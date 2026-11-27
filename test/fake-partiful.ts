/**
 * A fake of the parts of partiful.com the partiful extractor reaches (docs/partiful.md), on 127.0.0.1, answered from
 * extractors/partiful/test/fixtures.ts (invented people and events):
 *   - a page at any path carrying `__NEXT_DATA__` (the explore page's data and a build id), and `/_next/data/<build>/…`
 *     as Next.js serves it between pages; signed in, the page keeps a Firebase user in IndexedDB as the Firebase SDK
 *     does, and it reloads when someone signs in (`signIn()`, as in the live view);
 *   - the Cloud Functions under /__api/<name> (api.partiful.com on the real site), the callable envelope both ways,
 *     the ones that need a sign-in refusing a call without the page's ID token;
 *   - Stream Chat's REST under /__stream (chat.stream-io-api.com), needing the chat token getStreamUserToken gave;
 *   - Firestore's runQuery under /__firestore (firestore.googleapis.com), the chatRequests query only, needing the
 *     page's ID token and asking for the signed-in user's own requests.
 *
 * Every call is recorded (function or path, params, whether the page's token went with it), so a test can tell the
 * hook made the app's own calls with the page's session, and which calls were never made.
 */
import { ME, ME_STREAM, streamToken, user, world, ANN, BEN, CAL, type World } from '../extractors/partiful/test/fixtures.ts';

export interface FnCall {
  fn: string;
  data: any;
  token: boolean;
}
export interface StreamCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  token: boolean;
}
export interface FirestoreCall {
  path: string;
  body: any;
  token: boolean;
}
export interface FakePartiful {
  url: string;
  fns: FnCall[];
  stream: StreamCall[];
  firestore: FirestoreCall[];
  pages: string[];
  world: World;
  signIn(): void;
  stop(): void;
}

export const PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const ID_TOKEN = 'fake-firebase-id-token';
const BUILD = 'fake-build-1';
const SIGNED_OUT_OK = new Set(['getEventInfo', 'getGuests', 'getEventComments', 'getEventDisplayedHostMessages', 'getEventMedia', 'getUsers']);

