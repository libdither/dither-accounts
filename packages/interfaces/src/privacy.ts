/**
 * `privacy.session`: the privacy kind's own small read interface (docs/privacy.md). Whether Privacy is signed in in
 * the account's sandbox and the non-secret facts about the passkey the account holds. It never returns the key, the
 * full credential id, the user handle or the counter. Transactions and statements come through the `statements`
 * interface (docs/statements.md), not this one.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

export interface PrivacyPasskey {
  enrolled: boolean;
  /** How many passkeys the account holds (one, normally). */
  count: number;
  /** The first 8 characters of the newest one's credential id (base64url). */
  credentialIdPrefix: string | null;
  algorithm: string | null;
  rpId: string | null;
  createdAt: number | null;
  lastUsedAt: number | null;
  /** When a sign-in with it was seen to finish. */
  signInCheckedAt: number | null;
}

export interface PrivacySession {
  /** The app is open on a page that is not a sign-in page. */
  signedIn: boolean;
  /** The tab's page, origin and path only. */
  page: string | null;
  passkey: PrivacyPasskey;
}

export const privacySession = iface({
  name: 'privacy.session',
  version: 1,
  describe: "A Privacy.com account's sign-in and passkey, as facts (never the key).",
  levels: {
    read: 'See whether Privacy is signed in and whether its passkey works',
  },
  ops: {
    'privacy.session': op('read', 'Whether Privacy is signed in in the sandbox, and the passkey it holds (non-secret facts)', s.object({}), s.typed<PrivacySession>()),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
  },
});
