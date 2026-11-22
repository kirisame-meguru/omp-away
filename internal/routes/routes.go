// Package routes implements only the outer Away/1 contract. It deliberately
// does not use ServeMux path cleaning or expose an API that accepts prose.
package routes

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
	"omp-away/relay/internal/push"
	"omp-away/relay/internal/registration"
	"omp-away/relay/internal/tunnel"
)

var uuid = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var errBody = errors.New("invalid JSON object")

type flight struct {
	done   chan struct{}
	status int
}
type Handler struct {
	desktop        [32]byte
	store          *registration.Store
	sender         push.Sender
	hub            *tunnel.Hub
	started        time.Time
	budget, pushes *rate.Limiter
	slots          chan struct{}
	mu             sync.Mutex
	flights        map[string]*flight
}

func New(desktop string, store *registration.Store, sender push.Sender) (*Handler, error) {
	if !randomText(desktop, 32) || store == nil || sender == nil {
		return nil, errors.New("invalid relay configuration")
	}
	return &Handler{desktop: sha256.Sum256([]byte(desktop)), store: store, sender: sender, hub: tunnel.New(), started: time.Now(), budget: rate.NewLimiter(20, 64), pushes: rate.NewLimiter(2, 16), slots: make(chan struct{}, 64), flights: make(map[string]*flight)}, nil
}
func (h *Handler) Close() { h.hub.Close() }
func randomText(s string, n int) bool {
	if len(s) != base64.RawURLEncoding.EncodedLen(n) {
		return false
	}
	var raw [32]byte
	end, err := base64.RawURLEncoding.Strict().Decode(raw[:], []byte(s))
	return err == nil && end == n
}
func (h *Handler) now() time.Time { return h.started.Add(time.Since(h.started)) }
func credential(r *http.Request) string {
	v := r.Header.Values("Authorization")
	if len(v) != 1 {
		return ""
	}
	s, ok := strings.CutPrefix(v[0], "Bearer ")
	if !ok || !randomText(s, 32) {
		return ""
	}
	return s
}
func status(err error) int {
	switch {
	case err == nil:
		return 204
	case errors.Is(err, registration.ErrAuth):
		return 401
	case errors.Is(err, registration.ErrMissing):
		return 404
	case errors.Is(err, registration.ErrUnready), errors.Is(err, registration.ErrConflict):
		return 409
	case errors.Is(err, registration.ErrFull):
		return 429
	case errors.Is(err, registration.ErrUnknown):
		return 503
	default:
		return 500
	}
}
func method(w http.ResponseWriter, r *http.Request, want string) bool {
	if r.Method == want {
		return true
	}
	w.Header().Set("Allow", want)
	w.WriteHeader(405)
	return false
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.RawPath != "" || r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.IsAbs() || len(r.Header.Values("Origin")) != 0 {
		w.WriteHeader(400)
		return
	}
	path := r.URL.Path
	if !h.budget.Allow() {
		w.WriteHeader(429)
		return
	}
	if path == "/healthz" {
		if method(w, r, "GET") {
			w.WriteHeader(200)
		}
		return
	}
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		w.WriteHeader(429)
		return
	}
	var device string
	switch {
	case path == "/v1/enroll":
		if !method(w, r, "POST") {
			return
		}
	case path == "/v1/token" || path == "/v1/phone":
		bearer := credential(r)
		if bearer == "" {
			w.WriteHeader(401)
			return
		}
		var err error
		device, err = h.store.Device(bearer)
		if err != nil {
			w.WriteHeader(status(err))
			return
		}
	case path == "/v1/enrollments" || path == "/v1/invites" || path == "/v1/control" || strings.HasPrefix(path, "/v1/tunnels/"):
		hash := sha256.Sum256([]byte(credential(r)))
		if subtle.ConstantTimeCompare(hash[:], h.desktop[:]) != 1 {
			w.WriteHeader(401)
			return
		}
	default:
		w.WriteHeader(404)
		return
	}
	switch path {
	case "/v1/enrollments":
		if !method(w, r, "POST") {
			return
		}
		if _, ok := object(w, r); !ok {
			return
		}
		ticket, err := h.store.Ticket(h.now())
		if err != nil {
			w.WriteHeader(status(err))
			return
		}
		respond(w, map[string]string{"ticket": ticket})
	case "/v1/enroll":
		v, ok := object(w, r, "ticket")
		if !ok {
			return
		}
		if !randomText(v[0], 32) {
			w.WriteHeader(401)
			return
		}
		id, token, err := h.store.Enroll(v[0], h.now())
		if err != nil {
			w.WriteHeader(status(err))
			return
		}
		respond(w, map[string]string{"deviceId": id, "token": token})
	case "/v1/token":
		if !method(w, r, "PUT") {
			return
		}
		v, ok := object(w, r, "fcmToken")
		if !ok {
			return
		}
		if !validFCM(v[0]) {
			w.WriteHeader(400)
			return
		}
		w.WriteHeader(status(h.store.SetFCM(device, v[0])))
	case "/v1/invites":
		if !method(w, r, "POST") {
			return
		}
		v, ok := object(w, r, "deviceId", "requestId")
		if !ok {
			return
		}
		if !randomText(v[0], 32) || !(uuid.MatchString(v[1]) || randomText(v[1], 16) || randomText(v[1], 32)) {
			w.WriteHeader(400)
			return
		}
		w.WriteHeader(h.invite(r.Context(), v[0], v[1]))
	case "/v1/control":
		if method(w, r, "GET") {
			h.hub.Control(w, r)
		}
	case "/v1/phone":
		if method(w, r, "GET") {
			h.hub.Phone(w, r, device)
		}
	default:
		if !method(w, r, "GET") {
			return
		}
		id := strings.TrimPrefix(path, "/v1/tunnels/")
		if !randomText(id, 32) {
			w.WriteHeader(404)
			return
		}
		h.hub.Desktop(w, r, id)
	}
}
func respond(w http.ResponseWriter, v map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func validFCM(s string) bool {
	if len(s) == 0 || len(s) > 4096 {
		return false
	}
	for i := range len(s) {
		if s[i] < 33 || s[i] > 126 {
			return false
		}
	}
	return true
}

// Map/struct unmarshalling alone accepts duplicate or case-insensitive keys.
func object(w http.ResponseWriter, r *http.Request, keys ...string) ([2]string, bool) {
	var vals [2]string
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" {
		w.WriteHeader(415)
		return vals, false
	}
	const cap = 8192
	if r.ContentLength > cap {
		w.WriteHeader(413)
		return vals, false
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, cap))
	err = decode(d, keys, &vals)
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			w.WriteHeader(413)
		} else {
			w.WriteHeader(400)
		}
		return vals, false
	}
	return vals, true
}
func decode(d *json.Decoder, keys []string, vals *[2]string) error {
	t, err := d.Token()
	if err != nil {
		return err
	}
	if t != json.Delim('{') {
		return errBody
	}
	mask := 0
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return err
		}
		index := -1
		for i, k := range keys {
			if key == k {
				index = i
				break
			}
		}
		if index < 0 || mask&(1<<index) != 0 {
			return errBody
		}
		value, err := d.Token()
		if err != nil {
			return err
		}
		s, ok := value.(string)
		if !ok {
			return errBody
		}
		vals[index] = s
		mask |= 1 << index
	}
	t, err = d.Token()
	if err != nil {
		return err
	}
	if t != json.Delim('}') || mask != (1<<len(keys))-1 {
		return errBody
	}
	if _, err = d.Token(); err != io.EOF {
		if err != nil {
			return err
		}
		return errBody
	}
	return nil
}

