/**
 * The spec format: what an interface is, as data the manager can check at runtime and the type checker can check at
 * build time.
 *
 * An interface is an effect signature: named operations (typed input → typed output) and the events it emits. An
 * extractor is a handler for one or more interfaces on one account; a consumer's grant is a set of interfaces on a set
 * of accounts up to a level. Every operation has a level, so a grant reads as a consent line:
 *
 *   read    observe: what is there, what arrives (history, profiles, a calendar's events)
 *   write   act as you: send, react, edit, delete, create an event
 *   manage  change settings and membership as you: roles, leaving, a room's name
 *
 * Schemas are a small combinator set: `s.object({ id: s.string })` checks values and `Infer<typeof X>` gives their
 * type. `s.typed<T>()` takes a type from elsewhere (dither-chat's protocol) with only a shallow runtime check; the
 * extractors behind those are trusted code from this repo, so the boundary check that matters is on what consumers
 * send, and those inputs get real schemas where they are not the extractor's own business to check.
 */

// ------------------------------------------------------------------ schemas

export interface Schema<T> {
  /** null when `v` fits; else what is wrong, with a path. */
  check(v: unknown, path?: string): string | null;
  /** For docs and the consent page. */
  readonly describe: string;
  /** Phantom: the type this schema checks. */
  readonly _t?: T;
}
export type Infer<S> = S extends Schema<infer T> ? T : never;

const mk = <T>(describe: string, check: (v: unknown, path: string) => string | null): Schema<T> => ({ describe, check: (v, path = '$') => check(v, path) });
const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

type Shape = Record<string, Schema<any>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends Schema<infer T> ? (undefined extends T ? K : never) : never }[keyof S];
type ObjectOf<S extends Shape> = { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> };

export const s = {
  string: mk<string>('text', (v, p) => (typeof v === 'string' ? null : `${p}: expected text, got ${kind(v)}`)),
  number: mk<number>('number', (v, p) => (typeof v === 'number' && Number.isFinite(v) ? null : `${p}: expected a number, got ${kind(v)}`)),
  integer: mk<number>('integer', (v, p) => (Number.isInteger(v) ? null : `${p}: expected an integer, got ${kind(v)}`)),
  boolean: mk<boolean>('yes/no', (v, p) => (typeof v === 'boolean' ? null : `${p}: expected true or false, got ${kind(v)}`)),
  unknown: mk<unknown>('anything', () => null),
  /** A type from elsewhere, checked only as "some object" at runtime. */
  typed<T>(describe = 'object'): Schema<T> {
    return mk<T>(describe, (v, p) => (v !== null && typeof v === 'object' ? null : `${p}: expected ${describe}, got ${kind(v)}`));
  },
  literal<L extends string | number | boolean | null>(l: L): Schema<L> {
    return mk<L>(JSON.stringify(l), (v, p) => (v === l ? null : `${p}: expected ${JSON.stringify(l)}`));
  },
  enum<const L extends readonly string[]>(...ls: L): Schema<L[number]> {
    return mk<L[number]>(ls.join(' | '), (v, p) => (ls.includes(v as string) ? null : `${p}: expected one of ${ls.join(', ')}`));
  },
  optional<T>(x: Schema<T>): Schema<T | undefined> {
    return mk<T | undefined>(`${x.describe}?`, (v, p) => (v === undefined ? null : x.check(v, p)));
  },
  nullable<T>(x: Schema<T>): Schema<T | null> {
    return mk<T | null>(`${x.describe} | null`, (v, p) => (v === null ? null : x.check(v, p)));
  },
  array<T>(x: Schema<T>, max = 10_000): Schema<T[]> {
    return mk<T[]>(`${x.describe}[]`, (v, p) => {
      if (!Array.isArray(v)) return `${p}: expected a list, got ${kind(v)}`;
      if (v.length > max) return `${p}: at most ${max} items`;
      for (let i = 0; i < v.length; i++) {
        const e = x.check(v[i], `${p}[${i}]`);
        if (e) return e;
      }
      return null;
    });
  },
  record<T>(x: Schema<T>): Schema<Record<string, T>> {
    return mk<Record<string, T>>(`{ [key]: ${x.describe} }`, (v, p) => {
      if (kind(v) !== 'object') return `${p}: expected an object, got ${kind(v)}`;
      for (const [k, e] of Object.entries(v as object)) {
        const err = x.check(e, `${p}.${k}`);
        if (err) return err;
      }
      return null;
    });
  },
  /** Unknown keys are allowed (and passed on): extractors may take more than a schema names. */
  object<S extends Shape>(shape: S): Schema<ObjectOf<S>> {
    return mk<ObjectOf<S>>(`{ ${Object.entries(shape).map(([k, x]) => `${k}: ${x.describe}`).join(', ')} }`, (v, p) => {
      if (kind(v) !== 'object') return `${p}: expected an object, got ${kind(v)}`;
      for (const [k, x] of Object.entries(shape)) {
        const err = x.check((v as Record<string, unknown>)[k], `${p}.${k}`);
        if (err) return err;
      }
      return null;
    });
  },
  union<const X extends readonly Schema<any>[]>(...xs: X): Schema<Infer<X[number]>> {
    return mk<Infer<X[number]>>(xs.map((x) => x.describe).join(' | '), (v, p) => {
      const errs = xs.map((x) => x.check(v, p));
      return errs.some((e) => e === null) ? null : errs[0];
    });
  },
};

