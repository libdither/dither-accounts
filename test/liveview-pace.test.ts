/**
 * The live view's bridge is paced by the page (packages/manager/src/http.ts, openLiveView): while the browser does not
 * take what is sent, the VNC server's socket is not read, so the server is held back rather than its output piling up
 * in the manager until Bun drops some of it, which would break the RFB stream. A stand-in VNC server sends 64 MB as
 * fast as its socket takes it; a WebSocket client that reads nothing at first must get every byte, in order, once it
 * reads, and the stand-in must have been held back meanwhile.
 */
import type { Socket, UnixSocketListener } from 'bun';
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManager, type Manager } from '@dither-accounts/manager';
import type { ManagerState } from '../packages/manager/src/api-types.ts';

setDefaultTimeout(60_000);

const TOTAL = 64 * 1024 * 1024;
const CHUNK = 256 * 1024;
/** Byte i of the stream is i % 251, so a dropped or repeated chunk shows. */
const pattern = (from: number, n: number) => {
  const b = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) b[i] = (from + i) % 251;
  return b;
};

let m: Manager;
let dir: string;
let vnc: UnixSocketListener<undefined>;
/** The stand-in's side: how much it has written, whether it finished, and since when its last write waits. */
const server = { written: 0, finished: false, blockedSince: 0 };

const until = async (f: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-lvpace-'));
  let pending: Buffer | null = null;
  const pump = (s: Socket<undefined>) => {
    for (;;) {
      if (!pending) {
        if (server.written >= TOTAL) return void (server.finished = true);
        pending = pattern(server.written, Math.min(CHUNK, TOTAL - server.written));
      }
      const n = s.write(pending);
      server.written += Math.max(0, n);
      if (n < pending.length) {
        pending = pending.subarray(Math.max(0, n));
        server.blockedSince = Date.now();
        return;
      }
      pending = null;
    }
  };
  vnc = Bun.listen({
    unix: join(dir, 'vnc.sock'),
    socket: {
      // Sends once the viewer says so.
      data: (s) => pump(s),
      drain: (s) => {
        server.blockedSince = 0;
        pump(s);
      },
    },
  });
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  m.kinds.get('fake')!.add = { blurb: 'for tests' };
});
afterAll(async () => {
  await m?.stop();
  vnc?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test('a page that does not keep up holds the VNC server back, and gets every byte once it reads', async () => {
  const made = await fetch(`${m.url}/api/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'fake', label: 'Flood', config: { vncSocket: join(dir, 'vnc.sock') } }) });
  const id = ((await made.json()) as { id: string }).id;
  await until(async () => ((await (await fetch(`${m.url}/api/state`)).json()) as ManagerState).accounts.find((a) => a.id === id)?.liveView === true, 20_000, 'its live view');

  // A WebSocket by hand, so it can stop reading: the upgrade, then frames.
  const u = new URL(m.url);
  let buf = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  let closed = false;
  const sock = await Bun.connect({
    hostname: u.hostname,
    port: Number(u.port),
    socket: {
      data: (_s, d) => {
        buf = Buffer.concat([buf, d]);
        wake?.();
      },
      close: () => {
        closed = true;
        wake?.();
      },
    },
  });
  const more = () => new Promise<void>((r) => (wake = r));
  sock.write(`GET /api/liveview/${id} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\nOrigin: ${m.url}\r\n\r\n`);
  while (!buf.includes('\r\n\r\n')) await more();
  const head = buf.subarray(0, buf.indexOf('\r\n\r\n')).toString();
  expect(head.split('\r\n')[0]).toContain('101');
  buf = buf.subarray(buf.indexOf('\r\n\r\n') + 4);
  // "Go", as a masked binary frame, then nothing read until the stand-in is held back (or, unpaced, has sent it all).
  const mask = Buffer.from([1, 2, 3, 4]);
  const go = Buffer.from('go').map((b, i) => b ^ mask[i % 4]!);
  sock.write(Buffer.concat([Buffer.from([0x82, 0x80 | go.length]), mask, go]));
  sock.pause();
  await until(() => server.finished || (server.blockedSince > 0 && Date.now() - server.blockedSince > 1000), 30_000, 'the stand-in held back or done');
  const heldAt = server.written;
  expect(server.finished).toBe(false);
  expect(heldAt).toBeLessThan(TOTAL);

  // Now read it all: every byte, in order, the socket still open.
  sock.resume();
  let got = 0;
  let bad = -1;
  while (got < TOTAL) {
    if (buf.length < 2) {
      if (closed) break;
      await more();
      continue;
    }
    const op = buf[0]! & 0x0f;
    let len = buf[1]! & 0x7f;
    let at = 2;
    if (len === 126) {
      if (buf.length < 4) {
        await more();
        continue;
      }
      len = buf.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (buf.length < 10) {
        await more();
        continue;
      }
      len = Number(buf.readBigUInt64BE(2));
      at = 10;
    }
    if (buf.length < at + len) {
      if (closed) break;
      await more();
      continue;
    }
    expect(op === 2 || op === 0).toBe(true);
    const payload = buf.subarray(at, at + len);
    if (bad < 0 && !payload.equals(pattern(got, payload.length))) bad = got;
    got += payload.length;
    buf = buf.subarray(at + len);
  }
  expect({ got, bad, closed }).toEqual({ got: TOTAL, bad: -1, closed: false });
  expect(server.finished).toBe(true);
  sock.end();
});
