//go:build !windows

package main

import "os"

func credentialPrivate(name string, _ *os.File, info os.FileInfo) bool {
	return info.Mode().Perm()&0077 == 0 || managedCredential(name, info)
}

func statePrivate(_ string, info os.FileInfo) bool {
	return info != nil && info.Mode().Perm()&0077 == 0
}
