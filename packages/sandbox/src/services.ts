/**
 * The desktop services a sandboxed app finds on its session bus, all of them ours (docs/native-sandbox.md):
 *
 *   org.freedesktop.Notifications       the app's notifications, as they are posted, replaced and closed; and the
 *                                       buttons on them (ActionInvoked), so a "mark as read" can be pressed for it
 *   org.freedesktop.portal.Desktop      OpenURI (links), FileChooser (open and save dialogs), Settings (a light
 *                                       colour scheme, so apps that ask get an answer), NetworkMonitor (whether the
 *                                       sandbox has a network, which GLib and Qt ask once portals are on)
 *   net.dither.Sandbox                  Open(uri): what the xdg-open shim on the sandbox's PATH calls
 *
 * What happens to each is the caller's policy (sandbox.ts); this file only speaks the protocols.
 */
import { DBUS_ERRORS, DBusConnection, DBusError, type Message, variant } from './dbus.ts';

export interface Notification {
  id: number;
  app: string;
  summary: string;
  body: string;
  /** [key, label] pairs, as the app offered them. */
  actions: [string, string][];
  /** Hints worth keeping: category, urgency, desktop-entry; never the image. */
  hints: Record<string, string | number | boolean>;
  replaced: boolean;
}

export interface FileRequest {
  kind: 'open' | 'save' | 'saveMany';
  title: string;
  multiple: boolean;
  directory: boolean;
  /** For save: the name the app suggests. For saveMany: the names. */
  names: string[];
}

export interface ServiceHooks {
  link(url: string, via: 'xdg-open' | 'portal'): void;
  notify(n: Notification): void;
  notificationClosed(id: number, by: 'app' | 'us'): void;
  /** File URIs as the app sees them, or null to say the user cancelled. */
  chooseFiles(req: FileRequest): Promise<string[] | null>;
  /** The sandbox has a network (the NetworkMonitor portal says so to GLib and Qt). */
  online: boolean;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}

export const SERVER_INFO = ['dither-accounts', 'dither', '1', '1.2'] as const;
/**
 * body, actions: content and buttons. inline-reply and sound: with these four, Telegram Desktop (and apps like it) use
 * the desktop's notifications by default instead of drawing their own; the reply field and the sound are simply not
 * used here.
 */
export const CAPABILITIES = ['body', 'actions', 'inline-reply', 'sound'];

const NOTIFY_PATH = '/org/freedesktop/Notifications';
const NOTIFY_IFACE = 'org.freedesktop.Notifications';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
export const SANDBOX_NAME = 'net.dither.Sandbox';
export const SANDBOX_PATH = '/net/dither/Sandbox';

const fileUri = (p: string) => `file://${p.split('/').map(encodeURIComponent).join('/')}`;
export { fileUri };

export class DesktopServices {
  private nextId = 1;
  private open = new Set<number>();
  private requests = 0;

  constructor(
    readonly bus: DBusConnection,
    private hooks: ServiceHooks,
  ) {}

