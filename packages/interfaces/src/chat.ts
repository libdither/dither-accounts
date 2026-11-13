/**
 * `chat`: dither-chat's adapter protocol (packages/chat-protocol, `AdapterCommand` and `AdapterEvent`) as an
 * interface. The Discord, Signal, Matrix and WhatsApp extractors speak it unchanged; dither-chat's hub is its consumer.
 * An op's input is its command without `t` and `id`; its output is what the protocol says the reply carries.
 *
 * Runtime checks stay shallow (an object): the extractors are this repo's own code and check their commands
 * themselves, and the types here keep apps honest at build time.
 */
import type { About, AdapterCommand, AdapterEvent, AddMembersResult, AddPreview, AddResult, AppAutocompleteResult, AppCommandsResult, BansResult, CreateGroupResult, DirectVoiceSession, GateResult, HistoryResult, InteractResult, LeaveResult, NativeMute, NativeScheduledResult, NetworkSearchResult, OpenDirectResult, OwnPresence, PersonAbout, PostFact, PostThread, PostViewer, ReactionContext, ReactorsPage, SavedFact, SavedListResult, ScheduledEventFact, ScheduledEventsResult, SessionsResult, SpaceGate, ThreadsResult } from '@dither-chat/protocol';
import type { StickerPackFact, StickerPage } from '@dither-chat/protocol';
import type { CreateThreadResult, ThreadFact } from '@dither-chat/protocol';
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
    write: 'Send, forward, react, edit and delete messages as you, mark them read, join calls, and post, like and repost',
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
    post: op('read', "A post's thread: what it answers and its replies", input('post'), out<PostThread>(), 120_000),
    postReactors: op('read', 'Who liked or reposted a post', input('postReactors'), out<ReactorsPage>(), 120_000),
    resolve: op('read', 'What an invite, address, name or handle is, without acting on it', input('resolve'), out<AddPreview>(), 60_000),
    scheduledEvents: op('read', "A server's scheduled events as the network has them now, with counts and your answers", input('scheduledEvents'), out<ScheduledEventsResult>(), 60_000),
    gate: op('read', 'What a server asks of you before you are in: its rules, an application, onboarding', input('gate'), out<SpaceGate | null>(), 60_000),
    appCommands: op('read', "The bots' slash commands (or apps' message commands) you may run in a conversation", input('appCommands'), out<AppCommandsResult>(), 60_000),
    appAutocomplete: op('read', "A bot's suggestions for an option of its command as you type it", input('appAutocomplete'), out<AppAutocompleteResult>(), 30_000),
    stickers: op('read', 'A page of the stickers you may send in a conversation', input('stickers'), out<StickerPage>(), 30_000),
    send: op('write', 'Send a message', input('send'), out<{ nativeId?: string } | undefined>(), 120_000),
    forward: op('write', 'Forward a message', input('forward'), out<{ nativeId?: string; fallback?: string }>(), 60_000),
    postAct: op('write', 'Like or repost a post, or take it back', input('postAct'), out<PostViewer>(), 60_000),
    publish: op('write', 'Write a post: a reply, a quote or a new one', input('publish'), out<PostFact>(), 120_000),
    openDirect: op('write', 'Open or find a direct conversation', input('openDirect'), out<OpenDirectResult>()),
    markRead: op('write', 'Mark a conversation read', input('markRead'), out<unknown>()),
    markUnread: op('write', 'Mark a conversation unread from a message on', input('markUnread'), out<unknown>()),
    markReadMany: op('write', 'Mark many conversations read in one request', input('markReadMany'), out<{ marked: number }>(), 60_000),
    typing: op('write', 'Say you are typing', input('typing'), out<unknown>()),
    viewed: op('write', 'Tell the sender you played their voice note or opened their video', input('viewed'), out<{ sent: boolean }>()),
    storyViewed: op('write', 'Tell someone you opened their story, where the network says so', input('storyViewed'), out<{ sent: boolean }>()),
    storyReply: op('write', 'Reply or react to a story', input('storyReply'), out<{ nativeId?: string }>(), 60_000),
    react: op('write', 'Add or remove a reaction', input('react'), out<unknown>()),
    edit: op('write', 'Edit your message', input('edit'), out<unknown>()),
    redact: op('write', 'Delete a message', input('redact'), out<unknown>()),
    call: op('write', 'Join, leave or signal a call', input('call'), out<{ direct?: DirectVoiceSession } | unknown>(), 60_000),
    declineCall: op('write', 'Stop a call ringing for you, the network\'s own way', input('declineCall'), out<unknown>(), 20_000),
    interact: op('write', "Press a bot's button, choose in its select, run its command, or send a form it opened", input('interact'), out<InteractResult>(), 60_000),
    configure: op('manage', 'Change one setting of a conversation or space', input('configure'), out<About>(), 60_000),
    resetSession: op('manage', 'Reset the encrypted session with someone in a direct conversation', input('resetSession'), out<unknown>(), 60_000),
    setProfile: op('manage', 'Change your own profile: your bio or About, name, emoji, picture or username', input('setProfile'), out<PersonAbout>(), 60_000),
    mute: op('manage', 'Mute or unmute a conversation or space on the network itself, with a timer', input('mute'), out<NativeMute>(), 60_000),
    action: op('manage', 'An account action: relogin, startLink, resync', input('action'), out<unknown>(), 120_000),
    add: op('manage', 'Join or ask to join a server, group or room, or add someone: friend, follow, contact', input('add'), out<AddResult>(), 120_000),
    answer: op('manage', 'Answer a request waiting on you: accept, decline or block', input('answer'), out<AddResult>(), 60_000),
    remove: op('manage', 'End a relationship: unfriend, cancel a request, unblock, remove a contact, unfollow', input('remove'), out<AddResult>(), 60_000),
    addMembers: op('manage', 'Add people to a group you are in', input('addMembers'), out<AddMembersResult>(), 120_000),
    createGroup: op('manage', 'Make a new group with people the account knows', input('createGroup'), out<CreateGroupResult>(), 120_000),
    rsvp: op('write', 'Say you are interested in a scheduled event, or take it back', input('rsvp'), out<ScheduledEventFact>(), 60_000),
    leave: op('manage', 'Leave a server, group or conversation', input('leave'), out<LeaveResult>(), 60_000),
    answerGate: op('manage', "Answer what a server asks before you are in: agree to its rules, apply, pick channels", input('answerGate'), out<GateResult>(), 60_000),
    setNick: op('manage', 'Set your own nickname in a server', input('setNick'), out<About>(), 60_000),
    verify: op('manage', 'Mark your safety number with someone verified, or clear the mark', input('verify'), out<PersonAbout>(), 60_000),
    block: op('manage', 'Block or unblock a person or a group', input('block'), out<{ blocked: boolean }>(), 60_000),
    addStickerPack: op('manage', 'Install a sticker pack from its link', input('addStickerPack'), out<{ pack: StickerPackFact }>(), 60_000),
    setContact: op('manage', 'Your private nickname or note for someone, kept on the network too', input('setContact'), out<unknown>(), 60_000),
    pollVote: op('write', 'Vote in a poll, or take your vote back', input('pollVote'), out<unknown>(), 60_000),
    pollCreate: op('write', 'Make a poll', input('pollCreate'), out<{ nativeId?: string }>(), 60_000),
    pollEnd: op('write', 'End a poll you made before its time', input('pollEnd'), out<unknown>(), 60_000),
    moderate: op('manage', "Moderate a group's or server's members: remove, ban, unban, admins, roles, timeouts, end a group", input('moderate'), out<About>(), 60_000),
    bans: op('read', 'Who is banned from a server', input('bans'), out<BansResult>(), 60_000),
    setLabel: op('manage', 'Set your own member label in a group', input('setLabel'), out<About>(), 60_000),
    clearReactions: op('manage', "Remove others' reactions from a message as a moderator", input('clearReactions'), out<unknown>(), 60_000),
    savedList: op('read', 'What you saved on the network, with its reminders, as its own list reads it', input('savedList'), out<SavedListResult>(), 60_000),
    nativeScheduled: op('read', "Messages scheduled with the network's own Send later", input('nativeScheduled'), out<NativeScheduledResult>(), 60_000),
    save: op('write', 'Save a message on the network, with a reminder, or stop keeping it', input('save'), out<SavedFact | Record<string, never>>(), 60_000),
    suppressEmbeds: op('write', 'Take the link previews off your own message', input('suppressEmbeds'), out<unknown>(), 60_000),
    cancelScheduled: op('write', "Cancel a message scheduled with the network's own Send later", input('cancelScheduled'), out<unknown>(), 60_000),
    lab: op('manage', 'Call-lab probe (DITHER_LAB only)', input('lab'), out<unknown>(), 120_000),
    sessions: op('read', 'Where the account is signed in', input('sessions'), out<SessionsResult>(), 60_000),
    ignore: op('manage', 'Ignore someone, or stop', input('ignore'), out<{ ignored: boolean }>(), 60_000),
    setPresence: op('manage', 'Your own presence and status line', input('setPresence'), out<OwnPresence>(), 60_000),
    // Threads, forums and groups (chat-protocol threads.ts).
    followThread: op('write', 'Follow or unfollow a thread', input('followThread'), out<ThreadFact>(), 60_000),
    threadNotify: op('write', 'How a thread notifies you: all messages, mentions or nothing, or muted', input('threadNotify'), out<ThreadFact>(), 60_000),
    createThread: op('write', 'Start a thread from a message or in a channel', input('createThread'), out<CreateThreadResult>(), 120_000),
    createPost: op('write', 'Start a post in a forum, with tags and files', input('createPost'), out<CreateThreadResult>(), 180_000),
    crosspost: op('write', 'Publish your message in an announcement channel to the channels that follow it', input('crosspost'), out<unknown>(), 60_000),
    threadState: op('manage', 'Archive, unarchive, lock or unlock a thread', input('threadState'), out<About>(), 60_000),
    removeMember: op('manage', 'Take someone out of a group you run', input('removeMember'), out<About>(), 60_000),
    setOwner: op('manage', 'Give a group you own to someone in it', input('setOwner'), out<About>(), 60_000),
    setPicture: op('manage', "Change or remove a group's picture", input('setPicture'), out<About>(), 120_000),
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
    pollUpdate: ev('Votes in a poll as they come, or the poll closing', fact('pollUpdate')),
    role: ev('A role given or taken', fact('role')),
    customStatus: ev("Someone's custom status", fact('customStatus')),
    presence: ev("Someone's presence: online, idle, do not disturb or offline", fact('presence')),
    members: ev('People seen as members of a server', fact('members')),
    receipt: ev('Someone got or read your messages', fact('receipt')),
    typing: ev('Someone is typing', fact('typing')),
    call: ev('Call signalling and state', fact('call')),
    callState: ev('A call ringing you, going on, or over', fact('callState')),
    voice: ev('Who is in a voice channel now (adversarial on the hub)', fact('voice')),
    voiceStatus: ev("A voice channel's status line", fact('voiceStatus')),
    requests: ev('Every request waiting on you: friend, follow, invite, message, join', fact('requests')),
    request: ev('A request waiting on you, new or changed', fact('request')),
    requestGone: ev('A request answered, withdrawn or expired', fact('requestGone')),
    personAbout: ev("What the network showed about someone unasked: their profile, as in your notifications", fact('personAbout')),
    relationships: ev('Every relationship: friends, requests sent, blocks, contacts, follows', fact('relationships')),
    relationship: ev('A relationship new, changed or gone', fact('relationship')),
    notices: ev('What the network wants done on the account: verify, agree, standing, age check', fact('notices')),
    selfState: ev("The account's own presence, folders and privacy settings", fact('selfState')),
    ignored: ev('Everyone the account ignores', fact('ignored')),
    scheduledEvents: ev("Every scheduled event of a server", fact('scheduledEvents')),
    scheduledEvent: ev('A scheduled event, new or changed', fact('scheduledEvent')),
    scheduledEventGone: ev('A scheduled event deleted', fact('scheduledEventGone')),
    gate: ev('What a server asks of you now: rules, an application and its outcome, onboarding', fact('gate')),
    interaction: ev('How an interaction with a bot went: sending, answered, failed, timed out, a form', fact('interaction')),
    appModal: ev('A form a bot opened in answer to one of your interactions', fact('appModal')),
    story: ev("Someone's story, kept a day (only with the account's stories setting on)", fact('story')),
    storyGone: ev('A story its author deleted', fact('storyGone')),
    saved: ev('Messages saved on the network, with their reminders', fact('saved')),
    unsaved: ev('A message no longer saved', fact('unsaved')),
    reminderDue: ev('A reminder you set on the network is due', fact('reminderDue')),
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
