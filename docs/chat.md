# Chat accounts

Discord, Signal, Matrix and WhatsApp accounts run here as extractors of the `chat` interface. They are dither-chat's
adapters, moved over unchanged (`extractors/<kind>`, from dither-chat's `packages/adapter-<kind>`), speaking the
same wire as before: dither-chat's adapter protocol, copied as `packages/chat-protocol` under its old name
`@dither-chat/protocol` so the adapters' imports did not change. dither-chat's hub is the app that reads them
(its `docs/accounts.md`).

| kind | extractor | what it runs |
|---|---|---|
| `discord` | `extractors/discord` | the real Discord web client in a sandbox: Xvfb, Chromium with a hook extension, x11vnc for the live view; the profile's service workers cleared before a launch whose extension worker changed (packages/browser `src/worker.ts`; Discord's own go too and come back on the next visit) |
| `signal` | `extractors/signal` | `signal-cli` as a linked device ([signal.md](signal.md): adding, requests, the quiet rule) |
| `matrix` | `extractors/matrix` | the Client-Server API with plain fetch; the Rust crypto (wasm) when encryption is on |
| `whatsapp` | `extractors/whatsapp` | a whatsmeow sidecar (`bridge/`, Go, built with nix) as a linked device; adding and join requests: [whatsapp.md](whatsapp.md) |
| `chat-fake` | `extractors/chat-fake` | a fake for tests: you and Alice in one DM |

## The `chat` interface

`packages/interfaces/src/chat.ts`. Every `AdapterCommand` is an op whose input is the command without `t` and `id`,
typed from the protocol, and every `AdapterEvent` but replies and logs is an event. Levels:

- **read**: history, search, walkMembers, reactionContext, reactors, fetchMedia, about, profile, resolve
- **write**: send, forward, openDirect, markRead, typing, react, edit, redact, call
- **manage**: configure, action (relogin, startLink, resync), add, answer, lab

`hello` and `status` are the account's own state: the manager keeps the latest of each and gives them to an app when it
connects or when a grant first lets it see the account.

## Network search and member walks

dither-chat's network search and index jobs (its `netsearch.ts` and `jobs.ts`) ask an account to search the network's
own servers (`search`, capability `search`), to list a channel's threads (`threads`, capability `listThreads`) and to
list a server's members (`walkMembers`, capability `walkMembers`). Hits come first as message facts (live=false) after
the conversations, threads and people they need, then the reply names them; a walk is a `members` event with source
`walk`, then `{ count, total?, next? }`. `history`'s reply carries `oldest`, the ts of the page's oldest message.

