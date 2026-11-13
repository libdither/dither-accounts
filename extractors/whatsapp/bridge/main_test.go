package main

// The bridge's adding rules without WhatsApp: join request notifications, the plain sentences, and that no code path
// changes anyone's membership but your own (or a requester's, by answering their request).

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

var (
	books    = types.NewJID("120363000000000002", types.GroupServer)
	bobLID   = types.NewJID("200000000000003", types.HiddenUserServer)
	carol    = types.NewJID("15550000004", types.DefaultUserServer)
	carolLID = types.NewJID("200000000000004", types.HiddenUserServer)
	dave     = types.NewJID("15550000006", types.DefaultUserServer)
)

func jidp(j types.JID) *types.JID { return &j }

func node(tag string, attrs waBinary.Attrs, kids ...waBinary.Node) *waBinary.Node {
	return &waBinary.Node{Tag: tag, Attrs: attrs, Content: kids}
}

// whatsmeow methods that change who is in a group, make one, or add people to one. The bridge calls none of them.
var forbidden = map[string]bool{
	"UpdateGroupParticipants": true, "ParticipantChangeAdd": true, "ParticipantChangeRemove": true,
	"ParticipantChangePromote": true, "ParticipantChangeDemote": true, "CreateGroup": true, "LinkGroup": true,
	"UnlinkGroup": true, "JoinGroupWithInvite": true, "LeaveGroup": true, "DangerousInternals": true,
}

func TestNeverChangesOthersMembership(t *testing.T) {
	fs := token.NewFileSet()
	used := map[string]bool{}
	for _, f := range []string{"main.go", "fixtures.go"} {
		file, err := parser.ParseFile(fs, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			if sel, ok := n.(*ast.SelectorExpr); ok && fromWhatsmeow(sel.X) {
				used[sel.Sel.Name] = true
			}
			return true
		})
	}
	for name := range used {
		if forbidden[name] {
			t.Errorf("the bridge uses whatsmeow's %s", name)
		}
	}
	// What it does use to add: your own join by link, and answers to requests to join.
	for _, name := range []string{"GetGroupInfoFromLink", "JoinGroupWithLink", "GetGroupRequestParticipants", "UpdateGroupRequestParticipants", "IsOnWhatsApp"} {
		if !used[name] {
			t.Errorf("expected the bridge to call %s", name)
		}
	}
}

// Making a group is left out on purpose (dither-chat: "Making groups from here is left out on WhatsApp"): the bridge
// never calls whatsmeow's CreateGroup or names its request, has no command for it, and never builds the IQ by hand (a
// "create" node, whatsmeow's tag for a new group, through DangerousInternals).
func TestNeverCreatesAGroup(t *testing.T) {
	fs := token.NewFileSet()
	for _, f := range []string{"main.go", "fixtures.go"} {
		file, err := parser.ParseFile(fs, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.SelectorExpr:
				if fromWhatsmeow(n.X) && (n.Sel.Name == "CreateGroup" || n.Sel.Name == "DangerousInternals") {
					t.Errorf("%s: the bridge uses whatsmeow's %s", fs.Position(n.Pos()), n.Sel.Name)
				}
				if n.Sel.Name == "ReqCreateGroup" {
					t.Errorf("%s: the bridge names whatsmeow's ReqCreateGroup", fs.Position(n.Pos()))
				}
			case *ast.BasicLit:
				if n.Kind == token.STRING {
					switch strings.Trim(n.Value, "`\"") {
					case "create", "createGroup":
						t.Errorf("%s: the bridge has the string %s", fs.Position(n.Pos()), n.Value)
					}
				}
			}
			return true
		})
	}
}

// fromWhatsmeow: whatsmeow.X, or a method of the client (cli.X, b.cli.X).
func fromWhatsmeow(x ast.Expr) bool {
	switch x := x.(type) {
	case *ast.Ident:
		return x.Name == "whatsmeow" || x.Name == "cli"
	case *ast.SelectorExpr:
		return x.Sel.Name == "cli"
	}
	return false
}

