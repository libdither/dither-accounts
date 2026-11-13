/**
 * A group's admin side (dither-chat's docs/moderation.md): who may remove, ban, make admins and end it, the banned
 * and those asking to join, member labels, leaving as its only admin, a new picture and link approval. Pure
 * functions from signal-cli's listGroups JSON, tested in test/groups.test.ts; the adapter (adapter.ts, "groups
 * admin") runs the calls. Signal's servers enforce who may do what and signal-cli does not, so every change is
 * gated here first, by the same read the About is made from.
 */
import type * as P from '@dither-chat/protocol';
import { MEMBER_LABEL_MAX, memberLabelProblem, modRefusal } from '@dither-chat/protocol';
import type { SigGroup } from './types.ts';

const lc = (s: string | null | undefined) => (s ? s.toLowerCase() : undefined);
const ids = (list: { uuid?: string | null }[] | undefined) => [...new Set((list ?? []).map((m) => lc(m.uuid)).filter((x): x is string => !!x))];

export const ONLY_ADMINS = 'Only admins can do this.';
export const ENDED = 'This group has been ended.';

/** Is this ACI an admin of the group, as listGroups says now? */
export function isAdmin(g: SigGroup, aci: string): boolean {
  return (g.members ?? []).some((m) => lc(m.uuid) === aci && m.isAdmin);
}

/** Why this account can do nothing in the group, or null. */
function outOf(g: SigGroup): string | null {
  if (g.isTerminated) return ENDED;
  if (g.isMember === false) return 'You are no longer in this group.';
  return null;
}

/** What an admin may do to the members, as Signal's own group settings offer it. */
export function groupModeration(g: SigGroup, self: string): P.AboutModeration {
  const out = outOf(g);
  const admin = !out && isAdmin(g, self);
  const p: P.ModPower = admin ? { can: true } : { can: false, reason: out ?? ONLY_ADMINS };
  return {
    remove: p,
    ban: p,
    admins: p,
    end: p,
    banned: ids(g.banned),
    ...(admin ? { requesting: ids(g.requestingMembers) } : {}),
  };
}

/** A member's label as listGroups gives it, when they set one. */
export function labelOf(m: { label?: string | null; labelEmoji?: string | null }): { text?: string; emoji?: string } | undefined {
  const text = m.label?.trim() || undefined;
  const emoji = m.labelEmoji?.trim() || undefined;
  return text || emoji ? { ...(text ? { text } : {}), ...(emoji ? { emoji } : {}) } : undefined;
}

/** Your own label here, and whether you may set it (any member can). */
export function ownLabel(g: SigGroup, self: string): P.AboutLabel {
  const me = (g.members ?? []).find((m) => lc(m.uuid) === self);
  const out = outOf(g);
  const l = me ? labelOf(me) : undefined;
  return { value: l?.text ?? null, emoji: l?.emoji ?? null, canEdit: !out && !!me, ...(out ? { reason: out } : {}), max: MEMBER_LABEL_MAX };
}

/** Leaving: always possible for a member; as its only admin with others in it, someone must be made admin. */
export function groupLeaving(g: SigGroup, self: string): P.AboutLeaving {
  if (g.isMember === false) return { can: false, reason: 'You are no longer in this group.' };
  const members = ids(g.members);
  const admins = (g.members ?? []).filter((m) => m.isAdmin).map((m) => lc(m.uuid));
  const onlyAdmin = !g.isTerminated && admins.length === 1 && admins[0] === self && members.length > 1;
  return {
    can: true,
    ...(onlyAdmin ? { needsAdmin: true, warning: 'You are its only admin: Signal wants someone else made admin as you leave.' } : {}),
    canForget: true,
  };
}

/** quitGroup's params: the group, who becomes admin, and whether to forget it on this device. Refuses what Signal would. */
export function quitParams(g: SigGroup, self: string, admins: string[] | undefined, forget: boolean): Record<string, unknown> {
  const leaving = groupLeaving(g, self);
  if (!leaving.can) throw new Error(leaving.reason ?? 'You cannot leave this group.');
  const members = new Set(ids(g.members));
  const next = [...new Set((admins ?? []).map((a) => a.toLowerCase()))];
  for (const a of next) if (a === self || !members.has(a)) throw new Error('Only someone still in the group can take over as admin.');
  if (leaving.needsAdmin && !next.length) throw new Error('You are its only admin: name who becomes admin first.');
  return { groupId: g.id, ...(next.length ? { admin: next } : {}), ...(forget ? { delete: true } : {}) };
}

/**
 * updateGroup's params for one moderating action, or terminateGroup's for `end`; null when it is already so. Throws
 * the refusal in words for anything this account may not do, by the same read the About is made from.
 */
