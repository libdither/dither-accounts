/**
 * The t3 account's state and what it emits (docs/t3.md). It hears thread summaries (from the shell stream, or from
 * the MCP list when there is no stream), reads a thread's turns only when its summary changed, at most once per
 * `readGapMs` per thread, and emits the chat facts. Everything T3-specific it reaches through `read` (an MCP tool
 * call) and `send` (the CLI), so tests drive it with a fake server.
 */
import type { AdapterEvent, HistoryResult, IdentityFact } from '@dither-chat/protocol';
import {
  agentIdentity,
  clipText,
  conversationOf,
  factChanged,
  failedMessage,
  fromShell,
  isTurnType,
  MAX_TEXT,
  ME,
  messageOf,
  needsRead,
  OTHER_AGENT,
  type Project,
  projectSpace,
  requestMessage,
  settled,
  spaceId,
  type Summary,
  T3_SYSTEM,
  type Turn,
  turnId,
} from './map.ts';

export interface ChatOpts {
  emit(ev: AdapterEvent): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void;
  /** An MCP tool call on T3 (read-only tools only). */
  read<T = any>(tool: string, args: Record<string, unknown>): Promise<T>;
  /** A turn to a thread (the CLI's `thread send`). */
  send(threadId: string, body: string): Promise<{ messageId: string }>;
  include(p: Project): boolean;
  /** Ids of messages sent from here, kept across restarts: T3 marks them as a client's, not the owner's. */
  sent: { has(id: string): boolean; add(id: string): void };
  /** How many of a thread's latest turns are emitted when it is first seen; older ones come with `history`. */
  initial?: number;
  /** The least time between two reads of one thread. */
  readGapMs?: number;
  /** Threads read at once while loading. */
  concurrency?: number;
}

interface ThreadState {
  s: Summary;
  /** Settled turns read so far, by position. */
  turns: Turn[];
  /** The afterPosition of the next read: the last settled turn's position (undefined: from the start). */
  cursor: number | undefined;
  loaded: boolean;
  emitted: Set<string>;
  link: string | null;
  reading: Promise<void> | null;
  again: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastReadAt: number;
  /** The request and failed run already said in the thread. */
  requestSaid: string | null;
  failedSaid: string | null;
  visited: number;
}

const PAGE = 100;
const CHARS_PER_ITEM = 50_000;

export class T3Chat {
  readonly projects = new Map<string, Project>();
  readonly threads = new Map<string, ThreadState>();
  private readonly agents = new Map<string, IdentityFact>();
  /** Summaries of threads whose project has not been heard of yet (a project made since the snapshot). */
  private readonly orphans = new Map<string, { s: Summary; live: boolean }>();
  private queue: (() => Promise<void>)[] = [];
  private running = 0;
  private stopped = false;
  private readonly initial: number;
  private readonly readGapMs: number;
  private readonly concurrency: number;

  constructor(private readonly o: ChatOpts) {
    this.initial = o.initial ?? 20;
    this.readGapMs = o.readGapMs ?? 2000;
    this.concurrency = o.concurrency ?? 3;
  }

  /** Identities that are not people: whoever sends from here, other agents, T3 itself. */
  static fixedIdentities(): IdentityFact[] {
    return [
      { nativeId: ME, displayName: 'You', isSelf: true },
      { nativeId: OTHER_AGENT, displayName: 'Another agent', isBot: true },
      { nativeId: T3_SYSTEM, displayName: 'T3 Code', isBot: true },
    ];
  }

  /** Everything the hub should know again after it reconnects, but the messages (it keeps those). */
  facts(): AdapterEvent[] {
    const out: AdapterEvent[] = T3Chat.fixedIdentities().map((identity) => ({ t: 'identity', identity }));
    for (const a of this.agents.values()) out.push({ t: 'identity', identity: a });
    for (const p of this.projects.values()) if (this.o.include(p)) out.push({ t: 'space', space: projectSpace(p) });
    for (const st of this.threads.values()) out.push({ t: 'conversation', conversation: conversationOf(st.s) });
    return out;
  }

