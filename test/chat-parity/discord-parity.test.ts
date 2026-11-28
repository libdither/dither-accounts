/**
 * Composition parity for Discord (docs/parity-testing.md, docs/parity-discord.md): extractors/discord's real hook and
 * ingest (discord-extractor.ts) in a replica of the web client on a fake Discord (fake-discord.ts), against a bot
 * (DiscordBotOracle) on the same fake, which acts as the other person and reads the channel back as the oracle.
 * scripts/parity-discord.ts runs the same suite against real Discord with a throwaway account and a test bot.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DiscordApiError, DiscordBotOracle } from './discord-bot-oracle.ts';
import { discordDriver, snowflakeNow, type DiscordDriver } from './discord-driver.ts';
import { startDiscordExtractor } from './discord-extractor.ts';
import { fakeDiscord, type FakeDiscord, type FakeUser } from './fake-discord.ts';
import { type Cap, diffConversationStates } from './harness.ts';
import { REACT_1, runCompositionSuite } from './scenarios.ts';

const CAPS: Cap[] = ['send', 'edit', 'react', 'reply', 'delete', 'pin', 'media'];
const QUINN: FakeUser = { id: '100000000000000001', username: 'quinn_m', global_name: 'Quinn', token: 'user-token-quinn' };
const BOT: FakeUser = { id: '400000000000000009', username: 'parity-bot', bot: true, token: 'bot-token-parity' };

interface Rig {
  fake: FakeDiscord;
  d: DiscordDriver;
  oracle: DiscordBotOracle;
  stop(): Promise<void>;
}

async function rig(o: { filter?: (event: string, data: any) => boolean } = {}): Promise<Rig> {
  const fake = fakeDiscord({ users: [QUINN, BOT] });
  const dir = mkdtempSync(join(tmpdir(), 'discord-parity-'));
  const oracle = new DiscordBotOracle({ token: BOT.token, baseUrl: fake.botBase, sleep: async () => void expect.unreachable('a sleep in CI') });
  // The driver is made before the extractor runs, so the extractor's first events land in its folder.
  let d!: DiscordDriver;
  const ex = startDiscordExtractor({ fake, self: QUINN, emit: (ev: P.AdapterEvent) => d.apply(ev), filter: o.filter });
  d = discordDriver({
    name: 'discord (fake Discord, real hook + ingest)',
    oracle,
    channelId: fake.channelId,
    actorA: QUINN.id,
    actorB: BOT.id,
    capabilities: CAPS,
    command: (cmd) => ex.command(cmd as P.AdapterCommand),
    after: snowflakeNow(Date.now() - 1000),
    fileDir: dir,
    networkChanged: () => fake.changed(),
  });
  await ex.ready();
  return {
    fake,
    d,
    oracle,
    async stop() {
      ex.stop();
      fake.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

runCompositionSuite(
  'discord',
  async () => {
    const r = await rig();
    return Object.assign(r.d, { stop: r.stop });
  },
  { capabilities: CAPS },
);

describe('the Discord bot oracle', () => {
  let r: Rig;
  beforeAll(async () => {
    r = await rig();
  });
  afterAll(() => r.stop());

  test("reads the fake's world the way the fake holds it: authors, replies, edits, reactions by person, pins, files", async () => {
    const chan = r.fake.channelId;
    const a = (await r.d.send('A', 'from quinn')) as string;
    const b = await r.d.reply('B', a, 'from the bot');
    await r.d.edit('B', b, 'from the bot, edited');
    await r.d.react('A', b, REACT_1);
    await r.d.react('B', b, REACT_1);
    await r.d.pin('B', a, true);
    const f = await r.d.send('B', 'a file', { attachment: { name: 'x.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) } });
    const s = await r.oracle.oracleState(chan, { actorA: QUINN.id, actorB: BOT.id, after: '0', made: r.d.made });
    expect(s.messages[a]).toMatchObject({ author: 'A', body: 'from quinn', edited: false, pinned: true, replyTo: null });
    expect(s.messages[b]).toMatchObject({ author: 'B', body: 'from the bot, edited', edited: true, replyTo: a, reactionsByAuthor: { A: [REACT_1], B: [REACT_1] } });
    expect(s.messages[f]!.attachments).toEqual(['image']);
    // The pin's notice (type 6) is the network's own, not a message of either person.
    expect(Object.keys(s.messages)).toHaveLength(3);
    await r.d.delete('B', f);
    expect((await r.oracle.oracleState(chan, { actorA: QUINN.id, actorB: BOT.id, made: r.d.made })).deleted).toEqual([f]);
  });

  test('a 429 is waited out (Retry-After: 0 here, so at once) and the request goes again', async () => {
    r.fake.rateLimit(2);
    const before = r.oracle.rateLimited;
    const m = await r.oracle.send(r.fake.channelId, 'after two 429s');
    expect(r.oracle.rateLimited - before).toBe(2);
    expect(r.fake.channels.get(r.fake.channelId)!.get(m.id)?.content).toBe('after two 429s');
  });

  test('an error names the request and Discord\'s code, never the token', async () => {
    const err = await r.oracle.edit(r.fake.channelId, [...r.d.madeBy].find(([, by]) => by === 'A')![0], 'not mine').catch((e) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect(err.status).toBe(403);
    expect(String(err.message)).toContain('code 50005');
    expect(String(err.message)).not.toContain(BOT.token);
  });
});

describe('the oracle catches what the extractor gets wrong', () => {
  /** The extractor's state as soon as the dispatch it was meant to fold has come and gone. */
  async function afterDropped(event: string, act: (r: Rig) => Promise<string>, kind: string) {
    let heard: () => void = () => {};
    const dropped = new Promise<void>((res) => (heard = res));
    const r = await rig({
      filter: (ev) => {
        if (ev !== event) return true;
        heard();
        return false;
      },
    });
    try {
      const id = await act(r);
      await dropped;
      const diff = diffConversationStates(r.d.extractorState(), await r.d.oracleState());
      expect(diff.map((x) => x.kind)).toContain(kind as any);
      expect(diff.find((x) => x.kind === kind)!.id).toBe(id);
    } finally {
      await r.stop();
    }
  }

  test('a missed edit: the body and the edited flag differ', async () => {
    await afterDropped(
      'MESSAGE_UPDATE',
      async (r) => {
        const m = await r.d.send('B', 'one');
        await r.d.folder.next((e) => e.t === 'message' && e.message.nativeId === m);
        await r.d.edit('B', m, 'two');
        return m;
      },
      'body',
    );
  });

  test("a dropped reaction: the bot's reaction is missing", async () => {
    await afterDropped(
      'MESSAGE_REACTION_ADD',
      async (r) => {
        const m = await r.d.send('A', 'react to me');
        await r.d.react('B', m, REACT_1);
        return m;
      },
      'missing reaction',
    );
  });

  test('a missed delete: the message the bot deleted is still shown', async () => {
    await afterDropped(
      'MESSAGE_DELETE',
      async (r) => {
        const m = await r.d.send('B', 'soon gone');
        await r.d.folder.next((e) => e.t === 'message' && e.message.nativeId === m);
        await r.d.delete('B', m);
        return m;
      },
      'missed delete',
    );
  });
});
