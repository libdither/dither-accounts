/**
 * Notices (docs/notices.md): what your accounts and services tell you (GitHub's notifications, dither-accounts' own
 * word about an account that needs you), through dither-accounts' `notifications` interface, triaged with your chats.
 */
import type { TriageView } from './api.ts';

/**
 * Whether the hub may read them: `off` without DITHER_ACCOUNTS_URL, `unreachable` while the manager does not answer,
 * `pending` until you approve the hub's request on the manager's page, `denied` if you declined it.
 */
export type NoticeAccessState = 'off' | 'unreachable' | 'pending' | 'denied' | 'granted';

/** The source's own hint (absent: normal). Never the decision: triage starts from it. */
export type NoticeUrgency = 'high' | 'normal' | 'low';

export interface NoticeView {
  /** `ntc_…`: also the id marks take (POST /api/messages/:id/feedback). */
  id: string;
  accountId: string;
  /** What raised it: 'github', 'dither-accounts'… */
  source: string;
  /** Where it belongs: a repository, an app, an account. */
  context: string | null;
  /** Its notifications' group (`ntg_…`): one notification per group, the key device rules and Mute use. */
  group: string;
  title: string;
  body: string | null;
  /** Where it leads, on the web. */
  url: string | null;
  /** Why you got it, in the service's words. */
  reason: string | null;
  urgency: NoticeUrgency;
  actors: { name: string; url: string | null }[];
  at: number;
  unread: boolean;
  /** Absent until triage decided. */
  triage?: TriageView;
}

export interface NoticeAccountView {
  id: string;
  kind: string;
  label: string;
}

/** GET /api/notices: the last 30 days, newest first. */
export interface NoticesPage {
  access: NoticeAccessState;
  /** The manager's page, where you approve the request (DITHER_ACCOUNTS_PUBLIC_URL). */
  managerUrl: string | null;
  accounts: NoticeAccountView[];
  items: NoticeView[];
}

/** In the bootstrap of a hub that has notices. */
export interface NoticesBoot {
  access: NoticeAccessState;
}
