/** A fake account for the manager's tests: the `test.echo` interface over the real extractor wire. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkManager, StatusError } from '@dither-accounts/link';

/**
 * Its dependency chain (status.layers): process → session → echo, all ok. config.failLayer names one to fail (with
 * config.failNote), and the ones after it wait; config.noLayers sends none.
 */
function layers(config: Record<string, any>) {
  if (config.noLayers) return {};
  const names = ['process', 'session', 'echo'];
  const notes: Record<string, string> = { process: `pid ${process.pid}`, session: 'always signed in', echo: 'answers at once' };
  const at = names.indexOf(String(config.failLayer ?? ''));
  return {
    layers: names.map((name, i) =>
      at < 0 || i < at
        ? { name, state: 'ok', note: notes[name] }
        : i === at
          ? { name, state: 'failed', note: String(config.failNote ?? 'failed on purpose (config.failLayer)') }
          : { name, state: 'waiting', note: `waits for ${names[at]}` },
    ),
  };
}

function crashWith(message: string): never {
  throw new TypeError(message);
}

/**
 * config.children: start what a real extractor starts (a browser, Xvfb), here two `sleep`s: one in its process group,
 * one in a session of its own, as a sandbox or a browser's zygote may be. A stop must end both (docs/supervisor.md).
 */
const children: number[] = [];
const startConfig = JSON.parse(process.env.DITHER_ACCOUNT_CONFIG || '{}') as { children?: boolean; tick?: number; slowExit?: number };
if (startConfig.children) {
  for (const detached of [false, true]) children.push(Bun.spawn(['sleep', '3600'], { stdio: ['ignore', 'ignore', 'ignore'], detached }).pid);
  // A third with no environment at all, in a session of its own, as bubblewrap starts a native app's Xvfb: only its
  // sandbox.json (packages/sandbox) says it is this account's.
  const bare = Bun.spawn(['env', '-i', 'sleep', '3601'], { stdio: ['ignore', 'ignore', 'ignore'], detached: true, env: {} });
  children.push(bare.pid);
  const dir = join(process.env.DITHER_ACCOUNT_DIR!, 'app');
  mkdirSync(dir, { recursive: true });
  await Bun.sleep(100); // env has exec'd sleep by then
  const stat = readFileSync(`/proc/${bare.pid}/stat`, 'utf8');
  writeFileSync(join(dir, 'sandbox.json'), JSON.stringify({ procs: [{ name: 'sleep', pid: bare.pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], match: 'sleep 3601' }] }), { mode: 0o600 });
}

let ticks = 0;
const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', version: '1', label: link.label });
    // config.vncSocket: pretend to offer a live view on that Unix socket (the page's live view proxy test).
    const lv = typeof link.config.vncSocket === 'string' ? { liveView: { vncSocket: link.config.vncSocket, width: 800, height: 600 } } : {};
    // config.crash: end at once (the manager's notices count crashes); config.attention: say it needs you, with that
    // message (and config.attentionKind, and config.attentionStatus: a passing state such as connecting).
    if (link.config.crash) process.exit(3);
    // config.throw: crash with an uncaught TypeError of that message (the manager's error file records it).
    if (typeof link.config.throw === 'string') setTimeout(() => crashWith(String(link.config.throw)));
    const at = typeof link.config.attention === 'string' ? { status: String(link.config.attentionStatus ?? 'attention'), attention: { kind: String(link.config.attentionKind ?? 'login'), message: link.config.attention } } : { status: 'online' };
    link.emit({ t: 'status', ...at, self: { displayName: 'Fake', handle: 'fake-one' }, ...lv, ...layers(link.config) });
    link.log('info', 'fake extractor up');
  },
    // config.slowExit: a shutdown takes that long (an extractor closing its browser).
  onShutdown: async () => {
    if (startConfig.slowExit) await Bun.sleep(startConfig.slowExit);
  },
  async onCommand(cmd) {
    switch (cmd.t) {
      case 'echo':
        return { text: cmd.text };
      case 'echoId':
        return { id: cmd.id ?? null };
      case 'shout':
        return { text: String(cmd.text).toUpperCase() };
      case 'fail':
        throw new StatusError(`failed with ${cmd.status}`, Number(cmd.status), typeof cmd.code === 'string' ? cmd.code : undefined);
      case 'slow':
        await Bun.sleep(Number(cmd.ms));
        return { slept: cmd.ms };
      case 'pid':
        return { pid: process.pid, children };
      case 'exit':
        // End with that code soon after answering (an adopted extractor's exit code: docs/supervisor.md).
        setTimeout(() => process.exit(Number(cmd.code ?? 0)), 50);
        return { exiting: true };
      case 'emit':
        for (let i = 0; i < Number(cmd.n); i++) link.emit({ t: 'note', n: i });
        return { emitted: cmd.n };
      default:
        throw new Error(`unknown op ${cmd.t}`);
    }
  },
});

// config.tick: a note every that many ms, numbered from 0, whether a manager is there or not (they wait in the link).
if (startConfig.tick) setInterval(() => link.emit({ t: 'note', n: ticks++ }), startConfig.tick);
