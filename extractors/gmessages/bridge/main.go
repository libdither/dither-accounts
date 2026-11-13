// SPDX-License-Identifier: AGPL-3.0-or-later
//
// dither-gm-bridge: Google Messages (SMS, MMS and RCS through your Android phone, as messages.google.com) for
// dither-accounts' gmessages extractor, through libgm from mautrix-gmessages (AGPL-3.0-or-later, so this program is
// too: see LICENSE beside it). It is a separate program on purpose; the TypeScript side only speaks to it in JSON
// lines.
//
//	stdin   {"id":"1","op":"connect","session":{...}}   one command per line
//	stdout  {"t":"reply","id":"1","ok":true,"result":{...}}, and events: {"t":"qr",...} {"t":"message",...}
//	stderr  its log
//
// It keeps nothing on disk. The session (libgm's AuthData) comes in with connect and goes out as {"t":"session"}
// whenever it changes (pairing, token refresh, rotated cookies); the TypeScript side keeps it in secret.json.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/exhttp"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/util"
)

const version = "0.1.0"

// How long one QR code lasts and how many follow before giving up (mautrix-gmessages' numbers).
var qrExpiry = 30 * time.Second

const qrAttempts = 6

// Phone-side failures a send is retried on, and after how long.
var sendRetryBackoff = []time.Duration{3 * time.Second, 8 * time.Second, 20 * time.Second}

type Bridge struct {
	log   zerolog.Logger
	ctx   context.Context
	outMu sync.Mutex
	out   io.Writer

	// How it reaches Google: exhttp's sensible settings, through a proxy if one was given.
	http exhttp.ClientSettings
	// How often the phone is pinged. mautrix-gmessages' default: libgm's own minute drains phones' batteries.
	pingInterval time.Duration

	mu         sync.Mutex
	cli        *libgm.Client
	auth       *libgm.AuthData
	pairCancel context.CancelFunc
	settings   *gmproto.Settings
	selfIDs    map[string]bool
	convs      map[string]*gmproto.Conversation
	lastSess   [32]byte
}

func NewBridge(ctx context.Context, out io.Writer, log zerolog.Logger) *Bridge {
	return &Bridge{ctx: ctx, out: out, log: log, http: exhttp.SensibleClientSettings, pingInterval: 20 * time.Minute, selfIDs: map[string]bool{}, convs: map[string]*gmproto.Conversation{}}
}

func (b *Bridge) emit(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		b.log.Error().Err(err).Msg("marshal")
		return
	}
	b.outMu.Lock()
	defer b.outMu.Unlock()
	_, _ = b.out.Write(append(data, '\n'))
}

type ev map[string]any

func (b *Bridge) reply(id string, result any, err error) {
	if err != nil {
		b.emit(ev{"t": "reply", "id": id, "ok": false, "error": err.Error()})
		return
	}
	b.emit(ev{"t": "reply", "id": id, "ok": true, "result": result})
}

// ---------------------------------------------------------------- session

func sessionJSON(ad *libgm.AuthData) ([]byte, error) {
	ad.CookiesLock.RLock()
	defer ad.CookiesLock.RUnlock()
	return json.Marshal(ad)
}

// emitSession prints the session when it differs from what was last printed (force: always).
func (b *Bridge) emitSession(force bool) {
	b.mu.Lock()
	ad := b.auth
	b.mu.Unlock()
	if ad == nil {
		return
	}
	data, err := sessionJSON(ad)
	if err != nil {
		b.log.Error().Err(err).Msg("marshal session")
		return
	}
	h := sha256.Sum256(data)
	b.mu.Lock()
	same := h == b.lastSess
	b.lastSess = h
	b.mu.Unlock()
	if same && !force {
		return
	}
	b.emit(ev{"t": "session", "session": json.RawMessage(data)})
}

// ---------------------------------------------------------------- the client

func (b *Bridge) newClient(ad *libgm.AuthData, component string) *libgm.Client {
	return libgm.NewClient(ad, nil, b.log.With().Str("component", component).Logger(), b.http)
}

func (b *Bridge) client() (*libgm.Client, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cli == nil {
		return nil, errors.New("not connected to Google Messages")
	}
	return b.cli, nil
}

// dropClient: the session is gone (unpaired, logged out). Disconnect and forget it.
func (b *Bridge) dropClient() {
	b.mu.Lock()
	cli := b.cli
	b.cli, b.auth = nil, nil
	b.mu.Unlock()
	if cli != nil {
		cli.SetEventHandler(nil)
		cli.Disconnect()
	}
}

