package main

import "fmt"

// Release tooling injects only public source metadata, never host paths or credentials.
var version = "dev"
var commit = "unknown"
var buildEpoch = "0"

func versionText(goos, goarch string) string {
	return fmt.Sprintf("away-relay %s commit=%s epoch=%s %s/%s", version, commit, buildEpoch, goos, goarch)
}
