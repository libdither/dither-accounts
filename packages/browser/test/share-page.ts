/**
 * The screen-share test page (screenshare.test.ts, scripts/bench-display.ts). It fills the screen with an animated
 * pattern: on every frame a counter, drawn as 32 black or white blocks (16 bits of the counter, 16 of a check), with the
 * time it was drawn kept. A click shares the screen (getDisplayMedia: a user gesture, as browsers want) and sends it
 * over WebRTC on this machine to a second page (a same-origin iframe), which decodes the blocks of every frame it gets
 * and reports what it saw: the counters (each one checked, so a wrong picture cannot pass as a frame), the frame size,
 * the rate and the time from drawing to decoding. Then it stops sharing, and a click starts it again.
 *
 * Reports go as JSON to POST /report: {ev:'page'}, {ev:'click'}, {ev:'shared', session} (getDisplayMedia answered),
 * {ev:'stats', session, ...}, {ev:'stopped', session, ended}, {ev:'error', name, message}.
 */

export const GRID = { cols: 8, rows: 4, w: 64, h: 48 } as const;

/**
 * 16 bits of n and a 16-bit check of them (CRC-16/CCITT, xor 0x5a5a), as 32 bits (most significant first). The check
 * is one-to-one over the 16 bits, so a frame torn between two counters, row by row, decodes to one of them or fails;
 * a block blurred to the wrong colour passes 1 time in 65536 (an 8-bit check passed 1 in 256, and a few blurred frames
 * a share are allowed: now and then one passed as a counter the page never drew).
 */
export function encode(n: number): number[] {
  const v = n & 0xffff;
  let c = 0;
  for (let i = 15; i >= 0; i--) c = ((c << 1) ^ ((((c >> 15) ^ (v >> i)) & 1) ? 0x1021 : 0)) & 0xffff;
  c ^= 0x5a5a;
  const bits: number[] = [];
  for (let i = 15; i >= 0; i--) bits.push((v >> i) & 1);
  for (let i = 15; i >= 0; i--) bits.push((c >> i) & 1);
  return bits;
}

/** The counter in 32 bits, or null when its check does not match. */
export function decode(bits: number[]): number | null {
  let v = 0;
  let got = 0;
  for (let i = 0; i < 16; i++) v = (v << 1) | bits[i]!;
  for (let i = 16; i < 32; i++) got = (got << 1) | bits[i]!;
  let c = 0;
  for (let i = 15; i >= 0; i--) c = ((c << 1) ^ ((((c >> 15) ^ (v >> i)) & 1) ? 0x1021 : 0)) & 0xffff;
  return (c ^ 0x5a5a) === got ? v : null;
}

export interface ShareStats {
  ev: 'stats';
  session: number;
  /** Frames the receiver decoded, and those whose check failed. */
  frames: number;
  bad: number;
  /** Distinct counters seen, and whether they only went up. */
  distinct: number;
  increasing: boolean;
  /** Counters the receiver decoded that the page never drew. */
  unknown: number;
  width: number;
  height: number;
  /** Distinct counters per second over the measured span. */
  fps: number;
  /** Drawn → decoded, in ms. */
  latency: { p50: number; p95: number; max: number };
  /** What the capture track says it is. */
  label: string;
  settings: Record<string, unknown>;
  /** ms from the click to the first decoded frame. */
  firstFrameMs: number;
}