// start connects a paired session. It answers what connect replies.
func (b *Bridge) start(ad *libgm.AuthData) (any, error) {
	b.mu.Lock()
	old := b.cli
	b.mu.Unlock()
	if old != nil {
		old.SetEventHandler(nil)
		old.Disconnect()
	}
	cli := b.newClient(ad, "libgm")
	cli.SetPingInterval(b.pingInterval)
	// An unanswered ping is retried with doubling timeouts: 1 + 2 + 4 + 8 = 15 minutes before "not responding".
	cli.SetAlertTimeoutCount(4)
	cli.SetEventHandler(b.onEvent)
	b.mu.Lock()
	b.cli, b.auth = cli, ad
	b.mu.Unlock()
	ctx := b.log.WithContext(b.ctx)
	if err := cli.FetchConfig(ctx); err != nil {
		b.log.Warn().Err(err).Msg("fetching the Google Messages config failed")
	} else if ad.IsGoogleAccount() && cli.Config.GetDeviceInfo().GetEmail() == "" {
		b.emit(ev{"t": "logged_out", "reason": "no_email", "error": "Google no longer accepts this sign-in (no account in its config)"})
		b.dropClient()
		return ev{"paired": true, "loggedOut": true}, nil
	}
	if err := cli.Connect(ctx); err != nil {
		switch {
		case errors.Is(err, events.ErrRequestedEntityNotFound):
			b.emit(ev{"t": "unpaired", "reason": "not_found", "error": err.Error()})
			b.dropClient()
			return ev{"paired": false, "unpaired": true}, nil
		case errors.Is(err, events.ErrInvalidCredentials):
			b.emit(ev{"t": "logged_out", "reason": "invalid_credentials", "error": err.Error()})
			b.dropClient()
			return ev{"paired": true, "loggedOut": true}, nil
		}
		b.dropClient()
		return nil, fmt.Errorf("connecting: %w", err)
	}
	b.emitSession(false)
	b.emit(ev{"t": "connected", "google": ad.IsGoogleAccount(), "account": googleAccount(ad, cli), "sessionId": cli.CurrentSessionID()})
	return ev{"paired": true}, nil
}

func googleAccount(ad *libgm.AuthData, cli *libgm.Client) string {
	if !ad.IsGoogleAccount() {
		return ""
	}
	if e := cli.Config.GetDeviceInfo().GetEmail(); e != "" {
		return e
	}
	return ad.Mobile.GetSourceID()
}

func (b *Bridge) onEvent(raw any) {
	// libgm calls this synchronously: nothing here may block or make a request.
	switch evt := raw.(type) {
	case *events.ListenFatalError:
		if errors.Is(evt.Error, events.ErrInvalidCredentials) || evt.Error.Error() == "http 401 while polling" {
			b.emit(ev{"t": "logged_out", "reason": "invalid_credentials", "error": evt.Error.Error()})
			go b.dropClient()
		} else {
			b.emit(ev{"t": "listen_error", "fatal": true, "error": evt.Error.Error()})
		}
	case *events.ListenTemporaryError:
		b.emit(ev{"t": "listen_error", "fatal": false, "error": evt.Error.Error()})
	case *events.ListenRecovered:
		b.emit(ev{"t": "listen_recovered"})
	case *events.PhoneNotResponding:
		b.emit(ev{"t": "phone", "responding": false})
	case *events.PhoneRespondingAgain:
		b.emit(ev{"t": "phone", "responding": true})
	case *events.PingFailed:
		if errors.Is(evt.Error, events.ErrRequestedEntityNotFound) {
			b.emit(ev{"t": "unpaired", "reason": "not_found", "error": evt.Error.Error()})
			go b.dropClient()
		} else {
			b.emit(ev{"t": "ping_failed", "error": evt.Error.Error(), "count": evt.ErrorCount})
		}
	case *gmproto.RevokePairData:
		b.emit(ev{"t": "unpaired", "reason": "revoked"})
		go b.dropClient()
	case *events.GaiaLoggedOut:
		b.emit(ev{"t": "unpaired", "reason": "google_logged_out"})
		go b.dropClient()
	case *events.AuthTokenRefreshed:
		go b.emitSession(false)
	case *gmproto.Conversation:
		b.mu.Lock()
		b.convs[evt.GetConversationID()] = evt
		b.mu.Unlock()
		b.emit(ev{"t": "conversation", "conversation": mapConversation(evt)})
	case *libgm.WrappedMessage:
		b.mu.Lock()
		self := b.selfIDs
		b.mu.Unlock()
		m := mapMessage(evt.Message, self)
		m.Old = evt.IsOld
		b.emit(ev{"t": "message", "message": m})
	case *gmproto.TypingData:
		b.emit(ev{"t": "typing", "conversation": evt.GetConversationID(), "number": evt.GetUser().GetNumber(), "stop": evt.GetType() == gmproto.TypingTypes_STOPPED_TYPING})
	case *gmproto.UserAlertEvent:
		if name := alertName(evt.GetAlertType()); name != "" {
			b.emit(ev{"t": "alert", "alert": name})
		}
	case *gmproto.Settings:
		if evt.GetSIMCards() != nil {
			b.mu.Lock()
			b.settings = evt
			b.selfIDs = map[string]bool{}
			for _, c := range evt.GetSIMCards() {
				if id := c.GetSIMParticipant().GetID(); id != "" {
					b.selfIDs[id] = true
				}
			}
			b.mu.Unlock()
		}
		b.emit(ev{"t": "settings", "settings": mapSettings(evt)})
	case *events.AccountChange:
		b.emit(ev{"t": "account_change", "account": evt.GetAccount(), "enabled": evt.GetEnabled(), "fake": evt.IsFake})
	case *events.NoDataReceived:
		b.emit(ev{"t": "no_data"})
	case *events.HackySetActiveMayFail:
		b.emit(ev{"t": "set_active_may_fail"})
	default:
		b.log.Debug().Type("type", raw).Msg("unhandled libgm event")
	}
}

