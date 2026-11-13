/**
 * Bots and apps (docs/apps.md): pressing a bot's buttons and choosing in its selects, running its slash commands, and
 * filling in the forms (modals) it opens in answer, each from one click of the owner's. Discord is the only network
 * with them today; the shapes are the protocol's.
 *
 * Every interaction is one request the owner caused. Nothing here is retried, and nothing presses or runs anything
 * by itself: a bot's controls and texts are untrusted, shown and never followed.
 *
 * Adapter side: the capabilities, commands and events below, each capability advertised only when the adapter found
 * what it needs (Discord: the client's own modules). Hub side: the views at the end, from /api/conversations/:id/apps/*.
 */
import type { MediaUrl } from './adapter.ts';
import type { Network } from './ontology.ts';
import type { SelectKind, SelectOptionFact } from './rich.ts';

export type InteractCapability =
  /** Presses a bot's buttons and chooses in its selects (`interact` with a component). */
  | 'interactComponents'
  /** Lists the slash commands a conversation has (`appCommands`), completes their options (`appAutocomplete`), runs them (`interact` with a command). */
  | 'interactCommands'
  /** Says when a bot opens a form in answer (the `appModal` event) and sends the owner's answers (`interact` with a modal). */
  | 'interactModals'
  /** Lists and runs apps' message commands (Discord's Apps menu on a message): `appCommands` with kind 'message'. */
  | 'interactContext';

// ---------------------------------------------------------------- commands an app offers

/** What an option takes. */
export type AppOptionType = 'string' | 'integer' | 'number' | 'boolean' | 'user' | 'channel' | 'role' | 'mentionable' | 'attachment';

export interface AppChoiceFact {
  name: string;
  value: string | number;
}

export interface AppOptionFact {
  name: string;
  description?: string;
  type: AppOptionType;
  required?: true;
  /** The only values it takes, when the app lists them. */
  choices?: AppChoiceFact[];
  /** The app suggests values as you type (`appAutocomplete`). */
  autocomplete?: true;
  /** For numbers: the smallest and largest it takes. */
  min?: number;
  max?: number;
  /** For strings: the shortest and longest. */
  minLength?: number;
  maxLength?: number;
}

/** chat: typed after a slash; message: run on a message (its Apps menu); user: run on a person. */
export type AppCommandKind = 'chat' | 'message' | 'user';

export interface AppCommandFact {
  /** The network's id for it (Discord: the command's id, then its group and subcommand names, NUL-separated). */
  id: string;
  /** What is typed after the slash, groups and subcommands included: "remind me". */
  name: string;
  description?: string;
  /** The app's id (AppFact.id). */
  app: string;
  kind: AppCommandKind;
  options: AppOptionFact[];
  /** Only for age-restricted channels. */
  nsfw?: true;
}

export interface AppFact {
  id: string;
  name: string;
  icon?: MediaUrl;
  /** The app's bot, as a native identity id (its identity fact comes first). */
  bot?: string;
}

/** The `appCommands` reply: what this account may run in the conversation, as the network's own client lists it. */
export interface AppCommandsResult {
  commands: AppCommandFact[];
  apps: AppFact[];
}

/**
 * An option's value as the owner gave it. `ref`: the value is a native id of that kind (a person, a role, a channel);
 * without it, a user, role, channel or mentionable option's value is a name the owner typed, which the network's own
 * client resolves as it would a typed one.
 */
export interface AppOptionValue {
  name: string;
  value: string | number | boolean;
  ref?: 'user' | 'role' | 'channel';
}

/** An answer to one field of a form (AppModalFact). Only what its kind takes. */
export interface ModalValue {
  /** The field's id (ModalFieldFact id). */
  field: string;
  /** A text field's text, or a radio group's value. */
  value?: string;
  /** A select's or checkbox group's values (native ids for user, role and channel selects). */
  values?: string[];
  /** A lone checkbox. */
  checked?: boolean;
}

/** What one `interact` does. */
export type InteractRequest =
  /** Press a button (no `values`) or choose in a select (`values`) on a bot's message. `component` is its custom id. */
  | { kind: 'component'; message: string; component: string; values?: string[] }
  /** Run a command; `target` is the message or person (native ids) a message or user command is run on. */
  | { kind: 'command'; command: string; app: string; options: AppOptionValue[]; target?: { kind: 'message' | 'user'; id: string } }
  /** Send the owner's answers to a form a bot opened (`modal`: AppModalFact.id). */
  | { kind: 'modal'; modal: string; values: ModalValue[] };

/** The `interact` reply: what the network calls this interaction. Its outcome comes as `interaction` events. */
export interface InteractResult {
  nonce: string;
}

/** The `appAutocomplete` reply: the app's suggestions for the option being typed in, at most 25. */
export interface AppAutocompleteResult {
  choices: AppChoiceFact[];
}

