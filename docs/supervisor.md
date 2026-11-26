# The supervisor: extractors that outlive the manager

The manager runs one extractor process per enabled account (`packages/manager/src/supervisor.ts`), except while one
of a kind that may sleep has nothing to do ([Sleeping](#sleeping-browser-accounts-only-needed-now-and-then)). Restarting the
manager (a deploy, `systemctl --user restart`) does **not** restart the accounts: their extractors keep their sessions
(a signed-in browser, a Telegram or WhatsApp connection) and the next manager takes them over. To the networks a deploy
is then invisible; before, every deploy relaunched every browser and reconnected every account at once, a pattern
that looks like a bot. Stopping the manager (`systemctl --user stop`) still stops them all.

## How an extractor is started

`launch` (flag `--launch`, `DITHER_ACCOUNTS_LAUNCH`, or `[manager] launch` in config.toml) picks one of:

| | |
|---|---|
| `scope` | `systemd-run --user --scope …`: the extractor gets a systemd scope of its own (`dither-accounts-x-<account>-<stamp>.scope`) and a session of its own. Stopping or restarting the manager's unit kills the unit's control group, and the extractor is not in it. |
| `detached` | A session of its own only. It outlives the manager's process, but not a systemd unit's stop. For a manager run by something other than systemd, and for tests. |
| `child` | A plain child, stopped with the manager: the old behaviour. |
| `auto` (default) | `scope` when the manager is the **main process of a systemd user service** (its control group is `<name>.service` and the unit's MainPID is its pid) and a trial `systemd-run --user --scope true` works; else `child`. A shell or script that only inherited a service's `INVOCATION_ID` (an agent's shell, a trial manager from a script) is not a service, so its extractors stop with it. |

The manager's log says which one it uses and why (`launch=scope: the main process of dither-accounts.service, and
systemd-run --user --scope works`, or what kept it from a scope). Right at a service's start systemd may not have
recorded its main process yet; that is asked again for a few seconds. The unit file needs no change.

In every mode the extractor's stdout and stderr go straight to the account's `adapter.log` (a file descriptor, not a
pipe through the manager), so a manager that goes cannot break a pipe under it. When an extractor crashes, the error
file's record (errors.ts, `onFailedExit`) is made from the last lines of that log since its start.

Its environment says whose it is: `DITHER_MANAGER_DATA` (the manager's data directory), `DITHER_EXTRACTOR_LAUNCH`, and
`DITHER_EXTRACTOR_FINGERPRINT` (below), besides the account's id and token. Its paths are the real ones (a release
reached through the `current` link is resolved first), so one that lives on keeps loading its own release's files
after a deploy moves the link.

An extractor of a kind with a screen (its manifest's `screen`: the browser kinds, Discord, Signal and Telegram
Desktop, Haveno) also gets `DITHER_DISPLAY_BACKEND` (below) and `DITHER_BINS`, the directory of its sandboxes'
programs the manager builds at its start from the repo's pinned nixpkgs (`packages/manager/src/prepare.ts`,
nix/README.md). Its start waits until that build is done (a few seconds when the store has them); a failed build keeps the last good directory, and with none the sandboxes look on PATH. Every
other kind starts at once and gets neither.

One manager per data directory: `<data>/manager.lock` names it, and a second one refuses to start (it would adopt and
stop the first one's extractors).

## Stopping an extractor, and everything it started

A stop (an account disabled, Stop or Restart on the page or from an app, removed, a secret replaced) sends `shutdown`
on its socket and SIGTERM, then SIGKILL after 8 s. Then whatever is left of it is ended too (SIGTERM, SIGKILL after
2 s). What is its is taken **before** it is signalled: every process in its scope's control group, its process group,
its descendants, every process carrying its account and this data directory in its environment (Chromium and its
zygotes, signal-cli, the WhatsApp bridge inherit it, whatever process group or session they moved to), and what a
native-app sandbox of the account records in its `sandbox.json` (packages/sandbox: bubblewrap clears the environment,
so Telegram Desktop's or Haveno's Xvfb, x11vnc (or sway, wayvnc), dbus-daemon, pasta and the app carry no account id; the record names
each by pid and start time). The same happens after an extractor crashes, before the next one starts, and before any
start that finds such leftovers: a browser or signal-cli left behind would be a second session on one account.

One stop of an account at a time, and a start asked for while one is under way waits for it, so a stop never ends or
forgets the extractor of the start that followed it.

### Calls while an extractor starts, restarts or reconnects

Each account's connection to its extractor follows one rule for being replaced (packages/spec/src/handover.ts):

- While its extractor starts (a start, the page's Restart, a restart for changed code), a call waits for it to
  connect, for at most 20 s (`START_OPEN_MS`) and within the call's own time, then runs. One that could not be sent by
  then fails `retry` (503): it never reached an extractor, so it is safe to send again.
- When its socket drops while its process runs, its link connects again within a second or so and sends the answers it
  made meanwhile: calls wait (at most 10 s, `RECONNECT_OPEN_MS`), and the ones it had are answered on the new socket.
- A call the extractor had when it ended (a crash, a stop, a Restart) fails at once, `offline`, not after its timeout:
  it may have run. A read is run again on the new process instead, once, when a Restart is under way.
- A call to an account with no extractor running, or one stopped on purpose, fails at once (`offline`). One to an
  account asleep wakes it and waits for it ([Sleeping](#sleeping-browser-accounts-only-needed-now-and-then)).

`test/extractor-swap.test.ts` cuts the connection in each of these ways with calls on it, and checks that each call is
answered exactly once or refused with one of those words (test/cut-mid-call.ts).

A whole stop of the manager takes at most about 15 s (SIGKILL at 8 s, 2 + 1 s for what is left, `list-jobs` bounded to
3 s), inside the unit's `TimeoutStopSec` (30 s on this setup; keep it at 20 s or more).

## When the manager stops: restart or stop

On SIGTERM, main.ts asks systemd what is happening to its unit (`systemctl --user list-jobs`): a `restart` job (a
deploy, `systemctl --user restart`) leaves extractors that can outlive it running for the next manager; a `stop` job
(`systemctl --user stop`, `disable --now`, a shutdown), or no job, stops them all, as before. A `detached` launch
outside systemd always leaves them; a `child` launch always stops them.
Its "dither-accounts going" line says which, with the job systemd listed for the unit (or how `systemctl` failed: that
counts as a stop).

### Handing over

On a restart nothing in flight is lost:

1. The going manager sends each extractor it leaves `manager-going`. Its link answers `holding`, and from then on keeps
   every event in its queue for the next manager. The answer comes after every frame sent before it on the same
   socket, so the going manager has them all (it waits at most 5 s).
2. It sends apps what waits in their outboxes, and writes what it holds for apps that are away (their buffered events
   and the accounts they already missed events of) to `<data>/handover.json` (0600), with the extractors that
   answered `holding`, its pid and start time, its release and its data directory.
3. The next manager reads that file once (and deletes it, and any half-written `handover.json.tmp`: it holds message
   events), holds its events for those apps before anything new, and adopts the extractors, which reconnect and send
   what they kept. A handover that is more than five minutes old, of another data directory or user, or whose writer
   still runs is set aside as if there were none.
4. Back on a new socket, a link first says `resumed`, and whether it was holding when the old socket closed (a link
   whose queue overflowed meanwhile says it was not). Only an adopted extractor's first return counts. Without a
   handover (the manager before crashed) every adopted extractor may have lost events; with one, only an extractor
   that it does not name and that says it was not holding. For those, every app with a grant on the account hears of
   a `gap` and starts it over (dither-chat's hub restarts it for a fresh snapshot, one account of a kind at a time). The start
   that follows a gap gets `DITHER_RESYNC=1`: what the extractor kept from before is not trusted (Discord's backfill
   memory, below).

The handshake lives in `packages/chat-protocol/src/outlive.ts`, outside the copy of dither-chat's protocol
(adapter-client.ts only calls it), and `test/outlive.test.ts` fails if either link stops answering.

The extractor's link (`packages/link`, and the chat extractors' `packages/chat-protocol` adapter-client.ts) reconnects
within seconds (250 ms doubling to 5 s), keeping everything, and its `onConnect` says hello and its status again, so
apps and the page see the account as before. An extractor that has had no manager for `DITHER_MANAGER_GONE_EXIT_S`
(30 minutes, set by the manager in the surviving modes) shuts itself down, so none is left running for good by a
manager that does not come back.

## When the manager starts: adoption

For each enabled account, before starting anything, the manager looks in `/proc` for an extractor an earlier manager
of **the same data directory** started for it with the account's current token. If one runs, it is adopted:

- The account's lock (`extractor.lock`) names this manager again; the adopted pid is not counted as someone else's.
- It is watched in `/proc` each second (it is no child, so there is no exit to wait for), by pid **and** start time:
  a pid the kernel has handed to another process is not taken for it, and is never signalled.
- When it ends, its exit code is read from `extractor.exit`, which the link writes in the account's directory as the
  process exits. With no record of it (SIGKILL, the OOM killer) it ended by signal `killed`. Either way it is a crash
  as a child's would be: recorded in the error file, what it left ended, and started again with the usual backoff.
- One that has not connected within a minute is taken for stuck: it and everything it started end, and a fresh one
  starts.
- The page's account pane says so: "kept running through the manager's restart".

Then the strays: an earlier manager's extractor (same data directory) for an account now disabled or removed, of a
kind that no longer loads, or carrying a token that is no longer the account's, is stopped with all it started. A
disabled account's extractor is not let onto the socket. Processes of another data directory (a test manager, a
second install) are never touched.

## Only changed code restarts

Each extractor carries the fingerprint of the code it was started with (`fingerprint.ts`):

- every file of this repo its entry reaches through its imports (Bun's import scan, so type-only imports, which run
  nothing, are left out): a change to a part of `packages/chat-protocol` that Discord does not import leaves Discord;
- in each package those files belong to, every file that is not TypeScript (a browser extension's scripts, a page
  script, a proto), which extractors read as files;
- the name and installed version of each npm package it imports directly, and `bun.lock`'s entries (version and
  integrity) for those and everything they depend on, not the whole lock: a dependency added for another extractor
  restarts nothing else; of the root `package.json` only what changes what is installed for every package (overrides,
  resolutions, patches, trusted dependencies), of `tsconfig.json` only what Bun reads at run time; Bun's version;
- the environment it is given that is not per account (its kind's `env`, `PATH`, `DITHER_*` settings), hashed.

The same computation over the new release gives the new manager's fingerprint. A fingerprint that could not be made
counts as changed. An adopted extractor whose fingerprint differs is restarted, gracefully and **one at a time per
kind**: 20 s after the manager starts, then the next of that kind 20 s after the previous one is online again (or a
minute; one not online by then stops its kind's restarts, so the rest of that kind keep their old code, and the
deployer rolls the deploy back). From the moment its turn comes, calls wait for the new process, and before it stops
the old one, it waits until the calls that one already has are answered (up to 30 s, `RESTART_DRAIN_MS`), so a deploy
does not fail an app's call midway, and an app that polls without pause cannot hold the restart up. Different kinds restart side by side: a Discord and a Telegram account at once is not what looks like a bot
to either network; every account at once, or two of one network together, is. One stopped on purpose meanwhile stays
stopped (so does one stopped while a Restart waits for its stop). One whose code did not change keeps running, across
any number of deploys.

The display backend restarts the same way, for kinds with a screen only. Each such extractor is started with
`DITHER_DISPLAY_BACKEND` (one of docs/browser.md's "Display backends": its account's `displayBackend`, else the
default picked on the manager's page, else config.toml's `display_backend`), and an adopted one started with another
than its account now wants is restarted in the same queue, one at a time per kind. A default picked on the page
(`PUT /api/display`) puts the running accounts that follow it in that same queue (`moveScreens`), the first of each
kind without the pause: two quick changes, or one during a deploy's restarts, still restart one account of a kind at a
time, and an account restarted for its code and its screen together restarts once. A moved account that does not come
back online, with its live view again if it had one, within the minute stops its kind's queue, as a deploy's does: the
others stay where they are. So a new default reaches every account without moving them all at once, and
an account that names its own backend is not touched by it, and a kind with no screen (mail, calendar, signal-cli)
never restarts for it. `DITHER_DISPLAY_BACKEND` is per account, so it is not part of the fingerprint;
the manager's own setting (`DITHER_ACCOUNTS_DISPLAY_BACKEND`) is not either, as no `DITHER_ACCOUNTS_*` is.

`/api/health` says how that goes, in counts only: `codeRestarts: {queued, active, restarted, online, crashed}`
(`active`: restarts under way now), where `crashed` counts only restarted extractors that ended on their own with a
failure since (a restart from the page, an app or a gap is none). The deployer (dither-chat's `packages/deploy`) waits
after a deploy of dither-accounts for those restarts, within its time; a crash of a restarted extractor rolls the
deploy back, while restarts still under way when its time is up are only said in the notice (later crashes reach you
through the manager's own notices). It also keeps every old release a running process still uses.

## Sleeping: browser accounts only needed now and then

A browser account holds 350–700 MB of memory and swap (Xvfb, Chromium, x11vnc) whether anything uses it or not. A
kind whose accounts work only now and then says so in its manifest (`sleep: { idleMinutes, keepAliveHours? }`,
kinds.ts), and its accounts **sleep**: the extractor stops while it has nothing to do, and starts again when something
needs it.

| kind | idle | keep-alive | |
|---|---|---|---|
| `amazon` | 20 min | 6 h | the daily pull and the odd `browser.*` call; woken every 6 h so its long-lived sign-in is used |
| `venmo` | 20 min | none | the daily pull; Venmo ends an idle session after ~30 minutes whether its browser runs or not |
| `schwab` | 20 min | none | the daily pull, which signs in with the passkey: Schwab logs an idle session out anyway |
| `privacy` | 20 min | none | the daily pull, which signs in with the passkey: Privacy's sessions last minutes |
| `claude` | 15 min | none | only the cliproxy provider's link jobs use it (docs/claude.md) |

Never a kind apps expect live events from: the chat kinds (Discord, Signal, Telegram, WhatsApp, X…), Proton's and
Gmail's watch. Reddit, Substack and Partiful poll their sites every few minutes for dither-chat's feed, so they stay
awake too.

**When it falls asleep.** The supervisor looks every 30 s. An account falls asleep after its kind's idle minutes during
which all of this held:

- its extractor is connected, and its last status says `online` with no `attention` (one that needs you stays up, its
  live view with it);
- no call is under way or waiting for it;
- nothing holds it awake: its live view open (the page's or an app's), a cliproxy link job;
- its extractor has said that it may (`link.sleep`, below) and is not busy: a pull, a passkey sign-in, browser tabs an
  app opened (`browser.*`, closed after 15 idle minutes);
- its next run is not due within the 2-minute lead plus 10 minutes (a stop and a start would cost more than they save).

The idle time counts from the last moment one of those did not hold: the last call's answer, the live view's close, a
pull's end. Falling asleep is the usual stop (`shutdown`, then everything it started ends), and the log says `idle for
N min: asleep until …`.

**What it says.** `asleep`: on the page (a ring for a dot, "Asleep"; the pane says since when and when it wakes, with
**Wake**), in `/api/state` and `cli.ts accounts`, and to apps in their account list (spec `AccountView.asleep`, with
`running` and `online` false and `error` null). It is neither stopped nor in trouble: the manager's notices leave it
out, it keeps its last status (all but its live view, which went with it), and an app reads it as "a call wakes it",
never as broken. While it falls asleep (its stop takes a few seconds) it still counts as running.

**What wakes it.**

- **A call** (an app's, the page's Try it, a provider's): it starts, and the call waits for it, for at most 30 s
  (`WAKE_OPEN_MS`) within the call's own time; one that could not be sent by then fails `retry` (503), safe to send
  again. A call that comes while it falls asleep waits for the stop, then for the start.
- **Its own next run**: its extractor says when that is (statements' daily pull, or a failed pull's hourly retry), and
  it is started 2 minutes before, so its browser is up by then.
- **A keep-alive**: a kind with `keepAliveHours` is woken at least that often, and sleeps again once idle.
- **You**: Wake, Start or Restart on the page or from an app, or turning Stay awake on. Its live view is not offered
  while it sleeps (there is none): Wake first.

A start that is a wake gets `DITHER_WOKE` (why, in words): it need not do what a start does for its own sake. Schwab and
Privacy then sign nothing in at start; the pull they were woken for signs in by itself.

**`link.sleep`.** The extractor of a kind that may sleep calls `link.sleep({ busy, wakeAt })`: what it is doing that a
stop would cut (null: nothing), and when it next needs to run by itself (ms since the epoch; null: no time of its own).
The link sends it when it changes and again on every connect, so a manager after a restart knows it too. An extractor
that has never said it does not sleep. statements-common's runner says it for the statements kinds (a pull under way,
the kind's own `busy`, the next pull or retry); claude says it while no step runs.

**Through a restart.** Who sleeps is in the registry (table `asleep`: since, wake_at, wake_for). The next manager leaves
those asleep (`startAll` starts none of them) and wakes each when the manager before would have, or at once if that
time passed while no manager ran. One whose extractor still runs (the manager went while it fell asleep) is adopted as
any other, and is awake. A going manager waits for an extractor that is falling asleep to stop, instead of leaving it
running. An adopted extractor sleeps as one this manager started: its link says again what it said before.

**Start, Stop, Restart, disable** keep their meaning: Stop and disable forget the sleep (a stopped account stays
stopped: a call fails `offline` and does not start it), Start and Restart wake it, removing it forgets it. **Stay
awake**, a setting every kind that may sleep gets, keeps one account running; it needs no restart, and turned on while
the account sleeps it wakes it. Turned off, the idle time counts from then.

**Settings** (`[manager]` in config.toml, or the flag or `DITHER_ACCOUNTS_*`): `sleep = 0` keeps every account awake;
`sleep_idle_minutes` sets every kind's idle time; `sleep_keep_alive_hours` the keep-alive of the kinds that have one (0:
none). `test/sleep.test.ts` covers falling asleep, a call waking it, both wakes by itself, a call, a busy extractor and
an open live view keeping it awake, a restart and an adoption, and the page's controls.

## Discord's startup backfill

After each start the Discord extractor fetches the latest 20 messages of up to 40 DMs and channels with unread
mentions. What it fetched is kept in the account's directory (`backfill.json`, 0600: channel id → the newest message
id fetched, and when), once messages came back and their events went out; the next start skips a channel whose newest
message is still that one. Entries expire after three days. A start after a gap (`DITHER_RESYNC=1`) skips nothing.
