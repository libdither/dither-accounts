#!/usr/bin/env bun
/**
 * A link with a set bandwidth, delay and loss between a live view's viewer and its VNC server, for
 * scripts/bench-link.ts. Run inside a network namespace of its own (`unshare -rn`), where it may set up that
 * namespace's loopback with tc (no root: the namespace's own user namespace gives it CAP_NET_ADMIN there):
 *
 *   viewer ─unix─▶ [--listen] ─TCP over lo (shaped)─▶ [the manager's side] ─unix─▶ VNC server [--target]
 *
 *   unshare -rn bun scripts/bench-shaper.ts --target <vnc.sock> --listen <link.sock>
 *                                           [--rate-mbit 5] [--rtt-ms 50] [--loss-pct 1] [--queue-ms 50] [--bridge paced|eager]
 *
 * The loopback gets an MTU of 1500 and no segmentation offload (gso_max_size 1500), so the shaping sees packets the
 * size a real link carries. Delay and loss: netem at the root; bandwidth: tbf (under netem when both), its queue
 * holding --queue-ms of the rate. Every packet crosses the loopback once, so each direction gets half the round trip,
 * and the bandwidth is shared by both directions (the viewer's side sends only requests, input and ACKs).
 *
 * The manager's side copies the VNC server's output to the TCP connection as the manager's live view does
 * (packages/manager/src/http.ts, openLiveView). `paced` (the default): it stops reading the VNC server's socket while
 * the connection is backed up and reads on once it has drained, so the server feels the slow link as a full socket.
 * `eager`: as the live view did before it was paced, every chunk passed on as it is read, the connection's own buffer
 * growing, and bytes past Bun's WebSocket backpressure limit (16 MB) dropped and counted, as `sendBinary` drops them. Prints one JSON line when ready, and a JSON line of what it dropped when stopped (SIGTERM).
 */
import { createServer, connect, type Socket } from 'node:net';
import { rmSync } from 'node:fs';

const arg = (name: string, def = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const target = arg('target');
const listen = arg('listen');
const rateMbit = Number(arg('rate-mbit', '0'));
const rttMs = Number(arg('rtt-ms', '0'));
const lossPct = Number(arg('loss-pct', '0'));
const queueMs = Number(arg('queue-ms', '50'));
/** paced: the manager's side stops reading the VNC server while the connection is backed up; eager: it never does. */
const bridge = arg('bridge', 'paced');
/** Bun's ServerWebSocket backpressureLimit default: past it, sendBinary drops the message. */
const LIMIT = 16 * 1024 * 1024;

const sh = (cmd: string[], must = true) => {
  const p = Bun.spawnSync(cmd, { stderr: 'pipe' });
  if (p.exitCode !== 0 && must) throw new Error(`${cmd.join(' ')}: ${p.stderr.toString().trim()}`);
  return p.exitCode === 0;
};

sh(['ip', 'link', 'set', 'lo', 'up']);
sh(['ip', 'link', 'set', 'lo', 'mtu', '1500']);
const noGso = sh(['ip', 'link', 'set', 'lo', 'gso_max_size', '1500', 'gso_max_segs', '1'], false);
const tbf = () => {
  // A burst of at least two full packets (tbf refuses to send a packet larger than it), else 4 ms of the rate.
  const burst = Math.max(3200, Math.round((rateMbit * 1e6) / 8 / 250));
  return ['tbf', 'rate', `${rateMbit}mbit`, 'burst', String(burst), 'latency', `${queueMs}ms`];
};
const netem = () => ['netem', 'limit', '100000', ...(rttMs ? ['delay', `${rttMs / 2}ms`] : []), ...(lossPct ? ['loss', `${lossPct}%`] : [])];
if (rttMs || lossPct) {
  sh(['tc', 'qdisc', 'add', 'dev', 'lo', 'root', 'handle', '1:', ...netem()]);
  if (rateMbit) sh(['tc', 'qdisc', 'add', 'dev', 'lo', 'parent', '1:1', 'handle', '10:', ...tbf()]);
} else if (rateMbit) sh(['tc', 'qdisc', 'add', 'dev', 'lo', 'root', 'handle', '1:', ...tbf()]);
const qdisc = Bun.spawnSync(['tc', 'qdisc', 'show', 'dev', 'lo']).stdout.toString().trim().split('\n');

let dropped = 0;
let droppedChunks = 0;
let maxBuffered = 0;
const conns = new Set<Socket>();
const track = (s: Socket) => {
  conns.add(s);
  s.on('close', () => conns.delete(s));
  s.on('error', () => s.destroy());
  return s;
};
const join = (a: Socket, b: Socket) => {
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
};

// The manager's side: the VNC server's output copied without backpressure.
const managerSide = createServer((tcp) => {
  track(tcp);
  tcp.setNoDelay(true);
  const vnc = track(connect(target));
  join(tcp, vnc);
  if (bridge === 'paced') tcp.on('drain', () => vnc.resume());
  vnc.on('data', (d: Buffer) => {
    if (bridge === 'paced') {
      if (!tcp.write(d)) vnc.pause();
      maxBuffered = Math.max(maxBuffered, tcp.writableLength);
      return;
    }
    if (tcp.writableLength + d.length > LIMIT) {
      dropped += d.length;
      droppedChunks++;
      return;
    }
    tcp.write(d);
    maxBuffered = Math.max(maxBuffered, tcp.writableLength);
  });
  tcp.on('data', (d: Buffer) => vnc.write(d));
});
await new Promise<void>((r) => managerSide.listen(0, '127.0.0.1', r));
const port = (managerSide.address() as { port: number }).port;

// The viewer's side: its end of the link, both ways with backpressure.
rmSync(listen, { force: true });
const viewerSide = createServer((unix) => {
  track(unix);
  const tcp = track(connect(port, '127.0.0.1'));
  tcp.setNoDelay(true);
  join(unix, tcp);
  unix.pipe(tcp);
  tcp.pipe(unix);
});
await new Promise<void>((r) => viewerSide.listen(listen, r));

console.log(JSON.stringify({ ready: true, qdisc, noGso }));
process.on('SIGTERM', () => {
  console.log(JSON.stringify({ dropped, droppedChunks, maxBuffered }));
  for (const c of conns) c.destroy();
  viewerSide.close();
  managerSide.close();
  rmSync(listen, { force: true });
  process.exit(0);
});
