# Zulip sandbox

A real Zulip server (docker-zulip 13.2, API feature level 517) in rootless podman, seeded with invented
people and traffic, for testing the zulip extractor against the real API. Nothing here reaches a real
account.

```sh
bun extractors/zulip/testbed/sandbox.ts up      # first boot takes 2-4 minutes, then seeds
eval "$(bun extractors/zulip/testbed/sandbox.ts env)"
bun extractors/zulip/testbed/sandbox.ts seed    # again, any time; idempotent
bun extractors/zulip/testbed/sandbox.ts down    # stop; data kept
bun extractors/zulip/testbed/sandbox.ts reset   # delete this project's containers and volumes
```

Options: `--dir <state dir>` (default `${XDG_CACHE_HOME:-~/.cache}/dither-zulip-sandbox`), `--port` (8591),
`--project` (podman-compose project, `zulipsandbox`). Port and project are remembered in `<dir>/sandbox.json`.
The commands refuse a project whose containers were started from another directory.

The state dir holds the compose files (copied from here once, never overwritten), generated secrets in
`secrets/`, `ca.crt` and `creds.json`: the URL, each user's email, password, API key and id (quinn, the
owner and account under test; ann, administrator; bob and cara, members; dave, guest; Echo Bot, quinn's
generic bot), channel and user group ids, and the ids of notable seeded messages (`messages.poll`,
`messages.edited`, ...). `env` prints `ZULIP_SANDBOX_URL`, `NODE_EXTRA_CA_CERTS` and `ZULIP_SANDBOX_CREDS`.

The seed covers channels (public, private, admins-only, archived, one quinn is not in, a channel folder),
formatting, mentions of every kind, a quote-reply, uploads, a poll and a to-do list with votes, edits, a
topic move, a resolved topic, a deleted message, reactions (unicode, Zulip and custom emoji), a star,
120 messages in one topic for paging, the empty topic, DMs (1:1, group, self, bot), muted and followed
topics, a muted channel, a scheduled message, a reminder, an alert word and a mixed unread state.

## Traps

- podman-compose 1.6 rejects secrets sourced from `environment:` and the `!override` tag: file secrets, plain values.
- Podman mounts file secrets root-owned with their own mode and memcached must read them: 0644 files in a 0700 dir.
- Rootless podman cannot raise the nofile limit to docker-zulip's default, so compose.yaml fixes it at 524288.
- Zulip wants a dotted EXTERNAL_HOST and https only: `zulip.localhost:<port>`, self-signed; trust `ca.crt` with `NODE_EXTRA_CA_CERTS` (Bun honours it).
- `zulip.localhost` can resolve to ::1, so the port is bound on 127.0.0.1 and [::1].
- Logs go to journald: `journalctl --user CONTAINER_NAME=<project>_zulip_1 -o cat`.
- Zulip allows 200 API requests a minute per user; the seed waits out 429s.
- The API's `email` field is a fake `user<id>@<host>` (email visibility is admins-only); log in with the real one.
- The empty topic reads as "general chat" unless a request passes `allow_empty_topic_name=true`.
