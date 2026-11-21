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
  fields (`setProfile`); invisible mode (`setPresence`); muting a person (`ignore`).
- **Starred messages** are saved messages. **Scheduled messages** and **reminders** are the hub's native scheduled
  sends. Group DMs are made by sending to several people (`createGroup`; they have no name).
- **Search**: Zulip's own full-text search, by narrow.

Not done: calls (Zulip hands them to Jitsi or Zoom), read receipts (Zulip's are per message and opt-in, not pushed
on the event queue), drafts, saved snippets, channel creation and organization settings beyond name and description.

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
