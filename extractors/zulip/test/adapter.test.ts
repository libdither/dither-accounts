import { afterEach, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { ZulipAdapter } from '../src/adapter.ts';
import { fakeZulip } from './fake-zulip.ts';
import { testLink, type TestLink } from './link.ts';

let stops: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

async function online(secret: Record<string, unknown> = {}) {
  const z = fakeZulip();
  const link = testLink({ server: z.url, email: 'quinn@example.com' }, { apiKey: z.key, ...secret });
  const a = new ZulipAdapter();
  a.start(link);
  a.onConnect();
  stops.push(() => z.stop(), () => a.shutdown());
  await link.next((e) => e.t === 'status' && e.status === 'online');
  const host = new URL(z.url).host;
  return { z, link, a, host };
}

const of = <T extends P.AdapterEvent['t']>(link: TestLink, t: T) => link.events.filter((e): e is Extract<P.AdapterEvent, { t: T }> => e.t === t);

test('a password is swapped for an API key, which is kept and the password dropped', async () => {
  const z = fakeZulip();
  const link = testLink({ server: z.url, email: 'quinn@example.com' }, { password: 'pw' });
  const a = new ZulipAdapter();
  a.start(link);
  stops.push(() => z.stop(), () => a.shutdown());
  await link.next((e) => e.t === 'status' && e.status === 'online');
  expect(link.secretValue).toEqual({ apiKey: z.key, email: 'quinn@example.com' });
});

test('a wrong password asks the owner to sign in, and nothing is retried', async () => {
  const z = fakeZulip();
  const link = testLink({ server: z.url, email: 'quinn@example.com' }, { password: 'nope' });
  const a = new ZulipAdapter();
  a.start(link);
  stops.push(() => z.stop(), () => a.shutdown());
  const st = await link.next<Extract<P.AdapterEvent, { t: 'status' }>>((e) => e.t === 'status' && e.status === 'attention');
  expect(st.attention?.kind).toBe('login');
  expect(z.calls.filter((c) => c.path === '/fetch_api_key')).toHaveLength(1);
});

test('the organization, its folder, channels as forums, topics as threads and DMs come at start', async () => {
  const { link, host } = await online();
  expect(of(link, 'space').map((e) => e.space)).toEqual([
    { nativeId: host, kind: 'community', name: 'Example Org', topic: '' },
    { nativeId: `${host}/f/1`, kind: 'section', name: 'Work', parents: [{ nativeId: host, position: '000000' }] },
  ]);
  const convs = new Map(of(link, 'conversation').map((e) => [e.conversation.nativeId, e.conversation]));
  expect(convs.get(`${host}/s/3`)).toMatchObject({ shape: 'channel', variant: 'forum', name: 'general', spaces: [{ nativeId: host }], mute: {} });
  expect(convs.get(`${host}/s/4`)).toMatchObject({ spaces: [{ nativeId: `${host}/f/1` }], mute: { muted: true } });
  expect(convs.get(`${host}/s/3/t/plans`)).toMatchObject({ shape: 'thread', name: 'plans', parentConversation: `${host}/s/3`, lastMessageAt: 1_700_000_010_101 });
  expect(convs.get(`${host}/dm/8,9`)).toMatchObject({ shape: 'direct', participants: [`${host}/u/8`, `${host}/u/9`] });
  const me = of(link, 'identity').find((e) => e.identity.nativeId === `${host}/u/8`);
  // The sign-in address, not the stand-in the API shows others.
  expect(me?.identity).toMatchObject({ handle: 'quinn@example.com', displayName: 'Quinn Park', isSelf: true, avatarUrl: 'zulip:/user_avatars/2/q.png' });
});

test('messages and read state at start: mentions, reactions, unread counts', async () => {
  const { link, host } = await online();
  const m = new Map(of(link, 'message').map((e) => [e.message.nativeId, e.message]));
  expect(m.get(`${host}/m/100`)).toMatchObject({ conversation: `${host}/s/3/t/plans`, author: `${host}/u/9`, body: `hello <@${host}/u/8>`, mentionsSelf: true, ts: 1_700_000_000_100 });
  // Zulip's seconds, with the id's last digits as milliseconds so one second's messages keep their order.
  expect(m.get(`${host}/m/101`)?.reactions).toEqual([{ key: '👍', authors: [`${host}/u/9`] }]);
  // Moved to this topic after it was sent (Zulip's last_moved_timestamp): when, for the app's "moved" mark.
  expect(m.get(`${host}/m/101`)?.extra).toMatchObject({ movedAt: 1_700_000_050_000 });
  expect(m.get(`${host}/m/100`)?.extra?.movedAt).toBeUndefined();
  const reads = new Map(of(link, 'read').map((e) => [e.conversation, e]));
  expect(reads.get(`${host}/s/3/t/plans`)).toMatchObject({ unread: 1, mentions: 1, upToTs: 1_700_000_000_100 - 1 });
  expect(reads.get(`${host}/dm/8,9`)).toMatchObject({ unread: 1, mentions: 0 });
  expect(of(link, 'saved').at(-1)).toMatchObject({ saved: [{ message: `${host}/m/101` }], complete: true });
});

test('live events: a message, a reaction, an edit, a move to another topic, a delete, flags', async () => {
  const { z, link, host } = await online();
  const from = link.events.length;
  const msg = { id: 150, sender_id: 10, sender_full_name: 'Bob Kim', content: 'new @**all**', timestamp: 1_700_000_100, type: 'stream', stream_id: 3, subject: 'Plans', display_recipient: 'general', reactions: [], submessages: [] };
  z.addMessage({ ...msg, flags: ['wildcard_mentioned', 'stream_wildcard_mentioned'] });
  z.push({ type: 'message', message: msg, flags: ['wildcard_mentioned', 'stream_wildcard_mentioned'] });
  const live = await link.next<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.nativeId === `${host}/m/150`, 10_000, from);
  // Zulip's topics are the same whatever their case.
  expect(live).toMatchObject({ live: true, message: { conversation: `${host}/s/3/t/plans`, body: 'new @everyone', mentionsSelf: true, mentionsAll: true } });
  await link.next((e) => e.t === 'read' && e.conversation === `${host}/s/3/t/plans` && e.unread === 2, 5_000, from);

  z.push({ type: 'reaction', op: 'add', message_id: 150, user_id: 9, emoji_name: 'smile', emoji_code: '1f604', reaction_type: 'unicode_emoji' });
  expect(await link.next((e) => e.t === 'reaction', 5_000, from)).toEqual({ t: 'reaction', conversation: `${host}/s/3/t/plans`, message: `${host}/m/150`, author: `${host}/u/9`, key: '😄' });

  z.push({ type: 'update_message', message_id: 150, message_ids: [150], content: 'edited', edit_timestamp: 1_700_000_200, flags: [] });
  const edited = await link.next<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.body === 'edited', 5_000, from);
  expect(edited.message).toMatchObject({ editedTs: 1_700_000_200_000 });
  expect(edited.message.mentionsSelf).toBeUndefined();
  // An edit of its words is not a move.
  expect(edited.message.extra?.movedAt).toBeUndefined();

  z.push({ type: 'update_message', message_id: 150, message_ids: [150], stream_id: 3, orig_subject: 'plans', subject: 'later', propagate_mode: 'change_one', edit_timestamp: 1_700_000_300 });
  const moved = await link.next<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.conversation === `${host}/s/3/t/later`, 5_000, from);
  expect(moved.message.moved).toBe(true);
  expect(moved.message.extra).toMatchObject({ movedAt: 1_700_000_300_000 });
  // Resolving the topic renames it by its ✔ only: not a move, so the time stays the move's.
  const beforeResolve = link.events.length;
  z.push({ type: 'update_message', message_id: 150, message_ids: [150], stream_id: 3, orig_subject: 'later', subject: '✔ later', propagate_mode: 'change_all', edit_timestamp: 1_700_000_350 });
  const resolved = await link.next<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.nativeId === `${host}/m/150`, 5_000, beforeResolve);
  expect(resolved.message.extra).toMatchObject({ movedAt: 1_700_000_300_000 });

  z.push({ type: 'update_message_flags', op: 'add', flag: 'read', messages: [150], all: false });
  await link.next((e) => e.t === 'read' && e.conversation === `${host}/s/3/t/later` && e.unread === 0, 5_000, from);

  z.push({ type: 'delete_message', message_type: 'stream', stream_id: 3, topic: 'later', message_ids: [150] });
  expect(await link.next((e) => e.t === 'delete', 5_000, from)).toEqual({ t: 'delete', conversation: `${host}/s/3/t/later`, nativeId: `${host}/m/150` });

  z.push({ type: 'typing', op: 'start', message_type: 'direct', sender: { user_id: 9 }, recipients: [{ user_id: 8 }, { user_id: 9 }] });
  expect(await link.next((e) => e.t === 'typing', 5_000, from)).toMatchObject({ conversation: `${host}/dm/8,9`, author: `${host}/u/9`, ttl: 15_000 });
});

