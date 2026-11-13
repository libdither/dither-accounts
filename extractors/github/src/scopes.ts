/**
 * What a token can do for notifications, from its shape and the scopes GitHub reports for it (X-OAuth-Scopes). GitHub's
 * notifications API takes classic personal access tokens (and OAuth app tokens) with the notifications or repo scope;
 * it does not take fine-grained tokens or GitHub App tokens. Without repo, private repositories' issues and pull
 * requests cannot be read, so their state is not resolved (their links still are).
 */

export type TokenType = 'classic' | 'fine-grained' | 'oauth' | 'github app' | 'unknown';

export function tokenType(t: string | null): TokenType | null {
  if (!t) return null;
  if (t.startsWith('ghp_') || /^[0-9a-f]{40}$/.test(t)) return 'classic';
  if (t.startsWith('github_pat_')) return 'fine-grained';
  if (t.startsWith('gho_')) return 'oauth';
  if (t.startsWith('ghu_') || t.startsWith('ghs_')) return 'github app';
  return 'unknown';
}

export const CLASSIC =
  "Make a classic token (github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)) with the notifications scope, and repo too for private repositories' issues and pull requests";

export interface Verdict {
  /** It can read notifications (as far as its scopes say). */
  ok: boolean;
  /** What to tell you when it cannot: what is missing and what to do. */
  message: string | null;
  /** One line for the scopes layer. */
  note: string;
  /** Private repositories' subjects can be read. */
  repo: boolean;
}

/** `scopes` null: GitHub sent no X-OAuth-Scopes (fine-grained and App tokens). */
export function scopeVerdict(token: string | null, scopes: string[] | null, recheckS = 60): Verdict {
  const type = tokenType(token);
  if (scopes === null) {
    if (type === 'fine-grained')
      return { ok: false, repo: false, message: `This is a fine-grained token, and GitHub's notifications API only takes classic ones. ${CLASSIC}, and replace this account's token with it.`, note: 'a fine-grained token: it cannot read notifications' };
    if (type === 'github app')
      return { ok: false, repo: false, message: `This is a GitHub App token, and GitHub's notifications API does not take those. ${CLASSIC}, and replace this account's token with it.`, note: 'a GitHub App token: it cannot read notifications' };
    // Something that reports no scopes but may still work: the notifications endpoint will say.
    return { ok: true, repo: true, message: null, note: 'GitHub reported no scopes for this token' };
  }
  const has = (s: string) => scopes.includes(s);
  if (!has('notifications') && !has('repo')) {
    const what = scopes.length ? `only ${scopes.join(', ')}` : 'no scopes';
    return {
      ok: false,
      repo: false,
      message: `The token has ${what}, not notifications. On GitHub, edit it (Settings → Developer settings → Personal access tokens → Tokens (classic)) and tick notifications (and repo for private repositories' subjects); this account checks again every ${recheckS} s. Or replace this account's token with a new one.`,
      note: `has ${what}; needs notifications`,
    };
  }
  if (has('repo')) return { ok: true, repo: true, message: null, note: scopes.join(', ') };
  return { ok: true, repo: false, message: null, note: `${scopes.join(', ')}; no repo scope, so private repositories' subjects are not resolved` };
}
