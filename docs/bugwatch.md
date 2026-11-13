# Bug watch (kind `bugwatch`)

Your own services' errors as the `notifications` interface ([notifications.md](notifications.md)): it reads their
error files and logs on this machine, groups the errors by fingerprint, raises a notice for each new bug, and can hand
each one to a T3 coding thread that looks into it and opens a pull request for you to review. dither-chat's hub shows
its notices with the rest, ranked with your chats (its `docs/notices.md`). It holds no session and reaches nothing on
the network: it reads files and runs one command.

```
 error files, trace files, plain logs ─▶ extractors/bugwatch ─┬─▶ notify.new / notify.read ─▶ the manager ─▶ apps
            (tailed every 30 s)        fingerprint, new/spike  └─▶ the thread command (argv, brief on stdin)
```

Code: `extractors/bugwatch/src` (`readers.ts` tails and parses, `normalize.ts` fingerprints, `watch.ts` decides,
starts threads and makes notices, `main.ts` is the extractor, `cli.ts` the command line), the brief's template
`extractors/bugwatch/brief.md`, and the manager's own error file in `packages/manager/src/errors.ts`.

## Adding it

Write its config (below) somewhere outside the repository, then on the manager's page **Add → Bug watch** with the
config file's absolute path. It reads the last 24 hours of each source at once: bugs found there are listed (an app
finds them with `notify.list`) without a notification, and get threads within the caps. From then on, each new bug is
a `notify.new`.

