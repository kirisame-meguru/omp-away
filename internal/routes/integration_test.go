package routes_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"firebase.google.com/go/v4/messaging"
	"github.com/coder/websocket"
	"omp-away/relay/internal/push"
	"omp-away/relay/internal/registration"
	"omp-away/relay/internal/routes"
)

var desktop = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{42}, 32))

const requestID = "8ec174f2-3086-41d3-aa45-34c8ece00b65"

type sender struct {
	mu              sync.Mutex
	messages        []*messaging.Message
	entered, resume chan struct{}
}

func (s *sender) Send(ctx context.Context, m *messaging.Message) error {
	s.mu.Lock()
	s.messages = append(s.messages, m)
	block := s.entered != nil && len(s.messages) == 1
	s.mu.Unlock()
	if block {
		close(s.entered)
		select {
		case <-s.resume:
			return push.ErrUnregistered
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

type fixture struct {
	t    *testing.T
	http *httptest.Server
	push *sender
	ctx  context.Context
}

func start(t *testing.T, sender *sender) *fixture {
	t.Helper()
	db, err := registration.Open(filepath.Join(t.TempDir(), "relay.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	h, err := routes.New(desktop, db, sender)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	t.Cleanup(h.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	t.Cleanup(cancel)
	return &fixture{t, srv, sender, ctx}
}
func (f *fixture) request(method, path, bearer, body string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(f.ctx, method, f.http.URL+path, strings.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := f.http.Client().Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	return res.StatusCode, data, err
}
func (f *fixture) call(method, path, bearer, body string, want int) map[string]string {
	f.t.Helper()
	status, data, err := f.request(method, path, bearer, body)
	if err != nil || status != want {
		f.t.Fatalf("%s %s: got %v (%v), want %d", method, path, status, err, want)
	}
	if len(data) == 0 || want != 200 {
		return nil
	}
	var v map[string]string
	if err = json.Unmarshal(data, &v); err != nil {
		f.t.Fatal(err)
	}
	return v
}
func (f *fixture) enroll() (string, string) {
	f.t.Helper()
	ticket := f.call("POST", "/v1/enrollments", desktop, "{}", 200)["ticket"]
	body := `{"ticket":"` + ticket + `"}`
	device := f.call("POST", "/v1/enroll", "", body, 200)
	f.call("POST", "/v1/enroll", "", body, 401)
	return device["deviceId"], device["token"]
}
func invite(id string) string { return `{"deviceId":"` + id + `","requestId":"` + requestID + `"}` }
func (f *fixture) dial(path, bearer string, want int) *websocket.Conn {
	f.t.Helper()
	c, res, err := websocket.Dial(f.ctx, "wss"+f.http.URL[5:]+path, &websocket.DialOptions{HTTPClient: f.http.Client(), HTTPHeader: http.Header{"Authorization": []string{"Bearer " + bearer}}})
	if want != 101 {
		if err == nil || res == nil || res.StatusCode != want {
			f.t.Fatalf("ws handshake: want %d, got %v", want, err)
		}
		return nil
	}
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { c.CloseNow() })
	return c
}
func (f *fixture) connect(control *websocket.Conn, id, bearer string) (*websocket.Conn, string) {
	f.t.Helper()
	c := f.dial("/v1/phone", bearer, 101)
	typ, b, err := control.Read(f.ctx)
	var msg map[string]string
	if err != nil || typ != websocket.MessageText || json.Unmarshal(b, &msg) != nil || len(msg) != 3 || msg["deviceId"] != id || msg["type"] != "connect" || msg["connectionId"] == "" {
		f.t.Fatal("wrong control notification", err)
	}
	return c, "/v1/tunnels/" + msg["connectionId"]
}
func TestWakeIsGenericIdempotentAndAuthenticated(t *testing.T) {
	f := start(t, &sender{})
	id, phone := f.enroll()
	f.call("POST", "/v1/enrollments", phone, "{}", 401)
	f.call("PUT", "/v1/token", desktop, `{"fcmToken":"other"}`, 401)
	f.call("PUT", "/v1/token", phone, `{"fcmToken":"registration-one"}`, 204)
	f.call("POST", "/v1/invites", phone, invite(id), 401)
	f.call("POST", "/v1/invites", desktop, strings.Replace(invite(id), `}`, `,"question":"secret"}`, 1), 400)
	f.call("POST", "/v1/invites", desktop, strings.Replace(invite(id), "deviceId", "DeviceId", 1), 400)
	f.call("POST", "/v1/invites", desktop, invite(id), 204)
	f.call("POST", "/v1/invites", desktop, invite(id), 204)
	f.push.mu.Lock()
	defer f.push.mu.Unlock()
	if len(f.push.messages) != 1 {
		t.Fatal("duplicate sends")
	}
	m := f.push.messages[0]
	if m.Token != "registration-one" || len(m.Data) != 1 || m.Data["requestId"] != requestID || m.Notification != nil || m.Android == nil || m.Android.Notification != nil || m.Android.Priority != "high" || m.Android.TTL == nil || *m.Android.TTL <= 0 || *m.Android.TTL > time.Minute {
		t.Fatal("incorrect wake envelope")
	}
}
func TestInvalidatedInFlightTokenDoesNotEraseRotation(t *testing.T) {
	s := &sender{entered: make(chan struct{}), resume: make(chan struct{})}
	f := start(t, s)
	id, phone := f.enroll()
	f.call("PUT", "/v1/token", phone, `{"fcmToken":"one"}`, 204)
	done := make(chan error, 1)
	go func() {
		status, _, err := f.request("POST", "/v1/invites", desktop, invite(id))
		if err == nil && status == 204 {
			err = errors.New("failed push reported success")
		}
		done <- err
	}()
	select {
	case <-s.entered:
	case <-f.ctx.Done():
		t.Fatal("push not attempted")
	}
	f.call("PUT", "/v1/token", phone, `{"fcmToken":"two"}`, 204)
	close(s.resume)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	f.call("POST", "/v1/invites", desktop, invite(id), 204)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.messages) != 2 || s.messages[1].Token != "two" {
		t.Fatal("invalid-token response erased rotated registration")
	}
}
func TestWebSocketDuplexAndCounterpartIsolation(t *testing.T) {
	f := start(t, &sender{})
	id, token := f.enroll()
	ctrl := f.dial("/v1/control", desktop, 101)
	f.dial("/v1/control", desktop, 409)
	p, path := f.connect(ctrl, id, token)
	f.dial(path, token, 401)
	f.dial("/v1/phone", token, 409)
	d := f.dial(path, desktop, 101)
	f.dial(path, desktop, 409)
	for _, pair := range [][2]*websocket.Conn{{p, d}, {d, p}} {
		if err := pair[0].Write(f.ctx, websocket.MessageBinary, []byte{0, 1, 255}); err != nil {
			t.Fatal(err)
		}
		k, b, e := pair[1].Read(f.ctx)
		if e != nil || k != websocket.MessageBinary || !bytes.Equal(b, []byte{0, 1, 255}) {
			t.Fatal("duplex forwarding failed", e)
		}
	}
	if err := d.Write(f.ctx, websocket.MessageBinary, make([]byte, 256<<10)); err != nil {
		t.Log("oversize write closed")
	}
	if _, _, err := p.Read(f.ctx); err == nil {
		t.Fatal("oversize forwarded")
	}
	// The prior device slot must be released when either side disappears.
	p2, next := f.connect(ctrl, id, token)
	d2 := f.dial(next, desktop, 101)
	p2.CloseNow()
	if _, _, err := d2.Read(f.ctx); err == nil {
		t.Fatal("dead peer retained")
	}
}
