/**
 * A server beyond its channels (dither-chat's docs/servers.md): scheduled events and your Interested, leaving it, its
 * invite links, your nickname, and what it asks of a new member (rules, an application, onboarding). The hook reads
 * and acts through the client's own stores and actions (hook.js, "servers"); this maps what it hands over to the
 * protocol (pure functions, tested in test/servers.test.ts) and runs the commands on the adapter's paces (ServerOps).
 *
 * Never answered for the owner: rules are agreed only when their own answer says so (here, in the hub and in the hook).
 */
import { DISCORD_INVITE_OPTIONS, NICK_MAX, gateAnswerProblem, nickProblem } from '@dither-chat/protocol';
import type * as P from '@dither-chat/protocol';
import type { RawCan, RawUser } from './discord-types.ts';
import { CHANNEL_TYPE, isoToMs, snowflakeToMs } from './map.ts';

// ---------------------------------------------------------------- what the hook hands over

/** One event as hook.js pickEvent whitelists it: the API's shape, with the count and your answer from the store. */
export interface RawEvent {
  id: string;
  guild_id: string;
  channel_id: string | null;
  creator_id: string | null;
  creator?: RawUser | null;
  name: string;
  description: string | null;
  scheduled_start_time: string | null;
  scheduled_end_time: string | null;
  /** 1 scheduled, 2 active, 3 completed, 4 canceled */
  status: number | null;
  /** 1 stage, 2 voice, 3 external */
  entity_type: number | null;
  location: string | null;
  image: string | null;
  recurrence_rule: RawRecurrence | null;
  exceptions: { id: string; is_canceled: boolean; scheduled_start_time: string | null; scheduled_end_time: string | null; rsvp: number | 'none' | null }[];
  user_count: number | null;
  /** 1 interested, 0 not (an occurrence's), 'none': no answer, null: not known yet. */
  rsvp: number | 'none' | null;
}

/** Discord's recurrence rule: frequency 0 yearly, 1 monthly, 2 weekly, 3 daily; weekdays 0 Monday to 6 Sunday. */
export interface RawRecurrence {
  start: string | null;
  end: string | null;
  frequency: number | null;
  interval: number | null;
  by_weekday: number[] | null;
  by_n_weekday: { n: number; day: number }[] | null;
  by_month: number[] | null;
  by_month_day: number[] | null;
  by_year_day: number[] | null;
  count: number | null;
}

export interface RawLink {
  code: string;
  channel_id: string | null;
  inviter_id: string | null;
  inviter?: RawUser | null;
  uses: number | null;
  max_uses: number | null;
  max_age: number | null;
  created_at: string | null;
  expires_at: string | null;
  temporary: boolean;
}

/** hook.js serverAbout: from the stores, no request. */
export interface RawServerAbout {
  guildId: string;
  selfId: string | null;
  ownerId: string | null;
  nick: string | null;
  vanity: string | null;
  can: RawCan & { changeNickname?: boolean | null };
  links: RawLink[];
  inviteChannelId: string | null;
  modules: { leave: boolean; nick: boolean; invites: boolean };
}

export interface RawFormField {
  field_type?: string;
  fieldType?: string;
  label?: string;
  description?: string | null;
  required?: boolean;
  values?: string[];
  choices?: string[];
}

/** hook.js gate: what the member still has to do, as the client has it. */
export type RawGate =
  | { kind: 'screening'; guildId: string; form: { version: string | null; description: string | null; form_fields: RawFormField[] } }
  | { kind: 'apply'; guildId: string; status: string; reason: string | null; form: null }
  | { kind: 'onboarding'; guildId: string; prompts: { id: string; title: string; single_select: boolean; required: boolean; options: { id: string; title: string; description: string | null; emoji: string | null }[] }[] }
  | null;

// ---------------------------------------------------------------- events

