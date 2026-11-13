/**
 * A homeserver connection that can be broken on purpose, for tests: an HTTP proxy in front of
 * the testbed. Point an adapter's "homeserver" at `url` and change `rule` while it runs.
 *
 *   pass   forward as usual
 *   hang   accept and never answer, like a connection that died without a reset (the client times out)
 *   reset  close the connection mid-answer (the client sees a network error at once)
 *
 * `refuse(ms)` stops listening altogether for a while: connection refused, open connections cut.
 */

export type Rule = 'pass' | 'hang' | 'reset';

export class FlakyProxy {
  /** Decides each request as it arrives. */
  rule: (method: string, path: string) => Rule = () => 'pass';
  readonly log: { at: number; method: string; path: string; rule: Rule | 'refused' }[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port = 0;

  constructor(readonly target: string) {
    this.target = target.replace(/\/+$/, '');
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  start(): this {
    this.server = Bun.serve({
      port: this.port,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      error: () => new Response(null, { status: 500 }),
      fetch: async (req) => {
        const u = new URL(req.url);
        const rule = this.rule(req.method, u.pathname);
        this.log.push({ at: Date.now(), method: req.method, path: u.pathname, rule });
        if (rule === 'hang') {
          await new Promise<void>((r) => req.signal.addEventListener('abort', () => r(), { once: true }));
          return new Response(null, { status: 499 });
        }
        if (rule === 'reset') return new Response(new ReadableStream({ start: (c) => c.error(new Error('reset by the test')) }));
        const headers = new Headers(req.headers);
        headers.delete('host');
        try {
          const res = await fetch(this.target + u.pathname + u.search, {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
            signal: req.signal,
            redirect: 'manual',
          });
          const out = new Headers(res.headers);
          out.delete('content-encoding');
          out.delete('content-length');
          return new Response(await res.arrayBuffer(), { status: res.status, headers: out });
        } catch {
          return new Response(new ReadableStream({ start: (c) => c.error(new Error('upstream failed')) }));
        }
      },
    });
    this.port = this.server.port ?? 0;
    return this;
  }

  /** Connection refused for `ms`, and every open connection cut now. */
  async refuse(ms: number) {
    this.server?.stop(true);
    this.server = null;
    this.log.push({ at: Date.now(), method: '*', path: '*', rule: 'refused' });
    await Bun.sleep(ms);
    this.start();
  }

  stop() {
    this.server?.stop(true);
    this.server = null;
  }
}
