#!/usr/bin/env bun
/**
 * desk-signer: the laptop's approver device (README.md).
 *
 *   desk-signer pair <dither-approver://pair?url=…&code=…> [--name NAME] [--url URL] [--force]
 *   desk-signer run
 *   desk-signer status
 *
 * Environment: DESK_SIGNER_STATE (its state directory; default $STATE_DIRECTORY, else ~/.local/state/desk-signer),
 * DESK_SIGNER_USER (whose finger counts; run needs it), DESK_SIGNER_VERIFY (the presence check as a JSON array, `{user}`
 * replaced; default ["fprintd-verify","{user}"]).
 */
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { DeskSigner, describe, load, pair } from './signer.ts';

const USAGE = `usage:
  desk-signer pair <dither-approver://pair?url=…&code=…> [--name NAME] [--url URL] [--force]
  desk-signer run
  desk-signer status`;

const dir = process.env.DESK_SIGNER_STATE || process.env.STATE_DIRECTORY || join(homedir(), '.local/state/desk-signer');
const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  if (!v) die(`${name} needs a value`, 64);
  rest.splice(i, 2);
  return v;
}

function die(msg: string, code = 1): never {
  console.error(`desk-signer: ${msg}`);
  process.exit(code);
}

if (cmd === 'pair') {
  const name = flag('--name') ?? `Desk (${hostname()})`;
  const base = flag('--url');
  const force = rest.includes('--force');
  const link = rest.find((a) => !a.startsWith('--'));
  if (!link) die(USAGE, 64);
  try {
    const d = await pair(link, { dir, name: name.slice(0, 64), base, force });
    const s = describe(dir);
    console.log(`paired as ${d.deviceId} (${d.name}) with ${d.url}`);
    console.log(`identity key  ${s.identityFingerprint}   (compare with the manager's Approvers page)`);
    console.log(`approval key  ${s.approvalFingerprint}   (the fingerprint for keys files)`);
  } catch (e) {
    die((e as Error).message);
  }
} else if (cmd === 'status') {
  try {
    const s = describe(dir);
    console.log(`device        ${s.device.deviceId} (${s.device.name}), kind desk`);
    console.log(`manager       ${s.device.url}`);
    console.log(`paired        ${new Date(s.device.pairedAt).toISOString()}`);
    console.log(`identity key  ${s.identityFingerprint}`);
    console.log(`approval key  ${s.approvalFingerprint}`);
    console.log(`state         ${dir}${s.problems.length ? `: ${s.problems.join('; ')}` : ' (private)'}`);
    if (s.problems.length) process.exit(1);
  } catch (e) {
    die(`${dir} holds no paired device (${(e as Error).message.split('\n')[0]})`);
  }
} else if (cmd === 'run') {
  const user = process.env.DESK_SIGNER_USER;
  if (!user) die('DESK_SIGNER_USER names whose finger counts', 64);
  let verify: string[] | undefined;
  if (process.env.DESK_SIGNER_VERIFY) {
    try {
      verify = JSON.parse(process.env.DESK_SIGNER_VERIFY);
      if (!Array.isArray(verify) || !verify.length || verify.some((x) => typeof x !== 'string')) throw new Error();
    } catch {
      die('DESK_SIGNER_VERIFY is a JSON array of strings, like ["fprintd-verify","{user}"]', 64);
    }
  }
  let st;
  try {
    st = await load(dir);
  } catch (e) {
    die((e as Error).message);
  }
  // Exit 2: not paired any more (systemd: RestartPreventExitStatus=2).
  const signer = new DeskSigner(st, { user, verify, onUnpaired: () => process.exit(2) });
  signer.start();
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.on(sig, () => {
      signer.stop();
      process.exit(0);
    });
} else die(USAGE, 64);
