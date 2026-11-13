// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

func firstWord(s string) string {
	if f := strings.Fields(s); len(f) > 0 {
		return f[0]
	}
	return ""
}

func participant(id, number, name string, me, visible bool) *gmproto.Participant {
	return &gmproto.Participant{
		ID:              &gmproto.SmallInfo{Type: gmproto.IdentifierType_PHONE, Number: number, ParticipantID: id},
		FirstName:       firstWord(name),
		FullName:        name,
		IsMe:            me,
		IsVisible:       visible,
		FormattedNumber: number,
	}
}

func TestConversation(t *testing.T) {
	c := mapConversation(&gmproto.Conversation{
		ConversationID:       "42",
		Name:                 "Family",
		IsGroupChat:          true,
		Type:                 gmproto.ConversationType_RCS,
		Status:               gmproto.ConversationStatus_KEEP_ARCHIVED,
		Unread:               true,
		LastMessageTimestamp: 1_770_000_000_123_456,
		LatestMessageID:      "900",
		DefaultOutgoingID:    "7",
		SendMode:             gmproto.ConversationSendMode_SEND_MODE_XMS_LATCH,
		GroupAvatarURL:       "https://lh3.googleusercontent.com/g",
		SimCard:              &gmproto.SIMCard{SIMData: &gmproto.SIMData{SIMPayload: &gmproto.SIMPayload{SIMNumber: 2}}},
		Participants: []*gmproto.Participant{
			participant("7", "+15550000001", "", true, true),
			participant("8", "+15550000002", "Alice Example", false, true),
		},
		OtherParticipants: []string{"8"},
	})
	if c.ID != "42" || !c.Group || c.Type != "rcs" || c.Status != "archived" || !c.Unread || c.SendMode != "xms" {
		t.Fatalf("conversation: %+v", c)
	}
	if c.LastTs != 1_770_000_000_123 {
		t.Errorf("microseconds become milliseconds: %d", c.LastTs)
	}
	if c.SIM != 2 || c.OutgoingID != "7" || c.AvatarURL == "" {
		t.Errorf("sim, outgoing, avatar: %+v", c)
	}
	if len(c.Participants) != 2 || !c.Participants[0].IsMe || c.Participants[1].FullName != "Alice Example" || c.Participants[1].IDType != "PHONE" {
		t.Errorf("participants: %+v", c.Participants)
	}
	if mapConversation(&gmproto.Conversation{ConversationID: "1", Type: gmproto.ConversationType_SMS, Status: gmproto.ConversationStatus_SPAM_FOLDER}).Status != "spam" {
		t.Error("spam folder")
	}
	if got := mapConversation(&gmproto.Conversation{ConversationID: "1"}); got.Type != "" || got.Status != "active" || got.Participants == nil {
		t.Errorf("unknown type stays empty, unknown status is active, participants is a list: %+v", got)
	}
}

func text(s string) *gmproto.MessageInfo {
	return &gmproto.MessageInfo{Data: &gmproto.MessageInfo_MessageContent{MessageContent: &gmproto.MessageContent{Content: s}}}
}

func status(s gmproto.MessageStatusType) *gmproto.MessageStatus {
	return &gmproto.MessageStatus{Status: s}
}

func TestMessageText(t *testing.T) {
	subject := "Re: dinner"
	m := mapMessage(&gmproto.Message{
		MessageID:      "100",
		ConversationID: "42",
		ParticipantID:  "8",
		Timestamp:      1_770_000_001_000_999,
		MessageStatus:  status(gmproto.MessageStatusType_INCOMING_COMPLETE),
		Type:           1,
		Subject:        &subject,
		MessageInfo:    []*gmproto.MessageInfo{text("first line"), text("second line")},
		ReplyMessage:   &gmproto.ReplyMessage{MessageID: "99"},
		SenderParticipant: &gmproto.Participant{
			ID:       &gmproto.SmallInfo{Number: "+15550000002", ParticipantID: "8"},
			FullName: "Alice Example",
		},
	}, nil)
	if m.ID != "100" || m.Conversation != "42" || m.Participant != "8" || m.FromMe {
		t.Fatalf("ids: %+v", m)
	}
	if m.Ts != 1_770_000_001_000 || m.State != "received" || m.Kind != "sms" || m.Status != "INCOMING_COMPLETE" {
		t.Errorf("ts, state, kind: %+v", m)
	}
	if m.Text != "first line\nsecond line" || m.Subject != "Re: dinner" || m.ReplyTo != "99" {
		t.Errorf("text, subject, reply: %+v", m)
	}
	if m.SenderNumber != "+15550000002" || m.SenderName != "Alice Example" {
		t.Errorf("sender: %+v", m)
	}
}

