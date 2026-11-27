/**
 * An account's signed-in browser from the command line, through the manager's `browser` interface (docs/browser.md):
 * for you, and for agents doing a one-off job on a site whose kind has no operation for it.
 *
 *   bun scripts/browse.ts accounts                              the accounts this tool may drive
 *   bun scripts/browse.ts open <url>                            a new tab of its own, in front, loaded
 *   bun scripts/browse.ts read [--text N] [--all]               the page: elements with refs (e1…), then its text
 *   bun scripts/browse.ts click <ref>                           a real mouse click
 *   bun scripts/browse.ts type <ref> <text> [--clear] [--enter]
 *   bun scripts/browse.ts select <ref> <option>                 a <select>'s option, by text or value
 *   bun scripts/browse.ts key <keys…>                           Return, Tab, Escape, ctrl+a, Page_Down…
 *   bun scripts/browse.ts scroll up|down
 *   bun scripts/browse.ts go <url>
 *   bun scripts/browse.ts shot [file.png]                       a PNG of the display (default ./shot.png)
 *   bun scripts/browse.ts tabs | close
 *   bun scripts/browse.ts press <ref>                           a click that may buy, pay, send or delete (manage)
 *   bun scripts/browse.ts status                                this tool's grant and requests
 *
 *   --account <id|label|kind>   which account, when the grant reaches more than one
 *   --tab <id>                  which of its tabs (default: the newest)
 *   --json                      print the interface's answer as it is
 *   --url <url>                 the manager (else $DITHER_ACCOUNTS_URL, else http://127.0.0.1:8486)
 *
 * It is an app named "browser-cli": the first run registers it with a request for `browser` at write, and keeps its
 * token in ~/.config/dither-accounts/browser-cli.json (0600; $DITHER_BROWSER_CLI_FILE to put it elsewhere). The owner
 * approves it on the manager's page (Apps) for the accounts it may drive; until then every command says so and exits
 * 2. A page asking for a captcha, a checkpoint or a code prints CHALLENGE and exits 3: that is the owner's to clear in
 * the account's live view.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AccountsClient, type AccountView, CallFailed, register, self } from '@dither-accounts/client';
import { type BrowserAfter, type BrowserPage, browser } from '@dither-accounts/interfaces';

const argv = process.argv.slice(2);
const VALUE_FLAGS = ['account', 'url', 'tab', 'text'];
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (n: string) => argv.includes(`--${n}`);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && VALUE_FLAGS.includes(argv[i - 1].slice(2))));
const [cmd, ...args] = pos;
const url = (opt('url') ?? process.env.DITHER_ACCOUNTS_URL ?? 'http://127.0.0.1:8486').replace(/\/$/, '');
const credFile = process.env.DITHER_BROWSER_CLI_FILE ?? join(homedir(), '.config/dither-accounts/browser-cli.json');
const json = flag('json');
const tabId = opt('tab') === undefined ? undefined : Number.parseInt(opt('tab')!, 10);

const die = (msg: string, code = 1): never => {
  console.error(msg);
  process.exit(code);
};
const usage = () => die(readFileSync(import.meta.path, 'utf8').split('\n').slice(1, 30).map((l) => l.replace(/^ \* ?/, '')).join('\n'));

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
    name: 'browser-cli',
    describe: "An account's signed-in browser from the command line (scripts/browse.ts): you, and agents doing one-off jobs",
    requests: [{ interface: 'browser', level: 'write' }],
  });
  const c = { url, app: reg.app, token: reg.token };
  mkdirSync(dirname(credFile), { recursive: true, mode: 0o700 });
  writeFileSync(credFile, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(credFile, 0o600);
  console.error(`registered as app ${reg.app}; the request for browser (write) waits on the manager's page: ${reg.requests.map((r) => r.id).join(', ')}`);
  return c;
}

async function pending(c: Creds): Promise<string> {
  const me = await self(url, c.app, c.token);
  const waits = (me.requests ?? []).filter((r: any) => r.interface === 'browser' && r.state === 'pending');
  if (waits.length) return `the browser request waits on the manager's page (Apps), or: bun packages/manager/src/cli.ts approve ${waits[0].id}`;
  return 'no grant reaches an account with a browser yet (approve the browser request on the manager page, for the accounts it may drive)';
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

const reachable = (accounts: AccountView[]) => accounts.filter((a) => a.grants.browser && a.interfaces.includes('browser'));

function pick(accounts: AccountView[]): AccountView | null {
  const reach = reachable(accounts);
  const want = opt('account');
  const list = () => reach.map((a) => `${a.id} (${a.kind}: ${a.label})`).join(', ') || 'none';
  if (want) {
    const hits = reach.filter((a) => a.id === want || a.label === want || a.kind === want);
    if (hits.length === 1) return hits[0];
    die(hits.length ? `"${want}" is more than one account: ${hits.map((a) => a.id).join(', ')}` : `no account "${want}" this tool may drive: ${list()}`);
  }
  if (reach.length > 1) die(`more than one account; pick one with --account: ${list()}`);
  return reach[0] ?? null;
}

function printAfter(a: BrowserAfter) {
  console.log(`${a.title}\n${a.url}`);
  if (a.challenge) challenge(a.challenge);
}
function challenge(c: string): never {
  return die(`CHALLENGE: the page asks for ${c}. That is the owner's to clear in the account's live view; stop here.`, 3);
}
function printPage(p: BrowserPage) {
  console.log(`${p.title}\n${p.url}\n`);
  for (const e of p.elements) {
    const bits = [e.value !== undefined ? `= ${JSON.stringify(e.value)}` : '', e.disabled ? '(disabled)' : '', e.guarded ? '(guarded: press)' : '', e.inView ? '' : '(below)', e.href && !flag('all') ? '' : (e.href ?? '')];
    console.log(`${e.ref.padEnd(5)} ${e.role.padEnd(9)} ${e.name}${bits.filter(Boolean).map((b) => ` ${b}`).join('')}`);
  }
  if (p.elementsCut) console.log('… more elements: --all, or scroll and read again');
  const n = opt('text') === undefined ? 3000 : Number.parseInt(opt('text')!, 10);
  if (n > 0) console.log(`\n--- text${p.textCut || p.text.length > n ? ' (cut)' : ''}\n${p.text.slice(0, n)}`);
  if (p.challenge) challenge(p.challenge);
}

async function main() {
  if (!cmd || cmd === 'help' || flag('help')) usage();
  const c = await creds();
  if (cmd === 'status') {
    console.log(JSON.stringify(await self(url, c.app, c.token), null, 2));
    return;
  }
  const { client, accounts } = await connect(c);
  try {
    if (cmd === 'accounts') {
      const reach = reachable(accounts);
      if (!reach.length) die(await pending(c), 2);
      for (const a of reach) console.log(`${a.id}  ${a.kind.padEnd(8)} ${a.grants.browser.padEnd(6)} ${a.online ? 'online ' : a.asleep ? 'asleep ' : 'offline'} ${a.label}`);
      return;
    }
    const acc = pick(accounts) ?? die(await pending(c), 2);
    const need = (n: number) => args.length >= n || usage();
    const t = tabId === undefined ? {} : { tabId };
    const call = (op: Parameters<typeof client.call<typeof browser, any>>[2], input: Record<string, unknown>) => client.call(browser, acc.id, op as any, input as any);
    let out: any;
    switch (cmd) {
      case 'open':
        need(1);
        out = await call('browser.open', { url: args[0] });
        break;
      case 'go':
        need(1);
        out = await call('browser.go', { ...t, url: args[0] });
        break;
      case 'read':
        out = await call('browser.read', { ...t, ...(flag('all') ? { maxElements: 2000 } : {}) });
        if (!json) printPage(out);
        break;
      case 'click':
      case 'press':
        need(1);
        out = await call(cmd === 'click' ? 'browser.click' : 'browser.press', { ...t, ref: args[0] });
        break;
      case 'type':
        need(2);
        out = await call('browser.type', { ...t, ref: args[0], text: args.slice(1).join(' '), clear: flag('clear'), enter: flag('enter') });
        break;
      case 'select':
        need(2);
        out = await call('browser.select', { ...t, ref: args[0], option: args.slice(1).join(' ') });
        break;
      case 'key':
        need(1);
        out = await call('browser.key', { ...t, keys: args.join(' ') });
        break;
      case 'scroll':
        out = await call('browser.scroll', { ...t, direction: args[0] === 'up' ? 'up' : 'down' });
        break;
      case 'shot': {
        out = await call('browser.shot', t);
        const file = args[0] ?? 'shot.png';
        writeFileSync(file, Buffer.from(out.base64, 'base64'));
        if (!json) console.log(file);
        out = { tabId: out.tabId, file };
        break;
      }
      case 'tabs':
        out = await call('browser.tabs', {});
        if (!json) for (const x of out.tabs) console.log(`${String(x.tabId).padEnd(6)} ${x.active ? '*' : ' '} ${x.title}  ${x.url}`);
        break;
      case 'close':
        out = await call('browser.close', t);
        if (!json) console.log('closed');
        break;
      default:
        usage();
    }
    if (json) console.log(JSON.stringify(out, null, 2));
    else if (out && 'challenge' in out && !('elements' in out)) printAfter(out);
  } catch (e) {
    if (e instanceof CallFailed) die(`${cmd}: ${e.message} (${e.code}${e.status ? ` ${e.status}` : ''})`);
    throw e;
  } finally {
    client.close();
  }
}

await main();
