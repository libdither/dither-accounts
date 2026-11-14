/**
 * A stand-in for client.schwab.com on http://localhost:<port>, enough for an export pull and the passkey: a sign-in page, the code
 * page Schwab shows after the password (a one-time-code field, in a frame as Schwab's sign-in is), the accounts
 * summary, History (a menu-style account picker, a date range with Custom, From and To fields, Search, and Export with
 * a format dialog) and Realized Gain/Loss (a plain select of the brokerage accounts, Custom date range, Search, and an
 * Export that downloads at once).
 * Exports come back as attachments named the way Schwab names them (Brokerage_XXX111_Transactions_…csv), with
 * Schwab's CSV headers.
 *
 * The passkey, as schwab.com's may be: its sign-in widget and its passkey settings come from another origin of the same
 * site (sws-gateway*.schwab.com there; here http://localhost:<another port>, `frameOrigin`), in frames on the app's
 * pages (allow="publickey-credentials-get/-create"). The widget's "Log in with a passkey" button does nothing until its
 * script has hydrated it (`hydrateMs`); then it asks navigator.credentials.get for rpId localhost, and the server
 * checks the assertion with FakeRp: the frame's origin, crossOrigin true and the app's origin as topOrigin, as Chromium
 * writes them for that frame, and the counter; `throttled`, it asks for nothing and shows an alert ("Too many attempts
 * …"). The settings frame registers one (ES256 only). After a passkey
 * sign-in the widget tells the top page (postMessage) to go to the summary, or, with `codeAfterPasskey`, to the code
 * page.
 *
 * Steps the test pushes, each done by the page where it is (nothing here clicks for the extractor): `password` on the
 * sign-in page (to the code page), `code` on the code page (signed in), `security` and `logout` on the summary or the
 * security page (to the passkey settings, or signed out), `idle` on the summary (Schwab's inactivity logout: a sign-in
 * page whose passkey option asks for nothing until it is loaded again), `register` in the settings frame (a passkey made), `passkey`
 * in the sign-in widget (the person clicks "Log in with a passkey"). `expire()` ends every session.
 */
import { FakeRp } from '../../../packages/passkey/test/fake-rp.ts';

export interface FakeSchwab {
  origin: string;
  /** The sign-in widget's and passkey settings' origin (sws-gateway's stand-in). */
  frameOrigin: string;
  rp: FakeRp;
  /** After a passkey sign-in, ask for a code (as Schwab may). */
  codeAfterPasskey: boolean;
  /** The widget's passkey option asks for nothing and shows an alert instead (as Schwab stopped asking for the passkey
   * after a few sign-ins in a row). */
  throttled: boolean;
  hydrateMs: number;
  /** Every export: which account, which range, signed in or not. */
  exports: { layout: string; mask: string; from: string; to: string; ok: boolean }[];
  log: string[];
  push(...steps: string[]): void;
  expire(): void;
  stop(): void;
}

export const ACCOUNTS = [
  { mask: '111', label: 'Brokerage …111', layout: 'brokerage' as const },
  { mask: '222', label: 'Checking …222', layout: 'bank' as const },
];

const usDay = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const q = (cells: string[]) => cells.map((c) => `"${c.replaceAll('"', '""')}"`).join(',');
/** Days from..to (ISO) whose day of month is in `dom`, newest first, from 2025 on. */
function days(from: string, to: string, dom: number[]): string[] {
  const out: string[] = [];
  const [fy] = from.split('-').map(Number);
  const [ty] = to.split('-').map(Number);
  for (let y = Math.max(fy, 2025); y <= ty; y++)
    for (let m = 1; m <= 12; m++)
      for (const d of dom) {
        const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (s >= from && s <= to) out.push(s);
      }
  return out.sort().reverse();
}