  get counts() {
    const shown = [...this.projects.values()].filter((p) => this.o.include(p)).length;
    return { threads: this.threads.size, projects: shown };
  }

  // ---------------------------------------------------------------- summaries in

  /** One item of the shell stream (OrchestrationV2ShellStreamItem). `live`: after the first snapshot. */
  onShell(item: any, live: boolean) {
    switch (item?.kind) {
      case 'snapshot': {
        // With resolvedRepositoryIdentityRoots it only refreshes some projects' repository identities.
        for (const p of item.snapshot?.projects ?? []) this.project(p);
        if (item.resolvedRepositoryIdentityRoots) return;
        for (const t of item.snapshot?.threads ?? []) {
          const s = fromShell(t);
          if (s) this.summary(s, live);
        }
        return;
      }
      case 'project.updated':
        return this.project(item.project);
      case 'project.removed': {
        const p = this.projects.get(String(item.projectId));
        this.projects.delete(String(item.projectId));
        if (p && this.o.include(p)) this.o.emit({ t: 'leave', kind: 'space', nativeId: spaceId(p.id) });
        return;
      }
      case 'thread.updated': {
        const s = fromShell(item.thread);
        if (!s) return this.gone(String(item.thread?.id));
        if (item.location === 'archive') s.archived = true;
        return this.summary(s, true);
      }
      case 'thread.removed':
        return this.gone(String(item.threadId));
    }
  }

  project(p: any) {
    if (!p?.id) return;
    const next: Project = { id: String(p.id), title: String(p.title ?? p.id), workspaceRoot: String(p.workspaceRoot ?? '') };
    const prev = this.projects.get(next.id);
    this.projects.set(next.id, next);
    if (this.o.include(next) && (!prev || prev.title !== next.title)) this.o.emit({ t: 'space', space: projectSpace(next) });
    for (const [id, o] of this.orphans) {
      if (o.s.projectId !== next.id) continue;
      this.orphans.delete(id);
      this.summary(o.s, o.live);
    }
  }

  private gone(id: string) {
    const st = this.threads.get(id);
    this.orphans.delete(id);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    this.threads.delete(id);
    this.o.emit({ t: 'leave', kind: 'conversation', nativeId: id });
  }

  /** A thread's summary, new or changed. */
  summary(s: Summary, live: boolean) {
    if (this.stopped || s.subagent) return;
    const p = this.projects.get(s.projectId);
    if (!p) return void this.orphans.set(s.id, { s, live });
    if (!this.o.include(p)) return;
    let st = this.threads.get(s.id);
    const prev = st?.s;
    // A request known only from a read (the list has none) stands until a read of the same run says it is gone.
    if (!s.pending && prev?.pending?.id.startsWith('run:') && prev.latestRunId === s.latestRunId) s = { ...s, pending: prev.pending };
    if (!st) {
      st = { s, turns: [], cursor: undefined, loaded: false, emitted: new Set(), link: null, reading: null, again: false, timer: null, lastReadAt: 0, requestSaid: null, failedSaid: null, visited: 0 };
      this.threads.set(s.id, st);
    }
    st.s = s;
    this.agent(s.providerInstanceId);
    if (factChanged(prev, s)) this.o.emit({ t: 'conversation', conversation: conversationOf(s) });
    if (!prev) this.enqueue(() => this.load(st!, live));
    else if (needsRead(prev, s)) this.schedule(st);
    this.state(st, prev, live);
  }

  private agent(providerInstanceId: string) {
    if (this.agents.has(providerInstanceId)) return;
    const a = agentIdentity(providerInstanceId);
    this.agents.set(providerInstanceId, a);
    this.o.emit({ t: 'identity', identity: a });
  }

