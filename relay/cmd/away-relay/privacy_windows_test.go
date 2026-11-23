package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func currentTestSID(t *testing.T) *windows.SID {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return user.User.Sid
}

func TestWindowsPrivacyRejectsBroadNullAndUnsupportedACLs(t *testing.T) {
	user := currentTestSID(t)
	sid := user.String()
	for _, tc := range []struct {
		name, sddl      string
		directory, want bool
	}{
		{"private file", "O:" + sid + "D:P(A;;FA;;;" + sid + ")(A;;FA;;;SY)(A;;FA;;;BA)", false, true},
		{"private inheritable directory", "O:" + sid + "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", true, true},
		{"inherited private file", "O:" + sid + "D:(A;ID;FA;;;" + sid + ")", false, true},
		{"unprotected directory", "O:" + sid + "D:(A;OICI;FA;;;" + sid + ")", true, false},
		{"everyone read", "O:" + sid + "D:P(A;;FA;;;" + sid + ")(A;;FR;;;WD)", false, false},
		{"users write", "O:" + sid + "D:P(A;;FA;;;" + sid + ")(A;;FW;;;BU)", false, false},
		{"inherit-only public access", "O:" + sid + "D:P(A;OICI;FA;;;" + sid + ")(A;OICIIO;FR;;;WD)", true, false},
		{"broad owner", "O:BUD:P(A;;FA;;;" + sid + ")", false, false},
		{"null dacl", "O:" + sid + "D:NO_ACCESS_CONTROL", false, false},
		{"empty dacl", "O:" + sid + "D:P", false, false},
		{"absent dacl", "O:" + sid, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sd, err := windows.SecurityDescriptorFromString(tc.sddl)
			if err != nil {
				t.Fatal(err)
			}
			if got := windowsDescriptorPrivate(sd, user, tc.directory); got != tc.want {
				t.Fatalf("privacy decision = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestWindowsCredentialAndStateUseDACLNotUnixMode(t *testing.T) {
	root := t.TempDir()
	user := currentTestSID(t)
	sd, err := windows.SecurityDescriptorFromString("O:" + user.String() + "D:P(A;OICI;FA;;;" + user.String() + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(root)
	if err != nil || !statePrivate(root, info) {
		t.Fatal("protected state directory rejected")
	}
	t.Run("state reparse point", func(t *testing.T) {
		alias := filepath.Join(t.TempDir(), "alias")
		if err := os.Symlink(root, alias); err != nil {
			t.Skip("Windows symlink creation requires Developer Mode or the symlink privilege")
		}
		if statePrivate(alias, info) {
			t.Fatal("state directory reparse point accepted")
		}
	})
	path := filepath.Join(root, "desktop-token")
	if err := os.WriteFile(path, []byte("private-fixture\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWAY_DESKTOP_TOKEN_FILE", path)
	if got, err := desktopCredential(); err != nil || got != "private-fixture" {
		t.Fatal("private Windows credential rejected")
	}
	alias := filepath.Join(root, "credential-alias")
	if err := os.Link(path, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := desktopCredential(); err == nil {
		t.Fatal("multiply linked Windows credential accepted")
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	broad, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + user.String() + ")(A;;FR;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	broadACL, _, err := broad.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, broadACL, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := desktopCredential(); err == nil {
		t.Fatal("world-readable Windows credential accepted")
	}
}
