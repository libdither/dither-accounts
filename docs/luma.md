# Luma: the `luma` kind

`extractors/luma` holds one Luma account: **Explore** (the events Luma lists for a city, signed in or not), **your
events** (going, hosting, invited; upcoming, then past), any event's page with **who is going** as far as Luma shows
you, people's profiles, your **notifications** as one read-only conversation, each event's **blasts** (its host's
announcements), and Luma's **chats** (event chats, direct and group) with send, reactions and read marks. When asked,
it RSVPs: the event page's one-click **Register**, or **Not going**. It answers the `chat` interface (docs/chat.md) for
dither-chat's Feed and Events pages, with the event fields chat-protocol's `EventFact` names (feed.ts).

Luma has no public API for a guest. The kind runs luma.com in a sandboxed browser (packages/browser: a screen of its own
on either display backend, Chromium with our extension, the live view, as for Substack and Reddit; docs/browser.md
"Display backends"), and every read and write is a call Luma's
own web app makes, from inside its page with its session, built the way the web app builds it.

## Adding it, and what you do

On the accounts page, **Add → Luma**: a name, and an optional **City**, a Luma discover place's slug as in
`luma.com/<slug>` (`nyc`, `london`, `tokyo`), or its name; it can be changed later under the account's settings (or
`cli.ts set <id> city <slug>`; `""` clears it). With no city, Explore is the place Luma picks for you (its discover
page's featured place).

The extractor starts a sandbox and opens luma.com/home. Explore works at once: Luma's discover calls answer anyone.
For the rest the account says **Sign in to Luma in the live view**. Open the live view and sign in as on your desktop:
the emailed code, a passkey, Google, whatever Luma shows (codes, captchas and Cloudflare checks are yours; nothing here
answers them). It goes online once `GET /user` answers with you.

## What luma.com is (read from its bundle as of November 2026, signed out)

luma.com is a Next.js app (built with Turbopack: `/_next/static/chunks/<hash>.js`), React. Everything it shows comes
from JSON calls to **`https://api.luma.com`**, made by one API client class. A GET puts its arguments in the query
string (null and undefined left out); a POST sends them as JSON. Every call goes with `credentials: 'include'` (the
session is the cookie `luma.auth-session-key`, on `.luma.com`) and these headers:

- `x-luma-client-type: luma-web`
- `x-luma-client-version`: the build's own (`<date>|<sha>`)
- `x-luma-web-url`: the page's origin and path
- `x-luma-previous-path`, `x-luma-document-referrer`
- `x-luma-timezone`: the browser's zone
- `accept-language`

An error answers `{ message, code? }`. `ADDITIONAL_VERIFICATION_REQUIRED` asks for a Turnstile check. Cloudflare in
front of both hosts can answer a 403 or 503 page instead (with `cf-mitigated: challenge`).

The hook (`src/extension/hook.js`) builds the same calls with the same headers. It learns the build's
`x-luma-client-version` and `x-luma-previous-path` from the page's own API calls as they go by, and sends nothing
until the extractor has told it its settings.

Realtime chat goes over Centrifugo (`wss://cent.luma.com`, tokens from `/centrifuge/get-channel-token(s)`). The kind
does not open that socket: it polls the same sync calls the chat page makes when it loads (below).

### The calls this kind makes

| what | call | read from |
|---|---|---|
| you | `GET /user` → `{ user }`; 401 signed out | the session hook every page mounts |
| the discover page | `GET /discover/bootstrap-page` → `{ places: [{ place }], featured_place: { place }, calendars, categories }` | `/discover`'s data loader |
| a city by its slug | `GET /url?url=<slug>` → `{ kind: 'discover-place', data: { place, events } }` | the catch-all page resolving `luma.com/<slug>` |
| a city's events | `GET /discover/get-paginated-events {discover_place_api_id, pagination_cursor?, pagination_limit: 25}` → `{ entries, has_more, next_cursor }` | the place page's event list (its infinite query, limit 25) |
| an event's page | `GET /event/get {event_api_id}` → the listing entry plus `description_mirror`, `guest_data`, `ticket_types`, `registration_questions`, `categories`, `event_invite`, `sold_out` | the event page's loader |
| who is going | `GET /event/get-guest-list {event_api_id, ticket_key, pagination_cursor?, pagination_limit: 100}` → `{ entries: [{ api_id, user, section_label? }], has_more, next_cursor }` | the guest list modal (a guest's own `ticket_key` from `guest_data`) |
| an event's blasts | `GET /event/get-blasts {event_api_id}` → `{ blasts: [{ api_id, sent_at, subject, content_text, user? }] }` | the event page's Updates for a guest |
| add to calendar | `GET /event/get-calendar-urls {event_api_id, proxy_key}` → `{ targets: [{ type, url }] }` | the Add to Calendar menu (a guest's `proxy_key` from `guest_data`) |
| your events | `GET /home/get-events {period: 'future' \| 'past', pagination_cursor?, pagination_limit}` | Home's Upcoming and Past tabs |
| notifications | `GET /notifications/list {pagination_cursor?}` → `{ entries, has_more, next_cursor }` | the bell's list |
| a profile | `GET /user/profile {username}` (a `usr-` id or the username) → `{ user }` | `luma.com/user/<id>` |
| their events | `GET /user/profile/events {username}` → `{ events_hosting, events_past, events_together }` | the same page |
| chats | `GET /chat/conversations/sync {pagination_cursor?}` → `{ entries, has_more, next_cursor }` | the chat page's first load, then its sync |
| chat messages | `GET /chat/messages/sync {pagination_cursor?, pagination_limit}` (250 on the first page, 50 after) | the same |
| one chat | `GET /chat/conversation/get {chat_conversation_api_id}` | opening a chat the sync has not brought |
| a chat's older messages | `GET /chat/conversation/get-messages {chat_conversation_api_id, sort_column: 'sent_at', pagination_cursor?}` | the chat's scroll back |
| send | `POST /chat/conversation/send {chat_conversation_api_id, replying_to_message_api_id, message_api_id, message}` → `{ messages }`; `message_api_id` is `chatmsg-` and 12 random letters and digits, made by the sender | the composer |
| read mark | `POST /chat/conversation/mark-as-read {chat_conversation_api_id}` | opening a chat |
| reactions | `POST /chat/conversation/add-reaction {chat_message_api_id, reaction_type}`, `POST /chat/conversation/remove-reaction {chat_message_api_id}`; one reaction per person per message | the message's reaction picker |
| Register | `POST /event/register`, the one-click body below → `{ status: 'success', … }` | the event page's Register button with nothing to fill in |
| Not going | `POST /event/decline-my-registration {event_api_id, decline_message}` | the guest's "Not going" |
| a picture | `GET` on images.lumacdn.com (and the other lumacdn hosts) without cookies, as an `<img>` loads it | |

The one-click Register body, as the button sends it for a free ticket with no questions:

```
{ event_api_id, ticket_type_to_selection: { <ttype id>: { count: 1, amount: 0 } }, expected_amount_cents: 0,
  expected_amount_tax: 0, for_waitlist: false, name, first_name, last_name, email, registration_answers: [],
  event_invite_api_id, opened_from, coupon_code: null, currency: null, payment_currency: null,
  payment_method: null, payment_method_id: null, phone_number: null, eth_address_info: null,
  solana_address_info: null, token_gate_info: null }
```

The name and email are yours from `GET /user`. `for_waitlist` is true when the event is sold out and has a waitlist.

### Never called

`POST /notifications/mark-as-read` (the bell's own page marks what it shows; the kind never does), the Centrifugo
socket, analytics, and every host or organiser call (`/event/admin/*`, `/calendar/admin/*`). Nothing signs up,
follows, subscribes to a calendar, buys a ticket or answers a registration form.

## The shapes it reads

- **A listing entry** (discover, home, a profile's events): `{ api_id, event, calendar, hosts[], guest_count,
  ticket_count, ticket_info, featured_guests[], guest_info, host_info, manager_info, waitlist_active, start_at }`.
- **`event`**: `api_id` (`evt-…`), `name`, `start_at`, `end_at`, `timezone`, `url` (the slug after luma.com/),
  `cover_url`, `show_guest_list`, `location_type`, `geo_address_info`, `geo_address_visibility`, `coordinate`.
  - `geo_address_info.mode` is `shown` (with `address`, `full_address`, `short_address`, `city`, `city_state`) or
    `obfuscated` (the city only, until you are approved).
- **`ticket_info`**: `{ price: { cents, currency, is_flexible, min_cents }, is_free, max_price, is_sold_out,
  spots_remaining, require_approval }`.
- **`guest_info`**: your own registration, `{ approval_status: 'approved' | 'pending_approval' | 'waitlist' |
  'declined' | 'invited' }`, or null. `host_info` is there when you host it.
- **When `show_guest_list` is false**, Luma itself sends `guest_count: 0` and no `featured_guests`, and answers 403 to
  `get-guest-list`.
- **A user**: `{ api_id (usr-…), name, first_name, last_name, username, avatar_url, bio_short, twitter_handle,
  instagram_handle, linkedin_handle, tiktok_handle, youtube_handle, website, timezone, is_verified }`.
- **A notification**: `{ api_id, notification: { title (names in **bold**), preview, original_action_at, seen_at,
  primary_image, secondary_image }, related_users[], event, calendar }`.
- **A chat**: `{ api_id, type: 'direct' | 'group' | 'support', name, avatar_url, event_api_id, other_participant:
  { user_api_id, user, last_read_at }, my_participant: { last_read_at, mute_until, removed_at }, last_message, role }`.
  A sync entry can instead say a chat was removed.
- **A chat message**: `{ api_id, chat_conversation_api_id, user_api_id, author, sent_at, deleted_at, message_type,
  message, replying_to_message_api_id, media, mentions, reactions: [{ reaction_type, user_api_id, created_at,
  removed_at }] }`.

## How it maps

Ids are Luma's own: an event is its `evt-` id, a person their `usr-` id, a chat its conversation id. Luma's own
notices are from `luma`.

- **An event** is a PostFact (`id` its `evt-` id, `url` its luma.com page) with `title`, its description as `text`
  (ProseMirror to plain lines, on its page only), the cover as `media`, and its calendar as `place`. Its `event`
  carries:
  - `start`, `end`, `timezone`;
  - `place`: the venue and address when shown, the city alone when Luma hides the address until you are approved,
    `online` for an online one;
  - `price`: "Free", "$20", "$20 to $40", "From $10", "Sold out";
  - `hosts`, and `rsvp` (approved → going, pending_approval → pending, waitlist, declined, invited);
  - `guests`, `guestCount` and `guestsShown`, by the rule below;
  - `conversation` (`event:<id>`) for an event you are in, and `ics` on its page when you are a guest.
- **Who is going, the hard rule**: guests are read only when the event's `show_guest_list` is true. Then they are the
  `featured_guests` the listing shows (`guestsShown` `sample`, or `all` when that is everyone), or, on the page of an
  event you are approved for (or host), the whole list Luma shows you (`all`). A hidden list gives no guests, no
  count and `guestsShown: 'hidden'`, and the guest list is never asked for. Guests that somehow came with a hidden
  list are dropped unread (and counted). Hosts are always shown, as Luma shows them.
- **People**: every host and shown guest goes out as an identity before the event that names them. A profile is a
  PersonAbout: name, `@username`, bio, the picture, and the socials as claims with links (Luma, X, Instagram,
  LinkedIn, TikTok, YouTube, website), with the events they host.
- **home**: `explore` is the city's discover listing (the place by its slug through `/url`, kept 6 hours; else
  `bootstrap-page`'s featured place), 25 a page, each with the reason "Featured in <city>". `following` is your
  events: upcoming first, then past (`f:`/`p:` cursors over Luma's own), without the ones you declined. `foryou` is
  refused: Luma has no such tab.
- **post**: the event's page, with its guest list as above and its `.ics` (from the calendar urls' `ics` target,
  `webcal:` made `https:`). `replies` is empty: Luma has no comments.
- **The feed** (nativeId `feed`, variant `feed`, read-only): each notification is a FeedItem of type `other` from the
  first related user (`other:<id>:<user>`), the title with its bold marks taken out, the preview below it, and
  `extra.event` when it is about an event. The first read of a fresh account goes back 14 days (two pages) and
  notifies nothing; later reads look at the newest page every 4-8 minutes and page back while a whole page is new.
- **Event conversations** (`event:<id>`, a group named after the event) for each event you are in, read every 20-40
  minutes. Their messages are the host's blasts (`blast:<id>`, `extra.blast: true`, `extra.event`), the subject
  above the words unless the words already start with it. Sending, reacting or marking read there is refused: Luma
  has no comments on an event.
- **Chats**: each one a conversation (direct with the other person, group with its name; an event's chat with
  `extra.event`; support chats left out), synced every 1-2 minutes. A message is a MessageFact with its reply, its
  reactions (with when) and `live` only when it is new since the last read and under a few minutes old. A deleted
  message goes out as a delete. **history** pages back with `get-messages`; an event's history is its blasts, the
  feed's nothing.
- **RSVP** is `action` with `action: 'rsvp'` and `args: { eventId, status, note? }` (chat-protocol's
  `EventRsvpArgs`), at **manage**: an app with write cannot. `going` sends the one-click Register only when the page
  needs nothing more (one kind of ticket, free, no questions, no phone number or wallet); otherwise it is refused,
  saying why, with "register in the live view". An event that needs the host's approval answers pending. `declined` sends Not going with the note. `maybe` and `interested` are
  refused: Luma has neither. The answer is the event as it reads afterwards.

## Pace, back-off and what it never does

Reads wait 2-4.5 s after the one before, one at a time; writes 1.2-2 s, one at a time. Explore, an event's page and a
profile are read only when the app asks; the notifications, chats and your events are on the timers above. A 429
holds every read for a minute, doubling with each one in a row up to 30 minutes. A Cloudflare check holds them 10
minutes and puts the account in **attention** (`captcha`, "Luma is showing a check (Cloudflare): clear it in the
live view"). Nothing here solves it. The hook holds the list of calls and checks every id and cursor it is given.

## Status

Layers: display, browser, extension, signed in (`as @username`), pace (while a 429 holds), notifications (items,
last read), chats (conversations, last sync). Signed out it asks for a sign-in (attention `login`, with the live view)
and stays usable for Explore. The details list the page's state, the hook's version, counts and the last command. Its
state file, `luma-state.json`, keeps the newest times, the ids announced lately and the chat sync cursors: no words
or names.

## Not verified yet

No signed-in account has been tried. These come from the bundle and the signed-out answers, and the first live
trial should check them against the web app's own requests:

- the signed-in shapes of `/home/get-events`, `/notifications/list` and the chat calls;
- the `targets` of `get-calendar-urls` (the first url in it that is `webcal:` or `https:` and ends `.ics` or calls
  `/ics/get` is taken);
- which field names a blast's sender (`user`, else the event's first host);
- whether `get-guest-list` wants `ticket_key` for a host as well as a guest.

## Tests

`extractors/luma/test/map.test.ts` maps invented answers (`test/fixtures.ts`): events to PostFacts, the hidden guest
list, people and socials, places, notifications, blasts and chats, the tracker, the back-off and the status.
`test/luma-browser.test.ts` runs the kind end to end, a real manager, Chromium and the extension against
`test/fake-luma.ts` (a page and the calls above on one origin): Explore signed out and paged, your events, an event's
page with its guest list and `.ics` (and that a hidden list is never asked for), a profile, the feed, blasts and
chats with a live message, the writes' exact bodies, RSVP, a 429, and the state file. It skips where Xvfb, Chromium or
x11vnc are missing. `test/luma-manager.test.ts` runs in CI with no browser: an RSVP below manage is refused, and the
City setting.
