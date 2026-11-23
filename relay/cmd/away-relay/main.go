// Command away-relay is an HTTP/1.1 backend for a local HTTPS/WSS terminator.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/net/netutil"
	"omp-away/relay/internal/push"
	"omp-away/relay/internal/registration"
	"omp-away/relay/internal/routes"
)

func listenAddr(value string) (string, error) {
	if value == "" {
		value = "127.0.0.1:8787"
	}
	a, err := netip.ParseAddrPort(value)
	if err != nil || !a.Addr().IsLoopback() || a.Addr().Zone() != "" || a.Port() == 0 {
		return "", errors.New("AWAY_LISTEN must specify a literal loopback address and port")
	}
	return a.String(), nil
}

func desktopCredential() (string, error) {
	const message = "AWAY_DESKTOP_TOKEN_FILE must name a protected regular credential file"
	name := os.Getenv("AWAY_DESKTOP_TOKEN_FILE")
	if !filepath.IsAbs(name) {
		return "", errors.New(message)
	}
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New(message)
	}
	f, err := os.Open(name)
	if err != nil {
		return "", errors.New(message)
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) || !opened.Mode().IsRegular() || opened.Size() > 45 {
		return "", errors.New(message)
	}
	if !credentialPrivate(name, f, opened) {
		return "", errors.New(message)
	}
	data, err := io.ReadAll(io.LimitReader(f, 46))
	if err != nil || len(data) > 45 {
		return "", errors.New(message)
	}
	return strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r"), nil
}

func run(ctx context.Context) error {
	if os.Geteuid() == 0 {
		return errors.New("refusing to run as root")
	}
	addr, err := listenAddr(os.Getenv("AWAY_LISTEN"))
	if err != nil {
		return err
	}
	token, err := desktopCredential()
	if err != nil {
		return err
	}
	dir := os.Getenv("AWAY_STATE_DIR")
	if !filepath.IsAbs(dir) {
		return errors.New("AWAY_STATE_DIR must name an absolute directory")
	}
	// systemd DynamicUser's StateDirectory can be a symlink to /var/lib/private.
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() || !statePrivate(dir, info) {
		return errors.New("state directory missing or not private")
	}
	dbName := filepath.Join(dir, "routes.db")
	if info, err := os.Lstat(dbName); err == nil && (!info.Mode().IsRegular() || !statePrivate(dbName, info)) {
		return errors.New("routing database is not private")
	}
	db, err := registration.Open(dbName)
	if err != nil {
		return errors.New("cannot open routing database")
	}
	defer db.Close()
	// Check a newly created database too: Windows applies inherited DACLs, not
	// the POSIX mode requested by bbolt. No routing secrets are written yet.
	dbInfo, err := os.Lstat(dbName)
	if err != nil || !dbInfo.Mode().IsRegular() || !statePrivate(dbName, dbInfo) {
		return errors.New("routing database is not private")
	}
	sender, err := push.New(ctx)
	if err != nil {
		return errors.New("cannot initialize Firebase messaging with ADC")
	}
	h, err := routes.New(token, db, sender)
	if err != nil {
		return err
	}
	defer h.Close()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return errors.New("cannot bind loopback listener")
	}
	defer ln.Close()
	srv := &http.Server{
		Handler: h, BaseContext: func(net.Listener) context.Context { return ctx },
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 12 * time.Second, WriteTimeout: 20 * time.Second,
		IdleTimeout: 45 * time.Second, MaxHeaderBytes: 8192,
		// net/http's default panic/error logger can include client-controlled
		// request details. Service diagnostics below are categorical only.
		ErrorLog: log.New(io.Discard, "", 0),
	}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(netutil.LimitListener(ln, 96)) }()
	select {
	case err = <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("loopback listener stopped")
		}
	case <-ctx.Done():
		h.Close() // http.Server.Shutdown does not own hijacked WebSockets.
		stop, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := srv.Shutdown(stop); err != nil {
			srv.Close()
			return errors.New("shutdown deadline exceeded")
		}
		<-done
	}
	return nil
}
func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "-version") {
		fmt.Println(versionText(runtime.GOOS, runtime.GOARCH))
		return
	}
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: away-relay [--version]")
		os.Exit(2)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
