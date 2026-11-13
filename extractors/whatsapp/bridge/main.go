// wa-bridge: a thin JSON-lines wrapper around whatsmeow, the WhatsApp multi-device library
// mautrix-whatsapp and Beeper use. The adapter (TypeScript) owns all mapping; this process
// only keeps the linked-device session, turns whatsmeow events into JSON and runs commands.
//
// stdout: one JSON object per line. Events are {"t":"<type>", ...}; replies are
// {"t":"reply","id":..., "ok":true, "result":...} or {"t":"reply","id":..., "ok":false, "error":...}.
// stdin: one command per line, {"id":"1","op":"send", ...}. Logs go to stderr.
// Messages are protojson (waE2E.Message, camelCase field names), with bytes fields over 2 KB
// (thumbnails) dropped.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waMmsRetry"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

const bridgeVersion = "0.1.0"

// ------------------------------------------------------------------ output

type writer struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func (w *writer) send(v any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.enc.Encode(v)
}

var out = &writer{enc: json.NewEncoder(os.Stdout)}

type obj = map[string]any

func emit(t string, fields obj) {
	if fields == nil {
		fields = obj{}
	}
	fields["t"] = t
	out.send(fields)
}

// stderr logger with a level floor.
type logger struct {
	module string
	min    int
}

var levels = map[string]int{"DEBUG": 0, "INFO": 1, "WARN": 2, "ERROR": 3}

func (l *logger) log(level, msg string, args ...any) {
	if levels[level] < l.min {
		return
	}
	fmt.Fprintf(os.Stderr, "%s [%s %s] %s\n", time.Now().Format("15:04:05.000"), l.module, level, fmt.Sprintf(msg, args...))
}
func (l *logger) Debugf(m string, a ...any) { l.log("DEBUG", m, a...) }
func (l *logger) Infof(m string, a ...any)  { l.log("INFO", m, a...) }
func (l *logger) Warnf(m string, a ...any)  { l.log("WARN", m, a...) }
func (l *logger) Errorf(m string, a ...any) { l.log("ERROR", m, a...) }
func (l *logger) Sub(module string) waLog.Logger {
	return &logger{module: l.module + "/" + module, min: l.min}
}

// ------------------------------------------------------------------ JSON shapes

var pj = protojson.MarshalOptions{}

// stripLarge drops bytes fields over 2 KB (jpegThumbnail and friends): the hub never shows them
// and history syncs carry thousands.
func stripLarge(m protoreflect.Message) {
	var clear []protoreflect.FieldDescriptor
	m.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		switch {
		case fd.IsMap():
		case fd.IsList():
			if fd.Kind() == protoreflect.MessageKind {
				l := v.List()
				for i := 0; i < l.Len(); i++ {
					stripLarge(l.Get(i).Message())
				}
			}
		case fd.Kind() == protoreflect.MessageKind || fd.Kind() == protoreflect.GroupKind:
			stripLarge(v.Message())
		case fd.Kind() == protoreflect.BytesKind:
			if len(v.Bytes()) > 2048 {
				clear = append(clear, fd)
			}
		}
		return true
	})
	for _, fd := range clear {
		m.Clear(fd)
	}
}

func protoJSON(m proto.Message) json.RawMessage {
	if m == nil || !m.ProtoReflect().IsValid() {
		return nil
	}
	c := proto.Clone(m)
	stripLarge(c.ProtoReflect())
	b, err := pj.Marshal(c)
	if err != nil {
		return nil
	}
	return b
}

func jidStr(j types.JID) string {
	if j.IsEmpty() {
		return ""
	}
	return j.ToNonAD().String()
}

func jidList(js []types.JID) []string {
	out := make([]string, 0, len(js))
	for _, j := range js {
		out = append(out, jidStr(j))
	}
	return out
}

type infoJSON struct {
	ID           string `json:"id"`
	Chat         string `json:"chat"`
	ChatAlt      string `json:"chatAlt,omitempty"`
	Sender       string `json:"sender"`
	SenderAlt    string `json:"senderAlt,omitempty"`
	RecipientAlt string `json:"recipientAlt,omitempty"`
	FromMe       bool   `json:"fromMe"`
	IsGroup      bool   `json:"isGroup"`
	Ts           int64  `json:"ts"`
	PushName     string `json:"pushName,omitempty"`
	Type         string `json:"type,omitempty"`
	MediaType    string `json:"mediaType,omitempty"`
	Edit         string `json:"edit,omitempty"`
	Addressing   string `json:"addressing,omitempty"`
	Category     string `json:"category,omitempty"`
	DeviceSentTo string `json:"deviceSentTo,omitempty"`
}

type bridge struct {
	cli       *whatsmeow.Client
	container *sqlstore.Container
	log       *logger
	ctx       context.Context

	qrMu      sync.Mutex
	qrCancel  context.CancelFunc
	firstCode chan struct{}

	retryMu sync.Mutex
	retries map[string]chan *events.MediaRetry

	// Who you blocked: read when a profile is first opened, dropped when WhatsApp says it changed or on a reconnect.
	blockMu   sync.Mutex
	blocklist *types.Blocklist
}

// alt finds the other address (phone number <-> LID) of a user, if the store knows it.
func (b *bridge) alt(j types.JID) string {
	if b.cli == nil {
		return ""
	}
	j = j.ToNonAD()
	var a types.JID
	var err error
	switch j.Server {
	case types.HiddenUserServer:
		a, err = b.cli.Store.LIDs.GetPNForLID(b.ctx, j)
	case types.DefaultUserServer:
		a, err = b.cli.Store.LIDs.GetLIDForPN(b.ctx, j)
	default:
		return ""
	}
	if err != nil || a.IsEmpty() {
		return ""
	}
	return jidStr(a)
}

func (b *bridge) info(i *types.MessageInfo) infoJSON {
	j := infoJSON{
		ID:           i.ID,
		Chat:         jidStr(i.Chat),
		Sender:       jidStr(i.Sender),
		SenderAlt:    jidStr(i.SenderAlt),
		RecipientAlt: jidStr(i.RecipientAlt),
		FromMe:       i.IsFromMe,
		IsGroup:      i.IsGroup,
		Ts:           i.Timestamp.UnixMilli(),
		PushName:     i.PushName,
		Type:         i.Type,
		MediaType:    i.MediaType,
		Edit:         string(i.Edit),
		Addressing:   string(i.AddressingMode),
		Category:     i.Category,
	}
	if i.DeviceSentMeta != nil {
		j.DeviceSentTo = i.DeviceSentMeta.DestinationJID
	}
	if !i.IsGroup {
		if j.RecipientAlt != "" && i.IsFromMe {
			j.ChatAlt = j.RecipientAlt
		} else {
			j.ChatAlt = b.alt(i.Chat)
		}
	}
	if j.SenderAlt == "" && !i.IsFromMe {
		j.SenderAlt = b.alt(i.Sender)
	}
	return j
}