// Concurrent duplicates share one FCM outcome. Persist before send; an
// ambiguous network error cannot safely be replayed during the dedup window.
func (h *Handler) invite(ctx context.Context, id, request string) int {
	key := id + ":" + request
	h.mu.Lock()
	if existing := h.flights[key]; existing != nil {
		h.mu.Unlock()
		select {
		case <-ctx.Done():
			return 503
		case <-existing.done:
			return existing.status
		}
	}
	f := &flight{done: make(chan struct{})}
	h.flights[key] = f
	h.mu.Unlock()
	result := h.deliver(ctx, id, request)
	h.mu.Lock()
	f.status = result
	close(f.done)
	delete(h.flights, key)
	h.mu.Unlock()
	return result
}
func (h *Handler) deliver(ctx context.Context, id, request string) int {
	token, dup, err := h.store.Reserve(id, request, h.now())
	if err != nil || dup {
		return status(err)
	}
	if !h.pushes.Allow() {
		if err := h.store.Rejected(id, request, ""); err != nil {
			return 500
		}
		return 429
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	err = h.sender.Send(ctx, push.Invite(token, request))
	if errors.Is(err, push.ErrUnregistered) {
		if err = h.store.Rejected(id, request, token); err != nil {
			return 500
		}
		return 410
	}
	if err != nil {
		return 502
	}
	return status(h.store.Accepted(id, request))
}
