/**
 * dither-accounts: one place for your signed-in accounts. Extractors (this repo's extractors/) hold each account's
 * session; apps (dither-chat, dither-calendar) ask for interfaces on accounts, you approve, and the manager routes
 * their calls and the accounts' events between them, keeping none of it.
 *
 *   bun packages/manager/src/main.ts [--data .data] [--port 8486] [--host 127.0.0.1] [--public-url http://localhost:8486] [--web-dist dir] [--trace 1]
 *
 * Each setting comes from its flag, else DITHER_ACCOUNTS_<FLAG>, else the [manager] table of <data>/config.toml
 * (config.example.toml lists every key), else the default above. The data directory itself comes only from the flag,
 * the environment or the default.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createManager } from './index.ts';

const args = process.argv.slice(2);
const given = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : process.env[`DITHER_ACCOUNTS_${n.toUpperCase().replace(/-/g, '_')}`];
};
const root = resolve(import.meta.dir, '../../..');
const dataDir = resolve(given('data') ?? join(root, '.data'));
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });

/** <data>/config.toml's [manager] table, keys as in config.example.toml (public_url for --public-url). */
function readConfig(): Record<string, unknown> {
  const file = join(dataDir, 'config.toml');
  if (!existsSync(file)) return {};
  const parsed = Bun.TOML.parse(readFileSync(file, 'utf8')) as { manager?: Record<string, unknown> };
  return parsed.manager ?? {};
}
const config = readConfig();
const opt = (n: string, d: string): string => {
  const v = given(n) ?? config[n.replace(/-/g, '_')];
  return v === undefined || v === null ? d : String(v);
};

const port = Number(opt('port', '8486'));
const host = opt('host', '127.0.0.1');
const publicUrl = opt('public-url', `http://localhost:${port}`);
const webDist = opt('web-dist', '');
// trace = 0 (DITHER_ACCOUNTS_TRACE=0) turns the trace files off (trace.ts).
const m = await createManager({ dataDir, port, hostname: host, publicUrl, ...(webDist ? { webDist: resolve(webDist) } : {}), trace: !['0', 'false'].includes(opt('trace', '1')) });
console.log(`dither-accounts on ${m.url.replace('127.0.0.1', host)}  page=${publicUrl}  kinds=${[...m.kinds.keys()].join(',')}  data=${dataDir}`);

const shutdown = async () => {
  await m.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
