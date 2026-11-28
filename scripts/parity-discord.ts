/**
 * The Discord composition parity suite (test/chat-parity, docs/parity-discord.md) against real Discord: a throwaway
 * Discord account in the manager as A, a test bot as B and as the oracle, in one test channel both can reach. Run by
 * hand, never by `bun run test`, and never with an account that is not a throwaway.
 *
 *   bun scripts/parity-discord.ts --manager <url> --account <id> --channel <channelId>
 *                                 [--token-file <path>] [--capture <dir>] [--keep] [--only <text>]
 *
 *   --manager <url>      the manager (else $DITHER_ACCOUNTS_URL, else http://127.0.0.1:8486)
 *   --account <id>       the throwaway Discord account, as the manager names it
 *   --channel <id>       the test channel: a server text channel whose name has "parity" or "test" in it
 *   --token-file <path>  the bot's token (else $DISCORD_BOT_TOKEN); never printed
 *   --capture <dir>      save each scenario's bot requests and extractor events there, anonymized (scrubTrace):
 *                        golden traces for this machine only, never for the repo
 *   --keep               leave the run's messages in the channel (else they are deleted at the end)
 *   --only <text>        only the scenarios whose name contains it
 *
 * It is an app named "parity-discord": the first run registers it with a request for `chat` at manage (pins go through
 * `configure`) and keeps its token in ~/.config/dither-accounts/parity-discord.json (0600; $DITHER_PARITY_CLI_FILE
 * puts it elsewhere). Approve it on the manager's page for the throwaway account only. Exit 0: every scenario agreed;
 * 1: some did not (each named with its differences); 2: it could not start.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { AccountsClient, type AccountView, register } from '@dither-accounts/client';
import { scrubTrace } from '../packages/manager/src/wire-capture.ts';
import { DiscordBotOracle, type OracleExchange } from '../test/chat-parity/discord-bot-oracle.ts';
import { discordDriver, snowflakeNow } from '../test/chat-parity/discord-driver.ts';
import { type Cap, runScenario, scenarioRuns } from '../test/chat-parity/harness.ts';
import { compositionScenarios } from '../test/chat-parity/scenarios.ts';

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (n: string) => argv.includes(`--${n}`);
function die(msg: string, code = 2): never {
  console.error(msg);
  process.exit(code);
}
if (flag('help') || !opt('account') || !opt('channel')) die(readFileSync(import.meta.path, 'utf8').split('\n').slice(1, 23).map((l) => l.replace(/^ \* ?/, '')).join('\n'));

const url = (opt('manager') ?? process.env.DITHER_ACCOUNTS_URL ?? 'http://127.0.0.1:8486').replace(/\/$/, '');
const accountId = opt('account')!;
const channelId = opt('channel')!;
const captureDir = opt('capture');
const keep = flag('keep');
const only = opt('only');
const credFile = process.env.DITHER_PARITY_CLI_FILE ?? join(homedir(), '.config/dither-accounts/parity-discord.json');
if (!/^\d{15,25}$/.test(channelId)) die('--channel: a Discord channel id (a snowflake)');

const tokenFile = opt('token-file');
const botToken = (tokenFile ? readFileSync(tokenFile, 'utf8') : (process.env.DISCORD_BOT_TOKEN ?? '')).trim().replace(/^Bot\s+/i, '');
if (!botToken) die('no bot token: set DISCORD_BOT_TOKEN or pass --token-file');

/** Both sides do everything, but A sends no files: the manager would read one from a path on its own machine. */
const CAPS: Cap[] = ['send', 'edit', 'react', 'reply', 'delete', 'pin', 'media'];
const ONLY: Partial<Record<'A' | 'B', Cap[]>> = { A: ['send', 'edit', 'react', 'reply', 'delete', 'pin'] };

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
    name: 'parity-discord',
    describe: 'The Discord composition parity suite (scripts/parity-discord.ts), run by hand against a throwaway account',
    requests: [{ interface: 'chat', level: 'manage' }],
  });
  const c = { url, app: reg.app, token: reg.token };
  mkdirSync(dirname(credFile), { recursive: true, mode: 0o700 });
  writeFileSync(credFile, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(credFile, 0o600);
  die(`registered as app ${reg.app}: approve its chat request on the manager's page (Apps) for the throwaway account only, then run this again`);
}

/** A scenario's capture: the bot's requests and the extractor's events, in order. */
let trace: { at: number; side: 'bot' | 'extractor'; record: OracleExchange | P.AdapterEvent }[] = [];

