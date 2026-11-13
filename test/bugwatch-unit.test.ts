/**
 * The bugwatch extractor's parts on their own (extractors/bugwatch, docs/bugwatch.md): the config; normalization and
 * fingerprints that stay the same when line numbers move; each reader (errors-ndjson, failed spans without expected
 * refusals, a plain log with a Bun crash block) and tailing across rotation and truncation; new, spike and `always`
 * bugs; a catch-up that lists without announcing; the thread caps and queue with a fake thread command; notices that
 * hold no raw content; read, mute and clear.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Config, parseConfig } from '../extractors/bugwatch/src/config.ts';
import { fingerprint, firstInRepoFrame, normalize, parseFrame } from '../extractors/bugwatch/src/normalize.ts';
import { expand, parseErrorsLine, parseSpanLine, parseTextLines, tail } from '../extractors/bugwatch/src/readers.ts';
import { run } from '../extractors/bugwatch/src/run.ts';
import { DAY, fresh, HOUR, loadState, saveState, type State } from '../extractors/bugwatch/src/state.ts';
import { type Deps, parseThreadId, type RunResult, Watch } from '../extractors/bugwatch/src/watch.ts';

const ROOT = resolve(import.meta.dir, '..');
const FAKE_T3 = join(ROOT, 'extractors/bugwatch/test/fake-t3.ts');
const TEMPLATE = readFileSync(join(ROOT, 'extractors/bugwatch/brief.md'), 'utf8');
const T0 = Date.parse('2026-11-13T12:00:00Z');
const dirs: string[] = [];
const tmp = (p = 'dacc-bugwatch-') => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const errLine = (o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, at: T0, app: 'hub', source: 'request', where: 'GET /api/conversations/:id/messages', name: 'SQLiteError', message: 'database is locked', stack: ['at query (packages/hub/src/db.ts:120:7)'], ...o });

describe('normalize and fingerprint', () => {
  test('ids, numbers, quoted strings, URLs and line:column become placeholders; words stay', () => {
    expect(normalize('no account acc_9f8e7d6c5b42 for user 700000000000000001 (took 250ms)')).toBe('no account <id> for user <n> (took <n>)');
    expect(normalize('row 3fa85f64-5717-4562-b3fc-2c963f66afa6 missing at 0x7ffd9a3c')).toBe('row <uuid> missing at <hex>');
    expect(normalize('GET https://example.com/api/x?y=1 answered 502')).toBe('GET <url> answered <n>');
    expect(normalize('no chat "Ann Lee" in \'Book club\', can\'t open it')).toBe('no chat "<s>" in \'<s>\', can\'t open it');
    expect(normalize('Unexpected . at /srv/app/packages/hub/src/x.ts:208:12', '/srv/app')).toBe('Unexpected . at packages/hub/src/x.ts:<n>');
    expect(normalize('token eyJhbGciOiJIUzI1NiJ9abcdef123456 refused, hash deadbeef01234567')).toBe('token <b64> refused, hash <hex>');
    expect(normalize('line one\nline two\ttabbed')).toBe('line one line two tabbed');
    expect(normalize('x'.repeat(400)).length).toBe(300);
  });

  test('frames: file and function, without line or column; only the project\'s own count', () => {
    expect(parseFrame('    at async handle (/srv/app/packages/hub/src/server.ts:88:13)', '/srv/app')).toEqual({ fn: 'handle', file: 'packages/hub/src/server.ts', inRepo: true });
    expect(parseFrame('at /srv/app/node_modules/ws/lib/x.js:1:1', '/srv/app')).toMatchObject({ file: 'node_modules/ws/lib/x.js', inRepo: false });
    expect(parseFrame('at processTimers (native:7:39)')).toMatchObject({ inRepo: false });
    expect(firstInRepoFrame(['at f (node_modules/a/b.js:1:1)', 'at g (native)', 'at h (packages/hub/src/db.ts:3:4)'])).toBe('packages/hub/src/db.ts#h');
    expect(firstInRepoFrame(['at f (node_modules/a/b.js:1:1)'])).toBe('');
  });

  test('a fingerprint stays when lines move, and changes with the function or the words', () => {
    const base = { sourceName: 'hub', source: 'request', where: 'GET /api/x/:id', name: 'SQLiteError', message: 'database is locked', stack: ['at query (packages/hub/src/db.ts:120:7)'] };
    const a = fingerprint(base);
    expect(fingerprint({ ...base, stack: ['at query (packages/hub/src/db.ts:131:9)'] }).id).toBe(a.id);
    expect(fingerprint({ ...base, message: 'database is locked' }).text).toBe('hub | request | GET /api/x/:id | SQLiteError | database is locked | packages/hub/src/db.ts#query');
    expect(fingerprint({ ...base, stack: ['at insert (packages/hub/src/db.ts:120:7)'] }).id).not.toBe(a.id);
    expect(fingerprint({ ...base, message: 'disk I/O error' }).id).not.toBe(a.id);
    expect(fingerprint({ ...base, sourceName: 'manager' }).id).not.toBe(a.id);
    // An id in the message does not make a new bug.
    expect(fingerprint({ ...base, message: 'no row acc_1a2b3c4d5e' }).id).toBe(fingerprint({ ...base, message: 'no row acc_9z8y7x6w5v' }).id);
  });
});

describe('readers', () => {
  test('errors-ndjson: the contract, with its count; anything else is skipped', () => {
    expect(parseErrorsLine(errLine({ count: 4, trace: 'a'.repeat(32), status: 500 }))).toMatchObject({ at: T0, source: 'request', name: 'SQLiteError', message: 'database is locked', count: 4, trace: 'a'.repeat(32), status: 500 });
    expect(parseErrorsLine('not json')).toBeNull();
    expect(parseErrorsLine(JSON.stringify({ v: 2, at: T0 }))).toBeNull();
    expect(parseErrorsLine('')).toBeNull();
    expect(parseErrorsLine(errLine({ source: 'weird', trace: 'nope' }))).toMatchObject({ source: 'job' });
    expect(parseErrorsLine(errLine({ trace: 'nope' }))!.trace).toBeUndefined();
  });

  test('trace-ndjson: failed spans, without expected refusals', () => {
    const span = (o: Record<string, unknown>) => JSON.stringify({ name: 'POST /api/groups', traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), startMs: T0, durationMs: 12, attrs: {}, status: 'error', ...o });
    expect(parseSpanLine(span({ attrs: { 'http.status': 500, 'http.route': '/api/groups' }, error: 'TypeError: x is undefined' }))).toMatchObject({ source: 'request', where: 'POST /api/groups', name: 'TypeError', message: 'x is undefined', status: 500, trace: 'b'.repeat(32), at: T0 + 12 });
    expect(parseSpanLine(span({ name: 'upkeep', error: 'disk full' }))).toMatchObject({ source: 'job', name: 'Error', message: 'disk full' });
    expect(parseSpanLine(span({ status: 'ok' }))).toBeNull();
    expect(parseSpanLine(span({ attrs: { 'http.status': 404 }, error: 'not found' }))).toBeNull();
    expect(parseSpanLine(span({ name: 'call mail.send', attrs: { outcome: 'denied' }, error: 'no grant' }))).toBeNull();
    // The manager's call span with the status an extractor gave its refusal.
    expect(parseSpanLine(span({ name: 'call calendar.events.list', attrs: { outcome: 'failed', status: 410 }, error: 'Sync token is no longer valid' }))).toBeNull();
    expect(parseSpanLine(span({ name: 'call x', attrs: { outcome: 'failed', status: 502 }, error: 'upstream down' }))).toMatchObject({ status: 502 });
    for (const e of ['Discord answered 429', 'rate limited, retry in 3 s', 'a captcha is needed', 'accept the new terms first', 'AbortError: aborted', 'GitHub answered status 403']) expect(parseSpanLine(span({ error: e }))).toBeNull();
    expect(parseSpanLine(span({ name: 'call x', attrs: { outcome: 'failed' }, error: 'Error: boom' }))).toMatchObject({ source: 'request', name: 'Error', message: 'boom' });
  });

  test('text-log: a Bun crash block is its error line and frames; the source excerpt and other lines are never kept', () => {
    const lines = [
      '--- 2026-11-13T10:00:00.000Z dither-accounts starting fake extractor',
      '[info] signed in as Ann Lee',
      '205 |   const token = secret.token;',
      '206 |   throw new TypeError("no token");',
      '            ^',
      'TypeError: no token for acc_7f3a9c2b1e',
      '      at load (/srv/app/extractors/x/src/main.ts:206:9)',
      '',
      'Bun v1.4.2 (Linux x64)',
      '[info] a password hint: hunter2',
      'error: Unexpected . at /srv/app/extractors/x/src/main.ts:208',
    ];
    const p = parseTextLines(lines, 1, undefined, '/srv/app');
    expect(p.recs).toHaveLength(2);
    expect(p.recs[0]).toMatchObject({ at: Date.parse('2026-11-13T10:00:00.000Z'), source: 'uncaught', name: 'TypeError', message: 'no token for acc_7f3a9c2b1e', stack: ['at load (extractors/x/src/main.ts:206:9)'] });
    expect(p.recs[1]).toMatchObject({ name: 'error', source: 'job', stack: [] });
    expect(p.lines).toEqual([5, 10]);
    expect(p.openFrom).toBe(10);
    const kept = JSON.stringify(p.recs);
    for (const s of ['Ann Lee', 'hunter2', 'secret.token', ' | ']) expect(kept).not.toContain(s);
  });

  test('tail: from where it was, across rotation (the rest of the old file first) and truncation', () => {
    const d = tmp();
    const f = join(d, 'errors.ndjson');
    writeFileSync(f, 'a\nb\n');
    let t = tail(f, undefined, null);
    expect(t.chunks.map((c) => c.lines)).toEqual([['a', 'b']]);
    appendFileSync(f, 'c\npartial');
    t = tail(f, t.state, null);
    expect(t.chunks.map((c) => c.lines)).toEqual([['c']]);
    appendFileSync(f, ' line\nd\n');
    renameSync(f, `${f}.1`);
    writeFileSync(f, 'e\n');
    t = tail(f, t.state, null);
    expect(t.chunks.map((c) => [c.current, c.lines])).toEqual([
      [false, ['partial line', 'd']],
      [true, ['e']],
    ]);
    truncateSync(f, 0);
    writeFileSync(f, 'f\n');
    expect(tail(f, { ...t.state!, offset: 99 }, null).chunks.map((c) => c.lines)).toEqual([['f']]);
    // A missing file: nothing, and its place is kept.
    expect(tail(join(d, 'nope'), t.state, null)).toEqual({ chunks: [], state: t.state });
  });

  test('tail on the first start: the end of the file and its rotated .1 (when recent)', () => {
    const d = tmp();
    const f = join(d, 'x.log');
    writeFileSync(`${f}.1`, 'old1\nold2\n');
    writeFileSync(f, 'new1\n');
    const t = tail(f, undefined, Date.now() - DAY);
    expect(t.chunks.map((c) => c.lines)).toEqual([['old1', 'old2'], ['new1']]);
  });

  test('expand: * in a segment', () => {
    const d = tmp();
    for (const a of ['acc_1', 'acc_2', '.hidden']) {
      mkdirSync(join(d, 'accounts', a), { recursive: true });
      writeFileSync(join(d, 'accounts', a, 'adapter.log'), '');
    }
    mkdirSync(join(d, 'accounts', 'acc_3'));
    expect(expand(join(d, 'accounts/*/adapter.log'))).toEqual([join(d, 'accounts/acc_1/adapter.log'), join(d, 'accounts/acc_2/adapter.log')]);
    expect(expand(join(d, 'plain.log'))).toEqual([join(d, 'plain.log')]);
  });
});

