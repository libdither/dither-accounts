import { expect, test } from 'bun:test';
import { FORWARD_KEY, forwardableContent, forwardOf } from '../src/messages.ts';

test('a forwarded copy keeps the content and drops what tied it to its room', () => {
  const c = forwardableContent({
    msgtype: 'm.text',
    body: '> <@a:x.org> earlier\n\nmy answer',
    format: 'org.matrix.custom.html',
    formatted_body: '<mx-reply><blockquote>earlier</blockquote></mx-reply>my <b>answer</b>',
    'm.relates_to': { 'm.in_reply_to': { event_id: '$e' } },
    'm.mentions': { user_ids: ['@a:x.org'] },
  });
  expect(c).toEqual({ msgtype: 'm.text', body: 'my answer', format: 'org.matrix.custom.html', formatted_body: 'my <b>answer</b>', 'm.mentions': {} });
  const file = { msgtype: 'm.image', body: 'a.png', url: 'mxc://x.org/abc', info: { mimetype: 'image/png' } };
  expect(forwardableContent(file)).toEqual({ ...file, 'm.mentions': {} });
});

test('where a forward came from is read back, and nonsense is not', () => {
  expect(forwardOf({ [FORWARD_KEY]: { room_id: '!r:x.org', event_id: '$e', sender: '@a:x.org', origin_server_ts: 5 } })).toEqual({ conversation: '!r:x.org', message: '$e', author: '@a:x.org', ts: 5 });
  expect(forwardOf({ [FORWARD_KEY]: 'yes' })).toBeUndefined();
  expect(forwardOf({ [FORWARD_KEY]: {} })).toBeUndefined();
  expect(forwardOf({ body: 'x' })).toBeUndefined();
});
