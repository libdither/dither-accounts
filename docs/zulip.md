# Zulip

A Zulip account runs here as the extractor `extractors/zulip` (kind `zulip`, interface `chat`): one person's account
on one Zulip server (Zulip Cloud or a self-hosted one), spoken to over Zulip's own REST API and event queue with plain
fetch. No browser, no bot account, no library. dither-chat's hub reads it like any other chat account.

Written against Zulip 13.2 (API feature level 517) and tested on a real server of that version
([testbed](#testing)). Older servers are not tested; where a feature needs a newer server (history from a date needs
feature level 445) it falls back or is left out.

## Adding one

On the manager's page (or dither-chat's **Add account → Zulip**):

| field | what |
|---|---|
| `server` | the organization's address, `https://chat.example.org` (with or without `https://`; a path is kept) |
| `email` | the address you sign in with |
| `apiKey` | your API key: **Settings → Account & privacy → API key** in Zulip's web app (secret) |
| `password` | or your password, used once (secret) |

Give the API key or the password. A password is swapped at once for the account's API key (`POST /fetch_api_key`), the
key is kept in the account's secret, and the password is dropped from it. A password does not work on servers that sign
in only through SSO or a social login: use the API key there. A wrong key or password puts the account in attention
(`login`) and nothing is retried until it is changed.

Actions (`action` op): `resync` drops the event queue and reads everything again; `relogin` signs in again with the
secret as it now stands.

## How Zulip is shown

| Zulip | the hub | native id |
|---|---|---|
| the organization | a space (`community`) | `<host>` |
| a channel folder | a section under it | `<host>/f/<folder id>` |
| a channel you are subscribed to | a conversation, `shape: 'channel'`, `variant: 'forum'` | `<host>/s/<channel id>` |
| a topic | a thread whose parent is its channel | `<host>/s/<channel id>/t/<topic, lowercased, URI-encoded>` |
| a direct message, 1:1 / group / to yourself | `direct` / `group` / `self` | `<host>/dm/<user ids, you included, sorted>` |
| a person | an identity | `<host>/u/<user id>` |
| a message | a message | `<host>/m/<message id>` |
| a user group (for mentions) | a role | `<host>/g/<group id>` |

`<host>` is the server's host (and port). Topics are case-insensitive in Zulip, so their ids are lowercased and the name
shown is the latest spelling seen. A channel takes no messages of its own: open a topic, or write one to start a new
topic (`createPost`). The empty topic ("general chat") is the topic whose name is empty.

A person's handle is their real address where you may see it (`delivery_email`), else the API's `email`, unless that
is Zulip's stand-in (`user8@chat.example.org`, where the organization keeps addresses from members): then none.

## What it does

- **Messages**: start with the newest 300 and every unread message (up to 2000), then history by message id on
  request (`history`, also from a date with `anchor=date`). Sent as Zulip Markdown: mentions, user group and wildcard
  mentions (`@everyone` is `@**all**`, `@here` is `@**topic**`), channel and topic links, `<time:>` stamps, spoilers,
  quotes, `/me`. Zulip's Markdown is turned into the hub's on the way in (`src/markdown.ts`), code left alone.
- **Replies**: Zulip has none of its own. A reply is sent the way the web client writes one: an `@_**Name|id** [said](link):`
  line and a quote, and a message that starts that way is read back as a reply to the linked message, without the quote.
- **Edits, deletes, moves**: content edits, which keep what the hub's copy never held (the reply's quote, uploads,
  silent mentions staying silent); a topic rename or a move to another topic or channel moves the messages
  (the hub's `MessageFact.moved`); resolving a topic (`✔ ` in front of its name) shows as the thread being closed.
  `redact` deletes, where the server lets you.
- **Uploads**: files linked from `/user_uploads/` are attachments, fetched with your key through `fetchMedia`
  (`zulip:/user_uploads/...`); sending media uploads first (`POST /user_uploads`) and links the file.
- **Reactions**: unicode emoji by Zulip's name for them, custom (`realm:<id>`) and Zulip's own (`zulip:<code>`);
  any number per person. Who reacted comes with each message; Zulip gives no time per reaction.
- **Polls and to-do lists**: Zulip's widgets (`/poll`, `/todo`). A poll is a hub poll (votes changeable, several per
  person, options added later shown); voting sends the widget's own submessages. A to-do list is shown as its tasks with
  ☑ and ☐.
