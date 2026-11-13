/**
 * DNS from the command line, through the manager's `dns` interface (a Njalla account: docs/njalla.md).
 *
 *   bun scripts/dns.ts zones
 *   bun scripts/dns.ts records <zone> [--name N] [--type T]
 *   bun scripts/dns.ts set <zone> <name> <type> <content> [--ttl N] [--prio N]    exactly this one record for that name and type
 *   bun scripts/dns.ts add <zone> <name> <type> <content> [--ttl N] [--prio N]
 *   bun scripts/dns.ts edit <zone> <id> [--content X] [--ttl N] [--prio N]
 *   bun scripts/dns.ts remove <zone> <id>
 *   bun scripts/dns.ts wait <fqdn> <type> [content] [--timeout S]               until public DNS (1.1.1.1 over HTTPS) answers so
 *   bun scripts/dns.ts status                                                    this tool's grant and requests
 *
 *   --account <id>   which DNS account, when the grant reaches more than one
 *   --json           print the interface's answer as it is
 *   --url <url>      the manager (else $DITHER_ACCOUNTS_URL, else http://127.0.0.1:8486)
 *
 * It is an app like any other, named "dns-cli": the first run registers it with a request for `dns` at write and keeps
 * its token in ~/.config/dither-accounts/dns-cli.json (0600; $DITHER_DNS_CLI_FILE to put it elsewhere). The request
 * waits on the manager's page (Apps), or `bun packages/manager/src/cli.ts approve <request>`; until it is approved
 * every command says so and exits 2. Names are relative to the zone (`@`, `www`), or full names.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AccountsClient, type AccountView, CallFailed, register, self } from '@dither-accounts/client';
import { type DnsRecord, dns } from '@dither-accounts/interfaces';

const argv = process.argv.slice(2);
const VALUE_FLAGS = ['account', 'url', 'ttl', 'prio', 'content', 'name', 'type', 'timeout'];
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (n: string) => argv.includes(`--${n}`);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(argv[i - 1].slice(2)) && argv[i - 1].startsWith('--')));
const [cmd, ...args] = pos;
const url = (opt('url') ?? process.env.DITHER_ACCOUNTS_URL ?? 'http://127.0.0.1:8486').replace(/\/$/, '');
const credFile = process.env.DITHER_DNS_CLI_FILE ?? join(homedir(), '.config/dither-accounts/dns-cli.json');
const json = flag('json');
const int = (n: string) => (opt(n) === undefined ? undefined : Number.parseInt(opt(n)!, 10));

const die = (msg: string, code = 1): never => {
  console.error(msg);
  process.exit(code);
};
const usage = () => die(readFileSync(import.meta.path, 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^ \* ?/, '')).join('\n'));

interface Creds {
  url: string;
  app: string;
  token: string;
}

async function creds(): Promise<Creds> {
  if (existsSync(credFile)) {
    const c = JSON.parse(readFileSync(credFile, 'utf8')) as Creds;
    if (c.url === url) return c;
  }
  const reg = await register(url, {
    name: 'dns-cli',
    describe: "DNS records from the command line (scripts/dns.ts): you, and agents working on this machine's services",
    requests: [{ interface: 'dns', level: 'write' }],
  });
  const c = { url, app: reg.app, token: reg.token };
  mkdirSync(dirname(credFile), { recursive: true, mode: 0o700 });
  writeFileSync(credFile, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(credFile, 0o600);
  console.error(`registered as app ${reg.app}; the request for dns (write) waits on the manager's page: ${reg.requests.map((r) => r.id).join(', ')}`);
  return c;
}

async function pending(c: Creds): Promise<string> {
  const me = await self(url, c.app, c.token);
  const waits = (me.requests ?? []).filter((r: any) => r.interface === 'dns' && r.state === 'pending');
  if (waits.length) return `the dns request waits on the manager's page (Apps), or: bun packages/manager/src/cli.ts approve ${waits[0].id}`;
  return 'no grant reaches a DNS account yet (approve the dns request on the manager page, and add a Njalla account)';
}

async function connect(c: Creds): Promise<{ client: AccountsClient; accounts: AccountView[] }> {
  let got: AccountView[] | null = null;
  const client = new AccountsClient({ url, app: c.app, token: c.token, onAccounts: (a) => (got = a) });
  const end = Date.now() + 8000;
  while (!(client.connected && got) && Date.now() < end) await Bun.sleep(50);
  if (!client.connected || !got) {
    client.close();
    die(`the manager at ${url} did not let this tool in (is it running? a stale ${credFile}?)`);
  }
  return { client, accounts: got! };
}

function pick(accounts: AccountView[]): AccountView | null {
  const reach = accounts.filter((a) => a.grants.dns && a.interfaces.includes('dns'));
  const want = opt('account');
  if (want) return reach.find((a) => a.id === want || a.label === want) ?? die(`no DNS account "${want}" this tool may use: ${reach.map((a) => `${a.id} (${a.label})`).join(', ') || 'none'}`);
  if (reach.length > 1) die(`more than one DNS account; pick one with --account: ${reach.map((a) => `${a.id} (${a.label})`).join(', ')}`);
  return reach[0] ?? null;
}

const row = (r: DnsRecord) => `${r.id.padEnd(10)} ${r.name.padEnd(28)} ${r.type.padEnd(6)} ${String(r.ttl ?? '').padEnd(6)} ${r.prio != null ? `${r.prio} ` : ''}${r.content}`;

/** Public DNS over HTTPS, so a check is not answered from this machine's own resolver cache. */
async function lookup(name: string, type: string): Promise<string[]> {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
  const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
  return (j.Answer ?? []).map((a) => a.data.replace(/^"|"$/g, '').replace(/\.$/, ''));
}

