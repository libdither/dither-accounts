/**
 * The sandbox's own audio devices (AppSandboxOptions.audio): a private PulseAudio outside the sandbox, its socket shown
 * inside as the session's, with only the null sinks and remapped sources asked for; nothing of the machine's own sound.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pickFreeDisplay } from '@dither-accounts/browser';
import { sandbox, why } from '../../../test/needs.ts';
import { BINS, resolveBin } from '../src/bins.ts';
import { type AudioDevices, AppSandbox, pulseScript } from '../src/sandbox.ts';

const AUDIO: AudioDevices = {
  sinks: [
    { name: 'call_out', description: 'Call' },
    { name: 'mic_in', description: 'DeviceMic' },
  ],
  sources: [{ name: 'device_mic', from: 'mic_in', description: 'Microphone' }],
  defaultSink: 'call_out',
  defaultSource: 'device_mic',
};

test('the audio script loads only the sinks and sources asked for, and names no file of the machine', () => {
  const s = pulseScript({ ...AUDIO, sinks: [...AUDIO.sinks, { name: 'odd name;rm', description: 'A b' }] }, '/run/x/pulse.sock');
  expect(s.split('\n')[0]).toBe('load-module module-native-protocol-unix socket=/run/x/pulse.sock auth-anonymous=1');
  expect(s).toContain('load-module module-null-sink sink_name=call_out rate=48000 sink_properties=device.description=Call');
  expect(s).toContain('load-module module-remap-source source_name=device_mic master=mic_in.monitor');
  // Names and descriptions are kept to a safe alphabet: nothing reads as a second command or argument.
  expect(s).toContain('sink_name=odd_name_rm');
  expect(s).toContain('device.description=A_b');
  expect(s).toContain('set-default-sink call_out\nset-default-source device_mic\n');
  expect(s).not.toContain('.include');
});

const ok = why('the native-app sandbox with PulseAudio', sandbox);
const it = test.skipIf(!ok);

const root = mkdtempSync(join(tmpdir(), 'dacc-sbx-audio-'));
const dir = join(root, 'acct', 'desktop');
let sb: AppSandbox;

beforeAll(async () => {
  if (!ok) return;
  const pa = resolveBin(BINS.pulseaudio, () => {});
  const pactl = join(dirname(pa), 'pactl');
  const app = join(root, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'app.sh'),
    `out="$HOME/report.txt"
{
  echo "server=$PULSE_SERVER"
  echo "sinks=$(${pactl} list short sinks | cut -f2 | tr '\\n' ' ')"
  echo "sources=$(${pactl} list short sources | cut -f2 | tr '\\n' ' ')"
  echo "default=$(${pactl} get-default-sink) $(${pactl} get-default-source)"
  ${pactl} load-module module-null-sink sink_name=extra >/dev/null 2>&1 && echo "load=yes" || echo "load=refused"
} > "$out.tmp"
mv "$out.tmp" "$out"
exec sleep 600
`,
    { mode: 0o755 },
  );
  const free = await pickFreeDisplay();
  sb = new AppSandbox({
    dir,
    display: free,
    width: 640,
    height: 480,
    command: [resolveBin(BINS.sh, () => {}), join(app, 'app.sh')],
    roBinds: [app],
    network: 'none',
    audio: AUDIO,
    log: () => {},
    onEvent: () => {},
  });
  await sb.start();
});

afterAll(async () => {
  if (!ok) return;
  await sb?.stop();
  rmSync(root, { recursive: true, force: true });
});

it('the app sees its own audio server, with only its devices, and cannot load modules into it', async () => {
  const report = join(dir, 'home', 'report.txt');
  for (let i = 0; i < 100 && !existsSync(report); i++) await Bun.sleep(100);
  const r = Object.fromEntries(
    readFileSync(report, 'utf8')
      .trim()
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
  expect(r.server).toBe(`unix:/run/user/${process.getuid!()}/pulse/native`);
  expect(r.sinks.split(' ').sort()).toEqual(['call_out', 'mic_in']);
  expect(r.sources.split(' ').sort()).toEqual(['call_out.monitor', 'device_mic', 'mic_in.monitor']);
  expect(r.default).toBe('call_out device_mic');
  expect(r.load).toBe('refused');
});
