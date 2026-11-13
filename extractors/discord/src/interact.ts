/**
 * Bots and apps (dither-chat's docs/apps.md): pressing a bot's buttons and choosing in its selects, its slash commands
 * with their suggestions, apps' message commands, and the forms (modals) a bot opens in answer. The hook runs each
 * through the client's own code (hook.js, "bots and apps"); this maps what the hub asks to the hook's commands and what
 * the hook hands back to the protocol (pure functions, tested in test/interact.test.ts).
 *
 * One interaction per hub command, and the hub sends one per click of the owner's: none is paced behind other work
 * (a click goes when it is made), none is retried, and nothing is pressed or run unless the hub asked.
 */
import type * as P from '@dither-chat/protocol';
import type { RawUser } from './discord-types.ts';

// ---------------------------------------------------------------- what the hook hands over

export interface RawCommandOption {
  type: P.AppOptionType | null;
  name: string;
  description?: string;
  required?: true;
  autocomplete?: true;
  choices?: { name: string; value: string | number }[];
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
}

export interface RawCommand {
  id: string;
  name: string;
  description?: string;
  app?: string;
  /** 1 chat, 2 user, 3 message */
  type: number;
  nsfw?: true;
  options: RawCommandOption[];
}

export interface RawApp {
  id: string;
  name: string;
  icon?: string;
  bot?: RawUser | { id: string };
}

/** hook.js ixCommands: the place's commands as the client's slash list has them. */
export interface RawCommands {
  commands: RawCommand[];
  apps: RawApp[];
  loading?: boolean;
}

/** hook.js INTERACTION_OUTCOME. */
export interface RawOutcome {
  nonce: string;
  channelId: string;
  messageId: string | null;
  state: P.InteractionState;
  error?: string;
}

/** hook.js INTERACTION_FORM: a form a bot opened for an interaction sent from here, its fields already flat. */
export interface RawForm {
  id: string;
  nonce: string;
  channelId: string;
  title: string;
  application: RawApp;
  fields: P.ModalFieldFact[];
}

export type InteractHookCommand =
  /** reply { nonce } */
  | { kind: 'ixComponent'; channelId: string; messageId: string; customId: string; values?: string[] }
  /** reply RawCommands */
  | { kind: 'ixCommands'; channelId: string; commandKind: P.AppCommandKind }
  /** reply { nonce } */
  | { kind: 'ixRun'; channelId: string; commandKind: P.AppCommandKind; commandId: string; app: string; options: P.AppOptionValue[]; targetId?: string }
  /** reply { choices } */
  | { kind: 'ixSuggest'; channelId: string; commandId: string; app: string; options: P.AppOptionValue[]; focused: string; query: string }
  /** reply { nonce } */
  | { kind: 'ixSubmit'; formId: string; values: P.ModalValue[] };

export const INTERACT_DISPATCHES = new Set(['INTERACTION_OUTCOME', 'INTERACTION_FORM']);
export type InteractDispatch = 'INTERACTION_OUTCOME' | 'INTERACTION_FORM';

// ---------------------------------------------------------------- capabilities

/** What this account can do with bots, from the client modules the hook found. */
export function interactCapabilities(found: Record<string, boolean>): P.Capability[] {
  const caps: P.Capability[] = [];
  if (found.ComponentInteract && found.MessageStore) caps.push('interactComponents');
  if (found.CommandExecute && found.CommandIndexStore) caps.push('interactCommands', 'interactContext');
  if (found.InteractionQueue && found.Snowflakes && found.AuthenticationStore && found.Rest) caps.push('interactModals');
  return caps;
}

// ---------------------------------------------------------------- mapping

const KINDS: Record<number, P.AppCommandKind> = { 1: 'chat', 2: 'user', 3: 'message' };
const OPTION_TYPES = new Set<P.AppOptionType>(['string', 'integer', 'number', 'boolean', 'user', 'channel', 'role', 'mentionable', 'attachment']);
const isUser = (u: unknown): u is RawUser => !!u && typeof u === 'object' && typeof (u as RawUser).id === 'string' && typeof (u as RawUser).username === 'string';

