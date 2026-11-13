package main

// `wa-bridge --print-fixtures` prints sample events in the exact wire format, built from real
// whatsmeow types, for the adapter's tests (test/fixtures/events.jsonl). No network, no store.

import (
	"encoding/json"
	"os"
	"time"

	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waVnameCert"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func printFixtures() {
	enc := json.NewEncoder(os.Stdout)
	b := &bridge{}
	me := types.NewJID("15550000001", types.DefaultUserServer)
	alice := types.NewJID("15550000002", types.DefaultUserServer)
	aliceLID := types.NewJID("200000000000002", types.HiddenUserServer)
	bob := types.NewJID("15550000003", types.DefaultUserServer)
	bobLID := types.NewJID("200000000000003", types.HiddenUserServer)
	group := types.NewJID("120363000000000001", types.GroupServer)
	ts := time.UnixMilli(1_760_000_000_000)
	n := 0
	at := func() time.Time { n++; return ts.Add(time.Duration(n) * time.Minute) }
	dm := func(id string, fromMe bool, m *waE2E.Message) *events.Message {
		sender := alice
		if fromMe {
			sender = me
		}
		return &events.Message{Info: types.MessageInfo{ID: id, Timestamp: at(), PushName: "Alice", MessageSource: types.MessageSource{Chat: alice, Sender: sender, IsFromMe: fromMe, SenderAlt: map[bool]types.JID{false: aliceLID, true: {}}[fromMe]}}, RawMessage: m}
	}
	grp := func(id string, from types.JID, alt types.JID, m *waE2E.Message) *events.Message {
		return &events.Message{Info: types.MessageInfo{ID: id, Timestamp: at(), PushName: "Bob", MessageSource: types.MessageSource{Chat: group, Sender: from, SenderAlt: alt, IsGroup: true, IsFromMe: from == me, AddressingMode: types.AddressingModeLID}}, RawMessage: m}
	}
	media := func() (dp *string, key []byte) {
		return proto.String("/v/t62.7118-24/abc?ccb=11-4"), []byte("0123456789abcdef0123456789abcdef")
	}
	dp, key := media()
	key2 := waCommon.MessageKey{RemoteJID: proto.String(alice.String()), FromMe: proto.Bool(false), ID: proto.String("A1")}

	msgs := []struct {
		name string
		evt  *events.Message
	}{
		{"text", dm("A1", false, &waE2E.Message{Conversation: proto.String("hey, *lunch* tomorrow?")})},
		{"own_text", dm("A2", true, &waE2E.Message{Conversation: proto.String("sure ~maybe~")})},
		{"reply_mention", grp("G1", bobLID, bob, &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text: proto.String("@15550000001 see above"),
			ContextInfo: &waE2E.ContextInfo{
				StanzaID: proto.String("G0"), Participant: proto.String(me.String()),
				QuotedMessage: &waE2E.Message{Conversation: proto.String("original")},
				MentionedJID:  []string{me.String()},
			},
		}})},
		{"image", dm("A3", false, &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Caption: proto.String("look"), Mimetype: proto.String("image/jpeg"), DirectPath: dp, MediaKey: key,
			FileSHA256: key, FileEncSHA256: key, FileLength: proto.Uint64(48213), Width: proto.Uint32(1280), Height: proto.Uint32(960),
			JPEGThumbnail: make([]byte, 4000),
		}})},
		{"document", dm("A4", false, &waE2E.Message{DocumentWithCaptionMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
			FileName: proto.String("plan.pdf"), Mimetype: proto.String("application/pdf"), Caption: proto.String("the plan"), DirectPath: dp, MediaKey: key, FileLength: proto.Uint64(90000),
		}}}})},
		{"voice", dm("A5", false, &waE2E.Message{AudioMessage: &waE2E.AudioMessage{Mimetype: proto.String("audio/ogg; codecs=opus"), PTT: proto.Bool(true), Seconds: proto.Uint32(7), DirectPath: dp, MediaKey: key, FileLength: proto.Uint64(12000)}})},
		{"sticker", dm("A6", false, &waE2E.Message{StickerMessage: &waE2E.StickerMessage{Mimetype: proto.String("image/webp"), DirectPath: dp, MediaKey: key, Width: proto.Uint32(512), Height: proto.Uint32(512)}})},
		{"reaction", dm("A7", false, &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Key: &waCommon.MessageKey{RemoteJID: proto.String(alice.String()), FromMe: proto.Bool(true), ID: proto.String("A2")}, Text: proto.String("❤️"), SenderTimestampMS: proto.Int64(ts.UnixMilli())}})},
		{"unreaction", dm("A8", false, &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Key: &waCommon.MessageKey{RemoteJID: proto.String(alice.String()), FromMe: proto.Bool(true), ID: proto.String("A2")}, Text: proto.String("")}})},
		{"edit", dm("A9", false, &waE2E.Message{EditedMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
			Key: &key2, Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(), EditedMessage: &waE2E.Message{Conversation: proto.String("hey, *dinner* tomorrow?")}, TimestampMS: proto.Int64(ts.Add(time.Hour).UnixMilli()),
		}}}})},
		{"revoke", dm("A10", false, &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Key: &key2, Type: waE2E.ProtocolMessage_REVOKE.Enum()}})},
		{"forwarded", dm("A11", false, &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("chain letter"), ContextInfo: &waE2E.ContextInfo{IsForwarded: proto.Bool(true), ForwardingScore: proto.Uint32(2)}}})},
		{"location", dm("A12", false, &waE2E.Message{LocationMessage: &waE2E.LocationMessage{DegreesLatitude: proto.Float64(52.52), DegreesLongitude: proto.Float64(13.405), Name: proto.String("Alexanderplatz")}})},
		{"contact_card", dm("A13", false, &waE2E.Message{ContactMessage: &waE2E.ContactMessage{DisplayName: proto.String("Carol"), Vcard: proto.String("BEGIN:VCARD\nVERSION:3.0\nFN:Carol\nTEL;type=CELL;waid=15550000004:+1 555 000 0004\nEND:VCARD")}})},
		{"poll", grp("G2", bobLID, bob, &waE2E.Message{PollCreationMessageV3: &waE2E.PollCreationMessage{Name: proto.String("Pizza?"), Options: []*waE2E.PollCreationMessage_Option{{OptionName: proto.String("yes")}, {OptionName: proto.String("no")}}}})},
		{"view_once", dm("A14", false, &waE2E.Message{ViewOnceMessageV2: &waE2E.FutureProofMessage{Message: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Mimetype: proto.String("image/jpeg"), DirectPath: dp, MediaKey: key, ViewOnce: proto.Bool(true)}}}})},
		{"group_from_me", grp("G3", me, types.EmptyJID, &waE2E.Message{Conversation: proto.String("on my way")})},
		{"video", grp("G4", bobLID, bob, &waE2E.Message{VideoMessage: &waE2E.VideoMessage{Mimetype: proto.String("video/mp4"), Caption: proto.String("clip"), DirectPath: dp, MediaKey: key, FileLength: proto.Uint64(2_000_000), Seconds: proto.Uint32(12), Width: proto.Uint32(720), Height: proto.Uint32(1280)}})},
		{"ephemeral", dm("A15", false, &waE2E.Message{EphemeralMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{Conversation: proto.String("this disappears")}}})},
		// Pins: the pin-in-chat protocol message, with the duration the pinner chose in messageContextInfo.
		{"pin", dm("A16", false, &waE2E.Message{
			PinInChatMessage:   &waE2E.PinInChatMessage{Key: &waCommon.MessageKey{RemoteJID: proto.String(alice.String()), FromMe: proto.Bool(true), ID: proto.String("A2")}, Type: waE2E.PinInChatMessage_PIN_FOR_ALL.Enum(), SenderTimestampMS: proto.Int64(ts.UnixMilli())},
			MessageContextInfo: &waE2E.MessageContextInfo{MessageAddOnDurationInSecs: proto.Uint32(7 * 86400)},
		})},
		{"unpin", dm("A17", false, &waE2E.Message{PinInChatMessage: &waE2E.PinInChatMessage{Key: &waCommon.MessageKey{RemoteJID: proto.String(alice.String()), FromMe: proto.Bool(true), ID: proto.String("A2")}, Type: waE2E.PinInChatMessage_UNPIN_FOR_ALL.Enum()}})},
		{"pin_group", grp("G5", bobLID, bob, &waE2E.Message{
			PinInChatMessage:   &waE2E.PinInChatMessage{Key: &waCommon.MessageKey{RemoteJID: proto.String(group.String()), FromMe: proto.Bool(false), ID: proto.String("G1"), Participant: proto.String(bobLID.String())}, Type: waE2E.PinInChatMessage_PIN_FOR_ALL.Enum()},
			MessageContextInfo: &waE2E.MessageContextInfo{MessageAddOnDurationInSecs: proto.Uint32(86400)},
		})},
		// Alice invites you to the Book club in your chat (an invitation message, not a link).
		{"group_invite", dm("A18", false, &waE2E.Message{GroupInviteMessage: &waE2E.GroupInviteMessage{
			GroupJID: proto.String("120363000000000002@g.us"), InviteCode: proto.String("FakeInviteCode01"), InviteExpiration: proto.Int64(ts.Add(72 * time.Hour).Unix()),
			GroupName: proto.String("Book club"), Caption: proto.String("come read with us"),
		}})},
	}
	for _, m := range msgs {
		if m.evt.RawMessage.PinInChatMessage != nil {
			m.evt.Info.Edit = types.EditAttributePinInChat
		}
		m.evt.UnwrapRaw()
		o := b.messageEvent(m.evt, false, nil)
		o["t"], o["fixture"] = "message", m.name
		_ = enc.Encode(o)
	}

	// A history sync: conversation metadata, then its messages with their WebMessageInfo extras.
	web := &waWeb.WebMessageInfo{
		Key:              &waCommon.MessageKey{RemoteJID: proto.String(group.String()), FromMe: proto.Bool(false), ID: proto.String("H1"), Participant: proto.String(bobLID.String())},
		MessageTimestamp: proto.Uint64(uint64(ts.Add(-24 * time.Hour).Unix())),
		Message:          &waE2E.Message{Conversation: proto.String("old news")},
		Status:           waWeb.WebMessageInfo_READ.Enum(),
		Reactions:        []*waWeb.Reaction{{Key: &waCommon.MessageKey{RemoteJID: proto.String(group.String()), FromMe: proto.Bool(true), ID: proto.String("R1")}, Text: proto.String("👍"), SenderTimestampMS: proto.Int64(ts.UnixMilli())}},
	}
	stub := &waWeb.WebMessageInfo{
		Key:                   &waCommon.MessageKey{RemoteJID: proto.String(group.String()), FromMe: proto.Bool(false), ID: proto.String("H2"), Participant: proto.String(bobLID.String())},
		MessageTimestamp:      proto.Uint64(uint64(ts.Add(-48 * time.Hour).Unix())),
		MessageStubType:       waWeb.WebMessageInfo_GROUP_PARTICIPANT_ADD.Enum(),
		MessageStubParameters: []string{aliceLID.String()},
	}
	// Bob pinned H1 for everyone (24 hours) and made Alice an admin, as the phone's history has them.
	pinStub := &waWeb.WebMessageInfo{
		Key:              &waCommon.MessageKey{RemoteJID: proto.String(group.String()), FromMe: proto.Bool(false), ID: proto.String("H3"), Participant: proto.String(bobLID.String())},
		MessageTimestamp: proto.Uint64(uint64(ts.Add(-23 * time.Hour).Unix())),
		MessageStubType:  waWeb.WebMessageInfo_PINNED_MESSAGE_IN_CHAT.Enum(),
		PinInChat: &waWeb.PinInChat{
			Type: waWeb.PinInChat_PIN_FOR_ALL.Enum(), Key: &waCommon.MessageKey{RemoteJID: proto.String(group.String()), FromMe: proto.Bool(false), ID: proto.String("H1"), Participant: proto.String(bobLID.String())},
			SenderTimestampMS: proto.Int64(ts.Add(-23 * time.Hour).UnixMilli()), ServerTimestampMS: proto.Int64(ts.Add(-23 * time.Hour).UnixMilli()),
			MessageAddOnContextInfo: &waWeb.MessageAddOnContextInfo{MessageAddOnDurationInSecs: proto.Uint32(86400)},
		},
	}
	promoteStub := &waWeb.WebMessageInfo{
		Key:                   &waCommon.MessageKey{RemoteJID: proto.String(group.String()), FromMe: proto.Bool(false), ID: proto.String("H4"), Participant: proto.String(bobLID.String())},
		MessageTimestamp:      proto.Uint64(uint64(ts.Add(-47 * time.Hour).Unix())),
		MessageStubType:       waWeb.WebMessageInfo_GROUP_PARTICIPANT_PROMOTE.Enum(),
		MessageStubParameters: []string{aliceLID.String()},
	}
	conv := &waHistorySync.Conversation{
		ID: proto.String(group.String()), Name: proto.String("Climbing crew"), UnreadCount: proto.Uint32(3), Archived: proto.Bool(false),
		MuteEndTime: proto.Uint64(uint64(ts.Add(72 * time.Hour).Unix())), LastMsgTimestamp: proto.Uint64(uint64(ts.Unix())), Pinned: proto.Uint32(1),
		Messages: []*waHistorySync.HistorySyncMsg{{Message: web, MsgOrderID: proto.Uint64(2)}, {Message: stub, MsgOrderID: proto.Uint64(1)}, {Message: pinStub, MsgOrderID: proto.Uint64(3)}, {Message: promoteStub, MsgOrderID: proto.Uint64(4)}},
	}
	dmConv := &waHistorySync.Conversation{ID: proto.String(aliceLID.String()), PnJID: proto.String(alice.String()), UnreadCount: proto.Uint32(0), LastMsgTimestamp: proto.Uint64(uint64(ts.Unix())), Archived: proto.Bool(true)}
	hs := &waHistorySync.HistorySync{
		SyncType:      waHistorySync.HistorySync_INITIAL_BOOTSTRAP.Enum(),
		Conversations: []*waHistorySync.Conversation{conv, dmConv},
		Pushnames:     []*waHistorySync.Pushname{{ID: proto.String(bob.String()), Pushname: proto.String("Bob")}},
		PhoneNumberToLidMappings: []*waHistorySync.PhoneNumberToLIDMapping{
			{PnJID: proto.String(alice.String()), LidJID: proto.String(aliceLID.String())},
			{PnJID: proto.String(bob.String()), LidJID: proto.String(bobLID.String())},
		},
	}
	convs := []json.RawMessage{}
	for _, c := range hs.Conversations {
		meta := proto.Clone(c)
		meta.ProtoReflect().Clear(meta.ProtoReflect().Descriptor().Fields().ByName("messages"))
		convs = append(convs, protoJSON(meta))
	}
	_ = enc.Encode(obj{"t": "history", "fixture": "history", "syncType": hs.GetSyncType().String(), "conversations": convs,
		"pushnames": []obj{{"jid": bob.String(), "name": "Bob"}}, "lidMappings": []obj{{"pn": alice.String(), "lid": aliceLID.String()}, {"pn": bob.String(), "lid": bobLID.String()}}})
	for i, wm := range []*waWeb.WebMessageInfo{web, stub, pinStub, promoteStub} {
		evt := &events.Message{Info: types.MessageInfo{ID: wm.GetKey().GetID(), Timestamp: time.Unix(int64(wm.GetMessageTimestamp()), 0), MessageSource: types.MessageSource{Chat: group, Sender: bobLID, IsGroup: true}}, RawMessage: wm.GetMessage()}
		if evt.RawMessage == nil {
			evt.RawMessage = &waE2E.Message{}
		}
		evt.UnwrapRaw()
		w := proto.Clone(wm)
		w.ProtoReflect().Clear(w.ProtoReflect().Descriptor().Fields().ByName("message"))
		o := b.messageEvent(evt, true, w)
		o["t"], o["fixture"] = "message", []string{"history_text", "history_stub", "history_pin", "history_promote"}[i]
		_ = enc.Encode(o)
	}
	_ = enc.Encode(obj{"t": "group", "fixture": "group", "group": groupOf(&types.GroupInfo{
		JID: group, GroupName: types.GroupName{Name: "Climbing crew"}, GroupTopic: types.GroupTopic{Topic: "Tuesdays"},
		GroupLinkedParent: types.GroupLinkedParent{LinkedParentJID: types.NewJID("120363000000000009", types.GroupServer)},
		Participants:      []types.GroupParticipant{{JID: bobLID, PhoneNumber: bob, LID: bobLID, IsAdmin: true}, {JID: me, PhoneNumber: me}},
	})})
	_ = enc.Encode(obj{"t": "group", "fixture": "community", "group": groupOf(&types.GroupInfo{
		JID: types.NewJID("120363000000000009", types.GroupServer), GroupName: types.GroupName{Name: "Neighbourhood"}, GroupParent: types.GroupParent{IsParent: true},
	})})
	_ = enc.Encode(obj{"t": "group", "fixture": "announcements", "group": groupOf(&types.GroupInfo{
		JID: types.NewJID("120363000000000010", types.GroupServer), GroupName: types.GroupName{Name: "Neighbourhood"}, GroupAnnounce: types.GroupAnnounce{IsAnnounce: true},
		GroupLinkedParent: types.GroupLinkedParent{LinkedParentJID: types.NewJID("120363000000000009", types.GroupServer)}, GroupIsDefaultSub: types.GroupIsDefaultSub{IsDefaultSubGroup: true},
	})})
	// A LID-addressed group where you are an admin under your LID, with every setting the About panel reads.
	meLID := types.NewJID("200000000000001", types.HiddenUserServer)
	_ = enc.Encode(obj{"t": "group", "fixture": "group_admin", "group": groupOf(&types.GroupInfo{
		JID: types.NewJID("120363000000000002", types.GroupServer), OwnerJID: bobLID, OwnerPN: bob,
		GroupName: types.GroupName{Name: "Book club"}, GroupTopic: types.GroupTopic{Topic: "One book a month", TopicID: "TOPIC1"},
		GroupLocked: types.GroupLocked{IsLocked: true}, GroupEphemeral: types.GroupEphemeral{IsEphemeral: true, DisappearingTimer: 7 * 86400},
		GroupMembershipApprovalMode: types.GroupMembershipApprovalMode{IsJoinApprovalRequired: true}, MemberAddMode: types.GroupMemberAddModeAllMember,
		AddressingMode: types.AddressingModeLID, GroupCreated: time.UnixMilli(1_709_337_600_000).UTC(),
		Participants: []types.GroupParticipant{
			{JID: bobLID, PhoneNumber: bob, LID: bobLID, IsAdmin: true, IsSuperAdmin: true},
			{JID: meLID, PhoneNumber: me, LID: meLID, IsAdmin: true},
			{JID: aliceLID, PhoneNumber: alice, LID: aliceLID},
		},
	})})
	// What userInfo answers: someone's About and picture id, and for a business its verified name.
	_ = enc.Encode(obj{"t": "result", "fixture": "user_info", "result": userInfoOf(types.UserInfo{Status: "Out climbing", PictureID: "1700000001", LID: aliceLID})})
	_ = enc.Encode(obj{"t": "result", "fixture": "user_info_business", "result": userInfoOf(types.UserInfo{
		Status: "Fresh bread daily", PictureID: "1700000002", LID: types.NewJID("200000000000005", types.HiddenUserServer),
		VerifiedName: &types.VerifiedName{Details: &waVnameCert.VerifiedNameCertificate_Details{VerifiedName: proto.String("Corner Bakery")}, VerifiedLevel: "high"},
	})})
	presence := []struct {
		name string
		evt  *events.ChatPresence
	}{
		{"typing_dm", &events.ChatPresence{MessageSource: types.MessageSource{Chat: alice, Sender: alice}, State: types.ChatPresenceComposing}},
		{"typing_group", &events.ChatPresence{MessageSource: types.MessageSource{Chat: group, Sender: bobLID, IsGroup: true}, State: types.ChatPresenceComposing}},
		{"recording_group", &events.ChatPresence{MessageSource: types.MessageSource{Chat: group, Sender: bobLID, IsGroup: true}, State: types.ChatPresenceComposing, Media: types.ChatPresenceMediaAudio}},
		{"paused_group", &events.ChatPresence{MessageSource: types.MessageSource{Chat: group, Sender: bobLID, IsGroup: true}, State: types.ChatPresencePaused}},
		{"typing_own", &events.ChatPresence{MessageSource: types.MessageSource{Chat: alice, Sender: me, IsFromMe: true}, State: types.ChatPresenceComposing}},
	}
	for _, p := range presence {
		o := chatPresenceOf(p.evt)
		o["t"], o["fixture"] = "chat_presence", p.name
		_ = enc.Encode(o)
	}
	// Receipts on your messages: per device of the reader (the device part is dropped), and in groups per participant.
	aliceDevice := types.JID{User: alice.User, Device: 3, Server: types.DefaultUserServer}
	rts := ts.Add(time.Hour)
	receipts := []struct {
		name string
		evt  *events.Receipt
	}{
		{"receipt_delivered", &events.Receipt{MessageSource: types.MessageSource{Chat: alice, Sender: aliceDevice}, MessageIDs: []string{"A2"}, Timestamp: rts, Type: types.ReceiptTypeDelivered}},
		{"receipt_read", &events.Receipt{MessageSource: types.MessageSource{Chat: alice, Sender: alice}, MessageIDs: []string{"A2", "SENT1"}, Timestamp: rts.Add(time.Minute), Type: types.ReceiptTypeRead}},
		{"receipt_group_read", &events.Receipt{MessageSource: types.MessageSource{Chat: group, Sender: bobLID, SenderAlt: bob, IsGroup: true, AddressingMode: types.AddressingModeLID}, MessageIDs: []string{"G3"}, Timestamp: rts.Add(2 * time.Minute), Type: types.ReceiptTypeRead}},
		{"receipt_played", &events.Receipt{MessageSource: types.MessageSource{Chat: alice, Sender: alice}, MessageIDs: []string{"A2"}, Timestamp: rts.Add(3 * time.Minute), Type: types.ReceiptTypePlayed}},
		{"receipt_own_device", &events.Receipt{MessageSource: types.MessageSource{Chat: alice, Sender: types.JID{User: me.User, Device: 2, Server: types.DefaultUserServer}, IsFromMe: true}, MessageIDs: []string{"A2"}, Timestamp: rts, Type: types.ReceiptTypeSender}},
	}
	for _, r := range receipts {
		o := b.receiptOf(r.evt)
		o["t"], o["fixture"] = "receipt", r.name
		_ = enc.Encode(o)
	}
	// Bob makes Alice an admin, then takes it back.
	bobCopy, bobPN := bobLID, bob
	for _, g := range []struct {
		name string
		evt  *events.GroupInfo
	}{
		{"group_promote", &events.GroupInfo{JID: group, Sender: &bobCopy, SenderPN: &bobPN, Timestamp: rts.Add(4 * time.Minute), Promote: []types.JID{aliceLID}}},
		{"group_demote", &events.GroupInfo{JID: group, Sender: &bobCopy, SenderPN: &bobPN, Timestamp: rts.Add(5 * time.Minute), Demote: []types.JID{aliceLID}}},
	} {
		o := b.groupChangeOf(g.evt)
		o["t"], o["fixture"] = "group_change", g.name
		_ = enc.Encode(o)
	}
	// A contact changed their About; WhatsApp pushes it.
	o := b.userAboutOf(&events.UserAbout{JID: alice, Status: "At the crag", Timestamp: rts.Add(6 * time.Minute)})
	o["t"], o["fixture"] = "user_about", "user_about"
	_ = enc.Encode(o)

	addingFixtures(enc, b, rts.Add(10*time.Minute))
}

