import { expect, test } from 'bun:test';
import { hubFile, hubFromEnvFile, magicLinkIn, needsRelink, soonestResetPriorities, weeklyReset } from '../packages/manager/src/providers/cliproxy.ts';

test("the hub's keys.env gives its URL and management key", () => {
  expect(hubFromEnvFile('CLIPROXY_URL=http://127.0.0.1:8317/\nCLIPROXY_MANAGEMENT_KEY=k\nCLIPROXY_API_KEY=sk-a\n')).toEqual({ url: 'http://127.0.0.1:8317', managementKey: 'k' });
  expect(hubFromEnvFile('CLIPROXY_MANAGEMENT_KEY=k')).toEqual({ url: 'http://127.0.0.1:8317', managementKey: 'k' });
  expect(hubFromEnvFile('CLIPROXY_API_KEY=a')).toBeNull();
});

test("the sign-in link is found in claude.ai's mail, html or text", () => {
  const html = '<a href="https://links.example.com/ls/click?upn=x">Help</a><a href="https://claude.ai/magic-link#tok-EN_1.2~3%3D" class="b">Sign in</a>';
  expect(magicLinkIn(null, html)).toBe('https://claude.ai/magic-link#tok-EN_1.2~3%3D');
  expect(magicLinkIn('Sign in [https://claude.ai/magic-link#abc] If you', null)).toBe('https://claude.ai/magic-link#abc');
  expect(magicLinkIn('https://claude.ai/login', '<a href="https://claude.ai.evil/magic-link#x">')).toBeNull();
  expect(magicLinkIn('see https://fake.example/magic-link#x', null, 'http://127.0.0.1:9')).toBeNull();
});

test('weekly reset from the quota signals the hub keeps', () => {
  expect(weeklyReset({ 'anthropic-ratelimit-unified-7d-reset': '1794600000', 'anthropic-ratelimit-unified-5h-reset': '1794500000' })).toBe(1794600000000);
  expect(weeklyReset({ 'anthropic-ratelimit-unified-7d-reset': '2026-11-14T00:00:00Z' })).toBe(Date.parse('2026-11-14T00:00:00Z'));
  expect(weeklyReset({ 'anthropic-ratelimit-unified-7d-reset-after-seconds': '100' })).toBeNull();
  expect(weeklyReset({})).toBeNull();
  expect(weeklyReset(null)).toBeNull();
});

test('auth-files entries: email, sign-in needed, refresh refused', () => {
  const f = hubFile({ name: 'claude-a@example.org.json', provider: 'claude', email: 'a@example.org', disabled: false, status: 'active', next_action: 'sign_in', quota: { signals: {} } });
  expect(f).toMatchObject({ name: 'claude-a@example.org.json', provider: 'claude', email: 'a@example.org', needsSignIn: true, weeklyResetAt: null });
  expect(needsRelink(f)).toBe(true);
  const g = hubFile({ name: 'g', type: 'claude', refresh_error: { code: 'invalid_grant', http_status: 400, message: 'refresh token revoked' } });
  expect(needsRelink(g)).toBe(true);
  expect(needsRelink(hubFile({ name: 'h', provider: 'claude', refresh_error: { code: 'timeout', http_status: 503 } }))).toBe(false);
});

test('soonest weekly reset first; an unknown reset ranks with the soonest; disabled 0; other providers left out', () => {
  const files = [
    hubFile({ name: 'late', provider: 'claude', quota: { signals: { 'anthropic-ratelimit-unified-7d-reset': '2000' } } }),
    hubFile({ name: 'soon', provider: 'claude', quota: { signals: { 'anthropic-ratelimit-unified-7d-reset': '1000' } } }),
    hubFile({ name: 'unknown', provider: 'claude' }),
    hubFile({ name: 'off', provider: 'claude', disabled: true, quota: { signals: { 'anthropic-ratelimit-unified-7d-reset': '500' } } }),
    hubFile({ name: 'codex', provider: 'codex', quota: { signals: { 'x-7d-reset': '1' } } }),
  ];
  const p = soonestResetPriorities(files);
  expect(Object.fromEntries(p)).toEqual({ late: 1, soon: 2, unknown: 2, off: 0 });
  expect(Object.fromEntries(soonestResetPriorities([hubFile({ name: 'a', provider: 'claude' })]))).toEqual({ a: 0 });
});
