/**
 * A fake of the parts of Mastodon's REST API the mastodon extractor calls, shaped as Mastodon 4.x documents them, with
 * invented data only:
 *
 * - apps and out-of-band OAuth: POST /api/v1/apps, GET /oauth/authorize (not followed), POST /oauth/token
 *   (authorization_code: a code `approve()` made, used once)
 * - tokens as `Authorization: Bearer <t>`; an unknown one is 401 {"error":"The access token is invalid"}
 * - GET /api/v1/accounts/verify_credentials, /api/v2/instance, /api/v1/accounts/lookup, /api/v2/search,
 *   /api/v1/accounts/relationships, /api/v1/accounts/:id/statuses
 * - GET /api/v1/notifications (limit, max_id, min_id, newest first)
 * - GET /api/v1/timelines/home (max_id, min_id), /api/v1/trends/statuses (offset)
 * - GET /api/v1/statuses/:id, /context, /favourited_by, /reblogged_by (Link next by max_id)
 * - POST /api/v1/statuses/:id/favourite|unfavourite|reblog|unreblog, POST /api/v1/statuses (Idempotency-Key),
 *   DELETE /api/v1/statuses/:id, POST /api/v2/media (202, ready on the second look), GET /api/v1/media/:id
 * - X-RateLimit-Remaining and X-RateLimit-Reset on every answer; `limitNext(n)` answers 429 n times
 */

export interface FakeAccount {
  id: string;
  username: string;
  /** Without a domain for the server's own people. */
  acct: string;
  display_name: string;
  avatar: string;
  header: string;
  note: string;
  url: string;
  bot: boolean;
  created_at: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  fields: { name: string; value: string; verified_at: string | null }[];
}

export interface FakeStatus {
  id: string;
  account: string;
  created_at: string;
  content: string;
  spoiler_text?: string;
  in_reply_to_id?: string | null;
  reblog_of?: string;
  quote_of?: string;
  media?: { id: string; type: string; url: string; description?: string }[];
  visibility?: string;
  language?: string;
  quote_approval?: { current_user: string };
}

export interface FakeNotification {
  id: string;
  type: string;
  account?: string;
  status?: string;
  created_at: string;
}

export interface FakeMastodon {
  url: string;
  host: string;
  calls: { method: string; path: string; query: string; auth: string | null; body: any; idem: string | null }[];
  accounts: Map<string, FakeAccount>;
  statuses: Map<string, FakeStatus>;
  notifications: FakeNotification[];
  tokens: Map<string, string>;
  favourites: Set<string>;
  reblogs: Set<string>;
  addAccount(a: Partial<FakeAccount> & { id: string; username: string }, remote?: string): FakeAccount;
  addStatus(s: Partial<FakeStatus> & { id: string; account: string; content: string }): FakeStatus;
  notify(n: Omit<FakeNotification, 'created_at'> & { created_at?: string }): void;
  /** The owner approving on the authorize page: a code for the latest app. */
  approve(account: string): string;
  limitNext(n: number): void;
  stop(): void;
}

