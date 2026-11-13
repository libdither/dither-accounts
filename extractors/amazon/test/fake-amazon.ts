/**
 * A stand-in for www.amazon.com on http://localhost:<port>, enough for an order-history pull: Your Orders by year (10
 * cards a page, with Amazon's class names, uppercase labels done in CSS, the time filter and page links), order
 * details pages (data-component blocks), the sign-in pages (email, then password with "keep me signed in", then an
 * authenticator code when asked for), the robot check (validateCaptcha) and the "I am human" checkpoint. Orders are
 * made to catch a parser that is not amazon.py's: non-ASCII and astral titles, quotes, thousands separators, digital
 * orders, duplicate product links, items without a title, quantity or seller, orders without a ship-to block or card.
 *
 * Steps the test pushes, done by the page where it is (nothing here clicks): `solve` on the robot check or the
 * checkpoint. Flags: `reauthAt(n)` (the n-th details page asks for the password again), `requireOtp`,
 * `robotNext(where)` / `humanNext(where)` (the next orders or details page is a challenge), `addOrder()` (a new order this year).
 */
export const EMAIL = 'test.user@example.com';
export const PASSWORD = 'correct horse ¶ battery';
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

interface Order {
  id: string;
  placed: Date;
  total: string;
  shipTo: string | null;
  status: string;
  items: { title: string; asin: string; price: string; qty: number | null; seller: string | null }[];
  digital: boolean;
  card: string | null;
  noShipBlock: boolean;
}