async function main() {
  if (!cmd || cmd === 'help' || flag('help')) usage();
  if (cmd === 'wait') {
    const [name, type = 'A', content] = args;
    if (!name) usage();
    const end = Date.now() + (int('timeout') ?? 600) * 1000;
    for (;;) {
      const got = await lookup(name, type.toUpperCase()).catch(() => []);
      const ok = content ? got.some((g) => g.toLowerCase() === content.replace(/\.$/, '').toLowerCase()) : got.length > 0;
      if (ok) {
        console.log(`${name} ${type.toUpperCase()} → ${got.join(', ')}`);
        return;
      }
      if (Date.now() > end) die(`${name} ${type.toUpperCase()}: still ${got.length ? got.join(', ') : 'no answer'} after the timeout`);
      await Bun.sleep(10_000);
    }
  }
  const c = await creds();
  if (cmd === 'status') {
    console.log(JSON.stringify(await self(url, c.app, c.token), null, 2));
    return;
  }
  const { client, accounts } = await connect(c);
  try {
    const acc = pick(accounts);
    if (!acc) die(await pending(c), 2);
    const z = args[0];
    const need = (n: number) => args.length >= n || usage();
    let out: unknown;
    switch (cmd) {
      case 'zones':
        out = await client.call(dns, acc!.id, 'dns.zones', {});
        if (!json) for (const x of (out as any).zones) console.log(`${x.name}${x.expiry ? `  (until ${x.expiry.slice(0, 10)})` : ''}`);
        break;
      case 'records': {
        need(1);
        out = await client.call(dns, acc!.id, 'dns.records', { zone: z });
        const name = opt('name');
        const type = opt('type')?.toUpperCase();
        const rs = (out as any).records.filter((r: DnsRecord) => (!name || r.name.toLowerCase() === name.toLowerCase()) && (!type || r.type === type));
        out = { records: rs };
        if (!json) for (const r of rs) console.log(row(r));
        break;
      }
      case 'set':
      case 'add': {
        need(4);
        const [, name, type, content] = args;
        out = await client.call(dns, acc!.id, cmd === 'set' ? 'dns.set' : 'dns.add', { zone: z, name, type, content, ttl: int('ttl'), prio: int('prio') });
        if (!json) {
          const o = out as any;
          console.log(`${cmd === 'set' ? (o.changed ? 'set' : 'already so') : 'added'}: ${row(o.record)}${o.removed?.length ? `\nremoved: ${o.removed.join(', ')}` : ''}`);
        }
        break;
      }
      case 'edit':
        need(2);
        out = await client.call(dns, acc!.id, 'dns.edit', { zone: z, id: args[1], content: opt('content'), ttl: int('ttl'), prio: int('prio') });
        if (!json) console.log(`changed: ${row((out as any).record)}`);
        break;
      case 'remove':
        need(2);
        out = await client.call(dns, acc!.id, 'dns.remove', { zone: z, id: args[1] });
        if (!json) console.log(`removed ${args[1]}`);
        break;
      default:
        usage();
    }
    if (json) console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    if (e instanceof CallFailed) die(`${cmd}: ${e.message} (${e.code}${e.status ? ` ${e.status}` : ''})`);
    throw e;
  } finally {
    client.close();
  }
}

await main();
