/** What the manager's own page reads (GET /api/state) and sends. */
import type { Level } from '@dither-accounts/spec';

export interface OpInfo {
  name: string;
  level: Level;
  describe: string;
}
export interface InterfaceInfo {
  name: string;
  version: number;
  describe: string;
  levels: Partial<Record<Level, string>>;
  ops: OpInfo[];
  events: { name: string; describe: string }[];
}
/** One field of a kind's add form (Manifest.add): a config key, or a key of secret.json when `secret`. */
export interface AddField {
  key: string;
  label: string;
  placeholder?: string;
  /** Goes to secret.json (0600, where the extractor reads credentials), never to the config or the page. */
  secret?: boolean;
  optional?: boolean;
  /** Used when it is left empty. */
  default?: string;
  /** A regular expression the value must match, and what to say when it does not. */
  pattern?: string;
  hint?: string;
}
/** How a kind is added on the page: what it is, what to fill in, and what happens next. */
export interface AddInfo {
  blurb: string;
  fields?: AddField[];
  /** What the page says once it is added (scan a code, sign in in the live view). */
  next?: string;
}
export interface KindInfo {
  kind: string;
  name: string;
  interfaces: string[];
  /** Accounts of this kind can be added on the page (Manifest.add). */
  add: AddInfo | null;
  /** Its extractor holds passkeys for its site (Manifest.passkeys): the pane offers Keep new passkeys on. */
  passkeys: boolean;
}
/**
 * One link of an account's dependency chain, from its status's `layers` (outermost first: display, browser,
 * extension, signed in…). The first that is waiting or failed is where it stops; `off` is a layer it does not use.
 */
export interface StatusLayer {
  name: string;
  state: 'ok' | 'waiting' | 'failed' | 'off';
  note?: string;
}
export interface AccountInfo {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
  running: boolean;
  online: boolean;
  /** Why it is not running (its directory is locked by another process, no extractor). */
  error: string | null;
  /** The last status its extractor reported ({ status, attention }), if any. */
  status: Record<string, unknown> | null;
  /** Who it is signed in as, from its status: a name, a handle or an email, and an avatar if it has one. */
  self: { name: string | null; detail: string | null; avatar: string | null } | null;
  /** Who it was last signed in as (kept in the registry), also while it is stopped; the page names it by this. */
  seenAs: { name: string | null; detail: string | null; avatar: string | null } | null;
  /** Its extractor offers a live view (a sandboxed browser you can see and use). */
  liveView: boolean;
  /** Part of the manager itself (its own notices, docs/notifications.md): no process to restart, disable or remove. */
  builtin: boolean;
  /** What it rests on, from its last status (null when its extractor does not say). */
  layers: StatusLayer[] | null;
  interfaces: string[];
  dir: string;
  /** The manager made its directory (`<data>/accounts/<id>`), so removing it may delete it too; not one imported in place. */
  ownDir: boolean;
  /** The app that made it, if one did. */
  createdBy: string | null;
  createdAt: number;
}
export interface GrantInfo {
  id: string;
  interface: string;
  level: Level;
  accounts: '*' | string[];
  kinds: string[] | null;
  dryRun: boolean;
  /** The consent lines this grant amounts to. */
  consent: string[];
  createdAt: number;
}
export interface RequestInfo {
  id: string;
  interface: string;
  level: Level;
  accounts: '*' | string[];
  kinds: string[] | null;
  reason: string | null;
  state: 'pending' | 'approved' | 'denied';
  consent: string[];
  createdAt: number;
}
export interface AppInfo {
  id: string;
  name: string;
  describe: string | null;
  connected: boolean;
  lastSeen: number | null;
  grants: GrantInfo[];
  requests: RequestInfo[];
}
export interface AuditRow {
  day: string;
  app: string;
  account: string;
  op: string;
  outcome: 'ok' | 'error' | 'denied' | 'limited' | 'dry';
  n: number;
  lastAt: number;
}
export interface ManagerState {
  startedAt: number;
  publicUrl: string;
  kinds: KindInfo[];
  interfaces: InterfaceInfo[];
  accounts: AccountInfo[];
  apps: AppInfo[];
  /** Provider sections (Google sign-in), each with its own status; see providers/. */
  providers: Record<string, unknown>;
}

