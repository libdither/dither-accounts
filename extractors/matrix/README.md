# @dither-chat/adapter-matrix

The Matrix adapter: one Client-Server API session per hub account, plain `fetch`, no SDK, plus the Rust crypto library for end-to-end encryption if you turn that on.
dither-accounts runs it as `bun extractors/matrix/src/main.ts` with the `DITHER_*` environment
described in `packages/chat-protocol/src/adapter.ts`.

```
src/main.ts      entry: linkHub, one-syncer-per-account lock, orphan watchdog
src/adapter.ts   login, /sync loop, timeline -> facts, commands
src/rooms.ts     joined-room state, spaces graph, shapes, names, power levels, push-rule mutes
src/messages.ts  event content -> message kind/body/attachments, relations, mentions
src/format.ts    Matrix HTML <-> canonical Markdown (protocol MessageFact.body)
src/db.ts        private state in $DITHER_ACCOUNT_DIR/matrix.sqlite (bun:sqlite)
src/history.ts   pins, roles, read receipts and status messages for the hub's history (docs/history.md)
src/about.ts     About and settings (about, configure), inviting people to a room (addMembers), making one (createGroup)
src/add.ts       adding (dither-chat docs/add.md): resolve, join and knock, invites and knocks as requests
src/e2ee.ts      end-to-end encryption: the OlmMachine and the requests it asks for, backup, verification
src/cryptostore.ts  IndexedDB for that library under Bun, written through to crypto.sqlite
src/recovery.ts  recovery key format and Secret Storage
src/http.ts      tiny CS API client (rate limits, retries, typed errors)
testbed/         local continuwuity homeserver with users and sample traffic
test/            unit tests (bun test) and an end-to-end harness with a fake hub
```

## Account setup

Config (`DITHER_ACCOUNT_CONFIG`, non-secret): `{ "homeserver": "https://matrix.org", "userId"?: "@you:matrix.org" }`.
Without `homeserver` it is discovered from the user id's `.well-known/matrix/client`.

Secret (`$DITHER_ACCOUNT_DIR/secret.json`): `{ password?, accessToken?, deviceId?, userId?, e2ee? }`.
With only a password the adapter logs in (`m.login.password`, device name "dither-chat"), saves
`accessToken`, `deviceId` and `userId`, and drops the password. If the token is later rejected
(`M_UNKNOWN_TOKEN`, 401) the account goes to status `attention` / `login`; fix it with

```sh
bun packages/hub/src/cli.ts action <accountId> relogin '{"password":"..."}'
```

or by editing `secret.json` (re-read every 15 s while waiting). The device id is reused.

Actions: `resync` (drop the since token, full initial sync, everything re-sent as backfill),
`relogin {password}`, `status`, and for encryption `setupEncryption {recoveryKey?}`, `encryptionStatus`,
`addRecoveryKey {recoveryKey}`, `verifyDevice {step: start|accept|sas|confirm|mismatch|cancel|dismiss}`.

## How Matrix maps onto the ontology

| Matrix | dither-chat |
| --- | --- |
| room with `m.room.create` type `m.space` | `SpaceFact` kind `community`; parents from `m.space.child` (non-empty `via`, `order` -> position) and validated `m.space.parent` |
| room in `m.direct` | `direct`, participants you + peer, peer identity `contact: true` |
| only you in the room | `self` |
| child of a joined space | `channel` with `spaces` (several parents allowed) |
| public join rule or > 20 members | `channel` without spaces |
| otherwise | `group` (full member list fetched once via `/joined_members`) |
| `m.thread` relation | thread conversation `<roomId>\|<rootEventId>`, name = root text (60 chars), root gets `threadRoot` |
| members can't post (power levels) | variant `announcement` |
| push rules: override rule with no notify / room rule with no notify | native mute `none` / `mentions` |

