/**
 * Signal composition parity on live throwaway accounts (docs/signal.md "Live parity testing"): the shared matrix
 * (test/chat-parity/scenarios.ts, compositionScenarios) driven through a running manager, step by step, with the
 * extractor's conversation compared after every step with what Signal itself holds.
 *
 *   Mode 1, one throwaway and its linked Signal Desktop, in Note to Self (needs no second number):
 *     bun scripts/parity-signal.ts --account <id> --desktop-dir <profile> --confirm-throwaway
 *   Mode 2, two throwaways talking to each other, the second one's extractor (and a Desktop, if given) as the oracle:
 *     bun scripts/parity-signal.ts --account <id> --peer-account <id2> [--desktop-dir <profile>] --confirm-throwaway
 *
 *   --manager <url>        the manager (default http://127.0.0.1:8486)
 *   --credentials <file>   an app's {"app","token"} (JSON); without one the script registers "parity-signal" and
 *                          waits for its request (chat at manage on these accounts only) to be approved on the page,
 *                          then saves them there (0600) when the flag names a file
 *   --capture <dir>        every command and event, anonymized (packages/manager/src/wire-capture.ts) and checked
 *                          by assertNoConcreteLeaks, as one JSON file there. It stays on this machine (AGENTS.md)
 *   --filter <text>        only scenarios whose name contains it; --list prints them and exits
 *   --media                include the file scenario (the file is written to a temp folder the extractor must read)
 *   --converge-ms <n>      how long each step may take to agree (default 45000)
 *
 * Nothing here has a default account: both ids are given every time, and --confirm-throwaway says they are
 * throwaways. With DITHER_SIGNAL_THROWAWAYS set (comma-separated account ids, kept outside the repo), any other
 * account is refused too. Every message, edit, reaction, delete and pin goes out for real on those accounts.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type * as P from '@dither-chat/protocol';
import { AccountsClient, type AccountView, register } from '@dither-accounts/client';
import { anonymizeTrace, assertNoConcreteLeaks } from '../packages/manager/src/wire-capture.ts';
import { dmId } from '../extractors/signal/src/mapping.ts';
import { type Actor, type Cap, diffConversationStates, EventFolder, formatMismatches, type Handle, type NormalizedConversationState, type ParityDriver, runScenario, scenarioRuns, scoped, type SendOptions } from '../test/chat-parity/harness.ts';
import { compositionScenarios } from '../test/chat-parity/scenarios.ts';
import { DesktopProfileReader } from '../test/chat-parity/signal-desktop-oracle.ts';

// ---------------------------------------------------------------- the guardrails

export interface SignalTargetArgs {
  account?: string;
  peerAccount?: string;
  desktopDir?: string;
  confirmThrowaway?: boolean;
  /** Account ids allowed at all (DITHER_SIGNAL_THROWAWAYS), when set. */
  allowlist?: string[];
}

export type SignalTarget = { ok: true; mode: 'note-to-self'; account: string; desktopDir: string } | { ok: true; mode: 'two-party'; account: string; peerAccount: string; desktopDir?: string } | { ok: false; errors: string[]; guide?: string };

export const NOTE_TO_SELF_GUIDE = `Mode 1 (one throwaway, no second number) needs the Signal Desktop linked to that throwaway:
  --desktop-dir <its profile folder>, the one holding config.json and sql/db.sqlite. For a Desktop the extractor
  runs (the account's calls body, docs/signal.md "Calls through Signal Desktop"), the account's directory will do:
  the profile is desktop/home/.config/Signal in it. The scenarios run in Note to Self, and Desktop's own database
  is the oracle, read from a copy (the profile is never written). Mode 2 instead: --peer-account <a second
  throwaway signal account>.`;

const ID_RE = /^[A-Za-z0-9_-]{4,128}$/;

