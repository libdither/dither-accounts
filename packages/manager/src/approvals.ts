/**
 * Approvals (docs/approver.md "Approvals"): a built-in account, kind `approver`, that offers the `approvals` interface
 * to apps (dither-chat's hub asks at `write`). It is never a process: the router answers its operations here, and its
 * events go out through Router.event like any extractor's, so grants, buffering and gaps apply unchanged.
 *
 * - approvals.ask: a request (the statement's eight asker lines and what to show), checked, then sent at once to every
 *   paired device with an approval key whose link is up, and to the others when their link's keys frame comes, until it
 *   is answered, cancelled or expires. Devices without a link are woken. Not through the passkey queue: approvals are
 *   not one at a time.
 * - A device's answer is checked before it goes on: the action is one offered, its message fits, and a signature (which
 *   an action that needs one must carry) verifies with the device's approval key over the whole statement rebuilt here.
 *   A good one becomes `approvals.answer`, is kept a day (approvals.answers), and cancels the request on every other
 *   device. A refusal (ok false) goes on too, and the request stays for the other devices.
 * - approvals.intent: the page asked the laptop to sign; forwarded to the desk devices that hold the request.
 * - Requests live in memory only, until their expiry (a restart loses them; the hub asks again). The audit (`approval`
 *   table) gets op `approve`, the asker as the account and the kind as the reason: never the title, body, payload or
 *   message.
 */
import { type Action, answerText, type Ask, checkRequest, type Display, fingerprint, MAX_MESSAGE, messageHash, verifySignature } from '@dither-accounts/approval';
import { type ApprovalAnswer, type ApprovalDevice, approvals } from '@dither-accounts/interfaces';
import type { Approvers } from './approvers.ts';
import { newToken, type Store } from './db.ts';
import { type Kind, kindOf } from './kinds.ts';
import { CallFailure, type Router } from './router.ts';
import { accountDir, type Supervisor } from './supervisor.ts';

export const APPROVER_ID = 'approver';
export const APPROVER_KIND = 'approver';
export const APPROVER_LABEL = 'Approvers';
/** Answers are kept this long for approvals.answers. */
export const KEEP_ANSWERS_MS = 86_400_000;
/** At most this many requests wait at once. */
export const MAX_HELD = 200;
/** setTimeout's longest wait; a later expiry re-arms. */
const MAX_TIMER = 2 ** 31 - 1;

/** The built-in kind: no directory, no entry, never started. */
export function approverKind(): Kind {
  return { ...kindOf({ kind: APPROVER_KIND, name: APPROVER_LABEL, interfaces: [approvals.name], entry: '' }, ''), builtin: true };
}

interface Held {
  id: string;
  askText: string;
  ask: Ask;
  display: Display;
  /** Devices holding it on their current link. */
  sentTo: Set<string>;
  /** Devices that refused it or said it expired: it is not sent to them again. */
  doneBy: Set<string>;
  sent: boolean;
  timer: Timer;
}

const fail = (code: 'invalid' | 'limited', message: string, status?: number): never => {
  throw new CallFailure({ code, message, ...(status ? { status } : {}) });
};
const REFUSALS = new Set(['expired', 'refused', 'error']);

export class Approvals {
  private held = new Map<string, Held>();
  private on = false;

  constructor(
    private store: Store,
    private router: Router,
    private sup: Supervisor,
    private approvers: Approvers,
    private opts: { dataDir: string; keepMs?: number },
  ) {}

  /** Makes the account if it is missing, answers its operations, hears the links, says it is online. */
  start() {
    const had = this.store.account(APPROVER_ID);
    if (had && had.kind !== APPROVER_KIND) {
      console.error(`[approvals] account "${APPROVER_ID}" is a ${had.kind} account: approvals are off`);
      return;
    }
    if (!had) {
      const now = Date.now();
      this.store.run(
        'INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)',
        APPROVER_ID,
        APPROVER_KIND,
        APPROVER_LABEL,
        '{}',
        newToken(),
        accountDir(this.opts.dataDir, APPROVER_ID),
        now,
        now,
      );
    } else if (!had.enabled) this.store.run('UPDATE account SET enabled = 1 WHERE id = ?', APPROVER_ID);
    this.on = true;
    this.sup.inProcess.add(APPROVER_ID);
    this.router.inProcess.set(APPROVER_ID, (op, input) => this.handle(op, input));
    this.approvers.hooks = { keys: (d) => this.keys(d), gone: (d) => this.gone(d), response: (d, m) => this.response(d, m) };
    this.router.event(APPROVER_ID, { t: 'hello', version: '1', label: APPROVER_LABEL, builtin: true });
    this.router.event(APPROVER_ID, { t: 'status', status: 'online' });
    this.sweepAnswers();
  }

  stop() {
    this.on = false;
    this.approvers.hooks = null;
    for (const h of this.held.values()) clearTimeout(h.timer);
    this.held.clear();
  }

