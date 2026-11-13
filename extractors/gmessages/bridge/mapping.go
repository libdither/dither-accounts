// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the bridge prints about Google Messages, mapped from libgm's protobufs (gmproto) into plain JSON the
// TypeScript side reads (src/types.ts). Everything here is a pure function, so mapping_test.go covers it without a
// phone. Times are milliseconds since the epoch (Google Messages counts in microseconds).

package main

import (
	"encoding/base64"
	"strings"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

// Participant is one person in a conversation, as the phone knows them.
type Participant struct {
	ID        string `json:"id"`
	Number    string `json:"number,omitempty"`
	Formatted string `json:"formatted,omitempty"`
	// PHONE, EMAIL, ALPHA_SHORT_NO_COUNTRY ... (gmproto.IdentifierType without the noise).
	IDType    string `json:"idType,omitempty"`
	FirstName string `json:"firstName,omitempty"`
	FullName  string `json:"fullName,omitempty"`
	IsMe      bool   `json:"isMe,omitempty"`
	Visible   bool   `json:"visible,omitempty"`
	ContactID string `json:"contactId,omitempty"`
	Color     string `json:"color,omitempty"`
}

// Conversation is a 1:1 or group SMS/MMS/RCS chat.
type Conversation struct {
	ID    string `json:"id"`
	Name  string `json:"name,omitempty"`
	Group bool   `json:"group,omitempty"`
	// "sms" (SMS/MMS) or "rcs"; "" when the phone does not say.
	Type string `json:"type"`
	// active, archived, deleted, spam, blocked, other.
	Status       string        `json:"status"`
	ReadOnly     bool          `json:"readOnly,omitempty"`
	Unread       bool          `json:"unread,omitempty"`
	Pinned       bool          `json:"pinned,omitempty"`
	LastTs       int64         `json:"lastTs"`
	LatestID     string        `json:"latestId,omitempty"`
	LatestText   string        `json:"latestText,omitempty"`
	OutgoingID   string        `json:"outgoingId,omitempty"`
	SIM          int32         `json:"sim,omitempty"`
	SendMode     string        `json:"sendMode,omitempty"`
	AvatarURL    string        `json:"avatarUrl,omitempty"`
	Color        string        `json:"color,omitempty"`
	Participants []Participant `json:"participants"`
	Others       []string      `json:"others,omitempty"`
}

// Media is one attachment of a message.
type Media struct {
	// The message part it is (actionMessageID): what a full-size request names.
	Part     string `json:"part,omitempty"`
	MediaID  string `json:"mediaId,omitempty"`
	Key      string `json:"key,omitempty"`
	ThumbID  string `json:"thumbId,omitempty"`
	ThumbKey string `json:"thumbKey,omitempty"`
	Name     string `json:"name,omitempty"`
	Mime     string `json:"mime,omitempty"`
	Size     int64  `json:"size,omitempty"`
	Width    int64  `json:"width,omitempty"`
	Height   int64  `json:"height,omitempty"`
	// Small media the phone sends inside the message rather than as a download (base64).
	Inline string `json:"inline,omitempty"`
	// Neither a download nor a thumbnail yet: the phone is still fetching it (MMS).
	Pending bool `json:"pending,omitempty"`
}

// Reaction is one emoji and who put it there.
type Reaction struct {
	Emoji        string   `json:"emoji"`
	Participants []string `json:"participants"`
}

// Message is one message, or an update of one (status, reactions, media that finished downloading).
type Message struct {
	ID           string `json:"id"`
	Conversation string `json:"conversation"`
	Participant  string `json:"participant,omitempty"`
	// The sender's number, when the message names its sender (senderParticipant).
	SenderNumber string `json:"senderNumber,omitempty"`
	SenderName   string `json:"senderName,omitempty"`
	FromMe       bool   `json:"fromMe,omitempty"`
	Ts           int64  `json:"ts"`
	// The phone's status name (OUTGOING_DELIVERED, INCOMING_COMPLETE, TOMBSTONE_PARTICIPANT_JOINED, MESSAGE_DELETED ...).
	Status string `json:"status"`
	// What the status means: sending, sent, delivered, read, failed (outgoing); received, downloading (incoming);
	// system (a tombstone); deleted.
	State string `json:"state"`
	// sms, mms or rcs, as far as the phone says.
	Kind      string     `json:"kind,omitempty"`
	Text      string     `json:"text,omitempty"`
	Subject   string     `json:"subject,omitempty"`
	Media     []Media    `json:"media,omitempty"`
	ReplyTo   string     `json:"replyTo,omitempty"`
	Reactions []Reaction `json:"reactions,omitempty"`
	TmpID     string     `json:"tmpId,omitempty"`
	// "Read by Alice, Bob" in groups.
	StatusText string `json:"statusText,omitempty"`
	// Why an outgoing message failed, in words.
	Error string `json:"error,omitempty"`
	// A tombstone Google Messages shows but that says nothing a chat needs (protocol switches, "group created").
	Ignore bool `json:"ignore,omitempty"`
	// The chat switched to (true) or from (false) end-to-end encrypted RCS with this message.
	E2EE *bool `json:"e2ee,omitempty"`
	// From an initial sync or a replay rather than live (libgm's IsOld).
	Old bool `json:"old,omitempty"`
}

// SIM is one SIM card of the phone.
type SIM struct {
	Number      int32  `json:"number"`
	Phone       string `json:"phone,omitempty"`
	Formatted   string `json:"formatted,omitempty"`
	Carrier     string `json:"carrier,omitempty"`
	Participant string `json:"participant,omitempty"`
	RCS         bool   `json:"rcs,omitempty"`
}

// Settings are the phone's Google Messages settings that matter here.
type Settings struct {
	SIMs           []SIM  `json:"sims"`
	RCSEnabled     bool   `json:"rcsEnabled"`
	ReadReceipts   bool   `json:"readReceipts"`
	TypingIndicate bool   `json:"typingIndicators"`
	DefaultSMSApp  *bool  `json:"defaultSmsApp,omitempty"`
	Version        string `json:"version,omitempty"`
}

func conversationStatus(s gmproto.ConversationStatus) string {
	switch s {
	case gmproto.ConversationStatus_ACTIVE, gmproto.ConversationStatus_UNKNOWN_CONVERSATION_STATUS:
		return "active"
	case gmproto.ConversationStatus_ARCHIVED, gmproto.ConversationStatus_KEEP_ARCHIVED:
		return "archived"
	case gmproto.ConversationStatus_DELETED, gmproto.ConversationStatus_TRASH_FOLDER:
		return "deleted"
	case gmproto.ConversationStatus_SPAM_FOLDER:
		return "spam"
	case gmproto.ConversationStatus_BLOCKED_FOLDER:
		return "blocked"
	default:
		return "other"
	}
}

func idType(t gmproto.IdentifierType) string {
	if t == gmproto.IdentifierType_UNKNOWN {
		return ""
	}
	return t.String()
}

func mapParticipant(p *gmproto.Participant) Participant {
	return Participant{
		ID:        p.GetID().GetParticipantID(),
		Number:    p.GetID().GetNumber(),
		Formatted: p.GetFormattedNumber(),
		IDType:    idType(p.GetID().GetType()),
		FirstName: p.GetFirstName(),
		FullName:  p.GetFullName(),
		IsMe:      p.GetIsMe(),
		Visible:   p.GetIsVisible(),
		ContactID: p.GetContactID(),
		Color:     p.GetAvatarHexColor(),
	}
}

func mapConversation(c *gmproto.Conversation) Conversation {
	out := Conversation{
		ID:           c.GetConversationID(),
		Name:         c.GetName(),
		Group:        c.GetIsGroupChat(),
		Status:       conversationStatus(c.GetStatus()),
		ReadOnly:     c.GetReadOnly(),
		Unread:       c.GetUnread(),
		Pinned:       c.GetPinned(),
		LastTs:       c.GetLastMessageTimestamp() / 1000,
		LatestID:     c.GetLatestMessageID(),
		LatestText:   c.GetLatestMessage().GetDisplayContent(),
		OutgoingID:   c.GetDefaultOutgoingID(),
		SIM:          c.GetSimCard().GetSIMData().GetSIMPayload().GetSIMNumber(),
		AvatarURL:    c.GetGroupAvatarURL(),
		Color:        c.GetAvatarHexColor(),
		Participants: []Participant{},
		Others:       c.GetOtherParticipants(),
	}
	switch c.GetType() {
	case gmproto.ConversationType_SMS:
		out.Type = "sms"
	case gmproto.ConversationType_RCS:
		out.Type = "rcs"
	}
	switch c.GetSendMode() {
	case gmproto.ConversationSendMode_SEND_MODE_XMS, gmproto.ConversationSendMode_SEND_MODE_XMS_LATCH:
		out.SendMode = "xms"
	default:
		out.SendMode = "auto"
	}
	for _, p := range c.GetParticipants() {
		out.Participants = append(out.Participants, mapParticipant(p))
	}
	return out
}

// ignoredTombstone: the system messages mautrix-gmessages does not bridge either. Protocol switches only matter in
// 1:1 chats' own UI; "group created" and friends say nothing a chat needs.
func ignoredTombstone(s gmproto.MessageStatusType) bool {
	switch s {
	case gmproto.MessageStatusType_TOMBSTONE_PROTOCOL_SWITCH_TO_TEXT,
		gmproto.MessageStatusType_TOMBSTONE_PROTOCOL_SWITCH_TO_RCS,
		gmproto.MessageStatusType_TOMBSTONE_PROTOCOL_SWITCH_TO_ENCRYPTED_RCS,
		gmproto.MessageStatusType_TOMBSTONE_PROTOCOL_SWITCH_TO_ENCRYPTED_RCS_INFO,
		gmproto.MessageStatusType_TOMBSTONE_ONE_ON_ONE_SMS_CREATED,
		gmproto.MessageStatusType_TOMBSTONE_ONE_ON_ONE_RCS_CREATED,
		gmproto.MessageStatusType_TOMBSTONE_ENCRYPTED_ONE_ON_ONE_RCS_CREATED,
		gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_PROTOCOL_SWITCH_TEXT_TO_E2EE,
		gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_PROTOCOL_SWITCH_E2EE_TO_TEXT,
		gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_PROTOCOL_SWITCH_RCS_TO_E2EE,
		gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_PROTOCOL_SWITCH_E2EE_TO_RCS,
		gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_ENCRYPTED_GROUP_CREATED,
		gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_GROUP_PROTOCOL_SWITCH_E2EE_TO_RCS,
		gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_GROUP_PROTOCOL_SWITCH_RCS_TO_E2EE,
		gmproto.MessageStatusType_TOMBSTONE_RCS_GROUP_CREATED,
		gmproto.MessageStatusType_TOMBSTONE_MMS_GROUP_CREATED,
		gmproto.MessageStatusType_TOMBSTONE_SMS_BROADCAST_CREATED,
		gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_PARTICIPANT_THEME_CHANGE,
		gmproto.MessageStatusType_TOMBSTONE_SHOW_LINK_PREVIEWS,
		gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_ACTIVE_SELF_IDENTITY_CHANGED:
		return true
	}
	return false
}

// e2eeSwitch: the chat became (or stopped being) end-to-end encrypted RCS. Sends then force RCS, as Google Messages
// for web does, so a message in an encrypted chat never falls back to SMS.
func e2eeSwitch(s gmproto.MessageStatusType) *bool {
	on, off := true, false
	switch s {
	case gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_PROTOCOL_SWITCH_RCS_TO_E2EE,
		gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_PROTOCOL_SWITCH_TEXT_TO_E2EE,
		gmproto.MessageStatusType_TOMBSTONE_ENCRYPTED_ONE_ON_ONE_RCS_CREATED,
		gmproto.MessageStatusType_TOMBSTONE_PROTOCOL_SWITCH_TO_ENCRYPTED_RCS:
		return &on
	case gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_PROTOCOL_SWITCH_E2EE_TO_RCS,
		gmproto.MessageStatusType_MESSAGE_STATUS_TOMBSTONE_PROTOCOL_SWITCH_E2EE_TO_TEXT:
		return &off
	}
	return nil
}

// FailReason is why an outgoing message failed, in words (mautrix-gmessages' wording), or "" if it did not.
func FailReason(s gmproto.MessageStatusType) string {
	switch s {
	case gmproto.MessageStatusType_OUTGOING_FAILED_TOO_LARGE:
		return "too large"
	case gmproto.MessageStatusType_OUTGOING_FAILED_RECIPIENT_LOST_RCS:
		return "the recipient lost RCS"
	case gmproto.MessageStatusType_OUTGOING_FAILED_RECIPIENT_LOST_ENCRYPTION:
		return "the recipient lost encryption"
	case gmproto.MessageStatusType_OUTGOING_FAILED_RECIPIENT_DID_NOT_DECRYPT,
		gmproto.MessageStatusType_OUTGOING_FAILED_RECIPIENT_DID_NOT_DECRYPT_NO_MORE_RETRY:
		return "the recipient could not decrypt it"
	case gmproto.MessageStatusType_OUTGOING_FAILED_TO_ENCRYPT:
		return "it could not be encrypted"
	case gmproto.MessageStatusType_OUTGOING_FAILED_RECIPIENT_NEGATIVE_DELIVERY:
		return "delivery failed"
	case gmproto.MessageStatusType_OUTGOING_FAILED_GENERIC:
		return "the carrier refused it; check Google Messages on the phone and try again"
	case gmproto.MessageStatusType_OUTGOING_FAILED_NO_RETRY_NO_FALLBACK:
		return "it could not be sent and there is no fallback"
	case gmproto.MessageStatusType_OUTGOING_FAILED_EMERGENCY_NUMBER:
		return "emergency numbers cannot be texted from here"
	case gmproto.MessageStatusType_OUTGOING_CANCELED:
		return "canceled"
	case gmproto.MessageStatusType_OUTGOING_RESTRICTED:
		return "restricted"
	}
	return ""
}

func messageState(s gmproto.MessageStatusType) string {
	switch {
	case s == gmproto.MessageStatusType_MESSAGE_DELETED || s == gmproto.MessageStatusType_OUTGOING_DELETED || s == gmproto.MessageStatusType_INCOMING_DELETED:
		return "deleted"
	case s == gmproto.MessageStatusType_OUTGOING_DISPLAYED:
		return "read"
	case s == gmproto.MessageStatusType_OUTGOING_DELIVERED:
		return "delivered"
	case s == gmproto.MessageStatusType_OUTGOING_COMPLETE:
		return "sent"
	case FailReason(s) != "":
		return "failed"
	case s >= 1 && s < 100:
		return "sending"
	case s == gmproto.MessageStatusType_INCOMING_AUTO_DOWNLOADING, s == gmproto.MessageStatusType_INCOMING_MANUAL_DOWNLOADING,
		s == gmproto.MessageStatusType_INCOMING_RETRYING_AUTO_DOWNLOAD, s == gmproto.MessageStatusType_INCOMING_RETRYING_MANUAL_DOWNLOAD,
		s == gmproto.MessageStatusType_INCOMING_YET_TO_MANUAL_DOWNLOAD, s == gmproto.MessageStatusType_INCOMING_AWAITING_AUTO_DOWNLOAD:
		return "downloading"
	case s >= 100 && s < 200:
		return "received"
	case s >= 200 && s < 300:
		return "system"
	}
	return "received"
}

// pendingNote: what Google Messages for web shows instead of an MMS it has not downloaded (or could not).
func pendingNote(s gmproto.MessageStatusType) string {
	switch s {
	case gmproto.MessageStatusType_INCOMING_YET_TO_MANUAL_DOWNLOAD:
		return "Attachment not downloaded: auto-download is off on the phone; download it in Google Messages there"
	case gmproto.MessageStatusType_INCOMING_MANUAL_DOWNLOADING, gmproto.MessageStatusType_INCOMING_AUTO_DOWNLOADING,
		gmproto.MessageStatusType_INCOMING_RETRYING_MANUAL_DOWNLOAD, gmproto.MessageStatusType_INCOMING_RETRYING_AUTO_DOWNLOAD,
		gmproto.MessageStatusType_INCOMING_AWAITING_AUTO_DOWNLOAD:
		return "Downloading the message on the phone…"
	case gmproto.MessageStatusType_INCOMING_DOWNLOAD_FAILED:
		return "The phone could not download this message"
	case gmproto.MessageStatusType_INCOMING_DOWNLOAD_FAILED_TOO_LARGE:
		return "The phone could not download this message (too large)"
	case gmproto.MessageStatusType_INCOMING_DOWNLOAD_FAILED_SIM_HAS_NO_DATA:
		return "The phone could not download this message (no mobile data)"
	case gmproto.MessageStatusType_INCOMING_DOWNLOAD_CANCELED:
		return "The download was canceled on the phone"
	case gmproto.MessageStatusType_INCOMING_EXPIRED_OR_NOT_AVAILABLE:
		return "This message expired before the phone could download it"
	case gmproto.MessageStatusType_INCOMING_FAILED_TO_DECRYPT, gmproto.MessageStatusType_INCOMING_DECRYPTION_ABORTED:
		return "The phone could not decrypt this message"
	}
	return ""
}

func messageKind(t int64) string {
	switch t {
	case 1:
		return "sms"
	case 2, 3:
		return "mms"
	case 4:
		return "rcs"
	}
	return ""
}

func reactionEmoji(d *gmproto.ReactionData) string {
	switch d.GetType() {
	case gmproto.EmojiType_CUSTOM:
		return d.GetUnicode()
	case gmproto.EmojiType_EMOTIFY, gmproto.EmojiType_REACTION_TYPE_UNSPECIFIED:
		// Emotify (an animated sticker of an emoji) has no emoji of its own; the unicode, if any, is the closest.
		return d.GetUnicode()
	default:
		if u := d.GetType().Unicode(); u != "" {
			return u
		}
		return d.GetUnicode()
	}
}

func b64(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	return base64.StdEncoding.EncodeToString(b)
}

func mapMedia(part string, m *gmproto.MediaContent) Media {
	mime := m.GetMimeType()
	if mime == "" {
		mime = libgm.FormatToMediaType[m.GetFormat()].Format
	}
	if mime == "" {
		switch m.GetFormat() {
		case gmproto.MediaFormats_IMAGE_UNSPECIFIED:
			mime = "image/*"
		case gmproto.MediaFormats_VIDEO_UNSPECIFIED:
			mime = "video/*"
		case gmproto.MediaFormats_AUDIO_UNSPECIFIED:
			mime = "audio/*"
		}
	}
	out := Media{
		Part:     part,
		MediaID:  m.GetMediaID(),
		Key:      b64(m.GetDecryptionKey()),
		ThumbID:  m.GetThumbnailMediaID(),
		ThumbKey: b64(m.GetThumbnailDecryptionKey()),
		Name:     m.GetMediaName(),
		Mime:     mime,
		Size:     m.GetSize(),
		Width:    m.GetDimensions().GetWidth(),
		Height:   m.GetDimensions().GetHeight(),
	}
	if len(m.GetMediaData()) > 0 {
		out.Inline = b64(m.GetMediaData())
	}
	out.Pending = out.MediaID == "" && out.ThumbID == "" && out.Inline == ""
	return out
}

// IsFromMe: outgoing statuses are ours, incoming ones are not, and otherwise participant "1" or one of the phone's
// own SIM participants (selfIDs) is us, as in mautrix-gmessages.
func IsFromMe(m *gmproto.Message, selfIDs map[string]bool) bool {
	s := m.GetMessageStatus().GetStatus()
	if s >= 1 && s < 100 {
		return true
	}
	if s >= 100 && s < 200 {
		return false
	}
	if m.GetSenderParticipant().GetIsMe() {
		return true
	}
	p := m.GetParticipantID()
	return p == "1" || selfIDs[p]
}

func mapMessage(m *gmproto.Message, selfIDs map[string]bool) Message {
	s := m.GetMessageStatus().GetStatus()
	out := Message{
		ID:           m.GetMessageID(),
		Conversation: m.GetConversationID(),
		Participant:  m.GetParticipantID(),
		SenderNumber: m.GetSenderParticipant().GetID().GetNumber(),
		SenderName:   m.GetSenderParticipant().GetFullName(),
		FromMe:       IsFromMe(m, selfIDs),
		Ts:           m.GetTimestamp() / 1000,
		Status:       s.String(),
		State:        messageState(s),
		Kind:         messageKind(m.GetType()),
		Subject:      m.GetSubject(),
		ReplyTo:      m.GetReplyMessage().GetMessageID(),
		TmpID:        m.GetTmpID(),
		StatusText:   m.GetMessageStatus().GetStatusText(),
		Error:        FailReason(s),
		Ignore:       ignoredTombstone(s),
		E2EE:         e2eeSwitch(s),
	}
	if out.SenderName == "" {
		out.SenderName = m.GetSenderParticipant().GetFirstName()
	}
	var text []string
	for _, part := range m.GetMessageInfo() {
		switch d := part.GetData().(type) {
		case *gmproto.MessageInfo_MessageContent:
			if c := d.MessageContent.GetContent(); c != "" {
				text = append(text, c)
			}
		case *gmproto.MessageInfo_MediaContent:
			out.Media = append(out.Media, mapMedia(part.GetActionMessageID(), d.MediaContent))
		}
	}
	out.Text = strings.Join(text, "\n")
	if note := pendingNote(s); note != "" && out.Text == "" && len(out.Media) == 0 {
		out.Text = note
	}
	for _, r := range m.GetReactions() {
		emoji := reactionEmoji(r.GetData())
		if emoji == "" || len(r.GetParticipantIDs()) == 0 {
			continue
		}
		out.Reactions = append(out.Reactions, Reaction{Emoji: emoji, Participants: r.GetParticipantIDs()})
	}
	return out
}

func mapSettings(s *gmproto.Settings) Settings {
	out := Settings{
		SIMs:           []SIM{},
		RCSEnabled:     s.GetRCSSettings().GetIsEnabled(),
		ReadReceipts:   s.GetRCSSettings().GetSendReadReceipts(),
		TypingIndicate: s.GetRCSSettings().GetShowTypingIndicators(),
		Version:        s.GetBugleVersion(),
	}
	if r := s.GetRCSSettings(); r != nil && r.IsDefaultSMSApp != nil {
		v := r.GetIsDefaultSMSApp()
		out.DefaultSMSApp = &v
	}
	for _, c := range s.GetSIMCards() {
		d := c.GetSIMData()
		out.SIMs = append(out.SIMs, SIM{
			Number:      d.GetSIMPayload().GetSIMNumber(),
			Phone:       d.GetInternationalPhoneNumber(),
			Formatted:   d.GetFormattedPhoneNumber(),
			Carrier:     d.GetCarrierName(),
			Participant: c.GetSIMParticipant().GetID(),
			RCS:         c.GetRCSChats().GetEnabled(),
		})
	}
	return out
}

// alertName: the phone's user alerts the TypeScript side acts on, by a short name; "" for the rest.
func alertName(a gmproto.AlertType) string {
	switch a {
	case gmproto.AlertType_BROWSER_ACTIVE:
		return "browser_active"
	case gmproto.AlertType_BROWSER_INACTIVE:
		return "browser_inactive"
	case gmproto.AlertType_BROWSER_INACTIVE_FROM_TIMEOUT:
		return "browser_inactive_timeout"
	case gmproto.AlertType_BROWSER_INACTIVE_FROM_INACTIVITY:
		return "browser_inactive_inactivity"
	case gmproto.AlertType_MOBILE_BATTERY_LOW:
		return "battery_low"
	case gmproto.AlertType_MOBILE_BATTERY_RESTORED:
		return "battery_restored"
	case gmproto.AlertType_MOBILE_DATA_CONNECTION:
		return "mobile_data"
	case gmproto.AlertType_MOBILE_WIFI_CONNECTION:
		return "wifi"
	case gmproto.AlertType_MOBILE_DATABASE_SYNC_STARTED:
		return "db_sync_started"
	case gmproto.AlertType_MOBILE_DATABASE_SYNC_COMPLETE:
		return "db_sync_complete"
	case gmproto.AlertType_PUSH_THROTTLE_STARTED:
		return "push_throttle_started"
	case gmproto.AlertType_PUSH_THROTTLE_ENDED:
		return "push_throttle_ended"
	case gmproto.AlertType_RCS_CONNECTION:
		return "rcs_connection"
	}
	return ""
}

// SIMPayloadFor: the SIM to send from for an outgoing participant, from the phone's settings.
func SIMPayloadFor(s *gmproto.Settings, participant string) *gmproto.SIMPayload {
	for _, c := range s.GetSIMCards() {
		if participant != "" && c.GetSIMParticipant().GetID() == participant {
			return c.GetSIMData().GetSIMPayload()
		}
	}
	return nil
}