test('a queue the server forgot is registered again', async () => {
  const { z, link } = await online();
  const registers = () => z.calls.filter((c) => c.path === '/register').length;
  expect(registers()).toBe(1);
  const from = link.events.length;
  z.dropQueue();
  // A second start says the structure again: its space fact is the sign.
  await link.next((e) => e.t === 'space', 10_000, from);
  expect(registers()).toBe(2);
});

test('commands: send to a topic and a DM, a reply quotes, react, mark read, typing', async () => {
  const { z, a, host } = await online();
  const sent = await a.command({ t: 'send', id: '1', conversation: `${host}/s/3/t/plans`, body: `hi <@${host}/u/9>`, replyTo: `${host}/m/100` });
  expect(sent).toEqual({ nativeId: `${host}/m/200` });
  const post = z.calls.findLast((c) => c.path === '/messages' && c.method === 'POST')!;
  expect(post.params).toMatchObject({ type: 'stream', to: 3, topic: 'plans' });
  expect(post.params.content).toStartWith(`@_**Ann Lee|9** [said](${z.url}/#narrow/channel/3-general/topic/plans/near/100):\n\`\`\`quote\nhello @**Quinn Park|8**\n\`\`\`\nhi @**Ann Lee|9**`);
  await a.command({ t: 'send', id: '2', conversation: `${host}/dm/8,9`, body: 'yo' });
  expect(z.calls.findLast((c) => c.path === '/messages' && c.method === 'POST')!.params).toMatchObject({ type: 'direct', to: [9], content: 'yo' });
  // A channel takes messages only in its topics.
  await expect(a.command({ t: 'send', id: '3', conversation: `${host}/s/3`, body: 'x' })).rejects.toThrow('topic');

  await a.command({ t: 'react', id: '4', conversation: `${host}/s/3/t/plans`, message: `${host}/m/100`, key: '👍' });
  expect(z.calls.findLast((c) => c.path === '/messages/100/reactions')).toMatchObject({ method: 'POST', params: { emoji_name: 'thumbs_up', emoji_code: '1f44d', reaction_type: 'unicode_emoji' } });

  await a.command({ t: 'markRead', id: '5', conversation: `${host}/s/3/t/plans`, upTo: `${host}/m/100` });
  expect(z.calls.findLast((c) => c.path === '/messages/flags/narrow')?.params).toMatchObject({ anchor: 100, num_before: 1000, num_after: 0, op: 'add', flag: 'read' });

  await a.command({ t: 'typing', id: '6', conversation: `${host}/s/3/t/plans` });
  expect(z.calls.findLast((c) => c.path === '/typing')?.params).toEqual({ op: 'start', type: 'stream', stream_id: 3, topic: 'plans' });

  await a.command({ t: 'followThread', id: '7', conversation: `${host}/s/3/t/plans`, follow: true });
  expect(z.calls.findLast((c) => c.path === '/user_topics')?.params).toEqual({ stream_id: 3, topic: 'plans', visibility_policy: 3 });
});

