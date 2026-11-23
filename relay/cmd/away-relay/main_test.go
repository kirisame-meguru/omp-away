package main

import "testing"

func TestBackendCannotBindPublicOrWildcardAddress(t *testing.T) {
	for _, addr := range []string{":8787", "0.0.0.0:8787", "[::]:8787", "192.0.2.8:8787", "localhost:8787", "127.0.0.1:0"} {
		if _, err := listenAddr(addr); err == nil {
			t.Errorf("accepted non-literal, non-loopback or ephemeral address %q", addr)
		}
	}
	for _, addr := range []string{"127.0.0.1:8787", "[::1]:8787"} {
		if _, err := listenAddr(addr); err != nil {
			t.Errorf("rejected %q", addr)
		}
	}
}
