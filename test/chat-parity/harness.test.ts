/**
 * The harness itself: the hub's folding (EventFolder), the diff, and the scenario runner against a toy network whose
 * extractor can be given each bug the matrix is there to catch. Clean, every scenario passes; with a bug, the
 * scenarios meant for it fail, naming it.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { type Actor, type Cap, diffConversationStates, EventFolder, type Handle, normalize, type ParityDriver, runScenario, scenarioRuns } from './harness.ts';
import { compositionScenarios } from './scenarios.ts';

const CONV = 'toy:dm';
const WHO: Record<Actor, string> = { A: 'u:me', B: 'u:ann' };

type Bug = 'edit-as-new' | 'react-to-edit' | 'edit-drops-reactions' | 'delete-misses-edited' | 'reply-to-edit' | 'no-edited-flag' | 'duplicate-late';

/** A network holding one conversation, and an extractor reporting it, with at most one bug. */
function toy(bug: Bug | null): ParityDriver {
  interface Msg { id: string; author: string; body: string; edited: boolean; replyTo: string | null; reactions: Map<string, Set<string>>; pinned: boolean; lastEdit?: string }
  const net = new Map<string, Msg>();
  const gone = new Set<string>();
  const folder = new EventFolder('matrix');
  let n = 0;
  const fact = (m: Msg, id = m.id): P.MessageFact => ({ nativeId: id, conversation: CONV, author: m.author, ts: 1, body: m.body, ...(m.edited && bug !== 'no-edited-flag' ? { editedTs: 2 } : {}), ...(m.replyTo ? { replyTo: bug === 'reply-to-edit' ? (net.get(m.replyTo)?.lastEdit ?? m.replyTo) : m.replyTo } : {}) });
  // The extractor hears of each change a moment later, as from a sync.
  const emit = (e: P.AdapterEvent) => queueMicrotask(() => folder.apply(e));
  const reactTarget = (m: Msg) => (bug === 'react-to-edit' && m.lastEdit ? m.lastEdit : m.id);
  const d: ParityDriver = {
    name: `toy${bug ? ` (${bug})` : ''}`,
    network: 'matrix',
    capabilities: ['send', 'edit', 'react', 'reply', 'delete', 'pin'] satisfies Cap[],
    actorA: WHO.A,
    actorB: WHO.B,
    async send(actor, body, o = {}) {
      const m: Msg = { id: `m${++n}`, author: WHO[actor], body, edited: false, replyTo: o.replyTo ?? null, reactions: new Map(), pinned: false };
      net.set(m.id, m);
      emit({ t: 'message', message: fact(m) });
      return m.id;
    },
    reply(actor, h, body) {
      return d.send(actor, body, { replyTo: h });
    },
    async edit(_actor, h, body) {
      const m = net.get(h)!;
      m.body = body;
      m.edited = true;
      m.lastEdit = `e${++n}`;
      if (bug === 'edit-as-new') emit({ t: 'message', message: fact(m, m.lastEdit) });
      else emit({ t: 'message', message: { ...fact(m), ...(bug === 'edit-drops-reactions' ? { reactions: [] } : {}) } });
      if (bug === 'duplicate-late') emit({ t: 'message', message: fact(m, `${m.id}-dup`) });
    },
    async react(actor, h, key, remove) {
      const m = net.get(h)!;
      const set = m.reactions.get(WHO[actor]) ?? m.reactions.set(WHO[actor], new Set()).get(WHO[actor])!;
      remove ? set.delete(key) : set.add(key);
      emit({ t: 'reaction', conversation: CONV, message: reactTarget(m), author: WHO[actor], key, ...(remove ? { remove: true } : {}) });
    },
    async delete(_actor, h) {
      const m = net.get(h)!;
      net.delete(h);
      gone.add(h);
      emit({ t: 'delete', conversation: CONV, nativeId: bug === 'delete-misses-edited' && m.lastEdit ? m.lastEdit : h });
    },
    async pin(_actor, h, pinned) {
      net.get(h)!.pinned = pinned;
      emit({ t: 'pin', conversation: CONV, message: h, pinned });
    },
    extractorState: () => folder.state(d, CONV),
    async oracleState() {
      return normalize(d, [...net.values()].map((m) => ({ ...m, reactions: [...m.reactions].flatMap(([author, keys]) => [...keys].map((key) => ({ author, key }))) })), gone);
    },
    changed: () => folder.changed(),
    mark: () => folder.events.length,
    dropped: (since) => folder.dropped.filter((x) => x.at >= since),
  };
  return d;
}

const ALL = compositionScenarios();
const named = (part: string) => ALL.filter((s) => s.name.includes(part));
/** A failing scenario ends at its first step that does not converge: a short limit keeps the test quick. */
const QUICK = { convergeMs: 150 };

