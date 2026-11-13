/**
 * The D-Bus wire format against fixed bytes and round trips, then a real dbus-daemon: our services answer a client
 * the way Telegram Desktop calls them (Notify with hints, the FileChooser and OpenURI portals with their Response
 * signal, Properties.Get for the portal versions), and dbus-send (what the shims run) reaches Open.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { BINS, resolveBin } from '../src/bins.ts';
import { DBusConnection, decodeMessage, encodeMessage, marshal, type Message, MsgType, splitSignature, unmarshal, variant } from '../src/dbus.ts';
import { CAPABILITIES, DesktopServices, type FileRequest, type Notification } from '../src/services.ts';

test('signatures split into complete types', () => {
  expect(splitSignature('susssasa{sv}i')).toEqual(['s', 'u', 's', 's', 's', 'as', 'a{sv}', 'i']);
  expect(splitSignature('a(iiibiiay)(sa(us))v')).toEqual(['a(iiibiiay)', '(sa(us))', 'v']);
  expect(() => splitSignature('a{sv')).toThrow();
});

test('marshalling matches the spec byte for byte and reads back', () => {
  // u then s: 4-byte length, the bytes, a NUL.
  expect([...marshal('us', [7, 'hi'])]).toEqual([7, 0, 0, 0, 2, 0, 0, 0, 0x68, 0x69, 0]);
  // a struct aligns to 8; an array's length leaves out the padding before its first element.
  expect([...marshal('y(t)', [1, [2n]])]).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
  expect([...marshal('at', [[5n]])]).toEqual([8, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0]);
  const hints = { urgency: variant('y', 1), category: variant('s', 'im.received'), 'image-data': variant('(iiibiiay)', [1, 1, 4, true, 8, 4, Buffer.from([1, 2, 3, 4])]) };
  const sig = 'susssasa{sv}i';
  const vals = ['Telegram Desktop', 0, 'telegram', 'Alice', 'hello', ['default', 'Open', 'mail-mark-read', 'Mark as read'], hints, -1];
  const back = unmarshal(sig, marshal(sig, vals));
  expect(back.slice(0, 6)).toEqual(vals.slice(0, 6));
  expect(back[6]).toEqual({ urgency: 1, category: 'im.received', 'image-data': [1, 1, 4, true, 8, 4, Buffer.from([1, 2, 3, 4])] });
  expect(back[7]).toBe(-1);
  // Nested variants, dicts of dicts, signed and 64-bit numbers.
  const s2 = 'a{sa{sv}}vxnd';
  const v2 = [{ 'org.freedesktop.appearance': { 'color-scheme': variant('u', 1) } }, variant('v', variant('as', ['a', 'b'])), -5n, -3, 1.5];
  expect(unmarshal(s2, marshal(s2, v2))).toEqual([{ 'org.freedesktop.appearance': { 'color-scheme': 1 } }, ['a', 'b'], -5n, -3, 1.5]);
});

test('a whole message encodes and decodes, and a partial one waits', () => {
  const m: Omit<Message, 'body'> & { body: unknown[] } = { type: MsgType.Call, flags: 0, serial: 9, path: '/org/freedesktop/Notifications', iface: 'org.freedesktop.Notifications', member: 'Notify', destination: 'org.freedesktop.Notifications', signature: 'su', body: ['x', 3] };
  const buf = encodeMessage(m);
  expect(decodeMessage(buf.subarray(0, buf.length - 1))).toBeNull();
  const got = decodeMessage(Buffer.concat([buf, Buffer.from([0x6c])]))!;
  expect(got.size).toBe(buf.length);
  expect(got.msg).toMatchObject({ type: MsgType.Call, serial: 9, path: m.path, iface: m.iface, member: 'Notify', destination: m.destination, signature: 'su', body: ['x', 3] });
});

// ---------------------------------------------------------------- against a real bus

const dir = mkdtempSync(join(tmpdir(), 'dacc-dbus-'));
let daemon: Subprocess;
let server: DBusConnection;
let client: DBusConnection;
let services: DesktopServices;
const seen: { links: [string, string][]; notes: Notification[]; closed: [number, string][]; files: FileRequest[] } = { links: [], notes: [], closed: [], files: [] };
const address = join(dir, 'bus');
let dbusSend = '';

beforeAll(async () => {
  const bin = resolveBin(BINS.dbusDaemon, () => {});
  dbusSend = join(bin, '..', 'dbus-send');
  writeFileSync(
    join(dir, 'bus.conf'),
    `<busconfig><type>session</type><listen>unix:path=${address}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>`,
  );
  daemon = Bun.spawn([bin, `--config-file=${join(dir, 'bus.conf')}`, '--nofork', '--nopidfile', '--nosyslog'], { stdout: 'ignore', stderr: 'ignore' });
  for (let i = 0; i < 100 && !(await Bun.file(address).exists()); i++) await Bun.sleep(30);
  server = await DBusConnection.connect({ address });
  services = new DesktopServices(server, {
    link: (url, via) => seen.links.push([url, via]),
    notify: (n) => seen.notes.push(n),
    notificationClosed: (id, by) => seen.closed.push([id, by]),
    chooseFiles: async (req) => {
      seen.files.push(req);
      return req.kind === 'open' ? null : ['file:///home/user/Downloads/a%20b.txt'];
    },
    online: true,
    log: () => {},
  });
  await services.register();
  client = await DBusConnection.connect({ address });
});

afterAll(() => {
  client?.close();
  server?.close();
  daemon?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('notifications: capabilities, Notify with hints, replace, close, and pressing a button for the app', async () => {
  expect(client.uniqueName).toMatch(/^:1\.\d+$/);
  const call = (member: string, sig: string, body: unknown[]) => client.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', member, sig, body);
  expect((await call('GetCapabilities', '', []))[0]).toEqual(CAPABILITIES);
  expect(await call('GetServerInformation', '', [])).toEqual(['dither-accounts', 'dither', '1', '1.2']);
  const hints = { category: variant('s', 'im.received'), 'image-data': variant('(iiibiiay)', [1, 1, 4, true, 8, 4, Buffer.alloc(4)]) };
  const [id] = (await call('Notify', 'susssasa{sv}i', ['Telegram Desktop', 0, '', 'Alice', 'hi there', ['default', 'Open', 'mail-mark-read', 'Mark as read'], hints, -1])) as [number];
  expect(id).toBeGreaterThan(0);
  expect(seen.notes[0]).toEqual({ id, app: 'Telegram Desktop', summary: 'Alice', body: 'hi there', actions: [['default', 'Open'], ['mail-mark-read', 'Mark as read']], hints: { category: 'im.received' }, replaced: false });
  const [again] = (await call('Notify', 'susssasa{sv}i', ['Telegram Desktop', id, '', 'Alice', 'hi again', [], {}, -1])) as [number];
  expect(again).toBe(id);
  expect(seen.notes[1].replaced).toBe(true);

  const signals: Message[] = [];
  client.onSignal((m) => signals.push(m));
  await client.addMatch("type='signal',interface='org.freedesktop.Notifications'");
  expect(services.invokeAction(id, 'mail-mark-read')).toBe(true);
  await call('CloseNotification', 'u', [id]);
  for (let i = 0; i < 50 && signals.length < 2; i++) await Bun.sleep(20);
  expect(signals.map((s) => [s.member, s.body])).toEqual([
    ['ActionInvoked', [id, 'mail-mark-read']],
    ['NotificationClosed', [id, 3]],
  ]);
  expect(seen.closed).toEqual([[id, 'app']]);
  expect(services.invokeAction(id, 'default')).toBe(false);
});

test('portals: versions, OpenURI and FileChooser answer with a handle and then a Response on it', async () => {
  const props = (iface: string) => client.call('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.DBus.Properties', 'Get', 'ss', [iface, 'version']);
  expect(await props('org.freedesktop.portal.FileChooser')).toEqual([3]);
  expect(await props('org.freedesktop.portal.OpenURI')).toEqual([2]);
  const responses: Message[] = [];
  client.onSignal((m) => m.member === 'Response' && responses.push(m));
  await client.addMatch("type='signal',interface='org.freedesktop.portal.Request'");
  const portal = (iface: string, member: string, sig: string, body: unknown[]) => client.call('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', iface, member, sig, body);
  const me = client.uniqueName.slice(1).replace('.', '_');

  const [h1] = await portal('org.freedesktop.portal.OpenURI', 'OpenURI', 'ssa{sv}', ['', 'https://example.org/a?b=c', { handle_token: variant('s', 'tok1') }]);
  expect(h1).toBe(`/org/freedesktop/portal/desktop/request/${me}/tok1`);
  const [h2] = await portal('org.freedesktop.portal.FileChooser', 'SaveFile', 'ssa{sv}', ['', 'Save File', { handle_token: variant('s', 'tok2'), current_name: variant('s', 'a b.txt') }]);
  const [h3] = await portal('org.freedesktop.portal.FileChooser', 'OpenFile', 'ssa{sv}', ['', 'Choose Files', { multiple: variant('b', true) }]);
  for (let i = 0; i < 50 && responses.length < 3; i++) await Bun.sleep(20);
  const byPath = Object.fromEntries(responses.map((r) => [r.path, r.body]));
  expect(byPath[h1 as string]).toEqual([0, {}]);
  expect(byPath[h2 as string]).toEqual([0, { uris: ['file:///home/user/Downloads/a%20b.txt'] }]);
  expect(byPath[h3 as string]).toEqual([1, {}]);
  expect(seen.links).toEqual([['https://example.org/a?b=c', 'portal']]);
  expect(seen.files.map((f) => [f.kind, f.title, f.multiple, f.names])).toEqual([
    ['save', 'Save File', false, ['a b.txt']],
    ['open', 'Choose Files', true, []],
  ]);
  expect(await portal('org.freedesktop.portal.NetworkMonitor', 'GetStatus', '', [])).toEqual([{ available: true, metered: false, connectivity: 4 }]);
  const [settings] = await portal('org.freedesktop.portal.Settings', 'ReadAll', 'as', [[]]);
  expect(settings).toEqual({ 'org.freedesktop.appearance': { 'color-scheme': 0 } });
  await expect(portal('org.freedesktop.portal.OpenURI', 'OpenFile', 'sha{sv}', ['', 0, {}])).rejects.toThrow();
});

test('dbus-send, as the xdg-open shim runs it, reaches Open; Introspect and unknown methods answer', async () => {
  const p = Bun.spawn([dbusSend, `--bus=unix:path=${address}`, '--print-reply=literal', '--dest=net.dither.Sandbox', '/net/dither/Sandbox', 'net.dither.Sandbox.Open', 'string:https://t.me/durov?x=1&y="2"'], { stdout: 'pipe', stderr: 'pipe' });
  expect(await p.exited).toBe(0);
  expect((await new Response(p.stdout).text()).trim()).toBe('boolean true');
  expect(seen.links.at(-1)).toEqual(['https://t.me/durov?x=1&y="2"', 'xdg-open']);
  const [xml] = (await client.call('net.dither.Sandbox', '/net/dither/Sandbox', 'org.freedesktop.DBus.Introspectable', 'Introspect', '', [])) as [string];
  expect(xml).toContain('<method name="Open"><arg type="s" direction="in"/><arg type="b" direction="out"/></method>');
  await expect(client.call('net.dither.Sandbox', '/net/dither/Sandbox', 'net.dither.Sandbox', 'Nope', '', [])).rejects.toThrow(/no method/);
  await expect(client.call('net.dither.Sandbox', '/net/dither/Sandbox', 'net.dither.Sandbox', 'Open', 'u', [1])).rejects.toThrow(/takes \(s\)/);
});
