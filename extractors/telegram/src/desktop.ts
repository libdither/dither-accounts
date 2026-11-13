/**
 * Telegram Desktop as the account's body (docs/telegram.md, "Signed in through Telegram Desktop"): the official app
 * in the account's sandbox (packages/sandbox), on its own display with a live view, where you sign in with
 * Telegram's own screens. This file runs it, reads who it is signed in as from its tdata (tdata.ts), and routes what
 * it hands to the desktop:
 *
 *   notifications   notify.new (the notifications interface); closed by the app → notify.read; notify.markRead
 *                   presses the notification's "Mark as read" for the app
 *   links           desktop.link, and desktop.links lists the recent ones; nothing is opened anywhere
 *   downloads       land in the sandbox's Downloads (Telegram Desktop's default folder, and every "Save as"), are
 *                   announced as desktop.download once whole, listed by desktop.downloads, read by desktop.fetch
 *   file pickers    "Save as" goes to Downloads; "Attach" is answered with what desktop.offer put in the outbox,
 *                   or cancelled when it is empty; each is a desktop.fileRequest event
 *
 * Logs and status carry ids, counts and states: never a link, a notification's text, a file name or the key.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppSandbox, type Download, type FileRequestRecord, type Network, pickFreeDisplay, resolveBin, type SandboxEvent } from '@dither-accounts/sandbox';
import type { DesktopKey } from './backend.ts';
import { keyFingerprint, readTdata, signedInAccount, TdataError } from './tdata.ts';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string };

export type DesktopSignIn =
  | { state: 'none' }
  | { state: 'signed-out' }
  | { state: 'signed-in'; key: DesktopKey }
  | { state: 'passcode'; wrong: boolean }
  | { state: 'unreadable'; error: string };

export interface DesktopOptions {
  accountDir: string;
  log: Log;
  /** notify.* and desktop.* events, to the manager. */
  emit: (ev: { t: string; [k: string]: unknown }) => void;
  /** The sandbox, the app or the sign-in changed. */
  onChange: () => void;
  width?: number;
  height?: number;
  network?: Network;
  /** The fake Telegram Desktop (test/fake-desktop.ts) instead of the real one. */
  fake?: boolean;
  /** How often tdata is read (it is also read on every change the app makes there). */
  pollMs?: number;
}

export interface DesktopNotification {
  id: string;
  source: string;
  title: string;
  body: string | null;
  url: string | null;
  reason: string | null;
  context: string | null;
  subject: null;
  actors: [];
  at: number;
  unread: boolean;
}

/** What the adapter needs from Telegram Desktop's side (DesktopSession; a stub in tests). */
export interface DesktopHost {
  readonly signIn: DesktopSignIn;
  start(): Promise<void>;
  stop(): Promise<void>;
  liveView(): { vncSocket: string; width: number; height: number } | null;
  layers(needed: boolean): Layer[];
  details(): Record<string, string | number | boolean | null>;
  command(cmd: { t: string; [k: string]: unknown }): Promise<unknown> | undefined;
  setPasscode(p: string): void;
  restartApp(): Promise<void>;
}

/** Where Telegram Desktop keeps its data, inside the sandbox (its -workdir). */
export const WORKDIR = '/home/user/.local/share/TelegramDesktop';
const KEEP = 200;
const MEDIA_MAX = 64 * 1024 * 1024;
const RESTART_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const REPO = join(import.meta.dir, '..', '..', '..');

export class DesktopSession implements DesktopHost {
  sandbox: AppSandbox | null = null;
  sandboxError: string | null = null;
  signIn: DesktopSignIn = { state: 'none' };
  readonly bin: string | null;
  private binError: string | null = null;
  private passcode = '';
  private poll?: Timer;
  private restartTimer?: Timer;
  private restarts = 0;
  private stopped = false;
  private boot = Date.now().toString(36);
  private notes: (DesktopNotification & { dbusId: number; actions: string[] })[] = [];
  private links: { id: string; url: string; via: string; at: number }[] = [];
  private requests: (FileRequestRecord & { at: number })[] = [];
  readonly counts = { notifications: 0, links: 0, downloads: 0, fileRequests: 0 };
  readonly tdataDir: string;
  readonly dir: string;

