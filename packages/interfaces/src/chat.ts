/**
 * `chat`: dither-chat's adapter protocol (packages/chat-protocol, `AdapterCommand` and `AdapterEvent`) as an
 * interface. The Discord, Signal, Matrix and WhatsApp extractors speak it unchanged; dither-chat's hub is its consumer.
 * An op's input is its command without `t` and `id`; its output is what the protocol says the reply carries.
 *
 * Runtime checks stay shallow (an object): the extractors are this repo's own code and check their commands
 * themselves, and the types here keep apps honest at build time.
 */
import type { About, AdapterCommand, AdapterEvent, AddMembersResult, AddPreview, AddResult, CreateGroupResult, DirectVoiceSession, HistoryResult, NetworkSearchResult, OpenDirectResult, PersonAbout, ReactionContext, ThreadsResult } from '@dither-chat/protocol';
import { ev, iface, op, type Schema, s } from '@dither-accounts/spec';
import type { Mentionables } from '@dither-chat/protocol';

type Cmd = Exclude<AdapterCommand, { t: 'shutdown' }>;
/** A command's input: the variant(s) with this `t`, without `t` and `id` (distributes over `call`'s variants). */
type InputOf<K extends Cmd['t']> = Extract<Cmd, { t: K }> extends infer C ? (C extends unknown ? Omit<C, 't' | 'id'> : never) : never;
type EventOf<K extends AdapterEvent['t']> = Extract<AdapterEvent, { t: K }>;

const input = <K extends Cmd['t']>(_t: K): Schema<InputOf<K>> => s.typed<InputOf<K>>('a chat command');
const out = <T>(): Schema<T> => s.unknown as Schema<T>;
const fact = <K extends AdapterEvent['t']>(_t: K): Schema<EventOf<K>> => s.typed<EventOf<K>>('a chat fact');

