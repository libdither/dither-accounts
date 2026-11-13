# CalDAV and CardDAV (kind `dav`)

One account on any CalDAV/CardDAV server (Nextcloud, Fastmail, iCloud with an app password, Radicale, Baïkal, SOGo,
Posteo, mailbox.org…), answering the `calendar` and `contacts` interfaces (packages/interfaces/src/calendar.ts,
contacts.ts) straight over WebDAV: no browser, no provider API. `extractors/dav`.

## Adding one

On the accounts page, **Add → CalDAV / CardDAV**:

| field | goes to | |
|---|---|---|
| Server | config `server` | a domain (`cloud.example.com`) or a URL (`https://cloud.example.com/remote.php/dav`); no scheme means https |
| User name | config `username` | |
| Password | secret.json `password` | an app password where the server has them |
| Contacts server | config `contactsServer`, optional | only when contacts are on another host than calendars |

Apps that manage the kind (`accounts` at manage for `dav`) add them the same way, and may set two more config keys:
`pollSeconds` (default 120, at least 5) and `syncMode: 'etag'` (never use sync-collection; for a server whose sync
reports misbehave).

It signs in and looks for the account at once. If the server refuses the password, the account asks for attention
("the server refused the username or password"); replacing the password (the page, or an app's `secret` action)
is noticed within seconds, without a restart. It does not try the refused password again on its own for 15 minutes,
so a server that locks accounts out after failed sign-ins is not pushed into it.

## How it finds things (RFC 6764)

From the server it tries, in order, until one names a `current-user-principal`: the URL as given if it has a path,
`/.well-known/caldav`, the `_caldavs._tcp` SRV record (with its TXT `path=`), `/`, then the same for CardDAV. The
principal's `calendar-home-set` and `addressbook-home-set` are the homes; a PROPFIND (Depth 1) on each lists the
calendars and address books. iCloud and Fastmail keep contacts on another host, so for them (and for a
`contactsServer`) CardDAV is looked for there too. What it found is kept, so a restart does not look again (a change
of server, user name or contacts server does).

Requests sign in the way the server asks: Digest (MD5 or SHA-256, qop=auth, a stale nonce answered again) when it
offers it, else Basic, sent only after the server's first 401. Redirects are followed by hand; the credentials go on
only to the same origin, or over https to the same site (`caldav.icloud.com` → `p52-caldav.icloud.com`), never
elsewhere. A plain `http://` server gets the password in the clear: use it only on this machine or the tailnet.

## Ids, times, recurrences

- A calendar's id is its collection's path (`/remote.php/dav/calendars/me/personal/`), an address book's likewise.
- An event's id is its resource's name in the collection (`standup.ics`). A changed instance of a series is
  `<name>#<key>`, the key being the instance's original start: `20260309T160000Z` (a time in a zone, as UTC),
  `20260309T090000` (floating) or `20260309` (a date). `expand` gives every instance the same kind of id, so
  `cal.put` on an instance id makes (or changes) that instance's override, and `cal.delete` on one adds an EXDATE
  (and drops its override).
- Times are as the interface says: `{ date }` with an exclusive end, or an RFC 3339 `dateTime` with its offset and the
  IANA `timeZone` it was made in (`null` for floating or UTC). A TZID that is no IANA name is looked for in its
  VTIMEZONE (X-LIC-LOCATION), as a trailing `Region/City` (`/mozilla.org/…/America/New_York`) and among the common
  Windows names (`Pacific Standard Time`); failing those, the VTIMEZONE itself converts it, with `timeZone: null`.
- `expand` (with `from` and `to`) walks RRULEs in the event's own wall-clock time, so 09:00 stays 09:00 across a change
  of offset; UNTIL (UTC) is read in that zone; RDATE (dates, times, periods), EXDATE and overrides count, also an
  override moved into the window from outside it. A local time that a change to daylight time skips is read with the
  offset before it (02:30 → 03:30), a repeated one is the first. A cancelled instance is left out of an expansion (it
  is listed, with status cancelled, without one). Dates and floating times are placed in the calendar's
  `calendar-timezone` for the window, else UTC.
- Without `expand`, a window (`from`/`to`) is the server's own time-range query (any instance in it); a server that
  will not do one gets a full listing filtered here.
- Writes: fields an input leaves out are kept; moving only the start moves the end with it; a new event in a zone
  gets that zone's VTIMEZONE (IANA data, timezones-ical-library), unused ones are dropped; SEQUENCE, DTSTAMP and
  LAST-MODIFIED move. `ics` is used as it is (for a new event the whole resource; on an id, it replaces that event and
  keeps the rest of the series). A new event's resource is named `<uid>.ics` when the UID is a plain name.
- Contacts: vCard 3.0 and 4.0 are read; a change rewrites only the properties of the fields it gives (and Apple's
  `X-ABLabel` of a group it empties), so everything else in the card stays. New cards are 3.0 (iCloud takes nothing
  else); a birthday without a year is written Apple's way (`X-APPLE-OMIT-YEAR=1604`). An address is one line, and is
  written back as the street part.

## Keeping up

- `cal.events` / `contacts.list` hand out a sync token on their last page; `cal.changes` / `contacts.changes` with it
  answer what changed. The token wraps the collection's DAV `sync-token` (a sync-collection REPORT, RFC 6578), or,
  for a collection without one, an etag snapshot: its `getctag` and every member's `getetag` (the last 8 snapshots of
  each such collection are kept, a token naming an older one is stale).
- A stale token fails with status 410 (the server answers `valid-sync-token`, or the snapshot is gone): list again.
  A token from another account or of another kind is 410 too; one for another collection is 400.
