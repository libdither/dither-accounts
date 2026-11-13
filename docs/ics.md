# Calendar feeds (kind `ics`)

A read-only `.ics` / `webcal://` feed as one calendar of the `calendar` interface (packages/interfaces/src/calendar.ts):
a published calendar, a provider's "secret address", holidays, a team or venue schedule. `extractors/ics`, with the
iCalendar code it shares with `dav` (extractors/dav/src/ical.ts, docs/dav.md).

## Adding one

On the accounts page, **Add → Calendar feed (.ics)**, with its **Feed URL**: `webcal://`, `webcals://` (both read as
https), `https://` or `http://`. A private feed's URL is a password, so it goes to secret.json, never to the config,
the page or the log; the page and the status show only its host. A URL with `user:password@` is fetched with those as
Basic auth. Apps that manage the kind may set `pollSeconds` in the config (default 600).

## How it keeps up

- It fetches the feed at start and every `pollSeconds`, and before answering a call when the copy it has is more
  than a minute old. With the copy in memory it asks with `If-None-Match` (the feed gave an ETag) and
  `If-Modified-Since` (it gave a Last-Modified): a 304 is no change. A feed with neither is compared by a hash of its
  text.
- A feed that changed is parsed, and each event (a series' master, or one changed instance) hashed without its
  DTSTAMP (Google stamps every copy with the time it was made). When any hash differs, that is a new version, and it
  says `cal.changed { calendarId: 'feed' }`. A feed that changed only in what is not an event is not a new version.
- `cal.events` hands out a sync token naming the version; `cal.changes` answers the events whose hash differs between
  that version and now (`changed`) and the ids that are no longer there (`removed`), by uid and recurrence-id. The
  last 12 versions are kept, across restarts; a token for an older one (or not of this feed) is stale: 410, list again.
- While the feed's server is down, the copy it has keeps answering; the feed layer says so, and it looks every 30 s.
  After a restart the first fetch is whole (the copy is kept only in memory), and a feed that changed while it was
  stopped is a new version then, said with `cal.changed`.

## Ids and times

- The calendar is `feed`: its name is the feed's `X-WR-CALNAME` (or `NAME`, or the account's label), its colour
  `X-APPLE-CALENDAR-COLOR` or `COLOR` when it is `#RRGGBB`, its zone `X-WR-TIMEZONE`; `readOnly: true`.
- An event's id is its UID; a changed instance (and an instance `expand` makes) is `<uid>#<key>`, the key as in
  docs/dav.md (`20260309T160000Z`, `20260309T090000`, `20260309`). A feed that reuses a UID for a second, unrelated
  event (some do) gets `<uid>~2`, `<uid>~3`… for the others, with `uid` itself unchanged.
- Times, `expand` and windows work as for dav (docs/dav.md), done here: dates and floating times are placed in
  `X-WR-TIMEZONE`, else UTC. Each event's `etag` is its hash, so it moves when the event does.
- A page is 500 series; its token names the version, so a feed that changes while paging is 410 (list again).

## Writes

`cal.put` and `cal.delete` fail with status 403: a feed is changed where it is published.

## Status

`self` is the calendar's name and the feed's host. `details`: host, counts, the version, how many are kept, how it
refreshes (`ETag`, `Last-Modified` or `content hash`), `pollSeconds`, `lastFetch`, `lastChange`. `layers`:

1. **feed**: ok (host, what the last fetch did, how it refreshes), waiting (fetching, or unreachable once or twice),
   failed (unreachable three times, refused with 401/403, gone with 404/410, another HTTP error, too big). A refused
   or gone feed asks for attention: the URL may have been reset (Google and iCloud make a new one when you reset the
   secret address) or the calendar unpublished.
2. **calendar**: ok (how many events in how many series, and tasks left out), failed (it is not iCalendar), waiting.

## What it keeps

`secret.json` (the URL) and `ics-state.json` (0600): the ETag and Last-Modified, the hash of the text, and the last
12 versions as event id → hash. Not the feed, not what any event says.

## Limits

- One feed, one calendar; read-only.
- Events only: VTODOs are counted and left out.
- At most 64 MB. A feed whose UIDs change on every fetch (rare, and broken) looks like everything removed and added.
- A feed behind a sign-in other than Basic in the URL (OAuth, cookies) cannot be fetched.

## Per provider

- **Google Calendar**: Settings → the calendar → Integrate calendar → "Secret address in iCal format" (private) or
  "Public address in iCal format". Google refreshes it every few hours on its side, so changes show late; for
  two-way and quick use the `google` kinds.
- **iCloud**: Calendar → share a calendar → Public Calendar → copy the `webcal://p…-caldav.icloud.com/published/…`
  link. Anyone with the link can read it.
- **Outlook.com / Microsoft 365**: Settings → Calendar → Shared calendars → Publish a calendar → the ICS link.
- **Fastmail, Proton, Nextcloud**: each calendar's share or export link (Nextcloud: "Copy subscription link"); for
  Fastmail and Nextcloud the `dav` kind gives two-way access instead.

Checklist for each real feed: it goes online with both layers ok and the event count the provider shows; a recurring
event's times are right after a change of offset; an event changed at the provider shows in `cal.changes` after the
provider republishes (Google: up to a day) and the next poll.

## Tests

```sh
bun test test/ics.test.ts
bun scripts/verify-dav.ts
```

`test/ics.test.ts` serves feeds from a local server (extractors/ics/test/feed-server.ts, port 18532) that answers by
ETag, by Last-Modified, or with neither and a fresh DTSTAMP each time, optionally behind Basic auth, and changes them
while the extractor watches.
