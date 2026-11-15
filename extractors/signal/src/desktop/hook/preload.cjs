/**
 * The calls hook, inside Signal Desktop (docs/signal.md "Calls through Signal Desktop"). main.cjs adds it to the
 * app's sessions, so it runs in Signal's own preload world: the same window.reduxActions and @signalapp/ringrtc the
 * app's buttons use. Only the main window (background.html) does anything.
 *
 * It talks to the extractor over one Unix socket (DITHER_HOOK_SOCKET), one JSON object per line:
 *   extractor → hook  {id, op, ...}              a request; answered {id, result} or {id, error}
 *   hook → extractor  {ev, ...}                  news: 'hello', 'app' (signed in, linking), 'call' (state, signal)
 *
 * What it does in a call, the bridge (dither-chat docs/calls.md "Video (bridge mode)"): it answers the device's WebRTC
 * offer with a peer connection of its own; the device's microphone plays into the sandbox's `mic_in` sink, whose
 * monitor is Signal's microphone (RingRTC records the default source); Signal's call audio plays into `call_out`, whose
 * monitor (the `call_mix` source) goes back to the device. The device's camera and screen are what Signal gets when it
 * asks getUserMedia for a camera or a desktop source; the frames Signal's own call view pulls from RingRTC for each
 * remote video are copied to a canvas each, which goes to the device on the bridge's video slots.
 *
 * Logs (to the extractor) carry states and counts, never a name, a number or what anyone says.
 */
'use strict';

if (/\/background\.html$/.test(location.pathname)) main();