/** Whether these arguments may run at all: explicit throwaways only, never a default, never the same account twice. */
export function validateSignalTargetAccounts(a: SignalTargetArgs): SignalTarget {
  const errors: string[] = [];
  const account = a.account?.trim();
  const peer = a.peerAccount?.trim();
  if (!account) errors.push('--account is required: the throwaway Signal account to test (there is no default)');
  else if (!ID_RE.test(account)) errors.push('--account is not an account id');
  if (a.peerAccount !== undefined && !peer) errors.push('--peer-account is empty');
  else if (peer && !ID_RE.test(peer)) errors.push('--peer-account is not an account id');
  if (account && peer && account === peer) errors.push('--account and --peer-account are the same account: two-party mode needs two different throwaways');
  if (!a.confirmThrowaway) errors.push('--confirm-throwaway is required: every step sends for real, so say that these are throwaway accounts');
  if (a.allowlist?.length) for (const id of [account, peer]) if (id && !a.allowlist.includes(id)) errors.push(`${id} is not in DITHER_SIGNAL_THROWAWAYS`);
  if (errors.length) return { ok: false, errors };
  if (peer) return { ok: true, mode: 'two-party', account: account!, peerAccount: peer, ...(a.desktopDir ? { desktopDir: a.desktopDir } : {}) };
  if (!a.desktopDir) return { ok: false, errors: ['no --desktop-dir and no --peer-account: nothing to compare with'], guide: NOTE_TO_SELF_GUIDE };
  return { ok: true, mode: 'note-to-self', account: account!, desktopDir: a.desktopDir };
}

/** The accounts as the manager has them: each a signal account, running, and not a dry run. */
export function checkTargetViews(views: Pick<AccountView, 'id' | 'kind' | 'dryRun' | 'grants'>[], ids: string[]): string[] {
  const errors: string[] = [];
  for (const id of ids) {
    const v = views.find((x) => x.id === id);
    if (!v) errors.push(`${id}: no such account, or this app has no grant on it`);
    else if (v.kind !== 'signal') errors.push(`${id} is a ${v.kind} account, not signal`);
    else if (v.dryRun) errors.push(`${id}: this app's grant is a dry run, so nothing would reach Signal`);
    else if (v.grants.chat !== 'manage') errors.push(`${id}: this app needs chat at manage (pins are a configure)`);
  }
  return errors;
}

// ---------------------------------------------------------------- the run

const CAPS: Cap[] = ['send', 'edit', 'react', 'reply', 'delete', 'pin'];

