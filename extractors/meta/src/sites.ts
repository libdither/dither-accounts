/** The two sites: where each starts, which pages are its sign-in and checks, and which network its facts name. */
export type SiteId = 'messenger' | 'instagram';

export interface Site {
  id: SiteId;
  network: 'messenger' | 'instagram';
  name: string;
  /** Origins the extension's scripts run on. */
  origins: string[];
  start(cfg: Record<string, unknown>): string;
  /** Sign-in pages: the account needs you to sign in. */
  signIn: RegExp;
  /** Checks Meta puts between you and the app (two-factor, checkpoint, consent): yours to pass. */
  check: RegExp;
}

export const SITES: Record<SiteId, Site> = {
  messenger: {
    id: 'messenger',
    network: 'messenger',
    name: 'Messenger',
    origins: ['https://www.messenger.com', 'https://www.facebook.com'],
    // messenger.com still has its own sign-in page and inbox (seen 2026-11-07); `site: "facebook"` uses
    // facebook.com/messages instead, for accounts that sign in there.
    start: (cfg) => (cfg.site === 'facebook' ? 'https://www.facebook.com/messages/' : 'https://www.messenger.com/'),
    signIn: /^\/(login|recover)/i,
    check: /^\/(checkpoint|two_step_verification|two_factor|auth_platform|confirmemail|privacy\/consent|cookie\/consent)/i,
  },
  instagram: {
    id: 'instagram',
    network: 'instagram',
    name: 'Instagram',
    origins: ['https://www.instagram.com'],
    start: () => 'https://www.instagram.com/direct/inbox/',
    signIn: /^\/accounts\/(login|onetap|emailsignup|password)/i,
    check: /^\/(challenge|two_factor|accounts\/(two_factor|suspended|disabled)|auth_platform|consent)/i,
  },
};
