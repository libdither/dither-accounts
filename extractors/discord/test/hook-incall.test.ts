/**
 * hook.js's "in a call" section against a small replica of the client (the harness is hook-moderation.test.ts's, with
 * timers the test runs itself): what the call's participants carry (Go Live, server mutes, your volume for them, their
 * place on a stage), one person's volume and mute through the client's own audio actions and in the bridge's mix, the
 * microphone's handling, stage actions as the client's stage module sends them, the soundboard, effects others send,
 * and moderating someone in voice. Web Audio and WebRTC are stand-ins: nothing here plays or connects.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerName, stampMarkers } from '@dither-accounts/browser/markers';

const KEY = 'discord-hook-incall-test-key';
const UP = markerName(KEY, 'up');
const DOWN = markerName(KEY, 'down');
const HOOK = stampMarkers(readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8'), KEY);

const ME = '100000000000000001';
const ANA = '100000000000000004';
const BEN = '100000000000000005';
const GUILD = '200000000000000001';
const VOICE = '300000000000000201';
const VOICE2 = '300000000000000202';
const STAGE = '300000000000000203';
const TEXT = '300000000000000200';
const OTHER_GUILD_VOICE = '300000000000000301';
const MUTE = 1n << 22n;
const DEAFEN = 1n << 23n;
const MOVE = 1n << 24n;
const SOUNDBOARD = 1n << 42n;

// ------------------------------------------------------------------ Web Audio and WebRTC stand-ins (bridge mode)

class Node {
  outs: unknown[] = [];
  connect(n: unknown) {
    this.outs.push(n);
  }
  disconnect() {
    this.outs = [];
  }
}
class GainNode extends Node {
  gain = { value: 1 };
}
const made: { gains: GainNode[]; audio: any[] } = { gains: [], audio: [] };
class FakeAudioContext {
  state = 'running';
  createMediaStreamDestination() {
    return Object.assign(new Node(), { stream: { getAudioTracks: () => [{ clone: () => ({}) }] } });
  }
  createAnalyser() {
    return Object.assign(new Node(), { fftSize: 32, getFloatTimeDomainData() {} });
  }
  createMediaStreamSource() {
    return new Node();
  }
  createMediaElementSource() {
    return new Node();
  }
  createGain() {
    const g = new GainNode();
    made.gains.push(g);
    return g;
  }
  close() {}
}
class FakeAudio {
  muted = false;
  srcObject: unknown = null;
  src = '';
  crossOrigin: string | null = null;
  constructor() {
    made.audio.push(this);
  }
  play() {
    return Promise.resolve();
  }
  addEventListener() {}
}
class FakeMediaStream {
  constructor(private tracks: unknown[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}
const track = (id: string) => ({ id, kind: 'audio', addEventListener() {} });
class FakePC {
  static receivers: { track: unknown }[] = [];
  getReceivers() {
    return FakePC.receivers;
  }
  addEventListener() {}
  setRemoteDescription() {
    return Promise.resolve();
  }
}
const GLOBALS = { AudioContext: FakeAudioContext, Audio: FakeAudio, MediaStream: FakeMediaStream, RTCPeerConnection: FakePC };
afterEach(() => {
  for (const k of Object.keys(GLOBALS)) delete (globalThis as any)[k];
  made.gains.length = 0;
  made.audio.length = 0;
});

// ------------------------------------------------------------------ the client

function client(opts: { grants?: bigint[]; perChannel?: Record<string, bigint[]> } = {}) {
  const grants = opts.grants ?? [MUTE, DEAFEN, MOVE, SOUNDBOARD];
  const handlers = new Map<string, ((a: any) => void)[]>();
  const calls: any[] = [];
  let interceptor: ((a: any) => boolean) | null = null;
  const guild = { id: GUILD, name: 'Test', ownerId: BEN };
  const channels: Record<string, any> = {
    [TEXT]: { id: TEXT, type: 0, guild_id: GUILD, name: 'general' },
    [VOICE]: { id: VOICE, type: 2, guild_id: GUILD, name: 'Voice' },
    [VOICE2]: { id: VOICE2, type: 2, guild_id: GUILD, name: 'Voice 2' },
    [STAGE]: { id: STAGE, type: 13, guild_id: GUILD, name: 'Town hall' },
    [OTHER_GUILD_VOICE]: { id: OTHER_GUILD_VOICE, type: 2, guild_id: '200000000000000009', name: 'Elsewhere' },
  };
  const voice: Record<string, Record<string, any>> = {};
  const volumes: Record<string, number> = { [ANA]: 50 };
  const localMutes = new Set<string>();
  const settings = { ns: true, nc: false, mode: 'VOICE_ACTIVITY' };
  const listeners = new Set<() => void>();
  const outputs: Record<string, { stream: FakeMediaStream }> = {};
  const sounds = new Map<string, any[]>([
    [GUILD, [{ soundId: '7001', name: 'Rimshot', guildId: GUILD, emojiName: '🥁', available: true }]],
    ['0', [{ soundId: '1', name: 'quack', guildId: '0', emojiName: '🦆' }, { soundId: '2', name: 'locked', guildId: '0', available: false }]],
  ]);
  const dispatcher = {
    dispatch() {},
    subscribe: (ev: string, fn: (a: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    unsubscribe() {},
    isDispatching: () => false,
    _subscriptions: {},
    addInterceptor: (fn: (a: any) => boolean) => void (interceptor = fn),
  };
  const store = (name: string, extra: Record<string, unknown>) => ({ getName: () => name, emitChange() {}, addChangeListener: (f: () => void) => listeners.add(f), removeChangeListener: (f: () => void) => listeners.delete(f), ...extra });
  const rest: Record<string, any> = {};
  for (const k of ['get', 'post', 'put', 'patch', 'del']) rest[k] = async (o: any) => (calls.push(['rest', k, o.url, o.body ?? o.query]), { body: {} });
  const audioActions = {
    toggleSelfMute() {},
    toggleSelfDeaf() {},
    setLocalVolume: (u: string, v: number) => (calls.push(['setLocalVolume', u, v]), (volumes[u] = v)),
    toggleLocalMute: (u: string) => (calls.push(['toggleLocalMute', u]), localMutes.has(u) ? localMutes.delete(u) : localMutes.add(u)),
    setMode: (mode: string, o: any) => void calls.push(['setMode', mode, o]),
    setNoiseSuppression: (on: boolean) => (calls.push(['setNoiseSuppression', on]), (settings.ns = on)),
    setNoiseCancellation: (on: boolean) => (calls.push(['setNoiseCancellation', on]), (settings.nc = on)),
  };
  const modules = (_m: any, e: any) => {
    e.A = dispatcher;
    e.B = store('UserStore', { getCurrentUser: () => ({ id: ME, username: 'me' }), getUser: (id: string) => ({ id, username: `u${id.slice(-1)}` }) });
    e.C = store('ChannelStore', { getChannel: (id: string) => channels[id] ?? null });
    e.D = store('GuildStore', { getGuilds: () => ({ [GUILD]: guild }), getGuild: (id: string) => (id === GUILD ? guild : null) });
    e.E = store('PermissionStore', { can: (bit: bigint, subject: any) => !!subject && (opts.perChannel?.[subject.id] ?? grants).includes(bit), canManageUser: () => true, getHighestRole: () => null });
    e.F = rest;
    e.G = store('VoiceStateStore', {
      getVoiceStatesForChannel: (c: string) => Object.fromEntries(Object.entries(voice).filter(([, v]) => v.channelId === c)),
      getAllVoiceStates: () => ({ [GUILD]: voice }),
    });
    e.H = store('SpeakingStore', { isSpeaking: (id: string) => id === ANA });
    e.I = store('MediaEngineStore', {
      getLocalVolume: (id: string) => volumes[id] ?? 100,
      isLocalMute: (id: string) => localMutes.has(id),
      isSelfMute: () => false,
      isSelfDeaf: () => false,
      getMode: () => settings.mode,
      getNoiseSuppression: () => settings.ns,
      getNoiseCancellation: () => settings.nc,
      getMediaEngine: () => ({ eachConnection: (cb: (c: any) => void) => cb({ conn: { outputs } }) }),
    });
    e.J = audioActions;
    e.K = { selectVoiceChannel: (c: string) => (calls.push(['select', c]), interceptor?.({ type: 'VOICE_SERVER_UPDATE', guildId: GUILD, endpoint: 'c-1.discord.media', token: 'vt' })), disconnect() {} };
    e.L = store('SelectedChannelStore', { getVoiceChannelId: () => voice[ME]?.channelId ?? null });
    e.M = store('AuthenticationStore', { getSessionId: () => 'session' });
    e.N = store('StageInstanceStore', { getStageInstanceByChannel: (c: string) => (c === STAGE ? { topic: 'Weekly town hall' } : null) });
    e.O = store('SoundboardStore', { getSounds: () => sounds, getSound: (g: string, id: string) => (sounds.get(g) ?? []).find((x) => x.soundId === id), getSoundById: (id: string) => [...sounds.values()].flat().find((x) => x.soundId === id) });
    e.P = {
      leaveGuild() {},
      updateMemberRoles() {},
      setServerMute: (g: string, u: string, on: boolean) => (calls.push(['setServerMute', g, u, on]), Promise.resolve()),
      setServerDeaf: (g: string, u: string, on: boolean) => (calls.push(['setServerDeaf', g, u, on]), Promise.resolve()),
    };
  };
  const emit = (ev: string, a: any) => (handlers.get(ev) ?? []).forEach((fn) => fn(a));
  const changed = () => [...listeners].forEach((f) => f());
  return { calls, voice, volumes, localMutes, outputs, modules, emit, changed };
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
  const mediaDevices = Object.create({ getUserMedia: () => Promise.resolve(null), enumerateDevices: () => Promise.resolve([]) });
  new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', HOOK)(win, doc, loc, { webdriver: false, mediaDevices }, { getItem: () => null, setItem() {} }, (fn: () => void) => timers.push(fn), () => 0);
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
  /** Run the timers due, as many rounds as they schedule more (a bounded number). */
  const tick = () => {
    for (let i = 0; i < 5 && timers.length; i++) timers.splice(0).forEach((fn) => fn());
  };
  tick();
  let n = 0;
  const cmd = async (command: unknown) => {
    const id = `c${n++}`;
    win.down({ t: 'cmd', id, cmd: command });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    tick();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    return posted.find((m) => m.t === 'reply' && m.id === id);
  };
  const state = () => posted.filter((m) => m.t === 'call' && m.state).at(-1)?.state;
  return { posted, cmd, tick, state };
}

