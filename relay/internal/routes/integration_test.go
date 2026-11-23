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
	failures        []error
}

func (s *sender) Send(ctx context.Context, m *messaging.Message) error {
	s.mu.Lock()
	s.messages = append(s.messages, m)
	block := s.entered != nil && len(s.messages) == 1
	var failure error
	if len(s.messages) <= len(s.failures) {
		failure = s.failures[len(s.messages)-1]
	}
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
	return failure
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
	for _, path := range []string{"/v1/invites", "/v1/invalidations"} {
		t.Run(path, func(t *testing.T) {
			s := &sender{entered: make(chan struct{}), resume: make(chan struct{})}
			f := start(t, s)
			id, phone := f.enroll()
			f.call("PUT", "/v1/token", phone, `{"fcmToken":"one"}`, 204)
			done := make(chan error, 1)
			go func() {
				status, _, err := f.request("POST", path, desktop, invite(id))
				if err == nil && status != 410 {
					err = errors.New("wrong invalid-token failure status")
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
			f.call("POST", path, desktop, invite(id), 204)
			s.mu.Lock()
			defer s.mu.Unlock()
			if len(s.messages) != 2 || s.messages[1].Token != "two" {
				t.Fatal("invalid-token response erased rotated registration")
			}
		})
	}
}

func TestInvalidationRequiresDesktopAndExactOpaqueSchema(t *testing.T) {
	f := start(t, &sender{})
	id, phone := f.enroll()
	f.call("PUT", "/v1/token", phone, `{"fcmToken":"registration-one"}`, 204)
	for _, bearer := range []string{"", phone, registration.RandomID()} {
		f.call("POST", "/v1/invalidations", bearer, invite(id), 401)
	}
	f.call("GET", "/v1/invalidations", desktop, invite(id), 405)
	for _, body := range []string{
		`{}`,
		`null`,
		`[]`,
		`{"deviceId":"` + id + `"}`,
		`{"requestId":"` + requestID + `"}`,
		`{"deviceId":null,"requestId":"` + requestID + `"}`,
		`{"deviceId":"` + id + `","requestId":42}`,
		`{"deviceId":"invalid","requestId":"` + requestID + `"}`,
		`{"deviceId":"` + id + `","requestId":"question prose"}`,
		strings.Replace(invite(id), "deviceId", "DeviceId", 1),
		strings.Replace(invite(id), "requestId", "RequestId", 1),
		strings.Replace(invite(id), `}`, `,"requestId":"`+requestID+`"}`, 1),
		strings.Replace(invite(id), `}`, `,"deviceId":"`+id+`"}`, 1),
		invite(id) + `{}`,
	} {
		f.call("POST", "/v1/invalidations", desktop, body, 400)
	}
	// A wakeup cannot carry a form answer or any private preview/authority.
	for _, field := range []string{"question", "session", "options", "answer", "confirm", "event", "type"} {
		body := strings.Replace(invite(id), `}`, `,"`+field+`":"private"}`, 1)
		f.call("POST", "/v1/invalidations", desktop, body, 400)
	}
	f.call("POST", "/v1/invalidations", desktop, strings.Repeat(" ", 8193), 413)
	f.push.mu.Lock()
	defer f.push.mu.Unlock()
	if len(f.push.messages) != 0 {
		t.Fatal("unauthorized or malformed invalidation sent a push")
	}
}

func TestInvalidationSharesInvitationTransportRestrictions(t *testing.T) {
	for _, tc := range []struct {
		name, path, header, value string
		want                      int
	}{
		{"media type", "/v1/invalidations", "Content-Type", "text/plain", 415},
		{"origin", "/v1/invalidations", "Origin", "https://example.com", 400},
		{"query", "/v1/invalidations?extra=1", "", "", 400},
		{"encoded path", "/v1/%69nvalidations", "", "", 400},
		{"duplicate authorization", "/v1/invalidations", "Authorization", "Bearer " + desktop, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := start(t, &sender{})
			req, err := http.NewRequestWithContext(f.ctx, "POST", f.http.URL+tc.path, strings.NewReader(invite(registration.RandomID())))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+desktop)
			req.Header.Set("Content-Type", "application/json")
			if tc.header == "Authorization" {
				req.Header.Add(tc.header, tc.value)
			} else if tc.header != "" {
				req.Header.Set(tc.header, tc.value)
			}
			res, err := f.http.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != tc.want || res.Header.Get("Cache-Control") != "no-store" {
				t.Fatalf("status %d, want %d; invalidation must not be cached", res.StatusCode, tc.want)
			}
			f.push.mu.Lock()
			defer f.push.mu.Unlock()
			if len(f.push.messages) != 0 {
				t.Fatal("rejected transport sent a push")
			}
		})
	}
}

