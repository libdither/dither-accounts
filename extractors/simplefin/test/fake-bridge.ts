/**
 * A fake SimpleFIN Bridge for tests: `POST /claim/<token>` answers an access URL once, `GET /simplefin/accounts`
 * (Basic auth) answers RESPONSES[i] for the i-th request since the last reset, written the way a server might write
 * JSON (compact, raw UTF-8, floats like 1.10 and 1E5, integers past 2^53, integer-like keys), so that only a writer
 * that does what Python's json does gets dither-finance's bytes. No real data.
 */
export const USER = 'demo-user';
export const PASS = 'p@ss/word';

const tx = (id: string, posted: number, amount: string, description: string, extra = '') =>
  `{"id":"${id}","posted":${posted},"amount":"${amount}","description":${JSON.stringify(description)},"payee":"Café \\u2603","memo":"","transacted_at":${posted - 60}${extra}}`;

/** Window 0 and 1 have transactions; window 2 has none (the pull stops there). */
export const RESPONSES = [
  `{"errors":[],"errlist":[{"code":"gen.auth","msg":"Re-authenticate \\"Bank\\"","conn_id":"CON-1"}],"connections":[{"conn_id":"CON-1","name":"Example Bank","org_id":"ORG-1","org_url":"https://bank.example/","sfin_url":"https://bridge.example/simplefin"}],` +
    `"accounts":[{"id":"ACT-1","name":"Checking — 💳","conn_id":"CON-1","currency":"USD","balance":"100.25","available-balance":"100.25","balance-date":1762675200,"transactions":[${tx('TRN-1', 1762588800, '-12.50', 'COFFEE\tSHOP\n#12')},${tx('TRN-2', 1762502400, '1000.00', 'PAYROLL über', ',"pending":true,"extra":{"10":"ten","2":"two","a":[1.10,1E5,-0,12345678901234567890,0.00001,1e16,2.5e-3,[],{}]}')}],"holdings":[]},` +
    `{"id":"ACT-2","name":"Card","conn_id":"CON-1","currency":"USD","balance":"-5.00","available-balance":"995.00","balance-date":1762675200,"transactions":[],"holdings":[]}]}`,
  `{"errors":["a warning"],"errlist":[],"connections":[{"conn_id":"CON-1","name":"Example Bank","org_id":"ORG-1"}],"accounts":[{"id":"ACT-1","name":"Checking","conn_id":"CON-1","currency":"USD","balance":"100.25","available-balance":"100.25","balance-date":1762675200,"transactions":[${tx('TRN-0', 1759000000, '-3.00', 'older / slash')}],"holdings":[]}]}`,
  `{"errors":[],"errlist":[],"connections":[],"accounts":[{"id":"ACT-1","name":"Checking","conn_id":"CON-1","currency":"USD","balance":"100.25","available-balance":"100.25","balance-date":1762675200,"transactions":[],"holdings":[]}]}`,
];

export class FakeBridge {
  server: ReturnType<typeof Bun.serve> | null = null;
  n = 0;
  /** Each GET's query (start-date, end-date, pending, version) and whether its auth was right. */
  requests: { query: Record<string, string>; authOk: boolean; ua: string | null }[] = [];
  claimed = new Set<string>();
  /** Answer this status instead (402, 403, 500). */
  failWith: number | null = null;
  /** Answer GETs this much later. */
  delayMs = 0;
  constructor(readonly port = 0) {}
  get url() {
    return `http://127.0.0.1:${this.server!.port}`;
  }
  get accessUrl() {
    return `http://${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}@127.0.0.1:${this.server!.port}/simplefin`;
  }
  setupToken(name = 'tok1') {
    return Buffer.from(`${this.url}/claim/${name}`).toString('base64');
  }
  reset() {
    this.n = 0;
    this.requests = [];
  }
  start() {
    this.server = Bun.serve({
      port: this.port,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const u = new URL(req.url);
        const m = u.pathname.match(/^\/claim\/(\w+)$/);
        if (m && req.method === 'POST') {
          if (this.claimed.has(m[1])) return new Response('Forbidden', { status: 403 });
          this.claimed.add(m[1]);
          return new Response(this.accessUrl + '\n');
        }
        if (u.pathname === '/simplefin/accounts') {
          const authOk = req.headers.get('authorization') === `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
          this.requests.push({ query: Object.fromEntries(u.searchParams), authOk, ua: req.headers.get('user-agent') });
          if (!authOk) return new Response('Forbidden', { status: 403 });
          if (this.delayMs) await Bun.sleep(this.delayMs);
          if (this.failWith) return new Response('no', { status: this.failWith });
          const body = RESPONSES[Math.min(this.n++, RESPONSES.length - 1)];
          return new Response(body, { headers: { 'content-type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    return this;
  }
  stop() {
    this.server?.stop(true);
  }
}