  /** What the summary itself says in the thread: a request waiting, a run that failed, the owner having read it in T3. */
  private state(st: ThreadState, prev: Summary | undefined, live: boolean) {
    const s = st.s;
    const waiting = s.pending?.id ?? null;
    if (waiting && waiting !== st.requestSaid) {
      st.requestSaid = waiting;
      // Said once the turns before it are out, so it comes after them.
      const say = () => this.o.emit({ t: 'message', message: requestMessage(s, st.link, Math.max(s.updatedAt, lastTs(st) + 1)), live: live && !!prev });
      st.loaded && !st.reading ? say() : void (st.reading ?? this.whenLoaded(st)).then(say);
    }
    if (s.status === 'failed' && prev && prev.status !== 'failed' && s.latestRunId !== st.failedSaid) {
      st.failedSaid = s.latestRunId;
      this.o.emit({ t: 'message', message: failedMessage(s, Math.max(s.updatedAt, lastTs(st) + 1)), live: true });
    }
    if (s.lastVisitedAt && s.lastVisitedAt > st.visited) {
      st.visited = s.lastVisitedAt;
      // Read in T3 Code after its latest turn: read here too.
      if (s.lastVisitedAt >= s.updatedAt - 1000) this.o.emit({ t: 'read', conversation: s.id, upToTs: s.lastVisitedAt });
    }
  }

  /**
   * The list (no shell stream) says nothing of requests; a read's pendingRequestCount does. It stands for one while
   * the summary has none, keyed by the run so it is said once.
   */
  private pendingFromRead(st: ThreadState, count: number) {
    const s = st.s;
    if (s.pending && !s.pending.id.startsWith('run:')) return;
    const next = count > 0 ? { id: `run:${s.latestRunId}`, kind: '' } : null;
    if ((next?.id ?? null) === (s.pending?.id ?? null)) return;
    const prev = s;
    st.s = { ...s, pending: next };
    this.o.emit({ t: 'conversation', conversation: conversationOf(st.s) });
    this.state(st, prev, true);
  }

  private whenLoaded(st: ThreadState): Promise<void> {
    return new Promise((resolve) => {
      const tick = () => (st.loaded && !st.reading) || this.stopped ? resolve() : setTimeout(tick, 100);
      tick();
    });
  }

  // ---------------------------------------------------------------- reading turns

  private enqueue(job: () => Promise<void>) {
    this.queue.push(job);
    this.pump();
  }