  private get keepMs() {
    return this.opts.keepMs ?? KEEP_ANSWERS_MS;
  }

  // ---------------------------------------------------------------- operations

  async handle(op: string, input: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'approvals.devices':
        return { devices: this.devices() };
      case 'approvals.ask':
        return this.ask(input);
      case 'approvals.cancel':
        this.cancel(String(input.id), 'cancelled');
        return {};
      case 'approvals.intent':
        return this.intent(String(input.id), String(input.action), input.message);
      case 'approvals.answers': {
        this.sweepAnswers();
        const ids = (input.ids as unknown[]).filter((x): x is string => typeof x === 'string');
        if (!ids.length) return { answers: [] };
        const rows = this.store.all<{ answer: string }>(`SELECT answer FROM approval_answer WHERE id IN (${ids.map(() => '?').join(',')}) AND at > ?`, ...ids, Date.now() - this.keepMs);
        return { answers: rows.map((r) => JSON.parse(r.answer) as ApprovalAnswer) };
      }
    }
    throw new CallFailure({ code: 'unknown-op', message: `approvals have no operation "${op}"` });
  }

  devices(): ApprovalDevice[] {
    return this.approvers.all().map((d) => ({ id: d.id, name: d.name, kind: d.kind ?? null, approvalKey: d.approvalKey ?? null, fingerprint: d.approvalKey ? fingerprint(d.approvalKey) : null, online: this.approvers.online(d.id) }));
  }

  private ask(input: Record<string, unknown>): { devices: number; answered?: true } {
    const checked = checkRequest({ ask: input.ask, display: input.display });
    if (typeof checked === 'string') return fail('invalid', checked);
    const { ask, display } = checked;
    if (input.expiresAt !== undefined && input.expiresAt !== ask.expires) return fail('invalid', 'expiresAt is not the ask’s expires');
    const text = input.ask as string;
    // Asked again (an app that lost its answer, or this manager restarted): the same request, never another.
    if (this.store.one('SELECT 1 FROM approval_answer WHERE id = ?', ask.id)) return { devices: 0, answered: true };
    const had = this.held.get(ask.id);
    if (had) {
      if (had.askText !== text || JSON.stringify(had.display) !== JSON.stringify(display)) return fail('invalid', `${ask.id} was asked with other words`);
      for (const d of this.approvers.all()) this.deliver(had, d.id);
      return { devices: had.sentTo.size };
    }
    if (this.held.size >= MAX_HELD) return fail('limited', `at most ${MAX_HELD} requests wait at once`);
    const now = Date.now();
    this.store.run(
      `INSERT INTO approval (id, account, rp_id, op, device, reason, outcome, created_at) VALUES (?, ?, '', 'approve', '', ?, 'waiting', ?)
       ON CONFLICT(id) DO UPDATE SET outcome = 'waiting', message = NULL, device = '', sent_at = NULL, decided_at = NULL, created_at = excluded.created_at`,
      ask.id,
      ask.asker,
      ask.kind,
      now,
    );
    const h: Held = { id: ask.id, askText: text, ask, display, sentTo: new Set(), doneBy: new Set(), sent: false, timer: this.arm(ask.id, ask.expires) };
    this.held.set(h.id, h);
    for (const d of this.approvers.all()) {
      if (!d.approvalKey) continue;
      if (!this.deliver(h, d.id) && !this.approvers.online(d.id)) this.approvers.wakeUp(d.id);
    }
    return { devices: h.sentTo.size };
  }

  private arm(id: string, expires: number): Timer {
    return setTimeout(
      () => {
        const h = this.held.get(id);
        if (!h) return;
        if (Date.now() >= h.ask.expires) this.end(h, 'expired', null);
        else h.timer = this.arm(id, expires);
      },
      Math.min(MAX_TIMER, Math.max(0, expires - Date.now())),
    );
  }

  /** To one device, when it may have it and its link is ready for it (keys checked); whether it went now. */
  private deliver(h: Held, device: string): boolean {
    if (h.sentTo.has(device) || h.doneBy.has(device) || !this.approvers.device(device)?.approvalKey || !this.approvers.keyedOnline(device)) return false;
    const sent = this.approvers.send(device, { t: 'request', id: h.id, op: 'approve', ask: h.askText, display: h.display, expiresAt: h.ask.expires });
    if (!sent) return false;
    h.sentTo.add(device);
    if (!h.sent) {
      h.sent = true;
      this.store.run('UPDATE approval SET sent_at = COALESCE(sent_at, ?) WHERE id = ?', Date.now(), h.id);
    }
    return true;
  }

  /** Withdrawn by the app (or answered on the page): every device that holds it drops it. Unknown ids are fine. */
  private cancel(id: string, outcome: 'cancelled') {
    const h = this.held.get(id);
    if (h) this.end(h, outcome, null);
  }

  private intent(id: string, action: string, message: unknown): { sent: number } {
    const h = this.held.get(id);
    if (!h) return fail('invalid', `no request ${id.slice(0, 40)} waits here`, 404);
    if (!h.display.actions.some((a) => a.id === action)) return fail('invalid', `${action.slice(0, 40)} is not one of its actions`);
    if (message != null && (typeof message !== 'string' || message.length > MAX_MESSAGE)) return fail('invalid', `a message is at most ${MAX_MESSAGE} characters`);
    let sent = 0;
    for (const d of h.sentTo) if (this.approvers.device(d)?.kind === 'desk' && this.approvers.send(d, { t: 'intent', id, action, message: message || null })) sent++;
    return { sent };
  }

  /** It ends: cancelled on every device holding it (but the one that answered), audited, forgotten. */
  private end(h: Held, outcome: string, by: { device: string; action: string } | null) {
    clearTimeout(h.timer);
    this.held.delete(h.id);
    for (const d of h.sentTo) if (d !== by?.device) this.approvers.send(d, { t: 'cancel', id: h.id });
    this.store.run('UPDATE approval SET outcome = ?, message = ?, device = ?, decided_at = ? WHERE id = ?', outcome, by?.action ?? null, by?.device ?? '', Date.now(), h.id);
    this.router.count('approver', APPROVER_ID, 'approve', outcome);
    this.approvers.changed();
  }

  // ---------------------------------------------------------------- the links

  /** A device's keys checked out on a new link: what waits goes to it. */
  private keys(device: string) {
    for (const h of this.held.values()) this.deliver(h, device);
  }

  /** Its link went: it holds nothing until the next one's keys frame. */
  private gone(device: string) {
    for (const h of this.held.values()) h.sentTo.delete(device);
  }

  /** A device's answer, checked; anything that doesn't check out is dropped (and logged), and the request waits on. */
  private async response(device: string, m: Record<string, unknown>) {
    const id = String(m.id);
    const h = this.held.get(id);
    const dev = this.approvers.device(device);
    const drop = (why: string) => void console.log(`[approvals] ${device} answered ${id.slice(0, 40)}: ${why}: dropped`);
    if (!h) return drop('no such request waits');
    if (!dev?.approvalKey) return drop('it has no approval key');
    if (h.doneBy.has(device)) return drop('it refused it before');
    if (m.ok !== true) {
      const reason = REFUSALS.has(m.reason as string) ? (m.reason as string) : 'error';
      const message = typeof m.message === 'string' && m.message ? m.message.slice(0, 300) : undefined;
      // A check that failed, or expired, there: not sent to it again. An error (a finger that didn't match) may be tried again.
      if (reason !== 'error') {
        h.doneBy.add(device);
        h.sentTo.delete(device);
      }
      this.emit({ id, ok: false, reason, ...(message ? { message } : {}), device, deviceName: dev.name });
      return;
    }
    const action: Action | undefined = h.display.actions.find((a) => a.id === m.action);
    if (!action) return drop('an action it was not offered');
    if (m.message != null && (typeof m.message !== 'string' || m.message.length > MAX_MESSAGE)) return drop(`a message over ${MAX_MESSAGE} characters`);
    const message = (m.message as string | null | undefined) || null;
    const signature = typeof m.signature === 'string' && m.signature ? m.signature : null;
    const signedOk = typeof m.signed === 'number' && Number.isSafeInteger(m.signed) && m.signed >= 0;
    if (signature && !signedOk) return drop('a signature without its time');
    if (!signature && action.needs === 'signed') return drop(`${action.id} needs a signature`);
    const signed = signedOk ? (m.signed as number) : Date.now();
    let statement: string | null = null;
    if (signature) {
      statement = h.askText + answerText({ action: action.id, messageSha256: messageHash(message), device, signed });
      if (signature.length > 200 || !(await verifySignature(dev.approvalKey, statement, signature))) return drop('a signature that does not check out with its approval key');
    }
    // Answered elsewhere, cancelled or expired while the signature was checked.
    if (this.held.get(id) !== h) return drop('it ended meanwhile');
    const answer: ApprovalAnswer = { id, ok: true, action: action.id, message, signed, ...(signature ? { signature, statement: statement! } : {}), device, deviceName: dev.name, deviceKind: dev.kind ?? 'phone' };
    this.store.run('INSERT OR REPLACE INTO approval_answer (id, answer, at) VALUES (?, ?, ?)', id, JSON.stringify(answer), Date.now());
    this.sweepAnswers();
    this.end(h, action.id === 'deny' ? 'denied' : 'ok', { device, action: action.id });
    this.emit(answer);
  }

  private emit(a: ApprovalAnswer) {
    if (this.on) this.router.event(APPROVER_ID, { t: 'approvals.answer', ...a });
  }

  private sweepAnswers() {
    this.store.run('DELETE FROM approval_answer WHERE at <= ?', Date.now() - this.keepMs);
  }
}
