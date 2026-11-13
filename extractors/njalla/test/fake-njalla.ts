/**
 * A stand-in for Njalla's JSON-RPC API (https://njal.la/api/1/): tokens, domains and their records, and the five
 * record methods the njalla kind sends. Errors come the way Njalla sends them: HTTP 200 with `{ error: { code,
 * message } }`. Every request is kept (method, params, token) so tests can see what went out.
 */
export interface FakeRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  prio?: number;
}

export interface FakeNjalla {
  url: string;
  /** A token and the domains it reaches (all of them when omitted). */
  addToken(token: string, domains?: string[]): void;
  revoke(token: string): void;
  addDomain(name: string, records?: Omit<FakeRecord, 'id'>[]): void;
  records(domain: string): FakeRecord[];
  calls: { method: string; params: Record<string, any>; token: string | null }[];
  /** The next answers are this HTTP status instead. */
  failNext(status: number, times?: number): void;
  stop(): void;
}

const TTLS = [60, 300, 900, 3600, 10800, 21600, 86400];

export function startFakeNjalla(): FakeNjalla {
  const tokens = new Map<string, string[] | null>();
  const domains = new Map<string, FakeRecord[]>();
  const calls: FakeNjalla['calls'] = [];
  let nextId = 1000;
  let fail: { status: number; times: number } | null = null;

  const err = (code: number, message: string) => Response.json({ jsonrpc: '2.0', error: { code, message } });
  const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', result });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/api/1/' || req.method !== 'POST') return new Response('not found', { status: 404 });
      const auth = req.headers.get('authorization') ?? '';
      const token = auth.startsWith('Njalla ') ? auth.slice(7) : null;
      const body = (await req.json().catch(() => ({}))) as { method?: string; params?: Record<string, any> };
      const method = String(body.method ?? '');
      const p = body.params ?? {};
      calls.push({ method, params: p, token });
      if (fail && fail.times-- > 0) return new Response('busy', { status: fail.status });
      if (!token || !tokens.has(token)) return err(403, 'Permission denied');
      const reach = tokens.get(token)!;
      const may = (d: string) => !reach || reach.includes(d);
      const domain = String(p.domain ?? '');
      const recs = () => {
        if (!domains.has(domain)) return null;
        if (!may(domain)) return 'denied' as const;
        return domains.get(domain)!;
      };
      switch (method) {
        case 'list-domains':
          return ok({ domains: [...domains.keys()].filter(may).map((name) => ({ name, status: 'active', expiry: '2027-08-01T00:00:00Z' })) });
        case 'list-records': {
          const r = recs();
          if (r === 'denied') return err(403, 'Permission denied');
          if (!r) return err(404, 'Domain not found');
          return ok({ records: r });
        }
        case 'add-record': {
          const r = recs();
          if (r === 'denied') return err(403, 'Permission denied');
          if (!r) return err(404, 'Domain not found');
          if (!p.type || !p.content || p.name === undefined) return err(400, 'Missing parameter');
          if (!TTLS.includes(Number(p.ttl))) return err(400, 'Invalid TTL');
          if (p.type === 'CNAME' && p.name === '@') return err(400, 'CNAME not allowed on the domain itself');
          if (p.type === 'CNAME' ? r.some((x) => x.name === p.name) : r.some((x) => x.name === p.name && x.type === 'CNAME')) return err(400, 'CNAME conflicts with another record');
          const rec: FakeRecord = { id: String(nextId++), name: String(p.name), type: String(p.type), content: String(p.content), ttl: Number(p.ttl), ...(p.prio !== undefined ? { prio: Number(p.prio) } : {}) };
          r.push(rec);
          return ok(rec);
        }
        case 'edit-record': {
          const r = recs();
          if (r === 'denied') return err(403, 'Permission denied');
          if (!r) return err(404, 'Domain not found');
          const rec = r.find((x) => x.id === String(p.id));
          if (!rec) return err(404, 'Record not found');
          if (p.ttl !== undefined && !TTLS.includes(Number(p.ttl))) return err(400, 'Invalid TTL');
          if (p.content !== undefined) rec.content = String(p.content);
          if (p.ttl !== undefined) rec.ttl = Number(p.ttl);
          if (p.prio !== undefined) rec.prio = Number(p.prio);
          return ok(rec);
        }
        case 'remove-record': {
          const r = recs();
          if (r === 'denied') return err(403, 'Permission denied');
          if (!r) return err(404, 'Domain not found');
          const i = r.findIndex((x) => x.id === String(p.id));
          if (i < 0) return err(404, 'Record not found');
          r.splice(i, 1);
          return ok({});
        }
        default:
          return err(400, `Unknown method ${method}`);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/api/1/`,
    addToken: (t, d) => tokens.set(t, d ?? null),
    revoke: (t) => tokens.delete(t),
    addDomain: (name, records = []) => domains.set(name, records.map((r) => ({ ...r, id: String(nextId++) }))),
    records: (d) => domains.get(d) ?? [],
    calls,
    failNext: (status, times = 1) => (fail = { status, times }),
    stop: () => server.stop(true),
  };
}