const STATUS: Record<number, P.EventStatus> = { 1: 'scheduled', 2: 'active', 3: 'completed', 4: 'cancelled' };
const FREQ = ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY'];
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const ints = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is number => Number.isInteger(x)) : []);
const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Discord's recurrence rule as an RFC 5545 RRULE body; undefined for none, or one it cannot say. */
export function rruleOf(r: RawRecurrence | null | undefined): string | undefined {
  if (!r || r.frequency === null || !FREQ[r.frequency]) return undefined;
  const parts = [`FREQ=${FREQ[r.frequency]}`, `INTERVAL=${Math.max(1, r.interval ?? 1)}`];
  const nth = (r.by_n_weekday ?? []).filter((x) => Number.isInteger(x?.n) && DAYS[x.day]);
  const days = ints(r.by_weekday).filter((d) => DAYS[d]);
  if (nth.length) parts.push(`BYDAY=${nth.map((x) => `${x.n}${DAYS[x.day]}`).join(',')}`);
  else if (days.length) parts.push(`BYDAY=${days.map((d) => DAYS[d]).join(',')}`);
  if (ints(r.by_month).length) parts.push(`BYMONTH=${ints(r.by_month).join(',')}`);
  if (ints(r.by_month_day).length) parts.push(`BYMONTHDAY=${ints(r.by_month_day).join(',')}`);
  if (ints(r.by_year_day).length) parts.push(`BYYEARDAY=${ints(r.by_year_day).join(',')}`);
  if (Number.isInteger(r.count) && r.count! > 0) parts.push(`COUNT=${r.count}`);
  else if (r.end && isoToMs(r.end)) parts.push(`UNTIL=${utc(isoToMs(r.end))}`);
  return parts.join(';');
}

const cdnImage = (eventId: string, hash: string) => `https://cdn.discordapp.com/guild-events/${eventId}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}?size=1024`;

/** One event to a fact; null for one without a start or a name. */
export function mapEvent(e: RawEvent | null | undefined): P.ScheduledEventFact | null {
  if (!e?.id || !e.guild_id) return null;
  const start = isoToMs(e.scheduled_start_time);
  if (!start) return null;
  const end = isoToMs(e.scheduled_end_time);
  const place: P.EventPlace | undefined =
    e.entity_type === 3 ? (e.location ? { kind: 'external', location: e.location } : undefined) : e.channel_id && (e.entity_type === 1 || e.entity_type === 2) ? { kind: e.entity_type === 1 ? 'stage' : 'voice', conversation: e.channel_id } : undefined;
  const rrule = rruleOf(e.recurrence_rule);
  const exceptions: P.EventException[] = (e.exceptions ?? [])
    .filter((x) => x?.id)
    .map((x) => {
      const s = isoToMs(x.scheduled_start_time);
      const en = isoToMs(x.scheduled_end_time);
      return {
        nativeId: x.id,
        // Discord names an exception by a snowflake of the occurrence's original start.
        original: snowflakeToMs(x.id),
        ...(s ? { start: s } : {}),
        ...(en ? { end: en } : {}),
        ...(x.is_canceled ? { cancelled: true } : {}),
        ...(typeof x.rsvp === 'number' ? { youInterested: x.rsvp === 1 } : {}),
      };
    });
  return {
    nativeId: e.id,
    space: e.guild_id,
    name: e.name || '(No title)',
    ...(e.description ? { description: e.description } : {}),
    start,
    ...(end ? { end } : {}),
    status: STATUS[e.status ?? 1] ?? 'scheduled',
    ...(place ? { place } : {}),
    ...(e.image ? { imageUrl: cdnImage(e.id, e.image) } : {}),
    ...(typeof e.user_count === 'number' ? { interested: e.user_count } : {}),
    ...(e.rsvp === 1 ? { youInterested: true } : e.rsvp === 'none' || e.rsvp === 0 ? { youInterested: false } : {}),
    ...(e.creator_id ? { creator: e.creator_id } : {}),
    ...(rrule ? { rrule } : {}),
    ...(rrule && exceptions.length ? { exceptions } : {}),
  };
}

/** The hook's dispatches of events and applications, to facts. Unknown ones: nothing. */
export const SERVER_DISPATCHES = new Set([
  'GUILD_SCHEDULED_EVENT_CREATE',
  'GUILD_SCHEDULED_EVENT_UPDATE',
  'GUILD_SCHEDULED_EVENT_DELETE',
  'GUILD_SCHEDULED_EVENT_USER_ADD',
  'GUILD_SCHEDULED_EVENT_USER_REMOVE',
  'GUILD_SCHEDULED_EVENT_EXCEPTION_CREATE',
  'GUILD_SCHEDULED_EVENT_EXCEPTION_UPDATE',
  'GUILD_SCHEDULED_EVENT_EXCEPTION_DELETE',
  'GUILD_JOIN_REQUEST_UPDATE',
  'USER_GUILD_JOIN_REQUEST_UPDATE',
]);