// ---------------------------------------------------------------- pairing

func (b *Bridge) cancelPairing() {
	b.mu.Lock()
	c := b.pairCancel
	b.pairCancel = nil
	b.mu.Unlock()
	if c != nil {
		c()
	}
}

// startQR: messages.google.com's old way. Google has been retiring it (mautrix-gmessages turned it off in v26.05);
// it is kept for phones that still offer "QR code scanner" under Device pairing.
func (b *Bridge) startQR() (any, error) {
	b.cancelPairing()
	ad := libgm.NewAuthData()
	cli := b.newClient(ad, "libgm-qr")
	cli.SetEventHandler(func(evt any) { b.log.Debug().Type("type", evt).Msg("event while pairing") })
	paired := make(chan *gmproto.PairedData, 1)
	cb := func(d *gmproto.PairedData) {
		select {
		case paired <- d:
		default:
		}
	}
	cli.PairCallback.Store(&cb)
	ctx, cancel := context.WithCancel(b.log.WithContext(b.ctx))
	if err := cli.FetchConfig(ctx); err != nil {
		cancel()
		return nil, fmt.Errorf("could not reach Google Messages: %w", err)
	}
	qr, err := cli.StartLogin(ctx)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("Google would not start a QR pairing: %w", err)
	}
	b.mu.Lock()
	b.pairCancel = cancel
	b.mu.Unlock()
	b.emit(ev{"t": "qr", "url": qr, "expiresMs": qrExpiry.Milliseconds(), "attempt": 1, "of": qrAttempts})
	go b.qrLoop(ctx, cancel, cli, ad, paired)
	return ev{"started": true}, nil
}

func (b *Bridge) qrLoop(ctx context.Context, cancel context.CancelFunc, cli *libgm.Client, ad *libgm.AuthData, paired chan *gmproto.PairedData) {
	defer cancel()
	for attempt := 1; ; attempt++ {
		t := time.NewTimer(qrExpiry)
		select {
		case d := <-paired:
			t.Stop()
			cli.Disconnect()
			b.paired(ad, "qr", d.GetMobile().GetSourceID(), 2*time.Second)
			return
		case <-ctx.Done():
			t.Stop()
			cli.Disconnect()
			return
		case <-t.C:
			if attempt >= qrAttempts {
				cli.Disconnect()
				b.emit(ev{"t": "qr_expired"})
				return
			}
			qr, err := cli.RefreshPhoneRelay()
			if err != nil {
				cli.Disconnect()
				b.emit(ev{"t": "pair_error", "via": "qr", "code": "refresh", "error": fmt.Sprintf("could not get a new QR code: %v", err)})
				return
			}
			b.emit(ev{"t": "qr", "url": qr, "expiresMs": qrExpiry.Milliseconds(), "attempt": attempt + 1, "of": qrAttempts})
		}
	}
}