describe('config', () => {
  test('sources, rules and threads; relative paths from the config file; mistakes said', () => {
    const c = parseConfig({ sources: [{ name: 'hub', kind: 'errors-ndjson', path: 'traces/errors.ndjson', project: '/srv/app', base: 'origin/main' }], ignore: ['ResizeObserver'], always: [{ match: '^attempt/' }], threads: { command: ['t3', '{title}'] }, briefs: [{ match: 'hub', file: 'extra.md' }] }, '/etc/bw');
    expect(c.sources[0]).toEqual({ name: 'hub', kind: 'errors-ndjson', path: '/etc/bw/traces/errors.ndjson', project: '/srv/app', base: 'origin/main' });
    expect(c.threads).toEqual({ command: ['t3', '{title}'], gapMinutes: 15, dayMax: 6, queueMax: 10 });
    expect(c.always[0]!.gapHours).toBe(24);
    expect(c.briefs[0]!.file).toBe('/etc/bw/extra.md');
    expect(c.spikeGapHours).toBe(6);
    expect(() => parseConfig({ sources: [] }, '/')).toThrow('no sources');
    expect(() => parseConfig({ sources: [{ name: 'a', kind: 'csv', path: '/x' }] }, '/')).toThrow('kind');
    expect(() => parseConfig({ sources: [{ name: 'a', kind: 'text-log', path: '/x' }, { name: 'a', kind: 'text-log', path: '/y' }] }, '/')).toThrow('two sources');
    expect(() => parseConfig({ sources: [{ name: 'a', kind: 'text-log', path: '/x' }], ignore: ['('] }, '/')).toThrow('regular expression');
    expect(() => parseConfig({ sources: [{ name: 'a', kind: 'text-log', path: '/x' }], threads: { command: [] } }, '/')).toThrow('program');
  });
});