  private pump() {
    while (this.running < this.concurrency && this.queue.length && !this.stopped) {
      const job = this.queue.shift()!;
      this.running++;
      job()
        .catch((e) => this.o.log('warn', `t3: ${(e as Error).message}`))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  /** Loading done: every thread seen so far has been read once. */
  async idle(): Promise<void> {
    while ((this.running || this.queue.length) && !this.stopped) await Bun.sleep(50);
  }

  /** First sight of a thread: read its timeline, emit its latest turns (new ones live after the first snapshot). */
  private async load(st: ThreadState, live: boolean) {
    await this.readMore(st, (fresh) => {
      const out = (live ? fresh : st.turns).slice(-this.initial);
      for (const t of out) this.emitTurn(st, t, live);
    });
    st.loaded = true;
  }

  private schedule(st: ThreadState) {
    if (st.timer) return;
    if (st.reading || !st.loaded) {
      st.again = true;
      return;
    }
    const wait = Math.max(250, st.lastReadAt + this.readGapMs - Date.now());
    st.timer = setTimeout(() => {
      st.timer = null;
      if (this.stopped || !this.threads.has(st.s.id)) return;
      this.readMore(st, (fresh) => fresh.forEach((t) => this.emitTurn(st, t, true))).catch((e) => this.o.log('warn', `t3: reading a thread: ${(e as Error).message}`));
    }, wait);
  }

  /** Reads the thread's turns after the cursor; `then` gets the settled ones new to it. One read at a time per thread. */
  private async readMore(st: ThreadState, then: (fresh: Turn[]) => void) {
    if (st.reading) {
      st.again = true;
      return st.reading;
    }
    st.again = false;
    st.reading = (async () => {
      st.lastReadAt = Date.now();
      const fresh: Turn[] = [];
      let after = st.cursor;
      let blocked = false;
      // A turn still being written holds back the ones after it while a run goes on; once the thread stopped, what is
      // there is all there will be (a turn left 'running' by a run that died must not hold the thread back forever).
      const going = !['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back', 'idle'].includes(st.s.status);
      for (let page = 0; page < 1000; page++) {
        const r = await this.o.read<any>('t3_thread_read', {
          threadId: st.s.id,
          view: 'messages',
          limit: PAGE,
          runLimit: 1,
          maxCharsPerItem: CHARS_PER_ITEM,
          ...(after === undefined ? {} : { afterPosition: after }),
        });
        if (typeof r?.thread?.link === 'string') st.link = r.thread.link;
        if (page === 0) this.pendingFromRead(st, Number(r?.thread?.pendingRequestCount ?? 0));
        for (const it of r?.items ?? []) {
          if (!isTurnType(it.type)) continue;
          // Everything from the first turn still being written is read again next time.
          if (blocked || (going && !settled(it))) {
            blocked = true;
            continue;
          }
          const t: Turn = { position: it.position, itemId: String(it.itemId), messageId: it.messageId ?? null, type: it.type, status: String(it.status), createdBy: it.createdBy ?? null, text: await this.fullText(st.s.id, it), ts: Date.parse(it.updatedAt) || Date.now() };
          st.cursor = t.position;
          if (!t.text.trim()) continue;
          fresh.push(t);
          st.turns.push(t);
        }
        if (!r?.hasMore || r.nextPosition == null) break;
        after = r.nextPosition;
      }
      then(fresh);
    })();
    try {
      await st.reading;
    } finally {
      st.reading = null;
      if (st.again && !this.stopped) {
        st.again = false;
        this.schedule(st);
      }
    }
  }

  /** An item's text past the read's cap, a page at a time, up to MAX_TEXT and a bit (clipText says the rest). */
  private async fullText(threadId: string, it: any): Promise<string> {
    let text = String(it.text ?? '');
    let offset: number | null = it.textTruncated ? (it.nextTextOffset ?? null) : null;
    while (offset !== null && text.length <= MAX_TEXT) {
      const r = await this.o.read<any>('t3_thread_read', { threadId, itemId: it.itemId, textOffset: offset, maxCharsPerItem: CHARS_PER_ITEM, runLimit: 1 });
      const chunk = (r?.items ?? []).find((c: any) => c.itemId === it.itemId);
      if (!chunk) break;
      text += String(chunk.text ?? '');
      offset = chunk.textTruncated ? (chunk.nextTextOffset ?? null) : null;
    }
    return text.length > MAX_TEXT ? clipText(text) : text;
  }

  private emitTurn(st: ThreadState, t: Turn, live: boolean) {
    const id = turnId(t);
    if (st.emitted.has(id)) return;
    st.emitted.add(id);
    this.o.emit({ t: 'message', message: messageOf(st.s, t, (x) => this.o.sent.has(x)), live });
  }

  // ---------------------------------------------------------------- commands

  /** Older turns, as the hub pages back: the ones before `beforeTs`, newest first, `limit` of them. */
  async history(conversation: string, beforeTs: number | undefined, limit: number): Promise<HistoryResult> {
    const st = this.threads.get(conversation);
    if (!st) throw new Error('not a thread this account shows');
    if (!st.loaded) await this.whenLoaded(st);
    const older = st.turns.filter((t) => beforeTs === undefined || t.ts < beforeTs);
    const page = older.slice(-Math.max(1, limit));
    for (const t of page) {
      st.emitted.delete(turnId(t));
      this.emitTurn(st, t, false);
    }
    return { count: page.length, done: page.length === older.length, ...(page.length ? { oldest: page[0]!.ts } : {}) };
  }

  /** A message to a thread: its next turn, queued behind a busy run. */
  async send(conversation: string, body: string): Promise<{ nativeId: string }> {
    const st = this.threads.get(conversation);
    if (!st) throw new Error('Not a thread this account shows');
    if (!body.trim()) throw new Error('Write something to send');
    const r = await this.o.send(conversation, body);
    this.o.sent.add(r.messageId);
    // The prompt and the agent's answer come from the thread itself; look soon rather than wait for the stream.
    this.schedule(st);
    return { nativeId: r.messageId };
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    for (const st of this.threads.values()) if (st.timer) clearTimeout(st.timer);
  }
}

const lastTs = (st: ThreadState) => st.turns.at(-1)?.ts ?? 0;
