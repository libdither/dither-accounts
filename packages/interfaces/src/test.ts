/** `test.echo`: for the manager's own tests (extractors/fake). */
import { ev, iface, op, s } from '@dither-accounts/spec';

export const testEcho = iface({
  name: 'test.echo',
  version: 1,
  describe: 'A fake account for tests.',
  levels: { read: 'Hear echoes', write: 'Shout', manage: 'Make it emit' },
  ops: {
    echo: op('read', 'Answers what it was given', s.object({ text: s.string }), s.object({ text: s.string })),
    shout: op('write', 'Answers in capitals', s.object({ text: s.string }), s.object({ text: s.string })),
    fail: op('read', 'Fails with an HTTP status, and the code given (the extractor\'s own word for the refusal)', s.object({ status: s.integer, code: s.optional(s.string) }), s.unknown),
    slow: op('read', 'Answers after ms', s.object({ ms: s.integer }), s.unknown, 500),
    emit: op('manage', 'Emits n note events', s.object({ n: s.integer }), s.unknown),
    echoId: op('read', 'Answers the id it was given, or null (an input named id reaches the extractor as sent)', s.object({ id: s.optional(s.string) }), s.object({ id: s.nullable(s.string) })),
  },
  events: {
    hello: ev('Started', s.typed<Record<string, unknown>>(), true),
    status: ev('State', s.typed<Record<string, unknown>>(), true),
    note: ev('A note', s.object({ n: s.integer })),
  },
});