// ------------------------------------------------------------------ interfaces

export type Level = 'read' | 'write' | 'manage';
export const LEVELS: Level[] = ['read', 'write', 'manage'];
export const levelRank = (l: Level) => LEVELS.indexOf(l);
/** Whether a grant up to `granted` covers an operation at `needed`. */
export const covers = (granted: Level, needed: Level) => levelRank(granted) >= levelRank(needed);

export interface OpSpec<I = any, O = any> {
  level: Level;
  describe: string;
  input: Schema<I>;
  output: Schema<O>;
  /** How long the manager waits for the extractor. Default 30 s. */
  timeoutMs?: number;
}

export interface EventSpec<E = any> {
  describe: string;
  schema: Schema<E>;
  /** About the account itself (its status, hello): every consumer with any grant on the account gets it. */
  account?: boolean;
}

export interface Iface<Ops extends Record<string, OpSpec> = Record<string, OpSpec>, Events extends Record<string, EventSpec> = Record<string, EventSpec>> {
  /** Unique: `chat`, `google.calendar`. */
  name: string;
  /** Bumped when a change breaks consumers or extractors; both say which version they speak. */
  version: number;
  describe: string;
  /** What each level lets an app do, as a consent line ("Read your chats and who is in them"). */
  levels: Partial<Record<Level, string>>;
  ops: Ops;
  events: Events;
}

export function op<I, O>(level: Level, describe: string, input: Schema<I>, output: Schema<O>, timeoutMs?: number): OpSpec<I, O> {
  return { level, describe, input, output, ...(timeoutMs ? { timeoutMs } : {}) };
}
export function ev<E>(describe: string, schema: Schema<E>, account = false): EventSpec<E> {
  return { describe, schema, ...(account ? { account: true } : {}) };
}
export function iface<const Ops extends Record<string, OpSpec>, const Events extends Record<string, EventSpec>>(def: Iface<Ops, Events>): Iface<Ops, Events> {
  for (const n of Object.keys(def.ops)) if (n === 'shutdown' || n === 'reply' || n === 'log') throw new Error(`${def.name}: "${n}" is reserved`);
  return def;
}

export type OpName<I extends Iface> = keyof I['ops'] & string;
export type InputOf<I extends Iface, K extends OpName<I>> = Infer<I['ops'][K]['input']>;
export type OutputOf<I extends Iface, K extends OpName<I>> = Infer<I['ops'][K]['output']>;
export type EventOf<I extends Iface> = { [K in keyof I['events']]: Infer<I['events'][K]['schema']> }[keyof I['events']];

/** The highest level an interface has an operation at. */
export function topLevel(i: Iface): Level {
  return Object.values(i.ops).reduce<Level>((l, o) => (levelRank(o.level) > levelRank(l) ? o.level : l), 'read');
}

/** The consent lines for a grant: each level up to `level`, as the interface words it. */
export function consent(i: Iface, level: Level): string[] {
  return LEVELS.filter((l) => covers(level, l) && i.levels[l]).map((l) => i.levels[l]!);
}

// ------------------------------------------------------------------ wire (manager ⇄ consumers)

/**
 * The manager's own reasons a call failed: denied (no grant), limited (rate), offline (extractor not connected),
 * timeout, invalid (bad input), failed (the extractor threw, and named no reason of its own), unknown-op,
 * unknown-account.
 */
export const MANAGER_CALL_CODES = ['denied', 'limited', 'offline', 'timeout', 'invalid', 'failed', 'unknown-op', 'unknown-account'] as const;
export type ManagerCallCode = (typeof MANAGER_CALL_CODES)[number];