// ---------------------------------------------------------------- what happened

/**
 * sending: on its way, nothing back yet. answered: the bot answered (it changed the message, replied, or said it is
 * thinking). failed: it refused, or the bot did not answer in time ("This interaction failed"). timedOut: nothing came
 * back at all. modal: the bot opened a form (an `appModal` event).
 */
export type InteractionState = 'sending' | 'answered' | 'failed' | 'timedOut' | 'modal';

export interface InteractionOutcome {
  nonce: string;
  conversation: string;
  /** The message whose control was pressed. */
  message?: string;
  state: InteractionState;
  /** Why, for failed, in words. */
  error?: string;
}

/** A field of a form. Its `id` is the bot's custom id. */
export type ModalFieldFact =
  | { kind: 'text'; id: string; label?: string; description?: string; style: 'short' | 'paragraph'; placeholder?: string; value?: string; required?: true; minLength?: number; maxLength?: number }
  | { kind: 'select'; id: string; label?: string; description?: string; select: SelectKind; options?: SelectOptionFact[]; placeholder?: string; min?: number; max?: number; required?: true }
  | { kind: 'radio'; id: string; label?: string; description?: string; options: SelectOptionFact[]; required?: true }
  | { kind: 'checkboxes'; id: string; label?: string; description?: string; options: SelectOptionFact[]; min?: number; max?: number; required?: true }
  | { kind: 'checkbox'; id: string; label?: string; description?: string; default?: true }
  /** A file to upload: not sent from dither (answer it on the network). */
  | { kind: 'file'; id: string; label?: string; description?: string; required?: true }
  /** Words in the form, not a field. */
  | { kind: 'display'; text: string };

/** A form a bot opened in answer to one of the owner's interactions. It can be sent once, within 15 minutes. */
export interface AppModalFact {
  /** The network's id for it (Discord: the interaction id it answers to). */
  id: string;
  /** The interaction it answers (InteractResult.nonce). */
  nonce: string;
  conversation: string;
  app: AppFact;
  title: string;
  fields: ModalFieldFact[];
}

/** A form's answers are sent at most this long after it opened (Discord's interaction tokens last 15 minutes). */
export const MODAL_TTL_MS = 15 * 60_000;
/** Text fields take at most this much. */
export const MODAL_TEXT_MAX = 4000;

// ---------------------------------------------------------------- adapter commands and events

export type InteractCommand =
  /** The commands of `kind` (default chat) this account may run in the conversation (capability 'interactCommands' or, for message, 'interactContext'). reply.result: AppCommandsResult */
  | { t: 'appCommands'; id: string; conversation: string; kind?: AppCommandKind }
  /** The app's suggestions for `focused` as `query` is typed (capability 'interactCommands'). reply.result: AppAutocompleteResult */
  | { t: 'appAutocomplete'; id: string; conversation: string; command: string; app: string; options: AppOptionValue[]; focused: string; query: string }
  /** One interaction (capability per kind: 'interactComponents', 'interactCommands' / 'interactContext', 'interactModals'). reply.result: InteractResult */
  | { t: 'interact'; id: string; conversation: string; interaction: InteractRequest };

export type InteractEvent =
  /** How an interaction this account sent went. Of the moment: the hub relays it and keeps nothing. */
  | { t: 'interaction'; outcome: InteractionOutcome }
  /** A bot opened a form in answer to one of this account's interactions (capability 'interactModals'). */
  | { t: 'appModal'; modal: AppModalFact };

// ---------------------------------------------------------------- what the hub hands the page

export interface AppView {
  id: string;
  name: string;
  icon?: string;
  /** Its bot, as a hub identity id. */
  identityId?: string;
}

/** GET /api/conversations/:id/apps/commands?kind= */
export interface AppCommandsView {
  accountId: string | null;
  commands: AppCommandFact[];
  apps: AppView[];
  /** Why there are none to offer (not connected, not built for this account). */
  reason?: string;
}

/**
 * Something a user, role, channel or mentionable option or select can take, from what the hub already knows of the
 * place: people seen there, its roles as its About last said, its channels. `value` goes back as it is.
 */
export interface AppPickView {
  value: string;
  name: string;
  kind: 'user' | 'role' | 'channel';
  color?: string;
}

/** POST /api/conversations/:id/apps/interact { interaction, accountId? }: the page's request, in hub ids. */
export type InteractRequestBody =
  /** `messageId`: a hub message id. `values`: a string select's values, or AppPickView values. */
  | { kind: 'component'; messageId: string; component: string; values?: string[] }
  /** Option values of user, role, channel and mentionable options may be AppPickView values, or a typed name. */
  | { kind: 'command'; command: string; app: string; options: { name: string; value: string | number | boolean }[]; targetMessageId?: string }
  | { kind: 'modal'; modal: string; values: ModalValue[] };