/** The page; `measureMs` is how long each session is measured, after its first decoded frame. */
export function sharePage(o: { measureMs?: number; constraints?: MediaStreamConstraints } = {}): string {
  const measureMs = o.measureMs ?? 4000;
  const constraints = JSON.stringify(o.constraints ?? { video: { frameRate: 30 }, audio: false });
  return `<!doctype html><html><head><meta charset="utf-8"><title>share probe</title><style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
#pat{position:absolute;left:0;top:0}
#recv{position:absolute;right:0;bottom:0;width:160px;height:120px;border:0}
</style></head><body><canvas id="pat"></canvas><iframe id="recv" src="about:blank"></iframe><script>
const G = ${JSON.stringify(GRID)};
${encode.toString()}
${decode.toString()}
const say = (o) => fetch('/report', { method: 'POST', body: JSON.stringify(o) });
const now = () => performance.now();
const pat = document.getElementById('pat');
pat.width = G.cols * G.w; pat.height = G.rows * G.h;
const g = pat.getContext('2d');
const drawn = new Map();
let n = 0;
function frame() {
  n = (n + 1) & 0xffff;
  const bits = encode(n);
  for (let i = 0; i < bits.length; i++) {
    g.fillStyle = bits[i] ? '#fff' : '#000';
    g.fillRect((i % G.cols) * G.w, Math.floor(i / G.cols) * G.h, G.w, G.h);
  }
  drawn.set(n, now());
  if (drawn.size > 4000) drawn.delete(drawn.keys().next().value);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// Ready once the page has been painted and two frames have passed: a click that comes before Chromium has shown the
// page's first frame can be lost (CI, now and then), and this script runs before that.
new PerformanceObserver((list, obs) => {
  if (!list.getEntries().some((e) => e.name === 'first-contentful-paint')) return;
  obs.disconnect();
  requestAnimationFrame(() => requestAnimationFrame(() => say({ ev: 'page', w: innerWidth, h: innerHeight, sw: screen.width, sh: screen.height })));
}).observe({ type: 'paint', buffered: true });
addEventListener('resize', () => say({ ev: 'resize', w: innerWidth, h: innerHeight }));

let session = 0, busy = false;
window.addEventListener('click', () => { say({ ev: 'click', busy, session }); if (!busy) start().catch((e) => { busy = false; say({ ev: 'error', name: e.name, message: String(e.message) }); }); });

async function start() {
  busy = true;
  const k = ++session;
  const clicked = now();
  const stream = await navigator.mediaDevices.getDisplayMedia(${constraints});
  say({ ev: 'shared', session: k, ms: Math.round(now() - clicked) });
  const track = stream.getVideoTracks()[0];
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  a.addTrack(track, stream);
  const got = new Promise((r) => (b.ontrack = (e) => r(e.streams[0] || new MediaStream([e.track]))));
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  // The blocks' place on the screen: the page is the bottom innerHeight of the window, which fills the screen.
  const top = screen.height - innerHeight;
  const recv = document.getElementById('recv').contentWindow;
  const stats = await recv.watch(await got, { top, measureMs: ${measureMs}, G, clicked, now, drawn, decode, sw: screen.width, sh: screen.height });
  say({ ev: 'stats', session: k, ...stats, label: track.label, settings: track.getSettings() });
  const ended = new Promise((r) => (track.onended = () => r('ended')));
  track.stop();
  a.close(); b.close();
  say({ ev: 'stopped', session: k, ended: track.readyState });
  void ended;
  busy = false;
}

// The second page: decodes what arrives.
const doc = document.getElementById('recv').contentDocument;
doc.open();
doc.write('<!doctype html><body style="margin:0"><video id="v" autoplay muted playsinline style="width:160px;height:120px"></video><canvas id="c" style="display:none"></canvas></body>');
doc.close();
document.getElementById('recv').contentWindow.watch = (stream, o) => new Promise((resolve) => {
  const v = doc.getElementById('v'), c = doc.getElementById('c');
  const x = c.getContext('2d', { willReadFrequently: true });
  v.srcObject = stream;
  const seen = [], lat = [];
  let frames = 0, bad = 0, unknown = 0, first = 0, w = 0, h = 0, firstAt = 0;
  const each = () => {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (vw && vh) {
      if (c.width !== vw || c.height !== vh) { c.width = vw; c.height = vh; }
      x.drawImage(v, 0, 0, vw, vh);
      const sx = vw / o.sw, sy = vh / o.sh;
      const bits = [];
      for (let i = 0; i < o.G.cols * o.G.rows; i++) {
        const px = Math.round(((i % o.G.cols) * o.G.w + o.G.w / 2) * sx);
        const py = Math.round((o.top + Math.floor(i / o.G.cols) * o.G.h + o.G.h / 2) * sy);
        const d = x.getImageData(px, py, 1, 1).data;
        bits.push(d[0] + d[1] + d[2] > 384 ? 1 : 0);
      }
      const n = o.decode(bits);
      const t = o.now();
      frames++;
      if (n === null) bad++;
      else {
        const at = o.drawn.get(n);
        if (at === undefined) unknown++;
        else {
          if (!first) { first = t; firstAt = t - o.clicked; w = vw; h = vh; }
          if (seen[seen.length - 1] !== n) { seen.push(n); lat.push(t - at); }
        }
      }
      if (first && t - first >= o.measureMs) {
        const q = (p) => { const s = [...lat].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : -1; };
        let inc = true;
        for (let i = 1; i < seen.length; i++) if (((seen[i] - seen[i - 1]) & 0xffff) > 0x8000) inc = false;
        resolve({ frames, bad, unknown, distinct: seen.length, increasing: inc, width: w, height: h, fps: (seen.length - 1) / ((t - first) / 1000), latency: { p50: q(0.5), p95: q(0.95), max: q(1) }, firstFrameMs: Math.round(firstAt) });
        return;
      }
    }
    v.requestVideoFrameCallback(each);
  };
  v.requestVideoFrameCallback(each);
});
</script></body></html>`;
}
