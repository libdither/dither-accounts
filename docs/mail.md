# Mail: the `imap` kind

`extractors/imap` holds one mailbox over IMAP, sending over SMTP, and answers the `mail` interface
(`packages/interfaces/src/mail.ts`): mailboxes, listing, reading, attachments, search, keeping up with changes, flags,
moving, trash and sending. It is plain IMAP and SMTP with a password, so it works with Proton Mail through Proton
Bridge, Fastmail, Gmail and iCloud (with app passwords) and any server of your own. No browser, no OAuth.

Libraries: [imapflow](https://github.com/postalsys/imapflow) (MIT) for IMAP, nodemailer's `SMTPConnection` and
`MailComposer` (MIT-0) for SMTP and building messages, html-to-text (MIT) for text from HTML-only mail. The tests also
use smtp-server (MIT-0) and mailparser (MIT). Everything they pull in is MIT, MIT-0, ISC or BSD.

## Adding one

On the manager's page, under Accounts → add → **Email (IMAP)**. The form has fields only, so the provider is a field
too: type one of `proton`, `fastmail`, `gmail`, `icloud`, `custom`. Its preset fills the servers; the server fields
stay empty unless the provider is `custom` or you want to override the preset (Proton Bridge on other ports, say).

| field | |
|---|---|
| Email address | the address you send as |
| Provider | `proton`, `fastmail`, `gmail`, `icloud` or `custom` |
| Password | secret.json only. See below for which password per provider: never your account's main password |
| Username | when it is not the email address (IMAP and SMTP both use it) |
| Your name | the name in From |
| IMAP server / port / security | `tls` (993), `starttls` (143) or `none` (only to 127.0.0.1: a password never crosses a network in the clear) |
| SMTP server / port / security | `tls` (465), `starttls` (587) or `none` (127.0.0.1 only) |
| Certificate | `verify` (the system's CAs and the host name; the default), `pin` (trust the certificate seen on first connect, and only it; the default for Proton Bridge), or a SHA-256 fingerprint to require |
| Copy to Sent | `auto` (the preset's), `append` (always append a copy), `server` (the server keeps one: append nothing), `detect` (look for the server's copy after 1.5 s, append if there is none) |

The presets:

| provider | IMAP | SMTP | certificate | copy to Sent | password |
|---|---|---|---|---|---|
| `proton` | 127.0.0.1:1143 STARTTLS | 127.0.0.1:1025 STARTTLS | pin | server | the one Proton Bridge shows for this address |
| `fastmail` | imap.fastmail.com:993 TLS | smtp.fastmail.com:465 TLS | verify | detect | a Fastmail app password with IMAP and SMTP access |
| `gmail` | imap.gmail.com:993 TLS | smtp.gmail.com:465 TLS | verify | server | a Google app password (needs 2-Step Verification) |
| `icloud` | imap.mail.me.com:993 TLS | smtp.mail.me.com:587 STARTTLS | verify | detect | an app-specific password from your Apple Account |
| `custom` | yours | yours | verify | detect | yours |

An app that runs `imap` accounts (an `accounts` grant at manage) creates them the same way, with the same config keys
and `{ password }` as the secret. One config key is not on the form: `sync` (`auto`, `condstore` or `flags`) forces a
weaker way of keeping up, for a server whose QRESYNC or CONDSTORE misbehaves.

## What you do, per provider

**Proton Mail (Proton Bridge).** Bridge is yours to install and run; this account only talks to it on 127.0.0.1.

1. Install Proton Bridge (on NixOS `protonmail-bridge`, or `protonmail-bridge-gui`) and sign in to your Proton account
   in it (`protonmail-bridge --cli`, then `login`; or the app).
2. Keep it running (its autostart, or a user service). If it is not, the account's first layer, **Proton Bridge
   running**, says so and the account tries again (1, 2, 5, 10, 30, 60 s).
3. In Bridge, open the mailbox's settings (`info` in the CLI): it shows the IMAP and SMTP username (your address) and
   a password made by Bridge. That password goes in the form, not your Proton password.
4. Bridge's ports and its connection mode: the preset is 1143 and 1025, both STARTTLS. If you changed them in Bridge
   (or set SSL), fill in the IMAP and SMTP port and security fields to match.
5. Optional but worth it: in Bridge, export its TLS certificate (Settings → Advanced → export TLS certificates) and
   compare `openssl x509 -in cert.pem -noout -fingerprint -sha256` with the account's "certificate" detail on the
   page. Or put that fingerprint in the form's Certificate field when you add it, and it is required from the start
   instead of trusted on first connect.
6. Sent mail: Proton keeps a copy in Sent itself, so nothing is appended.

**Fastmail.** Settings → Privacy & Security → app passwords → New app password, with access to IMAP and SMTP. The
username is your Fastmail address. Copy to Sent is `detect`: if Fastmail's "save a copy of SMTP mail to Sent" is on
and copies show up twice, set Copy to Sent to `server`.

**Gmail.** Turn on 2-Step Verification, then make an app password (myaccount.google.com → Security → App passwords).
Gmail keeps the Sent copy itself. Its labels come through as `labels`, its threads as `threadId`, and search uses
Gmail's own search syntax (X-GM-RAW). [Gmail]/Important has the role `important` (from its \Important flag, RFC 8457,
which imapflow's special-use list leaves out). A move out of [Gmail]/All Mail into anything but Trash or Spam is a COPY:
All Mail is every message, not a label, so a MOVE out of it deletes the message there, while a COPY adds the
destination's label (Inbox to put it back in the inbox, or a user label) and leaves it in All Mail; the reply's id is
the copy's. A Google Workspace account whose admin turned off app passwords or IMAP cannot be added this way.

**iCloud.** appleid.apple.com → Sign-In and Security → App-Specific Passwords. The username is your full iCloud
address; if iCloud refuses it, try the part before the @ in Username.

**Your own server.** `custom`, and its host names, ports and security. If it has its own certificate (self-signed, a
private CA), set Certificate to `pin` or to its SHA-256 fingerprint; with `verify` the TLS layer fails and shows the
fingerprint it was offered.

Outlook.com and Microsoft 365 turned off password sign-in for IMAP and SMTP (OAuth only), so they cannot be added here.

## How it works

Two IMAP connections:

- **operations**: opened when a call needs it, opened again when the server dropped it (a read that hit a dropped
  connection is tried once more on a new one). Each call selects its mailbox again, so counts and UIDNEXT are fresh.
- **watch**: the inbox selected in IDLE (re-entered a quarter second after each command, renewed every 5 minutes). New
  messages become `mail.arrived` (with the message's summary), and anything that changes the inbox becomes
  `mail.changed` with a fresh state. When it drops it reconnects with backoff (1, 2, 5, 10, 30, 60 s). A server without
  IDLE is polled with NOOP. The inbox's UIDVALIDITY and UIDNEXT are kept in `watch.json`, so after a restart the
  messages that came meanwhile are announced (the newest 20).

SMTP is one connection per send (and one sign-in at start, for its layer). When a sign-in or a send fails for a reason
a retry may mend (the server not answering, a timeout), it signs in again after 10 s, then 30 s, 1, 2, 5 and 10
minutes, so the SMTP layer and `canSend` come back by themselves. A refused password or certificate is not retried.

### Layers

`[Proton Bridge running →] server → TLS → signed in → inbox → IDLE → SMTP`, each `ok`, `waiting`, `failed` or `off`
(TLS is `off` for `none`). The first that is not ok is where it stops: the page shows it, and the account's status is
`online` once signed in with the inbox open, `offline` while the server does not answer, `attention` when it needs you.

### Certificates

`verify` checks the server against the system's CAs and its host name, as any mail program does. `pin` trusts one
certificate: on the first connect it fetches the server's certificate (a connection that sends nothing but STARTTLS),
keeps its SHA-256 fingerprint in `tls-pins.json`, and from then on every connection is held to it **before** anything
is sent: imapflow's transport is ours, and the fingerprint is compared right after the TLS handshake, so LOGIN never
goes to a server with another certificate; for SMTP the comparison is made after STARTTLS and before AUTH. Nothing turns
verification off for anything else, and there is no global switch.

A pinned server that offers another certificate is refused: the TLS layer fails, the status asks for attention with
both fingerprints, and the account stops trying. If you know why (you reinstalled Bridge, you replaced the server's
certificate), delete `tls-pins.json` in the account's directory: within a few seconds it pins the new one and signs in
(no restart needed). Or put the new fingerprint in its config (`certificate`).

The fingerprints are public facts, not secrets. They would belong in the account's config, but an extractor cannot
write its config (see "Asked of the manager" below), so they live in the account directory.

### When it needs you

- **Wrong password**: the server refused it. The signed-in layer fails, the status asks for attention (`login`), calls
  answer 401 at once, and it does not try again (a server that sees repeated bad passwords may lock the account). A new
  password in secret.json (an app's `secret` action) is picked up within seconds and it signs in again.
- **Certificate changed** (pinned) or **not trusted** (verify): as above, 495.
- **Server not answering**: 503, retried with backoff by itself.

## Ids and states

All opaque to apps (`src/ids.ts`):

| | | |
|---|---|---|
| mailbox | base64url of its path | changes if it is renamed |
| message | `<mailbox>.<UIDVALIDITY>.<UID>` | the same while it stays there; a move gives it a new UID, so a new id |
| attachment | its MIME part number (`2`, `1.3`) | |
| `mail.list`'s `next` | `<UIDVALIDITY>.<UID>`: older than this | |
| state | `q.<UIDVALIDITY>.<HIGHESTMODSEQ>.<UIDNEXT>`, `c.<UIDVALIDITY>.<HIGHESTMODSEQ>.<snapshot>`, `f.<UIDVALIDITY>.0.<snapshot>` | |

A changed UIDVALIDITY (the server rebuilt the mailbox) makes every id, cursor and state of that mailbox answer **410**:
list it again. A message that is not there (moved, deleted) is 404.

### mail.changes

The best the server has:

- **QRESYNC** (Dovecot, Fastmail, Cyrus): `UID FETCH … (CHANGEDSINCE m VANISHED)` gives the flag changes and the
  removals; new messages are those from the old UIDNEXT. Nothing is kept here.
- **CONDSTORE** without QRESYNC (Gmail): flag changes by modseq; removals by comparing `UID SEARCH ALL` with
  the UID list kept for the state.
- **neither** (Proton Bridge, as far as known): every UID with its flags, compared with the list kept for the state.

The lists are kept in the account directory's `sync/` (newest 32 per mailbox; equal lists are one file, so polling an
unchanged mailbox gives the same state back), so states survive restarts. A state whose list is gone answers 410, and so
does a state made one way when the server now has another (it gained or lost CONDSTORE). `limit` (default 200, at most
1000) caps `added`; `more` says to call again with the new state. `changed` and `removed` come whole.

## Operations

Every summary (`mail.list`, `mail.search`, `mail.changes`' `added`, `mail.arrived`) comes from one FETCH per page:
FLAGS, ENVELOPE, BODYSTRUCTURE, INTERNALDATE, the size, Gmail's thread and labels where there are any, and
`BODY.PEEK[HEADER.FIELDS (REFERENCES LIST-ID LIST-UNSUBSCRIBE PRECEDENCE AUTO-SUBMITTED)]` (a few lines a message, and
never \Seen). From those:

- `inReplyTo`: ENVELOPE's In-Reply-To, as `<id>` like `messageId` (a bare `id@host` gets its brackets; the first id
  when a client wrote more); null when there is none.
- `references`: the References header's Message-IDs, unfolded, in order, each once: all of them up to 20, else the
  first (the thread's root) and the last 19. `mail.get` gives them all.
- `bulk`: `{ listId, unsubscribe, precedence, autoSubmitted }`, the raw values of List-Id, List-Unsubscribe,
  Precedence and Auto-Submitted (unfolded, spaces made one, trimmed, 300 characters at most, null when absent),
  present only when at least one is there. `Auto-Submitted: no` is kept as it is: deciding what is bulk is the app's.

- `mail.mailboxes`: every mailbox from LIST, its role from SPECIAL-USE (`\Sent`, `\Trash`, …; INBOX is always `inbox`;
  imapflow guesses well-known names when the server says nothing), counts from STATUS.
- `mail.list`: newest first by arrival (UID), 50 by default, at most 500; pages by sequence numbers, with ESEARCH
  COUNT when the server has it. `since` is by arrival time (the server's SINCE is by day; the exact time is checked here).
- `mail.get`: from ENVELOPE and BODYSTRUCTURE; only the text and HTML parts are downloaded (decoded, charset to UTF-8,
  format=flowed undone, 5 MB each), never with \Seen set (BODY.PEEK). Text is made from the HTML when there is no text
  part. Everything else is an attachment, a forwarded message (message/rfc822) included; `inline` is from its
  Content-Disposition, `size` is decoded (about, for base64).
- `mail.attachment`: one part, decoded, as base64; over 25 MB is 413 (before downloading, from its size).
- `mail.search`: each word in From, To, Cc, Subject or the body (one SEARCH per word, kept where all agree), on the
  server; Gmail gets the query as X-GM-RAW. Without a mailbox: "All Mail" where there is one, else every mailbox but
  Trash and Junk.
- `mail.flag`: STORE ±FLAGS.
- `mail.move`: MOVE (or COPY, delete, expunge), and the new ids from COPYUID; without UIDPLUS they are found by
  Message-ID in the destination, and an id it cannot find is `""`. On Gmail (provider `gmail`, or X-GM-EXT-1) out of
  All Mail into anything but Trash or Spam it is a COPY (see Gmail above).
- `mail.trash`: to the Trash role mailbox; messages already in Trash, or on a server without one, are deleted outright.
- `mail.send`: built here (MailComposer with file and URL access off), sent through SMTP to every To, Cc and Bcc; Bcc
  is left out of what is sent and kept in the Sent copy. `from`, when given, must be one of the account's addresses
  (`status.self.addresses`: today only the configured email address, matched without regard to case), else **422**
  before anything is sent; it sets From (with the configured name) and the SMTP envelope sender. `replyTo` sets In-Reply-To and References from the original
  and marks it answered. Attachments: `base64`, or `path`, an absolute path to a regular file of at most 25 MB that is
  not one of the account's own files (its secret.json above all); 35 MB together. The copy to Sent per "Copy to Sent"
  above; `sentId` is its id, or null.

Events: `hello` (once per start, with `startedAt`), `status` (status, attention, `self: { email, displayName,
addresses }`, `details`, `layers`), `mail.arrived { message }` for the inbox, `mail.changed { mailboxId, state }` for the inbox (from
IDLE) and for every mailbox this account itself changed (flag, move, trash, Sent).

`self.addresses` is `[{ email, name }]`, the addresses it sends as: the configured email address and name (an
`aliases` config key would add more; there is none yet). `details.canSend` is true when the SMTP layer is ok (its last
sign-in or send worked), and `details.sendNote` says why not in a sentence for a person ("Sending is not checked yet:
…", "Mail cannot be sent: the SMTP server refused the password. …", "Mail cannot be sent now (SMTP host:port: …). It
tries the SMTP server again by itself."); null when it can.

## What it keeps

In the account's directory (0700):

| | |
|---|---|
| `secret.json` | `{ "password": … }`, written by the manager |
| `tls-pins.json` | per endpoint (`imap 127.0.0.1:1143`, `smtp …`): the pinned certificate's SHA-256 fingerprint, subject, issuer, expiry, when it was pinned |
| `watch.json` | the inbox's UIDVALIDITY and the next UID it has announced |
| `sync/` | the UID (and flag) lists behind mail.changes states, on servers without QRESYNC |
| `adapter.log` | the extractor's log: ids, counts, servers' answers; never message contents or the password |

Its config holds the form's fields (no password). Nothing else: messages are read from the server on each call.

## Limits

- `preview` is always null (IMAP has no cheap one that servers agree on).
- `threadId` only from servers that have one (Gmail's X-GM-THRID, OBJECTID's THREADID); `emailId`, the server's own
  id for a message in every mailbox it is in, likewise (Gmail's X-GM-MSGID, OBJECTID's EMAILID), and absent elsewhere.
- IDLE watches the inbox only; other mailboxes say `mail.changed` only for this account's own changes. Call
  `mail.changes` on them to keep up.
- One password for IMAP and SMTP (`smtpUsername` in the config, not the form, for a different SMTP login).
- One address to send as: no aliases yet, so `from` is the configured address or nothing.
- Password sign-in only: no OAuth (XOAUTH2), so not Outlook.com / Microsoft 365.
- A renamed mailbox gets a new id (its path is the id).

## Asked of the manager

- **An input named `id` does not reach the extractor**: the supervisor sends `{ ...input, t, id }` with its own call id,
  so `mail.get` and `mail.attachment` lose the message id. Until that is fixed they also take it as `message`
  (`{ id, message: id }`); once the manager sends its call id apart (as `rid`, say), the plain `id` works and is
  taken first.
- An extractor cannot update its own config, so the pinned fingerprint lives in `tls-pins.json` rather than the config.
- The add form has only text fields: a choice field (`options: [...]`) for the provider and the security fields, and
  fields shown only for `custom`, would make the form shorter.

## Tests

```sh
bun test test/imap.test.ts test/imap-sync.test.ts
bun scripts/verify-imap.ts [--keep]
```

Against a real Dovecot 2.4 from nix (`nix build nixpkgs#dovecot`; or `DOVECOT_BIN`), run unprivileged in a temp
directory with a passwd-file and a self-signed certificate (CA:FALSE, as Bridge's), and an SMTP sink (smtp-server)
that wants STARTTLS and a password and delivers into Dovecot (`extractors/imap/test/servers.ts`). Through a throwaway
manager and an app on its wire: every op, QRESYNC, CONDSTORE alone and neither (Dovecot's capabilities switched off),
UIDVALIDITY → 410, IDLE events, the threading and bulk headers on summaries (folded, more than 20 references, a long
value capped, a bare In-Reply-To; on mail.list, mail.search, mail.changes' added and mail.arrived; nothing marked read),
`from` accepted in any case and refused (422, nothing sent), `canSend` and `self.addresses`, an SMTP server that is not
there (canSend false, reading goes on) and comes later (canSend true by itself), a bad password and a new one, the server down and back, a restart keeping state and
announcing what came meanwhile, a pinned certificate changed and refused (no LOGIN reaches it) and renewed, a
fingerprint in the config, a self-signed server under `verify`, the Proton Bridge preset (its ports pointed at the test
Dovecot) and Bridge not running. Ports 18550–18560. `KEEP_IMAP_TEST=1` keeps the temp directories.

## Checklist (what only a real mailbox can show)

For each provider you use, after adding it:

1. The page shows it online with every layer ok, and the "certificate" detail (Proton: compare the fingerprint with
   Bridge's exported certificate).
2. **Try it** → `mail.mailboxes`: Sent, Trash, Drafts, Junk and Archive (Gmail: All Mail, Important, Starred) have
   their roles.
3. `mail.list` on the inbox: newest first; a second page with `before`.
4. `mail.get` on a newsletter (HTML), a plain mail, one with an attachment; `mail.attachment` on that one. In
   `mail.list`, the newsletter has `bulk` (its List-Id and List-Unsubscribe), and a reply has `inReplyTo` and
   `references`.
5. `mail.search` for a word you know is there (Gmail: it uses Gmail's search).
6. The status's `details.canSend` is true and `self.addresses` is your address. Send yourself a message with
   `mail.send`: it arrives, appears once in Sent (twice means set Copy to Sent to
   `server`), and a reply to it threads in your mail program.
7. Mark something read in your phone's mail app: a `mail.changed` comes within seconds; `mail.changes` from the state
   before shows it. Send yourself mail from elsewhere: `mail.arrived`.
8. The "sync" detail says which way it keeps up (expected: Gmail CONDSTORE, Fastmail QRESYNC, Proton Bridge "UID +
   flags diff"; iCloud whatever it has). Note it in this file if it differs.
9. Proton: quit Bridge: the first layer fails within a minute; start it: back online by itself.
