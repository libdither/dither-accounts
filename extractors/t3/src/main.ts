/**
 * The t3 extractor: T3 Code's coding threads as chats (docs/t3.md), over dither-chat's adapter wire.
 *
 *   t3 auth session issue (two read-only sessions, kept in secret.json) → the shell stream (live summaries) →
 *   t3_thread_read for a thread whose summary changed → message facts; send → t3 thread send
 *
 * Config (all optional): `t3` the command's path, `baseDir` T3 Code's data directory, `projects` which projects to
 * show (ids, titles or folders; empty: all). It logs thread ids, counts and states, never what a thread says.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AdapterEvent, StatusLayer } from '@dither-chat/protocol';
import { linkHub } from '@dither-chat/protocol/client';
import { T3Chat } from './account.ts';
import { fromListItem, projectFilter } from './map.ts';
import { AuthError, baseDirOf, Cli, findBin, issueSession, Mcp, readOrigin, revokeSession, type Session, type SessionUse, sendTurn, ShellStream } from './t3.ts';

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
/** Without the shell stream, the thread list is read this often (each read costs T3 a scan of every thread). */
const POLL_MS = num('DITHER_T3_POLL_MS', 15_000);
/** Waits after a failure to reach T3: this, doubling, up to a minute. */
const RETRY_MS = num('DITHER_T3_RETRY_MS', 5_000);
const READ_GAP_MS = num('DITHER_T3_READ_GAP_MS', 2_000);
/** A session is replaced when it has less than this left. */
const RENEW_MS = 24 * 3600_000;
const SENT_KEEP = 2000;

type Ws = 'off' | 'connecting' | 'on' | 'failed';

const hub = linkHub({
  onConnect: () => {
    hub.emit({ t: 'hello', network: 't3', version: '1', capabilities: ['send', 'history', 'markRead'] });
    status();
    if (chat) for (const e of chat.facts()) hub.emit(e);
  },
  async onCommand(cmd) {
    switch (cmd.t) {
      case 'send':
        if (!chat) throw new Error('T3 Code is not reachable yet');
        if (cmd.attachments?.length) throw new Error('A T3 thread takes words only');
        return chat.send(cmd.conversation, cmd.body);
      case 'history':
        if (!chat) throw new Error('T3 Code is not reachable yet');
        return chat.history(cmd.conversation, cmd.beforeTs, cmd.limit);
      // Read here only: marking a thread read in T3 Code would change the owner's thread.
      case 'markRead':
      case 'typing':
        return { ok: true };
      case 'action':
        if (cmd.action === 'resync') {
          restart('resync');
          return { ok: true };
        }
        throw new Error(`unknown action ${cmd.action}`);
      default:
        throw new Error(`a T3 account does not do ${cmd.t}`);
    }
  },
  onShutdown: () => stop(),
});

const config = hub.config as { t3?: string; baseDir?: string; projects?: string | string[] };
const include = projectFilter(config.projects);
const bin = findBin(config);
const baseDir = baseDirOf(config);
const cli = bin ? new Cli(bin, typeof config.baseDir === 'string' && config.baseDir.trim() ? baseDir : null) : null;
const label = `dither-accounts ${hub.label || hub.accountId}`;

let chat: T3Chat | null = null;
let mcp: Mcp | null = null;
let shell: ShellStream | null = null;
let ws: Ws = 'off';
let wsWhy = '';
let origin: string | null = null;
let problem: { layer: string; note: string } | null = null;
let loaded = false;
/** The first snapshot since start was heard: what comes after it is live (a reconnect's snapshot too). */
let seenSnapshot = false;
let stopped = false;
let generation = 0;
let retryMs = RETRY_MS;
let timer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------- what was sent from here