Messages: `m.text`, `m.notice`, `m.emote`, `m.image`/`m.file`/`m.video`/`m.audio` (attachment url is the
`mxc://` URL; the hub fetches it with `fetchMedia`, authenticated media first, legacy download as fallback),
`m.sticker`, `m.location`, polls, and an `m.room.encrypted` event that cannot be decrypted as kind `encrypted` with an empty body.
`formatted_body` is converted to canonical Markdown (pills become `<@@user:server>`); a plain `body` is
used as typed, with the legacy reply fallback stripped. Edits re-emit the target with `editedTs`
(fetching the target if it is older than anything seen), redactions emit `delete` (or a tombstone plus
`delete` for messages first seen already redacted), reactions are indexed so a redacted reaction can be
removed, and backfilled messages carry a reaction snapshot from that index.

Sync: lazy-loading filter, 50-event timeline window. The initial sync is backfill (`live=false`),
incremental syncs are live, except a newly joined room's history before your join. A limited
incremental timeline (more than 50 events while the adapter was down) is closed by paging back to the
last event seen. Recent threads are discovered per room with `/threads` so a thread older than the window
still shows up. Read state: `unread_notifications` counts plus your `m.read` receipt or `m.fully_read`.
The since token, per-room back-pagination tokens and the relation indexes live in `matrix.sqlite`, so a
restart resumes where it left off.

History (docs/history.md), from what sync already brings:

| Matrix | event |
| --- | --- |
| `m.room.pinned_events` against the one it replaces | `pin` per message added or removed, `by` the sender |
| `m.room.power_levels` against the one it replaces | `role` when a member listed in either moves between Admin (100), Moderator (50), "Level N" and the default (no role): the old one taken, the new one given. v12 creators are skipped |
| others' `m.read` in `m.receipt` | `receipt` for the event named (`state: 'read'`; the hub reads it as "up to") |
| `m.presence` from people in `m.direct` | `customStatus` when `status_msg` changes; `presence` when online, unavailable (idle), busy (dnd) or offline changes |

Pins and roles come only from incremental syncs, or from your own change through `configure`: an initial sync,
or a room just joined, is how things are, with nothing before it to compare. A room known before with no
`m.room.pinned_events` had no pins. The initial sync's receipts (every receipt in each room) are
sent for direct chats, groups and self only; later ones for every room. Presence is filtered to the people
`m.direct` names (the filter's `senders`, re-uploaded when they change; someone new to it has their status fetched
once with `GET /presence/{user}/status`); your own presence stays `offline`. The last status per person is kept
in `matrix.sqlite`.

## Adding: resolve, add, answer

dither-chat's New box (its `docs/add.md`). The hello says `resolve`, `join` and `requests`. It does not say `connect`:
Matrix has no friends, follows or contacts, so for a person the only action is Message (`openDirect`). Every lookup,
join and answer comes from the owner's click on the hub's page. Nothing is joined or answered in the background, and a
join, knock, leave, invite or kick is tried once: one that timed out may have gone through. A homeserver that wants its
terms accepted first (`M_CONSENT_NOT_GIVEN`) gets the `rules` check back, with its consent link in the notes and
nothing done. It is never accepted from here.