test('history pages back by message id', async () => {
  const { a, host } = await online();
  const r = (await a.command({ t: 'history', id: '1', conversation: `${host}/s/3/t/plans`, limit: 1 })) as P.HistoryResult;
  expect(r).toMatchObject({ count: 1, next: '101' });
  const r2 = (await a.command({ t: 'history', id: '2', conversation: `${host}/s/3/t/plans`, limit: 1, cursor: r.next })) as P.HistoryResult;
  expect(r2).toMatchObject({ count: 1, next: '100', done: true });
});

test('an edit keeps the quote of the message it answers; follow and notify say the thread as it now stands', async () => {
  const { z, a, host } = await online();
  const quote = `@_**Ann Lee|9** [said](${z.url}/#narrow/channel/3-general/topic/plans/near/100):\n\`\`\`quote\nhello\n\`\`\`\n`;
  z.addMessage({ id: 160, sender_id: 8, sender_full_name: 'Quinn Park', content: `${quote}sure`, timestamp: 1_700_000_400, type: 'stream', stream_id: 3, subject: 'plans', display_recipient: 'general', reactions: [], submessages: [], flags: ['read'] });
  await a.command({ t: 'edit', id: '1', conversation: `${host}/s/3/t/plans`, message: `${host}/m/160`, body: 'sure, at noon' });
  expect(z.calls.findLast((c) => c.path === '/messages/160' && c.method === 'PATCH')?.params.content).toBe(`${quote}sure, at noon`);

  expect(await a.command({ t: 'followThread', id: '2', conversation: `${host}/s/3/t/plans`, follow: true })).toEqual({ joined: true, notify: 'all' });
  // Unmuting a followed topic keeps it followed: only what is given changes.
  expect(await a.command({ t: 'threadNotify', id: '3', conversation: `${host}/s/3/t/plans`, muted: false })).toEqual({ joined: true, notify: 'all' });
  expect(z.calls.findLast((c) => c.path === '/user_topics')?.params.visibility_policy).toBe(3);
  expect(await a.command({ t: 'markReadMany', id: '4', items: [{ conversation: `${host}/s/3/t/plans`, upTo: `${host}/m/100` }] })).toEqual({ marked: 1 });
  expect(await a.command({ t: 'ignore', id: '5', identity: `${host}/u/9`, ignored: true })).toEqual({ ignored: true });
});