// Adding: invite links as GetGroupInfoFromLink reads them, numbers as IsOnWhatsApp answers, and the join requests of
// the Book club (group_admin above, where you are an admin and joining asks first).
func addingFixtures(enc *json.Encoder, b *bridge, ts time.Time) {
	books := types.NewJID("120363000000000002", types.GroupServer)
	bobLID := types.NewJID("200000000000003", types.HiddenUserServer)
	carol := types.NewJID("15550000004", types.DefaultUserServer)
	carolLID := types.NewJID("200000000000004", types.HiddenUserServer)
	dave := types.NewJID("15550000006", types.DefaultUserServer)
	result := func(name string, v any) { _ = enc.Encode(obj{"t": "result", "fixture": name, "result": v}) }

	garden := &types.GroupInfo{
		JID: types.NewJID("120363000000000011", types.GroupServer), GroupName: types.GroupName{Name: "Maple garden swap"},
		GroupTopic: types.GroupTopic{Topic: "Seeds and cuttings, every other Sunday"}, ParticipantCount: 41,
		AddressingMode: types.AddressingModeLID, MemberAddMode: types.GroupMemberAddModeAdmin,
	}
	result("link_group", groupOf(garden))
	asks := *garden
	asks.JID, asks.Name, asks.ParticipantCount = types.NewJID("120363000000000012", types.GroupServer), "Quiet readers", 7
	asks.IsJoinApprovalRequired = true
	result("link_group_approval", groupOf(&asks))
	result("link_community", groupOf(&types.GroupInfo{
		JID: types.NewJID("120363000000000013", types.GroupServer), GroupName: types.GroupName{Name: "Riverside"},
		GroupTopic: types.GroupTopic{Topic: "Everything on our street"}, ParticipantCount: 230,
		GroupParent:                 types.GroupParent{IsParent: true, DefaultMembershipApprovalMode: "request_required"},
		GroupMembershipApprovalMode: types.GroupMembershipApprovalMode{IsJoinApprovalRequired: true},
	}))

	result("on_whatsapp", []obj{b.onWhatsAppOf(types.IsOnWhatsAppResponse{Query: "+15550000004", JID: carolLID, PhoneNumber: carol, IsIn: true})})
	result("on_whatsapp_business", []obj{b.onWhatsAppOf(types.IsOnWhatsAppResponse{
		Query: "+15550000005", JID: types.NewJID("15550000005", types.DefaultUserServer), IsIn: true,
		VerifiedName: &types.VerifiedName{Details: &waVnameCert.VerifiedNameCertificate_Details{VerifiedName: proto.String("Corner Bakery")}},
	})})
	result("not_on_whatsapp", []obj{b.onWhatsAppOf(types.IsOnWhatsAppResponse{Query: "+15550000008", JID: types.NewJID("15550000008", types.DefaultUserServer)})})

	result("join_requests", []obj{
		b.joinRequestOf(types.GroupParticipantRequest{JID: carolLID, RequestedAt: ts.Add(-2 * time.Hour)}),
		b.joinRequestOf(types.GroupParticipantRequest{JID: dave, RequestedAt: ts.Add(-time.Hour)}),
	})

	// Join request notifications, as whatsmeow hands them over: unknown changes of a group notification.
	request := func(tag string, user, pn types.JID, method string) *waBinary.Node {
		p := waBinary.Node{Tag: "participant", Attrs: waBinary.Attrs{"jid": user}}
		if !pn.IsEmpty() {
			p.Attrs["phone_number"] = pn
		}
		n := &waBinary.Node{Tag: tag, Attrs: waBinary.Attrs{}, Content: []waBinary.Node{p}}
		if method != "" {
			n.Attrs["request_method"] = method
		}
		return n
	}
	who := func(j types.JID) *types.JID { return &j }
	for _, f := range []struct {
		name string
		evt  *events.GroupInfo
	}{
		{"join_request_new", &events.GroupInfo{JID: books, Sender: who(carolLID), SenderPN: who(carol), Timestamp: ts, UnknownChanges: []*waBinary.Node{request("created_membership_requests", carolLID, carol, "invite_link")}}},
		{"join_request_withdrawn", &events.GroupInfo{JID: books, Sender: who(carolLID), Timestamp: ts.Add(time.Minute), UnknownChanges: []*waBinary.Node{request("revoked_membership_requests", carolLID, carol, "")}}},
		{"join_request_declined", &events.GroupInfo{JID: books, Sender: who(bobLID), Timestamp: ts.Add(2 * time.Minute), UnknownChanges: []*waBinary.Node{request("revoked_membership_requests", dave, types.EmptyJID, "")}}},
		// No participant element: the sender asked.
		{"join_request_sender", &events.GroupInfo{JID: books, Sender: who(dave), Timestamp: ts.Add(3 * time.Minute), UnknownChanges: []*waBinary.Node{{Tag: "created_membership_requests", Attrs: waBinary.Attrs{"request_method": "invite_link"}}}}},
	} {
		for _, o := range b.joinRequestsOf(f.evt) {
			o["t"], o["fixture"] = "join_request", f.name
			_ = enc.Encode(o)
		}
	}
	// Another admin let Dave in; and someone switched join approval.
	for _, g := range []struct {
		name string
		evt  *events.GroupInfo
	}{
		{"group_join_approved", &events.GroupInfo{JID: books, Sender: who(bobLID), Timestamp: ts.Add(4 * time.Minute), Join: []types.JID{dave}}},
		{"group_approval_mode", &events.GroupInfo{JID: books, Sender: who(bobLID), Timestamp: ts.Add(5 * time.Minute), MembershipApprovalMode: &types.GroupMembershipApprovalMode{IsJoinApprovalRequired: true}}},
	} {
		o := b.groupChangeOf(g.evt)
		o["t"], o["fixture"] = "group_change", g.name
		_ = enc.Encode(o)
	}
}