  constructor(private o: DesktopOptions) {
    this.dir = join(o.accountDir, 'desktop');
    this.tdataDir = join(this.dir, 'home', WORKDIR.slice('/home/user/'.length), 'tdata');
    let bin: string | null = null;
    if (!o.fake) {
      try {
        bin = resolveBin({ name: 'Telegram', env: 'TELEGRAM_DESKTOP_BIN', nix: 'telegram-desktop' }, o.log);
      } catch (e) {
        this.binError = (e as Error).message;
      }
    }
    this.bin = bin;
  }

  /** The app and how to run it: Telegram Desktop with its data in the sandbox's home and no updater, or the fake. */
  private launch(): { command: string[]; roBinds: string[] } {
    if (this.o.fake) {
      const bun = process.execPath;
      const binds = [join(REPO, 'extractors/telegram/src'), join(REPO, 'extractors/telegram/test'), join(REPO, 'packages/sandbox/src')];
      if (!bun.startsWith('/nix/store/')) binds.push(dirname(bun));
      return { command: [bun, join(REPO, 'extractors/telegram/test/fake-desktop.ts'), '-workdir', WORKDIR], roBinds: binds };
    }
    if (!this.bin) throw new Error(this.binError ?? 'Telegram Desktop is not available');
    return { command: [this.bin, '-workdir', WORKDIR, '-noupdate'], roBinds: [] };
  }

