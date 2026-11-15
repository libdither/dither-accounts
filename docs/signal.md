# Signal

A Signal account runs here as the extractor `extractors/signal` (kind `signal`, interface `chat`): this machine
linked as another device of your phone's Signal account, through [signal-cli](https://github.com/AsamK/signal-cli)
0.14 (`signal-cli daemon --socket`, JSON-RPC). Adding one and what the process needs are in [chat.md](chat.md).
This page is about adding on Signal: dither-chat's Add (its `docs/add.md`), with the requests waiting on you, about
keeping a message request quiet, about what a message carries besides its text (dither-chat's `docs/messages.md`),
and about people and this device: safety numbers, blocking, nicknames and notes, your own profile and username,
devices and captchas.

## What it advertises

`resolve`, `join` and `requests`, with `openDirect` for Message. Not `connect`: Signal has no friend requests,
follows or contact requests. You add someone by writing to them. For people and this device (below):
`relationships`, `disconnect`, `block`, `safetyNumbers` and `contactNotes`, and `editProfile` with every field.
For groups you are in or admin (docs/chat.md, "Moderating"): `leave`, `moderate`, `memberLabels` and `setPicture`.

## The commands

| Command | What it does on Signal | signal-cli calls |
|---|---|---|
| `resolve` a group link (`signal.group/#…`) | Reads the group key out of the link itself and derives the group's id, as libsignal does (`src/add.ts`). If signal-cli has that group already, the preview says so: **you are in it** (`joined`, its name and member count), **invited** (answer it under Requests), **asked to join** (its admins have not answered), **blocked**, or **you were in it before** (Join). Otherwise the preview is **partial**: name = the link, Join, and the note "Signal shows the group only after you join". signal-cli has no group-link preview: `joinGroup` is the only call that reads a link on the server, and it joins. | `listGroups` (local) |
| `resolve` a person (`+number`, `name.12`, `signal.me/#eu/…`) | Whether there is a Signal account and its ACI, then what signal-cli has for them: name, picture, contact, blocked. Message is the action, or nothing for a blocked person or yourself. A username link is resolved, not partial. Nothing reaches the person. | `getUserStatus` (`recipient` or `username`), `listContacts` by ACI |
| `add` (join, ask) a group link | Joins by the link. When the group's admins approve joins, signal-cli answers `onlyRequested` and the result is `pending`, with no conversation. The group's member identities and conversation fact come before the reply, and a system message "You joined the group via the group link." Already in it, or already asked (`pending`): no `joinGroup`. | `joinGroup` (`uri`), then `listGroups` |
| `answer` an invitation | **accept**: `updateGroup` with the group id alone; signal-cli accepts a pending invitation before any change, and there is none. A group id is always given (`acceptInviteParams`): without one `updateGroup` would create a group. Then the conversation, and "You accepted the invitation to the group." **decline**: `quitGroup`, which for an invitation revokes it. **block**: `quitGroup`, then `block` the group. | `updateGroup`, `quitGroup`, `block` (`groupId`) |
| `answer` a message request | **accept**: `sendMessageRequestResponse` type `accept` (tells your other devices; profile sharing on). **decline**: type `delete`. **block**: `block` the person, then type `delete`. Declined or blocked, the conversation goes (`leave`), as Signal's apps delete it; a later message from them is a new request. | `sendMessageRequestResponse` (`recipient`, `type`), `block` (`recipient`) |

Errors come back as one sentence: "No Signal account has this number" (or username, or username link), "This is not
a working Signal group link", "This group link has been reset or turned off", "You were removed from this group, so
its link no longer lets you in". A rate limit says when it frees up, from the time signal-cli puts in its message:
"Signal is limiting how often this device can look people up; try again in 10 minutes". A lookup's rate limit does
not change the account's status. A captcha Signal wants before a join (a proof-required challenge) is a check:
`{ check: 'captcha' }` and nothing was done; it is never worked around. Nothing here retries: every lookup, join and
answer is one call from one click.

## Requests

Native ids: `invite:<groupId>`, `message:<peer ACI>`, and `join:<groupId>:<ACI>` for someone asking to join a group
you admin (`requestingMembers`; accept is `updateGroup member`, decline `removeMember`; no block). The others offer
accept, decline and block. The whole list
(`requests`) goes once a read of contacts and groups has made it, after every start of signal-cli's daemon, and again
on every reconnect to the hub; never before, so an empty list means none. Then `request` for each new or changed one
and `requestGone` for each that went, answered here or elsewhere, or withdrawn.

- **Invitations:** groups `listGroups` shows with `isMember: false` and you among `pendingMembers` (by ACI, or by
  number for an invitation to your phone number), not blocked or ended. They never become conversations: the group
  update that invites you is held until a read of the group says what it is, then dropped. `from` is the sender of
  that update, when one came while the adapter was running; `listGroups` does not say who invited you. An invitation
  goes when a read shows you a member (accepted on another device: the group then shows, with its update) or no longer
  invited (withdrawn, or declined elsewhere). Reads happen on every group update and every snapshot.
- **Message requests:** a 1:1 where the other person wrote first (`heard` in `state.json`) and you have not written
  (`ours`: here, or a transcript from your phone), and signal-cli's record for them (`listContacts`) has
  `profileSharing: false`, no contact name (`name`, `givenName`, `familyName`: your address book), and is neither
  blocked nor unregistered (`src/add.ts isMessageRequest`). That is how Signal's apps decide. `profileSharing` is the
  account's "accepted" flag: the phone keeps it in storage, and accepting or writing to someone turns it on.
  signal-cli 0.14.8 shows no message-request event, so: someone new who writes is read once (`listContacts` by ACI, no
  server lookup); a sync from your other devices that signal-cli shows nothing of (a message request answered on the
  phone is one) makes it read the open ones again 5 and 30 seconds later, after the storage update; every snapshot
  decides them all again; and your own reply from the phone ends one at once.

## Keeping a message request quiet

Until a message request is accepted, nothing from this adapter tells the sender their message was seen. Its
conversation and messages are emitted as usual (the hub keeps it out of the inbox), but:

| Path | Held back how |
|---|---|
| `markRead` | No `sendReceipt`. What is unread stays unread, so the read receipts go after you accept, from the next read. |
| `typing`, `action typing` | No `sendTyping`. |
| `viewed` | No `sendReceipt --type viewed`: `{ sent: false }`. |
| `resetSession` | Refused, as a send is: an end-session message tells them. |
| `send`, `react`, `edit`, `redact`, `configure` (the disappearing timer, a pin), `pollVote`, `pollCreate`, `pollEnd` | Refused with "Accept this message request first: writing back on Signal accepts it and shares your profile with them". signal-cli's send turns profile sharing on and carries your profile key, so a reply is an accept; on Signal's apps too. |
| signal-cli by itself | The daemon runs without `--send-read-receipts`, so it sends no read receipts of its own. It sends your profile key on receipt only as a primary device; this one is linked. It does send delivery receipts for every message, as Signal's apps do: the sender sees "delivered" for a message request, never "read". |

Someone who wrote first and has not been looked at yet (signal-cli not read, or the read failed) is treated as a
request by these guards: they wait for that read, and stay quiet if it fails. A group you are only invited to is held
back the same way. After an accept, receipts and typing work normally again. The hub blocks `markRead` and `typing`
for requests too; the adapter does not rely on it.

## What a message carries besides its text

Mapped into `MessageFact.extra` under the keys dither-chat's protocol names (`extra.ts`, `MessageExtra`):

| From signal-cli | Into | Notes |
|---|---|---|
| `quote` (author, text with its ranges, `attachments[].thumbnail`) | `extra.quote` | `replyTo` as before; the thumbnail as a `file://` URL when its file is there |
| `previews[]` | `extra.embeds` (`url, title, description, provider, image`) | http(s) links only; the picture only when it downloaded |
| `contacts[]` (name, phones and emails with their types, addresses, organisation, avatar) | `extra.contacts`, and one line each in the body as before (`line`) | |
| `storyContext`, and a reaction with one | `extra.storyReply` (`author, ts`, `emoji` for a reaction) | a story reaction is a message of its own (its emoji as the body); taking it back does nothing |
| `attachments[].isVoiceNote`, `.caption` | `extra.attachmentNotes`, by position among the files kept | |
| an attachment with no `id`, or whose file is not there | `extra.missingAttachments` (`name, mime, size`) | signal-cli downloads a message's files before it hands the message over, so a file not there failed or was skipped |
| `sourceDevice`, `serverReceivedTimestamp`, `serverDeliveredTimestamp` | `extra.sourceDevice`, `serverReceivedTs`, `serverDeliveredTs` | not for edits |
| a `receive` with an `exception` and nothing readable, from someone else | a system message in your 1:1 with them, "A message from Sam could not be decrypted.", id `<author>:<ts>:undecrypted` | once per message; none for `…Duplicate…` or `SelfSend…` exceptions. The warning is logged as before |
| your `send`'s `results[]` that are not `SUCCESS` (some of a group) | `extra.failed` on the echo (`who, number, reason`) | when nobody gets it signal-cli fails the call, as before |

What you send:

- **Quotes** carry the quoted message as Signal has it: `quoteMessage` with its mentions (`quoteMention`) and styles
  (`quoteTextStyle`), and its files (`quoteAttachment`, `contentType:filename[:preview]`; a picture of 256 KB or less is
  its own thumbnail, a colon in a name becomes `_`). That needs the message seen by this version (the state index keeps
  `q`); older ones keep the plain-text quote. A thumbnail whose file has gone goes without one.
- **Link previews** (`send`'s `preview`, capability `linkPreviews`): `previewUrl/Title/Description/Image`, only while
  your phone's link-preview setting is on and only for a link that is in the text. The picture is copied into
  `attachments/sent-<ts>-preview` for the echo's embed.
- **`viewed`**: `sendReceipt --type viewed` for someone else's message, once per message (in memory), only with read
  receipts on, never in a message request.
- **`resetSession`**: `send --end-session` (`endSession: true`) in a 1:1, and a system line "You reset the secure
  session." (id `<self>:<ts>:endsession`).

## Your phone's settings

signal-cli keeps the configuration your phone syncs in its account database, and no JSON-RPC method reads it (in
0.14.8 `ConfigurationStore` is a key-value store). The adapter opens `<signal-cli>/data/<path>.d/account.db` read-only
(`path` from `data/accounts.json`) and reads `key_value` rows `config-read-receipts`, `config-typing-indicators` and
`config-link-previews` (`readSignalSettings`), at most once a minute and again at every snapshot. A row that is not
there (the phone has not synced it) or a database that cannot be read the old way (a newer signal-cli) is "not known":

| Setting | Off | Not known |
|---|---|---|
| Typing indicators | no `sendTyping` (signal-cli's own `sendTyping` does not check it) | sent, as before and as Signal's default |
| Read receipts | no viewed receipts | no viewed receipts |
| Link previews | no previews, and `linkPreviews` is not advertised | the same |

`linkPreviews` is advertised in `hello` only while the setting is on; a snapshot that finds it changed sends `hello`
again, so the hub stops (or starts) fetching previews for this account.

## People and this device

`src/people.ts` has the helpers; the adapter calls signal-cli. Nothing here retries or acts by itself on someone
else: each change is one call from the owner's click.

| What | How | signal-cli calls |
|---|---|---|
| Safety numbers | Every snapshot (30 minutes) reads everyone's identity key, locally. signal-cli sends no event when a key changes (e12), so a fingerprint that is not the one last seen (`keys` in `state.json`) is a change: a system line "Your safety number with X has changed." in your 1:1 with them, at the time the key came (`addedTimestamp`), and `safety.changedAt` on their profile. The first read changes nobody. Their profile shows the digits, the QR code's bytes (`scannable`, base64) and the trust level. `verify` marks it verified only if the number the owner compared is still the current one ("Their safety number changed since: look again"); `clear` trusts it unverified again. Both leave a line in the 1:1. | `listIdentities`, `trust` (`verifiedSafetyNumber`, `trustAllKnownKeys`) |
| Trust mode | Unchanged: the daemon runs with `--trust-new-identities always` (account config `trustNewIdentities`), as Signal's apps keep receiving from someone whose key changed. `on-first-use` or `never` would hold back messages from anyone whose key changed until it is trusted, and nothing here asks you to: do not set them without building that. | |
| Your list | Contacts (`listContacts` without allRecipients, not hidden) are `contact`, anyone blocked `blocked`: the whole list (`relationships`) once per connection and on every hub reconnect, then `relationship` for each change. A block made on the phone arrives as a sync that makes the next read. | `listContacts` |
| Block, unblock | `block` a person or a group from their profile or the group's About; `remove` with `blocked` unblocks a person, with `contact` takes them off your contacts as Signal's "Remove" does (hidden; the chat and its messages stay). Each refuses when it is not so any more ("That changed; look again"). A group's About says `blocked`. | `block`, `unblock` (`recipient` or `groupId`), `removeContact` (`hide`) |
| Your nickname and note | Identity facts carry `nickname` (Signal's nick given and family names, joined) and `note`, and `displayName` is their own or address-book name without it. An empty one is sent only to clear one the hub was told. `setContact` writes either one alone: a field not given is kept, the family name stays where the phone put it when the new nickname still ends with it, and your phone gets it by storage sync. | `updateContact` (`nickGivenName`, `nickFamilyName`, `note`) |
| Archived 1:1s | A 1:1 archived on the phone has `archived: true` on its conversation fact, `false` when it is not (from `isArchived`); the hub follows it or not (its `followArchive`). Groups have no such field (e4). | `listContacts` |
| Your profile | `setProfile` sends only the fields given: `bio` as `about`, `emoji` as `aboutEmoji`, `name` as given and family names (split as the phone had it), `avatar` a picture file (JPEG, PNG, WebP or GIF) or null to remove it. Your own PersonAbout lists them all as `editable`. | `updateProfile` |
| Your username | `setProfile` `username`: Signal adds the number (`name.42`); null deletes it. The answer's link is kept (`username` in `state.json`) and shown as `username` and a Username link on your profile: signal-cli cannot read the link otherwise (e8), so a username set on the phone shows without one until it is set here. | `updateAccount` (`username`, `deleteUsername`) |
| Devices | The account page's Session lists signal-cli's version, this device (its name and number, from signal-cli's account file) and every linked device, read on start and every 6 hours (a server call). The action `renameDevice` { name } renames this one; `devices` reads them again. | `version`, `listDevices`, `updateAccount` (`deviceName`) |
| Relink | signal-cli 0.14.8 cannot take a linked device off the account: `removeDevice` is primary-only and `unregister` on a linked device only marks it unregistered here. So before wiping, the device is renamed "dither-chat (old)" (best effort; the wipe goes on if that fails) and the link screen says to remove it under Linked devices on your phone; Signal ages it out after about 30 days otherwise. | `updateAccount` (`deviceName`) |
| Sync | Just after linking, or after the daemon was not up for a day, the phone is asked once for contacts, groups and settings (not again within the hour). | `sendSyncRequest` |
| Profile freshness | A profile key update from someone you have a 1:1 with or as a contact reads them again (once in ten minutes at most): their name, About and how you stand. | `listContacts` by ACI |
| Captchas | A send or call that Signal answers with a rate-limit challenge (`RATE_LIMIT_FAILURE` with a token, in the result or in the error's data) makes the account's attention a `captcha` check: `detail.captcha` { url: signalcaptchas.org's page, action: `submitCaptcha` }. The owner solves it in their own browser and pastes the link "Open Signal" points at (the `signalcaptcha://` prefix is taken off); the action sends it with the challenge. Nothing solves it here. | `submitRateLimitChallenge` |

Not built: the privacy settings (`updateAccount --discoverable-by-number`, `--number-sharing`), since signal-cli
cannot read what they are now (e6) and a switch would show a guess; the system contact name (`updateContact
--given-name`), which is your phone's address book's; forgetting a contact (`removeContact --forget`), which drops
what signal-cli knows of them; contact colours, `listContacts --name`, `getAvatar` and the multi-account JSON-RPC
link.

## What only a live account shows

The tests (`test/add.test.ts`) run against `test/fake-signal-cli.ts`. Only a live account can confirm:

- what `getUserStatus` answers for a username nobody has (signal-cli maps the server's 404 to "unregistered"; the
  adapter reads either an unregistered status or such an error as "nobody"), and for a username link;
- that a phone's accept reaches `listContacts` as `profileSharing: true` within the 5 to 30 seconds it waits, and
  that the sync that precedes it is one signal-cli shows nothing of (else the next snapshot finds it, within 30
  minutes);
- that invited members receive the group update that invites them (signal-cli sends updates to members and pending
  members), so `from` is set;
- the exact text of a rate limit and of a captcha challenge from `joinGroup`;
- that `block` works from a linked device (signal-cli 0.14.8's code allows it; its CLI still has an old "doesn't work
  on linked devices" message), and `unblock` and `removeContact --hide` too;
- that `listIdentities` gives a new fingerprint and `addedTimestamp` after someone reinstalls, and `trust` takes the
  digits as it lists them;
- that `updateAccount deviceName` renames a linked device as the phone lists it, and that `listDevices` works from one;
- that `updateContact`'s nickname and note reach the phone, and that the phone's archive shows as `isArchived`;
- the token a real rate-limit challenge carries and where (result or error data), and that `submitRateLimitChallenge`
  takes the pasted captcha;
- that signal-cli 0.14.8 really writes the synced settings into `key_value` as 0/1 on a linked device (read from its
  bytecode, not from a live database), and that a `receive` with an exception carries the sender (the fixture assumes
  it does; with sealed sender failing on the outer layer it may not, and then only the warning is logged);
- what Signal's apps show for a viewed receipt, a quote with mentions and a thumbnail, a link preview and an end
  session sent from here.

## Polls and pins

signal-cli 0.14.8 sends what a linked device needs, and dither-chat's docs/polls.md has the model.

- A poll (`pollCreate`) comes on its message as `extra.poll`, its options numbered by position, as votes name them.
- A vote (`pollVote`) is the voter's whole vote: their options and the vote's number (`voteCount`). The adapter sends
  it as a `pollUpdate` with `vote`. The hub keeps each voter's highest number, as Signal's apps do. Signal shows every
  member who voted for what, so the voters are kept.
- `pollTerminate` is a line ("Sam ended the poll.") and closes the poll.
- `pollVote` sends `sendPollVote` with the options' positions and a `voteCount` one higher than your last vote on that
  poll (the hub's `seq`, or this run's). `pollCreate` sends `sendPollCreate`; Signal's polls have no timer. `pollEnd`
  sends `sendPollTerminate`, for your own polls only.
- Pins: `configure` with a `pin` change sends `sendPinMessage` (`pinDuration`: 1 day, 1 week, 30 days, or -1 for good;
  a day when none is chosen) or `sendUnpinMessage`. A pin that ends is unpinned here when its time comes, like one
  that came in. The About's `pinned` has no messages, because signal-cli keeps no list a linked device can read; the
  hub adds the pins it saw. In a group, whoever may send may pin. That rule is our reading: Signal does not say.
- All of these are refused in a message request (see above).

Not checked live: the durations Signal's apps offer (taken as 1 day, 1 week and 30 days), what they show for a vote
whose count is not higher, and whether a linked device's pins and polls show on the phone as these fakes assume.

## Stickers, voice notes, view-once and stories

dither-chat's `docs/media-kinds.md` has the app's side; this is what the adapter does on Signal. Advertised:
`sendStickers`, `installStickers`, `sendVoice`, `sendViewOnce` and `stories`.

- **Stickers.** `stickers` lists the installed packs (`listStickerPacks`, packs seen but not installed left out), a
  page at a time; each sticker's picture is `stickers/<pack>/<id>` under signal-cli's directory, and `fetchMedia` asks
  `getSticker` for one not downloaded yet. `send` with `sticker` (`packId:stickerId`) is `send --sticker`, shown here
  as the sticker. `addStickerPack` takes a signal.art link only (checked before signal-cli is called) and reads the
  pack back from the list.
- **Voice notes.** A send whose one file carries `voice` is `send --voice-note`; the message's copy here is marked as
  one.
- **View-once.** `send` with `viewOnce` is `send --view-once`; no copy of the file is kept here, and the message is a
  placeholder, as Signal's apps show your own. An incoming view-once message stays a placeholder, and **the file
  signal-cli downloaded for it is deleted from disk as soon as the message is mapped** (`MapResult.discard`).
- **Stories.** Off unless the owner turns them on: the account action `stories` (`{ on }`) keeps the choice in
  `state.json`, and the daemon reads it **when it starts**: off, it runs with `--ignore-stories`; on, without. A change
  does not restart anything; the action's answer says whether the running daemon has stories (`running`). With them on,
  a contact's or group's story (`storyMessage`) and one you posted from your phone (`syncMessage.sentStoryMessage`)
  become `story` events, never messages, ending a day after they were posted; a picture's or video's file is deleted
  then (`state.json` `storyFiles`, swept with disappearing messages). Colours come from signal-cli as `#AARRGGBB` and
  go out as CSS `#RRGGBBAA`. `storyViewed` sends a viewed receipt only with read receipts on in the phone's settings,
  never to someone whose message request waits (the quiet rule above), once per story. `storyReply` is `send
  --story-timestamp --story-author` (or `sendReaction --story` with an emoji), in the author's 1:1 or the group of a
  group story, refused in a message request.

Only a live account can confirm: that a viewed receipt for a story is what Signal's apps send for one, that a story
reply shows on the phone as a reply to that story, that `getSticker` answers `{ data }` over JSON-RPC as on the CLI,
that `addStickerPack` takes `uri` as a list over JSON-RPC, and that an Ogg Opus voice note plays on an iPhone.

## Calls

`callStates` (src/calls.ts): what a linked device already receives, nothing asked. An offer is a call ringing you; the
caller's hangup to your other devices says how it went (answered, declined or busy on another device, or missed), and
once an answered call is hung up, how long it lasted. The offer's line is worded again as the call ends. dither-chat's
docs/calls.md "Ringing" has the hub's side.

Not `subscribeCallEvents`, `rejectCall`, `startCall` or `acceptCall`: signal-cli 0.14.8 tracks a call only while
subscribed to call events, and then spawns `signal-call-tunnel` for every incoming offer. The nix build ships none, the
spawn fails, and signal-cli hangs up on the caller (`endCall` 'tunnel_spawn_error'): every call would end on the phone
too. Calls from here go through Signal Desktop instead (next section).

## Calls through Signal Desktop

With the account's **calls** setting on (off by default: `bun packages/manager/src/cli.ts set <account> calls on`, or
`PATCH /api/accounts/<id>` with `{"settings": {"calls": true}}`; the extractor restarts to take it), the extractor runs
Signal Desktop as the account's calls body: the official app, linked as one more device of the account, in the
account's own sandbox ([native-sandbox.md](native-sandbox.md)) with audio devices of its own, and a hook of ours inside
its window. signal-cli goes on doing everything else; Desktop is only used for calls. dither-chat calls through it in
bridge mode, the same way it calls through Discord's client (dither-chat's docs/calls.md, "Video (bridge mode)").

**Linking it.** On an account whose primary is a phone, the account's status gets a `calls` layer, "link Signal
Desktop: scan the code in the live view with Signal on your phone (Settings → Linked devices)", and the live view is
Desktop's display. On an account whose primary is signal-cli itself (a number registered here, like a test account),
the extractor links Desktop with signal-cli's `addDevice` and the code Desktop shows, with nobody involved. Desktop's
data is `<account>/desktop/home/.config/Signal`. It runs with `--password-store=basic`, because the sandbox has no
keyring and Signal would wait for one, so its database key is kept as signal-cli's keys are: in the 0700 account
directory.

**What it advertises**, only while Desktop is linked and its hook is connected (the hello goes out again when that
changes): `calls`, `declineCall`, `ringCalls` and `callVideo`, beside `callStates`.

**How the hook gets in.** nixpkgs runs Signal Desktop on its own Electron (`electron app.asar`), so the extractor runs
`electron -r hook/main.cjs app.asar`. `main.cjs` adds `hook/preload.cjs` to the app's sessions, so it runs in Signal's
own preload world, beside the app's code, with the same `window.reduxActions` and `@signalapp/ringrtc` its buttons use
(required from the same `app.asar`, so it is the same module instance). Nothing is patched on disk and no debugging
port is opened. The hook talks to the extractor over one Unix socket in the sandbox's runtime directory, bound into the
sandbox, one JSON object per line.

| What | How |
|---|---|
| start a call | `calling.startCallingLobby`, then `calling.startCall` with the lobby's call mode (groups: `setOutgoingRing` first, when the device asked to ring) |
| answer (a `join` while it rings here) | `calling.acceptCall` |
| decline | `calling.declineCall` |
| leave, mute | `calling.hangUpActiveCall`, `calling.setLocalAudio` (deafen: the mix to the device is cut) |
| camera on or off | `calling.setLocalVideo`; when Signal then asks `getUserMedia` for a camera, it gets the device's camera from the bridge |
| share a screen | `calling._setPresenting(source, stream)` with the device's screen (and its sound) from the bridge; off: `cancelPresenting` |
| the device's microphone | played into the `mic_in` sink; its monitor is `device_mic`, the sandbox's default source, which RingRTC records |
| the call's audio | RingRTC plays into `call_out`, the default sink; the hook records its monitor (`call_mix`, no echo cancelling, gain control or noise suppression) and sends it on mid 0 |
| others' video | each frame Signal's own call view pulls from RingRTC (`Call.receiveVideoFrame`, `GroupCall.getVideoSource`) is copied to a canvas of its own, whose stream goes on one of the bridge's video slots (mids 4–7, screens first); CallState.video says whose |
| the call's state | read from the store four times a second: participants (ACIs) with mute, speaking (audio level over 0.05), camera and screen; `self.connected` once Signal's own call is connected (direct: `connected`; group: connected and joined) |
| group rings | a group call ringing this account (`ringId`, not yet joined) is a `callState` fact `ring:<ringId>`; signal-cli does not see these. 1:1 rings stay signal-cli's (above) |

In the sandbox the hook allows Signal's own microphone and camera settings, since there they always mean the device's.

**When Desktop's window fails.** A crashed renderer is loaded again by `main.cjs`. A window that hangs first has its main
thread paused once through Electron's debugger, and where it stood (function names, files and lines; never a value) is
written to `~/dither-hang.json` in the sandbox, which the extractor logs as "Signal Desktop hung" when the hook goes. A
call through Desktop ends for the device as soon as the hook goes ("Signal Desktop stopped"), and a Desktop whose hook
has not come back after 45 s is started again. The copy of others' video keeps to the largest size Signal pulled in the
last second, because Signal's call view can pull one screen share at two sizes, and a canvas resized on every frame
restarts the encoder behind it each time.

**Measured** (one machine, 2026-11-15):

- Desktop idle, linked, in the sandbox: about 470 MB resident and under 1 % of a core. Started with
  `--password-store=basic` it is up in about a second; without it, it waits about 50 s for a keyring.
- A 1:1 call from the test account to a phone, answered on the phone: the bridge's answer reaches the device 0.25 s
  after its offer. Audio and video went both ways (heard and seen on the phone; the phone's camera and voice reached the
  device). The phone's video arrived at the device at 176 to 528 pixels wide.
- Two accounts here, each with Desktop as its calls body, called each other through dither-chat with a headless
  device on each end (dither-chat's two-device call lab), with no phone involved: the ring was answered and both sides
  were connected in 3–5 s. Audio went both ways in every phase. Cameras went both ways, ramping from 240×180 to
  720×540 at about 20 fps. Screen sharing worked both ways (an 800×450 tab, seen at the far end).
- With a phone on mobile data, the phone's own answer capped the call at 300 kbit/s, and its video came through at
  under 1 fps. Once in that call, the phone's voice faded at the device a few seconds after the answer although
  RingRTC received it; this was not seen again between the two accounts here. Each call logs its media every 5 s
  (`[desktop] call media`: the call mix's level, the tracks, frames per remote), which is where to look if it is.

**A calls-only account for the call lab.** To test calls between two Signal accounts automatically, the way
dither-chat's call lab does for Discord, a lab manager can hold an account in calls-only mode: config `callsOnly: true`
and `peers`, a list of ACIs. It runs Signal Desktop alone, without signal-cli, so the real account it is linked to gains
exactly one linked device. Nothing of the account's messages, contacts or groups goes to the hub. The hub hears only who
this account is, and a 1:1 with each peer (named as Signal names them). It advertises `callStates` and the call
capabilities, nothing else. Desktop itself still receives what any linked device receives, in its own database in
the lab's account directory. Delete that directory and unlink the device (on the phone: Settings → Linked devices) when
the lab is done.

**Why Desktop, and not the others** (weighed for this, 2026-11-14):

| | signal-cli + `signal-call-tunnel` | Signal Desktop in the sandbox | Android app in the emulator |
|---|---|---|---|
| 1:1 voice | yes | yes | yes |
| video | no: signal-cli always offers `AUDIO_CALL`, and the tunnel drops incoming frames and feeds no outgoing ones | yes | yes, but video in needs v4l2loopback (a kernel module) or a file, and video out is only a screen capture |
| group calls | no: `startCall` takes one recipient; the tunnel's group handling does nothing | yes | yes |
| media taps | per-call PulseAudio devices | PulseAudio devices of the sandbox's own, and video frames in the renderer | the emulator's gRPC audio in and out; camera by v4l2 or file |
| packaging here | not in nixpkgs; builds against a prebuilt WebRTC download, but a nested cargo build stalled in a first attempt | nixpkgs `signal-desktop` | the SDK's emulator needs an FHS environment on NixOS; the image has no Play services |
| cost | small (estimated) | 470 MB idle, measured | 2.5–3.5 GB and 1–2 cores in a video call (estimated, not booted) |
| risk to the account | signal-cli ends any call it gives up on with a hangup to the caller (tunnel error, daemon restart, 60 s of ringing), which ends the call on the caller's side | the official client, one more linked device | a whole phone to keep registered |

The tunnel is [signal-call-tunnel](https://github.com/visigoth/signal-call-tunnel) (RingRTC 2.65); signal-cli added
calls in 0.14.2 ([CHANGELOG](https://github.com/AsamK/signal-cli/blob/master/CHANGELOG.md)) and has an open request
for video ([#1735](https://github.com/AsamK/signal-cli/issues/1735)).

## Not built

- Resending a group message to only the members it missed: signal-cli cannot send to part of a group.
- `send --no-urgent`: nothing in dither asks for it yet.
- Posting your own stories (`sendStory`), deleting one (`sendAdminDelete --story`) and making sticker packs
  (`uploadStickerPack`): see Stickers, voice notes, view-once and stories.
- Declining a message request on the phone is not seen: signal-cli 0.14.8 does not handle the phone's "delete"
  response, so the request stays here until answered here.
- Message requests from before this version of the adapter: only those still unread at the upgrade are found; the
  rest show once the person writes again.
