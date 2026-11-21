/**
 * `approvals`: signed approval requests answered on paired approver devices (docs/approver.md "Approvals"). Only the
 * manager's built-in account `approver` speaks it (packages/manager/src/approvals.ts); an app (dither-chat's hub) asks
 * through it, and each device's answer comes back as `approvals.answer`, signed by the device's approval key over the
 * statement (dither-chat's docs/approvals.md, "The statement") when the action needs it.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

export interface ApprovalAction {
  id: string;
  label?: string;
  needs: 'signed' | 'any';
}

/** What a device shows; its hashes are in the ask (payload-sha256, display-sha256). */
export interface ApprovalDisplay {
  kind: string;
  asker: string;
  /** One line, at most 200 characters, as it was hashed. */
  title: string;
  body: string;
  payload: string;
  urgency?: 'high' | 'normal' | 'low';
  /** deny always among them, needing no signature. */
  actions: ApprovalAction[];
}

export interface ApprovalDevice {
  id: string;
  name: string;
  /** `phone` or `desk`; null until its keys frame came. */
  kind: 'phone' | 'desk' | null;
  /** Its approval key's SPKI, base64; null until its keys frame came. */
  approvalKey: string | null;
  fingerprint: string | null;
  online: boolean;
}

/**
 * A device's answer. `signed` is the statement's `signed` line (ms since the epoch) whether or not there is a
 * signature; `signature` (base64url DER) and `statement` (the whole signed text, which the manager checked against the
 * device's approval key) come only with a signed answer.
 */
export type ApprovalAnswer =
  | { id: string; ok: true; action: string; message: string | null; signed: number; signature?: string; statement?: string; device: string; deviceName: string; deviceKind: 'phone' | 'desk' }
  | { id: string; ok: false; reason: string; message?: string; device: string; deviceName: string };

export const approvals = iface({
  name: 'approvals',
  version: 1,
  describe: 'Ask for approvals on your paired approver devices, signed by them.',
  levels: {
    read: 'See your approver devices and their approval keys, and the answers they gave',
    write: 'Ask your approver devices to approve things, and cancel what it asked',
  },
  ops: {
    'approvals.devices': op('read', 'The paired devices, their kind and approval key', s.object({}), s.typed<{ devices: ApprovalDevice[] }>()),
    'approvals.ask': op(
      'write',
      'Send a request to every device with an approval key (the ask is the statement’s eight asker lines)',
      s.object({ ask: s.string, display: s.typed<ApprovalDisplay>(), expiresAt: s.optional(s.number) }),
      s.typed<{ devices: number }>(),
    ),
    'approvals.cancel': op('write', 'Withdraw a request from every device', s.object({ id: s.string, reason: s.optional(s.string) }), s.object({})),
    'approvals.intent': op('write', 'Ask the desk signers that hold a request to sign this action (after your finger)', s.object({ id: s.string, action: s.string, message: s.optional(s.nullable(s.string)) }), s.typed<{ sent: number }>()),
    'approvals.answers': op('read', 'The answers given in the last day to these requests (catch-up after a gap)', s.object({ ids: s.array(s.string, 500) }), s.typed<{ answers: ApprovalAnswer[] }>()),
  },
  events: {
    hello: ev('The manager started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
    'approvals.answer': ev('A device answered a request (or refused it: ok false)', s.typed<ApprovalAnswer>()),
  },
});