describe('the folder folds as the hub does', () => {
  const d = { actorA: 'me', actorB: 'ann' };
  test('a reaction, pin or delete aimed at an unknown message is dropped, and said', () => {
    const f = new EventFolder('matrix');
    f.apply({ t: 'reaction', conversation: 'c', message: 'nope', author: 'ann', key: '👍' });
    f.apply({ t: 'pin', conversation: 'c', message: 'nope', pinned: true });
    f.apply({ t: 'delete', conversation: 'c', nativeId: 'nope' });
    expect(f.dropped.map((x) => [x.t, x.nativeId])).toEqual([['reaction', 'nope'], ['pin', 'nope'], ['delete', 'nope']]);
    expect(f.state(d, 'c')).toEqual({ messages: {}, deleted: [] });
  });
  test('a message fact replaces the message, but an edit flag, a reply and a delete stay', () => {
    const f = new EventFolder('matrix');
    f.apply({ t: 'message', message: { nativeId: 'm', conversation: 'c', author: 'me', ts: 1, body: 'one', replyTo: 'p', editedTs: 5 } });
    f.apply({ t: 'message', message: { nativeId: 'm', conversation: 'c', author: 'me', ts: 1, body: 'two' } });
    expect(f.state(d, 'c').messages.m).toMatchObject({ body: 'two', edited: true, replyTo: 'p', author: 'A' });
    f.apply({ t: 'delete', conversation: 'c', nativeId: 'm' });
    f.apply({ t: 'message', message: { nativeId: 'm', conversation: 'c', author: 'me', ts: 1, body: '' } });
    expect(f.state(d, 'c')).toEqual({ messages: {}, deleted: ['m'] });
  });
  test('exclusive reactions replace a person’s own; a snapshot is the whole list', () => {
    const f = new EventFolder('whatsapp');
    f.apply({ t: 'message', message: { nativeId: 'm', conversation: 'c', author: 'me', ts: 1, body: 'x' } });
    f.apply({ t: 'reaction', conversation: 'c', message: 'm', author: 'ann', key: '👍' });
    f.apply({ t: 'reaction', conversation: 'c', message: 'm', author: 'ann', key: '🎉' });
    expect(f.state(d, 'c').messages.m!.reactionsByAuthor).toEqual({ B: ['🎉'] });
    f.apply({ t: 'message', message: { nativeId: 'm', conversation: 'c', author: 'me', ts: 1, body: 'x', reactions: [{ key: '👍', authors: ['me'] }] } });
    expect(f.state(d, 'c').messages.m!.reactionsByAuthor).toEqual({ A: ['👍'] });
  });
});

describe('the diff names what differs', () => {
  const d = { actorA: 'me', actorB: 'ann' };
  test('a duplicate, a body, a lost reaction, a missed delete and a dangling reply', () => {
    const ex = normalize(d, [
      { id: 'm1', author: 'me', body: 'new', edited: true, reactions: [] },
      { id: 'e1', author: 'me', body: 'new', edited: false },
      { id: 'm2', author: 'ann', body: 'gone?', edited: false },
      { id: 'r', author: 'ann', body: 're', edited: false, replyTo: 'm3' },
    ]);
    const or = normalize(d, [
      { id: 'm1', author: 'me', body: 'new', edited: true, reactions: [{ author: 'ann', key: '👍' }] },
      { id: 'r', author: 'ann', body: 're', edited: false, replyTo: 'm3' },
      { id: 'm3', author: 'me', body: 'parent', edited: false },
    ], ['m2']);
    expect(diffConversationStates(ex, or).map((x) => `${x.kind} ${x.id}`).sort()).toEqual(['dangling replyTo r', 'extra message e1', 'missed delete m2', 'missing message m3', 'missing reaction m1'].sort());
    expect(diffConversationStates(ex, or).find((x) => x.kind === 'extra message')!.detail).toContain('a duplicate of m1?');
  });
});

describe('the scenarios against a toy network', () => {
  test('a correct extractor agrees with the network in every scenario', async () => {
    for (const s of ALL.filter((s) => scenarioRuns(toy(null), s))) await runScenario(toy(null), s);
  });

  const fails = async (bug: Bug, scenario: string, kinds: string[]) => {
    const err = await runScenario(toy(bug), named(scenario)[0]!, QUICK).then(() => null, (e: Error) => e.message);
    expect(err).not.toBeNull();
    for (const k of kinds) expect(err).toContain(k);
  };
  test('a chained edit that arrives as a new message', () => fails('edit-as-new', 'self: send → edit → edit', ['extra message', 'a duplicate of']));
  test('a reaction aimed at the edit instead of the message', () => fails('react-to-edit', 'peer: send → edit → edit → react', ['missing reaction', 'dropped event']));
  test('an edit that loses the reactions', () => fails('edit-drops-reactions', 'self: send → react → edit → unreact', ['missing reaction']));
  test('a delete that misses an edited message', () => fails('delete-misses-edited', 'peer: send → edit → edit → delete', ['missed delete', 'dropped event']));
  test('a reply pointing at an edit', () => fails('reply-to-edit', 'self: send → edit → reply', ['replyTo']));
  test('an edit not marked as one', () => fails('no-edited-flag', 'peer: send → edit → edit', ['edited']));
  test('a duplicate that comes late is caught by the barrier', () => fails('duplicate-late', 'self: send → edit → edit', ['extra message']));
});
