/**
 * hook.js's bridge calls beyond audio (docs/chat.md "Calls"), against a small replica of the client: a client that
 * never enabled audio enables it when a call starts and gets the device's microphone, through the page's own
 * getUserMedia wrapper as well as the prototype's; the device's camera and screen become the client's camera and Go
 * Live; others' cameras and the streams the device watches go on the bridge's receive slots; the call's state says
 * the client's own state and whose video is where. WebRTC and Web Audio are stand-ins: nothing plays or connects.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';

const KEY = 'discord-hook-video-test-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

const ME = '100000000000000001';
const ANA = '100000000000000004';
const BEN = '100000000000000005';
const GUILD = '200000000000000001';
const VOICE = '300000000000000201';

// ------------------------------------------------------------------ stand-ins

class Node {
  connect(n: unknown) {
    return n;
  }
  disconnect() {}
}
let micClones = 0;
class FakeAudioContext {
  state = 'running';
  createMediaStreamDestination() {
    return Object.assign(new Node(), { stream: { getAudioTracks: () => [{ kind: 'audio', clone: () => (micClones++, { kind: 'audio', id: 'device-mic' }) }] } });
  }
  createAnalyser() {
    return Object.assign(new Node(), { fftSize: 32, getFloatTimeDomainData() {} });
  }
  createMediaStreamSource() {
    return new Node();
  }
  createGain() {
    return Object.assign(new Node(), { gain: { value: 1 } });
  }
  close() {}
}
class FakeAudio {
  muted = false;
  srcObject: unknown = null;
  play() {
    return Promise.resolve();
  }
  addEventListener() {}
}
class FakeMediaStream {
  constructor(public tracks: any[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}
const vtrack = (id: string) => ({ id, kind: 'video', readyState: 'live', clone() {
  return { ...this, id: `${id}-clone` };
}, addEventListener() {} });

class FakePC {
  static made: FakePC[] = [];
  transceivers: any[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  ontrack: ((e: any) => void) | null = null;
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  connectionState = 'new';
  localDescription: { sdp: string } | null = null;
  constructor() {
    FakePC.made.push(this);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  getReceivers() {
    return [];
  }
  getTransceivers() {
    return this.transceivers;
  }
  /** A device's bridge offer: its eight m-lines (protocol BRIDGE_MIDS), and its tracks on the ones it sends. */
  setRemoteDescription(d: any) {
    if (d?.type === 'offer') {
      const kinds = ['audio', 'video', 'video', 'audio', 'video', 'video', 'video', 'video'];
      this.transceivers = kinds.map((kind, i) => {
        const sender = { track: null as any, replaceTrack: (t: any) => ((sender.track = t), Promise.resolve()) };
        return { mid: String(i), direction: 'recvonly', receiver: { track: { kind } }, sender };
      });
      for (const [mid, t] of [
        ['0', { kind: 'audio', id: 'mic-from-device' }],
        ['1', vtrack('camera-from-device')],
        ['2', vtrack('screen-from-device')],
      ] as const)
        this.ontrack?.({ track: t, transceiver: this.transceivers[Number(mid)] });
    }
    return Promise.resolve();
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'v=0' });
  }
  setLocalDescription(d: any) {
    this.localDescription = d;
    return Promise.resolve();
  }
  addIceCandidate() {
    return Promise.resolve();
  }
  close() {}
  /** A remote track on one of the client's own connections. */
  track(t: any, streamId: string) {
    for (const fn of this.listeners.track ?? []) fn({ track: t, streams: [{ id: streamId }] });
  }
}
const GLOBALS = { AudioContext: FakeAudioContext, Audio: FakeAudio, MediaStream: FakeMediaStream, RTCPeerConnection: FakePC };
afterEach(() => {
  for (const k of Object.keys(GLOBALS)) delete (globalThis as any)[k];
  FakePC.made = [];
  micClones = 0;
});

// ------------------------------------------------------------------ the client