- **Read state**: unread counts and mentions per topic and DM from `/register`, then `update_message_flags`; mark
  read up to a message (`markRead`, `markReadMany`), mark unread, typing both ways.
- **Topics**: follow, unfollow, mute and unmute a topic (`user_topics`), list a channel's topics (`threads`; resolved
  ones are its archived list), rename and resolve one (`configure`, `threadState`). A topic not seen since start is
  looked up before anything is sent to it, so its capitals stay as Zulip has them.
- **Channels**: about (description, who may post, privacy, history, subscribers), join one by name, link or
  `#name` (`resolve`, `add`), leave, mute, invite people, and an admin's settings (`configure`).
- **People**: profiles with custom profile fields, pronouns, time zone, status; your own name, avatar, status and
  fields (`setProfile`); invisible mode (`setPresence`); muting a person (`ignore`). A profile names the organization
  (`mutualSpaces`) with their role first, then the user groups they are directly in, by name (not the system
  `role:…` groups, nor deactivated ones); a walk of the members (`walkMembers`) gives the same roles. A person field
  and a bot's owner are facts with the people's ids (`facts[].people`), so the app links them; a date field reads as
  "March 5, 1990"; an external account field links through its `url_pattern` (or GitHub's and X's own); a custom
  status emoji is `:name:` with its picture (`status.emojiUrl`).
- **Presence**: everyone's at start (offline too, so nobody stays online in the hub from before), then as it changes.
  Zulip's event says only when someone comes online; its apps read everyone's times again each ping interval and
  work out idle and offline from them, after the server's `server_presence_offline_threshold_seconds`. The extractor
  does the same: `GET /realm/presence` each `server_presence_ping_interval_seconds` (one request a minute; reading
  it does not change your own presence), and a look every 15 s for whoever aged past the threshold.
- **Roles**: a new role in the organization (member → administrator) is a role lost and one given (`role`); joining or
  leaving a user group is that group's role given or lost, as Discord's roles are; a new group is given to the people
  it was made with, and a group deactivated (or back again) is lost (or given) by everyone in it.
- **Read receipts** for your own messages in DMs and group DMs, where the organization has them on (Zulip 6.0+). Zulip
  sends no event for them, so the extractor asks (`GET /messages/{id}/read_receipts`) about your newest message in each
  DM 30 s, 2 min, 10 min and 1 h after you sent it, and again a few seconds after someone there writes or starts
  typing; each person is said once (`receipt`, `read`), at the time it was learned, and the DM is let go once everyone
  read it. At start, your newest message in each DM from the last day is asked about once. At most 20 asks a minute.
  Not in channels (a topic's readers can be hundreds). "Read" is Zulip's: marking a conversation read counts, and
  someone who turned off "Let others see when I've read messages" is never said.
- **@all and @topic** are offered in the @ picker (the hub's @everyone and @here) in a channel of up to 15 subscribers,
  or a bigger one if you are in the organization's `can_mention_many_users_group`, as Zulip itself allows.
- **Starred messages** are saved messages. **Scheduled messages** and **reminders** are the hub's native scheduled
  sends. Group DMs are made by sending to several people (`createGroup`; they have no name).
- **Search**: Zulip's own full-text search, by narrow.

Not done: calls (Zulip hands them to Jitsi or Zoom), read receipts in channels, drafts, saved snippets, channel creation and organization settings beyond name and description.

## Rate limits and the event queue

Zulip allows about 200 requests a minute per user. The extractor keeps `X-RateLimit-Remaining` and `-Reset` from
every answer and, below a small reserve, waits for the reset; a 429 is waited out as its `Retry-After` says, once. The event queue is long-polled (`GET /events`); a queue the server forgot
(`BAD_EVENT_QUEUE_ID`, after a server restart or a long sleep) is registered again, and the structure and the newest
messages are said again so nothing in between is lost: messages deleted or moved meanwhile are deleted or moved here
too, as far back as the newest 300. The event poll goes on when the budget runs low (only a 429 holds it); other
requests wait for the window's reset. At start, channels with something among the newest messages get their topics
before the account is online, the rest just after, so a big organization is not held back.

## Testing

- `bun test extractors/zulip/test/`: Markdown both ways, widgets and emoji, and the adapter against a fake server
  (`test/fake-zulip.ts`: start, live events, a lost queue, commands).
- `extractors/zulip/testbed/`: a real Zulip 13.2 in rootless podman, seeded with invented people and traffic
  ([its README](../extractors/zulip/testbed/README.md)); `testbed/drive.ts` runs the extractor against it end to end.
