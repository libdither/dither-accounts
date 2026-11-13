# Njalla (kind `njalla`)

Your Njalla domains' DNS records as the `dns` interface (packages/interfaces/src/dns.ts): apps list, add, change and
remove records with a grant you approve, and `scripts/dns.ts` does the same from the command line. It talks to
Njalla's JSON-RPC API (`https://njal.la/api/1/`) with a token you paste: no browser.

## Adding it

On the manager's page, **Add → Njalla**:

- **API token** (secret): njal.la → Settings → API → **Add token**. Njalla shows it once. You can restrict a token
  there to some domains, methods, record types or name prefixes. For this kind, allow at least `list-domains`,
  `list-records`, `add-record`, `edit-record` and `remove-record` on the domains you want it to manage.
  - Don't make tokens through the API's `add-token`. It quietly ignores parameters it doesn't know and then makes an
    unrestricted token. This kind never sends it.
- **Only these domains** (optional): a comma-separated list. Apps can't list or touch any other domain, even when
  the token reaches it. Empty means every domain the token reaches.

It checks the token right away by listing the domains, then again every 15 minutes (`DITHER_NJALLA_RECHECK_MS`) and
whenever a call is refused for the token. The pane shows the domains. A token Njalla restricts to some domains is
refused the others: that call fails with 403, but the account stays online. Only a token that can no longer list
anything marks the account for attention. A new token written to `secret.json` is picked up without a restart.

## What apps can do

| Op | Level | What |
|---|---|---|
| `dns.zones` | read | the domains (name, status, expiry) |
| `dns.records` | read | a domain's records: `id`, `name`, `type`, `content`, `ttl`, `prio` |
| `dns.add` | write | add a record (TTL 300 s when none is given) |
| `dns.edit` | write | change a record's content, TTL or priority. The rest is sent as it was, because Njalla's `edit-record` takes the record whole. |
| `dns.remove` | write | remove a record |
| `dns.set` | write | make one name and type hold exactly this record. It leaves an exact match alone, else changes one (or adds one) and removes the rest of that name and type. Returns `changed` and `removed`. |

Each write emits `dns.changed { zone }`, so every app with the grant hears about it.

Names are relative to the zone (`@` is the zone itself, `www`, `_acme-challenge.home`); a full name, with or without
its final dot, is cut down. Types are made upper case. Njalla's own refusals (an unknown domain, a CNAME clash, a
TTL it doesn't allow) come back with Njalla's words and its 4xx status. When Njalla doesn't answer, the call fails
with 503; an HTTP error from Njalla gives 502 and a rate limit 429.

It only ever sends `list-domains`, `list-records`, `add-record`, `edit-record` and `remove-record` (src/api.ts
refuses anything else). It never registers, renews or transfers a domain, never changes name servers, and never makes
tokens. Its log names the method, domain, record name and type, but never the token or record contents.

## From the command line: scripts/dns.ts

```
bun scripts/dns.ts zones
bun scripts/dns.ts records example.net --name trip
bun scripts/dns.ts set example.net trip CNAME vps.example.net
bun scripts/dns.ts wait trip.example.net CNAME vps.example.net    # until 1.1.1.1 answers so
bun scripts/dns.ts remove example.net <id>
```

It is an ordinary app named `dns-cli`. The first run registers it, asks for `dns` at write, and keeps its token in
`~/.config/dither-accounts/dns-cli.json` (0600). The request waits on the page (Apps), or you can run
`bun packages/manager/src/cli.ts approve <request>`. Until it is approved, every command prints how to approve and
exits 2. `--account` picks among several DNS accounts and `--json` prints the interface's answer as it is.

## Tests

`test/njalla.test.ts` runs against `extractors/njalla/test/fake-njalla.ts`, which answers the way Njalla does
(HTTP 200 with `{ error: { code, message } }`, string record ids) and checks that nothing but the five record methods
goes out. The method names, the `Authorization: Njalla <token>` header and the record shape match go-acme/lego's
njalla client, which uses the same API. The request fields of `edit-record` and `list-domains` come from Njalla's
API page, which needs a sign-in; no test checks them against the real API.
