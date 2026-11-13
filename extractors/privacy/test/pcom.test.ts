/**
 * The privacy pull against dither-finance's own puller: test/fixtures were made by make-fixtures.ts running
 * privacy/pcom.py's `pull` against the fake Privacy. The same pull here (pcom.ts, with the app's own request as the
 * page saw it) must make the same requests in the same order (all four passes) and write the same bytes under the
 * same name (but for the stamp). Also: parse_qsl/urlencode and the KEEP allowlist as Python has them, and the seed.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { py } from '@dither-accounts/statements-common';
import { cmpStr, compareWithSeed, discoveryFrom, isTxnRequest, parseQsl, privacyFile, pullTransactions, redact, seedFromRaw, sortKeys, stampUtc, urlencode } from '../src/pcom.ts';
import { BASE_TXNS, type FakePrivacy, startFakePrivacy } from './fake-privacy.ts';

const FIX = join(import.meta.dir, 'fixtures');
const meta = JSON.parse(readFileSync(join(FIX, 'meta.json'), 'utf8'));
const fixture = readFileSync(join(FIX, 'privacy.json'), 'utf8');
let fake: FakePrivacy;
let cookie = '';
let token = '';

beforeAll(async () => {
  fake = startFakePrivacy();
  const r = await fetch(`${fake.origin}/api/password`, { method: 'POST' });
  cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  token = ((await r.json()) as { token: string }).token;
});
afterAll(() => fake?.stop());

const get = async (url: string): Promise<[number, string]> => {
  const r = await fetch(url, { headers: { cookie, authorization: `Bearer ${token}`, 'x-privacy-client': 'web' } });
  return [r.status, await r.text()];
};

test("a pull makes pcom.py's requests and writes pcom.py's file", async () => {
  fake.resetTxns();
  // The app's own request on /transactions (what the page hook sees), then the pager.
  const captured = `${fake.origin}/api/v2/transactions?limit=25&fullInfo=true&transactionFilter=ALL`;
  await get(captured);
  const logs: string[] = [];
  const p = await pullTransactions(captured, { get, log: (m) => logs.push(m) });
  expect(fake.txnRequests.map((r) => [r.query, r.ok])).toEqual(meta.requests);
  expect(p.passes).toBe(4);
  expect(p.requests).toBe(meta.requests.length - 1);
  expect(p.transactions.length).toBe(BASE_TXNS + 1);
  expect(logs.at(-1)).toBe(`pass 4: ${BASE_TXNS + 1}/${BASE_TXNS + 5} distinct`);
  const now = new Date(meta.pulledAt * 1000);
  const f = privacyFile(p, now);
  expect(f.name).toBe(meta.name.replace('STAMP', stampUtc(now)));
  expect(f.name).toMatch(/^privacy-\d{8}T\d{6}\.json$/);
  expect(f.text.length).toBe(fixture.length);
  expect(f.text === fixture).toBe(true);
  // What never reaches the file: fields past the allowlist, nested ones too.
  for (const s of ['cardExpiry', 'ipAddress', 'authCode', 'riskScore', 'threeDS', 'secret-', '"risk"', '"code"']) expect(f.text).not.toContain(s);
  expect(meta.signIns).toEqual(['passkey:1']);
});

test('a failed request fails the pull, as pcom.py exited', async () => {
  const captured = `${fake.origin}/api/v2/transactions?limit=25&fullInfo=true&transactionFilter=ALL`;
  await expect(pullTransactions(captured, { get: async () => [401, '{}'] })).rejects.toThrow('transactions request failed: HTTP 401');
});

test("parse_qsl, update and urlencode as pcom.py's Python did them", () => {
  const cases: [string, [string, string][], string][] = [
    ['limit=25&fullInfo=true&transactionFilter=ALL', [['limit', '100'], ['fullInfo', 'true'], ['transactionFilter', 'ALL'], ['offset', '0']], 'limit=100&fullInfo=true&transactionFilter=ALL&offset=0'],
    ['a=1&b=&c&a=2&d=x+y%2Bz&e=%E2%98%95&&f==g', [['a', '2'], ['d', 'x y+z'], ['e', '☕'], ['f', '=g'], ['limit', '100'], ['offset', '0'], ['fullInfo', 'true']], 'a=2&d=x+y%2Bz&e=%E2%98%95&f=%3Dg&limit=100&offset=0&fullInfo=true'],
    [';x=1&y=a;b', [[';x', '1'], ['y', 'a;b'], ['limit', '100'], ['offset', '0'], ['fullInfo', 'true']], '%3Bx=1&y=a%3Bb&limit=100&offset=0&fullInfo=true'],
  ];
  for (const [q, items, enc] of cases) {
    const d = parseQsl(q);
    d.set('limit', '100');
    d.set('offset', '0');
    d.set('fullInfo', 'true');
    expect([...d]).toEqual(items);
    expect(urlencode(d)).toBe(enc);
  }
  expect(urlencode(new Map([['k k', "a/b?c=d&e ~!*()'é"]]))).toBe('k+k=a%2Fb%3Fc%3Dd%26e+~%21%2A%28%29%27%C3%A9');
  expect(isTxnRequest('https://app.privacy.com/api/v2/transactions/?limit=1')).toBe(true);
  expect(isTxnRequest('https://app.privacy.com/api/v2/transactions/status')).toBe(false);
  expect(isTxnRequest('https://evil.example/api/v2/transactions')).toBe(false);
});

test('KEEP, KEEP_NESTED and refunds as _redact; sort_keys by code point', () => {
  const t = py.parse(
    '{"zz": 1, "amount": 1.0, "mccCategory": {"name": "A", "code": "1"}, "calculatedFees": {"10": 1, "2": 2}, "originalAuth": {"uuid": "u", "authCode": "x"}, "refunds": [{"amount": 2, "ip": "1"}, 3], "fundingAccount": {"any": 1}, "transactionUuid": "t", "mcc": "5"}',
  ) as InstanceType<typeof py.PyObj>;
  expect(py.dumps(redact(t))).toBe('{"amount": 1.0, "mccCategory": {"name": "A"}, "calculatedFees": {"10": 1, "2": 2}, "originalAuth": {"uuid": "u"}, "refunds": [{"amount": 2}, 3], "fundingAccount": {"any": 1}, "transactionUuid": "t", "mcc": "5"}');
  expect(py.dumps(sortKeys(py.parse('{"b": {"z": 1, "a": [{"y": 2, "x": 1}]}, "a": 0, "\\ud83c\\udf55": 1, "\\uffff": 2}')))).toBe('{"a": 0, "b": {"a": [{"x": 1, "y": 2}], "z": 1}, "\\uffff": 2, "\\ud83c\\udf55": 1}');
  expect(cmpStr('￿', '\u{1f355}')).toBeLessThan(0);
});

test('the seed: the newest raw file and the discovery; then a pull against it, in counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-seed-'));
  try {
    writeFileSync(join(dir, 'privacy-20261101T000000.json'), '{"source": "privacy.com", "transactions": []}');
    writeFileSync(join(dir, 'privacy-20261102T000000.json'), fixture);
    writeFileSync(join(dir, 'venmo-x.json'), '{}');
    const seed = seedFromRaw(dir)!;
    expect(seed.file).toBe('privacy-20261102T000000.json');
    expect(seed.transactions).toBe(BASE_TXNS + 1);
    expect(seed.total).toBe(BASE_TXNS + 5);
    expect(seed.transactionFilter).toBe('ALL');
    expect(Object.keys(seed.txn).length).toBe(BASE_TXNS + 1);
    const d = discoveryFrom(JSON.stringify({ 'GET app.privacy.com/api/v2/transactions?limit=…&fullInfo=…&transactionFilter=…': {}, 'GET app.privacy.com/api/v2/transactions/status': {}, 'GET app.privacy.com/api/v2/transactions/?limit=…&offset=…': {} }));
    expect(d).toEqual({ endpoints: ['GET app.privacy.com/api/v2/transactions?limit=…&fullInfo=…&transactionFilter=…', 'GET app.privacy.com/api/v2/transactions/?limit=…&offset=…'], queryNames: [['limit', 'fullInfo', 'transactionFilter'], ['limit', 'offset']] });
    // A pull that sees one row less and one row changed.
    const doc = py.parse(fixture) as InstanceType<typeof py.PyObj>;
    const txns = (doc.get('transactions') as InstanceType<typeof py.PyObj>[]).slice(1);
    txns[0] = new py.PyObj([...txns[0]!.entries(), ['memo', 'changed']]);
    const c = compareWithSeed(seed, { transactions: txns, total: null, transactionFilter: 'ALL', requests: 0, passes: 0 }, 'x', 1);
    expect(c).toEqual({ at: 1, file: 'x', same: BASE_TXNS - 1, changed: 1, added: 0, gone: 1, transactionFilterSame: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