export function serverDispatch(event: string, a: any): P.AdapterEvent[] {
  if (!SERVER_DISPATCHES.has(event) || !a) return [];
  if (a.gone?.id && a.gone.guild_id) return [{ t: 'scheduledEventGone', space: a.gone.guild_id, nativeId: a.gone.id }];
  if (a.event) {
    const e = mapEvent(a.event);
    return e ? [{ t: 'scheduledEvent', event: e }] : [];
  }
  if (a.application?.guild_id) {
    const g = applicationGate(a.application.guild_id, a.application.status, a.application.reason);
    return g === undefined ? [] : [{ t: 'gate', space: a.application.guild_id, gate: g }];
  }
  return [];
}

/** An application's outcome as a gate: still waiting or turned down, or nothing once let in. undefined: nothing to say. */
function applicationGate(guildId: string, status: string, reason: string | null): P.SpaceGate | null | undefined {
  if (status === 'APPROVED') return null;
  if (status === 'SUBMITTED') return { space: guildId, kind: 'apply', status: 'submitted' };
  if (status === 'REJECTED') return { space: guildId, kind: 'apply', status: 'rejected', ...(reason ? { reason } : {}) };
  return undefined;
}

// ---------------------------------------------------------------- gates

/** What the hook says the member still has to do, as a gate. */
export function mapGate(raw: RawGate): P.SpaceGate | null {
  if (!raw) return null;
  if (raw.kind === 'apply') return applicationGate(raw.guildId, raw.status, raw.reason) ?? null;
  if (raw.kind === 'onboarding') {
    return {
      space: raw.guildId,
      kind: 'onboarding',
      prompts: raw.prompts.map((p) => ({
        id: p.id,
        title: p.title,
        single: p.single_select,
        required: p.required,
        options: p.options.map((o) => ({ id: o.id, title: o.title, ...(o.description ? { description: o.description } : {}), ...(o.emoji ? { emoji: o.emoji } : {}) })),
      })),
    };
  }
  const fields = raw.form.form_fields ?? [];
  const rules: string[] = [];
  const questions: P.GateQuestion[] = [];
  fields.forEach((f, i) => {
    const type = f.field_type ?? f.fieldType;
    if (type === 'TERMS') rules.push(...(f.values ?? []).filter((v) => typeof v === 'string'));
    else if (type === 'TEXT_INPUT' || type === 'PARAGRAPH' || type === 'MULTIPLE_CHOICE')
      questions.push({
        id: String(i),
        kind: type === 'TEXT_INPUT' ? 'text' : type === 'PARAGRAPH' ? 'paragraph' : 'choice',
        label: f.label ?? '',
        ...(f.description ? { description: f.description } : {}),
        required: !!f.required,
        ...(type === 'MULTIPLE_CHOICE' ? { choices: f.choices ?? [] } : {}),
      });
  });
  return {
    space: raw.guildId,
    // Questions beyond the rules make it an application a moderator answers.
    kind: questions.length ? 'apply' : 'rules',
    ...(raw.form.description ? { description: raw.form.description } : {}),
    ...(rules.length ? { rules } : {}),
    ...(questions.length ? { questions, status: 'open' as const } : {}),
    ...(raw.form.version ? { version: raw.form.version } : {}),
  };
}

// ---------------------------------------------------------------- the About

const NEED_INVITE = 'You need the Create Invite permission.';
const NEED_MANAGE = 'Only people who may manage the server see and turn off every link; you can turn off the ones you made.';

/** An invite link to a fact. */
export function mapLink(l: RawLink, selfId: string | null, manage: boolean): P.InviteLinkFact {
  const expires = isoToMs(l.expires_at);
  return {
    code: l.code,
    url: `https://discord.gg/${l.code}`,
    ...(l.channel_id ? { conversation: l.channel_id } : {}),
    ...(l.inviter_id ? { inviter: l.inviter_id } : {}),
    ...(typeof l.uses === 'number' ? { uses: l.uses } : {}),
    ...(typeof l.max_uses === 'number' ? { maxUses: l.max_uses } : {}),
    ...(expires ? { expiresAt: expires } : {}),
    ...(l.temporary ? { temporary: true } : {}),
    canRevoke: manage || (!!selfId && l.inviter_id === selfId),
  };
}