test('a description changed in the organization settings is heard', async () => {
  const { z, link, host } = await online();
  const from = link.events.length;
  z.push({ type: 'realm', op: 'update_dict', property: 'default', data: { description: 'We make things' } });
  expect(await link.next((e) => e.t === 'space', 5_000, from)).toEqual({ t: 'space', space: { nativeId: host, kind: 'community', name: 'Example Org', topic: 'We make things' } });
});

test('a message deleted while the queue was gone is deleted here once it is back', async () => {
  const { z, link, host } = await online();
  const from = link.events.length;
  z.removeMessage(101);
  z.dropQueue();
  expect(await link.next((e) => e.t === 'delete', 10_000, from)).toEqual({ t: 'delete', conversation: `${host}/s/3/t/plans`, nativeId: `${host}/m/101` });
});

test("a profile gives the person's time zone as its own field, and as a fact for an app that does not read it", async () => {
  const { a, host } = await online();
  const about = (await a.command({ t: 'profile', id: 'p1', who: `${host}/u/9` })) as P.PersonAbout;
  expect(about.timeZone).toBe('Europe/Berlin');
  expect(about.facts).toContainEqual({ label: 'Time zone', value: 'Europe/Berlin' });
  const none = (await a.command({ t: 'profile', id: 'p2', who: `${host}/u/10` })) as P.PersonAbout;
  expect(none.timeZone).toBeUndefined();
});
