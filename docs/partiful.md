# Partiful: the `partiful` kind

`extractors/partiful` holds one Partiful account: **Explore** for a city (trending events and the site's sections, as
the Home feed `explore`), **your events** (going, hosting, invited, been to; the Home feed `following`), any event as a
post with its hosts, the guests the site shows and your mutuals, each of your events' **comments, host messages and
album** as a conversation, your **chats** (direct and group, through Stream as the site's own chat does), your
**notifications** as one read-only conversation, and anyone's profile. When asked, it comments and answers comments,
reacts to comments, host messages and chat messages, sends chat messages, marks a chat read, and, at the `manage`
level only, RSVPs. It answers the `chat` interface (docs/chat.md), events in the shape the wire contract gives them
(`PostFact.event`, packages/chat-protocol/src/feed.ts).

Partiful has no public API. The kind runs partiful.com in a sandboxed browser (packages/browser: Xvfb, Chromium with
our extension, x11vnc for the live view, as for Substack and X), and every call is one the site's own pages make, from
inside its page with its sign-in.

## Adding it, and what you do

On the accounts page, **Add → Partiful**: a name and, if you like, a **city** as Partiful spells it in its Explore
links (`sf`, `nyc`, `la`...). The city is a setting you can change later on the account's card (or
`cli.ts set <account> city <slug>`); without one, Explore is the site's own front page of trending cities.

The account says **Sign in to Partiful in the live view (Explore works meanwhile)**. Open the live view and sign in as
on your phone: the texted code, and any check the site shows (those are yours; nothing here answers them). It goes
online once the page holds a signed-in user. Signed out, Explore and public events still work.

## What partiful.com is (read from its bundles as of November 2026, signed out)

A Next.js site (pages router). `/explore/[region]` is a static page (`gsp`), so `__NEXT_DATA__` on the page carries
its data, and `/_next/data/<buildId>/explore/<city>.json?region=<city>` is what the app fetches moving between pages;
the build id is `window.__NEXT_DATA__.buildId`.

Everything else is Firebase: the signed-in user lives where the Firebase SDK keeps it (IndexedDB
`firebaseLocalStorageDb`, store `firebaseLocalStorage`, key `firebase:authUser:<apiKey>:[DEFAULT]`, a `uid` and an ID
token in `stsTokenManager`), and the reads and writes are Cloud Functions called through `httpsCallable` on the custom
domain `api.partiful.com`: `POST /<name>` with `{data: {params, paging?, userId, client: 'web'}}` and
`Authorization: Bearer <ID token>`, answered `{result: {data, paging?}}`.

Chats are Stream Chat: the function `getStreamUserToken` gives a token, and the page talks to
`chat.stream-io-api.com` with it (`?user_id=&api_key=`, `Authorization: <token>`, `stream-auth-type: jwt`).

### The calls this kind makes

| What | Call | Params (as the site's bundle builds them) |
| --- | --- | --- |
| Explore | `/_next/data/<build>/explore[/<city>].json`, else the page's `__NEXT_DATA__` | `region` |
| An event | `getEventInfo` | `{eventId}` |
| Who is going | `getGuests` (only when the list is shown) | `{eventId, includeInvitedGuests: true}`, paging `{cursor, maxResults: 500}` |
| Mutuals | `getMutualGuests` (signed in, list shown) | `{eventId}` |
| Comments | `getEventComments` | `{eventId}` |
| Host messages (blasts) | `getEventDisplayedHostMessages` | `{eventId}` |
| Album | `getEventMedia` | `{eventId}` |
| Your events | `getMyUpcomingEventsForHomePage` | `{}` |
| Notifications | `getNotifications` | `{cursor: {startAfterMs, startId}}`; the first page is `startAfterMs` = now, no `startId` (without a time it answers 500 INTERNAL) |
| People | `getUsers` | `{ids, includePartyStats}` |
| Comment | `createComment` | `{id, eventId, message, replyTo?, timezone, mentions}` |
| React | `updateCommentReaction`, `updateHostMessageReaction` | `{eventId, commentId \| hostMessageId, reaction: {emoji, active}}` |
| RSVP | `addGuest` | `{eventId, rsvp: {status, count: 1, message?}}` |
| Chat token | `getStreamUserToken` | `{}` |
| Chats | Stream `POST /channels` | `filter_conditions {type: 'messaging', members: {$in: [me]}}`, newest first |
| A chat | Stream `POST /channels/messaging/<id>/query`, `/message`, `/read` | as the chat page |
| Chat reactions | Stream `POST /messages/<id>/reaction`, `DELETE /messages/<id>/reaction/<type>` | |

Pictures (`fetchMedia`) come only from Partiful's own storage (firebasestorage, storage.googleapis.com,
assets.partiful.com) and Stream's CDN, fetched without credentials.

