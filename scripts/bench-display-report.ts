#!/usr/bin/env bun
/**
 * The page for scripts/bench-display.ts's numbers: one HTML file, the results inside it, charts drawn by the page
 * itself (no network), light and dark.
 *
 *   bun scripts/bench-display-report.ts <results.json> <out dir>
 *
 * Writes <out dir>/index.html and a copy of the results as <out dir>/results.json.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('usage: bun scripts/bench-display-report.ts <results.json> <out dir>');
  process.exit(2);
}
const results = JSON.parse(readFileSync(input, 'utf8'));
mkdirSync(outDir, { recursive: true });
copyFileSync(input, join(outDir, 'results.json'));

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X11 vs Wayland sandboxes</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10);
  --x11: #2a78d6; --wayland: #eb6834;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
    --x11: #3987e5; --wayland: #d95926;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
  --x11: #3987e5; --wayland: #d95926;
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
<h1>X11 vs Wayland sandboxes</h1>
<div class="sub" id="sub"></div>
<div class="legend" aria-label="legend"><span><i class="sw" style="background:var(--x11)"></i>x11: Xvfb, x11vnc, xdotool, import</span><span><i class="sw" style="background:var(--wayland)"></i>wayland: sway, wayvnc, RFB input, grim</span></div>
<div id="sections"></div>
<h2>Every number</h2>
<p class="note">Median over the repetitions, and the lowest and highest. Each repetition is a fresh sandbox; the order of the two backends alternates between repetitions.</p>
<div class="tablewrap"><table id="table"><thead><tr><th>Measure</th><th>x11 median</th><th>x11 range</th><th>wayland median</th><th>wayland range</th><th>Better</th></tr></thead><tbody></tbody></table></div>
<h2>Notes</h2>
<ul class="notes" id="notes"></ul>
<div id="tip" role="status"></div>
</main>
<script type="application/json" id="data">${JSON.stringify(results).replace(/</g, '\\u003c')}</script>
<script>
const R = JSON.parse(document.getElementById('data').textContent);
const B = ['x11', 'wayland'];
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
  { title: 'The live view (VNC)', note: 'A viewer of our own on the live view’s socket asks for every frame (ZRLE first), for 5 s. The sandbox’s wayvnc holds itself to 30 frames a second; x11vnc has no such cap.', metrics: [
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
  const W = 260, rowH = 30, padL = 64, padR = 52, H = rowH * 2 + 18;
  const max = Math.max(...B.flatMap((b) => vals[b]), 0) || 1;
  const x = (v) => padL + (v / max) * (W - padL - padR);
  const svg = el('svg', { viewBox: \`0 0 \${W} \${H}\`, role: 'img', 'aria-label': m.label + ': ' + B.map((b) => b + ' ' + fmt(med(vals[b])) + ' ' + m.unit).join(', ') }, card);
  el('line', { x1: padL, x2: padL, y1: 2, y2: rowH * 2 + 2, stroke: 'var(--axis)', 'stroke-width': 1 }, svg);
  B.forEach((b, i) => {
    const v = vals[b];
    const y = 6 + i * rowH, bh = 18;
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
  const ok = R.scale.filter((s) => !s.error);
  const SC = [
    { label: 'Memory of all (PSS)', unit: 'MB', get: (s) => s.pssMB },
    { label: 'Memory per sandbox (PSS)', unit: 'MB', get: (s) => s.perSandboxPssMB },
    { label: 'Time until every first page ran', unit: 'ms', get: (s) => s.wallMs },
    { label: 'Idle CPU of all', unit: '% of one core', get: (s) => s.idleCpu },
  ];
  for (const m of SC) {
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
  const W = 260, H = 150, padL = 44, padR = 56, padT = 8, padB = 24;
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
  if (ends.length === 2 && ends[1].y - ends[0].y < 13) { const mid = (ends[0].y + ends[1].y) / 2; ends[0].y = mid - 7; ends[1].y = mid + 7; }
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

// What the numbers do not say on their own.
const notes = document.getElementById('notes');
const w60 = pick('wayland', (r) => r.vnc.anim60.fps), w60cpu = pick('wayland', (r) => r.vnc.anim60.serverCpu);
const h264 = runs.filter((r) => r.backend === 'wayland').map((r) => r.vnc?.animH264).filter(Boolean);
const toEvent = pick('x11', (r) => r.input.toEvent.median);
const renderer = runs.find((r) => r.webgl?.renderer)?.webgl.renderer;
const N = [
  w60.length && \`wayvnc told to send up to 60 frames a second (a second wayvnc on the same compositor, -f 60) delivered a median \${fmt(med(w60))} frames a second of the full-screen animation, at \${fmt(med(w60cpu))}% of one core: the 30 above is wayvnc’s default cap, not a limit of the backend.\`,
  h264.length && (h264.every((x) => !x.fps) ? \`wayvnc’s Open H.264 (-g, VA-API through FFmpeg) delivered nothing here: the encoder took the first frame and never finished it, with wayvnc at 100% of a core (\${(h264[0].serverSaid ?? []).slice(-1)[0] ?? 'no message'}). Not usable on this machine as it stands.\` : \`wayvnc’s Open H.264 (-g): \${fmt(med(h264.map((x) => x.fps)))} frames a second, \${fmt(med(h264.map((x) => x.bytesPerS / 1e6)))} MB/s.\`),
  toEvent.length && \`On X, Chromium stamps a pointer event with the X server’s millisecond clock, so its event time can come out before the press was sent (median press → event time \${fmt(med(toEvent))} ms on x11). The handler’s own time is used above.\`,
  renderer && \`WebGL ran on \${renderer} on both backends; both hold the display’s 60 frames a second, so the frame rate shows only that neither falls short.\`,
  'Typing uses each backend’s own path with the same 35 ms between keys: xdotool type on X, RFB key presses on Wayland (each press and release its own message, with a short wait for modifiers), so the difference is the input path, not the screen.',
  'CPU is from /proc/<pid>/stat over the span (100% = one core); memory from /proc/<pid>/smaps_rollup. All of a sandbox’s processes are counted: Chromium and its helpers, the display server, the VNC server, and on Wayland the session bus every sandbox gets (and with sharing on, PipeWire, WirePlumber and the portals).',
].filter(Boolean);
for (const n of N) h('li', '', n, notes);
</script></body></html>`;

writeFileSync(join(outDir, 'index.html'), page);
console.log(join(outDir, 'index.html'));
