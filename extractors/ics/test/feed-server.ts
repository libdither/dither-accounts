/**
 * A local HTTP server of .ics feeds for the tests. Each path has its text and how it answers a refresh: `etag`
 * (ETag, 304 for If-None-Match), `lastmod` (Last-Modified, 304 for If-Modified-Since), or `none` (neither, and a fresh
 * DTSTAMP on every fetch, as Google's feeds do); optionally Basic auth. It records every request.
 */
import type { Server } from 'bun';

export interface FeedDef {
  text: string;
  mode: 'etag' | 'lastmod' | 'none';
  auth?: string;
  status?: number;
  modifiedAt?: number;
}

export class FeedServer {
  private feeds = new Map<string, FeedDef>();
  hits: { path: string; ifNoneMatch: string | null; ifModifiedSince: string | null; status: number; auth: boolean }[] = [];
  private server: Server<undefined> | null = null;
  readonly url: string;

  constructor(readonly port: number) {
    this.url = `http://127.0.0.1:${port}`;
  }

  set(path: string, def: FeedDef) {
    this.feeds.set(path, { ...def, modifiedAt: def.modifiedAt ?? Math.floor(Date.now() / 1000) * 1000 });
  }
  /** Change a feed's text (its ETag and Last-Modified move with it). */
  update(path: string, text: string) {
    const f = this.feeds.get(path)!;
    // Last-Modified has second resolution: make sure it moves.
    this.feeds.set(path, { ...f, text, modifiedAt: Math.max(Math.floor(Date.now() / 1000) * 1000, (f.modifiedAt ?? 0) + 1000) });
  }
  hitsOf(path: string) {
    return this.hits.filter((h) => h.path === path);
  }

  start() {
    if (this.server) return;
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: this.port,
      fetch: (req) => {
        const u = new URL(req.url);
        const f = this.feeds.get(u.pathname);
        const hit = { path: u.pathname, ifNoneMatch: req.headers.get('if-none-match'), ifModifiedSince: req.headers.get('if-modified-since'), status: 200, auth: !!req.headers.get('authorization') };
        this.hits.push(hit);
        const answer = (status: number, body: string | null = null, headers: Record<string, string> = {}) => {
          hit.status = status;
          return new Response(body, { status, headers });
        };
        if (!f) return answer(404, 'no such feed');
        if (f.auth && req.headers.get('authorization') !== `Basic ${Buffer.from(f.auth).toString('base64')}`) return answer(401, 'sign in', { 'www-authenticate': 'Basic realm="feed"' });
        if (f.status) return answer(f.status, 'nope');
        const type = { 'content-type': 'text/calendar; charset=utf-8' };
        if (f.mode === 'etag') {
          const etag = `"${new Bun.CryptoHasher('sha1').update(f.text).digest('hex').slice(0, 16)}"`;
          if (req.headers.get('if-none-match') === etag) return answer(304, null, { etag });
          return answer(200, f.text, { ...type, etag });
        }
        if (f.mode === 'lastmod') {
          const lm = new Date(f.modifiedAt!).toUTCString();
          const since = Date.parse(req.headers.get('if-modified-since') ?? '');
          if (Number.isFinite(since) && f.modifiedAt! <= since) return answer(304, null, { 'last-modified': lm });
          return answer(200, f.text, { ...type, 'last-modified': lm });
        }
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        return answer(200, f.text.replace(/^DTSTAMP:.*$/gm, `DTSTAMP:${stamp}`), type);
      },
    });
  }

  stop() {
    this.server?.stop(true);
    this.server = null;
  }
}

export const feed = (name: string, ...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test feed//EN', `X-WR-CALNAME:${name}`, ...lines, 'END:VCALENDAR', ''].join('\r\n');
export const vevent = (...lines: string[]) => ['BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
