# The page's login

The page holds signed-in browsers and, soon, financial accounts, so being on the tailnet is no longer enough.
`packages/manager/src/auth.ts` is the login; `http.ts` puts it in front of the page.

## What needs it, and what does not

| Needs the login (a session cookie, or the CLI's token) | Does not |
|---|---|
| the page's files (`/`, `/assets/*`): without it, a redirect to `/login?next=…` | `/login`, `/logout` |
| every `/api/*` the page uses (state, accounts, add/remove, secret, call, grants, requests approve/deny, apps, audit, matrix, interfaces, providers, sessions): without it, 401 `{ error, login: '/login' }` | `/api/health` (only `{ ok: true }`) |
| `/oauth/*` (Google's sign-in comes back to a top-level GET, which carries the Lax cookie) | `/extractor` (the extractor's token), `/consumer` and `/consumer/liveview/:id` (the app's token) |
| `/api/approvers*` (paired phones, a new pairing code: [approver.md](approver.md)) | `POST /approver/pair` (a one-time code from the page) and `GET /approver/ws` (the phone's own key), never from a browser (a request with an `Origin` is refused) |
| `/api/liveview/:id`, the page's live view socket | `/api/apps/register`, `/api/apps/:id/requests`, `/api/apps/:id/self` (this machine only, never a browser, as before) |
| `/api/accounts/import`, `/api/accounts/forget`: the CLI's token only, from this machine, never a browser (they add or drop accounts with no approval on the page) | |

An app that registers still only files requests: approving them is the page's (or `cli.ts approve`), behind the login.

## The password

`bun packages/manager/src/cli.ts set-password --file <file>`, or the password on stdin (`… set-password < file`, or
typed twice on a terminal, not echoed). It never comes from argv. At least 10 characters. It is kept only as an
argon2id hash (Bun.password, 64 MiB, t=3) in `<data>/login.json` (0600), with the fixed username `admin`. Setting it
again revokes every session (they are deleted, and any older than the new password is refused anyway). With no
`login.json` the login page says how to set one and every gated path stays shut.

The CLI's data dir is `--data`, else `$DITHER_ACCOUNTS_DATA`, else `~/.local/share/dither-accounts` when it exists.

## Sessions

- A login makes a 32-byte random token, sent as `dacc_session` (HttpOnly, SameSite=Lax, Path=/, Secure when the page is
  served over https: directly, or `X-Forwarded-Proto: https` from the proxy on this machine, which may reach us from this machine's tailnet address). The registry keeps only
  its sha256, with when it was made and last used, the user agent, and the address it signed in from and was last used
  from (`session` table in accounts.sqlite).
- It slides: it ends 90 days after its last use, and a year after its login at the latest. Its last use is written at
  most once a minute; the cookie's Max-Age is renewed at most once a day.
- **Sessions** on the page lists them and signs out one, or all but this one; **Log out** ends this one.
  `cli.ts sessions` and `cli.ts revoke-sessions` do the same from this machine.

## Failed logins

Per address (behind Caddy, the `X-Forwarded-For` it sets, trusted only from this machine's own addresses), five tries are free, then
each failure doubles the wait from 1 s up to 15 minutes; a success clears it. Overall, past 50 failures the same
doubling applies to everyone, so a spread-out guesser is slowed too (at the cost that it can hold you back a while).

## Cross-site writes

The cookie is SameSite=Lax, so other sites' POSTs do not carry it. As a second lock, every write a browser makes
(anything but GET/HEAD, and the live view socket) must carry an `Origin` (or, without one, a `Referer`) whose host is
the request's `Host`; one with neither is refused. That includes `/login` and `/logout`.

## The CLI

The manager writes a fresh random token to `<data>/cli.token` (0600) each start. `cli.ts` sends it in
`x-dither-accounts-cli`; it counts only from loopback, not through the proxy (no `X-Forwarded-For`) and not from a
browser (no `Origin`). Anyone who can read the data dir can already read the registry and the sessions' secrets.

## Tests and scripts

`test/auth.test.ts` covers the above. The other tests make their manager with `openPage: true` (tests only: the page
answers without a login; `main.ts` never sets it). `scripts/verify-ui.ts`, `verify-chat-add.ts` and `verify-dav.ts`
run a real manager, so they now meet the login: set a password in their data dir first and sign in, or send the CLI
token.