/** A server's About with what this adds: whether you may leave it, your nickname, and its invite links. */
export function withServer(about: P.About, raw: RawServerAbout, caps: P.Capability[]): P.About {
  const owner = !!raw.selfId && raw.ownerId === raw.selfId;
  const manage = raw.can.manageGuild === true;
  const links = raw.links.map((l) => mapLink(l, raw.selfId, manage));
  const create = raw.can.createInvite === true && !!raw.inviteChannelId;
  const nickCan = raw.can.changeNickname;
  return {
    ...about,
    ...(caps.includes('leave') ? { leaving: owner ? { can: false, reason: 'You own this server: Discord lets you leave only after you give it to someone else (Server Settings → Members) or delete it, in Discord.' } : { can: true } } : {}),
    ...(caps.includes('nick')
      ? { nick: { value: raw.nick, canEdit: nickCan === true, ...(nickCan === true ? {} : { reason: nickCan === false ? 'You need the Change Nickname permission here.' : 'Discord did not say whether you may.' }), max: NICK_MAX } }
      : {}),
    ...(caps.includes('inviteLinks')
      ? {
          invite: {
            link: links[0]?.url ?? (raw.vanity ? `https://discord.gg/${raw.vanity}` : null),
            canCreate: create,
            canRevoke: links.some((l) => l.canRevoke),
            ...(create ? {} : { reason: raw.can.createInvite === true ? 'There is no channel here you may invite people to.' : NEED_INVITE }),
            links,
            ...(raw.vanity ? { vanity: `https://discord.gg/${raw.vanity}` } : {}),
            options: DISCORD_INVITE_OPTIONS,
          },
        }
      : {}),
    ...(caps.includes('inviteLinks') && !manage && links.length === 0 && raw.can.createInvite === true ? { facts: [...(about.facts ?? []), { label: 'Invite links', value: NEED_MANAGE }] } : {}),
  };
}

/** What `configure` asks the hook for to change a link: checked against the server's About first. */
export type InvitePlan = { kind: 'createInvite'; guildId: string; channelId: string; maxAge: number; maxUses: number; temporary: boolean } | { kind: 'revokeInvite'; guildId: string; code: string; channelId: string | null };

export function invitePlan(raw: RawServerAbout, change: Extract<P.AboutChange, { key: 'invite' }>): InvitePlan {
  const about = withServer({ fields: {} }, raw, ['inviteLinks']);
  const inv = about.invite!;
  if (change.op === 'create') {
    if (!inv.canCreate) throw new Error(inv.reason ?? NEED_INVITE);
    const maxAge = change.maxAge ?? DISCORD_INVITE_OPTIONS.defaults.maxAge;
    const maxUses = change.maxUses ?? DISCORD_INVITE_OPTIONS.defaults.maxUses;
    if (!DISCORD_INVITE_OPTIONS.maxAge.includes(maxAge)) throw new Error('Not one of the expiry choices Discord offers');
    if (!DISCORD_INVITE_OPTIONS.maxUses.includes(maxUses)) throw new Error('Not one of the use limits Discord offers');
    return { kind: 'createInvite', guildId: raw.guildId, channelId: raw.inviteChannelId!, maxAge, maxUses, temporary: change.temporary === true };
  }
  const link = change.code ? inv.links?.find((l) => l.code === change.code) : inv.links?.[0];
  if (!link) throw new Error(change.code ? 'That link is not one you can see here: look again' : 'There is no link to turn off');
  if (!link.canRevoke) throw new Error(NEED_MANAGE);
  return { kind: 'revokeInvite', guildId: raw.guildId, code: link.code, channelId: link.conversation ?? null };
}

/** The capabilities the modules found allow. */
export function serverCapabilities(found: Record<string, boolean>): P.Capability[] {
  const caps: P.Capability[] = [];
  if (found.GuildScheduledEventStore) caps.push('events');
  if (found.GuildScheduledEventStore && found.EventActions) caps.push('rsvp');
  if (found.GuildActions) caps.push('leave');
  if (found.VerificationActions || (found.OnboardingActions && found.OnboardingStore)) caps.push('gates');
  if (found.InviteActions && found.Rest) caps.push('inviteLinks');
  if (found.NickActions && found.GuildMemberStore) caps.push('nick');
  return caps;
}

// ---------------------------------------------------------------- the commands