// ------------------------------------------------------------------ the engine

interface Rig {
  w: Watch;
  st: State;
  dir: string;
  file: string;
  calls: string;
  events: { t: string; [k: string]: any }[];
  logs: string[];
  clock: { now: number };
  write: (lines: string[]) => void;
}

function rig(o: { threads?: Partial<Config['threads']> | null; always?: Config['always']; ignore?: RegExp[]; run?: Deps['run']; backlog?: string[] } = {}): Rig {
  const dir = tmp();
  const calls = join(dir, 'calls');
  mkdirSync(calls);
  const file = join(dir, 'traces/errors.ndjson');
  mkdirSync(join(dir, 'traces'));
  writeFileSync(file, (o.backlog ?? []).map((l) => `${l}\n`).join(''));
  const cfg: Config = {
    sources: [{ name: 'hub', kind: 'errors-ndjson', path: file, project: '/srv/app', base: 'origin/main' }],
    ignore: o.ignore ?? [],
    always: o.always ?? [],
    threads: o.threads === null ? null : { command: ['bun', FAKE_T3, calls, 'thread', 'start', '--title', '{title}', '--worktree', '{base}', '--json', '{project}', '-'], gapMinutes: 15, dayMax: 6, queueMax: 10, ...o.threads },
    briefs: [],
    spikeGapHours: 6,
  };
  const st = fresh();
  const events: Rig['events'] = [];
  const logs: string[] = [];
  const clock = { now: T0 };
  const w = new Watch(cfg, st, { now: () => clock.now, run: o.run ?? run, log: (l, m) => logs.push(`[${l}] ${m}`), emit: (e) => events.push(e), briefTemplate: TEMPLATE });
  return { w, st, dir, file, calls, events, logs, clock, write: (lines) => appendFileSync(file, lines.map((l) => `${l}\n`).join('')) };
}
const callsIn = (r: Rig) => readdirSync(r.calls).filter((f) => f.startsWith('call-')).sort().map((f) => JSON.parse(readFileSync(join(r.calls, f), 'utf8')) as { argv: string[]; stdin: string });
const news = (r: Rig) => r.events.filter((e) => e.t === 'notify.new').map((e) => e.notification);