/** GET /api/accounts/:id: everything the manager knows about one account. */
export interface AccountDetail {
  account: AccountInfo;
  /** Its config, with anything that looks like a credential masked. */
  config: Record<string, unknown>;
  /** secret.json: whether there is one, and its top-level keys (never the values). */
  secret: { present: boolean; keys: string[] };
  process: {
    pid: number | null;
    /** The extractor and what it started, by name: Chromium, Xvfb, signal-cli… */
    tree: { name: string; pids: number[]; rssBytes: number }[];
    startedAt: number | null;
    onlineSince: number | null;
    /** Starts since the manager started. */
    starts: number;
    lastExit: { code: number | null; signal: string | null; at: number } | null;
    /** Started by an earlier manager and taken over by this one at its start (docs/supervisor.md). */
    adopted: boolean;
    /** Who holds the directory's lock, from extractor.lock. */
    lock: { pid: number; owner: string; at: string | null } | null;
  };
  /** Its extractor's latest hello and status, whole. */
  hello: Record<string, unknown> | null;
  status: Record<string, unknown> | null;
  /** Its dependency chain, as in `account.layers`. */
  layers: StatusLayer[] | null;
  /** Apps whose grants reach this account. */
  access: { grant: string; app: string; appName: string; interface: string; level: Level; dryRun: boolean }[];
  /** Calls to it, by app, op and outcome, over the last 30 days. */
  activity: AuditRow[];
  /** For a kind that holds passkeys: the device new ones go to, and each held one with where its key lives. */
  passkeys: AccountPasskeys | null;
  updatedAt: number;
}

/** An account's passkeys (secret.json's `passkeys`, never a key) and where new ones are made (config passkeyDevice). */
export interface AccountPasskeys {
  /** The approver device new passkeys go to; null: made here, in secret.json. */
  device: string | null;
  list: {
    idPrefix: string;
    rpId: string;
    algorithm: string;
    /** null: the key is here, in secret.json; else the approver device it is on. */
    device: string | null;
    createdAt: number;
    lastUsedAt: number | null;
    verifiedAt: number | null;
  }[];
}

/** A paired phone (docs/approver.md), as the page shows it. */
export interface ApproverDeviceInfo {
  id: string;
  name: string;
  /** SHA-256 of its identity key's SPKI, first 8 bytes as hex pairs: the app shows the same. */
  fingerprint: string;
  pairedAt: number;
  lastSeenAt: number | null;
  /** It has a link open now. */
  online: boolean;
  /** It gave a UnifiedPush endpoint (it can be woken). */
  push: boolean;
  /** Requests waiting for it. */
  waiting: number;
}
/** One approver request and how it ended (never the client data or a key). */
export interface ApprovalInfo {
  id: string;
  account: string;
  rpId: string;
  op: 'create' | 'get';
  device: string;
  reason: string | null;
  /** waiting, ok, or the refusal: denied, refused, expired, unknown-credential, error, no-device. */
  outcome: string;
  message: string | null;
  createdAt: number;
  sentAt: number | null;
  decidedAt: number | null;
}
/** GET /api/approvers */
export interface ApproversState {
  devices: ApproverDeviceInfo[];
  approvals: ApprovalInfo[];
}
/** POST /api/approvers/pair: a one-time code, and the link the app opens (shown as a QR). */
export interface ApproverPairing {
  code: string;
  link: string;
  url: string;
  expiresAt: number;
}

/** GET /api/matrix: which app reaches which account, at what level, and how its calls there went day by day. */
export interface GrantMatrix {
  /** The days the series cover, oldest first (UTC, YYYY-MM-DD; today last). */
  days: string[];
  /** Every app and account that have a grant between them, or calls in those days. Apps and accounts are in /api/state. */
  cells: MatrixCell[];
}
export interface MatrixCell {
  app: string;
  account: string;
  /** Interface → the level the app holds on this account; empty when it holds none (its calls were refused, or the grant went). */
  grants: Record<string, Level>;
  /** It may run this account (an `accounts` grant at manage for its kind). */
  manages: boolean;
  /** A grant that reaches it answers writes without reaching the account. */
  dryRun: boolean;
  /** Per day of `days`: its calls, and how many of them failed or were denied. */
  calls: { n: number; bad: number }[];
}

export interface DirEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  /** Bytes; for a directory, everything under it (as far as the count got). */
  size: number;
  /** Files under a directory. */
  files?: number;
  mtime: number;
}
/** GET /api/accounts/:id/files */
export interface DirListing {
  path: string;
  exists: boolean;
  entries: DirEntry[];
  size: number;
  /** The count stopped early (too many files, or too slow): sizes are at least these. */
  partial: boolean;
}

/** POST /api/accounts/:id/call */
export interface PageCallResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; status?: number };
  ms: number;
}

/** GET /api/interfaces: the TypeScript types of every op and event (scripts/gen-types.ts). */
export interface IfaceTypes {
  ops: Record<string, { input: string; output: string; example: unknown }>;
  events: Record<string, string>;
  defs: Record<string, string>;
}

/** POST /api/apps/register and /api/apps/:id/requests. */
export interface AccessRequest {
  interface: string;
  level: Level;
  accounts?: '*' | string[];
  kinds?: string[] | null;
  reason?: string;
}

/** GET /api/sessions: a browser signed in to the page (auth.ts). */
export interface SessionInfo {
  id: string;
  createdAt: number;
  lastUsed: number;
  /** When it ends unless used again (90 days after its last use, at most a year after its login). */
  expiresAt: number;
  userAgent: string | null;
  /** Where it signed in from, and where it was last used from. */
  ip: string | null;
  lastIp: string | null;
  /** The browser asking. */
  current: boolean;
}
