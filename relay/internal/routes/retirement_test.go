package routes

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"firebase.google.com/go/v4/messaging"
	"golang.org/x/time/rate"
	"omp-away/relay/internal/registration"
)

// Only the external FCM send is replaced; routing, reservation and coalescing
// use the real implementation and database.
type retirementSender struct {
	mu              sync.Mutex
	attempts        int
	entered, resume chan struct{}
	failure         error
}

func (s *retirementSender) Send(ctx context.Context, _ *messaging.Message) error {
	s.mu.Lock()
	s.attempts++
	first := s.attempts == 1
	s.mu.Unlock()
	if first && s.entered != nil {
		close(s.entered)
		select {
		case <-s.resume:
			return s.failure
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func retirementHandler(t *testing.T, sender *retirementSender) (*Handler, string) {
	t.Helper()
	store, err := registration.Open(filepath.Join(t.TempDir(), "relay.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	h, err := New(registration.RandomID(), store, sender)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	now := time.Now()
	ticket, err := store.Ticket(now)
	if err != nil {
		t.Fatal(err)
	}
	id, _, err := store.Enroll(ticket, now)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.SetFCM(id, "registration-one"); err != nil {
		t.Fatal(err)
	}
	return h, id
}

// Signals when a duplicate enters the existing-flight wait, without sleeps or
// production-only hooks. Done still has the original cancellation semantics.
type observedWait struct {
	context.Context
	once    sync.Once
	waiting chan struct{}
}

func (c *observedWait) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func TestConcurrentWakeupsShareFailureAndOnlyInvalidationCanRetry(t *testing.T) {
	for _, invalidation := range []bool{false, true} {
		name := "invitation"
		if invalidation {
			name = "invalidation"
		}
		t.Run(name, func(t *testing.T) {
			sender := &retirementSender{
				entered: make(chan struct{}), resume: make(chan struct{}),
				failure: errors.New("temporary provider failure"),
			}
			h, id := retirementHandler(t, sender)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			leader := make(chan int, 1)
			go func() { leader <- h.wake(ctx, id, "request", invalidation) }()
			select {
			case <-sender.entered:
			case <-ctx.Done():
				t.Fatal("first send did not enter FCM")
			}
			waiter := &observedWait{Context: ctx, waiting: make(chan struct{})}
			duplicate := make(chan int, 1)
			go func() { duplicate <- h.wake(waiter, id, "request", invalidation) }()
			select {
			case <-waiter.waiting:
			case <-ctx.Done():
				t.Fatal("duplicate did not wait for the existing flight")
			}
			close(sender.resume)
			for _, result := range []<-chan int{leader, duplicate} {
				select {
				case status := <-result:
					if status != 502 {
						t.Fatalf("coalesced failure status %d, want 502", status)
					}
				case <-ctx.Done():
					t.Fatal("coalesced request did not finish")
				}
			}
			wantStatus, wantAttempts := 503, 1
			if invalidation {
				wantStatus, wantAttempts = 204, 2
			}
			for range 2 {
				if status := h.wake(ctx, id, "request", invalidation); status != wantStatus {
					t.Fatalf("retry status %d, want %d", status, wantStatus)
				}
			}
			sender.mu.Lock()
			defer sender.mu.Unlock()
			if sender.attempts != wantAttempts {
				t.Fatalf("got %d FCM attempts, want %d", sender.attempts, wantAttempts)
			}
		})
	}
}

func TestRateLimitedInvalidationReleasesReservation(t *testing.T) {
	sender := &retirementSender{}
	h, id := retirementHandler(t, sender)
	h.pushes = rate.NewLimiter(0, 0)
	if status := h.wake(context.Background(), id, "request", true); status != 429 {
		t.Fatalf("rate-limited status %d, want 429", status)
	}
	h.pushes = rate.NewLimiter(rate.Inf, 1)
	for range 2 {
		if status := h.wake(context.Background(), id, "request", true); status != 204 {
			t.Fatalf("retry status %d, want 204", status)
		}
	}
	sender.mu.Lock()
	defer sender.mu.Unlock()
	if sender.attempts != 1 {
		t.Fatal("rate-limited request sent a push or poisoned the retry reservation")
	}
}
