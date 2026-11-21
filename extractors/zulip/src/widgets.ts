/**
 * Zulip's message widgets: `/poll` and `/todo`. A widget message's first submessage (its author's, msg_type
 * `widget`) says what it is; every later one is a change by whoever made it, all as JSON in `content`:
 *
 *   poll   {widget_type: 'poll', extra_data: {question, options: [..]}}
 *          {type: 'vote', key: 'canned,0' | '<user id>,<n>', vote: 1 | -1}   toggles one person's vote for one option
 *          {type: 'new_option', idx, option}                               key '<sender id>,<idx>'
 *          {type: 'question', question}                                    only the author
 *   todo   {widget_type: 'todo', extra_data: {task_list_title, tasks: [{task, desc}]}}
 *          {type: 'new_task', key, task, desc, completed}                  key '<key>,<sender id>'
 *          {type: 'strike', key}                                           toggles a task done
 *          {type: 'new_task_list_title', title}
 *
 * The state is folded from all of them in order, as the web client does (web/src/poll_widget.ts, todo_widget.ts), so
 * a poll's every voter is known: Zulip shows who voted for what to everyone in the conversation.
 */
import type * as P from '@dither-chat/protocol';

export interface Submessage {
  id?: number;
  message_id?: number;
  sender_id: number;
  msg_type: string;
  content: string;
}

export interface PollState {
  kind: 'poll';
  author: number;
  question: string;
  /** In the order they were made: key → text. */
  options: Map<string, string>;
  /** key → voters. */
  votes: Map<string, Set<number>>;
}

export interface TodoState {
  kind: 'todo';
  author: number;
  title: string;
  /** key → task. */
  tasks: Map<string, { task: string; desc: string; done: boolean }>;
}

export type WidgetState = PollState | TodoState;

function parse(s: Submessage): any {
  try {
    return JSON.parse(s.content);
  } catch {
    return null;
  }
}

/** Folds a widget message's submessages into its state; null for a message that is not a widget. */
export function fold(subs: Submessage[]): WidgetState | null {
  const sorted = [...subs].filter((s) => s.msg_type === 'widget').sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const first = sorted[0] ? parse(sorted[0]) : null;
  if (!first) return null;
  let st: WidgetState;
  if (first.widget_type === 'poll') {
    const options = new Map<string, string>();
    (Array.isArray(first.extra_data?.options) ? first.extra_data.options : []).forEach((o: unknown, i: number) => options.set(`canned,${i}`, String(o)));
    st = { kind: 'poll', author: sorted[0].sender_id, question: String(first.extra_data?.question ?? ''), options, votes: new Map() };
  } else if (first.widget_type === 'todo') {
    const tasks = new Map<string, { task: string; desc: string; done: boolean }>();
    (Array.isArray(first.extra_data?.tasks) ? first.extra_data.tasks : []).forEach((t: any, i: number) => tasks.set(`${i},canned`, { task: String(t?.task ?? ''), desc: String(t?.desc ?? ''), done: false }));
    st = { kind: 'todo', author: sorted[0].sender_id, title: String(first.extra_data?.task_list_title ?? ''), tasks };
  } else return null;
  for (const s of sorted.slice(1)) apply(st, s);
  return st;
}

/** One change, as it comes in a `submessage` event. */
export function apply(st: WidgetState, s: Submessage): boolean {
  const d = parse(s);
  if (!d || typeof d !== 'object') return false;
  if (st.kind === 'poll') {
    if (d.type === 'vote' && typeof d.key === 'string' && st.options.has(d.key)) {
      const set = st.votes.get(d.key) ?? new Set<number>();
      if (d.vote === -1) set.delete(s.sender_id);
      else set.add(s.sender_id);
      st.votes.set(d.key, set);
      return true;
    }
    if (d.type === 'new_option' && typeof d.option === 'string') {
      const key = `${s.sender_id},${d.idx}`;
      if (st.options.has(key)) return false;
      st.options.set(key, d.option);
      return true;
    }
    if (d.type === 'question' && typeof d.question === 'string' && s.sender_id === st.author) {
      st.question = d.question;
      return true;
    }
    return false;
  }
  if (d.type === 'new_task' && typeof d.task === 'string') {
    const key = `${d.key},${s.sender_id}`;
    if (st.tasks.has(key)) return false;
    st.tasks.set(key, { task: d.task, desc: String(d.desc ?? ''), done: !!d.completed });
    return true;
  }
  if (d.type === 'strike' && typeof d.key === 'string') {
    const t = st.tasks.get(d.key);
    if (!t) return false;
    t.done = !t.done;
    return true;
  }
  if (d.type === 'new_task_list_title' && typeof d.title === 'string' && s.sender_id === st.author) {
    st.title = d.title;
    return true;
  }
  return false;
}

/** The hub's poll: every option, counts, and this account's own vote. */
export function pollFact(st: PollState, self: number): P.PollFact {
  const counts: Record<string, number> = {};
  const mine: string[] = [];
  const voters = new Set<number>();
  for (const key of st.options.keys()) {
    const v = st.votes.get(key) ?? new Set();
    counts[key] = v.size;
    if (v.has(self)) mine.push(key);
    for (const u of v) voters.add(u);
  }
  return {
    question: st.question,
    options: [...st.options].map(([id, text]) => ({ id, text })),
    multi: true,
    counts,
    voters: voters.size,
    mine,
  };
}

/** The votes to send so this account holds exactly `want`: one toggle for each option that differs. */
export function voteChanges(st: PollState, self: number, want: string[]): { key: string; vote: 1 | -1 }[] {
  const out: { key: string; vote: 1 | -1 }[] = [];
  for (const key of st.options.keys()) {
    const has = st.votes.get(key)?.has(self) ?? false;
    const wants = want.includes(key);
    if (has !== wants) out.push({ key, vote: wants ? 1 : -1 });
  }
  return out;
}

/** A to-do list as words, for the message body: Zulip's list has no other place in the hub. */
export function todoBody(st: TodoState): string {
  const lines = [`**${st.title || 'Task list'}**`];
  for (const t of st.tasks.values()) lines.push(`${t.done ? '☑' : '☐'} ${t.done ? `~~${t.task}~~` : t.task}${t.desc ? `: ${t.desc}` : ''}`);
  return lines.join('\n');
}

/** A poll's message as Zulip's compose box writes it: `/poll question` and one option per line. */
export function pollCommand(d: P.PollDraft): string {
  return [`/poll ${d.question.trim()}`, ...d.options.map((o) => o.trim()).filter(Boolean)].join('\n');
}