describe('bugs', () => {
  test('the first start: the last 24 h are a catch-up, listed and not announced; a thread starts within the caps', async () => {
    const r = rig({ backlog: [errLine({ at: T0 - 2 * DAY, message: 'too old' }), errLine({ at: T0 - HOUR }), errLine({ at: T0 - HOUR + 1000, where: 'upkeep', source: 'job', name: 'Error', message: 'disk full' })] });
    const s = await r.w.scan();
    expect(s.catchUp).toBe(true);
    expect(s.records).toBe(2);
    expect(s.raised.map((x) => x.reason)).toEqual(['new', 'new']);
    expect(news(r)).toEqual([]);
    const l = r.w.list({});
    expect(l.notifications.map((n) => n.title).sort()).toEqual(['hub: Error: disk full', 'hub: SQLiteError: database is locked']);
    // One thread now (the gap), the other waits.
    expect(callsIn(r)).toHaveLength(1);
    expect(r.w.queue()).toHaveLength(1);
    const bodies = l.notifications.map((n) => n.body!);
    expect(bodies.some((b) => b.includes('A T3 thread is looking into it (Bug: hub: '))).toBe(true);
    expect(bodies.some((b) => b.includes('A T3 thread will start when the limits allow (one every 15 minutes, 6 a day).'))).toBe(true);
    // The next scan is not a catch-up: a new record of a known fingerprint is not news.
    r.clock.now += 60_000;
    r.write([errLine({ at: r.clock.now })]);
    expect((await r.w.scan()).raised).toEqual([]);
  });

  test('a source added to the config later is a catch-up of its own: its last 24 h, listed and not announced', async () => {
    const r = rig({ threads: null });
    await r.w.scan();
    const later = join(r.dir, 'later.ndjson');
    writeFileSync(later, [errLine({ at: T0 - 3 * DAY, where: 'old job', source: 'job' }), errLine({ at: T0 - HOUR, where: 'recent job', source: 'job' })].join('\n') + '\n');
    r.w.cfg.sources.push({ name: 'later', kind: 'errors-ndjson', path: later });
    r.clock.now += 60_000;
    const s = await r.w.scan();
    expect(s.raised.map((x) => [x.bug.sourceName, x.bug.where])).toEqual([['later', 'recent job']]);
    expect(news(r)).toEqual([]);
    expect(r.w.list({}).notifications.map((n) => n.title)).toEqual(['later: SQLiteError: database is locked']);
    // From then on it is live.
    appendFileSync(later, `${errLine({ at: r.clock.now, where: 'next job', source: 'job' })}\n`);
    r.clock.now += 60_000;
    await r.w.scan();
    expect(news(r).map((n) => n.context)).toEqual(['later']);
  });

  test('new: a fingerprint not seen for 14 days; the same one later is counted, not announced', async () => {
    const r = rig({ threads: null });
    await r.w.scan();
    r.write([errLine({ at: T0 + 1000, stack: ['at query (packages/hub/src/db.ts:120:7)'] })]);
    r.clock.now += 30_000;
    expect((await r.w.scan()).raised.map((x) => x.reason)).toEqual(['new']);
    expect(news(r)).toHaveLength(1);
    // A deploy moved the line: the same bug.
    r.write([errLine({ at: T0 + 60_000, stack: ['at query (packages/hub/src/db.ts:131:3)'] }), errLine({ at: T0 + 61_000, message: 'database is locked', count: 3 })]);
    r.clock.now += 30_000;
    expect((await r.w.scan()).raised).toEqual([]);
    const b = Object.values(r.st.bugs)[0]!;
    expect(b.count).toBe(5);
    expect(b.samples).toHaveLength(3);
    // Fifteen days of quiet: new again.
    r.clock.now += 15 * DAY;
    r.write([errLine({ at: r.clock.now })]);
    expect((await r.w.scan()).raised.map((x) => x.reason)).toEqual(['new']);
  });

  test('spike: the last hour at max(20, 5× its hourly mean over the week before), at most once per spikeGapHours', async () => {
    const r = rig({ threads: null });
    await r.w.scan();
    // A steady 2 an hour for a week.
    const old: string[] = [];
    for (let h = 7 * 24; h >= 2; h--) old.push(errLine({ at: T0 - h * HOUR }), errLine({ at: T0 - h * HOUR + 60_000 }));
    r.write(old);
    r.clock.now = T0;
    await r.w.scan();
    r.w.markAllRead();
    // 15 in the hour: under 20.
    r.write(Array.from({ length: 15 }, (_, i) => errLine({ at: T0 + i * 1000 })));
    r.clock.now += 60_000;
    expect((await r.w.scan()).raised).toEqual([]);
    r.write(Array.from({ length: 10 }, (_, i) => errLine({ at: T0 + 100_000 + i * 1000 })));
    r.clock.now += 60_000;
    const s = await r.w.scan();
    expect(s.raised.map((x) => x.reason)).toEqual(['spike']);
    const n = news(r).at(-1)!;
    expect(n.unread).toBe(true);
    expect(n.reason).toBe('spike');
    expect(n.body).toMatch(/, 25 in the last hour against about 2\.0 an hour over the week before\./);
    // Still spiking: not again within 6 hours.
    r.write(Array.from({ length: 30 }, (_, i) => errLine({ at: T0 + 200_000 + i })));
    r.clock.now += 60_000;
    expect((await r.w.scan()).raised).toEqual([]);
  });

  test('always: every occurrence of a matching source/where, at most once per gapHours; a read one too', async () => {
    const r = rig({ threads: null, always: [{ match: /^attempt\/POST \/api\/groups$/, gapHours: 1 }] });
    await r.w.scan();
    const attempt = (at: number) => errLine({ at, source: 'attempt', where: 'POST /api/groups', name: 'GroupError', message: 'Discord refused to make the group' });
    r.write([attempt(T0 + 1)]);
    expect((await r.w.scan()).raised.map((x) => x.reason)).toEqual(['new']);
    r.w.markRead([`bug:${Object.keys(r.st.bugs)[0]}`]);
    r.write([attempt(T0 + 600_000)]);
    r.clock.now = T0 + 600_000;
    expect((await r.w.scan()).raised).toEqual([]);
    r.write([attempt(T0 + HOUR + 2)]);
    r.clock.now = T0 + HOUR + 2;
    expect((await r.w.scan()).raised.map((x) => x.reason)).toEqual(['always']);
    expect(news(r).at(-1)).toMatchObject({ unread: true, reason: 'always' });
  });

  test('ignore drops records before anything; a failed span whose trace an error record named is the same failure', async () => {
    const r = rig({ threads: null, ignore: [/ResizeObserver/] });
    const spans = join(r.dir, 'traces/hub.trace.ndjson');
    writeFileSync(spans, '');
    r.w.cfg.sources.push({ name: 'hub-spans', kind: 'trace-ndjson', path: spans });
    await r.w.scan();
    const trace = 'd'.repeat(32);
    r.write([errLine({ at: T0 + 1, trace }), errLine({ at: T0 + 2, name: 'Error', message: 'ResizeObserver loop limit exceeded' })]);
    appendFileSync(spans, `${JSON.stringify({ name: 'GET /api/x', traceId: trace, spanId: 'e'.repeat(16), startMs: T0, durationMs: 1, attrs: { 'http.status': 500 }, status: 'error', error: 'SQLiteError: database is locked' })}\n`);
    const s = await r.w.scan();
    expect(s.raised.map((x) => x.bug.sourceName)).toEqual(['hub']);
  });
});

