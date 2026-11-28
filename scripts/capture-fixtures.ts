/**
 * Golden wire traces: capture real payloads, anonymize them, refuse to write anything the leak guard catches
 * (packages/manager/src/wire-capture.ts).
 *
 *   bun scripts/capture-fixtures.ts scrub <input.ndjson|json> <output.json|ndjson> [--keep-text] [--host <name>]...
 *       Anonymize any captured trace (NDJSON lines or one JSON document). Free text is replaced too unless
 *       --keep-text. Nothing is written if the result still holds concrete data. A scrubbed trace from a real account
 *       is for shaping a fixture by hand; it stays on this machine (AGENTS.md).
 *
 *   bun scripts/capture-fixtures.ts matrix-golden [--out <dir>] [--keep]
 *       Start a fresh continuwuity homeserver (temp dir, free port, federation off), register invented users, run the
 *       composition scenarios below, keep every /sync response the self user (quinn) got, and write one anonymized
 *       fixture per scenario to extractors/matrix/test/golden/. extractors/matrix/test/golden-replay.test.ts replays
 *       them through the adapter. The binary: CONTINUWUITY_BIN, conduwuit on PATH, else nixpkgs#matrix-continuwuity.
 */

import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { syncFilter } from '../extractors/matrix/src/adapter.ts';
import { enc, MatrixClient, MatrixError } from '../extractors/matrix/src/http.ts';
import { assertNoConcreteLeaks, LeakError, parseTrace, scrubTrace } from '../packages/manager/src/wire-capture.ts';

const REPO = resolve(import.meta.dir, '..');

// ------------------------------------------------------------------ scrub

