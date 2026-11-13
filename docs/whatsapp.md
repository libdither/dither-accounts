# WhatsApp

`extractors/whatsapp` runs WhatsApp as a linked device, the way WhatsApp Web does. There are two parts:

- **The bridge** (`bridge/main.go`): Go, on whatsmeow. It keeps the session, turns whatsmeow's events into JSON lines, and runs one whatsmeow call per op.
- **The adapter** (`src/adapter.ts`, `src/mapping.ts`): TypeScript. It does all the mapping to dither-chat's protocol.

The adapter only does what a person in WhatsApp Web would cause. dither-chat's `docs/whatsapp.md` says why.

## Adding (dither-chat's docs/add.md)

`hello` advertises `resolve`, `join` and `requests`. It does not advertise `connect`: WhatsApp has no friend requests or follows. Adding someone there means messaging them, which goes through `openDirect`.

| Command | Bridge op | whatsmeow | What happens |
|---|---|---|---|
| `resolve` an invite (`chat.whatsapp.com/CODE`) | `groupFromLink` | `GetGroupInfoFromLink` | The read WhatsApp's own invite sheet makes. It joins nothing and tells nobody. See [Invite previews](#invite-previews). |
| `resolve` a person (`+PHONE`, `wa.me/PHONE`) | `isOnWhatsApp`, one number | `IsOnWhatsApp` | See [Phone numbers](#phone-numbers). |
| `add` with `join` or `ask` | `joinLink`, then `group` | `JoinGroupWithLink`, then `GetGroupInfo` | Your own join by a link the owner pasted, sent once and never retried. See [Joining](#joining). |
| `answer` with `accept` or `decline` | `answerJoinRequest` | `UpdateGroupRequestParticipants`, approve or reject | For that one person. The reply carries the requester's identity, and on accept also the group. `block` is refused: WhatsApp has no blocking from a join request. |
| the requests list, after connect | `joinRequests` | `GetGroupRequestParticipants` | See [Requests](#requests). |

### Invite previews

- **What it is:** `group`, or `space` for a community.
- **Fields:** the name, the description, and the member count.
- **Actions:** `join`, or `ask` when join approval is on. Ask comes with the note "The group's admins approve new members".
- **Already in it** (its chat or group read is here, or WhatsApp lists you): `joined` with the native id, no actions, and the group's picture.
- **Errors:**
  - "This group invite link was reset or revoked"
  - "This group invite link is invalid"
  - "WhatsApp does not know this group any more"
  - "This group is full"
  - a rate limit: "… Try again in an hour"

### Phone numbers

- **The lookup:** one number per lookup, never a list. There is no lookup at all when this account already knows the number: a contact, or someone in a chat or a group.
- **The preview:** `person`, with the JID as `nativeId`. Its identity fact comes before the reply. A business shows its verified name.
- **Actions and relationship:** the action is `message`; the relationship is `contact` or `stranger`.
- **Not registered:** "+PHONE is not on WhatsApp".

### Joining

- **Join approval on:** the join is a request. The result is `{ pending: true, notes: ["The group's admins approve new members"] }`. The group arrives later as any joined group does, when an admin lets you in.
- **Otherwise:** the group is read as the existing group path reads it. Its conversation fact, or a community's space fact, comes before the reply, and the reply carries its native id.
- **Approval switched on since the link was read:** the group read is refused, and the join turns out to be a request: the result is pending.
- **Already in it:** nothing is sent.
- **Rule:** the adapter decides pending from the link read: the preview the owner just saw, kept 10 minutes, or a fresh read.

### Requests

The requests are `join` requests to groups you admin.

- **At connect:** the snapshot of groups reads each group you admin that has join approval on, one query per group. The whole list goes out (`requests`), each requester's identity fact first. If any read failed, the list is not whole, so the requests found go out one by one (`request`). The hub keeps what it had.
- **Live:** whatsmeow passes join-request notifications through as unknown group changes. The bridge turns them into `join_request` events and does not read the group again for them:
  - `created_membership_requests` becomes `request`.
  - `revoked_membership_requests` becomes `requestGone`. That covers a request withdrawn and one another admin declined.
- **An add of the requester** (approved here or elsewhere) becomes `requestGone`.
- **Leaving the group, or no longer being an admin there:** each of its requests becomes `requestGone`.
- **Made an admin, or join approval switched:** that group's list is read again and compared.
- **Native ids:** `<group JID>/join/<requester's identity id>`. Each request's target is the group, or the community for a community's own group.
- **The hub reconnecting** gets the whole list again.

### Partial previews

None. WhatsApp says everything above without acting.

### Pacing in the adapter

The adapter has its own limits, kept in `state.db` so a restart does not reset them: number lookups 20 an hour, link reads 60 an hour, joins 5 a day.

- **Why:** they are the hub's limits, repeated, because any app with the chat grant may call `resolve`.
- **Past a limit:** the error says when the next one frees up.

### The enforcement rule

Adding people is what WhatsApp's enforcement watches. Nothing here adds anyone to a group. The bridge has no op that calls `UpdateGroupParticipants`, `CreateGroup`, `LinkGroup` or `JoinGroupWithInvite`. Two things are allowed:

- your own join by a link the owner pasted and clicked Join on;
- approving or rejecting a request to join that the owner clicked on.

Tests hold this:

- `bridge/main_test.go` reads the bridge's own source and fails on any of those calls.
- `bridge/main_test.go` `TestNeverCreatesAGroup` fails on `CreateGroup`, `ReqCreateGroup`, `DangerousInternals`, or a `"create"` or `"createGroup"` string in the bridge. The adapter has no `createGroup` capability and refuses the command in words ("Making groups from here is left out on WhatsApp…").
- `test/adapter.test.ts` checks there is one call site each for `joinLink` and `answerJoinRequest`, and that the adding flows send no other ops.

Nothing joins, asks or answers in the background, and nothing retries a join.

### Not built

- **Joining from an invitation message** (`groupInviteMessage`: an invite sent in a chat, not a link). Its group, code and expiry are kept on the message as `extra.waGroupInvite`, with the message's author as the inviter. That is enough for `JoinGroupWithInvite` later.
- **The group picture on a preview of a group you are not in.** It needs the invite code in the picture query.

### Only a live account shows

- **The exact join-request notifications.** whatsmeow does not parse them. Their shape comes from public client libraries: a `participant` child with `jid` and `phone_number`, and `request_method`.
- **What WhatsApp answers in some cases:**
  - a community link joined with `JoinGroupWithLink`;
  - which status codes a refused join gets (401, 403, 409, 419);
  - whether switching join approval off leaves requests waiting.

## Building and testing the bridge

- **Build:** a source change rebuilds the bridge on the next start of the account. `src/bridge.ts` caches the nix build of `bridge/package.nix` per source hash. That does not apply if `WHATSAPP_BRIDGE_BIN` or a `dither-wa-bridge` on PATH points at another binary.
- **Development:** `go build ./...` needs a C compiler that links (`nix shell nixpkgs#stdenv.cc`), since go-sqlite3 uses cgo. `CGO_ENABLED=0 go test ./...` runs the bridge's tests without one.
- **Fixtures:** `test/fixtures/events.jsonl` is `dither-wa-bridge --print-fixtures`, printed from real whatsmeow types. Print it again after changing an event's shape.