  async start() {
    const width = this.o.width ?? 1280;
    const height = this.o.height ?? 800;
    const tried: number[] = [];
    for (let attempt = 0; attempt < 3 && !this.stopped; attempt++) {
      let free: { display: number };
      try {
        free = await pickFreeDisplay(undefined, tried);
        tried.push(free.display);
        const { command, roBinds } = this.launch();
        this.sandbox = new AppSandbox({
          dir: this.dir,
          display: free.display,
          width,
          height,
          command,
          roBinds,
          network: this.o.network ?? (this.o.fake ? 'none' : 'pasta'),
          fitWindow: this.o.fake ? undefined : '^Telegram',
          log: this.o.log,
          onEvent: (ev) => this.onEvent(ev),
        });
        await this.sandbox.start();
        this.sandboxError = null;
        break;
      } catch (e) {
        this.sandboxError = String((e as Error).message ?? e).slice(0, 300);
        this.o.log('warn', `desktop sandbox failed: ${this.sandboxError}`);
        await this.sandbox?.stop().catch(() => {});
        this.sandbox = null;
        // Another display only helps when the display was the trouble.
        if (!/display|Xvfb/i.test(this.sandboxError)) break;
      }
    }
    this.readSignIn();
    this.poll = setInterval(() => this.readSignIn(), this.o.pollMs ?? 2000);
    this.o.onChange();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.poll);
    clearTimeout(this.restartTimer);
    clearTimeout(this.countsTimer);
    await this.sandbox?.stop().catch(() => {});
  }

  liveView(): { vncSocket: string; width: number; height: number } | null {
    if (!this.sandbox) return null;
    const i = this.sandbox.info();
    return { vncSocket: i.vncSocket, width: i.width, height: i.height };
  }

  /** Telegram Desktop's local passcode, used to read its tdata (kept in memory only, never written). */
  setPasscode(p: string) {
    this.passcode = p;
    this.readSignIn(true);
  }

  async restartApp() {
    if (!this.sandbox) throw new Error(this.sandboxError ?? 'the sandbox is not running');
    clearTimeout(this.restartTimer);
    this.restarts = 0;
    await this.sandbox.restartApp();
  }

  // ---------------------------------------------------------------- tdata

  private lastSig = '';
  private lastFiles = '';
  /** key_datas and the accounts' files, by size and time: tdata is read again only when one changed. */
  private filesSig(): string {
    try {
      return readdirSync(this.tdataDir)
        .filter((n) => /^(key_data|[0-9A-F]{16})[s01]$/.test(n))
        .sort()
        .map((n) => {
          const st = statSync(join(this.tdataDir, n));
          return `${n}:${st.size}:${st.mtimeMs}`;
        })
        .join(',');
    } catch {
      return '';
    }
  }

  readSignIn(force = false) {
    // With a local passcode a read costs 100000 PBKDF2 rounds: not every poll, only after a change.
    const files = this.filesSig();
    if (!force && files === this.lastFiles && this.signIn.state !== 'none') return;
    this.lastFiles = files;
    let next: DesktopSignIn;
    try {
      const t = readTdata(this.tdataDir, this.passcode);
      const a = signedInAccount(t);
      next = a ? { state: 'signed-in', key: { userId: a.userId, dcId: a.mainDcId, authKey: a.authKey, fingerprint: keyFingerprint(a.authKey) } } : { state: 'signed-out' };
    } catch (e) {
      if (e instanceof TdataError && e.code === 'missing') next = { state: 'none' };
      else if (e instanceof TdataError && e.code === 'passcode') next = { state: 'passcode', wrong: !!this.passcode };
      else next = { state: 'unreadable', error: (e as Error).message };
    }
    const sig = next.state === 'signed-in' ? `in:${next.key.userId}:${next.key.fingerprint}` : next.state === 'unreadable' ? `x:${next.error}` : next.state;
    if (sig === this.lastSig) return;
    // A file caught half-written reads as damaged: believe it only when it says so twice.
    if (next.state === 'unreadable' && !this.lastSig.startsWith('x:') && this.signIn.state !== 'none') {
      this.lastSig = sig;
      return;
    }
    this.lastSig = sig;
    this.signIn = next;
    this.o.log('info', next.state === 'signed-in' ? `Telegram Desktop is signed in (user ${next.key.userId}, DC ${next.key.dcId})` : `Telegram Desktop: ${next.state}`);
    this.o.onChange();
  }

  // ---------------------------------------------------------------- what it hands out

  /** The counts in the status: refreshed at most once a second while things arrive. */
  private countsTimer?: Timer;
  private countsChanged() {
    this.countsTimer ??= setTimeout(() => {
      this.countsTimer = undefined;
      if (!this.stopped) this.o.onChange();
    }, 1000);
  }

  private onEvent(ev: SandboxEvent) {
    if (ev.t !== 'app' && ev.t !== 'notificationClosed') this.countsChanged();
    switch (ev.t) {
      case 'app':
        if (ev.state === 'exited' && !this.stopped) {
          const delay = RESTART_MS[Math.min(this.restarts++, RESTART_MS.length - 1)];
          this.o.log('warn', `Telegram Desktop exited (code ${ev.code ?? ev.signal}); starting it again in ${delay / 1000} s`);
          clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => this.sandbox?.startApp(), delay);
        }
        // Two minutes up counts as a good start: the next exit waits the shortest time again.
        if (ev.state === 'running') setTimeout(() => this.sandbox?.appAlive && (this.restarts = 0), 120_000);
        this.o.onChange();
        return;
      case 'notification': {
        const n = ev.notification;
        const id = `tdesktop:${this.boot}:${n.id}`;
        const note = {
          id,
          source: 'Telegram Desktop',
          title: n.summary,
          body: n.body || null,
          url: null,
          reason: n.hints.category === 'im.received' ? 'message' : typeof n.hints.category === 'string' ? n.hints.category : null,
          context: null,
          subject: null,
          actors: [] as [],
          at: ev.at,
          unread: true,
          dbusId: n.id,
          actions: n.actions.map(([k]) => k),
        };
        this.notes = [note, ...this.notes.filter((x) => x.id !== id)].slice(0, KEEP);
        this.counts.notifications++;
        this.o.log('info', `notification ${id}${n.replaced ? ' (replaced)' : ''}`);
        this.o.emit({ t: 'notify.new', notification: publicNote(note) });
        return;
      }
      case 'notificationClosed': {
        const note = this.notes.find((x) => x.dbusId === ev.id && x.id.startsWith(`tdesktop:${this.boot}:`));
        if (!note || !note.unread) return;
        note.unread = false;
        if (ev.by === 'app') this.o.emit({ t: 'notify.read', ids: [note.id] });
        return;
      }
      case 'link':
        this.links = [{ id: ev.id, url: ev.url, via: ev.via, at: ev.at }, ...this.links].slice(0, KEEP);
        this.counts.links++;
        this.o.log('info', `link ${ev.id} (${scheme(ev.url)}) routed from Telegram Desktop`);
        this.o.emit({ t: 'desktop.link', link: { id: ev.id, url: ev.url, via: ev.via, at: ev.at } });
        return;
      case 'download':
        this.counts.downloads++;
        this.o.log('info', `download ${ev.download.id} (${ev.download.size} bytes)`);
        this.o.emit({ t: 'desktop.download', download: ev.download });
        return;
      case 'fileRequest':
        this.requests = [{ ...ev.request, at: ev.at }, ...this.requests].slice(0, KEEP);
        this.counts.fileRequests++;
        this.o.log('info', `file request ${ev.request.id}: ${ev.request.kind}, ${ev.request.answer}, ${ev.request.files.length} file(s)`);
        this.o.emit({ t: 'desktop.fileRequest', request: { ...ev.request, at: ev.at } });
        return;
    }
  }

  /** notify.* and desktop.* operations; undefined when the command is not one of them. */
  command(cmd: { t: string; [k: string]: unknown }): Promise<unknown> | undefined {
    const t = cmd.t;
    if (!t.startsWith('notify.') && !t.startsWith('desktop.')) return undefined;
    return (async () => {
      switch (t) {
        case 'notify.list': {
          const since = typeof cmd.since === 'number' ? cmd.since : 0;
          const all = this.notes.filter((n) => (!cmd.unreadOnly || n.unread) && n.at >= since);
          const from = Number(cmd.pageToken ?? 0) || 0;
          const limit = Math.min(Math.max(Number(cmd.limit) || 50, 1), KEEP);
          const page = all.slice(from, from + limit);
          return { notifications: page.map(publicNote), next: from + limit < all.length ? String(from + limit) : null };
        }
        case 'notify.markRead':
        case 'notify.markAllRead': {
          const before = typeof cmd.before === 'number' ? cmd.before : Date.now();
          const ids = t === 'notify.markRead' ? new Set((cmd.ids as string[]) ?? []) : null;
          for (const n of this.notes) {
            if (!n.unread || (ids ? !ids.has(n.id) : n.at > before)) continue;
            n.unread = false;
            // Telegram Desktop's own button marks the chat read; then the notification goes, as a desktop's would.
            if (n.id.startsWith(`tdesktop:${this.boot}:`) && this.sandbox?.services) {
              if (n.actions.includes('mail-mark-read')) this.sandbox.services.invokeAction(n.dbusId, 'mail-mark-read');
              this.sandbox.services.dismiss(n.dbusId);
            }
          }
          return {};
        }
        case 'notify.mute':
          throw new Error('Mute the chat in Telegram itself (in the live view), or through the chat interface');
        case 'desktop.links':
          return { links: this.links.slice(0, Math.min(Math.max(Number(cmd.limit) || 50, 1), KEEP)) };
        case 'desktop.downloads':
          return { downloads: (this.sandbox?.listDownloads() ?? []).slice(0, Math.min(Math.max(Number(cmd.limit) || 50, 1), 1000)) };
        case 'desktop.fetch': {
          const p = this.sandbox?.downloadPath(String(cmd.id ?? ''));
          if (!p) throw new Error('No such download (it may have changed or gone since)');
          const size = statSync(p).size;
          if (size > MEDIA_MAX) throw new Error(`The file is ${size} bytes; at most ${MEDIA_MAX} come through here`);
          const d = this.sandbox!.listDownloads().find((x) => x.id === cmd.id) as Download;
          return { name: d.name, mime: d.mime, size, base64: readFileSync(p).toString('base64') };
        }
        case 'desktop.offer': {
          if (!this.sandbox) throw new Error('The sandbox is not running');
          const bytes = Buffer.from(String(cmd.base64 ?? ''), 'base64');
          if (bytes.length > MEDIA_MAX) throw new Error(`At most ${MEDIA_MAX} bytes`);
          return { name: this.sandbox.offer(String(cmd.name ?? 'file'), bytes) };
        }
        case 'desktop.fileRequests':
          return { requests: this.requests.slice(0, 50) };
        default:
          throw new Error(`unknown operation ${t}`);
      }
    })();
  }

  // ---------------------------------------------------------------- status

  /** The sandbox, the app in it, and its sign-in. `needed`: the account rests on that sign-in (nothing imported yet, or it shares the key). */
  layers(needed: boolean): Layer[] {
    const info = this.sandbox?.info();
    const sandbox: Layer = info
      ? { name: 'sandbox', state: 'ok', note: `display :${info.display}, live view ready, ${info.network === 'pasta' ? 'its own network' : info.network === 'none' ? 'no network' : "the host's network"}` }
      : this.sandboxError
        ? { name: 'sandbox', state: 'failed', note: this.sandboxError }
        : { name: 'sandbox', state: 'waiting', note: 'starting' };
    const version = this.bin?.match(/telegram-desktop-(\d+\.\d+\.\d+)/)?.[1];
    const what = this.o.fake ? 'the fake Telegram Desktop' : `Telegram Desktop${version ? ` ${version}` : ''}`;
    const app: Layer = !info
      ? { name: 'Telegram Desktop', state: 'waiting', note: this.sandboxError ? 'waits for the sandbox' : 'starting' }
      : info.app === 'running'
        ? { name: 'Telegram Desktop', state: 'ok', note: `${what} is running` }
        : info.app === 'exited'
          ? { name: 'Telegram Desktop', state: 'failed', note: `${what} exited (${info.lastExit?.code ?? info.lastExit?.signal ?? '?'}); starting it again` }
          : { name: 'Telegram Desktop', state: 'waiting', note: `starting ${what}` };
    const s = this.signIn;
    const signed: Layer =
      s.state === 'signed-in'
        ? { name: 'signed in (Telegram Desktop)', state: 'ok', note: `user ${s.key.userId}, DC ${s.key.dcId}` }
        : s.state === 'passcode'
          ? { name: 'signed in (Telegram Desktop)', state: 'waiting', note: s.wrong ? 'that is not its local passcode: give it again (action desktopPasscode)' : 'Telegram Desktop has a local passcode: give it once (action desktopPasscode), or turn it off there' }
          : s.state === 'unreadable'
            ? { name: 'signed in (Telegram Desktop)', state: 'failed', note: s.error }
            : !needed
              ? { name: 'signed in (Telegram Desktop)', state: 'off', note: s.state === 'signed-out' ? 'signed out in the live view; this account keeps its own session' : 'not needed: this account has its own session' }
              : { name: 'signed in (Telegram Desktop)', state: 'waiting', note: s.state === 'signed-out' ? 'sign in to Telegram in the live view' : 'waits for Telegram Desktop' };
    return [sandbox, app, signed];
  }

  details(): Record<string, string | number | boolean | null> {
    const info = this.sandbox?.info();
    return {
      desktop: this.o.fake ? 'the fake Telegram Desktop' : (this.bin ?? 'not found'),
      desktopDisplay: info ? `:${info.display}` : null,
      desktopNetwork: info?.network ?? null,
      desktopApp: info?.app ?? (this.sandboxError ? 'sandbox failed' : 'starting'),
      desktopRestarts: info?.appExits ?? 0,
      desktopSignIn: this.signIn.state,
      desktopUser: this.signIn.state === 'signed-in' ? String(this.signIn.key.userId) : null,
      // Which of our desktop services it uses, by method name and count ("Notifications.Notify×3").
      desktopBus: info ? Object.entries(info.busCalls).map(([k, n]) => `${k.replace(/^org\.freedesktop\.(portal\.)?/, '')}×${n}`).join(', ') || null : null,
      notifications: this.counts.notifications,
      links: this.counts.links,
      downloads: this.counts.downloads,
      fileRequests: this.counts.fileRequests,
    };
  }
}

function publicNote(n: DesktopNotification): DesktopNotification {
  const { id, source, title, body, url, reason, context, subject, actors, at, unread } = n;
  return { id, source, title, body, url, reason, context, subject, actors, at, unread };
}

const scheme = (url: string) => url.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase() ?? 'no scheme';
