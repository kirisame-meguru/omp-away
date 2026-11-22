// Package registration owns the single-operator routing database. Nothing here
// identifies an inner TLS peer. Only the FCM address must be recoverable.
package registration

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
)

var (
	ErrAuth     = errors.New("invalid credential")
	ErrMissing  = errors.New("route not found")
	ErrUnready  = errors.New("no push registration")
	ErrFull     = errors.New("capacity reached")
	ErrConflict = errors.New("registration already assigned")
	ErrUnknown  = errors.New("previous push outcome unknown")
	devices     = []byte("devices-v1")
	bearers     = []byte("phone-bearer-sha256-v1")
	invites     = []byte("invites-v1")
	expires     = []byte("invite-expiry-v1")
)

const inviteRetention = 10 * time.Minute

type Store struct {
	db *bolt.DB
	mu sync.Mutex
	// Losing outstanding tickets on restart is intentional (fail closed).
	tickets map[[32]byte]time.Time
}

func Open(path string) (*Store, error) {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("invalid database file")
	} else if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	db, err := bolt.Open(path, 0600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, name := range [][]byte{devices, bearers, invites, expires} {
			if _, err := tx.CreateBucketIfNotExists(name); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db, tickets: make(map[[32]byte]time.Time)}, nil
}
func (s *Store) Close() error { return s.db.Close() }

func RandomID() string {
	var b [32]byte
	rand.Read(b[:]) // Go 1.26 crypto/rand.Read never returns an error.
	return base64.RawURLEncoding.EncodeToString(b[:])
}
func (s *Store) Ticket(now time.Time) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, until := range s.tickets {
		if !now.Before(until) {
			delete(s.tickets, k)
		}
	}
	if len(s.tickets) >= 32 {
		return "", ErrFull
	}
	ticket := RandomID()
	s.tickets[sha256.Sum256([]byte(ticket))] = now.Add(10 * time.Minute)
	return ticket, nil
}
func (s *Store) Enroll(ticket string, now time.Time) (string, string, error) {
	h := sha256.Sum256([]byte(ticket))
	s.mu.Lock()
	until, ok := s.tickets[h]
	delete(s.tickets, h)
	s.mu.Unlock()
	if !ok || !now.Before(until) {
		return "", "", ErrAuth
	}
	id, token := RandomID(), RandomID()
	digest := sha256.Sum256([]byte(token))
	err := s.db.Update(func(tx *bolt.Tx) error {
		d := tx.Bucket(devices)
		if d.Sequence() >= 256 {
			return ErrFull
		}
		if d.Get([]byte(id)) != nil || tx.Bucket(bearers).Get(digest[:]) != nil {
			return ErrConflict
		}
		if _, err := d.NextSequence(); err != nil {
			return err
		}
		if err := d.Put([]byte(id), nil); err != nil {
			return err
		}
		return tx.Bucket(bearers).Put(digest[:], []byte(id))
	})
	if err != nil {
		return "", "", err
	}
	return id, token, nil
}
func (s *Store) Device(token string) (string, error) {
	h := sha256.Sum256([]byte(token))
	var id string
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bearers).Get(h[:])
		if b == nil {
			return ErrAuth
		}
		id = string(b)
		return nil
	})
	return id, err
}
func (s *Store) SetFCM(id, token string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		d := tx.Bucket(devices)
		key, val := []byte(id), []byte(token)
		if d.Get(key) == nil {
			return ErrMissing
		}
		if bytes.Equal(d.Get(key), val) {
			return nil
		}
		// Prevent an existing token from being reassigned via another phone bearer.
		if err := d.ForEach(func(k, v []byte) error {
			if bytes.Equal(v, val) {
				return ErrConflict
			}
			return nil
		}); err != nil {
			return err
		}
		return d.Put(key, val)
	})
}

// Reserve records intent before contacting Google. A crash can lose a wakeup,
// but will not replay a possibly delivered push. The private inbox is authoritative.
func (s *Store) Reserve(id, request string, now time.Time) (token string, duplicate bool, err error) {
	key := []byte(id + ":" + request)
	err = s.db.Update(func(tx *bolt.Tx) error {
		d := tx.Bucket(devices).Get([]byte(id))
		if d == nil {
			return ErrMissing
		}
		b, idx := tx.Bucket(invites), tx.Bucket(expires)
		c := idx.Cursor()
		count := b.Sequence()
		prior := count
		for k, _ := c.First(); k != nil; k, _ = c.First() {
			if len(k) < 9 || count == 0 {
				return errors.New("invalid expiry index")
			}
			if int64(binary.BigEndian.Uint64(k[:8])) > now.UnixMilli() {
				break
			}
			if err := b.Delete(k[8:]); err != nil {
				return err
			}
			if err := c.Delete(); err != nil {
				return err
			}
			count--
		}
		if count != prior {
			if err := b.SetSequence(count); err != nil {
				return err
			}
		}
		if previous := b.Get(key); previous != nil {
			if len(previous) != 9 || previous[8] != 1 {
				return ErrUnknown
			}
			duplicate = true
			return nil
		}
		if len(d) == 0 {
			return ErrUnready
		}
		if count >= 4096 {
			return ErrFull
		}
		var record [9]byte // expiry plus 0=reserved/unknown, 1=accepted
		binary.BigEndian.PutUint64(record[:8], uint64(now.Add(inviteRetention).UnixMilli()))
		if err := b.Put(key, record[:]); err != nil {
			return err
		}
		idxKey := make([]byte, 8+len(key))
		copy(idxKey, record[:8])
		copy(idxKey[8:], key)
		if err := idx.Put(idxKey, nil); err != nil {
			return err
		}
		if err := b.SetSequence(count + 1); err != nil {
			return err
		}
		token = string(d)
		return nil
	})
	return
}

func (s *Store) Accepted(id, request string) error {
	key := []byte(id + ":" + request)
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(invites)
		v := b.Get(key)
		if len(v) != 9 {
			return ErrUnknown
		}
		var record [9]byte
		copy(record[:8], v)
		record[8] = 1
		return b.Put(key, record[:])
	})
}

// Rejected releases a known failed send. Invalidation is compare-and-delete:
// an UNREGISTERED response for yesterday's token must not erase today's upload.
func (s *Store) Rejected(id, request, invalidToken string) error {
	key := []byte(id + ":" + request)
	return s.db.Update(func(tx *bolt.Tx) error {
		d := tx.Bucket(devices)
		if invalidToken != "" && bytes.Equal(d.Get([]byte(id)), []byte(invalidToken)) {
			if err := d.Put([]byte(id), nil); err != nil {
				return err
			}
		}
		b := tx.Bucket(invites)
		v := b.Get(key)
		if v == nil {
			return nil
		}
		if len(v) != 9 {
			return ErrUnknown
		}
		idxKey := make([]byte, 8+len(key))
		copy(idxKey, v[:8])
		copy(idxKey[8:], key)
		if err := tx.Bucket(expires).Delete(idxKey); err != nil {
			return err
		}
		if err := b.Delete(key); err != nil {
			return err
		}
		return b.SetSequence(b.Sequence() - 1)
	})
}