- **Discord** (`extractors/discord/src/search.ts`, hook.js `search`, `threads` and `walkMembers`). Checked on a live
  client with a test account (its own test server, and a large public server, as an ordinary member).
  - Search: one server (`GET /guilds/{id}/messages/search`; a server channel is its server's search narrowed by
    `channel_id`) or one DM (`GET /channels/{id}/messages/search`) through the client's REST module, with the query
    its search bar sends (`content`, `author_id`, `mentions`, `has`, `channel_id`, `min_id`/`max_id`,
    `sort_by`/`sort_order`, `offset`, `include_nsfw`), 25 a page, on the history pace. The REST module sends an array
    as repeated keys (`author_id=1&author_id=2`). The answer is `{analytics_id, messages: [[hit]],
    doing_deep_historical_index, total_results, threads, members}`; each group is the hit alone (`hit: true`),
    `threads` are the hits' threads (archived and forum posts too) and `members` your thread memberships
    (`{id: thread id, user_id, …}`), not people. A 202 (a server or DM never searched before: `{message, code,
    documents_indexed, retry_after}`) resolves, not rejects, and replies `retryAfterMs`. Not everything at once:
    Discord has no such search.
  - Threads: `GET /channels/{id}/threads/search?archived=…&sort_by=last_message_time&sort_order=desc&offset=N`, a
    text channel's or a forum's, `{threads, members, has_more, total_results}`. It is the search index too: a new
    thread is listed a minute or two later, and a 202 is `{ indexing }`, replied as `retryAfterMs`.
  - Members, by name: one gateway member query (op 8, at most 100, presences off) through the guild actions'
    `requestMembers(guildId, query, limit, presences)` (the module found by `requestMembers` + `requestMembersById`
    is Discord's guild actions), else the `GUILD_MEMBERS_REQUEST` action its gateway store sends on. Never an empty
    query (refused before any request). It matches the start of the username, display name or nick.
  - Members, recent (`recent`, from `after`): op 35 through the same module's `searchRecentMembers(guildId, {query,
    continuationToken})`, else the `GUILD_SEARCH_RECENT_MEMBERS` action: 1,000 a page in joining order, the next page
    from the page's earliest member's user id, up to the 10,000 newest. It answers an ordinary member. A full page
    replies `next`, a short one `next: null` and, within 10,000, `complete`.
  - Either answer comes as one `GUILD_MEMBERS_CHUNK_BATCH` whose chunks have `{guildId, members, notFound, nonce}`
    and no `chunk_index`/`chunk_count`; the gateway store keeps a query's nonce to itself, so a walk takes that
    server's chunks without a nonce (one with a nonce answers a by-id request) and is over at the batch. A lone
    `GUILD_MEMBERS_CHUNK` (older clients) ends it when it says it is the last, else 750 ms after; at most 5 s.
    `total` is `GuildMemberCountStore`'s count.
  - Passive `seen` members: chunks the client asked for itself (by id, for the authors on screen) go on as
    `GUILD_MEMBERS_CHUNK` dispatches, one per chunk of a batch (listening for the unbatched event alone misses
    them). A chunk a walk took, or one without a nonce for a server a walk waits on, is the walk's and not passed
    on, whichever subscriber hears it first; a by-id answer in the same batch still is.
- **Matrix** (`extractors/matrix/src/search.ts`, the adapter's `search`): `POST /search` on `content.body`, every room
  (scope `all`), a space's rooms, or one room; `in:` narrows the rooms, authors are `senders`, relevance is
  `order_by: rank`; dates are kept to after the fact. The hub's numeric offsets stand for the server's `next_batch`
  tokens, remembered per search. Encrypted rooms are not searched by the server. No member walks.

## Adding: joining, friends and requests

dither-chat's **New** box (its `docs/add.md`) asks an account to look up what was pasted (`resolve`), act on it (`add`)
and answer the requests waiting on you (`answer`, and the `requests`, `request` and `requestGone` events). The
contract is `packages/chat-protocol/src/add.ts`. An extractor says `resolve`, `join`, `connect` and `requests` in its
hello only for what it does. Every command runs once, from the owner's click; nothing retries one that may have acted.
A check the network wants (a captcha, verifying the account, a phone, a server's rules) is never answered: it comes
back as `check`, with nothing done, for the owner to do in the live view.

### Discord

All through the web client's own modules in the sandbox (`extractors/discord/src/extension/hook.js`, "adding"; the
mapping is `src/add.ts`): `InviteActions` (found by `resolveInvite` and `acceptInvite`), `InviteStore`, and
`RelationshipActions` (`sendRequest`, `addRelationship`, `removeRelationship`). The client's actions take one object
or plain arguments, and arity doesn't say which: the live `addRelationship(e, t)` declares two parameters but takes
`userId` and the rest apart from its first, while `removeRelationship(e, t, n)` is positional. So the hook reads the
function's text (`takesObject`): a first parameter taken apart by one of the object's keys gets the object, else two
or more parameters get plain arguments (going by arity, an Accept sent `PUT .../relationships/undefined`). A friend
request's asker comes with the snapshot's request list, so a request from a stranger has a name. A missing module is
"not found" in the hook report, a log line, and no capability, never a throw on load.

| Capability | Advertised when the hook found |
|---|---|
| `resolve` | `InviteActions` or `RelationshipActions` (people need only the user store) |
| `join` | `InviteActions` |
| `connect` | `RelationshipActions` |
| `requests` | `RelationshipActions` and `RelationshipStore` |
| `relationships` | `RelationshipStore` |
| `disconnect` | `RelationshipActions` (found only with its `removeRelationship`) and `RelationshipStore` |

The hello is sent again whenever the found modules change what the account can do.

| Command | On Discord |
|---|---|
| `resolve` an invite | `resolveInvite(code, 'Join Guild')`, the lookup the Join a Server dialog runs (counts and expiry). A server: name, icon, description, member and online counts, expiry, the inviter (identity fact first), notes for membership screening and a phone requirement, and `joined` with no actions when the account is in it already. A group DM invite is a `group`; a friend invite a `person` with Add friend. Not found, expired or revoked: "This invite has expired or was revoked"; banned: "You are banned from this server"; a rate limit says when it frees up. |
| `resolve` a person | The client's stores only (`UserStore`, `RelationshipStore`), no request: by user id, or by a username the client has seen. Name, avatar, relationship; Message and Add friend as they apply. Anyone else is **partial**: a username gets Add friend only (Discord says who a username is only once the request is sent), a user id Add friend and Message. |
| `add` join | `acceptInvite({ inviteKey, context })`, as the Join button, using the client's own copy of the invite when it has one. Then the server, its categories and channels as they land in the stores (facts first); the reply names the server and the invite's channel. A captcha in the refusal, or one the client puts on screen while it waits (left there for the owner): `check: 'captcha'`, nothing joined. Code 40002 / 60003: `verify`, or `phone` when Discord says phone. Membership screening (`show_verification_form`, or the member held as pending): joined, the server, and `check: 'rules'`; the rules are never agreed to. A server wanting a verified phone the account lacks: a note. Already in it: its ids, nothing sent. |
| `add` friend | By username `sendRequest({ discordTag })`, the Add Friend form; by user id `addRelationship({ userId })` (which accepts theirs if they asked first, and so can want a confirm: see below); a friend invite `acceptInvite`. `relationship: 'requested'`, `pending: true`, and the person once Discord names them in the relationship it adds. Captcha: `check: 'captcha'`. Other refusals are Discord's own sentence ("Incoming friend requests disabled."). |
| `requests` | Incoming friend requests (RelationshipStore type 3) as `kind: 'friend'`, `from` the asker (identity first), answers accept, decline, block, `nativeId` `friend:<user id>`, and `warning` when Discord flagged it (below). The whole list from the snapshot once the gateway's READY is in (CONNECTION_OPEN, or a store that already has relationships), and again when the client reloads its relationships; `RELATIONSHIP_ADD` gives `request`, `RELATIONSHIP_REMOVE` or the asker becoming a friend or blocked gives `requestGone`. No list is sent before it is known. |
| `answer` | accept `addRelationship({ userId })`, decline `removeRelationship(userId)`, block `addRelationship({ userId, type: 2 })`, as the friends list does; only for a request still waiting. The person, `requestGone`, then the relationship now. An accept can come back `confirm` instead (below). |
| `relationships` | Friends (type 1 → `friend`), blocks (2 → `blocked`) and requests you sent (4 → `requested`), each with `since` from `getSince`: everyone's identity first, then `{ t: 'relationships', list }`, at the same moment as the requests list (never an empty list for one not loaded yet), again after a reconnect to the hub and when the client reloads its relationships (`LOAD_RELATIONSHIPS_SUCCESS`). Incoming requests (3) are `requests`, not in it; implicit relationships (5) are left out. Then `relationship` on `RELATIONSHIP_ADD` / `_UPDATE` / `_REMOVE`: someone new or changed (an incoming request accepted is `friend`), and a remove `stranger`. Never the nickname you gave anyone (`getNickname`, the record's `nickname`). |
| `remove` | `removeRelationship(userId, { location: 'Friends' })`, positional, as the friends list's Remove Friend, Cancel and Unblock all call it: `friend`, `requested` and `blocked`. Only while `getRelationshipType` still says what the owner saw (friend 1, requested 4, blocked 2), else "That changed; look again" with nothing sent. `requesting` is answered, not removed; `contact` and `following` don't exist on Discord and are refused in a sentence. The reply (`relationship: 'stranger'`) once the store shows it gone, or after 3 s if Discord took it and the store has not caught up; the `relationship` event comes from the client's `RELATIONSHIP_REMOVE`. |

**Warnings.** A request waiting on you carries Discord's own flags, read from `RelationshipStore.isSpam(id)` and
`isStranger(id)`, else the record's `isSpamRequest` / `isStrangerRequest` (never the record itself): spam gives
`warning` "Discord filed this request as possible spam", a stranger (no server or friend in common) "Discord says you
share no server or friend with them; it asks you to confirm before accepting", both give both. The hook sends the flags
with the snapshot's incoming requests and with `RELATIONSHIP_ADD` / `_UPDATE` of one, and forwards
`UPDATE_STRANGER_STATUS` for a request waiting on you; a flag that changes is a `request` event with the warning now.
`isStranger` is a cache that expires, so its not saying is not Discord saying otherwise: a stranger stays one until
Discord says not.

**The confirm step.** Accepting a stranger's request without `confirm_stranger_request` is refused with code 80013,
"You must confirm the friend request to add this user." The adapter never confirms on its own and never retries: an
`answer` accept (or `add` friend by user id) without `confirm: true` that gets 80013 replies `{ confirm: <Discord's
sentence> }` with nothing done (not an error), and the request gets the stranger warning. The page shows it with
"Accept anyway", which sends the same command with `confirm: true`; only then does the call carry
`addRelationship({ userId, context, confirmStrangerRequest: true })`. A refusal even with the confirm is a plain
refusal. Decline, block and Add friend by username never carry it. A client build whose `addRelationship` takes plain
arguments has no place for the confirm, so a confirmed accept there is refused ("accept it in the live view").

Not built: Ask (servers that take applications are not handled apart: Join comes back with whatever check or refusal
Discord gives), follow and contacts (Discord has neither), and message requests (Discord's inbox for DMs from
strangers).

Everything above is tested against fakes of the client's modules (`test/hook.test.ts`, `test/add.test.ts`, and
`test/pipeline.test.ts` into dither-chat's hub store); the module shapes, the accept's captcha and screening
answers, the 80013 refusal and the confirm, the spam and stranger flags, and the analytics contexts are what the
client is known to use (read from its bundle as of November 2026), and are confirmed only on a live account.

## Making a group

dither-chat's "New group" asks one account to make a group on its own network with people it knows (the `createGroup`
command; `GROUP_RULES` in `packages/chat-protocol/src/about.ts`). An extractor says `createGroup` in its hello only
when it can. The hub has checked the name and the number of people and paced it; each extractor checks them again
before it sends anything. Each sends one call, once: a timeout is an error, never a second group. Someone refused does
not stop the rest, as long as the group is made. Identity facts go out first, then the new conversation's fact, then
the reply (`CreateGroupResult`, native ids).

| Network | The call | Who comes back how |
|---|---|---|
| Discord | the client's own `PrivateChannelActions.ensurePrivateChannel(friendIds)` in the sandbox: `POST /users/@me/channels { recipients }` through its REST client, which puts the group in the store (its own `CHANNEL_CREATE`) and resolves to the id. Then, with a name, one `PATCH /channels/{id} { name }` through the client's REST module, as `configure` renames a group DM (the client's `setName` sends the same) | friends only, 2 to 9. Someone not a friend is refused before anything is sent ("Discord adds only your friends to a group."). A refused name leaves the group made, with a note; so does a group with exactly these people already there (a new one is made, as the client does), or Discord giving that one back. Advertised only when the hook finds `ensurePrivateChannel` with the shape it relies on (`GroupDMCreate`, `isGroupMaker` in the hook) |
| Signal | signal-cli `updateGroup { name, member }` with no group id (`createGroupParams`, the only path that leaves the id out; changes to a group still go by `updateGroupParams`, which refuses that) | `added` with a profile key this device has or can fetch, else `invited` (pending); members by ACI are never looked up, so nobody is refused for not being on Signal. The answer's `groupId` names the group, read again with `listGroups`; its `results` say whom the group update reached: `UNREGISTERED_FAILURE` is `failed` ("not on Signal any more"), other failures a note (their phones learn of a group from that message). Signal's servers refusing reads only as "Failed to create group": one sentence, nothing made |
| Matrix | `POST /createRoom { preset: 'private_chat', name }`, with `m.room.encryption` in `initial_state` when the account can encrypt (as its new DMs are). Before it, `GET /profile` for each person on the account's own homeserver; then `POST /rooms/{id}/invite` for each, as `addMembers` invites | everyone `invited`. Someone the own homeserver answers `M_NOT_FOUND` for is `failed` ("… has no account on …"; continuwuity takes an invite for a local name nobody has), and with nobody left no room is made. Invites go one by one rather than in `createRoom`'s `invite` list, which fails the whole request on one refusal after the room exists; this way a refusal is that person's, in the server's words, and the room is still made. The reply waits for sync to bring the room with its name (and encryption), and the room's fact is sent again after the invites |
| Telegram | `messages.createChat { title, users }`, in the pacer's join lane, sent once (mtcute `floodSleepThreshold: 0`, `maxRetryCount: 0`) | a basic group. The answer is `messages.invitedUsers`; its `updates` go to mtcute's sequence numbers as mtcute's own `createGroup` does, and `missingInvitees` are `failed` with addMembers' sentences (privacy, Premium only); someone it has not seen is refused before. FLOOD_WAIT and PEER_FLOOD are the error, saying when; the other codes listed for `createChat` are sentences |
| WhatsApp | none | left out on purpose: no capability, the command refused in words, and `bridge/main_test.go` `TestNeverCreatesAGroup` |

Settled without a live account:

- Matrix, on the testbed (continuwuity, `extractors/matrix/testbed`): the room is made invite-only with its name,
  encrypted when the account has set up encryption and plain when not; both invites are on the server; the reply is
  `{ conversation, added: [], invited }` after the group's fact; one accepting is in the About at once (the room's
  fact names the invited and the joined alike, so it does not change); someone on another server is `failed` in the server's words with the room still made; names of 255 characters (also
  255 two- and four-byte ones) are taken, 256 refused before anything is sent; no people, only yourself, or a blank
  name refused; yourself among the people left out.
- Signal, from signal-cli 0.14.8's source (`UpdateGroupCommand`, `GroupHelper.createGroup`,
  `GroupV2Helper.buildNewGroup`, `RecipientHelper.resolveRecipient`, `SignalJsonRpcCommandHandler`,
  `JsonSendMessageResult`) and its signal-service-java 2.15.3_unofficial_153 (`GroupsV2Operations.createNewGroup`):
  the answer carries `groupId` (base64, as `listGroups`), someone without a profile key credential is pending, members
  by ACI are never looked up, a server refusal is the generic "Failed to create group", and the name may be empty
  (signal-cli sends "") though `GROUP_RULES` asks for one.
- Telegram, from mtcute 0.32.7 (`tl/index.d.ts` at layer 232, `tl/raw-errors.json`,
  `highlevel/methods/chats/create-group.js`, `network/middlewares/flood-waiter.js`): `messages.createChat` answers
  `messages.invitedUsers { updates, missingInvitees }`, each `missingInvitee` with `userId`,
  `premiumWouldAllowInvite`, `premiumRequiredForPm`; a call with `floodSleepThreshold: 0` and `maxRetryCount: 0`
  is never retried after a flood wait.

Discord, read from the web client's bundle (build 670026, release 2026-11-10; `web.*.js`):

- `ensurePrivateChannel(e)` takes one id or a list (`_getRecipients` wraps one id, keeps a list), sends one
  `POST /users/@me/channels { recipients }` (oldFormErrors, rejectWithError, no `retries`, no `X-Context-Properties`),
  makes a channel record of the answer, dispatches `CHANNEL_CREATE` with it and resolves to its id. It does not
  navigate, and it never looks for an existing DM or group first (`getOrEnsurePrivateChannel` does, for one id).
- The New Group DM picker confirms with `openPrivateChannel({ recipientIds, location: 'New Group DM' })`: the same POST
  and body, plus `X-Context-Properties` (base64 of `{"location":"New Group DM"}`) and `retries: 3` (on 502, 504, 507,
  522-524, 598, 599 or a dropped connection), then the page moves to the group; a name typed in the picker follows as
  `updateChannel` (`PATCH /channels/{id} { name }`, with its own context). The hook keeps `ensurePrivateChannel`:
  sent once, page untouched. The one difference on the wire is that header.
- Before sending, the picker looks for group DMs with exactly the same people and, if any, asks "make a new one
  anyway?". Confirmed, it makes a new one: neither call reuses a group.
- The picker's limit is 10 people with you (25 for staff, or Nitro in an experiment). It never sends someone not a
  friend: those get an invite link by DM instead. A refusal is the REST client's error (`status`, `body`); with
  oldFormErrors a 50035 body is flattened to `{ field: [sentence] }`, which the hook reads. A captcha (400 with
  `captcha_key`) is answered by the client's own interceptor: a captcha in the page, and the same request again once
  solved, so the call waits; the hook says so after it sees the captcha.

Only a live run proves, most likely to bite first:

- Signal: that Signal's servers take a new group from this linked device at all (signal-cli needs this account's own
  profile key credential; without it, or under a rate limit or a captcha, the answer is the same generic failure and
  the reason is only in signal-cli's log), and that the people's phones then show the group or the invitation.
- Discord: that the server makes a group DM for two or more friends (not a DM with the first), Discord's own words and
  codes for a non-friend, too many people (30004 is TOO_MANY_RECIPIENTS in the client's table) or a quarantined
  account, whether it minds the missing `X-Context-Properties`, and that the gateway's own `CHANNEL_CREATE` after the
  client's does not disturb anything.
- Telegram: what Telegram does when every person is in `missingInvitees` (a group with only you, or an error); that
  the updates carry the "created the group" message (mtcute itself only takes `chats[0]`); and that a createChat sent
  just before a reconnect is not made twice (MTProto re-sends an unanswered request with the same message id, which
  Telegram should drop as a duplicate).
- Matrix on Synapse or another server: their refusal sentences (the testbed's for a remote user is its federation-off
  config error), a profile endpoint that refuses lookups (403: the invite decides), names over 255 bytes, and invites
  to people on slow remote servers within the 25 s budget.
- Every network but Matrix: that the real hub has the conversation before it reads the answer (shown here with fakes).

## Adding chat accounts here

Each chat kind's manifest has `add`, so the page's Add dialog offers it:

| kind | the form | then |
|---|---|---|
| Discord | a name | its browser starts and the live view opens: sign in there once |
| Signal | a name | the pane shows the link QR from its status (`attention.qr`, refreshed by itself); **New code** runs `action refreshLink` |
| WhatsApp | a name | the QR as for Signal, or a phone number: `action pairPhone` shows a code to type on the phone |
| Matrix | homeserver (optional), user ID, password | the password goes to `secret.json` only; the extractor signs in, keeps the session and drops it. A lapsed sign-in asks for the password again (`action relogin`) |

The actions run as the page's own calls (input check, rate limit, counted as "This page"). An account added here is a
`chat` account like any other: dither-chat's hub, whose grant is `chat` on every account, shows it under its network
as soon as it appears, remote, and reads and sends through it (`scripts/verify-chat-add.ts` proves this with a
throwaway hub). Encryption and device verification for Matrix stay in dither-chat (or `action` under Try it).

While dither-chat's hub still runs accounts of its own, remove such an account in dither-chat, not here: a hub
that sees an account vanish from its list runs it itself again, which for one made here means a fresh, empty session.

## What the processes need

The manager starts each extractor as `bun extractors/<kind>/src/main.ts` from this repo's root, with its own
environment plus `DITHER_HUB_URL` (the manager's `/extractor` socket), `DITHER_ACCOUNT_ID`, `DITHER_ADAPTER_TOKEN`,
`DITHER_ACCOUNT_DIR`, `DITHER_ACCOUNT_CONFIG`, `DITHER_ACCOUNT_LABEL` and `DITHER_MARKER_KEY`. The last is what the
names a browser extension leaves in pages are made from (Discord's: the types of the events its hook and content.js
talk by, the sessionStorage key counting reloads, the key it tells translation proxies by, the microphone's groupId
during a bridge call), per install and account (`packages/browser/src/markers.ts`; what else a page can and cannot see
of the hooks: [page-traces.md](page-traces.md)); an extractor started without it makes its own each start. Everything
else they find themselves, so the manager's unit needs the same environment dither-chat's hub had:

- **PATH** with `bun` and `nix` (`/run/current-system/sw/bin`). Binaries not on PATH are built with nix on first use:
  - **Discord:** `Xvfb`, `x11vnc` and `chromium`. Chromium is also looked for in `/etc/profiles/per-user/$USER/bin`, so `USER` matters.
  - **Signal:** `signal-cli`, rebuilt weekly, with the result cached in the account directory.
  - **WhatsApp:** the bridge, cached in the account directory per source hash. An imported account keeps its cache, since the bridge sources are unchanged.
- **Optional overrides:**
  - `XVFB_BIN`, `X11VNC_BIN`, `CHROMIUM_BIN`, `SIGNAL_CLI_BIN` and `WHATSAPP_BRIDGE_BIN`.
  - For Discord: `DITHER_DISPLAY`, `DITHER_ADAPTER_WS_PORT` and `DITHER_CHROMIUM_NO_SANDBOX=1`. (Its live view has no port: x11vnc listens on `vnc.sock` in the account's directory.)
  - For Signal's socket directory: `XDG_RUNTIME_DIR`.
- **`DITHER_LAB=1`** is for dither-chat's call lab only. Never set it on the live manager.
- **Not needed here:** the hub keeps what calls need (`DITHER_DAVE_DIR`, the TURN settings). Voice still goes through the hub; the Discord live view reaches it through the manager (`liveViewPath`), which alone connects to the sandbox's VNC socket.

## One process per account

A session must never run twice: two Signal or WhatsApp processes on one store corrupt it. Two guards protect against this:

- **The lock file.** Before starting an extractor, the manager takes `<account dir>/extractor.lock` (`{ pid, owner, at }`). dither-chat's hub takes the same lock for the accounts it still runs.
- **The process check.** Both also refuse while any live adapter process carries `DITHER_ACCOUNT_ID=<id>`. That catches a hub from before the lock existed, and adapters orphaned by a crash. Only the `bun …/src/main.ts` process itself counts, not the Chromium or signal-cli it started.

A refused start is retried every 15 s, so an account comes over by itself once the other side lets go.

Matrix also has its own `adapter.pid` standby. It now treats dither-chat's copy and this one as the same adapter.

## Moving accounts in from dither-chat

```sh
bun packages/manager/src/cli.ts import-dither-chat --hub-data <your dither-chat checkout>/.data --accounts <id> [--dry-run]
bun packages/manager/src/cli.ts forget <id>      # the way back: stop it here, drop it from the registry, keep its directory
```

`import-dither-chat` registers accounts in place:

- **What it copies:** the same id, kind = the hub's adapter, the label, the config, and whether the account is enabled.
- **Where the session stays:** the directory is `<hub-data>/accounts/<id>` as it is.
- **The token:** a fresh extractor token.

It reads the hub's database read-only. It refuses:

- demo accounts;
- accounts already here;
- accounts without a session directory;
- any account a live process still runs, so stop the account in the hub first.

When the manager is running, the tool goes through its loopback-only `POST /api/accounts/import` (with the CLI's token, docs/auth.md), and the manager starts the account at once. Otherwise it writes the registry, and the account starts with the manager.

`forget` (`POST /api/accounts/forget`, also loopback-only) is the per-account rollback. Once the account is gone from the manager's list, dither-chat's hub runs it again by itself.

The rest of the CLI covers `accounts`, `apps`, `approve <request> [--level L] [--dry-run]` and `grant <app> <interface> <level> [--accounts a,b] [--kinds k,l] [--dry-run]`.

## Testing

- **Unit tests:** `bun test` in each `extractors/<kind>` runs that adapter's own tests in their new place.
  - Discord's `pipeline.test.ts` feeds the adapter's facts into dither-chat's real hub store. It needs a dither-chat checkout beside this repo (or `DITHER_CHAT_REPO`) and is skipped without one.
- **Matrix testbed:** `extractors/matrix/testbed/testbed.ts`, with its integration harnesses in `extractors/matrix/test/` (see its README). Use `DITHER_TESTBED_DIR` and `DITHER_TESTBED_PORT` so a run has its own homeserver.
- **This repo's tests:** `test/chat-import.test.ts` covers the import, the process check, forgetting an account, and the interface's types. `test/chat-add.test.ts` adds chat accounts the page's way and reads them as the hub does: a fake chat account (and the hub's `createGroup` through the manager to it), Signal on a fake signal-cli (QR, new code, linked) and WhatsApp on a fake bridge (QR, pairing code).
- **End to end:** dither-chat's `scripts/verify-accounts-matrix.ts` moves a testbed Matrix account from a hub into a manager and back. `scripts/verify-chat-add.ts` here adds Matrix (testbed), Signal and WhatsApp (fakes) on the page in headless Chromium and checks a throwaway hub sees and uses them.

## Keeping the protocol in step

`packages/chat-protocol` is a copy of dither-chat's `packages/protocol`, made at dither-chat 3598604. Until dither-chat
reads it from here, a change to the adapter wire goes into both:

```sh
diff -r <your dither-chat checkout>/packages/protocol/src packages/chat-protocol/src
```

`chat.version` changes when the wire breaks.