- `removed` names a removed event's id and the ids of its changed instances; when a series loses an override, its id
  is named as removed to every token older than when it was seen to go (and to no newer one; that memory lasts 90
  days). A token's age is when it was handed out.
- Page tokens are kept in memory for 15 minutes; a lost one (or a restart) is 410.
- Watching: every `pollSeconds` (120) one PROPFIND per home reads each collection's `sync-token`, else `getctag`, else
  a hash of its members' etags; when one moved, or a collection came or went, it says `cal.changed { calendarId }` or
  `contacts.changed { bookId }`. The first look after a start compares with what it saw before stopping, so a change
  made while it was down is said then. Its own writes say so at once. While the server is down it looks every 30 s.
- Writes go with `If-Match` (the app's `ifMatch`, else the etag it just read, retried once if someone else's change
  landed in between) and new ones with `If-None-Match: *`: a write that lost fails with 412 (a new event whose UID is
  taken, too). Read-only collections (no `write`/`write-content` in `current-user-privilege-set`) fail with 403 before
  anything is sent; a server's own 403 passes through.

## Status

`status` carries `self` (`handle`: the user name; `displayName` and `email` when the principal has them),
`details` (server, user name, principal, homes, counts, `auth`: basic or digest, the server's `Server` header,
`pollSeconds`, `lastPoll`) and `layers`:

1. **server**: ok (its origin and product), waiting (connecting, or unreachable once or twice), failed (unreachable
   three times in a row, or no server in the config).
2. **signed in**: ok (`as <user>`), failed (the password was refused; the status asks for attention), waiting.
3. **calendars**: ok (`3 calendars, 1 read-only; sync-collection`), off (no calendar home for this user), failed
   (listing it failed), waiting.
4. **address books**: the same.

## What it keeps

In the account's directory: `secret.json` (the password, 0600, written whole) and `dav-state.json` (0600): where the
account was found, each collection's last token (for the poll), the ids of changed instances each event has had and
when the gone ones went, and the etag snapshots of collections without sync-collection. Nothing an event or contact
says is kept; the log has paths and statuses, never passwords or contents.

## Limits

- Polling, not push: no WebDAV-Push and no Apple push. Two minutes by default.
- Events only: tasks (VTODO) are listed in a calendar's `components` but not returned; VJOURNAL neither.
- No calendar or address book is made or removed (no MKCALENDAR), and no scheduling: no inbox/outbox, no iTIP
  replies; attendees are written as given.
- One UID per resource (CalDAV's rule); a second one in a resource is left out. `RANGE=THISANDFUTURE` overrides are
  read as single-instance ones.
- An expansion stops at 10 000 instances per series and 200 000 rule steps.
- Calendars on another server than the principal's (iCloud shared calendars by link, "subscribed" collections) are
  not followed; add those as `ics` feeds.

## Per provider (what only your own account can check)

- **Nextcloud**: server = your Nextcloud's domain (it answers `/.well-known/caldav`; behind a proxy that does not pass
  that on, give `https://<host>/remote.php/dav`). With two-factor sign-in, make an app password: Personal settings →
  Security → Devices & sessions → Create new app password. User name: your Nextcloud login name (not always the
  e-mail).
- **Fastmail**: server = `fastmail.com` (looked up as `caldav.fastmail.com` and `carddav.fastmail.com`). An app
  password is required (Settings → Privacy & Security → app passwords → New app password), with access to
  calendars (CalDAV) and contacts (CardDAV). User name: your full Fastmail address.
- **iCloud**: server = `icloud.com` (looked up as `caldav.icloud.com` and `contacts.icloud.com`). An app-specific
  password is required (two-factor is on for every Apple ID): account.apple.com → Sign-In and Security →
  App-Specific Passwords. User name: your Apple ID e-mail. Shared calendars you were invited to appear (read-only
  unless shared to you with edit); public "subscribed" calendars do not.
- **Radicale**: server = its URL (`https://dav.example.com/` or with its prefix). Basic auth (htpasswd).
- **Baïkal**: server = `https://<host>/dav.php/` (or just the domain, if its web server redirects
  `/.well-known/caldav` there). Digest or Basic, as it is set up; both work.
- **Google**: its CalDAV takes only OAuth, not passwords: use the `google` or `google-api` kinds (docs/google.md).

Checklist for the first real account of each: it goes online with the four layers ok; `cal.calendars` lists what the
provider's own app shows (shared and read-only ones too); a test event made with `cal.put` appears in the provider's
app with the right time and zone, and one made there shows as `cal.changed` within two minutes and in `cal.changes`;
a contact's change keeps its photo and labels in the provider's app; deleting the test event and contact.

## Libraries

ical.js (MPL-2.0: used unchanged as a library; MPL obligations apply only to changes to its own files),
@xmldom/xmldom (MIT), timezones-ical-library (Apache-2.0).

## Tests

```sh
bun test test/dav.test.ts test/dav-auth.test.ts test/dav-ical.test.ts test/dav-vcard.test.ts
bun scripts/verify-dav.ts        # a throwaway manager, Radicale and a feed server; both kinds as the page adds them, every op as an app
```

`test/dav.test.ts` runs Radicale from nixpkgs (extractors/dav/test/radicale.ts; `RADICALE_BIN` for another) with
htpasswd users on port 18530, a read-only collection, and a second client that changes things behind the
extractor's back. `test/dav-auth.test.ts` puts a Digest-only proxy in front of it (extractors/dav/test/digest-proxy.ts).