export function exportCsv(layout: 'brokerage' | 'bank' | 'realized', from: string, to: string): string {
  if (layout === 'brokerage') {
    const rows = days(from, to, [5]).flatMap((d) => [
      q([`${usDay(d)} as of ${usDay(d)}`, 'Reinvest Shares', 'SWVXX', 'SCHWAB PRIME ADVANTAGE MONEY INVESTOR SHARES', '0.12', '$1.00', '', '-$0.12']),
      q([usDay(d), 'Reinvest Dividend', 'SWVXX', 'SCHWAB PRIME ADVANTAGE MONEY INVESTOR SHARES', '', '', '', '$0.12']),
    ]);
    return [q(['Date', 'Action', 'Symbol', 'Description', 'Quantity', 'Price', 'Fees & Comm', 'Amount']), ...rows].join('\r\n') + '\r\n';
  }
  if (layout === 'bank') {
    // Newest first, each row's balance after it: an older row holds $1 more.
    const rows = days(from, to, [7, 21]).map((d, i) => q([usDay(d), 'Posted', 'ACH', '', 'COFFEE, "THE" PLACE', '$1.00', '', `$${(100 + i).toFixed(2)}`]));
    return [q(['Date', 'Status', 'Type', 'CheckNumber', 'Description', 'Withdrawal', 'Deposit', 'RunningBalance']), ...rows].join('\r\n') + '\r\n';
  }
  const rows = days(from, to, [2])
    .filter((d) => d.slice(5, 7) === '03')
    .map((d) => q(['VYM', 'VANGUARD HIGH DIVIDEND YIELD ETF', usDay(d), '1', '$110.00', 'FIFO', '$110.00', '$100.00', '+$10.00', '+$10.00', '', '']));
  return (
    [
      q([`Realized Gain/Loss for XXX111 for ${usDay(from)} to ${usDay(to)}`]),
      q(['Symbol', 'Name', 'Closed Date', 'Quantity', 'Closing Price', 'Cost Basis Method', 'Proceeds', 'Cost Basis (CB)', 'Total Gain/Loss ($)', 'Long Term Gain/Loss ($)', 'Short Term Gain/Loss ($)', 'Disallowed Loss']),
      ...rows,
    ].join('\r\n') + '\r\n'
  );
}