export function startFakePartiful(o: { signedIn?: boolean } = {}): FakePartiful {
  let signedIn = o.signedIn ?? true;
  const fns: FnCall[] = [];
  const stream: StreamCall[] = [];
  const firestore: FirestoreCall[] = [];
  const pages: string[] = [];
  const now = Date.now();
  let url = '';
  let w: World;
  const people = [ME, ANN, BEN, CAL];
  const comments: Record<string, any[]> = {};
  const chatMessages: Record<string, any[]> = {};
  let made = 0;

  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });
  const result = (data: unknown, paging?: unknown) => json({ result: { data, ...(paging ? { paging } : {}) } });
  const fnError = (status: number, code: string, message: string) => json({ error: { status: code, message } }, status);
  const events = () => [w.open, w.hidden, w.mine, w.past];

  const page = () => {
    const nd = { props: { pageProps: w.explore }, page: '/explore/[region]', query: { region: 'testville' }, buildId: BUILD, isFallback: false, gsp: true };
    const authUser = { uid: ME.id, displayName: ME.name, stsTokenManager: { accessToken: ID_TOKEN, refreshToken: 'fake-refresh', expirationTime: Date.now() + 3600_000 } };
    return `<!doctype html><html><head><title>Partiful</title></head><body>
<main>${signedIn ? 'Explore' : 'Explore (signed out)'}</main>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nd)}</script>
<script>
  window.__NEXT_DATA__ = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
  // As the Firebase SDK keeps its user: IndexedDB firebaseLocalStorageDb, store firebaseLocalStorage.
  const signedIn = ${JSON.stringify(signedIn)};
  const open = indexedDB.open('firebaseLocalStorageDb', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
  open.onsuccess = () => {
    const st = open.result.transaction('firebaseLocalStorage', 'readwrite').objectStore('firebaseLocalStorage');
    const key = 'firebase:authUser:fake-api-key:[DEFAULT]';
    if (signedIn) st.put({ fbase_key: key, value: ${JSON.stringify(authUser)} });
    else st.delete(key);
  };
  setInterval(async () => {
    const s = await (await fetch('/__fake/state')).json();
    if (s.signedIn !== signedIn) location.reload();
  }, 500);
</script></body></html>`;
  };

  function fn(name: string, data: any, token: boolean): Response {
    fns.push({ fn: name, data, token });
    if (!SIGNED_OUT_OK.has(name) && (!signedIn || !token)) return fnError(401, 'UNAUTHENTICATED', 'Unauthenticated');
    if (token && data?.userId !== ME.id) return fnError(400, 'INVALID_ARGUMENT', 'userId');
    const p = data?.params ?? {};
    const ev = events().find((e) => e.id === p.eventId);
    switch (name) {
      case 'getEventInfo':
        if (p.eventId === 'evRateLimit1') return json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Too many requests' } }, 429);
        return ev ? result({ event: { ...eventOf(ev.id) }, passwordRequired: false }) : fnError(404, 'NOT_FOUND', 'Event not found');
      case 'getGuests':
        return result(w.guests[p.eventId] ?? [], { nextCursor: null, pageResultCount: (w.guests[p.eventId] ?? []).length });
      case 'getMutualGuests':
        return result({ totalCount: 1, guests: [{ user: user(ANN, url) }] });
      case 'getEventComments':
        return result({ comments: [...(w.comments[p.eventId] ?? []), ...(comments[p.eventId] ?? [])] });
      case 'getEventDisplayedHostMessages':
        return result({ hostMessages: w.hostMessages[p.eventId] ?? [] });
      case 'getEventMedia':
        return result({ media: w.album[p.eventId] ?? [] });
      case 'getMyUpcomingEventsForHomePage':
        return result(w.myEvents);
      case 'getNotifications':
        // As Partiful does: a cursor without its start time is an INTERNAL error, not the first page.
        if (!Number.isFinite(p.cursor?.startAfterMs)) return fnError(500, 'INTERNAL', 'INTERNAL');
        return result({ notifications: w.notifications, reachedEndOfData: true });
      case 'getUsers':
        return result((Array.isArray(p.ids) ? p.ids : []).map((id: string) => people.find((x) => x.id === id)).filter(Boolean).map((x: any) => user(x, url, { stats: true })));
      case 'createComment': {
        const c = { id: p.id, eventId: p.eventId, userId: ME.id, message: p.message, createdAt: new Date().toISOString(), ...(p.replyTo ? { replyTo: { id: p.replyTo } } : {}), photoIds: [] };
        (comments[p.eventId] ??= []).push(c);
        return result(c);
      }
      case 'updateCommentReaction':
      case 'updateHostMessageReaction':
        return result(null);
      case 'addGuest':
        return result({ id: ME.id, status: p.rsvp?.status, count: 1, previousStatus: 'SENT' });
      case 'getStreamUserToken':
        return result({ token: streamToken() });
      default:
        return fnError(404, 'NOT_FOUND', `no fake for ${name}`);
    }
  }
  const eventOf = (id: string) => {
    const e = w.myEvents.upcomingEvents.find((x) => x.id === id) ?? w.myEvents.initialPastEvents.find((x) => x.id === id);
    const { guest: _g, ...rest } = e as any;
    return rest;
  };

  function sc(req: Request, path: string, query: Record<string, string>, body: any): Response {
    const token = req.headers.get('authorization') === streamToken() && req.headers.get('stream-auth-type') === 'jwt';
    stream.push({ method: req.method, path, query, body, token });
    if (!token || query.api_key !== 'vpkgtsebxkk2' || query.user_id !== ME_STREAM) return json({ code: 5, message: 'unauthorized' }, 401);
    let m: RegExpExecArray | null;
    if (req.method === 'POST' && path === '/channels') return json({ channels: w.chats.map((c) => ({ ...c, messages: [...c.messages, ...(chatMessages[c.channel.id] ?? [])] })) });
    if (req.method === 'POST' && (m = /^\/channels\/messaging\/([\w!-]+)\/query$/.exec(path))) {
      const c = w.chats.find((x) => x.channel.id === m![1]);
      if (!c) return json({ message: 'no such channel' }, 404);
      const all = [...c.messages, ...(chatMessages[c.channel.id] ?? [])];
      const before = body?.messages?.id_lt;
      const at = before ? all.findIndex((x) => x.id === before) : all.length;
      return json({ ...c, messages: all.slice(Math.max(0, at - (body?.messages?.limit ?? 50)), at) });
    }
    if (req.method === 'POST' && (m = /^\/channels\/messaging\/([\w!-]+)\/message$/.exec(path))) {
      const msg = { id: body?.message?.id ?? `made-${++made}`, text: body?.message?.text, type: 'regular', user: { id: ME_STREAM, name: ME.name }, created_at: new Date().toISOString(), latest_reactions: [] };
      (chatMessages[m[1]!] ??= []).push(msg);
      return json({ message: msg });
    }
    if (req.method === 'POST' && /^\/channels\/messaging\/[\w!-]+\/read$/.test(path)) return json({ event: { type: 'message.read' } });
    if (req.method === 'POST' && /^\/messages\/[\w-]+\/reaction$/.test(path)) return json({ reaction: body?.reaction });
    if (req.method === 'DELETE' && /^\/messages\/[\w-]+\/reaction\/[^/]+$/.test(path)) return json({});
    return json({ message: `no fake for ${req.method} ${path}` }, 404);
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      if (p === '/__fake/state') return json({ signedIn });
      if (p.startsWith('/__fake/media/')) return new Response(PIXEL, { headers: { 'content-type': 'image/png' } });
      if (p.startsWith('/__api/')) {
        const body = await req.json().catch(() => null);
        const auth = req.headers.get('authorization');
        return fn(p.slice(7), body?.data, auth === `Bearer ${ID_TOKEN}`);
      }
      if (p.startsWith('/__firestore/')) {
        const body = await req.json().catch(() => null);
        const token = req.headers.get('authorization') === `Bearer ${ID_TOKEN}`;
        const path = decodeURIComponent(p.slice(12));
        firestore.push({ path, body, token });
        if (!signedIn || !token) return json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } }, 403);
        const q = body?.structuredQuery;
        const mine = `projects/getpartiful/databases/(default)/documents/users/${ME.id}`;
        const asked = req.method === 'POST' && path === '/v1/projects/getpartiful/databases/(default)/documents:runQuery' && q?.from?.[0]?.collectionId === 'chatRequests';
        const filter = q?.where?.fieldFilter;
        if (!asked || filter?.field?.fieldPath !== 'participants' || filter?.op !== 'ARRAY_CONTAINS' || filter?.value?.referenceValue !== mine)
          return json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } }, 403);
        return json(w.chatRequests);
      }
      if (p.startsWith('/__stream/')) {
        const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
        return sc(req, p.slice(9), Object.fromEntries(u.searchParams), body);
      }
      if (p.startsWith('/_next/data/')) {
        pages.push(`${p}${u.search}`);
        if (p === `/_next/data/${BUILD}/explore/testville.json`) return json({ pageProps: w.explore, __N_SSG: true });
        if (p === `/_next/data/${BUILD}/explore.json`) return json({ pageProps: { trendingSections: { TESTVILLE: w.explore.trendingSection } }, __N_SSG: true });
        return json({ notFound: true }, 404);
      }
      return new Response(page(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
  w = world(now, url);

  return {
    url,
    fns,
    stream,
    firestore,
    pages,
    get world() {
      return w;
    },
    signIn() {
      signedIn = true;
    },
    stop() {
      server.stop(true);
    },
  };
}
