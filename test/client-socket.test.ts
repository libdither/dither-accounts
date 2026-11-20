/**
 * The client's own WebSocket (packages/client/src/socket.ts) against a Bun server: text both ways at each length
 * encoding, frames that arrive a byte at a time, fragments, pings, and closes from either side with their code.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ManagerSocket, OPEN } from '../packages/client/src/socket.ts';

const echo = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 400 })),
  websocket: {
    message(ws, msg) {
      const s = String(msg);
      if (s === 'close please') ws.close(4001, 'asked');
      else ws.send(s);
    },
  },
});
afterAll(() => echo.stop(true));

function open(url: string) {
  const ws = new ManagerSocket(url);
  const heard: string[] = [];
  const waiters: ((s: string) => void)[] = [];
  ws.onmessage = (e) => {
    const w = waiters.shift();
    if (w) w(e.data);
    else heard.push(e.data);
  };
  const closed = new Promise<{ code: number; reason: string }>((res) => (ws.onclose = res));
  const opened = new Promise<void>((res) => (ws.onopen = res));
  const next = () => (heard.length ? Promise.resolve(heard.shift()!) : new Promise<string>((res) => waiters.push(res)));
  return { ws, opened, closed, next };
}

/** A raw server that writes the given bytes after the handshake, in pieces of `step` bytes. */
function raw(bytes: Buffer, step: number) {
  return Bun.listen<{ buf: string; done: boolean }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(s) {
        s.data = { buf: '', done: false };
      },
      async data(s, d) {
        if (s.data.done) return;
        s.data.buf += d.toString();
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(s.data.buf)?.[1];
        if (!key || !s.data.buf.includes('\r\n\r\n')) return;
        s.data.done = true;
        const accept = createHash('sha1').update(`${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        for (let i = 0; i < bytes.length; i += step) {
          s.write(bytes.subarray(i, i + step));
          await Bun.sleep(0);
        }
      },
    },
  });
}
const frame = (op: number, payload: Buffer, fin = true) => {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, n]) : Buffer.from([(fin ? 0x80 : 0) | op, 126, n >> 8, n & 255]);
  return Buffer.concat([head, payload]);
};

test('text both ways at each length encoding, in order', async () => {
  const c = open(`ws://127.0.0.1:${echo.port}/x?a=1`);
  await c.opened;
  expect(c.ws.readyState).toBe(OPEN);
  const texts = ['', 'é', 'x'.repeat(125), 'x'.repeat(126), 'y'.repeat(65_535), 'z'.repeat(65_536), `ü${'w'.repeat(300_000)}`];
  for (const t of texts) c.ws.send(t);
  for (const t of texts) expect(await c.next()).toBe(t);
  c.ws.close();
  expect((await c.closed).code).toBe(1000);
});

test("the server's close reaches onclose with its code and reason", async () => {
  const c = open(`ws://127.0.0.1:${echo.port}/`);
  await c.opened;
  c.ws.send('close please');
  expect(await c.closed).toEqual({ code: 4001, reason: 'asked' });
});

test('frames a byte at a time, a fragmented message, and a ping between its parts', async () => {
  const bytes = Buffer.concat([
    frame(0x1, Buffer.from('one')),
    frame(0x1, Buffer.from('tw'), false),
    frame(0x9, Buffer.from('p')),
    frame(0x0, Buffer.from('o'), false),
    frame(0x0, Buffer.from(`-${'x'.repeat(200)}`)),
    frame(0x1, Buffer.from('three')),
    frame(0x8, Buffer.from([0x0f, 0xa0, 0x62, 0x79, 0x65])),
  ]);
  const srv = raw(bytes, 1);
  try {
    const c = open(`ws://127.0.0.1:${srv.port}/`);
    await c.opened;
    expect(await c.next()).toBe('one');
    expect(await c.next()).toBe(`two-${'x'.repeat(200)}`);
    expect(await c.next()).toBe('three');
    expect(await c.closed).toEqual({ code: 4000, reason: 'bye' });
  } finally {
    srv.stop(true);
  }
});

test('a malformed frame fails the socket with 1002; a refused upgrade or no server closes it 1006', async () => {
  const srv = raw(Buffer.from([0x83, 0x00]), 64);
  try {
    const c = open(`ws://127.0.0.1:${srv.port}/`);
    await c.opened;
    expect((await c.closed).code).toBe(1002);
  } finally {
    srv.stop(true);
  }
  const plain = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('no', { status: 400 }) });
  try {
    const c = open(`ws://127.0.0.1:${plain.port}/`);
    expect((await c.closed).code).toBe(1006);
  } finally {
    plain.stop(true);
  }
  const gone = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = gone.port;
  gone.stop(true);
  expect((await open(`ws://127.0.0.1:${port}/`).closed).code).toBe(1006);
});
