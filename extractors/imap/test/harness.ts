/**
 * A throwaway manager with the imap kind (and only it), an app on it that may read
 * and write mail, and helpers to add accounts as the page does and to wait for their events and status.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mail } from '@dither-accounts/interfaces';
import { AccountsClient, register } from '@dither-accounts/client';
import { createManager, kindOf, type Manager, type Manifest } from '@dither-accounts/manager';

export const ROOT = resolve(import.meta.dir, '../../..');
export const IMAP_DIR = join(ROOT, 'extractors/imap');

export async function imapManifest(): Promise<Manifest> {
  return (await import(join(IMAP_DIR, 'manifest.ts'))).default as Manifest;
}

export type Ev = { account: string; t: string; [k: string]: any };

export class Harness {
  m!: Manager;
  dir!: string;
  app!: AccountsClient;
  events: Ev[] = [];

  async start() {
    this.dir = mkdtempSync(join(tmpdir(), 'dacc-imap-mgr-'));
    const kind = kindOf(await imapManifest(), IMAP_DIR);
    this.m = await createManager({ openPage: true, dataDir: this.dir, port: 0, kinds: new Map([[kind.kind, kind]]) });
    const reg = await register(this.m.url, { name: 'mail-test', requests: [{ interface: 'mail', level: 'write', kinds: ['imap'] }] });
    const st = (await (await fetch(`${this.m.url}/api/state`)).json()) as any;
    for (const app of st.apps) for (const r of app.requests) if (r.state === 'pending') await fetch(`${this.m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
    this.app = new AccountsClient({ url: this.m.url, app: reg.app, token: reg.token, onEvents: (account, evs) => this.events.push(...evs.map((e) => ({ ...e, account }) as Ev)) });
    await until(() => this.app.connected, 5000, 'the app connected');
  }

  async stop() {
    this.app?.close();
    await this.m?.stop();
    if (this.dir && !process.env.KEEP_IMAP_TEST) rmSync(this.dir, { recursive: true, force: true });
  }

  /** POST /api/accounts, as the page does. */
  async add(config: Record<string, unknown>, password: string | null, label = 'Mail'): Promise<string> {
    const r = await fetch(`${this.m.url}/api/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'imap', label, config, secret: password === null ? {} : { password } }) });
    const j = (await r.json()) as any;
    if (!r.ok) throw new Error(`add: ${j.error}`);
    return j.id;
  }

  async detail(id: string): Promise<any> {
    return (await fetch(`${this.m.url}/api/accounts/${id}`)).json();
  }
  async layer(id: string, name: string): Promise<{ state: string; note?: string } | undefined> {
    return ((await this.detail(id)).layers ?? []).find((l: any) => l.name === name);
  }
  /** Restart it and wait until the new process is online (not the old one's last status). */
  async restart(id: string, ms = 30_000) {
    const t = Date.now();
    await fetch(`${this.m.url}/api/accounts/${id}/restart`, { method: 'POST' });
    await this.waitOnline(id, ms, t);
  }
  async enable(id: string, enabled: boolean) {
    await fetch(`${this.m.url}/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
  }
  accountDir(id: string): string {
    return this.m.store.account(id)!.dir as string;
  }

  call<K extends keyof typeof mail.ops & string>(account: string, op: K, input: any): Promise<any> {
    return this.app.call(mail, account, op as any, standIn(op, input));
  }
  /** The call's failure: its CallFailed (code, status), or a throw if it succeeded. */
  async fails(account: string, op: string, input: any): Promise<{ code: string; status?: number; message: string }> {
    try {
      await this.app.callRaw(account, op, standIn(op, input), 60_000);
    } catch (e: any) {
      return { code: e.code, status: e.status, message: e.message };
    }
    throw new Error(`${op} did not fail`);
  }

  /** Online with IDLE running; with `since`, from a process started after it. */
  async waitOnline(id: string, ms = 30_000, since = 0) {
    await until(
      async () => {
        const d = await this.detail(id);
        return d.account.online && (d.hello?.startedAt ?? 0) >= since && d.status?.status === 'online' && d.layers?.find((l: any) => l.name === 'IDLE')?.state === 'ok';
      },
      ms,
      `${id} online`,
    );
  }

  /** The first event matching, from `from` (an index into events) on. */
  async event(pred: (e: Ev) => boolean, ms = 15_000, from = 0): Promise<Ev> {
    let hit: Ev | undefined;
    await until(() => !!(hit = this.events.slice(from).find(pred)), ms, 'an event');
    return hit!;
  }
}

/**
 * The manager overwrites an input `id` with its own call id, so mail.get and mail.attachment also send the message id
 * as `message` (src/main.ts messageArg) until that is fixed.
 */
export function standIn(op: string, input: any) {
  return (op === 'mail.get' || op === 'mail.attachment') && input?.id !== undefined && input.message === undefined ? { ...input, message: input.id } : input;
}

export async function until(f: () => unknown | Promise<unknown>, ms: number, what: string) {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      if (await f()) return;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ''}`);
}
export { simpleParser } from 'mailparser';