export interface InteractView {
  nonce: string;
}

/** An interaction's outcome, in hub ids (ClientEvent 'interaction'). */
export interface InteractionView {
  nonce: string;
  conversationId: string;
  messageId?: string;
  state: InteractionState;
  error?: string;
  ts: number;
}

/** A form, in hub ids (ClientEvent 'appModal'). */
export interface AppModalView {
  id: string;
  nonce: string;
  conversationId: string;
  accountId: string;
  network: Network;
  app: AppView;
  title: string;
  fields: ModalFieldFact[];
  /** When the hub heard it: answers go within MODAL_TTL_MS of it. */
  at: number;
}

/**
 * Whether a form's answers are fit to send, in words: null when they are. Checked by the hub before sending, and by
 * the page as the owner fills it in.
 */
export function modalProblem(fields: ModalFieldFact[], values: ModalValue[]): string | null {
  const by = new Map(values.map((v) => [v.field, v]));
  const known = new Set(fields.filter((f) => f.kind !== 'display').map((f) => (f as { id: string }).id));
  for (const v of values) if (!known.has(v.field)) return 'That answers a field this form does not have';
  for (const f of fields) {
    if (f.kind === 'display') continue;
    const v = by.get(f.id);
    const name = f.label ?? 'A field';
    switch (f.kind) {
      case 'text': {
        const t = v?.value ?? '';
        if (typeof t !== 'string') return `${name}: not text`;
        if (f.required && !t.trim()) return `${name} is required`;
        if (t && f.minLength !== undefined && [...t].length < f.minLength) return `${name} needs at least ${f.minLength} characters`;
        const max = Math.min(f.maxLength ?? MODAL_TEXT_MAX, MODAL_TEXT_MAX);
        if ([...t].length > max) return `${name} takes at most ${max} characters`;
        break;
      }
      case 'select':
      case 'checkboxes': {
        const list = v?.values ?? [];
        if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) return `${name}: not a list`;
        if (f.required && !list.length) return `${name} is required`;
        if (list.length && f.min !== undefined && list.length < f.min) return `${name}: pick at least ${f.min}`;
        if (f.max !== undefined && list.length > f.max) return `${name}: pick at most ${f.max}`;
        if (f.options && (f.kind === 'checkboxes' || f.select === 'string')) {
          const ok = new Set(f.options.map((o) => o.value));
          if (list.some((x) => !ok.has(x))) return `${name}: that is not one of its options`;
        }
        break;
      }
      case 'radio':
        if (f.required && !v?.value) return `${name} is required`;
        if (v?.value && !f.options.some((o) => o.value === v.value)) return `${name}: that is not one of its options`;
        break;
      case 'checkbox':
        if (v?.checked !== undefined && typeof v.checked !== 'boolean') return `${name}: not a yes or no`;
        break;
      case 'file':
        if (f.required) return `${name} wants a file: answer this form on the network`;
        break;
    }
  }
  return null;
}

/** Whether a command's option values are fit to send, in words: null when they are. */
export function commandProblem(cmd: AppCommandFact, given: { name: string; value: unknown }[]): string | null {
  const by = new Map(given.map((g) => [g.name, g.value]));
  for (const g of given) if (!cmd.options.some((o) => o.name === g.name)) return `/${cmd.name} has no option ${g.name}`;
  for (const o of cmd.options) {
    const v = by.get(o.name);
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (o.required) return `${o.name} is required`;
      continue;
    }
    if (o.type === 'attachment') return `${o.name} wants a file: run this command on the network`;
    if (o.type === 'boolean' && typeof v !== 'boolean') return `${o.name} is a yes or no`;
    if ((o.type === 'integer' || o.type === 'number') && (typeof v !== 'number' || !Number.isFinite(v) || (o.type === 'integer' && !Number.isInteger(v)))) return `${o.name} is a ${o.type === 'integer' ? 'whole number' : 'number'}`;
    if (typeof v === 'number') {
      if (o.min !== undefined && v < o.min) return `${o.name} is at least ${o.min}`;
      if (o.max !== undefined && v > o.max) return `${o.name} is at most ${o.max}`;
    }
    if (o.type === 'string') {
      if (typeof v !== 'string') return `${o.name} is text`;
      if (o.minLength !== undefined && [...v].length < o.minLength) return `${o.name} needs at least ${o.minLength} characters`;
      if (o.maxLength !== undefined && [...v].length > o.maxLength) return `${o.name} takes at most ${o.maxLength} characters`;
      if ([...v].length > 6000) return `${o.name} is too long`;
    }
    if (o.choices?.length && !o.choices.some((c) => c.value === v)) return `${o.name}: that is not one of its choices`;
    if ((o.type === 'user' || o.type === 'channel' || o.type === 'role' || o.type === 'mentionable') && typeof v !== 'string') return `${o.name}: name one`;
  }
  return null;
}