export const chat = iface({
  name: 'chat',
  version: 1,
  describe: 'Messages, people, groups and communities on a chat network.',
  levels: {
    read: 'Read your chats, who is in them, and what arrives',
    write: 'Send, forward, react, edit and delete messages as you, mark them read, and join calls',
    manage: "Change chats' and servers' settings, roles and membership as you, and run account actions (re-login, relink)",
  },
  ops: {
    history: op('read', 'Older messages of a conversation', input('history'), out<HistoryResult>(), 120_000),
    search: op('read', "Search messages on the network's own servers: a server, a DM, or everything at once", input('search'), out<NetworkSearchResult>(), 60_000),
    walkMembers: op('read', "A server's members whose names start with some letters", input('walkMembers'), out<{ count: number; total?: number }>(), 60_000),
    mentionables: op('read', 'Who a conversation can ping, for the @ picker', input('mentionables'), out<Mentionables>(), 15_000),
    threads: op('read', "A page of a channel's threads, active or archived", input('threads'), out<ThreadsResult>(), 60_000),
    reactionContext: op('read', 'Which reactions you may use here', input('reactionContext'), out<ReactionContext>()),
    reactors: op('read', 'Who is behind a reaction count', input('reactors'), out<{ authors: string[] }>()),
    fetchMedia: op('read', 'An attachment or avatar the network serves', input('fetchMedia'), out<{ mime: string; base64: string }>(), 120_000),
    about: op('read', "A conversation's or space's settings and members", input('about'), out<About>(), 60_000),
    profile: op('read', 'What the network says about a person', input('profile'), out<PersonAbout>(), 60_000),
    resolve: op('read', 'What an invite, address, name or handle is, without acting on it', input('resolve'), out<AddPreview>(), 60_000),
    send: op('write', 'Send a message', input('send'), out<{ nativeId?: string } | undefined>(), 120_000),
    forward: op('write', 'Forward a message', input('forward'), out<{ nativeId?: string; fallback?: string }>(), 60_000),
    openDirect: op('write', 'Open or find a direct conversation', input('openDirect'), out<OpenDirectResult>()),
    markRead: op('write', 'Mark a conversation read', input('markRead'), out<unknown>()),
    typing: op('write', 'Say you are typing', input('typing'), out<unknown>()),
    react: op('write', 'Add or remove a reaction', input('react'), out<unknown>()),
    edit: op('write', 'Edit your message', input('edit'), out<unknown>()),
    redact: op('write', 'Delete a message', input('redact'), out<unknown>()),
    call: op('write', 'Join, leave or signal a call', input('call'), out<{ direct?: DirectVoiceSession } | unknown>(), 60_000),
    configure: op('manage', 'Change one setting of a conversation or space', input('configure'), out<About>(), 60_000),
    setProfile: op('manage', 'Change your own profile: your bio or About', input('setProfile'), out<PersonAbout>(), 60_000),
    action: op('manage', 'An account action: relogin, startLink, resync', input('action'), out<unknown>(), 120_000),
    add: op('manage', 'Join or ask to join a server, group or room, or add someone: friend, follow, contact', input('add'), out<AddResult>(), 120_000),
    answer: op('manage', 'Answer a request waiting on you: accept, decline or block', input('answer'), out<AddResult>(), 60_000),
    remove: op('manage', 'End a relationship: unfriend, cancel a request, unblock, remove a contact, unfollow', input('remove'), out<AddResult>(), 60_000),
    addMembers: op('manage', 'Add people to a group you are in', input('addMembers'), out<AddMembersResult>(), 120_000),
    createGroup: op('manage', 'Make a new group with people the account knows', input('createGroup'), out<CreateGroupResult>(), 120_000),
    lab: op('manage', 'Call-lab probe (DITHER_LAB only)', input('lab'), out<unknown>(), 120_000),
  },
  events: {
    hello: ev('The extractor started: network, version, capabilities', fact('hello'), true),
    status: ev("The account's state: connecting, online, needs attention; its own identity", fact('status'), true),
    identity: ev('A person on the network', fact('identity')),
    space: ev('A server, space or community', fact('space')),
    conversation: ev('A DM, group, channel or thread', fact('conversation')),
    leave: ev('You left a space or conversation', fact('leave')),
    message: ev('A message, new or edited', fact('message')),
    delete: ev('A message is gone', fact('delete')),
    reaction: ev('A reaction added or removed', fact('reaction')),
    reactionsCleared: ev('Reactions removed by a moderator', fact('reactionsCleared')),
    read: ev('Read state', fact('read')),
    pin: ev('A message pinned or unpinned', fact('pin')),
    role: ev('A role given or taken', fact('role')),
    customStatus: ev("Someone's custom status", fact('customStatus')),
    presence: ev("Someone's presence: online, idle, do not disturb or offline", fact('presence')),
    members: ev('People seen as members of a server', fact('members')),
    receipt: ev('Someone got or read your messages', fact('receipt')),
    typing: ev('Someone is typing', fact('typing')),
    call: ev('Call signalling and state', fact('call')),
    requests: ev('Every request waiting on you: friend, follow, invite, message, join', fact('requests')),
    request: ev('A request waiting on you, new or changed', fact('request')),
    requestGone: ev('A request answered, withdrawn or expired', fact('requestGone')),
    personAbout: ev("What the network showed about someone unasked: their profile, as in your notifications", fact('personAbout')),
    relationships: ev('Every relationship: friends, requests sent, blocks, contacts, follows', fact('relationships')),
    relationship: ev('A relationship new, changed or gone', fact('relationship')),
  },
});

/** Every event an account's chat extractor sends (replies and logs stay with the manager). */
export type ChatEvent = Exclude<AdapterEvent, { t: 'reply' } | { t: 'log' }>;

// Every command of the protocol is an op here and every fact an event: the manager refuses an op and drops an event it
// doesn't list, so one added to chat-protocol without a line above would never get through. A missing one is a type
// error naming it.
type MissingOps = Exclude<Cmd['t'], keyof typeof chat.ops>;
type MissingEvents = Exclude<ChatEvent['t'], keyof typeof chat.events>;
export const everyCommandIsAnOp: [MissingOps] extends [never] ? true : MissingOps = true;
export const everyFactIsAnEvent: [MissingEvents] extends [never] ? true : MissingEvents = true;
