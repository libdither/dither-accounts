# The supervisor: extractors that outlive the manager

The manager runs one extractor process per enabled account (`packages/manager/src/supervisor.ts`). Restarting the
manager (a deploy, `systemctl --user restart`, a crash) does **not** restart the accounts: their extractors keep their
sessions (a signed-in browser, a Telegram or WhatsApp connection) and the next manager takes them over. To the networks
a deploy is then invisible; before, every deploy relaunched every browser and reconnected every account at once, a
pattern that looks like a bot.

## How an extractor is started

`launch` (flag `--launch`, `DITHER_ACCOUNTS_LAUNCH`, or `[manager] launch` in config.toml) picks one of:

| | |
|---|---|
| `scope` | `systemd-run --user --scope …`: the extractor gets a systemd scope of its own (`dither-accounts-x-<account>-<stamp>.scope`) and a session of its own. Stopping or restarting the manager's unit kills the unit's control group, and the extractor is not in it. |
| `detached` | A session of its own only. It outlives the manager's process, but not a systemd unit's stop. For a manager run by something other than systemd, and for tests. |
| `child` | A plain child, stopped with the manager: the old behaviour. |
| `auto` (default) | `scope` when the manager runs as a systemd service (`INVOCATION_ID` is set) and a trial `systemd-run --user --scope true` works; else `child`, so a manager run in a terminal still stops its extractors on Ctrl-C. |

The manager's start line in its log says which one it uses (`launch=scope`). The unit file needs no change: with
`KillMode=mixed` or `control-group` alike, only the unit's own control group is signalled.

In every mode the extractor's stdout and stderr go straight to the account's `adapter.log` (a file descriptor, not a
pipe through the manager), so a manager that goes cannot break a pipe under it. When an extractor crashes, the error
file's record (errors.ts, `onFailedExit`) is made from the last lines of that log since its start.

Its environment says whose it is: `DITHER_MANAGER_DATA` (the manager's data directory), `DITHER_EXTRACTOR_LAUNCH`, and
`DITHER_EXTRACTOR_FINGERPRINT` (below), besides the account's id and token. Its paths are the real ones (a release
reached through the `current` link is resolved first), so one that lives on keeps loading its own release's files
after a deploy moves the link.

## When the manager stops

On SIGTERM or SIGINT, main.ts stops the manager with `leaveExtractors`: extractors launched as `scope` or `detached`
(and adopted ones) are left running; the rest stop as before. A deliberate stop of an account (disabled, Stop or
Restart on the page, removed, a secret replaced) still stops its extractor, adopted or not: SIGTERM after a
`shutdown` on its socket, SIGKILL after 8 s.

The extractor's link (`packages/link`, and the chat extractors' `packages/chat-protocol` adapter-client.ts) reconnects
within seconds (250 ms doubling to 5 s), keeping everything it holds; events emitted meanwhile are queued and sent on
reconnect, and its `onConnect` says hello and its status again, so apps and the page see the account as before. An
extractor that has had no manager for `DITHER_MANAGER_GONE_EXIT_S` (30 minutes, set by the manager in the surviving
modes) shuts itself down, so none is left running for good by a manager that does not come back.

To stop every extractor by hand along with the manager: `systemctl --user stop dither-accounts 'dither-accounts-x-*'`.

## When the manager starts: adoption

For each enabled account, before starting anything, the manager looks in `/proc` for an extractor an earlier manager
of **the same data directory** started for it with the account's current token. If one runs, it is adopted:

- The account's lock (`extractor.lock`) names this manager again; the adopted pid is not counted as someone else's.
- It is watched in `/proc` each second (it is no child, so there is no exit to wait for), by pid **and** start time:
  a pid the kernel has handed to another process is not taken for it, and is never signalled.
- When it ends, its exit code is read from `extractor.exit`, which the link writes in the account's directory as the
  process exits, and it is restarted with the usual backoff, as a crashed child would be.
- One that has not connected within a minute is taken for stuck and started afresh.
- The page's account pane says so: "kept running through the manager's restart".

Then the strays: an earlier manager's extractor (same data directory) for an account now disabled or removed, or
carrying a token that is no longer the account's, is stopped. Processes of another data directory (a test manager, a
second install) are never touched.

## Only changed code restarts

Each extractor carries the fingerprint of the code it was started with (`fingerprint.ts`): starting from the kind's
entry, Bun's import scan finds the packages of this repo it loads at run time (its own directory, `packages/browser`,
`packages/chat-protocol`… but not `packages/manager` for a manifest's type), each hashed whole by relative path and
contents (without `node_modules` and tests, so files read as files, such as a browser extension, count), plus the
name and installed version of each npm package it imports directly. The same computation over the new release gives
the new manager's fingerprint.

An adopted extractor whose fingerprint differs is restarted, gracefully and **one at a time**: 20 s after the manager
starts, then the next 20 s after the previous one is online again (or a minute). One whose code did not change keeps
running, across any number of deploys. Not seen: a version that changes only deep inside npm's tree.

An adopted extractor runs from the release it started in. The deployer (dither-chat's `packages/deploy`) prunes old
releases but keeps every one a running process uses (its working directory or command line is in it).

## Discord's startup backfill

After each start the Discord extractor fetches the latest 20 messages of up to 40 DMs and channels with unread
mentions. What it fetched is kept in the account's directory (`backfill.json`, 0600: channel id → the newest message
id fetched, and when); the next start skips a channel whose newest message is still that one. Entries expire after
three days.
