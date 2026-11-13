/**
 * A fake chat account for tests, through dither-chat's own adapter client (the wire the real adapters speak): you
 * ("me") and Alice in one DM. On connect it sends hello, status and the DM with two old messages. `send` echoes your
 * message back as a live fact; `createGroup` makes `group:<name>` with everyone invited; the `emit` action makes Alice say n things (live); `resync` sends the snapshot again.
 * Native ids are fixed per account, so a resent snapshot changes nothing in the hub. With config.vncSocket it says it
 * has a live view on that Unix socket (the live view tests put a stand-in VNC server on it), as Discord's sandbox does. Its status
 * carries a dependency chain (network → signed in → snapshot); config.failLayer names one to fail (with
 * config.failNote), and the ones after it wait; config.noLayers sends none.
 */
import type { AdapterEvent, CreateGroupResult, MessageFact, StatusLayer } from '@dither-chat/protocol';
import { linkHub } from '@dither-chat/protocol/client';

let seq = 0;
const ME = 'me';
const ALICE = 'alice';
const DM = 'dm:me:alice';
const msg = (author: string, body: string, ts: number, nativeId = `m${Date.now()}-${seq++}`): MessageFact => ({ nativeId, conversation: DM, author, ts, body });

const hub = linkHub({
  onConnect: () => snapshot(),
  async onCommand(cmd) {
    switch (cmd.t) {
      case 'send': {
        const m = msg(ME, cmd.body, Date.now());
        hub.emit({ t: 'message', message: m, live: true });
        return { nativeId: m.nativeId };
      }
      case 'history':
        return { count: 0, done: true };
      case 'markRead':
      case 'typing':
        return { ok: true };
      case 'createGroup': {
        // As the real ones: refused in words before anything, else identities, the group's fact, then the answer.
        const name = cmd.name?.trim();
        if (!name) throw new Error('Give the room a name');
        const people = cmd.people.filter((p) => p !== ME);
        const conversation = `group:${name}`;
        for (const p of people) hub.emit({ t: 'identity', identity: { nativeId: p, displayName: p } });
        hub.emit({ t: 'conversation', conversation: { nativeId: conversation, shape: 'group', name, participants: [ME, ...people] } });
        return { conversation, added: [], invited: people } satisfies CreateGroupResult;
      }
      case 'action': {
        if (cmd.action === 'resync') return snapshot(), { ok: true };
        if (cmd.action === 'emit') {
          const n = Number((cmd.args as { n?: number })?.n ?? 1);
          for (let i = 0; i < n; i++) hub.emit({ t: 'message', message: msg(ALICE, `hello ${i}`, Date.now() + i), live: true });
          return { emitted: n };
        }
        if (cmd.action === 'pid') return { pid: process.pid };
        throw new Error(`unknown action ${cmd.action}`);
      }
      default:
        throw new Error(`the fake does not do ${cmd.t}`);
    }
  },
});

function layers(): { layers?: StatusLayer[] } {
  const c = hub.config;
  if (c.noLayers) return {};
  const names = ['network', 'signed in', 'snapshot'];
  const notes: Record<string, string> = { network: 'a fake one, in this process', 'signed in': 'as Me', snapshot: 'one DM, two messages' };
  const at = names.indexOf(String(c.failLayer ?? ''));
  return {
    layers: names.map((name, i): StatusLayer =>
      at < 0 || i < at
        ? { name, state: 'ok', note: notes[name] }
        : i === at
          ? { name, state: 'failed', note: String(c.failNote ?? 'failed on purpose (config.failLayer)') }
          : { name, state: 'waiting', note: `waits for ${names[at]}` },
    ),
  };
}

function snapshot() {
  const evs: AdapterEvent[] = [
    { t: 'hello', network: 'matrix', version: 'fake', capabilities: ['send', 'history', 'createGroup'] },
    { t: 'status', status: 'online', self: { nativeId: ME, displayName: 'Me', isSelf: true }, ...(typeof hub.config.vncSocket === 'string' ? { liveView: { vncSocket: hub.config.vncSocket, width: 800, height: 600 } } : {}), ...layers() },
    { t: 'identity', identity: { nativeId: ALICE, displayName: 'Alice', contact: true } },
    { t: 'conversation', conversation: { nativeId: DM, shape: 'direct', participants: [ME, ALICE] } },
    { t: 'message', message: msg(ALICE, 'an old message', 1_700_000_000_000, 'old-1'), live: false },
    { t: 'message', message: msg(ME, 'an old answer', 1_700_000_001_000, 'old-2'), live: false },
  ];
  for (const e of evs) hub.emit(e);
}
