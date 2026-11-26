/**
 * A fake of the parts of luma.com and api.luma.com the luma extractor reaches (docs/luma.md), on 127.0.0.1, both on
 * one origin: a page at any path (luma.com) and the API calls (told apart by the `x-luma-client-type: luma-web` header
 * Luma's web client sends), answered from extractors/luma/test/fixtures.ts (invented people, a made-up city).
 *
 * Signed out, the discover calls, an event's page and a profile answer (as Luma's do) and the rest are 401; the page
 * looks every half second for a sign-in (`signIn()`, someone signing in in the live view) and reloads. Signed in, the
 * page sets the session cookie, and every call that needs it checks it.
 *
 * Every API call is recorded (method, path, query, JSON body, whether the session and the client type came with it),
 * so a test can tell the hook made the web app's own calls, and which ones it never made (a hidden guest list, a
 * notification marked seen).
 */
import { ANN, BEN, blasts, CAL, CHAT_DM, chatMessages, conversations, DEE, eventPage, ME, notifications, OTHER_PLACE, PLACE, world, type World } from '../extractors/luma/test/fixtures.ts';

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  session: boolean;
  clientType: string | null;
}
export interface FakeLuma {
  url: string;
  calls: Call[];
  world: World;
  signIn(): void;
  /**
   * The page's "Continue with Google": it sends its tab to `provider`'s authorize page for Luma's redirect address,
   * as luma.com's button does (in its popup). The code that comes back to /google signs it in.
   */
  continueWithGoogle(provider: string): void;
  /** The codes /google was given, in order. */
  googleCodes: string[];
  /** The next `n` API calls answer 429. */
  rateLimit(n: number): void;
  /** A chat message someone sends now: the next message sync brings it. */
  incoming(text: string): string;
  stop(): void;
}

export const PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const COOKIE = 'luma.auth-session-key=fake-session';
/** Answered without a session, as Luma's are. */
const OPEN = new Set(['/discover/bootstrap-page', '/url', '/discover/get-paginated-events', '/event/get', '/user/profile', '/user/profile/events']);