func TestFromMe(t *testing.T) {
	cases := []struct {
		name string
		m    *gmproto.Message
		self map[string]bool
		want bool
	}{
		{"outgoing status", &gmproto.Message{ParticipantID: "8", MessageStatus: status(gmproto.MessageStatusType_OUTGOING_SENDING)}, nil, true},
		{"incoming status from participant 1", &gmproto.Message{ParticipantID: "1", MessageStatus: status(gmproto.MessageStatusType_INCOMING_COMPLETE)}, nil, false},
		{"tombstone by participant 1", &gmproto.Message{ParticipantID: "1", MessageStatus: status(gmproto.MessageStatusType_TOMBSTONE_PARTICIPANT_JOINED)}, nil, true},
		{"tombstone by a SIM participant", &gmproto.Message{ParticipantID: "7", MessageStatus: status(gmproto.MessageStatusType_TOMBSTONE_PARTICIPANT_LEFT)}, map[string]bool{"7": true}, true},
		{"tombstone by someone else", &gmproto.Message{ParticipantID: "8", MessageStatus: status(gmproto.MessageStatusType_TOMBSTONE_PARTICIPANT_LEFT)}, map[string]bool{"7": true}, false},
		{"deleted, sender isMe", &gmproto.Message{ParticipantID: "9", MessageStatus: status(gmproto.MessageStatusType_MESSAGE_DELETED), SenderParticipant: &gmproto.Participant{IsMe: true}}, nil, true},
	}
	for _, c := range cases {
		if got := IsFromMe(c.m, c.self); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
}

func TestStates(t *testing.T) {
	cases := map[gmproto.MessageStatusType]string{
		gmproto.MessageStatusType_OUTGOING_YET_TO_SEND:            "sending",
		gmproto.MessageStatusType_OUTGOING_SENDING:                "sending",
		gmproto.MessageStatusType_OUTGOING_COMPLETE:               "sent",
		gmproto.MessageStatusType_OUTGOING_DELIVERED:              "delivered",
		gmproto.MessageStatusType_OUTGOING_DISPLAYED:              "read",
		gmproto.MessageStatusType_OUTGOING_FAILED_GENERIC:         "failed",
		gmproto.MessageStatusType_OUTGOING_FAILED_TOO_LARGE:       "failed",
		gmproto.MessageStatusType_INCOMING_COMPLETE:               "received",
		gmproto.MessageStatusType_INCOMING_DISPLAYED:              "received",
		gmproto.MessageStatusType_INCOMING_AUTO_DOWNLOADING:       "downloading",
		gmproto.MessageStatusType_TOMBSTONE_PARTICIPANT_LEFT:      "system",
		gmproto.MessageStatusType_MESSAGE_DELETED:                 "deleted",
		gmproto.MessageStatusType_OUTGOING_DELETED:                "deleted",
		gmproto.MessageStatusType_INCOMING_DOWNLOAD_FAILED:        "received",
		gmproto.MessageStatusType_OUTGOING_NOT_DELIVERED_YET:      "sending",
		gmproto.MessageStatusType_INCOMING_YET_TO_MANUAL_DOWNLOAD: "downloading",
	}
	for s, want := range cases {
		if got := messageState(s); got != want {
			t.Errorf("%s: %s, want %s", s, got, want)
		}
	}
	m := mapMessage(&gmproto.Message{MessageID: "1", MessageStatus: status(gmproto.MessageStatusType_OUTGOING_FAILED_TOO_LARGE)}, nil)
	if m.Error != "too large" || !m.FromMe {
		t.Errorf("failure reason: %+v", m)
	}
	pending := mapMessage(&gmproto.Message{MessageID: "2", MessageStatus: status(gmproto.MessageStatusType_INCOMING_YET_TO_MANUAL_DOWNLOAD)}, nil)
	if !strings.Contains(pending.Text, "auto-download is off") {
		t.Errorf("an MMS not downloaded says so: %q", pending.Text)
	}
}

func TestTombstones(t *testing.T) {
	created := mapMessage(&gmproto.Message{MessageID: "1", MessageStatus: status(gmproto.MessageStatusType_TOMBSTONE_RCS_GROUP_CREATED)}, nil)
	if !created.Ignore || created.State != "system" {
		t.Errorf("group created is ignored: %+v", created)
	}
	left := mapMessage(&gmproto.Message{MessageID: "2", MessageStatus: status(gmproto.MessageStatusType_TOMBSTONE_PARTICIPANT_LEFT), MessageInfo: []*gmproto.MessageInfo{text("Bob left")}}, nil)
	if left.Ignore || left.Text != "Bob left" {
		t.Errorf("someone leaving is kept: %+v", left)
	}
	e2ee := mapMessage(&gmproto.Message{MessageID: "3", MessageStatus: status(gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_PROTOCOL_SWITCH_RCS_TO_E2EE)}, nil)
	if e2ee.E2EE == nil || !*e2ee.E2EE || !e2ee.Ignore {
		t.Errorf("switch to encryption is noted: %+v", e2ee)
	}
	plain := mapMessage(&gmproto.Message{MessageID: "4", MessageStatus: status(gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_PROTOCOL_SWITCH_E2EE_TO_TEXT)}, nil)
	if plain.E2EE == nil || *plain.E2EE {
		t.Errorf("switch away from encryption is noted: %+v", plain)
	}
}

func TestMedia(t *testing.T) {
	part := "p1"
	m := mapMessage(&gmproto.Message{
		MessageID:     "200",
		MessageStatus: status(gmproto.MessageStatusType_INCOMING_COMPLETE),
		Type:          2,
		MessageInfo: []*gmproto.MessageInfo{
			{ActionMessageID: &part, Data: &gmproto.MessageInfo_MediaContent{MediaContent: &gmproto.MediaContent{
				Format: gmproto.MediaFormats_IMAGE_JPEG, MediaID: "media-1", MediaName: "photo.jpg", Size: 1234,
				Dimensions: &gmproto.Dimensions{Width: 640, Height: 480}, DecryptionKey: []byte{1, 2, 3},
				ThumbnailMediaID: "thumb-1", ThumbnailDecryptionKey: []byte{4, 5},
			}}},
			{Data: &gmproto.MessageInfo_MediaContent{MediaContent: &gmproto.MediaContent{Format: gmproto.MediaFormats_VIDEO_UNSPECIFIED, MediaName: "clip"}}},
			{Data: &gmproto.MessageInfo_MediaContent{MediaContent: &gmproto.MediaContent{MimeType: "image/png", MediaData: []byte("png!")}}},
			text("caption"),
		},
	}, nil)
	if m.Kind != "mms" || m.Text != "caption" || len(m.Media) != 3 {
		t.Fatalf("media message: %+v", m)
	}
	img := m.Media[0]
	if img.Part != "p1" || img.MediaID != "media-1" || img.Key != "AQID" || img.ThumbID != "thumb-1" || img.ThumbKey != "BAU=" || img.Mime != "image/jpeg" || img.Width != 640 || img.Pending {
		t.Errorf("image: %+v", img)
	}
	if !m.Media[1].Pending || m.Media[1].Mime != "video/*" {
		t.Errorf("media still downloading on the phone is pending: %+v", m.Media[1])
	}
	if m.Media[2].Inline != "cG5nIQ==" || m.Media[2].Pending || m.Media[2].Mime != "image/png" {
		t.Errorf("inline media: %+v", m.Media[2])
	}
}

func TestReactions(t *testing.T) {
	m := mapMessage(&gmproto.Message{
		MessageID:     "300",
		MessageStatus: status(gmproto.MessageStatusType_OUTGOING_DELIVERED),
		Reactions: []*gmproto.ReactionEntry{
			{Data: &gmproto.ReactionData{Type: gmproto.EmojiType_LIKE}, ParticipantIDs: []string{"8", "9"}},
			{Data: &gmproto.ReactionData{Type: gmproto.EmojiType_CUSTOM, Unicode: "🦊"}, ParticipantIDs: []string{"1"}},
			{Data: &gmproto.ReactionData{Type: gmproto.EmojiType_EMOTIFY}, ParticipantIDs: []string{"8"}},
			{Data: &gmproto.ReactionData{Type: gmproto.EmojiType_RED_HEART}},
		},
	}, nil)
	if len(m.Reactions) != 2 {
		t.Fatalf("reactions with an emoji and someone behind them: %+v", m.Reactions)
	}
	if m.Reactions[0].Emoji != "👍" || len(m.Reactions[0].Participants) != 2 || m.Reactions[1].Emoji != "🦊" {
		t.Errorf("reactions: %+v", m.Reactions)
	}
	if rd := gmproto.MakeReactionData("❤️"); rd.GetType() != gmproto.EmojiType_RED_HEART {
		t.Errorf("sending a heart names its type: %v", rd)
	}
}

func TestSettings(t *testing.T) {
	yes := true
	s := mapSettings(&gmproto.Settings{
		SIMCards: []*gmproto.SIMCard{{
			RCSChats:       &gmproto.RCSChats{Enabled: true},
			SIMData:        &gmproto.SIMData{SIMPayload: &gmproto.SIMPayload{SIMNumber: 1}, CarrierName: "Example Mobile", FormattedPhoneNumber: "(555) 000-0001", InternationalPhoneNumber: "+15550000001"},
			SIMParticipant: &gmproto.SIMParticipant{ID: "7"},
		}},
		RCSSettings:  &gmproto.RCSSettings{IsEnabled: true, SendReadReceipts: true, IsDefaultSMSApp: &yes},
		BugleVersion: "messages.android_20261101",
	})
	if len(s.SIMs) != 1 || s.SIMs[0].Phone != "+15550000001" || s.SIMs[0].Carrier != "Example Mobile" || s.SIMs[0].Participant != "7" || !s.SIMs[0].RCS {
		t.Errorf("sims: %+v", s.SIMs)
	}
	if !s.RCSEnabled || !s.ReadReceipts || s.TypingIndicate || s.DefaultSMSApp == nil || !*s.DefaultSMSApp || s.Version == "" {
		t.Errorf("settings: %+v", s)
	}
	if mapSettings(&gmproto.Settings{RCSSettings: &gmproto.RCSSettings{}}).DefaultSMSApp != nil {
		t.Error("an absent default-app flag stays absent")
	}
	settings := &gmproto.Settings{SIMCards: []*gmproto.SIMCard{
		{SIMData: &gmproto.SIMData{SIMPayload: &gmproto.SIMPayload{SIMNumber: 1}}, SIMParticipant: &gmproto.SIMParticipant{ID: "7"}},
		{SIMData: &gmproto.SIMData{SIMPayload: &gmproto.SIMPayload{SIMNumber: 2}}, SIMParticipant: &gmproto.SIMParticipant{ID: "12"}},
	}}
	if p := SIMPayloadFor(settings, "12"); p.GetSIMNumber() != 2 {
		t.Errorf("SIM for participant 12: %v", p)
	}
	if SIMPayloadFor(settings, "") != nil || SIMPayloadFor(nil, "7") != nil {
		t.Error("no participant or no settings: no SIM")
	}
}

func TestAlerts(t *testing.T) {
	if alertName(gmproto.AlertType_BROWSER_ACTIVE) != "browser_active" || alertName(gmproto.AlertType_BROWSER_INACTIVE_FROM_TIMEOUT) != "browser_inactive_timeout" {
		t.Error("browser alerts")
	}
	if alertName(gmproto.AlertType_OBSERVER_REGISTERED) != "" {
		t.Error("alerts nothing acts on are dropped")
	}
}

// ---------------------------------------------------------------- the line protocol, without Google

type lines struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lines) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lines) all() []map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []map[string]any
	sc := bufio.NewScanner(bytes.NewReader(l.buf.Bytes()))
	for sc.Scan() {
		var m map[string]any
		_ = json.Unmarshal(sc.Bytes(), &m)
		out = append(out, m)
	}
	return out
}

