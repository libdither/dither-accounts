/**
 * One passkey request from the page, as the extension's service worker sends it up (packages/browser/src/page/
 * webauthn-worker.js), answered by the authenticator. The kind does its own bookkeeping with what comes back (a
 * passkey made, a sign-in answered, a refusal) and sends `answer` down as the command `webauthn.answer`.
 */
import { type Authenticator, type Caller, type CreateOptions, type CreateResult, type GetOptions, type GetResult, WebAuthnError } from './authenticator.ts';

/** What the service worker sends up: the page's request, and where it came from as Chromium reports it. */
export interface WebauthnUp {
  t: 'webauthn';
  sid: string;
  op: string;
  options: unknown;
  /** The asking frame's origin (port.sender.origin). */
  origin: string;
  /** The asking frame's page, origin and path. */
  page: string;
  /** The tab's top frame's page, origin and path (port.sender.tab.url). */
  topPage?: string;
  top: boolean;
  topOrigin?: string | null;
  ancestors?: string[] | null;
}

export interface WebauthnAnswer {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

export type Responded =
  | { answer: WebauthnAnswer; made: CreateResult; used?: undefined; none?: undefined; refused?: undefined }
  | { answer: WebauthnAnswer; used: GetResult; made?: undefined; none?: undefined; refused?: undefined }
  | { answer: WebauthnAnswer; none: true; made?: undefined; used?: undefined; refused?: undefined }
  | { answer: WebauthnAnswer; refused: WebAuthnError; made?: undefined; used?: undefined; none?: undefined };

export const callerOf = (m: WebauthnUp): Caller => ({
  origin: typeof m.origin === 'string' ? m.origin : '',
  top: m.top === true,
  topOrigin: typeof m.topOrigin === 'string' ? m.topOrigin : null,
  ancestors: Array.isArray(m.ancestors) ? m.ancestors.map(String) : null,
});

/** Answer it: a credential made, an assertion, `none` (the browser's own get runs), or a refusal (no secrets in it). */
export async function respond(auth: Authenticator, m: WebauthnUp): Promise<Responded> {
  try {
    if (m.op === 'create') {
      const made = await auth.create(callerOf(m), m.options as CreateOptions);
      return { answer: { ok: true, result: made }, made };
    }
    if (m.op === 'get') {
      const used = await auth.get(callerOf(m), m.options as GetOptions);
      if (!used) return { answer: { ok: true, result: { none: true } }, none: true };
      return { answer: { ok: true, result: used }, used };
    }
    throw new WebAuthnError('NotAllowedError', 'unknown passkey operation');
  } catch (e) {
    const err = e instanceof WebAuthnError ? e : new WebAuthnError('NotAllowedError', String((e as Error)?.message ?? e));
    return { answer: { ok: false, error: err.message, code: err.code }, refused: err };
  }
}
