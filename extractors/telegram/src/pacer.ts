/**
 * Pacing, so the account is never flood-limited. Telegram does not publish its limits for user accounts; it answers
 * too many requests with FLOOD_WAIT_<seconds> and makes the account wait. So calls start no closer together than
 * their lane allows (lists and history slowest, sends one a second per chat), a method Telegram made wait is held
 * until the wait is over, and waits are reported (status details, the log).
 *
 * mtcute already sleeps through waits of up to 10 s and retries; what reaches here is longer. Background work (the
 * snapshot, catching up) waits it out, up to 15 minutes; a command waits up to 30 s and otherwise fails with
 * Telegram's wait in words.
 */
import { floodSeconds } from './backend.ts';

export type Lane = 'join' | 'dialogs' | 'history' | 'send' | 'read' | 'media' | 'light';

/**
 * join: Telegram flood-limits joining groups, adding contacts, adding people to groups and making groups hard, so those
 * (and removing a contact, unblocking) start seconds apart.
 */
export const SPACING: Record<Lane, number> = { join: 3000, dialogs: 1000, history: 700, send: 350, read: 300, media: 200, light: 120 };
/** Between two sends into the same conversation. */
export const PER_CHAT_SEND_MS = 1000;

const LANES: [RegExp, Lane][] = [
  [/^messages\.(importChatInvite|addChatUser|createChat)$|^channels\.(joinChannel|inviteToChannel)$|^contacts\.(addContact|importContacts|deleteContacts|unblock)$/, 'join'],
  [/^messages\.(getDialogs|getPeerDialogs|getForumTopics|getDialogFilters)$|^contacts\.(getContacts|getBlocked)$/, 'dialogs'],
  [/^messages\.(getHistory|getReplies|search|searchGlobal|getMessageReactionsList|getCommonChats|getMessages|getChatInviteImporters)$|^channels\.(getParticipants|getMessages)$/, 'history'],
  [/^messages\.(send\w*|forwardMessages|editMessage|deleteMessages|uploadMedia|editChat\w*|exportChatInvite|editExportedChatInvite|updatePinnedMessage|editForumTopic|hideChatJoinRequest)$|^channels\.(deleteMessages|edit\w*|toggle\w*)$/, 'send'],
  [/^messages\.(readHistory|readDiscussion|readMentions|readReactions)$|^channels\.readHistory$/, 'read'],
  [/^upload\./, 'media'],
];
export const laneOf = (method: string): Lane => LANES.find(([re]) => re.test(method))?.[1] ?? 'light';

export class FloodError extends Error {
  constructor(
    readonly method: string,
    readonly seconds: number,
  ) {
    super(`Telegram asks this account to wait ${seconds} s before more ${method}`);
  }
}

export interface PacerOptions {
  spacing?: Partial<Record<Lane, number>>;
  perChatSendMs?: number;
  maxForegroundWaitMs?: number;
  maxBackgroundWaitMs?: number;
  onFlood?: (method: string, seconds: number) => void;
}

export class Pacer {
  private spacing: Record<Lane, number>;
  private next = new Map<string, number>();
  private chains = new Map<string, Promise<void>>();
  private blocked = new Map<string, number>();
  /** The last waits Telegram asked for, newest last. */
  readonly floods: { method: string; seconds: number; at: number }[] = [];

  constructor(private o: PacerOptions = {}) {
    this.spacing = { ...SPACING, ...(o.spacing ?? {}) };
  }

  /** What Telegram holds back now: method -> seconds left. */
  held(): Record<string, number> {
    const out: Record<string, number> = {};
    const now = Date.now();
    for (const [m, until] of this.blocked) if (until > now) out[m] = Math.ceil((until - now) / 1000);
    return out;
  }

  /**
   * once: the call acts (joins, adds, answers): no retry after a flood wait, and a method Telegram holds fails at once
   * rather than waiting. maxWaitMs: a command's own limit on waiting (under the 30 s default).
   */
  async run<T>(method: string, fn: () => Promise<T>, opts: { background?: boolean; chat?: string; once?: boolean; maxWaitMs?: number } = {}): Promise<T> {
    const lane = laneOf(method);
    const limit = opts.once ? 0 : opts.background ? (this.o.maxBackgroundWaitMs ?? 15 * 60_000) : Math.min(opts.maxWaitMs ?? Infinity, this.o.maxForegroundWaitMs ?? 30_000);
    for (let attempt = 0; ; attempt++) {
      // A held method fails before it takes a turn in its lane, so the next call is not kept waiting for nothing.
      const held = (this.blocked.get(method) ?? 0) - Date.now();
      if (held > limit) throw new FloodError(method, Math.ceil(held / 1000));
      await this.slot(lane, this.spacing[lane]);
      if (lane === 'send' && opts.chat) await this.slot(`chat:${opts.chat}`, this.o.perChatSendMs ?? PER_CHAT_SEND_MS);
      const wait = (this.blocked.get(method) ?? 0) - Date.now();
      if (wait > 0) {
        if (wait > limit) throw new FloodError(method, Math.ceil(wait / 1000));
        await Bun.sleep(wait);
      }
      try {
        return await fn();
      } catch (e) {
        const s = floodSeconds(e);
        if (s === null) throw e;
        this.blocked.set(method, Date.now() + s * 1000);
        this.floods.push({ method, seconds: s, at: Date.now() });
        if (this.floods.length > 20) this.floods.shift();
        this.o.onFlood?.(method, s);
        if (opts.once || s * 1000 > limit || attempt >= 3) throw new FloodError(method, s);
        await Bun.sleep(s * 1000);
      }
    }
  }

  /** Wait for this lane's turn: starts at least `gap` ms apart, in the order asked. */
  private async slot(key: string, gap: number) {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.chains.set(
      key,
      prev.then(() => mine),
    );
    await prev;
    const wait = (this.next.get(key) ?? 0) - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    this.next.set(key, Date.now() + gap);
    release();
  }
}