describe('notices', () => {
  test('a notice holds the source, where, name and normalized message only: never a stack, a sample or raw text', async () => {
    const r = rig({ threads: null });
    await r.w.scan();
    r.write([errLine({ at: T0 + 1, source: 'uncaught', where: 'process', name: 'TypeError', message: 'cannot read "Ann Lee" of acc_7f3a9c2b1e at https://example.com/x?token=abc123def456', stack: ['at secretFn (packages/hub/src/people.ts:44:2)'] })]);
    await r.w.scan();
    const n = news(r)[0]!;
    expect(n).toMatchObject({ source: 'bugwatch', title: 'hub: TypeError: cannot read "<s>" of <id> at <url>', url: null, reason: 'new', context: 'hub', actors: [], unread: true, urgency: 'high', at: T0 });
    expect(n.id).toMatch(/^bug:[0-9a-f]{16}$/);
    expect(n.body).toBe(`process: 1 time since 2026-11-13 12:00 UTC. No T3 thread: threads are not set up in the config.`);
    const all = JSON.stringify(n);
    for (const s of ['Ann Lee', 'acc_7f3a9c2b1e', 'example.com', 'abc123def456', 'secretFn', 'people.ts', 'packages/']) expect(all).not.toContain(s);
    expect(n.title.length).toBeLessThanOrEqual(120);
  });

  test('read acknowledges; a read fingerprint is announced again only on a spike; mute and clear', async () => {
    const r = rig({ threads: null });
    await r.w.scan();
    r.write([errLine({ at: T0 + 1 })]);
    await r.w.scan();
    const id = news(r)[0]!.id;
    expect(r.w.markRead([id, 'bug:nope'])).toEqual([id]);
    expect(r.events.at(-1)).toEqual({ t: 'notify.read', ids: [id] });
    expect(r.w.markRead([id])).toEqual([]);
    expect(r.w.list({ unreadOnly: true }).notifications).toEqual([]);
    expect(r.w.list({}).notifications[0]!.unread).toBe(false);
    r.write(Array.from({ length: 10 }, (_, i) => errLine({ at: T0 + 10 + i })));
    r.clock.now += 60_000;
    expect((await r.w.scan()).raised).toEqual([]);
    // Mute: no notices, none listed; clear brings it back.
    expect(r.w.mute(id)).toBe(true);
    r.write(Array.from({ length: 30 }, (_, i) => errLine({ at: T0 + 100 + i })));
    r.clock.now += 60_000;
    expect((await r.w.scan()).raised).toEqual([]);
    expect(r.w.list({}).notifications).toEqual([]);
    expect(r.w.clear(id)).toBe(true);
    expect(r.w.list({}).notifications).toHaveLength(1);
    expect(r.w.mute('bug:nope')).toBe(false);
  });

  test('list pages, since, unreadOnly', async () => {
    const r = rig({ threads: null });
    await r.w.scan();
    for (let i = 0; i < 5; i++) {
      r.clock.now += 1000;
      r.write([errLine({ at: r.clock.now, where: `job number ${'abcde'[i]}`, source: 'job' })]);
      await r.w.scan();
    }
    const p1 = r.w.list({ limit: 2 });
    expect(p1.notifications.map((n) => n.at)).toEqual([T0 + 5000, T0 + 4000]);
    const p2 = r.w.list({ limit: 2, pageToken: p1.next! });
    expect(p2.notifications.map((n) => n.at)).toEqual([T0 + 3000, T0 + 2000]);
    expect(r.w.list({ limit: 2, pageToken: '4' }).next).toBeNull();
    expect(r.w.list({ since: T0 + 4000 }).notifications).toHaveLength(2);
    r.w.markAllRead(T0 + 3000);
    expect(r.w.list({ unreadOnly: true }).notifications.map((n) => n.at)).toEqual([T0 + 5000, T0 + 4000]);
  });
});

