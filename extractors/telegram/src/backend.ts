/**
 * What the adapter needs from a Telegram client: raw MTProto calls in TL objects, the sign-in flows, files, and the
 * update stream. `mtcute.ts` is the real one (mtcute over Telegram's servers), `fake.ts` a fake Telegram for tests
 * (TELEGRAM_FAKE=1). Everything else in this extractor speaks TL through this, so the fake runs all of it.
 */
import type { tl } from '@mtcute/bun';

export type { tl };

/** One update with the users and chats that came with it. */
export interface UpdateInfo {
  update: tl.TypeUpdate;
  users: tl.TypeUser[];
  chats: tl.TypeChat[];
}

export type ConnState = 'connecting' | 'updating' | 'connected' | 'offline';

export interface QrHandlers {
  /** A new login URL (tg://login?token=…) and when it expires (ms epoch). */
  onUrl(url: string, expiresAt: number): void;
  /** The phone accepted it; the client finishes signing in (it may still need the password). */
  onScanned(): void;
  /** The two-step verification password. Asked again, with `wrong`, after a wrong one. */
  password(hint: string | null, wrong: boolean): Promise<string>;
  signal: AbortSignal;
}

export interface SentCode {
  phoneCodeHash: string;
  /** Where the code went: 'app' (another Telegram session), 'sms', 'call', 'flashCall', 'email', 'fragment', ... */
  type: string;
  /** Digits, when Telegram says. */
  length?: number;
  /** Where it goes if asked again. */
  nextType?: string;
  /** Seconds before it may be sent again. */
  timeout?: number;
}

export interface UploadSpec {
  path: string;
  name: string;
  mime: string;
  size: number;
}

export interface BackendInfo {
  library: string;
  layer: number;
  testMode: boolean;
  dc: number | null;
}

/** Telegram Desktop's signed-in session, from its tdata (tdata.ts): who, where, and its auth key. */
export interface DesktopKey {
  userId: bigint;
  dcId: number;
  authKey: Uint8Array;
  /** sha256 of the key, cut short: which key, without the key. */
  fingerprint: string;
}

/** A client on Telegram Desktop's key that signs in the extractor's own session (mtcute.ts MtcuteDeskClient, or the fake's). */
export interface DeskClient {
  acceptLoginToken(token: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface TgBackend {
  /** Connect, with the saved session if there is one. Who is signed in, or null. Throws when the session is no good. */
  start(session: string | null): Promise<tl.RawUser | null>;
  /** The QR login flow until signed in (or aborted). */
  qrLogin(h: QrHandlers): Promise<tl.RawUser>;
  sendCode(phone: string): Promise<SentCode>;
  resendCode(phone: string, phoneCodeHash: string): Promise<SentCode>;
  /** Throws SESSION_PASSWORD_NEEDED when the account has a password (then checkPassword). */
  signIn(phone: string, phoneCodeHash: string, code: string): Promise<tl.RawUser>;
  checkPassword(password: string): Promise<tl.RawUser>;
  passwordHint(): Promise<string | null>;
  /** The session as one string, for secret.json. */
  exportSession(): Promise<string>;
  /**
   * Raw call. Updates in its result are fed to the client's own state (not dispatched as updates). once: the call acts
   * (a join, a contact added): the client must not send it again by itself, after a flood wait or an internal error.
   */
  call<T extends tl.RpcMethod>(req: T, opts?: { timeoutMs?: number; floodSleepMs?: number; once?: boolean }): Promise<tl.RpcCallReturn[T['_']]>;
  /** Start receiving updates (with what was missed since the last run, where the client keeps state). */
  startUpdates(onUpdate: (u: UpdateInfo) => void, onState: (s: ConnState) => void): Promise<void>;
  uploadFile(f: UploadSpec): Promise<tl.TypeInputFile>;
  download(location: tl.TypeInputFileLocation, opts: { dcId?: number; size?: number }): Promise<Uint8Array>;
  /** Signs this session out on Telegram. */
  logOut(): Promise<void>;
  /** Forget the local state that belongs to the session (after a sign-out or a revoked session). */
  wipe(): Promise<void>;
  close(): Promise<void>;
  /** Fetch missed updates now (updates.getDifference), where the client keeps update state. */
  catchUp?(): void;
  info(): BackendInfo;
}

// ---------------------------------------------------------------- errors

/** Telegram's error text ("FLOOD_WAIT_30", "PEER_ID_INVALID") from whatever was thrown. */
export function rpcText(e: unknown): string {
  const any = e as { text?: unknown; errorMessage?: unknown; message?: unknown } | null;
  if (typeof any?.text === 'string') return any.text;
  if (typeof any?.errorMessage === 'string') return any.errorMessage;
  return typeof any?.message === 'string' ? any.message : String(e);
}

/** mtcute puts the wait in `seconds` and keeps "FLOOD_WAIT_%d" as the text. */
export function floodSeconds(e: unknown): number | null {
  const any = e as { seconds?: unknown; code?: unknown } | null;
  const text = rpcText(e);
  if (!/^(FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT|FLOOD_TEST_PHONE_WAIT)_/.test(text) && any?.code !== 420) return null;
  if (typeof any?.seconds === 'number') return any.seconds;
  const m = text.match(/_(\d+)$/);
  return m ? Number(m[1]) : 1;
}

export const isRpc = (e: unknown, text: string) => {
  const t = rpcText(e);
  return t === text || t.replace(/_\d+$/, '_%d') === text;
};

/** The session no longer works: signed out elsewhere, revoked, or the account is gone. */
export const isAuthGone = (e: unknown) =>
  ['AUTH_KEY_UNREGISTERED', 'AUTH_KEY_INVALID', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN', 'AUTH_KEY_PERM_EMPTY'].includes(rpcText(e));

/** An error with Telegram's text, as the fake throws it (mtcute's RpcError has the same `code` and `text`). */
export class FakeRpcError extends Error {
  readonly seconds?: number;
  readonly text: string;
  constructor(
    readonly code: number,
    text: string,
  ) {
    super(`Telegram API error ${code}: ${text}`);
    // As mtcute's RpcError.fromTl: "FLOOD_WAIT_30" becomes "FLOOD_WAIT_%d" with seconds 30.
    const m = text.match(/^(FLOOD_WAIT|SLOWMODE_WAIT|FLOOD_PREMIUM_WAIT)_(\d+)$/);
    this.text = m ? `${m[1]}_%d` : text;
    if (m) this.seconds = Number(m[2]);
  }
}
