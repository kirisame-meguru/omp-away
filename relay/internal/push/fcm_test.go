package push

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	firebase "firebase.google.com/go/v4"
	"google.golang.org/api/option"
)

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
