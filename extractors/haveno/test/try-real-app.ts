/**
 * By hand: the real haveno-desktop in the sandbox on the node's data, up to its login screen, with a screenshot,
 * then closes it (a close request). Stop the daemon first (its API's ShutdownServer.Stop). Usage: bun try-real-app.ts <scratch dir>
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HavenoApp } from '../src/app.ts';

const out = process.argv[2];
let exited: number | null | undefined;
const app = new HavenoApp({
  accountDir: join(out, 'account'),
  dataDir: join(homedir(), '.local/share/Haveno-reto'),
  log: (l, m) => console.log(l, m),
  onChange: () => {},
  onExit: (c) => (exited = c),
});
await app.start();
const lv = app.liveView()!;
console.log('live view', lv);
await Bun.sleep(Number(process.env.WAIT_MS ?? 45000));
const d = (app as any).display;
spawnSync('import', ['-window', 'root', join(out, 'shot.png')], { env: { DISPLAY: `:${d}`, PATH: process.env.PATH } });
console.log('screenshot taken; quitting');
app.quit();
for (let i = 0; i < 60 && exited === undefined; i++) await Bun.sleep(500);
console.log('exited', exited);
if (exited === undefined) await app.kill();
process.exit(0);