export function moderateParams(g: SigGroup, self: string, a: P.ModAction): { method: 'updateGroup' | 'terminateGroup'; params: Record<string, unknown> } | null {
  const m = groupModeration(g, self);
  if (a.op === 'role' || a.op === 'timeout') throw new Error('Signal groups have no roles or timeouts: only admins and members.');
  if (a.op === 'voiceMute' || a.op === 'voiceDeafen' || a.op === 'move' || a.op === 'disconnect') throw new Error('Signal groups have no voice channels to moderate.');
  const who = a.op === 'end' ? null : a.who.toLowerCase();
  if (who === self) throw new Error('That is you.');
  const inIt = who ? ids(g.members).includes(who) : false;
  const refusal = modRefusal(m, a.op === 'end' ? a : { ...a, who: who! }, undefined, inIt || a.op === 'ban' || a.op === 'unban');
  if (refusal) throw new Error(refusal);
  switch (a.op) {
    case 'remove':
      return { method: 'updateGroup', params: { removeMember: [who] } };
    case 'ban':
      // Banning someone in it removes them too, as Signal's own "Remove and ban" does.
      return ids(g.banned).includes(who!) ? null : { method: 'updateGroup', params: { ban: [who] } };
    case 'unban':
      if (!ids(g.banned).includes(who!)) throw new Error('They are not banned here.');
      return { method: 'updateGroup', params: { unban: [who] } };
    case 'admin': {
      const now = isAdmin(g, who!);
      if (a.remove ? !now : now) return null;
      return { method: 'updateGroup', params: a.remove ? { removeAdmin: [who] } : { admin: [who] } };
    }
    case 'end':
      return { method: 'terminateGroup', params: { groupId: g.id } };
  }
}

/** updateGroup's params for your own member label ('' clears it). */
export function labelParams(g: SigGroup, self: string, text: string, emoji: string | undefined): Record<string, unknown> {
  const problem = memberLabelProblem(text, emoji);
  if (problem) throw new Error(problem);
  const own = ownLabel(g, self);
  if (!own.canEdit) throw new Error(own.reason ?? 'You cannot set a label here.');
  return { memberLabel: text.trim(), ...(emoji !== undefined ? { memberLabelEmoji: emoji.trim() } : {}) };
}

/** Join requests to a group this account admins: `join:<groupId>:<aci>`, answered by adding or removing them. */
export function joinRequestId(groupId: string, aci: string) {
  return `join:${groupId}:${aci}`;
}
export function parseJoinRequest(id: string): { groupId: string; aci: string } | null {
  const m = /^join:(.+):([0-9a-f-]{36})$/i.exec(id);
  return m ? { groupId: m[1]!, aci: m[2]!.toLowerCase() } : null;
}

/** Everyone asking to join a group this account admins, as requests (first seen at `seen`, else now). */
export function joinRequests(groups: Iterable<SigGroup>, self: string, seen: (id: string) => number, conv: (groupId: string) => string): P.RequestFact[] {
  const out: P.RequestFact[] = [];
  for (const g of groups) {
    if (g.isMember === false || g.isTerminated || !isAdmin(g, self)) continue;
    for (const aci of ids(g.requestingMembers)) {
      const id = joinRequestId(g.id, aci);
      out.push({ nativeId: id, kind: 'join', from: aci, target: { kind: 'conversation', nativeId: conv(g.id), ...(g.name ? { name: g.name } : {}), members: ids(g.members).length }, ts: seen(id), answers: ['accept', 'decline'] });
    }
  }
  return out;
}

/** updateGroup's params to answer one: accept adds them (an approval), decline removes them from the requests. */
export function answerJoinParams(g: SigGroup, self: string, aci: string, answer: P.RequestAnswer): Record<string, unknown> {
  if (!isAdmin(g, self) || g.isTerminated) throw new Error(ONLY_ADMINS);
  if (!ids(g.requestingMembers).includes(aci)) throw new Error('That request is not waiting any more');
  if (answer === 'accept') return { member: [aci] };
  if (answer === 'decline') return { removeMember: [aci] };
  throw new Error(`A request to join cannot be answered with ${answer}`);
}

/** updateGroup's params for link approval: on is the link with approval, off the link without. Needs the link on. */
export function approvalParams(g: SigGroup, on: unknown): Record<string, unknown> {
  if (typeof on !== 'boolean') throw new Error('on or off');
  if (!g.groupInviteLink) throw new Error('Turn the group link on first: approval is about who joins with it.');
  return { link: on ? 'enabled-with-approval' : 'enabled' };
}

/** A file:// URL the hub gave for a new picture, as a path signal-cli reads. */
export function picturePath(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('file://')) throw new Error('which picture?');
  return decodeURIComponent(new URL(v).pathname);
}
