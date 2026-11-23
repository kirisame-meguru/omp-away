package push

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	firebase "firebase.google.com/go/v4"
	"google.golang.org/api/option"
)

func TestFirebaseProjectIDSelection(t *testing.T) {
	for _, tc := range []struct {
		name, override, credential, want string
	}{
		{"credential fallback", "", "example-credential", "example-credential"},
		{"explicit override", "example-override", "example-credential", "example-override"},
		{"override without credential project", "example-override", "", "example-override"},
		{"override ignores invalid credential project", "example-override", "INVALID", "example-override"},
		{"minimum length", "", "abcdef", "abcdef"},
		{"maximum length", "", "a" + strings.Repeat("b", 29), "a" + strings.Repeat("b", 29)},
		{"numeric suffix", "", "example-123", "example-123"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := firebaseProjectID(tc.override, tc.credential)
			if err != nil || got != tc.want {
				t.Fatalf("project selection got %q (%v), want %q", got, err, tc.want)
			}
		})
	}
}

func TestFirebaseProjectIDRejectsMissingAndInvalidConfiguration(t *testing.T) {
	if project, err := firebaseProjectID("", ""); project != "" || err == nil || !strings.Contains(err.Error(), "GOOGLE_CLOUD_PROJECT") {
		t.Fatal("missing project must explain the required configuration")
	}
	for _, invalid := range []string{
		"abcde",
		"a" + strings.Repeat("b", 30),
		"123456",
		"-example",
		"example-",
		"Example-project",
		"example_project",
		"example.project",
		" example-project",
		"example-project ",
		"example-project\n",
		"example/project",
		"example:project",
		"example-\u00e9",
		"example-\x00project",
	} {
		t.Run(invalid, func(t *testing.T) {
			// An invalid override must not silently select the credential project.
			for _, source := range [][2]string{{invalid, "example-credential"}, {"", invalid}} {
				project, err := firebaseProjectID(source[0], source[1])
				if project != "" || err == nil {
					t.Fatal("invalid project configuration accepted")
				}
				if strings.Contains(err.Error(), invalid) || strings.Contains(err.Error(), "example-credential") {
					t.Fatal("configuration error exposed a supplied project value")
				}
			}
		})
	}
}

func TestOnlyTokenSpecificFCMFailuresInvalidate(t *testing.T) {
	for _, tc := range []struct {
		detail, code string
		status       int
		invalid      bool
	}{
		{"google.firebase.fcm.v1.FcmError", "UNREGISTERED", 404, true},
		{"google.firebase.fcm.v1.FcmError", "INVALID_ARGUMENT", 400, true},
		{"google.rpc.BadRequest", "INVALID_ARGUMENT", 400, false},
		{"google.firebase.fcm.v1.FcmError", "SENDER_ID_MISMATCH", 403, false},
	} {
		t.Run(tc.detail+tc.code, func(t *testing.T) {
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/projects/omp-away/messages:send" || r.Method != "POST" {
					t.Error("wrong HTTP v1 route")
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				fmt.Fprintf(w, `{"error":{"code":%d,"status":%q,"message":"failure","details":[{"@type":"type.googleapis.com/%s","errorCode":%q}]}}`, tc.status, tc.code, tc.detail, tc.code)
			}))
			defer srv.Close()
			ctx := context.Background()
			app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: "omp-away"}, option.WithHTTPClient(srv.Client()), option.WithEndpoint(srv.URL))
			if err != nil {
				t.Fatal(err)
			}
			client, err := app.Messaging(ctx)
			if err != nil {
				t.Fatal(err)
			}
			err = (&FCM{client}).Send(ctx, Invite("example-fcm-token", "8ec174f2-3086-41d3-aa45-34c8ece00b65"))
			if err == nil || errors.Is(err, ErrUnregistered) != tc.invalid {
				t.Fatal("incorrect classification of provider response")
			}
		})
	}
}