func TestJoinRequestsOf(t *testing.T) {
	b := &bridge{}
	ts := time.UnixMilli(1_760_000_000_000)
	got := b.joinRequestsOf(&events.GroupInfo{JID: books, Sender: jidp(carolLID), Timestamp: ts, UnknownChanges: []*waBinary.Node{
		node("created_membership_requests", waBinary.Attrs{"request_method": "invite_link"}, waBinary.Node{Tag: "participant", Attrs: waBinary.Attrs{"jid": carolLID, "phone_number": carol}}),
	}})
	want := obj{"group": books.String(), "user": carolLID.String(), "alt": carol.String(), "ts": ts.UnixMilli(), "method": "invite_link", "by": carolLID.String()}
	if len(got) != 1 || !same(got[0], want) {
		t.Fatalf("created: %v", got)
	}

	// Withdrawn by its sender, or declined by another admin: gone either way.
	got = b.joinRequestsOf(&events.GroupInfo{JID: books, Sender: jidp(bobLID), Timestamp: ts, UnknownChanges: []*waBinary.Node{
		node("revoked_membership_requests", waBinary.Attrs{}, waBinary.Node{Tag: "participant", Attrs: waBinary.Attrs{"jid": dave}}),
	}})
	if len(got) != 1 || got[0]["gone"] != true || got[0]["user"] != dave.String() || got[0]["by"] != bobLID.String() || got[0]["alt"] != nil {
		t.Fatalf("revoked: %v", got)
	}

	// No participant element: the sender is who asked.
	got = b.joinRequestsOf(&events.GroupInfo{JID: books, Sender: jidp(dave), Timestamp: ts, UnknownChanges: []*waBinary.Node{node("created_membership_requests", waBinary.Attrs{})}})
	if len(got) != 1 || got[0]["user"] != dave.String() || got[0]["gone"] != nil {
		t.Fatalf("sender: %v", got)
	}

	// Other unknown changes are not requests.
	if got := b.joinRequestsOf(&events.GroupInfo{JID: books, UnknownChanges: []*waBinary.Node{node("something_new", waBinary.Attrs{})}}); len(got) != 0 {
		t.Fatalf("other: %v", got)
	}
}

func TestOnlyJoinRequests(t *testing.T) {
	req := node("created_membership_requests", waBinary.Attrs{})
	if !onlyJoinRequests(&events.GroupInfo{JID: books, UnknownChanges: []*waBinary.Node{req}}) {
		t.Error("a request alone needs no group read")
	}
	if onlyJoinRequests(&events.GroupInfo{JID: books, Name: &types.GroupName{Name: "x"}, UnknownChanges: []*waBinary.Node{req}}) {
		t.Error("a rename with it is a group change")
	}
	if onlyJoinRequests(&events.GroupInfo{JID: books, Join: []types.JID{dave}, UnknownChanges: []*waBinary.Node{req}}) {
		t.Error("an add with it is a group change")
	}
	if onlyJoinRequests(&events.GroupInfo{JID: books, UnknownChanges: []*waBinary.Node{req, node("something_new", waBinary.Attrs{})}}) {
		t.Error("another unknown change is a group change")
	}
	if onlyJoinRequests(&events.GroupInfo{JID: books, Name: &types.GroupName{Name: "x"}}) {
		t.Error("no requests at all")
	}
}

func TestAddErrorSentences(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{whatsmeow.ErrInviteLinkRevoked, "This group invite link was reset or revoked"},
		{whatsmeow.ErrInviteLinkInvalid, "This group invite link is invalid"},
		{whatsmeow.ErrGroupNotFound, "WhatsApp does not know this group any more"},
		{&whatsmeow.IQError{Code: 429, Text: "rate-overlimit"}, "Try again in an hour"},
		{&whatsmeow.IQError{Code: 419, Text: "resource-limit"}, "This group is full"},
		{&whatsmeow.IQError{Code: 409, Text: "conflict"}, "in this group already"},
		{&whatsmeow.IQError{Code: 403, Text: "forbidden"}, "does not allow this account"},
		{errors.New("websocket closed"), "websocket closed"},
	} {
		if got := addError(c.err).Error(); !strings.Contains(got, c.want) {
			t.Errorf("%v: %q does not say %q", c.err, got, c.want)
		}
	}
}

func TestOnWhatsAppOf(t *testing.T) {
	b := &bridge{}
	o := b.onWhatsAppOf(types.IsOnWhatsAppResponse{Query: "+15550000004", JID: carolLID, PhoneNumber: carol, IsIn: true})
	if o["jid"] != carolLID.String() || o["pn"] != carol.String() || o["isIn"] != true {
		t.Fatalf("%v", o)
	}
	o = b.onWhatsAppOf(types.IsOnWhatsAppResponse{Query: "+15550000006", JID: dave, PhoneNumber: dave, IsIn: true})
	if _, has := o["pn"]; has {
		t.Fatalf("pn repeats the jid: %v", o)
	}
}

func same(a, b obj) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range b {
		if a[k] != v {
			return false
		}
	}
	return true
}