### Never called

Anything that marks notifications read, anything that invites, hosts, edits or cancels an event, `getRooms` and
`markRoomSeen` (those are Partiful's community rooms, not chats), and every sign-in, sign-up or account setting call.

## The hidden guest list

A host can hide who is going (`displaySettings.showGuestList` false). The site still answers `getGuests` for such an
event, with the names blanked but each guest's RSVP history, times and notes in it. So:

- when the list is not explicitly shown, `getGuests` and `getMutualGuests` are **never called** for that event, and
  the post carries only the count the site shows (`guestsShown: 'count'`, or `'hidden'` when the count is hidden too);
- for a shown list, the hook strips every row's `rsvpHistory`, `rsvpDate`, RSVP message and image, `invitedBy`,
  questionnaire answers and plus-ones before the answer leaves the page; only who, and their status, go on;
- every event post passes through the protocol's `withoutHiddenGuests` on its way out, as the hub does again on its
  side.

extractors/partiful/test/map.test.ts proves the mapping never reads a hidden event's rows (a trap on them), and
test/partiful-browser.test.ts that no such call is made and no note reaches an app.

## How it maps

- **Events → posts.** Each event is a `PostFact` with `event`: start and end, timezone, place (the site's own wording;
  a full address only when it shows one), hosts, counts, `guests` (the shown list, then mutuals), `guestsShown`, your
  `rsvp` (signed in only), `hosting`, `conversation` (`event:<id>`, when you are in it) and an `.ics` link. Hosts and
  the guests it names go out as identity facts first, keyed by Partiful user id.
- **Home.** `explore`: trending, then each section, then the rest of the feed, each event once, a page of 20 at a time
  (cursor `o<offset>`), its section as the item's `reason`. `following`: your events, upcoming soonest first, then
  past ones, latest first. `foryou` is refused.
- **Event conversations** (`event:<id>`, a group): comments (`c:<id>`, answers as replies), host messages (`h:<id>`,
  `extra.blast`), album photos (`m:<id>`, as media).
- **Chats** (`chat:<channel id>`): direct when there are two members, otherwise a group; messages `s:<id>`. A Stream
  user is keyed by the Partiful id it carries, else as `stream:<id>`.
- **Notifications** (`feed`, read-only): each a system message from whoever caused it, or from Partiful.
- **Profiles**: name, picture, bio, socials as links, parties hosted and attended.
- **RSVP** is the action `rsvp` (`{eventId, status: going | maybe | declined | interested, note?}`) at `manage`; it
  answers with the event re-read.

## Pace and what it never does

Reads go one at a time, 1.5 to 4 s apart; writes 1.2 to 2.1 s apart. The periodic read (notifications, your events,
chats, and two upcoming events' comments in turn) runs every 4 to 8 minutes. A 429 stops every read for 10 minutes,
doubling to an hour, and says so in the status; a page asking for a check stops it until you clear it in the live view.
It never solves a check, never signs in or up, and never marks notifications read.

## Status

Layers: display, browser, extension, signed in, notifications. Signed out: attention `login`. A check: attention
`captcha`. A 429: `rate_limited` until the wait ends.

## Tests

- extractors/partiful/test/map.test.ts: the mapping, from invented fixtures (extractors/partiful/test/fixtures.ts).
- test/partiful-browser.test.ts: the extractor in a real manager and Chromium against test/fake-partiful.ts, signed out
  then signed in: Explore and paging, your events, a shown and a hidden guest list, comments, reactions, chats, the
  RSVP refused below `manage`, a profile, pictures, a 429. Skipped without Xvfb, Chromium and x11vnc.

## Not yet seen on a signed-in account

Read from the bundle, not yet from a live answer: `getEventMedia`'s answer shape, what `createComment` answers,
which `rsvp` fields `addGuest` needs beyond status and count, and whether Stream users carry their Partiful id (if not,
a chat's people stay `stream:<id>` and are not matched to event guests).
