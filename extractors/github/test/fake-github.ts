/**
 * A fake of the parts of GitHub's REST API the github extractor calls, behaving as GitHub documents them:
 *
 * - tokens as `Authorization: Bearer|token <t>`; a missing or unknown one is 401 "Bad credentials". Classic tokens report
 *   their scopes in X-OAuth-Scopes; fine-grained ones (scopes null) report none and are refused the notifications API
 *   (403 "Resource not accessible by personal access token"); a classic token without notifications or repo is 403
 * - GET /user
 * - GET /notifications (all, participating, since, before, per_page up to 50, page), newest first, with Link
 *   (next/prev/first/last), Last-Modified, X-Poll-Interval, and 304 for an If-Modified-Since at or after Last-Modified
 * - PATCH /notifications/threads/:id (205), DELETE (204, done), PUT /notifications (205, or 202 for many),
 *   GET/PUT /notifications/threads/:id/subscription
 * - issues, pulls, releases and comments under /repos/:owner/:repo, with ETags (If-None-Match → 304), and 404 for a
 *   private repository's without the repo scope
 * - the core rate limit on every answer (X-RateLimit-Limit/Remaining/Reset/Used/Resource); a 304 costs nothing; when
 *   none remain, 403 "API rate limit exceeded" with remaining 0 until the reset; secondary limits on demand (403 or 429,
 *   with or without Retry-After)
 *
 * Last-Modified is the newest thread update: marking threads read does not move it (the cautious reading of GitHub's
 * docs, so reads elsewhere are only seen by reading the list), unless `lastModifiedOnRead`.
 *
 * Helpers stand in for GitHub's other clients: threads arriving, comments, state changes, reading and marking unread on
 * the web; and for GitHub itself: revoking a token, changing its scopes, exhausting the limit, failing the next calls.
 * Under `prefix` (default /api/v3, as GitHub Enterprise Server), so the extractor is tested with an API URL that has a
 * path.
 */

export interface FakeToken {
  login: string;
  /** null: a fine-grained token (no X-OAuth-Scopes). */
  scopes: string[] | null;
}

interface FakeThread {
  id: string;
  repo: string;
  type: string;
  title: string;
  reason: string;
  updatedAt: number;
  lastReadAt: number | null;
  unread: boolean;
  done: boolean;
  /** API paths (under the prefix), or null. */
  subject: string | null;
  latestComment: string | null;
  ignored: boolean | null;
}

export interface AddThread {
  repo?: string;
  private?: boolean;
  type?: 'Issue' | 'PullRequest' | 'Release' | 'Commit' | 'Discussion' | 'CheckSuite' | 'RepositoryInvitation';
  title?: string;
  reason?: string;
  number?: number;
  author?: string;
  body?: string;
  state?: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  /** A comment as the latest activity. */
  comment?: { author: string; body: string };
  unread?: boolean;
}

export interface Call {
  method: string;
  path: string;
  query: string;
  status: number;
  at: number;
  ims: string | null;
  inm: string | null;
  body: unknown;
  /** It counted against the rate limit. */
  spent: boolean;
  /** The token it came with (these are the fake's own). */
  token: string | null;
}

type Failure = { status: number; retryAfter?: number; message?: string; count: number; match?: RegExp; remainingZero?: boolean };