interface Bridge {
  request<T>(cmd: { kind: string; [k: string]: unknown }, timeoutMs: number): Promise<T>;
}
interface Pace {
  run<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export interface ServerOpsDeps {
  bridge: Bridge;
  /** Writes: as the adapter paces sends and settings. */
  pace: Pace;
  /** Reads a click makes (counts, a form, the links). */
  lookPace: Pace;
  emit: (ev: P.AdapterEvent) => void;
  /** Identity facts for people an answer names. */
  users: (users: (RawUser | null | undefined)[]) => void;
  caps: () => P.Capability[];
  log: (level: 'debug' | 'info' | 'warn', msg: string, data?: unknown) => void;
}

/** A check the client wanted (a captcha): the owner's, in the live view. */
function checked(r: { check?: string } | null | undefined, what: string) {
  if (r?.check) throw new Error(`Discord wants a ${r.check} check before it will ${what}: open the live view`);
}

export class ServerOps {
  constructor(private d: ServerOpsDeps) {}

  private need(cap: P.Capability, what: string) {
    if (!this.d.caps().includes(cap)) throw new Error(`${what} isn't available: the hook did not find Discord's own module for it (Discord changed?)`);
  }

  /** Every server's events from the client's store (no request), or one server's: after the snapshot, after a join. */
  async syncEvents(guildId?: string) {
    if (!this.d.caps().includes('events')) return;
    try {
      const r = await this.d.bridge.request<{ known: boolean; guilds: Record<string, RawEvent[]> }>({ kind: 'serverEventsAll', ...(guildId ? { guildId } : {}) }, 15_000);
      if (!r?.known) return;
      for (const [gid, list] of Object.entries(r.guilds ?? {})) {
        this.d.users(list.map((e) => e.creator));
        this.d.emit({ t: 'scheduledEvents', space: gid, events: list.map(mapEvent).filter((e): e is P.ScheduledEventFact => !!e) });
      }
    } catch (e) {
      this.d.log('debug', 'reading scheduled events failed', String(e));
    }
  }

  async scheduledEvents(space: string): Promise<P.ScheduledEventsResult> {
    this.need('events', 'Scheduled events');
    const r = await this.d.lookPace.run('events', () => this.d.bridge.request<{ events: RawEvent[] }>({ kind: 'serverEvents', guildId: space }, 60_000));
    this.d.users((r.events ?? []).map((e) => e.creator));
    const events = (r.events ?? []).map(mapEvent).filter((e): e is P.ScheduledEventFact => !!e);
    this.d.emit({ t: 'scheduledEvents', space, events });
    return { events };
  }

  async rsvp(cmd: Extract<P.AdapterCommand, { t: 'rsvp' }>): Promise<P.ScheduledEventFact> {
    this.need('rsvp', 'Saying Interested');
    // An occurrence by its original start (the calendar's) is the snowflake of that start, as Discord names it.
    const occ = cmd.occurrence && /^\d{13}$/.test(cmd.occurrence) ? msToSnowflake(Number(cmd.occurrence)) : cmd.occurrence;
    const r = await this.d.pace.run('rsvp', () => this.d.bridge.request<{ event?: RawEvent; check?: string }>({ kind: 'rsvp', guildId: cmd.space, eventId: cmd.event, ...(occ ? { exceptionId: occ } : {}), interested: cmd.interested }, 45_000));
    checked(r, 'take your answer');
    const e = mapEvent(r.event);
    if (!e) throw new Error('Discord did not say how the event stands now');
    this.d.emit({ t: 'scheduledEvent', event: e });
    return e;
  }

  async leave(cmd: Extract<P.AdapterCommand, { t: 'leave' }>): Promise<P.LeaveResult> {
    this.need('leave', 'Leaving');
    if (cmd.target.kind !== 'space') throw new Error("Leaving a Discord group DM from here isn't built yet");
    const r = await this.d.pace.run('leave', () => this.d.bridge.request<{ left?: boolean; channels?: { id: string; type: number }[]; check?: string }>({ kind: 'leaveGuild', guildId: cmd.target.nativeId }, 45_000));
    checked(r, 'let you leave');
    for (const c of r.channels ?? []) this.d.emit({ t: 'leave', kind: c.type === CHANNEL_TYPE.CATEGORY ? 'space' : 'conversation', nativeId: c.id });
    this.d.emit({ t: 'leave', kind: 'space', nativeId: cmd.target.nativeId });
    this.d.emit({ t: 'gate', space: cmd.target.nativeId, gate: null });
    return { left: true };
  }

