/**
 * Calls through Signal Desktop (src/desktop/calls.ts), against the fake signal-cli and a stub Desktop: off unless the
 * account's `calls` setting is on; the call capabilities only while Desktop is linked and its hook is in (and the hub is
 * told again when that changes); the hub's call commands become the hook's ops with the signal kind's conversations as
 * ACIs and group ids; the hook's news becomes `call` events and, for group rings, `callState` facts; a primary links
 * Desktop with its own code.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent, Capability } from '@dither-chat/protocol';
import { type AdapterHost, CAPABILITIES, SignalAdapter } from '../src/adapter.ts';
import type { CallsHost, DesktopApp, DesktopOptions, HookEvent } from '../src/desktop/desktop.ts';

const FAKE = join(import.meta.dir, 'fake-signal-cli.ts');
const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const ALICE = 'a11ce000-2222-4ccc-9ddd-000000000002';
const GID = 'Cl1mb1ngCrew+Gr0up0000000000000000000000000=';
const CALL_CAPS: Capability[] = ['calls', 'declineCall', 'ringCalls', 'callVideo'];

/** A Desktop that is whatever the test says, and remembers what it was asked. */
class StubDesktop implements CallsHost {
  app: DesktopApp | null = null;
  hookIn = false;
  asked: { op: string; body: Record<string, unknown> }[] = [];
  started = 0;
  stopped = 0;
  constructor(public o: DesktopOptions) {}
  get ready() {
    return this.hookIn && !!this.app?.signedIn;
  }
  async start() {
    this.started++;
  }
  async stop() {
    this.stopped++;
  }
  async request<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
    this.asked.push({ op, body });
    return { ok: true } as T;
  }
  liveView() {
    return { vncSocket: '/run/test/vnc.sock', width: 1280, height: 800 };
  }
  layer() {
    return this.ready ? { name: 'calls', state: 'ok' as const, note: 'through Signal Desktop' } : { name: 'calls', state: 'waiting' as const, note: 'test' };
  }
  details() {
    return { 'calls body': this.ready ? 'Signal Desktop, linked' : 'Signal Desktop, not linked' };
  }
  /** Desktop changes: linked or not, a link code, its hook in. */
  set(app: DesktopApp | null, hookIn = this.hookIn) {
    this.app = app;
    this.hookIn = hookIn;
    this.o.onChange();
  }
  hear(ev: HookEvent) {
    this.o.onEvent(ev);
  }
}

interface World {
  dir: string;
  adapter: SignalAdapter;
  events: AdapterEvent[];
  logs: string[];
  desk: StubDesktop | null;
  made: number;
}

async function world(config: Record<string, unknown>, primary = false): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'dither-sig-calls-'));
  const w: World = { dir, events: [], logs: [], desk: null, made: 0, adapter: null as unknown as SignalAdapter };
  let secret: Record<string, any> = {};
  const host: AdapterHost = {
    emit: (ev) => w.events.push(ev),
    log: (level, msg) => w.logs.push(`[${level}] ${msg}`),
    accountDir: dir,
    config,
    secret: () => secret,
    saveSecret: (v) => {
      secret = v as Record<string, any>;
    },
  };
  // The adapter takes its environment for signal-cli when it is made: set only for that, so no other test file sees it.
  if (primary) process.env.FAKE_PRIMARY = '1';
  w.adapter = new SignalAdapter(host, {
    signalCli: async () => [process.execPath, FAKE],
    linkRotateMs: 600,
    restartBackoffMs: [100, 200, 400],
    resnapshotMs: [0],
    resnapshotEveryMs: 3_600_000,
    expirySweepMs: 3_600_000,
    daemonReadyTimeoutMs: 10_000,
    daemonHealthEveryMs: 0,
    desktop: (o) => {
      w.made++;
      w.desk = new StubDesktop(o);
      return w.desk;
    },
  });
  delete process.env.FAKE_PRIMARY;
  await w.adapter.start();
  // Link the fake signal-cli, so the account knows itself.
  await until(w, 'a QR code', () => w.events.some((e) => e.t === 'status' && e.attention?.qr));
  writeFileSync(join(dir, 'signal-cli', 'fake-scan'), '');
  await until(w, 'online', () => w.events.some((e) => e.t === 'status' && e.status === 'online'));
  return w;
}