// pairGoogle: pairing by Google account, as messages.google.com does now: the account's cookies, then an emoji to
// tap on the phone.
func (b *Bridge) pairGoogle(rawCookies string) (any, error) {
	cookies, err := ParseCookies(rawCookies)
	if err != nil {
		return nil, err
	}
	b.cancelPairing()
	ad := libgm.NewAuthData()
	ad.SetCookies(cookies)
	cli := b.newClient(ad, "libgm-google")
	cli.SetEventHandler(func(evt any) { b.log.Debug().Type("type", evt).Msg("event while pairing") })
	ctx := b.log.WithContext(b.ctx)
	if err := cli.FetchConfig(ctx); err != nil {
		var he events.HTTPError
		if errors.As(err, &he) && (he.Resp.StatusCode == http.StatusUnauthorized || he.Resp.StatusCode == http.StatusForbidden) {
			return nil, fmt.Errorf("Google did not accept these cookies (http %d): sign in at messages.google.com again and copy fresh ones", he.Resp.StatusCode)
		}
		return nil, fmt.Errorf("could not reach Google Messages: %w", err)
	}
	bg, cancel := context.WithCancel(ctx)
	emoji, sess, err := cli.StartGaiaPairing(ctx, bg)
	if err != nil {
		cancel()
		cli.Disconnect()
		return nil, gaiaError(err)
	}
	b.mu.Lock()
	b.pairCancel = cancel
	b.mu.Unlock()
	b.emit(ev{"t": "emoji", "emoji": emoji, "svg": libgm.GetEmojiSVG(emoji)})
	go func() {
		defer cancel()
		phoneID, err := cli.FinishGaiaPairing(bg, sess)
		cli.Disconnect()
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			e := gaiaError(err)
			b.emit(ev{"t": "pair_error", "via": "google", "code": gaiaCode(err), "error": e.Error()})
			return
		}
		b.paired(ad, "google", phoneID, 0)
	}()
	return ev{"emoji": emoji}, nil
}

func gaiaCode(err error) string {
	switch {
	case errors.Is(err, libgm.ErrNoDevicesFound):
		return "no_devices"
	case errors.Is(err, libgm.ErrPairingInitTimeout):
		return "phone_not_responding"
	case errors.Is(err, events.ErrCallerNoPermission):
		return "no_permission"
	case errors.Is(err, libgm.ErrIncorrectEmoji):
		return "wrong_emoji"
	case errors.Is(err, libgm.ErrPairingCancelled):
		return "cancelled"
	case errors.Is(err, libgm.ErrPairingTimeout):
		return "timeout"
	}
	return "unknown"
}

func gaiaError(err error) error {
	switch gaiaCode(err) {
	case "no_devices":
		return errors.New("no phone found for this Google account: in Google Messages on the phone, sign in with the same account (Settings → Google account) and turn on Device pairing")
	case "phone_not_responding":
		return errors.New("the phone did not answer: keep it online with Google Messages open, and try again")
	case "no_permission":
		return errors.New("this Google account may not use Google Messages for web")
	case "wrong_emoji":
		return errors.New("a different emoji was tapped on the phone; try again")
	case "cancelled":
		return errors.New("pairing was cancelled on the phone")
	case "timeout":
		return errors.New("the emoji was not tapped in time; try again")
	}
	return fmt.Errorf("pairing failed: %w", err)
}

func (b *Bridge) paired(ad *libgm.AuthData, via, phone string, settle time.Duration) {
	b.mu.Lock()
	b.auth = ad
	b.mu.Unlock()
	data, _ := sessionJSON(ad)
	b.emit(ev{"t": "paired", "via": via, "phone": phone, "session": json.RawMessage(data)})
	// The phone saves the pairing for a moment; connecting too soon gets the new session unpaired again.
	time.Sleep(settle)
	if _, err := b.start(ad); err != nil {
		b.emit(ev{"t": "connect_error", "error": err.Error()})
	}
}

// ---------------------------------------------------------------- commands

type command struct {
	ID string `json:"id"`
	Op string `json:"op"`
}

func (b *Bridge) handleLine(line []byte) {
	var c command
	if err := json.Unmarshal(line, &c); err != nil || c.ID == "" {
		b.log.Warn().Str("line", string(line)).Msg("not a command")
		return
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				b.reply(c.ID, nil, fmt.Errorf("%s panicked: %v", c.Op, r))
			}
		}()
		result, err := b.run(c.Op, line)
		b.reply(c.ID, result, err)
	}()
}

func decode[T any](raw []byte) (T, error) {
	var v T
	err := json.Unmarshal(raw, &v)
	return v, err
}

func (b *Bridge) conv(ctx context.Context, cli *libgm.Client, id string) (*gmproto.Conversation, error) {
	b.mu.Lock()
	c := b.convs[id]
	b.mu.Unlock()
	if c != nil {
		return c, nil
	}
	c, err := cli.GetConversation(ctx, id)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, errors.New("no such conversation on the phone")
	}
	b.mu.Lock()
	b.convs[id] = c
	b.mu.Unlock()
	return c, nil
}

