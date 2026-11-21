import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emoji, charToCode, keyOf, reactionOf } from '../src/emoji.ts';
import { apply, fold, pollCommand, pollFact, todoBody, voteChanges, type PollState, type TodoState } from '../src/widgets.ts';

const sub = (id: number, sender: number, content: unknown) => ({ id, sender_id: sender, msg_type: 'widget', content: JSON.stringify(content) });

test('a poll folds from its submessages: canned and added options, votes toggled per person', () => {
  const st = fold([
    sub(1, 9, { widget_type: 'poll', extra_data: { question: 'Lunch?', options: ['Tacos', 'Pizza'] } }),
    sub(2, 10, { type: 'vote', key: 'canned,0', vote: 1 }),
    sub(3, 8, { type: 'vote', key: 'canned,1', vote: 1 }),
    sub(4, 10, { type: 'new_option', idx: 1, option: 'Soup' }),
    sub(5, 8, { type: 'vote', key: '10,1', vote: 1 }),
    sub(6, 8, { type: 'vote', key: 'canned,1', vote: -1 }),
    // Only the author may change the question.
    sub(7, 10, { type: 'question', question: 'Dinner?' }),
  ]) as PollState;
  expect(st.kind).toBe('poll');
  expect(pollFact(st, 8)).toEqual({
    question: 'Lunch?',
    options: [
      { id: 'canned,0', text: 'Tacos' },
      { id: 'canned,1', text: 'Pizza' },
      { id: '10,1', text: 'Soup' },
    ],
    multi: true,
    counts: { 'canned,0': 1, 'canned,1': 0, '10,1': 1 },
    voters: 2,
    mine: ['10,1'],
  });
  expect(voteChanges(st, 8, ['canned,0'])).toEqual([
    { key: 'canned,0', vote: 1 },
    { key: '10,1', vote: -1 },
  ]);
  expect(apply(st, sub(8, 9, { type: 'question', question: 'Brunch?' }))).toBe(true);
  expect(st.question).toBe('Brunch?');
});

test('a to-do list folds, and strikes toggle', () => {
  const st = fold([
    sub(1, 9, { widget_type: 'todo', extra_data: { task_list_title: 'Launch', tasks: [{ task: 'Write docs', desc: '' }, { task: 'Ship', desc: 'Friday' }] } }),
    sub(2, 10, { type: 'strike', key: '0,canned' }),
    sub(3, 10, { type: 'new_task', key: 2, task: 'Party', desc: '', completed: false }),
  ]) as TodoState;
  expect(todoBody(st)).toBe('**Launch**\n☑ ~~Write docs~~\n☐ Ship: Friday\n☐ Party');
  apply(st, sub(4, 8, { type: 'strike', key: '0,canned' }));
  expect(todoBody(st)).toContain('☐ Write docs');
});

test('a message without a widget folds to nothing', () => {
  expect(fold([])).toBeNull();
  expect(fold([{ sender_id: 1, msg_type: 'widget', content: 'not json' }])).toBeNull();
});

test('a poll is made the way the compose box writes one', () => {
  expect(pollCommand({ question: ' Lunch? ', options: ['Tacos', ' ', 'Pizza '], multi: true })).toBe('/poll Lunch?\nTacos\nPizza');
});

test("reactions: the hub's key to Zulip's name, code and type, and back", () => {
  const e = new Emoji(join(mkdtempSync(join(tmpdir(), 'zemoji-')), 'emoji.json'));
  e.set({ name_to_codepoint: { thumbs_up: '1f44d', heart: '2764', zulip: 'zulip' }, codepoint_to_name: { '1f44d': 'thumbs_up', '2764': 'heart' } });
  e.realm.set('7', { id: '7', name: 'partyparrot', source_url: '/user_avatars/2/emoji/images/7.gif' });
  expect(reactionOf('👍', e)).toEqual({ emoji_name: 'thumbs_up', emoji_code: '1f44d', reaction_type: 'unicode_emoji' });
  // ❤️ carries a variation selector the table leaves out.
  expect(reactionOf('❤️', e)).toEqual({ emoji_name: 'heart', emoji_code: '2764', reaction_type: 'unicode_emoji' });
  expect(reactionOf('realm:7', e)).toEqual({ emoji_name: 'partyparrot', emoji_code: '7', reaction_type: 'realm_emoji' });
  expect(reactionOf('zulip:zulip', e)).toEqual({ emoji_name: 'zulip', emoji_code: 'zulip', reaction_type: 'zulip_extra_emoji' });
  expect(reactionOf('🫠', e)).toBeNull();
  expect(keyOf({ emoji_code: '1f44d', reaction_type: 'unicode_emoji' })).toBe('👍');
  expect(keyOf({ emoji_code: '7', reaction_type: 'realm_emoji' })).toBe('realm:7');
  expect(charToCode('❤️')).toBe('2764');
});