function client(o: { enabled?: boolean; muted?: boolean } = {}) {
  const calls: any[] = [];
  const listeners = new Set<() => void>();
  const voice: Record<string, any> = {};
  const media = { enabled: o.enabled ?? true, muted: o.muted ?? false, video: false };
  const conns: any[] = [];
  const holder: { nav?: any } = {};
  let interceptor: ((a: any) => boolean) | null = null;
  const channels: Record<string, any> = { [VOICE]: { id: VOICE, type: 2, guild_id: GUILD, name: 'Voice' } };
  const store = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, addChangeListener: (f: () => void) => listeners.add(f), removeChangeListener: (f: () => void) => listeners.delete(f), ...extra });
  const modules = (_m: any, e: any) => {
    e.A = { dispatch: (a: any) => void calls.push(['dispatch', a.type, a.streamKey]), subscribe() {}, unsubscribe() {}, isDispatching: () => false, _subscriptions: {}, addInterceptor: (fn: any) => void (interceptor = fn) };
    e.B = store('UserStore', { getCurrentUser: () => ({ id: ME, username: 'me' }), getUser: (id: string) => ({ id, username: `u${id.slice(-1)}` }) });
    e.C = store('ChannelStore', { getChannel: (id: string) => channels[id] ?? null });
    e.D = store('GuildStore', { getGuilds: () => ({}), getGuild: () => null });
    e.G = store('VoiceStateStore', { getVoiceStatesForChannel: (c: string) => Object.fromEntries(Object.entries(voice).filter(([, v]) => v.channelId === c)), getAllVoiceStates: () => ({ [GUILD]: voice }) });
    e.H = store('SpeakingStore', { isSpeaking: () => false });
    e.I = store('MediaEngineStore', {
      isEnabled: () => media.enabled,
      isSelfMute: () => media.muted,
      isSelfDeaf: () => false,
      isVideoEnabled: () => media.video,
      getMode: () => 'VOICE_ACTIVITY',
      getMediaEngine: () => ({ eachConnection: (cb: (c: any) => void) => conns.forEach(cb) }),
    });
    // The audio settings: unmuting a client whose audio is off enables it instead, which asks for the microphone.
    e.J = {
      toggleSelfMute() {
        calls.push(['toggleSelfMute']);
        media.muted = !media.muted;
      },
      toggleSelfDeaf() {},
      setSelfMute: (_ctx: string, on: boolean) => (calls.push(['setSelfMute', on]), (media.muted = on)),
      enable: (unmute: boolean) =>
        holder.nav.mediaDevices.getUserMedia({ audio: { deviceId: 'default' } }).then((s: any) => {
          calls.push(['enabled', s.getAudioTracks()[0]?.id]);
          media.enabled = true;
          if (unmute) media.muted = false;
        }),
      setVideoEnabled: (on: boolean) => (calls.push(['setVideoEnabled', on]), (media.video = on)),
    };
    e.K = { selectVoiceChannel: (c: string) => (calls.push(['select', c]), interceptor?.({ type: 'VOICE_SERVER_UPDATE', guildId: GUILD, endpoint: 'c-1.discord.media', token: 'vt' })), disconnect() {} };
    e.L = store('SelectedChannelStore', { getVoiceChannelId: () => voice[ME]?.channelId ?? null, getChannelId: () => null });
    e.M = store('AuthenticationStore', { getSessionId: () => 'session' });
    e.N = store('ApplicationStreamingStore', { getCurrentUserActiveStream: () => null });
    // The streaming actions and the web Go Live start, found by what their code says.
    e.O = {
      // Their code is what finds them (Bun's transpiler drops comments, so the words are strings here).
      a: function watch(key: any, opts: any) {
        if (key === 'type:"STREAM_WATCH" allowMultiple') return;
        calls.push(['watch', key, opts]);
      },
      b: function stop(key: string) {
        if (key === 'type:"STREAM_STOP"') return;
        calls.push(['stopStream', key]);
      },
    };
    e.P = {
      A: function start(guildId: string, channelId: string) {
        if (guildId === 'PRESET_CUSTOM getDesktopSource(') return;
        calls.push(['goLive', guildId, channelId]);
      },
    };
    e.Q = {
      t: function transitionTo(path: string) {
        if (path === 'transitionTo - Transitioning to') return;
        calls.push(['open', path]);
      },
    };
  };
  const changed = () => [...listeners].forEach((f) => f());
  return { calls, voice, media, conns, holder, modules, changed };
}

