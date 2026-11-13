/**
 * A stand-in for the `t3` command line, for tests: what the t3 extractor runs (`auth session issue|revoke`,
 * `thread send`), answered through the fake server's /_ctl routes (fake-t3-server.ts), which it finds as the real one
 * does: `--base-dir` (or $T3CODE_HOME), then userdata/server-runtime.json. Each call is appended to
 * `<base dir>/cli-calls.ndjson`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const all = (name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]!] : []));
const baseDir = flag('--base-dir') ?? process.env.T3CODE_HOME;
if (!baseDir) {
  console.error('No running T3 Code server (the fake needs --base-dir).');
  process.exit(1);
}
appendFileSync(join(baseDir, 'cli-calls.ndjson'), `${JSON.stringify(argv)}\n`);
const { origin } = JSON.parse(readFileSync(join(baseDir, 'userdata', 'server-runtime.json'), 'utf8'));
const ctl = async (op: string, body: unknown) => {
  const r = await fetch(`${origin}/_ctl/${op}`, { method: 'POST', body: JSON.stringify(body) });
  const j = (await r.json()) as any;
  if (!r.ok) {
    console.error(j.error ?? `HTTP ${r.status}`);
    process.exit(1);
  }
  return j;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--') && !['--json', '--wait', '--token-only'].includes(argv[i - 1]!)));
const [group, sub, verb] = positional;

if (group === 'auth' && sub === 'session' && verb === 'issue') {
  console.log(JSON.stringify(await ctl('issue', { subject: flag('--subject'), scopes: all('--scope'), label: flag('--label'), ttl: flag('--ttl') })));
} else if (group === 'auth' && sub === 'session' && verb === 'revoke') {
  await ctl('revoke', { sessionId: positional[3] });
  console.log('Revoked.');
} else if (group === 'thread' && sub === 'send') {
  const [threadId, message] = positional.slice(2);
  const text = message === '-' ? await new Response(Bun.stdin.stream()).text() : message;
  console.log(JSON.stringify(await ctl('send', { threadId, message: text })));
} else {
  console.error(`the fake t3 does not do: ${argv.join(' ')}`);
  process.exit(2);
}
