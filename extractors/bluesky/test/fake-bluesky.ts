/**
 * A fake of the parts of the AT Protocol the bluesky extractor calls, shaped as the app.bsky and com.atproto lexicons
 * describe them, with invented DIDs, handles (`*.example`) and posts only. One server plays all three roles:
 *
 * - the entryway: com.atproto.identity.resolveHandle (anonymous)
 * - the PLC directory: GET /did:plc:… → a DID document naming this server as the PDS
 * - the PDS and its app view: com.atproto.server.createSession (an emailed code when `needCode` is set:
 *   401 AuthFactorTokenRequired), refreshSession, getSession; app.bsky.actor.getProfile; app.bsky.feed.getTimeline,
 *   getFeed, getPosts, getPostThread, getLikes, getRepostedBy, getAuthorFeed; app.bsky.notification.listNotifications;
 *   com.atproto.repo.createRecord, deleteRecord, uploadBlob
 * - an expired access token answers 400 ExpiredToken; a bad one 401 InvalidToken
 * - RateLimit-Remaining and RateLimit-Reset (epoch seconds) on every answer; `limitNext(n)` answers 429 n times
 */

export interface FakeProfile {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  followersCount: number;
  followsCount: number;
  postsCount: number;
  createdAt: string;
  /** What the account signed in thinks of them. */
  following?: boolean;
  followedBy?: boolean;
}

export interface FakeRecord {
  uri: string;
  cid: string;
  did: string;
  collection: string;
  rkey: string;
  value: any;
  indexedAt: string;
}

export interface FakeNotification {
  uri: string;
  author: string;
  reason: string;
  reasonSubject?: string;
  indexedAt: string;
}

