/**
 * The github extractor's parts on their own: threads as Notifications (web links from API URLs, kinds, states,
 * actors), where it is in the list (state.json's diff), the token's scopes, and its GitHub client against the fake
 * GitHub (304s, Link pages, rate limits, the token never sent elsewhere).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHub, type GitHubError, parseLink, parseScopes, rateLimitRetryAt } from '../extractors/github/src/api.ts';
import { commentAnchor, fromPageToken, kindOf, pageToken, subjectInfo, subjectWebUrl, type Thread, toNotification } from '../extractors/github/src/map.ts';
import { Resolver } from '../extractors/github/src/resolve.ts';
import { scopeVerdict, tokenType } from '../extractors/github/src/scopes.ts';
import { applyUnread, fresh, loadState, markRead, prune, saveState, unreadIds } from '../extractors/github/src/state.ts';
import { type FakeGitHub, startFakeGitHub } from '../extractors/github/test/fake-github.ts';

const thread = (o: Omit<Partial<Thread>, 'subject' | 'repository'> & { subject?: Partial<Thread['subject']>; repository?: Partial<Thread['repository']> } = {}): Thread => ({
  id: '1',
  unread: true,
  reason: 'mention',
  updated_at: '2026-11-07T10:00:00Z',
  last_read_at: null,
  ...o,
  subject: { title: 'Fix it', url: 'https://api.github.com/repos/octo/hello/issues/12', latest_comment_url: 'https://api.github.com/repos/octo/hello/issues/12', type: 'Issue', ...o.subject },
  repository: { full_name: 'octo/hello', html_url: 'https://github.com/octo/hello', private: false, ...o.repository },
});

test('kinds: GitHub subject types in snake case', () => {
  expect(['Issue', 'PullRequest', 'CheckSuite', 'RepositoryVulnerabilityAlert', 'RepositoryDependabotAlertsThread', 'Release', ''].map(kindOf)).toEqual(['issue', 'pull_request', 'check_suite', 'repository_vulnerability_alert', 'repository_dependabot_alerts_thread', 'release', 'unknown']);
});

test('web links from API URLs, without a request', () => {
  const at = (type: string, url: string | null) => subjectWebUrl(thread({ subject: { type, url } }));
  expect(at('Issue', 'https://api.github.com/repos/octo/hello/issues/12')).toBe('https://github.com/octo/hello/issues/12');
  expect(at('PullRequest', 'https://api.github.com/repos/octo/hello/pulls/7')).toBe('https://github.com/octo/hello/pull/7');
  expect(at('Commit', 'https://api.github.com/repos/octo/hello/commits/abc123')).toBe('https://github.com/octo/hello/commit/abc123');
  expect(at('Release', 'https://api.github.com/repos/octo/hello/releases/99')).toBe('https://github.com/octo/hello/releases');
  expect(at('Discussion', null)).toBe('https://github.com/octo/hello/discussions');
  expect(at('CheckSuite', null)).toBe('https://github.com/octo/hello/actions');
  expect(at('RepositoryVulnerabilityAlert', null)).toBe('https://github.com/octo/hello/security/dependabot');
  expect(at('SomethingNew', null)).toBe('https://github.com/octo/hello');
  // GitHub Enterprise: the repository's html_url says where the web is.
  expect(subjectWebUrl(thread({ subject: { url: 'https://ghe.example/api/v3/repos/a/b/pulls/3', type: 'PullRequest' }, repository: { full_name: 'a/b', html_url: 'https://ghe.example/a/b' } }))).toBe('https://ghe.example/a/b/pull/3');
  expect(commentAnchor('https://api.github.com/repos/o/r/issues/comments/55')).toBe('#issuecomment-55');
  expect(commentAnchor('https://api.github.com/repos/o/r/pulls/comments/56')).toBe('#discussion_r56');
  expect(commentAnchor('https://api.github.com/repos/o/r/comments/57')).toBe('#commitcomment-57');
  expect(commentAnchor('https://api.github.com/repos/o/r/issues/12')).toBeNull();
});

test('a thread as a Notification, before and after resolving', () => {
  const t = thread({ subject: { latest_comment_url: 'https://api.github.com/repos/octo/hello/issues/comments/55' } });
  expect(toNotification(t)).toEqual({
    id: '1',
    source: 'github',
    title: 'Fix it',
    body: null,
    url: 'https://github.com/octo/hello/issues/12#issuecomment-55',
    reason: 'mention',
    context: 'octo/hello',
    subject: { kind: 'issue', title: 'Fix it', url: 'https://github.com/octo/hello/issues/12', state: null },
    actors: [],
    at: Date.parse('2026-11-07T10:00:00Z'),
    unread: true,
  });
  const n = toNotification(t, {
    subject: subjectInfo('Issue', { html_url: 'https://github.com/octo/hello/issues/12', state: 'open', user: { login: 'mona', html_url: 'https://github.com/mona', avatar_url: 'https://a/m' }, body: 'desc' }),
    comment: { url: 'https://github.com/octo/hello/issues/12#issuecomment-55', author: { name: 'hubot', url: 'https://github.com/hubot', avatar: null }, body: '@octocat look' },
  });
  expect(n).toMatchObject({ body: '@octocat look', actors: [{ name: 'hubot' }], subject: { state: 'open' } });
  // Its own activity (opened, a review asked for): the subject's author and description.
  expect(toNotification(thread({ reason: 'review_requested', subject: { type: 'PullRequest', url: 'https://api.github.com/repos/octo/hello/pulls/7', latest_comment_url: 'https://api.github.com/repos/octo/hello/pulls/7' } }), { subject: subjectInfo('PullRequest', { html_url: 'https://github.com/octo/hello/pull/7', state: 'open', draft: true, user: { login: 'mona' }, body: 'please' }) })).toMatchObject({
    url: 'https://github.com/octo/hello/pull/7',
    body: 'please',
    actors: [{ name: 'mona' }],
    subject: { kind: 'pull_request', state: 'draft' },
  });
  // A state change: whoever merged it.
  expect(toNotification(thread({ reason: 'state_change', subject: { type: 'PullRequest', url: 'https://api.github.com/repos/octo/hello/pulls/7', latest_comment_url: 'https://api.github.com/repos/octo/hello/pulls/7' } }), { subject: subjectInfo('PullRequest', { state: 'closed', merged: true, user: { login: 'mona' }, merged_by: { login: 'hubot' } }) })).toMatchObject({ actors: [{ name: 'hubot' }], subject: { state: 'merged' } });
  expect(subjectInfo('Release', { html_url: 'https://github.com/o/r/releases/tag/v1', prerelease: true }).state).toBe('prerelease');
});

test('page tokens carry only the query of GitHub’s next link', () => {
  const tok = pageToken('https://api.github.com/notifications?all=true&per_page=2&page=3&evil=1');
  expect(fromPageToken(tok)!.toString()).toBe('all=true&per_page=2&page=3');
  expect(fromPageToken(Buffer.from('page=2&host=evil').toString('base64url'))).toBeNull();
  expect(fromPageToken(Buffer.from('all=true').toString('base64url'))).toBeNull();
  expect(fromPageToken('%%%')).toBeNull();
});

test('state: new, changed and unread-again threads are news; reads only from a complete list', () => {
  const s = fresh();
  expect(applyUnread(s, [{ id: 'a', updatedAt: 10 }, { id: 'b', updatedAt: 20 }], true)).toEqual({ news: ['a', 'b'], reads: [] });
  expect(applyUnread(s, [{ id: 'a', updatedAt: 10 }, { id: 'b', updatedAt: 20 }], true)).toEqual({ news: [], reads: [] });
  expect(applyUnread(s, [{ id: 'b', updatedAt: 30 }], false)).toEqual({ news: ['b'], reads: [] });
  expect(applyUnread(s, [{ id: 'b', updatedAt: 30 }], true)).toEqual({ news: [], reads: ['a'] });
  expect(applyUnread(s, [{ id: 'a', updatedAt: 10 }, { id: 'b', updatedAt: 30 }], true)).toEqual({ news: ['a'], reads: [] });
  expect(s.newest).toBe(30);
  expect(markRead(s, ['a', 'zzz'])).toEqual(['a']);
  expect(unreadIds(s).sort()).toEqual(['b']);
  expect(unreadIds(s, 20)).toEqual([]);
});

test('state: kept whole, pruned, and a broken file starts over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dacc-gh-state-'));
  try {
    const p = join(dir, 'state.json');
    const s = fresh();
    s.baselineAt = 1;
    s.lastModified = 'Sat, 07 Nov 2026 10:00:00 GMT';
    const now = Date.now();
    s.seen = { old: [now - 40 * 86_400_000, 0], recent: [now - 86_400_000, 0], unreadOld: [now - 90 * 86_400_000, 1] };
    prune(s, now);
    expect(Object.keys(s.seen).sort()).toEqual(['recent', 'unreadOld']);
    saveState(p, s);
    expect(loadState(p)).toEqual(s);
    writeFileSync(p, '{"version": 1, "seen":');
    const logs: string[] = [];
    expect(loadState(p, (m) => logs.push(m))).toEqual(fresh());
    expect(logs[0]).toContain('does not read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scopes: what is missing, said plainly', () => {
  expect(tokenType('ghp_abc')).toBe('classic');
  expect(tokenType('a'.repeat(40).replace(/a/g, 'f'))).toBe('classic');
  expect(tokenType('github_pat_11AB')).toBe('fine-grained');
  expect(tokenType('ghu_x')).toBe('github app');
  expect(scopeVerdict('ghp_x', ['notifications', 'repo'])).toMatchObject({ ok: true, repo: true });
  expect(scopeVerdict('ghp_x', ['repo'])).toMatchObject({ ok: true, repo: true });
  const noRepo = scopeVerdict('ghp_x', ['notifications']);
  expect(noRepo).toMatchObject({ ok: true, repo: false });
  expect(noRepo.note).toContain('no repo scope');
  const none = scopeVerdict('ghp_x', ['read:user', 'gist']);
  expect(none.ok).toBe(false);
  expect(none.message).toContain('only read:user, gist, not notifications');
  expect(scopeVerdict('ghp_x', []).message).toContain('no scopes');
  const fg = scopeVerdict('github_pat_x', null);
  expect(fg.ok).toBe(false);
  expect(fg.message).toContain('fine-grained');
  expect(fg.message).toContain('classic');
});

test('Link and scope headers; rate limits by GitHub’s rules', () => {
  expect(parseLink('<https://x/n?page=2>; rel="next", <https://x/n?page=5>; rel="last"')).toEqual({ next: 'https://x/n?page=2', last: 'https://x/n?page=5' });
  expect(parseLink(null)).toEqual({});
  expect(parseScopes('notifications, repo')).toEqual(['notifications', 'repo']);
  expect(parseScopes('')).toEqual([]);
  expect(parseScopes(null)).toBeNull();
  const h = (o: Record<string, string>) => new Headers(o);
  const now = 1_000_000;
  expect(rateLimitRetryAt(403, h({ 'retry-after': '30' }), 'x', now)).toBe(now + 30_000);
  expect(rateLimitRetryAt(429, h({ 'retry-after': '0' }), 'x', now)).toBe(now + 1000);
  expect(rateLimitRetryAt(403, h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 600) }), 'API rate limit exceeded', now)).toBe(now + 600_000);
  expect(rateLimitRetryAt(403, h({}), 'You have exceeded a secondary rate limit', now)).toBe(now + 60_000);
  expect(rateLimitRetryAt(403, h({}), 'You have exceeded a secondary rate limit', now, 2)).toBe(now + 240_000);
  expect(rateLimitRetryAt(429, h({}), 'x', now)).toBe(now + 60_000);
  expect(rateLimitRetryAt(403, h({}), 'Resource not accessible by personal access token', now)).toBeNull();
  expect(rateLimitRetryAt(404, h({ 'retry-after': '5' }), 'x', now)).toBeNull();
});

let fake: FakeGitHub;
beforeAll(() => {
  fake = startFakeGitHub({ pollInterval: 7 });
  fake.addToken('ghp_good', { login: 'octocat' });
  fake.addToken('ghp_noscope', { scopes: ['read:user'] });
});
afterAll(() => fake.stop());

test('the client: scopes, 304s that cost nothing, Link pages, 401', async () => {
  const gh = new GitHub(fake.url, () => 'ghp_good');
  const me = await gh.req('GET', '/user');
  expect(me.body.login).toBe('octocat');
  expect(parseScopes(me.headers.get('x-oauth-scopes'))).toEqual(['notifications', 'repo', 'read:user']);
  for (let i = 0; i < 5; i++) fake.addThread({ title: `t${i}` });
  const first = await gh.req('GET', '/notifications', { query: { per_page: 2 } });
  expect(first.body.map((t: any) => t.subject.title)).toEqual(['t4', 't3']);
  expect(first.headers.get('x-poll-interval')).toBe('7');
  const left = gh.rate.remaining!;
  const again = await gh.req('GET', '/notifications', { query: { per_page: 2 }, ifModifiedSince: first.headers.get('last-modified') });
  expect(again.status).toBe(304);
  expect(gh.rate.remaining).toBe(left);
  expect(gh.notModified).toBe(1);
  const titles: string[] = first.body.map((t: any) => t.subject.title);
  for (let next = first.next; next; ) {
    const r = await gh.req('GET', next);
    titles.push(...r.body.map((t: any) => t.subject.title));
    next = r.next;
  }
  expect(titles).toEqual(['t4', 't3', 't2', 't1', 't0']);
  const bad = (await new GitHub(fake.url, () => 'ghp_nope').req('GET', '/user').catch((e) => e)) as GitHubError;
  expect([bad.status, bad.failure, bad.message]).toEqual([401, 'auth', 'Bad credentials']);
  const no = (await new GitHub(fake.url, () => 'ghp_noscope').req('GET', '/notifications').catch((e) => e)) as GitHubError;
  expect([no.status, no.failure, no.accepted]).toEqual([403, 'forbidden', 'notifications, repo']);
});

test('the client: the token goes only to the API’s own origin', async () => {
  const gh = new GitHub(fake.url, () => 'ghp_good');
  const e = (await gh.req('GET', 'https://evil.example/api/v3/user').catch((x) => x)) as GitHubError;
  expect(e.status).toBe(400);
  expect(e.message).toContain('refused to send the token');
});

test('the client: a primary limit is waited out without asking, a secondary one for its Retry-After', async () => {
  const gh = new GitHub(fake.url, () => 'ghp_good', { secondaryMs: 1000 });
  fake.exhaust(2);
  const before = fake.calls.length;
  const e = (await gh.req('GET', '/user').catch((x) => x)) as GitHubError;
  expect([e.status, e.failure]).toEqual([429, 'rate']);
  expect(e.retryAt).toBeGreaterThan(Date.now());
  expect(gh.rate.remaining).toBe(0);
  // Meanwhile nothing is sent.
  await gh.req('GET', '/user').catch(() => {});
  expect(fake.calls.length).toBe(before + 1);
  await Bun.sleep(Math.max(0, gh.limitedUntil - Date.now()) + 50);
  expect((await gh.req('GET', '/user')).status).toBe(200);

  fake.failNext({ status: 429, retryAfter: 1 });
  const s = (await gh.req('GET', '/user').catch((x) => x)) as GitHubError;
  expect(s.failure).toBe('rate');
  expect(gh.limitedUntil - Date.now()).toBeLessThanOrEqual(1000);
  await Bun.sleep(gh.limitedUntil - Date.now() + 50);
  fake.failNext({ status: 403 });
  const s2 = (await gh.req('GET', '/user').catch((x) => x)) as GitHubError;
  expect(s2.failure).toBe('rate');
  // No Retry-After: at least the minimum.
  expect(gh.limitedUntil - Date.now()).toBeGreaterThan(900);
  await Bun.sleep(gh.limitedUntil - Date.now() + 50);
  // A 5xx is retried when asked.
  fake.failNext({ status: 502, count: 1 });
  expect((await gh.req('GET', '/user', { retries: 1 })).status).toBe(200);
}, 15_000);

test('resolving: subjects fetched once per change and revalidated with their ETag, private ones not without repo', async () => {
  const gh = new GitHub(fake.url, () => 'ghp_good');
  let repo = true;
  const r = new Resolver(gh, () => repo);
  const id = fake.addThread({ repo: 'octo/hello', type: 'PullRequest', title: 'Add it', author: 'mona', comment: { author: 'hubot', body: 'LGTM' } });
  const list = async () => (await gh.req('GET', '/notifications', { query: { per_page: 50 } })).body.find((t: any) => t.id === id);
  const n1 = await r.resolve(await list(), { n: 10 });
  expect(n1).toMatchObject({ subject: { kind: 'pull_request', state: 'open', url: `${fake.origin}/octo/hello/pull/${id}` }, actors: [{ name: 'hubot' }], body: 'LGTM' });
  expect(n1.url).toMatch(/#issuecomment-\d+$/);
  const calls = () => fake.callsTo(new RegExp(`/repos/octo/hello/(pulls/${id}|issues/comments/)`)).length;
  const c1 = calls();
  await r.resolve(await list(), { n: 10 });
  expect(calls()).toBe(c1);
  fake.changeState(id, 'merged', 'hubot');
  const n2 = await r.resolve(await list(), { n: 10 });
  expect(n2).toMatchObject({ reason: 'state_change', subject: { state: 'merged' }, actors: [{ name: 'hubot' }] });
  // A budget of none: linked from the URL alone.
  const n3 = await r.resolve(await list(), { n: 0 });
  expect(n3.subject!.url).toBe(`${fake.origin}/octo/hello/pull/${id}`);

  const priv = fake.addThread({ repo: 'octo/secret', private: true, type: 'Issue', title: 'Hidden' });
  repo = false;
  const before = fake.callsTo(/\/repos\/octo\/secret\//).length;
  const p = await r.resolve(await (async () => (await gh.req('GET', '/notifications')).body.find((t: any) => t.id === priv))(), { n: 10 });
  expect(fake.callsTo(/\/repos\/octo\/secret\//).length).toBe(before);
  expect(p).toMatchObject({ url: `${fake.origin}/octo/secret/issues/${priv}`, subject: { state: null } });
});

test('a state file holds ids and times only', () => {
  const s = fresh();
  applyUnread(s, [{ id: '42', updatedAt: 1 }], true);
  const text = JSON.stringify(s);
  expect(Object.keys(JSON.parse(text))).toEqual(['version', 'baselineAt', 'lastModified', 'newest', 'lastReconcileAt', 'seen']);
  expect(readFileSync).toBeDefined();
});
