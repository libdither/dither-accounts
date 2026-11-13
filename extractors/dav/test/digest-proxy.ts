/**
 * A proxy in front of a test server that signs clients in with HTTP Digest (RFC 7616: MD5, qop=auth, opaque) and
 * passes requests on with Basic, as Baïkal and older servers do. `rotate()` changes the nonce, so the next request is
 * answered 401 with stale=true.
 */
import type { Server } from 'bun';

const md5 = (s: string) => new Bun.CryptoHasher('md5').update(s).digest('hex');

export class DigestProxy {
  private server: Server<undefined>;
  nonce = crypto.randomUUID();
  readonly realm = 'dav-test';
  readonly opaque = 'opaque-value';
  /** What each request came with: digest (and whether it checked out), basic, or nothing. */
  seen: string[] = [];
  readonly url: string;

  constructor(
    port: number,
    private upstream: string,
    private users: Record<string, string>,
  ) {
    this.url = `http://127.0.0.1:${port}`;
    this.server = Bun.serve({ hostname: '127.0.0.1', port, fetch: (req) => this.handle(req) });
  }

  rotate() {
    this.nonce = crypto.randomUUID();
  }

  private challenge(stale = false) {
    return new Response('sign in', { status: 401, headers: { 'www-authenticate': `Digest realm="${this.realm}", qop="auth", algorithm=MD5, nonce="${this.nonce}", opaque="${this.opaque}"${stale ? ', stale=true' : ''}` } });
  }

  private async handle(req: Request): Promise<Response> {
    const h = req.headers.get('authorization') ?? '';
    if (!h.startsWith('Digest ')) {
      this.seen.push(h ? h.split(' ')[0].toLowerCase() : 'none');
      return this.challenge();
    }
    const p: Record<string, string> = {};
    for (const m of h.slice(7).matchAll(/(\w+)=("((?:[^"\\]|\\.)*)"|[^,\s]+)/g)) p[m[1]] = m[3] ?? m[2];
    const u = new URL(req.url);
    const pass = this.users[p.username];
    const ha1 = md5(`${p.username}:${this.realm}:${pass}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    const good = pass !== undefined && p.uri === u.pathname + u.search && p.opaque === this.opaque && p.qop === 'auth' && p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`);
    if (good && p.nonce !== this.nonce) {
      this.seen.push('digest-stale');
      return this.challenge(true);
    }
    this.seen.push(good ? 'digest-ok' : 'digest-bad');
    if (!good) return this.challenge();
    const headers = new Headers(req.headers);
    headers.set('authorization', `Basic ${Buffer.from(`${p.username}:${pass}`).toString('base64')}`);
    headers.delete('host');
    const res = await fetch(this.upstream + u.pathname + u.search, { method: req.method, headers, body: req.body ? await req.text() : undefined, redirect: 'manual' });
    // fetch has already undone any compression.
    const out = new Headers(res.headers);
    out.delete('content-encoding');
    out.delete('content-length');
    return new Response(await res.arrayBuffer(), { status: res.status, headers: out });
  }

  stop() {
    this.server.stop(true);
  }
}
