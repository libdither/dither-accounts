/** Bots and apps (src/interact.ts): what the hook hands over, as the protocol says it, and the hub's commands for it. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { commandsOutcome, interactCapability, interactDispatch, interactHookCommand, mapCommand } from '../src/interact.ts';

const bot = { id: '800000000000000001', username: 'helper', global_name: null, discriminator: '0', avatar: null, bot: true };

test('a command keeps its options; one with an option of a kind the protocol lacks is left out whole', () => {
  expect(mapCommand({ id: 'c1', name: 'roll', app: 'a', type: 1, options: [{ type: 'integer', name: 'sides', min: 2, max: 100, required: true }] })).toEqual({ id: 'c1', name: 'roll', app: 'a', kind: 'chat', options: [{ name: 'sides', type: 'integer', required: true, min: 2, max: 100 }] });
  expect(mapCommand({ id: 'c2', name: 'pick', app: 'a', type: 1, options: [{ type: 'string', name: 's', autocomplete: true, choices: [{ name: 'A', value: 'a' }] }] })!.options[0]).toEqual({ name: 's', type: 'string', choices: [{ name: 'A', value: 'a' }] });
  expect(mapCommand({ id: 'c3', name: 'x', app: 'a', type: 1, options: [{ type: null, name: 'weird' }] })).toBeNull();
  expect(mapCommand({ id: 'c4', name: 'Quote', app: 'a', type: 3, options: [] })?.kind).toBe('message');
  expect(mapCommand({ id: 'c5', name: 'x', type: 1, options: [] })).toBeNull();
});

test("the commands' bots come first as people; apps nobody here uses are left out", () => {
  const { users, result } = commandsOutcome({ commands: [{ id: 'c1', name: 'roll', app: 'a', type: 1, options: [] }], apps: [{ id: 'a', name: 'Helper', bot }, { id: 'b', name: 'Unused' }] });
  expect(users).toEqual([bot]);
  expect(result.apps).toEqual([{ id: 'a', name: 'Helper', bot: bot.id }]);
});

test("the hook's outcome and form as protocol events", () => {
  expect(interactDispatch('INTERACTION_OUTCOME', { nonce: 'n', channelId: 'c', messageId: 'm', state: 'failed', error: 'no' }).events).toEqual([{ t: 'interaction', outcome: { nonce: 'n', conversation: 'c', message: 'm', state: 'failed', error: 'no' } }]);
  expect(interactDispatch('INTERACTION_OUTCOME', { nonce: 'n', channelId: 'c', messageId: null, state: 'answered' }).events).toEqual([{ t: 'interaction', outcome: { nonce: 'n', conversation: 'c', state: 'answered' } }]);
  const f = interactDispatch('INTERACTION_FORM', { id: 'f', nonce: 'n', channelId: 'c', title: '', application: { id: 'a', name: 'Helper', bot }, fields: [{ kind: 'text', id: 's', style: 'short' }, { kind: 'display', text: 'hi' }, { kind: 'text' }] });
  expect(f.users).toEqual([bot]);
  expect(f.events).toEqual([{ t: 'appModal', modal: { id: 'f', nonce: 'n', conversation: 'c', app: { id: 'a', name: 'Helper', bot: bot.id }, title: 'A form', fields: [{ kind: 'text', id: 's', style: 'short' }, { kind: 'display', text: 'hi' }] } }]);
  expect(interactDispatch('INTERACTION_FORM', { id: 'f' }).events).toEqual([]);
});

test("the hub's interact as the hook's command, and the capability each needs", () => {
  const cmd = (interaction: P.InteractRequest) => ({ t: 'interact' as const, id: 'x', conversation: 'c', interaction });
  expect(interactHookCommand(cmd({ kind: 'component', message: 'm', component: 'roll' }))).toEqual({ kind: 'ixComponent', channelId: 'c', messageId: 'm', customId: 'roll' });
  expect(interactHookCommand(cmd({ kind: 'command', command: 'q', app: 'a', options: [], target: { kind: 'message', id: 'm' } }))).toEqual({ kind: 'ixRun', channelId: 'c', commandKind: 'message', commandId: 'q', app: 'a', options: [], targetId: 'm' });
  expect(interactHookCommand(cmd({ kind: 'modal', modal: 'f', values: [{ field: 's', value: 'x' }] }))).toEqual({ kind: 'ixSubmit', formId: 'f', values: [{ field: 's', value: 'x' }] });
  expect(interactCapability({ kind: 'command', command: 'q', app: 'a', options: [], target: { kind: 'message', id: 'm' } })).toBe('interactContext');
  expect(interactCapability({ kind: 'modal', modal: 'f', values: [] })).toBe('interactModals');
  expect(() => interactHookCommand(cmd({ kind: 'nope' } as never))).toThrow('What should it do?');
});