function scrub(input: string, output: string, keepText: boolean, hosts: string[]) {
  const records = parseTrace(readFileSync(input, 'utf8'), { lines: input.endsWith('.ndjson') });
  let value: unknown;
  try {
    value = scrubTrace(records, { scrubText: !keepText, hosts }).value;
  } catch (e) {
    if (e instanceof LeakError) {
      console.error(`refusing to write ${output}: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const text = output.endsWith('.ndjson') && Array.isArray(value) ? value.map((r) => JSON.stringify(r)).join('\n') + '\n' : JSON.stringify(value, null, 2) + '\n';
  assertNoConcreteLeaks(text);
  writeFileSync(output, text);
  console.log(`wrote ${output} (${Array.isArray(value) ? `${value.length} records` : 'one document'})`);
}

// ------------------------------------------------------------------ matrix-golden

const SERVER_NAME = 'dither.test';
const USERS = ['quinn', 'alice', 'bob'] as const;
type UserKey = (typeof USERS)[number];

type Step =
  | { do: 'send'; by: UserKey; body: string }
  | { do: 'edit'; by: UserKey; target: number; body: string }
  | { do: 'reply'; by: UserKey; target: number; body: string }
  | { do: 'react'; by: UserKey; target: number; key: string }
  | { do: 'unreact'; by: UserKey; target: number }
  | { do: 'redact'; by: UserKey; target: number; reason?: string };

interface Scenario {
  name: string;
  about: string;
  steps: Step[];
}

/** Each step's `target` is the index of an earlier step, whose event it acts on. */
export const SCENARIOS: Scenario[] = [
  {
    name: 'send-edit-edit',
    about: 'Alice sends a message and edits it twice: the latest edit wins.',
    steps: [
      { do: 'send', by: 'alice', body: 'golden: first draft' },
      { do: 'edit', by: 'alice', target: 0, body: 'golden: second draft' },
      { do: 'edit', by: 'alice', target: 0, body: 'golden: final draft' },
    ],
  },
  {
    name: 'send-edit-react-unreact',
    about: 'Alice sends and edits; Bob reacts, then takes the reaction back.',
    steps: [
      { do: 'send', by: 'alice', body: 'golden: lunch at noon?' },
      { do: 'edit', by: 'alice', target: 0, body: 'golden: lunch at one?' },
      { do: 'react', by: 'bob', target: 0, key: '👍' },
      { do: 'unreact', by: 'bob', target: 2 },
    ],
  },
  {
    name: 'send-edit-reply',
    about: 'Alice sends and edits; the self user (quinn) replies to the edited message.',
    steps: [
      { do: 'send', by: 'alice', body: 'golden: the build is red' },
      { do: 'edit', by: 'alice', target: 0, body: 'golden: the build is green again' },
      { do: 'reply', by: 'quinn', target: 0, body: 'golden: nice, thanks' },
    ],
  },
  {
    name: 'send-edit-redact',
    about: 'Bob sends and edits, then deletes the message.',
    steps: [
      { do: 'send', by: 'bob', body: 'golden: wrong room, sorry' },
      { do: 'edit', by: 'bob', target: 0, body: 'golden: wrong room, sorry!' },
      { do: 'redact', by: 'bob', target: 0, reason: 'wrong room' },
    ],
  },
];

const secret = (n = 18) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64url');

function binary(): { bin: string; version: string } {
  const named = process.env.CONTINUWUITY_BIN;
  let bin = named && existsSync(named) ? named : Bun.which('conduwuit');
  if (!bin) {
    console.log('fetching matrix-continuwuity from nixpkgs (once)...');
    const p = Bun.spawnSync(['nix', 'build', 'nixpkgs#matrix-continuwuity', '--no-link', '--print-out-paths'], { stdout: 'pipe', stderr: 'inherit' });
    if (p.exitCode !== 0) throw new Error('nix build nixpkgs#matrix-continuwuity failed; set CONTINUWUITY_BIN');
    bin = join(p.stdout.toString().trim().split('\n').pop()!, 'bin', 'conduwuit');
  }
  // The version only, never the path: it names this machine's store.
  const version = /matrix-continuwuity-([\d.]+[\w.-]*)/.exec(bin)?.[1];
  return { bin, version: version ? `continuwuity ${version}` : 'continuwuity' };
}

function freePort(): number {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

async function register(base: string, user: UserKey, token: string): Promise<MatrixClient> {
  const c = new MatrixClient(base);
  const body = { username: user, password: `${user}-${secret(9)}`, initial_device_display_name: 'golden capture' };
  let session: string | undefined;
  try {
    await c.request('POST', '/_matrix/client/v3/register', { auth: false, retries: 0, body });
  } catch (e) {
    if (!(e instanceof MatrixError) || e.status !== 401) throw e;
    session = e.data.session;
  }
  const res = await c.request('POST', '/_matrix/client/v3/register', { auth: false, retries: 0, body: { ...body, auth: { type: 'm.login.registration_token', token, session } } });
  c.accessToken = res.access_token;
  return c;
}

const timelineIds = (res: any, roomId: string): string[] => (res?.rooms?.join?.[roomId]?.timeline?.events ?? []).map((e: any) => e.event_id);

/** A fresh homeserver of its own (temp dir, free port): continuwuity ignores a sync filter's room list, so each scenario
 * gets a server where its room is the only one. */
async function homeserver(bin: string, keep: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dither-matrix-golden-'));
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const token = secret();
  writeFileSync(
    join(dir, 'continuwuity.toml'),
    `[global]
server_name = "${SERVER_NAME}"
database_path = "${join(dir, 'db')}"
address = ["127.0.0.1"]
port = ${port}
allow_federation = false
allow_registration = true
registration_token = "${token}"
force_disable_first_run_mode = true
allow_encryption = true
trusted_servers = []
allow_announcements_check = false
new_user_displayname_suffix = ""
log = "warn"
`,
    { mode: 0o600 },
  );
  const log = openSync(join(dir, 'server.log'), 'a');
  const server = Bun.spawn([bin, '-c', join(dir, 'continuwuity.toml')], { cwd: dir, stdio: ['ignore', log, log] });
  const stop = async () => {
    server.kill();
    await server.exited;
    if (keep) console.log(`kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  };
  try {
    for (let i = 0; ; i++) {
      if (server.exitCode !== null) throw new Error(`continuwuity exited during startup; see ${join(dir, 'server.log')}`);
      try {
        if ((await fetch(`${base}/_matrix/client/versions`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch {}
      if (i > 240) throw new Error('continuwuity did not answer within 60 s');
      await Bun.sleep(250);
    }
  } catch (e) {
    await stop();
    throw e;
  }
  return { base, token, stop };
}

async function matrixGolden(outDir: string, keep: boolean) {
  const { bin, version } = binary();
  mkdirSync(outDir, { recursive: true });
  for (const sc of SCENARIOS) {
    const { base, token, stop } = await homeserver(bin, keep);
    try {
      await scenario(sc, base, token, version, outDir);
    } finally {
      await stop();
    }
  }
}

async function scenario(sc: Scenario, base: string, token: string, version: string, outDir: string) {
  const C = {} as Record<UserKey, MatrixClient>;
  for (const u of USERS) C[u] = await register(base, u, token);
  const mxid = (u: UserKey) => `@${u}:${SERVER_NAME}`;
  for (const u of USERS) await C[u].request('PUT', `/_matrix/client/v3/profile/${enc(mxid(u))}/displayname`, { body: { displayname: { quinn: 'Quinn', alice: 'Alice Chen', bob: 'Bob Okafor' }[u] } });

  const created = await C.quinn.request('POST', '/_matrix/client/v3/createRoom', { body: { name: `golden ${sc.name}`, preset: 'private_chat', invite: [mxid('alice'), mxid('bob')] } });
  const roomId: string = created.room_id;
  await C.alice.request('POST', `/_matrix/client/v3/join/${enc(roomId)}`, { body: {} });
  await C.bob.request('POST', `/_matrix/client/v3/join/${enc(roomId)}`, { body: {} });
  const filter = { ...syncFilter([]), room: { ...syncFilter([]).room, rooms: [roomId] } };
  let since: string | undefined;
  const syncs: { after: string; response: unknown }[] = [];
  const sync = async (after: string, until?: string) => {
    for (let i = 0; i < 20; i++) {
      const res = await C.quinn.request('GET', '/_matrix/client/v3/sync', { query: { filter: JSON.stringify(filter), since, timeout: since ? 10_000 : 0 }, timeoutMs: 30_000 });
      since = res.next_batch;
      syncs.push({ after, response: res });
      if (!until || timelineIds(res, roomId).includes(until)) return;
    }
    throw new Error(`${sc.name}: ${until} never came through sync`);
  };
  // The first sync: how the room is before the scenario, as an adapter's first sync of the account sees it.
  await sync('setup');
  const ids: string[] = [];
  const steps: Record<string, unknown>[] = [];
  for (const [i, st] of sc.steps.entries()) {
    const c = C[st.by];
    const put = async (type: string, content: unknown) =>
      (await c.request('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/send/${enc(type)}/${enc(c.txnId())}`, { body: content })).event_id as string;
    let id: string;
    if (st.do === 'send') id = await put('m.room.message', { msgtype: 'm.text', body: st.body });
    else if (st.do === 'edit')
      id = await put('m.room.message', { msgtype: 'm.text', body: `* ${st.body}`, 'm.new_content': { msgtype: 'm.text', body: st.body }, 'm.relates_to': { rel_type: 'm.replace', event_id: ids[st.target] } });
    else if (st.do === 'reply') id = await put('m.room.message', { msgtype: 'm.text', body: st.body, 'm.relates_to': { 'm.in_reply_to': { event_id: ids[st.target] } } });
    else if (st.do === 'react') id = await put('m.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: ids[st.target], key: st.key } });
    else {
      const reason = st.do === 'redact' ? st.reason : undefined;
      id = (await c.request('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/redact/${enc(ids[st.target])}/${enc(c.txnId())}`, { body: reason ? { reason } : {} })).event_id;
    }
    ids.push(id);
    const { target, ...rest } = st as Step & { target?: number };
    steps.push({ ...rest, by: mxid(st.by), event: id, ...(target !== undefined ? { target: ids[target] } : {}) });
    await sync(String(i), id);
  }
  const fixture = { scenario: sc.name, about: sc.about, source: `${version}, a local testbed with invented users (scripts/capture-fixtures.ts matrix-golden)`, self: mxid('quinn'), room: roomId, steps, syncs };
  const preset = Object.fromEntries(USERS.map((u) => [mxid(u), `@${u}:example.test`]));
  const { json } = scrubTrace(fixture, { scrubText: false, preset });
  const file = join(outDir, `${sc.name}.json`);
  writeFileSync(file, json + '\n');
  console.log(`wrote ${file.startsWith(REPO) ? file.slice(REPO.length + 1) : basename(file)}: ${steps.length} steps, ${syncs.length} syncs`);
}

// ------------------------------------------------------------------ cli

const argv = process.argv.slice(2);
const take = (name: string): string[] => {
  const out: string[] = [];
  for (let i = argv.indexOf(name); i >= 0; i = argv.indexOf(name)) out.push(...argv.splice(i, 2).slice(1));
  return out;
};
const keepText = argv.includes('--keep-text');
const keep = argv.includes('--keep');
const hosts = take('--host');
const out = take('--out')[0];
const [cmd, ...rest] = argv.filter((a) => !a.startsWith('--'));

if (import.meta.main) {
  try {
    if (cmd === 'scrub' && rest.length === 2) scrub(rest[0], rest[1], keepText, hosts);
    else if (cmd === 'matrix-golden') await matrixGolden(resolve(out ?? join(REPO, 'extractors/matrix/test/golden')), keep);
    else {
      console.log('usage: capture-fixtures.ts scrub <input> <output> [--keep-text] [--host <name>]... | matrix-golden [--out <dir>] [--keep]');
      process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    console.error(`capture-fixtures: ${e instanceof MatrixError ? `${e.errcode}: ${e.error}` : e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