let clock = Date.parse('2026-05-01T12:00:00Z');
export const isoAt = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export function startFakeMastodon(opts: { self: string; selfToken?: string } = { self: '1' }): FakeMastodon {
  const accounts = new Map<string, FakeAccount>();
  const statuses = new Map<string, FakeStatus>();
  const notifications: FakeNotification[] = [];
  const tokens = new Map<string, string>();
  const apps = new Map<string, { secret: string }>();
  const codes = new Map<string, string>();
  const favourites = new Set<string>();
  const reblogs = new Set<string>();
  const media = new Map<string, { id: string; looks: number; type: string }>();
  const idem = new Map<string, string>();
  const calls: FakeMastodon['calls'] = [];
  let limited = 0;
  let nextId = 900;
  let lastApp = '';
  if (opts.selfToken) tokens.set(opts.selfToken, opts.self);

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const u = new URL(req.url);
      const auth = req.headers.get('authorization');
      let body: any = null;
      const ct = req.headers.get('content-type') ?? '';
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        if (ct.includes('json')) body = await req.json().catch(() => null);
        else if (ct.includes('multipart')) {
          const f = await req.formData();
          body = { file: f.get('file') ? (f.get('file') as File).name : null };
        }
      }
      calls.push({ method: req.method, path: u.pathname, query: u.search, auth, body, idem: req.headers.get('idempotency-key') });
      return route(req.method, u, auth, body, req.headers.get('idempotency-key'));
    },
  });
  const host = `127.0.0.1:${server.port}`;
  const base = `http://${host}`;

  const rate = (r: Response) => {
    r.headers.set('x-ratelimit-limit', '300');
    r.headers.set('x-ratelimit-remaining', '250');
    r.headers.set('x-ratelimit-reset', new Date(Date.now() + 300_000).toISOString());
    return r;
  };
  const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => rate(new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } }));
  const err = (status: number, error: string) => json({ error }, status);

  const accountJson = (id: string) => {
    const a = accounts.get(id)!;
    return { ...a };
  };
  const statusJson = (id: string, viewer: string | null, depth = 0): any => {
    const s = statuses.get(id)!;
    const reblog = s.reblog_of && depth < 1 ? statusJson(s.reblog_of, viewer, depth + 1) : null;
    const replyTo = s.in_reply_to_id ? statuses.get(s.in_reply_to_id) : null;
    const replies = [...statuses.values()].filter((x) => x.in_reply_to_id === id).length;
    return {
      id: s.id,
      uri: `${base}/users/${accounts.get(s.account)!.username}/statuses/${s.id}`,
      url: `${base}/@${accounts.get(s.account)!.acct}/${s.id}`,
      created_at: s.created_at,
      account: accountJson(s.account),
      content: reblog ? '' : s.content,
      spoiler_text: s.spoiler_text ?? '',
      sensitive: !!s.spoiler_text,
      visibility: s.visibility ?? 'public',
      language: s.language ?? 'en',
      in_reply_to_id: s.in_reply_to_id ?? null,
      in_reply_to_account_id: replyTo?.account ?? null,
      reblog,
      mentions: replyTo ? [{ id: replyTo.account, acct: accounts.get(replyTo.account)!.acct, username: accounts.get(replyTo.account)!.username, url: accounts.get(replyTo.account)!.url }] : [],
      media_attachments: (s.media ?? []).map((m) => ({ ...m, preview_url: m.url, meta: { original: { width: 640, height: 480 } } })),
      replies_count: replies,
      reblogs_count: [...reblogs].filter((k) => k.startsWith(`${id}:`)).length,
      favourites_count: [...favourites].filter((k) => k.startsWith(`${id}:`)).length,
      favourited: viewer ? favourites.has(`${id}:${viewer}`) : undefined,
      reblogged: viewer ? reblogs.has(`${id}:${viewer}`) : undefined,
      ...(s.quote_of && depth < 1 ? { quote: { state: 'accepted', quoted_status: statusJson(s.quote_of, viewer, depth + 1) } } : {}),
      ...(s.quote_approval ? { quote_approval: { automatic: ['public'], manual: [], current_user: s.quote_approval.current_user } } : {}),
    };
  };
  const page = <T extends { id: string }>(list: T[], u: URL, limitMax = 40): { items: T[]; next: string | null } => {
    const limit = Math.min(limitMax, Number(u.searchParams.get('limit')) || 20);
    const max = u.searchParams.get('max_id');
    const min = u.searchParams.get('min_id');
    const byId = [...list].sort((a, b) => Number(b.id) - Number(a.id));
    let items: T[];
    if (min) items = byId.filter((x) => Number(x.id) > Number(min)).slice(-limit);
    else items = byId.filter((x) => !max || Number(x.id) < Number(max)).slice(0, limit);
    return { items, next: items.length === limit ? items[items.length - 1].id : null };
  };

  function route(method: string, u: URL, auth: string | null, body: any, idemKey: string | null): Response {
    const p = u.pathname;
    if (limited > 0 && p.startsWith('/api/')) {
      limited--;
      return json({ error: 'Too many requests' }, 429, { 'retry-after': '1' });
    }
    if (method === 'POST' && p === '/api/v1/apps') {
      const id = `client-${apps.size + 1}`;
      apps.set(id, { secret: `secret-${apps.size + 1}` });
      lastApp = id;
      return json({ id: String(apps.size), name: body?.client_name, client_id: id, client_secret: apps.get(id)!.secret, redirect_uri: body?.redirect_uris });
    }
    if (method === 'POST' && p === '/oauth/token') {
      const app = apps.get(body?.client_id);
      if (!app || app.secret !== body?.client_secret) return json({ error: 'invalid_client', error_description: 'Client authentication failed' }, 401);
      const who = codes.get(body?.code);
      if (!who || body?.grant_type !== 'authorization_code') return json({ error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' }, 400);
      codes.delete(body.code);
      const t = `tok-${nextId++}`;
      tokens.set(t, who);
      return json({ access_token: t, token_type: 'Bearer', scope: body.scope, created_at: 1 });
    }
    if (p === '/api/v2/instance') return json({ domain: host, configuration: { statuses: { max_characters: 500, characters_reserved_per_url: 23, max_media_attachments: 4 } } });
    const viewer = auth?.startsWith('Bearer ') ? (tokens.get(auth.slice(7)) ?? null) : null;
    if (p === '/api/v1/trends/statuses') {
      const off = Number(u.searchParams.get('offset')) || 0;
      const lim = Number(u.searchParams.get('limit')) || 20;
      const all = [...statuses.values()].filter((s) => !s.reblog_of && !s.in_reply_to_id).sort((a, b) => Number(a.id) - Number(b.id));
      return json(all.slice(off, off + lim).map((s) => statusJson(s.id, viewer)));
    }
    if (!viewer) return err(401, 'The access token is invalid');
    if (p === '/api/v1/accounts/verify_credentials') return json({ ...accountJson(viewer), source: { privacy: 'public' } });
    if (p === '/api/v1/notifications') {
      const { items, next } = page(notifications, u);
      return json(
        items.map((n) => ({ id: n.id, type: n.type, created_at: n.created_at, ...(n.account ? { account: accountJson(n.account) } : {}), ...(n.status ? { status: statusJson(n.status, viewer) } : {}) })),
        200,
        next ? { link: `<${base}/api/v1/notifications?max_id=${next}>; rel="next"` } : {},
      );
    }
    if (p === '/api/v1/timelines/home') {
      const { items } = page([...statuses.values()], u);
      return json(items.map((s) => statusJson(s.id, viewer)));
    }
    if (p === '/api/v1/accounts/lookup') {
      const acct = u.searchParams.get('acct');
      // Only people the server has heard of: here, its own.
      const a = [...accounts.values()].find((x) => x.acct === acct && !x.acct.includes('@'));
      return a ? json(accountJson(a.id)) : err(404, 'Record not found');
    }
    if (p === '/api/v2/search') {
      const q = (u.searchParams.get('q') ?? '').replace(/^@/, '');
      const a = u.searchParams.get('resolve') === 'true' ? [...accounts.values()].find((x) => `${x.username}@remote.example` === q) : undefined;
      return json({ accounts: a ? [accountJson(a.id)] : [], statuses: [], hashtags: [] });
    }
    if (p === '/api/v1/accounts/relationships') {
      const id = u.searchParams.get('id[]');
      return json([{ id, following: id === '2', followed_by: id === '2', requested: false, blocking: false }]);
    }
    let m = p.match(/^\/api\/v1\/accounts\/(\w+)\/statuses$/);
    if (m) {
      const id = m[1];
      const list = [...statuses.values()].filter((s) => s.account === id).sort((a, b) => Number(b.id) - Number(a.id));
      if (u.searchParams.get('pinned') === 'true') return json(list.slice(-1).map((s) => ({ ...statusJson(s.id, viewer), pinned: true })));
      return json(list.slice(0, Number(u.searchParams.get('limit')) || 20).map((s) => statusJson(s.id, viewer)));
    }
    m = p.match(/^\/api\/v1\/statuses\/(\w+)(?:\/(\w+))?$/);
    if (m) {
      const [, id, sub] = m;
      if (!statuses.has(id)) return err(404, 'Record not found');
      if (method === 'GET' && !sub) return json(statusJson(id, viewer));
      if (method === 'DELETE' && !sub) {
        statuses.delete(id);
        return json({ id });
      }
      if (method === 'GET' && sub === 'context') {
        const anc: string[] = [];
        for (let cur = statuses.get(id)!.in_reply_to_id; cur && statuses.has(cur); cur = statuses.get(cur)!.in_reply_to_id) anc.unshift(cur);
        const desc: string[] = [];
        const walk = (pid: string) => {
          for (const s of [...statuses.values()].filter((x) => x.in_reply_to_id === pid).sort((a, b) => Number(a.id) - Number(b.id))) {
            desc.push(s.id);
            walk(s.id);
          }
        };
        walk(id);
        return json({ ancestors: anc.map((a) => statusJson(a, viewer)), descendants: desc.map((d) => statusJson(d, viewer)) });
      }
      if (method === 'GET' && (sub === 'favourited_by' || sub === 'reblogged_by')) {
        const set = sub === 'favourited_by' ? favourites : reblogs;
        const who = [...set].filter((k) => k.startsWith(`${id}:`)).map((k) => ({ id: k.split(':')[1] }));
        const { items, next } = page(who, u);
        return json(items.map((w) => accountJson(w.id)), 200, next ? { link: `<${base}${p}?max_id=${next}>; rel="next"` } : {});
      }
      if (method === 'POST' && sub) {
        const k = `${id}:${viewer}`;
        if (sub === 'favourite') favourites.add(k);
        else if (sub === 'unfavourite') favourites.delete(k);
        else if (sub === 'reblog') {
          reblogs.add(k);
          const rid = String(nextId++);
          statuses.set(rid, { id: rid, account: viewer, created_at: new Date().toISOString(), content: '', reblog_of: id });
          return json(statusJson(rid, viewer));
        } else if (sub === 'unreblog') reblogs.delete(k);
        else return err(404, 'Not found');
        return json(statusJson(id, viewer));
      }
    }
    if (method === 'POST' && p === '/api/v1/statuses') {
      if (idemKey && idem.has(idemKey)) return json(statusJson(idem.get(idemKey)!, viewer));
      if (body?.in_reply_to_id && !statuses.has(body.in_reply_to_id)) return err(404, 'Record not found');
      for (const mid of body?.media_ids ?? []) if (!media.has(mid) || media.get(mid)!.looks < 1) return err(422, 'Validation failed: media not ready');
      const id = String(nextId++);
      statuses.set(id, {
        id,
        account: viewer,
        created_at: new Date().toISOString(),
        content: `<p>${String(body?.status ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`,
        spoiler_text: body?.spoiler_text,
        in_reply_to_id: body?.in_reply_to_id ?? null,
        visibility: body?.visibility,
        ...(body?.quoted_status_id ? { quote_of: body.quoted_status_id } : {}),
        media: (body?.media_ids ?? []).map((mid: string) => ({ id: mid, type: 'image', url: `${base}/media/${mid}.png` })),
      });
      if (idemKey) idem.set(idemKey, id);
      return json(statusJson(id, viewer));
    }
    if (method === 'POST' && p === '/api/v2/media') {
      const id = String(nextId++);
      media.set(id, { id, looks: 0, type: 'image' });
      return json({ id, type: 'image', url: null }, 202);
    }
    m = p.match(/^\/api\/v1\/media\/(\w+)$/);
    if (m && media.has(m[1])) {
      const md = media.get(m[1])!;
      md.looks++;
      return md.looks >= 1 ? json({ id: md.id, type: 'image', url: `${base}/media/${md.id}.png` }) : json({ id: md.id, url: null }, 206);
    }
    return err(404, 'Not found');
  }

  const fake: FakeMastodon = {
    url: base,
    host,
    calls,
    accounts,
    statuses,
    notifications,
    tokens,
    favourites,
    reblogs,
    addAccount(a, remote) {
      const acct = remote ? `${a.username}@${remote}` : a.username;
      const full: FakeAccount = {
        acct,
        display_name: '',
        avatar: `https://files.example/avatars/${a.id}.png`,
        header: 'https://files.example/headers/missing.png',
        note: '',
        url: `${remote ? `https://${remote}` : base}/@${a.username}`,
        bot: false,
        created_at: '2024-01-02T00:00:00.000Z',
        followers_count: 3,
        following_count: 4,
        statuses_count: 5,
        fields: [],
        ...a,
      };
      accounts.set(a.id, full);
      return full;
    },
    addStatus(s) {
      const full: FakeStatus = { created_at: new Date((clock += 60_000)).toISOString(), ...s };
      statuses.set(s.id, full);
      return full;
    },
    notify(n) {
      notifications.push({ created_at: new Date().toISOString(), ...n });
    },
    approve(account) {
      const code = `code-${nextId++}`;
      if (!lastApp) throw new Error('no app registered yet');
      codes.set(code, account);
      return code;
    },
    limitNext(n) {
      limited = n;
    },
    stop: () => server.stop(true),
  };
  return fake;
}
