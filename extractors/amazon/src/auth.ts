/**
 * dither-finance's connectors/amazon_auth.py, for the extension: when an order page lands on Amazon's sign-in, type
 * the stored email and password (and, if one is stored, the authenticator code) as you would; anything else — a
 * captcha, a code sent by text or email, an approval on your phone — stops the pull for you to clear in the live view.
 * Nothing here solves a captcha.
 */
import { createHmac } from 'node:crypto';
import { NeedsYouHere } from './amazon.ts';

export interface Cred {
  email?: string;
  password?: string;
  totpSecret?: string;
}
/** What page.js `probe` reports. */
export interface Probe {
  url: string;
  ready?: string;
  captcha: boolean;
  robot: boolean;
  human: boolean;
  email: { empty: boolean } | null;
  password: boolean;
  otp: boolean;
  cvf: boolean;
  continueButton: boolean;
  signedIn: boolean | null;
}

/** RFC 6238 (SHA-1, 30 s, 6 digits), as amazon_auth.py `totp`. */
export function totp(secret: string, at = Date.now() / 1000): string {
  const s = secret.replaceAll(' ', '').toUpperCase();
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '')) {
    const v = A.indexOf(c);
    if (v < 0) throw new Error('the authenticator secret is not base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30)));
  const d = createHmac('sha1', key).update(msg).digest();
  const o = d[d.length - 1] & 15;
  return String((d.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const signedInUrl = (url: string) => !url.includes('/ap/signin') && !url.includes('/ap/mfa') && !url.includes('/ap/cvf');

export const NEEDS = {
  signIn: 'Amazon wants you to sign in: open the live view and sign in (or store the password on this account)',
  captcha: 'Amazon is showing a captcha: open the live view and sign in by hand; the next pull waits until you have',
  code: 'Amazon wants a one-time code: sign in by hand in the live view, or store an authenticator secret on this account',
  verify: "Amazon wants to verify it's you (a code by text or email): sign in by hand in the live view",
  stuck: "Couldn't get past Amazon's sign-in: sign in by hand in the live view",
  human: "Amazon wants you to confirm you're human: open the live view and tick the box; the next pull waits until you have",
  robot: "Amazon is showing its robot check: open the live view and type the characters; the next pull waits until you have",
};

export interface EnsureDeps {
  url: () => Promise<string>;
  probe: () => Promise<Probe | null>;
  step: (step: 'email' | 'password' | 'otp', value: string) => Promise<{ ok: boolean; why?: string }>;
  sleep: (ms: number) => Promise<void>;
  cred: () => Cred;
  log: (msg: string) => void;
}

/** amazon_auth.py `ensure`: get past Amazon's sign-in prompts in the tab, or throw NeedsYouHere. */
export async function ensure(d: EnsureDeps, tries = 3): Promise<void> {
  if (signedInUrl(await d.url())) return;
  const cred = d.cred();
  if (!cred.password) throw new NeedsYouHere(NEEDS.signIn, 'login');
  d.log('Amazon asks for the password again: answering with the stored one');
  for (let i = 0; i < tries * 4; i++) {
    await d.sleep(1200);
    if (signedInUrl(await d.url())) return;
    const p = await d.probe();
    if (!p) continue; // the page is changing under us
    if (p.captcha) throw new NeedsYouHere(NEEDS.captcha, 'captcha');
    if (p.email && p.email.empty) {
      if (!p.continueButton) throw new Error("Amazon's sign-in page has no continue button");
      await d.step('email', cred.email ?? '');
      continue;
    }
    if (p.password) {
      await d.step('password', cred.password);
      continue;
    }
    if (p.otp) {
      if (!cred.totpSecret) throw new NeedsYouHere(NEEDS.code, 'code');
      await d.step('otp', totp(cred.totpSecret));
      continue;
    }
    if (p.cvf) throw new NeedsYouHere(NEEDS.verify, 'code');
  }
  if (!signedInUrl(await d.url())) throw new NeedsYouHere(NEEDS.stuck, 'login');
}