async function main() {
  const { values } = parseArgs({
    options: {
      manager: { type: 'string', default: 'http://127.0.0.1:8486' },
      account: { type: 'string' },
      'peer-account': { type: 'string' },
      'desktop-dir': { type: 'string' },
      'confirm-throwaway': { type: 'boolean', default: false },
      credentials: { type: 'string' },
      capture: { type: 'string' },
      filter: { type: 'string' },
      list: { type: 'boolean', default: false },
      media: { type: 'boolean', default: false },
      'converge-ms': { type: 'string', default: '45000' },
    },
  });
  const caps: Cap[] = values.media ? [...CAPS, 'media'] : CAPS;
  if (values.list) {
    for (const s of compositionScenarios()) console.log(`${s.name}  (${s.catches})`);
    return;
  }
  const target = validateSignalTargetAccounts({
    account: values.account,
    peerAccount: values['peer-account'],
    desktopDir: values['desktop-dir'],
    confirmThrowaway: values['confirm-throwaway'],
    allowlist: process.env.DITHER_SIGNAL_THROWAWAYS?.split(',').map((s) => s.trim()).filter(Boolean),
  });
  if (!target.ok) {
    for (const e of target.errors) console.error(`refused: ${e}`);
    if (target.guide) console.error(`\n${target.guide}`);
    process.exit(2);
  }
  const ids = target.mode === 'two-party' ? [target.account, target.peerAccount] : [target.account];
  const work = mkdtempSync(join(tmpdir(), 'parity-signal-'));
  const capture: unknown[] = [];
  const record = (r: Record<string, unknown>) => values.capture && capture.push({ at: Date.now(), ...r });

  // The app: saved credentials, or a request approved on the page.
  let creds: { app: string; token: string } | null = null;
  if (values.credentials && existsSync(values.credentials)) creds = JSON.parse(readFileSync(values.credentials, 'utf8'));
  // A new app waits for the owner on the page; one approved before is told at once.
  let approvalMs = 30_000;
  if (!creds) {
    const reg = await register(values.manager!, { name: 'parity-signal', describe: 'Signal composition parity on throwaway accounts', requests: [{ interface: 'chat', level: 'manage', accounts: ids, reason: 'send, edit, react, reply, delete and pin test messages' }] });
    creds = { app: reg.app, token: reg.token };
    if (values.credentials) {
      writeFileSync(values.credentials, JSON.stringify(creds), { mode: 0o600 });
      chmodSync(values.credentials, 0o600);
    }
    console.log(`Approve "parity-signal" (chat at manage on ${ids.length} account${ids.length > 1 ? 's' : ''}) on the manager's page; waiting up to 30 minutes.`);
    approvalMs = 30 * 60_000;
  }

  const folders = new Map(ids.map((id) => [id, new EventFolder('signal')]));
  const selfOf = new Map<string, string>();
  const notices = new Set<string>();
  const ticks = new Set<() => void>();
  const tick = () => [...ticks].forEach((f) => f());
  let views: AccountView[] = [];
  const client = new AccountsClient({
    url: values.manager!,
    app: creds.app,
    token: creds.token,
    onAccounts: (a) => ((views = a), tick()),
    onEvents: (account, events) => {
      const f = folders.get(account);
      if (!f) return;
      for (const e of events as P.AdapterEvent[]) {
        record({ account: ids.indexOf(account) === 0 ? 'A' : 'B', event: e });
        if (e.t === 'status' && e.self?.nativeId) selfOf.set(account, e.self.nativeId.toLowerCase());
        if (e.t === 'message' && e.message.kind === 'system') notices.add(e.message.nativeId);
        f.apply(e);
      }
      tick();
    },
  });
  const until = async (ok: () => boolean, ms: number, what: string) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
      await new Promise<void>((r) => {
        const t = setTimeout(done, 1000);
        function done() {
          clearTimeout(t);
          ticks.delete(done);
          r();
        }
        ticks.add(done);
      });
    }
  };

  let failed = 0;
  try {
    // Until approved, the accounts are not in the list (or lack the grant); the manager tells the app when they are.
    await until(() => !checkTargetViews(views, ids).length, approvalMs, 'the accounts with chat at manage').catch(() => {
      throw new Error(checkTargetViews(views, ids).join('\n'));
    });
    // Each account's ACI comes in its status (sent to an app as it connects). A status sent since without it (a rate
    // limit lifted) leaves none: restarting the account's extractor on the page sends it again.
    await until(() => ids.every((id) => selfOf.has(id)), 60_000, "each account's own ACI in its status (restart the account on the manager's page to send it again)");
    const A = selfOf.get(ids[0]!)!;
    const B = target.mode === 'two-party' ? selfOf.get(ids[1]!)! : A;
    const conv = (actor: Actor) => (target.mode === 'note-to-self' ? dmId(A, A) : actor === 'A' ? dmId(A, B) : dmId(B, A));
    const accountOf = (actor: Actor) => (actor === 'A' || target.mode === 'note-to-self' ? ids[0]! : ids[1]!);
    const desktop = target.desktopDir ? new DesktopProfileReader({ profile: target.desktopDir, workDir: join(work, 'desktop') }) : null;
    const startedAt = Date.now() - 60_000;

    const cmd = async (actor: Actor, op: string, input: Record<string, unknown>) => {
      record({ account: actor, op, input });
      const r = await client.callRaw(accountOf(actor), op, input, 120_000);
      record({ account: actor, op, result: r });
      return r as any;
    };
    const stateOf = (account: string, c: string, actors: Pick<ParityDriver, 'actorA' | 'actorB'>): NormalizedConversationState => {
      const s = folders.get(account)!.state(actors, c);
      for (const id of notices) delete s.messages[id];
      return s;
    };
    const desktopState = () => desktop!.state({ conversation: { peer: target.mode === 'note-to-self' ? A : B }, actors: d, self: A, since: startedAt });

    const send = async (actor: Actor, body: string, o: SendOptions = {}): Promise<Handle> => {
      const input: Record<string, unknown> = { conversation: conv(actor), body };
      if (o.replyTo) input.replyTo = o.replyTo;
      if (o.attachment) {
        const path = join(work, o.attachment.name);
        writeFileSync(path, o.attachment.bytes);
        input.attachments = [{ path, name: o.attachment.name, mime: o.attachment.mime, size: o.attachment.bytes.length, kind: 'image' }];
      }
      return (await cmd(actor, 'send', input)).nativeId;
    };
    const d: ParityDriver & { stop(): Promise<void> } = {
      name: target.mode === 'note-to-self' ? 'signal live (Note to Self, Signal Desktop oracle)' : `signal live (two throwaways, ${desktop ? 'Signal Desktop' : "the peer's extractor"} oracle)`,
      network: 'signal',
      capabilities: caps,
      actorA: A,
      actorB: B,
      send,
      reply: (actor, h, body) => send(actor, body, { replyTo: h }),
      edit: async (actor, h, body) => void (await cmd(actor, 'edit', { conversation: conv(actor), message: h, body })),
      react: async (actor, h, key, remove) => void (await cmd(actor, 'react', { conversation: conv(actor), message: h, key, ...(remove ? { remove: true } : {}) })),
      delete: async (actor, h) => void (await cmd(actor, 'redact', { conversation: conv(actor), message: h })),
      pin: async (actor, h, pinned) => void (await cmd(actor, 'configure', { target: { kind: 'conversation', nativeId: conv(actor) }, change: { key: 'pin', message: h, ...(pinned ? {} : { remove: true }) } })),
      extractorState: () => stateOf(ids[0]!, conv('A'), d),
      async oracleState() {
        if (desktop) return desktopState();
        return stateOf(ids[1]!, conv('B'), d);
      },
      changed() {
        const w = desktop?.changed();
        return Promise.race([new Promise<void>((r) => ticks.add(function t() { ticks.delete(t); r(); })), ...(w ? [w.promise] : [])]).finally(() => w?.cancel());
      },
      mark: () => folders.get(ids[0]!)!.events.length,
      dropped: (since) => folders.get(ids[0]!)!.dropped.filter((x) => x.at >= since),
      async stop() {},
    };

    // In Note to Self both actors are the account itself, so the peer half of the matrix would repeat the self half.
    const scenarios = compositionScenarios().filter((s) => (target.mode === 'two-party' || s.name.startsWith('self:')) && (!values.filter || s.name.includes(values.filter)) && scenarioRuns(d, s));
    console.log(`${d.name}: ${scenarios.length} scenarios`);
    for (const s of scenarios) {
      const before = new Set<string>();
      if (target.mode === 'two-party' && desktop) {
        const peer = stateOf(ids[1]!, conv('B'), d);
        for (const id of [...Object.keys(peer.messages), ...peer.deleted, ...Object.keys(desktopState().messages), ...desktopState().deleted]) before.add(id);
      }
      try {
        await runScenario(d, s, { convergeMs: Number(values['converge-ms']), log: (l) => console.log(`  ${l}`) });
        // Two throwaways and a Desktop: the peer's extractor must agree with Desktop too, a third view of the same chat.
        if (target.mode === 'two-party' && desktop) {
          const keep = (id: Handle) => !before.has(id);
          const diff = diffConversationStates(scoped(stateOf(ids[1]!, conv('B'), d), keep), scoped(desktopState(), keep));
          if (diff.length) throw new Error(`the peer's extractor does not agree with Signal Desktop:\n${formatMismatches(diff)}`);
        }
        console.log(`ok   ${s.name}`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${s.name}\n${(e as Error).message}`);
      }
    }
    console.log(failed ? `${failed} of ${scenarios.length} scenarios failed` : `all ${scenarios.length} scenarios agree`);
  } finally {
    client.close();
    if (values.capture) {
      const json = JSON.stringify(anonymizeTrace(capture), null, 1);
      assertNoConcreteLeaks(json);
      mkdirSync(values.capture, { recursive: true, mode: 0o700 });
      const file = join(values.capture, `signal-live-${target.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(file, json, { mode: 0o600 });
      console.log(`capture: ${file}`);
    }
    rmSync(work, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
