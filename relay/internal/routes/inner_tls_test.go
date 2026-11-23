package routes_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"math/big"
	"net"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Record the actual bytes sent as opaque WS payload, not a decrypted TLS
// transcript. A separate stream owns each buffer until both handshakes end.
type recorded struct {
	net.Conn
	wire bytes.Buffer
}

func (r *recorded) Write(b []byte) (int, error) {
	n, err := r.Conn.Write(b)
	r.wire.Write(b[:n])
	return n, err
}
func testIdentity(t *testing.T, name string) tls.Certificate {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{name}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}
}
func peerConfig(me, peer tls.Certificate) *tls.Config {
	roots := x509.NewCertPool()
	roots.AddCert(peer.Leaf)
	pin := sha256.Sum256(peer.Leaf.RawSubjectPublicKeyInfo)
	return &tls.Config{Certificates: []tls.Certificate{me}, MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13, RootCAs: roots, ClientCAs: roots, ClientAuth: tls.RequireAndVerifyClientCert, ServerName: "desktop.invalid", VerifyConnection: func(cs tls.ConnectionState) error {
		if len(cs.PeerCertificates) != 1 || sha256.Sum256(cs.PeerCertificates[0].RawSubjectPublicKeyInfo) != pin {
			return errors.New("pin mismatch")
		}
		return nil
	}}
}
func streams(f *fixture, id, token string, ctrl *websocket.Conn) (*recorded, *recorded) {
	pc, path := f.connect(ctrl, id, token)
	dc := f.dial(path, desktop, 101)
	return &recorded{Conn: websocket.NetConn(f.ctx, pc, websocket.MessageBinary)}, &recorded{Conn: websocket.NetConn(f.ctx, dc, websocket.MessageBinary)}
}

func TestInnerPinnedTLSIsOpaqueAtRelayBoundary(t *testing.T) {
	f := start(t, &sender{})
	id, token := f.enroll()
	ctrl := f.dial("/v1/control", desktop, 101)
	pw, dw := streams(f, id, token, ctrl)
	pkey, dkey := testIdentity(t, "phone.invalid"), testIdentity(t, "desktop.invalid")
	p, d := tls.Client(pw, peerConfig(pkey, dkey)), tls.Server(dw, peerConfig(dkey, pkey))
	sentinel := []byte("unique inner content / do not expose / 9020b2bb")
	done := make(chan error, 1)
	go func() {
		if err := d.HandshakeContext(f.ctx); err != nil {
			done <- err
			return
		}
		var read = make([]byte, len(sentinel))
		if _, err := io.ReadFull(d, read); err != nil {
			done <- err
			return
		}
		if !bytes.Equal(read, sentinel) {
			done <- errors.New("decrypted payload mismatch")
			return
		}
		_, err := d.Write(read)
		done <- err
	}()
	if err := p.HandshakeContext(f.ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Write(sentinel); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, len(sentinel))
	if _, err := io.ReadFull(p, echo); err != nil || !bytes.Equal(echo, sentinel) {
		t.Fatal("no decrypted echo", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	for _, wire := range []*recorded{pw, dw} {
		if wire.wire.Len() == 0 || bytes.Contains(wire.wire.Bytes(), sentinel) {
			t.Fatal("relay-boundary capture empty or reveals plaintext")
		}
	}
}

func TestRelayBearerDoesNotAuthenticateReplacementKey(t *testing.T) {
	for _, replace := range []string{"desktop", "phone"} {
		t.Run(replace, func(t *testing.T) {
			f := start(t, &sender{})
			id, token := f.enroll()
			ctrl := f.dial("/v1/control", desktop, 101)
			pw, dw := streams(f, id, token, ctrl)
			phone, desk := testIdentity(t, "phone.invalid"), testIdentity(t, "desktop.invalid")
			pc, dc := peerConfig(phone, desk), peerConfig(desk, phone)
			if replace == "desktop" {
				dc.Certificates = []tls.Certificate{testIdentity(t, "desktop.invalid")}
			} else {
				pc.Certificates = []tls.Certificate{testIdentity(t, "phone.invalid")}
			}
			p, d := tls.Client(pw, pc), tls.Server(dw, dc)
			done := make(chan error, 1)
			go func() { done <- d.HandshakeContext(f.ctx) }()
			clientErr := p.HandshakeContext(f.ctx)
			serverErr := <-done
			if replace == "phone" && serverErr == nil || replace == "desktop" && clientErr == nil {
				t.Fatal("relay-issued route accepted swapped inner identity")
			}
			if errors.Is(serverErr, context.DeadlineExceeded) || errors.Is(clientErr, context.DeadlineExceeded) {
				t.Fatal("timeout instead of authentication failure")
			}
		})
	}
}
