/**
 * attention.ts's facts fed into dither-chat's real hub Store, as pipeline.test.ts does for the rest: a mention found
 * late is triaged only while it is young by its own time, a message request is held silent under Requests (spam never
 * notifies), and a mute cleared in Discord clears the hub's.
 *
 * Needs a dither-chat checkout beside this repo (or DITHER_CHAT_REPO); skipped without one.
 */
import { afterAll, beforeAll, describe as describeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hubId } from '@dither-chat/protocol/ids';
import type * as P from '@dither-chat/protocol';
import { attentionSnapshot, mentionEvents, newAttention, requestChanges, settingsEvents, type RawDM } from '../src/attention.ts';
import { newState, translateSnapshot } from '../src/ingest.ts';
import type { RawChannel, RawMessage, RawSnapshot } from '../src/discord-types.ts';

const HUB_SRC = join(process.env.DITHER_CHAT_REPO ?? resolve(import.meta.dir, '../../../../dither-chat'), 'packages/hub/src');
const hub = existsSync(join(HUB_SRC, 'store.ts')) && existsSync(join(HUB_SRC, 'latenews.ts')) ? await import(join(HUB_SRC, 'store.ts')) : null;
const hubAdd = hub ? await import(join(HUB_SRC, 'add.ts')) : null;
const hubNotify = hub ? await import(join(HUB_SRC, 'requestnotify.ts')) : null;
const describe = hub ? describeAll : describeAll.skip;

const SELF = '100000000000000001';
const ALICE = '400000000000000001';
const GUILD = '200000000000000001';
const CHAN = '300000000000000200';
const DM = '600000000000000001';
const REQ_DM = '600000000000000005';
const SPAM_DM = '600000000000000006';
const alice = { id: ALICE, username: 'alice.chen', global_name: 'Alice' };
const flake = (ms: number) => ((BigInt(ms) - 1420070400000n) << 22n).toString();

const channels: RawChannel[] = [{ id: CHAN, type: 0, name: 'beginners', guild_id: GUILD }];
const snapshot: RawSnapshot = {
  self: { id: SELF, username: 'me' },
  guilds: [{ id: GUILD, name: 'Rust' }],
  channels,
  privateChannels: [
    { id: DM, type: 1, recipients: [alice], is_message_request: false, is_spam: false } as RawDM,
    { id: REQ_DM, type: 1, recipients: [alice], is_message_request: true, is_message_request_timestamp: new Date().toISOString(), is_spam: false } as RawDM,
    { id: SPAM_DM, type: 1, recipients: [alice], is_message_request: false, is_spam: true } as RawDM,
  ],
  relationships: [{ id: ALICE, type: 1 }],
  guildSettings: [{ guild_id: GUILD, channel_overrides: [{ channel_id: CHAN, muted: true }] }],
};

let dir: string;
let store: any;
let acc: { id: string };
const st = newState();
const att = newAttention();
const ingest = (events: P.AdapterEvent[]) => events.flatMap((ev) => store.ingest(acc, ev) as string[]);

beforeAll(() => {
  if (!hub) return;
  dir = mkdtempSync(join(tmpdir(), 'dither-attention-'));
  store = new hub.Store(join(dir, 'hub.sqlite'), (raw: string | null) => raw ?? null);
  acc = store.createAccount({ network: 'discord', label: 'throwaway', color: '#5865F2', adapter: 'discord' });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: SELF, handle: 'me', isSelf: true } });
  ingest(translateSnapshot(snapshot, st).events);
  ingest(attentionSnapshot(snapshot, st, att));
});

afterAll(() => {
  if (!hub) return;
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const mention = (ts: number, n: string): RawMessage => ({ id: flake(ts) + n, channel_id: CHAN, guild_id: GUILD, author: alice, content: `<@${SELF}> hi`, timestamp: new Date(ts).toISOString(), mentions: [{ id: SELF, username: 'me' }] }) as RawMessage;

describe('attention facts in a real hub', () => {
  test('a mention found a minute late is triaged; one found an hour late is only unread', () => {
    const young = mention(Date.now() - 60_000, '1');
    const old = mention(Date.now() - 60 * 60_000, '2');
    const fresh = ingest(mentionEvents([young, old], channels, st, att));
    expect(fresh).toEqual([hubId('msg', 'discord', young.id)]);
    const cid = hubId('cnv', 'discord', CHAN);
    const v = store.db.query(`SELECT unread, mentions FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`).get(cid);
    expect(v).toEqual({ unread: 2, mentions: 2 });
  });

  test('a mention the hub already had is not news again', () => {
    const m = mention(Date.now() - 30_000, '3');
    expect(ingest([{ t: 'message', live: true, message: { nativeId: m.id, conversation: CHAN, author: ALICE, ts: Date.now() - 30_000, body: 'x', mentionsSelf: true } }])).toHaveLength(1);
    expect(ingest(mentionEvents([m], channels, st, att))).toEqual([]);
  });

  test('message requests wait under Requests and hold their DM; the spam one never notifies', () => {
    const views = (hubAdd.requestViews(store) as P.RequestView[]).filter((r) => r.accountId === acc.id);
    expect(views.map((r) => [r.nativeId, r.kind, r.spam ?? false]).sort()).toEqual([
      [`message:${REQ_DM}`, 'message', false],
      [`message:${SPAM_DM}`, 'message', true],
    ]);
    expect(hubAdd.requestHeld(store.db, hubId('cnv', 'discord', REQ_DM))).toBe(true);
    expect(hubAdd.requestHeld(store.db, hubId('cnv', 'discord', DM))).toBe(false);
    // Alice is a friend with a DM: someone the account knows, yet the spam one stays quiet.
    expect(hubNotify.judgeRequest(store, acc.id, `message:${SPAM_DM}`)).toBeNull();
  });

  test('accepted in Discord: gone from Requests, the DM no longer held', () => {
    ingest(requestChanges([{ id: REQ_DM, type: 1, recipients: [alice], is_message_request: false, is_spam: false } as RawDM], st, att));
    expect((hubAdd.requestViews(store) as P.RequestView[]).map((r) => r.nativeId)).toEqual([`message:${SPAM_DM}`]);
    expect(hubAdd.requestHeld(store.db, hubId('cnv', 'discord', REQ_DM))).toBe(false);
  });

  test('a channel unmuted in Discord clears the mute the hub had', () => {
    const conv = () => store.bootstrap().conversations.find((c: P.ConversationView) => c.nativeId === CHAN);
    expect(conv().nativeMute).toEqual({ level: 'none', muted: true });
    ingest(settingsEvents([{ guildId: GUILD, settings: { guild_id: GUILD, channel_overrides: [] }, channels, guild: null }], st, att));
    expect(conv().nativeMute).toEqual({});
  });
});
