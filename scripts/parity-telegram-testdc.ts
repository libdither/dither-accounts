/**
 * The composition parity suite against Telegram's test DC (docs/telegram.md, "Test DC parity testing"): the real
 * extractor signed in as one test account, a bare mtcute client as the other, every scenario of
 * test/chat-parity/scenarios.ts run both ways (each sequence by the extractor's account and by the other person), and
 * the extractor's view compared with the network's after every step.
 *
 *   TELEGRAM_API_ID=… TELEGRAM_API_HASH=… bun scripts/parity-telegram-testdc.ts [--dc 2] [--chat group|dm|both]
 *     [--state-dir <dir>] [--capture <dir>] [--keep] [--creds-file <file>] [--only <words>] [--converge-ms 20000]
 *
 * --state-dir keeps the two test accounts' sessions (0600) so later runs sign in once; without it each run picks
 * numbers afresh. --capture writes each run's commands and events, anonymized and leak-checked, as golden traces.
 * --keep leaves the extractor's account directory and the supergroup. Nothing here touches a real account: test DC
 * numbers only (+99966…), and the credentials are never logged.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { scrubTrace } from '@dither-accounts/manager/wire-capture';
import { runScenario, scenarioRuns } from '../test/chat-parity/harness.ts';
import { compositionScenarios } from '../test/chat-parity/scenarios.ts';
import { type ChatMode, createTestDcDriver, DEFAULT_TEST_DC, readCreds, TEST_DCS } from '../test/chat-parity/telegram-testdc-oracle.ts';

const { values: a } = parseArgs({
  options: {
    dc: { type: 'string', default: String(DEFAULT_TEST_DC) },
    chat: { type: 'string', default: 'both' },
    'state-dir': { type: 'string' },
    capture: { type: 'string' },
    keep: { type: 'boolean', default: false },
    'creds-file': { type: 'string' },
    only: { type: 'string' },
    'converge-ms': { type: 'string', default: '20000' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (a.help) {
  console.log('bun scripts/parity-telegram-testdc.ts [--dc 2] [--chat group|dm|both] [--state-dir <dir>] [--capture <dir>] [--keep] [--creds-file <file>] [--only <words>]');
  process.exit(0);
}
const dc = Number(a.dc);
if (!(TEST_DCS as readonly number[]).includes(dc)) throw new Error(`--dc is 1, 2 or 3, not ${a.dc}`);
const modes: ChatMode[] = a.chat === 'both' ? ['group', 'dm'] : a.chat === 'group' || a.chat === 'dm' ? [a.chat] : (() => { throw new Error('--chat is group, dm or both'); })();
const creds = readCreds({ file: a['creds-file'] });
const convergeMs = Number(a['converge-ms']);
const log = (l: string) => console.log(`  ${l}`);

let failed = 0;
let passed = 0;
for (const chat of modes) {
  console.log(`\n== test DC ${dc}, ${chat === 'group' ? 'a supergroup' : 'a private chat'}`);
  const d = await createTestDcDriver({ creds, dc, chat, stateDir: a['state-dir'], keep: a.keep, log });
  try {
    for (const s of compositionScenarios()) {
      if (a.only && !s.name.includes(a.only)) continue;
      if (!scenarioRuns(d, s)) {
        console.log(`skip ${s.name}`);
        continue;
      }
      const t0 = Date.now();
      try {
        await runScenario(d, s, { convergeMs, ...(process.env.PARITY_LOG ? { log } : {}) });
        passed++;
        console.log(`ok   ${s.name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${s.name}\n${(e as Error).message.split('\n').map((l) => `     ${l}`).join('\n')}`);
      }
    }
  } finally {
    await d.stop();
    if (a.capture) {
      mkdirSync(a.capture, { recursive: true });
      // Anonymized (ids, numbers, times and text swapped for synthetic ones) and swept; a leak throws, nothing is written.
      const { json } = scrubTrace(d.trace);
      const file = join(a.capture, `telegram-testdc-${chat}.json`);
      writeFileSync(file, `${json}\n`);
      console.log(`  trace: ${file} (${d.trace.length} records)`);
    }
    if (a.keep) console.log(`  kept the extractor's account directory: ${d.dir}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

