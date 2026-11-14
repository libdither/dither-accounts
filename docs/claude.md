# Claude subscriptions on a CLIProxyAPI hub: the `claude` kind and the `cliproxy` provider

The setup described in https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af: every Claude subscription is
signed in to one always-on machine that runs [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), and Claude
Code on every machine uses that hub as its API (`ANTHROPIC_BASE_URL` + an access key) instead of its own login. The
hub keeps the sign-ins fresh, keeps a session on one account (prompt caches are per account), and moves on to the next
account when one runs out.

Run CLIProxyAPI yourself (it listens on 127.0.0.1:8317 by default; put it behind HTTPS if other machines use it). This
repo signs it in to the accounts and keeps it so, with no hands: claude.ai sends a sign-in link to the account's
address, and that address's mail account is in the manager too.

## Two rules (from the gist)

1. The subscriptions serve only Claude Code. No other app uses the hub.
2. Only your own traffic. Never anyone else's.

Pooling subscriptions this way may break Anthropic's terms, and the accounts may be suspended for it.

## The `claude` kind (extractors/claude)

claude.ai in a sandboxed browser (statements-common's BrowserHost: Xvfb, an ordinary Chromium with the account's
profile and an MV3 extension, x11vnc for the live view; no CDP, no automation flags). Config `{ email, mailAccount?,
authFile? }`. Its `claude` interface (packages/interfaces/src/claude.ts):

| op | level | does |
|---|---|---|
| `claude.session` | read | signed in or not, as which email (claude.ai's `/api/account`), the plan tiers |
| `claude.survey` | read | the tab's page as structure (headings, fields, buttons; never a value), for when a step finds the page unexpected |
| `claude.signin.start` | manage | `/login`, the account's email typed into the form, its email button pressed; waits for "check your email" |
| `claude.signin.finish {link}` | manage | opens `https://claude.ai/magic-link#…` in the same tab, waits until `/api/account` names the account's email |
| `claude.authorize {url}` | manage | opens an `https://claude.ai/oauth/authorize?…` URL whose `redirect_uri` is `http://localhost…` (and has a state and a PKCE challenge), presses Authorize, and hands back the URL claude.ai redirects to. Nothing listens there; the tab's URL is read. |

Refusals (409): `needs-you` (Cloudflare's check, or another only you can answer: the account goes to attention with the
live view until it is gone), `wrong-account`, `signed-out`, `no-form` (the message carries `claude.survey`'s output),
`bad-link`/`bad-url` (400), `busy`. It never reads a chat or sends a prompt, and never sees a token: the callback's
code is redeemed by the hub with its own PKCE verifier. Logs name steps and page paths, never a link, a query or the
callback.

## The `cliproxy` provider (packages/manager/src/providers/cliproxy.ts)

A link job, for one `claude` account:

1. `claude.session`; when signed in as the account's email, go to 3.
2. `claude.signin.start`, then the mail account here with that address (`mailAccount` in the config pins one) is
   searched (`mail.search "secure link to Claude"`, every 4 s, up to 4 minutes) for a mail from `@mail.anthropic.com`
   newer than the request; `mail.get` gives the link; `claude.signin.finish`.
3. The hub's `GET /v0/management/anthropic-auth-url` gives `{url, state}`; `claude.authorize` approves it; the callback
   URL goes to the hub (`POST /v0/management/oauth-callback {provider: anthropic, redirect_url}`); `get-auth-status`
   until `ok`. The hub's new auth file (found by email in `GET /auth-files`) is kept as the account's `authFile`.

Steps: `starting`, `signing-in`, `waiting-for-mail`, `opening-link`, `authorizing`, `exchanging`, then `done`,
`needs-you` (open the live view, then relink) or `error`.

The watchdog (every 5 minutes; `DITHER_CLIPROXY_WATCH_MS` for tests) reads `GET /auth-files`:

- an account whose sign-in the hub cannot renew any more (`next_action: sign_in`, or a refresh refused with 400/401 or
  `invalid_grant`) is linked again by itself, at most once every 6 hours;
- **soonest reset first** (what a fork of the hub adds, done here without one): each enabled Claude credential with a
  known weekly reset (`anthropic-ratelimit-unified-7d-reset` in the hub's quota signals, seen on its last response) gets
  a priority, the soonest the highest, through `PATCH /auth-files/fields {name, priority}`; one whose reset is not known
  yet ranks with the soonest, so it gets traffic and its reset becomes known; disabled ones 0. The hub serves the
  highest priority first (round-robin among equals), and a session stays on its account (`session-affinity`).

The hub's URL and management key: `PUT /api/providers/cliproxy/hub {url, managementKey}` (kept in
`<data>/providers/cliproxy.json`, 0600), which `cli.ts cliproxy connect [keys.env]` does from the hub's `keys.env`
(`CLIPROXY_URL`, default `http://127.0.0.1:8317`, and `CLIPROXY_MANAGEMENT_KEY`). Pass the file; with none, the CLI
tries `~/.local/share/cliproxyapi/keys.env`. The manager itself tries no default path, so a test's manager never finds
a real hub; `$DITHER_CLIPROXY_KEYS` may name a keys.env for it instead.

### API (behind the page login, or the CLI token from this machine)

| route | |
|---|---|
| `GET /api/providers/cliproxy[?fresh=1]` | the hub, each Claude account with its hub sign-in (status, disabled, needs sign-in, refresh error, priority, weekly reset) and last job; sign-ins on the hub no account here knows |
| `PUT /api/providers/cliproxy/hub {url, managementKey}` | |
| `POST /api/providers/cliproxy/claude {email, mailAccount?}` | makes (or finds) the `claude` account and starts a link job: `{job}` |
| `GET /api/providers/cliproxy/jobs/:id` | `{job}`: `step`, `error`, `liveView` |
| `POST /api/providers/cliproxy/claude/:account/relink` | a new link job |
| `POST /api/providers/cliproxy/claude/:account/enable` / `disable` | in or out of the hub's rotation (`PATCH /auth-files/status`) |
| `DELETE /api/providers/cliproxy/claude/:account` | removes the hub's sign-in; the browser stays signed in |

CLI: `bun packages/manager/src/cli.ts cliproxy status | connect [keys.env] | add-claude <email> [--mail <account>] |
relink|enable|disable|remove <account>`; `add-claude` and `relink` follow the job to its end.

## Clients

On any machine (the hub's own machine can use `http://127.0.0.1:8317`), with the access key from the hub's `keys.env`
(`CLIPROXY_API_KEY`):

```json
{ "env": { "ANTHROPIC_BASE_URL": "https://cliproxy.example.net", "ANTHROPIC_AUTH_TOKEN": "<CLIPROXY_API_KEY>" } }
```

in `~/.claude/settings.json`, or first in a second config dir (`CLAUDE_CONFIG_DIR=~/.claude-cliproxy claude`) to try
it without touching the normal login. The hub's own panel is `https://cliproxy.example.net/management.html` (the
management key).

## Checklist (real accounts)

- [ ] `cli.ts cliproxy connect <keys.env>`, then `cli.ts cliproxy status` shows the hub.
- [ ] `cli.ts cliproxy add-claude <email>`: the job reaches `done`; the hub lists the account's auth file.
- [ ] `curl -H "Authorization: Bearer $CLIPROXY_API_KEY" https://cliproxy.example.net/v1/models` lists Claude models.
- [ ] One prompt through the hub from a second config dir.
- [ ] After traffic, `cliproxy status` shows a weekly reset and priorities.
