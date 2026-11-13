/**
 * The amazon account's status from what the extractor knows. Pure, so it is tested (test/status.test.ts). A pull that
 * stopped for you (a captcha, a checkpoint, a code) is held until the live view shows it cleared: that is the
 * attention. Signed out with a stored password is fine (the next pull signs in as amazon_auth.py did); signed out
 * without one is an attention.
 */
export interface View {
  hold: { kind: string; message: string; since: number } | null;
  /** What Amazon's header says on the tab you see: null when no Amazon page with a header was seen yet. */
  navSignedIn: boolean | null;
  hasPassword: boolean;
  page: string | null;
}

export const SIGN_IN_MESSAGE = 'Sign in to Amazon in the live view (or store the password on this account: the pull then signs in by itself when Amazon asks).';

export function state(v: View): { status: string; attention: { kind: string; message: string; liveView: boolean } | null } {
  if (v.hold) return { status: 'attention', attention: { kind: v.hold.kind, message: v.hold.message, liveView: true } };
  if (v.navSignedIn === false && !v.hasPassword) return { status: 'attention', attention: { kind: 'login', message: SIGN_IN_MESSAGE, liveView: true } };
  return { status: 'online', attention: null };
}

export function signedInLayer(v: View): { name: string; state: 'ok' | 'waiting' | 'failed'; note: string } {
  if (v.hold) return { name: 'signed in', state: 'failed', note: `held: ${v.hold.kind} (open the live view)` };
  if (v.navSignedIn === true) return { name: 'signed in', state: 'ok', note: 'Amazon says hello' };
  if (v.navSignedIn === false) return { name: 'signed in', state: 'waiting', note: v.hasPassword ? 'signed out; the next pull signs in with the stored password' : 'signed out: sign in in the live view' };
  return { name: 'signed in', state: 'waiting', note: 'not seen yet' };
}