// sim: the SIM to send from in a conversation: the settings' SIM for its outgoing participant, else its own.
func (b *Bridge) sim(c *gmproto.Conversation, outgoing string) *gmproto.SIMPayload {
	b.mu.Lock()
	s := b.settings
	b.mu.Unlock()
	if p := SIMPayloadFor(s, outgoing); p != nil {
		return p
	}
	return c.GetSimCard().GetSIMData().GetSIMPayload()
}

func (b *Bridge) run(op string, raw []byte) (any, error) {
	ctx := b.log.WithContext(b.ctx)
	switch op {
	case "connect":
		a, err := decode[struct {
			Session json.RawMessage `json:"session"`
		}](raw)
		if err != nil {
			return nil, err
		}
		if len(a.Session) == 0 || string(a.Session) == "null" {
			return ev{"paired": false}, nil
		}
		ad := &libgm.AuthData{}
		if err := json.Unmarshal(a.Session, ad); err != nil {
			return nil, fmt.Errorf("the stored session does not parse: %w", err)
		}
		if ad.Browser == nil || ad.TachyonAuthToken == nil {
			return ev{"paired": false}, nil
		}
		// libgm needs both keys of a session; one without them (a hand-edited or torn secret.json) cannot connect.
		if ad.RefreshKey == nil || len(ad.RefreshKey.D) == 0 || ad.RequestCrypto == nil || len(ad.RequestCrypto.AESKey) == 0 {
			b.log.Warn().Msg("the stored session lacks its keys; pairing again")
			return ev{"paired": false, "incomplete": true}, nil
		}
		return b.start(ad)
	case "startQr":
		return b.startQR()
	case "pairGoogle":
		a, err := decode[struct {
			Cookies string `json:"cookies"`
		}](raw)
		if err != nil {
			return nil, err
		}
		return b.pairGoogle(a.Cookies)
	case "parseCookies":
		a, _ := decode[struct {
			Cookies string `json:"cookies"`
		}](raw)
		c, err := ParseCookies(a.Cookies)
		if err != nil {
			return nil, err
		}
		names := make([]string, 0, len(c))
		for k := range c {
			names = append(names, k)
		}
		return ev{"names": names}, nil
	case "cancelPairing":
		b.cancelPairing()
		return ev{}, nil
	case "status":
		b.mu.Lock()
		cli, ad := b.cli, b.auth
		pairing := b.pairCancel != nil
		b.mu.Unlock()
		out := ev{"version": version, "pairing": pairing, "client": cli != nil}
		if cli != nil {
			out["connected"] = cli.IsConnected()
			out["loggedIn"] = cli.IsLoggedIn()
			out["sessionId"] = cli.CurrentSessionID()
		}
		if ad != nil {
			out["google"] = ad.IsGoogleAccount()
			out["tokenExpiry"] = ad.TachyonExpiry.UnixMilli()
		}
		return out, nil
	case "session":
		b.emitSession(true)
		return ev{}, nil
	}

	cli, err := b.client()
	if err != nil {
		return nil, err
	}
	switch op {
	case "reconnect":
		return ev{}, cli.Reconnect(ctx)
	case "setActive":
		return ev{}, cli.SetActiveSession(ctx)
	case "logout":
		err := cli.Unpair(ctx)
		b.dropClient()
		if err != nil {
			b.log.Warn().Err(err).Msg("unpair request failed; forgetting the session anyway")
		}
		return ev{}, nil
	case "conversations":
		a, err := decode[struct {
			Count  int64  `json:"count"`
			Folder string `json:"folder"`
		}](raw)
		if err != nil {
			return nil, err
		}
		folder := gmproto.ListConversationsRequest_INBOX
		switch a.Folder {
		case "archive":
			folder = gmproto.ListConversationsRequest_ARCHIVE
		case "spam":
			folder = gmproto.ListConversationsRequest_SPAM_BLOCKED
		}
		if a.Count <= 0 {
			a.Count = 25
		}
		resp, err := cli.ListConversations(ctx, &gmproto.ListConversationsRequest{Count: a.Count, Folder: folder})
		if err != nil {
			return nil, err
		}
		out := []Conversation{}
		b.mu.Lock()
		for _, c := range resp.GetConversations() {
			b.convs[c.GetConversationID()] = c
			out = append(out, mapConversation(c))
		}
		b.mu.Unlock()
		return ev{"conversations": out}, nil
	case "conversation":
		a, err := decode[struct {
			Conversation string `json:"conversation"`
		}](raw)
		if err != nil {
			return nil, err
		}
		c, err := cli.GetConversation(ctx, a.Conversation)
		if err != nil {
			return nil, err
		}
		if c == nil {
			return nil, errors.New("no such conversation on the phone")
		}
		b.mu.Lock()
		b.convs[a.Conversation] = c
		b.mu.Unlock()
		return ev{"conversation": mapConversation(c)}, nil
	case "messages":
		a, err := decode[struct {
			Conversation string `json:"conversation"`
			Count        int64  `json:"count"`
			Cursor       *struct {
				ID string `json:"id"`
				Ts int64  `json:"ts"`
			} `json:"cursor"`
		}](raw)
		if err != nil {
			return nil, err
		}
		var cursor *gmproto.Cursor
		if a.Cursor != nil && a.Cursor.ID != "" {
			cursor = &gmproto.Cursor{LastItemID: a.Cursor.ID, LastItemTimestamp: a.Cursor.Ts}
		}
		if a.Count <= 0 || a.Count > 100 {
			a.Count = 25
		}
		resp, err := cli.FetchMessages(ctx, a.Conversation, a.Count, cursor)
		if err != nil {
			return nil, err
		}
		b.mu.Lock()
		self := b.selfIDs
		b.mu.Unlock()
		msgs := []Message{}
		for _, m := range resp.GetMessages() {
			mm := mapMessage(m, self)
			mm.Old = true
			msgs = append(msgs, mm)
		}
		out := ev{"messages": msgs, "total": resp.GetTotalMessages()}
		if c := resp.GetCursor(); c != nil && c.GetLastItemID() != "" {
			out["cursor"] = ev{"id": c.GetLastItemID(), "ts": c.GetLastItemTimestamp()}
		}
		return out, nil
	case "send":
		return b.send(ctx, cli, raw)
	case "react":
		a, err := decode[struct {
			Conversation string `json:"conversation"`
			Message      string `json:"message"`
			Emoji        string `json:"emoji"`
			Action       string `json:"action"`
		}](raw)
		if err != nil {
			return nil, err
		}
		action := gmproto.SendReactionRequest_ADD
		switch a.Action {
		case "remove":
			action = gmproto.SendReactionRequest_REMOVE
		case "switch":
			action = gmproto.SendReactionRequest_SWITCH
		}
		req := &gmproto.SendReactionRequest{MessageID: a.Message, ReactionData: gmproto.MakeReactionData(a.Emoji), Action: action}
		if action != gmproto.SendReactionRequest_REMOVE && a.Conversation != "" {
			if c, err := b.conv(ctx, cli, a.Conversation); err == nil {
				req.SIMPayload = b.sim(c, c.GetDefaultOutgoingID())
			}
		}
		resp, err := cli.SendReaction(ctx, req)
		if err != nil {
			return nil, err
		}
		if !resp.GetSuccess() {
			return nil, errors.New("the phone did not take the reaction")
		}
		return ev{}, nil
	case "markRead":
		a, err := decode[struct {
			Conversation string `json:"conversation"`
			Message      string `json:"message"`
		}](raw)
		if err != nil {
			return nil, err
		}
		return ev{}, cli.MarkRead(ctx, a.Conversation, a.Message)
	case "typing":
		a, err := decode[struct {
			Conversation string `json:"conversation"`
		}](raw)
		if err != nil {
			return nil, err
		}
		var sim *gmproto.SIMPayload
		if c, err := b.conv(ctx, cli, a.Conversation); err == nil {
			sim = b.sim(c, c.GetDefaultOutgoingID())
		}
		return ev{}, cli.SetTyping(ctx, a.Conversation, sim)
	case "delete":
		a, err := decode[struct {
			Message string `json:"message"`
		}](raw)
		if err != nil {
			return nil, err
		}
		resp, err := cli.DeleteMessage(ctx, a.Message)
		if err != nil {
			return nil, err
		}
		if !resp.GetSuccess() {
			return nil, errors.New("the phone did not delete it")
		}
		return ev{}, nil
	case "download":
		a, err := decode[struct {
			MediaID string `json:"mediaId"`
			Key     string `json:"key"`
			Dest    string `json:"dest"`
		}](raw)
		if err != nil {
			return nil, err
		}
		return download(cli, a.MediaID, a.Key, a.Dest)
	case "thumbnails":
		a, err := decode[struct {
			IDs []string `json:"ids"`
		}](raw)
		if err != nil {
			return nil, err
		}
		resp, err := cli.GetParticipantThumbnail(ctx, a.IDs...)
		if err != nil {
			return nil, err
		}
		out := []ev{}
		for _, t := range resp.GetThumbnail() {
			if img := t.GetData().GetImageBuffer(); len(img) > 0 {
				out = append(out, ev{"id": t.GetIdentifier(), "mime": http.DetectContentType(img), "base64": base64.StdEncoding.EncodeToString(img)})
			}
		}
		return ev{"thumbnails": out}, nil
	case "fullMedia":
		a, err := decode[struct {
			Message string `json:"message"`
			Part    string `json:"part"`
		}](raw)
		if err != nil {
			return nil, err
		}
		_, err = cli.GetFullSizeImage(ctx, a.Message, a.Part)
		return ev{}, err
	case "getOrCreate":
		a, err := decode[struct {
			Numbers []string `json:"numbers"`
			Name    string   `json:"name"`
		}](raw)
		if err != nil {
			return nil, err
		}
		req := &gmproto.GetOrCreateConversationRequest{}
		for _, n := range a.Numbers {
			req.Numbers = append(req.Numbers, &gmproto.ContactNumber{MysteriousInt: 2, Number: n, Number2: n})
		}
		resp, err := cli.GetOrCreateConversation(ctx, req)
		if err != nil {
			return nil, err
		}
		if resp.GetStatus() == gmproto.GetOrCreateConversationResponse_CREATE_RCS && len(a.Numbers) > 1 {
			name := a.Name
			if name == "" {
				name = "Group"
			}
			yes := true
			req.RCSGroupName, req.CreateRCSGroup = &name, &yes
			if resp, err = cli.GetOrCreateConversation(ctx, req); err != nil {
				return nil, err
			}
		}
		c := resp.GetConversation()
		if c == nil {
			return nil, fmt.Errorf("the phone made no conversation (%s)", resp.GetStatus())
		}
		b.mu.Lock()
		b.convs[c.GetConversationID()] = c
		b.mu.Unlock()
		return ev{"conversation": mapConversation(c)}, nil
	}
	return nil, fmt.Errorf("unknown op %q", op)
}

