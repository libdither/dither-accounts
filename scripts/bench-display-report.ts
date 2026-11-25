#!/usr/bin/env bun
/**
 * The page for scripts/bench-display.ts's numbers: one HTML file, the results inside it, charts drawn by the page
 * itself (no network), light and dark.
 *
 *   bun scripts/bench-display-report.ts <results.json> <out dir> [--native native.json] [--link link.json]
 *                                       [--lab lab.json] [--findings findings.html]
 *
 * Writes <out dir>/index.html and a copy of each input beside it (results.json, native.json, link.json). The native
 * apps' numbers come from scripts/bench-native.ts, the constrained link's from scripts/bench-link.ts. The native runs'
 * log lines (the apps' own output) are left out of the page and its copy. --lab: real programs on test accounts
 * (scripts/bench-lab.ts), shown as a table. --findings: an HTML fragment put at the top (what was concluded, by hand).
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = args[i + 1]!;
  args.splice(i, 2);
  return v;
};
const nativeIn = opt('native');
const linkIn = opt('link');
const labIn = opt('lab');
const findingsIn = opt('findings');
const findings = findingsIn ? readFileSync(findingsIn, 'utf8') : '';
const [input, outDir] = args;
if (!input || !outDir) {
  console.error('usage: bun scripts/bench-display-report.ts <results.json> <out dir> [--native native.json] [--link link.json]');
  process.exit(2);
}
const results = JSON.parse(readFileSync(input, 'utf8'));
mkdirSync(outDir, { recursive: true });
copyFileSync(input, join(outDir, 'results.json'));
const native = nativeIn ? JSON.parse(readFileSync(nativeIn, 'utf8')) : null;
if (native) {
  for (const r of native.runs) delete r.gpuLines;
  writeFileSync(join(outDir, 'native.json'), JSON.stringify(native, null, 2));
}
const link = linkIn ? JSON.parse(readFileSync(linkIn, 'utf8')) : null;
if (link) copyFileSync(linkIn!, join(outDir, 'link.json'));
const lab = labIn ? JSON.parse(readFileSync(labIn, 'utf8')) : null;
if (lab) copyFileSync(labIn!, join(outDir, 'lab.json'));
const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sandbox display backends</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10);
  --x11: #2a78d6; --wayland: #eb6834; --pixman: #1baf7a; --gles2: #eb6834; --tigervnc: #8a5cc2; --kasmvnc: #c2417a; --turbovnc: #a0821c;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
    --x11: #3987e5; --wayland: #d95926; --pixman: #199e70; --gles2: #d95926; --tigervnc: #a07ad6; --kasmvnc: #d9608f; --turbovnc: #c4a23a;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
  --x11: #3987e5; --wayland: #d95926; --pixman: #199e70; --gles2: #d95926; --tigervnc: #a07ad6; --kasmvnc: #d9608f; --turbovnc: #c4a23a;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 17px; margin: 32px 0 4px; font-weight: 600; }
.sub, .note { color: var(--ink-2); }
.note { margin: 0 0 12px; max-width: 75ch; }
.legend { display: flex; gap: 16px; margin: 12px 0 0; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 12px 14px 10px; min-width: 0; }
.card h3 { font-size: 13px; font-weight: 600; margin: 0; }
.card .how { color: var(--muted); font-size: 12px; margin: 0 0 6px; }
.wide { grid-column: 1 / -1; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr)); gap: 12px; }
svg { display: block; width: 100%; overflow: visible; }
svg text { fill: var(--ink-2); font-size: 12px; }
svg .val { fill: var(--ink); font-weight: 600; }
svg .ax { fill: var(--muted); font-size: 11px; }
.hit { fill: transparent; cursor: default; }
.hit:hover + .bar, .hit:focus + .bar { opacity: 0.8; }
#tip { position: fixed; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--ring); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); display: none; z-index: 10; max-width: 280px; }
#tip b { font-size: 14px; }
#tip .k { display: inline-block; width: 12px; height: 2px; vertical-align: middle; margin-right: 6px; }
#tip .row { color: var(--ink-2); }
.tablewrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
td.n { text-align: right; font-variant-numeric: tabular-nums; }
th { color: var(--ink-2); font-weight: 600; }
details summary { cursor: pointer; color: var(--ink-2); margin: 8px 0; }
ul.notes { padding-left: 20px; max-width: 80ch; }
ul.notes li { margin: 4px 0; }
code { font-size: 12px; }
</style></head><body><main>
<h1>Sandbox display backends</h1>
<div class="sub" id="sub"></div>
<div class="legend" aria-label="legend" id="legend"></div>
<div id="findings">${findings}</div>
<div id="sections"></div>
<div id="native"></div>
<div id="link"></div>
<div id="lab"></div>
<h2>Every number: one browser sandbox</h2>
<p class="note">Median over the repetitions, and the lowest and highest. Each repetition is a fresh sandbox; the order of the backends rotates between repetitions.</p>
<div class="tablewrap"><table id="table"><thead><tr id="thead"><th>Measure</th></tr></thead><tbody></tbody></table></div>
<h2>Notes</h2>
<ul class="notes" id="notes"></ul>
<div id="tip" role="status"></div>
</main>
<script type="application/json" id="data">${json(results)}</script>
<script type="application/json" id="native-data">${json(native)}</script>
<script type="application/json" id="link-data">${json(link)}</script>
<script type="application/json" id="lab-data">${json(lab)}</script>
<script>
const R = JSON.parse(document.getElementById('data').textContent);
const B = R.backends || ['x11', 'wayland'];
const LABEL = { x11: 'x11: Xvfb + x11vnc', tigervnc: 'tigervnc: TigerVNC Xvnc', kasmvnc: 'kasmvnc: KasmVNC Xvnc', turbovnc: 'turbovnc: TurboVNC Xvnc', wayland: 'wayland: sway + wayvnc' };
{ const lg = document.getElementById('legend'); for (const b of B) { const sp = document.createElement('span'); const sw = document.createElement('i'); sw.className = 'sw'; sw.style.background = 'var(--' + b + ')'; sp.append(sw, LABEL[b] || b); lg.append(sp); } }
{ const th = document.getElementById('thead'); for (const b of B) for (const t of [b + ' median', b + ' range']) { const c = document.createElement('th'); c.textContent = t; th.append(c); } const c = document.createElement('th'); c.textContent = 'Better'; th.append(c); }
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
const h = (tag, cls, text, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; if (parent) parent.appendChild(e); return e; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const fmt = (v, d) => (v === undefined || Number.isNaN(v) ? '–' : v >= 1000 ? Math.round(v).toLocaleString('en') : v.toFixed(d ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2)));
const runs = R.runs.filter((r) => !r.error);
const pick = (b, get) => runs.filter((r) => r.backend === b).map((r) => { try { const v = get(r); return typeof v === 'number' && Number.isFinite(v) ? v : undefined; } catch { return undefined; } }).filter((v) => v !== undefined);

const loads = R.runs.map((r) => r.load?.load).filter((x) => x !== undefined);
document.getElementById('sub').textContent = \`\${R.machine.cpus} threads (\${R.machine.model}), \${R.machine.memGB} GB, \${R.machine.gpu ? 'a GPU render node' : 'no GPU'} · screen \${R.size} · \${R.reps} repetitions · \${new Date(R.when).toISOString().slice(0, 16).replace('T', ' ')} UTC · 1-minute load during the runs \${fmt(Math.min(...loads), 1)}–\${fmt(Math.max(...loads), 1)}\${R.runs.some((r) => r.load?.busy) ? ' (some runs taken while busy)' : ''}\`;

const tip = document.getElementById('tip');
function showTip(ev, title, rows) {
  tip.replaceChildren();
  h('div', '', title, tip).style.marginBottom = '4px';
  for (const [color, value, label] of rows) { const r = h('div', 'row', undefined, tip); const k = h('span', 'k', undefined, r); k.style.background = color; h('b', '', value, r); r.append(' ' + label); }
  tip.style.display = 'block';
  const x = ev.clientX ?? ev.target.getBoundingClientRect().right, y = ev.clientY ?? ev.target.getBoundingClientRect().top;
  const w = tip.offsetWidth, hh = tip.offsetHeight;
  tip.style.left = Math.min(innerWidth - w - 8, x + 12) + 'px';
  tip.style.top = Math.max(8, y - hh - 8) + 'px';
}
const hideTip = () => (tip.style.display = 'none');

const SECTIONS = [
  { title: 'Starting', note: 'From new Sandbox().start() to the live view answering, and to the first page’s script running in Chromium.', metrics: [
    { label: 'Live view up', unit: 'ms', better: 'lower', get: (r) => r.start.screenMs },
    { label: 'First page ran', unit: 'ms', better: 'lower', get: (r) => r.start.pageMs },
  ] },
  { title: 'Sitting idle', note: 'A still page, after 10 s, over 10 s: every process of the sandbox. PSS shares Chromium’s common pages fairly between processes; RSS counts them in each.', metrics: [
    { label: 'CPU', unit: '% of one core', better: 'lower', get: (r) => r.idle.cpu },
    { label: 'Memory (PSS)', unit: 'MB', better: 'lower', get: (r) => r.idle.pssMB },
    { label: 'Display stack memory (PSS, all but Chromium)', unit: 'MB', better: 'lower', get: (r) => r.idle.pssMB - (r.idle.memByName.chromium?.pssMB ?? 0) },
    { label: 'Processes', unit: '', better: 'lower', get: (r) => r.idle.processes },
  ] },
  { title: 'The live view (VNC)', note: 'A viewer of our own on the live view’s socket asks for every frame (ZRLE first), for 5 s. The sandbox’s wayvnc sends up to 60 frames a second (wayvnc’s own default is 30); x11vnc has no cap.', metrics: [
    { label: 'Still page: VNC server CPU with a viewer', unit: '% of one core', better: 'lower', get: (r) => r.vnc.idle.serverCpu },
    { label: 'Full-screen animation: frames delivered', unit: 'per s', better: 'higher', get: (r) => r.vnc.anim.fps },
    { label: 'Full-screen animation: bytes', unit: 'MB/s', better: 'lower', get: (r) => r.vnc.anim.bytesPerS / 1e6 },
    { label: 'Full-screen animation: VNC server CPU', unit: '% of one core', better: 'lower', get: (r) => r.vnc.anim.serverCpu },
    { label: 'Page scrolling: frames delivered', unit: 'per s', better: 'higher', get: (r) => r.vnc.scroll.fps },
    { label: 'Page scrolling: bytes', unit: 'MB/s', better: 'lower', get: (r) => r.vnc.scroll.bytesPerS / 1e6 },
    { label: 'Page scrolling: VNC server CPU', unit: '% of one core', better: 'lower', get: (r) => r.vnc.scroll.serverCpu },
    { label: '720p video: frames delivered', unit: 'per s', better: 'higher', get: (r) => r.vnc.video.fps },
    { label: '720p video: bytes', unit: 'MB/s', better: 'lower', get: (r) => r.vnc.video.bytesPerS / 1e6 },
    { label: '720p video: VNC server CPU', unit: '% of one core', better: 'lower', get: (r) => r.vnc.video.serverCpu },
  ] },
  { title: 'The live view as noVNC asks (Tight first)', note: 'The same scenes, asked for as the manager’s live view asks: noVNC’s list, Tight first, quality 6, compression 2. On kasmvnc again with WebP added, as KasmVNC’s own web client asks (our noVNC cannot decode WebP rectangles).', metrics: [
    { label: 'Animation, Tight: frames', unit: 'per s', better: 'higher', get: (r) => r.vnc.animTight.fps },
    { label: 'Animation, Tight: bytes', unit: 'MB/s', better: 'lower', get: (r) => r.vnc.animTight.bytesPerS / 1e6 },
    { label: 'Animation, Tight: server CPU', unit: '% of one core', better: 'lower', get: (r) => r.vnc.animTight.serverCpu },
    { label: 'Scrolling, Tight: frames', unit: 'per s', better: 'higher', get: (r) => r.vnc.scrollTight.fps },
    { label: 'Scrolling, Tight: bytes', unit: 'MB/s', better: 'lower', get: (r) => r.vnc.scrollTight.bytesPerS / 1e6 },
    { label: 'Scrolling, Tight: server CPU', unit: '% of one core', better: 'lower', get: (r) => r.vnc.scrollTight.serverCpu },
    { label: 'Video, Tight: frames', unit: 'per s', better: 'higher', get: (r) => r.vnc.videoTight.fps },
    { label: 'Video, Tight: bytes', unit: 'MB/s', better: 'lower', get: (r) => r.vnc.videoTight.bytesPerS / 1e6 },
    { label: 'Animation, WebP (kasmvnc): frames', unit: 'per s', better: 'higher', get: (r) => r.vnc.animWebp.fps },
    { label: 'Animation, WebP (kasmvnc): bytes', unit: 'MB/s', better: 'lower', get: (r) => r.vnc.animWebp.bytesPerS / 1e6 },
    { label: 'Scrolling, WebP (kasmvnc): bytes', unit: 'MB/s', better: 'lower', get: (r) => r.vnc.scrollWebp.bytesPerS / 1e6 },
  ] },
  { title: 'Input', note: 'An RFB pointer press sent on the live view’s socket, 20 times: to the page’s pointerdown handler running, and to the changed pixels arriving in the viewer’s picture (click to photon). Median of each run.', metrics: [
    { label: 'Press → page handler', unit: 'ms', better: 'lower', get: (r) => r.input.toHandler.median },
    { label: 'Click to photon', unit: 'ms', better: 'lower', get: (r) => r.input.clickToPhoton.median },
    { label: 'Typing 200 characters (each backend’s own way)', unit: 'chars/s', better: 'higher', get: (r) => r.typing.charsPerS },
  ] },
  { title: 'Screen sharing', note: 'In a sandbox of its own with sharing on: getDisplayMedia of the whole screen, sent over WebRTC to a second page that decodes a frame counter drawn on the screen. x11: Chromium’s own X capturer. wayland: PipeWire and the portal of the sandbox’s own. CPU is every process of the sandbox, Chromium’s encoding and decoding included.', metrics: [
    { label: 'Frames received', unit: 'per s', better: 'higher', get: (r) => r.share.fps },
    { label: 'Drawn → decoded, median', unit: 'ms', better: 'lower', get: (r) => r.share.latencyP50 },
    { label: 'Click → first frame', unit: 'ms', better: 'lower', get: (r) => r.share.firstFrameMs },
    { label: 'CPU while sharing', unit: '% of one core', better: 'lower', get: (r) => r.share.cpu },
  ] },
  { title: 'Video, WebGL, screenshots', note: 'A 1280×720 30 fps VP9 video for 10 s (getVideoPlaybackQuality); a full-screen shader; the backend’s screenshot (import or grim), 10 times.', metrics: [
    { label: 'Video: frames dropped', unit: '%', better: 'lower', get: (r) => r.video.droppedPct },
    { label: 'Video: CPU', unit: '% of one core', better: 'lower', get: (r) => r.video.cpu },
    { label: 'WebGL: frames', unit: 'per s', better: 'higher', get: (r) => r.webgl.fps },
    { label: 'WebGL: CPU', unit: '% of one core', better: 'lower', get: (r) => r.webgl.cpu },
    { label: 'Screenshot', unit: 'ms', better: 'lower', get: (r) => r.shot.median },
  ] },
];

const tbody = document.querySelector('#table tbody');
const root = document.getElementById('sections');
for (const s of SECTIONS) {
  h('h2', '', s.title, root);
  h('p', 'note', s.note, root);
  const grid = h('div', 'grid', undefined, root);
  for (const m of s.metrics) {
    const vals = Object.fromEntries(B.map((b) => [b, pick(b, m.get)]));
    if (!B.some((b) => vals[b].length)) continue;
    barCard(grid, m, vals);
    const tr = h('tr', '', undefined, tbody);
    h('td', '', m.label + (m.unit ? ' (' + m.unit + ')' : ''), tr);
    for (const b of B) { const v = vals[b]; h('td', 'n', fmt(med(v)), tr); h('td', 'n', v.length ? fmt(Math.min(...v)) + '–' + fmt(Math.max(...v)) + ' (' + v.length + ')' : '–', tr); }
    h('td', '', m.better, tr);
  }
}

function barCard(parent, m, vals) {
  const card = h('div', 'card', undefined, parent);
  h('h3', '', m.label, card);
  h('p', 'how', (m.unit ? m.unit + ' · ' : '') + m.better + ' is better', card);
  const W = 260, rowH = 26, padL = 64, padR = 52, H = rowH * B.length + 18;
  const max = Math.max(...B.flatMap((b) => vals[b]), 0) || 1;
  const x = (v) => padL + (v / max) * (W - padL - padR);
  const svg = el('svg', { viewBox: \`0 0 \${W} \${H}\`, role: 'img', 'aria-label': m.label + ': ' + B.map((b) => b + ' ' + fmt(med(vals[b])) + ' ' + m.unit).join(', ') }, card);
  el('line', { x1: padL, x2: padL, y1: 2, y2: rowH * B.length + 2, stroke: 'var(--axis)', 'stroke-width': 1 }, svg);
  B.forEach((b, i) => {
    const v = vals[b];
    const y = 6 + i * rowH, bh = 16;
    const t = el('text', { x: padL - 8, y: y + bh / 2 + 4, 'text-anchor': 'end' }, svg); t.textContent = b;
    if (!v.length) { const n = el('text', { x: padL + 6, y: y + bh / 2 + 4, class: 'ax' }, svg); n.textContent = 'no data'; return; }
    const mv = med(v), x1 = x(mv);
    const w = Math.max(1, x1 - padL);
    const hit = el('rect', { x: padL, y: y - 4, width: W - padL, height: bh + 8, class: 'hit', tabindex: 0 }, svg);
    // Square at the baseline, 4px round at the data end.
    const r = Math.min(4, w);
    el('path', { class: 'bar', d: \`M\${padL},\${y} H\${padL + w - r} Q\${padL + w},\${y} \${padL + w},\${y + r} V\${y + bh - r} Q\${padL + w},\${y + bh} \${padL + w - r},\${y + bh} H\${padL} Z\`, fill: \`var(--\${b})\` }, svg);
    if (v.length > 1) {
      const lo = x(Math.min(...v)), hi = x(Math.max(...v));
      el('line', { x1: lo, x2: hi, y1: y + bh / 2, y2: y + bh / 2, stroke: 'var(--ink)', 'stroke-width': 1, opacity: 0.55 }, svg);
      for (const xx of [lo, hi]) el('line', { x1: xx, x2: xx, y1: y + bh / 2 - 4, y2: y + bh / 2 + 4, stroke: 'var(--ink)', 'stroke-width': 1, opacity: 0.55 }, svg);
    }
    const lab = el('text', { x: Math.max(x1, v.length > 1 ? x(Math.max(...v)) : x1) + 6, y: y + bh / 2 + 4, class: 'val' }, svg); lab.textContent = fmt(mv);
    const show = (ev) => showTip(ev, m.label, [[\`var(--\${b})\`, fmt(mv) + (m.unit ? ' ' + m.unit : ''), \`\${b}, median of \${v.length}\${v.length > 1 ? ' (' + fmt(Math.min(...v)) + '–' + fmt(Math.max(...v)) + ')' : ''}\`]]);
    hit.addEventListener('pointermove', show); hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', hideTip); hit.addEventListener('blur', hideTip);
  });
  const ax = el('text', { x: padL, y: H - 2, class: 'ax' }, svg); ax.textContent = '0';
  const ax2 = el('text', { x: W - padR, y: H - 2, class: 'ax', 'text-anchor': 'end' }, svg); ax2.textContent = fmt(max);
}

// Many sandboxes at once.
if (R.scale?.length) {
  h('h2', '', 'Many sandboxes at once', root);
  h('p', 'note', 'N sandboxes started together (screen sharing off, as for every account but Discord), then 15 s later 10 s of idle CPU and the memory of all their processes.', root);
  const grid = h('div', 'grid', undefined, root);
  const okAll = R.scale.filter((s) => !s.error);
  const SC = [
    { label: 'Memory of all (PSS)', unit: 'MB', get: (s) => s.pssMB },
    { label: 'Memory per sandbox (PSS)', unit: 'MB', get: (s) => s.perSandboxPssMB },
    { label: 'Time until every first page ran', unit: 'ms', get: (s) => s.wallMs },
    { label: 'Idle CPU of all', unit: '% of one core', get: (s) => s.idleCpu },
    { label: 'Shared memory segments of the display servers', unit: 'segments', get: (s) => s.shm?.display },
    { label: 'Shared memory segments of everything in them', unit: 'segments', get: (s) => s.shm?.sandboxes },
  ];
  for (const m of SC) {
    const ok = okAll.filter((s) => typeof m.get(s) === 'number');
    if (!ok.length) continue;
    lineCard(grid, m, ok);
    const ns = [...new Set(ok.map((s) => s.n))].sort((a, b) => a - b);
    for (const n of ns) {
      const tr = h('tr', '', undefined, tbody);
      h('td', '', \`\${n} at once: \${m.label} (\${m.unit})\`, tr);
      for (const b of B) { const s = ok.find((x) => x.n === n && x.backend === b); h('td', 'n', s ? fmt(m.get(s)) : '–', tr); h('td', 'n', '', tr); }
      h('td', '', 'lower', tr);
    }
  }
  for (const s of R.scale.filter((s) => s.error))
    h('p', 'note', \`\${s.n} at once on \${s.backend} failed: \${s.error}.\${/x11vnc exited/.test(s.error) ? ' When x11vnc exits this way it is usually System V shared memory running out (its log says shmget: No space left on device): every x11 sandbox holds a few dozen segments while it runs, and the kernel allows kernel.shmmni of them (4096 by default) for the whole machine, other programs’ included. Wayland sandboxes hold none.' : ''}\`, root);
}

function lineCard(parent, m, rows) {
  const card = h('div', 'card', undefined, parent);
  h('h3', '', m.label, card);
  h('p', 'how', m.unit + ' · by number of sandboxes', card);
  const W = 260, H = 170, padL = 44, padR = 64, padT = 8, padB = 24;
  const ns = [...new Set(rows.map((s) => s.n))].sort((a, b) => a - b);
  const max = Math.max(...rows.map(m.get), 0) || 1;
  const nMax = Math.max(...ns);
  const x = (n) => padL + (n / nMax) * (W - padL - padR);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const svg = el('svg', { viewBox: \`0 0 \${W} \${H}\`, role: 'img', 'aria-label': m.label }, card);
  for (const f of [0, 0.5, 1]) {
    el('line', { x1: padL, x2: W - padR, y1: y(max * f), y2: y(max * f), stroke: f ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1 }, svg);
    const t = el('text', { x: padL - 6, y: y(max * f) + 4, class: 'ax', 'text-anchor': 'end' }, svg); t.textContent = fmt(max * f, 0);
  }
  for (const n of ns) { const t = el('text', { x: x(n), y: H - 6, class: 'ax', 'text-anchor': 'middle' }, svg); t.textContent = n; }
  const cross = el('line', { y1: padT, y2: H - padB, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' }, svg);
  for (const b of B) {
    const pts = ns.map((n) => rows.find((s) => s.n === n && s.backend === b)).filter(Boolean);
    if (!pts.length) continue;
    el('polyline', { points: pts.map((s) => \`\${x(s.n)},\${y(m.get(s))}\`).join(' '), fill: 'none', stroke: \`var(--\${b})\`, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    for (const s of pts) el('circle', { cx: x(s.n), cy: y(m.get(s)), r: 4, fill: \`var(--\${b})\`, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
  }
  // End labels: the series names at the right, nudged apart only if they would overlap.
  const ends = B.map((b) => { const s = rows.filter((r) => r.backend === b).sort((p, q) => q.n - p.n)[0]; return s && { b, y: y(m.get(s)), x: x(s.n) }; }).filter(Boolean).sort((p, q) => p.y - q.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 12) ends[k].y = ends[k - 1].y + 12;
  for (const e of ends) { const t = el('text', { x: e.x + 8, y: e.y + 4 }, svg); t.textContent = e.b; }
  const hit = el('rect', { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: 'transparent', tabindex: 0 }, svg);
  const at = (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ev.clientX !== undefined ? ((ev.clientX - box.left) / box.width) * W : x(ns[ns.length - 1]);
    const n = ns.reduce((best, k) => (Math.abs(x(k) - px) < Math.abs(x(best) - px) ? k : best), ns[0]);
    cross.setAttribute('x1', x(n)); cross.setAttribute('x2', x(n)); cross.setAttribute('visibility', 'visible');
    showTip(ev, \`\${n} sandboxes: \${m.label}\`, B.map((b) => { const s = rows.find((r) => r.n === n && r.backend === b); return [\`var(--\${b})\`, s ? fmt(m.get(s)) + ' ' + m.unit : '–', b]; }));
  };
  hit.addEventListener('pointermove', at); hit.addEventListener('focus', at);
  const off = () => { cross.setAttribute('visibility', 'hidden'); hideTip(); };
  hit.addEventListener('pointerleave', off); hit.addEventListener('blur', off);
}

// Grouped bars: a row per group (an app, a condition), a bar per series in it. vals: group -> series -> numbers.
function groupCard(parent, m, groups, series) {
  const card = h('div', 'card', undefined, parent);
  h('h3', '', m.label, card);
  h('p', 'how', (m.unit ? m.unit + ' · ' : '') + m.better + ' is better' + (m.how ? ' · ' + m.how : ''), card);
  const barH = 14, gap = 2, groupGap = 8, headH = 16, padL = 62, padR = 56, W = 460;
  const rows = groups.length * (series.length * (barH + gap) + headH + groupGap);
  const H = rows + 20;
  const all = groups.flatMap((g) => series.flatMap((s) => g.vals[s.key] || []));
  const max = Math.max(...all, 0) || 1;
  const x = (v) => padL + (v / max) * (W - padL - padR);
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': m.label, style: 'max-width:' + W + 'px' }, card);
  let y = 4;
  for (const g of groups) {
    const t = el('text', { x: 0, y: y + 11 }, svg); t.textContent = g.label;
    y += headH;
    for (const s of series) {
      const v = g.vals[s.key] || [];
      const lab = el('text', { x: padL - 8, y: y + barH - 3, 'text-anchor': 'end', class: 'ax' }, svg); lab.textContent = s.short || s.key;
      if (!v.length) { const n = el('text', { x: padL + 6, y: y + barH - 3, class: 'ax' }, svg); n.textContent = g.why && g.why[s.key] ? g.why[s.key] : 'no data'; y += barH + gap; continue; }
      const mv = med(v), w = Math.max(1, x(mv) - padL), r = Math.min(4, w);
      const hit = el('rect', { x: padL, y: y - 1, width: W - padL, height: barH + 2, class: 'hit', tabindex: 0 }, svg);
      el('path', { class: 'bar', d: 'M' + padL + ',' + y + ' H' + (padL + w - r) + ' Q' + (padL + w) + ',' + y + ' ' + (padL + w) + ',' + (y + r) + ' V' + (y + barH - r) + ' Q' + (padL + w) + ',' + (y + barH) + ' ' + (padL + w - r) + ',' + (y + barH) + ' H' + padL + ' Z', fill: 'var(--' + s.key + ')' }, svg);
      if (v.length > 1) {
        const lo = x(Math.min(...v)), hi = x(Math.max(...v));
        el('line', { x1: lo, x2: hi, y1: y + barH / 2, y2: y + barH / 2, stroke: 'var(--ink)', 'stroke-width': 1, opacity: 0.55 }, svg);
      }
      const vl = el('text', { x: Math.max(x(mv), v.length > 1 ? x(Math.max(...v)) : 0) + 6, y: y + barH - 3, class: 'val' }, svg); vl.textContent = fmt(mv);
      const show = (ev) => showTip(ev, g.label + ': ' + m.label, [['var(--' + s.key + ')', fmt(mv) + (m.unit ? ' ' + m.unit : ''), s.label + ', median of ' + v.length + (v.length > 1 ? ' (' + fmt(Math.min(...v)) + '–' + fmt(Math.max(...v)) + ')' : '')]]);
      hit.addEventListener('pointermove', show); hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', hideTip); hit.addEventListener('blur', hideTip);
      y += barH + gap;
    }
    y += groupGap;
  }

  const a0 = el('text', { x: padL, y: H - 2, class: 'ax' }, svg); a0.textContent = '0';
  const a1 = el('text', { x: W - padR, y: H - 2, class: 'ax', 'text-anchor': 'end' }, svg); a1.textContent = fmt(max);
}
const legend = (parent, series) => { const l = h('div', 'legend', undefined, parent); for (const s of series) { const sp = h('span', '', undefined, l); const sw = h('i', 'sw', undefined, sp); sw.style.background = 'var(--' + s.key + ')'; sp.append(s.label); } };
const val = (f) => (r) => { try { const v = f(r); return typeof v === 'number' && Number.isFinite(v) ? v : undefined; } catch { return undefined; } };
const smallTable = (parent, head, rows) => { const w = h('div', 'tablewrap', undefined, parent); const t = h('table', '', undefined, w); const tr = h('tr', '', undefined, h('thead', '', undefined, t)); for (const c of head) h('th', '', c, tr); const tb = h('tbody', '', undefined, t); for (const r of rows) { const row = h('tr', '', undefined, tb); r.forEach((c, i) => h('td', i ? 'n' : '', c, row)); } };

// The native apps.
const NAT = JSON.parse(document.getElementById('native-data').textContent);
if (NAT && NAT.runs.length) {
  const root = document.getElementById('native');
  const NL = { x11: 'x11: Xvfb, x11vnc', tigervnc: 'tigervnc', kasmvnc: 'kasmvnc', turbovnc: 'turbovnc', gles2: 'wayland, sway on the GPU (gles2)', pixman: 'wayland, sway in software (pixman): what they get' };
  const S = [...new Set(NAT.runs.map((r) => r.config))].map((k) => ({ key: k, label: NL[k] || k, short: k }));
  const CFG = Object.fromEntries(S.map((x) => [x.key, x.key]));
  const APPN = { signal: 'Signal Desktop', telegram: 'Telegram Desktop', haveno: 'Haveno (X app; satellite on wayland)' };
  h('h2', '', 'Native apps: Signal Desktop, Telegram Desktop, Haveno', root);
  h('p', 'note', 'Each in its sandbox (packages/sandbox) with no network and a fresh home, never signed in: to its first screen. ' + NAT.reps + ' repetitions, configurations in alternating order. The app has no render node inside its sandbox, so it draws in software on every configuration; only the compositor differs. “Screen stack” is the display and live view: Xvfb and x11vnc, or sway and wayvnc (and xwayland-satellite with its Xwayland for Haveno).', root);
  legend(root, S);
  const grid = h('div', 'grid2', undefined, root);
  const apps = [...new Set(NAT.runs.map((r) => r.app))];
  const M = [
    { label: 'Sandbox up (screen, bus, sound)', unit: 'ms', better: 'lower', get: (r) => r.sandboxMs },
    { label: 'Start → the app’s first picture', unit: 'ms', better: 'lower', get: (r) => r.firstPictureMs },
    { label: 'Screen stack memory (PSS)', unit: 'MB', better: 'lower', get: (r) => r.idle.screenPssMB },
    { label: 'Whole sandbox memory (PSS)', unit: 'MB', better: 'lower', get: (r) => r.idle.pssMB },
    { label: 'Idle CPU, whole sandbox', unit: '% of one core', better: 'lower', get: (r) => r.idle.cpu },
  ];
  const rows = [];
  for (const m of M) {
    const groups = apps.map((a) => ({ label: APPN[a] || a, vals: Object.fromEntries(S.map((s) => [s.key, NAT.runs.filter((r) => r.app === a && r.config === CFG[s.key] && !r.error).map(val(m.get)).filter((v) => v !== undefined)])) }));
    groupCard(grid, m, groups, S);
    for (const g of groups) rows.push([g.label + ': ' + m.label + ' (' + m.unit + ')', ...S.map((s) => fmt(med(g.vals[s.key])))]);
  }
  for (const a of apps) rows.push([(APPN[a] || a) + ': input reached it (screens that changed)', ...S.map((s) => { const rs = NAT.runs.filter((r) => r.app === a && r.config === CFG[s.key] && r.input); return rs.filter((r) => r.input.changedPixels > 0).length + ' of ' + rs.length; })]);
  h('h3', '', 'Native apps: every median', root).style.margin = '16px 0 6px';
  smallTable(root, ['Measure', ...S.map((s) => s.short)], rows);
  const failed = NAT.runs.filter((r) => r.error);
  for (const r of failed) h('p', 'note', r.app + ' on ' + r.config + ' (repetition ' + (r.rep + 1) + ') failed: ' + r.error, root);
}

// The live view over a constrained link and CPU.
const LNK = JSON.parse(document.getElementById('link-data').textContent);
if (LNK && LNK.runs.length) {
  const root = document.getElementById('link');
  const S = (LNK.backends || ['x11', 'wayland']).map((k) => ({ key: k, label: LABEL[k] || k, short: k }));
  h('h2', '', 'The live view over a slow link, and with little CPU', root);
  h('p', 'note', 'A viewer asking for what the manager’s live view (noVNC) asks for: Tight first, quality 6, compression 2, continuous updates and fences where the server has them (wayvnc does, x11vnc does not). Between it and the VNC server, a link shaped with tc in a network namespace of its own (netem for delay and loss, tbf for bandwidth with a 50 ms queue), with the manager’s side paced as the manager now paces it. The CPU conditions put the display processes alone (Xvfb and x11vnc, or sway and wayvnc) in a systemd scope with a CPU quota; Chromium is not limited. ' + LNK.reps + ' repetitions; each number is a median.', root);
  legend(root, S);
  const conds = LNK.conditions.filter((c) => !c.bridge || c.bridge === 'paced');
  const runs = LNK.runs.filter((r) => !r.error);
  const grid = h('div', 'grid2', undefined, root);
  const LM = [
    { label: 'Full-screen animation: frames delivered', unit: 'per s', better: 'higher', get: (r) => r.anim.fps, how: 'the page draws 60' },
    { label: 'Page scrolling: frames delivered', unit: 'per s', better: 'higher', get: (r) => r.scroll.fps },
    { label: '720p video: frames delivered', unit: 'per s', better: 'higher', get: (r) => r.video.fps, how: 'the video has 30' },
    { label: 'Click to photon through the link', unit: 'ms', better: 'lower', get: (r) => r.click.clickToPhoton.median },
    { label: 'Connect → the whole screen (a still page of text)', unit: 'ms', better: 'lower', get: (r) => r.first.ms },
    { label: 'Full-screen animation: bytes', unit: 'MB/s', better: 'lower', get: (r) => r.anim.bytesPerS / 1e6 },
    { label: 'Full-screen animation: display processes’ CPU', unit: '% of one core', better: 'lower', get: (r) => r.anim.cpu },
  ];
  const rows = [];
  for (const m of LM) {
    const groups = conds.map((c) => ({ label: c.label, vals: Object.fromEntries(S.map((s) => [s.key, runs.filter((r) => r.condition === c.name && r.backend === s.key).map(val(m.get)).filter((v) => v !== undefined)])) }));
    groupCard(grid, m, groups, S);
  }
  for (const c of conds) {
    const by = (b, f) => fmt(med(runs.filter((r) => r.condition === c.name && r.backend === b).map(val(f)).filter((v) => v !== undefined)));
    rows.push([c.label, ...S.flatMap((s) => [by(s.key, (r) => r.anim.fps), by(s.key, (r) => r.scroll.fps), by(s.key, (r) => r.video.fps), by(s.key, (r) => r.click.clickToPhoton.median), by(s.key, (r) => r.first.ms), by(s.key, (r) => r.first.bytes / 1e3)])]);
  }
  h('h3', '', 'Every median', root).style.margin = '16px 0 6px';
  smallTable(root, ['Condition', ...S.flatMap((s) => [s.short + ' anim fps', 'scroll fps', 'video fps', 'click→photon ms', 'whole screen ms', 'its KB'])], rows);

  h('h3', '', 'The links, measured', root).style.margin = '16px 0 6px';
  h('p', 'note', 'Each shaped link checked before use, through the same shaper to a test server: TCP goodput over 3 s and the round trip of one byte. Both directions share the bandwidth (the viewer’s side sends only requests, input and acknowledgements).', root);
  smallTable(root, ['Condition', 'goodput Mbit/s', 'round trip ms (median)', 'p90'], LNK.checks.filter((k) => !k.error).map((k) => [(LNK.conditions.find((c) => c.name === k.name) || {}).label || k.name, fmt(k.goodputMbit), fmt(k.rttMs), fmt(k.rttP90)]));

  const eager = LNK.conditions.filter((c) => c.bridge === 'eager');
  if (eager.length) {
    h('h3', '', 'Before the manager paced its live view', root).style.margin = '16px 0 6px';
    h('p', 'note', 'The same conditions with the manager’s side as it was: every chunk read from the VNC socket passed on at once, its WebSocket buffering without limit until Bun drops what is past 16 MB. Dropped bytes break the RFB stream: the page’s viewer would fail or show garbage.', root);
    smallTable(root, ['Condition', 'backend', 'largest buffer MB', 'dropped MB', 'anim fps', 'click→photon ms'], eager.flatMap((c) => S.map((s) => { const rs = runs.filter((r) => r.condition === c.name && r.backend === s.key); return [c.label, s.short, fmt(med(rs.map((r) => (r.link?.maxBuffered ?? NaN) / 1e6))), fmt(med(rs.map((r) => (r.link?.dropped ?? NaN) / 1e6))), fmt(med(rs.map(val((r) => r.anim.fps)).filter((v) => v !== undefined))), fmt(med(rs.map(val((r) => r.click.clickToPhoton.median)).filter((v) => v !== undefined)))]; })));
  }
  const encRuns = runs.filter((r) => r.enc);
  if (encRuns.length) {
    h('h3', '', 'Other encodings, full-screen animation (and scrolling)', root).style.margin = '16px 0 6px';
    h('p', 'note', 'Tight is what noVNC asks for first (after Open H.264, which neither server sends as set up). ZRLE alone asked for instead; on wayland also a second wayvnc with -g (its GPU features), asked for Open H.264 first as noVNC would.', root);
    const rowsE = [];
    for (const c of LNK.conditions.filter((c) => c.encodings)) for (const s of S) {
      const rs = runs.filter((r) => r.condition === c.name && r.backend === s.key);
      const line = (name) => {
        const of = (r) => (name === 'tight' ? r.anim : name === 'tightScroll' ? r.scroll : r.enc && r.enc[name]);
        const pick = (f) => rs.map(val((r) => (of(r) && !of(r).error ? f(of(r)) : undefined))).filter((x) => x !== undefined);
        const fps = pick((o) => o.fps);
        return fps.length ? [c.label, s.short, name, fmt(med(fps)), fmt(med(pick((o) => o.bytesPerS / 1e6))), fmt(med(pick((o) => o.cpu)))] : null;
      };
      for (const l of [line('tight'), line('zrle'), line('webp'), line('h264'), line('tightScroll'), line('zrleScroll'), line('webpScroll')]) if (l) rowsE.push(l);
      if (s.key === 'wayland') for (const r of rs) if (r.enc?.h264?.error) rowsE.push([c.label, s.short, 'h264', r.enc.h264.error, '', '']);
    }
    smallTable(root, ['Condition', 'backend', 'encoding', 'frames/s', 'MB/s', 'display CPU %'], rowsE);
  }
}

// Real programs on test accounts (scripts/bench-lab.ts): one table per program, a column per backend.
const LAB = JSON.parse(document.getElementById('lab-data').textContent);
if (LAB && LAB.runs.length) {
  const root = document.getElementById('lab');
  h('h2', '', 'Real programs, on test accounts', root);
  h('p', 'note', LAB.note || '', root);
  const LB = [...new Set(LAB.runs.map((r) => r.backend))];
  const LM = [
    ['Restart → online (manager)', 's', (r) => r.onlineMs / 1000],
    ['Restart → usable (online, the live view settled 2 s)', 's', (r) => r.usableMs / 1000],
    ['Idle CPU, whole sandbox', '%', (r) => r.idle.cpu],
    ['Idle CPU, display stack', '%', (r) => r.idle.screenCpu],
    ['Memory, whole sandbox (PSS)', 'MB', (r) => r.idle.pssMB],
    ['Memory, display stack (PSS)', 'MB', (r) => r.idle.screenPssMB],
    ['Interacting: frames to the live view', 'per s', (r) => r.interact.fps],
    ['Interacting: bytes', 'KB/s', (r) => r.interact.bytesPerS / 1e3],
    ['Interacting: CPU, whole sandbox', '%', (r) => r.interact.cpu],
    ['5 Mbit/s, 50 ms: first whole screen', 's', (r) => r.slow.bw5rtt50.firstWholeMs / 1000],
    ['5 Mbit/s, 50 ms: frames interacting', 'per s', (r) => r.slow.bw5rtt50.fps],
    ['1 Mbit/s, 150 ms: first whole screen', 's', (r) => r.slow.bw1rtt150.firstWholeMs / 1000],
    ['1 Mbit/s, 150 ms: frames interacting', 'per s', (r) => r.slow.bw1rtt150.fps],
  ];
  for (const r of LAB.runs) r.program ??= r.label;
  for (const prog of [...new Set(LAB.runs.map((r) => r.program))]) {
    h('h3', '', prog, root).style.margin = '16px 0 6px';
    const rows = LM.map(([label, unit, f]) => [label + ' (' + unit + ')', ...LB.map((b) => { const v = LAB.runs.filter((r) => r.program === prog && r.backend === b && !r.error).map(val(f)).filter((x) => x !== undefined); return v.length ? fmt(med(v)) + (v.length > 1 ? ' (' + v.length + ')' : '') : '–'; })]);
    smallTable(root, ['Measure', ...LB], rows);
    for (const r of LAB.runs.filter((r) => r.program === prog && r.error)) h('p', 'note', prog + ' on ' + r.backend + ': ' + r.error, root);
  }
}

// What the numbers do not say on their own.
const notes = document.getElementById('notes');
const w30 = pick('wayland', (r) => r.vnc.anim30.fps), w30cpu = pick('wayland', (r) => r.vnc.anim30.serverCpu), w60 = pick('wayland', (r) => r.vnc.anim.fps), w60cpu = pick('wayland', (r) => r.vnc.anim.serverCpu);
const i30 = pick('wayland', (r) => r.vnc.idle30.serverCpu), i60 = pick('wayland', (r) => r.vnc.idle.serverCpu);
const gpu = pick('wayland', (r) => r.vnc.animGpu.fps), gpuCpu = pick('wayland', (r) => r.vnc.animGpu.serverCpu);
const h264 = runs.filter((r) => r.backend === 'wayland').map((r) => r.vnc?.animH264).filter(Boolean);
const toEvent = pick('x11', (r) => r.input.toEvent.median);
const renderer = runs.find((r) => r.webgl?.renderer)?.webgl.renderer;
const N = [
  w30.length && \`The sandbox’s wayvnc (-f 60) delivered a median \${fmt(med(w60))} frames a second of the full-screen animation at \${fmt(med(w60cpu))}% of one core; a second wayvnc on the same compositor at its own default (-f 30), \${fmt(med(w30))} at \${fmt(med(w30cpu))}%. On a still page with a viewer connected: \${fmt(med(i60))}% at 60, \${fmt(med(i30))}% at 30 (it sends only what changed).\`,
  gpu.length && \`wayvnc with -g (its GPU features) and ZRLE: \${fmt(med(gpu))} frames a second at \${fmt(med(gpuCpu))}% of one core, against \${fmt(med(w60))} at \${fmt(med(w60cpu))}% without.\`,
  h264.length && (h264.every((x) => !x.fps) ? \`wayvnc’s Open H.264 (-g, VA-API through FFmpeg) delivered nothing here: the encoder took the first frame and never finished it, with wayvnc at 100% of a core (\${(h264[0].serverSaid ?? []).slice(-1)[0] ?? 'no message'}). Not usable on this machine as it stands.\` : \`wayvnc’s Open H.264 (-g): \${fmt(med(h264.map((x) => x.fps)))} frames a second, \${fmt(med(h264.map((x) => x.bytesPerS / 1e6)))} MB/s.\`),
  toEvent.length && \`On X, Chromium stamps a pointer event with the X server’s millisecond clock, so its event time can come out before the press was sent (median press → event time \${fmt(med(toEvent))} ms on x11). The handler’s own time is used above.\`,
  renderer && \`WebGL ran on \${renderer} on every backend (Chromium renders on the GPU whatever the display is), so its frame rate shows only whether one falls short of 60.\`,
  'Typing uses each backend’s own path with the same 35 ms between keys: xdotool type on X, RFB key presses on Wayland (each press and release its own message, with a short wait for modifiers), so the difference is the input path, not the screen.',
  'CPU is from /proc/<pid>/stat over the span (100% = one core); memory from /proc/<pid>/smaps_rollup. All of a sandbox’s processes are counted: Chromium and its helpers, the display server, the VNC server, and on Wayland the session bus every sandbox gets (and with sharing on, PipeWire, WirePlumber and the portals).',
].filter(Boolean);
for (const n of N) h('li', '', n, notes);
</script></body></html>`;

writeFileSync(join(outDir, 'index.html'), page);
console.log(join(outDir, 'index.html'));
