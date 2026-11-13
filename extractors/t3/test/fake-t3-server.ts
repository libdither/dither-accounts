/**
 * A stand-in T3 Code server for tests, with invented projects and threads: the parts the t3 extractor uses.
 *
 * - `POST /mcp`: JSON-RPC (initialize, tools/call of t3_project_list, t3_thread_list, t3_thread_read with its paging
 *   and text offsets), only for an `mcp-client` session it issued, answered as JSON or, every other call, as SSE.
 * - `POST /api/auth/websocket-ticket` for a plain session, and `GET /ws?wsTicket&orchestrationProtocol=2`: the shell
 *   stream in Effect RPC frames (Request → Chunk of a snapshot, then thread.updated; it waits for each Ack).
 * - `/_ctl/*` for the fake CLI (fake-t3.ts): issue and revoke sessions, send a turn (the agent answers a moment later).
 *
 * It writes `<baseDir>/userdata/server-runtime.json` as the real one does, so the extractor finds its origin.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';

export interface FakeItem {
  position: number;
  itemId: string;
  messageId: string | null;
  type: string;
  status: string;
  createdBy: 'user' | 'agent' | 'system' | null;
  text: string | null;
  updatedAt: string;
}
export interface FakeThread {
  id: string;
  projectId: string;
  title: string;
  status: string;
  providerInstanceId: string;
  model: string;
  updatedAt: number;
  latestRunId: string | null;
  pending: { id: string; kind: string } | null;
  lastError: string | null;
  lastVisitedAt: number | null;
  subagent: boolean;
  items: FakeItem[];
}
export interface FakeOpts {
  baseDir: string;
  /** The shell stream answers 426 (another orchestration protocol): the extractor falls back to the list. */
  noShell?: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class FakeT3 {
  projects = [
    { id: 'proj-a', title: 'Acme App', workspaceRoot: '/srv/acme-app' },
    { id: 'proj-b', title: 'Side Project', workspaceRoot: '/srv/side' },
  ];
  threads = new Map<string, FakeThread>();
  sessions = new Map<string, { id: string; subject: string; scopes: string[]; revoked: boolean }>();
  tickets = new Set<string>();
  /** Every turn the fake CLI sent: { threadId, message }. */
  sends: { threadId: string; message: string }[] = [];
  /** MCP tool calls, by name. */
  calls = new Map<string, number>();
  server: Server<{ ticket: string }>;
  private sockets = new Set<ServerWebSocket<{ ticket: string }>>();
  private seq = 100;
  private n = 0;
  private clock = Date.parse('2026-01-05T10:00:00Z');

  constructor(readonly opts: FakeOpts) {
    this.seed();
    const self = this;
    this.server = Bun.serve<{ ticket: string }>({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === '/ws') {
          if (url.searchParams.get('orchestrationProtocol') !== '2' || self.opts.noShell) return Response.json({ code: 'orchestration_protocol_incompatible' }, { status: 426 });
          const ticket = url.searchParams.get('wsTicket') ?? '';
          if (!self.tickets.delete(ticket)) return new Response('no', { status: 401 });
          return server.upgrade(req, { data: { ticket } }) ? undefined : new Response('upgrade failed', { status: 400 });
        }
        if (url.pathname === '/api/auth/websocket-ticket' && req.method === 'POST') {
          const s = self.auth(req);
          if (!s || s.subject === 'mcp-client') return new Response('no', { status: 401 });
          const ticket = `ticket-${self.n++}`;
          self.tickets.add(ticket);
          return Response.json({ ticket, expiresAt: iso(Date.now() + 60_000) });
        }
        if (url.pathname === '/mcp') return self.mcp(req);
        if (url.pathname.startsWith('/_ctl/')) return self.ctl(url.pathname.slice(6), await req.json());
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open: (ws) => void self.sockets.add(ws),
        close: (ws) => void self.sockets.delete(ws),
        message(ws, raw) {
          const m = JSON.parse(String(raw));
          if (m._tag === 'Ping') return void ws.send(JSON.stringify({ _tag: 'Pong' }));
          if (m._tag === 'Request' && m.tag === 'orchestration.subscribeShell') {
            ws.send(JSON.stringify({ _tag: 'Chunk', requestId: m.id, values: [{ kind: 'snapshot', snapshot: { schemaVersion: 1, snapshotSequence: self.seq, projects: self.projects, threads: [...self.threads.values()].map((t) => self.shell(t)), archivedThreads: [] } }] }));
          }
        },
      },
    });
    mkdirSync(join(opts.baseDir, 'userdata'), { recursive: true });
    writeFileSync(join(opts.baseDir, 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, pid: 1, port: this.server.port, origin: this.origin }));
  }

  get origin() {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Drops every shell subscriber, as a server restart or a network blip does. */
  dropSockets() {
    for (const ws of this.sockets) ws.close();
  }

  stop() {
    for (const ws of this.sockets) ws.close();
    this.server.stop(true);
  }

  // ---------------------------------------------------------------- data

  private tick() {
    return (this.clock += 1000);
  }

  item(type: string, text: string, createdBy: FakeItem['createdBy'], status = 'completed'): FakeItem {
    const id = this.n++;
    return { position: 0, itemId: `item-${id}`, messageId: type.endsWith('_message') ? `msg-${id}` : null, type, status, createdBy, text, updatedAt: iso(this.tick()) };
  }

  addItem(threadId: string, it: FakeItem) {
    const t = this.threads.get(threadId)!;
    it.position = t.items.length ? t.items.at(-1)!.position + 1 : 0;
    t.items.push(it);
    t.updatedAt = Date.parse(it.updatedAt);
    return it;
  }

  private seed() {
    const mk = (id: string, projectId: string, title: string, extra: Partial<FakeThread> = {}): FakeThread => {
      const t: FakeThread = { id, projectId, title, status: 'completed', providerInstanceId: 'claudeAgent', model: 'model-x', updatedAt: this.clock, latestRunId: `run-${id}`, pending: null, lastError: null, lastVisitedAt: null, subagent: false, items: [], ...extra };
      this.threads.set(id, t);
      return t;
    };
    mk('thread-fix', 'proj-a', 'Fix the login button');
    this.addItem('thread-fix', this.item('user_message', 'The login button does nothing on Safari. Please look.', 'user'));
    this.addItem('thread-fix', this.item('command_execution', 'grep -r login', null));
    this.addItem('thread-fix', this.item('file_change', 'src/login.ts', null));
    this.addItem('thread-fix', this.item('assistant_message', `Found it: the handler was bound twice.\n\n${'A long explanation. '.repeat(4000)}THE END`, 'agent'));

    // Sixty turns, for paging back.
    mk('thread-long', 'proj-a', 'A long conversation');
    for (let i = 0; i < 30; i++) {
      this.addItem('thread-long', this.item('user_message', `question ${i}`, 'user'));
      this.addItem('thread-long', this.item('assistant_message', `answer ${i}`, 'agent'));
    }

    // Started by another agent (a script through T3's MCP), still working.
    mk('thread-bug', 'proj-b', 'Bug: disk full in upkeep', { status: 'running' });
    this.addItem('thread-bug', this.item('user_message', 'A brief from a script.', 'agent'));
    this.addItem('thread-bug', this.item('assistant_message', 'Half writ', 'agent', 'running'));

    // A subagent: not a chat of its own.
    mk('thread-sub', 'proj-a', 'helper', { subagent: true });
    this.addItem('thread-sub', this.item('user_message', 'sub task', 'agent'));
  }

  shell(t: FakeThread) {
    return {
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      createdBy: 'user',
      creationSource: 'web',
      providerInstanceId: t.providerInstanceId,
      modelSelection: { instanceId: t.providerInstanceId, model: t.model },
      lineage: { parentThreadId: t.subagent ? 'thread-fix' : null, relationshipToParent: t.subagent ? 'subagent' : null, rootThreadId: t.id },
      latestRunId: t.latestRunId,
      status: t.status,
      lastError: t.lastError,
      pendingRuntimeRequest: t.pending ? { id: t.pending.id, kind: t.pending.kind, createdAt: iso(t.updatedAt) } : null,
      itemCount: t.items.length,
      visibleItemCount: t.items.length,
      createdAt: iso(Date.parse('2026-01-05T09:00:00Z')),
      updatedAt: iso(t.updatedAt),
      archivedAt: null,
      lastVisitedAt: t.lastVisitedAt == null ? null : iso(t.lastVisitedAt),
      deletedAt: null,
    };
  }

  /** Tells the stream's subscribers a thread changed, as the server does. */
  push(threadId: string) {
    const t = this.threads.get(threadId)!;
    const frame = JSON.stringify({ _tag: 'Chunk', requestId: '1', values: [{ kind: 'thread.updated', sequence: ++this.seq, location: 'active', thread: this.shell(t) }] });
    for (const ws of this.sockets) ws.send(frame);
  }

  /** A thread in a project the extractor has not heard of: the thread's update first, the project's after. */
  newProjectThread(projectId: string, title: string, threadId: string, prompt: string) {
    const t: FakeThread = { id: threadId, projectId, title, status: 'running', providerInstanceId: 'codex', model: 'model-y', updatedAt: this.tick(), latestRunId: `run-${threadId}`, pending: null, lastError: null, lastVisitedAt: null, subagent: false, items: [] };
    this.threads.set(threadId, t);
    this.addItem(threadId, this.item('user_message', prompt, 'user'));
    this.push(threadId);
    const p = { id: projectId, title, workspaceRoot: `/srv/${projectId}` };
    this.projects.push(p);
    const frame = JSON.stringify({ _tag: 'Chunk', requestId: '1', values: [{ kind: 'project.updated', sequence: ++this.seq, project: p }] });
    for (const ws of this.sockets) ws.send(frame);
  }

  /** The agent says something (settled), and the stream hears of it. */
  say(threadId: string, text: string, status = 'completed') {
    const it = this.addItem(threadId, this.item('assistant_message', text, 'agent'));
    const t = this.threads.get(threadId)!;
    t.status = status;
    this.push(threadId);
    return it;
  }

  // ---------------------------------------------------------------- MCP

  private auth(req: Request) {
    const tok = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const s = this.sessions.get(tok);
    return s && !s.revoked ? s : null;
  }

  private async mcp(req: Request): Promise<Response> {
    const s = this.auth(req);
    if (!s || s.subject !== 'mcp-client') return Response.json({ error: 'invalid_mcp_credential' }, { status: 401 });
    if (req.method === 'DELETE') return new Response(null, { status: 204 });
    const m = (await req.json()) as { id?: string; method: string; params?: any };
    if (m.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => {
      const body = { jsonrpc: '2.0', id: m.id, result };
      // Every other answer as an event stream, as T3's endpoint may.
      if (this.n++ % 2) return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' } });
      return Response.json(body, { headers: { 'mcp-session-id': 'sess-1' } });
    };
    if (m.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-t3', version: '0' } });
    if (m.method !== 'tools/call') return reply({});
    const { name, arguments: a } = m.params;
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
    const ok = (structuredContent: unknown) => reply({ content: [{ type: 'text', text: '{}' }], structuredContent });
    const err = (message: string) => reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'x', message }) }] });
    if (name === 't3_project_list') return ok({ projects: this.projects, nextCursor: null });
    if (name === 't3_thread_list') {
      const list = [...this.threads.values()].filter((t) => a.includeSubagents || !t.subagent).sort((x, y) => y.updatedAt - x.updatedAt);
      return ok({ projectId: null, currentThreadId: null, threads: list.slice(0, a.limit ?? 100).map((t) => ({ threadId: t.id, projectId: t.projectId, title: t.title, status: t.pending ? 'waiting' : t.status, latestRunId: t.latestRunId, providerInstanceId: t.providerInstanceId, model: t.model, relationshipToParent: t.subagent ? 'subagent' : null, itemCount: t.items.length, createdAt: iso(t.updatedAt), updatedAt: iso(t.updatedAt) })), nextCursor: null, total: list.length });
    }
    if (name === 't3_thread_read') {
      const t = this.threads.get(a.threadId);
      if (!t) return err(`No thread ${a.threadId}.`);
      const cap = a.maxCharsPerItem ?? 4000;
      const view = (it: FakeItem, from = 0) => {
        const text = it.text ?? '';
        const part = text.slice(from, from + cap);
        const more = from + cap < text.length;
        return { ...it, visibility: 'local', sourceThreadId: t.id, runId: t.latestRunId, creationSource: 'web', title: null, text: part, textTruncated: more, nextTextOffset: more ? from + cap : null };
      };
      const thread = { threadId: t.id, projectId: t.projectId, title: t.title, link: `https://t3.example/threads/${t.id}`, status: t.status, pendingRequestCount: t.pending ? 1 : 0 };
      if (a.itemId) {
        const it = t.items.find((x) => x.itemId === a.itemId);
        return ok({ thread, recentRuns: [], items: it ? [view(it, a.textOffset ?? 0)] : [], nextPosition: null, hasMore: false });
      }
      const pool = t.items.filter((it) => (a.view === 'messages' ? it.type.endsWith('_message') : true) && (a.afterPosition === undefined || it.position > a.afterPosition));
      const page = pool.slice(0, a.limit ?? 50);
      return ok({ thread, recentRuns: [], items: page.map((it) => view(it)), nextPosition: page.at(-1)?.position ?? null, hasMore: pool.length > page.length });
    }
    return err(`the fake has no ${name}`);
  }

  // ---------------------------------------------------------------- the fake CLI's side

  private async ctl(op: string, body: any): Promise<Response> {
    if (op === 'issue') {
      const token = `tok-${this.n++}-${Math.random().toString(36).slice(2)}`;
      const s = { id: `sess-${this.n++}`, subject: body.subject ?? 'cli-issued-session', scopes: body.scopes ?? [], revoked: false };
      this.sessions.set(token, s);
      return Response.json({ sessionId: s.id, token, method: 'bearer-access-token', scopes: s.scopes, subject: s.subject, expiresAt: iso(Date.now() + 7 * 86400_000) });
    }
    if (op === 'revoke') {
      for (const s of this.sessions.values()) if (s.id === body.sessionId) s.revoked = true;
      return Response.json({ ok: true });
    }
    if (op === 'send') {
      const t = this.threads.get(body.threadId);
      if (!t) return Response.json({ error: `No thread ${body.threadId}.` }, { status: 404 });
      this.sends.push({ threadId: body.threadId, message: body.message });
      // A client's turn: T3 marks it as an agent's (it came through MCP).
      const it = this.addItem(t.id, this.item('user_message', body.message, 'agent'));
      t.status = 'running';
      this.push(t.id);
      setTimeout(() => this.say(t.id, `You said: ${body.message}`), 150);
      return Response.json({ threadId: t.id, messageId: it.messageId, runId: `run-${this.n++}`, status: 'starting', delivery: 'started' });
    }
    return Response.json({ error: 'unknown' }, { status: 404 });
  }
}
