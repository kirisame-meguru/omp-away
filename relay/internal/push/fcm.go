// Package push sends wakeups only. It cannot carry application-supplied text.
package push

import (
	"context"
	"errors"
	"net/http"
	"time"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/messaging"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/option"
)

var ErrUnregistered = errors.New("registration no longer valid")

type Sender interface {
	Send(context.Context, *messaging.Message) error
}

type FCM struct{ client *messaging.Client }

func New(ctx context.Context) (*FCM, error) {
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	ctx = context.WithValue(ctx, oauth2.HTTPClient, &http.Client{CheckRedirect: noRedirect, Timeout: 10 * time.Second})
	credentials, err := google.FindDefaultCredentials(ctx, "https://www.googleapis.com/auth/firebase.messaging")
	if err != nil {
		return nil, err
	}
	hc := oauth2.NewClient(ctx, credentials.TokenSource)
	hc.CheckRedirect = noRedirect
	hc.Timeout = 10 * time.Second
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: "omp-away"}, option.WithHTTPClient(hc))
	if err != nil {
		return nil, err
	}
	client, err := app.Messaging(ctx)
	if err != nil {
		return nil, err
	}
	return &FCM{client}, nil
}

func Invite(token, requestID string) *messaging.Message {
	ttl := 45 * time.Second
	return &messaging.Message{
		Token:   token,
		Data:    map[string]string{"requestId": requestID},
		Android: &messaging.AndroidConfig{Priority: "high", TTL: &ttl},
	}
}

func (f *FCM) Send(ctx context.Context, msg *messaging.Message) error {
	_, err := f.client.Send(ctx, msg)
	// Our message has a fixed valid shape. A typed FcmError INVALID_ARGUMENT
	// then identifies an invalid token; a general HTTP 400/BadRequest does not.
	if messaging.IsUnregistered(err) || messaging.IsInvalidArgument(err) {
		return ErrUnregistered
	}
	return err
}
