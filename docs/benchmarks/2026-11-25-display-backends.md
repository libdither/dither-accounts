# Display backends, measured (2026-11-25)

The five display backends of docs/browser.md ("Display backends") side by side: `x11` (Xvfb and x11vnc), `tigervnc`
and `kasmvnc` (an Xvnc), `wayland` (sway and wayvnc) and `wayland-tigervnc` (sway and w0vncserver). What
docs/browser.md concludes from them is in its "What the benchmarks found"; this page is the numbers, how they were
taken, and what they leave out. Each cell is the range over the repetitions, lowest to highest: with two or three
repetitions on a shared machine a median would claim more than the runs can say.

## What ran

- **Code:** commit `7175670a6ef7` of this repository (the branch that added the Xvnc backends), every backend in one
  session. The page's tables come from the JSON in [`2026-11-25-display-backends/`](2026-11-25-display-backends/) by
  `scripts/bench-tables.ts` (below).
- **Programs,** all from the pinned nixpkgs (`nix/pin.json`, `2786a2a7`), prepared with
  `bun scripts/prepare-bins.ts --out <dir> --tests`: Xvfb 21.1.24, x11vnc 0.9.17, TigerVNC's Xvnc 1.16.2, KasmVNC's
  Xvnc 1.5.2-dither.3 and w0vncserver 1.16.2-dither.2 (both from this project's forks, nix/README.md "Forks"), sway
  1.12, wayvnc 0.10.2, grim 1.5.0, xdotool, ImageMagick 7.1.2. Chromium 155 (the machine's own).
- **Machine:** a 16-thread desktop with a discrete GPU (Chromium's WebGL ran on it through ANGLE on Vulkan), shared
  with a desktop session and other work: the 1-minute load as each repetition began is given with each table.
  1280×800 screens.
- **Viewer:** the benchmarks' own RFB client (`packages/browser/test/rfb-viewer.ts`), asking for what noVNC asks
  for unless a row says otherwise. KasmVNC speaks standard RFB to it, as to noVNC.

## The JSON, and running it again

The files in [`2026-11-25-display-backends/`](2026-11-25-display-backends/) are what the runs below wrote, passed
through `bun scripts/bench-scrub.ts <in> <out>`, which leaves out what would describe the machine (the CPU and GPU
models, the memory size, the native apps' own log lines) and puts `lab-1`… for the lab's account ids. The tables
here come from them:

```
D=docs/benchmarks/2026-11-25-display-backends
bun scripts/bench-tables.ts --results $D/results.json --scale $D/scale.json --link $D/link-a.json,$D/link-b.json \
  --native $D/native.json --backends x11,tigervnc,kasmvnc,wayland,wayland-tigervnc
bun scripts/bench-tables.ts --lab $D/lab.json --backends tigervnc,wayland,wayland-tigervnc
```

To take them again:

```
bun scripts/prepare-bins.ts --out /tmp/bins --tests
export DITHER_BINS=/tmp/bins
O=~/.cache/da-bench/<round>
bun scripts/bench-display.ts --out $O/results.json --reps 3 --only start,idle,vnc,input,typing,share,video,webgl,shot \
  --backends x11,tigervnc,kasmvnc,wayland,wayland-tigervnc
bun scripts/bench-display.ts --out $O/scale.json --reps 1 --only scale --scale 1,5,10 \
  --backends tigervnc,kasmvnc,wayland,wayland-tigervnc
# The slow links in two halves, each under two hours here; bench-tables.ts merges them.
bun scripts/bench-link.ts --out $O/link-a.json --reps 2 --backends tigervnc,kasmvnc,wayland,wayland-tigervnc \
  --only base,bw20,bw5,bw1,rtt50
bun scripts/bench-link.ts --out $O/link-b.json --reps 2 --backends tigervnc,kasmvnc,wayland,wayland-tigervnc \
  --only rtt150,bw5rtt50,bw1rtt150,loss1,cpu20
bun scripts/bench-native.ts --out $O/native.json --reps 2 --configs x11,tigervnc,kasmvnc,pixman,w0-pixman
bun scripts/bench-tables.ts --results $O/results.json --scale $O/scale.json --link $O/link-a.json,$O/link-b.json \
  --native $O/native.json \
  --backends x11,tigervnc,kasmvnc,wayland,wayland-tigervnc
bun scripts/bench-display-report.ts $O/results.json <out dir> --scale $O/scale.json --native $O/native.json \
  --link $O/link-a.json,$O/link-b.json
```

The lab table (signed-in test accounts) is from an earlier session the same day, on a test manager:

```
bun scripts/bench-lab.ts --url <test manager> --data <its data dir> --accounts <ids> \
  --backends tigervnc,wayland,wayland-tigervnc
bun scripts/bench-tables.ts --lab lab.json --backends tigervnc,wayland,wayland-tigervnc
```

x11 is left out of the many-at-once and slow-link runs here. Many x11 sandboxes take the machine's System V shared
memory segments (about 40 each, from a limit of 4096 shared by everything on it), and the machine had under 500
free; its slow-link numbers are in the earlier round (below).

## The numbers

Synthetic pages (scripts/bench-display.ts): 3 repetitions per backend, 1-minute load 2.90–7.35 as each began.

|  | `x11` | `tigervnc` | `kasmvnc` | `wayland` | `wayland-tigervnc` |
| --- | --- | --- | --- | --- | --- |
| start → live view answers RFB (ms) | 127–630 | 68.7–1,045 | 79.7–545 | 284–989 | 271–436 |
| start → first page ran (ms) | 529–1,083 | 470–1,777 | 481–1,173 | 737–1,667 | 780–1,113 |
| idle: display programs, PSS (MB) | 28.6–28.7 | 25–25.1 | 22.5–22.9 | 68.9–69.1 | 71.2–71.3 |
| idle: the sandbox, USS (MB) | 164–181 | 163–164 | 161–162 | 185–202 | 183–199 |
| idle: CPU (% of a core) | 3.10–3.49 | 3.29–3.49 | 3–3.20 | 3.20–3.69 | 3.10–3.20 |
| animation, ZRLE: frames/s, server CPU % | 38.6–39.2, 14.8–15.9 | 55.2–56.9, 30.6–39.3 | 17.8–18.7, 31.8–34.7 | 56–58.2, 71.2–75.8 | 57.3–58, 36.6–39.7 |
| animation, Tight: frames/s, MB/s, server CPU % | 32.3–34.5, 2.62–2.80, 25.6–29.4 | 54.7–56.5, 3.94–3.98, 47.7–60.5 | 54.5–57.4, 1.60–1.70, 58–71.2 | 55.6–58.8, 12.3–12.8, 34.6–45.8 | 54.1–58, 3.94–4.07, 52.5–67.7 |
| scrolling, Tight: frames/s, MB/s | 29.3–30.8, 2.79–2.96 | 55.1–58.4, 5.53–5.54 | 55.2–58.8, 2.60–2.66 | 58–58.8, 14.7–14.8 | 57.7–58, 5.64–5.65 |
| 720p video, Tight: frames/s, MB/s | 31.9–34.4, 2.69–2.73 | 30–38.9, 2.50–2.53 | 29.7–30, 3.68–3.73 | 28.1–28.3, 2.97–3 | 33.7–38.7, 2.39–2.42 |
| RFB press → page handler (ms, median of 20) | 8.55–8.99 | 0.80–1.01 | 0.83–0.89 | 0.83–0.99 | 0.99–1.61 |
| click to photon (ms, median of 20) | 72.8–79.3 | 28–31.8 | 29.3–29.6 | 27.2–28.6 | 19.2–28.9 |
| typing, 35 ms a key (chars/s) | 28.1 | 28.1 | 28.1–28.2 | 16.6 | 16.5–16.6 |
| screen share: frames/s, drawn → decoded ms, CPU % | 20.7–24.7, 82.8–98.9, 137–154 | 23.1–24.9, 97.2–97.4, 140–153 | 24.3–25.5, 83–85.9, 140–142 | 24.9–27, 115–125, 106–119 | 18.7–25.7, 128–130, 118–154 |
| 720p VP9 in Chromium: dropped %, CPU % | 0–0.66, 58.1–62.6 | 0, 58.7–62.6 | 0, 57.7–64.6 | 3.64–5.96, 25.3–28.3 | 4.64–5.63, 30.2–34.6 |
| WebGL: frames/s, CPU % | 60, 92.4–95.9 | 60, 90.8–105 | 60, 91.9–103 | 61.1–61.3, 26–31.1 | 60.7–61.1, 45.3–46.3 |
| screenshot (ms, median of 10) | 86.2–110 | 87.1–96.5 | 88.8–99.2 | 32.6–47.9 | 32.6–33.9 |

Sandboxes started at once (bench-display.ts --only scale): all started (s), then USS per sandbox (MB) and System V shm
segments held by all of them; one run each.

| at once | `tigervnc` | `kasmvnc` | `wayland` | `wayland-tigervnc` |
| --- | --- | --- | --- | --- |
| 1 | 0.49 s, 162 MB, 0 shm | 0.52 s, 160 MB, 0 shm | 0.74 s, 185 MB, 0 shm | 0.82 s, 182 MB, 0 shm |
| 5 | 1.13 s, 132 MB, 0 shm | 1.17 s, 132 MB, 0 shm | 1.21 s, 159 MB, 0 shm | 1.43 s, 159 MB, 0 shm |
| 10 | 2.70 s, 132 MB, 0 shm | 1.81 s, 131 MB, 0 shm | 2.04 s, 159 MB, 0 shm | 1.93 s, 159 MB, 0 shm |

The live view through a shaped link (scripts/bench-link.ts, as noVNC asks: Tight first, quality 6): frames/s of the
animation / of the video, then click to photon (ms); 2 repetitions, 1-minute load 1.91–7.74.

| link | `tigervnc` | `kasmvnc` | `wayland` | `wayland-tigervnc` |
| --- | --- | --- | --- | --- |
| unlimited | 52.1–58.2 / 29.8–39.5, 28.4–28.5 ms | 55.5–56.4 / 29.8, 23.8 ms | 56.3–58.3 / 28.1–28.5, 7.73–8.62 ms | 57.2–58.1 / 37–38.8, 16.5–17.3 ms |
| 20 Mbit/s | 28.8 / 28.4–28.8, 25.1–27.6 ms | 55.8–56 / 18.8, 23.6–26.1 ms | 10.9 / 21.6–21.7, 50.8–51.3 ms | 28.3–28.6 / 27.9–28.6, 18.4–21.1 ms |
| 5 Mbit/s | 7.30–7.50 / 6.70–6.71, 25.6–26.8 ms | 27.6 / 4.55, 23.7 ms | 2.76–2.77 / 4.35, 193 ms | 7.08–7.12 / 6.30–6.72, 17–20.5 ms |
| 1 Mbit/s | 1.58–2.17 / 1.58, 25.7–27.9 ms | 5.92 / 0.99, 23.3–24.4 ms | 0.59 / 0.59–0.79, 1,171 ms | 1.38–1.57 / 1.19–1.78, 16.8–18.2 ms |
| 50 ms | 54.6–58.8 / 42.3–44.2, 75.2–77.1 ms | 56.3–56.4 / 29.8–30, 73.9–74 ms | 57.1–58.3 / 27.8–28.3, 58.2–58.8 ms | 56.7–57 / 39.5–42.7, 67.1–68.4 ms |
| 150 ms | 46–50.3 / 29.9–39.9, 176–179 ms | 55.4–55.6 / 30, 174–176 ms | 45.6–51.4 / 25.1–26.3, 158–159 ms | 44 / 31.6–32, 167–168 ms |
| 5 Mbit/s, 50 ms | 5.93–6.89 / 4.94–5.33, 74.9–76.2 ms | 27–27.1 / 4.15–4.54, 73.7–74.7 ms | 1.97–1.98 / 2.76–2.97, 301 ms | 6.91–6.92 / 4.54–4.55, 66.5–68.4 ms |
| 1 Mbit/s, 150 ms | 1.18–1.19 / 0.79–0.99, 175–176 ms | 5.52–5.73 / 0.79, 174 ms | 0.39–0.40 / 0.59, 1,593–1,637 ms | 1.19–1.58 / 0.79, 167 ms |
| 20 Mbit/s, 50 ms, 1% loss | 3.95–4.53 / 3.16–3.75, 75.6–77.6 ms | 18–18.1 / 2.97–3.16, 73.7–76.7 ms | 1.38 / 1.97–2.17, 176–358 ms | 3.56–4.74 / 2.37–5.14, 67.8–100 ms |
| display at 20% of a core | 21.7–24.3 / 24.9–30.6, 25–25.8 ms | 13–13.8 / 12.3–12.6, 24 ms | 16.2–17 / 27.9–28.1, 8.10–10.1 ms | 17.4–19.6 / 24.5–26.1, 16.9 ms |

Bytes on an unlimited link: the first whole screen of a still page of text (KB), and the animation (MB/s).

|  | `tigervnc` | `kasmvnc` | `wayland` | `wayland-tigervnc` |
| --- | --- | --- | --- | --- |
| first whole screen (KB) | 94.9 | 53.2–53.3 | 270 | 94.1 |
| animation (MB/s) | 3.63–3.95 | 1.66–1.71 | 12.7–12.8 | 4.07 |

Native apps, never signed in (scripts/bench-native.ts): the display programs' memory (PSS, MB), then start → the app's
first picture (s); 2 repetitions.

|  | `x11` | `tigervnc` | `kasmvnc` | `pixman` | `w0-pixman` |
| --- | --- | --- | --- | --- | --- |
| signal | 29.2–29.4 MB, 12.8–24.1 s | 25.2–25.4 MB, 11.9–12.6 s | 24–24.1 MB, 12.1–12.7 s | 52.3–52.4 MB, 12.1–13 s | 50 MB, 12.1–13 s |
| telegram | 24.7–25.4 MB, 2.83–5.69 s | 21.2 MB, 2.80–2.92 s | 19.1–19.7 MB, 2.83–2.86 s | 52.7–54.8 MB, 2.71–2.76 s | 52.4–52.5 MB, 2.68–2.71 s |
| haveno | 24.4–24.6 MB, 3.10–3.56 s | 21–21.2 MB, 2.95–2.97 s | 19.2–19.4 MB, 2.93–2.99 s | 79.8 MB, 2.77–3.34 s | 78.4 MB, 2.70–2.71 s |

Input reached the app in 30 of 30 runs.

`pixman` is sway drawing in software with wayvnc (`wayland`, as native apps get it), `w0-pixman` the same with
w0vncserver (`wayland-tigervnc`).

What they say, in short (docs/browser.md, "What the benchmarks found", has the rest):

- Every backend but x11 passes a click on within a millisecond; x11vnc takes 8–9 ms, and its change comes back
  70–80 ms after the press against 20–30 ms.
- The Xvnc servers and w0vncserver send a third of wayvnc's bytes for the same animation, and KasmVNC under half of
  theirs; on a thin link that is the difference between a usable live view and not: at 5 Mbit/s with 50 ms, KasmVNC
  draws the animation at 27 frames a second, TigerVNC and w0vncserver at 6–7, wayvnc at 2, and a click comes back in
  65–76 ms on the first three and 300 ms on wayvnc.
- With nothing in the way, wayvnc answers a click fastest (8–9 ms). With the display held to a fifth of a core,
  TigerVNC keeps the most frames (22–24 a second), w0vncserver and wayvnc 16–20, KasmVNC 13.
- sway costs about 45 MB more than an Xvnc while idle, and about 27 MB more per sandbox when many run at once; it
  pays that back on GPU work: WebGL, VP9 video and screenshots cost a third to a half of what they cost on X.
  w0vncserver copies each frame through shared memory, so on a GPU screen it costs more than wayvnc (WebGL 45% of a
  core against 26–31%).
- Native apps behave the same on every X backend (input reached every one in every run); the display costs 19–29 MB
  on X against 50–80 MB on sway, and the first picture comes as soon on each.
- No backend but x11 holds a System V shared memory segment.

## An earlier round the same day

Before the Xvnc backends moved onto the backend list and KasmVNC onto its fork, with x11 and TurboVNC still in it
(three repetitions, slow links two). It is here for x11's slow-link and many-at-once numbers, which the session
above leaves out:

Sandboxes started at once (bench-display.ts --only scale): all started (s), then USS per sandbox (MB) and System V shm
segments held by all of them; one run each.

| at once | `x11` |
| --- | --- |
| 1 | 0.60 s, 157 MB, 42 shm |
| 5 | 1.55 s, 139 MB, 210 shm |

The live view through a shaped link (scripts/bench-link.ts, as noVNC asks: Tight first, quality 6): frames/s of the
animation / of the video, then click to photon (ms); 2 repetitions, 1-minute load 2.30–9.53.

| link | `x11` |
| --- | --- |
| unlimited | 33.4–34.8 / 32.2–34.3, 46.6–48.7 ms |
| 20 Mbit/s | 20–20.1 / 16.8–17.5, 46.6–47.4 ms |
| 5 Mbit/s | 6.88–6.89 / 5.05–5.12, 55.4–55.6 ms |
| 1 Mbit/s | 1.54–1.57 / 1.18–1.38, 94.6–95.2 ms |
| 50 ms | 16.7–17.1 / 13.6, 147 ms |
| 150 ms | 11.6 / 5.72–5.91, 197–345 ms |
| 5 Mbit/s, 50 ms | 5.31–5.32 / 4.14–4.34, 146–148 ms |
| 1 Mbit/s, 150 ms | 1.58–1.77 / 0.99–1.18, 247–345 ms |
| 20 Mbit/s, 50 ms, 1% loss | 3.71–5.52 / 2.95–3.94, 96.1–147 ms |
| display at 50% of a core | 34.2–35.4 / 33.3–34.4, 46.3–47.4 ms |
| display at 20% of a core | 15.8–17.1 / 17–17.5, 46.6–47.3 ms |

Bytes on an unlimited link: the first whole screen of a still page of text (KB), and the animation (MB/s).

|  | `x11` |
| --- | --- |
| first whole screen (KB) | 103 |
| animation (MB/s) | 2.72–2.83 |

At 5 x11 sandboxes the machine had 31 segments left of its 4096; 10 and 20 x11 sandboxes at once failed earlier the
same way (x11vnc: `shmget: No space left on device`). TurboVNC was measured in that round too and dropped: it matched
TigerVNC's frames for two to four times its Tight bytes and more CPU, and needed `-deferupdate 1` to reach them.
wayvnc's GPU features (`-g`) changed nothing with ZRLE, and its Open H.264 delivered no frame at all on this machine
(the encoder takes the first frame and never finishes it), so the sandbox's wayvnc runs without `-g`.

Signed-in test accounts in the lab (scripts/bench-lab.ts, read-only): 4 accounts (proton, discord), 1 run(s) each,
1-minute load 4.58–24.3; ranges over the accounts.

|  | `tigervnc` | `wayland` | `wayland-tigervnc` |
| --- | --- | --- | --- |
| pointer sweep and clicks: frames/s, MB/s | 4.29–22.2, 0.01–0.41 | 2.35–22, 0.03–0.99 | 11.7–30.6, 0.01–0.33 |
| 5 Mbit/s, 50 ms: frames/s | 5.51–20 | 2.03–10.4 | 11.8–27.5 |
| 1 Mbit/s, 150 ms: frames/s, first whole screen (s) | 10–28.5, 1.72–2.30 | 2.37–4.19, 3.10–3.68 | 16.7–37.2, 1.70–2.29 |
| display programs, PSS (MB) | 19.4–24.8 | 71.3–108 | 58.2–68.1 |
| start → account online (s) | 1–3.66 | 1.06–1.56 | 2.92–4.86 |

## What the benchmarks leave out

Earlier rounds fixed three things in the scripts: a screen counts as started once its live view has said "RFB" (an
Xvnc's socket appears before it answers), the scripts record USS (pages no other process maps) beside PSS (which
moves with whatever else maps the same pages, other Chromiums included), and `bench-lab.ts` records the load and
takes `--first-rep` to go through the backends in another order. Still open:

- Synthetic pages are not apps. The animation, scrolling page, video and WebGL scene are regular and worst-case; an
  app redraws in bursts (a hover, an avatar, a typing dot). The lab run covers two kinds of signed-in browser accounts
  (Proton, Discord), read-only. The native apps (Signal Desktop, Telegram Desktop, Haveno) are measured only on their
  first screen, never signed in. To close: a signed-in Signal Desktop and Telegram Desktop on test accounts in the lab.
- Our viewer is not noVNC. The benchmarks' viewer is a Bun RFB client that counts what arrives and decodes only what
  a measurement reads; frames a second are updates received, not frames drawn, and the cost of decoding JPEG, WebP or
  ZRLE in a browser (on a phone, most of it) is not in them. To close: noVNC in a headless Chromium as the viewer, CPU
  throttled to a phone's, counting its own paints.
- The shaped link is tc on a loopback with a fixed delay and independent random loss: no jitter, reordering,
  Wi-Fi or cellular bursts, and none of the real path's hops (the manager's WebSocket, TLS, a VPN tunnel).
  To close: the same scenes through the manager's live-view WebSocket from another machine, and netem jitter and slot
  models for Wi-Fi and LTE.
- Click to photon ends when the changed pixels reach our viewer's framebuffer: it leaves out the viewer's decode and
  paint and the screen's refresh (16–50 ms more), and the change it waits for is a flat block of colour, cheap to
  encode. To close: the same with noVNC, timed from its input event to the canvas showing the change.
- The machine is shared. Load is taken as a repetition starts, not throughout; a repetition that could not wait for a
  quiet machine is kept and marked busy. To close: sample CPU pressure (`/proc/pressure/cpu`) through each measurement
  and flag the ones it rose in, or pin the benchmark to cores nothing else uses.
- Few repetitions (three synthetic, two slow-link, one per account in the lab): the tables give the range, not a
  confidence interval, and two backends whose ranges overlap are not told apart by these runs.
- Warm caches: every start after the first reads its programs from the page cache. A first start after a boot or a
  deploy is slower, by seconds for a large program. To close: evict the store paths (`posix_fadvise` DONTNEED, no root
  needed) before a cold repetition.
- The GPU is shared with the desktop and every other Chromium on the machine, so WebGL, video and wayland's
  gles2 numbers move with them. To close: record the GPU's busy share (`gpu_busy_percent` in sysfs) during each run.
- Lab start times are mostly the service's: "online" waits for the account's site to load and sign in, so one run per
  account and backend says little about the backend.
- One screen size (1280×800); a phone viewer scaling it down is not measured.
- KasmVNC is measured through standard RFB on the Unix socket, as noVNC gets it from the fork: its own web client's
  WebP, adaptive quality and UDP transport, which is how KasmVNC's own users get it, are not.
- w0vncserver draws the pointer into its frames (and with it sway draws it into the output, so grim's pictures have
  it too). The scenes never move the pointer while measuring, so the cost of sending a moving pointer as picture,
  where the other servers send a cursor shape once, is not measured. The native apps' "first picture" once took the
  lone pointer on a black screen for the app's first frame; it now also needs the screen to be more than nearly black.
- `wayland-tigervnc` and `kasmvnc` run builds of this project's forks (nix/README.md, "Forks"); the others run
  nixpkgs' builds as shipped.