  /** The store's bits of a server's About; with invite links listed as its settings list them, for a manager. */
  async serverAbout(guildId: string, list: boolean): Promise<RawServerAbout> {
    const raw = await this.d.bridge.request<RawServerAbout>({ kind: 'serverAbout', guildId }, 15_000);
    if (list && this.d.caps().includes('inviteLinks') && raw.can?.manageGuild === true) {
      try {
        const r = await this.d.lookPace.run('invites', () => this.d.bridge.request<{ links: RawLink[] }>({ kind: 'listInvites', guildId }, 30_000));
        raw.links = r.links ?? raw.links;
      } catch (e) {
        this.d.log('info', 'listing invite links failed; showing the ones kept', String(e));
      }
    }
    this.d.users(raw.links.map((l) => l.inviter));
    return raw;
  }

  async about(target: P.AboutTarget, about: P.About): Promise<P.About> {
    if (target.kind !== 'space' || about.noun !== 'Server') return about;
    const caps = this.d.caps();
    if (!caps.some((c) => c === 'leave' || c === 'nick' || c === 'inviteLinks')) return about;
    try {
      return withServer(about, await this.serverAbout(target.nativeId, true), caps);
    } catch (e) {
      this.d.log('info', 'reading the server part of the about failed', String(e));
      return about;
    }
  }

  /** An invite link made or turned off; then the About read again. */
  async invite(target: P.AboutTarget, change: Extract<P.AboutChange, { key: 'invite' }>, reread: () => Promise<P.About>): Promise<P.About> {
    this.need('inviteLinks', 'Invite links');
    if (target.kind !== 'space') throw new Error('Discord links lead to a server: change them on the server');
    const plan = invitePlan(await this.serverAbout(target.nativeId, true), change);
    const r = await this.d.pace.run('invite', () => this.d.bridge.request<{ check?: string }>({ ...plan }, 45_000));
    checked(r, plan.kind === 'createInvite' ? 'make a link' : 'turn the link off');
    return reread();
  }

  async setNick(space: string, nick: string, reread: () => Promise<P.About>): Promise<P.About> {
    this.need('nick', 'Nicknames');
    const problem = nickProblem(nick);
    if (problem) throw new Error(problem);
    const raw = await this.serverAbout(space, false);
    if (raw.can.changeNickname === false) throw new Error('You need the Change Nickname permission here');
    const r = await this.d.pace.run('nick', () => this.d.bridge.request<{ check?: string }>({ kind: 'setNick', guildId: space, nick: nick.trim() }, 30_000));
    checked(r, 'change your nickname');
    return reread();
  }

  async gate(space: string): Promise<P.SpaceGate | null> {
    this.need('gates', 'Answering what a server asks');
    const raw = await this.d.lookPace.run('gate', () => this.d.bridge.request<RawGate>({ kind: 'gate', guildId: space }, 45_000));
    const g = mapGate(raw);
    this.d.emit({ t: 'gate', space, gate: g });
    return g;
  }

  /** The owner's own answer: checked against the gate as it stands, then the client's own submit. */
  async answerGate(space: string, answer: P.GateAnswer): Promise<P.GateResult> {
    const gate = await this.gate(space);
    if (!gate) throw new Error('This server asks nothing of you now');
    const problem = gateAnswerProblem(gate, answer);
    if (problem) throw new Error(problem);
    const r = await this.d.pace.run('answerGate', () => this.d.bridge.request<{ status?: string | null; next?: RawGate; check?: string }>({ kind: 'answerGate', guildId: space, answer }, 60_000));
    checked(r, 'take your answer');
    if (r.status === 'SUBMITTED') {
      const g: P.SpaceGate = { ...gate, status: 'submitted' };
      this.d.emit({ t: 'gate', space, gate: g });
      return { done: true, status: 'submitted', next: null };
    }
    const next = mapGate(r.next ?? null);
    this.d.emit({ t: 'gate', space, gate: next });
    return { done: true, ...(r.status === 'APPROVED' ? { status: 'approved' as const } : {}), next };
  }
}

function msToSnowflake(ms: number): string {
  return ((BigInt(Math.floor(ms)) - 1420070400000n) << 22n).toString();
}
