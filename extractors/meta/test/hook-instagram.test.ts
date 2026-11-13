/**
 * hook.js on the fake Instagram (the Slide mailbox in a Relay store): the environment by name and by shape, the
 * snapshot and changed records it forwards, typing, and every command through Instagram's own message modules.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ALICE, IG, SELF } from '../../../test/fake-messenger.ts';
import { harness, until } from './harness.ts';

let h: ReturnType<typeof harness> | null = null;
afterEach(() => {
  h?.stop();
  h = null;
});
const ready = (x: ReturnType<typeof harness>) => until(() => x.last('snapshot'), 8000, 'the snapshot');
const records = (x: ReturnType<typeof harness>) => x.all('records');
const ig = (extra: Record<string, unknown> = {}) => harness({ site: 'instagram', ...extra } as any);

describe('the hook on Instagram', () => {
  test('the Slide store through PolarisRelayEnvironment, its change feed, and the message modules', async () => {
    h = ig();
    await ready(h);
    const r = h.last('hooks').results;
    expect(h.last('hooks').backend).toBe('slide');
    expect(r['slide.env']).toEqual({ ok: true, via: 'PolarisRelayEnvironment', need: 'core' });
    expect(r['slide.read'].via).toBe('RecordSource');
    expect(r['slide.changes'].via).toBe('store.publish');
    expect(r['slide.deltas'].via).toBe('IGDSlideMutationProcessor');
    expect(r['slide.typingIn'].via).toBe('IGDTypingIndicatorTransformer');
    for (const id of ['slide.send', 'slide.react', 'slide.edit', 'slide.typingOut', 'slide.markRead', 'slide.history']) expect(r[id].ok).toBe(true);
    expect(r['slide.unsend'].ok).toBe(false);
    expect(r['ls.db']).toBeUndefined();
  });

  test('the snapshot: threads, people with both their ids, messages with media and reactions; nothing else', async () => {
    h = ig();
    const snap = await ready(h);
    expect(snap.self).toMatchObject({ id: SELF.eimu, eimu: SELF.eimu });
    const direct = snap.threads.find((t: any) => t.threadFbid === IG.direct);
    expect(direct).toMatchObject({ threadId: IG.directIg, nodeId: `node:${IG.direct}`, title: ALICE.name, isGroup: false });
    expect(direct.users[0]).toMatchObject({ igid: ALICE.ig, fbid: ALICE.eimu, username: ALICE.username });
    expect(direct.receipts).toEqual([{ fbid: ALICE.eimu, ts: expect.any(Number) }]);
    const pic = snap.messages.find((m: any) => m.messageId === 'mid.$ig3');
    expect(pic.contentType).toBe('SlideMessageImageContent');
    expect(pic.attachments[0]).toMatchObject({ id: '800000000000001', preview: expect.stringContaining('/cat.png'), width: 1 });
    expect(snap.messages.find((m: any) => m.messageId === 'mid.$ig2').reactions).toEqual([{ emoji: '😂', senderFbid: ALICE.eimu, ts: expect.any(Number) }]);
    expect(snap.messages.find((m: any) => m.messageId === 'mid.$ig4')).toMatchObject({ edits: 1, editedTs: expect.any(Number) });
    const text = JSON.stringify(snap);
    expect(text).not.toContain('secret snippet');
    expect(text).not.toContain('old words');
  });

  test('changes: a new message, a reaction, an unsend by them, typing (Instagram ids turned into fbids)', async () => {
    h = ig();
    await ready(h);
    const id = h.server.deliver(IG.direct, 'are you there?');
    await until(() => records(h!).flatMap((r) => r.messages).find((m: any) => m.messageId === id), 5000, 'the new message');
    h.server.react(id, '🔥');
    await until(() => records(h!).flatMap((r) => r.messages).find((m: any) => m.messageId === id && m.reactions.length), 5000, 'the reaction');
    h.server.typing(IG.direct, true);
    const ty = await until(() => h!.last('typing'), 5000, 'typing');
    expect(ty).toMatchObject({ thread: IG.direct, sender: ALICE.eimu, on: true });
    h.server.unsendByThem(id);
    await until(() => records(h!).flatMap((r) => r.deleted).find((d: any) => d.message === id), 5000, 'the delete');
  });

  test('commands through IGDMAPI*: send (and reply), react, edit, typing, mark read, history', async () => {
    h = ig();
    await ready(h);
    const sent = await h.cmd({ kind: 'send', thread: IG.direct, text: 'hello from the hook', replyTo: 'mid.$ig1' });
    expect(sent.nativeId).toMatch(/^mid\.\$igsrv/);
    const call = h.server.calls.find((c) => c.name === 'IGDirectTextSendMutation')!;
    expect(call.keys).toContain('offline_threading_id');
    expect([...h.server.messages.values()].find((m) => m.id === sent.nativeId)?.replyTo).toBe('mid.$ig1');
    await h.cmd({ kind: 'react', thread: IG.direct, message: 'mid.$ig1', emoji: '❤️' });
    await h.cmd({ kind: 'edit', thread: IG.direct, message: sent.nativeId, text: 'hello, edited' });
    await h.cmd({ kind: 'typing', thread: IG.direct, on: true });
    expect(h.server.typingOut).toEqual([{ thread: IG.directIg, on: true }]);
    // In a group the client sends no typing at all; neither do we.
    expect(await h.cmd({ kind: 'typing', thread: IG.group, on: true })).toEqual({ ok: true, skipped: 'group' });
    await h.cmd({ kind: 'markRead', thread: IG.direct, upTo: 'mid.$ig3' });
    expect(h.server.reads.at(-1)).toEqual({ thread: IG.direct, message: 'mid.$ig3' });
    expect(h.server.calls.find((c) => c.name === 'useIGDMarkThreadAsReadMutation')!.keys).toEqual(['data', 'metadata']);
    const hist = await h.cmd({ kind: 'history', thread: IG.direct, beforeTs: Date.now() - 180_000, limit: 4 });
    expect(hist.asked).toBe(true);
    expect(hist.messages.map((m: any) => m.messageId)).toEqual(['mid.$ig1', 'mid.$old0', 'mid.$old1', 'mid.$old2']);
    // Unsend: no module for it here, so a plain refusal and no request.
    await expect(h.cmd({ kind: 'unsend', thread: IG.direct, message: sent.nativeId })).rejects.toThrow(/unsend module was not found/);
    // Every request the page made is one of the client's own operations.
    expect(new Set(h.server.calls.map((c) => c.name ?? c.path))).toEqual(new Set(['IGDirectTextSendMutation', 'IGDirectReactionSendMutation', 'IGDirectEditMessageMutation', '/ig_send_message', 'useIGDMarkThreadAsReadMutation', 'IGDMessageListOffMsysQuery']));
  });

  test('unsend, where the page has a module for it', async () => {
    h = ig({ unsendModule: true });
    await ready(h);
    expect(h.last('hooks').results['slide.unsend'].via).toBe('IGDMAPIUnsendMessage');
    await h.cmd({ kind: 'unsend', thread: IG.direct, message: 'mid.$ig2' });
    await until(() => records(h!).flatMap((r) => r.deleted).find((d: any) => d.message === 'mid.$ig2'), 5000, 'the delete');
  });

  test('without PolarisRelayEnvironment: the environment by its shape', async () => {
    h = ig({ missing: ['PolarisRelayEnvironment'] });
    await ready(h);
    expect(h.last('hooks').results['slide.env'].via).toBe('shape');
  });

  test('without the delta router or the typing transformer: still live, typing missing, said so', async () => {
    h = ig({ missing: ['IGDSlideMutationProcessor', 'IGDTypingIndicatorTransformer', 'IGDMAPISendTextMessage'] });
    await ready(h);
    const r = h.last('hooks').results;
    expect(r['slide.changes'].via).toBe('store.publish');
    expect(r['slide.typingIn'].ok).toBe(false);
    expect(r['slide.send'].ok).toBe(false);
    await expect(h.cmd({ kind: 'send', thread: IG.direct, text: 'x' })).rejects.toThrow(/send module is not loaded/);
  });

  test('a record without what a message needs is dropped and counted', async () => {
    h = ig();
    await ready(h);
    h.win.require('PolarisRelayEnvironment').default.commitUpdate((c: any) => c.set('SlideMessage:broken', { __id: 'SlideMessage:broken', __typename: 'SlideMessage', message_id: 'mid.$broken', thread_fbid: IG.direct }));
    await Bun.sleep(200);
    const survey = await h.cmd({ kind: 'survey' });
    expect(survey.dropped.message).toBe(1);
    expect(records(h).flatMap((r) => r.messages).some((m: any) => m.messageId === 'mid.$broken')).toBe(false);
    expect(survey.data.records.SlideMessage).toBeGreaterThan(3);
    expect(survey.presence.users.fbid).toBeGreaterThan(0);
  });

  test('signed out: says so', async () => {
    h = ig({ signedIn: false });
    await until(() => h!.last('page'), 5000, 'the page state');
    expect(h.last('page').signedIn).toBe(false);
  });
});