async function main() {
  const oracle = new DiscordBotOracle({ token: botToken, onExchange: (x) => captureDir && trace.push({ at: Date.now(), side: 'bot', record: x }) });
  const bot = await oracle.me().catch((e) => die(`the bot token did not work: ${String(e?.message ?? e)}`));
  if (!bot.bot) die('that token is not a bot user');
  const channel = await oracle.request<{ id: string; type: number; name?: string; guild_id?: string }>('GET', `/channels/${channelId}`).catch((e) => die(`the bot cannot see that channel: ${String(e?.message ?? e)}`));
  if (channel.type !== 0 || !channel.guild_id) die('--channel must be a text channel in a server');
  if (!/parity|test/i.test(channel.name ?? '')) die('the channel\'s name has neither "parity" nor "test" in it: this runs only in a channel made for it');

  const c = await creds();
  let self: string | null = null;
  let gotSelf: () => void = () => {};
  const selfKnown = new Promise<void>((r) => (gotSelf = r));
  let apply: (ev: P.AdapterEvent) => void = () => {};
  let accounts: AccountView[] = [];
  const client = new AccountsClient({
    url,
    app: c.app,
    token: c.token,
    timeoutMs: 90_000,
    onAccounts: (a) => (accounts = a),
    onEvents: (account, events) => {
      if (account !== accountId) return;
      for (const ev of events as P.AdapterEvent[]) {
        if (ev.t === 'status' && ev.self?.nativeId && !self) {
          self = ev.self.nativeId;
          gotSelf();
        }
        if (captureDir) trace.push({ at: Date.now(), side: 'extractor', record: ev });
        apply(ev);
      }
    },
  });
  const ok = await Promise.race([selfKnown.then(() => true), Bun.sleep(20_000).then(() => false)]);
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) die(`the manager at ${url} shows this app no account ${accountId}: approve the chat request for it (or wrong --account)`);
  if (acc.kind !== 'discord') die(`${accountId} is a ${acc.kind} account, not discord`);
  if (!acc.grants.chat || acc.grants.chat === 'read') die(`this app has ${acc.grants.chat ?? 'no'} chat grant on ${accountId}; it needs manage (pins go through configure)`);
  if (acc.dryRun) die(`${accountId}'s grant is a dry run: nothing would reach Discord`);
  if (!ok || !self) die(`${accountId} never said who it is (status with self): is it online?`);
  const me: string = self;
  if (me === bot.id) die('the account and the bot are the same user');

  const after = snowflakeNow();
  const d = discordDriver({
    name: 'discord (live)',
    oracle,
    channelId,
    actorA: me,
    actorB: bot.id,
    capabilities: CAPS,
    only: ONLY,
    command: ({ t, ...input }) => client.callRaw(accountId, t, input, 90_000),
    after,
    // Nothing tells a bot that someone else's request landed: look again shortly.
    networkChanged: () => Bun.sleep(500),
  });
  apply = (ev) => d.apply(ev);

  const failed: string[] = [];
  const scenarios = compositionScenarios().filter((s) => (!only || s.name.includes(only)) && scenarioRuns(d, s));
  console.log(`${scenarios.length} scenarios in #${channel.name}, account A ${accountId}, bot B`);
  for (const s of scenarios) {
    trace = [];
    const t0 = Date.now();
    try {
      await runScenario(d, s, { convergeMs: 60_000, log: process.env.PARITY_LOG ? (l) => console.log(`  ${l}`) : undefined });
      console.log(`ok   ${s.name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e: any) {
      failed.push(s.name);
      console.log(`FAIL ${s.name}\n${String(e?.message ?? e).split('\n').filter((l) => !/^\s+(extractor|network):/.test(l)).join('\n')}`);
    }
    if (captureDir) save(s.name, failed.includes(s.name));
  }

  if (!keep) await cleanup(oracle, after, me, bot.id);
  client.close();
  console.log(failed.length ? `\n${failed.length} of ${scenarios.length} did not agree` : `\nall ${scenarios.length} agreed`);
  process.exit(failed.length ? 1 : 0);
}

/** One scenario's trace, anonymized and checked for leaks before it is written; a trace that fails the check is not. */
function save(name: string, failed: boolean) {
  mkdirSync(captureDir!, { recursive: true, mode: 0o700 });
  const file = join(captureDir!, `discord-${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}${failed ? '.failed' : ''}.json`);
  try {
    const { json } = scrubTrace(trace);
    writeFileSync(file, `${json}\n`, { mode: 0o600 });
  } catch (e: any) {
    console.log(`     not saved: ${String(e?.message ?? e)}`);
  }
}

/** Every message after the run's start by either person, deleted by the bot (Manage Messages), pins' notices too. */
async function cleanup(oracle: DiscordBotOracle, after: string, a: string, b: string) {
  const left = (await oracle.messages(channelId, after)).filter((m) => m.author.id === a || m.author.id === b);
  for (const m of left) await oracle.delete(channelId, m.id).catch((e) => console.log(`     could not delete ${m.id}: ${String(e?.message ?? e)}`));
  console.log(`cleaned up ${left.length} messages`);
}

await main().catch((e) => die(String(e?.stack ?? e)));