func (b *Bridge) send(ctx context.Context, cli *libgm.Client, raw []byte) (any, error) {
	a, err := decode[struct {
		Conversation string `json:"conversation"`
		Text         string `json:"text"`
		ReplyTo      string `json:"replyTo"`
		Outgoing     string `json:"outgoing"`
		ForceRCS     bool   `json:"forceRcs"`
		TmpID        string `json:"tmpId"`
		Media        *struct {
			Path string `json:"path"`
			Name string `json:"name"`
			Mime string `json:"mime"`
		} `json:"media"`
	}](raw)
	if err != nil {
		return nil, err
	}
	c, err := b.conv(ctx, cli, a.Conversation)
	if err != nil {
		return nil, fmt.Errorf("looking up the conversation: %w", err)
	}
	outgoing := a.Outgoing
	if outgoing == "" {
		outgoing = c.GetDefaultOutgoingID()
	}
	tmp := a.TmpID
	if tmp == "" {
		tmp = util.GenerateTmpID()
	}
	req := &gmproto.SendMessageRequest{
		ConversationID: a.Conversation,
		MessagePayload: &gmproto.MessagePayload{TmpID: tmp, ConversationID: a.Conversation, ParticipantID: outgoing, TmpID2: tmp},
		SIMPayload:     b.sim(c, outgoing),
		TmpID:          tmp,
		ForceRCS:       a.ForceRCS && c.GetType() == gmproto.ConversationType_RCS && c.GetSendMode() == gmproto.ConversationSendMode_SEND_MODE_AUTO,
	}
	if a.ReplyTo != "" {
		req.Reply = &gmproto.ReplyPayload{MessageID: a.ReplyTo}
	}
	if a.Media != nil {
		data, err := os.ReadFile(a.Media.Path)
		if err != nil {
			return nil, fmt.Errorf("reading the attachment: %w", err)
		}
		mc, err := cli.UploadMedia(data, a.Media.Name, a.Media.Mime)
		if err != nil {
			return nil, fmt.Errorf("uploading the attachment: %w", err)
		}
		req.MessagePayload.MessageInfo = append(req.MessagePayload.MessageInfo, &gmproto.MessageInfo{Data: &gmproto.MessageInfo_MediaContent{MediaContent: mc}})
	}
	if a.Text != "" {
		req.MessagePayload.MessageInfo = append(req.MessagePayload.MessageInfo, &gmproto.MessageInfo{Data: &gmproto.MessageInfo_MessageContent{MessageContent: &gmproto.MessageContent{Content: a.Text}}})
	}
	if len(req.MessagePayload.MessageInfo) == 0 {
		return nil, errors.New("nothing to send")
	}
	resp, err := cli.SendMessage(ctx, req)
	for attempt := 0; err == nil && transient(resp.GetStatus()) && attempt < len(sendRetryBackoff); attempt++ {
		b.log.Warn().Str("status", resp.GetStatus().String()).Int("attempt", attempt+1).Msg("the phone refused a send for now; retrying")
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(sendRetryBackoff[attempt]):
		}
		resp, err = cli.SendMessage(ctx, req)
	}
	if err != nil {
		if errors.Is(err, libgm.ErrPhoneNotResponding) {
			return nil, fmt.Errorf("phone_not_responding: the phone did not answer; it may still send the message when it is back online")
		}
		return nil, err
	}
	if resp.GetStatus() != gmproto.SendMessageResponse_SUCCESS {
		hint := ""
		if resp.GetStatus() == gmproto.SendMessageResponse_FAILURE_4 {
			hint = " (is Google Messages the phone's default SMS app?)"
		}
		return nil, fmt.Errorf("the phone refused the message: %s%s", resp.GetStatus(), hint)
	}
	return ev{"tmpId": tmp, "status": resp.GetStatus().String()}, nil
}