/**
 * A code an extractor may give a refusal it explains (`new StatusError(message, 422, 'recipients')` in
 * packages/link): a short lowercase word (letters, digits, hyphens; at most 40), and never one of the manager's own,
 * so an extractor cannot pass for the manager (an extractor's 'denied' arrives as 'failed').
 */
export function isExtractorCode(code: unknown): code is string {
  return typeof code === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(code) && !(MANAGER_CALL_CODES as readonly string[]).includes(code);
}

/**
 * An error from a call. `status` carries an upstream HTTP status (410 for a stale sync token, 404 for gone).
 *
 * `code` is one of the manager's own (MANAGER_CALL_CODES), or, when the extractor refused the call and said why in a
 * word of its own, that word (isExtractorCode), with the extractor's `status`. The interface documents its words (mail:
 * Proton's mail.send says 'from', 'recipients' or 'settings' with 422). An extractor's error without one is 'failed'.
 */
export interface CallError {
  message: string;
  code: ManagerCallCode | (string & {});
  status?: number;
}

/** An account as an app sees it: only those its grants name. */
export interface AccountView {
  id: string;
  kind: string;
  label: string;
  /** What the account offers. */
  interfaces: string[];
  /** The extractor's process is running / its socket is connected. */
  running: boolean;
  online: boolean;
  enabled: boolean;
  /** Why it is not running, when the manager knows (another process holds its directory, no extractor). */
  error: string | null;
  /** What this app may do here, per interface. */
  grants: Record<string, Level>;
  /** Writes are answered without reaching the account (a dry-run grant). */
  dryRun: boolean;
  /** This app may run account administration on it (an `accounts` grant at manage for its kind). */
  manages: boolean;
  /** Its extractor offers a live view (a sandboxed browser); an app that manages it may open it (liveViewPath). */
  liveView: boolean;
  /** Who made it: this app, another app, the manager's page (or a provider's sign-in), or an import in place. */
  origin: 'self' | 'app' | 'page' | 'import';
}

export type ConsumerIn =
  /** `trace`: the app's W3C traceparent, so the manager's span for the call (and the extractor's) join its trace. */
  | { t: 'call'; id: string; account: string; op: string; input?: Record<string, unknown>; trace?: string }
  | { t: 'admin'; id: string; action: AdminAction }
  | { t: 'ping' };

/**
 * Account administration, for apps with an `accounts` grant at manage on the account's kind. The manager does it; the
 * extractor is not asked.
 */
export type AdminAction =
  | { do: 'create'; kind: string; label: string; config?: Record<string, unknown>; secret?: unknown; id?: string; enabled?: boolean }
  | { do: 'update'; account: string; label?: string; config?: Record<string, unknown>; enabled?: boolean }
  /** Replace its secret.json (what the extractor reads its credentials from). */
  | { do: 'secret'; account: string; secret: unknown }
  /** Forget it and stop its extractor. With `purge`, its directory goes too, if the manager made it (not one imported in place). */
  | { do: 'delete'; account: string; purge?: boolean }
  | { do: 'start' | 'stop' | 'restart'; account: string }
  /** The last lines of its extractor's log (adapter.log in its directory): at most 5000, default 400. */
  | { do: 'log'; account: string; lines?: number };

/** What each admin action answers. */
export type AdminResult<A extends AdminAction> = A extends { do: 'create' }
  ? { id: string }
  : A extends { do: 'delete' }
    ? { ok: true; purged: boolean; dir: string; why?: string }
    : A extends { do: 'log' }
      ? { lines: string[]; size: number }
      : { ok: true };

/**
 * An account's live view for an app (from this machine, with its token, not from a browser): a WebSocket carrying
 * the raw VNC stream of the extractor's sandboxed browser, both ways. The app needs `manages` on the account.
 */
export const liveViewPath = (account: string) => `/consumer/liveview/${encodeURIComponent(account)}`;

export type ConsumerOut =
  | { t: 'hello'; app: string; name: string; manager: string }
  | { t: 'accounts'; accounts: AccountView[] }
  | { t: 'result'; id: string; ok: true; result: unknown }
  | { t: 'result'; id: string; ok: false; error: CallError }
  /** Events from one account, in order. */
  | { t: 'events'; account: string; events: { t: string; [k: string]: unknown }[] }
  /** Events for this account were dropped while you were away (the buffer filled): ask it to start over (restart). */
  | { t: 'gap'; account: string; dropped: number }
  | { t: 'pong' };