export function startFakeGitHub(opts: { port?: number; prefix?: string; pollInterval?: number; lastModifiedOnRead?: boolean; accepted202Over?: number } = {}) {
  const prefix = (opts.prefix ?? '/api/v3').replace(/\/+$/, '');
  let pollInterval = opts.pollInterval ?? 60;
  const tokens = new Map<string, FakeToken>();
  const users = new Map<string, { id: number; login: string; name: string | null }>();
  const repos = new Map<string, { id: number; private: boolean }>();
  const threads = new Map<string, FakeThread>();
  const objects = new Map<string, { body: any; v: number }>();
  const calls: Call[] = [];
  const failures: Failure[] = [];
  const rate = { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600, used: 0 };
  let seq = 1;
  let last = 0;
  let changedAt = 0;
  let origin = '';

  /** GitHub's time is in whole seconds, and here every change is at a later one than the last. */
  const tick = () => {
    let t = Math.floor(Date.now() / 1000) * 1000;
    if (t <= last) t = last + 1000;
    last = t;
    return t;
  };
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const userJson = (login: string) => {
    const u = users.get(login) ?? { id: 0, login, name: null };
    return { login: u.login, id: u.id, node_id: `U_${u.id}`, avatar_url: `https://avatars.example/u/${u.id}`, html_url: `${origin}/${u.login}`, type: 'User', site_admin: false, name: u.name };
  };
  const user = (login: string, name: string | null = null) => {
    if (!users.has(login)) users.set(login, { id: 1000 + users.size, login, name });
    return users.get(login)!;
  };
  const api = (path: string | null) => (path ? `${origin}${prefix}${path}` : null);
  const lastModified = () => {
    let m = 0;
    for (const t of threads.values()) if (t.updatedAt > m) m = t.updatedAt;
    return Math.max(m, opts.lastModifiedOnRead ? changedAt : 0);
  };

  const threadJson = (t: FakeThread) => {
    const [owner, name] = t.repo.split('/');
    const r = repos.get(t.repo)!;
    return {
      id: t.id,
      unread: t.unread,
      reason: t.reason,
      updated_at: iso(t.updatedAt),
      last_read_at: t.lastReadAt ? iso(t.lastReadAt) : null,
      subject: { title: t.title, url: api(t.subject), latest_comment_url: api(t.latestComment), type: t.type },
      repository: { id: r.id, node_id: `R_${r.id}`, name, full_name: t.repo, private: r.private, owner: userJson(owner), html_url: `${origin}/${t.repo}`, url: api(`/repos/${t.repo}`), fork: false },
      url: api(`/notifications/threads/${t.id}`),
      subscription_url: api(`/notifications/threads/${t.id}/subscription`),
    };
  };

  function repo(full: string, priv = false) {
    if (!repos.has(full)) repos.set(full, { id: 500 + repos.size, private: priv });
    user(full.split('/')[0]);
    return repos.get(full)!;
  }

  function addThread(a: AddThread = {}): string {
    const full = a.repo ?? 'octo/hello';
    repo(full, a.private);
    const type = a.type ?? 'Issue';
    const id = String(seq++);
    const n = a.number ?? Number(id);
    const author = a.author ?? 'mona';
    user(author);
    const at = tick();
    let subject: string | null = null;
    if (type === 'Issue' || type === 'PullRequest') {
      subject = `/repos/${full}/${type === 'Issue' ? 'issues' : 'pulls'}/${n}`;
      const htmlPath = `${origin}/${full}/${type === 'Issue' ? 'issues' : 'pull'}/${n}`;
      objects.set(subject, {
        v: 1,
        body: {
          number: n,
          title: a.title ?? `Thing ${n}`,
          state: a.merged ? 'closed' : (a.state ?? 'open'),
          html_url: htmlPath,
          user: userJson(author),
          body: a.body ?? `The description of ${n}`,
          ...(type === 'PullRequest' ? { draft: !!a.draft, merged: !!a.merged, merged_at: a.merged ? iso(at) : null, merged_by: a.merged ? userJson(author) : null } : { state_reason: null, closed_by: null }),
        },
      });
    } else if (type === 'Release') {
      subject = `/repos/${full}/releases/${9000 + n}`;
      objects.set(subject, { v: 1, body: { id: 9000 + n, tag_name: `v${n}.0`, name: a.title ?? `v${n}.0`, html_url: `${origin}/${full}/releases/tag/v${n}.0`, draft: false, prerelease: false, author: userJson(author), body: a.body ?? 'Release notes' } });
    } else if (type === 'Commit') {
      subject = `/repos/${full}/commits/${'c0ffee'.padEnd(40, String(n % 10))}`;
    }
    const t: FakeThread = { id, repo: full, type, title: a.title ?? `Thing ${n}`, reason: a.reason ?? 'subscribed', updatedAt: at, lastReadAt: null, unread: a.unread ?? true, done: false, subject, latestComment: subject, ignored: null };
    threads.set(id, t);
    if (a.comment) comment(id, a.comment);
    return id;
  }

  /** Someone comments: the thread is updated and unread again. */
  function comment(id: string, c: { author: string; body: string }) {
    const t = threads.get(id)!;
    user(c.author);
    const cid = 7000 + seq++;
    const path = t.type === 'PullRequest' && c.body.startsWith('review:') ? `/repos/${t.repo}/pulls/comments/${cid}` : t.type === 'Issue' || t.type === 'PullRequest' ? `/repos/${t.repo}/issues/comments/${cid}` : `/repos/${t.repo}/comments/${cid}`;
    const page = objects.get(t.subject ?? '')?.body?.html_url ?? `${origin}/${t.repo}`;
    const anchor = path.includes('/pulls/comments/') ? `#discussion_r${cid}` : path.includes('/issues/comments/') ? `#issuecomment-${cid}` : `#commitcomment-${cid}`;
    objects.set(path, { v: 1, body: { id: cid, html_url: page + anchor, user: userJson(c.author), body: c.body } });
    t.latestComment = path;
    t.updatedAt = tick();
    t.unread = true;
    t.done = false;
    t.reason = t.reason === 'subscribed' ? 'comment' : t.reason;
    return cid;
  }

  /** It is closed or merged by someone: a state_change, unread again. */
  function changeState(id: string, state: 'closed' | 'open' | 'merged', by = 'hubot') {
    const t = threads.get(id)!;
    const o = objects.get(t.subject!)!;
    user(by);
    o.body = { ...o.body, state: state === 'merged' ? 'closed' : state, ...(state === 'merged' ? { merged: true, merged_at: iso(Date.now()), merged_by: userJson(by) } : { closed_by: state === 'closed' ? userJson(by) : null }) };
    o.v++;
    t.latestComment = t.subject;
    t.updatedAt = tick();
    t.unread = true;
    t.done = false;
    t.reason = 'state_change';
  }

  function readOnWeb(id: string) {
    const t = threads.get(id)!;
    t.unread = false;
    t.lastReadAt = Date.now();
    changedAt = tick();
  }
  /** "Mark as unread" on the web: unread again, without an update. */
  function unreadOnWeb(id: string) {
    threads.get(id)!.unread = true;
    changedAt = tick();
  }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
  const etagOf = (path: string, v: number) => `W/"${Bun.hash(`${path}#${v}`).toString(16)}"`;

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.json().catch(() => undefined);
      const call: Call = { method: req.method, path: u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname, query: u.search, status: 0, at: Date.now(), ims: req.headers.get('if-modified-since'), inm: req.headers.get('if-none-match'), body, spent: false, token: req.headers.get('authorization')?.match(/^(?:token|bearer)\s+(\S+)$/i)?.[1] ?? null };
      calls.push(call);
      const res = await handle(req, u, call, body);
      call.status = res.status;
      return res;
    },
  });
  origin = `http://127.0.0.1:${server.port}`;

  async function handle(req: Request, u: URL, call: Call, body: any): Promise<Response> {
    if (!u.pathname.startsWith(prefix + '/')) return json({ message: 'Not Found' }, 404);
    const path = call.path;
    const auth = req.headers.get('authorization')?.match(/^(?:token|bearer)\s+(\S+)$/i)?.[1];
    if (!auth) return json({ message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' }, 401);
    const tok = tokens.get(auth);
    if (!tok) return json({ message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' }, 401);

    const now = Date.now();
    if (now >= rate.reset * 1000) {
      rate.remaining = rate.limit;
      rate.used = 0;
      rate.reset = Math.floor(now / 1000) + 3600;
    }
    const headers = (accepted = '') => ({
      'x-ratelimit-limit': String(rate.limit),
      'x-ratelimit-remaining': String(rate.remaining),
      'x-ratelimit-reset': String(rate.reset),
      'x-ratelimit-used': String(rate.used),
      'x-ratelimit-resource': 'core',
      'x-github-api-version-selected': '2022-11-28',
      ...(tok.scopes !== null ? { 'x-oauth-scopes': tok.scopes.join(', '), 'x-accepted-oauth-scopes': accepted } : {}),
    });
    const spend = () => {
      rate.remaining = Math.max(0, rate.remaining - 1);
      rate.used++;
      call.spent = true;
    };

    const f = failures.find((x) => !x.match || x.match.test(`${req.method} ${path}`));
    if (f) {
      if (--f.count <= 0) failures.splice(failures.indexOf(f), 1);
      if (f.status === 403 || f.status === 429) {
        const h: Record<string, string> = { ...headers(), ...(f.retryAfter !== undefined ? { 'retry-after': String(f.retryAfter) } : {}) };
        if (f.remainingZero) h['x-ratelimit-remaining'] = '0';
        return json({ message: f.message ?? 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.', documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits' }, f.status, h);
      }
      spend();
      return json({ message: f.message ?? 'Server Error' }, f.status, headers());
    }
    if (rate.remaining <= 0) return json({ message: `API rate limit exceeded for user ID ${users.get(tok.login)?.id ?? 1}.`, documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api' }, 403, headers());

    const can = (s: string) => tok.scopes === null || tok.scopes.includes(s);
    const notifScopes = 'notifications, repo';
    const mayNotify = () => {
      if (tok.scopes === null) return json({ message: 'Resource not accessible by personal access token', documentation_url: 'https://docs.github.com/rest/activity/notifications' }, 403, headers(notifScopes));
      if (!tok.scopes.includes('notifications') && !tok.scopes.includes('repo')) return json({ message: "Missing the 'notifications' scope.", documentation_url: 'https://docs.github.com/rest/activity/notifications' }, 403, headers(notifScopes));
      return null;
    };
    let m: RegExpMatchArray | null;

    if (path === '/user' && req.method === 'GET') {
      spend();
      return json(userJson(tok.login), 200, headers());
    }

    if (path === '/notifications' && req.method === 'GET') {
      const no = mayNotify();
      if (no) return (spend(), no);
      const lm = lastModified();
      const lmHeader = new Date(lm).toUTCString();
      const ims = call.ims ? Date.parse(call.ims) : NaN;
      const common = { 'last-modified': lmHeader, 'x-poll-interval': String(pollInterval) };
      if (!Number.isNaN(ims) && Math.floor(lm / 1000) <= Math.floor(ims / 1000)) return new Response(null, { status: 304, headers: { ...headers(notifScopes), ...common } });
      spend();
      const q = u.searchParams;
      const all = q.get('all') === 'true';
      const participating = q.get('participating') === 'true';
      const since = q.get('since') ? Date.parse(q.get('since')!) : null;
      const before = q.get('before') ? Date.parse(q.get('before')!) : null;
      const perPage = Math.min(50, Math.max(1, Number(q.get('per_page')) || 50));
      const page = Math.max(1, Number(q.get('page')) || 1);
      const list = [...threads.values()]
        .filter((t) => !t.done && (all || t.unread))
        .filter((t) => !participating || ['mention', 'assign', 'review_requested', 'author', 'comment', 'team_mention'].includes(t.reason))
        .filter((t) => (since === null || t.updatedAt > since) && (before === null || t.updatedAt < before))
        .sort((a, b) => b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id));
      const pages = Math.max(1, Math.ceil(list.length / perPage));
      const linkTo = (p: number) => {
        const n = new URL(u.toString().replace(/^http:\/\/[^/]+/, origin));
        n.searchParams.set('page', String(p));
        return n.toString();
      };
      const rels: string[] = [];
      if (page < pages) rels.push(`<${linkTo(page + 1)}>; rel="next"`, `<${linkTo(pages)}>; rel="last"`);
      if (page > 1) rels.push(`<${linkTo(1)}>; rel="first"`, `<${linkTo(page - 1)}>; rel="prev"`);
      return json(list.slice((page - 1) * perPage, page * perPage).map(threadJson), 200, { ...headers(notifScopes), ...common, ...(rels.length ? { link: rels.join(', ') } : {}) });
    }

    if (path === '/notifications' && req.method === 'PUT') {
      const no = mayNotify();
      spend();
      if (no) return no;
      const until = typeof body?.last_read_at === 'string' ? Date.parse(body.last_read_at) : Infinity;
      const hit = [...threads.values()].filter((t) => t.unread && t.updatedAt <= until);
      for (const t of hit) {
        t.unread = false;
        t.lastReadAt = Date.now();
      }
      changedAt = tick();
      if (hit.length > (opts.accepted202Over ?? 10)) return json({ message: "Unread notifications couldn't be marked in a single request. Notifications are being marked as read in the background." }, 202, headers(notifScopes));
      return new Response(null, { status: 205, headers: headers(notifScopes) });
    }

    if ((m = path.match(/^\/notifications\/threads\/(\d+)(\/subscription)?$/))) {
      const no = mayNotify();
      spend();
      if (no) return no;
      const t = threads.get(m[1]);
      if (!t) return json({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }, 404, headers(notifScopes));
      if (m[2]) {
        if (req.method === 'PUT') t.ignored = !!body?.ignored;
        if (req.method === 'DELETE') t.ignored = null;
        if (req.method === 'GET' && t.ignored === null) return json({ message: 'Not Found' }, 404, headers(notifScopes));
        return json({ subscribed: t.ignored === false, ignored: !!t.ignored, reason: null, created_at: iso(Date.now()), url: api(`/notifications/threads/${t.id}/subscription`), thread_url: api(`/notifications/threads/${t.id}`) }, 200, headers(notifScopes));
      }
      if (req.method === 'GET') return json(threadJson(t), 200, headers(notifScopes));
      if (req.method === 'PATCH') {
        t.unread = false;
        t.lastReadAt = Date.now();
        changedAt = tick();
        return new Response(null, { status: 205, headers: headers(notifScopes) });
      }
      if (req.method === 'DELETE') {
        t.done = true;
        t.unread = false;
        changedAt = tick();
        return new Response(null, { status: 204, headers: headers(notifScopes) });
      }
      return json({ message: 'Not Found' }, 404, headers());
    }

    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/(issues|pulls|releases|issues\/comments|pulls\/comments|comments)\/(\d+)$/)) && req.method === 'GET') {
      const o = objects.get(path);
      const r = repos.get(m[1]);
      if (!o || !r || (r.private && !can('repo'))) return (spend(), json({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }, 404, headers('repo')));
      const etag = etagOf(path, o.v);
      if (call.inm === etag) return new Response(null, { status: 304, headers: { ...headers('repo'), etag } });
      spend();
      return json(o.body, 200, { ...headers('repo'), etag });
    }
    spend();
    return json({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }, 404, headers());
  }

  return {
    /** The API base URL (what the add form's API URL field takes). */
    get url() {
      return origin + prefix;
    },
    origin,
    server,
    calls,
    rate,
    threads,
    objects,
    addToken(token: string, t: { login?: string; name?: string | null; scopes?: string[] | null } = {}) {
      const login = t.login ?? 'octocat';
      user(login, t.name ?? 'The Octocat');
      tokens.set(token, { login, scopes: t.scopes === undefined ? ['notifications', 'repo', 'read:user'] : t.scopes });
    },
    revoke: (token: string) => void tokens.delete(token),
    setScopes(token: string, scopes: string[] | null) {
      tokens.get(token)!.scopes = scopes;
    },
    setPollInterval: (s: number) => void (pollInterval = s),
    addThread,
    comment,
    changeState,
    readOnWeb,
    unreadOnWeb,
    thread: (id: string) => threads.get(id),
    /** No requests remain until `resetInS` from now. */
    exhaust(resetInS: number) {
      rate.remaining = 0;
      rate.reset = Math.floor(Date.now() / 1000) + resetInS;
    },
    /** The next `count` matching requests fail: a 5xx, or a secondary rate limit (403/429, Retry-After if given). */
    failNext(f: { status: number; retryAfter?: number; message?: string; count?: number; match?: RegExp; remainingZero?: boolean }) {
      failures.push({ ...f, count: f.count ?? 1 });
    },
    /** Calls to a path (under the prefix), optionally by method. */
    callsTo: (re: RegExp, method?: string) => calls.filter((c) => re.test(c.path) && (!method || c.method === method)),
    stop: () => server.stop(true),
  };
}

export type FakeGitHub = ReturnType<typeof startFakeGitHub>;