func transient(s gmproto.SendMessageResponse_Status) bool {
	return s == gmproto.SendMessageResponse_FAILURE_2 || s == gmproto.SendMessageResponse_FAILURE_3
}

func download(cli *libgm.Client, mediaID, key, dest string) (any, error) {
	k, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(k) == 0 {
		return nil, errors.New("no key for that attachment")
	}
	if dest == "" || !filepath.IsAbs(dest) {
		return nil, errors.New("download needs an absolute dest")
	}
	r, err := cli.DownloadMedia(mediaID, k)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	n, err := io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(dest)
		return nil, err
	}
	head := make([]byte, 512)
	mime := ""
	if f, err := os.Open(dest); err == nil {
		m, _ := f.Read(head)
		_ = f.Close()
		mime = http.DetectContentType(head[:m])
	}
	return ev{"size": n, "mime": mime}, nil
}

// ---------------------------------------------------------------- main

// A plain line per entry: "15:04:05 [WARN] message key=value", which the TypeScript side files by level.
func newLogger(level string) zerolog.Logger {
	lvl, err := zerolog.ParseLevel(strings.ToLower(level))
	if err != nil || level == "" {
		lvl = zerolog.InfoLevel
	}
	cw := zerolog.ConsoleWriter{Out: os.Stderr, NoColor: true, TimeFormat: "15:04:05"}
	cw.FormatLevel = func(i any) string { return "[" + strings.ToUpper(fmt.Sprint(i)) + "]" }
	return zerolog.New(cw).Level(lvl).With().Timestamp().Logger()
}