const TITLES = [
  'Café ☕ Mug, 12 oz',
  'USB-C cable (2 pack) — braided',
  'Ünïcødé 📚 Book: "Quotes" & More',
  'Wool socks',
  'Kindle Edition: The <Long> Title',
  'Ｆｕｌｌｗｉｄｔｈ ｔｅａ',
  'Batteries AA ×24',
];
const NAMES = ['Test User', 'Ann Lee', 'José Núñez', 'Bo Chen'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const asin = (n: number) => `B0${(n * 2654435761).toString(36).toUpperCase().padStart(8, 'X').slice(-8)}`;
const fmtDay = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
const money = (cents: number) => `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;

function makeOrders(): Order[] {
  const out: Order[] = [];
  const per: Record<number, number> = { 2026: 14, 2025: 23, 2024: 6 };
  let k = 0;
  for (const y of [2026, 2025, 2024]) {
    for (let i = 0; i < per[y]; i++, k++) {
      const digital = y === 2025 && (i === 4 || i === 15);
      const month = 10 - Math.floor((i * 10) / per[y]);
      const placed = new Date(Date.UTC(y, month, 1 + ((i * 7) % 27)));
      const n = 1 + (k % 3);
      const items = Array.from({ length: n }, (_, j) => ({
        title: TITLES[(k + j) % TITLES.length],
        asin: asin(k * 10 + j),
        price: money(199 + ((k * 3137 + j * 911) % 150000)),
        qty: (k + j) % 4 === 0 ? null : 1 + ((k + j) % 3),
        seller: (k + j) % 5 === 0 ? null : `Seller ${String.fromCharCode(65 + ((k + j) % 26))} LLC`,
      }));
      out.push({
        id: digital ? `D01-${y}${String(i).padStart(3, '0')}-${String((k * 7919) % 9999999).padStart(7, '0')}` : `1${String(10 + (k % 89))}-${y}${String(i).padStart(3, '0')}-${String((k * 7919) % 9999999).padStart(7, '0')}`,
        placed,
        total: money(299 + ((k * 104729) % 250000)),
        shipTo: digital ? null : NAMES[k % NAMES.length],
        status: digital ? 'Digital order' : ['Delivered ', 'Arriving ', 'Return complete', 'Cancelled', 'Now arriving today'][k % 5] + (k % 5 < 2 ? fmtDay(placed).replace(/, \d{4}$/, '') : ''),
        items,
        digital,
        card: k % 6 === 5 ? null : k % 2 ? 'Mastercard ending in 9876' : 'Visa ending in 1234',
        noShipBlock: k % 9 === 4,
      });
    }
  }
  return out;
}

export interface FakeAmazon {
  origin: string;
  orders: Order[];
  /** What happened: 'email:ok', 'password:ok:remember', 'otp:ok', 'robot', 'human', 'solved', 'details:<id>', 'list:<y>:<n>'. */
  log: string[];
  push(...steps: string[]): void;
  reauthAt(n: number): void;
  requireOtp(on: boolean): void;
  robotNext(where?: 'orders' | 'details'): void;
  humanNext(where?: 'orders' | 'details'): void;
  addOrder(): void;
  stop(): void;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PAGE = (title: string, body: string, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>.u{text-transform:uppercase} .hide{display:none}</style></head><body>
<div id="nav-link-accountList-nav-line-1">Hello, Test</div>${body}<script>${script}</script></body></html>`;
const SOLVE_SCRIPT = `setInterval(async () => { try { const n = await fetch('/api/next').then(r => r.json()); if (n.action === 'solve') document.forms[0].submit(); } catch (e) {} }, 300);`;

export function startFakeAmazon(): FakeAmazon {
  const orders = makeOrders();
  const sessions = new Set<string>();
  const log: string[] = [];
  const steps: string[] = [];
  let detailCount = 0;
  let reauth: number | null = null;
  let otp = false;
  let robot: string | null = null;
  let human: string | null = null;
  let added = 0;
  const session = (req: Request) => {
    const m = /(?:^|;\s*)a_session=([\w-]+)/.exec(req.headers.get('cookie') ?? '');
    return m && sessions.has(m[1]) ? m[1] : null;
  };
  const newSession = () => {
    const id = crypto.randomUUID();
    sessions.add(id);
    return `a_session=${id}; Path=/; HttpOnly; SameSite=Lax`;
  };
  const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
  const redirect = (to: string, cookie?: string) => new Response(null, { status: 302, headers: { location: to, ...(cookie ? { 'set-cookie': cookie } : {}) } });
  const signin = (back: string) => redirect(`/ap/signin?return_to=${encodeURIComponent(back)}`);
  const years = () => [...new Set(orders.map((o) => o.placed.getUTCFullYear()))].sort((a, b) => b - a);
  const filter = () =>
    `<form><select name="timeFilter"><option value="last30">past 30 days</option><option value="months-3">past 3 months</option>${years()
      .map((y) => `<option value="year-${y}">${y}</option>`)
      .join('')}<option value="archived">Archived orders</option></select></form>`;

  const card = (o: Order) => `<div class="order-card js-order-card">
 <div class="order-header">
  <div><div class="u">Order placed</div><div>${fmtDay(o.placed)}</div></div>
  <div><div class="u">Total</div><div>${o.total}</div></div>
  ${o.shipTo ? `<div><div class="u">Ship to</div><div><a href="#">${esc(o.shipTo)}</a></div></div>` : ''}
  <div><div><span class="u">Order #</span> ${o.id}</div><a href="/your-orders/order-details?orderID=${o.id}">View order details</a></div>
 </div>
 <div class="shipment"><div>${esc(o.status)}</div>
  ${o.items.map((it) => `<div class="item"><a href="/dp/${it.asin}/ref=img"><img alt=""></a><a href="/dp/${it.asin}?ref=ppx">${esc(it.title)}</a></div>`).join('\n  ')}
 </div>
</div>`;

  const detailsPage = (o: Order) =>
    PAGE(
      'Order details',
      `${o.noShipBlock ? '' : `<div data-component="shippingAddress"><div class="u">Ship to</div><div>${esc(o.shipTo ?? 'Test User')}</div><div>123 Main St</div><div>Springfield, IL 62701</div></div>`}
${o.items
  .map(
    (it, j) => `<div data-component="purchasedItems">
  ${j === 2 ? '<div data-component="itemTitle"></div>' : `<div data-component="itemTitle"><a href="/dp/${it.asin}?ref=dt">${esc(it.title)}</a></div>`}
  <div data-component="unitPrice"><span>${it.price}</span></div>
  ${it.qty ? `<div data-component="quantity">Qty: ${it.qty}</div>` : ''}
  ${it.seller ? `<div data-component="orderedMerchant">Sold by: ${esc(it.seller)}</div>` : ''}
</div>`,
  )
  .join('\n')}
<div data-component="chargeSummary"><div>Item(s) Subtotal:</div><div>${o.total}</div><div>Shipping &amp; Handling:</div><div>$0.00</div><div>Total before tax:</div><div>${o.total}</div><div>Estimated tax to be collected:</div><div>$1.07</div><div>Promotion Applied:</div><div>-$2.00</div><div>Grand Total:</div><div>${o.total}</div></div>
${o.card ? `<div>Payment method</div><div>${o.card}</div>` : '<div>Payment method</div><div>Amazon gift card balance</div>'}`,
    );

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      const here = p + u.search;
      if (p === '/test-login') return redirect('/', newSession());
      if (p === '/api/next') return Response.json({ action: steps.length ? steps.shift() : null });
      if (p === '/') return html(PAGE('Amazon (fake)', '<h1>Amazon.com (fake)</h1>'));
      // ----------------------------------------------------------- sign-in
      if (p === '/ap/signin' && req.method === 'GET') {
        const back = u.searchParams.get('return_to') ?? '/';
        if (u.searchParams.get('step') === 'password')
          return html(
            PAGE(
              'Amazon Sign-In',
              `<form method="post" action="/ap/signin/password"><input type="hidden" name="return_to" value="${esc(back)}"><label>Password</label><input type="password" id="ap_password" name="password"><label><input type="checkbox" name="rememberMe" value="true"> Keep me signed in</label><input type="submit" id="signInSubmit" value="Sign in"></form>`,
            ),
          );
        return html(
          PAGE(
            'Amazon Sign-In',
            `<form method="post" action="/ap/signin/email"><input type="hidden" name="return_to" value="${esc(back)}"><label>Email</label><input type="email" id="ap_email" name="email"><input type="submit" id="continue" value="Continue"></form>`,
          ),
        );
      }
      if (p === '/ap/signin/email' && req.method === 'POST') {
        const f = await req.formData();
        const ok = f.get('email') === EMAIL;
        log.push(`email:${ok ? 'ok' : 'bad'}`);
        const back = String(f.get('return_to') ?? '/');
        return ok ? redirect(`/ap/signin?step=password&return_to=${encodeURIComponent(back)}`) : redirect(`/ap/signin?return_to=${encodeURIComponent(back)}`);
      }
      if (p === '/ap/signin/password' && req.method === 'POST') {
        const f = await req.formData();
        const ok = f.get('password') === PASSWORD;
        log.push(`password:${ok ? 'ok' : 'bad'}${f.get('rememberMe') === 'true' ? ':remember' : ''}`);
        const back = String(f.get('return_to') ?? '/');
        if (!ok) return redirect(`/ap/signin?step=password&return_to=${encodeURIComponent(back)}`);
        if (otp) return redirect(`/ap/mfa?return_to=${encodeURIComponent(back)}`);
        return redirect(back, newSession());
      }
      if (p === '/ap/mfa' && req.method === 'GET') {
        const back = u.searchParams.get('return_to') ?? '/';
        return html(
          PAGE(
            'Two-Step Verification',
            `<form method="post" action="/ap/mfa"><input type="hidden" name="return_to" value="${esc(back)}"><input id="auth-mfa-otpcode" name="otpCode"><label><input type="checkbox" id="auth-mfa-remember-device" name="rememberDevice" value="true"> Don't require a code on this browser</label><input type="submit" id="auth-signin-button" value="Sign in"></form>`,
          ),
        );
      }
      if (p === '/ap/mfa' && req.method === 'POST') {
        const f = await req.formData();
        const { totp } = await import('../src/auth.ts');
        const ok = f.get('otpCode') === totp(TOTP_SECRET);
        log.push(`otp:${ok ? 'ok' : 'bad'}${f.get('rememberDevice') === 'true' ? ':remember' : ''}`);
        const back = String(f.get('return_to') ?? '/');
        return ok ? redirect(back, newSession()) : redirect(`/ap/mfa?return_to=${encodeURIComponent(back)}`);
      }
      // ----------------------------------------------------------- challenges
      if (p === '/errors/validateCaptcha') {
        log.push('solved');
        return redirect(u.searchParams.get('back') ?? '/');
      }
      if (p.startsWith('/checkpoint/')) {
        if (u.searchParams.get('done')) {
          log.push('solved');
          return redirect(u.searchParams.get('return_to') ?? '/');
        }
        return html(
          PAGE(
            'Checkpoint',
            `<form method="get" action="/checkpoint/human"><input type="hidden" name="return_to" value="${esc(u.searchParams.get('return_to') ?? '/')}"><input type="hidden" name="done" value="1"><label><input type="checkbox"> I am human</label><button>Continue</button></form>`,
            SOLVE_SCRIPT,
          ),
        );
      }
      // ----------------------------------------------------------- orders
      if (p === '/your-orders/orders' || p === '/your-orders/order-details') {
        if (!session(req)) return signin(here);
        const where = p === '/your-orders/orders' ? 'orders' : 'details';
        if (robot === where) {
          robot = null;
          log.push('robot');
          return html(
            PAGE(
              'Amazon.com',
              `<form method="get" action="/errors/validateCaptcha"><input type="hidden" name="back" value="${esc(here)}"><img src="/captcha.jpg" alt=""><input id="captchacharacters" name="field-keywords"><button type="submit">Continue shopping</button></form>`,
              SOLVE_SCRIPT,
            ),
          );
        }
        if (human === where) {
          human = null;
          log.push('human');
          return redirect(`/checkpoint/human?return_to=${encodeURIComponent(here)}`);
        }
      }
      if (p === '/your-orders/orders') {
        const tf = u.searchParams.get('timeFilter') ?? `year-${years()[0]}`;
        const y = Number(tf.slice(5));
        const n = Number(u.searchParams.get('page') ?? 0);
        log.push(`list:${y}:${n}`);
        const mine = orders.filter((o) => o.placed.getUTCFullYear() === y).sort((a, b) => b.placed.getTime() - a.placed.getTime());
        const pages = Math.ceil(mine.length / 10);
        const shown = mine.slice(n * 10, n * 10 + 10);
        const nav = Array.from({ length: pages }, (_, i) => (i === n ? `<li class="a-selected">${i + 1}</li>` : `<li><a href="/your-orders/orders?timeFilter=year-${y}&page=${i}">${i + 1}</a></li>`)).join('');
        return html(PAGE('Your Orders', `${filter()}<div class="your-orders-content-container">${shown.map(card).join('\n')}</div><ul class="a-pagination">${nav}</ul>`));
      }
      if (p === '/your-orders/order-details') {
        const id = u.searchParams.get('orderID') ?? '';
        detailCount++;
        if (reauth !== null && detailCount === reauth) {
          reauth = null;
          sessions.clear();
          return signin(here);
        }
        log.push(`details:${id}`);
        const o = orders.find((x) => x.id === id);
        return o ? html(detailsPage(o)) : new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    origin: `http://localhost:${server.port}`,
    orders,
    log,
    push: (...s) => steps.push(...s),
    reauthAt: (n) => {
      reauth = detailCount + n;
    },
    requireOtp: (on) => {
      otp = on;
    },
    robotNext: (where = 'orders') => {
      robot = where;
    },
    humanNext: (where = 'orders') => {
      human = where;
    },
    addOrder: () => {
      added++;
      orders.unshift({
        id: `113-2026${String(900 + added).padStart(3, '0')}-${String(1234567 + added).padStart(7, '0')}`,
        placed: new Date(Date.UTC(2026, 10, 8)),
        total: '$1,049.99',
        shipTo: 'Test User',
        status: 'Arriving tomorrow',
        items: [{ title: 'New thing 🎁', asin: asin(99990 + added), price: '$1,049.99', qty: 1, seller: 'Amazon.com' }],
        digital: false,
        card: 'Visa ending in 1234',
        noShipBlock: false,
      });
    },
    stop: () => server.stop(true),
  };
}
