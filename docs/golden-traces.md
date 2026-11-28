# Golden wire traces

Fixtures shaped by hand follow what we believe a network sends. Golden traces are what it did send: real payloads
from a local testbed, anonymized so they can live in this public repo, replayed by tests with no server.

## The pieces

- `packages/manager/src/wire-capture.ts`
  - `anonymizeTrace(records, opts)` walks any JSON and swaps each identifying token for a synthetic one, the same
    one for the same input across the whole trace, keys included, so ids still point at each other:
    - UUIDs become `00000000-0000-4000-8000-000000000001`, `…002`, …
    - phone numbers become `+15550100`, `+15550101`, … and emails `user1@example.com`, …
    - Matrix ids become `@alice:example.test`, `!room1:example.test`, `$ev1`, `#alias1:example.test`
    - long numeric ids (9 digits or more) become `700000000000000001`, …
    - epoch times (ms or s) are rebased so the earliest is `1700000000000`, every delta kept exactly
    - hostnames (the servers Matrix ids name, and any given in `hosts`), tailnet names, IP addresses other than
      loopback, home paths and `acc_…` ids become placeholders
  - `scrubText` (on by default) also replaces message bodies and names (`message 1`, `Alice`), keeping HTML tags and
    an edit's `* `. Testbed traces turn it off: their text is invented. `preset` keeps a testbed's invented user
    names.
  - `assertNoConcreteLeaks(text)` is the AGENTS.md sweep as a check: it masks the synthetic shapes above, then throws a
    `LeakError` (saying what and where, never the value) if long numbers, emails, phones, tailnet or LAN addresses,
    other IPs, `.ts.net`, `/home/` or account ids remain. Nothing is written without passing it.
  - `AdapterStreamRecorder` records what the manager and an extractor say to each other (commands and events), one
    anonymized NDJSON file per account in `DITHER_WIRE_CAPTURE_DIR`. Unset, the supervisor holds no recorder and
    records nothing. A line the guard refuses is left out (a `dropped` marker stands in its place).
- `scripts/capture-fixtures.ts`
  - `scrub <input> <output> [--keep-text] [--host <name>]…` anonymizes a captured trace (NDJSON or JSON) and refuses
    to write if the guard fails.
  - `matrix-golden` starts a fresh continuwuity per scenario (temp dir, free port; continuwuity ignores a sync
    filter's room list, so a scenario gets a server of its own), registers quinn, alice and bob, runs the scenario,
    keeps every `/sync` response quinn got, and writes `extractors/matrix/test/golden/<scenario>.json`.
- `extractors/matrix/test/golden-replay.test.ts` serves those responses in order from a fake homeserver (checking the
  adapter asks with each `next_batch`) and asserts what the hub ends up with.

## Rules

- Committed traces come from local testbeds with invented users only. A trace from a real account stays on this
  machine even scrubbed: the repo never holds one (AGENTS.md). Scrubbing one is for shaping a fixture by hand.
- Read a new trace before committing it, and run the sweep from AGENTS.md: the guard cannot see names.
- Capture again after changing a scenario: `bun scripts/capture-fixtures.ts matrix-golden` (needs continuwuity:
  `CONTINUWUITY_BIN`, `conduwuit` on PATH, or Nix to build it).
