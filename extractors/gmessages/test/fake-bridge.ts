/**
 * Stands in for bridge/main.go in tests: the same JSON lines on stdin/stdout, no Google and no phone.
 *
 * The test drives it over a Unix socket ($FAKE_GM_SOCK): every command the adapter sends is copied there as {cmd},
 * and the test can send {emit: event}, {result: {op, value}} (the answer to an op from then on), {error: {op,
 * message}}, {clear: op} or {exit: code}.
 *
 * Built in: prints ready; `connect` with a paired session says connected (with settings, and the phone making this
 * session active), without one says not paired; `startQr` prints a QR code; `pairGoogle` an emoji (or refuses
 * cookies without SAPISID); `send` answers and prints the phone's copy of the message, as the phone does; `download`
 * writes a file. $FAKE_GM_ECHO=0 leaves out the copy, $FAKE_GM_QUIET=1 the settings and the active alert.
 */

import { writeFileSync } from 'node:fs';

const results: Record<string, unknown> = {};
const errors: Record<string, string> = {};
let ctl: { write(s: string): void } | null = null;
const backlog: string[] = [];
let sent = 0;
const echo = process.env.FAKE_GM_ECHO !== '0';
const quiet = process.env.FAKE_GM_QUIET === '1';
/** The first this many connects fail, as with no network. */
let connectFails = Number(process.env.FAKE_GM_CONNECT_FAILS ?? 0);

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');
const toCtl = (o: unknown) => {
  const s = JSON.stringify(o) + '\n';
  if (ctl) ctl.write(s);
  else backlog.push(s);
};

let ctlBuf = '';
if (process.env.FAKE_GM_SOCK) {
  await Bun.connect({
    unix: process.env.FAKE_GM_SOCK,
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
          if (msg.clear) {
            delete results[msg.clear];
            delete errors[msg.clear];
          }
          if (msg.exit !== undefined) process.exit(msg.exit);
        }
      },
    },
  }).catch(() => {});
}

out({ t: 'ready', version: 'fake' });

const FAKE_SETTINGS = {
  sims: [{ number: 1, phone: '+15550000001', formatted: '(555) 000-0001', carrier: 'Example Mobile', participant: '1', rcs: true }],
  rcsEnabled: true,
  readReceipts: true,
  typingIndicators: true,
  defaultSmsApp: true,
  version: 'fake-messages',
};

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
      case 'connect': {
        if (connectFails > 0) {
          connectFails--;
          out({ t: 'reply', id: cmd.id, ok: false, error: 'connecting: dial tcp: no route to host' });
          break;
        }
        if (errors.connect || 'connect' in results) {
          reply(cmd.id, 'connect', null);
          break;
        }
        const s = cmd.session;
        if (!s?.browser || !s?.tachyon_token) {
          reply(cmd.id, 'connect', { paired: false });
          break;
        }
        reply(cmd.id, 'connect', { paired: true });
        const google = !!s.dest_reg_id && s.dest_reg_id !== '00000000-0000-0000-0000-000000000000';
        out({ t: 'connected', google, account: google ? 'someone@example.com' : '', sessionId: 'fake-session' });
        if (!quiet) {
          out({ t: 'settings', settings: FAKE_SETTINGS });
          out({ t: 'alert', alert: 'browser_active' });
        }
        break;
      }
      case 'startQr':
        reply(cmd.id, 'startQr', { started: true });
        if (!errors.startQr) out({ t: 'qr', url: 'https://support.google.com/messages/?p=web_computer#?c=FAKEQR1', expiresMs: 30_000, attempt: 1, of: 6 });
        break;
      case 'pairGoogle':
        if (!errors.pairGoogle && !String(cmd.cookies ?? '').includes('SAPISID')) {
          out({ t: 'reply', id: cmd.id, ok: false, error: 'missing Google cookies APISID, SAPISID (sign in at messages.google.com first, then copy them from there)' });
          break;
        }
        reply(cmd.id, 'pairGoogle', { emoji: '🦊' });
        if (!errors.pairGoogle) out({ t: 'emoji', emoji: '🦊', svg: 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f98a/emoji.svg' });
        break;
      case 'send': {
        const n = ++sent;
        reply(cmd.id, 'send', { tmpId: cmd.tmpId, status: 'SUCCESS' });
        if (echo && !errors.send) {
          const media = cmd.media ? [{ part: `p${n}`, mediaId: `up${n}`, key: 'a2V5', name: cmd.media.name, mime: cmd.media.mime, size: 16 }] : undefined;
          out({
            t: 'message',
            message: { id: `9${n}`, conversation: cmd.conversation, participant: '1', fromMe: true, ts: 1_770_000_100_000 + n, status: 'OUTGOING_COMPLETE', state: 'sent', kind: media ? 'mms' : 'sms', text: cmd.text, media, replyTo: cmd.replyTo, tmpId: cmd.tmpId },
          });
        }
        break;
      }
      case 'conversations':
        reply(cmd.id, cmd.op, { conversations: [] });
        break;
      case 'messages':
        reply(cmd.id, cmd.op, { messages: [], total: 0 });
        break;
      case 'conversation':
        if (cmd.op in results || errors[cmd.op]) reply(cmd.id, cmd.op, null);
        else out({ t: 'reply', id: cmd.id, ok: false, error: 'no such conversation on the phone' });
        break;
      case 'download':
        writeFileSync(cmd.dest, 'fake media bytes');
        reply(cmd.id, cmd.op, { size: 16, mime: 'image/png' });
        break;
      case 'thumbnails':
        reply(cmd.id, cmd.op, { thumbnails: cmd.ids.map((id: string) => ({ id, mime: 'image/png', base64: Buffer.from('png').toString('base64') })) });
        break;
      case 'getOrCreate':
        reply(cmd.id, cmd.op, {
          conversation: {
            id: '77',
            type: 'sms',
            status: 'active',
            lastTs: 0,
            participants: [
              { id: '1', number: '+15550000001', isMe: true, visible: true },
              { id: '70', number: cmd.numbers[0], formatted: cmd.numbers[0], visible: true },
            ],
          },
        });
        break;
      default:
        reply(cmd.id, cmd.op, {});
    }
  }
}