func TestInvitationAndInvalidationHaveIndependentDeduplication(t *testing.T) {
	f := start(t, &sender{})
	id, phone := f.enroll()
	f.call("PUT", "/v1/token", phone, `{"fcmToken":"registration-one"}`, 204)
	for _, path := range []string{"/v1/invites", "/v1/invalidations", "/v1/invalidations", "/v1/invites"} {
		f.call("POST", path, desktop, invite(id), 204)
	}
	f.push.mu.Lock()
	defer f.push.mu.Unlock()
	if len(f.push.messages) != 2 {
		t.Fatalf("want invitation and one retirement wakeup, got %d", len(f.push.messages))
	}
	for _, m := range f.push.messages {
		data, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		var got map[string]json.RawMessage
		if err = json.Unmarshal(data, &got); err != nil {
			t.Fatal(err)
		}
		if len(got) != 3 || m.Token != "registration-one" || len(m.Data) != 1 || m.Data["requestId"] != requestID ||
			m.Android == nil || m.Android.Priority != "high" || m.Android.TTL == nil || *m.Android.TTL != 45*time.Second {
			t.Fatal("wakeups must contain only the token, opaque request ID and bounded Android delivery configuration")
		}
		var android map[string]json.RawMessage
		if err = json.Unmarshal(got["android"], &android); err != nil || len(android) != 2 {
			t.Fatal("unexpected Android wakeup fields", err)
		}
	}
}

func TestInvalidationDoesNotCoalesceWithInFlightInvitation(t *testing.T) {
	s := &sender{entered: make(chan struct{}), resume: make(chan struct{})}
	f := start(t, s)
	id, phone := f.enroll()
	f.call("PUT", "/v1/token", phone, `{"fcmToken":"registration-one"}`, 204)
	done := make(chan error, 1)
	go func() {
		status, _, err := f.request("POST", "/v1/invites", desktop, invite(id))
		if err == nil && status != 410 {
			err = errors.New("wrong invitation failure status")
		}
		done <- err
	}()
	select {
	case <-s.entered:
	case <-f.ctx.Done():
		t.Fatal("invitation push not attempted")
	}
	// The retirement must reach FCM without waiting for the invitation's outcome.
	f.call("POST", "/v1/invalidations", desktop, invite(id), 204)
	close(s.resume)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	f.call("POST", "/v1/invalidations", desktop, invite(id), 204)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.messages) != 2 {
		t.Fatal("invitation and invalidation shared a flight or reservation")
	}
}

func TestFailedInvalidationCanRetryWithoutChangingInvitePolicy(t *testing.T) {
	for _, tc := range []struct {
		path  string
		want  int
		sends int
	}{
		{"/v1/invalidations", 204, 2},
		{"/v1/invites", 503, 1},
	} {
		t.Run(tc.path, func(t *testing.T) {
			s := &sender{failures: []error{errors.New("temporary provider failure")}}
			f := start(t, s)
			id, phone := f.enroll()
			f.call("PUT", "/v1/token", phone, `{"fcmToken":"registration-one"}`, 204)
			f.call("POST", tc.path, desktop, invite(id), 502)
			f.call("POST", tc.path, desktop, invite(id), tc.want)
			f.call("POST", tc.path, desktop, invite(id), tc.want)
			s.mu.Lock()
			defer s.mu.Unlock()
			if len(s.messages) != tc.sends {
				t.Fatalf("got %d FCM attempts, want %d", len(s.messages), tc.sends)
			}
		})
	}
}

func TestInvalidationIsolatesDevicesRequestsAndMissingRegistrations(t *testing.T) {
	f := start(t, &sender{})
	first, firstPhone := f.enroll()
	second, secondPhone := f.enroll()
	f.call("POST", "/v1/invalidations", desktop, invite(registration.RandomID()), 404)
	f.call("POST", "/v1/invalidations", desktop, invite(first), 409)
	f.call("PUT", "/v1/token", firstPhone, `{"fcmToken":"registration-one"}`, 204)
	f.call("PUT", "/v1/token", secondPhone, `{"fcmToken":"registration-two"}`, 204)
	otherRequest := "0b6cd7cc-8c34-4318-a3c7-13c0b1daee96"
	for _, body := range []string{invite(first), invite(second), strings.Replace(invite(first), requestID, otherRequest, 1), invite(first)} {
		f.call("POST", "/v1/invalidations", desktop, body, 204)
	}
	f.push.mu.Lock()
	defer f.push.mu.Unlock()
	if len(f.push.messages) != 3 {
		t.Fatal("unrelated devices or requests suppressed each other's wakeups")
	}
	for i, want := range []struct{ token, request string }{
		{"registration-one", requestID},
		{"registration-two", requestID},
		{"registration-one", otherRequest},
	} {
		m := f.push.messages[i]
		if m.Token != want.token || len(m.Data) != 1 || m.Data["requestId"] != want.request {
			t.Fatal("cross-device or cross-request invalidation")
		}
	}
}

func TestInvalidationUnregisteredTokenCanBeReplaced(t *testing.T) {
	s := &sender{failures: []error{push.ErrUnregistered}}
	f := start(t, s)
	id, phone := f.enroll()
	f.call("PUT", "/v1/token", phone, `{"fcmToken":"registration-old"}`, 204)
	f.call("POST", "/v1/invalidations", desktop, invite(id), 410)
	f.call("POST", "/v1/invalidations", desktop, invite(id), 409)
	f.call("PUT", "/v1/token", phone, `{"fcmToken":"registration-new"}`, 204)
	f.call("POST", "/v1/invalidations", desktop, invite(id), 204)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.messages) != 2 || s.messages[1].Token != "registration-new" {
		t.Fatal("retirement could not retry after token replacement")
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