  async register() {
    const h = this.hooks;
    this.bus.export(NOTIFY_PATH, {
      [NOTIFY_IFACE]: {
        methods: {
          GetCapabilities: { in: '', out: 'as', fn: () => CAPABILITIES },
          GetServerInformation: { in: '', out: 'ssss', fn: () => [...SERVER_INFO] },
          Notify: {
            in: 'susssasa{sv}i',
            out: 'u',
            fn: ([app, replaces, _icon, summary, body, actions, hints]: [string, number, string, string, string, string[], Record<string, unknown>]) => {
              const replaced = !!replaces && this.open.has(replaces);
              const id = replaced ? replaces : this.nextId++;
              this.open.add(id);
              const pairs: [string, string][] = [];
              for (let i = 0; i + 1 < actions.length; i += 2) pairs.push([actions[i], actions[i + 1]]);
              const kept: Notification['hints'] = {};
              for (const k of ['category', 'urgency', 'desktop-entry', 'x-kde-origin-name']) {
                const v = hints?.[k];
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') kept[k] = v;
              }
              h.notify({ id, app, summary, body, actions: pairs, hints: kept, replaced });
              return id;
            },
          },
          CloseNotification: {
            in: 'u',
            out: '',
            fn: ([id]: [number]) => {
              if (!this.open.delete(id)) return;
              h.notificationClosed(id, 'app');
              this.bus.signal(NOTIFY_PATH, NOTIFY_IFACE, 'NotificationClosed', 'uu', [id, 3]);
            },
          },
        },
        signals: { NotificationClosed: 'uu', ActionInvoked: 'us', ActivationToken: 'us', NotificationReplied: 'us' },
      },
    });

    const request = (msg: Message, options: Record<string, unknown>) => {
      const token = typeof options?.handle_token === 'string' && /^[A-Za-z0-9_]+$/.test(options.handle_token) ? options.handle_token : `dither${++this.requests}`;
      const sender = (msg.sender ?? ':0').slice(1).replace(/\./g, '_');
      return { path: `${PORTAL_PATH}/request/${sender}/${token}`, sender: msg.sender };
    };
    /** Answer a portal request: the method returns its handle, then the Response signal follows on it. */
    const respond = (r: { path: string; sender?: string }, code: number, results: Record<string, unknown>) => {
      setTimeout(() => this.bus.signal(r.path, 'org.freedesktop.portal.Request', 'Response', 'ua{sv}', [code, results], r.sender), 20);
      return r.path;
    };

    this.bus.export(PORTAL_PATH, {
      'org.freedesktop.portal.OpenURI': {
        methods: {
          OpenURI: {
            in: 'ssa{sv}',
            out: 'o',
            fn: ([_parent, uri, options]: [string, string, Record<string, unknown>], msg) => {
              h.link(uri, 'portal');
              return respond(request(msg, options), 0, {});
            },
          },
          // Both pass the file as a descriptor, which this bus does not carry: an app falls back to its own way
          // (Telegram Desktop to opening a file:// URL, which reaches xdg-open).
          OpenFile: {
            in: 'sha{sv}',
            out: 'o',
            fn: () => {
              throw new DBusError(DBUS_ERRORS.notSupported, 'files are not opened outside the sandbox');
            },
          },
          OpenDirectory: {
            in: 'sha{sv}',
            out: 'o',
            fn: () => {
              throw new DBusError(DBUS_ERRORS.notSupported, 'folders are not opened outside the sandbox');
            },
          },
        },
        properties: { version: { sig: 'u', get: () => 2 } },
      },
      'org.freedesktop.portal.FileChooser': {
        methods: {
          OpenFile: {
            in: 'ssa{sv}',
            out: 'o',
            fn: async ([_parent, title, options]: [string, string, Record<string, unknown>], msg) => {
              const uris = await h.chooseFiles({ kind: 'open', title, multiple: !!options?.multiple, directory: !!options?.directory, names: [] });
              return respond(request(msg, options), uris ? 0 : 1, uris ? { uris: variant('as', uris) } : {});
            },
          },
          SaveFile: {
            in: 'ssa{sv}',
            out: 'o',
            fn: async ([_parent, title, options]: [string, string, Record<string, unknown>], msg) => {
              const name = typeof options?.current_name === 'string' ? options.current_name : '';
              const uris = await h.chooseFiles({ kind: 'save', title, multiple: false, directory: false, names: [name] });
              return respond(request(msg, options), uris ? 0 : 1, uris ? { uris: variant('as', uris) } : {});
            },
          },
          SaveFiles: {
            in: 'ssa{sv}',
            out: 'o',
            fn: async ([_parent, title, options]: [string, string, Record<string, unknown>], msg) => {
              const files = Array.isArray(options?.files) ? (options.files as Buffer[]).map((b) => Buffer.from(b).toString('utf8').replace(/\0+$/, '')) : [];
              const uris = await h.chooseFiles({ kind: 'saveMany', title, multiple: true, directory: false, names: files });
              return respond(request(msg, options), uris ? 0 : 1, uris ? { uris: variant('as', uris) } : {});
            },
          },
        },
        properties: { version: { sig: 'u', get: () => 3 } },
      },
      'org.freedesktop.portal.NetworkMonitor': {
        methods: {
          GetAvailable: { in: '', out: 'b', fn: () => h.online },
          GetMetered: { in: '', out: 'b', fn: () => false },
          // 4: full connectivity; 1: local only.
          GetConnectivity: { in: '', out: 'u', fn: () => (h.online ? 4 : 1) },
          GetStatus: { in: '', out: 'a{sv}', fn: () => ({ available: variant('b', h.online), metered: variant('b', false), connectivity: variant('u', h.online ? 4 : 1) }) },
          CanReach: { in: 'su', out: 'b', fn: () => h.online },
        },
        properties: { version: { sig: 'u', get: () => 3 } },
        signals: { changed: '' },
      },
      'org.freedesktop.portal.Settings': {
        methods: {
          ReadAll: { in: 'as', out: 'a{sa{sv}}', fn: () => ({ 'org.freedesktop.appearance': { 'color-scheme': variant('u', 0) } }) },
          Read: { in: 'ss', out: 'v', fn: ([ns, key]: [string, string]) => variant('v', this.setting(ns, key)) },
          ReadOne: { in: 'ss', out: 'v', fn: ([ns, key]: [string, string]) => this.setting(ns, key) },
        },
        properties: { version: { sig: 'u', get: () => 2 } },
        signals: { SettingChanged: 'ssv' },
      },
    });

    this.bus.export(SANDBOX_PATH, {
      [SANDBOX_NAME]: {
        methods: {
          Open: {
            in: 's',
            out: 'b',
            fn: ([uri]: [string]) => {
              h.link(uri, 'xdg-open');
              return true;
            },
          },
        },
      },
    });

    for (const name of [NOTIFY_IFACE, 'org.freedesktop.portal.Desktop', SANDBOX_NAME]) await this.bus.requestName(name);
  }

  private setting(ns: string, key: string) {
    if (ns === 'org.freedesktop.appearance' && key === 'color-scheme') return variant('u', 0);
    throw new DBusError('org.freedesktop.portal.Error.NotFound', `no setting ${ns} ${key}`);
  }

  /** Press a notification's button for the app ("default" is a click on the notification itself). */
  invokeAction(id: number, key: string) {
    if (!this.open.has(id)) return false;
    this.bus.signal(NOTIFY_PATH, NOTIFY_IFACE, 'ActionInvoked', 'us', [id, key]);
    return true;
  }

  /** Dismiss a notification, as a desktop does when you close it. */
  dismiss(id: number) {
    if (!this.open.delete(id)) return false;
    this.bus.signal(NOTIFY_PATH, NOTIFY_IFACE, 'NotificationClosed', 'uu', [id, 2]);
    this.hooks.notificationClosed(id, 'us');
    return true;
  }

  isOpen(id: number) {
    return this.open.has(id);
  }
}
