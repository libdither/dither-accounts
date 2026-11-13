import { expect, test } from 'bun:test';
import { agentName, clipText, conversationOf, fromListItem, fromShell, MAX_TEXT, messageOf, projectFilter, stateWord, type Summary, type Turn } from '../src/map.ts';

const base: Summary = { id: 'th-1', projectId: 'p-1', title: 'Fix it', status: 'running', providerInstanceId: 'claudeAgent', model: 'model-x', itemCount: 3, updatedAt: 1000, archived: false, subagent: false, latestRunId: 'r-1', pending: null, lastError: null, lastVisitedAt: null };

test('the state in words', () => {
  expect(stateWord({ status: 'running', pending: null })).toBe('Working');
  expect(stateWord({ status: 'queued', pending: null })).toBe('Working');
  expect(stateWord({ status: 'running', pending: { id: 'q', kind: 'user_input' } })).toBe('Waiting for your answer');
  // A run waiting on something that is not you (delegated work) is still working.
  expect(stateWord({ status: 'waiting', pending: null })).toBe('Working');
  expect(stateWord({ status: 'completed', pending: null })).toBe('Finished');
  expect(stateWord({ status: 'failed', pending: null })).toBe('Failed');
  expect(stateWord({ status: 'interrupted', pending: null })).toBe('Stopped');
  expect(stateWord({ status: 'idle', pending: null })).toBe('Idle');
});

test('a thread as a channel in its project', () => {
  expect(conversationOf({ ...base, archived: true })).toEqual({ nativeId: 'th-1', shape: 'channel', name: 'Fix it', topic: 'Working · model-x', spaces: [{ nativeId: 'project:p-1' }], lastMessageAt: 1000, archived: true });
  expect(conversationOf({ ...base, title: '' }).name).toBe('Untitled thread');
});

test('summaries from the shell and from the list', () => {
  expect(fromShell({ id: 'a', deletedAt: '2026-01-01T00:00:00Z' })).toBeNull();
  const s = fromShell({ id: 'a', projectId: 'p', title: 'T', status: 'waiting', providerInstanceId: 'codex', modelSelection: { model: 'm' }, visibleItemCount: 4, itemCount: 9, updatedAt: '2026-01-01T00:00:01Z', archivedAt: null, lineage: { relationshipToParent: 'subagent' }, latestRunId: 'r', pendingRuntimeRequest: { id: 'q', kind: 'user_input' }, lastVisitedAt: '2026-01-01T00:00:02Z' })!;
  expect(s).toMatchObject({ itemCount: 4, model: 'm', subagent: true, pending: { id: 'q', kind: 'user_input' }, updatedAt: Date.parse('2026-01-01T00:00:01Z'), lastVisitedAt: Date.parse('2026-01-01T00:00:02Z') });
  expect(fromListItem({ threadId: 'b', projectId: 'p', title: 'U', status: 'completed', providerInstanceId: 'claudeAgent', model: 'm', itemCount: 2, updatedAt: '2026-01-01T00:00:00Z', relationshipToParent: 'fork' })).toMatchObject({ id: 'b', subagent: false, pending: null });
});

test('who wrote a turn', () => {
  const turn = (type: Turn['type'], createdBy: string | null, messageId: string | null = 'm-1'): Turn => ({ position: 0, itemId: 'i-1', messageId, type, status: 'completed', createdBy, text: 'x', ts: 5 });
  const none = () => false;
  expect(messageOf(base, turn('assistant_message', 'agent'), none).author).toBe('agent:claudeAgent');
  expect(messageOf(base, turn('user_message', 'user'), none).author).toBe('me');
  expect(messageOf(base, turn('user_message', 'agent'), none).author).toBe('agent:other');
  expect(messageOf(base, turn('user_message', 'agent'), (id) => id === 'm-1').author).toBe('me');
  expect(messageOf(base, turn('user_message', 'system'), none).author).toBe('t3');
  expect(messageOf(base, turn('user_message', 'user', null), none).nativeId).toBe('i-1');
  expect(agentName('codex')).toBe('Codex');
  expect(agentName('my-provider')).toBe('my-provider');
});

test('very long text is kept whole up to the cap, then clipped with a note', () => {
  expect(clipText('short')).toBe('short');
  const long = clipText('a'.repeat(MAX_TEXT + 10));
  expect(long.startsWith('a'.repeat(MAX_TEXT))).toBe(true);
  expect(long).toContain('clipped here: 10 more characters in T3 Code');
});

test('which projects: ids, titles in any case, folders', () => {
  const p = (id: string, title: string, workspaceRoot: string) => ({ id, title, workspaceRoot });
  const all = projectFilter('');
  expect(all(p('x', 'X', '/a'))).toBe(true);
  const some = projectFilter('proj-1, acme app\n/srv/work/');
  expect(some(p('proj-1', 'Other', '/z'))).toBe(true);
  expect(some(p('p2', 'Acme App', '/z'))).toBe(true);
  expect(some(p('p3', 'Q', '/srv/work/q'))).toBe(true);
  expect(some(p('p4', 'Q', '/srv/work'))).toBe(true);
  expect(some(p('p5', 'Q', '/srv/workshop'))).toBe(false);
  expect(projectFilter(['p6'])(p('p6', 'Q', '/'))).toBe(true);
});
