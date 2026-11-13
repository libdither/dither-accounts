/**
 * Makes test/fixtures from dither-finance's own puller: runs privacy/pcom.py `pull` (unchanged, its source read and
 * run with the fake's origin in place of https://app.privacy.com, and its host in place of "privacy.com" in the
 * request filter) against the fake Privacy (fake-privacy.ts) in a
 * throwaway FINANCE_HOME, with a passkey made here and known to the fake's relying party (pcom.py loads it into its
 * DevTools virtual authenticator, as it does dither-finance's). Keeps the file it wrote (fixtures/privacy.json), its
 * name's shape and pulled_at, and the transactions requests it made, in order (fixtures/meta.json). pcom.py's headless
 * Playwright Chromium is test tooling for running the old puller; the extractor never uses one.
 *
 *   bun extractors/privacy/test/make-fixtures.ts [~/Projects/dither-finance]
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakePrivacy } from './fake-privacy.ts';

const FT = process.argv[2] ?? join(homedir(), 'Projects/dither-finance');
const out = join(import.meta.dir, 'fixtures');
const home = mkdtempSync(join(tmpdir(), 'privacy-fixture-'));
const fake = startFakePrivacy();

// A passkey for the fake, in the form pcom.py keeps (CDP's WebAuthn credential: base64, PKCS#8).
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const credId = randomBytes(32);
const userHandle = Buffer.from('fake-user-1');
fake.addCredential({ id: credId.toString('base64url'), publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), alg: -8, userHandle: userHandle.toString('base64url') });
mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
writeFileSync(
  join(home, 'secrets/privacy_passkey.json'),
  JSON.stringify({ credentialId: credId.toString('base64'), rpId: 'localhost', privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), userHandle: userHandle.toString('base64'), signCount: 0, isResidentCredential: true }),
  { mode: 0o600 },
);

const PY = `
import argparse, sys
src = open(${JSON.stringify(join(FT, 'privacy/pcom.py'))}).read()
src = src.replace('APP = "https://app.privacy.com"', 'APP = "' + sys.argv[1] + '"')
src = src.replace('u.netloc.endswith("privacy.com")', 'u.netloc.endswith("' + sys.argv[1].split("//")[1] + '")')
assert sys.argv[1] in src and sys.argv[1].split("//")[1] + '")' in src
ns = {"__name__": "pcom_fixture"}
exec(compile(src, "pcom.py", "exec"), ns)
ns["pull"](argparse.Namespace(headed=False, page_size=100))
`;
fake.resetTxns();
const p = Bun.spawn(['uv', 'run', '--project', FT, 'python', '-c', PY, fake.origin], { cwd: FT, env: { ...process.env, FINANCE_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
if ((await p.exited) !== 0) {
  fake.stop();
  throw new Error(`pcom.py: ${o.slice(-300)} ${e.slice(-800)}`);
}
const raw = join(home, 'data/raw');
const files = readdirSync(raw).filter((f) => /^privacy-\d{8}T\d{6}\.json$/.test(f));
if (files.length !== 1) throw new Error(`pcom.py wrote ${files.length} files`);
const text = readFileSync(join(raw, files[0]!), 'utf8');
const pulledAt = Number(/"pulled_at": (\d+)/.exec(text)![1]);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'privacy.json'), text);
writeFileSync(join(out, '.gitattributes'), '* -text\n');
const requests = fake.txnRequests.map((r) => [r.query, r.ok]);
writeFileSync(join(out, 'meta.json'), JSON.stringify({ name: files[0]!.replace(/\d{8}T\d{6}/, 'STAMP'), pulledAt, requests, signIns: fake.log.filter((l) => l.startsWith('passkey:')) }, null, 1) + '\n');
fake.stop();
rmSync(home, { recursive: true, force: true });
console.log(`${files[0]!.replace(/\d{8}T\d{6}/, 'STAMP')}: ${text.length} bytes; ${requests.length} transactions request(s); pcom.py said: ${o.trim().split('\n').slice(-2).join(' | ')}`);
