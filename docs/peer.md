# Peer accounts: a chat account from another manager

A `peer` account shows a chat account that another dither-accounts manager holds, as if this manager held it. It is
for a second setup beside the main one (a test lab, say) that should see some real accounts without being able to
act on them: the lab's apps read the account here, and the other manager decides what reaches it.

## How it works

The peer is one of the other manager's apps. On its first start it registers there (`POST /api/apps/register`),
asking for `chat` at its `level` (read by default) on that one account, and keeps the app's id and token in its
`secret.json`. Until the owner approves the request on the other manager's page, the account here says it waits
("Approve this account's request on …").

Once approved:

- The account's `hello`, `status` and facts come in as they are and go out here as this account's. Two things stay on
  the other side: a live view's socket (a path there) and an attention (its fix is on that manager's page).
- A call here goes out as the other manager's call, and its answer or refusal comes back. That manager's grant is the
  line that holds: a write it was not granted is refused there, whatever this manager allows.
- The peer also refuses, before anything leaves, an op above its own `level`. With the default, read, nothing it
  forwards can send, react, mark read or change anything.
- At its start, whenever it reconnects, when the account comes online there, and when the other manager says events
  were dropped (a gap), it asks for the account's facts again with `snapshot`.

The other manager must be on this machine: its app endpoints answer loopback only.

## `snapshot`

`snapshot` is a `chat` op at read: send the account's facts again, to every app that reads it. The manager runs it as
the account's action `resync`, which every chat extractor has. `resync` asked for by name stays at manage; `snapshot`
exists so an app that only reads can still start from the account's whole state. The facts go to every app with a
grant on the account, which is harmless: a fact already held changes nothing.

## Adding one

On the page, add "Another manager's account" with:

| field | |
|---|---|
| Other manager | its address, like `http://127.0.0.1:8486` |
| Account there | the account's id on that manager |
| At most | read (default), write or manage |

Then approve its request on the other manager's page. You may narrow it there (a lower level); the narrower of the
two holds.

## Status

Its chain: **other manager** (reached, or why not), **approved there**, **account there** (online on that side).
Offline here means the other manager is not reachable; the account's own state otherwise.