export function startFakeLuma(o: { signedIn?: boolean } = {}): FakeLuma {
  let signedIn = o.signedIn ?? true;
  let google: string | null = null;
  const googleCodes: string[] = [];
  let limited = 0;
  const now = Date.now();
  const w = world(now);
  const calls: Call[] = [];
  const all = [w.open, w.hidden, w.paid, w.online, w.mine, w.mineHidden, w.past];
  const byId = new Map(all.map((e) => [e.api_id, e]));
  const later: any[] = [];
  let n = 0;

  const page = () => `<!doctype html><html><head><title>Luma</title></head><body>
<main>${signedIn ? 'Home' : 'Sign in to Luma'}</main>
<script>
  // As Luma's sign-in does once you are in: the page comes back signed in.
  const was = ${JSON.stringify(signedIn)};
  setInterval(async () => {
    const s = await (await fetch('/__fake/state')).json();
    if (s.signedIn !== was) location.reload();
    else if (s.google) location.href = s.google;
  }, 500);
</script></body></html>`;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const guestRows = (us: typeof ANN[]) => us.map((u) => ({ api_id: `gst-${u.api_id.slice(4)}`, user: u }));

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === '/__fake/state') {
        const go = google;
        google = null;
        return json({ signedIn, google: go });
      }
      // Luma's /google page with Google's answer: it trades the code for a session (POST /google/sign-in).
      if (p === '/google' && url.searchParams.get('code') && !req.headers.get('x-luma-client-type')) {
        googleCodes.push(url.searchParams.get('code')!);
        signedIn = true;
      }
      if (p === '/__fake/media/pixel.png') return new Response(PIXEL, { headers: { 'content-type': 'image/png' } });
      const clientType = req.headers.get('x-luma-client-type');
      if (!clientType) {
        const res = new Response(page(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (signedIn) res.headers.append('set-cookie', `${COOKIE}; Path=/; HttpOnly; SameSite=Lax`);
        return res;
      }
      const body = req.method === 'GET' ? null : await req.json().catch(() => null);
      const q = Object.fromEntries(url.searchParams);
      const session = (req.headers.get('cookie') ?? '').includes(COOKIE);
      calls.push({ method: req.method, path: p, query: q, body, session, clientType });
      if (limited > 0) {
        limited--;
        return json({ message: 'Too many requests' }, 429);
      }
      if (!OPEN.has(p) && !(signedIn && session)) return json({ message: 'Not signed in', code: 'not-authenticated' }, 401);
      const route = `${req.method} ${p}`;
      const ev = (id: string | undefined) => (id ? byId.get(id) : undefined);
      switch (route) {
        case 'GET /user':
          return json({ user: { ...ME, email: 'quinn@example.com' } });
        case 'GET /discover/bootstrap-page':
          return json({ places: [{ place: PLACE }, { place: OTHER_PLACE }], featured_place: { place: OTHER_PLACE }, calendars: [], categories: [] });
        case 'GET /url':
          return q.url === PLACE.slug ? json({ kind: 'discover-place', data: { place: PLACE, is_subscriber: false, events: [w.open] } }) : json({ message: 'Not found' }, 404);
        case 'GET /discover/get-paginated-events':
          if (q.discover_place_api_id === OTHER_PLACE.api_id) return json({ entries: [w.online], has_more: false, next_cursor: null });
          if (q.discover_place_api_id !== PLACE.api_id) return json({ message: 'No such place' }, 404);
          return q.pagination_cursor === 'page-2' ? json({ entries: [w.paid, w.online], has_more: false, next_cursor: null }) : json({ entries: [w.open, w.hidden], has_more: true, next_cursor: 'page-2' });
        case 'GET /event/get': {
          const e = ev(q.event_api_id);
          return e ? json(eventPage(e, { free: e !== w.paid })) : json({ message: 'Event not found' }, 404);
        }
        case 'GET /event/get-guest-list': {
          const e = ev(q.event_api_id);
          // Luma itself refuses a hidden list; the extractor must never ask.
          if (!e || !e.event.show_guest_list) return json({ message: 'Guest list is hidden' }, 403);
          return json({ entries: guestRows(e === w.mine ? [BEN, CAL, DEE] : (e.featured_guests as any)), has_more: false, next_cursor: null });
        }
        case 'GET /event/get-blasts':
          return json(q.event_api_id === w.mine.api_id ? blasts(now) : { blasts: [] });
        case 'GET /event/get-calendar-urls':
          return json({ targets: [{ type: 'google', url: 'https://calendar.example.com/add' }, { type: 'ics', url: `webcal://api.luma.com/ics/get?entity=event&id=${q.event_api_id}` }] });
        case 'GET /home/get-events':
          return json(q.period === 'past' ? { entries: [w.past], has_more: false, next_cursor: null } : { entries: [w.mine, w.mineHidden], has_more: false, next_cursor: null });
        case 'GET /notifications/list':
          return json(notifications(now));
        case 'GET /user/profile':
          return q.username === ANN.api_id ? json({ user: ANN, is_blocked: false }) : json({ message: 'User not found' }, 404);
        case 'GET /user/profile/events':
          return json({ events_hosting: q.username === ANN.api_id ? [w.open] : [], events_past: [], events_together: [] });
        case 'GET /chat/conversations/sync':
          return json(q.pagination_cursor ? { entries: [], has_more: false, next_cursor: q.pagination_cursor } : conversations(now));
        case 'GET /chat/messages/sync':
          if (!q.pagination_cursor) return json(chatMessages(now));
          return json({ entries: later.splice(0), has_more: false, next_cursor: `msgsync-${++n + 1}` });
        case 'GET /chat/conversation/get':
          return json(conversations(now).entries.find((c) => c.api_id === q.chat_conversation_api_id) ?? { message: 'Not found' }, 200);
        case 'GET /chat/conversation/get-messages':
          if (q.chat_conversation_api_id !== CHAT_DM) return json({ entries: [], has_more: false, next_cursor: null });
          return q.pagination_cursor === 'older-1'
            ? json({ entries: [{ api_id: 'chatmsg-BenOlder0001', chat_conversation_api_id: CHAT_DM, user_api_id: BEN.api_id, author: BEN, sent_at: new Date(now - 86_400_000).toISOString(), message_type: 'text', message: 'Hi again', reactions: [] }], has_more: false, next_cursor: null })
            : json({ entries: [chatMessages(now).entries[0]], has_more: true, next_cursor: 'older-1' });
        case 'POST /chat/conversation/send':
          return json({ messages: [{ api_id: body?.message_api_id, chat_conversation_api_id: body?.chat_conversation_api_id, user_api_id: ME.api_id, author: ME, sent_at: new Date().toISOString(), message_type: 'text', message: body?.message, replying_to_message_api_id: body?.replying_to_message_api_id ?? null, reactions: [] }] });
        case 'POST /chat/conversation/mark-as-read':
        case 'POST /chat/conversation/add-reaction':
        case 'POST /chat/conversation/remove-reaction':
          return json({});
        case 'POST /event/register': {
          const e = ev(body?.event_api_id);
          if (!e) return json({ message: 'Event not found' }, 404);
          (e as any).guest_info = { approval_status: 'approved' };
          return json({ status: 'success', ticket_key: 'tk-new' });
        }
        case 'POST /event/decline-my-registration': {
          const e = ev(body?.event_api_id);
          if (!e) return json({ message: 'Event not found' }, 404);
          (e as any).guest_info = { approval_status: 'declined' };
          return json({});
        }
      }
      return json({ message: `no fake for ${route}` }, 404);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    world: w,
    signIn() {
      signedIn = true;
    },
    continueWithGoogle(provider: string) {
      const u = new URL('/o/oauth2/v2/auth', provider);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', 'luma-web.apps.example.com');
      u.searchParams.set('scope', 'https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email');
      u.searchParams.set('prompt', 'select_account consent');
      u.searchParams.set('state', 'state-123');
      u.searchParams.set('redirect_uri', `http://127.0.0.1:${server.port}/google`);
      google = u.toString();
    },
    googleCodes,
    rateLimit(k: number) {
      limited = k;
    },
    incoming(text: string) {
      const id = `chatmsg-Incoming${String(++n).padStart(4, '0')}`;
      later.push({ api_id: id, chat_conversation_api_id: CHAT_DM, user_api_id: BEN.api_id, author: BEN, sent_at: new Date().toISOString(), message_type: 'text', message: text, reactions: [], mentions: [] });
      return id;
    },
    stop() {
      server.stop(true);
    },
  };
}