describe('threads', () => {
  test('the command gets its argv filled in and the brief on stdin; its JSON names the thread', async () => {
    const r = rig();
    await r.w.scan();
    r.write([errLine({ at: T0 + 1, trace: 'f'.repeat(32) })]);
    await r.w.scan();
    const [c] = callsIn(r);
    const title = 'Bug: hub: SQLiteError: database is locked';
    expect(c!.argv).toEqual(['thread', 'start', '--title', title, '--worktree', 'origin/main', '--json', '/srv/app', '-']);
    expect(c!.stdin).toContain('# A bug bugwatch found: hub: SQLiteError: database is locked');
    expect(c!.stdin).toContain(`bun scripts/trace-summary.ts --data ${r.dir} --since all --trace ${'f'.repeat(32)}`);
    expect(c!.stdin).toContain('at query (packages/hub/src/db.ts:120:7)');
    expect(c!.stdin).toContain('do not merge it, do not enable auto-merge, do not');
    expect(c!.stdin).not.toMatch(/\{\{\w+\}\}/);
    const b = Object.values(r.st.bugs)[0]!;
    expect(b.thread).toEqual({ title, at: T0, id: 'thread-1' });
    expect(news(r)[0]!.body).toContain(`A T3 thread is looking into it (${title}).`);
    expect(news(r)[0]!.subject!.state).toBe('thread');
  });

  test('caps: one per gapMinutes, dayMax a day; the queue keeps the most frequent; one thread per fingerprint until cleared', async () => {
    const started: string[][] = [];
    const fake: Deps['run'] = async (argv): Promise<RunResult> => {
      started.push(argv);
      return { code: 0, stdout: `${JSON.stringify({ threadId: `t${started.length}`, runId: null })}\n`, stderr: '' };
    };
    const r = rig({ run: fake, threads: { gapMinutes: 10, dayMax: 2, queueMax: 2 } });
    await r.w.scan();
    // Four bugs at once, seen 1, 4, 3 and 2 times.
    const bug = (k: string, n: number) => Array.from({ length: n }, (_, i) => errLine({ at: T0 + i, where: `job ${k}`, source: 'job' }));
    r.write([...bug('a', 1), ...bug('b', 4), ...bug('c', 3), ...bug('d', 2)]);
    await r.w.scan();
    expect(started.map((a) => a.at(-1))).toEqual(['-']);
    const titleOf = (argv: string[]) => argv[argv.indexOf('--title') + 1];
    expect(titleOf(started[0]!)).toBe('Bug: hub: SQLiteError: database is locked');
    // b (4) started; c (3) and d (2) wait; a (1) was left out.
    const byWhere = (w: string) => Object.values(r.st.bugs).find((b) => b.where === w)!;
    expect(byWhere('job b').thread?.id).toBe('t1');
    expect(r.w.queue().map((b) => b.where)).toEqual(['job c', 'job d']);
    expect(byWhere('job a').dropped).toBe(true);
    expect(r.w.notification(byWhere('job a')).body).toContain('No T3 thread: more bugs were waiting than the queue keeps, each seen more often.');
    // Within the gap: nothing.
    r.clock.now += 5 * 60_000;
    await r.w.pump();
    expect(started).toHaveLength(1);
    r.clock.now += 6 * 60_000;
    await r.w.pump();
    expect(started).toHaveLength(2);
    expect(byWhere('job c').thread?.id).toBe('t2');
    // dayMax 2: d waits for the day to roll.
    r.clock.now += 20 * 60_000;
    await r.w.pump();
    expect(started).toHaveLength(2);
    r.clock.now = T0 + DAY + 1000;
    await r.w.pump();
    expect(started).toHaveLength(3);
    // b again, as a spike: no second thread; its notice says the first one looked.
    r.clock.now += 11 * 60_000;
    r.write(Array.from({ length: 30 }, (_, i) => errLine({ at: r.clock.now - 1000 + i, where: 'job b', source: 'job' })));
    const s = await r.w.scan();
    expect(s.raised.map((x) => [x.bug.where, x.reason])).toEqual([['job b', 'spike']]);
    expect(started).toHaveLength(3);
    expect(news(r).at(-1)!.body).toContain('A T3 thread already looked into it (Bug: hub: SQLiteError: database is locked).');
    // Cleared while its notice is unread: it may have a thread again.
    r.w.clear(byWhere('job b').id);
    r.clock.now += 11 * 60_000;
    await r.w.pump();
    expect(started).toHaveLength(4);
  });

  test('a command that fails: said in the notice and the log, never its output in the notice', async () => {
    const r = rig();
    writeFileSync(join(r.calls, 'fail'), '7');
    await r.w.scan();
    r.write([errLine({ at: T0 + 1 })]);
    await r.w.scan();
    const n = news(r)[0]!;
    expect(n.body).toContain('Starting a T3 thread failed (exit code 7): the bugwatch account\'s log says more.');
    expect(n.subject!.state).toBe('thread-failed');
    expect(JSON.stringify(n)).not.toContain('told to fail');
    expect(r.logs.find((l) => l.startsWith('[error]'))).toMatch(/starting a thread for bug [0-9a-f]{16} failed \(exit code 7\); it said: error: the fake thread command was told to fail/);
  });

  test('a source without a project and base gets no thread, and says so', async () => {
    const r = rig();
    delete r.w.cfg.sources[0]!.project;
    await r.w.scan();
    r.write([errLine({ at: T0 + 1 })]);
    await r.w.scan();
    expect(callsIn(r)).toEqual([]);
    expect(news(r)[0]!.body).toContain('No T3 thread: its source names no project and base.');
  });

  test('parseThreadId: t3\'s { threadId }, a line of it, or nothing', () => {
    expect(parseThreadId('{"threadId":"abc-123","runId":"r"}')).toBe('abc-123');
    expect(parseThreadId('starting…\n{"threadId":"abc-124"}\n')).toBe('abc-124');
    expect(parseThreadId('{"thread":{"id":"x1"}}')).toBe('x1');
    expect(parseThreadId('no json')).toBeNull();
    expect(parseThreadId('{"threadId":"has space"}')).toBeNull();
  });
});

test('state.json round-trips, and an unreadable one starts over', () => {
  const d = tmp();
  const p = join(d, 'state.json');
  const s = fresh();
  s.startedAt = T0;
  saveState(p, s);
  expect(loadState(p)).toEqual(s);
  writeFileSync(p, '{');
  const said: string[] = [];
  expect(loadState(p, (m) => said.push(m))).toEqual(fresh());
  expect(said[0]).toContain('starting over');
});
