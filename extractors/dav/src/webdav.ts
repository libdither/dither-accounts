/**
 * A small WebDAV client for CalDAV and CardDAV: requests with Basic or Digest auth (whichever the server asks for,
 * Digest first), redirects followed by hand so credentials go on only to the same site, and multistatus answers
 * parsed with their namespaces (@xmldom/xmldom). Failures are StatusErrors with the server's HTTP status; an
 * unreachable server is 503, a refused sign-in 401 (AuthFailed).
 */
import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import { StatusError } from '@dither-accounts/link';

export const NS = {
  d: 'DAV:',
  c: 'urn:ietf:params:xml:ns:caldav',
  card: 'urn:ietf:params:xml:ns:carddav',
  cs: 'http://calendarserver.org/ns/',
  ical: 'http://apple.com/ns/ical/',
} as const;
export const XMLNS = Object.entries(NS)
  .map(([p, u]) => `xmlns:${p}="${u}"`)
  .join(' ');
export const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export class AuthFailed extends StatusError {
  constructor(message = 'the server refused the username or password') {
    super(message, 401);
  }
}
export class Unreachable extends StatusError {
  constructor(message: string) {
    super(message, 503);
  }
}

export interface DavResponse {
  /** Absolute. */
  href: string;
  /** The response's own status (a removed member in a sync report: 404), if it has one. */
  status: number | null;
  /** `${namespace} ${localName}` → the property element, for properties found (200). */
  props: Map<string, Element>;
}

export interface Creds {
  username: string;
  password: string;
}

type Digest = { realm: string; nonce: string; qop: string | null; opaque: string | null; algorithm: string; nc: number };

const md5 = (s: string) => new Bun.CryptoHasher('md5').update(s).digest('hex');
const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');

/** Challenges in a WWW-Authenticate header: scheme → its parameters. */
function challenges(h: string | null): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (!h) return out;
  const re = /([A-Za-z][\w-]*)\s*(?:=\s*("(?:[^"\\]|\\.)*"|[^\s,]+))?\s*,?\s*/g;
  let scheme: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(h))) {
    if (!m[0]) break;
    if (m[2] === undefined) {
      scheme = m[1].toLowerCase();
      out.set(scheme, {});
    } else if (scheme) out.get(scheme)![m[1].toLowerCase()] = m[2].replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
  }
  return out;
}

/** The last two labels of a host: credentials follow a redirect within the same site (caldav.icloud.com → p52-caldav.icloud.com). */
const site = (host: string) => (/^[\d.]+$|:/.test(host) ? host : host.split('.').slice(-2).join('.'));

export class DavClient {
  /** The scheme the server took last; null until it asks. */
  scheme: 'basic' | 'digest' | null = null;
  private digest: Digest | null = null;
  /** Where credentials may go: the servers' sites, as configured. */
  private homes: URL[] = [];
  server = '';

  constructor(
    private creds: () => Creds,
    private opts: { userAgent: string; timeoutMs?: number; log?: (msg: string) => void } = { userAgent: 'dither-accounts' },
  ) {}

  /** The site credentials are sent to (and to its subdomains, over https). */
  trust(url: URL) {
    if (!this.homes.some((h) => h.origin === url.origin)) this.homes.push(url);
  }

  private mayAuth(u: URL): boolean {
    if (!this.homes.length) return true;
    return this.homes.some((h) => u.origin === h.origin || (u.protocol === 'https:' && site(u.hostname) === site(h.hostname)));
  }

