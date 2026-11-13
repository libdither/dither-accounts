/*
 * Call lab probe: time-coded synthetic media, detectors for it on the far side, and WebRTC stats.
 *
 * The same file runs in two places: inside a lab sandbox's Discord page (sandbox.ts appends it to
 * hook.js only for accounts configured with `lab: true`), and in the test browser that stands in
 * for a device (scripts/call-lab.ts injects it). Both ends run on one machine, so their wall
 * clocks agree and a latency is just "heard at" minus "sent at".
 *
 * Audio: a beep every second over a faint noise bed, cycling four pitches so a beep can be matched
 * to the one that was sent. Video: moving shapes plus two rows of blocks carrying the send time in
 * milliseconds (the second row inverted, so each bit is read against its own complement).
 *
 * Plain JS with no imports: it is stringified into pages.
 */
function installDitherProbe(label) {
  'use strict';
  const PITCHES = [700, 1100, 1500, 1900];
  const BEEP_MS = 120;
  const MAX = 20000;
  const wall = () => performance.timeOrigin + performance.now();
  const S = { label, emitted: [], heard: [], frames: [], stats: [], pcs: [], env: {}, speech: null, micStarted: false, camStarted: false, notes: [] };
  const tappedAudio = new WeakSet();
  const tappedVideo = new WeakSet();
  const keep = (arr, v) => (arr.push(v), arr.length > MAX && arr.splice(0, arr.length - MAX));

  let ctx = null;
  function audio() {
    if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }
  const ctxToWall = (t) => wall() + (t - audio().currentTime) * 1000;

  // ------------------------------------------------------------ sources
  let micDest = null;
  let speech = null;
  /** Loop a recording instead of beeps: Discord's default noise cancellation and VAD (Krisp) only pass speech. */
  async function useSpeech(bytes) {
    const c = audio();
    mic();
    const buf = await c.decodeAudioData(bytes);
    if (speech) speech.stop();
    speech = c.createBufferSource();
    speech.buffer = buf;
    speech.loop = true;
    const g = c.createGain();
    g.gain.value = 0.8;
    speech.connect(g).connect(micDest);
    const at = c.currentTime + 0.1;
    speech.start(at);
    S.speech = { t: ctxToWall(at), dur: buf.duration * 1000, rate: buf.sampleRate, len: buf.length };
    return S.speech;
  }
  function mic() {
    const c = audio();
    if (micDest) return micDest.stream;
    micDest = c.createMediaStreamDestination();
    // Noise bed, about -50 dBFS, so the stream is never digital silence.
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = c.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const ng = c.createGain();
    ng.gain.value = 0.003;
    noise.connect(ng).connect(micDest);
    noise.start();
    let n = 0;
    const schedule = () => {
      if (speech) return;
      const k = n++;
      const f = PITCHES[k % PITCHES.length];
      const at = c.currentTime + 0.05;
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.35, at + 0.004);
      g.gain.setValueAtTime(0.35, at + BEEP_MS / 1000 - 0.004);
      g.gain.linearRampToValueAtTime(0, at + BEEP_MS / 1000);
      osc.connect(g).connect(micDest);
      osc.start(at);
      osc.stop(at + BEEP_MS / 1000 + 0.01);
      keep(S.emitted, { k, f, t: ctxToWall(at) });
    };
    setInterval(schedule, 1000);
    S.micStarted = true;
    return micDest.stream;
  }

  let cam = null;
  function camera(w = 1280, h = 720, fps = 30) {
    if (cam) return cam;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    const B = w / 32;
    let n = 0;
    const draw = () => {
      const now = wall();
      const t = now / 1000;
      n++;
      g.fillStyle = `hsl(${(t * 40) % 360},50%,40%)`;
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 24; i++) {
        g.fillStyle = `hsl(${(i * 37 + t * 90) % 360},70%,${30 + ((i * 13) % 40)}%)`;
        const x = ((i * 97 + t * 120 * (1 + (i % 3))) % (w + 200)) - 100;
        const y = 2 * B + 20 + ((i * 53) % (h - 2 * B - 140));
        g.fillRect(x, y, 120, 90);
      }
      g.fillStyle = '#fff';
      g.font = 'bold 64px sans-serif';
      g.fillText(String(n), 40, h - 50);
      const code = Math.floor(now) % 4294967296;
      for (let i = 0; i < 32; i++) {
        const bit = Math.floor(code / 2 ** (31 - i)) % 2;
        g.fillStyle = bit ? '#fff' : '#000';
        g.fillRect(i * B, 0, B, B);
        g.fillStyle = bit ? '#000' : '#fff';
        g.fillRect(i * B, B, B, B);
      }
    };
    draw();
    setInterval(draw, 1000 / fps);
    cam = cv.captureStream(fps);
    S.camStarted = true;
    return cam;
  }

  /** What getUserMedia / getDisplayMedia hand out while the lab media is on. */
  function streamFor(c) {
    const tracks = [];
    if (c && c.audio) tracks.push(mic().getAudioTracks()[0].clone());
    if (c && c.video) tracks.push(camera().getVideoTracks()[0].clone());
    return new MediaStream(tracks);
  }

  let unpatch = null;
  function patchMedia() {
    if (unpatch) return;
    const md = navigator.mediaDevices;
    const orig = { gum: md.getUserMedia, gdm: md.getDisplayMedia, enumerate: md.enumerateDevices };
    md.getUserMedia = async (c) => streamFor(c);
    md.getDisplayMedia = async () => streamFor({ video: true });
    md.enumerateDevices = async () => [
      { deviceId: 'lab-mic', kind: 'audioinput', label: 'Lab microphone', groupId: 'lab', toJSON() {} },
      { deviceId: 'lab-cam', kind: 'videoinput', label: 'Lab camera', groupId: 'lab', toJSON() {} },
      { deviceId: 'default', kind: 'audiooutput', label: 'Default', groupId: 'lab', toJSON() {} },
    ];
    unpatch = () => {
      Object.assign(md, { getUserMedia: orig.gum, getDisplayMedia: orig.gdm, enumerateDevices: orig.enumerate });
      unpatch = null;
    };
  }

  // ---------------------------------------------------------- detectors
  function tapAudio(track, where) {
    if (tappedAudio.has(track)) return;
    tappedAudio.add(track);
    const c = audio();
    // Chromium only feeds a remote track into Web Audio while a media element also plays it.
    const el = new Audio();
    el.muted = true;
    el.srcObject = new MediaStream([track]);
    el.play().catch(() => {});
    const src = c.createMediaStreamSource(new MediaStream([track]));
    const N = 256;
    const sp = c.createScriptProcessor(N, 1, 1);
    const coeff = PITCHES.map((f) => 2 * Math.cos((2 * Math.PI * f) / c.sampleRate));
    let quietSince = 0;
    let lastOnset = 0;
    const env = (S.env[where + ':' + track.id] = { t: [], v: [] });
    sp.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      const end = wall();
      let energy = 0;
      for (let i = 0; i < N; i++) energy += x[i] * x[i];
      const rms = Math.sqrt(energy / N);
      env.t.push(Math.round((end - (N / c.sampleRate) * 1000) * 10) / 10);
      env.v.push(Math.round(rms * 10000) / 10000);
      if (env.t.length > 60000) (env.t.splice(0, 10000), env.v.splice(0, 10000));
      if (rms < 0.02) {
        if (!quietSince) quietSince = end;
        return;
      }
      // Loud block: an onset if the line was quiet for 300 ms first.
      if (!quietSince || end - quietSince < 300 || end - lastOnset < 500) {
        quietSince = 0;
        return;
      }
      quietSince = 0;
      lastOnset = end;
      let best = -1;
      let bestP = 0;
      coeff.forEach((cf, j) => {
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < N; i++) {
          const s0 = x[i] + cf * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        const p = s1 * s1 + s2 * s2 - cf * s1 * s2;
        if (p > bestP) (bestP = p), (best = j);
      });
      let first = 0;
      while (first < N && Math.abs(x[first]) < 0.05) first++;
      keep(S.heard, { t: end - ((N - first) / c.sampleRate) * 1000, f: PITCHES[best], rms: Math.round(rms * 1000) / 1000, where });
    };
    src.connect(sp);
    const sink = c.createGain();
    sink.gain.value = 0;
    sp.connect(sink).connect(c.destination);
    track.addEventListener('ended', () => {
      try {
        sp.disconnect();
        src.disconnect();
      } catch {}
    });
  }

  function tapVideo(track, where) {
    if (tappedVideo.has(track)) return;
    tappedVideo.add(track);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = new MediaStream([track]);
    v.play().catch(() => {});
    const cv = document.createElement('canvas');
    const g = cv.getContext('2d', { willReadFrequently: true });
    const onFrame = (now, meta) => {
      const w = meta.width;
      const h = meta.height;
      const sw = 320;
      const sh = Math.max(1, Math.round((sw * h) / w));
      if (cv.width !== sw || cv.height !== sh) (cv.width = sw), (cv.height = sh);
      g.drawImage(v, 0, 0, sw, sh);
      const B = sw / 32;
      const row = (y) => g.getImageData(0, Math.floor(y), sw, 1).data;
      const a = row(B / 2);
      const b = row(B * 1.5);
      let code = 0;
      let margin = 255;
      for (let i = 0; i < 32; i++) {
        const x = Math.floor(i * B + B / 2) * 4;
        const la = a[x] + a[x + 1] + a[x + 2];
        const lb = b[x] + b[x + 1] + b[x + 2];
        margin = Math.min(margin, Math.abs(la - lb) / 3);
        code = code * 2 + (la > lb ? 1 : 0);
      }
      const at = performance.timeOrigin + now;
      if (margin > 40) {
        const low = Math.floor(at) % 4294967296;
        const lat = (low - code + 4294967296) % 4294967296;
        if (lat < 10000) keep(S.frames, { t: at, lat, w, h, where });
      } else keep(S.frames, { t: at, lat: null, w, h, where });
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  // ----------------------------------------------------- connections + stats
  const proto = RTCPeerConnection.prototype;
  const origSLD = proto.setLocalDescription;
  proto.setLocalDescription = function (...args) {
    if (!S.pcs.includes(this)) {
      S.pcs.push(this);
      const idx = S.pcs.length - 1;
      this.addEventListener('track', (e) => (e.track.kind === 'audio' ? tapAudio(e.track, 'pc' + idx) : tapVideo(e.track, 'pc' + idx)));
    }
    return origSLD.apply(this, args);
  };

  const KEEP = {
    'outbound-rtp': ['kind', 'ssrc', 'rid', 'bytesSent', 'packetsSent', 'retransmittedPacketsSent', 'framesEncoded', 'framesSent', 'keyFramesEncoded', 'frameWidth', 'frameHeight', 'framesPerSecond', 'qualityLimitationReason', 'encoderImplementation', 'targetBitrate', 'totalEncodeTime', 'nackCount', 'pliCount', 'firCount', 'active', 'scalabilityMode', 'codecId'],
    'inbound-rtp': ['kind', 'ssrc', 'bytesReceived', 'packetsReceived', 'packetsLost', 'jitter', 'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferEmittedCount', 'concealedSamples', 'silentConcealedSamples', 'totalSamplesReceived', 'concealmentEvents', 'insertedSamplesForDeceleration', 'removedSamplesForAcceleration', 'audioLevel', 'framesDecoded', 'framesDropped', 'framesReceived', 'keyFramesDecoded', 'frameWidth', 'frameHeight', 'framesPerSecond', 'freezeCount', 'totalFreezesDuration', 'pauseCount', 'totalPausesDuration', 'totalDecodeTime', 'totalProcessingDelay', 'decoderImplementation', 'nackCount', 'pliCount', 'firCount', 'codecId', 'trackIdentifier'],
    'remote-inbound-rtp': ['kind', 'ssrc', 'roundTripTime', 'fractionLost', 'jitter', 'packetsLost'],
    'candidate-pair': ['state', 'nominated', 'currentRoundTripTime', 'availableOutgoingBitrate', 'bytesSent', 'bytesReceived', 'localCandidateId', 'remoteCandidateId'],
    'local-candidate': ['candidateType', 'protocol', 'relayProtocol', 'address', 'port'],
    'remote-candidate': ['candidateType', 'protocol', 'address', 'port'],
    codec: ['mimeType', 'clockRate', 'sdpFmtpLine'],
    'media-source': ['kind', 'audioLevel', 'totalAudioEnergy', 'width', 'height', 'framesPerSecond'],
  };
  setInterval(async () => {
    const t = wall();
    for (let i = 0; i < S.pcs.length; i++) {
      const pc = S.pcs[i];
      if (!pc || pc.connectionState === 'closed') {
        if (pc) S.pcs[i] = null;
        continue;
      }
      // Late tracks: receivers that exist without a track event (re-used transceivers).
      for (const r of pc.getReceivers()) if (r.track) r.track.kind === 'audio' ? tapAudio(r.track, 'pc' + i) : tapVideo(r.track, 'pc' + i);
      try {
        const rep = await pc.getStats();
        const items = [];
        rep.forEach((s) => {
          const keys = KEEP[s.type];
          if (!keys) return;
          if (s.type === 'candidate-pair' && !s.nominated) return;
          if ((s.type === 'inbound-rtp' || s.type === 'outbound-rtp') && !(s.bytesReceived || s.bytesSent)) return;
          const o = { type: s.type, id: s.id };
          for (const k of keys) if (s[k] !== undefined) o[k] = s[k];
          items.push(o);
        });
        keep(S.stats, { t, pc: i, items });
      } catch {}
    }
  }, 1000);

  return {
    patchMedia,
    unpatchMedia: () => unpatch && unpatch(),
    mic,
    useSpeech,
    camera,
    note: (n) => keep(S.notes, { t: wall(), n }),
    report(since = 0) {
      const f = (a) => a.filter((x) => x.t >= since);
      const env = {};
      for (const [k, e] of Object.entries(S.env)) {
        const i = e.t.findIndex((t) => t >= since);
        if (i >= 0) env[k] = { t: e.t.slice(i), v: e.v.slice(i) };
      }
      return { label: S.label, now: wall(), speech: S.speech, emitted: f(S.emitted), heard: f(S.heard), frames: f(S.frames), stats: f(S.stats), notes: f(S.notes), env, pcs: S.pcs.map((p) => p && p.connectionState) };
    },
  };
}