export function mapOption(o: RawCommandOption): P.AppOptionFact | null {
  if (!o || typeof o.name !== 'string' || !o.type || !OPTION_TYPES.has(o.type)) return null;
  const choices = Array.isArray(o.choices) ? o.choices.filter((c) => c && typeof c.name === 'string' && (typeof c.value === 'string' || typeof c.value === 'number')).slice(0, 25) : [];
  return {
    name: o.name,
    type: o.type,
    ...(o.description ? { description: o.description } : {}),
    ...(o.required ? { required: true as const } : {}),
    ...(choices.length ? { choices: choices.map((c) => ({ name: c.name, value: c.value })) } : {}),
    ...(o.autocomplete && !choices.length ? { autocomplete: true as const } : {}),
    ...(typeof o.min === 'number' ? { min: o.min } : {}),
    ...(typeof o.max === 'number' ? { max: o.max } : {}),
    ...(typeof o.min_length === 'number' ? { minLength: o.min_length } : {}),
    ...(typeof o.max_length === 'number' ? { maxLength: o.max_length } : {}),
  };
}

/** A command, or null when it has an option of a kind the protocol does not know (it is left out, never half shown). */
export function mapCommand(c: RawCommand): P.AppCommandFact | null {
  if (!c || typeof c.id !== 'string' || typeof c.name !== 'string' || !c.app) return null;
  const kind = KINDS[c.type];
  if (!kind) return null;
  const options: P.AppOptionFact[] = [];
  for (const o of Array.isArray(c.options) ? c.options : []) {
    const m = mapOption(o);
    if (!m) return null;
    options.push(m);
  }
  return { id: c.id, name: c.name, ...(c.description ? { description: c.description } : {}), app: c.app, kind, options, ...(c.nsfw ? { nsfw: true as const } : {}) };
}

export function mapApp(a: RawApp): P.AppFact {
  return { id: a.id, name: a.name, ...(a.icon ? { icon: a.icon } : {}), ...(a.bot?.id ? { bot: a.bot.id } : {}) };
}

/** The bots' users to say before the commands (so the hub knows who `bot` is), and the result. */
export function commandsOutcome(raw: RawCommands): { users: RawUser[]; result: P.AppCommandsResult } {
  const commands = (raw.commands ?? []).map(mapCommand).filter((c): c is P.AppCommandFact => !!c);
  const used = new Set(commands.map((c) => c.app));
  const apps = (raw.apps ?? []).filter((a) => a && used.has(a.id));
  return { users: apps.map((a) => a.bot).filter(isUser), result: { commands, apps: apps.map(mapApp) } };
}

/** The hook's INTERACTION_OUTCOME and INTERACTION_FORM, as protocol events (a form's bot first, as an identity). */
export function interactDispatch(event: string, data: any): { users: RawUser[]; events: P.AdapterEvent[] } {
  if (event === 'INTERACTION_OUTCOME') {
    const o = data as RawOutcome;
    if (!o?.nonce || !o.channelId || !o.state) return { users: [], events: [] };
    return { users: [], events: [{ t: 'interaction', outcome: { nonce: o.nonce, conversation: o.channelId, ...(o.messageId ? { message: o.messageId } : {}), state: o.state, ...(o.error ? { error: o.error } : {}) } }] };
  }
  if (event === 'INTERACTION_FORM') {
    const f = data as RawForm;
    if (!f?.id || !f.nonce || !f.channelId || !f.application?.id) return { users: [], events: [] };
    const fields = (Array.isArray(f.fields) ? f.fields : []).filter((x) => x && typeof x === 'object' && (x.kind === 'display' ? typeof x.text === 'string' : typeof (x as { id?: unknown }).id === 'string'));
    return {
      users: isUser(f.application.bot) ? [f.application.bot] : [],
      events: [{ t: 'appModal', modal: { id: f.id, nonce: f.nonce, conversation: f.channelId, app: mapApp(f.application), title: f.title || 'A form', fields } }],
    };
  }
  return { users: [], events: [] };
}

/** The hub's command for the hook. Checks only what is the adapter's to check; the hub checked the rest. */
export function interactHookCommand(cmd: Extract<P.AdapterCommand, { t: 'interact' }>): InteractHookCommand {
  const i = cmd.interaction;
  switch (i?.kind) {
    case 'component':
      return { kind: 'ixComponent', channelId: cmd.conversation, messageId: i.message, customId: i.component, ...(i.values ? { values: i.values.map(String) } : {}) };
    case 'command':
      return { kind: 'ixRun', channelId: cmd.conversation, commandKind: i.target?.kind ?? 'chat', commandId: i.command, app: i.app, options: i.options ?? [], ...(i.target ? { targetId: i.target.id } : {}) };
    case 'modal':
      return { kind: 'ixSubmit', formId: i.modal, values: i.values ?? [] };
    default:
      throw new Error('What should it do?');
  }
}

/** Which capability an interaction needs. */
export function interactCapability(i: P.InteractRequest): P.Capability {
  return i.kind === 'component' ? 'interactComponents' : i.kind === 'modal' ? 'interactModals' : i.target ? 'interactContext' : 'interactCommands';
}
