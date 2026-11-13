/**
 * A real CalDAV/CardDAV server for the tests: Radicale from nixpkgs (RADICALE_BIN to use another), in a temporary
 * directory, htpasswd (plain) users, and rights where each user owns their collections except `<user>/holidays`,
 * which they may only read. Collections are seeded on disk before it starts; `as(user)` is a second client that
 * changes things behind the extractor's back.
 */
import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bin: string | null = process.env.RADICALE_BIN ?? null;
export function radicaleBin(): string {
  if (bin) return bin;
  const r = Bun.spawnSync(['nix', 'build', 'nixpkgs#radicale', '--no-link', '--print-out-paths'], { stdout: 'pipe', stderr: 'pipe' });
  const out = r.stdout.toString().trim().split('\n').pop();
  if (r.exitCode !== 0 || !out) throw new Error(`nix build nixpkgs#radicale failed: ${r.stderr.toString().slice(-500)}`);
  bin = join(out, 'bin', 'radicale');
  return bin;
}

export interface Seed {
  /** user → collection name → what it is. */
  [user: string]: Record<string, { tag: 'VCALENDAR' | 'VADDRESSBOOK'; name?: string; color?: string; components?: string; items?: Record<string, string> }>;
}

export class Radicale {
  readonly dir: string;
  readonly url: string;
  private proc: Subprocess | null = null;

  constructor(
    readonly port: number,
    readonly users: Record<string, string>,
    seed: Seed = {},
  ) {
    this.dir = mkdtempSync(join(tmpdir(), 'dacc-radicale-'));
    this.url = `http://127.0.0.1:${port}`;
    writeFileSync(join(this.dir, 'users'), Object.entries(users).map(([u, p]) => `${u}:${p}`).join('\n') + '\n');
    writeFileSync(
      join(this.dir, 'rights'),
      [
        '[root]\nuser: .+\ncollection:\npermissions: R',
        '[principal]\nuser: .+\ncollection: {user}\npermissions: RW',
        '[readonly]\nuser: .+\ncollection: {user}/holidays\npermissions: r',
        '[collections]\nuser: .+\ncollection: {user}/[^/]+\npermissions: rw',
      ].join('\n\n') + '\n',
    );
    writeFileSync(
      join(this.dir, 'config'),
      [
        '[server]',
        `hosts = 127.0.0.1:${port}`,
        '[auth]',
        'type = htpasswd',
        `htpasswd_filename = ${join(this.dir, 'users')}`,
        'htpasswd_encryption = plain',
        'delay = 0',
        '[rights]',
        'type = from_file',
        `file = ${join(this.dir, 'rights')}`,
        '[storage]',
        `filesystem_folder = ${join(this.dir, 'collections')}`,
        '[web]',
        'type = none',
        '[logging]',
        'level = warning',
      ].join('\n') + '\n',
    );
    for (const [user, colls] of Object.entries(seed)) {
      for (const [name, c] of Object.entries(colls)) {
        const d = join(this.dir, 'collections', 'collection-root', user, name);
        mkdirSync(d, { recursive: true });
        const props: Record<string, string> = { tag: c.tag };
        if (c.name) props['D:displayname'] = c.name;
        if (c.color) props['ICAL:calendar-color'] = c.color;
        if (c.tag === 'VCALENDAR') props['C:supported-calendar-component-set'] = c.components ?? 'VEVENT,VTODO';
        writeFileSync(join(d, '.Radicale.props'), JSON.stringify(props));
        for (const [file, text] of Object.entries(c.items ?? {})) writeFileSync(join(d, file), text);
      }
    }
  }

  async start() {
    if (this.proc && this.proc.exitCode === null) return;
    // Something else on the port (another run of these tests) would answer for us: refuse rather than test it.
    const taken = await fetch(`${this.url}/`, { redirect: 'manual', signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    if (taken) throw new Error(`port ${this.port} is already in use (another test run?); not starting Radicale on it`);
    this.proc = Bun.spawn([radicaleBin(), '--config', join(this.dir, 'config')], { stdout: Bun.file(join(this.dir, 'radicale.log')), stderr: Bun.file(join(this.dir, 'radicale.err')) });
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      if (this.proc.exitCode !== null) throw new Error(`radicale exited (${this.proc.exitCode}): ${await Bun.file(join(this.dir, 'radicale.err')).text()}`);
      try {
        const r = await fetch(`${this.url}/.well-known/caldav`, { redirect: 'manual' });
        if (r.status > 0) return;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error(`radicale did not start: ${existsSync(join(this.dir, 'radicale.err')) ? await Bun.file(join(this.dir, 'radicale.err')).text() : ''}`);
  }

  async stop() {
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null) return;
    p.kill('SIGTERM');
    const t = setTimeout(() => p.kill('SIGKILL'), 5000);
    await p.exited;
    clearTimeout(t);
  }

  async close() {
    await this.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** A plain HTTP client signed in as `user`, for changes the extractor did not make. */
  as(user: string) {
    const auth = `Basic ${Buffer.from(`${user}:${this.users[user]}`).toString('base64')}`;
    const req = async (method: string, path: string, body?: string, headers: Record<string, string> = {}) => {
      const r = await fetch(this.url + path, { method, body, headers: { authorization: auth, ...headers } });
      return { status: r.status, etag: r.headers.get('etag'), text: await r.text() };
    };
    return {
      req,
      put: (path: string, text: string, type = path.endsWith('.vcf') ? 'text/vcard' : 'text/calendar', headers: Record<string, string> = {}) => req('PUT', path, text, { 'content-type': type, ...headers }),
      get: (path: string) => req('GET', path),
      del: (path: string, headers: Record<string, string> = {}) => req('DELETE', path, undefined, headers),
    };
  }
}

export const ics = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
export const vcf = (...lines: string[]) => ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD', ''].join('\r\n');
