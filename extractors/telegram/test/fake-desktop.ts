/**
 * A fake Telegram Desktop, run inside the real sandbox by the desktop path's tests (TELEGRAM_DESKTOP_FAKE=1). Like the
 * real one it keeps a tdata (in the format tdata.ts reads: at its sign-in screen user 0 with a fresh key, then the
 * signed-in user and key), and it uses only what the sandbox gives it: the session bus (notifications, the
 * FileChooser portal), xdg-open on its PATH, and the Downloads folder.
 *
 * Driven by command files dropped into $HOME/.fake-desktop/ (the account's desktop/home/.fake-desktop/), one JSON
 * object each, run in name order; the answer goes to <name>.done:
 *
 *   { do: 'signIn', userId, dcId, keyHex }   tdata signed in with this key
 *   { do: 'signOut' }                        tdata back at the sign-in screen
 *   { do: 'notify', title, body }            a notification, as Telegram Desktop posts one (Open, Mark as read)
 *   { do: 'close', id }                      it takes that notification back (read elsewhere)
 *   { do: 'open', url }                      xdg-open
 *   { do: 'download', name, text }           a file in Downloads/Telegram Desktop/
 *   { do: 'save', name, text }               "Save as" through the FileChooser portal, written where it says
 *   { do: 'attach' }                         "Attach" through the FileChooser portal: what it was given
 *   { do: 'exit', code }                     quits
 *
 * Buttons pressed on its notifications are appended to $HOME/.fake-desktop/actions.log.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DBusConnection, type Message, variant } from '../../../packages/sandbox/src/dbus.ts';
import { writeTdata } from '../src/tdata.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const home = process.env.HOME ?? '/home/user';
const workdir = arg('-workdir') ?? join(home, '.local/share/TelegramDesktop');
const tdata = join(workdir, 'tdata');
const inbox = join(home, '.fake-desktop');
mkdirSync(inbox, { recursive: true });

const signedOut = () => writeTdata(tdata, { accounts: [{ index: 0, userId: 0n, mainDcId: 2, keys: [{ dcId: 2, key: randomBytes(256) }], keysToDestroy: [] }] });
signedOut();

const bus = await DBusConnection.connect({ address: process.env.DBUS_SESSION_BUS_ADDRESS! });
const signals: Message[] = [];
bus.onSignal((m) => {
  if (m.member === 'ActionInvoked') appendFileSync(join(inbox, 'actions.log'), `${m.body[0]} ${m.body[1]}\n`);
  signals.push(m);
});
await bus.addMatch("type='signal',interface='org.freedesktop.Notifications'");
await bus.addMatch("type='signal',interface='org.freedesktop.portal.Request'");

/** A FileChooser call and the Response that follows on its handle. */
async function chooser(member: 'OpenFile' | 'SaveFile', title: string, options: Record<string, unknown>) {
  const token = `fake${Date.now()}`;
  const [handle] = await bus.call('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.FileChooser', member, 'ssa{sv}', ['', title, { handle_token: variant('s', token), ...options }]);
  for (let i = 0; i < 100; i++) {
    const r = signals.find((s) => s.member === 'Response' && s.path === handle);
    if (r) return { code: r.body[0] as number, uris: ((r.body[1] as Record<string, unknown>).uris as string[] | undefined) ?? [] };
    await Bun.sleep(20);
  }
  throw new Error('no Response from the FileChooser portal');
}
const pathOf = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));

async function run(c: Record<string, any>): Promise<unknown> {
  switch (c.do) {
    case 'signIn':
      writeTdata(tdata, { accounts: [{ index: 0, userId: BigInt(c.userId), mainDcId: c.dcId ?? 2, keys: [{ dcId: c.dcId ?? 2, key: Buffer.from(c.keyHex, 'hex') }], keysToDestroy: [] }] });
      return { ok: true };
    case 'signOut':
      signedOut();
      return { ok: true };
    case 'notify': {
      const [id] = await bus.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'Notify', 'susssasa{sv}i', [
        'Telegram Desktop',
        0,
        'telegram',
        c.title,
        c.body,
        ['default', 'Open', 'mail-mark-read', 'Mark as read'],
        { category: variant('s', 'im.received'), urgency: variant('y', 1) },
        -1,
      ]);
      return { id };
    }
    case 'close':
      await bus.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'CloseNotification', 'u', [c.id]);
      return { ok: true };
    case 'open': {
      const p = Bun.spawn(['xdg-open', c.url], { stdout: 'ignore', stderr: 'pipe' });
      return { code: await p.exited };
    }
    case 'download': {
      const dir = join(home, 'Downloads', 'Telegram Desktop');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, c.name), c.text);
      return { ok: true };
    }
    case 'save': {
      const r = await chooser('SaveFile', 'Save File', { current_name: variant('s', c.name) });
      if (r.code !== 0) return { cancelled: true };
      writeFileSync(pathOf(r.uris[0]), c.text);
      return { path: pathOf(r.uris[0]) };
    }
    case 'attach': {
      const r = await chooser('OpenFile', 'Choose Files', { multiple: variant('b', true) });
      return r.code !== 0 ? { cancelled: true } : { files: r.uris.map((u) => ({ path: pathOf(u), text: readFileSync(pathOf(u), 'utf8') })) };
    }
    case 'exit':
      process.exit(c.code ?? 0);
  }
  throw new Error(`unknown command ${c.do}`);
}

for (;;) {
  for (const name of readdirSync(inbox).filter((n) => n.endsWith('.json')).sort()) {
    const file = join(inbox, name);
    let answer: unknown;
    try {
      answer = { ok: true, result: await run(JSON.parse(readFileSync(file, 'utf8'))) };
    } catch (e) {
      answer = { ok: false, error: String((e as Error).message ?? e) };
    }
    writeFileSync(`${file}.done.tmp`, JSON.stringify(answer));
    renameSync(`${file}.done.tmp`, `${file}.done`);
    renameSync(file, `${file}.ran`);
  }
  if (!existsSync(inbox)) mkdirSync(inbox, { recursive: true });
  await Bun.sleep(100);
}
