/**
 * What the adapter remembers between runs (state.json in the account directory, 0600): enough to address the people
 * and chats it knows (Telegram wants each peer's access hash with every call), to place deletes and read receipts
 * (Telegram's delete in a private chat names message ids only), and who it is signed in as. Nothing anyone wrote.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface File {
  v: 1;
  self?: { id: number; name: string; username?: string; phone?: string };
  /** user id -> access hash (only from full user objects: a "min" one's hash does not work for calls). */
  users: Record<string, string>;
  /** channel id -> access hash. */
  channels: Record<string, string>;
  /** user id -> name, for the text of an outgoing mention. */
  names: Record<string, string>;
  forums: number[];
  /** Conversations Telegram has a dialog for (openDirect: did it exist). */
  dialogs: string[];
  /** Recent message ids of private chats and basic groups -> their conversation (for updateDeleteMessages). */
  msgConv: [number, string][];
  /** This account's recent messages per conversation, and how far the other side has read them. */
  outbox: Record<string, { ids: number[]; readUpTo: number }>;
}

const MSG_CONV_MAX = 20_000;
const OUTBOX_MAX = 200;

export class State {
  readonly path: string;
  self: File['self'];
  users = new Map<number, string>();
  channels = new Map<number, string>();
  names = new Map<number, string>();
  forums = new Set<number>();
  dialogs = new Set<string>();
  msgConv = new Map<number, string>();
  outbox = new Map<string, { ids: number[]; readUpTo: number }>();
  private timer?: Timer;

  constructor(dir: string) {
    this.path = join(dir, 'state.json');
    if (!existsSync(this.path)) return;
    try {
      const f = JSON.parse(readFileSync(this.path, 'utf8')) as File;
      this.self = f.self;
      for (const [k, v] of Object.entries(f.users ?? {})) this.users.set(Number(k), v);
      for (const [k, v] of Object.entries(f.channels ?? {})) this.channels.set(Number(k), v);
      for (const [k, v] of Object.entries(f.names ?? {})) this.names.set(Number(k), v);
      for (const id of f.forums ?? []) this.forums.add(id);
      for (const c of f.dialogs ?? []) this.dialogs.add(c);
      for (const [id, c] of f.msgConv ?? []) this.msgConv.set(id, c);
      for (const [c, o] of Object.entries(f.outbox ?? {})) this.outbox.set(c, o);
    } catch {
      // A torn or foreign file: start over; Telegram tells us everything again.
    }
  }

  rememberMessage(id: number, conv: string, own: boolean) {
    if (!conv.startsWith('channel:')) {
      this.msgConv.delete(id);
      this.msgConv.set(id, conv);
      if (this.msgConv.size > MSG_CONV_MAX) for (const k of [...this.msgConv.keys()].slice(0, this.msgConv.size - MSG_CONV_MAX)) this.msgConv.delete(k);
    }
    if (own) {
      const o = this.outbox.get(conv) ?? { ids: [], readUpTo: 0 };
      if (!o.ids.includes(id)) o.ids.push(id);
      o.ids.sort((a, b) => a - b);
      if (o.ids.length > OUTBOX_MAX) o.ids.splice(0, o.ids.length - OUTBOX_MAX);
      this.outbox.set(conv, o);
    }
    this.save();
  }

  /** Own messages the other side has now read up to `maxId`, newly. */
  readOutbox(conv: string, maxId: number): number[] {
    const o = this.outbox.get(conv);
    if (!o || maxId <= o.readUpTo) return [];
    const ids = o.ids.filter((id) => id > o.readUpTo && id <= maxId);
    o.readUpTo = maxId;
    this.save();
    return ids;
  }

  /** After a sign-out: nothing of the old account is kept. */
  clear() {
    this.self = undefined;
    for (const m of [this.users, this.channels, this.names, this.msgConv, this.outbox] as Map<unknown, unknown>[]) m.clear();
    this.forums.clear();
    this.dialogs.clear();
    this.flush();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const f: File = {
      v: 1,
      ...(this.self ? { self: this.self } : {}),
      users: Object.fromEntries(this.users),
      channels: Object.fromEntries(this.channels),
      names: Object.fromEntries(this.names),
      forums: [...this.forums],
      dialogs: [...this.dialogs],
      msgConv: [...this.msgConv],
      outbox: Object.fromEntries(this.outbox),
    };
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