func (b *bridge) messageEvent(evt *events.Message, history bool, web proto.Message) obj {
	o := obj{
		"info":    b.info(&evt.Info),
		"message": protoJSON(evt.Message),
	}
	flags := []string{}
	if evt.IsEdit {
		flags = append(flags, "edit")
	}
	if evt.IsViewOnce {
		flags = append(flags, "viewOnce")
	}
	if evt.IsEphemeral {
		flags = append(flags, "ephemeral")
	}
	if len(flags) > 0 {
		o["flags"] = flags
	}
	if history {
		o["history"] = true
	}
	if web != nil {
		o["web"] = protoJSON(web)
	}
	return o
}

type partJSON struct {
	JID         string `json:"jid"`
	PN          string `json:"pn,omitempty"`
	LID         string `json:"lid,omitempty"`
	Admin       bool   `json:"admin,omitempty"`
	SuperAdmin  bool   `json:"superAdmin,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
}

type groupJSON struct {
	JID          string     `json:"jid"`
	Name         string     `json:"name"`
	Topic        string     `json:"topic,omitempty"`
	IsParent     bool       `json:"isParent,omitempty"`
	LinkedParent string     `json:"linkedParent,omitempty"`
	IsDefaultSub bool       `json:"isDefaultSub,omitempty"`
	IsAnnounce   bool       `json:"isAnnounce,omitempty"`
	IsLocked     bool       `json:"isLocked,omitempty"`
	Ephemeral    uint32     `json:"ephemeral,omitempty"`
	Created      int64      `json:"created,omitempty"`
	Addressing   string     `json:"addressing,omitempty"`
	Count        int        `json:"count,omitempty"`
	Suspended    bool       `json:"suspended,omitempty"`
	Participants []partJSON `json:"participants"`
	// For the About panel: who made it, who may add people, whether joining by link needs an admin, and the
	// current description's id (SetGroupTopic wants it as the previous one).
	OwnerJID      string `json:"ownerJid,omitempty"`
	OwnerPN       string `json:"ownerPn,omitempty"`
	MemberAddMode string `json:"memberAddMode,omitempty"`
	JoinApproval  bool   `json:"joinApproval,omitempty"`
	TopicID       string `json:"topicId,omitempty"`
}

func groupOf(g *types.GroupInfo) groupJSON {
	j := groupJSON{
		JID:          jidStr(g.JID),
		Name:         g.Name,
		Topic:        g.Topic,
		IsParent:     g.IsParent,
		LinkedParent: jidStr(g.LinkedParentJID),
		IsDefaultSub: g.IsDefaultSubGroup,
		IsAnnounce:   g.IsAnnounce,
		IsLocked:     g.IsLocked,
		Addressing:   string(g.AddressingMode),
		Count:        g.ParticipantCount,
		Suspended:    g.Suspended,
		Participants: []partJSON{},

		OwnerJID:      jidStr(g.OwnerJID),
		OwnerPN:       jidStr(g.OwnerPN),
		MemberAddMode: string(g.MemberAddMode),
		JoinApproval:  g.IsJoinApprovalRequired,
		TopicID:       g.TopicID,
	}
	if g.IsEphemeral {
		j.Ephemeral = g.DisappearingTimer
	}
	if !g.GroupCreated.IsZero() {
		j.Created = g.GroupCreated.UnixMilli()
	}
	for _, p := range g.Participants {
		j.Participants = append(j.Participants, partJSON{
			JID: jidStr(p.JID), PN: jidStr(p.PhoneNumber), LID: jidStr(p.LID),
			Admin: p.IsAdmin, SuperAdmin: p.IsSuperAdmin, DisplayName: p.DisplayName,
		})
	}
	if j.Count == 0 {
		j.Count = len(j.Participants)
	}
	return j
}

// What WhatsApp's own apps show when you open someone's info: their About, picture id and business name.
type userInfoJSON struct {
	Status        string `json:"status,omitempty"`
	PictureID     string `json:"pictureId,omitempty"`
	LID           string `json:"lid,omitempty"`
	BusinessName  string `json:"businessName,omitempty"`
	VerifiedLevel string `json:"verifiedLevel,omitempty"`
}

func userInfoOf(u types.UserInfo) userInfoJSON {
	j := userInfoJSON{Status: u.Status, PictureID: u.PictureID, LID: jidStr(u.LID)}
	if u.VerifiedName != nil && u.VerifiedName.Details != nil {
		j.BusinessName = u.VerifiedName.Details.GetVerifiedName()
		j.VerifiedLevel = u.VerifiedName.VerifiedLevel
	}
	return j
}

// ------------------------------------------------------------------ events

// Someone typing ("composing", with media "audio" when recording a voice note) or stopping ("paused").
func chatPresenceOf(evt *events.ChatPresence) obj {
	return obj{"chat": jidStr(evt.Chat), "sender": jidStr(evt.Sender), "fromMe": evt.IsFromMe, "state": string(evt.State), "media": string(evt.Media)}
}

// A receipt: "" (delivered), "read" or "played" from someone else on your messages, per device and, in groups,
// per participant; or your own devices' reads ("read-self", or "read" from you).
func (b *bridge) receiptOf(evt *events.Receipt) obj {
	o := obj{
		"chat": jidStr(evt.Chat), "sender": jidStr(evt.Sender), "fromMe": evt.IsFromMe, "isGroup": evt.IsGroup,
		"ids": evt.MessageIDs, "ts": evt.Timestamp.UnixMilli(), "type": string(evt.Type), "messageSender": jidStr(evt.MessageSender),
	}
	alt := jidStr(evt.SenderAlt)
	if alt == "" && !evt.IsFromMe {
		alt = b.alt(evt.Sender)
	}
	if alt != "" {
		o["senderAlt"] = alt
	}
	return o
}

// A group notification: name, description, members in and out, admins made and unmade. alts maps each member
// JID to their other address (phone number <-> LID) where the store knows it.
func (b *bridge) groupChangeOf(evt *events.GroupInfo) obj {
	o := obj{"jid": jidStr(evt.JID), "join": jidList(evt.Join), "leave": jidList(evt.Leave), "ts": evt.Timestamp.UnixMilli()}
	if len(evt.Promote) > 0 {
		o["promote"] = jidList(evt.Promote)
	}
	if len(evt.Demote) > 0 {
		o["demote"] = jidList(evt.Demote)
	}
	if evt.Name != nil {
		o["name"] = evt.Name.Name
	}
	if evt.Topic != nil {
		o["topic"] = evt.Topic.Topic
	}
	if evt.Delete != nil {
		o["deleted"] = true
	}
	if evt.Sender != nil {
		o["sender"] = jidStr(*evt.Sender)
	}
	if evt.SenderPN != nil {
		o["senderPn"] = jidStr(*evt.SenderPN)
	}
	if evt.MembershipApprovalMode != nil {
		// whatsmeow reads only that the setting changed, not to what: the adapter reads the group again.
		o["approvalMode"] = true
	}
	alts := obj{}
	for _, js := range [][]types.JID{evt.Join, evt.Leave, evt.Promote, evt.Demote} {
		for _, j := range js {
			if a := b.alt(j); a != "" {
				alts[jidStr(j)] = a
			}
		}
	}
	if len(alts) > 0 {
		o["alts"] = alts
	}
	return o
}

// Join requests in a group notification, which whatsmeow passes through as unknown changes: someone asked to join a
// group you admin (created_membership_requests), or a request went because its sender withdrew it or another admin
// declined it (revoked_membership_requests). An approved request arrives as an add. Each child names the requester in
// a participant element (jid, and phone_number for a LID); without one, the notification's sender is the requester.
func (b *bridge) joinRequestsOf(evt *events.GroupInfo) []obj {
	list := []obj{}
	for _, n := range evt.UnknownChanges {
		if n == nil || !isJoinRequestTag(n.Tag) {
			continue
		}
		method := n.AttrGetter().OptionalString("request_method")
		type who struct{ jid, pn types.JID }
		people := []who{}
		parts := n.GetChildrenByTag("participant")
		for i := range parts {
			ag := parts[i].AttrGetter()
			people = append(people, who{ag.OptionalJIDOrEmpty("jid"), ag.OptionalJIDOrEmpty("phone_number")})
		}
		if len(people) == 0 && evt.Sender != nil {
			w := who{jid: *evt.Sender}
			if evt.SenderPN != nil {
				w.pn = *evt.SenderPN
			}
			people = append(people, w)
		}
		for _, p := range people {
			if p.jid.IsEmpty() {
				continue
			}
			o := obj{"group": jidStr(evt.JID), "user": jidStr(p.jid), "ts": evt.Timestamp.UnixMilli()}
			alt := jidStr(p.pn)
			if alt == "" {
				alt = b.alt(p.jid)
			}
			if alt != "" && alt != jidStr(p.jid) {
				o["alt"] = alt
			}
			if method != "" {
				o["method"] = method
			}
			if n.Tag == "revoked_membership_requests" {
				o["gone"] = true
			}
			if evt.Sender != nil {
				o["by"] = jidStr(*evt.Sender)
			}
			list = append(list, o)
		}
	}
	return list
}

func isJoinRequestTag(tag string) bool {
	return tag == "created_membership_requests" || tag == "revoked_membership_requests"
}

// onlyJoinRequests: the notification says nothing but who asked to join or whose request went. That needs no fresh
// read of the group, which a group_change makes the adapter do.
func onlyJoinRequests(evt *events.GroupInfo) bool {
	if len(evt.UnknownChanges) == 0 {
		return false
	}
	for _, n := range evt.UnknownChanges {
		if n == nil || !isJoinRequestTag(n.Tag) {
			return false
		}
	}
	return evt.Name == nil && evt.Topic == nil && evt.Locked == nil && evt.Announce == nil && evt.Ephemeral == nil &&
		evt.MembershipApprovalMode == nil && evt.Delete == nil && evt.Link == nil && evt.Unlink == nil && evt.NewInviteLink == nil &&
		len(evt.Join)+len(evt.Leave)+len(evt.Promote)+len(evt.Demote) == 0 && !evt.Suspended && !evt.Unsuspended
}

// One person who asked to join a group you admin, as GetGroupRequestParticipants lists them.
func (b *bridge) joinRequestOf(r types.GroupParticipantRequest) obj {
	o := obj{"jid": jidStr(r.JID), "ts": r.RequestedAt.UnixMilli()}
	if a := b.alt(r.JID); a != "" {
		o["alt"] = a
	}
	return o
}

// What IsOnWhatsApp says about one number: the account's JID (a LID, or the phone number), the phone number it is
// registered under, and a business's verified name.
func (b *bridge) onWhatsAppOf(r types.IsOnWhatsAppResponse) obj {
	o := obj{"query": r.Query, "jid": jidStr(r.JID), "isIn": r.IsIn, "alt": b.alt(r.JID)}
	if pn := jidStr(r.PhoneNumber); pn != "" && pn != jidStr(r.JID) {
		o["pn"] = pn
	}
	if r.VerifiedName != nil && r.VerifiedName.Details != nil && r.VerifiedName.Details.GetVerifiedName() != "" {
		o["businessName"] = r.VerifiedName.Details.GetVerifiedName()
	}
	return o
}

// addError says in a plain sentence why WhatsApp refused a link, a join or an answer. Anything else as it came.
func addError(err error) error {
	var iq *whatsmeow.IQError
	switch {
	case err == nil:
		return nil
	case errors.Is(err, whatsmeow.ErrInviteLinkRevoked):
		return errors.New("This group invite link was reset or revoked")
	case errors.Is(err, whatsmeow.ErrInviteLinkInvalid):
		return errors.New("This group invite link is invalid")
	case errors.Is(err, whatsmeow.ErrGroupNotFound), errors.Is(err, whatsmeow.ErrIQNotFound):
		return errors.New("WhatsApp does not know this group any more")
	case errors.Is(err, whatsmeow.ErrIQRateOverLimit):
		return errors.New("WhatsApp is refusing more of these from this account for now (rate limit). Try again in an hour")
	case errors.Is(err, whatsmeow.ErrIQResourceLimit):
		return errors.New("This group is full")
	case errors.Is(err, whatsmeow.ErrIQNotAuthorized), errors.Is(err, whatsmeow.ErrIQForbidden), errors.Is(err, whatsmeow.ErrNotInGroup):
		return fmt.Errorf("WhatsApp does not allow this account to do that (%w)", err)
	case errors.As(err, &iq) && iq.Code == 409:
		return errors.New("This account is in this group already")
	}
	return err
}

// Someone's About changed. WhatsApp pushes this on its own, for your contacts; nothing here asks for it.
func (b *bridge) userAboutOf(evt *events.UserAbout) obj {
	o := obj{"jid": jidStr(evt.JID), "status": evt.Status}
	if a := b.alt(evt.JID); a != "" {
		o["alt"] = a
	}
	if !evt.Timestamp.IsZero() {
		o["ts"] = evt.Timestamp.UnixMilli()
	}
	return o
}

func (b *bridge) onEvent(raw any) {
	switch evt := raw.(type) {
	case *events.Message:
		emit("message", b.messageEvent(evt, false, nil))
	case *events.UndecryptableMessage:
		emit("undecryptable", obj{"info": b.info(&evt.Info), "unavailable": evt.IsUnavailable, "unavailableType": string(evt.UnavailableType)})
	case *events.HistorySync:
		b.onHistory(evt)
	case *events.Receipt:
		emit("receipt", b.receiptOf(evt))
	case *events.ChatPresence:
		emit("chat_presence", chatPresenceOf(evt))
	case *events.PushName:
		emit("push_name", obj{"jid": jidStr(evt.JID), "alt": jidStr(evt.JIDAlt), "name": evt.NewPushName})
	case *events.BusinessName:
		emit("business_name", obj{"jid": jidStr(evt.JID), "name": evt.NewBusinessName})
	case *events.Contact:
		emit("contact", obj{"jid": jidStr(evt.JID), "alt": b.alt(evt.JID), "fullName": evt.Action.GetFullName(), "firstName": evt.Action.GetFirstName()})
	case *events.Mute:
		emit("mute", obj{"jid": jidStr(evt.JID), "muted": evt.Action.GetMuted(), "until": evt.Action.GetMuteEndTimestamp()})
	case *events.Archive:
		emit("archive", obj{"jid": jidStr(evt.JID), "archived": evt.Action.GetArchived()})
	case *events.Pin:
		emit("pin", obj{"jid": jidStr(evt.JID), "pinned": evt.Action.GetPinned()})
	case *events.MarkChatAsRead:
		emit("mark_chat_read", obj{"jid": jidStr(evt.JID), "read": evt.Action.GetRead(), "ts": evt.Timestamp.UnixMilli()})
	case *events.DeleteChat:
		emit("delete_chat", obj{"jid": jidStr(evt.JID)})
	case *events.ClearChat:
		emit("clear_chat", obj{"jid": jidStr(evt.JID)})
	case *events.DeleteForMe:
		emit("delete_for_me", obj{"chat": jidStr(evt.ChatJID), "sender": jidStr(evt.SenderJID), "fromMe": evt.IsFromMe, "id": evt.MessageID})
	case *events.Picture:
		emit("picture", obj{"jid": jidStr(evt.JID), "id": evt.PictureID, "remove": evt.Remove})
	case *events.JoinedGroup:
		emit("group", obj{"group": groupOf(&evt.GroupInfo)})
	case *events.GroupInfo:
		if !onlyJoinRequests(evt) {
			emit("group_change", b.groupChangeOf(evt))
		}
		for _, r := range b.joinRequestsOf(evt) {
			emit("join_request", r)
		}
	case *events.UserAbout:
		emit("user_about", b.userAboutOf(evt))
	case *events.MediaRetry:
		b.retryMu.Lock()
		ch := b.retries[evt.MessageID]
		b.retryMu.Unlock()
		if ch != nil {
			select {
			case ch <- evt:
			default:
			}
		}
	case *events.AppStateSyncComplete:
		emit("app_state_synced", obj{"name": string(evt.Name)})
	case *events.OfflineSyncPreview:
		emit("offline_sync", obj{"total": evt.Total, "done": false})
	case *events.OfflineSyncCompleted:
		emit("offline_sync", obj{"total": evt.Count, "done": true})
	case *events.Blocklist:
		b.dropBlocklist()
	case *events.Connected:
		b.dropBlocklist()
		emit("connected", b.self())
	case *events.Disconnected:
		emit("disconnected", nil)
	case *events.KeepAliveTimeout:
		emit("keepalive_timeout", obj{"errors": evt.ErrorCount})
	case *events.KeepAliveRestored:
		emit("keepalive_restored", nil)
	case *events.PairSuccess:
		emit("paired", obj{"jid": jidStr(evt.ID), "lid": jidStr(evt.LID), "businessName": evt.BusinessName, "platform": evt.Platform})
	case *events.PairError:
		emit("pair_error", obj{"error": fmt.Sprint(evt.Error)})
	case *events.LoggedOut:
		emit("logged_out", obj{"reason": evt.Reason.String(), "onConnect": evt.OnConnect})
	case *events.StreamReplaced:
		emit("stream_replaced", nil)
	case *events.TemporaryBan:
		emit("temporary_ban", obj{"code": int(evt.Code), "reason": evt.Code.String(), "expireSec": int64(evt.Expire.Seconds()), "message": evt.String()})
	case *events.ConnectFailure:
		emit("connect_failure", obj{"reason": int(evt.Reason), "message": evt.Reason.String() + " " + evt.Message})
	case *events.ClientOutdated:
		emit("client_outdated", nil)
	case *events.StreamError:
		emit("stream_error", obj{"code": evt.Code})
	}
}

func (b *bridge) self() obj {
	o := obj{"loggedIn": b.cli.Store.ID != nil, "pushName": b.cli.Store.PushName, "businessName": b.cli.Store.BusinessName}
	if b.cli.Store.ID != nil {
		o["jid"] = jidStr(*b.cli.Store.ID)
	}
	if !b.cli.Store.LID.IsEmpty() {
		o["lid"] = jidStr(b.cli.Store.LID)
	}
	return o
}

func (b *bridge) onHistory(evt *events.HistorySync) {
	d := evt.Data
	convs := []json.RawMessage{}
	for _, c := range d.GetConversations() {
		meta := proto.Clone(c)
		meta.ProtoReflect().Clear(meta.ProtoReflect().Descriptor().Fields().ByName("messages"))
		convs = append(convs, protoJSON(meta))
	}
	pushnames := []obj{}
	for _, p := range d.GetPushnames() {
		pushnames = append(pushnames, obj{"jid": p.GetID(), "name": p.GetPushname()})
	}
	lids := []obj{}
	for _, m := range d.GetPhoneNumberToLidMappings() {
		lids = append(lids, obj{"pn": m.GetPnJID(), "lid": m.GetLidJID()})
	}
	emit("history", obj{
		"syncType": d.GetSyncType().String(), "chunkOrder": d.GetChunkOrder(), "progress": d.GetProgress(),
		"conversations": convs, "pushnames": pushnames, "lidMappings": lids,
	})
	for _, c := range d.GetConversations() {
		chat, err := types.ParseJID(c.GetID())
		if err != nil {
			continue
		}
		for _, hm := range c.GetMessages() {
			wm := hm.GetMessage()
			if wm == nil {
				continue
			}
			parsed, err := b.cli.ParseWebMessage(chat, wm)
			if err != nil {
				b.log.Debugf("history message %s: %v", wm.GetKey().GetID(), err)
				continue
			}
			web := proto.Clone(wm)
			web.ProtoReflect().Clear(web.ProtoReflect().Descriptor().Fields().ByName("message"))
			emit("message", b.messageEvent(parsed, true, web))
		}
	}
	emit("history_done", obj{"syncType": d.GetSyncType().String(), "chunkOrder": d.GetChunkOrder(), "count": len(d.GetConversations())})
}

// ------------------------------------------------------------------ linking

// startQR (re)starts a QR pairing session. QR codes go out as "qr" events.
func (b *bridge) startQR() error {
	if b.cli.Store.ID != nil {
		return errors.New("already linked")
	}
	b.qrMu.Lock()
	if b.qrCancel != nil {
		b.qrCancel()
	}
	b.cli.Disconnect()
	ctx, cancel := context.WithCancel(b.ctx)
	b.qrCancel = cancel
	first := make(chan struct{})
	b.firstCode = first
	b.qrMu.Unlock()

	ch, err := b.cli.GetQRChannel(ctx)
	if err != nil {
		cancel()
		return err
	}
	if err := b.cli.Connect(); err != nil {
		cancel()
		return err
	}
	go func() {
		once := sync.Once{}
		for item := range ch {
			switch item.Event {
			case whatsmeow.QRChannelEventCode:
				emit("qr", obj{"code": item.Code, "timeoutMs": item.Timeout.Milliseconds()})
				once.Do(func() { close(first) })
			case whatsmeow.QRChannelEventError:
				emit("qr_done", obj{"result": "error", "error": fmt.Sprint(item.Error)})
			default:
				emit("qr_done", obj{"result": item.Event})
			}
		}
	}()
	return nil
}

func (b *bridge) pairPhone(phone string) (string, error) {
	if b.cli.Store.ID != nil {
		return "", errors.New("already linked")
	}
	b.qrMu.Lock()
	first := b.firstCode
	b.qrMu.Unlock()
	if first == nil || !b.cli.IsConnected() {
		if err := b.startQR(); err != nil {
			return "", err
		}
		b.qrMu.Lock()
		first = b.firstCode
		b.qrMu.Unlock()
	}
	select {
	case <-first:
	case <-time.After(30 * time.Second):
		return "", errors.New("WhatsApp did not answer the link request")
	}
	phone = strings.TrimLeft(strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, phone), "0")
	return b.cli.PairPhone(b.ctx, phone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
}

// ------------------------------------------------------------------ commands

type command struct {
	ID string          `json:"id"`
	Op string          `json:"op"`
	A  json.RawMessage `json:"-"`
}

func parseJID(s string) (types.JID, error) {
	j, err := types.ParseJID(s)
	if err != nil {
		return j, fmt.Errorf("bad JID %q: %w", s, err)
	}
	return j, nil
}

func (b *bridge) run(op string, raw json.RawMessage) (any, error) {
	ctx, cancel := context.WithTimeout(b.ctx, 120*time.Second)
	defer cancel()
	switch op {
	case "status":
		o := b.self()
		o["connected"] = b.cli.IsConnected()
		o["version"] = bridgeVersion
		return o, nil
	case "connect":
		if b.cli.Store.ID == nil {
			return nil, b.startQR()
		}
		if b.cli.IsConnected() {
			return nil, nil
		}
		return nil, b.cli.Connect()
	case "link":
		return nil, b.startQR()
	case "pairPhone":
		var a struct{ Phone string }
		_ = json.Unmarshal(raw, &a)
		code, err := b.pairPhone(a.Phone)
		return obj{"code": code}, err
	case "logout":
		if b.cli.Store.ID == nil {
			return nil, nil
		}
		return nil, b.cli.Logout(ctx)
	case "send":
		// Field names must not match "id" (Go's JSON matching ignores case): that is the command id.
		var a struct {
			Chat      string
			MessageID string `json:"messageId"`
			Message   json.RawMessage
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		chat, err := parseJID(a.Chat)
		if err != nil {
			return nil, err
		}
		var msg waE2E.Message
		if err := protojson.Unmarshal(a.Message, &msg); err != nil {
			return nil, fmt.Errorf("bad message: %w", err)
		}
		resp, err := b.cli.SendMessage(ctx, chat, &msg, whatsmeow.SendRequestExtra{ID: a.MessageID})
		if err != nil {
			return nil, err
		}
		return obj{"id": resp.ID, "ts": resp.Timestamp.UnixMilli(), "sender": jidStr(resp.Sender)}, nil
	case "historyRequest":
		var a struct {
			Chat, Sender string
			MsgID        string `json:"msgId"`
			FromMe       bool
			Ts           int64
			Count        int
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		chat, err := parseJID(a.Chat)
		if err != nil {
			return nil, err
		}
		info := &types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, IsFromMe: a.FromMe}, ID: a.MsgID, Timestamp: time.UnixMilli(a.Ts)}
		if a.Sender != "" {
			info.Sender, _ = types.ParseJID(a.Sender)
		}
		_, err = b.cli.SendPeerMessage(ctx, b.cli.BuildHistorySyncRequest(info, a.Count))
		return nil, err
	case "upload":
		var a struct{ Path, Kind string }
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		data, err := os.ReadFile(a.Path)
		if err != nil {
			return nil, err
		}
		mt := map[string]whatsmeow.MediaType{"image": whatsmeow.MediaImage, "video": whatsmeow.MediaVideo, "audio": whatsmeow.MediaAudio, "sticker": whatsmeow.MediaImage}[a.Kind]
		if mt == "" {
			mt = whatsmeow.MediaDocument
		}
		up, err := b.cli.Upload(ctx, data, mt)
		if err != nil {
			return nil, err
		}
		o := obj{"url": up.URL, "directPath": up.DirectPath, "mediaKey": up.MediaKey, "fileEncSHA256": up.FileEncSHA256, "fileSHA256": up.FileSHA256, "fileLength": up.FileLength}
		if a.Kind == "image" {
			if thumb, w, h, err := thumbnail(data); err == nil {
				o["thumbnail"], o["width"], o["height"] = thumb, w, h
			}
		}
		return o, nil
	case "download":
		var a struct {
			Message json.RawMessage
			Dest    string
			Info    struct {
				ID, Chat, Sender string
				FromMe           bool
			}
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		var msg waE2E.Message
		if err := protojson.Unmarshal(a.Message, &msg); err != nil {
			return nil, fmt.Errorf("bad message: %w", err)
		}
		data, err := b.cli.DownloadAny(ctx, &msg)
		var newPath string
		if errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith404) || errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith410) {
			newPath, err = b.mediaRetry(ctx, &msg, a.Info.ID, a.Info.Chat, a.Info.Sender, a.Info.FromMe)
			if err == nil {
				data, err = b.cli.DownloadAny(ctx, &msg)
			}
		}
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(a.Dest, data, 0o600); err != nil {
			return nil, err
		}
		o := obj{"path": a.Dest, "size": len(data)}
		if newPath != "" {
			o["directPath"] = newPath
		}
		return o, nil
	case "markRead":
		var a struct {
			Chat, Sender string
			IDs          []string
			Ts           int64
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		chat, err := parseJID(a.Chat)
		if err != nil {
			return nil, err
		}
		var sender types.JID
		if a.Sender != "" {
			sender, _ = types.ParseJID(a.Sender)
		}
		return nil, b.cli.MarkRead(ctx, a.IDs, time.UnixMilli(a.Ts), chat, sender)
	case "chatPresence":
		var a struct{ Chat, State string }
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		chat, err := parseJID(a.Chat)
		if err != nil {
			return nil, err
		}
		return nil, b.cli.SendChatPresence(ctx, chat, types.ChatPresence(a.State), types.ChatPresenceMediaText)
	case "presence":
		var a struct{ State string }
		_ = json.Unmarshal(raw, &a)
		return nil, b.cli.SendPresence(ctx, types.Presence(a.State))
	case "groups":
		gs, err := b.cli.GetJoinedGroups(ctx)
		if err != nil {
			return nil, err
		}
		list := []groupJSON{}
		for _, g := range gs {
			list = append(list, groupOf(g))
		}
		return list, nil
	case "group":
		var a struct{ JID string }
		_ = json.Unmarshal(raw, &a)
		j, err := parseJID(a.JID)
		if err != nil {
			return nil, err
		}
		g, err := b.cli.GetGroupInfo(ctx, j)
		if err != nil {
			return nil, err
		}
		return groupOf(g), nil
	case "setGroupName", "setGroupTopic", "setGroupAnnounce", "setGroupLocked", "setGroupMemberAddMode", "setGroupJoinApproval", "setDisappearing", "groupInviteLink":
		return b.groupSetting(ctx, op, raw)
	case "contacts":
		all, err := b.cli.Store.Contacts.GetAllContacts(ctx)
		if err != nil {
			return nil, err
		}
		list := []obj{}
		for j, c := range all {
			o := obj{"jid": jidStr(j), "firstName": c.FirstName, "fullName": c.FullName, "pushName": c.PushName, "businessName": c.BusinessName}
			if a := b.alt(j); a != "" {
				o["alt"] = a
			}
			list = append(list, o)
		}
		return list, nil
	case "lids":
		var a struct{ JIDs []string }
		_ = json.Unmarshal(raw, &a)
		m := obj{}
		for _, s := range a.JIDs {
			if j, err := types.ParseJID(s); err == nil {
				if alt := b.alt(j); alt != "" {
					m[s] = alt
				}
			}
		}
		return m, nil
	case "isOnWhatsApp":
		var a struct{ Phones []string }
		_ = json.Unmarshal(raw, &a)
		res, err := b.cli.IsOnWhatsApp(ctx, a.Phones)
		if err != nil {
			return nil, addError(err)
		}
		list := []obj{}
		for _, r := range res {
			list = append(list, b.onWhatsAppOf(r))
		}
		return list, nil
	case "groupFromLink", "joinLink", "joinRequests", "answerJoinRequest":
		return b.adding(ctx, op, raw)
	case "userInfo":
		// One person, when you open their profile: the usync query WhatsApp's own apps make then. Never a list.
		var a struct{ JID string }
		_ = json.Unmarshal(raw, &a)
		j, err := parseJID(a.JID)
		if err != nil {
			return nil, err
		}
		j = j.ToNonAD()
		if j.Server != types.DefaultUserServer && j.Server != types.HiddenUserServer {
			return nil, fmt.Errorf("%s is not a person", j)
		}
		res, err := b.cli.GetUserInfo(ctx, []types.JID{j})
		if err != nil {
			return nil, err
		}
		u, ok := res[j]
		if !ok { // answered under their other address
			for _, v := range res {
				u, ok = v, true
				break
			}
		}
		if !ok {
			return nil, nil
		}
		return userInfoOf(u), nil
	case "setAbout":
		// Your own About: the text status WhatsApp's apps set (no emoji, no expiry). "" clears it.
		var a struct{ About string }
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		if b.cli.Store.ID == nil {
			return nil, fmt.Errorf("not linked")
		}
		return nil, b.cli.SetStatusMessage(ctx, types.SetStatusInput{Text: &a.About})
	case "blocked":
		// Whether any of one person's addresses is on your blocklist.
		var a struct{ JIDs []string }
		_ = json.Unmarshal(raw, &a)
		bl, err := b.getBlocklist(ctx)
		if err != nil {
			return nil, err
		}
		for _, s := range a.JIDs {
			if j, err := types.ParseJID(s); err == nil && bl.IsBlocked(j.ToNonAD()) {
				return obj{"blocked": true}, nil
			}
		}
		return obj{"blocked": false}, nil
	case "avatar":
		var a struct {
			JID       string
			Community bool
		}
		_ = json.Unmarshal(raw, &a)
		j, err := parseJID(a.JID)
		if err != nil {
			return nil, err
		}
		p, err := b.cli.GetProfilePictureInfo(ctx, j, &whatsmeow.GetProfilePictureParams{IsCommunity: a.Community})
		if errors.Is(err, whatsmeow.ErrProfilePictureNotSet) || errors.Is(err, whatsmeow.ErrProfilePictureUnauthorized) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if p == nil {
			return nil, nil
		}
		return obj{"url": p.URL, "id": p.ID}, nil
	}
	return nil, fmt.Errorf("unknown op %q", op)
}

// getBlocklist is the blocklist as last read, or read now (one query, as WhatsApp's own apps make on start).
func (b *bridge) getBlocklist(ctx context.Context) (*types.Blocklist, error) {
	b.blockMu.Lock()
	defer b.blockMu.Unlock()
	if b.blocklist != nil {
		return b.blocklist, nil
	}
	bl, err := b.cli.GetBlocklist(ctx, "")
	if err != nil {
		return nil, err
	}
	if bl == nil {
		bl = &types.Blocklist{}
	}
	b.blocklist = bl
	return bl, nil
}

func (b *bridge) dropBlocklist() {
	b.blockMu.Lock()
	b.blocklist = nil
	b.blockMu.Unlock()
}

// The disappearing timers WhatsApp's own apps offer. In groups the server refuses others; in 1:1 chats the apps
// ignore them.
var disappearingTimers = map[int64]bool{0: true, 86400: true, 7 * 86400: true, 90 * 86400: true}

// groupSetting changes one setting of a group or community, reads or resets its invite link, or sets a chat's
// disappearing timer. Membership is never changed here: adding people is what WhatsApp's enforcement watches for.
func (b *bridge) groupSetting(ctx context.Context, op string, raw json.RawMessage) (any, error) {
	// Field names must not match "id" or "op" (Go's JSON matching ignores case).
	var a struct {
		JID        string
		Name       string
		Topic      string
		PreviousID string `json:"previousId"`
		On         bool
		Mode       string
		Seconds    int64
		Reset      bool
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	j, err := parseJID(a.JID)
	if err != nil {
		return nil, err
	}
	if op == "setDisappearing" {
		if !disappearingTimers[a.Seconds] {
			return nil, fmt.Errorf("WhatsApp offers disappearing messages of 24 hours, 7 days or 90 days, not %d seconds", a.Seconds)
		}
		if j.Server != types.GroupServer && j.Server != types.DefaultUserServer && j.Server != types.HiddenUserServer {
			return nil, fmt.Errorf("cannot set disappearing messages in %s", j)
		}
		return nil, b.cli.SetDisappearingTimer(ctx, j.ToNonAD(), time.Duration(a.Seconds)*time.Second, time.Time{})
	}
	if j.Server != types.GroupServer {
		return nil, fmt.Errorf("%s is not a group", j)
	}
	switch op {
	case "setGroupName":
		if strings.TrimSpace(a.Name) == "" {
			return nil, errors.New("a group name cannot be empty")
		}
		return nil, b.cli.SetGroupName(ctx, j, a.Name)
	case "setGroupTopic":
		// Without the previous id whatsmeow fetches the group for it first.
		return nil, b.cli.SetGroupTopic(ctx, j, a.PreviousID, "", a.Topic)
	case "setGroupAnnounce":
		return nil, b.cli.SetGroupAnnounce(ctx, j, a.On)
	case "setGroupLocked":
		return nil, b.cli.SetGroupLocked(ctx, j, a.On)
	case "setGroupMemberAddMode":
		mode := types.GroupMemberAddMode(a.Mode)
		if mode != types.GroupMemberAddModeAdmin && mode != types.GroupMemberAddModeAllMember {
			return nil, fmt.Errorf("unknown member add mode %q", a.Mode)
		}
		return nil, b.cli.SetGroupMemberAddMode(ctx, j, mode)
	case "setGroupJoinApproval":
		return nil, b.cli.SetGroupJoinApprovalMode(ctx, j, a.On)
	case "groupInviteLink":
		link, err := b.cli.GetGroupInviteLink(ctx, j, a.Reset)
		if errors.Is(err, whatsmeow.ErrGroupInviteLinkUnauthorized) {
			return nil, errors.New("only admins can see and change the invite link")
		}
		if err != nil {
			return nil, err
		}
		return obj{"link": link}, nil
	}
	return nil, fmt.Errorf("unknown op %q", op)
}

// adding: what a group invite link is, joining yourself by one, and the join requests of groups you admin. Each runs
// only because the owner clicked: a pasted link, Join, Accept or Decline. Nobody else's membership is changed here
// except by answering their own request to join: adding people is what WhatsApp's enforcement watches for.
func (b *bridge) adding(ctx context.Context, op string, raw json.RawMessage) (any, error) {
	// Field names must not match "id" or "op" (Go's JSON matching ignores case).
	var a struct {
		Code    string
		JID     string
		User    string
		Approve bool
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	switch op {
	case "groupFromLink":
		// The read WhatsApp's own apps make to show an invite: it joins nothing and tells nobody.
		g, err := b.cli.GetGroupInfoFromLink(ctx, a.Code)
		if err != nil {
			return nil, addError(err)
		}
		return groupOf(g), nil
	case "joinLink":
		// You join, or with join approval on, ask to: the admins then answer.
		j, err := b.cli.JoinGroupWithLink(ctx, a.Code)
		if err != nil {
			return nil, addError(err)
		}
		return obj{"jid": jidStr(j)}, nil
	}
	j, err := parseJID(a.JID)
	if err != nil {
		return nil, err
	}
	if j.Server != types.GroupServer {
		return nil, fmt.Errorf("%s is not a group", j)
	}
	switch op {
	case "joinRequests":
		list, err := b.cli.GetGroupRequestParticipants(ctx, j)
		if err != nil {
			return nil, addError(err)
		}
		out := []obj{}
		for _, r := range list {
			out = append(out, b.joinRequestOf(r))
		}
		return out, nil
	case "answerJoinRequest":
		user, err := parseJID(a.User)
		if err != nil {
			return nil, err
		}
		if user.Server != types.DefaultUserServer && user.Server != types.HiddenUserServer {
			return nil, fmt.Errorf("%s is not a person", user)
		}
		action := whatsmeow.ParticipantChangeReject
		if a.Approve {
			action = whatsmeow.ParticipantChangeApprove
		}
		res, err := b.cli.UpdateGroupRequestParticipants(ctx, j, []types.JID{user.ToNonAD()}, action)
		if errors.Is(err, whatsmeow.ErrIQNotAuthorized) || errors.Is(err, whatsmeow.ErrIQForbidden) {
			return nil, errors.New("Only the group's admins can answer requests to join it")
		}
		if err != nil {
			return nil, addError(err)
		}
		for _, p := range res {
			switch {
			case p.Error == 404:
				return nil, errors.New("That request is not waiting any more")
			case p.Error != 0:
				return nil, fmt.Errorf("WhatsApp did not take that answer (error %d)", p.Error)
			}
		}
		return obj{"approved": a.Approve}, nil
	}
	return nil, fmt.Errorf("unknown op %q", op)
}

// mediaRetry asks the phone to re-upload media whose CDN copy expired, and points msg at the new copy.
func (b *bridge) mediaRetry(ctx context.Context, msg *waE2E.Message, id, chat, sender string, fromMe bool) (string, error) {
	media := downloadable(msg)
	if media == nil {
		return "", errors.New("nothing to download in this message")
	}
	chatJID, err := parseJID(chat)
	if err != nil {
		return "", err
	}
	info := &types.MessageInfo{ID: id, MessageSource: types.MessageSource{Chat: chatJID, IsFromMe: fromMe, IsGroup: chatJID.Server == types.GroupServer}}
	if sender != "" {
		info.Sender, _ = types.ParseJID(sender)
	}
	ch := make(chan *events.MediaRetry, 1)
	b.retryMu.Lock()
	b.retries[id] = ch
	b.retryMu.Unlock()
	defer func() {
		b.retryMu.Lock()
		delete(b.retries, id)
		b.retryMu.Unlock()
	}()
	if err := b.cli.SendMediaRetryReceipt(ctx, info, media.GetMediaKey()); err != nil {
		return "", err
	}
	select {
	case evt := <-ch:
		if evt.Error != nil {
			return "", fmt.Errorf("the phone could not re-send this media (code %d)", evt.Error.Code)
		}
		res, err := whatsmeow.DecryptMediaRetryNotification(evt, media.GetMediaKey())
		if err != nil {
			return "", err
		}
		if res.GetResult() != waMmsRetry.MediaRetryNotification_SUCCESS {
			return "", fmt.Errorf("the phone no longer has this media (%s)", res.GetResult())
		}
		media.setDirectPath(res.GetDirectPath())
		return res.GetDirectPath(), nil
	case <-time.After(45 * time.Second):
		return "", errors.New("media expired and the phone did not re-send it (is it online?)")
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

type mediaRef struct {
	GetMediaKey   func() []byte
	setDirectPath func(string)
}

func downloadable(m *waE2E.Message) *mediaRef {
	switch {
	case m.ImageMessage != nil:
		x := m.ImageMessage
		return &mediaRef{x.GetMediaKey, func(p string) { x.DirectPath = &p }}
	case m.VideoMessage != nil:
		x := m.VideoMessage
		return &mediaRef{x.GetMediaKey, func(p string) { x.DirectPath = &p }}
	case m.AudioMessage != nil:
		x := m.AudioMessage
		return &mediaRef{x.GetMediaKey, func(p string) { x.DirectPath = &p }}
	case m.DocumentMessage != nil:
		x := m.DocumentMessage
		return &mediaRef{x.GetMediaKey, func(p string) { x.DirectPath = &p }}
	case m.StickerMessage != nil:
		x := m.StickerMessage
		return &mediaRef{x.GetMediaKey, func(p string) { x.DirectPath = &p }}
	case m.PtvMessage != nil:
		x := m.PtvMessage
		return &mediaRef{x.GetMediaKey, func(p string) { x.DirectPath = &p }}
	}
	return nil
}

// thumbnail makes the small JPEG preview WhatsApp shows before an image downloads.
func thumbnail(data []byte) ([]byte, int, int, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, err
	}
	bnd := img.Bounds()
	w, h := bnd.Dx(), bnd.Dy()
	scale := 72.0 / float64(max(w, h))
	if scale > 1 {
		scale = 1
	}
	tw, th := max(1, int(float64(w)*scale)), max(1, int(float64(h)*scale))
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	for y := 0; y < th; y++ {
		for x := 0; x < tw; x++ {
			dst.Set(x, y, img.At(bnd.Min.X+int(float64(x)/scale), bnd.Min.Y+int(float64(y)/scale)))
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 60}); err != nil {
		return nil, 0, 0, err
	}
	return buf.Bytes(), w, h, nil
}

// ------------------------------------------------------------------ main

func main() {
	dbPath := flag.String("db", "", "SQLite file for the session (required)")
	osName := flag.String("os-name", "dither-chat", "name shown in WhatsApp → Linked devices")
	platform := flag.String("platform", "DESKTOP", "DeviceProps platform type (DESKTOP, CHROME, FIREFOX, ...)")
	logLevel := flag.String("log", "INFO", "DEBUG, INFO, WARN or ERROR")
	fixtures := flag.Bool("print-fixtures", false, "print sample events for the adapter's tests and exit")
	flag.Parse()
	if *fixtures {
		printFixtures()
		return
	}
	if *dbPath == "" {
		fmt.Fprintln(os.Stderr, "usage: wa-bridge --db <file>")
		os.Exit(2)
	}
	log := &logger{module: "wa", min: levels[strings.ToUpper(*logLevel)]}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	store.SetOSInfo(*osName, [3]uint32{0, 1, 0})
	if v, ok := waCompanionReg.DeviceProps_PlatformType_value[strings.ToUpper(*platform)]; ok {
		store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_PlatformType(v).Enum()
	}
	// The built-in version ages; WhatsApp refuses clients that are too old (405). Use what web.whatsapp.com serves now.
	vctx, vcancel := context.WithTimeout(ctx, 15*time.Second)
	if v, err := whatsmeow.GetLatestVersion(vctx, nil); err == nil {
		store.SetWAVersion(*v)
		log.Infof("WhatsApp Web version %s", v)
	} else {
		log.Warnf("could not fetch the current WhatsApp Web version, using the built-in one: %v", err)
	}
	vcancel()

	container, err := sqlstore.New(ctx, "sqlite3", "file:"+*dbPath+"?_foreign_keys=on&_journal_mode=WAL&_busy_timeout=5000", log.Sub("db"))
	if err != nil {
		emit("fatal", obj{"error": "opening the session store: " + err.Error()})
		os.Exit(1)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		emit("fatal", obj{"error": "reading the session store: " + err.Error()})
		os.Exit(1)
	}
	cli := whatsmeow.NewClient(device, log.Sub("client"))
	cli.EmitAppStateEventsOnFullSync = true
	cli.AutomaticMessageRerequestFromPhone = true
	b := &bridge{cli: cli, container: container, log: log, ctx: ctx, retries: map[string]chan *events.MediaRetry{}}
	cli.AddEventHandler(b.onEvent)

	emit("ready", obj{"version": bridgeVersion, "loggedIn": device.ID != nil})

	lines := make(chan []byte)
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 1<<20), 64<<20)
		for sc.Scan() {
			lines <- append([]byte(nil), sc.Bytes()...)
		}
		close(lines)
	}()
	for {
		select {
		case <-ctx.Done():
			cli.Disconnect()
			return
		case line, ok := <-lines:
			if !ok { // the adapter went away
				cli.Disconnect()
				return
			}
			var c command
			if err := json.Unmarshal(line, &c); err != nil || c.Op == "" {
				continue
			}
			go func(c command, raw []byte) {
				res, err := b.run(c.Op, raw)
				if c.ID == "" {
					return
				}
				if err != nil {
					out.send(obj{"t": "reply", "id": c.ID, "ok": false, "error": err.Error()})
				} else {
					out.send(obj{"t": "reply", "id": c.ID, "ok": true, "result": res})
				}
			}(c, line)
		}
	}
}
