/**
 * T3 Code's threads as chat facts (docs/t3.md): a project is a space, a thread a channel in it named by its title with
 * its state as the topic, the owner's prompts are the owner's messages and the agent's replies its own. Pure functions
 * over the shapes T3 sends (the shell stream's thread summaries, the MCP list's items, `t3_thread_read`'s timeline).
 */
import type { ConversationFact, IdentityFact, MessageFact, SpaceFact } from '@dither-chat/protocol';

/** The account's own identity: whoever sends from here is the owner. */
export const ME = 'me';
/** Prompts that another agent wrote (a parent thread, a script through T3's MCP), and T3's own. */
export const OTHER_AGENT = 'agent:other';
export const T3_SYSTEM = 't3';

/** A whole message is kept up to this many characters; past it, the rest is clipped with a note. */
export const MAX_TEXT = 200_000;

export interface Project {
  id: string;
  title: string;
  workspaceRoot: string;
}

/** What the extractor keeps of a thread, from the shell stream or (without it) the MCP list. */
export interface Summary {
  id: string;
  projectId: string;
  title: string;
  /** idle, or the latest run's: preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled, rolled_back */
  status: string;
  providerInstanceId: string;
  model: string;
  itemCount: number;
  /** ms epoch */
  updatedAt: number;
  archived: boolean;
  /** A subagent spawned inside another thread: not a chat of its own. */
  subagent: boolean;
  latestRunId: string | null;
  /** A question or approval the run waits on: the shell's pendingRuntimeRequest, else a read's pendingRequestCount. */
  pending: { id: string; kind: string } | null;
  lastError: string | null;
  /** ms epoch: when the owner last opened it in T3 Code, when the shell says. */
  lastVisitedAt: number | null;
}

const ms = (v: unknown): number | null => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  // DateTimeUtc may come encoded as { epochMillis } on some wires.
  if (v && typeof v === 'object' && typeof (v as { epochMillis?: unknown }).epochMillis === 'number') return (v as { epochMillis: number }).epochMillis;
  return null;
};

/** A thread summary from the shell stream (OrchestrationV2ThreadShell); null for one deleted. */
export function fromShell(t: any): Summary | null {
  if (!t?.id || t.deletedAt) return null;
  return {
    id: String(t.id),
    projectId: String(t.projectId),
    title: String(t.title ?? ''),
    status: String(t.status ?? 'idle'),
    providerInstanceId: String(t.providerInstanceId ?? ''),
    model: String(t.modelSelection?.model ?? t.model ?? ''),
    itemCount: Number(t.visibleItemCount ?? t.itemCount ?? 0),
    updatedAt: ms(t.updatedAt) ?? 0,
    archived: t.archivedAt != null,
    subagent: t.lineage?.relationshipToParent === 'subagent',
    latestRunId: t.latestRunId ?? null,
    pending: t.pendingRuntimeRequest ? { id: String(t.pendingRuntimeRequest.id), kind: String(t.pendingRuntimeRequest.kind ?? '') } : null,
    lastError: typeof t.lastError === 'string' ? t.lastError : null,
    lastVisitedAt: ms(t.lastVisitedAt),
  };
}

/** A thread from `t3_thread_list` (OrchestratorMcpThreadListItem), when there is no shell stream. */
export function fromListItem(t: any): Summary {
  return {
    id: String(t.threadId),
    projectId: String(t.projectId),
    title: String(t.title ?? ''),
    status: String(t.status ?? 'idle'),
    providerInstanceId: String(t.providerInstanceId ?? ''),
    model: String(t.model ?? ''),
    itemCount: Number(t.itemCount ?? 0),
    updatedAt: ms(t.updatedAt) ?? 0,
    archived: false,
    subagent: t.relationshipToParent === 'subagent',
    latestRunId: t.latestRunId ?? null,
    pending: null,
    lastError: null,
    lastVisitedAt: null,
  };
}

/** What changed between two summaries that calls for reading the thread's new turns. */
export const needsRead = (a: Summary | undefined, b: Summary) => !a || a.itemCount !== b.itemCount || a.status !== b.status || a.updatedAt !== b.updatedAt;

/** What changed that the conversation fact shows (its name, topic, space, last activity). */
export const factChanged = (a: Summary | undefined, b: Summary) =>
  !a || a.title !== b.title || a.projectId !== b.projectId || a.archived !== b.archived || stateLine(a) !== stateLine(b) || a.updatedAt !== b.updatedAt;

// ---------------------------------------------------------------- the conversation

// 'waiting' is a run still alive (T3 counts it active) that waits on something: delegated work, a queue. Only a
// pending request means it waits on you.
const LIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);

/** The thread's state in a few words: what the topic says. */
export function stateWord(s: Pick<Summary, 'status' | 'pending'>): string {
  if (s.pending) return 'Waiting for your answer';
  if (LIVE.has(s.status)) return 'Working';
  switch (s.status) {
    case 'completed':
      return 'Finished';
    case 'failed':
      return 'Failed';
    case 'interrupted':
    case 'cancelled':
      return 'Stopped';
    case 'rolled_back':
      return 'Rolled back';
    default:
      return 'Idle';
  }
}

