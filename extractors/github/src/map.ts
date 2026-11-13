/**
 * GitHub's notification threads as the `notifications` interface's Notification. The web link of what a thread is about
 * is made from its API URL and its repository's html_url (no request) wherever GitHub's URLs say enough: issues, pull
 * requests, commits, discussions, and the latest comment's anchor. A fetched subject or comment (resolve.ts) adds its
 * state, author and text, and the links GitHub gives (a release's tag page).
 */
import type { Notification, NotificationActor } from '@dither-accounts/interfaces';

/** A thread as GET /notifications gives it (the fields this uses). */
export interface Thread {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  last_read_at: string | null;
  subject: { title: string; url: string | null; latest_comment_url: string | null; type: string };
  repository: { full_name: string; html_url: string; private?: boolean };
  url?: string;
  subscription_url?: string;
}

/** What a fetched issue, pull request or release adds. */
export interface SubjectInfo {
  url: string | null;
  state: string | null;
  author: NotificationActor | null;
  /** Who closed or merged it, when GitHub says. */
  closer: NotificationActor | null;
  body: string | null;
}

/** What a fetched comment adds. */
export interface CommentInfo {
  url: string | null;
  author: NotificationActor | null;
  body: string | null;
}

/** Subject types worth a request for their state and link (commits and the rest are linked without one). */
export const FETCHED = new Set(['Issue', 'PullRequest', 'Release']);

/** GitHub's subject type as a kind: PullRequest → pull_request, CheckSuite → check_suite. */
export function kindOf(type: string): string {
  return (
    type
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
      .toLowerCase() || 'unknown'
  );
}

const API_PATH = /\/repos\/[^/]+\/[^/]+\/(issues|pulls|commits|releases|discussions)\/([^/?#]+)\/?$/;

/** The web page of what a thread is about, from its API URL (or its type, when GitHub gives none). */
export function subjectWebUrl(t: Thread): string | null {
  const repo = t.repository?.html_url?.replace(/\/+$/, '') ?? null;
  if (!repo) return null;
  const m = t.subject.url?.match(API_PATH);
  if (m) {
    const [, what, id] = m;
    if (what === 'issues') return `${repo}/issues/${id}`;
    if (what === 'pulls') return `${repo}/pull/${id}`;
    if (what === 'commits') return `${repo}/commit/${id}`;
    if (what === 'discussions') return `${repo}/discussions/${id}`;
    if (what === 'releases') return `${repo}/releases`;
  }
  switch (t.subject.type) {
    case 'Discussion':
      return `${repo}/discussions`;
    case 'CheckSuite':
    case 'WorkflowRun':
      return `${repo}/actions`;
    case 'RepositoryInvitation':
      return `${repo}/invitations`;
    case 'RepositoryVulnerabilityAlert':
    case 'RepositoryDependabotAlertsThread':
      return `${repo}/security/dependabot`;
    case 'SecurityAdvisory':
      return `${repo}/security/advisories`;
    case 'Release':
      return `${repo}/releases`;
    default:
      return repo;
  }
}

/** The anchor of the latest comment on the subject's page, from its API URL: #issuecomment-1, #discussion_r1, #commitcomment-1. */
export function commentAnchor(latestCommentUrl: string | null): string | null {
  const m = latestCommentUrl?.match(/\/repos\/[^/]+\/[^/]+\/(issues\/comments|pulls\/comments|comments)\/(\d+)\/?$/);
  if (!m) return null;
  return m[1] === 'issues/comments' ? `#issuecomment-${m[2]}` : m[1] === 'pulls/comments' ? `#discussion_r${m[2]}` : `#commitcomment-${m[2]}`;
}

/** A thread's latest comment is a comment, not the subject itself (opened, closed, a review requested). */
export const hasComment = (t: Thread) => !!t.subject.latest_comment_url && t.subject.latest_comment_url !== t.subject.url && commentAnchor(t.subject.latest_comment_url) !== null;

export function actorOf(u: any): NotificationActor | null {
  if (!u || typeof u !== 'object' || typeof u.login !== 'string') return null;
  return { name: u.login, url: typeof u.html_url === 'string' ? u.html_url : null, avatar: typeof u.avatar_url === 'string' ? u.avatar_url : null };
}

/** Text to show with a notification: the start of a comment or description, at most `n` characters. */
export function excerpt(text: unknown, n = 2000): string | null {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** An issue's, pull request's or release's state: open, closed, merged, draft (a draft PR or release), prerelease. */
export function subjectInfo(type: string, o: any): SubjectInfo {
  let state: string | null = null;
  if (type === 'PullRequest') state = o?.merged || o?.merged_at ? 'merged' : o?.state === 'open' && o?.draft ? 'draft' : (o?.state ?? null);
  else if (type === 'Issue') state = o?.state ?? null;
  else if (type === 'Release') state = o?.draft ? 'draft' : o?.prerelease ? 'prerelease' : 'published';
  return {
    url: typeof o?.html_url === 'string' ? o.html_url : null,
    state: typeof state === 'string' ? state : null,
    author: actorOf(o?.user ?? o?.author),
    closer: actorOf(o?.merged_by ?? o?.closed_by),
    body: excerpt(o?.body),
  };
}

export function commentInfo(o: any): CommentInfo {
  return { url: typeof o?.html_url === 'string' ? o.html_url : null, author: actorOf(o?.user), body: excerpt(o?.body) };
}

export function toNotification(t: Thread, r: { subject?: SubjectInfo | null; comment?: CommentInfo | null } = {}): Notification {
  const subjectUrl = r.subject?.url ?? subjectWebUrl(t);
  const comment = hasComment(t);
  const anchor = comment ? commentAnchor(t.subject.latest_comment_url) : null;
  const url = (comment ? r.comment?.url : null) ?? (subjectUrl && anchor && t.subject.type !== 'Release' ? subjectUrl + anchor : subjectUrl) ?? t.repository?.html_url ?? null;
  // Who it is about: the comment's author; for a state change whoever closed or merged it; otherwise the subject's author.
  const actor = comment ? (r.comment?.author ?? null) : t.reason === 'state_change' ? (r.subject?.closer ?? null) : (r.subject?.author ?? null);
  return {
    id: String(t.id),
    source: 'github',
    title: t.subject.title,
    body: comment ? (r.comment?.body ?? null) : (r.subject?.body ?? null),
    url,
    reason: t.reason ?? null,
    context: t.repository?.full_name ?? null,
    subject: { kind: kindOf(t.subject.type ?? ''), title: t.subject.title, url: subjectUrl, state: r.subject?.state ?? null },
    actors: actor ? [actor] : [],
    at: Date.parse(t.updated_at) || 0,
    unread: !!t.unread,
  };
}

/** notify.list's page token: the query of GitHub's next link, so a page token can never point anywhere else. */
const PAGE_KEYS = new Set(['all', 'participating', 'since', 'before', 'per_page', 'page']);
export function pageToken(nextLink: string): string {
  const q = new URL(nextLink).searchParams;
  const keep = new URLSearchParams();
  for (const [k, v] of q) if (PAGE_KEYS.has(k)) keep.set(k, v);
  return Buffer.from(keep.toString()).toString('base64url');
}
export function fromPageToken(token: string): URLSearchParams | null {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const keys = [...q.keys()];
  if (!keys.length || !keys.every((k) => PAGE_KEYS.has(k)) || !/^\d+$/.test(q.get('page') ?? '')) return null;
  return q;
}
