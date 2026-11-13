# Signal

A Signal account runs here as the extractor `extractors/signal` (kind `signal`, interface `chat`): this machine
linked as another device of your phone's Signal account, through [signal-cli](https://github.com/AsamK/signal-cli)
0.14 (`signal-cli daemon --socket`, JSON-RPC). Adding one and what the process needs are in [chat.md](chat.md).
This page is about adding on Signal: dither-chat's Add (its `docs/add.md`), with the requests waiting on you, and
about keeping a message request quiet.

## What it advertises

`resolve`, `join` and `requests`, with `openDirect` for Message. Not `connect`: Signal has no friend requests,
follows or contact requests. You add someone by writing to them.

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

Native ids: `invite:<groupId>` and `message:<peer ACI>`. Each offers accept, decline and block. The whole list
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
  signal-cli 0.14.9 shows no message-request event, so: someone new who writes is read once (`listContacts` by ACI, no
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
| `send`, `react`, `edit`, `redact`, `configure` (the disappearing timer) | Refused with "Accept this message request first: writing back on Signal accepts it and shares your profile with them". signal-cli's send turns profile sharing on and carries your profile key, so a reply is an accept; on Signal's apps too. |
| signal-cli by itself | The daemon runs without `--send-read-receipts`, so it sends no read receipts of its own. It sends your profile key on receipt only as a primary device; this one is linked. It does send delivery receipts for every message, as Signal's apps do: the sender sees "delivered" for a message request, never "read". |

Someone who wrote first and has not been looked at yet (signal-cli not read, or the read failed) is treated as a
request by these guards: they wait for that read, and stay quiet if it fails. A group you are only invited to is held
back the same way. After an accept, receipts and typing work normally again. The hub blocks `markRead` and `typing`
for requests too; the adapter does not rely on it.

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
- that `block` works from a linked device (signal-cli 0.14.9's code allows it; its CLI still has an old "doesn't work
  on linked devices" message).

## Not built

- Join requests to groups you admin (`requestingMembers` of your own groups): a `join` request kind for later.
- Declining a message request on the phone is not seen: signal-cli 0.14.9 does not handle the phone's "delete"
  response, so the request stays here until answered here.
- Message requests from before this version of the adapter: only those still unread at the upgrade are found; the
  rest show once the person writes again.