func (l *lines) reply(t *testing.T, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, m := range l.all() {
			if m["t"] == "reply" && m["id"] == id {
				return m
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no reply to %s", id)
	return nil
}

func TestProtocolWithoutASession(t *testing.T) {
	out := &lines{}
	b := NewBridge(context.Background(), out, zerolog.Nop())
	b.handleLine([]byte(`{"id":"1","op":"connect"}`))
	if r := out.reply(t, "1"); r["ok"] != true || r["result"].(map[string]any)["paired"] != false {
		t.Errorf("connect without a session: %v", r)
	}
	b.handleLine([]byte(`{"id":"2","op":"connect","session":{"request_crypto":{"aes_key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","hmac_key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}}`))
	if r := out.reply(t, "2"); r["ok"] != true || r["result"].(map[string]any)["paired"] != false {
		t.Errorf("a session that never paired is not paired: %v", r)
	}
	b.handleLine([]byte(`{"id":"2b","op":"connect","session":{"browser":{"sourceID":"b"},"tachyon_token":"dG9r","request_crypto":{"aes_key":"AAAA","hmac_key":"AAAA"}}}`))
	if r := out.reply(t, "2b"); r["ok"] != true || r["result"].(map[string]any)["incomplete"] != true {
		t.Errorf("a paired session without its refresh key is not used: %v", r)
	}
	b.handleLine([]byte(`{"id":"3","op":"send","conversation":"1","text":"hi"}`))
	if r := out.reply(t, "3"); r["ok"] != false || !strings.Contains(r["error"].(string), "not connected") {
		t.Errorf("send before connecting: %v", r)
	}
	b.handleLine([]byte(`{"id":"4","op":"nope"}`))
	if r := out.reply(t, "4"); r["ok"] != false {
		t.Errorf("an unknown op is refused: %v", r)
	}
	b.handleLine([]byte(`{"id":"5","op":"pairGoogle","cookies":"SID=1"}`))
	if r := out.reply(t, "5"); r["ok"] != false || !strings.Contains(r["error"].(string), "missing Google cookies") {
		t.Errorf("pairing with too few cookies says which are missing: %v", r)
	}
	b.handleLine([]byte(`{"id":"6","op":"status"}`))
	if r := out.reply(t, "6"); r["ok"] != true || r["result"].(map[string]any)["client"] != false {
		t.Errorf("status: %v", r)
	}
	b.handleLine([]byte(`not json`))
	b.handleLine([]byte(`{"op":"status"}`))
	time.Sleep(20 * time.Millisecond)
	if n := len(out.all()); n != 7 {
		t.Errorf("lines that are not commands get no reply: %d lines", n)
	}
}

func TestSessionRoundTrip(t *testing.T) {
	// What secret.json holds is libgm's AuthData as JSON: it must come back whole, cookies included.
	ad := libgm.NewAuthData()
	ad.Browser = &gmproto.Device{SourceID: "browser"}
	ad.Mobile = &gmproto.Device{SourceID: "phone"}
	ad.TachyonAuthToken = []byte("token")
	ad.SetCookies(map[string]string{"SID": "s"})
	data, err := sessionJSON(ad)
	if err != nil {
		t.Fatal(err)
	}
	back := &libgm.AuthData{}
	if err := json.Unmarshal(data, back); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(back.Mobile, ad.Mobile) || string(back.TachyonAuthToken) != "token" || back.Cookies["SID"] != "s" || back.RequestCrypto == nil || back.RefreshKey == nil {
		t.Errorf("session round trip: %+v", back)
	}

	out := &lines{}
	b := NewBridge(context.Background(), out, zerolog.Nop())
	b.auth = ad
	b.emitSession(false)
	b.emitSession(false)
	ad.SetCookies(map[string]string{"SID": "rotated"})
	b.emitSession(false)
	var sessions int
	for _, m := range out.all() {
		if m["t"] == "session" {
			sessions++
		}
	}
	if sessions != 2 {
		t.Errorf("a session is printed when it changes: %d times", sessions)
	}
}

func TestEvents(t *testing.T) {
	out := &lines{}
	b := NewBridge(context.Background(), out, zerolog.Nop())
	b.onEvent(&gmproto.Settings{SIMCards: []*gmproto.SIMCard{{SIMParticipant: &gmproto.SIMParticipant{ID: "7"}, SIMData: &gmproto.SIMData{}}}})
	b.onEvent(&libgm.WrappedMessage{Message: &gmproto.Message{MessageID: "1", ParticipantID: "7", MessageStatus: status(gmproto.MessageStatusType_TOMBSTONE_PARTICIPANT_JOINED)}, IsOld: true})
	b.onEvent(&gmproto.TypingData{ConversationID: "42", User: &gmproto.User{Number: "+15550000002"}, Type: gmproto.TypingTypes_STOPPED_TYPING})
	b.onEvent(&events.PhoneNotResponding{})
	b.onEvent(&gmproto.UserAlertEvent{AlertType: gmproto.AlertType_BROWSER_INACTIVE})
	b.onEvent(&gmproto.Conversation{ConversationID: "42"})
	got := out.all()
	if len(got) != 6 {
		t.Fatalf("events: %v", got)
	}
	msg := got[1]["message"].(map[string]any)
	if got[1]["t"] != "message" || msg["fromMe"] != true || msg["old"] != true {
		t.Errorf("a tombstone by our own SIM participant is ours, and old: %v", got[1])
	}
	if got[2]["t"] != "typing" || got[2]["stop"] != true || got[2]["number"] != "+15550000002" {
		t.Errorf("typing: %v", got[2])
	}
	if got[3]["t"] != "phone" || got[3]["responding"] != false {
		t.Errorf("phone: %v", got[3])
	}
	if got[4]["alert"] != "browser_inactive" || got[5]["t"] != "conversation" {
		t.Errorf("alert and conversation: %v %v", got[4], got[5])
	}
	if b.convs["42"] == nil {
		t.Error("conversations are kept for sends")
	}
}
