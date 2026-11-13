/**
 * A stand-in for account.venmo.com on http://localhost:<port>, enough for a statements pull: a sign-in page, the app,
 * /statement (which, signed in, puts ?profileId=… in its URL the way Venmo's app does), and
 * /api/statement/download-v2 answering {"jsonData": "<CSV>"} in Venmo's statement layout. The CSVs are made to catch a
 * writer that is not venmo.py's: non-ASCII and astral characters, quoted commas, doubled quotes and a newline inside
 * a field, CRLF and LF. Years before 2024 have no activity, so a backfill stops after 2023 and 2022.
 *
 * Steps the test pushes, each done by the page where it is (nothing here clicks): `signin` on /signin.
 * `expire()` ends every session (Venmo's 30 idle minutes); `bump(end)` adds a row to the statement ending then.
 */
export const PROFILE_ID = '2468013579';

export interface FakeVenmo {
  origin: string;
  /** Every statement request: start, end, and whether it came signed in with the right profile. */
  requests: { start: string; end: string; ok: boolean; query: string[] }[];
  log: string[];
  push(...steps: string[]): void;
  expire(): void;
  /** One more row in the statement that ends on `end` (this month's, today). */
  bump(end: string): void;
  stop(): void;
}

const header =
  ',ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer';
const blank = (n: number) => ','.repeat(n);

/** The statement CSV for a range: rows on the 3rd of each month from 2024 on (and `extra` more in the last month). */
export function csvFor(start: string, end: string, extra = 0): string {
  const rows: string[] = [];
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    if (y < 2024) continue;
    const day = `${y}-${String(m).padStart(2, '0')}-03`;
    if (day < start || day > end) continue;
    const id = `4${y}${String(m).padStart(2, '0')}0300001`;
    rows.push(`,${id},${day}T18:22:01,Payment,Complete,"Tacos 🌮, crème brûlée ""again""",Test User,Ann Lee,- $12.50,,0,,0,,Venmo balance,,,,,Venmo,,`);
    rows.push(`,${id.slice(0, -1)}2,${day}T19:02:44,Payment,Complete,"rent
split",Bo Chen,Test User,+ $400.00,,0,,0,,,Venmo balance,,,,Venmo,,`);
  }
  for (let i = 0; i < extra; i++) rows.push(`,49999000${i},${end}T08:00:00,Standard Transfer,Issued,,,,- $5.00,,0,$0.00,0,,,Bank *1234,,,,,,`);
  const lines = [
    `Account Statement - (@Test-User) ${blank(21)}`,
    `Account Activity${blank(21)}`,
    header,
    `${blank(16)}$10.00${blank(5)}`,
    ...rows,
    `${blank(17)}$22.00${blank(4)}`,
    `In case of errors or questions about your electronic transfers: ☎ 855-812-4430${blank(21)}`,
  ];
  // Venmo's own files mix line ends; so does this one.
  return lines.join('\n').replace('Account Activity' + blank(21) + '\n', 'Account Activity' + blank(21) + '\r\n') + '\n';
}

const PAGE = (title: string, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><script>${script}</script></body></html>`;

const SIGNIN_SCRIPT = `
let busy = false;
async function step() {
  if (busy) return; busy = true;
  try {
    const next = await fetch('/api/next?path=' + encodeURIComponent(location.pathname)).then(r => r.json());
    if (next.action === 'signin') { await fetch('/api/signin', { method: 'POST' }); location.href = '/'; return; }
  } catch (e) {} finally { busy = false; }
}
setInterval(step, 300); step();`;

export function startFakeVenmo(): FakeVenmo {
  const sessions = new Set<string>();
  const steps: string[] = [];
  const log: string[] = [];
  const requests: FakeVenmo['requests'] = [];
  const extra = new Map<string, number>();
  const session = (req: Request) => {
    const m = /(?:^|;\s*)v_session=([\w-]+)/.exec(req.headers.get('cookie') ?? '');
    return m && sessions.has(m[1]) ? m[1] : null;
  };
  const login = () => {
    const id = crypto.randomUUID();
    sessions.add(id);
    return `v_session=${id}; Path=/; HttpOnly; SameSite=Lax`;
  };
  const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) } });
  const redirect = (to: string, cookie?: string) => new Response(null, { status: 302, headers: { location: to, ...(cookie ? { 'set-cookie': cookie } : {}) } });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      if (p === '/test-login') return redirect('/', login());
      if (p === '/api/next') {
        const want = steps[0];
        if (want === 'signin' && u.searchParams.get('path') === '/signin') {
          steps.shift();
          return Response.json({ action: 'signin' });
        }
        return Response.json({ action: null });
      }
      if (p === '/api/signin' && req.method === 'POST') {
        log.push('signin');
        return new Response('{}', { headers: { 'set-cookie': login(), 'content-type': 'application/json' } });
      }
      if (p === '/signin') return html(PAGE('Venmo sign in (fake)', SIGNIN_SCRIPT));
      if (p === '/') return session(req) ? html(PAGE('Venmo (fake)')) : redirect('/signin');
      if (p === '/statement') {
        if (!session(req)) return redirect('/signin');
        return html(
          PAGE(
            'Statements (fake)',
            `setTimeout(() => { if (!location.search.includes('profileId')) history.replaceState(null, '', '/statement?profileId=${PROFILE_ID}&accountType=personal'); }, 300);`,
          ),
        );
      }
      if (p === '/api/statement/download-v2') {
        const q = u.searchParams;
        const ok = !!session(req) && q.get('profileId') === PROFILE_ID && q.get('accountType') === 'personal' && q.get('csv') === 'true';
        const start = q.get('startDate') ?? '';
        const end = q.get('endDate') ?? '';
        requests.push({ start, end, ok, query: [...q.keys()] });
        if (!ok) return Response.json({ error: 'unauthorized' }, { status: 401 });
        return Response.json({ jsonData: csvFor(start, end, extra.get(end) ?? 0) });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    origin: `http://localhost:${server.port}`,
    requests,
    log,
    push: (...s) => steps.push(...s),
    expire: () => sessions.clear(),
    bump: (end) => {
      extra.set(end, (extra.get(end) ?? 0) + 1);
    },
    stop: () => server.stop(true),
  };
}
