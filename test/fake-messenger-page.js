/*
 * A stand-in for Messenger's and Instagram's web apps, for extractors/meta's hook: the parts the hook touches, shaped
 * as the real bundles have them (read from the public resources on 2026-11-07; docs/messenger.md), nothing more.
 *
 *  - the module system: an inline stub that queues `__d` calls in `__d_stub`, then a runtime that defines modules by
 *    name, runs a factory on first require, keeps records `{ id, exports, defaultExport, factoryFinished, ... }`
 *    in `__debug.modulesMap`, answers `ifRequired`, and calls `__onAfterModuleFactory(record)`;
 *  - Messenger: a ReStore-like LightSpeed database (tables, a subscription manager every row passes through,
 *    transactions, 64-bit values as [high, low]), ReQL, LSIssueNewTask/LSFactory, a task sender that ships the
 *    pending_tasks queue to the server, MAWBridge for end-to-end encrypted chats, and a chat list and composer;
 *  - Instagram: a Relay-like environment and store with Slide records, the delta router, the typing transformer,
 *    and the IGDMAPI* message modules, mutations and the history query, all going to the server as the real ones do.
 *
 * It runs in a real page (served by test/fake-messenger.ts) and in a plain object standing in for `window` (the hook's
 * unit tests): everything it reaches goes through `win` and `opts.transport`.
 */