| Command | Calls | Reply |
| --- | --- | --- |
| `resolve` a place (`#alias:server`, `!id:server`, `via` servers from a matrix.to link) | `GET /directory/room/{alias}` for the room id and its servers; then the room summary (`GET /_matrix/client/v1/room_summary/{id}?via=…`, MSC3266), else nheko's unstable `…/im.nheko.summary/rooms/{id}/summary`, else `POST /publicRooms?server=…` searched for the address and matched on the room id | name, topic, avatar (`mxc://`), member count, space or room. Join rule `public`: Join. `knock`: Ask. `restricted`: Join if this account is in an allowed room, else none. `knock_restricted`: Join if it is in an allowed room, else Ask. `invite`: none, with a note. Already in it: `joined` with its id, without asking the server. Invited: Join (accepts it). Banned or knocked already: none, with a note |
| `resolve` a person (`@user:server`) | `GET /profile/{userId}` | display name, avatar, Message; the identity fact goes first |
| `add` join | `POST /join/{roomIdOrAlias}?server_name=…` (the via servers) | waits up to 25 s for sync to bring the room, sends its space or conversation fact, then replies with its id. If sync is slower, it replies with a note and the room appears on its own |
| `add` ask | `POST /knock/{roomIdOrAlias}?server_name=…` | `pending`. The admins' answer is an invite, which shows as a request |
| `answer` an invite: accept | `POST /join/{roomId}?server_name=<the inviter's server>`; for an `is_direct` invite, the room is added to `m.direct` | as join |
| `answer` an invite: decline | `POST /rooms/{roomId}/leave` | `{}` |
| `answer` an invite: block | the leave, then `PUT` `m.ignored_user_list` with the inviter added to whoever was on it (read first) | the inviter, `blocked` |
| `answer` a knock: accept / decline | `POST /rooms/{roomId}/invite` / `POST /rooms/{roomId}/kick` with the reason "Your request to join was declined" | the knocker |

**Partial previews.** A server without the summary endpoints whose public room list does not have the room, a room the
summary hides (invite-only, or gone: Matrix answers both the same way), a profile the server shows only to people who
share a room, a server that cannot be reached, a join rule nobody knows: the name is the input, the actions are the
likely ones (Join and Ask, Join for a hidden room, Message for a person), and a note says why.

**Errors** are sentences from the server's errcode: "This room alias doesn't exist on example.org", "There is no Matrix
user @x:example.org", "Couldn't join #x:example.org: You are not invited to this room." A rate limit (`M_LIMIT_EXCEEDED`)
says when it frees up from `retry_after_ms`.

**Requests.** Invites come from sync's `rooms.invite` (stripped state): `kind: 'invite'`, from the inviter (the sender
of your `m.room.member` invite, with their name from the stripped state when the server includes it), the room or space
with its name, the invite's timestamp, and accept, decline and block (no block without a known inviter). They are kept
in `matrix.sqlite`, since sync names each invite only once. The whole list goes to the hub after the first sync of the
process and again on each reconnect. After that, `request` goes out for each new or changed invite, and `requestGone`
when the room shows up joined or left in sync (answered elsewhere, taken back, or gone) or when it is answered here. A
store that synced before invites were followed has no list, so it says nothing about the whole list. Once, after its
first sync, it runs one sync without a since token, filtered down to the invites (`INVITES_ONLY`), and only then sends
the list. If that fails, it tries again 10 minutes later and meanwhile only sends single requests.

Knocks on rooms that take them (`knock`, `knock_restricted`), where this account may invite, are requests of
`kind: 'join'` with accept, and decline where it may also kick. They come from the room state sync keeps. After the
first sync of each process, `GET /rooms/{id}/members?membership=knock` fills in knocks older than sync's window.

Not built: a knock's reason, and a reason when declining an invite. The protocol has no field for either. Block on a
knock (a ban) is not offered either. If the server says the account is in a room that sync has not brought yet, the
preview's `joined` names a conversation the hub does not have yet.

Verified against the fake homeserver in `test/add.test.ts` only. The summary endpoints, the knock and the snapshot sync
have not run against continuwuity, Synapse or a real account.

## Inviting people to a room

dither-chat's "Add people" on a room's About (the `addMembers` command, in `src/about.ts`); the hello says `addMembers`.
Every joined room except a space or a direct chat has `adding` in its About: `who: 'known'`, `mode: 'invite'` (they are
in once they accept), and `can` when this account's power level reaches the room's `invite` level (0 unless the room
sets it), else the reason "You need power level N to invite people." Matrix sets no limit on a room's size, so there is
no `room`. Spaces are left out: the hub asks for rooms.

The command checks the power levels again from the stored room state, refuses as the About would, then sends
`POST /rooms/{roomId}/invite {user_id}` for each person in turn, each tried once:

| The server | The person |
| --- | --- |
| 200 | `invited`. A stand-in `m.room.member` invite (`~invited:<user>`) is kept at once, so the room's conversation fact names them before the reply; sync's real event replaces it |
| an error (`M_FORBIDDEN` "… is banned from the room") | `failed`, with the server's `error` text; the rest go on |
| a rate limit | waited out as `retry_after_ms` asks, while the reply can still wait (25 s in all). Past that, this one and the rest fail, saying when it frees up |
| the session ended, terms to accept, no answer | this one fails with that sentence and the rest are not tried. An invite with no answer may have gone through |

Someone the stored state has as joined is `added` with no request. Anyone `/joined_members` lists afterwards (the server
said they were in already, or they accepted at once) is moved to `added`. The reply carries the About read again.

Verified against fakes only (`test/about.test.ts`, `test/add.test.ts`): no invite from here has reached continuwuity,
Synapse or a real account, so the servers' own error texts are not checked.

## Making a room

dither-chat's "New group" (the `createGroup` command, `createGroup` in `src/about.ts`); the hello says `createGroup`.
One `POST /createRoom { preset: 'private_chat', name }` (sent once, no retries; encrypted with `m.room.encryption` in
`initial_state` when the account can encrypt, as its new DMs are), then one invite each, as above. Everyone comes back
`invited`. A refused invite is that person's, and the room is still made: `createRoom`'s own `invite` list is not used,
since one refusal there fails the whole request after the room exists. The reply waits for sync to bring the room
(25 s); past that, "The room was made but has not synced yet." Verified against the fake host in `test/about.test.ts`
only.

## End-to-end encryption

Off per account until you press **Set up encryption** on the account's page (or run
`cli.ts action <id> setupEncryption '{"recoveryKey":"..."}'`). Setting up creates this device's keys and
publishes them on the account, so your other clients show a new, unverified device. There is no switch to
take that back: to undo it, set `e2ee.on` to false in `secret.json` and remove the device from another client.
While it is off, encrypted rooms show `encrypted` messages and refuse every write, and the composer says where to set it up.

