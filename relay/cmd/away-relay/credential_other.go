//go:build !linux && !windows

package main

import "os"

// The systemd credential mount exception is Linux-specific.
func managedCredential(string, os.FileInfo) bool { return false }
