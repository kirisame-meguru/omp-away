package main

import (
	"strings"
	"testing"
)

func TestVersionMetadataDoesNotRequireRuntimeCredentials(t *testing.T) {
	output := versionText("linux", "arm")
	if !strings.Contains(output, "away-relay dev") || !strings.Contains(output, "commit=unknown") || !strings.Contains(output, "linux/arm") {
		t.Fatalf("missing version metadata: %s", output)
	}
}