**The library.** [`@matrix-org/matrix-sdk-crypto-wasm`](https://github.com/matrix-org/matrix-rust-sdk-crypto-wasm), the Rust crypto
Element uses. No Olm or Megolm is implemented here. Both candidates load under Bun on NixOS. The native
`matrix-sdk-crypto-nodejs` has a SQLite store of its own, but its API has no way to import a room key
and no verification at all, so it could never read old messages. The WebAssembly build has both and needs nothing
installed besides `bun install`, but its only persistent store is IndexedDB, which Bun does not have.
`src/cryptostore.ts` closes that gap: [`fake-indexeddb`](https://github.com/dumbmatter/fakeIndexedDB) holds the store in memory, and every
committed transaction is written synchronously to `crypto.sqlite` (0600, `synchronous = FULL`) before the
library carries on, then replayed at startup. Values are already encrypted by the library with `e2ee.storeKey` from `secret.json`.
Losing that key or `crypto.sqlite` loses the device: log in again as a new device. Cost: about 90 MB
of memory per account with encryption on, plus about 3 KB per room key, since the whole store lives in memory.

**Receiving.** To-device messages, `device_lists` and the key counts go to the library before a sync's
timelines, and the since token only moves after, so keys are not lost to a crash. Timeline, history, thread and
bundled events are decrypted as they are processed. Cleartext is what `matrix.sqlite` and the hub store, so
search works. What has no key yet stays kind `encrypted` and goes into the `utd` table by session; when a key arrives
(to-device, backup, another device) those events are re-emitted in place. Edits and reactions wait the same way, without a bubble of their own.
A plaintext edit cannot replace an encrypted message, and a plaintext message in an encrypted room gets a warning in the timeline.

**Sending.** Everything goes through `sendEvent` and `uploadFile`. In an encrypted room they share the room
key with every device of every member (invitees too, unless history is `joined`), encrypt, and send `m.room.encrypted`.
If any step fails the write fails. There is no path to plaintext, and `test/never-plaintext.test.ts` holds that
with crypto off, with it failing, and with a state event pretending encryption was turned off. Encryption stays on once a room has it.
Files upload as ciphertext, without name or type, under the `file` key. Devices are not filtered by trust, like Element's default.

**Encrypted media.** An attachment's URL is `mxc://server/id#<event id>`. `fetchMedia` takes the key from that
event, checks the hash, decrypts, and answers with the sender's media type only from a short list (no HTML or SVG on the hub's origin).

**Old messages.** The recovery key can be any of: the backup's own key, a Secret Storage key, or a Secret Storage
passphrase. It is saved in `secret.json` only after it has opened something. A key for a session
is fetched from the backup when an event needs it, one session at a time, rather than all at once: a whole backup is
huge and most of it would never be read. So everything the hub has stored, and everything you scroll back to, decrypts.
Room keys this device receives are uploaded to the same backup.

**Verification.** With a Secret Storage key, the adapter imports the cross-signing keys and signs its own device,
so it shows verified everywhere. This is the route the account page offers first: it needs no second app. A key that
does not work says why: a typo (checksum), a key or phrase that does not unlock secret storage, an account without
secret storage or backup, cross-signing keys that no longer match the account.

Otherwise, emoji verification (SAS) with another of your devices, started from either side, shows through the account's
attention card without taking the account offline, with the other device's name and the time left. After it, the other
device sends over the backup key and cross-signing keys if it has them. The library's limits shape it: a request lives
10 minutes; the emoji step 5 minutes, and it is cancelled when nothing arrives from the other device for 60 s, a check
that runs at each sync before that sync's messages are read. So:

- Messages the library hands back rather than queues (request, ready, start, accept, MAC, cancel) go through an outbox
  that retries them in order until they go out or their flow is over; queued crypto requests that fail are retried on a
  timer, not at the next sync. Both retry at once when a sync gets through.
- While a flow runs, /sync long-polls for 5 s and gives up on a silent connection after 20 s (instead of 30 s and 60 s),
  and a failed sync is retried within 2 s.
- When the other device asked, the adapter waits for it to start the emoji step rather than starting it itself a few
  seconds later: that would start the 60 s clock while the other app may be in the background. "Show emoji" starts it.
- A second request while one is open makes the library cancel both. A newer request from your devices (an app killed in
  the background and asking again) cancels the older one first, so the newer one goes ahead.
- A flow that ends without verifying stays on the card with the reason and "Start again" until dismissed.
- The flow lives in the adapter process: restarting the adapter mid-flow ends it.

Not done:

- **Other people.** No verifying other users, no marking of messages from unverified senders or devices. Only the plaintext warning above shows.
- **QR verification**, and verification requests inside a room. Emoji only, to-device only, your own devices only.
- **Creating cross-signing** or a backup, if the account has neither. Use another client for that once. It would reset what is there, so the adapter never does it.
- A late key updates the message but sends no new notification: the push for it said "Encrypted message".
- Decrypted text and media are at rest in `matrix.sqlite`, the hub's database and its media cache, protected by file modes only.

Verified: `bun test`, and `test/integration.ts` against continuwuity with two other clients built on the same library,
both directions, in full: text, replies, edits, reactions, threads, late keys, media, restart, backup, Secret Storage, SAS.
`scripts/verify-e2ee.ts` runs setup, composer, image and search through the real hub and PWA in headless Chromium, then
the recovery key (a typo, then the key: verified, backup, an old message decrypted) and emoji verification through a
page reload and 15 s without the homeserver, a repeated request, a timeout and "Start again".
`test/verify-resilience.ts` runs emoji verification behind a proxy that drops or stalls the adapter's homeserver
connection: sends that fail, a silent connection while comparing, a refused connection, a repeated request, the other
app in the background for 75 s, a timeout.
Once by hand, not in the repository: matrix-nio 0.26 (Python, its own attachment crypto, vodozemac for Olm) exchanged text, an edit, a reaction
and files both ways with the adapter through a real hub. **Never run:** Element, or matrix.org or any other real homeserver. continuwuity
lacked nothing this needs. A room key request answered by another device was not exercised.

## Local testbed homeserver

`testbed/testbed.ts` runs [continuwuity](https://continuwuity.org) from nixpkgs on `127.0.0.1:6167`
(server name `dither.test`, federation off, registration by token) and seeds it. All state, including
the generated passwords and the registration token, is in `.data/matrix-testbed/` (gitignored):
`testbed.json` (credentials, room ids), `db/`, `server.log`, `server.pid`, `continuwuity.toml`.

```sh
bun extractors/matrix/testbed/testbed.ts up        # start if needed, seed what's missing, print status
bun extractors/matrix/testbed/testbed.ts start     # just (re)start the homeserver; data is kept
bun extractors/matrix/testbed/testbed.ts stop
bun extractors/matrix/testbed/testbed.ts status    # pid, rooms, and the hub "add" command with quinn's password
bun extractors/matrix/testbed/testbed.ts chatter --every 15          # alice/bob post every 15 s (Ctrl-C)
bun extractors/matrix/testbed/testbed.ts chatter --every 3 --count 5 --room general
bun extractors/matrix/testbed/testbed.ts say alice dm "hello"        # one message (rooms by key, see status)
bun extractors/matrix/testbed/testbed.ts tail general 20             # what the homeserver has
bun extractors/matrix/testbed/testbed.ts reset --yes                 # delete everything
```

Every command is idempotent: seeding runs in steps that are recorded in `testbed.json`, and `up` on a
running server only fills in what is missing. The binary is found via `$CONTINUWUITY_BIN`, `conduwuit`
on `PATH` (the repo's dev shell has it), or `nix build nixpkgs#matrix-continuwuity`.

What gets seeded (users `@quinn`, `@alice`, `@bob`, `@carol` on `dither.test`; quinn is the account
for the hub):

- space **Dither Testbed** (with an icon) > `#general`, `#dev`, `#announcements` (only moderators can post),
  `#archive` (120 messages for scrollback), and the subspace **Off-topic** > `#memes`, `#crossposts`
- space **Rust Friends** > `#crossposts`, so `#crossposts` has two parents
- a DM quinn <-> alice, marked in `m.direct` on both sides (with a text file)
- private unencrypted group **Weekend plans** (quinn, bob, carol), **Notes to self** (quinn only),
  public **Lobby** outside any space, and **Secret plans** (encrypted, one event nothing can decrypt)
- in `#general`: a reply with a legacy fallback, an edit, reactions, a redacted reaction, a redacted
  message, formatting, an emote, an image upload, and a message that mentions quinn
- in `#dev`: a thread with fallback and genuine in-thread replies, a notice, a reaction
- in `#archive`: a reaction, an edit and a thread reply posted late against early messages

To point a hub at it:

```sh
bun packages/hub/src/main.ts --data /tmp/dither-matrix-test --port 8481
bun extractors/matrix/testbed/testbed.ts status     # prints the matching "cli.ts add matrix ..." line
```

## Tests

```sh
bun test extractors/matrix                      # format, crypto store, recovery keys, never-plaintext
bun extractors/matrix/test/integration.ts       # needs the testbed: real adapter + fake hub, every command, encryption
bun extractors/matrix/test/verify-resilience.ts # needs the testbed: verification over a connection that drops
bun scripts/verify-e2ee.ts                            # needs the testbed: encryption through a real hub and the PWA in Chromium
bunx tsc -p extractors/matrix --noEmit
```

The integration harness logs in as a fresh quinn device (logged out again at the end) and writes its
test messages to "Notes to self" and the `#dev` thread, redacting them afterwards. Its encryption half
(`test/integration-e2ee.ts`) makes a new encrypted room each run and leaves it again, and replaces quinn's cross-signing keys and backup on the testbed.

## Not done yet

- State changes (joins, renames) are not rendered as system messages.
- Typing notifications and presence, outgoing (no protocol commands for them).
