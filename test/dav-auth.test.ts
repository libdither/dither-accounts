/**
 * How the dav extractor's WebDAV client signs in (extractors/dav/src/webdav.ts), against Radicale: HTTP Digest through
 * a proxy that demands it (and a nonce gone stale), a refused password, and credentials never following a redirect to
 * another site.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { discover } from '../extractors/dav/src/discover.ts';
import { AuthFailed, DavClient } from '../extractors/dav/src/webdav.ts';
import { DigestProxy } from '../extractors/dav/test/digest-proxy.ts';
import { Radicale } from '../extractors/dav/test/radicale.ts';
import { radicale, why } from './needs.ts';

const ok = why('Radicale (from nixpkgs, or RADICALE_BIN)', radicale);
const it = test.skipIf(!ok);

setDefaultTimeout(60_000);
let rad: Radicale;
let proxy: DigestProxy;
let redirector: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!ok) return;
  rad = new Radicale(18531, { carol: 'carol-pw' }, { carol: { cal: { tag: 'VCALENDAR', name: 'Carol' } } });
  await rad.start();
  proxy = new DigestProxy(18533, rad.url, { carol: 'carol-pw' });
  // Another site (localhost is not 127.0.0.1) that sends everything on to Radicale.
  redirector = Bun.serve({ hostname: '127.0.0.1', port: 18534, fetch: (req) => new Response(null, { status: 307, headers: { location: `http://localhost:18531${new URL(req.url).pathname}` } }) });
});
afterAll(async () => {
  if (!ok) return;
  proxy?.stop();
  redirector?.stop(true);
  await rad?.close();
});

const client = (password: string) => new DavClient(() => ({ username: 'carol', password }), { userAgent: 'test' });

it('Digest: found through a server that only takes Digest; a stale nonce is answered again', async () => {
  const c = client('carol-pw');
  const f = await discover(c, proxy.url);
  expect(c.scheme).toBe('digest');
  expect(new URL(f.principal).pathname).toBe('/carol/');
  expect(new URL(f.calHome!).pathname).toBe('/carol/');
  expect(proxy.seen[0]).toBe('none');
  expect(proxy.seen).not.toContain('basic');
  expect(proxy.seen.filter((s) => s === 'digest-ok').length).toBeGreaterThan(1);
  proxy.rotate();
  const { responses } = await c.propfind(f.calHome!, '<d:displayname/><d:resourcetype/>', 1);
  expect(responses.some((r) => r.href.endsWith('/carol/cal/'))).toBe(true);
  expect(proxy.seen).toContain('digest-stale');
});

it('a refused password is AuthFailed (401), after one answer to the challenge', async () => {
  const c = client('wrong');
  const before = proxy.seen.length;
  const e = await discover(c, proxy.url).catch((x) => x);
  expect(e).toBeInstanceOf(AuthFailed);
  expect(e.status).toBe(401);
  expect(proxy.seen.slice(before).filter((s) => s === 'digest-bad').length).toBe(1);
  const b = await discover(client('wrong'), rad.url).catch((x) => x);
  expect(b).toBeInstanceOf(AuthFailed);
});

it('credentials do not follow a redirect to another site', async () => {
  const c = client('carol-pw');
  c.trust(new URL('http://127.0.0.1:18534/'));
  const e = await c.propfind('http://127.0.0.1:18534/carol/', '<d:resourcetype/>', 0).catch((x) => x);
  expect(e).toBeInstanceOf(AuthFailed);
  expect(e.message).toContain('another site');
  // The same server by its own name is fine.
  const ok = client('carol-pw');
  ok.trust(new URL(rad.url));
  expect((await ok.propfind(`${rad.url}/carol/`, '<d:resourcetype/>', 0)).responses.length).toBe(1);
});