/** The agent's name for a provider instance: Claude, Codex, or the instance id as T3 names it. */
export function agentName(providerInstanceId: string): string {
  const id = providerInstanceId.toLowerCase();
  if (id.startsWith('claude')) return 'Claude';
  if (id.startsWith('codex')) return 'Codex';
  if (id.startsWith('cursor')) return 'Cursor';
  if (id.startsWith('gemini')) return 'Gemini';
  if (id.startsWith('opencode')) return 'OpenCode';
  return providerInstanceId || 'Agent';
}
export const agentId = (providerInstanceId: string) => `agent:${providerInstanceId || 'unknown'}`;

export function agentIdentity(providerInstanceId: string): IdentityFact {
  return { nativeId: agentId(providerInstanceId), displayName: agentName(providerInstanceId), isBot: true };
}

export const stateLine = (s: Summary) => [stateWord(s), s.model].filter(Boolean).join(' · ');

export const spaceId = (projectId: string) => `project:${projectId}`;

export function projectSpace(p: Project): SpaceFact {
  return { nativeId: spaceId(p.id), kind: 'community', name: p.title };
}

export function conversationOf(s: Summary): ConversationFact {
  return {
    nativeId: s.id,
    shape: 'channel',
    name: s.title || 'Untitled thread',
    topic: stateLine(s),
    spaces: [{ nativeId: spaceId(s.projectId) }],
    lastMessageAt: s.updatedAt,
    ...(s.archived ? { archived: true } : {}),
  };
}

// ---------------------------------------------------------------- turns

/** One user or assistant message of a thread's timeline (OrchestratorMcpThreadTimelineItem), its text whole. */
export interface Turn {
  position: number;
  itemId: string;
  messageId: string | null;
  type: 'user_message' | 'assistant_message';
  status: string;
  createdBy: string | null;
  text: string;
  /** ms epoch */
  ts: number;
}

export const isTurnType = (t: unknown): t is Turn['type'] => t === 'user_message' || t === 'assistant_message';

/** A turn's settled: its text will not change. Running and pending ones are read again later. */
export const settled = (t: Pick<Turn, 'status'>) => !['idle', 'pending', 'running', 'waiting'].includes(t.status);

export const turnId = (t: Pick<Turn, 'messageId' | 'itemId'>) => t.messageId ?? t.itemId;

export function clipText(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n\n*(clipped here: ${(text.length - MAX_TEXT).toLocaleString('en-US')} more characters in T3 Code)*`;
}

/**
 * A turn as a message. The owner's prompts are theirs (`createdBy` user, or a turn this account sent); another
 * agent's prompt (a parent thread's, a script's through T3's MCP) is OTHER_AGENT's; replies are the thread's agent's.
 */
export function messageOf(thread: Pick<Summary, 'id' | 'providerInstanceId'>, t: Turn, sentHere: (id: string) => boolean): MessageFact {
  const id = turnId(t);
  const author =
    t.type === 'assistant_message' ? agentId(thread.providerInstanceId) : t.createdBy === 'user' || sentHere(id) ? ME : t.createdBy === 'system' ? T3_SYSTEM : OTHER_AGENT;
  return { nativeId: id, conversation: thread.id, author, ts: t.ts, body: clipText(t.text) };
}

const REQUEST_WORDS: Record<string, string> = {
  user_input: 'your answer to its question',
  dynamic_tool_call: 'your approval of a tool call',
  auth_refresh: 'a sign-in',
};

/** A question or approval the run waits on, said in the thread as the agent: what makes the chat unread. */
export function requestMessage(s: Summary, link: string | null, ts: number): MessageFact {
  const kind = s.pending?.kind ?? '';
  const what = REQUEST_WORDS[kind] ?? (kind ? `your approval (${kind.replace(/_/g, ' ')})` : 'your answer');
  return {
    nativeId: `request:${s.pending?.id ?? s.latestRunId ?? 'unknown'}`,
    conversation: s.id,
    author: agentId(s.providerInstanceId),
    ts,
    body: `Waiting for ${what}. Answer it in T3 Code${link ? `: ${link}` : '.'}`,
  };
}

/** A run that failed, said in the thread as the agent. */
export function failedMessage(s: Summary, ts: number): MessageFact {
  return {
    nativeId: `failed:${s.latestRunId ?? 'unknown'}`,
    conversation: s.id,
    author: agentId(s.providerInstanceId),
    ts,
    body: `The run failed${s.lastError ? `: ${s.lastError.slice(0, 500)}` : '.'}`,
  };
}

// ---------------------------------------------------------------- which projects

/**
 * The config's `projects`: ids, titles (any case) or folders (a project whose folder is or is under one), separated
 * by commas or new lines. Empty: every project.
 */
export function projectFilter(spec: unknown): (p: Project) => boolean {
  const parts = (typeof spec === 'string' ? spec.split(/[,\n]/) : Array.isArray(spec) ? spec.map(String) : []).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return () => true;
  return (p) =>
    parts.some((x) => {
      if (x === p.id || x.toLowerCase() === p.title.toLowerCase()) return true;
      if (!x.startsWith('/')) return false;
      const root = x.replace(/\/+$/, '');
      return p.workspaceRoot === root || p.workspaceRoot.startsWith(`${root}/`);
    });
}
