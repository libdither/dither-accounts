/**
 * A private headless Chromium driven over the DevTools protocol, for verifying the PWA and taking
 * screenshots. It has its own throwaway profile and HOME; pass caCert to trust the hub's private CA.
 * Uses no dependency beyond chromium itself (and nix for certutil).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Page {
  send<T = any>(method: string, params?: unknown): Promise<T>;
  eval<T = any>(expr: string): Promise<T>;
  goto(url: string): Promise<void>;
  shot(path: string): Promise<void>;
  size(width: number, height: number, mobile?: boolean): Promise<void>;
  until(expr: string, ms?: number): Promise<void>;
  errors: string[];
  on(method: string, fn: (params: any) => void): void;
  /** Evaluate in a service worker whose script URL contains this. */
  evalWorker<T = any>(url: string, expr: string): Promise<T>;
}

/** args: extra Chromium flags, e.g. a fake microphone for call tests. */
export async function launch(opts: { caCert?: string; host?: string; args?: string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dither-browser-'));
  if (opts.caCert) {
    const nss = join(home, '.pki/nssdb');
    mkdirSync(nss, { recursive: true });
    const run = (...cmd: string[]) => Bun.spawnSync(['nix', 'shell', 'nixpkgs#nss.tools', '-c', 'certutil', ...cmd], { stderr: 'pipe' });
    run('-N', '-d', `sql:${nss}`, '--empty-password');
    const r = run('-A', '-d', `sql:${nss}`, '-t', 'C,,', '-n', 'dither-chat', '-i', opts.caCert);
    if (r.exitCode !== 0) throw new Error('certutil failed: ' + r.stderr.toString());
  }
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = Bun.spawn(['chromium', '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(home, 'profile')}`, '--no-first-run', '--no-sandbox', '--disable-gpu', ...(opts.args ?? []), 'about:blank'], {
    env: { ...process.env, HOME: home },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  let targets: any[] = [];
  for (let i = 0; i < 100 && !targets.length; i++) {
    await Bun.sleep(200);
    targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json() as Promise<any[]>).catch(() => []);
  }
  const target = targets.find((t) => t.type === 'page');
  if (!target) throw new Error('chromium did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let seq = 0;
  const waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const listeners = new Map<string, ((p: any) => void)[]>();
  const errors: string[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id)!;
      waiting.delete(m.id);
      if (m.error) w.rej(new Error(`${m.error.message}`));
      else w.res(m.result);
    } else for (const fn of listeners.get(m.method) ?? []) fn(m.params);
  };
  const page: Page = {
    errors,
    on: (method, fn) => void listeners.set(method, [...(listeners.get(method) ?? []), fn]),
    send: (method, params) =>
      new Promise((res, rej) => {
        const id = ++seq;
        waiting.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    async eval(expr) {
      const r = await page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async evalWorker(url, expr) {
      const all = (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())) as any[];
      const t = all.find((x) => x.type === 'service_worker' && x.url.includes(url));
      if (!t) throw new Error(`no service worker at ${url}`);
      const sw = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => ((sw.onopen = res), (sw.onerror = rej)));
      try {
        const answer = new Promise<any>((res) => (sw.onmessage = (e) => JSON.parse(String(e.data)).id === 1 && res(JSON.parse(String(e.data)))));
        sw.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
        const r = await answer;
        if (r.error || r.result?.exceptionDetails) throw new Error(r.error?.message ?? r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
        return r.result.result.value;
      } finally {
        sw.close();
      }
    },
    async goto(url) {
      await page.send('Page.navigate', { url });
      await Bun.sleep(300);
    },
    async shot(path) {
      await Bun.sleep(250);
      const r = await page.send('Page.captureScreenshot', { format: 'png' });
      await Bun.write(path, Buffer.from(r.data, 'base64'));
    },
    async size(width, height, mobile = false) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    },
    async until(expr, ms = 8000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await page.eval(expr).catch(() => false)) return;
        await Bun.sleep(100);
      }
      throw new Error(`timed out waiting for: ${expr}`);
    },
  };
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  page.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
  page.on('Log.entryAdded', (p) => p.entry?.level === 'error' && errors.push(p.entry.text));
  await page.send('Log.enable');
  return {
    page,
    /** The browser's own directory: every one of its processes has it on the command line. */
    profileDir: home,
    async close() {
      ws.close();
      proc.kill();
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
