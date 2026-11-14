# The supervisor: extractors that outlive the manager

The manager runs one extractor process per enabled account (`packages/manager/src/supervisor.ts`). Restarting the
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

The manager's start line in its log says which one it uses (`launch=scope`). The unit file needs no change.

In every mode the extractor's stdout and stderr go straight to the account's `adapter.log` (a file descriptor, not a
pipe through the manager), so a manager that goes cannot break a pipe under it. When an extractor crashes, the error
file's record (errors.ts, `onFailedExit`) is made from the last lines of that log since its start.

Its environment says whose it is: `DITHER_MANAGER_DATA` (the manager's data directory), `DITHER_EXTRACTOR_LAUNCH`, and
`DITHER_EXTRACTOR_FINGERPRINT` (below), besides the account's id and token. Its paths are the real ones (a release
reached through the `current` link is resolved first), so one that lives on keeps loading its own release's files
after a deploy moves the link.

One manager per data directory: `<data>/manager.lock` names it, and a second one refuses to start (it would adopt and
stop the first one's extractors).

## Stopping an extractor, and everything it started

A stop (an account disabled, Stop or Restart on the page or from an app, removed, a secret replaced) sends `shutdown`
on its socket and SIGTERM, then SIGKILL after 8 s. Then whatever is left of it is ended too (SIGTERM, SIGKILL after
3 s): every process in its scope's control group, its process group, its descendants as they were before the stop,
and every process carrying its account and this data directory in its environment (Chromium and its zygotes, Xvfb,
signal-cli, the WhatsApp bridge inherit it, whatever process group or session they moved to). The same happens after
an extractor crashes, before the next one starts, and before any start that finds such leftovers: a browser or
signal-cli left behind would be a second session on one account.

## When the manager stops: restart or stop

On SIGTERM, main.ts asks systemd what is happening to its unit (`systemctl --user list-jobs`): a `restart` job (a
deploy, `systemctl --user restart`) leaves extractors that can outlive it running for the next manager; a `stop` job
(`systemctl --user stop`, `disable --now`, a shutdown), or no job, stops them all, as before. A `detached` launch
outside systemd always leaves them; a `child` launch always stops them.

### Handing over

On a restart nothing in flight is lost:

1. The going manager sends each extractor it leaves `manager-going`. Its link answers `holding`, and from then on keeps
   every event in its queue for the next manager. The answer comes after every frame sent before it on the same
   socket, so the going manager has them all (it waits at most 2 s).
2. It sends apps what waits in their outboxes, and writes what it holds for apps that are away (their buffered events
   and the accounts they already missed events of) to `<data>/handover.json` (0600), with the extractors that
   answered `holding`.
3. The next manager reads that file once (and deletes it: it holds message events), holds its events for those apps
   before anything new, and adopts the extractors, which reconnect and send what they kept.
4. An adopted extractor not named in a handover (the manager before crashed, or the extractor did not answer) may have
   lost events: every app with a grant on it hears of a `gap` for it and starts it over (dither-chat's hub restarts it
   for a fresh snapshot).

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
- the name and installed version of each npm package it imports directly, the repo's `bun.lock`, `package.json` and
  `tsconfig.json`, and Bun's version;
- the environment it is given that is not per account (its kind's `env`, `PATH`, `DITHER_*` settings), hashed.

The same computation over the new release gives the new manager's fingerprint. A fingerprint that could not be made
counts as changed. An adopted extractor whose fingerprint differs is restarted, gracefully and **one at a time**:
20 s after the manager starts, then the next 20 s after the previous one is online again (or a minute). One stopped on
purpose meanwhile stays stopped. One whose code did not change keeps running, across any number of deploys.

`/api/health` says how that goes, in counts only: `codeRestarts: {queued, active, restarted, online, crashed}`. The
deployer (dither-chat's `packages/deploy`) waits after a deploy of dither-accounts until nothing is queued or active,
then holds it to every restarted extractor being online and none having crashed since, a little later; otherwise it
rolls back. It also keeps every old release a running process still uses.

## Discord's startup backfill

After each start the Discord extractor fetches the latest 20 messages of up to 40 DMs and channels with unread
mentions. What it fetched is kept in the account's directory (`backfill.json`, 0600: channel id → the newest message
id fetched, and when), once messages came back and their events went out; the next start skips a channel whose newest
message is still that one. Entries expire after three days.
