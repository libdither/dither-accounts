/**
 * `claude`: a Claude (claude.ai) account signed in in the account's sandboxed browser (docs/claude.md). It exists so
 * the manager's `cliproxy` provider can sign the account in to CLIProxyAPI, the hub that serves the subscription to
 * Claude Code: it signs claude.ai in with a magic link from the account's mailbox and approves CLIProxyAPI's OAuth
 * request on claude.ai's own consent page. It never reads chats, never sends a prompt and never sees a token: the
 * callback URL it hands back carries a one-time code that only CLIProxyAPI can redeem (PKCE).
 *
 * Refusal codes (CallError.code, status 409): `needs-you` (a check only you can answer, in the live view),
 * `wrong-account` (claude.ai is signed in as another email), `signed-out` (claude.authorize before a sign-in),
 * `bad-link` / `bad-url` (input that is not claude.ai's), `no-form` (the page did not show what was expected; see
 * claude.survey).
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

export interface ClaudeSession {
  /** null until the extractor has looked. */
  signedIn: boolean | null;
  /** The email claude.ai says is signed in. */
  email: string | null;
  /** The email this account is for (its config). */
  expectedEmail: string | null;
  /** The tab's page, origin and path only. */
  page: string | null;
  /** The organizations' rate limit tiers claude.ai reports (`default_claude_max_20x`), when signed in. */
  tiers: string[];
}

/** What a page shows, without any value typed into it: for when a step finds the page not as expected. */
export interface ClaudeSurvey {
  page: string;
  title: string;
  headings: string[];
  inputs: { type: string; name: string | null; id: string | null; placeholder: string | null; label: string | null }[];
  buttons: string[];
  challenge: boolean;
}

export const claude = iface({
  name: 'claude',
  version: 1,
  describe: 'A Claude account signed in in a sandboxed browser, so the CLIProxyAPI hub can be signed in to it.',
  levels: {
    read: 'See whether Claude is signed in, and as whom',
    manage: 'Sign Claude in with a magic link and approve OAuth requests on its consent page',
  },
  ops: {
    'claude.session': op('read', 'Whether claude.ai is signed in in the sandbox, as whom, and its plan tiers', s.object({}), s.typed<ClaudeSession>(), 30_000),
    'claude.survey': op('read', "The tab's page as structure (headings, fields, buttons; never a value)", s.object({}), s.typed<ClaudeSurvey>(), 30_000),
    'claude.signin.start': op(
      'manage',
      "Ask claude.ai to email this account's address a sign-in link (nothing is done when it is signed in already)",
      s.object({}),
      s.typed<{ already: boolean; email: string | null; requestedAt: number | null }>(),
      90_000,
    ),
    'claude.signin.finish': op(
      'manage',
      'Open the emailed sign-in link (https://claude.ai/magic-link#…) in the sandbox and wait until claude.ai is signed in as this account',
      s.object({ link: s.string }),
      s.typed<{ email: string | null }>(),
      90_000,
    ),
    'claude.authorize': op(
      'manage',
      "Open an OAuth authorize URL on claude.ai, approve it, and hand back the localhost callback URL it redirects to (not loaded)",
      s.object({ url: s.string }),
      s.typed<{ callbackUrl: string }>(),
      90_000,
    ),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
  },
});