  private authHeader(method: string, u: URL): string | null {
    if (!this.mayAuth(u)) return null;
    const { username, password } = this.creds();
    if (this.scheme === 'basic') return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    if (this.scheme === 'digest' && this.digest) {
      const d = this.digest;
      const h = d.algorithm.toUpperCase().startsWith('SHA-256') ? sha256 : md5;
      const uri = u.pathname + u.search;
      const cnonce = crypto.randomUUID().replace(/-/g, '');
      const nc = (++d.nc).toString(16).padStart(8, '0');
      let ha1 = h(`${username}:${d.realm}:${password}`);
      if (d.algorithm.toLowerCase().endsWith('-sess')) ha1 = h(`${ha1}:${d.nonce}:${cnonce}`);
      const ha2 = h(`${method}:${uri}`);
      const qop = d.qop?.split(',').map((q) => q.trim()).includes('auth') ? 'auth' : null;
      const response = qop ? h(`${ha1}:${d.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : h(`${ha1}:${d.nonce}:${ha2}`);
      const q = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
      return [
        `Digest username=${q(username)}`,
        `realm=${q(d.realm)}`,
        `nonce=${q(d.nonce)}`,
        `uri=${q(uri)}`,
        `algorithm=${d.algorithm}`,
        `response=${q(response)}`,
        ...(d.opaque !== null ? [`opaque=${q(d.opaque)}`] : []),
        ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce=${q(cnonce)}`] : []),
      ].join(', ');
    }
    return null;
  }

  /** Take the server's challenge; false when it offers nothing this client speaks. */
  private challenged(res: Response): boolean {
    const ch = challenges(res.headers.get('www-authenticate'));
    const dg = ch.get('digest');
    if (dg && dg.nonce && (!dg.algorithm || /^(MD5|MD5-sess|SHA-256|SHA-256-sess)$/i.test(dg.algorithm))) {
      this.scheme = 'digest';
      this.digest = { realm: dg.realm ?? '', nonce: dg.nonce, qop: dg.qop ?? null, opaque: dg.opaque ?? null, algorithm: dg.algorithm ?? 'MD5', nc: 0 };
      return true;
    }
    if (ch.has('basic') || !ch.size) {
      this.scheme = 'basic';
      return true;
    }
    return false;
  }

  /**
   * One request, redirects followed (the method kept, except 303), signed in as the server asks. A 401 after
   * answering the server's challenge throws AuthFailed; no answer at all throws Unreachable.
   */
  async request(method: string, url: string | URL, init: { headers?: Record<string, string>; body?: string; depth?: 0 | 1 | 'infinity' } = {}): Promise<Response & { finalUrl: URL }> {
    let u = new URL(url);
    let m = method;
    let body = init.body;
    let answered = false;
    for (let hop = 0; hop < 8; hop++) {
      const headers: Record<string, string> = { 'user-agent': this.opts.userAgent, ...(init.headers ?? {}) };
      if (init.depth !== undefined) headers.depth = String(init.depth);
      if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/xml; charset=utf-8';
      const auth = this.authHeader(m, u);
      if (auth) headers.authorization = auth;
      let res: Response;
      try {
        res = await fetch(u, { method: m, headers, body, redirect: 'manual', signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000) });
      } catch (e: any) {
        const why = e?.name === 'TimeoutError' ? 'no answer in time' : String(e?.code ?? e?.message ?? e);
        throw new Unreachable(`${u.host} is not reachable: ${why}`);
      }
      this.server = res.headers.get('server') ?? this.server;
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
        await res.body?.cancel().catch(() => {});
        u = new URL(res.headers.get('location')!, u);
        if (res.status === 303) {
          m = 'GET';
          body = undefined;
        }
        continue;
      }
      if (res.status === 401) {
        const stale = /stale\s*=\s*"?true/i.test(res.headers.get('www-authenticate') ?? '');
        await res.body?.cancel().catch(() => {});
        if (!this.mayAuth(u)) throw new AuthFailed(`${u.host} asks for a sign-in, but it is another site than the one set up; not sending the password there`);
        if ((!answered || stale) && this.challenged(res)) {
          answered = true;
          hop--;
          continue;
        }
        throw new AuthFailed();
      }
      return Object.assign(res, { finalUrl: u });
    }
    throw new StatusError(`too many redirects from ${new URL(url).host}`, 508);
  }

  /** A request that must succeed (2xx); the answer's text. */
  async text(method: string, url: string | URL, init: Parameters<DavClient['request']>[2] = {}, what = method): Promise<{ status: number; text: string; headers: Headers; url: URL }> {
    const res = await this.request(method, url, init);
    const text = await res.text();
    if (!res.ok) throw httpError(res.status, what, text);
    return { status: res.status, text, headers: res.headers, url: res.finalUrl };
  }

  async propfind(url: string | URL, props: string, depth: 0 | 1): Promise<{ responses: DavResponse[]; url: URL }> {
    const r = await this.text('PROPFIND', url, { depth, body: `<?xml version="1.0" encoding="utf-8"?><d:propfind ${XMLNS}><d:prop>${props}</d:prop></d:propfind>` }, 'PROPFIND');
    return { responses: parseMultistatus(r.text, r.url).responses, url: r.url };
  }

  async report(url: string | URL, body: string, depth: 0 | 1 = 1): Promise<{ responses: DavResponse[]; syncToken: string | null; url: URL }> {
    const r = await this.text('REPORT', url, { depth, body: `<?xml version="1.0" encoding="utf-8"?>${body}` }, 'REPORT');
    return { ...parseMultistatus(r.text, r.url), url: r.url };
  }
}

