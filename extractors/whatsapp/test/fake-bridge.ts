/**
 * Stands in for bridge/main.go in the adapter tests: same JSON lines on stdin/stdout, no WhatsApp.
 *
 * The test drives it over a Unix socket ($FAKE_WA_SOCK): every command the adapter sends is copied
 * there as {cmd}, and the test can send {emit: event}, {result: {op, value}} (the answer to an op),
 * {error: {op, message}} or {exit: code}.
 *
 * Built-in behaviour: prints ready; `connect` prints connected when $FAKE_WA_LOGGED_IN=1, else a QR
 * code; `send` answers with a fresh id; `download` writes a file.
 */

import { writeFileSync } from 'node:fs';

const loggedIn = process.env.FAKE_WA_LOGGED_IN === '1';
const results: Record<string, unknown> = {};
const errors: Record<string, string> = {};
let ctl: { write(s: string): void } | null = null;
const backlog: string[] = [];
let sent = 0;

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');
const toCtl = (o: unknown) => {
  const s = JSON.stringify(o) + '\n';
  if (ctl) ctl.write(s);
  else backlog.push(s);
};

let ctlBuf = '';
await Bun.connect({
  unix: process.env.FAKE_WA_SOCK!,
  socket: {
    open(s) {
      ctl = s;
      for (const l of backlog.splice(0)) s.write(l);
    },
    data(_s, d) {
      ctlBuf += d.toString();
      let nl: number;
      while ((nl = ctlBuf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(ctlBuf.slice(0, nl));
        ctlBuf = ctlBuf.slice(nl + 1);
        if (msg.emit) out(msg.emit);
        if (msg.result) results[msg.result.op] = msg.result.value;
        if (msg.error) errors[msg.error.op] = msg.error.message;
        if (msg.exit !== undefined) process.exit(msg.exit);
      }
    },
  },
});

out({ t: 'ready', version: 'fake', loggedIn });

const reply = (id: string, op: string, value: unknown) => {
  if (errors[op]) out({ t: 'reply', id, ok: false, error: errors[op] });
  else out({ t: 'reply', id, ok: true, result: op in results ? results[op] : value });
};

let buf = '';
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const cmd = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    toCtl({ cmd });
    switch (cmd.op) {
      case 'connect':
        reply(cmd.id, cmd.op, null);
        if (loggedIn) out({ t: 'connected', loggedIn: true, jid: '15550000001@s.whatsapp.net', lid: '200000000000001@lid', pushName: 'Me' });
        else out({ t: 'qr', code: '2@fake-qr', timeoutMs: 60_000 });
        break;
      case 'send':
        reply(cmd.id, cmd.op, { id: `SENT${++sent}`, ts: 1_770_000_000_000 + sent });
        break;
      case 'download':
        writeFileSync(cmd.dest, 'fake media bytes');
        reply(cmd.id, cmd.op, { path: cmd.dest, size: 16 });
        break;
      case 'groups':
      case 'contacts':
        reply(cmd.id, cmd.op, []);
        break;
      default:
        reply(cmd.id, cmd.op, null);
    }
  }
}