(function (root) {
  'use strict';

  root.installFakeMeta = function installFakeMeta(win, opts) {
    const T = opts.transport; // { post(path, body) -> Promise<json>, poll(since) -> Promise<{ events, next }> }
    const missing = new Set(opts.missing || []);
    // LightSpeed's 64-bit integers: [high, low]. Offline ids pass 2^53, so through BigInt.
    const L = (n) => {
      const b = BigInt(String(n));
      return [Number(BigInt.asIntN(32, b >> 32n)), Number(b & 0xffffffffn)];
    };
    const S = (v) => (Array.isArray(v) ? ((BigInt(v[0]) << 32n) + BigInt(v[1] >>> 0)).toString() : String(v));
    const N = (v) => Number(S(v));
    const newOtid = () => ((BigInt(Date.now()) << 22n) | BigInt(Math.floor(Math.random() * 4194304))).toString();
    const doc = win.document;

    // ------------------------------------------------------------- modules
    const modules = {};
    function run(rec) {
      if (rec.factoryFinished) return rec.exports;
      const module = { exports: {} };
      rec.factory(win, req, importDefault, importNamespace, requireLazy, module, module.exports);
      rec.exports = module.exports;
      rec.defaultExport = module.exports && module.exports.default !== undefined ? module.exports.default : module.exports;
      rec.factoryFinished = true;
      rec.factory = null;
      if (typeof win.__onAfterModuleFactory === 'function') win.__onAfterModuleFactory(rec);
      return rec.exports;
    }
    const specials = {
      __debug: { modulesMap: modules, getCounts: () => ({ numDefined: Object.keys(modules).length }) },
      ifRequired: (name, found, notFound) => {
        const r = modules[name];
        return r && r.factoryFinished ? found(r.exports) : notFound && notFound();
      },
    };
    function req(name) {
      if (name in specials && !(name === '__debug' && opts.noDebug)) return specials[name];
      const rec = modules[name];
      if (!rec) throw new Error(`Requiring unknown module "${name}"`);
      return run(rec);
    }
    function importDefault(name) {
      req(name);
      return modules[name].defaultExport;
    }
    function importNamespace(name) {
      return req(name);
    }
    function requireLazy(names, cb) {
      setTimeout(() => cb(...names.map(req)), 0);
    }
    function define(name, deps, factory) {
      if (missing.has(name) || modules[name]) return;
      modules[name] = { id: name, exports: null, defaultExport: undefined, factory, factoryFinished: false, hasError: false, dependencies: deps };
    }
    // The runtime starts: the hooks it offers are empty, then __d becomes real and the stub's queue is drained.
    win.__onBeforeModuleFactory = null;
    win.__onAfterModuleFactory = null;
    win.require = req;
    win.requireLazy = requireLazy;
    win.importDefault = importDefault;
    win.__d = function (name, deps, factory) {
      define(name, deps, factory);
    };
    for (const e of win.__d_stub || []) win.__d.apply(null, e);
    delete win.__d_stub;
    // A module a test leaves out is never defined at all, so not even its name reaches __d.
    const def = (name, factory) => (missing.has(name) ? undefined : win.__d(name, [], factory, 98));
    /** What the app loads at start, unless a test left it out. */
    const boot = (name) => (modules[name] ? req(name) : undefined);

    // -------------------------------------------------------------- session
    const me = opts.self; // { fb, ig, eimu }
    def('CurrentUserInitialData', (g, r, d, n, l, m) => {
      m.exports = { USER_ID: opts.signedIn ? me.fb : '0', NON_FACEBOOK_USER_ID: opts.signedIn ? me.ig || me.fb : '0', IG_USER_EIMU: opts.signedIn ? me.eimu || '0' : '0', NAME: opts.signedIn ? 'Sam Self' : '' };
    });
    def('CurrentUser', (g, r, d, n, l, m, e) => {
      const data = r('CurrentUserInitialData');
      e.getID = () => data.USER_ID;
      e.getPossiblyNonFacebookUserID = () => data.NON_FACEBOOK_USER_ID;
      e.getEIMU = () => data.IG_USER_EIMU;
      e.getName = () => data.NAME;
      e.isLoggedIn = () => data.NON_FACEBOOK_USER_ID !== '0';
    });
    def('SiteData', (g, r, d, n, l, m) => {
      m.exports = { client_revision: 1029384756, server_revision: 1029384756 };
    });
    req('CurrentUser');
    req('SiteData');
    if (!opts.signedIn) return { modules };

    const calls = [];
    const send = (path, body) => {
      calls.push(path);
      return T.post(path, body);
    };
    // What each transaction was opened with after its callback (mode, …, the name it is traced by), in order.
    const api = { modules, calls, actions: {}, transactions: [] };

    // ============================================================ Messenger
    if (opts.site === 'messenger') {
      def('I64', (g, r, d, n, l, m, e) => {
        e.cast = (v) => v;
        e.of_float = (f) => L(f);
        e.of_string = (s) => L(Number(s));
        e.to_string = (v) => S(v);
        e.to_float = (v) => N(v);
      });
      const PK = {
        threads: ['threadKey'],
        messages: ['threadKey', 'timestampMs', 'messageId'],
        contacts: ['id'],
        participants: ['threadKey', 'contactId'],
        reactions: ['threadKey', 'messageId', 'actorId'],
        attachments: ['threadKey', 'messageId', 'attachmentFbid'],
        typing_indicator: ['threadKey', 'senderId'],
        pending_tasks: ['taskId'],
      };
      const keyOf = (t, row) => JSON.stringify(PK[t].map((k) => (Array.isArray(row[k]) ? S(row[k]) : row[k])));
      const subs = {};
      const commitSubs = new Set();
      // Every row passes through here on its way to the views; the hook wraps it.
      const SM = {
        notifyTableAndIndexSubscribers(table, prev, next, ctx) {
          for (const h of subs[table] || []) h(next ? keyOf(table, next) : keyOf(table, prev), prev && next ? { operation: 'put', prevValue: prev, value: next } : next ? { operation: 'add', value: next } : { operation: 'delete', prevValue: prev }, ctx);
        },
        subscribeTable(t, h) {
          (subs[t] = subs[t] || []).push(h);
          return () => (subs[t] = subs[t].filter((x) => x !== h));
        },
        subscribeToCommit(cb) {
          commitSubs.add(cb);
          return () => commitSubs.delete(cb);
        },
        notifyCommit() {
          for (const cb of commitSubs) cb();
        },
      };
      // A build whose subscription manager cannot be wrapped: the hook must subscribe table by table instead.
      if (opts.frozenNotify) Object.defineProperty(SM, 'notifyTableAndIndexSubscribers', { value: SM.notifyTableAndIndexSubscribers, writable: false, configurable: false });
      let taskSeq = 0;
      function table(name) {
        const rows = new Map();
        const write = (prev, next) => SM.notifyTableAndIndexSubscribers(name, prev, next, {});
        return {
          name,
          keyFields: PK[name],
          rows,
          get: (...key) => rows.get(JSON.stringify(key.map((k) => (Array.isArray(k) ? S(k) : k)))),
          put(row) {
            if (name === 'pending_tasks' && row.taskId === undefined) row = { ...row, taskId: L(++taskSeq) };
            const k = keyOf(name, row);
            const prev = rows.get(k);
            rows.set(k, row);
            write(prev || null, row);
            return row;
          },
          add(row) {
            return this.put(row);
          },
          delete(row) {
            const k = keyOf(name, row);
            const prev = rows.get(k);
            if (!prev) return;
            rows.delete(k);
            write(prev, null);
          },
          subscribe(h) {
            return SM.subscribeTable(name, h);
          },
          entries(_bounds, dir) {
            const list = sorted(name, dir);
            let i = 0;
            return { next: () => Promise.resolve(i < list.length ? { done: false, value: { item: list[i++] } } : { done: true, value: undefined }) };
          },
        };
      }
      function sorted(name, dir) {
        const list = [...tables[name].rows.values()].sort((a, b) => {
          for (const k of PK[name]) {
            const x = Array.isArray(a[k]) ? N(a[k]) : a[k];
            const y = Array.isArray(b[k]) ? N(b[k]) : b[k];
            if (x < y) return -1;
            if (x > y) return 1;
          }
          return 0;
        });
        return dir === 'desc' ? list.reverse() : list;
      }
      const tables = {};
      for (const t of Object.keys(PK)) tables[t] = table(t);
      const db = {
        tables,
        table: (n) => tables[n],
        subscriptionManager: SM,
        subscribeToCommit: (cb) => SM.subscribeToCommit(cb),
        getTableData: () => ({ tableNames: PK }),
        async runInTransaction(fn, ...rest) {
          api.transactions.push(rest);
          const r = await fn({ tables, table: (n) => tables[n] });
          SM.notifyCommit();
          return r;
        },
      };
      const dbReady = new Promise((res) => setTimeout(() => res(db), 30));
      def('LSDatabaseSingleton', (g, r, d, n, l, m, e) => {
        let v = dbReady;
        dbReady.then((x) => (v = x));
        e.LSDatabaseSingleton = dbReady;
        e.getLSDatabaseSingletonPromiseOrValue = () => v;
      });
      def('LSDatabaseSingletonLazyWrapper', (g, r, d, n, l, m, e) => {
        e.default = () => dbReady;
      });
      def('ReQL', (g, r, d, n, l, m, e) => {
        const q = (t, dir, prefix) => ({ table: t, dir, prefix, getKeyRange: (...p) => q(t, dir, p) });
        e.fromTableAscending = (t) => q(t, 'asc', null);
        e.fromTableDescending = (t) => q(t, 'desc', null);
        e.toArrayAsync = async (query) => sorted(query.table.name, query.dir).filter((row) => !query.prefix || query.prefix.every((p, i) => S(row[PK[query.table.name][i]]) === S(p)));
        e.firstAsync = async (query) => (await e.toArrayAsync(query))[0];
      });
      // The client's stored procedures run on a runtime made from a transaction.
      def('LSFactory', (g, r, d, n, l, m) => {
        m.exports = (tx) => ({ i64: r('I64'), db: { table: (id) => tx.table(id === 2 ? 'pending_tasks' : id) }, tx });
      });
      def('LSIssueNewTask', (g, r, d, n, l, m) => {
        function issue() {
          const a = arguments;
          const rt = a[a.length - 1];
          rt.tx.tables.pending_tasks.add({ taskId: undefined, queueName: a[0], context: rt.i64.to_string(a[1]), taskValue: a[2], enqueueTimestampMs: L(Date.now()), httpUrlOverride: a[3], timeoutTimestampMs: a[4], pluginType: a[5], priority: a[6], syncGroupId: a[7], transportKey: a[8], minTimeToSyncTimestampMs: a[9] });
        }
        issue.__sproc_name__ = 'LSCoreIssueNewTaskStoredProcedure';
        issue.__tables__ = ['pending_tasks'];
        m.exports = issue;
      });
      def('MAWBridge', (g, r, d, n, l, m, e) => {
        const bridge = {
          sendAndReceive: (backend, route, payload) => send('/maw', { backend, route, payload }),
          fireAndForget: (backend, route, payload) => void send('/maw', { backend, route, payload }),
        };
        e.getBridge = () => bridge;
      });
      boot('I64');
      boot('ReQL');
      boot('LSDatabaseSingleton');
      boot('LSDatabaseSingletonLazyWrapper');

      // The task sender: what the client queues, it ships, then takes off the queue.
      tables.pending_tasks.subscribe((key, change) => {
        if (change.operation !== 'add') return;
        const t = change.value;
        void send('/ls_req', { label: t.context, queue: t.queueName, payload: t.taskValue, pluginType: t.pluginType === undefined ? null : S(t.pluginType), syncGroupId: t.syncGroupId === undefined ? null : S(t.syncGroupId) }).finally(() => tables.pending_tasks.delete(t));
      });

      // What the server says goes into the tables as the client's stored procedures would put it.
      const rowOf = {
        thread: (t) => ({ threadKey: L(t.id), threadType: L(t.type), threadName: t.name ?? null, threadPictureUrl: t.picture ?? null, lastActivityTimestampMs: L(t.lastActivity), lastReadWatermarkTimestampMs: L(t.lastRead || 0), muteExpireTimeMs: L(t.muteUntil || 0), folderName: 'inbox', unreadMessageCount: L(t.unread || 0), isHidden: false, snippet: 'secret snippet' }),
        contact: (c) => ({ id: L(c.id), name: c.name, firstName: c.name.split(' ')[0], username: c.username ?? null, profilePictureUrl: c.picture ?? null, contactType: L(1), phoneNumber: '+1 555 0100' }),
        participant: (p) => ({ threadKey: L(p.thread), contactId: L(p.contact), readWatermarkTimestampMs: L(p.read || 0), deliveredWatermarkTimestampMs: L(p.delivered || 0), nickname: null, isAdmin: false }),
        message: (x) => ({ threadKey: L(x.thread), timestampMs: L(x.ts), messageId: x.id, offlineThreadingId: x.otid ? L(x.otid) : null, senderId: L(x.sender), text: x.text ?? null, isAdminMessage: false, stickerId: null, isUnsent: !!x.unsent, replySourceId: x.replyTo ?? null, mentionOffsets: x.mentions ? x.mentions.map((m) => m.at).join(',') : null, mentionLengths: x.mentions ? x.mentions.map((m) => m.len).join(',') : null, mentionIds: x.mentions ? x.mentions.map((m) => m.id).join(',') : null, isForwarded: false, editCount: L(x.edits || 0), sendStatusV2: L(x.pending ? 1 : 0) }),
        reaction: (x) => ({ threadKey: L(x.thread), messageId: x.message, actorId: L(x.actor), reaction: x.emoji, timestampMs: L(x.ts || Date.now()) }),
        attachment: (a) => ({ threadKey: L(a.thread), messageId: a.message, attachmentFbid: L(a.id), attachmentType: L(2), filename: a.name, filesize: L(a.size), previewUrl: a.url, previewUrlMimeType: a.mime, playableUrl: null, previewWidth: L(a.width || 0), previewHeight: L(a.height || 0) }),
      };
      const apply = (ev) =>
        db.runInTransaction(async () => {
          switch (ev.sp) {
            case 'thread':
              return tables.threads.put(rowOf.thread(ev.thread));
            case 'contact':
              return tables.contacts.put(rowOf.contact(ev.contact));
            case 'participant':
              return tables.participants.put(rowOf.participant(ev.participant));
            case 'message': {
              if (ev.message.otid) for (const row of [...tables.messages.rows.values()]) if (row.offlineThreadingId && S(row.offlineThreadingId) === String(ev.message.otid) && row.messageId !== ev.message.id) tables.messages.delete(row);
              return tables.messages.put(rowOf.message(ev.message));
            }
            case 'reaction':
              return ev.remove ? tables.reactions.delete(rowOf.reaction(ev.reaction)) : tables.reactions.put(rowOf.reaction(ev.reaction));
            case 'attachment':
              return tables.attachments.put(rowOf.attachment(ev.attachment));
            case 'typing': {
              const row = { threadKey: L(ev.thread), senderId: L(ev.sender), expirationTimestampMs: L(Date.now() + 10000) };
              return ev.on ? tables.typing_indicator.put(row) : tables.typing_indicator.delete(row);
            }
          }
        });
      api.apply = apply;

      // ------------------------------------------------- the client's own UI
      let current = null;
      const isE2EE = (key) => {
        const t = tables.threads.get(L(key));
        return t && (N(t.threadType) === 15 || N(t.threadType) === 16);
      };
      /** The client's own send: an optimistic row, then a task (or the encryption worker for an encrypted chat). */
      async function clientSend(key, text, replyTo) {
        const otid = newOtid();
        await db.runInTransaction(async (tx) => {
          tx.tables.messages.put(rowOf.message({ thread: key, ts: Date.now(), id: `mid.$opt${otid}`, otid, sender: me.fb, text, pending: true, replyTo }));
        });
        if (isE2EE(key)) return req('MAWBridge').getBridge().sendAndReceive('backend', 'sendTextMessage', { chatJid: `${key}@msgr`, otid, text, replyTo: replyTo || null });
        const payload = `{"thread_id":${key},"otid":"${otid}","source":65537,"send_type":1,"sync_group":1,` + (replyTo ? `"reply_metadata":{"reply_source_id":${JSON.stringify(replyTo)},"reply_source_type":1,"reply_type":0},` : '') + `"text":${JSON.stringify(text)},"initiating_source":1,"skip_url_preview_gen":0,"text_has_links":0,"multitab_env":0}`;
        await task(String(key), 46, payload);
      }
      // The client names the transactions it issues tasks in (here: after the task's label), as Meta's code traces them.
      async function task(queue, label, payload) {
        await db.runInTransaction(
          async (tx) => {
            const rt = req('LSFactory')(tx);
            req('LSIssueNewTask')(queue, rt.i64.of_float(label), payload, undefined, undefined, rt.i64.of_float(0), rt.i64.of_float(0), rt.i64.of_float(1), undefined, undefined, rt);
          },
          'readwrite',
          undefined,
          undefined,
          `FakeTaskIssuer.${label}`,
        );
      }
      api.actions = {
        send: (a) => clientSend(a.thread, a.text, a.replyTo),
        react: (a) => {
          const row = [...tables.messages.rows.values()].find((m) => m.messageId === a.message);
          return task(JSON.stringify(['reaction', a.message]), 29, `{"thread_key":${a.thread},"timestamp_ms":${row ? N(row.timestampMs) : 0},"message_id":${JSON.stringify(a.message)},"actor_id":${me.fb},"reaction":${JSON.stringify(a.emoji)},"reaction_style":null,"sync_group":1,"send_attribution":65537}`);
        },
        markRead: (a) => task(String(a.thread), 21, `{"thread_id":${a.thread},"last_read_watermark_ts":${Date.now()},"sync_group":1}`),
        edit: (a) => task('edit_message', 742, `{"message_id":${JSON.stringify(a.message)},"text":${JSON.stringify(a.text)}}`),
        unsend: (a) => task('unsend_message', 33, `{"message_id":${JSON.stringify(a.message)}}`),
      };

      if (doc && opts.ui !== false) {
        const main = doc.createElement('div');
        main.setAttribute('role', 'main');
        const list = doc.createElement('nav');
        const box = doc.createElement('div');
        box.setAttribute('contenteditable', 'true');
        box.setAttribute('role', 'textbox');
        box.setAttribute('aria-label', 'Message');
        box.id = 'composer';
        main.appendChild(box);
        doc.body.appendChild(list);
        doc.body.appendChild(main);
        const open = (key) => {
          current = key;
          box.textContent = '';
        };
        const route = () => {
          const m = win.location.pathname.match(/\/t\/(\d+)/);
          open(m ? m[1] : null);
        };
        api.renderList = () => {
          list.textContent = '';
          for (const t of sorted('threads', 'desc')) {
            const a = doc.createElement('a');
            a.href = `/${N(t.threadType) === 15 || N(t.threadType) === 16 ? 'e2ee/' : ''}t/${S(t.threadKey)}/`;
            a.textContent = 'chat';
            a.addEventListener('click', (e) => {
              e.preventDefault();
              win.history.pushState(null, '', a.getAttribute('href'));
              route();
            });
            list.appendChild(a);
          }
        };
        box.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault();
          const text = box.textContent;
          if (!current || !text.trim()) return;
          box.textContent = '';
          void clientSend(current, text);
        });
        route();
      }
    }

    // ============================================================ Instagram
    if (opts.site === 'instagram') {
      const recs = new Map();
      const notifySubs = new Set();
      const source = {
        getRecordIDs: () => [...recs.keys()],
        get: (id) => (recs.has(id) ? recs.get(id) : undefined),
        has: (id) => recs.has(id),
        size: () => recs.size,
      };
      const store = {
        getSource: () => source,
        /** Every change reaches the store as a source of changed records (null: deleted). */
        publish(src) {
          for (const id of src.getRecordIDs()) {
            const r = src.get(id);
            if (r === null) recs.delete(id);
            else recs.set(id, { ...(recs.get(id) || {}), ...r });
          }
        },
        notify() {
          for (const cb of notifySubs) cb();
        },
        subscribe: (cb) => (notifySubs.add(cb), { dispose: () => notifySubs.delete(cb) }),
      };
      const changes = () => {
        const m = new Map();
        return {
          set: (id, r) => m.set(id, r),
          del: (id) => m.set(id, null),
          src: { getRecordIDs: () => [...m.keys()], get: (id) => m.get(id) },
        };
      };
      const env = {
        getStore: () => store,
        commitUpdate(fn) {
          const c = changes();
          fn(c);
          store.publish(c.src);
          store.notify();
        },
        commitPayload(op, payload) {
          this.commitUpdate((c) => normalize(c, payload));
        },
        execute: () => ({ subscribe: () => ({ unsubscribe() {} }) }),
      };
      const ref = (id) => ({ __ref: id });
      const refs = (ids) => ({ __refs: ids });
      function userRecs(c, u) {
        c.set(`XDTUserDict:${u.pk}`, { __id: `XDTUserDict:${u.pk}`, __typename: 'XDTUserDict', pk: u.pk, id: u.pk, username: u.username, full_name: u.name, profile_pic_url: u.picture, interop_messaging_user_fbid: u.fbid });
        c.set(`SlideUser:${u.fbid}`, { __id: `SlideUser:${u.fbid}`, __typename: 'SlideUser', id: u.fbid, igid: u.pk, name: u.name, user_dict: ref(`XDTUserDict:${u.pk}`) });
      }
      function messageRecs(c, m) {
        const id = `SlideMessage:${m.id}`;
        const cid = `client:${m.id}:content`;
        if (m.image) {
          c.set(`client:${m.id}:att`, { __id: `client:${m.id}:att`, __typename: 'XFBSlideAttachment', attachment_fbid: m.image.id, attachment_type: 'image', preview_cdn_url: m.image.url, preview_width: m.image.width, preview_height: m.image.height });
          c.set(cid, { __id: cid, __typename: 'SlideMessageImageContent', attachments: refs([`client:${m.id}:att`]) });
        } else c.set(cid, { __id: cid, __typename: 'SlideMessageTextContent' });
        const rids = (m.reactions || []).map((r, i) => {
          const rid = `client:${m.id}:r${i}`;
          c.set(rid, { __id: rid, __typename: 'XFBSlideReaction', reaction: r.emoji, sender_fbid: r.sender, reaction_timestamp_ms: String(r.ts || 1) });
          return rid;
        });
        const eids = (m.edits || []).map((e, i) => {
          const eid = `client:${m.id}:e${i}`;
          c.set(eid, { __id: eid, __typename: 'XFBSlideMessageEdit', body: 'old words', timestamp_ms: String(e) });
          return eid;
        });
        c.set(id, {
          __id: id,
          __typename: 'SlideMessage',
          id: m.id,
          message_id: m.id,
          thread_fbid: m.thread,
          sender_fbid: m.sender,
          timestamp_ms: String(m.ts),
          text_body: m.text ?? null,
          offline_threading_id: m.otid || null,
          replied_to_message_id: m.replyTo || null,
          igd_snippet: 'secret snippet',
          content: ref(cid),
          reactions: refs(rids),
          slide_edit_history: refs(eids),
          sender: ref(`SlideUser:${m.sender}`),
          client__send_status: m.status || 'AUTHORITATIVE',
        });
      }
      function threadRecs(c, t) {
        for (const u of t.users) userRecs(c, u);
        const rr = (t.receipts || []).map((r, i) => {
          const rid = `client:${t.fbid}:rr${i}`;
          c.set(rid, { __id: rid, __typename: 'XFBSlideReadReceipt', participant_fbid: r.fbid, watermark_timestamp_ms: String(r.ts) });
          return rid;
        });
        c.set(`XFBIGDirectViewerThread:${t.fbid}`, {
          __id: `XFBIGDirectViewerThread:${t.fbid}`,
          __typename: 'XFBIGDirectViewerThread',
          id: `node:${t.fbid}`,
          thread_fbid: t.fbid,
          thread_id: t.igid,
          thread_key: t.fbid,
          thread_title: t.title,
          is_group: !!t.group,
          is_muted: !!t.muted,
          last_activity_timestamp_ms: String(t.lastActivity),
          users: refs(t.users.map((u) => `XDTUserDict:${u.pk}`)),
          slide_read_receipts: refs(rr),
          viewer_id: me.eimu,
        });
        c.set(`SlideThread:${t.fbid}`, { __id: `SlideThread:${t.fbid}`, __typename: 'SlideThread', id: t.fbid, as_ig_direct_thread: ref(`XFBIGDirectViewerThread:${t.fbid}`) });
      }
      function normalize(c, payload) {
        for (const t of payload.threads || []) threadRecs(c, t);
        for (const m of payload.messages || []) messageRecs(c, m);
      }
      api.store = { recs };
      def('PolarisRelayEnvironment', (g, r, d, n, l, m, e) => {
        e.default = env;
      });
      // Another module that holds the same environment (Instagram has several): found by its shape alone.
      def('IGDWebRelayEnvironmentHolder', (g, r, d, n, l, m, e) => {
        e.environment = env;
      });
      const relay = (e) => {
        e.commitMutation = (environment, config) => {
          const name = config.mutation && config.mutation.params ? config.mutation.params.name : '?';
          if (config.optimisticUpdater) environment.commitUpdate((c) => config.optimisticUpdater({ get: () => null, set: c.set }));
          send('/graphql', { name, variables: config.variables })
            .then((res) => (res && res.errors ? config.onError && config.onError(new Error(res.errors[0].message)) : config.onCompleted && config.onCompleted(res.data || {}, null)))
            .catch((err) => config.onError && config.onError(err));
          return { dispose() {} };
        };
        e.fetchQuery = (environment, query, variables) => ({
          toPromise: () =>
            send('/graphql', { name: query.params.name, variables }).then((res) => {
              environment.commitPayload(null, res.data || {});
              return res.data;
            }),
        });
      };
      def('relay-runtime', (g, r, d, n, l, m, e) => relay(e));
      def('CometRelay', (g, r, d, n, l, m, e) => relay(e));
      const op = (name, kind) => (g, r, d, n, l, m) => {
        m.exports = { kind: 'Request', params: { name, operationKind: kind, id: `${name}_instagramRelayOperation` } };
      };
      def('useIGDMarkThreadAsReadMutation.graphql', op('useIGDMarkThreadAsReadMutation', 'mutation'));
      def('IGDMessageListOffMsysQuery.graphql', op('IGDMessageListOffMsysQuery', 'query'));
      // The delta router and its handlers.
      def('IGDSlideMutationProcessor', (g, r, d, n, l, m, e) => {
        e.default = (environment, delta) => {
          environment.commitUpdate((c) => {
            switch (delta.__typename) {
              case 'SlideUQPPNewMessage':
                if (delta.message.otid) c.del(`SlideMessage:mid.$${delta.message.otid}`);
                return messageRecs(c, delta.message);
              case 'SlideUQPPEditMessage':
              case 'SlideUQPPCreateReaction':
              case 'SlideUQPPDeleteReaction':
                return messageRecs(c, delta.message);
              case 'SlideUQPPDeleteMessage':
                return c.del(`SlideMessage:${delta.message_id}`);
              case 'SlideUQPPReadReceipt':
                return threadRecs(c, delta.thread);
            }
          });
        };
      });
      def('IGDTypingIndicatorTypes', (g, r, d, n, l, m, e) => {
        e.IGDTypingStatus = { TYPING: 1, STOPPED_TYPING: 0 };
      });
      def('IGDTypingIndicatorTransformer', (g, r, d, n, l, m, e) => {
        e.transformIGDTypingPayload = (p) => {
          const a = p && p.xdt_direct_realtime_event && p.xdt_direct_realtime_event.data && p.xdt_direct_realtime_event.data[0];
          const v = JSON.parse((a && a.value) || '{}');
          const t = ((a && a.path) || '').match(/threads\/(\d+)\/activity_indicator_id/);
          return t ? { activityStatus: v.activity_status, senderIgId: String(v.sender_id), threadIgId: t[1], timestamp: Math.floor(Number(v.timestamp) / 1000), ttl: v.ttl } : null;
        };
      });
      // The message API: an optimistic record, then the mutation; the server's delta brings the real message.
      def('IGDMAPISendTextMessage', (g, r, d, n, l, m, e) => {
        e.IGDMAPISendTextMessage = async (environment, args) => {
          const otid = newOtid();
          environment.commitUpdate((c) => messageRecs(c, { id: `mid.$${otid}`, thread: args.threadFbid, sender: args.senderId, ts: Date.now(), text: args.text, otid, status: 'SENDING' }));
          try {
            await send('/graphql', { name: 'IGDirectTextSendMutation', variables: { text: { sensitive_string_value: args.text }, ig_thread_igid: args.threadFbid, offline_threading_id: otid, reply_to_message_id: args.repliedMessageContent ? args.repliedMessageContent.messageId : null, recipient_igids: null, mentioned_user_ids: null, mentions: null, commands: null, forwarded_from_thread_id: null, is_forwarded_from_own_message: null, replied_to_item_id: null, send_attribution: null } });
          } catch (err) {
            environment.commitUpdate((c) => messageRecs(c, { id: `mid.$${otid}`, thread: args.threadFbid, sender: args.senderId, ts: Date.now(), text: args.text, otid, status: 'FAILED' }));
          }
        };
      });
      def('IGDMAPISendReaction', (g, r, d, n, l, m, e) => {
        e.IGDMAPISendReaction = async (environment, args) => {
          await new Promise((res) => r('CometRelay').commitMutation(environment, { mutation: { params: { name: 'IGDirectReactionSendMutation' } }, variables: { input: { emoji: args.emoji, item_id: '', message_id: args.messageId, reaction_status: args.reactionStatus, thread_id: args.threadFbid } }, onCompleted: res, onError: res }));
        };
      });
      def('IGDMAPIEditMessage', (g, r, d, n, l, m, e) => {
        e.IGDMAPIEditMessage = async (environment, args) => {
          await new Promise((res) => r('CometRelay').commitMutation(environment, { mutation: { params: { name: 'IGDirectEditMessageMutation' } }, variables: { body: { sensitive_string_value: args.text }, offline_threading_id: '1', target_message_id: args.messageId, thread_id: args.threadFbid }, onCompleted: res, onError: res }));
        };
      });
      if (opts.unsendModule) {
        def('IGDMAPIUnsendMessage', (g, r, d, n, l, m, e) => {
          e.IGDMAPIUnsendMessage = async (environment, args) => {
            await send('/graphql', { name: 'IGDirectUnsendMessageMutation', variables: { message_id: args.messageId, thread_id: args.threadFbid } });
          };
        });
      }
      def('IGDMAPISendTypingIndicator', (g, r, d, n, l, m, e) => {
        e.default = async (threadId, on) => {
          await send('/mqtt', { topic: '/ig_send_message', payload: { action: 'indicate_activity', activity_status: on ? 1 : 0, client_context: '', thread_id: threadId } });
        };
      });
      boot('PolarisRelayEnvironment');
      boot('IGDWebRelayEnvironmentHolder');
      boot('relay-runtime');
      boot('CometRelay');
      boot('IGDSlideMutationProcessor');
      boot('IGDTypingIndicatorTransformer');
      env.commitUpdate((c) => c.set(`SlideMailbox:${me.eimu}`, { __id: `SlideMailbox:${me.eimu}`, __typename: 'SlideMailbox', id: me.eimu, iris_inactive_subscription_uq_seq_id: '7' }));
      api.apply = (ev) => {
        if (ev.kind === 'state') env.commitPayload(null, ev.data);
        else if (ev.kind === 'delta') req('IGDSlideMutationProcessor').default(env, ev.delta, { markHandlerName() {} });
        else if (ev.kind === 'typing') req('IGDTypingIndicatorTransformer').transformIGDTypingPayload(ev.payload);
      };
      api.actions = {
        send: (a) => req('IGDMAPISendTextMessage').IGDMAPISendTextMessage(env, { text: a.text, threadFbid: a.thread, senderId: me.eimu }),
        react: (a) => req('IGDMAPISendReaction').IGDMAPISendReaction(env, { emoji: a.emoji, messageId: a.message, reactionStatus: 'created', senderId: me.eimu, threadFbid: a.thread }),
        markRead: (a) => req('CometRelay').commitMutation(env, { mutation: req('useIGDMarkThreadAsReadMutation.graphql'), variables: { data: { item_id: '', message_id: a.message }, metadata: { ig_thread_igid: a.igid } } }),
      };
    }

    // --------------------------------------------------- the server's pushes
    let since = 0;
    let stopped = false;
    api.stop = () => (stopped = true);
    (async function pump() {
      while (!stopped) {
        let r = null;
        try {
          r = await T.poll(since);
        } catch (e) {
          await new Promise((res) => setTimeout(res, 500));
          continue;
        }
        since = r.next;
        for (const ev of r.events) {
          try {
            if (ev.kind === 'action') await (api.actions[ev.action.type] || (() => {}))(ev.action);
            else await api.apply(ev);
          } catch (e) {}
        }
        if (api.renderList) api.renderList();
      }
    })();
    return api;
  };
})(typeof window !== 'undefined' ? window : globalThis);
