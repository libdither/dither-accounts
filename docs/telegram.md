# Telegram

A Telegram account runs here as the extractor `extractors/telegram` (kind `telegram`, interface `chat`): your own
Telegram account, signed in as another device the way Telegram Desktop is, speaking MTProto directly with
[mtcute](https://mtcute.dev) (pure TypeScript, Bun-native, MIT). No browser, no native library, no bridge. It signs
in by a QR code on its pane, or by phone and code; or, where the manager offers it, through the real Telegram Desktop
running in the account's sandbox, which then stays as the account's live view and the source of its notifications,
links and downloads ([below](#signed-in-through-telegram-desktop)).

## Adding one

1. Every client that signs in to Telegram does so as an app: an **api_id** (a number) and an **api_hash** (32 hex
   characters). Telegram's terms ask every client for an app of its own: make one at https://my.telegram.org →
   **API development tools** (any title and short name; platform "Desktop" or "Other") and give both its App api_id
   and App api_hash. One without the other is refused. Or choose **App** `desktop` to use **Telegram Desktop's**
   instead (611335, the one nixpkgs and Telegram's own Linux packages build Telegram Desktop with, `TDESKTOP_API_ID`,
   published in both): nothing to make first, but it is one client presenting another's app, which Telegram may
   hold against the account. An account that signed in with Telegram Desktop's app before this was a choice (a session
   and neither api_id nor api_hash) keeps it.
2. On the manager's page, **Add account → Telegram**: your app's api_id and api_hash, or App `desktop`. Leave
   "Telegram's test servers" empty (`yes` is for a test account on the test DCs, below).
3. The pane shows a QR code. On your phone: **Telegram → Settings → Devices → Link Desktop Device**, and scan it.
   It renews itself every 30 s or so for 10 minutes; after that, **New code**.
4. If the account has a two-step verification password, the pane asks for it next (the password form, with your
   hint). It is used for that one check and never written anywhere.

It is then online: the pane shows who it is signed in as, the session facts, and the chain (api_id and api_hash →
connection → signed in → updates); the first link says whose app it signed in with.

**Without the phone at hand** (or with no phone app to scan with): sign in with the number and the code Telegram
sends to your other sessions (or by SMS), through the account's actions. The page has no form for these yet (only
WhatsApp gets the phone field), so until it does they are under **Try it → action**:

| action | args | what it does |
|---|---|---|
| `sendCode` (or `pairPhone`) | `{"phone": "+15551234567"}` | Telegram sends a code; the pane says where (attention `verify`, `detail.code` = `{type, length, next}`) |
| `signIn` (or `code`) | `{"code": "12345"}` | signs in, or answers `{password: true}` when the account has a two-step password |
| `resendCode` | | the code again, by the next way Telegram offers (SMS, a call) |
| `relogin` (or `password`) | `{"password": "…"}` | the two-step password, after a QR scan or a code (what the pane's password form runs) |
| `refreshLink` (`startLink`, `qr`) | | a new QR code (the pane's **New code**) |
| `logout` (`relink`) | | signs this device out on Telegram and starts over with a QR code |
| `resync` | | reads every chat again |
| `status` | | phase, connection, chat count, and what Telegram is holding back |

## Standing in for the phone: approving sign-ins, sessions

Once an account is signed in, an app can do what Telegram's phone app does under **Settings → Devices**, so the phone
app is not needed: approve a sign-in on another device by scanning the QR code it shows, list the account's sessions,
and end one. dither-chat does this with a camera scanner and a confirm dialog. These are actions (the `chat`
interface's `action` op, level **manage**), and they work only while the account is signed in; before that each
answers "Telegram is not signed in on this account yet: sign in first". `src/sessions.ts` has the wording.

| action | args | answers |
|---|---|---|
| `approveLogin` | `{"link": "tg://login?token=…"}`, or the bare base64url token | `{session: {hash, device, platform, app, appVersion, country, region, createdAt}}`: the session it signed in (`auth.acceptLoginToken`) |
| `sessions` | | `{sessions: [{hash, current, device, platform, app, appVersion, country, region, createdAt, activeAt}]}` (`account.getAuthorizations`), this account's own first, then by `activeAt` |
| `endSession` | `{"hash": "…"}` | `{}` once Telegram has ended that session (`account.resetAuthorization`) |

`hash` is a session's 64-bit id as a decimal string (it may be negative); it is only for `endSession`. This account's
own session is `current` with hash `"0"`, and `endSession` refuses it (use `logout`). `createdAt` and `activeAt` are ms
since the epoch; `country` and `region` are what Telegram guesses from the IP, `null` when it has none. The IP itself
is never answered. `device` is Telegram's device model (an app's own name for itself, often), `platform` and `app`
as Telegram lists them.

What it refuses, in words an app can show as they are:

- an expired code (`AUTH_TOKEN_EXPIRED`): "That code has expired: show a new one on the other device" (the other
  device makes a new one every 30 s or so);
- a code already used (`AUTH_TOKEN_ALREADY_ACCEPTED`): it says so, and to end the session it made if that was not you;
- a code Telegram does not know (`AUTH_TOKEN_INVALID…`), or anything that is not a `tg://login?token=` link or a
  token: two messages, both saying to scan the code the other device shows;
- `endSession` from a session **less than a day old** (`FRESH_RESET_AUTHORISATION_FORBIDDEN`): Telegram lets only a
  session that has been signed in for a day end others. The message names the session that is too new (this
  account's own, e.g. "Telegram Desktop on dither-accounts, signed in 3 hours ago") and about when it can; until then,
  end it from an older device. Should Telegram ever refuse `approveLogin` the same way (`SESSION_TOO_FRESH_…`), the
  message is the same, for approving;
- a hash with no session behind it (`HASH_INVALID`): it may have ended already; list the sessions again;
- a flood wait, as for any call; anything else: "Telegram did not approve that sign-in (ERROR)" and the like.

**Approving a code gives whoever shows it your account.** A QR code on someone else's screen ("scan this to join",
"to verify your account") is a sign-in to *your* account on *their* device, and Telegram cannot tell the two apart.
Telegram says nothing about the other device before it is approved (the answer is the first time its name is known),
so the app must ask first, every time, in plain words: *only approve a code that your own device is showing you right
now, because you started signing in there.* Then show what was approved, with a way to end it; and know that the
undo is refused while this account's own session is under a day old (above), so for a new account the confirmation is
the only safeguard.

The log (`adapter.log`, the pane) says only which action ran and how it ended ("approveLogin: approved a sign-in on
another device", "endSession: refused by Telegram (FRESH_RESET_AUTHORISATION_FORBIDDEN)", "sessions: listed 4"): never
the code, a hash, a device's name or where it is. The manager keeps none of a call's input or answer.

**Login codes without the phone.** Someone signing in to this account elsewhere by phone number gets a code from
Telegram's service account, **Telegram** (user 777000), which Telegram writes into your chat with it. That chat is an
ordinary private chat here, `dm:<you>:777000`, shape `direct`: in the snapshot with its last message, live as codes
arrive, and in `history`. Nothing filters it. If the chat is new (you deleted it, or it never had a message), its
conversation is sent before the first code, as for anyone who writes for the first time. One thing is not shown:
notices Telegram sends as `updateServiceNotification` (a popup, or a message official apps keep only locally in that
chat) have no message id on the server and are left out; login codes are real messages and are not among them.

## Signed in through Telegram Desktop

The other way in: the real Telegram Desktop (7.2.9 from nixpkgs) runs in the account's own sandbox
(`packages/sandbox`, docs/native-sandbox.md), and you sign in there, in the live view, with Telegram's own screens.
The app stays: it is the account's body, the live view shows it working, and everything it hands to the desktop
(notifications, links, saved files, file dialogs) comes to this account instead. It is **off by default**: a manager
offers it only with `DITHER_TELEGRAM_DESKTOP=1` in its environment (then the add form has **Sign in with**, and the kind
serves `notifications` and `desktop` besides `chat`). An account made with `signIn: desktop` on a manager without it
says so and does nothing.

1. **Add account → Telegram**, **Sign in with** `desktop` (no api_id or api_hash: this way signs in as Telegram Desktop
itself, so it uses its app).
2. The pane says to sign in in the live view. Open it: Telegram Desktop's welcome screen; **Start Messaging** shows its
   QR code. On your phone, **Settings → Devices → Link Desktop Device**, and scan it. Or **Log in using phone number**
   there: the code, and your two-step password if you have one, are typed into Telegram Desktop.
3. As soon as Telegram Desktop's tdata says it is signed in, the account makes **a session of its own** from it: this
   account's client asks Telegram for a login token (`auth.exportLoginToken`, as for a QR code), and a short-lived
   client on Telegram Desktop's key accepts it (`auth.acceptLoginToken`), as your phone would by scanning. That client
   presents itself exactly as Telegram Desktop does from the sandbox (its api_id, "Desktop", "Linux X11 glibc 2.44",
   "7.2.9", lang pack `tdesktop`), makes that one call without updates, and closes without signing anything out.
   If the account has a two-step password, Telegram asks the new session for it too: the pane's password form, once.
4. Online. The two sessions are separate entries in **Settings → Devices** ("dither-accounts", and Telegram Desktop),
   each revocable alone; they never share an auth key, so there is no fight over updates.

**If Telegram refuses `acceptLoginToken`** (a session younger than a day may not be allowed to sign in others; the
error is shown), the account **shares Telegram Desktop's key** instead: its own MTProto session id on the same
authorization, presenting itself as Telegram Desktop, catching up with `updates.getDifference` every minute (Telegram
may deliver some updates to Telegram Desktop's connection only). The key is read from tdata at each start and never
copied into `secret.json`. The chain says which: `session imported` is "its own session (auth.acceptLoginToken)" or
"shares Telegram Desktop's session (…why)". Config `desktopSession: shared` asks for the shared one from the start;
the action `importDesktop {"mode": "own" | "shared"}` makes one now.

The chain: **sandbox → Telegram Desktop → signed in (Telegram Desktop) → session imported → connection → updates**.

**Signing out in Telegram Desktop** (in the live view): with its own session, the account carries on; the third link
turns grey ("signed out in the live view; this account keeps its own session"), and a new sign-in there is not
imported unless this account has no session. With the shared key, the account's session ends with Telegram Desktop's,
and it waits for you to sign in there again. **Ending this account's session** (logout, or removing "dither-accounts"
under Settings → Devices) does not make another from the same Telegram Desktop sign-in by itself: `importDesktop`
does, or a new sign-in there. With the shared key, `logout` signs out that key, which is Telegram Desktop's: it goes
back to its sign-in screen too. If Telegram Desktop is signed in as another account than this one, the chain says so
and this account stays who it was. Closing Telegram Desktop's window quits it (there is no tray); it is started again
within seconds (backing off to a minute if it keeps exiting), and `restartDesktop` restarts it.

**A local passcode** (Telegram Desktop → Settings → Privacy → Local passcode) encrypts its tdata: the pane asks for it
(`desktopPasscode {"passcode": "…"}`), which is used in memory to read the session and never written. Or turn it off.

What comes out of Telegram Desktop, and where it goes (the same policy as any app in the sandbox,
docs/native-sandbox.md):

| | |
|---|---|
| notifications | `notify.new` (interface `notifications`, source "Telegram Desktop", title the chat, body as Telegram Desktop shows it, reason `message`); taken back by the app: `notify.read`. `notify.list`; `notify.markRead` presses its "Mark as read" (the chat is read in Telegram); `notify.mute` is refused (mute in Telegram) |
| links | `desktop.link` and `desktop.links`; opened nowhere |
| downloads | Telegram Desktop's folder is the sandbox's `~/Downloads/Telegram Desktop/`; each file, once whole, is `desktop.download`; `desktop.downloads`, `desktop.fetch {id}` |
| file dialogs | "Save as" goes to `~/Downloads`; "Attach" gets what `desktop.offer {name, base64}` put in `~/Outbox`, or nothing; each is `desktop.fileRequest` |

Actions here: `importDesktop {mode?}`, `desktopPasscode {passcode}`, `restartDesktop`, `relogin {password}` (the own
session's two-step password), `logout`, `resync`, `status`, and `approveLogin`, `sessions`, `endSession` as above (with
the shared key, "this account's own session" is Telegram Desktop's). `refreshLink`, `sendCode` and `signIn` say to use
the live view.

## What it stores

In the account's directory (0700), nothing anyone wrote:

| file | what |
|---|---|
| `secret.json` | `apiHash`, `session` (mtcute's session string: the auth key, the DC, who), `userId`. Written whole or not at all (`secret-file.ts`). The session string is the credential: anyone with it is signed in as you, until you end the session under Settings → Devices |
| `telegram.sqlite` | mtcute's state: the update sequence numbers (so a restart catches up on what it missed), the peers it has seen with their access hashes, the DC list. The auth key is kept out of it: it lives in memory, from `secret.json` |
| `state.json` | the extractor's own: access hashes and names of the people and chats it knows (Telegram wants an access hash with every call), which channels are forums, the chats it has, recent message ids → their chat (Telegram's delete in a private chat names only ids), and your recent messages per chat (to say which ones the other side read) |
| `adapter.pid`, `adapter.log` | one process per session (two connections on one auth key make Telegram end it), and its log |

The api_id is in the account's config (it is not a secret); the api_hash and the session in `secret.json` only.

Signed in through Telegram Desktop, also:

| | |
|---|---|
| `secret.json` | besides the above: `sessionMode` (`own` or `shared`), `desktopKey` (which Telegram Desktop key it came from: 16 hex digits of its SHA-256, not the key), `desktopEnded` (a key whose session was ended, not imported again by itself). With the shared key there is no `session` here |
| `desktop/home/` | the sandbox's home: `.local/share/TelegramDesktop/` is Telegram Desktop's working dir (`-workdir`), with its `tdata` (its session: anyone with this directory is signed in as you, as with `secret.json`) and its `log.txt`; `Downloads/`, `Outbox/`; `.config/` with what we put there for it (user-dirs, the default link handler) |
| `desktop/bin/`, `desktop/etc/` | the shims (`xdg-open` and friends), the sandbox's `passwd`, `group`, `machine-id` |
| `desktop/sandbox.json` | the sandbox's processes while it runs, so a start after a killed extractor ends them |

The bus socket lives in `$XDG_RUNTIME_DIR/dither-sandbox/<hash>/` while the sandbox runs (a unix socket path must be
short).

## Telegram Desktop's tdata

`src/tdata.ts` reads it (and writes it, for the tests' fixtures and the fake), from the format alone: Telegram Desktop
is GPL, and none of its code is here. As 7.2.9 writes it:

- **a file**: `TDF$`, the app version as int32 little-endian (7002009), a body, and MD5 of the body, its length
  (int32 LE), the version and `TDF$`. Written as `<name>s`; older versions kept `<name>0` and `<name>1`, the newer of
  which is read. The body is a Qt data stream: big-endian integers, byte arrays as a uint32 length and the bytes.
- **an encrypted part**: 16 bytes of msg_key, then AES-256-IGE of [uint32 LE length counting itself][data][padding to
  16]; msg_key is SHA-1 of that plaintext, cut to 16; the AES key and IV come from msg_key and a 256-byte key as in
  MTProto 1.0 (x = 8).
- **`key_datas`**: byte arrays salt (32), keyEncrypted, infoEncrypted. The passcode key is PBKDF2-HMAC-SHA512 of
  SHA-512(salt ‖ passcode ‖ salt) with the salt: one iteration with no passcode, 100000 with one; it opens
  keyEncrypted, which is the 256-byte local key; that opens infoEncrypted: the account indices (0–5) and the active
  one.
- **`<part>s`** per account, `<part>` the first 8 bytes of MD5 of `data` (account 0; `data#2` for account 1, …) as a
  little-endian number in hex, low nibble first: `D877F783D5D3EF8C` for `data`. Its body is one encrypted byte array of
  blocks; block `0x4b` holds the MTP authorization: uint64 all-ones, uint64 user id, int32 main DC (old files: int32
  user id, int32 DC), then the keys in use and the keys to destroy, each an int32 count of (int32 DC, 256 bytes).
  User 0 is its sign-in screen (it already has keys then).

`bun scripts/verify-telegram-desktop.ts --real` checks this against what the real Telegram Desktop writes.

## Your real account, through Telegram Desktop: a checklist

Nothing of this has met a real account yet. When you try it:

1. Give the manager `DITHER_TELEGRAM_DESKTOP=1` (the unit's environment) and restart it when nothing else
   needs it running. The add form then has **Sign in with**.
2. Add a Telegram account with **Sign in with** `desktop`, api_id and api_hash empty. Open the live view: Telegram
   Desktop's welcome screen should fill it.
3. **Start Messaging**, then scan its QR code from your phone (Settings → Devices → Link Desktop Device), or log in by
   phone number there. If you have a two-step password, Telegram Desktop asks for it, and then the pane asks again for
   this account's own session.
4. Within seconds the chain should read all green, with `session imported` "its own session (auth.acceptLoginToken)".
   If it says "shares Telegram Desktop's session (auth.acceptLoginToken refused: …)", note the error: that is the one
   thing only a real account can tell. Try `importDesktop {"mode": "own"}` again a day later.
5. On your phone, Settings → Devices should list Telegram Desktop ("Desktop", Linux) and "dither-accounts" separately,
   and Telegram Desktop's entry should still say Telegram Desktop.
6. Send yourself a message from the phone while Telegram Desktop shows another chat: an app with `notifications`
   should get `notify.new`; `notify.markRead` should mark it read on the phone.
7. Open a link in a message in the live view: `desktop.link`, nothing opens. Download a file: `desktop.download`.
8. Sign out in the live view: the account should stay online (own session). Remove "dither-accounts" on the phone:
   the account should wait, and not come back by itself.

What only that can show: whether Telegram lets a fresh Telegram Desktop session accept a login token (and how soon);
whether it treats the short-lived client on Telegram Desktop's key as Telegram Desktop; with the shared key, how many
updates go to Telegram Desktop's connection rather than ours (getDifference covers them, a minute late); whether
Telegram Desktop shows notifications while its window is the active one (it does not for the chat it has open).

## How it maps

Ids (`src/ids.ts`): Telegram numbers users, basic groups and channels apart, and numbers messages per account in
private chats and basic groups but per channel in channels. So:

| | native id |
|---|---|
| a person | `<userId>` (a channel posting as itself: `channel:<id>`) |
| a private chat | `dm:<you>:<them>` (Saved Messages: `dm:<you>:<you>`, shape `self`) |
| a basic group | `group:<you>:<chatId>` |
| a supergroup or channel | `channel:<id>` |
| a forum | the space `channel:<id>` |
| a forum topic | `channel:<id>/<topicId>` (General is topic 1), a channel in that space |
| a message | `<chat>#<msgId>` (in a topic too: the id is the channel's) |
| a file | `tg://media/<chat>/<msgId>`, `tg://avatar/<peer>/<photoId>?dc=<dc>`, `tg://emoji/<documentId>`, all through `fetchMedia` |

Chats: private chats are `direct`, basic groups and supergroups `group` (variant `text`), broadcast channels `group`
with variant `announcement`. Archived chats are `archived`, muted ones `mute: {level: 'none'}`. Folders are not mapped.

**Forums as spaces.** A forum (a supergroup with topics) goes to the hub as Discord's servers and Matrix's spaces do:
a `community` space with the forum's own id (`channel:<id>`; the hub keeps spaces and conversations apart), its name,
picture and mute, and each topic a `channel` in it, pinned topics first and then by creation (General, topic 1,
leads). The forum's own conversation holds no messages (they all sit in topics), so it is left once each run
(`leave`). The adapter keeps the forum as a conversation inside and changes it on the way out (`route` in
`src/adapter.ts`): the forum's reads are dropped (the topics carry their own), pins and typing that name no topic go to
General, roles and join requests name the space, and `about`, `configure` and `addMembers` take the space. A group
that turns its topics off sheds the space and comes back as a group; one that turns them on becomes a space at its next
snapshot.

Messages: text with its entities as the hub's Markdown (`src/entities.ts`: bold, italic, underline, strike, spoiler,
code, pre with its language, links, quotes, mentions by name as `<@id>`), replies (across chats too), forwards with
where from, edits, `mentionsSelf` from Telegram's own flag, photos, files, video, voice, stickers (kind `sticker`,
body the emoji), places, contacts, polls and dice as text, service messages in words (joins, renames, calls, topics,
timers), views and album ids under `extra`. Reactions: a message's whole set as a snapshot (`reactions`, with the
people Telegram names and its totals), and live changes as `reaction` events for those it names.

Events: `message` (live, and `live: false` for the snapshot and history), `delete`, `reaction`, `read` (with Telegram's
own unread and mention counts), `receipt` (read, in private chats: Telegram says who only there), `typing` (6 s, as
Telegram's apps), `pin`, `role` (admins given and taken), `identity`, `conversation`, `leave`.

Commands: `send` (Markdown to entities, replies, into a topic, one file as a photo or document, several as an
album), `edit`, `redact` (deleted for everyone), `react` (one reaction each without Premium, as REACTION_RULES says),
`reactionContext`, `reactors`, `markRead` (topics too), `typing`, `history` (paged back by date), `fetchMedia` (up to
64 MB), `openDirect` (@username, +phone, or a user id it knows; a public group's @name gives that group),
`forward` (with a note first, as Telegram's apps send one; a chat that forbids forwarding answers with a fallback),
`about` and `configure` (name, description, slow mode, join requests on public groups, the invite link, pins, a
topic's name), `profile` (bio, username, phone where shown, groups in common, birthday; for you, your contacts).
`resolve`, `add` and `answer`, with the `requests` events: [below](#joining-contacts-join-requests). `remove`, with
the `relationships` events: [below](#contacts-and-blocks-relationships-and-remove). `call` is refused.

## Joining, contacts, join requests

dither-chat's **New** box (its docs/add.md) looks up what was pasted or typed, then acts on it when you click. The
account advertises all four capabilities for it: `resolve`, `join`, `connect` and `requests`. Only a command does any
of this: nothing joins, adds a contact or answers a request by itself, and nothing that acted is sent again by itself.

**`resolve`** says what a reading is without joining, adding or telling anyone. Each is one read; the identity facts
it names go out before the answer.

| reading | call | answer |
|---|---|---|
| invite link (`t.me/+HASH`, `t.me/joinchat/HASH`, `tg://join?invite=`) | `messages.checkChatInvite` | not in it (`chatInvite`): `what` `channel` for a broadcast channel, else `group`; its title, `about` as `description`, `participants_count` as `members`, its picture (`tg://invite/<hash>/<photoId>`, through `fetchMedia`, which looks the link up again for a fresh file reference), actions `ask` when the admins approve (`request_needed`) else `join`; notes for that, for a channel, for scam or fake marks, and for your contacts in it. In it (`chatInviteAlready`): `nativeId` and `joined.conversation`, no actions, "You are in it already" (its conversation goes out first if the snapshot did not reach it). Allowed to look in for a while (`chatInvitePeek`): `joined` for now, actions `join` (or `ask`), and a note until when; no conversation is made for it |
| `@name`, `t.me/NAME` | `contacts.resolveUsername` | a person: `what` `person`, name, `nativeId` (their user id), picture, `relationship` `contact` or `stranger`, actions `message`, and `contact` unless they are one already, a bot, or you. A channel or public group: also `channels.getFullChannel` (still read-only) for its description and size; `joined` if you are in it, else `join`, or `ask` where it wants approval |
| `+phone`, `t.me/+PHONE` | `contacts.resolvePhone` (read-only: nothing is imported) | a person, as above |

Never `partial`: Telegram tells all of this without acting. Not found and expired are errors in words:
"This invite link has expired or was revoked" (`INVITE_HASH_EXPIRED`), "Telegram does not know this invite link: it may
be mistyped, or it was revoked" (`INVITE_HASH_INVALID`), "Nobody on Telegram is called @name"
(`USERNAME_NOT_OCCUPIED`), "No Telegram account has this number, or its owner hides it" (`PHONE_NOT_OCCUPIED`), "This
group or channel is private, or you were removed from it". A paid channel (Telegram Stars) has no actions and says to
join it from a Telegram app.

**`add`** acts. The facts for what now exists go out first; the answer carries their native ids.

| action | reading | call | answer |
|---|---|---|---|
| `join`, `ask` (one call on Telegram: a chat that wants approval answers `INVITE_REQUEST_SENT`) | invite link | `messages.importChatInvite` | joined: the chat's conversation (and, after `messages.getPeerDialogs`, its last message, read state and a forum's topics), then `{conversation}`, with "Joined; only its admins post here" for a channel. `INVITE_REQUEST_SENT`: `{pending: true}`. `USER_ALREADY_PARTICIPANT`: the conversation it is (looked up again with `checkChatInvite`) |
| | `@name` of a public group or channel | `channels.joinChannel` | as above |
| `contact` | `@name` or `+phone` of a person | `contacts.addContact` with `add_phone_privacy_exception` **false**, their own first and last name, and their number when found by it | their identity again with `contact: true`, then `{identity, relationship: 'contact'}`. Your number is not shared with them. Already a contact: said so, nothing sent |

`friend` and `follow` are refused: Telegram has neither. **A check is never worked around:** a group whose bot checks
new members first (Telegram answers `messages.chatInviteJoinResultWebView`, the bot's mini app) gives
`{check: 'captcha'}` with nothing done; pass it by joining from a Telegram app (on an account signed in through
Telegram Desktop, that is the live view). Other refusals in words: too many groups and channels (`CHANNELS_TOO_MUCH`),
a full group, banned, private, a frozen account (`FROZEN_…`), Telegram's spam limit on the account (`PEER_FLOOD`).

**Join requests** (`requests`; Telegram has no friend, invite or message requests, so none are made up): someone asks
to join a group or channel you own, or admin with the right to add members. After connect, once the snapshot has said
which chats those are, `messages.getChatInviteImporters` (`requested`) per such chat gives the whole list, sent as one
`requests` event: `{nativeId: 'join:<conversation>:<userId>', kind: 'join', from: <userId>, target: {kind:
'conversation', nativeId, name, members}, ts, answers: ['accept', 'decline']}`, the requester's identity first. Then
Telegram's `updatePendingJoinRequests` for a chat reads that chat's list again: `request` for each new one,
`requestGone` for each answered elsewhere or withdrawn (and for all of a chat this account leaves). The list is not
sent when it is not known: no snapshot (the next one that works lists it), or a chat that could not be read (what was
found goes out as `request`, and it is read again in two minutes); the hub keeps its own meanwhile. When the hub
connects again it gets the list as it stands. **`answer`** is `messages.hideChatJoinRequest` (`approved` for accept,
not for decline): `requestGone`, then `{identity, notes}`. One no longer waiting (`HIDE_REQUESTER_MISSING`) is gone
too, and the answer says so. There is no `block` for a join request on Telegram.

**Flood waits** for any of these come back in words that say when it frees up, e.g. "Telegram asks this account to
wait before joining more groups and channels: try again in 5 minutes (after 21:37 UTC)". An act (join, contact,
answer) is sent once: never retried after a wait (here or in mtcute, which otherwise sleeps through short ones), and
one Telegram holds fails at once without being sent. A lookup may wait out a hold of up to 10 s.

What only a real account can show: the flood limits on joining and adding contacts (the lane below is a guess on the
safe side); the bot check (`chatInviteJoinResultWebView`) and the peek (`chatInvitePeek`) as Telegram sends them;
whether a just-joined chat's dialog is listed at once; that `updatePendingJoinRequests` reaches this session and comes
with `hideChatJoinRequest`'s answer. Limits: join requests are read only in the chats the snapshot reached
(`maxDialogs`) and up to 1000 per chat; the requester's note to the admins is not carried (the protocol has no place
for it).

## Contacts and blocks: relationships and remove

The account advertises `relationships` and `disconnect` (dither-chat's people links). Telegram has no friends,
follows or friend requests: a person is a **contact**, **blocked**, or neither.

**The list.** After each snapshot that works (at connect, and `resync`), `contacts.getContacts` (hash 0 the first
time) and `contacts.getBlocked` (100 at a time) give the whole list, sent as one `relationships` event, each person's
identity first: `{identity: <userId>, relationship: 'contact'}`, and `{identity, relationship: 'blocked', since}` with
`since` the date Telegram gives for the block. Contacts carry no `since` (Telegram gives none). A blocked contact is
in it once, as `blocked`; blocked groups and channels are left out (not people), and so are you. If either read
fails, no list goes out (never an empty one by mistake); the hub keeps its own, and the next snapshot or read again
sends it. When the hub connects again it gets the list as it stands. The pane shows `contacts` and `blocked` counts.

**Changes**, each as a `relationship` event (`stranger`: gone), only when it differs from what the hub was told:

- `updatePeerBlocked` (blocked or unblocked in a Telegram app; the story blocklist is another list and is ignored).
- Contacts added or removed on another device: Telegram has no update of its own for this that this account can
  count on (`updateContactsReset` aside), so the lists are read again every 30 minutes (`contacts.getContacts` with
  the hash of the list as known: an unchanged one comes back as `contactsNotModified`) and the differences go out;
  and when a user Telegram sends (with a message, `updatePeerSettings`, `updateUser`) has a contact flag that
  disagrees with the list, the lists are read again 2 s later (at most once a minute).
- This account's own `add` with `contact`, and its `remove`. A profile (`users.getFullUser`) that shows someone
  blocked or a contact when the list says otherwise also corrects it.

**`remove {identity, relationship}`** ends one: `contact` is `contacts.deleteContacts`, `blocked` is
`contacts.unblock`. Telegram is asked first what they are now (`users.getFullUser`, a lookup; if it will not say, the
lists as known), and a remove whose `relationship` is not what they are is refused with "That changed; look again"
(the change goes out as a `relationship` first). `friend`, `requested`, `following` and the like: "Telegram has no
friends or follows; only contacts and blocks". The act goes in the slow lane and is sent once (a flood wait: "Telegram
asks this account to wait before removing more contacts: try again in 5 minutes (after 21:37 UTC)", or "…before
unblocking more people…"). The identity again (no longer a contact) and the `relationship` event, then the answer:
`{identity, relationship: 'stranger', notes}`, or `'contact'` for a blocked contact unblocked, who stays a contact.

What only a real account can show: whether Telegram sends this session anything when a contact is added or removed
on another device (the re-read covers it either way), and whether `updatePeerBlocked` reaches it after a block in
another app; that the contacts hash matches Telegram's (a wrong one only means the whole list each time).

## Search

The `search` command is dither-chat's network search (its docs/indexing.md), one request per account (`src/search.ts`):

- Words alone: `messages.searchGlobal`, every chat and channel the account is in.
- `in:` chats: `messages.search` in each (a forum topic by `topMsgId`); another account's chats are skipped.
- `from:` with no chat: `messages.search` over `inputPeerEmpty` (every private chat and basic group at once) for
  each person, and with words a global search held to those people for the supergroups and channels.
- `has:` is one of Telegram's filters: image → photos, video → videos (both → photos and videos), audio → voice,
  file and attachment → documents, link and embed → links. Mentions are your own only (`inputMessagesFilterMyMentions`).
- What Telegram cannot do fails with a reason: `has:sticker`, `has:reaction`, two filters at once, mentions of
  someone else, more than 8 requests (chats × people).
- Quotes are dropped from the words; dates are held exactly to the hub's bounds after Telegram's (a second wider)
  ones. One page of 25, newest first (`next` is always null); `sort:oldest` reorders that page.
- The hits' messages go out first as history facts (`live: false`), so the hub stores them.

Searches share the history lane (0.7 s apart).

## Pacing

Telegram does not publish its limits for user accounts; it answers too many requests with `FLOOD_WAIT_<seconds>` and
the account must wait. So (`src/pacer.ts`): calls start no closer together than their lane allows (joining a group or
channel and adding a contact 3 s apart, as Telegram flood-limits those hard; chat lists 1 s, history and join-request
lists 0.7 s, sends 0.35 s and one a second per chat, answers to join requests 0.35 s, reads 0.3 s; lookups the normal
0.12 s; removing a contact and unblocking go in the 3 s lane, the contact and block lists in the 1 s one), a method
Telegram made wait is held until the wait is over, and every wait is logged and shown on the pane (`floodWait`, and
the `updates` layer). mtcute sleeps through waits up to 10 s itself; longer ones: background work
(the snapshot, catching up) waits up to 15 minutes, a command waits up to 30 s and otherwise fails with "Telegram asks
this account to wait N s before more <method>". Acts are sent once ([above](#joining-contacts-join-requests)).
Typing goes out at most every 4.5 s per chat, as Telegram's apps repeat it. The snapshot reads at most 2000 chats per
folder (config `maxDialogs`).

## Limits

- **Secret chats** (Telegram's end-to-end ones) are tied to the device that made them and are not read or made here.
- **Calls** are not supported.
- **Folders** are not spaces; channels' comment threads are ordinary replies in the discussion group.
- **Avatars** are `tg://avatar/…` and come through `fetchMedia`; the manager's page shows only https avatars, so its
  pane has none (dither-chat's hub fetches them).
- Several reactions on one message (Premium) are sent as a set; a broadcast channel does not say who reacted.
- `about` lists at most 200 recent members plus the admins; a channel's subscribers only to its admins.
- Changing a chat's picture is not supported (nor does `aboutChangeProblem` allow it).
- **Sign-up** is not possible: Telegram no longer lets third-party apps create accounts. Make the account in a
  Telegram app first.
- Telegram limits accounts that look automated. This extractor sends nothing on its own, but a brand-new account
  signing in with a brand-new api_id has been known to be frozen for a while; an account with some history is safer.

## Testing it

Without an api_id, everything runs against a fake Telegram (`src/fake.ts`, `TELEGRAM_FAKE=1`): the same backend
interface the real one implements, answering the TL methods the extractor calls with TL objects, over a small world
(you, Alice, Bob, Carol, a bot; a group, a supergroup, a forum with topics, a channel), driven through a socket in the
account directory (`fake-telegram.sock`: scan the QR, someone writes, reacts, types, reads, a flood wait, a revoked
session). For the session actions it has two other sessions (a phone, a Telegram Desktop), and `loginToken` (another
device shows a QR code: `{link}`; `ttlMs: 0` for one already expired), `ageSession {hours}` (the signed-in session is
older: under a day it may not end others, as on Telegram) and `loginCode {code}` (Telegram, user 777000, sends a login
code). `extractors/telegram/test/sessions.test.ts` runs every path of them. For adding, it has chats the account is
not in (a group to join by invite, one whose admins approve, a public channel, a public group that asks first, one
whose bot checks members, one to peek into), their invite links (`FAKE_INVITES`, one expired), people with no contact
(Dave by name and number, Erin, Frank by number), join requests waiting in two chats it admins, and the ops
`joinRequest {chat, user, withdraw?}` (someone asks, or the request goes), `invite {hash, chat, …}`, `fail {method,
error}`, and `calls {method?, full?}` (with what was sent). For contacts and blocks: Alice and Bob are contacts, Grace
and a group are blocked, and the ops `block {user, blocked?, silent?}` and `contact {user, contact?, silent?}` change
that as another device would (with `updatePeerBlocked` or `updatePeerSettings`, or, `silent`, with nothing, so only a
read again finds it). `test/telegram.test.ts` runs adding and removing end to end;
`extractors/telegram/test/adapter.test.ts` checks the facts go out before each answer, and the lists and their
changes.

```sh
bun test extractors/telegram/test test/telegram.test.ts   # mapping, entities, pacing, the adapter on the fake, mtcute offline, a throwaway manager
bun scripts/verify-telegram.ts                             # a manager process on 18510: added as the page does, an app's calls and events
```

Through Telegram Desktop: `extractors/telegram/test/tdata.test.ts` (the format, against our own encoder's fixtures),
`extractors/telegram/test/desktop.test.ts` (the adapter's import: its own session, the password, the shared fallback,
an ended session, the passcode), `test/telegram-desktop.test.ts` (a throwaway manager, the fake Telegram, and the fake
Telegram Desktop, `test/fake-desktop.ts`, in the real sandbox: it writes a tdata, posts notifications on the bus, runs
`xdg-open`, downloads, and uses the FileChooser portal). The fake Telegram takes `authorizeKey`, `endKey` and
`refuseAccept` for it.

```sh
bun scripts/verify-telegram-desktop.ts                                   # the same through a manager process on 18511
bun scripts/verify-telegram-desktop.ts --real --start-messaging --shots /tmp/shots
                                                                          # the real Telegram Desktop, up to its QR code
```

**On Telegram's test servers**, once you have an api_id (it works on both): the test DCs are a separate Telegram with
their own accounts. Numbers of the form `99966XYYYY` (X the DC, 1–3; YYYY any digits) take `XXXXX` as their code, no
SMS. A test account has to exist first (sign-up is for official apps), e.g. from Telegram Desktop's test mode (hold
Alt+Shift and right-click **Add Account**, then **Test Server**) with such a number. Then add a Telegram account here
with "Telegram's test servers" set to `yes`, and sign in by phone: `sendCode {"phone": "+99966XYYYY"}`, `signIn {"code":
"XXXXX"}`. Test accounts are wiped from time to time; nothing there touches your real account.
