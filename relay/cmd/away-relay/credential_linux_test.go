package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestManagedCredentialRequiresExactUnitAndProtectedRootMetadata(t *testing.T) {
	const dir = "/run/credentials/away-relay.service"
	const name = dir + "/desktop-token"
	base := syscall.Stat_t{Uid: 0, Gid: 0, Mode: syscall.S_IFDIR | 0550}
	leaf := syscall.Stat_t{Uid: 0, Gid: 0, Mode: syscall.S_IFREG | 0440}
	if !managedCredentialMetadata(name, dir, &base, &leaf) {
		t.Fatal("rejected systemd 257 DynamicUser mount")
	}
	for _, tc := range []struct{ name, dir string }{
		{name, ""}, {name, "/tmp"}, {dir + "/google-adc", dir}, {dir + "/./desktop-token", dir},
		{"/run/credentials/other.service/desktop-token", "/run/credentials/other.service"},
	} {
		if managedCredentialMetadata(tc.name, tc.dir, &base, &leaf) {
			t.Fatal("trusted substituted credential path")
		}
	}
	for _, bad := range []syscall.Stat_t{{Uid: 1, Mode: syscall.S_IFDIR | 0550}, {Gid: 1, Mode: syscall.S_IFDIR | 0550}, {Mode: syscall.S_IFDIR | 0750}, {Mode: syscall.S_IFDIR | 0555}, {Mode: syscall.S_IFLNK | 0550}} {
		if managedCredentialMetadata(name, dir, &bad, &leaf) {
			t.Fatal("trusted insecure mount directory")
		}
	}
	for _, bad := range []syscall.Stat_t{{Uid: 1, Mode: syscall.S_IFREG | 0440}, {Gid: 1, Mode: syscall.S_IFREG | 0440}, {Mode: syscall.S_IFREG | 0640}, {Mode: syscall.S_IFREG | 0444}, {Mode: syscall.S_IFLNK | 0440}} {
		if managedCredentialMetadata(name, dir, &base, &bad) {
			t.Fatal("trusted insecure mount file")
		}
	}
}

func TestOrdinaryBearerRejectsGroupAccessAndSymlink(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "desktop-token")
	t.Setenv("CREDENTIALS_DIRECTORY", dir)
	t.Setenv("AWAY_DESKTOP_TOKEN_FILE", path)
	if err := os.WriteFile(path, []byte("private-fixture\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := desktopCredential(); err != nil || got != "private-fixture" {
		t.Fatal("private file rejected")
	}
	if err := os.Chmod(path, 0440); err != nil {
		t.Fatal(err)
	}
	if _, err := desktopCredential(); err == nil {
		t.Fatal("trusted group-readable ordinary path")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(dir, "alias")
	if err := os.Symlink(path, alias); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWAY_DESKTOP_TOKEN_FILE", alias)
	if _, err := desktopCredential(); err == nil {
		t.Fatal("trusted symlink to private file")
	}
}
