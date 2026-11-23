package main

import (
	"os"
	"syscall"
)

const unitCredentialDir = "/run/credentials/away-relay.service"

// systemd 257 can expose the DynamicUser credential via an ACL on a
// root:root 0440 file inside a root:root 0550 service credential mount.
// An environment variable or a group-readable file outside that mount is
// not a substitute. Do not resolve aliases or trust symlinked mount paths.
func managedCredential(name string, file os.FileInfo) bool {
	dir := os.Getenv("CREDENTIALS_DIRECTORY")
	if dir != unitCredentialDir || name != unitCredentialDir+"/desktop-token" {
		return false
	}
	info, err := os.Lstat(unitCredentialDir)
	if err != nil {
		return false
	}
	dirStat, okDir := info.Sys().(*syscall.Stat_t)
	fileStat, okFile := file.Sys().(*syscall.Stat_t)
	return okDir && okFile && managedCredentialMetadata(name, dir, dirStat, fileStat)
}

func managedCredentialMetadata(name, dir string, parent, file *syscall.Stat_t) bool {
	return dir == unitCredentialDir && name == unitCredentialDir+"/desktop-token" &&
		parent.Uid == 0 && parent.Gid == 0 && parent.Mode == syscall.S_IFDIR|0550 &&
		file.Uid == 0 && file.Gid == 0 && file.Mode == syscall.S_IFREG|0440
}