const PAGE = (title: string, body: string, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${body}<script>${script}</script></body></html>`;

const STEP = (path: string, post: string, to: string) => `
let busy = false;
setInterval(async () => {
  if (busy) return; busy = true;
  try {
    const next = await fetch('/api/next?path=' + encodeURIComponent(location.pathname)).then(r => r.json());
    if (next.action) { await fetch('${post}', { method: 'POST' }); top.location.href = '${to}'; }
  } catch (e) {} finally { busy = false; }
}, 300);`;

const HISTORY = (accounts: typeof ACCOUNTS) => `
<div>Transaction History</div>
<button id="picker" aria-haspopup="listbox" aria-expanded="false">${accounts[0].label}</button>
<ul id="menu" role="listbox" hidden>${accounts.map((a) => `<li role="option" data-mask="${a.mask}">${a.label}</li>`).join('')}</ul>
<label>Date range <select id="range"><option>Last 6 Months</option><option value="custom">Custom</option></select></label>
<span id="custom" hidden><input aria-label="From" placeholder="mm/dd/yyyy"><input aria-label="To" placeholder="mm/dd/yyyy"></span>
<button id="search">Search</button>
<p id="found"></p>
<button id="export">Export</button>
<div id="dlg" role="dialog" hidden><label><input type="radio" name="fmt" value="json" checked> JSON</label><label><input type="radio" name="fmt" value="csv"> CSV</label><button id="go">Export</button><button>Cancel</button></div>`;

const HISTORY_SCRIPT = `
const st = { mask: '111', from: '', to: '' };
const $ = (s) => document.querySelector(s);
$('#picker').onclick = () => { const m = $('#menu'); m.hidden = !m.hidden; $('#picker').setAttribute('aria-expanded', String(!m.hidden)); };
for (const li of document.querySelectorAll('#menu li')) li.onclick = () => { st.mask = li.dataset.mask; $('#picker').textContent = li.textContent; $('#menu').hidden = true; $('#picker').setAttribute('aria-expanded', 'false'); busy(); };
$('#range').onchange = () => { $('#custom').hidden = $('#range').value !== 'custom'; };
function busy() { const f = $('#found'); f.textContent = 'Loading...'; f.setAttribute('aria-busy', 'true'); setTimeout(() => { f.removeAttribute('aria-busy'); f.textContent = 'Transactions found from ' + (st.from || 'the last 6 months') + ' to ' + (st.to || 'today'); }, 400); }
$('#search').onclick = () => { const [a, b] = document.querySelectorAll('#custom input'); if ($('#range').value === 'custom') { st.from = a.value; st.to = b.value; } else { st.from = st.to = ''; } busy(); };
$('#export').onclick = () => { $('#dlg').hidden = false; };
$('#go').onclick = () => { const fmt = document.querySelector('input[name=fmt]:checked').value; $('#dlg').hidden = true; location.href = '/api/export?page=history&mask=' + st.mask + '&from=' + encodeURIComponent(st.from) + '&to=' + encodeURIComponent(st.to) + '&fmt=' + fmt; };
busy();`;

const REALIZED = `
<div>Realized Gain / Loss</div>
<label>Account <select id="acct"><option value="111">Brokerage …111</option></select></label>
<label>Date range <select id="range"><option>Year to date</option><option value="custom">Custom date range</option></select></label>
<label for="f">From</label><input id="f" placeholder="mm/dd/yyyy"><label for="t">To</label><input id="t" placeholder="mm/dd/yyyy">
<button id="search">Search</button>
<p id="found">Realized Gain/Loss Details</p>
<a href="#" id="export" aria-label="Export">Export</a>`;
const REALIZED_SCRIPT = `
const st = { from: '', to: '' };
const $ = (s) => document.querySelector(s);
$('#search').onclick = () => { if ($('#range').value === 'custom') { st.from = $('#f').value; st.to = $('#t').value; } };
$('#export').onclick = (e) => { e.preventDefault(); location.href = '/api/export?page=realized&mask=' + $('#acct').value + '&from=' + encodeURIComponent(st.from) + '&to=' + encodeURIComponent(st.to) + '&fmt=csv'; };`;

const b64uJs = `
const enc = (b) => { const u = new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer); let s = ''; for (const c of u) s += String.fromCharCode(c); return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); };
const dec = (s) => { const t = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(t, (c) => c.charCodeAt(0)); };`;

/** Steps for the app's own pages (the summary, the security page): go to the passkey settings, or log out. */
const APP_STEP = (path: string) => `
let appBusy = false;
setInterval(async () => {
  if (appBusy) return; appBusy = true;
  try {
    const next = await fetch('/api/next?path=' + encodeURIComponent('${path}')).then(r => r.json());
    if (next.action === 'security') location.href = '/app/security/passkeys/';
    if (next.action === 'logout') location.href = '/logout/';
    if (next.action === 'idle') location.href = '/logout/?inactivity=1';
  } catch (e) {} finally { appBusy = false; }
}, 300);`;

/** The sign-in widget, in a frame on the sign-in page. */
const WIDGET = (app: string, hydrateMs: number, dead = false) => `
${b64uJs}
const button = document.getElementById('pk');
let hydrated = false;
setTimeout(() => { hydrated = true; }, ${hydrateMs});
button.addEventListener('click', async () => {
  if (!hydrated) return; // prerendered: a click before the script is up does nothing
  if (${dead}) return; // the sign-in page left after an idle logout: its passkey option asks for nothing
  try {
    const res = await fetch('/gw/passkey/options', { method: 'POST' });
    const o = await res.json();
    if (!res.ok) { document.getElementById('err').textContent = o.error; return; }
    const cred = await navigator.credentials.get({ publicKey: { challenge: dec(o.challenge), rpId: 'localhost', userVerification: 'required', allowCredentials: [] } });
    const body = { id: cred.id, clientDataJSON: enc(cred.response.clientDataJSON), authenticatorData: enc(cred.response.authenticatorData), signature: enc(cred.response.signature), userHandle: cred.response.userHandle ? enc(cred.response.userHandle) : null };
    const r = await fetch('/gw/passkey/finish', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
    parent.postMessage(r.next, '${app}');
  } catch (e) {
    document.getElementById('err').textContent = 'That did not work: ' + (e && e.name);
  }
});
let busy = false;
setInterval(async () => {
  if (busy || !hydrated) return; busy = true;
  try {
    const next = await fetch('/api/next?path=/ui/login').then(r => r.json());
    if (next.action === 'passkey') button.click();
  } catch (e) {} finally { busy = false; }
}, 300);`;

/** The passkey settings, in a frame on the app's security page. */
const SETTINGS = `
${b64uJs}
let busy = false;
setInterval(async () => {
  if (busy) return; busy = true;
  try {
    const next = await fetch('/api/next?path=/ui/passkeys').then(r => r.json());
    if (next.action !== 'register') return;
    const o = await fetch('/gw/passkey/register-options', { method: 'POST' }).then(r => r.json());
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { id: 'localhost', name: 'Fake Schwab' }, user: { id: dec(o.userId), name: 'me', displayName: 'Me' }, challenge: dec(o.challenge),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none' } });
    const body = { id: cred.id, clientDataJSON: enc(cred.response.clientDataJSON), attestationObject: enc(cred.response.attestationObject), publicKey: enc(cred.response.getPublicKey()), publicKeyAlgorithm: cred.response.getPublicKeyAlgorithm() };
    const r = await fetch('/gw/passkey/register', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
    document.getElementById('list').textContent = r.ok ? 'Passkey added' : 'Passkey refused';
  } catch (e) {
    document.getElementById('list').textContent = 'That did not work: ' + (e && e.name);
  } finally { busy = false; }
}, 300);`;

export function startFakeSchwab(): FakeSchwab {
  const sessions = new Set<string>();
  const pending = new Set<string>();
  const steps: string[] = [];
  const log: string[] = [];
  const exports: FakeSchwab['exports'] = [];
  const cookie = (req: Request, name: string) => new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)`).exec(req.headers.get('cookie') ?? '')?.[1] ?? null;
  const session = (req: Request) => {
    const s = cookie(req, 's_session');
    return s && sessions.has(s) ? s : null;
  };
  const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
  const iso = (us: string) => (/^\d\d\/\d\d\/\d{4}$/.test(us) ? `${us.slice(6)}-${us.slice(0, 2)}-${us.slice(3, 5)}` : '');
  const signedIn = (id: string) => new Response('{"next":"signed-in"}', { headers: { 'set-cookie': `s_session=${id}; Path=/; HttpOnly; SameSite=Lax`, 'content-type': 'application/json' } });
  /** Where each step is done: the page (or frame) path that acts on it. */
  const WHERE: Record<string, string[]> = {
    password: ['/Areas/Access/Login'],
    code: ['/mfa/frame'],
    security: ['/clientapps/accounts/summary/'],
    logout: ['/clientapps/accounts/summary/', '/app/security/passkeys/'],
    idle: ['/clientapps/accounts/summary/'],
    register: ['/ui/passkeys'],
    passkey: ['/ui/login'],
  };
  const challenges = { get: new Set<string>(), create: new Set<string>() };
  const userId = Buffer.from('fake-schwab-user').toString('base64url');
  const me: FakeSchwab = { origin: '', frameOrigin: '', rp: null as unknown as FakeRp, codeAfterPasskey: false, throttled: false, hydrateMs: 600, exports, log, push: () => {}, expire: () => {}, stop: () => {} };

  // The app (client.schwab.com's stand-in) and the sign-in widget's origin (sws-gateway's): one site, two origins.
  const handler = (req: Request): Response | Promise<Response> => {
      const u = new URL(req.url);
      const p = u.pathname;
      if (p === '/api/next') {
        const path = u.searchParams.get('path') ?? '';
        const want = steps[0];
        if (want && WHERE[want]?.includes(path)) {
          steps.shift();
          return Response.json({ action: want });
        }
        return Response.json({ action: null });
      }
      // ---- the gateway's widget and passkey settings (served on both origins; the app's pages frame frameOrigin's)
      if (p === '/ui/login')
        return html(PAGE('Log in', '<button id="pk" type="button"><span>Log in with a passkey</span></button> <a href="#">Learn about passkeys</a><p id="err" role="alert"></p>', WIDGET(me.origin, me.hydrateMs, u.searchParams.has('inactivity'))));
      if (p === '/ui/passkeys') return html(PAGE('Passkeys', '<p id="list">No passkeys yet</p>', SETTINGS));
      if (p === '/gw/passkey/options' && req.method === 'POST') {
        if (me.throttled) {
          log.push('passkey-throttled');
          return Response.json({ error: 'Too many attempts (error 4029). Please try again later.' }, { status: 429 });
        }
        const challenge = me.rp.challenge();
        challenges.get.add(challenge);
        return Response.json({ challenge });
      }
      if (p === '/gw/passkey/finish' && req.method === 'POST') {
        return (async () => {
          const body = await req.json();
          const challenge = JSON.parse(Buffer.from(body.clientDataJSON, 'base64url').toString()).challenge;
          if (!challenges.get.delete(challenge)) return Response.json({ next: 'refused' }, { status: 400 });
          try {
            me.rp.authenticate(challenge, body);
          } catch (e) {
            log.push(`passkey-refused: ${(e as Error).message}`);
            return Response.json({ next: 'refused' }, { status: 401 });
          }
          log.push('passkey-signin');
          if (me.codeAfterPasskey) {
            const id = crypto.randomUUID();
            pending.add(id);
            return new Response('{"next":"code"}', { headers: { 'set-cookie': `s_pending=${id}; Path=/; HttpOnly; SameSite=Lax`, 'content-type': 'application/json' } });
          }
          const id = crypto.randomUUID();
          sessions.add(id);
          return signedIn(id);
        })();
      }
      if (p === '/gw/passkey/register-options' && req.method === 'POST') {
        if (!session(req)) return Response.json({ error: 'sign in first' }, { status: 401 });
        const challenge = me.rp.challenge();
        challenges.create.add(challenge);
        return Response.json({ challenge, userId });
      }
      if (p === '/gw/passkey/register' && req.method === 'POST') {
        if (!session(req)) return Response.json({ ok: false }, { status: 401 });
        return (async () => {
          const body = await req.json();
          const challenge = JSON.parse(Buffer.from(body.clientDataJSON, 'base64url').toString()).challenge;
          if (!challenges.create.delete(challenge)) return Response.json({ ok: false }, { status: 400 });
          try {
            me.rp.register(challenge, body, userId);
          } catch (e) {
            log.push(`passkey-register-refused: ${(e as Error).message}`);
            return Response.json({ ok: false }, { status: 400 });
          }
          log.push('passkey-registered');
          return Response.json({ ok: true });
        })();
      }
      if (p === '/api/password' && req.method === 'POST') {
        log.push('password');
        const id = crypto.randomUUID();
        pending.add(id);
        return new Response('{}', { headers: { 'set-cookie': `s_pending=${id}; Path=/; HttpOnly; SameSite=Lax`, 'content-type': 'application/json' } });
      }
      if (p === '/api/code' && req.method === 'POST') {
        const pid = cookie(req, 's_pending');
        if (!pid || !pending.has(pid)) return Response.json({ error: 'no' }, { status: 401 });
        log.push('code');
        const id = crypto.randomUUID();
        sessions.add(id);
        return new Response('{}', { headers: { 'set-cookie': `s_session=${id}; Path=/; HttpOnly; SameSite=Lax`, 'content-type': 'application/json' } });
      }
      if (p === '/Areas/Access/Login')
        return html(
          PAGE(
            'Log in (fake Schwab)',
            `${u.searchParams.has('inactivity') ? "<p>For your security, we've logged you out of your account due to inactivity.</p><p>There was a problem logging you in.</p>" : ''}<label>Login ID <input name="id"></label><label>Password <input type="password" name="pw"></label><button>Log in</button>
<iframe src="${me.frameOrigin}/ui/login${u.search}" title="Log in" allow="publickey-credentials-get *" width="500" height="120"></iframe>`,
            STEP(p, '/api/password', '/mfa/verify') +
              `\naddEventListener('message', (e) => { if (e.origin !== '${me.frameOrigin}') return; if (e.data === 'signed-in') location.href = '/clientapps/accounts/summary/'; if (e.data === 'code') location.href = '/mfa/verify'; });`,
          ),
        );
      if (p === '/logout/') {
        sessions.clear();
        log.push(u.searchParams.has('inactivity') ? 'idle-logout' : 'logout');
        return redirect(`/Areas/Access/Login${u.search}`);
      }
      // As Schwab's: the code is asked for in a frame; the top page says nothing about it.
      if (p === '/mfa/verify') return html(PAGE('Log in (fake Schwab)', '<iframe src="/mfa/frame" title="Login" width="600" height="300"></iframe>'));
      if (p === '/mfa/frame') return html(PAGE('Verify', '<p>We sent a security code to your phone. Enter the code.</p><input autocomplete="one-time-code" aria-label="Security code"><button>Continue</button>', STEP(p, '/api/code', '/clientapps/accounts/summary/')));
      if (!session(req) && (p.startsWith('/clientapps/') || p.startsWith('/app/') || p.startsWith('/api/export'))) {
        if (p.startsWith('/api/export')) exports.push({ layout: '?', mask: u.searchParams.get('mask') ?? '', from: '', to: '', ok: false });
        return redirect('/Areas/Access/Login');
      }
      if (p === '/clientapps/accounts/summary/') return html(PAGE('Accounts summary (fake Schwab)', ACCOUNTS.map((a) => `<p>${a.label}</p>`).join(''), APP_STEP(p)));
      if (p === '/app/security/passkeys/')
        return html(PAGE('Security Center (fake Schwab)', `<h2>Passkeys</h2><iframe src="${me.frameOrigin}/ui/passkeys" title="Passkeys" allow="publickey-credentials-create *; publickey-credentials-get *" width="500" height="120"></iframe>`, APP_STEP(p)));
      if (p === '/app/accounts/history/') return html(PAGE('History (fake Schwab)', HISTORY(ACCOUNTS), HISTORY_SCRIPT));
      if (p === '/app/accounts/realizedgainloss/') return html(PAGE('Realized Gain/Loss (fake Schwab)', REALIZED, REALIZED_SCRIPT));
      if (p === '/api/export') {
        const page = u.searchParams.get('page');
        const mask = u.searchParams.get('mask') ?? '';
        const a = ACCOUNTS.find((x) => x.mask === mask);
        if (!a) return new Response('no account', { status: 404 });
        const today = new Date().toISOString().slice(0, 10);
        const from = iso(u.searchParams.get('from') ?? '') || `${today.slice(0, 4)}-01-01`;
        const to = iso(u.searchParams.get('to') ?? '') || today;
        const layout = page === 'realized' ? 'realized' : a.layout;
        exports.push({ layout, mask, from, to, ok: true });
        if (u.searchParams.get('fmt') !== 'csv') return Response.json({ BrokerageTransactions: [] }, { headers: { 'content-disposition': `attachment; filename="Wrong_XXX${mask}.json"` } });
        const stamp = '20261110-101010';
        const name = layout === 'realized' ? `${a.label.split(' ')[0]}_XXX${mask}_GainLoss_Realized_${stamp}.csv` : `${a.label.split(' ')[0]}_XXX${mask}_Transactions_${stamp}.csv`;
        return new Response(exportCsv(layout, from, to), { headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${name}"` } });
      }
      if (p === '/') return redirect('/Areas/Access/Login');
      return new Response('not found', { status: 404 });
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  me.origin = `http://localhost:${server.port}`;
  me.frameOrigin = `http://localhost:${gateway.port}`;
  // The relying party is the site (rpId localhost); its ceremonies run in the widget's frame on the app's pages.
  me.rp = new FakeRp('localhost', me.frameOrigin, me.origin);
  me.push = (...s) => steps.push(...s);
  me.expire = () => {
    sessions.clear();
    pending.clear();
  };
  me.stop = () => {
    server.stop(true);
    gateway.stop(true);
  };
  return me;
}