Try a config first, without starting anything: `bun extractors/bugwatch/src/cli.ts --config <file> --dry` reads the
sources now (`--since 6h` for another window) and prints the bugs it would raise and the threads it would start
(`--brief` adds the first one's brief). `--selftest` starts one real thread with the thread command whose only task is
to reply "ok", and prints the command's answer and the thread id it found in it.

The config is read again when it changes. A source added to it later is read the same way as on the first start: its
last 24 hours, its bugs listed without a notification. One that stops reading keeps the last good one in use (the account's
`config` layer says so). Without a config that reads, the account is in `attention`.

## The config

```json
{
  "sources": [
    { "name": "hub", "kind": "errors-ndjson", "path": "/path/to/chat-data/traces/errors.ndjson", "project": "/path/to/dither-chat", "base": "origin/main" },
    { "name": "hub-spans", "kind": "trace-ndjson", "path": "/path/to/chat-data/traces/hub.trace.ndjson", "project": "/path/to/dither-chat", "base": "origin/main" },
    { "name": "manager", "kind": "errors-ndjson", "path": "/path/to/accounts-data/traces/errors.ndjson", "project": "/path/to/dither-accounts", "base": "origin/master" },
    { "name": "manager-spans", "kind": "trace-ndjson", "path": "/path/to/accounts-data/traces/manager.trace.ndjson", "project": "/path/to/dither-accounts", "base": "origin/master" },
    { "name": "adapters", "kind": "text-log", "path": "/path/to/accounts-data/accounts/*/adapter.log", "project": "/path/to/dither-accounts", "base": "origin/master" }
  ],
  "ignore": ["ResizeObserver loop"],
  "always": [{ "match": "^attempt/", "gapHours": 24 }],
  "threads": {
    "command": ["t3", "thread", "start", "--title", "{title}", "--provider", "claudeAgent", "--model", "claude-opus-5-5", "--worktree", "{base}", "--json", "{project}", "-"],
    "gapMinutes": 15,
    "dayMax": 6
  },
  "briefs": [{ "match": "^hub ", "file": "/path/to/hub-addendum.md" }]
}
```

- **`sources`**: each a `name` (letters, digits, `.`, `-`, `_`; it names the source in fingerprints and notices), a
  `kind` (below), a `path` (`*` in a segment matches any name there; relative paths are taken from the config file's
  directory), and for threads the `project` (the checkout a thread works in; paths in frames are made relative to it)
  and the `base` (the branch its worktree starts from). A source without both gets notices but no threads. `data`
  (optional) is the data directory the brief's `trace-summary` command names; else the directory above the file's
  `traces/`.
- **`ignore`**: regular expressions; a record whose `where`, `name`, `message` or `name: message` matches is dropped
  before anything else.
- **`always`**: a record whose `source/where` (as `attempt/POST /api/groups`) matches is a bug every time, at most once
  per `gapHours` (24) per fingerprint, read or not: for failures you want to hear of each time, such as a failed attempt
  to make a group.
- **`threads`**: the command, as argv (never through a shell), with `{title}`, `{project}` and `{base}` filled in and
  the brief on its stdin; `gapMinutes` (15) between two starts, `dayMax` (6) in 24 hours, `queueMax` (10) bugs waiting.
  Without `threads`, no threads: notices only.
- **`briefs`**: an addendum file appended to the brief of each bug whose fingerprint text matches.
- **`spikeGapHours`** (6): a spike of one fingerprint is announced at most this often.

## What it reads

Each file is tailed from where the last scan stopped (its inode and offset in `state.json`): across a rotation (the
old file, renamed to `<file>.1`, is read to its end first, then the new one from its start), a truncation (read again
from the start), and restarts. At most 8 MB of a file a scan; on the first start, the last 16 MB of it and of its `.1`
(when that changed in the window), keeping the records of the last 24 hours; the same for a source new to the
config. A file that appears later in a source it already reads (a new account's log) is read from its start.

- **`errors-ndjson`**: one JSON object per line, in this contract (dither-chat's hub writes it, and so does this
  manager: below):

  ```
  { v: 1, at: <ms since the epoch>, app: 'hub' | 'web' | 'manager',
    source: 'uncaught' | 'rejection' | 'request' | 'job' | 'attempt' | 'client',
    where: <route template, span or job name>, name: <error class>, message: <one line, ≤ 300 characters>,
    stack: [<≤ 10 frames, repo-relative paths>], status?: number, trace?: <32 hex>, version?: string,
    extra?: { ids and short words }, count?: number }
  ```

  `count` (the writer merged repeats) counts as that many occurrences. Lines that are not this are skipped.
- **`trace-ndjson`**: a span file (dither-chat's `hub.trace.ndjson`, the manager's `manager.trace.ndjson`; the format
  is `SpanRecord` in packages/manager/src/trace.ts): its spans with `status: 'error'`, `where` the span's name, the
  error's class and message from its `error` (`SQLiteError: database is locked`), and its trace id. Expected refusals
  are not bugs and are left out: a status under 500 (the hub's `http.status`; the manager's `call <op>` spans carry
  `status`, the upstream status an extractor gave its refusal, as 410 for a stale sync token), the manager's own refusals (`outcome` `denied`, `limited`,
  `invalid`, `unknown-op`, `unknown-account`, `offline`), and an error that says 429, a 4xx status, a rate limit, a
  captcha, terms, or an abort. A failed span whose trace an `errors-ndjson` record named in the last hour is the same
  failure, and is left out too.
- **`text-log`**: a plain log. An error is a line like `SomeError: …`, Bun's `error: …` (as in
  `error: Unexpected . at …/file.ts:208`), `uncaught …` or `unhandled …` (after an ISO time or a `[tag]` or two), with
  the indented `at …` frames right after it. Nothing else is kept: not Bun's source excerpt (`227 |   const x = …` and
  the `^` under it), not the lines around. A block followed by Bun's `Bun v1.x (…)` line, or Bun's `error:` with
  frames, is a process crash (`uncaught`); `unhandled` is a `rejection`; anything else a `job`. Its time is the last
  ISO time a line before it said (adapter.log's `--- <time> … starting` lines), else when it was read. An error on the
  last line read waits one scan for its frames. `where` is the file's name.

## The manager's error file

The manager writes `<data>/traces/errors.ndjson` (packages/manager/src/errors.ts; `errors = 0` in config.toml, or
`--errors 0`, turns it off) in the contract above, `app: 'manager'`:

- its own uncaught exceptions (`source: 'uncaught'`) and unhandled rejections (`'rejection'`), `where: 'process'`; it
  then ends with exit code 1, as the crash would have, for the service manager to restart it;
- an extractor whose process ends on its own with a failure (a code other than 0, or a signal): `source: 'uncaught'`,
  `where: 'extractor <kind>'`, the last error and its frames from the last 60 lines of its stderr (or `Exit`, "exited
  with code N", when there was none), and `extra: { kind, account, code, signal }`;
- failed calls are not repeated in it: they are failed `call <op>` spans in `manager.trace.ndjson`, read as a
  `trace-ndjson` source.

The same error (source, where, name, message) within 10 s is one record with `count`; at most 30 records are written a
minute, and the number a full minute dropped goes in the next record's `extra.dropped`. Frames are relative to the
repository (`extractors/fake/src/main.ts:12:3`; a dependency's from its `node_modules/`). The file rotates at 2 MB,
keeping 3.

## Fingerprints

A fingerprint is the source's name, the record's `source`, `where`, `name`, its normalized message, and the first frame
in the project as `file#function`, without line or column, so a deploy that moves lines keeps it:

```
hub | request | GET /api/conversations/:id/messages | SQLiteError | database is locked | packages/hub/src/db.ts#query
```

Normalizing a message (and `where`): one line; the project's path taken off; URLs → `<url>`, quoted strings →
`"<s>"`, `path.ts:208:12` → `path.ts:<n>`, uuids → `<uuid>`, `0x…` and hex runs of 8 or more with a digit →
`<hex>`, ids like `acc_7f3a9c2b1e` → `<id>`, runs of 20 or more letters and digits (tokens, base64) → `<b64>`,
numbers (with a unit: `250ms`) → `<n>`; at most 300 characters. A frame is in the project when its path is relative
(after the project's path is taken off), not under `node_modules/`, and not `native`, `node:` or `bun:`. A
fingerprint's id is the first 16 hex characters of its text's SHA-256.

## What is a bug

- **New**: a fingerprint not seen in the 14 days before.
- **A spike**: in the last hour (in 10-minute buckets), at least max(20, 5 × its mean an hour over the 7 days before
  that hour); at most once per `spikeGapHours`.
- **`always`**: a matching `source/where`, each time, at most once per its `gapHours`.

For each fingerprint it keeps the count, first and last seen, the counts in 10-minute buckets for 8 days, and 5 sample
records (the first and the latest four; the error line and frames only, for the brief). Fingerprints not seen for 30
days are forgotten unless their notice is unread or they wait for a thread.

## A notice

One per fingerprint, id `bug:<fingerprint id>`, so a repeat replaces it:

| field | what |
| --- | --- |
| `source` | `bugwatch` |
| `title` | `<source name>: <name>: <normalized message>`, at most 120 characters (`hub: SQLiteError: database is locked`) |
| `body` | where, how many times since when (and for a spike, the last hour against the week's mean), then the thread: "A T3 thread is looking into it (<thread title>).", "A T3 thread already looked into it (…)." (a spike after one), "A T3 thread will start when the limits allow (…).", "Starting a T3 thread failed (exit code N): the bugwatch account's log says more.", or why there is none (no `threads` in the config; the source names no project and base; more bugs waited than the queue keeps) |
| `reason` | `new`, `spike` or `always` |
| `context` | the source's name |
| `subject` | `{ kind: 'bug', title: '<name>: <message>', url: null, state: 'thread' \| 'queued' \| 'thread-failed' \| 'no-thread' }` |
| `urgency` | `high` when one of its records was a process crash (`uncaught`), else `normal` |
| `at` | when it was raised; `url` null; `actors` empty |

**Never a stack, a sample, a raw log line or anything else of a record**: only bugwatch's words and the record's
source, `where`, `name` and normalized message. A notice goes to apps and on to phones; a log line can carry a name, a
token or a password hint. The brief, which stays on this machine, has the samples.

`notify.markRead` acknowledges it: a read fingerprint is announced again only on a spike or an `always` rule's next
turn (or when it comes back after 14 quiet days, as new). `notify.markAllRead { before? }` reads all up to then.
`notify.mute { id }` mutes the fingerprint: no notices, no threads, not listed, until it is cleared. `notify.list`
takes `unreadOnly`, `since` (raised at or after), `limit` (up to 200) and `pageToken`.

## A thread

For each bug, within the caps, it runs `threads.command` with `{title}` (`Bug: <notice title>`, at most 100
characters), `{project}` and `{base}` from its source, the brief on stdin, for at most 2 minutes, and reads the thread
id from its JSON output (`t3 thread start --json` prints `{ threadId, runId }`). A command that fails (an exit code
other than 0, a timeout) is said in the notice and in the account's log (its last stderr line); it is not tried again
until cleared.

- **Caps**: one thread per fingerprint, until you clear it; one start every `gapMinutes`; at most `dayMax` in 24
  hours. Bugs over the caps wait in a queue of `queueMax` (10), the most frequent first; the rest are left out and
  their notices say so. The queue starts as the caps allow, one a scan.
- **Clearing** a fingerprint (it may get a thread again, and is unmuted): `bun extractors/bugwatch/src/cli.ts
  --account-dir <the account's directory> --clear <fingerprint id>` writes it to `clear.txt` there, applied at the
  next scan. One whose notice is still unread waits for a thread again at once.
- **The brief** (`extractors/bugwatch/brief.md`, filled in): what was seen (the fingerprint, where, the counts, first
  and last seen, the last hour and the week's mean, the sample records, the trace id and how to read it with
  `bun scripts/trace-summary.ts --data <dir> --since all --trace <id>` in a dither-chat checkout), then the rules:
  read only on live systems (never re-send a command, never act on a real account, never restart a live service);
  reproduce it in a test or a demo instance; fix it in a pull request and leave it for the owner's review (no merge, no
  auto-merge, no deploy); finish with what failed, why, the pull request's link and what is unproven. Then each
  matching `briefs` addendum.

## Its account

Status `online` once the config reads (`attention` with kind `config` until it does). Layers: `config`, each source
(how many files its path matches now and the records of the last scan, or why it failed), `threads` (started in the
last 24 h, waiting). Details: the config's path, sources, fingerprints kept, unread notices, threads today, queued, the
last scan. `state.json` in the account's directory keeps where it is in each file and the fingerprints;
`DITHER_BUGWATCH_SCAN_MS` changes the 30 s between scans.

## Tests

`test/bugwatch-unit.test.ts`: normalizing and fingerprints across line changes, each reader (a Bun crash block with its
excerpt left out, failed spans without expected refusals), tailing across rotation and truncation, the config, new,
spike and `always`, the catch-up, the caps and the queue with a fake thread command, a failing command, notices that
hold no raw content, read, mute and clear. `test/bugwatch.test.ts`: over the real wire, a manager with the kind, an
account added as the page adds it, an app hearing `notify.new` and `notify.read`, a restart, and the CLI's `--dry`.
`test/errors.test.ts`: the manager's error file, with a fake extractor that crashes.
