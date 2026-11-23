// Package tunnel switches binary messages without terminating the inner TLS
// stream. A slot belongs to a particular control epoch, never its successor.
package tunnel

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"
	"omp-away/relay/internal/registration"
)

const (
	maxSlots      = 16
	maxMessage    = 128 << 10
	attachTimeout = 15 * time.Second
	writeTimeout  = 10 * time.Second
)

type notice struct {
	Type   string `json:"type"`
	Device string `json:"deviceId"`
	ID     string `json:"connectionId"`
}
type control struct {
	ctx     context.Context
	cancel  context.CancelFunc
	notices chan notice
}
type slot struct {
	id, device     string
	epoch          *control
	ctx            context.Context
	cancel         context.CancelFunc
	ready          chan struct{}
	phone, desktop *websocket.Conn // published before ready closes
	claimed        bool            // protected by Hub.mu
	timer          *time.Timer
}
type Hub struct {
	mu             sync.Mutex
	closed         bool
	ctrl           *control
	byID, byDevice map[string]*slot
}

func New() *Hub { return &Hub{byID: make(map[string]*slot), byDevice: make(map[string]*slot)} }

func (h *Hub) dropLocked(s *slot) {
	if h.byID[s.id] != s {
		return
	}
	delete(h.byID, s.id)
	delete(h.byDevice, s.device)
	s.timer.Stop()
	s.cancel()
}
func (h *Hub) drop(s *slot) { h.mu.Lock(); defer h.mu.Unlock(); h.dropLocked(s) }
func (h *Hub) clearLocked(c *control) {
	if h.ctrl != c || c == nil {
		return
	}
	h.ctrl = nil
	for _, s := range h.byID {
		h.dropLocked(s)
	}
	c.cancel()
}
func (h *Hub) Close() { h.mu.Lock(); defer h.mu.Unlock(); h.closed = true; h.clearLocked(h.ctrl) }

// These are native-client endpoints. Never accept a browser Origin; the
// HTTP layer also rejects URLs with credentials, queries, or path aliases.
func accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	return websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
}
func ping(ctx context.Context, c *websocket.Conn) error {
	limit, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.Ping(limit)
}
func send(ctx context.Context, c *websocket.Conn, kind websocket.MessageType, b []byte) error {
	limit, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.Write(limit, kind, b)
}

func (h *Hub) Control(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	if h.closed || h.ctrl != nil {
		h.mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	owner := &control{ctx, cancel, make(chan notice, maxSlots)}
	h.ctrl = owner
	h.mu.Unlock()
	defer func() { h.mu.Lock(); h.clearLocked(owner); h.mu.Unlock() }()
	c, err := accept(w, r)
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(1)
	ctx = c.CloseRead(ctx)
	beat := time.NewTicker(25 * time.Second)
	defer beat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-beat.C:
			if ping(ctx, c) != nil {
				return
			}
		case n := <-owner.notices:
			b, _ := json.Marshal(n)
			if send(ctx, c, websocket.MessageText, b) != nil {
				return
			}
		}
	}
}

func (h *Hub) Phone(w http.ResponseWriter, r *http.Request, device string) {
	h.mu.Lock()
	epoch := h.ctrl
	if h.closed || epoch == nil {
		h.mu.Unlock()
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if h.byDevice[device] != nil {
		h.mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		return
	}
	if len(h.byID) >= maxSlots {
		h.mu.Unlock()
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	ctx, cancel := context.WithTimeout(epoch.ctx, 2*time.Hour)
	s := &slot{id: registration.RandomID(), device: device, epoch: epoch, ctx: ctx, cancel: cancel, ready: make(chan struct{})}
	h.byID[s.id] = s
	h.byDevice[device] = s
	s.timer = time.AfterFunc(attachTimeout, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if s.desktop == nil {
			h.dropLocked(s)
		}
	})
	h.mu.Unlock()
	c, err := accept(w, r)
	if err != nil {
		h.drop(s)
		return
	}
	defer c.CloseNow()
	defer h.drop(s)
	c.SetReadLimit(maxMessage)
	h.mu.Lock()
	if h.byID[s.id] != s {
		h.mu.Unlock()
		return
	}
	s.phone = c
	h.mu.Unlock()
	select {
	case epoch.notices <- notice{"connect", device, s.id}:
	case <-ctx.Done():
		return
	}
	h.pump(s, c, true)
}
func (h *Hub) Desktop(w http.ResponseWriter, r *http.Request, id string) {
	h.mu.Lock()
	s := h.byID[id]
	if s == nil || s.phone == nil || s.epoch != h.ctrl {
		h.mu.Unlock()
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if s.claimed {
		h.mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		return
	}
	s.claimed = true
	h.mu.Unlock()
	c, err := accept(w, r)
	if err != nil {
		h.drop(s)
		return
	}
	defer c.CloseNow()
	defer h.drop(s)
	c.SetReadLimit(maxMessage)
	h.mu.Lock()
	if h.byID[id] != s {
		h.mu.Unlock()
		return
	}
	s.desktop = c
	s.timer.Stop()
	close(s.ready)
	h.mu.Unlock()
	h.pump(s, c, false)
}

// A complete short read is one frame. A full buffer is one byte over the
// limit; never forward even the prefix of an invalid message.
func readMessage(rd io.Reader, buf []byte) (int, error) {
	n := 0
	for n < len(buf) {
		count, err := rd.Read(buf[n:])
		n += count
		if err == io.EOF && n > 0 && n < len(buf) {
			return n, nil
		}
		if err != nil {
			return 0, err
		}
	}
	return 0, io.ErrShortBuffer
}
func (h *Hub) pump(s *slot, src *websocket.Conn, fromPhone bool) {
	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-ticker.C:
				if ping(s.ctx, src) != nil {
					h.drop(s)
					return
				}
			}
		}
	}()
	// At most one bounded message per direction, including before attachment.
	// Reuse a buffer instead of allocating a TLS/audio buffer per frame.
	buf := make([]byte, maxMessage+1)
	frames, octets := rate.NewLimiter(256, 512), rate.NewLimiter(1<<20, 2<<20)
	for {
		kind, rd, err := src.Reader(s.ctx)
		if err != nil || kind != websocket.MessageBinary {
			return
		}
		n, err := readMessage(rd, buf)
		if err != nil {
			return
		}
		now := time.Now()
		if !frames.AllowN(now, 1) || !octets.AllowN(now, n) {
			return
		}
		select {
		case <-s.ctx.Done():
			return
		case <-s.ready:
		}
		dst := s.phone
		if fromPhone {
			dst = s.desktop
		}
		if send(s.ctx, dst, kind, buf[:n]) != nil {
			return
		}
	}
}