func main() {
	level := flag.String("log", "INFO", "log level: DEBUG, INFO, WARN, ERROR")
	proxy := flag.String("proxy", "", "reach Google through this proxy (http://, https://, socks5://)")
	ping := flag.Duration("ping-interval", 20*time.Minute, "how often to ping the phone (1m to 4h)")
	device := flag.String("device-name", "dither-accounts", "what the phone lists this pairing as, under Device pairing")
	flag.Parse()
	log := newLogger(*level)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b := NewBridge(ctx, os.Stdout, log)
	b.pingInterval = *ping
	if *device != "" {
		// What libgm tells Google when pairing: the phone shows it under Device pairing.
		util.BrowserDetailsMessage.OS = *device
	}
	if *proxy != "" {
		cs, err := b.http.WithProxy(*proxy)
		if err != nil {
			b.emit(ev{"t": "fatal", "error": fmt.Sprintf("bad proxy %q: %v", *proxy, err)})
			os.Exit(2)
		}
		b.http = cs
	}
	b.emit(ev{"t": "ready", "version": version})

	// The session's cookies change on Google's say (Set-Cookie on any answer): pass them on when they do.
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				b.emitSession(false)
			}
		}
	}()

	dec := json.NewDecoder(os.Stdin)
	for {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			if !errors.Is(err, io.EOF) {
				log.Error().Err(err).Msg("reading commands")
			}
			break
		}
		b.handleLine(raw)
	}
	// stdin closed: the extractor is gone or stopping us.
	b.cancelPairing()
	b.mu.Lock()
	cli := b.cli
	b.mu.Unlock()
	if cli != nil {
		cli.Disconnect()
	}
}