describe("hook.js's in-call section", () => {
  test('finds the modules; the call says Go Live, server mutes, your volume and mute for each person', async () => {
    const c = client();
    const p = page(c);
    expect(p.posted.filter((m) => m.t === 'finders').pop()?.results).toMatchObject({ LocalVolume: true, InputSettings: true, StageInstanceStore: true, SoundboardStore: true });
    c.voice[ME] = { userId: ME, channelId: VOICE };
    c.voice[ANA] = { userId: ANA, channelId: VOICE, selfStream: true, selfVideo: true, mute: true };
    c.voice[BEN] = { userId: BEN, channelId: VOICE, deaf: true };
    c.localMutes.add(BEN);
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'join', channelId: VOICE, mode: 'direct' })).ok).toBe(true);
    p.tick();
    const st = p.state();
    expect(st.stage).toBeUndefined();
    const by = Object.fromEntries(st.participants.map((x: any) => [x.id, x]));
    expect(by[ME]).toEqual({ id: ME, muted: false, deafened: false, speaking: false, video: false });
    expect(by[ANA]).toEqual({ id: ANA, muted: true, deafened: false, speaking: true, video: true, streaming: true, serverMuted: true, volume: 50 });
    expect(by[BEN]).toEqual({ id: BEN, muted: false, deafened: true, speaking: false, video: false, serverDeafened: true, localMute: true });
  });

  test("one person's volume and mute go through the client's own audio actions; never yourself", async () => {
    const c = client();
    const p = page(c);
    c.voice[ME] = { userId: ME, channelId: VOICE };
    await p.cmd({ kind: 'call', call: 'd1', op: 'join', channelId: VOICE, mode: 'direct' });
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'local', user: ANA, volume: 250 })).ok).toBe(true);
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'local', user: ANA, muted: true })).ok).toBe(true);
    // Already muted: the toggle is not pressed again.
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'local', user: ANA, muted: true })).ok).toBe(true);
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'local', user: ME, volume: 10 })).error).toMatch(/That is you/);
    // Another call's command is stale.
    expect((await p.cmd({ kind: 'call', call: 'old', op: 'local', user: ANA, volume: 10 })).result).toEqual({ stale: true });
    expect(c.calls.filter((x) => x[0] !== 'select')).toEqual([
      ['setLocalVolume', ANA, 200],
      ['toggleLocalMute', ANA],
    ]);
  });

  test("the microphone's handling: the client's noise suppression (its Krisp off too) and sensitivity", async () => {
    const c = client();
    const p = page(c);
    await p.cmd({ kind: 'call', call: 'd1', op: 'join', channelId: VOICE, mode: 'direct' });
    await p.cmd({ kind: 'call', call: 'd1', op: 'local', user: ANA, volume: 100 });
    c.calls.length = 0;
    await p.cmd({ kind: 'call', call: 'd1', op: 'input', input: { noiseSuppression: true, sensitivity: -42 } });
    expect(c.calls).toEqual([['setMode', 'VOICE_ACTIVITY', { autoThreshold: false, threshold: -42 }]]);
    c.calls.length = 0;
    await p.cmd({ kind: 'call', call: 'd1', op: 'input', input: { noiseSuppression: false, sensitivity: 'auto' } });
    expect(c.calls).toEqual([
      ['setNoiseSuppression', false],
      ['setMode', 'VOICE_ACTIVITY', { autoThreshold: true }],
    ]);
  });

  test("a stage: roles, topic and moderator in the state; hands, speaking and the audience as the client's stage module sends them", async () => {
    const c = client({ perChannel: { [STAGE]: [SOUNDBOARD] } });
    const p = page(c);
    c.voice[ME] = { userId: ME, channelId: STAGE, suppress: true };
    c.voice[ANA] = { userId: ANA, channelId: STAGE, suppress: false };
    c.voice[BEN] = { userId: BEN, channelId: STAGE, suppress: true, requestToSpeakTimestamp: '2026-11-12T10:00:00.000Z' };
    await p.cmd({ kind: 'call', call: 's1', op: 'join', channelId: STAGE, mode: 'direct' });
    p.tick();
    let st = p.state();
    expect(st.stage).toEqual({ topic: 'Weekly town hall', moderator: false });
    expect(Object.fromEntries(st.participants.map((x: any) => [x.id, x.stage]))).toEqual({ [ME]: 'audience', [ANA]: 'speaker', [BEN]: 'hand' });
    c.calls.length = 0;
    expect((await p.cmd({ kind: 'call', call: 's1', op: 'stage', action: 'raiseHand' })).ok).toBe(true);
    expect((await p.cmd({ kind: 'call', call: 's1', op: 'stage', action: 'speak' })).error).toMatch(/Raise your hand/);
    expect((await p.cmd({ kind: 'call', call: 's1', op: 'stage', action: 'invite', user: BEN })).error).toMatch(/stage moderator/);
    // Invited by a moderator: speaking is now yours to take.
    c.voice[ME] = { userId: ME, channelId: STAGE, suppress: false, requestToSpeakTimestamp: '2026-11-12T10:01:00.000Z' };
    c.changed();
    p.tick();
    st = p.state();
    expect(st.participants.find((x: any) => x.id === ME).stage).toBe('invited');
    expect((await p.cmd({ kind: 'call', call: 's1', op: 'stage', action: 'speak' })).ok).toBe(true);
    expect((await p.cmd({ kind: 'call', call: 's1', op: 'stage', action: 'listen' })).ok).toBe(true);
    expect((await p.cmd({ kind: 'call', call: 's1', op: 'stage', action: 'lowerHand' })).ok).toBe(true);
    const at = `/guilds/${GUILD}/voice-states/@me`;
    expect(c.calls).toEqual([
      ['rest', 'patch', at, { request_to_speak_timestamp: expect.stringMatching(/^\d{4}-/), channel_id: STAGE }],
      ['rest', 'patch', at, { suppress: false, request_to_speak_timestamp: null, channel_id: STAGE }],
      ['rest', 'patch', at, { suppress: true, channel_id: STAGE, self_video: false, self_stream: false }],
      ['rest', 'patch', at, { request_to_speak_timestamp: null, channel_id: STAGE }],
    ]);
  });

  test("a stage moderator invites someone to speak and moves them back; a voice channel is no stage", async () => {
    const c = client();
    const p = page(c);
    c.voice[ME] = { userId: ME, channelId: STAGE, suppress: false };
    await p.cmd({ kind: 'call', call: 's1', op: 'join', channelId: STAGE, mode: 'direct' });
    p.tick();
    expect(p.state().stage.moderator).toBe(true);
    c.calls.length = 0;
    await p.cmd({ kind: 'call', call: 's1', op: 'stage', action: 'invite', user: BEN });
    await p.cmd({ kind: 'call', call: 's1', op: 'stage', action: 'audience', user: ANA });
    expect(c.calls).toEqual([
      ['rest', 'patch', `/guilds/${GUILD}/voice-states/${BEN}`, { suppress: false, request_to_speak_timestamp: expect.stringMatching(/^\d{4}-/), channel_id: STAGE }],
      ['rest', 'patch', `/guilds/${GUILD}/voice-states/${ANA}`, { suppress: true, channel_id: STAGE, self_video: false, self_stream: false }],
    ]);
    const q = page(client());
    await q.cmd({ kind: 'call', call: 'v1', op: 'join', channelId: VOICE, mode: 'direct' });
    expect((await q.cmd({ kind: 'call', call: 'v1', op: 'stage', action: 'raiseHand' })).error).toMatch(/not on a stage/);
  });

  test("the soundboard: this server's sounds and Discord's, played as the client sends them; others' sounds and emoji reach the device", async () => {
    const c = client();
    const p = page(c);
    c.voice[ME] = { userId: ME, channelId: VOICE };
    await p.cmd({ kind: 'call', call: 'd1', op: 'join', channelId: VOICE, mode: 'direct' });
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'sounds' })).result).toEqual({
      sounds: [
        { id: '7001', name: 'Rimshot', guild: GUILD, emoji: '🥁' },
        { id: '1', name: 'quack', guild: '0', emoji: '🦆' },
      ],
    });
    c.calls.length = 0;
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'sound', sound: '1', guild: '0' })).ok).toBe(true);
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'sound', sound: '7001', guild: GUILD })).ok).toBe(true);
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'sound', sound: '9', guild: '0' })).error).toMatch(/No such sound/);
    expect((await p.cmd({ kind: 'call', call: 'd1', op: 'sound', sound: '5', guild: '999' })).error).toMatch(/this server's sounds/);
    expect(c.calls).toEqual([
      ['rest', 'post', `/channels/${VOICE}/send-soundboard-sound`, { sound_id: '1', emoji_id: null, emoji_name: '🦆' }],
      ['rest', 'post', `/channels/${VOICE}/send-soundboard-sound`, { sound_id: '7001', emoji_id: null, emoji_name: '🥁', source_guild_id: GUILD }],
    ]);
    c.emit('VOICE_CHANNEL_EFFECT_SEND', { channelId: VOICE, userId: ANA, emoji: { name: '🎉' } });
    c.emit('VOICE_CHANNEL_EFFECT_SEND', { channelId: VOICE, userId: BEN, soundId: '1', soundVolume: 0.5, emoji: { name: '🦆' } });
    c.emit('VOICE_CHANNEL_EFFECT_SEND', { channelId: VOICE2, userId: BEN, emoji: { name: '👀' } });
    expect(p.posted.filter((m) => m.t === 'call' && m.effect).map((m) => m.effect)).toEqual([
      { who: ANA, emoji: '🎉' },
      { who: BEN, emoji: '🦆', sound: { id: '1', name: 'quack' } },
    ]);
    const q = page(client({ grants: [] }));
    await q.cmd({ kind: 'call', call: 'd2', op: 'join', channelId: VOICE, mode: 'direct' });
    expect((await q.cmd({ kind: 'call', call: 'd2', op: 'sounds' })).result).toEqual({ sounds: [], reason: 'You need the Use Soundboard permission here.' });
  });

  test("bridge mode: each tapped track gets the client's volume and mute for its owner; a sound plays into the mix", async () => {
    Object.assign(globalThis, GLOBALS);
    const c = client();
    const p = page(c);
    const a = track('a');
    const b = track('b');
    c.outputs[ANA] = { stream: new FakeMediaStream([a]) };
    FakePC.receivers = [{ track: a }, { track: b }];
    c.voice[ME] = { userId: ME, channelId: VOICE };
    expect((await p.cmd({ kind: 'call', call: 'b1', op: 'join', channelId: VOICE, mode: 'bridge' })).ok).toBe(true);
    // The client's own connection gets its answer: the hook taps it.
    await new (globalThis as any).RTCPeerConnection().setRemoteDescription({});
    const [ga, gb] = made.gains;
    expect(ga!.gain.value).toBe(0.5); // Ana at 50
    expect(gb!.gain.value).toBe(1); // nobody the client names: as it is
    await p.cmd({ kind: 'call', call: 'b1', op: 'local', user: ANA, muted: true });
    expect(ga!.gain.value).toBe(0);
    await p.cmd({ kind: 'call', call: 'b1', op: 'local', user: ANA, muted: false, volume: 150 });
    expect(ga!.gain.value).toBe(1.5);
    c.emit('VOICE_CHANNEL_EFFECT_SEND', { channelId: VOICE, userId: BEN, soundId: '7001', soundVolume: 0.25 });
    const el = made.audio.find((x) => x.src);
    expect(el.src).toBe('https://cdn.discordapp.com/soundboard-sounds/7001');
    expect(made.gains.at(-1)!.gain.value).toBe(0.25);
    await p.cmd({ kind: 'call', call: 'b1', op: 'leave' });
  });

  test('moderating someone in voice: the permission in the channel they are in, the client’s own server mute and deafen, a move or disconnect by the request it sends', async () => {
    const c = client({ perChannel: { [VOICE]: [MUTE, MOVE], [VOICE2]: [MOVE] } });
    const p = page(c);
    c.voice[ANA] = { userId: ANA, channelId: VOICE };
    const mod = (op: string, extra: object = {}) => p.cmd({ kind: 'moderate', guildId: GUILD, userId: ANA, op, ...extra });
    expect((await mod('voiceMute', { on: true })).ok).toBe(true);
    expect((await mod('voiceDeafen', { on: true })).error).toMatch(/Deafen Members permission there/);
    expect((await mod('move', { channelId: VOICE2 })).ok).toBe(true);
    expect((await mod('move', { channelId: TEXT })).error).toMatch(/voice channel of this server/);
    expect((await mod('move', { channelId: OTHER_GUILD_VOICE })).error).toMatch(/voice channel of this server/);
    expect((await mod('disconnect')).ok).toBe(true);
    delete c.voice[ANA];
    expect((await mod('voiceMute', { on: false })).error).toMatch(/not in a voice channel/);
    expect(c.calls).toEqual([
      ['setServerMute', GUILD, ANA, true],
      ['rest', 'patch', `/guilds/${GUILD}/members/${ANA}`, { channel_id: VOICE2 }],
      ['rest', 'patch', `/guilds/${GUILD}/members/${ANA}`, { channel_id: null }],
    ]);
  });
});