/** A failed answer as a StatusError, with what the server said when it says it in a DAV error element. */
export function httpError(status: number, what: string, body = ''): StatusError {
  const cond = body.match(/<(?:\w+:)?(valid-sync-token|no-uid-conflict|supported-calendar-data|valid-calendar-data|valid-address-data|number-of-matches-within-limits|needs-privilege)\b/)?.[1];
  const words: Record<number, string> = { 403: 'refused (no permission)', 404: 'not found', 405: 'not allowed here', 409: 'conflict', 412: 'changed since (the etag does not match)', 415: 'unsupported data', 507: 'the server is full' };
  const e = new StatusError(`${what}: the server answered ${status}${words[status] ? ` (${words[status]})` : ''}${cond ? `: ${cond}` : ''}`, status);
  (e as any).condition = cond ?? null;
  return e;
}

const kids = (n: Node): Element[] => {
  const out: Element[] = [];
  for (let c = n.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as Element);
  return out;
};
export const child = (n: Node, ns: string, name: string): Element | null => kids(n).find((e) => e.namespaceURI === ns && e.localName === name) ?? null;
export const children = (n: Node, ns: string, name: string): Element[] => kids(n).filter((e) => e.namespaceURI === ns && e.localName === name);
export const elements = kids;
export const textOf = (e: Element | null | undefined): string | null => {
  const t = e?.textContent?.trim();
  return t ? t : null;
};
const code = (s: string | null) => Number(s?.match(/\s(\d{3})\b/)?.[1] ?? NaN) || null;

export function parseXml(text: string): Element {
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (level: string, msg: string) => void (level !== 'warning' && errors.push(msg)) }).parseFromString(text, 'text/xml');
  const root = doc.documentElement;
  if (!root || errors.length) throw new StatusError(`the server sent XML that does not parse${errors.length ? `: ${errors[0]}` : ''}`, 502);
  return root as unknown as Element;
}

export function parseMultistatus(text: string, base: URL): { responses: DavResponse[]; syncToken: string | null } {
  const root = parseXml(text);
  if (root.namespaceURI !== NS.d || root.localName !== 'multistatus') throw new StatusError('the server did not answer with a multistatus', 502);
  const responses: DavResponse[] = [];
  for (const r of children(root, NS.d, 'response')) {
    const href = textOf(child(r, NS.d, 'href'));
    if (!href) continue;
    const props = new Map<string, Element>();
    for (const ps of children(r, NS.d, 'propstat')) {
      const st = code(textOf(child(ps, NS.d, 'status')));
      if (st === null || st < 200 || st > 299) continue;
      const p = child(ps, NS.d, 'prop');
      if (p) for (const e of kids(p)) props.set(`${e.namespaceURI} ${e.localName}`, e);
    }
    let abs: string;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    responses.push({ href: abs, status: code(textOf(child(r, NS.d, 'status'))), props });
  }
  return { responses, syncToken: textOf(child(root, NS.d, 'sync-token')) };
}

export const prop = (r: DavResponse, ns: string, name: string) => r.props.get(`${ns} ${name}`) ?? null;
export const propText = (r: DavResponse, ns: string, name: string) => textOf(prop(r, ns, name));
/** The hrefs inside a property (current-user-principal, calendar-home-set), absolute. */
export function propHrefs(r: DavResponse, ns: string, name: string, base: URL): URL[] {
  const p = prop(r, ns, name);
  if (!p) return [];
  return children(p, NS.d, 'href')
    .map((h) => textOf(h))
    .filter((h): h is string => !!h)
    .map((h) => new URL(h, base));
}
export const hasType = (r: DavResponse, ns: string, name: string) => {
  const rt = prop(r, NS.d, 'resourcetype');
  return !!rt && !!child(rt, ns, name);
};

/** A path segment, decoded once and encoded the one way, so ids match however a server spells an href. */
export const canonSeg = (seg: string) => {
  let d = seg;
  try {
    d = decodeURIComponent(seg);
  } catch {}
  return d.replace(/[^A-Za-z0-9._~@+=!$&'()*,;:-]/g, (c) => encodeURIComponent(c));
};
export const canonPath = (path: string) => path.split('/').map(canonSeg).join('/');
/** The ETag as a value to compare (weak or strong alike). */
export const etagValue = (e: string | null | undefined) => (e ? e.trim().replace(/^W\//, '') : null);
