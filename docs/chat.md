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
| `t3` | `extractors/t3` | T3 Code's coding threads on this machine, through its shell stream, MCP endpoint and command line ([t3.md](t3.md)): no adapter in dither-chat |
| `chat-fake` | `extractors/chat-fake` | a fake for tests: you and Alice in one DM |

## The `chat` interface

`packages/interfaces/src/chat.ts`. Every `AdapterCommand` is an op whose input is the command without `t` and `id`,
typed from the protocol, and every `AdapterEvent` but replies and logs is an event. Levels:

- **read**: history, search, walkMembers, reactionContext, reactors, fetchMedia, about, profile, resolve
- **write**: send, forward, openDirect, markRead, typing, react, edit, redact, call, declineCall
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

Not built: Ask as its own action (a server that takes applications still comes back from Join with `check: 'rules'`;
the application itself is then answered from the server's page, "Servers" below), follow and contacts (Discord has
neither). Message requests and spam DMs are in "Attention" below.

Everything above is tested against fakes of the client's modules (`test/hook.test.ts`, `test/add.test.ts`, and
`test/pipeline.test.ts` into dither-chat's hub store); the module shapes, the accept's captcha and screening
answers, the 80013 refusal and the confirm, the spam and stranger flags, and the analytics contexts are what the
client is known to use (read from its bundle as of November 2026), and are confirmed only on a live account.

## The account itself (Discord)

What Discord says of the account and its person-level actions, for dither-chat's docs/account-self.md
(`extractors/discord/src/self.ts`, hook.js "your own self", `test/self.test.ts`). Everything is read from the client's
own stores as they change, and written the way its own settings pages and buttons write it; nothing polls.