const sentFile = join(hub.accountDir, 'sent.json');
const sentIds: string[] = (() => {
  try {
    const v = JSON.parse(readFileSync(sentFile, 'utf8'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
})();
const sentSet = new Set(sentIds);
const sent = {
  has: (id: string) => sentSet.has(id),
  add(id: string) {
    if (sentSet.has(id)) return;
    sentSet.add(id);
    sentIds.push(id);
    while (sentIds.length > SENT_KEEP) sentSet.delete(sentIds.shift()!);
    writeFileSync(sentFile, JSON.stringify(sentIds));
  },
};

// ---------------------------------------------------------------- status

function layers(): StatusLayer[] {
  const out: StatusLayer[] = [];
  const at = (name: string, ok: () => StatusLayer['state'] | [StatusLayer['state'], string], note?: string) => {
    const blocked = out.some((l) => l.state !== 'ok');
    if (problem?.layer === name) return void out.push({ name, state: 'failed', note: problem.note });
    if (blocked) return void out.push({ name, state: 'waiting', note: `waits for ${out.find((l) => l.state !== 'ok')!.name}` });
    const r = ok();
    out.push(Array.isArray(r) ? { name, state: r[0], note: r[1] } : { name, state: r, note });
  };
  at('t3 command', () => (bin ? 'ok' : 'failed'), bin ? basename(bin.at(-1)!) : "no t3 on PATH: give its path in the account's config");
  at('T3 Code', () => (origin ? ['ok', 'running'] : ['waiting', 'starting']));
  at('sessions', () => (mcp ? ['ok', 'read-only'] : ['waiting', 'signing in']));
  at('live updates', () => (ws === 'on' ? ['ok', 'the shell stream'] : ws === 'failed' ? ['ok', `the thread list every ${Math.round(POLL_MS / 1000)} s (${wsWhy})`] : ['waiting', 'connecting']));
  at('threads', () => (loaded && chat ? ['ok', `${chat.counts.threads} threads in ${chat.counts.projects} projects`] : ['waiting', 'reading']));
  return out;
}

function status() {
  const ls = layers();
  const down = ls.find((l) => l.state === 'failed');
  const ev: AdapterEvent = {
    t: 'status',
    status: !bin ? 'attention' : down ? 'offline' : loaded ? 'online' : 'connecting',
    attention: !bin ? { kind: 'unknown', message: "The t3 command was not found. Set its path in this account's config (t3)." } : null,
    self: { nativeId: 'me', displayName: 'You', isSelf: true },
    layers: ls,
  };
  hub.emit(ev);
}

// ---------------------------------------------------------------- sessions

type Saved = { sessions?: Partial<Record<SessionUse, Session>> };

async function session(use: SessionUse, fresh = false): Promise<Session> {
  const secret = hub.secret<Saved & Record<string, unknown>>();
  const have = secret.sessions?.[use];
  if (have && !fresh && have.expiresAt - Date.now() > RENEW_MS) return have;
  const s = await issueSession(cli!, use, label);
  hub.saveSecret({ ...secret, sessions: { ...secret.sessions, [use]: s } });
  hub.log('info', `t3: a new ${use} session, until ${new Date(s.expiresAt).toISOString()}`);
  if (have) await revokeSession(cli!, have.sessionId).catch(() => {});
  return s;
}

// ---------------------------------------------------------------- running

function fail(layer: string, e: unknown) {
  const note = (e as Error).message ?? String(e);
  problem = { layer, note };
  hub.log('warn', `t3: ${layer}: ${note}`);
  status();
  retry();
}

function retry() {
  if (stopped || timer) return;
  const gen = generation;
  timer = setTimeout(() => {
    timer = null;
    if (gen === generation) void start();
  }, retryMs);
  retryMs = Math.min(retryMs * 2, 60_000);
}

function teardown() {
  generation++;
  shell?.close();
  shell = null;
  void mcp?.close();
  mcp = null;
  chat?.stop();
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  ws = 'off';
  seenSnapshot = false;
}

function restart(why: string) {
  hub.log('info', `t3: starting again (${why})`);
  teardown();
  loaded = false;
  void start();
}

async function start() {
  if (stopped || !cli) return status();
  teardown();
  const gen = generation;
  problem = null;
  origin = readOrigin(baseDir);
  if (!origin) return fail('T3 Code', new Error('not running here (start T3 Code; it writes userdata/server-runtime.json)'));
  status();
  let mcpSession: Session;
  try {
    mcpSession = await session('mcp');
  } catch (e) {
    return fail('sessions', e);
  }
  if (gen !== generation) return;
  mcp = new Mcp(origin, mcpSession.token);
  const read = async <T>(tool: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return await mcp!.call<T>(tool, args);
    } catch (e) {
      if (e instanceof AuthError) {
        // A session revoked or expired: a new one, then once more.
        const s = await session('mcp', true);
        if (gen !== generation) throw e;
        mcp = new Mcp(origin!, s.token);
        return mcp.call<T>(tool, args);
      }
      throw e;
    }
  };
  chat = new T3Chat({
    emit: (e) => hub.emit(e),
    log: (l, m) => hub.log(l, m),
    read,
    send: async (threadId, body) => sendTurn(cli, threadId, body),
    include,
    sent,
    readGapMs: READ_GAP_MS,
  });
  for (const identity of T3Chat.fixedIdentities()) hub.emit({ t: 'identity', identity });
  try {
    // Projects first, so threads find theirs whichever way their summaries come.
    for (let cursor: number | null = 0; cursor !== null && gen === generation; ) {
      const r: { projects: any[]; nextCursor: number | null } = await read('t3_project_list', { cursor, limit: 100 });
      for (const p of r.projects ?? []) chat.project(p);
      cursor = r.nextCursor ?? null;
    }
  } catch (e) {
    return fail('sessions', e);
  }
  if (gen !== generation) return;
  status();
  await live(gen);
}

/** The shell stream; when it cannot be had, the thread list now and then. */
async function live(gen: number) {
  let rpc: Session;
  try {
    rpc = await session('rpc');
  } catch (e) {
    return poll(gen, (e as Error).message);
  }
  if (gen !== generation) return;
  ws = 'connecting';
  shell = new ShellStream(origin!, rpc.token, {
    onOpen: () => {
      ws = 'on';
      retryMs = RETRY_MS;
      status();
    },
    onItem: (item) => {
      if (gen !== generation || !chat) return;
      const snapshot = item?.kind === 'snapshot' && !item.resolvedRepositoryIdentityRoots;
      chat.onShell(item, seenSnapshot);
      if (snapshot && !seenSnapshot) {
        seenSnapshot = true;
        void chat.idle().then(() => {
          if (gen !== generation) return;
          loaded = true;
          hub.log('info', `t3: ${chat!.counts.threads} threads in ${chat!.counts.projects} projects`);
          status();
        });
      }
    },
    onClose: (why, protocol) => {
      if (gen !== generation) return;
      shell = null;
      if (protocol) return void poll(gen, why);
      hub.log('warn', `t3: the shell stream: ${why}`);
      ws = 'connecting';
      status();
      // Reconnect after a pause; a fresh snapshot then brings what was missed (reads only what changed).
      setTimeout(() => gen === generation && void reconnect(gen), retryMs);
      retryMs = Math.min(retryMs * 2, 60_000);
    },
  });
  try {
    await shell.start();
  } catch (e) {
    if (e instanceof AuthError) await session('rpc', true).catch(() => {});
    if (!origin || readOrigin(baseDir) !== origin) return restart('T3 Code moved or stopped');
    return poll(gen, (e as Error).message);
  }
}

async function reconnect(gen: number) {
  if (readOrigin(baseDir) !== origin) return restart('T3 Code restarted elsewhere');
  await live(gen);
}

/** Without the stream: the first page of the thread list (the most recently changed), every POLL_MS. */
function poll(gen: number, why: string) {
  if (gen !== generation || !chat) return;
  ws = 'failed';
  wsWhy = why;
  hub.log('warn', `t3: no shell stream (${why}); reading the thread list every ${Math.round(POLL_MS / 1000)} s`);
  status();
  let first = true;
  const tick = async () => {
    pollTimer = null;
    if (gen !== generation || !chat) return;
    try {
      const r = await mcp!.call<{ threads: any[] }>('t3_thread_list', { allProjects: true, includeSubagents: false, limit: 100 });
      for (const t of r.threads ?? []) chat.summary(fromListItem(t), !first);
      if (first) {
        first = false;
        await chat.idle();
        loaded = true;
        status();
      }
    } catch (e) {
      if (readOrigin(baseDir) !== origin) return restart('T3 Code moved or stopped');
      hub.log('warn', `t3: the thread list: ${(e as Error).message}`);
    }
    if (gen === generation) pollTimer = setTimeout(tick, POLL_MS);
  };
  void tick();
}

function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  teardown();
}

if (!existsSync(hub.accountDir)) hub.log('warn', 't3: the account directory is missing');
void start();
