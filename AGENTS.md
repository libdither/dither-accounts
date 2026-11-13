# dither-accounts: notes for agents

A self-hosted accounts manager. Extractors (extractors/<kind>) hold each account's session (a sandboxed browser, a
linked device, an API token); apps (dither-chat, dither-calendar, a finance ledger) ask for interfaces on accounts at
a level, the owner approves on the manager's page, and the manager routes calls and events between them. The repo is
public, so it holds code and generic docs only.

## Keep concrete data and local configuration out of the repo
Nothing in the repo may identify the owner or describe their accounts, money, people or machine.

- **Never commit:** real names (the owner's or anyone else's), handles, phone numbers, email addresses, account
  numbers, ids or masks, balances, amounts and dates of real transactions, postal or wallet addresses, hostnames,
  domains, IP addresses (tailnet or LAN) and machine-specific ports or paths, merchants, employers, schools or
  communities tied to the owner, and anything about the owner's life. Never commit secrets, cookies, tokens, passkeys,
  session dumps, or pages, responses or traces captured from a real account. That holds for code, comments, docs,
  tests, fixtures, examples, commit messages and PR text.
- **Where those go instead:**
  - `<data>/config.toml` for the manager's settings (packages/manager/src/main.ts reads its `[manager]` table;
    config.example.toml lists every key with a neutral default). `<data>` is `--data` / `DITHER_ACCOUNTS_DATA`.
  - `<data>/accounts/<id>/` for each account's config, `secret.json` and browser profile. The manager writes these;
    never copy anything from them into the repo.
  - `CLAUDE.local.md` (untracked) for notes about this machine and the owner's accounts.
- **New code:**
  - A new manager setting gets a flag, a localhost or neutral default in main.ts, and a line in config.example.toml.
  - A kind's per-account settings go in its manifest's add form (config or secret fields), never as defaults that fit
    one person.
  - Tests and fixtures use invented data: "Ann Lee", "ACME BANK", `acct-123`, `alice@example.com`, phone numbers in
    +1 555 01xx, snowflakes like `700000000000000001`. Shape a fixture after a real response by hand; never save one.
- **Before every commit**, read `git diff --cached` for the above. A quick sweep:
  `git grep -nIE '[0-9]{9,}|@[a-z0-9-]+\.[a-z]{2,}|100\.64\.|192\.168\.|\.ts\.net|/home/'`. Most hits are invented
  ids and example.com addresses; read each new one. Then look for names by eye: a pattern can't find them.

## Working on it
- Bun (see .github/workflows/ci.yml for the version). `bun install`, then `bun run typecheck`, `bun run web:build`
  and `bun run test`; CI runs those three. Tests that need a Nix machine's tools (Xvfb, Chromium, x11vnc, bubblewrap,
  Radicale, Dovecot) skip elsewhere (test/needs.ts).
- Tests run managers on fresh temp data dirs, port 0, with fakes (test/fake-*.ts, extractors/*/test). Nothing in a
  test reaches the network or a real account.
- Interfaces: after changing one, `bun scripts/gen-types.ts` (a test fails when types.generated.json is stale).
- apps/android (the approver app) has its own check: `./gradlew testDebugUnitTest assembleDebug`.
- Each kind has a doc in docs/; keep it true when the kind changes, and add one for a new kind.
- Secrets: an account's credentials live only in its `secret.json` (0600, in a 0700 directory) and reach only its
  extractor; never log them, put them in a status or send them to an app. Logs name steps and paths, not values.
- Never sign in, send, pay, trade or change anything on a real account from a test or script, and never solve
  captchas or accept terms for one.
- Commit messages: "<area>: what changed, in a plain sentence".