function main() {
  const net = require('node:net');
  const SOCKET = process.env.DITHER_HOOK_SOCKET;
  const LAB = process.env.DITHER_HOOK_LAB === '1';
  const ASAR = process.env.DITHER_SIGNAL_ASAR;
  if (!SOCKET) return;

  // ---------------------------------------------------------------- the wire
  let sock = null;
  let buf = '';
  const send = (o) => {
    if (sock && !sock.destroyed) sock.write(`${JSON.stringify(o)}\n`);
  };
  const log = (level, msg, data) => send({ ev: 'log', level, msg, ...(data === undefined ? {} : { data }) });
  function connect() {
    sock = net.connect(SOCKET);
    sock.setEncoding('utf8');
    sock.on('connect', () => send({ ev: 'hello', lab: LAB, at: Date.now() }));
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) void onRequest(line);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      sock = null;
      setTimeout(connect, 1000);
    });
  }
  async function onRequest(line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    try {
      const fn = OPS[req.op];
      if (!fn) throw new Error(`unknown op ${req.op}`);
      const result = await fn(req);
      send({ id: req.id, result: result === undefined ? null : result });
    } catch (e) {
      send({ id: req.id, error: String((e && e.message) || e) });
    }
  }
  connect();


  // ---------------------------------------------------------------- the app
  let rtc = null;
  try {
    rtc = require(`${ASAR}/node_modules/@signalapp/ringrtc`);
  } catch (e) {
    log('warn', 'ringrtc not reachable', String(e));
  }
  const store = () => window.reduxStore;
  const actions = () => window.reduxActions;
  const state = () => (store() ? store().getState() : null);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms, what) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  function appState() {
    const s = state();
    if (!s) return { ready: false };
    const inst = s.installer || {};
    const user = s.user || {};
    const prov = inst.provisioningUrl;
    return {
      ready: true,
      step: inst.step || null,
      linkUrl: prov && typeof prov.value === 'string' ? prov.value : null,
      aci: user.ourAci || null,
      signedIn: !!user.ourAci,
    };
  }
  let lastApp = '';
  function tellApp() {
    const a = appState();
    const k = JSON.stringify(a);
    if (k === lastApp) return;
    lastApp = k;
    send({ ev: 'app', app: a });
    if (a.signedIn) void allowMedia();
  }
  setInterval(tellApp, 1000);

  /** Signal asks its own settings before it records or films; in this sandbox both are always ours to give. */
  let mediaAllowed = false;
  async function allowMedia() {
    if (mediaAllowed || !window.IPC) return;
    mediaAllowed = true;
    try {
      if (!(await window.IPC.getMediaPermissions())) await window.IPC.setMediaPermissions(true);
      if (!(await window.IPC.getMediaCameraPermissions())) await window.IPC.setMediaCameraPermissions(true);
    } catch (e) {
      mediaAllowed = false;
      log('warn', 'could not allow media', String(e));
    }
  }

  // ---------------------------------------------------------------- conversations
  /** A target ({peer: ACI} or {group: group id}) as Signal Desktop's conversation id. */
  function conversationOf(t) {
    const cc = window.ConversationController;
    if (!cc) throw new Error('Signal is not ready');
    if (t && t.peer) {
      const c = cc.lookupOrCreate({ serviceId: t.peer, reason: 'calls' });
      if (!c) throw new Error('Signal does not know this person');
      return c.id;
    }
    if (t && t.group) {
      const c = cc.get(t.group);
      if (!c) throw new Error('Signal Desktop does not have this group yet');
      return c.id;
    }
    throw new Error('no conversation');
  }
  /** Signal Desktop's conversation as a target. */
  function targetOf(id) {
    const c = state() && state().conversations.conversationLookup[id];
    if (!c) return null;
    if (c.type === 'group' && c.groupId) return { group: c.groupId };
    if (c.serviceId) return { peer: c.serviceId };
    return null;
  }

  // ---------------------------------------------------------------- the device's media, as Signal's camera and screen
  const BRIDGE = { audio: '0', camera: '1', screen: '2', screenAudio: '3', video: ['4', '5', '6', '7'] };
  /** What the device sends up the bridge. */
  const fromDevice = { mic: null, camera: null, screen: null, screenAudio: null };
  const md = MediaDevices.prototype;
  const gum = md.getUserMedia;
  const gdm = md.getDisplayMedia;
  const enumerate = md.enumerateDevices;
  const STAND_IN = { deviceId: 'dither-camera', groupId: 'dither', kind: 'videoinput', label: 'Camera' };
  md.enumerateDevices = async function () {
    const out = await enumerate.call(this);
    // A camera for Signal to choose: the device's, whenever it sends one.
    return out.some((d) => d.kind === 'videoinput') ? out : [...out, { ...STAND_IN, toJSON: () => STAND_IN }];
  };
  md.getUserMedia = async function (c) {
    const v = c && c.video;
    if (!v) return gum.call(this, c);
    const desktop = typeof v === 'object' && v.mandatory && v.mandatory.chromeMediaSource === 'desktop';
    const track = desktop ? fromDevice.screen : fromDevice.camera;
    if (!track || track.readyState === 'ended') throw new DOMException(desktop ? 'The device is not sharing a screen' : 'The device has no camera on', 'NotFoundError');
    return new MediaStream([track.clone()]);
  };
  md.getDisplayMedia = async function () {
    if (!fromDevice.screen) throw new DOMException('The device is not sharing a screen', 'NotAllowedError');
    return new MediaStream([fromDevice.screen.clone(), ...(fromDevice.screenAudio ? [fromDevice.screenAudio.clone()] : [])]);
  };
  void gdm;

  // ---------------------------------------------------------------- others' video, as Signal's call view pulls it
  /** key (`direct` or a group demux id) -> { canvas, ctx, track, at } */
  const remote = new Map();
  function frameTo(key, buffer, frame) {
    if (!frame || !bridge.pc) return;
    const [w, h] = frame;
    if (!(w > 2 && h > 2)) return;
    let r = remote.get(key);
    if (!r) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { alpha: false });
      r = { canvas, ctx, track: canvas.captureStream().getVideoTracks()[0], at: 0, frames: 0 };
      remote.set(key, r);
    }
    if (r.canvas.width !== w || r.canvas.height !== h) {
      r.canvas.width = w;
      r.canvas.height = h;
    }
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer || buffer);
    r.ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, w * h * 4), w, h), 0, 0);
    r.at = Date.now();
    r.frames++;
  }
  if (rtc) {
    const direct = rtc.Call.prototype.receiveVideoFrame;
    rtc.Call.prototype.receiveVideoFrame = function (buffer, maxW, maxH) {
      const f = direct.call(this, buffer, maxW, maxH);
      try {
        frameTo('direct', buffer, f);
      } catch (e) {}
      return f;
    };
    const source = rtc.GroupCall.prototype.getVideoSource;
    rtc.GroupCall.prototype.getVideoSource = function (demuxId) {
      const s = source.call(this, demuxId);
      const pull = s.receiveVideoFrame;
      s.receiveVideoFrame = function (buffer, maxW, maxH) {
        const f = pull.call(this, buffer, maxW, maxH);
        try {
          frameTo(String(demuxId), buffer, f);
        } catch (e) {}
        return f;
      };
      return s;
    };
  }

  // ---------------------------------------------------------------- the bridge to the device
  const bridge = { pc: null, ctx: null, mixTrack: null, micEl: null, slots: new Map() };
  async function deviceIdOf(kind, label) {
    const d = (await enumerate.call(navigator.mediaDevices)).find((x) => x.kind === kind && x.label === label);
    if (!d) throw new Error(`no ${kind} "${label}" in the sandbox`);
    return d.deviceId;
  }
  /** Signal's call audio: the `call_out` sink's monitor, as the sandbox shows it (source `call_mix`). */
  async function mixTrack() {
    if (bridge.mixTrack && bridge.mixTrack.readyState === 'live') return bridge.mixTrack;
    const id = await deviceIdOf('audioinput', 'CallMix');
    const s = await gum.call(navigator.mediaDevices, { audio: { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    bridge.mixTrack = s.getAudioTracks()[0];
    return bridge.mixTrack;
  }
  /** The device's microphone into the `mic_in` sink, whose monitor is Signal's microphone. */
  async function playMic(track) {
    if (bridge.micEl) bridge.micEl.srcObject = null;
    const el = new Audio();
    el.srcObject = new MediaStream([track]);
    await el.setSinkId(await deviceIdOf('audiooutput', 'DeviceMic'));
    await el.play();
    bridge.micEl = el;
  }
  function closeBridge() {
    if (bridge.pc) bridge.pc.close();
    bridge.pc = null;
    if (bridge.micEl) {
      bridge.micEl.pause();
      bridge.micEl.srcObject = null;
      bridge.micEl = null;
    }
    bridge.slots.clear();
    fromDevice.mic = fromDevice.camera = fromDevice.screen = fromDevice.screenAudio = null;
    for (const r of remote.values()) r.track.stop();
    remote.clear();
  }
  async function bridgeSignal(data) {
    if (!call) throw new Error('no call');
    if (data && data.type === 'offer' && data.sdp) {
      closeBridge();
      const pc = new RTCPeerConnection({ iceServers: data.iceServers || [] });
      bridge.pc = pc;
      pc.onicecandidate = (e) => send({ ev: 'call', call: call.id, signal: { candidate: e.candidate ? e.candidate.toJSON() : null } });
      pc.onconnectionstatechange = () => log('info', `bridge ${pc.connectionState}`);
      pc.ontrack = (e) => {
        const mid = e.transceiver && e.transceiver.mid;
        if (mid === BRIDGE.camera) fromDevice.camera = e.track;
        else if (mid === BRIDGE.screen) fromDevice.screen = e.track;
        else if (mid === BRIDGE.screenAudio) fromDevice.screenAudio = e.track;
        else if (e.track.kind === 'audio') {
          fromDevice.mic = e.track;
          playMic(e.track).catch((err) => log('warn', 'the device microphone does not play into the sandbox', String(err)));
        }
      };
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      const ts = pc.getTransceivers();
      const audio = ts.find((x) => x.mid === BRIDGE.audio);
      const mix = await mixTrack();
      if (audio) {
        audio.direction = 'sendrecv';
        await audio.sender.replaceTrack(mix);
      } else pc.addTrack(mix);
      for (const x of ts) {
        if (!BRIDGE.video.includes(x.mid)) continue;
        x.direction = 'sendonly';
        bridge.slots.set(x.mid, { sender: x.sender, key: null });
      }
      await pc.setLocalDescription(await pc.createAnswer());
      send({ ev: 'call', call: call.id, signal: { type: 'answer', sdp: pc.localDescription.sdp } });
      return { ok: true };
    }
    if (data && 'candidate' in data && bridge.pc) {
      if (data.candidate) await bridge.pc.addIceCandidate(data.candidate).catch(() => {});
      return { ok: true };
    }
    return { ignored: true };
  }

  // ---------------------------------------------------------------- the call
  /** The call the device is in: { id, conversationId, target, deafened, muted, joinedAt, ended } */
  let call = null;
  const SPEAKING = 0.05;

  /** Remote videos now, as [{key, who, source}], screens first. */
  function liveVideo(c, s) {
    const out = [];
    if (!c) return out;
    if (c.callMode === 'Direct') {
      const t = targetOf(c.conversationId);
      if (c.hasRemoteVideo && t && t.peer) out.push({ key: 'direct', who: t.peer, source: c.isSharingScreen ? 'stream' : 'camera' });
      return out;
    }
    for (const p of c.remoteParticipants || []) {
      if (p.hasRemoteVideo || p.presenting) out.push({ key: String(p.demuxId), who: p.aci, source: p.presenting || p.sharingScreen ? 'stream' : 'camera' });
    }
    out.sort((a, b) => (a.source === b.source ? 0 : a.source === 'stream' ? -1 : 1));
    void s;
    return out;
  }
  /** Live video onto the bridge's slots, keeping what plays where it is; returns CallState.video. */
  function assignSlots(videos) {
    if (!bridge.slots.size) return [];
    const live = videos.filter((v) => remote.has(v.key)).slice(0, bridge.slots.size);
    const keys = new Set(live.map((v) => v.key));
    for (const slot of bridge.slots.values()) {
      if (slot.key && !keys.has(slot.key)) {
        slot.key = null;
        slot.sender.replaceTrack(null).catch(() => {});
      }
    }
    for (const v of live) {
      if ([...bridge.slots.values()].some((x) => x.key === v.key)) continue;
      const free = [...bridge.slots.values()].find((x) => !x.key);
      if (!free) break;
      free.key = v.key;
      free.sender.replaceTrack(remote.get(v.key).track).catch(() => {});
    }
    const out = [];
    for (const [mid, slot] of bridge.slots) {
      const v = slot.key && live.find((x) => x.key === slot.key);
      if (v) out.push({ slot: mid, who: v.who, source: v.source });
    }
    return out;
  }

  /** The call's state as dither-chat's CallState, with native ids (ACIs). */
  function callState() {
    const s = state();
    if (!s || !call) return null;
    const cs = s.calling;
    const c = cs.callsByConversation[call.conversationId];
    const a = cs.activeCallState && cs.activeCallState.conversationId === call.conversationId && cs.activeCallState.state === 'Active' ? cs.activeCallState : null;
    const me = s.user.ourAci;
    const participants = [];
    let connected = false;
    if (c && c.callMode === 'Direct') {
      connected = c.callState === 'connected';
      const t = targetOf(call.conversationId);
      if (connected && t && t.peer) participants.push({ id: t.peer, muted: c.hasRemoteAudio === false, deafened: false, speaking: (c.remoteAudioLevel || 0) > SPEAKING, ...(c.hasRemoteVideo ? { video: true } : {}), ...(c.isSharingScreen ? { streaming: true } : {}) });
    } else if (c) {
      connected = c.connectionState === 2 && c.joinState === 3;
      const levels = c.remoteAudioLevels;
      for (const p of c.remoteParticipants || []) {
        participants.push({ id: p.aci, muted: !p.hasRemoteAudio, deafened: false, speaking: ((levels && levels.get && levels.get(p.demuxId)) || 0) > SPEAKING, ...(p.hasRemoteVideo ? { video: true } : {}), ...(p.presenting ? { streaming: true } : {}) });
      }
    }
    if (connected && me) participants.unshift({ id: me, muted: a ? !a.hasLocalAudio : !!call.muted, deafened: !!call.deafened, speaking: !!a && (a.localAudioLevel || 0) > SPEAKING, ...(a && a.hasLocalVideo ? { video: true } : {}), ...(a && a.presentingSource ? { streaming: true } : {}) });
    return {
      participants,
      video: assignSlots(liveVideo(c, s)),
      self: { connected, muted: a ? !a.hasLocalAudio : !!call.muted, deafened: !!call.deafened, camera: !!(a && a.hasLocalVideo), streaming: !!(a && a.presentingSource) },
      _over: callOver(c, a),
    };
  }
  /** Over: the call ended for this account (hung up here or there, rejected, failed). */
  function callOver(c, a) {
    if (!call || !call.started) return null;
    if (c && c.callMode === 'Direct' && c.callState === 'ended') return c.callEndedReason || 'ended';
    if (!a && Date.now() - call.started > 3000) return c ? 'left' : 'ended';
    return null;
  }

  let lastState = '';
  function tellState() {
    if (!call) return;
    const st = callState();
    if (!st) return;
    const over = st._over;
    delete st._over;
    if (over) {
      endCall(over);
      return;
    }
    const k = JSON.stringify(st);
    if (k === lastState) return;
    lastState = k;
    const t = call.target;
    send({ ev: 'call', call: call.id, state: { target: t, ...st } });
  }
  function endCall(reason) {
    if (!call) return;
    const id = call.id;
    call = null;
    lastState = '';
    closeBridge();
    send({ ev: 'call', call: id, ended: reason });
  }
  // Signal's video frames come at its own pace; slots and levels are read a few times a second.
  setInterval(() => {
    try {
      tellState();
    } catch (e) {
      log('warn', 'call state', String(e));
    }
  }, 250);

  // ---------------------------------------------------------------- rings: group calls ringing this account
  /** Group rings by conversation, as last told. Signal's 1:1 rings reach signal-cli too, which says them already. */
  const rings = new Map();
  function tellRings() {
    const s = state();
    if (!s) return;
    const now = new Map();
    for (const c of Object.values(s.calling.callsByConversation)) {
      if (c.callMode !== 'Group' || c.ringId === undefined || c.ringId === null || c.joinState !== 0) continue;
      const t = targetOf(c.conversationId);
      if (t) now.set(c.conversationId, { ring: String(c.ringId), target: t, caller: c.ringerAci || null, video: false });
    }
    for (const [id, r] of now) if (!rings.has(id)) send({ ev: 'ring', state: 'ringing', ...r, at: Date.now() });
    for (const [id, r] of rings) if (!now.has(id)) send({ ev: 'ring', state: 'ended', ...r, joined: !!(call && call.conversationId === id), at: Date.now() });
    rings.clear();
    for (const [k, v] of now) rings.set(k, v);
  }
  setInterval(() => {
    try {
      tellRings();
    } catch (e) {}
  }, 500);

  // ---------------------------------------------------------------- the ops
  async function join(req) {
    if (call) throw new Error('already in a call');
    if (!appState().signedIn) throw new Error('Signal Desktop is not linked yet');
    await allowMedia();
    const conversationId = conversationOf(req.target);
    const A = actions().calling;
    const existing = state().calling.callsByConversation[conversationId];
    call = { id: req.call, conversationId, target: req.target, muted: !!req.muted, deafened: !!req.deafened, started: 0 };
    const ringingHere = existing && ((existing.callMode === 'Direct' && existing.isIncoming && existing.callState === 'ringing') || (existing.callMode === 'Group' && existing.ringId !== undefined && existing.joinState === 0));
    try {
      if (ringingHere) {
        A.acceptCall({ conversationId, asVideoCall: false });
      } else {
        A.startCallingLobby({ conversationId, isVideoCall: false });
        const lobby = await until(() => {
          const a = state().calling.activeCallState;
          return a && a.conversationId === conversationId && a.state === 'Active' ? a : null;
        }, 20000, 'the call lobby');
        if (lobby.callMode !== 'Direct') A.setOutgoingRing(!!req.ring);
        A.startCall({ callMode: lobby.callMode, conversationId, hasLocalAudio: !req.muted, hasLocalVideo: false });
      }
      call.started = Date.now();
      // Muted as the device is, once Signal has the call.
      await until(() => state().calling.activeCallState && state().calling.activeCallState.state === 'Active', 10000, 'the call');
      if (req.muted) A.setLocalAudio({ enabled: false });
    } catch (e) {
      call = null;
      throw e;
    }
    return { ok: true, answered: !!ringingHere };
  }

  const OPS = {
    app: () => appState(),
    /** Counts for the lab and the docs: frames copied per remote video, the bridge's state. */
    stats: () => ({
      bridge: bridge.pc ? bridge.pc.connectionState : null,
      remote: Object.fromEntries([...remote].map(([k, r]) => [k, { frames: r.frames, width: r.canvas.width, height: r.canvas.height }])),
      fromDevice: Object.fromEntries(Object.entries(fromDevice).map(([k, t]) => [k, t ? t.readyState : null])),
    }),
    join,
    signal: (req) => bridgeSignal(req.data),
    leave: () => {
      if (!call) return { ok: true };
      actions().calling.hangUpActiveCall('left from dither');
      endCall('left');
      return { ok: true };
    },
    mute: (req) => {
      if (!call) throw new Error('no call');
      call.muted = !!req.muted;
      call.deafened = !!req.deafened;
      actions().calling.setLocalAudio({ enabled: !req.muted });
      // Deafened: the device hears nothing of the call.
      if (bridge.mixTrack) bridge.mixTrack.enabled = !req.deafened;
      return { ok: true };
    },
    video: async (req) => {
      if (!call) throw new Error('no call');
      const A = actions().calling;
      const a = state().calling.activeCallState;
      if (!!req.camera !== !!(a && a.hasLocalVideo)) {
        if (req.camera && !fromDevice.camera) throw new Error("the device's camera has not reached the account yet");
        A.setLocalVideo({ enabled: !!req.camera });
      }
      const presenting = !!(a && a.presentingSource);
      if (req.screen && !presenting) {
        if (!fromDevice.screen) throw new Error("the device's screen has not reached the account yet");
        const tracks = [fromDevice.screen.clone(), ...(req.screenAudio && fromDevice.screenAudio ? [fromDevice.screenAudio.clone()] : [])];
        A._setPresenting({ id: 'dither-screen', name: 'Screen', isScreen: true }, new MediaStream(tracks));
      } else if (!req.screen && presenting) A.cancelPresenting();
      return { ok: true };
    },
    decline: (req) => {
      const conversationId = conversationOf(req.target);
      if (!state().calling.callsByConversation[conversationId]) return { ok: true, none: true };
      actions().calling.declineCall({ conversationId });
      return { ok: true };
    },
    eval: async (req) => {
      if (!LAB) throw new Error('eval is for the lab only');
      let v;
      try {
        v = await new Function(`return (async () => { ${req.code} })()`)();
      } catch (e) {
        if (!/EvalError|unsafe-eval|Content Security/.test(String(e))) throw e;
        v = await require('node:vm').runInThisContext(`(async () => { ${req.code} })()`);
      }
      try {
        return JSON.parse(JSON.stringify(v === undefined ? null : v));
      } catch {
        return String(v);
      }
    },
  };
  if (LAB) window.__dither = { OPS, rtc: () => rtc, bridge, remote, fromDevice, call: () => call };
}