function page(c: ReturnType<typeof client>) {
  const posted: any[] = [];
  const timers: (() => void)[] = [];
  const events = new EventTarget();
  events.addEventListener(UP, (e: any) => {
    if (e.detail === null || e.detail === undefined) events.dispatchEvent(new CustomEvent(DOWN, { detail: null }));
    else posted.push(e.detail);
  });
  const win: any = {
    addEventListener: (type: string, fn: (e: any) => void) => events.addEventListener(type, fn),
    dispatchEvent: (e: Event) => events.dispatchEvent(e),
    down: (payload: any) => events.dispatchEvent(new CustomEvent(DOWN, { detail: payload })),
  };
  const doc: any = { readyState: 'complete', addEventListener() {}, querySelector: () => null, body: { innerText: '' } };
  const loc = { origin: 'https://discord.com', href: 'https://discord.com/app', pathname: '/app', reload() {} };
  // The page's own wrapper over the prototype's getUserMedia, holding the original it took at load: the browser has no
  // microphone, so the original finds none.
  const proto = { getUserMedia: (_cs?: unknown) => Promise.reject(new Error('NotFoundError: Requested device not found')), getDisplayMedia: () => Promise.reject(new Error('no screen')), enumerateDevices: () => Promise.resolve([]) };
  const mediaDevices = Object.create(proto);
  const original = proto.getUserMedia;
  mediaDevices.getUserMedia = (cs: unknown) => original(cs);
  const nav = { webdriver: false, mediaDevices };
  c.holder.nav = nav;
  new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', HOOK)(win, doc, loc, nav, { getItem: () => null, setItem() {} }, (fn: () => void) => timers.push(fn), () => 0);
  const cache: Record<string, { exports: any }> = {};
  const T: any = (id: string) => cache[id]!.exports;
  T.c = cache;
  (win.webpackChunkdiscord_app = win.webpackChunkdiscord_app || []).push = function (chunkData: any) {
    const [, mods, run] = chunkData;
    for (const id in mods) {
      const m = (cache[id] = { exports: {} });
      mods[id](m, m.exports, T);
    }
    if (run) run(T);
  };
  win.webpackChunkdiscord_app.push([['700'], { client: c.modules }]);
  const tick = () => {
    for (let i = 0; i < 5 && timers.length; i++) timers.splice(0).forEach((fn) => fn());
  };
  tick();
  let n = 0;
  const settle = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    tick();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    tick();
  };
  const cmd = async (command: unknown) => {
    const id = `c${n++}`;
    win.down({ t: 'cmd', id, cmd: command });
    await settle();
    return posted.find((m) => m.t === 'reply' && m.id === id);
  };
  const state = () => posted.filter((m) => m.t === 'call' && m.state).at(-1)?.state;
  return { posted, cmd, tick, settle, state, mediaDevices };
}

/** A bridge call with the device's offer answered; returns the bridge's own peer connection. */
async function bridgeCall(c: ReturnType<typeof client>, p: ReturnType<typeof page>) {
  c.voice[ME] = { userId: ME, channelId: VOICE };
  expect((await p.cmd({ kind: 'call', call: 'b1', op: 'join', channelId: VOICE, mode: 'bridge' })).ok).toBe(true);
  expect((await p.cmd({ kind: 'call', call: 'b1', op: 'signal', data: { type: 'offer', sdp: 'v=0' } })).ok).toBe(true);
  return FakePC.made.at(-1)!;
}