export interface FakeBluesky {
  url: string;
  host: string;
  calls: { method: string; nsid: string; params: URLSearchParams; auth: string | null; body: any }[];
  profiles: Map<string, FakeProfile>;
  records: Map<string, FakeRecord>;
  notifications: FakeNotification[];
  /** Access and refresh tokens that work. */
  access: Set<string>;
  refresh: Set<string>;
  /** createSession wants an emailed code (this one). */
  needCode: string | null;
  addProfile(p: Partial<FakeProfile> & { did: string; handle: string }): FakeProfile;
  /** A post by `did`; returns its at:// URI. */
  addPost(did: string, rkey: string, value: Record<string, unknown>, minutesAgo?: number): string;
  addRecord(did: string, collection: string, rkey: string, value: Record<string, unknown>, minutesAgo?: number): string;
  notify(n: Omit<FakeNotification, 'indexedAt'> & { minutesAgo?: number }): void;
  /** Every access token now answers ExpiredToken. */
  expireAccess(): void;
  limitNext(n: number): void;
  stop(): void;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function startFakeBluesky(opts: { self: string; password: string; email?: string }): FakeBluesky {
  const profiles = new Map<string, FakeProfile>();
  const records = new Map<string, FakeRecord>();
  const notifications: FakeNotification[] = [];
  const access = new Set<string>();
  const refresh = new Set<string>();
  const expired = new Set<string>();
  const calls: FakeBluesky['calls'] = [];
  let limited = 0;
  let seq = 0;
  let cidSeq = 0;
  const self = opts.self;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const u = new URL(req.url);
      const auth = req.headers.get('authorization');
      if (u.pathname.startsWith('/did:plc:')) return didDoc(decodeURIComponent(u.pathname.slice(1)));
      if (!u.pathname.startsWith('/xrpc/')) return new Response('not found', { status: 404 });
      const nsid = u.pathname.slice(6);
      let body: any = null;
      if (req.method === 'POST') {
        const ct = req.headers.get('content-type') ?? '';
        body = ct.includes('json') ? await req.json().catch(() => null) : { bytes: (await req.arrayBuffer()).byteLength, type: ct };
      }
      calls.push({ method: req.method, nsid, params: u.searchParams, auth, body });
      if (limited > 0) {
        limited--;
        return json({ error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' }, 429, { 'ratelimit-remaining': '0', 'ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 1) });
      }
      return route(req.method, nsid, u.searchParams, auth, body);
    },
  });
  const host: string = `127.0.0.1:${server.port}`;
  const base: string = `http://${host}`;

  const rate = (r: Response) => {
    if (!r.headers.has('ratelimit-remaining')) {
      r.headers.set('ratelimit-limit', '3000');
      r.headers.set('ratelimit-remaining', '2900');
      r.headers.set('ratelimit-reset', String(Math.ceil(Date.now() / 1000) + 300));
    }
    return r;
  };
  const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => rate(new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } }));
  const err = (status: number, error: string, message = error) => json({ error, message }, status);

  function didDoc(did: string): Response {
    if (!profiles.has(did)) return new Response('DID not registered', { status: 404 });
    return json({ id: did, alsoKnownAs: [`at://${profiles.get(did)!.handle}`], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: base }] });
  }

  const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const tid = () => {
    let n = Date.now() * 1000 + seq++;
    let s = '';
    for (let i = 0; i < 13; i++) {
      s = B32[n % 32] + s;
      n = Math.floor(n / 32);
    }
    return s;
  };
  const newCid = () => `bafyfake${(cidSeq++).toString().padStart(6, '0')}`;

  const basic = (did: string) => {
    const p = profiles.get(did);
    if (!p) return { did, handle: 'handle.invalid' };
    return { did, handle: p.handle, ...(p.displayName ? { displayName: p.displayName } : {}), ...(p.avatar ? { avatar: p.avatar } : {}), viewer: { ...(p.following ? { following: `at://${self}/app.bsky.graph.follow/f${did.slice(-4)}` } : {}), ...(p.followedBy ? { followedBy: `at://${did}/app.bsky.graph.follow/f1` } : {}) }, labels: [] };
  };
  const detailed = (did: string) => {
    const p = profiles.get(did)!;
    return { ...basic(did), description: p.description, followersCount: p.followersCount, followsCount: p.followsCount, postsCount: p.postsCount, createdAt: p.createdAt, indexedAt: p.createdAt };
  };

  const of = (collection: string) => [...records.values()].filter((r) => r.collection === collection);
  const imagesView = (did: string, e: any) => ({
    $type: 'app.bsky.embed.images#view',
    images: (e.images ?? []).map((i: any) => ({ thumb: `https://cdn.example/thumb/${did}/${i.image?.ref?.$link}`, fullsize: `https://cdn.example/full/${did}/${i.image?.ref?.$link}`, alt: i.alt ?? '', ...(i.aspectRatio ? { aspectRatio: i.aspectRatio } : {}) })),
  });
  const viewRecord = (uri: string) => {
    const r = records.get(uri);
    if (!r) return { $type: 'app.bsky.embed.record#viewNotFound', uri, notFound: true };
    return { $type: 'app.bsky.embed.record#viewRecord', uri, cid: r.cid, author: basic(r.did), value: r.value, indexedAt: r.indexedAt, embeds: r.value.embed ? [embedView(r.did, r.value.embed, 1)] : [], likeCount: count('app.bsky.feed.like', uri) };
  };
  function embedView(did: string, e: any, depth = 0): any {
    const t = String(e?.$type ?? '');
    if (t === 'app.bsky.embed.images') return imagesView(did, e);
    if (t === 'app.bsky.embed.external') return { $type: 'app.bsky.embed.external#view', external: { ...e.external } };
    if (t === 'app.bsky.embed.record') return { $type: 'app.bsky.embed.record#view', record: depth < 1 ? viewRecord(e.record.uri) : { $type: 'app.bsky.embed.record#viewNotFound', uri: e.record.uri } };
    if (t === 'app.bsky.embed.recordWithMedia') return { $type: 'app.bsky.embed.recordWithMedia#view', record: { record: viewRecord(e.record.record.uri) }, media: embedView(did, e.media, depth) };
    return undefined;
  }
  const count = (collection: string, uri: string) => of(collection).filter((r) => r.value?.subject?.uri === uri).length;
  const mine = (collection: string, uri: string) => of(collection).find((r) => r.did === self && r.value?.subject?.uri === uri)?.uri;
  function postView(uri: string): any {
    const r = records.get(uri)!;
    const gate = records.get(`at://${r.did}/app.bsky.feed.threadgate/${r.rkey}`);
    const embed = r.value.embed ? embedView(r.did, r.value.embed) : undefined;
    return {
      uri,
      cid: r.cid,
      author: basic(r.did),
      record: r.value,
      ...(embed ? { embed } : {}),
      replyCount: of('app.bsky.feed.post').filter((p) => p.value?.reply?.parent?.uri === uri).length,
      repostCount: count('app.bsky.feed.repost', uri),
      likeCount: count('app.bsky.feed.like', uri),
      quoteCount: of('app.bsky.feed.post').filter((p) => p.value?.embed?.record?.uri === uri || p.value?.embed?.record?.record?.uri === uri).length,
      indexedAt: r.indexedAt,
      viewer: { ...(mine('app.bsky.feed.like', uri) ? { like: mine('app.bsky.feed.like', uri) } : {}), ...(mine('app.bsky.feed.repost', uri) ? { repost: mine('app.bsky.feed.repost', uri) } : {}) },
      labels: [],
      ...(gate ? { threadgate: { uri: gate.uri, cid: gate.cid, record: gate.value } } : {}),
    };
  }
  const byNewest = (a: { indexedAt: string }, b: { indexedAt: string }) => (a.indexedAt < b.indexedAt ? 1 : a.indexedAt > b.indexedAt ? -1 : 0);
  /** A list paged by offset: `cursor` is the index to start from. */
  const page = <T>(list: T[], params: URLSearchParams) => {
    const limit = Number(params.get('limit') ?? 50);
    const at = Number(params.get('cursor') ?? 0);
    const items = list.slice(at, at + limit);
    return { items, cursor: at + limit < list.length ? String(at + limit) : undefined };
  };
  const feedItem = (r: FakeRecord) => {
    if (r.collection === 'app.bsky.feed.repost') return { post: postView(r.value.subject.uri), reason: { $type: 'app.bsky.feed.defs#reasonRepost', by: basic(r.did), uri: r.uri, cid: r.cid, indexedAt: r.indexedAt } };
    const parent = r.value.reply?.parent?.uri ? records.get(r.value.reply.parent.uri) : null;
    return { post: postView(r.uri), ...(parent ? { reply: { root: postView(r.value.reply.root.uri), parent: postView(parent.uri) } } : {}) };
  };
  function threadNode(uri: string, depth: number): any {
    const kids = of('app.bsky.feed.post').filter((p) => p.value?.reply?.parent?.uri === uri).sort((a, b) => -byNewest(a, b));
    return { $type: 'app.bsky.feed.defs#threadViewPost', post: postView(uri), ...(depth > 0 ? { replies: kids.map((k) => threadNode(k.uri, depth - 1)) } : {}) };
  }

  let tokenSeq = 0;
  function makeSession() {
    const a = `access-${++tokenSeq}-${crypto.randomUUID()}`;
    const r = `refresh-${tokenSeq}-${crypto.randomUUID()}`;
    access.add(a);
    refresh.add(r);
    const p = profiles.get(self)!;
    return { did: self, handle: p.handle, accessJwt: a, refreshJwt: r, email: opts.email, active: true, didDoc: { id: self, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: base }] } };
  }

  function route(method: string, nsid: string, params: URLSearchParams, auth: string | null, body: any): Response {
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const authed = () => {
      if (!bearer) return err(401, 'AuthenticationRequired', 'Authentication Required');
      if (expired.has(bearer)) return err(400, 'ExpiredToken', 'Token has expired');
      if (!access.has(bearer)) return err(401, 'InvalidToken', 'Token could not be verified');
      return null;
    };
    switch (nsid) {
      case 'com.atproto.identity.resolveHandle': {
        const p = [...profiles.values()].find((x) => x.handle === params.get('handle'));
        return p ? json({ did: p.did }) : err(400, 'InvalidRequest', 'Unable to resolve handle');
      }
      case 'com.atproto.server.createSession': {
        const id = String(body?.identifier ?? '');
        const p = profiles.get(self)!;
        if ((id !== p.handle && id !== opts.email && id !== self) || body?.password !== opts.password) return err(401, 'AuthenticationRequired', 'Invalid identifier or password');
        if (fake.needCode && body?.authFactorToken !== fake.needCode) return err(401, 'AuthFactorTokenRequired', 'A sign in code has been sent to your email address');
        return json(makeSession());
      }
      case 'com.atproto.server.refreshSession': {
        if (!bearer || !refresh.has(bearer)) return err(400, 'ExpiredToken', 'Token has expired');
        refresh.delete(bearer);
        return json(makeSession());
      }
    }
    const no = authed();
    if (no) return no;
    switch (nsid) {
      case 'com.atproto.server.getSession':
        return json({ did: self, handle: profiles.get(self)!.handle, active: true });
      case 'app.bsky.actor.getProfile': {
        const a = params.get('actor')!;
        const p = profiles.get(a) ?? [...profiles.values()].find((x) => x.handle === a);
        return p ? json(detailed(p.did)) : err(400, 'InvalidRequest', 'Profile not found');
      }
      case 'app.bsky.feed.getTimeline': {
        const list = [...of('app.bsky.feed.post').filter((r) => r.did !== self || !r.value.reply), ...of('app.bsky.feed.repost').filter((r) => r.did !== self)].sort(byNewest);
        const { items, cursor } = page(list, params);
        return json({ feed: items.map(feedItem), ...(cursor ? { cursor } : {}) });
      }
      case 'app.bsky.feed.getFeed': {
        if (!params.get('feed')?.endsWith('/app.bsky.feed.generator/whats-hot')) return err(400, 'UnknownFeed', 'Unknown feed');
        const list = of('app.bsky.feed.post')
          .filter((r) => !r.value.reply)
          .sort((a, b) => count('app.bsky.feed.like', b.uri) - count('app.bsky.feed.like', a.uri) || byNewest(a, b));
        const { items, cursor } = page(list, params);
        return json({ feed: items.map((r) => ({ post: postView(r.uri) })), ...(cursor ? { cursor } : {}) });
      }
      case 'app.bsky.feed.getPosts':
        return json({ posts: params.getAll('uris').filter((u) => records.has(u)).map(postView) });
      case 'app.bsky.feed.getPostThread': {
        const uri = params.get('uri')!;
        if (!records.has(uri)) return err(400, 'NotFound', `Post not found: ${uri}`);
        const node = threadNode(uri, Number(params.get('depth') ?? 6));
        let at = node;
        for (let r = records.get(uri)!; r.value.reply?.parent?.uri && records.has(r.value.reply.parent.uri); r = records.get(r.value.reply.parent.uri)!) {
          at.parent = { $type: 'app.bsky.feed.defs#threadViewPost', post: postView(r.value.reply.parent.uri) };
          at = at.parent;
        }
        return json({ thread: node });
      }
      case 'app.bsky.feed.getLikes':
      case 'app.bsky.feed.getRepostedBy': {
        const like = nsid.endsWith('getLikes');
        const list = of(like ? 'app.bsky.feed.like' : 'app.bsky.feed.repost')
          .filter((r) => r.value.subject?.uri === params.get('uri'))
          .sort(byNewest);
        const { items, cursor } = page(list, params);
        return json(like ? { uri: params.get('uri'), likes: items.map((r) => ({ actor: basic(r.did), createdAt: r.indexedAt, indexedAt: r.indexedAt })), ...(cursor ? { cursor } : {}) } : { uri: params.get('uri'), repostedBy: items.map((r) => basic(r.did)), ...(cursor ? { cursor } : {}) });
      }
      case 'app.bsky.feed.getAuthorFeed': {
        const did = params.get('actor')!;
        const list = [...of('app.bsky.feed.post').filter((r) => r.did === did), ...of('app.bsky.feed.repost').filter((r) => r.did === did)].sort(byNewest);
        const { items, cursor } = page(list, params);
        return json({ feed: items.map(feedItem), ...(cursor ? { cursor } : {}) });
      }
      case 'app.bsky.notification.listNotifications': {
        const list = [...notifications].sort(byNewest);
        const { items, cursor } = page(list, params);
        return json({
          notifications: items.map((n) => ({ uri: n.uri, cid: records.get(n.uri)?.cid ?? 'bafyother', author: basic(n.author), reason: n.reason, ...(n.reasonSubject ? { reasonSubject: n.reasonSubject } : {}), record: records.get(n.uri)?.value ?? { $type: 'app.bsky.graph.follow', subject: self, createdAt: n.indexedAt }, isRead: false, indexedAt: n.indexedAt, labels: [] })),
          ...(cursor ? { cursor } : {}),
        });
      }
      case 'com.atproto.repo.createRecord': {
        if (body?.repo !== self) return err(401, 'InvalidRequest', 'repo must be the signed-in account');
        const v = body.record ?? {};
        if (v.$type !== body.collection) return err(400, 'InvalidRequest', 'Invalid $type');
        if (body.collection === 'app.bsky.feed.post' && [...new Intl.Segmenter().segment(String(v.text ?? ''))].length > 300) return err(400, 'InvalidRequest', 'Record/text must not be longer than 300 graphemes');
        const uri = addRecord(self, body.collection, body.rkey ?? tid(), v, 0);
        return json({ uri, cid: records.get(uri)!.cid, commit: { cid: 'bafycommit', rev: 'rev' } });
      }
      case 'com.atproto.repo.deleteRecord': {
        if (body?.repo !== self) return err(401, 'InvalidRequest', 'repo must be the signed-in account');
        records.delete(`at://${self}/${body.collection}/${body.rkey}`);
        return json({ commit: { cid: 'bafycommit', rev: 'rev' } });
      }
      case 'com.atproto.repo.uploadBlob':
        return json({ blob: { $type: 'blob', ref: { $link: `bafyblob${body.bytes}` }, mimeType: body.type, size: body.bytes } });
    }
    return err(501, 'MethodNotImplemented', `Method Not Implemented: ${nsid}`);
  }

  function addRecord(did: string, collection: string, rkey: string, value: Record<string, unknown>, minutesAgo = 0) {
    const uri = `at://${did}/${collection}/${rkey}`;
    const indexedAt = iso(minutesAgo);
    records.set(uri, { uri, cid: newCid(), did, collection, rkey, value: { $type: collection, createdAt: indexedAt, ...value }, indexedAt });
    return uri;
  }

  const fake: FakeBluesky = {
    url: base,
    host,
    calls,
    profiles,
    records,
    notifications,
    access,
    refresh,
    needCode: null,
    addProfile(p) {
      const full: FakeProfile = { followersCount: 3, followsCount: 4, postsCount: 5, createdAt: '2024-02-01T00:00:00.000Z', ...p };
      profiles.set(p.did, full);
      return full;
    },
    addPost: (did, rkey, value, minutesAgo) => addRecord(did, 'app.bsky.feed.post', rkey, value, minutesAgo),
    addRecord,
    notify({ minutesAgo, ...n }) {
      notifications.push({ ...n, indexedAt: iso(minutesAgo ?? 0) });
    },
    expireAccess() {
      for (const a of access) expired.add(a);
    },
    limitNext(n) {
      limited = n;
    },
    stop: () => server.stop(true),
  };
  return fake;
}