| Capability | Advertised when the hook found |
|---|---|
| `block`, `ignore` | `RelationshipActions` and `RelationshipStore` |
| `contactNotes`, `sessions` | `Rest` |
| `setPresence` | `SettingsActions` (the settings proto's action creator, by its `ProtoClass.typeName`) and `UserSettingsProtoStore` |

| Event or command | On Discord |
|---|---|
| `notices` | `UserRequiredActionStore.getAction()` (the gateway's required action: verify email or phone, a captcha, `AGREEMENTS`, `REQUIRE_SAFETY_FLOWS`) and, once the client has read it itself, `SafetyHubStore.getAccountStanding()` (limited, very limited, at risk, suspended), each in plain words with the live view. Sent at subscribe and on `USER_REQUIRED_ACTION_UPDATE` / `SAFETY_HUB_FETCH_SUCCESS`, the whole list each time; never done here. |
| `selfState` | `UserSettingsProtoStore.settings` (status, custom status and when they end; privacy: DMs from server members, message requests) and `getGuildFolders()`, on `USER_SETTINGS_PROTO_UPDATE`. Your age check (`ageVerificationStatus` on your user) is a privacy line. Only parts that changed are sent. |
| `ignored` | Everyone `RelationshipStore.isIgnored(id)` says, after each relationship change or `RELATIONSHIP_IGNORE_USER_SUCCESS`. |
| `block` | The shared command (as Signal's): a person only. Block is `addRelationship({ userId, context, type: 2 })`, as the Block button; `unblock` is `removeRelationship` as the friends list's Unblock (`friendRemove` type 2). Reply `{ blocked }`, relationship events as for `remove`. A group is refused in words. |
| `ignore` | `ignoreUser(id, location)` / `unignoreUser`, as the Ignore button. Those show a toast on failure and say nothing else, so the store decides: an ignore must be in it when the call returns, an unignore within 5 s. |
| `contactNotes` | Your note on someone, as Signal's: read with a profile only (`NoteStore`, else the `GET /users/@me/notes/{id}` the client's profile makes, then `USER_NOTE_UPDATE` into the store as the client does), sent as an identity fact `{ nativeId, note }` ('' when none; nothing when the read failed for another reason than 404, so a note is never taken for cleared). `setContact` with `note` is `PUT /users/@me/notes/{id}` `{ note }` (256 characters, checked first), then the identity fact again. Never for yourself. A `nickname` is left alone: dither neither reads nor writes Discord's friend nicknames. |
| `setPresence` | `SettingsActions.updateAsync('status', draft => ..., 0)` as the status picker: `status`, `statusExpiresAtMs`, `customStatus` (text, emoji name, expiry), made with the proto's own message types read from `ProtoClass.fields`. A server's own emoji cannot be named in text and is refused. |
| `sessions` | `GET /auth/sessions` as the Devices page, the sandbox's own marked by `AuthenticationStore.getAuthSessionIdHash()`. Signing others out asks for the password: the live view. |
| `setProfile` beyond the bio | Your own profile lists `editable`: `bio`, `name`, `avatar`, `pronouns`, `banner`, `accent`. `PATCH /users/@me` (`global_name` from `name`, `avatar` as a data URL) and `PATCH /users/@me/profile` (`bio`, `pronouns`, `banner`, `accent_color`), as the profile settings. `emoji` and `username` are refused in words. A banner without Nitro is Discord's refusal, passed on. |
| `profile` | Also badges (`getUserProfile().badges`), theme colours, the avatar decoration's asset, and your note (above). |

Untested against a live account: shapes are from the client's code (build of 2026-11-12) and the fakes in
`test/self.test.ts`.

## Attention: mentions, requests, notification settings, read states

What Discord knows about what needs the owner, beyond messages as they come (`extractors/discord/src/attention.ts`,
the hook's "attention" section; dither-chat's docs/notifications.md "From the network itself" and
docs/research/discord-gaps.md). Each through the client's own modules as a click would, read from build 671535
(2026-11-12):

| What | How | Capability |
|---|---|---|
| Mentions in channels the client never loaded | `RecentMentionsActions.fetchRecentMentions({ limit: 25, roles: true, everyone: true })`, as the Inbox's Mentions tab; its answer is heard as `LOAD_RECENT_MENTIONS_SUCCESS` (whoever asked, the owner in the live view too). Without the module, the same `GET /users/@me/mentions` through the REST helper. Asked 45 s after a snapshot (start, reconnect) and when a notification-center mention item comes without its message, on the history pace, never more often than every 5 minutes (`MentionsPacer`). Each hit once, as a message fact with `live: false, late: true`, `mentionsSelf`, and `mentionsAll` unless it names the owner; a thread nobody opened first, from the client's channel store | `mentions` |
| Notification center | `NOTIFICATION_CENTER_ITEM_CREATE`: a `recent_mention` or `reply_mention` item with its message is a late mention at once; without, it asks the list. `REACTION_NOTIFICATION_SENT` (someone reacted to your message) is a `reaction` fact. Other items (friend accepted, events starting) are left: the relationships say the first, and the hub has no Discord events | — |
| Message requests and spam DMs | A DM's `isMessageRequest`, `isMessageRequestTimestamp` and `isSpam` (picked with the channel): a `request` of kind `message` about its conversation, `nativeId` `message:<channel id>`, from the other person, answers accept, decline, block; spam ones `spam: true` and a warning. Gone when the flags clear (`CHANNEL_UPDATES`), the DM closes, or `MESSAGE_REQUEST_ACCEPT_OPTIMISTIC`. The snapshot's DMs are all of them, so one not there is gone. They ride in every `requests` list beside the friend requests (`withMessageRequests`). Answering: the client's request module when its lazy chunk is loaded (`MessageRequestActions`, found by its source), else the same calls through the REST helper: accept `PUT /channels/{id}/recipients/@me {consent_status: 2}` then `MESSAGE_REQUEST_ACCEPT_OPTIMISTIC`, decline `PUT /channels/recipients/@me/batch-reject`, block the friends module's block then decline | `requests` |
| Notification settings as they change | `USER_GUILD_SETTINGS_FULL_UPDATE`, `_GUILD_UPDATE`, `_CHANNEL_UPDATE`, `_CHANNEL_UPDATE_BULK`, `_GUILD_AND_CHANNELS_UPDATE`, `CHANNEL_MUTE_EXPIRED`, `GUILD_MUTE_EXPIRED`: the server's (or the DMs') settings as the store has them after, with its channels; the adapter sends the fact of each place whose mute changed since the snapshot, `mute: {}` where one was cleared. A server's mute carries `suppressEveryone` and `suppressRoles`; any mute set with Discord's Mute carries `muted: true` | — |
| Mute with a timer | `NotificationSettingsActions.updateGuildNotificationSettings(guildId, settings)` for a server, `updateChannelOverrideSettings({ guildId, channelId, settings })` for a category, channel or DM (guild null), as its menus; `settings` `{ muted: true, mute_config: { selected_time_window: seconds or -1, end_time } }` or `{ muted: false }`. The reply is the target's mute as the store then has it | `mute` |
| Mark unread | `POST /channels/{c}/messages/{m}/ack {manual: true, mention_count: 0}` for the message before the first unread, through the REST helper. The gateway's `MESSAGE_ACK` with `manual` (from any app) is a `read` with `manual` | `markUnread` |
| Many read | The client's own `BULK_ACK` action (`context: 'APP'`), which acks them locally and posts 100 at a time to `/read-states/ack-bulk`; up to 50 a command | `markReadMany` |

Not built: thread notification settings, account-wide notification settings, safety warnings in DMs, the ICYMI feed
(Discord's ranking; dither has its own), notification center acks. Everything here is tested against fakes
(`test/attention.test.ts`, `test/hook-attention.test.ts`, and `test/attention-pipeline.test.ts` into dither-chat's hub
store) and has not run on a live client.

## Servers: events, leaving, links, nicknames, rules

dither-chat's docs/servers.md is the hub's side. The Discord extractor's is `src/servers.ts` (mapping and the commands
on the adapter's paces) and hook.js's "servers" section (the client's own stores and actions). Capabilities, each
only when the hook found the module behind it (`serverCapabilities`): `events` (GuildScheduledEventStore), `rsvp`
(and the events module), `leave` (the server module's `leaveGuild`), `gates` (membership screening's
`fetchVerificationForm`/`submitVerificationForm`, or onboarding's store and actions), `inviteLinks` (the invite module
and REST), `nick` (`changeNickname` and the member store).

| What | How |
|---|---|
| Events, passively | After the snapshot and when a server is joined (`GUILD_CREATE`): every server's events from the store, no request, as `scheduledEvents`. `GUILD_SCHEDULED_EVENT_CREATE/UPDATE/DELETE`, `…_USER_ADD/REMOVE` and `…_EXCEPTION_*` pass on as the event as the store now has it (`scheduledEvent`, `scheduledEventGone`): the count moves, only your own answer is said, never who else answered. Recurrence as an RRULE; an exception's original start is its snowflake. |
| `scheduledEvents` | What opening the server's events list does: `getGuildEventsForCurrentUser` once per server (your answers), then `fetchGuildEventUserCounts` per event. On the look pace. |
| `rsvp` | `createRsvpForGuildEvent` / `deleteRsvpForGuildEvent`, as the Interested button. One occurrence gets an answer of its own only where it differs from the series' (as the client keeps them). |
| `leave` | Refused before anything when the account owns the server ("You own this server: …"). Else `leaveGuild`, as the Leave Server confirm; then a leave for each of its categories and channels and for the server. A group DM or a DM: "Threads, forums and group DMs" below. |
| About of a server | `serverAbout` from the stores (owner, your nickname, vanity code, where a new link leads): `leaving`, `nick`, `invite` with `links`, `vanity` and Discord's dialog choices (`DISCORD_INVITE_OPTIONS`: 7 days and no limit by default). Someone who may manage the server gets every link, as the settings' Invites tab loads them (one GET of `/guilds/{id}/invites` per About read); anyone else sees the links this session made. |
| `configure` invite | create: `createInvite(channel, {max_age, max_uses, temporary})` on the rules channel, else the system channel, else the first text channel you may invite to; only the choices Discord's dialog offers. revoke: `revokeInvite`, for a link you made or with Manage Server. |
| `setNick` | `changeNickname(guild, null, '@me', nick)`, as the Change Nickname dialog; refused without the permission. |
| `gate` | A pending member: the screening form as the client fetches it to show it (`fetchVerificationForm`); rules alone are `rules`, questions make it `apply`. Else, a server with onboarding the member has not finished: the client's onboarding fetch and its prompts. Else null. |
| `answerGate` | Checked against the gate as it stands (`gateAnswerProblem`), then `submitVerificationForm` with the TERMS field ticked only when the owner's answer says `agree: true` (the hook refuses it too), or `selectOption` per pick, `completeOnboarding` and `finishOnboarding`. An application submitted waits: `gate` events carry its outcome (`GUILD_JOIN_REQUEST_UPDATE` for your own request only). |

Tested against fakes of the client's modules (`test/servers.test.ts`); the module shapes and payloads are read from the
client's bundle (2026-11-12) and are not confirmed on a live account.

## Threads, forums and group DMs

dither-chat's docs/threads.md is the hub's side. The Discord extractor's is `src/threads.ts` (mapping, the About parts
and the commands on the adapter's paces) and hook.js's "threads" section. Capabilities (`threadCapabilities`), each
only when the hook found what it needs: `followThreads` (JoinedThreadsStore and the thread actions), `threadState` (the
thread actions), and with the REST client `createThreads`, `forumPosts`, `myThreads`, `crosspost`, `removeMembers`,
`transferOwner`, `groupPicture` and `leave` (for group DMs and DMs).

| What | How |
|---|---|
| Membership, passively | Every channel the hook picks carries this account's membership of a thread (`member`: flags, mute, its end; null when not in it) from JoinedThreadsStore, a post's tags, a thread's start and message count, a forum's tags, default order and layout. The snapshot's threads are the ones the account is in. `THREAD_MEMBER_UPDATE` and `THREAD_MEMBERS_UPDATE` pass on only when they are about this account (never anyone else: no member lists), as the thread now stands. The conversation fact carries `thread` and `forum`, and a thread's membership as its native mute: not in it, mentions only; in it, its own setting (`ALL_MESSAGES` 2, `ONLY_MENTIONS` 4, `NO_MESSAGES` 8) or none (as its channel), and its mute. A channel override's mute (attention.ts) wins. |
| Posts loaded, passively | `LOAD_FORUM_POSTS`, `LOAD_THREADS_SUCCESS` and `LOAD_ARCHIVED_THREADS_SUCCESS` (when the client's own forum view or thread browser loaded them) pass on their threads and first messages. |
| `threads` | As before (`/threads/search`, now with each page's first and latest messages, and `ids`). With `mine`: `/channels/{id}/users/@me/threads/archived/private`, the thread browser's Private tab, paged by the last archive time. |
| `followThread` | Join: the request Join Thread makes (`POST /thread-members/@me`, location "Thread Browser") through the REST helper, since the client's own `joinThread` turns a refusal into a dialog; then the store must list the account. Leave: the client's `leaveThread`. |
| `threadNotify` | The bell menu's `setNotificationSettings(channel, {flags} or {muted, mute_config})`, which joins first where it must; the flags keep `HAS_INTERACTED`. |
| `threadState` | Checked against a fresh About (`AboutThread`: who started it may archive while it is open, Manage Threads may do all). Then `lockThread`, `unlockThread`, `archiveThread`, `unarchiveThread`, the client's own. |
| `createThread` | The body the client's thread form posts (name, type 10/11/12, the parent's auto-archive), to `/messages/{id}/threads` or `/threads`; then its first message, if any, as an ordinary send. |
| `createPost` | Checked by `postProblem` against the forum's tags; files uploaded as a send's are; then the New Post body to `/threads?use_nested_fields=true` (name, auto-archive, `applied_tags`, the first message). |
| `crosspost` | The Publish request (`/messages/{id}/crosspost`) through the REST helper (the client's own swallows a refusal into a dialog). A message already published carries the `published` mark (`CROSSPOSTED`). |
| `leave` (a conversation) | A group DM: `DELETE /channels/{id}` with `silent` as Leave Group sends it, then a leave event. A DM: the same request, Close DM; no leave event, since Discord only hides it. A channel or thread: refused. |
| `removeMember`, `setOwner` | Checked against a fresh About (`AboutOwnership`: only the owner, only someone in it), then the private channel actions' `removeRecipient` / `setDMOwner`. |
| `setPicture` | A PNG, JPEG, GIF or WebP from the spool, at most 8 MB, as a data URL in `PATCH /channels/{id} {icon}`, as Change Icon sends it; null removes it. |
| Newer channel types | 17 lobby as a group, 18 game DM as a DM, 19 media post as a thread, 20 and 21 as channels (map.ts). |

Tested against a replica of the client (`test/hook-threads.test.ts`) and the mapping (`test/threads.test.ts`); the
module shapes and payloads are read from the client's bundle (build 671535, 2026-11-12) and are not confirmed on a
live account.

## Moderating: members, others' messages, labels (Discord, Signal)

dither-chat's docs/moderation.md is the hub's side. Capability `moderate` (both), `memberLabels` (Signal), `setPicture`
(both), and `leave` on Signal. The commands: `moderate` (`ModAction`: remove, ban, unban, admin, role, timeout, end),
`bans`, `setLabel`, `clearReactions`, and `redact` with `moderator`. The About carries `moderation` (each power with
why not), `members.list[].mod` (`above` when they outrank you, roles held, timeout) and `label`; the reaction context
carries `moderation` for others' messages. Each is one click on the hub, re-checked here against the same read.

| What | Discord (`src/moderation.ts`, hook.js "moderation") | Signal (`src/groups.ts`) |
|---|---|---|
| Powers | `PermissionStore.can` for Kick, Ban, Timeout Members and Manage Roles on the server; per loaded member `canManageUser` (hierarchy); roles below your top role (`getHighestRole`), never @everyone or managed ones. Fails closed | admins of the group (`members[].isAdmin`), not once it is ended |
| Remove | the moderation module's `kickUser`, else `DELETE /guilds/{g}/members/{u}` | `updateGroup removeMember` |
| Ban, unban | `banUser(g, u, delete_message_seconds)` with the ban dialog's choices, `unbanUser`; else `PUT`/`DELETE /guilds/{g}/bans/{u}`. The Bans list: one `GET /guilds/{g}/bans?limit=1000` on a click | `updateGroup ban` / `unban`; the banned from `listGroups.banned` |
| Admins | (roles instead) | `updateGroup admin` / `removeAdmin` |
| Roles | `GuildActions.updateMemberRoles(g, u, roles, added, removed)` with the whole list, as the member menu; else `PATCH` the member's `roles` | — |
| Timeout | `setCommunicationDisabledUntil` with an ISO end (null ends it), the client's durations; else `PATCH communication_disabled_until` | — |
| End a group | — | `terminateGroup` |
| Join requests | — | `requestingMembers` of groups you admin as requests `join:<group>:<aci>` (kind `join`); accept `updateGroup member`, decline `removeMember` |
| Others' messages | Manage Messages (`reactionContext.manageMessages`): `MessageActions.deleteMessage`; reactions: `DELETE …/reactions`, `…/reactions/{emoji}`, `…/reactions/{emoji}/0/{user}`, then `reactionsCleared` or a reaction removal | an admin's `sendAdminDelete`; nobody removes others' reactions |
| Label | — | `updateGroup memberLabel`, then `memberLabelEmoji` (one field per call) |
| Picture | a server icon: the hub's `file://` path read into a data URI, `PATCH /guilds/{g} {icon}`. A group DM's: not here | `updateGroup avatar <path>` |
| Settings | server `description` (Community), channel `default_auto_archive_duration`, `user_limit`, `bitrate` (up to the boost tier's ceiling) | link approval: `updateGroup link enabled-with-approval` / `enabled` (written, never read) |
| Leave | (servers) | `quitGroup` with `admin` as its only admin, `delete` only when asked; no `leave` event, the group stays read-only |

Not built: Discord's audit log, AutoMod, pruning, emoji/sticker/soundboard management, integrations, moderator reports,
raid actions, role member lists. Tested against fakes of the client's modules (`test/moderation.test.ts`,
`test/hook-moderation.test.ts`) and a fake signal-cli (`test/adapter.test.ts`, "groups admin"); nothing live.

## Rich messages (Discord)

What a Discord message carries beyond its text, files and plain embeds reaches the hub as dither-chat's protocol has
it (`chat-protocol/src/rich.ts`; dither-chat `docs/rich-messages.md`). `extractors/discord/src/rich.ts` does the
mapping; `hook.js` whitelists it from the gateway's raw object or the client's own record (camelCase) alike:

- Message flags: sent silently (`MessageFact.silent`, so the hub never alerts on it), ephemeral, previews hidden,
  crosspost (its webhook's name says "Server #channel"; its reference is not a reply), the server's own, a suspended
  author.
- Components: a bot's buttons and selects as rows with their custom ids and the message's `application`, which the
  `interact` command presses (next section). Components V2 messages, which have no content and no embeds, are
  flattened into the body and attachments.
- Roles: `mention_roles`, and the roles a message names with their names and colours from the client's role store.
  Your own roles in each server come from the client's member store, for you only (the snapshot's `selfRoles`, a
  joined server's `self_roles`, GUILD_MEMBER_UPDATE of you), and a ping to one of them is `mentionsSelf`.
- Attachments' alt text, spoiler and explicit flags, a voice message's length and waveform; embeds' colour, footer,
  timestamp, author icon and video (Discord's proxies preferred; a YouTube, Twitch or Vimeo player page is passed as
  a player, loaded by the app only when clicked).
- `interaction_metadata` ("X used /cmd"), `activity` and `application` (activity invites).
- MESSAGE_DELETE_BULK deletes each message; MESSAGE_REACTION_ADD_MANY adds each reaction (poll votes left out).
- A send AutoMod blocks (codes 200000 and 200001) answers "This server's AutoMod blocked it: …".
- System types 13 to 17, 22, 25 to 41, 45, 64, 66 and Discord's notices have words of their own.

Tested against hand-written raw and record shapes (`test/rich.test.ts`, `test/hook.test.ts`), one test into
dither-chat's hub store. The record shapes were read from the client's bundle (2026-11-12), not seen on a live account.

## Bots and apps (Discord)

Pressing a bot's buttons, choosing in its selects, its slash commands with their suggestions, apps' message commands,
and the forms (modals) bots open in answer (dither-chat `docs/apps.md`; protocol `chat-protocol/src/apps.ts`).
`extractors/discord/src/interact.ts` maps; hook.js's "bots and apps" section runs each through the client's own code,
read from build 671535:

| What | The client's own | Capability |
|---|---|---|
| Press, choose | `executeMessageComponentInteraction` (its nonce, session, the message's flags, the application id; it refuses a second press while one waits) | `interactComponents` |
| Commands listed | `ApplicationCommandIndexStore.query` with `allowFetch`, as typing `/` runs it: each place's index loaded once, its permission checks, built-ins left out | `interactCommands`, `interactContext` (message commands) |
| Run, suggestions | `executeCommand`, with an autocomplete context for suggestions (the gateway's APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE to its nonce answers) | `interactCommands` |
| A form | the client sends forms only from inside its dialog, so the hook does what the dialog does: `queueInteraction`, a snowflake nonce, the session id, its REST helper with the dialog's body, its failure action on a refusal | `interactModals` |

Outcomes (`interaction` events: sending, answered, failed, timedOut, modal) come from INTERACTION_SUCCESS and
_FAILURE, INTERACTION_MODAL_CREATE and a MESSAGE_CREATE carrying the nonce, for the hook's own nonces only; nothing
back in 15 s is a timeout. A form a bot opens comes up as an `appModal` event. A message the client no longer holds is
read once around it (GET messages `around`, as jumping to it reads it). None of it is paced behind other work (a click
goes when it is made) and none is retried. User commands, files in options and forms, and app-page (iframe) forms are
not built.

The client's local notices (Clyde, author `1`, flagged ephemeral: a failed send or interaction said on that screen
only) are no longer passed on as messages (`ingest.ts`).

Tested against a replica of the client's modules (`test/hook-interact.test.ts`) and pure mapping tests
(`test/interact.test.ts`); not run on a live account.

## Polls and pins

dither-chat's docs/polls.md has the model; protocol `poll.ts` has the shapes (`pollUpdate`, `pollVote`, `pollCreate`,
`pollEnd`, and the capabilities `polls`, `pollVote`, `pollCreate`, `pollEnd`, `pin`). Nothing here has run against a
real account; the tests use the hook replica (`extractors/discord/test/hook-polls.test.ts`) and the fake signal-cli.

**Discord** (`extractors/discord/src/polls.ts`, the hook's "polls and pins" section):
- A poll is picked from the gateway's object (its `results`) or from the client's record, where votes are reactions
  of their own kind (`count_details.vote`, `me_vote`). It comes on its message as `extra.poll`.
- A vote is a reaction of the vote kind (type 2), which the client turns `MESSAGE_POLL_VOTE_ADD`/`REMOVE` and the
  batched form into. The hook sends it with the poll as the client then counts it, when it has the message loaded:
  the counts go out whole. Otherwise the vote moves its answer by one. Your own vote is said when you make it (the
  hub moves the counts), so an echo of it without counts is not counted again. A vote is never a reaction.
  `POLL_RESULT` (type 46) closes the poll it points at.
- Who voted is never asked for (`POLL_ANSWER_VOTERS`). The client asks only when someone clicks a count.
- Voting and End Now go through the client's poll actions module, found by the requests its code makes
  (`POLL_ANSWERS` with `answer_ids`, `POLL_EXPIRE`). That module is in a lazy chunk, so without it the same request
  goes through its REST helper. A poll is made with `MessageActions.sendPollMessage` (the Create Poll dialog's call),
  with the durations the dialog offers.
- Pin and unpin are the pin button's request (`PUT`/`DELETE /channels/{c}/messages/pins/{m}`) through the REST
  helper. The client's own `pinMessage` shows a refusal as a dialog in the page and resolves either way, so it could
  not report one. An archived thread is refused first.
- A channel's pinned list is read when its About is opened (`pinnedList`): the pages the pins popout loads (25
  each, up to 4), then `CHANNEL_PINS_ACK`, as the popout does. It is kept a minute. The pinned messages go out as
  facts with a pin each at its time, and the About's `pinned` is `complete` when Discord said there were no more.
  Who may pin: anyone in a DM or group DM; elsewhere, Pin Messages or Manage Messages.

**Signal** (docs/signal.md "Polls and pins").

## Sending extras (Discord)

dither-chat's `docs/sending.md`: a reply without a ping, sending silently, previews off, saved messages and reminders,
Discord's own scheduled messages (`extractors/discord/src/sending.ts`, hook.js "sending extras"). The hub's own Send
later needs nothing here: it sends through the ordinary `send` at its time.

- `send` with `silent` and `mentionReplied: false`: the client's own `sendMessage` options, `flags: 4096` and
  `allowedMentions: { parse: [users, roles, everyone], replied_user: false }`, as its reply bar's @ toggle and @silent
  build them; on the REST path, the same as `flags` and `allowed_mentions`. Capabilities `silentSend`, `replyMention`.
- `suppressEmbeds`: the patch its own Remove Embeds sends, with `SUPPRESS_EMBEDS` added to the flags the message has
  (read first, as a jump to it does, when the client has not loaded it).
- Saved messages (`savedMessages`, needs `SavedMessagesStore` and its save module): `save` (with `dueAt`, a reminder)
  and remove through the client's own functions; `savedList` runs its Saved list's own fetch (the next page with
  `before`) and reads its store. `SAVED_MESSAGES_UPDATE` (loaded by the client itself on connecting),
  `SAVED_MESSAGE_CREATE/DELETE` and its own timer's `MESSAGE_REMINDER_DUE` are forwarded as `saved`, `unsaved` and
  `reminderDue`.
- `nativeScheduled` and `cancelScheduled` (`nativeScheduled`): only where the client's own gate for its experiment
  `2026-08-scheduled-messages` says so (else `{ enabled: false }` and no request); the list is the request its
  Scheduled list makes, cancel its own action.
- The reaction picker's custom emoji are ordered by `TopEmojiStore` (persisted; never fetched by us).

The functions are found by their code (`PUT_SAVED_MESSAGE`, `GET_BOOKMARKS`, `SCHEDULED_MESSAGES_DELETE_START`, the
gate's `getConfig({location:` with `isPrivate()`), read from the client's bundle (2026-11-12). Tested against replicas
with that minified text (`test/hook-sending.test.ts`, `test/sending.test.ts`); never on a live account. Not built:
DMs-wide search and search tabs (the request's body is in a chunk not read), channel summaries (they come only when a
channel is opened in Discord's own UI), Discord's AI features (gated).

## Stickers and voice messages (Discord)

`sendStickers` and `sendVoice` (extractors/discord `src/media.ts`, hook.js `stickers`). The sticker picker's page is
read from the client's `StickersStore`: this server's stickers, other servers', then the standard packs the client has
loaded; nothing is fetched. Each sticker is kept only where the client's own sendability rule (the module whose
function checks `canUseCustomStickersEverywhere` and `getSelfMember`) answers SENDABLE: one that needs Nitro is left
out and the page says so, never sent another way. Without that module, only this server's own and the standard packs.
A sticker goes through `MessageActions.sendStickers` (REST `sticker_ids` without it). A recording goes through the
same upload path files take (upload URL, PUT, the message), as the client's recorder sends one: flag IS_VOICE_MESSAGE,
no text, the file named `voice-message.ogg` with `duration_secs` and `waveform`; only an Ogg file is sent that way.
Checked against the bundle replica in `test/hook.test.ts`, not on a live account. dither-chat's `docs/media-kinds.md`
has the app's side (and why there is no GIF picker).

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

## Calls ringing you and voice channels

dither-chat's docs/calls.md "Ringing" has the whole picture; here, where it comes from.

- **Discord** (`extractors/discord/src/calls.ts`, hook.js "calls ringing, voice channels"). The hook subscribes to
  `CALL_CREATE`/`CALL_UPDATE`/`CALL_DELETE` (with `ongoingRings`: who is rung, and by whom) and reads the call
  channel's voice states from the client's store: `callState` facts, one per call message. `declineCall` is the
  client's own `CallActions.stopRinging`; a call `join` with `ring` calls `CallActions.ring` after the join, as the
  client's call button does. `VOICE_STATE_UPDATES` (at most one list per channel a second) and the voice state store
  after connecting give `voice` events; `VOICE_CHANNEL_STATUS_UPDATE` and `CHANNEL_INFO` give `voiceStatus`. All of it
  is what the client was sent anyway. Capabilities `callStates`, `voicePresence`, `declineCall` and `ringCalls` follow
  the modules the hook found.
- **Signal** (`extractors/signal/src/calls.ts`): `callStates` from the call messages in envelopes (docs/signal.md "Calls").

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
  - Discord's `pipeline.test.ts` and `attention-pipeline.test.ts` feed the adapter's facts into dither-chat's real hub store. It needs a dither-chat checkout beside this repo (or `DITHER_CHAT_REPO`) and is skipped without one.
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