async function until<T>(w: World, what: string, fn: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${w.logs.slice(-15).join('\n')}`);
    await Bun.sleep(20);
  }
}
const hellos = (w: World) => w.events.filter((e): e is Extract<AdapterEvent, { t: 'hello' }> => e.t === 'hello');
const cmd = (w: World, c: any) => w.adapter.command({ id: String(Math.random()), ...c });
const rpc = (w: World, method: string) => {
  const f = join(w.dir, 'signal-cli', 'fake-rpc.jsonl');
  return existsSync(f)
    ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.t === 'rpc' && r.method === method)
    : [];
};
async function done(w: World) {
  await w.adapter.shutdown();
  rmSync(w.dir, { recursive: true, force: true });
}

describe('calls setting off (the default)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world({});
  });
  afterAll(() => done(w));

  test('no Desktop, no call capabilities, and call commands are refused', async () => {
    expect(w.made).toBe(0);
    expect(hellos(w).every((h) => h.capabilities.join(',') === CAPABILITIES.join(','))).toBe(true);
    await expect(cmd(w, { t: 'call', call: 'c1', op: 'join', conversation: `dm:${SELF}:${ALICE}`, mode: 'bridge' })).rejects.toThrow(/off/);
    await expect(cmd(w, { t: 'declineCall', conversation: `dm:${SELF}:${ALICE}`, call: '1' })).rejects.toThrow(/off/);
    const st = w.events.filter((e): e is Extract<AdapterEvent, { t: 'status' }> => e.t === 'status').at(-1)!;
    expect(st.layers?.map((l) => l.name)).not.toContain('calls');
    expect(st.liveView).toBeUndefined();
  });
});

describe('calls setting on, a linked account (a phone is the primary)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world({ calls: true });
  });
  afterAll(() => done(w));

  test('Desktop starts with the adapter; the calls layer and its live view are in the status', () => {
    expect(w.made).toBe(1);
    expect(w.desk!.started).toBe(1);
    const st = w.events.filter((e): e is Extract<AdapterEvent, { t: 'status' }> => e.t === 'status').at(-1)!;
    expect(st.layers?.at(-1)).toMatchObject({ name: 'calls', state: 'waiting' });
    expect(st.liveView).toEqual({ vncSocket: '/run/test/vnc.sock', width: 1280, height: 800 });
  });

  test('not linked yet: no call capabilities, and a linked device never links Desktop itself (the phone scans it)', async () => {
    w.desk!.set({ ready: true, signedIn: false, linkUrl: 'sgnl://linkdevice?uuid=AAA&pub_key=BBB' }, true);
    await Bun.sleep(100);
    expect(hellos(w).at(-1)!.capabilities).toEqual(CAPABILITIES);
    expect(rpc(w, 'addDevice')).toEqual([]);
  });

  test('linked and its hook in: the hub is told the call capabilities at once', async () => {
    const before = hellos(w).length;
    w.desk!.set({ ready: true, signedIn: true, aci: SELF });
    const h = await until(w, 'a new hello', () => hellos(w).length > before && hellos(w).at(-1));
    expect(h.capabilities).toEqual([...CAPABILITIES, ...CALL_CAPS]);
  });

  test("a join becomes the hook's join, with the conversation as an ACI; a group's as its id", async () => {
    await cmd(w, { t: 'call', call: 'c1', op: 'join', conversation: `dm:${SELF}:${ALICE}`, mode: 'bridge', ring: true });
    expect(w.desk!.asked.at(-1)).toEqual({ op: 'join', body: { call: 'c1', target: { peer: ALICE }, ring: true, muted: false, deafened: false } });
    await cmd(w, { t: 'call', call: 'c2', op: 'join', conversation: `group:${GID}`, mode: 'bridge', muted: true });
    expect(w.desk!.asked.at(-1)!.body).toMatchObject({ call: 'c2', target: { group: GID }, ring: false, muted: true });
    await expect(cmd(w, { t: 'call', call: 'c3', op: 'join', conversation: `dm:${SELF}:${ALICE}`, mode: 'direct' })).rejects.toThrow(/bridge/);
    await expect(cmd(w, { t: 'call', call: 'c3', op: 'join', conversation: `dm:${SELF}:${SELF}`, mode: 'bridge' })).rejects.toThrow(/person or a group/);
  });

  test('signal, mute, video and leave pass through; decline names the conversation', async () => {
    await cmd(w, { t: 'call', call: 'c1', op: 'signal', data: { type: 'offer', sdp: 'v=0' } });
    await cmd(w, { t: 'call', call: 'c1', op: 'mute', muted: true, deafened: false });
    await cmd(w, { t: 'call', call: 'c1', op: 'video', camera: true, screen: false });
    await cmd(w, { t: 'call', call: 'c1', op: 'leave' });
    await cmd(w, { t: 'declineCall', conversation: `dm:${SELF}:${ALICE}`, call: '77' });
    expect(w.desk!.asked.slice(-5)).toEqual([
      { op: 'signal', body: { call: 'c1', data: { type: 'offer', sdp: 'v=0' } } },
      { op: 'mute', body: { call: 'c1', muted: true, deafened: false } },
      { op: 'video', body: { call: 'c1', camera: true, screen: false, screenAudio: false } },
      { op: 'leave', body: { call: 'c1' } },
      { op: 'decline', body: { target: { peer: ALICE } } },
    ]);
  });

  test("the hook's news: signalling, the call's state in the signal kind's ids, and its end", () => {
    const mark = w.events.length;
    w.desk!.hear({ ev: 'call', call: 'c2', signal: { type: 'answer', sdp: 'v=0' } });
    w.desk!.hear({
      ev: 'call',
      call: 'c2',
      state: {
        target: { group: GID },
        participants: [{ id: ALICE, muted: false, deafened: false, speaking: true, video: true }],
        video: [{ slot: '4', who: ALICE, source: 'camera' }],
        self: { connected: true, muted: true, deafened: false, camera: false, streaming: false },
      },
    });
    w.desk!.hear({ ev: 'call', call: 'c2', ended: 'left' });
    expect(w.events.slice(mark)).toEqual([
      { t: 'call', call: 'c2', signal: { type: 'answer', sdp: 'v=0' } },
      {
        t: 'call',
        call: 'c2',
        state: {
          conversation: `group:${GID}`,
          participants: [{ id: ALICE, muted: false, deafened: false, speaking: true, video: true }],
          video: [{ slot: '4', who: ALICE, source: 'camera' }],
          self: { connected: true, muted: true, deafened: false, camera: false, streaming: false },
        },
      },
      { t: 'call', call: 'c2', ended: 'left' },
    ]);
  });

  test('a group ring is a callState fact from its start; answered here it goes on, else it was missed', () => {
    const mark = w.events.length;
    const T0 = 1_793_330_000_000;
    w.desk!.hear({ ev: 'ring', state: 'ringing', ring: '42', target: { group: GID }, caller: ALICE.toUpperCase(), video: false, at: T0 });
    w.desk!.hear({ ev: 'ring', state: 'ended', ring: '42', target: { group: GID }, caller: ALICE, video: false, joined: false, at: T0 + 20_000 });
    w.desk!.hear({ ev: 'ring', state: 'ringing', ring: '43', target: { group: GID }, caller: ALICE, video: false, at: T0 + 60_000 });
    w.desk!.hear({ ev: 'ring', state: 'ended', ring: '43', target: { group: GID }, caller: ALICE, video: false, joined: true, at: T0 + 65_000 });
    expect(w.events.slice(mark)).toEqual([
      { t: 'callState', call: { nativeId: 'ring:42', conversation: `group:${GID}`, caller: ALICE, startedAt: T0, state: 'ringing', ringsSelf: true } },
      { t: 'callState', call: { nativeId: 'ring:42', conversation: `group:${GID}`, caller: ALICE, startedAt: T0, state: 'ended', outcome: 'missed', endedAt: T0 + 20_000 } },
      { t: 'callState', call: { nativeId: 'ring:43', conversation: `group:${GID}`, caller: ALICE, startedAt: T0 + 60_000, state: 'ringing', ringsSelf: true } },
      { t: 'callState', call: { nativeId: 'ring:43', conversation: `group:${GID}`, caller: ALICE, startedAt: T0 + 60_000, state: 'ongoing', answeredAt: T0 + 65_000 } },
    ]);
  });

  test('its hook gone: the call capabilities go with it', async () => {
    const before = hellos(w).length;
    w.desk!.set(w.desk!.app, false);
    const h = await until(w, 'a new hello', () => hellos(w).length > before && hellos(w).at(-1));
    expect(h.capabilities).toEqual(CAPABILITIES);
    await expect(cmd(w, { t: 'call', call: 'c9', op: 'join', conversation: `dm:${SELF}:${ALICE}`, mode: 'bridge' })).rejects.toThrow(/not set up/);
  });

  test('Desktop stops with the adapter', async () => {
    await w.adapter.shutdown();
    expect(w.desk!.stopped).toBe(1);
  });
});

describe('calls setting on, the primary device (signal-cli registered the number)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world({ calls: true }, true);
  });
  afterAll(() => done(w));

  test('Desktop showing its code is linked with signal-cli addDevice, once per code', async () => {
    w.desk!.set({ ready: true, signedIn: false, linkUrl: 'sgnl://linkdevice?uuid=AAA&pub_key=BBB' }, true);
    await until(w, 'addDevice', () => rpc(w, 'addDevice').length === 1);
    expect(rpc(w, 'addDevice')[0].params).toEqual({ uri: 'sgnl://linkdevice?uuid=AAA&pub_key=BBB' });
    w.desk!.set({ ready: true, signedIn: false, linkUrl: 'sgnl://linkdevice?uuid=AAA&pub_key=BBB' }, true);
    await Bun.sleep(100);
    expect(rpc(w, 'addDevice').length).toBe(1);
    // Nothing of the code reaches the log.
    expect(w.logs.join('\n')).not.toMatch(/AAA|BBB/);
  });
});

describe('a calls-only account (the call lab): Signal Desktop alone, no signal-cli', () => {
  const events: AdapterEvent[] = [];
  let dir: string;
  let adapter: SignalAdapter;
  let desk: StubDesktop;
  const w = () => ({ dir, adapter, events, logs: [], desk, made: 1 }) as World;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dither-sig-callsonly-'));
    const host: AdapterHost = { emit: (ev) => events.push(ev), log: () => {}, accountDir: dir, config: { callsOnly: true, peers: [ALICE.toUpperCase(), 'not-an-aci'] }, secret: () => ({}), saveSecret: () => {} };
    adapter = new SignalAdapter(host, {
      signalCli: async () => {
        throw new Error('a calls-only account runs no signal-cli');
      },
      desktop: (o) => {
        desk = new StubDesktop(o);
        desk.request = (async (op: string, body: Record<string, unknown> = {}) => {
          desk.asked.push({ op, body });
          return op === 'names' ? { [ALICE]: 'Ann Lee' } : { ok: true };
        }) as CallsHost['request'];
        return desk;
      },
    });
    await adapter.start();
  });
  afterAll(async () => {
    await adapter.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('it offers calls only, and asks for the link with Desktop’s code', async () => {
    expect(events[0]).toMatchObject({ t: 'hello', capabilities: ['callStates'] });
    expect(desk.started).toBe(1);
    desk.set({ ready: true, signedIn: false, linkUrl: 'sgnl://linkdevice?uuid=AAA&pub_key=BBB' }, true);
    const st = await until(w(), 'the link code', () => events.find((e) => e.t === 'status' && e.attention?.qr));
    expect(st).toMatchObject({ status: 'attention', attention: { kind: 'link_device', qr: 'sgnl://linkdevice?uuid=AAA&pub_key=BBB' }, layers: [{ name: 'calls', state: 'waiting' }] });
  });

  test('linked: online as itself, with a 1:1 for each listed peer and nothing else, and the call capabilities', async () => {
    const mark = events.length;
    desk.set({ ready: true, signedIn: true, aci: SELF.toUpperCase() });
    await until(w(), 'online', () => events.slice(mark).find((e) => e.t === 'status' && e.status === 'online'));
    const out = events.slice(mark).filter((e) => e.t !== 'status');
    expect(out).toEqual([
      { t: 'hello', network: 'signal', version: expect.any(String), capabilities: ['callStates', ...CALL_CAPS] },
      { t: 'identity', identity: { nativeId: ALICE, displayName: 'Ann Lee', contact: true } },
      { t: 'conversation', conversation: { nativeId: `dm:${SELF}:${ALICE}`, shape: 'direct', participants: [SELF, ALICE], encrypted: true } },
    ]);
    expect(desk.asked.find((a) => a.op === 'names')!.body).toEqual({ peers: [ALICE] });
    await cmd(w(), { t: 'call', call: 'c1', op: 'join', conversation: `dm:${SELF}:${ALICE}`, mode: 'bridge' });
    expect(desk.asked.at(-1)).toMatchObject({ op: 'join', body: { target: { peer: ALICE } } });
  });

  test('on a reconnect to the hub it says its peers again', () => {
    const mark = events.length;
    adapter.onHubConnect();
    expect(events.slice(mark).filter((e) => e.t === 'conversation').length).toBe(1);
  });
});