describe("hook.js's bridge video", () => {
  test("a client that never enabled audio enables it when the call starts, gets the device's microphone through the page's own wrapper, and is unmuted", async () => {
    Object.assign(globalThis, GLOBALS);
    const c = client({ enabled: false, muted: true });
    const p = page(c);
    const wrapper = p.mediaDevices.getUserMedia;
    await bridgeCall(c, p);
    expect(c.calls.find((x) => x[0] === 'enabled')).toEqual(['enabled', 'device-mic']);
    expect(c.media).toMatchObject({ enabled: true, muted: false });
    // Enabled before the client joins, so it joins unmuted.
    expect(c.calls.findIndex((x) => x[0] === 'enabled')).toBeLessThan(c.calls.findIndex((x) => x[0] === 'select'));
    // The device's microphone, from either getUserMedia, while the call lasts; the page's own wrapper is back after.
    expect((await p.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0].id).toBe('device-mic');
    await p.cmd({ kind: 'call', call: 'b1', op: 'leave' });
    expect(p.mediaDevices.getUserMedia).toBe(wrapper);
  });

  test('a muted client is unmuted at the start, as the device asks; one the device asks muted stays muted', async () => {
    Object.assign(globalThis, GLOBALS);
    const c = client({ muted: true });
    const p = page(c);
    await bridgeCall(c, p);
    expect(c.media.muted).toBe(false);
    p.tick();
    expect(p.state().self).toMatchObject({ muted: false, deafened: false });
    await p.cmd({ kind: 'call', call: 'b1', op: 'leave' });
    const d = client({ muted: true });
    const q = page(d);
    d.voice[ME] = { userId: ME, channelId: VOICE };
    await q.cmd({ kind: 'call', call: 'b2', op: 'join', channelId: VOICE, mode: 'bridge', muted: true });
    expect(d.calls.some((x) => x[0] === 'toggleSelfMute')).toBe(false);
  });

  test("the device's camera and screen become the client's camera and Go Live, and stop with it", async () => {
    Object.assign(globalThis, GLOBALS);
    const c = client();
    const p = page(c);
    await bridgeCall(c, p);
    // An audio call: the call view stays closed.
    p.tick();
    expect(c.calls.some((x) => x[0] === 'open')).toBe(false);
    expect((await p.cmd({ kind: 'call', call: 'b1', op: 'video', camera: true, screen: false })).ok).toBe(true);
    expect(c.calls.filter((x) => x[0] === 'setVideoEnabled')).toEqual([['setVideoEnabled', true]]);
    // The client asks for a camera: it gets the device's, as it came up the bridge.
    expect((await p.mediaDevices.getUserMedia({ video: { deviceId: 'default' } })).getVideoTracks()[0].id).toBe('camera-from-device-clone');
    expect((await p.mediaDevices.enumerateDevices()).map((d: any) => d.kind)).toEqual(['audioinput', 'videoinput']);
    expect((await p.cmd({ kind: 'call', call: 'b1', op: 'video', camera: true, screen: true })).ok).toBe(true);
    expect(c.calls).toContainEqual(['goLive', GUILD, VOICE]);
    expect((await p.mediaDevices.getDisplayMedia({ video: true })).getVideoTracks()[0].id).toBe('screen-from-device-clone');
    expect((await p.cmd({ kind: 'call', call: 'b1', op: 'video', camera: false, screen: false })).ok).toBe(true);
    expect(c.calls).toContainEqual(['setVideoEnabled', false]);
    expect(c.calls).toContainEqual(['stopStream', `guild:${GUILD}:${VOICE}:${ME}`]);
  });

  test("others' cameras and the streams the device watches go on the bridge's slots, streams first; the state says whose is where", async () => {
    Object.assign(globalThis, GLOBALS);
    const c = client();
    const p = page(c);
    c.voice[ANA] = { userId: ANA, channelId: VOICE, selfVideo: true, selfStream: true };
    c.voice[BEN] = { userId: BEN, channelId: VOICE, selfVideo: true };
    const bridge = await bridgeCall(c, p);
    // The client's own connections: its call (default) and Ana's Go Live (stream). The hook taps them.
    const call = new FakePC();
    const stream = new FakePC();
    c.conns.push({ context: 'default', pc: call, connectionState: 'CONNECTED' }, { context: 'stream', pc: stream, streamUserId: ANA });
    await call.setRemoteDescription({ type: 'answer' });
    await stream.setRemoteDescription({ type: 'answer' });
    const anaCam = vtrack('ana-cam');
    const benCam = vtrack('ben-cam');
    const anaScreen = vtrack('ana-screen');
    call.track(anaCam, `${ANA}-1111`);
    call.track(benCam, `${BEN}-2222`);
    await p.settle();
    let st = p.state();
    // Someone has a camera on: the client's call view opens, which asks the voice server for their video.
    expect(c.calls).toContainEqual(['open', `/channels/${GUILD}/${VOICE}`]);
    expect(st.self).toMatchObject({ connected: true, muted: false });
    expect(st.video).toEqual([
      { slot: '4', who: ANA, source: 'camera' },
      { slot: '5', who: BEN, source: 'camera' },
    ]);
    expect(bridge.transceivers[4].sender.track).toBe(anaCam);
    expect(bridge.transceivers[4].direction).toBe('sendonly');
    // Watching Ana's Go Live: the client's own viewer, and her screen on a slot of its own.
    expect((await p.cmd({ kind: 'call', call: 'b1', op: 'watch', user: ANA, on: true })).ok).toBe(true);
    expect(c.calls).toContainEqual(['watch', { streamType: 'guild', guildId: GUILD, channelId: VOICE, ownerId: ANA }, { forceMultiple: false, noFocus: true }]);
    stream.track(anaScreen, `${ANA}-3333`);
    await p.settle();
    st = p.state();
    expect(st.self.watching).toEqual([ANA]);
    expect(st.video).toContainEqual({ slot: '6', who: ANA, source: 'stream' });
    expect(bridge.transceivers[6].sender.track).toBe(anaScreen);
    // Ben turns his camera off: his slot empties.
    c.voice[BEN] = { userId: BEN, channelId: VOICE };
    c.changed();
    await p.settle();
    expect(p.state().video.map((v: any) => `${v.who}:${v.source}`).sort()).toEqual([`${ANA}:camera`, `${ANA}:stream`]);
    expect(bridge.transceivers[5].sender.track).toBe(null);
    // Unwatching: the client's own stop.
    await p.cmd({ kind: 'call', call: 'b1', op: 'watch', user: ANA, on: false });
    expect(c.calls).toContainEqual(['stopStream', `guild:${GUILD}:${VOICE}:${ANA}`]);
    await p.cmd({ kind: 'call', call: 'b1', op: 'leave' });
  });

  test('direct mode: no video, and a client whose audio is off gets its gateway mute set without enabling anything', async () => {
    Object.assign(globalThis, GLOBALS);
    const c = client({ enabled: false, muted: true });
    const p = page(c);
    c.voice[ME] = { userId: ME, channelId: VOICE };
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'join', channelId: VOICE, mode: 'direct' })).ok).toBe(true);
    expect(c.calls.some((x) => x[0] === 'enabled')).toBe(false);
    expect(c.calls).toContainEqual(['setSelfMute', false]);
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'video', camera: true, screen: false })).error).toMatch(/bridge mode/);
  });
});
