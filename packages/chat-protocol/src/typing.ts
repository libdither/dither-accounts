/**
 * Typing indicators (docs/typing.md): who is typing where, and telling the networks when you are.
 *
 * Both directions are of the moment. Nothing about typing is stored or journaled: a client that reconnects simply does
 * not see a typer it missed, and a typer whose network never says "stopped" fades out after their TTL.
 */

/** How long a start lasts without another, as in Discord's client (10 s). Adapters may give their network's own. */
export const TYPING_TTL = 10_000;
/** While you keep typing, a start goes out again this often, as Discord's client does. */
export const TYPING_REFRESH = 8_000;
/** The hub passes on at most one start per account and conversation this often, whatever its clients ask. */
export const TYPING_MIN_GAP = 5_000;

/** Settings → Privacy. One choice for every network. */
export interface PrivacySettings {
  /** Tell the networks when you are typing. Default on. */
  shareTyping: boolean;
}

/** "Alice is typing…" as runs of text, names marked bold, the way Discord words it. */
export function typingLine(names: string[]): { text: string; bold?: true }[] {
  const b = (text: string) => ({ text, bold: true as const });
  const n = [...new Set(names)];
  if (!n.length) return [];
  if (n.length === 1) return [b(n[0]), { text: ' is typing…' }];
  if (n.length === 2) return [b(n[0]), { text: ' and ' }, b(n[1]), { text: ' are typing…' }];
  if (n.length === 3) return [b(n[0]), { text: ', ' }, b(n[1]), { text: ' and ' }, b(n[2]), { text: ' are typing…' }];
  return [{ text: 'Several people are typing…' }];
}

export interface TypingTarget {
  conversationId: string;
  /** The account that would send (the send-as choice), when there is one. */
  accountId?: string;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Turns composer input into starts and stops, throttled like Discord's client: a start at the first keystroke, again
 * at a keystroke TYPING_REFRESH after the last start, and a stop when the text is cleared or sent, the composer loses
 * focus, the target changes, or nothing was typed for TYPING_TTL.
 */
export class TypingSender {
  private cur: { key: string; target: TypingTarget; lastStart: number } | null = null;
  private idle: Timer | null = null;
  private readonly now: () => number;
  private readonly enabled: () => boolean;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;

  constructor(
    private send: (target: TypingTarget, stop: boolean) => void,
    opts: { now?: () => number; enabled?: () => boolean; setTimer?: (fn: () => void, ms: number) => Timer; clearTimer?: (t: Timer) => void } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.enabled = opts.enabled ?? (() => true);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
  }

  /** The composer's text changed by the user's hand. */
  input(target: TypingTarget, text: string) {
    if (!text.trim() || !this.enabled()) return this.stop();
    const key = `${target.conversationId}|${target.accountId ?? ''}`;
    if (this.cur && this.cur.key !== key) this.stop();
    const now = this.now();
    if (!this.cur || now - this.cur.lastStart >= TYPING_REFRESH) {
      this.cur = { key, target, lastStart: now };
      this.send(target, false);
    }
    if (this.idle) this.clearTimer(this.idle);
    this.idle = this.setTimer(() => this.stop(), TYPING_TTL);
  }

  /** Sent, cleared, left, or idle: say so if a start went out. */
  stop() {
    if (this.idle) this.clearTimer(this.idle);
    this.idle = null;
    const cur = this.cur;
    this.cur = null;
    if (cur) this.send(cur.target, true);
  }

  get active(): TypingTarget | null {
    return this.cur?.target ?? null;
  }
}
