/**
 * hook.js on the fake Messenger (LightSpeed): the module system's three ways in, the self-test, the snapshot and rows
 * it forwards (whitelisted, checked, counted when dropped), the client's own tasks it learns and then uses, and its
 * fallbacks when a hook point is missing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { MS, SELF } from '../../../test/fake-messenger.ts';
import { harness, until } from './harness.ts';

let h: ReturnType<typeof harness> | null = null;
afterEach(() => {
  h?.stop();
  h = null;
});
const ready = (x: ReturnType<typeof harness>) => until(() => x.last('snapshot'), 8000, 'the snapshot');
const SECRET = /secret snippet|\+1 555|Sam Self/;

describe('the hook on Messenger', () => {
  test('finds the modules, the database and the change feed by name, and says so', async () => {
    h = harness({ site: 'messenger' });
    await ready(h);
    const hooks = h.last('hooks');
    expect(hooks.backend).toBe('ls');
    expect(hooks.records).toBe('__debug.modulesMap');
    expect(hooks.names).toBe('__d');
    expect(hooks.results.modules).toEqual({ ok: true, via: '__debug.modulesMap', need: 'core' });
    expect(hooks.results.session.ok).toBe(true);
    expect(hooks.results['ls.db']).toEqual({ ok: true, via: 'LSDatabaseSingleton', need: 'core' });
    expect(hooks.results['ls.read'].via).toBe('ReQL');
    expect(hooks.results['ls.changes'].via).toBe('subscriptionManager');
    expect(hooks.results['ls.send'].via).toBe('composer');
    expect(hooks.results['ls.react'].ok).toBe(false);
    // Stored procedures are listed once the client has loaded them (here: after one task of its own).
    h.server.userAction({ type: 'markRead', thread: MS.direct });
    await until(() => h!.server.tasks.length, 5000, 'the client task');
    const survey = await h.cmd({ kind: 'survey' });
    expect(survey.lists.MW).toEqual([]);
    expect(survey.modules.defined).toBeGreaterThan(5);
    expect(survey.lists.LS).toContain('LSIssueNewTask');
    expect(survey.sprocs.map((s: any) => s.sproc)).toContain('LSCoreIssueNewTaskStoredProcedure');
    expect(JSON.stringify(survey)).not.toMatch(SECRET);
    expect(JSON.stringify(survey)).not.toContain('hello from alice');
  });

  test('the snapshot: whitelisted rows, 64-bit values as decimal strings, nothing it does not need', async () => {
    h = harness({ site: 'messenger' });
    const snap = await ready(h);
    expect(snap.self.id).toBe(SELF.fb);
    expect(snap.threads.map((t: any) => t.threadKey).sort()).toEqual([MS.direct, MS.e2ee, MS.group].sort());
    expect(snap.threads.find((t: any) => t.threadKey === MS.e2ee).threadType).toBe(15);
    expect(snap.messages.find((m: any) => m.messageId === 'mid.$e1').text).toBe('secret plans, decrypted in the page');
    expect(snap.messages.find((m: any) => m.messageId === 'mid.$g1').mentionIds).toEqual([SELF.fb]);
    expect(snap.reactions).toEqual([{ threadKey: MS.direct, messageId: 'mid.$a2', actorId: expect.any(String), reaction: '❤', timestampMs: expect.any(Number) }]);
    expect(snap.attachments[0]).toMatchObject({ attachmentFbid: '700000000000001', previewUrlMimeType: 'image/png', filename: 'cat.png' });
    const text = JSON.stringify(snap);
    expect(text).not.toContain('secret snippet');
    expect(text).not.toContain('+1 555');
    expect(text).not.toContain('phoneNumber');
  });

  test('rows as the client writes them: a new message, a reaction, typing, an unsend', async () => {
    h = harness({ site: 'messenger' });
    await ready(h);
    const id = h.server.deliver(MS.direct, 'are you there?');
    await until(() => h!.all('rows').flatMap((r) => r.changes).find((c: any) => c.table === 'messages' && c.row.messageId === id), 5000, 'the row');
    h.server.react(id, '👍');
    h.server.typing(MS.direct, true);
    h.server.unsendByThem(id);
    const changes = await until(() => {
      const c = h!.all('rows').flatMap((r) => r.changes);
      return c.some((x: any) => x.table === 'messages' && x.row.isUnsent) && c.some((x: any) => x.table === 'typing_indicator') && c.some((x: any) => x.table === 'reactions' && x.row.reaction === '👍') ? c : null;
    }, 5000, 'reaction, typing and unsend rows');
    const unsent = changes.find((x: any) => x.table === 'messages' && x.row.isUnsent);
    expect(unsent.op).toBe('put');
    expect(unsent.prev.text).toBe('are you there?');
  });

  test('a malformed row is dropped and counted, never forwarded', async () => {
    h = harness({ site: 'messenger' });
    await ready(h);
    const db = await h.win.require('LSDatabaseSingleton').LSDatabaseSingleton;
    await db.runInTransaction(async (tx: any) => tx.tables.messages.put({ threadKey: [0, 1], messageId: 'mid.$broken', senderId: [0, 2] }));
    await until(() => h!.last('hooks')?.dropped?.messages || null, 35_000, 'the drop to be reported').catch(() => null);
    const survey = await h.cmd({ kind: 'survey' });
    expect(survey.dropped.messages).toBe(1);
    expect(h.all('rows').flatMap((r) => r.changes).some((c: any) => c.row.messageId === 'mid.$broken')).toBe(false);
  });

  test('tasks: learned from the client, then sent in exactly its shape', async () => {
    h = harness({ site: 'messenger' });
    await ready(h);
    // Nothing learned yet: reacting is refused before any request.
    await expect(h.cmd({ kind: 'react', thread: MS.direct, message: 'mid.$a1', emoji: '😀' })).rejects.toThrow(/by hand in the live view first/);
    // The person sends, reacts, reads, edits and unsends once by hand in the live view.
    h.server.userAction({ type: 'send', thread: MS.direct, text: 'by hand' });
    h.server.userAction({ type: 'react', thread: MS.direct, message: 'mid.$a1', emoji: '😮' });
    h.server.userAction({ type: 'markRead', thread: MS.direct });
    h.server.userAction({ type: 'edit', thread: MS.direct, message: 'mid.$a2', text: 'hi alice!' });
    h.server.userAction({ type: 'unsend', thread: MS.direct, message: 'mid.$a2' });
    await until(() => ['46', '29', '21', '742', '33'].every((k) => h!.all('learned').some((l) => l.key === k)), 5000, 'the shapes learned');
    expect(h.all('learned').every((l) => l.shape.usable)).toBe(true);
    // The learned shapes carry names and constants only.
    expect(JSON.stringify(h.all('learned'))).not.toMatch(/by hand|hi alice|😮/);
    const before = h.server.tasks.length;
    const sent = await h.cmd({ kind: 'send', thread: MS.direct, text: 'from the hook' });
    expect(sent.via).toBe('task');
    expect(sent.otid).toMatch(/^\d{16,}$/);
    await h.cmd({ kind: 'react', thread: MS.direct, message: 'mid.$a1', emoji: '🎉' });
    await h.cmd({ kind: 'markRead', thread: MS.direct, upToTs: Date.now() });
    await h.cmd({ kind: 'edit', thread: MS.direct, message: 'mid.$a1', text: 'edited' });
    await h.cmd({ kind: 'unsend', thread: MS.direct, message: 'mid.$a1' });
    await until(() => h!.server.tasks.length >= before + 5, 5000, 'the tasks shipped');
    // Every task of a label went out with the same fields, the same constants and the same queue pattern.
    for (const label of ['46', '29', '21', '742', '33']) {
      const ts = h.server.tasks.filter((t) => t.label === label);
      expect(ts.length).toBe(2);
      expect(ts[1].keys).toEqual(ts[0].keys);
      expect(ts[1].consts).toEqual(ts[0].consts);
      expect(ts[1].queue).toBe(ts[0].queue);
    }
    // The server took them: the message exists, the reaction is there.
    await until(() => [...h!.server.messages.values()].some((m) => m.text === 'from the hook'), 5000, 'the message on the server');
    // Each of our tasks went in a transaction opened as the client opened its own for that task: the same mode and
    // the same name, never one of ours.
    const named = (h.app.transactions as unknown[][]).filter((t) => t.length > 1);
    for (const label of ['46', '29', '21', '742', '33']) expect(named.filter((t) => t[0] === 'readwrite' && t[3] === `FakeTaskIssuer.${label}`).length).toBe(2);
    expect(named.every((t) => /^FakeTaskIssuer\.\d+$/.test(String(t[3])))).toBe(true);
    expect(h.all('learned').find((l) => l.key === '46')?.shape.tx).toEqual({ mode: 'readwrite', name: 'FakeTaskIssuer.46' });
  });

  test('an end-to-end encrypted chat is never sent a task; without a composer the send fails plainly', async () => {
    h = harness({ site: 'messenger' });
    await ready(h);
    h.server.userAction({ type: 'send', thread: MS.direct, text: 'teach' });
    await until(() => h!.all('learned').some((l) => l.key === '46'), 5000, 'the send shape');
    const n = h.server.tasks.length;
    await expect(h.cmd({ kind: 'send', thread: MS.e2ee, text: 'to bob' })).rejects.toThrow();
    await expect(h.cmd({ kind: 'react', thread: MS.e2ee, message: 'mid.$e1', emoji: '👍' })).rejects.toThrow(/end-to-end encrypted/);
    await Bun.sleep(200);
    expect(h.server.tasks.length).toBe(n);
  });

  test('history: the rows the client already holds, older than asked', async () => {
    h = harness({ site: 'messenger' });
    await ready(h);
    const r = await h.cmd({ kind: 'history', thread: MS.direct, beforeTs: Date.now() - 100_000, limit: 10 });
    expect(r.messages.map((m: any) => m.messageId)).toEqual(['mid.$a2', 'mid.$a1']);
    expect(r.reactions.length).toBe(1);
    expect(r.done).toBe(true);
  });

  test('without __debug: ifRequired and the __d trap still reach every module', async () => {
    h = harness({ site: 'messenger', noDebug: true });
    await ready(h);
    const hooks = h.last('hooks');
    expect(hooks.records).toBe('ifRequired');
    expect(hooks.results['ls.db'].ok).toBe(true);
  });

  test('without LSDatabaseSingleton or ReQL: the lazy wrapper and the table iterator', async () => {
    h = harness({ site: 'messenger', missing: ['LSDatabaseSingleton', 'ReQL'] });
    const snap = await ready(h);
    const hooks = h.last('hooks');
    expect(hooks.results['ls.db'].via).toBe('LSDatabaseSingletonLazyWrapper');
    expect(hooks.results['ls.read'].via).toBe('table.entries');
    expect(snap.messages.length).toBe(5);
  });

  test('a subscription manager it cannot wrap: it subscribes table by table', async () => {
    h = harness({ site: 'messenger', frozenNotify: true });
    await ready(h);
    expect(h.last('hooks').results['ls.changes'].via).toBe('table.subscribe');
    const id = h.server.deliver(MS.group, 'via the table');
    await until(() => h!.all('rows').flatMap((r) => r.changes).find((c: any) => c.row.messageId === id), 5000, 'the row');
  });

  test('without the database at all: the core hook is missing and nothing is read', async () => {
    h = harness({ site: 'messenger', missing: ['LSDatabaseSingleton', 'LSDatabaseSingletonLazyWrapper'] });
    await until(() => h!.last('hooks')?.results?.['ls.db'], 5000, 'the self-test');
    await Bun.sleep(300);
    expect(h.last('hooks').results['ls.db']).toEqual({ ok: false, via: null, need: 'core' });
    expect(h.last('snapshot')).toBeUndefined();
    await expect(h.cmd({ kind: 'send', thread: MS.direct, text: 'x' })).rejects.toThrow(/not finished loading/);
  });

  test('signed out: says so, and looks for nothing', async () => {
    h = harness({ site: 'messenger', signedIn: false });
    await until(() => h!.last('page'), 5000, 'the page state');
    expect(h.last('page').signedIn).toBe(false);
    await Bun.sleep(300);
    expect(h.last('hooks').results['ls.db']).toBeUndefined();
  });

  test('a sign-in page runs nothing of ours', async () => {
    h = harness({ site: 'messenger', path: '/login/' });
    await Bun.sleep(400);
    expect(h.posted).toEqual([]);
  });
});
