/**
 * `desktop`: what a native app in the account's sandbox hands to the desktop, which the extractor owns
 * (docs/native-sandbox.md): links it opens, files it saves, files it asks for. Telegram Desktop's today. Nothing is
 * opened anywhere: a link is recorded and offered to the apps that subscribe; a saved file stays in the account's
 * downloads folder until an app fetches it.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

export interface DesktopLink {
  id: string;
  url: string;
  /** How the app asked: the xdg-open shim on its PATH, or the OpenURI portal. */
  via: 'xdg-open' | 'portal';
  at: number;
}

export interface DesktopDownload {
  id: string;
  /** Relative to the downloads folder: "Telegram Desktop/photo.jpg". */
  path: string;
  name: string;
  size: number;
  mime: string;
  at: number;
}

export interface DesktopFileRequest {
  id: string;
  /** open: the app wants a file (to attach); save, saveMany: where to put one. */
  kind: 'open' | 'save' | 'saveMany';
  title: string;
  /** outbox: given what desktop.offer left there; downloads: saved into the downloads folder; cancelled. */
  answer: 'outbox' | 'downloads' | 'cancelled';
  files: string[];
  at: number;
}

export const desktop = iface({
  name: 'desktop',
  version: 1,
  describe: "What the account's sandboxed app hands to the desktop: links, saved files, file requests.",
  levels: {
    read: 'See the links your app opened and the files it saved',
    write: 'Give your app files for when it asks for one',
  },
  ops: {
    'desktop.links': op('read', 'Links the app asked to open, newest first', s.object({ limit: s.optional(s.integer) }), s.typed<{ links: DesktopLink[] }>()),
    'desktop.downloads': op('read', 'Files the app saved, newest first', s.object({ limit: s.optional(s.integer) }), s.typed<{ downloads: DesktopDownload[] }>()),
    'desktop.fetch': op('read', "A saved file's bytes (up to 64 MB)", s.object({ id: s.string }), s.typed<{ name: string; mime: string; size: number; base64: string }>(), 60_000),
    'desktop.fileRequests': op('read', 'The file dialogs the app opened and how each was answered, newest first', s.object({}), s.typed<{ requests: DesktopFileRequest[] }>()),
    'desktop.offer': op('write', 'Put a file where the app finds it the next time it asks for one', s.object({ name: s.string, base64: s.string }), s.object({ name: s.string }), 60_000),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
    'desktop.link': ev('The app asked to open a link', s.typed<{ link: DesktopLink }>()),
    'desktop.download': ev('The app saved a file, and it is whole', s.typed<{ download: DesktopDownload }>()),
    'desktop.fileRequest': ev('The app opened a file dialog, and how it was answered', s.typed<{ request: DesktopFileRequest }>()),
  },
});
