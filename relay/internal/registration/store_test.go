package registration

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

func TestExpiredTicketAndDurableBearer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	old, err := s.Ticket(now)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Enroll(old, now.Add(10*time.Minute)); !errors.Is(err, ErrAuth) {
		t.Fatal("expired ticket accepted")
	}
	ticket, err := s.Ticket(now)
	if err != nil {
		t.Fatal(err)
	}
	id, bearer, err := s.Enroll(ticket, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Enroll(ticket, now); !errors.Is(err, ErrAuth) {
		t.Fatal("ticket replay")
	}
	if err := s.SetFCM(id, "first-registration"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{old, ticket, bearer} {
		if bytes.Contains(data, []byte(secret)) {
			t.Fatal("raw credential stored")
		}
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if got, err := s.Device(bearer); err != nil || got != id {
		t.Fatal("lost phone registration")
	}
	if token, _, err := s.Reserve(id, "request", now); err != nil || token != "first-registration" {
		t.Fatal("lost FCM registration")
	}
}

func TestAmbiguousAndAcceptedReservationsSurviveRestartButExpire(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	ticket, err := s.Ticket(now)
	if err != nil {
		t.Fatal(err)
	}
	id, _, err := s.Enroll(ticket, now)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetFCM(id, "fcm-one"); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"accepted", "ambiguous"} {
		if _, dup, err := s.Reserve(id, key, now); err != nil || dup {
			t.Fatal("first send rejected", err)
		}
	}
	if err = s.Accepted(id, "accepted"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, dup, err := s.Reserve(id, "accepted", now.Add(time.Minute)); err != nil || !dup {
		t.Fatal("accepted wake replayed after restart", err)
	}
	if _, _, err := s.Reserve(id, "ambiguous", now.Add(time.Minute)); !errors.Is(err, ErrUnknown) {
		t.Fatal("ambiguous wake replayed or reported successful", err)
	}
	for _, key := range []string{"accepted", "ambiguous"} {
		if token, dup, err := s.Reserve(id, key, now.Add(10*time.Minute)); err != nil || dup || token != "fcm-one" {
			t.Fatal("expired wake reservation not released", err)
		}
	}
}

func TestNamespacedWakeReservationsAreDurableAndExpire(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s != nil {
			s.Close()
		}
	})
	now := time.Now()
	ticket, err := s.Ticket(now)
	if err != nil {
		t.Fatal(err)
	}
	id, _, err := s.Enroll(ticket, now)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetFCM(id, "registration-one"); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"request", "invalidation:request", "invalidation:interrupted"} {
		if token, dup, err := s.Reserve(id, key, now); err != nil || dup || token != "registration-one" {
			t.Fatal("separate wake reservation rejected", err)
		}
		if key != "invalidation:interrupted" {
			if err = s.Accepted(id, key); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"request", "invalidation:request"} {
		if _, dup, err := s.Reserve(id, key, now.Add(time.Minute)); err != nil || !dup {
			t.Fatal("successful wakeup replayed after restart", err)
		}
	}
	if _, _, err := s.Reserve(id, "invalidation:interrupted", now.Add(time.Minute)); !errors.Is(err, ErrUnknown) {
		t.Fatal("interrupted reservation unexpectedly accepted", err)
	}
	// Even a crash between reservation and send cannot suppress retries forever.
	for _, key := range []string{"request", "invalidation:request", "invalidation:interrupted"} {
		if token, dup, err := s.Reserve(id, key, now.Add(10*time.Minute)); err != nil || dup || token != "registration-one" {
			t.Fatal("expired wake reservation still suppresses delivery", err)
		}
	}
	if err = s.Accepted(id, "invalidation:request"); err != nil {
		t.Fatal(err)
	}
	if err = s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(devices).Delete([]byte(id)) }); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Reserve(id, "invalidation:request", now.Add(10*time.Minute)); !errors.Is(err, ErrMissing) {
		t.Fatal("deduplication accepted a deleted enrollment", err)
	}
}

func TestNamespacedWakeReservationsShareBoundedCapacityAndReleaseFailures(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "relay.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now()
	ticket, err := s.Ticket(now)
	if err != nil {
		t.Fatal(err)
	}
	id, _, err := s.Enroll(ticket, now)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetFCM(id, "registration-one"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.Reserve(id, "invitation", now); err != nil {
		t.Fatal(err)
	}
	for i := range 4095 {
		if _, dup, err := s.Reserve(id, "invalidation:"+strconv.Itoa(i), now); err != nil || dup {
			t.Fatal("reservation rejected below capacity", err)
		}
	}
	if _, _, err = s.Reserve(id, "invalidation:overflow", now); !errors.Is(err, ErrFull) {
		t.Fatal("unbounded invalidation reservations", err)
	}
	if err = s.Rejected(id, "invalidation:0", ""); err != nil {
		t.Fatal(err)
	}
	if token, dup, err := s.Reserve(id, "invalidation:0", now); err != nil || dup || token != "registration-one" {
		t.Fatal("failed delivery did not release its reservation and capacity", err)
	}
	if token, dup, err := s.Reserve(id, "invalidation:overflow", now.Add(10*time.Minute)); err != nil || dup || token != "registration-one" {
		t.Fatal("expired reservations did not release capacity", err)
	}
}
