/*
 * MAIN-world content script, injected at document_start on discord.com.
 *
 * This runs the real Discord web client's own modules (the Vencord approach): it
 * grabs webpack's require by pushing a chunk onto window.webpackChunkdiscord_app,
 * locates the Flux dispatcher, a handful of stores, the REST module and the
 * message actions, then (a) forwards a whitelisted snapshot + whitelisted live
 * events out to the ISOLATED world, and (b) runs commands through the client's
 * own code paths so requests look like any other action the user took.
 *
 * It never touches the network itself and never sees the adapter token; it only
 * talks to content.js, over the channel in main-world.js (put in below when the
 * extension is copied), which also keeps what it puts in the page (the chunk
 * list's trap, the media patches during a call) looking like the page's own.
 * Plain JS on purpose (no build step).
 */
(() => {
  'use strict';
  /*@include main-world@*/
  const log = (level, msg, data) => post({ t: 'log', level, msg, data });
  const up = (payload) => post(payload);
  const post = (payload) => cloak.send(payload);
  const promiseThen = Promise.prototype.then;

  // -------------------------------------------------------------- webpack grab
  // Discord ships several rspack runtimes (web, fast-connect, sentry,
  // libdiscore-wasm-fetch) that share window.webpackChunkdiscord_app. Each one
  // wraps the push installed before it, and every chunk script assigns the
  // global again right before pushing. The hook must leave that chain exactly as
  // the runtimes built it: re-wrapping push on each assignment drops them out of
  // it, and lazy chunks then never load ("Loading chunk N failed").
  //
  // Each time a runtime installs its push we send a probe chunk down the chain.
  // Every runtime on it hands the probe its require, and module lookups search
  // all of their caches. The probe then leaves the page's chunk list again, the
  // list's global is a plain property once a runtime has made it, and the push
  // trap reads like a native accessor (main-world.js).
  const requires = new Set();
  const hasOwn = Object.prototype.hasOwnProperty;

  function probe(chunks) {
    const chunk = [
      [Symbol()],
      {},
      (r) => {
        if (r && r.c) requires.add(r);
      },
    ];
    try {
      chunks.push(chunk);
    } catch (e) {
      log('error', 'probe chunk failed', String(e));
    }
    try {
      const i = chunks.lastIndexOf(chunk);
      if (i >= 0) chunks.splice(i, 1);
    } catch (e) {}
  }

  function installWebpackHook() {
    const hooked = new WeakSet();
    const hookArray = (chunks) => {
      if (!chunks || typeof chunks !== 'object' || hooked.has(chunks)) return;
      hooked.add(chunks);
      let push = chunks.push;
      // Enumerable, as the property the runtime assigns is.
      cloak.accessor(
        chunks,
        'push',
        () => push,
        (fn) => {
          push = fn;
          probe(chunks);
        },
        true,
      );
    };
    const stored = window.webpackChunkdiscord_app;
    if (stored) {
      // Injected late: some runtimes may already be on the chain.
      if (cloak.apply(hasOwn, stored, ['push'])) probe(stored);
      hookArray(stored);
      return;
    }
    // Every runtime and chunk script after the first keeps the array the first one made.
    let early;
    cloak.accessor(
      window,
      'webpackChunkdiscord_app',
      () => early,
      (v) => {
        early = v;
        if (!v || typeof v !== 'object') return;
        Object.defineProperty(window, 'webpackChunkdiscord_app', { value: v, writable: true, enumerable: true, configurable: true });
        hookArray(v);
      },
      true,
    );
  }

  // -------------------------------------------------------------- module lookup
  // rspack mangles export names, so every export of every module is a candidate.
  // Except i18n message bundles: they are Proxies that answer every key with a
  // function, so they would pass any shape test and sit ahead of the real modules.
  function answersAnyKey(v) {
    try {
      return v['__MARK_noSuchKey__'] !== undefined;
    } catch (e) {
      return true;
    }
  }
  function candidates() {
    const out = [];
    const seen = new Set();
    const add = (v) => {
      if (v && typeof v === 'object' && !seen.has(v) && !answersAnyKey(v)) {
        seen.add(v);
        out.push(v);
      }
    };
    for (const r of requires) {
      const cache = r.c;
      for (const id in cache) {
        let exp;
        try {
          exp = cache[id] && cache[id].exports;
        } catch (e) {
          continue;
        }
        if (!exp || (typeof exp !== 'object' && typeof exp !== 'function') || exp === window) continue;
        add(exp);
        let keys;
        try {
          keys = Object.keys(exp);
        } catch (e) {
          continue;
        }
        if (keys.length > 64) continue; // icon sets, constant tables
        for (const k of keys) {
          try {
            add(exp[k]);
          } catch (e) {
            /* export binding not initialized yet */
          }
        }
      }
    }
    return out;
  }
  function moduleCount() {
    let n = 0;
    for (const r of requires) n += Object.keys(r.c).length;
    return n;
  }
  function storeName(m) {
    try {
      return typeof m.getName === 'function' && typeof m.emitChange === 'function' ? m.getName() : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * The client's PrivateChannelActions as createGroupDM relies on it (read in build 670026, 2026-11-10):
   * _getRecipients keeps a list as it is, and ensurePrivateChannel(list) is a POST with them as `recipients`, sent
   * without the REST client's `retries` (a second try could make a second group), that puts the answer in the store
   * itself with a CHANNEL_CREATE and resolves to the new channel's id. Its source is read, never run.
   */
  function isGroupMaker(m) {
    if (typeof m.ensurePrivateChannel !== 'function' || typeof m._getRecipients !== 'function') return false;
    const list = m._getRecipients(['1', '2']);
    if (!Array.isArray(list) || list.length !== 2 || list[1] !== '2') return false;
    const src = Function.prototype.toString.call(m.ensurePrivateChannel);
    return /_getRecipients/.test(src) && /\brecipients\s*:/.test(src) && /CHANNEL_CREATE/.test(src) && !/\bretries\b/.test(src);
  }

  // --------------------------------------------------------------- the modules
  const isStore =
    (...names) =>
    (m) =>
      names.includes(storeName(m));
  const FINDERS = {
    Dispatcher: (m) => typeof m.dispatch === 'function' && typeof m.subscribe === 'function' && !!(m._actionHandlers || m._subscriptions || typeof m.isDispatching === 'function'),
    UserStore: isStore('UserStore'),
    GuildStore: isStore('GuildStore'),
    ChannelStore: isStore('ChannelStore'),
    // Messages of the channels the client has loaded: whether one was pinned before an update says so.
    MessageStore: isStore('MessageStore'),
    GuildChannelStore: isStore('GuildChannelStore'),
    ReadStateStore: isStore('ReadStateStore'),
    RelationshipStore: isStore('RelationshipStore'),
    UserGuildSettingsStore: isStore('UserGuildSettingsStore'),
    GuildMemberStore: isStore('GuildMemberStore'),
    // Newer builds keep roles here rather than on the guild record; older ones have neither store.
    GuildRoleStore: isStore('GuildRoleStore'),
    GuildMemberCountStore: isStore('GuildMemberCountStore'),
    ThreadStore: isStore('ThreadsStore', 'ThreadStore', 'ActiveThreadsStore'),
    EmojiStore: isStore('EmojiStore'),
    PermissionStore: isStore('PermissionStore'),
    // Your server folders and the order of your server list, as the client keeps them (guildFolders).
    UserSettingsProtoStore: isStore('UserSettingsProtoStore'),
    SortedGuildStore: isStore('SortedGuildStore'),
    // The client's own answer to "can I use this emoji here", Nitro and permissions included.
    EmojiRules: (m) => typeof m.getEmojiUnavailableReason === 'function',
    // The client's own in-memory log, which records every failed request with its response body.
    ClientLog: (m) => {
      const v = Object.values(m);
      return v.length <= 4 && v.some(isLogReader);
    },
    // REST client: an object exposing the http verbs.
    Rest: (m) => ['get', 'post', 'put', 'patch', 'del'].every((k) => typeof m[k] === 'function'),
    // Message actions: sendMessage / editMessage / fetchMessages.
    MessageActions: (m) => typeof m.sendMessage === 'function' && typeof m.editMessage === 'function',
    // Opening DMs: the module the client's own "Message" button uses.
    PrivateChannelActions: (m) => typeof m.openPrivateChannel === 'function',
    // Making a group DM: the same module's ensurePrivateChannel with the friends picked (see createGroupDM). Taken only
    // when it has the shape createGroupDM relies on (isGroupMaker), so createGroup is never offered on a guess.
    GroupDMCreate: (m) => typeof m.openPrivateChannel === 'function' && isGroupMaker(m),
    // Typing: what the client's own composer calls on a keystroke (it sends and throttles POST /typing itself).
    TypingActions: (m) => typeof m.startTyping === 'function' && typeof m.stopTyping === 'function',
    // Calls: what the client's own voice channel buttons call, and the stores its call panel reads.
    VoiceActions: (m) => typeof m.selectVoiceChannel === 'function' && typeof m.disconnect === 'function',
    AudioActions: (m) => typeof m.toggleSelfMute === 'function' && typeof m.toggleSelfDeaf === 'function',
    VoiceStateStore: isStore('VoiceStateStore'),
    SpeakingStore: isStore('SpeakingStore'),
    MediaEngineStore: isStore('MediaEngineStore'),
    SelectedChannelStore: isStore('SelectedChannelStore'),
    AuthenticationStore: isStore('AuthenticationStore'),
    // Profiles: the store the client's profile reads, the fetch a click on someone runs (and, under it, the fetch
    // itself, from a module that also accepts the terms of service: only the fetch is ever taken from it), the
    // connected-account table, and presences for the custom status.
    UserProfileStore: isStore('UserProfileStore'),
    PresenceStore: isStore('PresenceStore'),
    ProfileOpen: (m) => !!exportedFn(m, 2, isProfileOpen),
    ProfileFetch: (m) => !!exportedFn(m, 12, isProfileFetch),
    Platforms: (m) => typeof m.get === 'function' && typeof m.getByUrl === 'function' && typeof m.isSupported === 'function',
    // Picture URLs: the client's own choice of the default icon for a group without one.
    IconUtils: (m) => typeof m.getChannelIconURL === 'function' && typeof m.getGuildIconURL === 'function',
    // Adding (docs/add.md): what the client's Join a Server dialog and invite embeds call to look up and accept an
    // invite, the store that keeps what it looked up, and what its Add Friend form and friends list call.
    InviteActions: (m) => typeof m.resolveInvite === 'function' && typeof m.acceptInvite === 'function',
    InviteStore: isStore('InviteStore'),
    RelationshipActions: (m) => typeof m.sendRequest === 'function' && typeof m.addRelationship === 'function' && typeof m.removeRelationship === 'function',
    // Member search (walkMembers): what the client's own mention autocomplete and member search call to ask the
    // gateway for members by name (op 8). Without it, the action it dispatches, which the client's gateway store sends.
    MemberActions: (m) => typeof m.requestMembers === 'function' && typeof m.requestMembersById === 'function' && !storeName(m),
  };
  // Nothing works without these; the others only degrade features.
  const CORE = ['Dispatcher', 'UserStore', 'ChannelStore', 'GuildStore'];
  const mod = {};

  /** One pass over every module, filling in whatever `mod` still lacks. */
  function resolveModules() {
    const missing = Object.keys(FINDERS).filter((k) => !mod[k]);
    if (missing.length) {
      for (const m of candidates()) {
        for (let i = missing.length - 1; i >= 0; i--) {
          let hit = false;
          try {
            hit = FINDERS[missing[i]](m);
          } catch (e) {
            /* some getters throw */
          }
          if (hit) mod[missing.splice(i, 1)[0]] = m;
        }
        if (!missing.length) break;
      }
    }
    const results = {};
    for (const k of Object.keys(FINDERS)) results[k] = !!mod[k];
    return results;
  }

  // The stores exist only once the app's own modules have run, so keep looking
  // until the core ones resolve. Success is reported at once, failure only after
  // a grace period (the adapter turns it into a "client changed" card).
  const startedAt = Date.now();
  let coreReady = false;
  let lastReport = '';
  function report(results) {
    const key = JSON.stringify(results);
    if (key === lastReport) return;
    lastReport = key;
    up({ t: 'finders', results, detail: `runtimes=${requires.size} modules=${moduleCount()}` });
  }
  function resolveTick() {
    const results = resolveModules();
    const age = Date.now() - startedAt;
    if (CORE.every((k) => results[k])) {
      report(results);
      if (!coreReady) {
        coreReady = true;
        subscribeDispatch();
      }
      // Optional modules can arrive with later chunks; stop looking after a while.
      if (!Object.values(results).every(Boolean) && age < 5 * 60_000) setTimeout(resolveTick, 5000);
      return;
    }
    if (age > 90_000) report(results);
    setTimeout(resolveTick, age > 120_000 ? 10_000 : 1000);
  }
  function currentUser() {
    try {
      return mod.UserStore && mod.UserStore.getCurrentUser();
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------- whitelisting
  const pickUser = (u) => u && { id: u.id, username: u.username, global_name: u.globalName ?? u.global_name ?? null, discriminator: u.discriminator, avatar: u.avatar, bot: !!u.bot };
  const pickChannel = (c) =>
    c && {
      id: c.id,
      type: c.type,
      guild_id: c.guild_id ?? c.guildId ?? null,
      name: c.name ?? null,
      topic: c.topic ?? null,
      position: c.position,
      parent_id: c.parent_id ?? c.parentId ?? null,
      recipients: Array.isArray(c.recipients) ? c.recipients.map((r) => (typeof r === 'string' ? resolveUser(r) : pickUser(r))).filter(Boolean) : undefined,
      owner_id: c.ownerId ?? c.owner_id ?? null,
      icon: c.icon ?? null,
      default_icon: defaultGroupIcon(c),
      thread_metadata: c.threadMetadata ? { archived: !!c.threadMetadata.archived, locked: !!c.threadMetadata.locked } : c.thread_metadata,
      last_message_id: c.lastMessageId ?? c.last_message_id ?? null,
    };
  /** A group DM without a picture: the default one the client draws for it, as an absolute URL. */
  function defaultGroupIcon(c) {
    if (c.type !== 3 || c.icon || !mod.IconUtils) return undefined;
    try {
      const app = typeof c.getApplicationId === 'function' ? c.getApplicationId() : (c.application_id ?? c.applicationId);
      const url = mod.IconUtils.getChannelIconURL({ id: c.id, icon: null, applicationId: app ?? undefined, size: 128 });
      return typeof url === 'string' && url ? new URL(url, location.origin).href : undefined;
    } catch (e) {
      return undefined;
    }
  }
  const pickGuild = (g) => g && { id: g.id, name: g.name, icon: g.icon, description: g.description ?? null, rules_channel_id: g.rulesChannelId ?? g.rules_channel_id ?? null };
  const pickEmoji = (e) => e && { id: e.id ?? null, name: e.name ?? null, animated: !!e.animated };
  const pickAttachment = (a) => a && { id: a.id, filename: a.filename, content_type: a.content_type, size: a.size, width: a.width, height: a.height, url: a.url, proxy_url: a.proxy_url };
  // Discord's own proxy for embed images when there is one: the hub fetches these, and must not hit whatever host a message names.
  const pickEmbedImage = (i) => i && { url: i.proxy_url ?? i.proxyURL ?? i.url };
  const pickEmbed = (e) =>
    e && {
      type: e.type,
      title: e.rawTitle ?? e.title,
      description: e.rawDescription ?? e.description,
      url: e.url,
      provider: e.provider && { name: e.provider.name },
      author: e.author && { name: e.author.name },
      fields: Array.isArray(e.fields) ? e.fields.map((f) => ({ name: f.rawName ?? f.name, value: f.rawValue ?? f.value })) : undefined,
      thumbnail: pickEmbedImage(e.thumbnail),
      image: pickEmbedImage(e.image),
    };
  /** A message's stickers: id, name and format (1 PNG, 2 APNG, 3 Lottie, 4 GIF), which is all it takes to draw one. */
  const pickStickers = (list) =>
    Array.isArray(list) && list.length ? list.map((s) => ({ id: s.id, name: s.name, format_type: s.format_type ?? s.formatType })) : undefined;
  function pickMessage(m) {
    if (!m) return null;
    return {
      id: m.id,
      channel_id: m.channel_id ?? m.channelId,
      guild_id: m.guild_id ?? m.guildId ?? null,
      author: pickUser(m.author),
      content: m.content ?? '',
      timestamp: typeof m.timestamp === 'string' ? m.timestamp : m.timestamp && m.timestamp.toISOString ? m.timestamp.toISOString() : new Date().toISOString(),
      edited_timestamp: m.edited_timestamp ?? (m.editedTimestamp && m.editedTimestamp.toISOString ? m.editedTimestamp.toISOString() : m.editedTimestamp) ?? null,
      type: m.type,
      mention_everyone: !!(m.mention_everyone ?? m.mentionEveryone),
      mentions: Array.isArray(m.mentions) ? m.mentions.map((u) => (typeof u === 'string' ? resolveUser(u) : pickUser(u))).filter(Boolean) : undefined,
      attachments: Array.isArray(m.attachments) ? m.attachments.map(pickAttachment) : undefined,
      embeds: Array.isArray(m.embeds) ? m.embeds.map(pickEmbed) : undefined,
      reactions: Array.isArray(m.reactions)
        ? m.reactions.map((r) => ({ emoji: pickEmoji(r.emoji), count: r.count, count_details: r.count_details, burst_count: r.burst_count, me: !!r.me, me_burst: !!r.me_burst, burst_colors: r.burst_colors }))
        : undefined,
      message_reference: m.message_reference ?? (m.messageReference ? { message_id: m.messageReference.messageId ?? m.messageReference.message_id, channel_id: m.messageReference.channelId ?? m.messageReference.channel_id, guild_id: m.messageReference.guildId ?? m.messageReference.guild_id, type: m.messageReference.type } : undefined),
      thread: m.thread ? pickChannel(m.thread) : undefined,
      message_snapshots: pickSnapshots(m.message_snapshots ?? m.messageSnapshots),
      sticker_items: pickStickers(m.sticker_items ?? m.stickerItems),
      poll: m.poll && m.poll.question ? { question: m.poll.question.text, answers: (m.poll.answers ?? []).map((a) => a.poll_media && a.poll_media.text).filter(Boolean) } : undefined,
      pinned: typeof m.pinned === 'boolean' ? m.pinned : undefined,
      member: pickMessageMember(m),
    };
  }
  /** The author's member object the gateway sent with a guild message, as it came: never looked up. */
  function pickMessageMember(m) {
    const mm = m.member;
    const guildId = m.guild_id ?? m.guildId;
    if (!mm || typeof mm !== 'object' || !guildId) return undefined;
    return { nick: typeof mm.nick === 'string' && mm.nick ? mm.nick : null, roles: roleNames(guildId, mm.roles), joined_at: isoOf(mm.joined_at ?? mm.joinedAt) };
  }
  /** Role ids to names from the client's role store, @everyone (the server's own id) left out. undefined: no names known. */
  function roleNames(guildId, ids) {
    if (!Array.isArray(ids)) return undefined;
    const g = guildOf(guildId);
    const byId = new Map((g ? guildRoles(g) : []).map((r) => [r.id, r.name]));
    if (!byId.size) return undefined;
    return ids.filter((id) => typeof id === 'string' && id !== guildId && byId.has(id)).map((id) => byId.get(id));
  }
  /**
   * Members the client received without our asking (a chunk it asked for itself, the member list in view), passed
   * on as they came, at most 500. null: none in it, and no counts.
   */
  function seenMemberList(guildId, members, total, online) {
    if (!guildId) return null;
    const out = [];
    for (const m of Array.isArray(members) ? members : []) {
      if (out.length >= 500) break;
      const user = m && m.user && pickUser(m.user);
      if (!user || !user.id) continue;
      out.push({ user, nick: typeof m.nick === 'string' && m.nick ? m.nick : null, roles: roleNames(guildId, m.roles), joined_at: isoOf(m.joined_at ?? m.joinedAt) });
    }
    const n = (x) => (typeof x === 'number' ? x : null);
    if (!out.length && n(total) === null && n(online) === null) return null;
    return { guildId, members: out, memberCount: n(total), onlineCount: n(online) };
  }
  // A forward's content. Records in the client's stores use camelCase and Date timestamps.
  function pickSnapshots(list) {
    if (!Array.isArray(list)) return undefined;
    return list
      .map((s) => {
        const x = s && s.message;
        if (!x) return null;
        const ts = x.timestamp && x.timestamp.toISOString ? x.timestamp.toISOString() : typeof x.timestamp === 'string' ? x.timestamp : undefined;
        return { content: x.content ?? '', timestamp: ts, attachments: (x.attachments ?? []).map(pickAttachment), embeds: (x.embeds ?? []).map(pickEmbed) };
      })
      .filter(Boolean);
  }
  function nickOf(guildId, userId) {
    try {
      return (guildId && mod.GuildMemberStore && mod.GuildMemberStore.getNick(guildId, userId)) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * You are typing, or stopped: the client's own typing action, as its composer calls it on a keystroke, so the request,
   * its throttle and its local state are the client's. Without that module, the action it dispatches.
   */
  function typing(channelId, stop) {
    const t = mod.TypingActions;
    if (t) {
      if (stop) t.stopTyping(channelId);
      else t.startTyping(channelId);
      return { ok: true, via: 'actions' };
    }
    mod.Dispatcher.dispatch({ type: stop ? 'TYPING_STOP_LOCAL' : 'TYPING_START_LOCAL', channelId });
    return { ok: true, via: 'dispatch' };
  }

  function resolveUser(id) {
    try {
      return pickUser(mod.UserStore.getUser(id));
    } catch (e) {
      return { id };
    }
  }

  // ---------------------------------------------------------------- snapshot
  let snapshotSent = false;
  function buildSnapshot(reason) {
    const data = {};
    const users = new Map();
    const addUser = (u) => {
      if (u && u.id && !users.has(u.id)) users.set(u.id, u);
    };
    try {
      const me = mod.UserStore && mod.UserStore.getCurrentUser();
      if (me) data.self = pickUser(me);
    } catch (e) {}
    try {
      const guilds = mod.GuildStore ? mod.GuildStore.getGuilds() : {};
      data.guilds = Object.values(guilds).map(pickGuild).filter(Boolean);
      const channels = [];
      for (const gid of Object.keys(guilds)) {
        const list = guildChannels(gid);
        for (const c of list) channels.push(c);
      }
      data.channels = channels;
    } catch (e) {
      log('warn', 'guild/channel snapshot failed', String(e));
    }
    try {
      data.threads = activeThreads();
    } catch (e) {}
    try {
      const priv = mod.ChannelStore && (mod.ChannelStore.getMutablePrivateChannels ? mod.ChannelStore.getMutablePrivateChannels() : null);
      const list = priv ? Object.values(priv) : getSortedPrivate();
      data.privateChannels = list.map(pickChannel).filter(Boolean);
      for (const c of list) if (Array.isArray(c.recipients)) for (const r of c.recipients) addUser(typeof r === 'string' ? resolveUser(r) : pickUser(r));
    } catch (e) {
      log('warn', 'private channel snapshot failed', String(e));
    }
    try {
      // getRelationships() is gone from current clients; relationshipTypes() reads whichever shape this build has.
      if (mod.RelationshipStore) {
        const records = relationshipRecords();
        // With the user records, so a request or a friend has a name even when nothing else in the snapshot names them.
        data.relationships = relationshipList(records, true);
        for (const id of records.keys()) addUser(resolveUser(id));
        // The whole list once the gateway's READY is in: at CONNECTION_OPEN, or when the store already has any.
        // Before that an empty list would only mean "not yet", and says nothing.
        data.requestsKnown = reason === 'CONNECTION_OPEN' || records.size > 0;
      }
    } catch (e) {}
    try {
      data.readStates = readStates();
    } catch (e) {}
    try {
      data.guildSettings = guildSettings();
    } catch (e) {}
    try {
      data.customStatuses = friendStatuses();
    } catch (e) {}
    try {
      data.presences = friendPresences();
    } catch (e) {}
    data.users = Array.from(users.values());
    return data;
  }

  function guildChannels(gid) {
    const out = [];
    const gcs = mod.GuildChannelStore;
    if (gcs && gcs.getChannels) {
      const g = gcs.getChannels(gid);
      if (g) {
        for (const key of Object.keys(g)) {
          const bucket = g[key];
          if (Array.isArray(bucket)) for (const entry of bucket) if (entry && entry.channel) out.push(pickChannel(entry.channel));
        }
      }
    }
    if (!out.length && mod.ChannelStore && mod.ChannelStore.getMutableGuildChannelsForGuild) {
      const map = mod.ChannelStore.getMutableGuildChannelsForGuild(gid) || {};
      for (const c of Object.values(map)) out.push(pickChannel(c));
    }
    return out.filter(Boolean);
  }
  function activeThreads() {
    const out = [];
    const ts = mod.ThreadStore;
    try {
      if (ts && ts.getActiveUnjoinedThreadsForGuild) return out; // handled lazily elsewhere
    } catch (e) {}
    return out;
  }
  function getSortedPrivate() {
    try {
      return mod.ChannelStore.getSortedPrivateChannels ? mod.ChannelStore.getSortedPrivateChannels() : [];
    } catch (e) {
      return [];
    }
  }
  function readStates() {
    const rss = mod.ReadStateStore;
    if (!rss) return [];
    try {
      if (rss.getAllReadStates) {
        const all = rss.getAllReadStates();
        const arr = Array.isArray(all) ? all : Object.values(all || {});
        return arr.map((r) => ({ id: r.channelId ?? r.id, last_message_id: r.lastMessageId ?? r.last_message_id ?? null, mention_count: r.mentionCount ?? r._mentionCount ?? 0 })).filter((r) => r.id);
      }
    } catch (e) {}
    return [];
  }
  function guildSettings() {
    const gs = mod.UserGuildSettingsStore;
    if (!gs) return [];
    try {
      const all = gs.getAllSettings ? gs.getAllSettings() : null;
      if (all) return normalizeGuildSettings(all);
    } catch (e) {}
    return [];
  }
  function normalizeGuildSettings(all) {
    const list = [];
    const src = all.userGuildSettings || all;
    const entries = Array.isArray(src) ? src : Object.values(src || {});
    for (const s of entries) {
      if (!s) continue;
      list.push({
        guild_id: s.guildId ?? s.guild_id ?? null,
        muted: !!s.muted,
        mute_config: s.muteConfig ? { end_time: s.muteConfig.endTime ?? s.muteConfig.end_time ?? null } : null,
        message_notifications: s.messageNotifications ?? s.message_notifications,
        channel_overrides: Array.isArray(s.channelOverrides || s.channel_overrides)
          ? (s.channelOverrides || s.channel_overrides).map((o) => ({ channel_id: o.channelId ?? o.channel_id, muted: !!o.muted, mute_config: o.muteConfig ? { end_time: o.muteConfig.endTime ?? null } : null, message_notifications: o.messageNotifications ?? o.message_notifications }))
          : [],
      });
    }
    return list;
  }

  function maybeSendSnapshot(reason) {
    if (!coreReady) return;
    const data = buildSnapshot(reason);
    snapshotSent = true;
    up({ t: 'snapshot', data });
    log('info', 'snapshot sent (' + reason + ')', { guilds: (data.guilds || []).length, channels: (data.channels || []).length, dms: (data.privateChannels || []).length });
  }

  // ----------------------------------------------------------- dispatch relay
  const FORWARD = [
    'MESSAGE_CREATE',
    'MESSAGE_UPDATE',
    'MESSAGE_DELETE',
    'MESSAGE_REACTION_ADD',
    'MESSAGE_REACTION_REMOVE',
    'MESSAGE_REACTION_REMOVE_ALL',
    'MESSAGE_REACTION_REMOVE_EMOJI',
    'CHANNEL_CREATE',
    'CHANNEL_UPDATES',
    'CHANNEL_DELETE',
    'GUILD_CREATE',
    'GUILD_UPDATE',
    'GUILD_DELETE',
    'THREAD_CREATE',
    'THREAD_UPDATE',
    'THREAD_DELETE',
    'THREAD_LIST_SYNC',
    'MESSAGE_ACK',
    'TYPING_START',
    'CHANNEL_PINS_UPDATE',
    'GUILD_MEMBER_UPDATE',
    'PRESENCE_UPDATE',
    'PRESENCE_UPDATES',
    'CONNECTION_OPEN_SUPPLEMENTAL',
    // Members the client loads on its own; we never ask for them (no gateway op, no request). The live client (2026-11)
    // hands chunks on as GUILD_MEMBERS_CHUNK_BATCH; each of its chunks goes on as a GUILD_MEMBERS_CHUNK.
    'GUILD_MEMBERS_CHUNK',
    'GUILD_MEMBERS_CHUNK_BATCH',
    'GUILD_MEMBER_LIST_UPDATE',
    // Friend requests coming and going (docs/add.md), and the client loading its relationships again.
    'RELATIONSHIP_ADD',
    'RELATIONSHIP_UPDATE',
    'RELATIONSHIP_REMOVE',
    'LOAD_RELATIONSHIPS_SUCCESS',
    // The client learning whether someone who asked is a stranger (it then wants an accept confirmed).
    'UPDATE_STRANGER_STATUS',
    // Someone added to a group DM or gone from it (here, or by anyone in it).
    'CHANNEL_RECIPIENT_ADD',
    'CHANNEL_RECIPIENT_REMOVE',
  ];
  function subscribeDispatch() {
    const d = mod.Dispatcher;
    if (!d) return;
    installPeek();
    const handler = (event) => (action) => {
      try {
        if (event === 'GUILD_MEMBERS_CHUNK_BATCH') {
          for (const c of Array.isArray(action && action.chunks) ? action.chunks : []) {
            const data = shrink('GUILD_MEMBERS_CHUNK', c);
            if (data !== null) up({ t: 'dispatch', event: 'GUILD_MEMBERS_CHUNK', data });
          }
          return;
        }
        // null: nothing in it worth sending (a presence of someone not followed, roles that did not change).
        const data = shrink(event, action);
        if (data !== null) up({ t: 'dispatch', event, data });
      } catch (e) {
        /* ignore */
      }
    };
    for (const ev of FORWARD) {
      try {
        d.subscribe(ev, handler(ev));
      } catch (e) {
        log('warn', 'subscribe failed for ' + ev, String(e));
      }
    }
    try {
      d.subscribe('CONNECTION_OPEN', () => maybeSendSnapshot('CONNECTION_OPEN'));
    } catch (e) {}
    log('info', 'subscribed to ' + FORWARD.length + ' dispatch events');
  }

  // ------------------------------------------------------- before an update
  // A subscriber hears an action once the stores have taken it in, so what it replaced is gone by then. The
  // dispatcher runs interceptors first: this one notes the little a change is told from, and never stops an action.
  const before = new WeakMap();
  const PEEK = {
    GUILD_MEMBER_UPDATE: (a) => {
      const gm = mod.GuildMemberStore;
      const guildId = a.guildId ?? a.guild_id;
      if (!gm || !guildId || !a.user) return {};
      const m = gm.getMember(guildId, a.user.id);
      // null: the client had not loaded them, and what changed is not knowable.
      return { roles: m && Array.isArray(m.roles) ? m.roles.slice() : null };
    },
    MESSAGE_UPDATE: (a) => {
      const msg = a.message;
      const m = msg && mod.MessageStore ? mod.MessageStore.getMessage(msg.channel_id ?? msg.channelId, msg.id) : null;
      return { pinned: m && typeof m.pinned === 'boolean' ? m.pinned : undefined };
    },
  };
  let peeking = false;
  function installPeek() {
    const d = mod.Dispatcher;
    if (peeking || !d || typeof d.addInterceptor !== 'function') return;
    d.addInterceptor((action) => {
      try {
        const peek = action && PEEK[action.type];
        if (peek) before.set(action, peek(action));
      } catch (e) {
        /* a store that throws leaves it unknown */
      }
      return false;
    });
    peeking = true;
  }

  const sameIds = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  /** A role change as the adapter needs it: the roles on both sides, with names. null when nothing changed. */
  function memberUpdate(a) {
    const guildId = a.guildId ?? a.guild_id;
    const roles = Array.isArray(a.roles) ? a.roles.filter((r) => typeof r === 'string') : null;
    if (!guildId || !a.user || !a.user.id || !roles) return null;
    const peek = before.get(a);
    const was = peek ? peek.roles : undefined;
    // Not loaded before, or a nickname or avatar change: no role changed that is knowable.
    if (was === null || (was && sameIds(was, roles))) return null;
    const ids = new Set([...roles, ...(was || [])]);
    const g = guildOf(guildId);
    const named = g ? guildRoles(g).filter((r) => ids.has(r.id)).map((r) => ({ id: r.id, name: r.name, color: r.color })) : [];
    return { guildId, user: pickUser(a.user), roles, ...(was ? { before: was } : {}), named };
  }

  // ---------------------------------------------------------- custom statuses
  // Only of friends and people with a DM open, never every member of a big server; and only when it changed, so a
  // song or game moving on sends nothing. Offline, Discord shows no status at all, which is not having none.
  const lastStatus = new Map();
  const statusKey = (s) => JSON.stringify([s.text, s.emoji && s.emoji.id, s.emoji && s.emoji.name]);

  function customOf(acts) {
    const a = Array.isArray(acts) ? acts.find((x) => x && x.type === CUSTOM_STATUS) : null;
    if (!a || (!a.state && !a.emoji)) return null;
    return { text: textOf(a.state), emoji: a.emoji ? pickEmoji(a.emoji) : null };
  }
  const isAway = (status) => !status || status === 'offline' || status === 'invisible';
  const statusOf = (status, acts) => (isAway(status) ? null : customOf(acts) || { text: null, emoji: null });

  /** Who is followed: one lookup each, as presences in a big server come many at a time. */
  function followedTest() {
    const rs = mod.RelationshipStore;
    const me = currentUser();
    let types = null;
    return (id) => {
      if (!id || (me && me.id === id)) return false;
      try {
        if (rs && typeof rs.getRelationshipType === 'function') {
          if (rs.getRelationshipType(id) === FRIEND) return true;
        } else if (rs && (types || (types = relationshipTypes())).get(id) === FRIEND) return true;
      } catch (e) {}
      try {
        return !!(mod.ChannelStore.getDMFromUserId && mod.ChannelStore.getDMFromUserId(id));
      } catch (e) {
        return false;
      }
    };
  }

  // ---------------------------------------------------------- presence
  // Online, idle, do not disturb or offline, and on which devices: of the same people, only when it changed.
  // Invisible shows as offline, as it does to everyone else.
  const lastPresence = new Map();
  const DEVICES = ['desktop', 'mobile', 'web'];
  function presenceOf(status, clientStatus) {
    if (typeof status !== 'string') return null;
    const state = status === 'online' || status === 'idle' || status === 'dnd' ? status : 'offline';
    const cs = clientStatus && typeof clientStatus === 'object' ? clientStatus : {};
    return { state, devices: state === 'offline' ? [] : DEVICES.filter((d) => typeof cs[d] === 'string' && cs[d] !== 'offline') };
  }
  const presenceKey = (p) => `${p.state}:${p.devices.join(',')}`;
  function clientStatusOf(ps, id) {
    try {
      if (typeof ps.getClientStatus === 'function') return ps.getClientStatus(id);
      const s = typeof ps.getState === 'function' ? ps.getState() : null;
      return s && s.clientStatuses ? s.clientStatuses[id] : null;
    } catch (e) {
      return null;
    }
  }

  function presenceStatuses(a) {
    const followed = followedTest();
    const statuses = [];
    const presences = [];
    for (const u of Array.isArray(a.updates) ? a.updates : [a]) {
      const id = u && u.user && u.user.id;
      if (!followed(id)) continue;
      const s = statusOf(u.status, u.activities);
      if (s && lastStatus.get(id) !== statusKey(s)) {
        lastStatus.set(id, statusKey(s));
        statuses.push({ user: resolveUser(id) || { id }, ...s });
      }
      const p = presenceOf(u.status, u.clientStatus || u.client_status);
      if (p && lastPresence.get(id) !== presenceKey(p)) {
        lastPresence.set(id, presenceKey(p));
        presences.push({ user: resolveUser(id) || { id }, ...p });
      }
    }
    if (!statuses.length && !presences.length) return null;
    return { ...(statuses.length ? { statuses } : {}), ...(presences.length ? { presences } : {}) };
  }

  /** Every friend's presence as it is now, offline ones too (the adapter keeps only the ones that changed). */
  function friendPresences() {
    const ps = mod.PresenceStore;
    if (!ps || !mod.RelationshipStore) return [];
    const out = [];
    for (const user of friendList()) {
      let p = null;
      try {
        p = presenceOf(ps.getStatus(user.id), clientStatusOf(ps, user.id));
      } catch (e) {}
      if (!p) continue;
      lastPresence.set(user.id, presenceKey(p));
      out.push({ user, ...p });
    }
    return out;
  }

  /** Every online friend's custom status as it is now (the adapter keeps only the ones that changed). */
  function friendStatuses() {
    const ps = mod.PresenceStore;
    if (!ps || !mod.RelationshipStore) return [];
    const out = [];
    for (const user of friendList()) {
      let s = null;
      try {
        s = statusOf(ps.getStatus(user.id), ps.getActivities(user.id));
      } catch (e) {}
      if (!s) continue;
      lastStatus.set(user.id, statusKey(s));
      out.push({ user, ...s });
    }
    return out;
  }

  // Keep only the whitelisted shape of each forwarded action.
  function shrink(event, a) {
    switch (event) {
      case 'MESSAGE_CREATE':
        return { message: pickMessage(a.message), optimistic: a.optimistic, channelId: a.channelId };
      case 'MESSAGE_UPDATE': {
        const peek = before.get(a);
        return { message: pickMessage(a.message), optimistic: a.optimistic, channelId: a.channelId, ...(peek && peek.pinned !== undefined ? { wasPinned: peek.pinned } : {}) };
      }
      case 'CHANNEL_PINS_UPDATE':
        return { channelId: a.channelId ?? a.channel_id, lastPinTimestamp: isoOf(a.lastPinTimestamp ?? a.last_pin_timestamp) };
      case 'GUILD_MEMBER_UPDATE':
        return memberUpdate(a);
      case 'GUILD_MEMBERS_CHUNK':
        // A walk's chunk is the walk's to tell (walkMembers), not the passive path's: one it took, or (whichever
        // subscriber hears it first) one for a server a walk waits on that answers no by-id request (no nonce).
        if (walkTook.has(a) || (walking.has(String(a.guildId ?? a.guild_id)) && !a.nonce)) return null;
        return seenMemberList(a.guildId ?? a.guild_id, a.members);
      case 'GUILD_MEMBER_LIST_UPDATE': {
        // The member list in view, as the gateway sent it to the client: its members and the list's counts.
        const items = [];
        for (const op of Array.isArray(a.ops) ? a.ops : []) {
          if (op && Array.isArray(op.items)) items.push(...op.items);
          if (op && op.item) items.push(op.item);
        }
        return seenMemberList(a.guildId ?? a.guild_id, items.map((i) => i && i.member).filter(Boolean), a.memberCount ?? a.member_count, a.onlineCount ?? a.online_count);
      }
      case 'PRESENCE_UPDATE':
      case 'PRESENCE_UPDATES':
        return presenceStatuses(a);
      case 'CONNECTION_OPEN_SUPPLEMENTAL': {
        // Friends' presences come with this, not with CONNECTION_OPEN: the starting point the snapshot may have lacked.
        const statuses = friendStatuses();
        const presences = friendPresences();
        if (!statuses.length && !presences.length) return null;
        return { ...(statuses.length ? { statuses } : {}), ...(presences.length ? { presences } : {}) };
      }
      case 'MESSAGE_DELETE':
        return { id: a.id, channelId: a.channelId, guildId: a.guildId };
      case 'MESSAGE_REACTION_ADD':
      case 'MESSAGE_REACTION_REMOVE':
        return { channelId: a.channelId, messageId: a.messageId, userId: a.userId, user: resolveUser(a.userId), emoji: pickEmoji(a.emoji), optimistic: !!a.optimistic, colors: a.colors, reactionType: a.reactionType };
      case 'MESSAGE_REACTION_REMOVE_ALL':
      case 'MESSAGE_REACTION_REMOVE_EMOJI':
        return { channelId: a.channelId, messageId: a.messageId, emoji: pickEmoji(a.emoji) };
      case 'CHANNEL_UPDATES':
        return { channels: Array.isArray(a.channels) ? a.channels.map(pickChannel) : [] };
      case 'CHANNEL_CREATE':
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE':
        return { channel: pickChannel(a.channel) };
      case 'CHANNEL_DELETE':
      case 'THREAD_DELETE':
        return { channel: pickChannel(a.channel) || { id: a.id, guild_id: a.guildId } };
      case 'GUILD_CREATE':
        // Its channels as the client now has them: a server joined just now has no other way to say them.
        return { guild: pickGuild(a.guild), channels: a.guild && a.guild.id ? guildChannels(a.guild.id) : [] };
      case 'GUILD_UPDATE':
        return { guild: pickGuild(a.guild) };
      case 'GUILD_DELETE':
        return { id: a.guild ? a.guild.id : a.id };
      case 'THREAD_LIST_SYNC':
        return { guildId: a.guildId, threads: Array.isArray(a.threads) ? a.threads.map(pickChannel) : [] };
      case 'MESSAGE_ACK':
        return { channelId: a.channelId, messageId: a.messageId, mentionCount: a.mentionCount };
      case 'TYPING_START':
        return { channelId: a.channelId, userId: a.userId, user: resolveUser(a.userId), nick: nickOf(a.guildId, a.userId) };
      case 'RELATIONSHIP_ADD':
      case 'RELATIONSHIP_UPDATE':
      case 'RELATIONSHIP_REMOVE':
        return relationshipChange(event, a);
      case 'LOAD_RELATIONSHIPS_SUCCESS':
        return mod.RelationshipStore ? { relationships: relationshipList(relationshipRecords(), true) } : null;
      case 'UPDATE_STRANGER_STATUS':
        return strangerStatus(a);
      case 'CHANNEL_RECIPIENT_ADD':
      case 'CHANNEL_RECIPIENT_REMOVE': {
        // Who, and the group as the store now has it (a subscriber hears an action once the stores took it in).
        const channelId = a.channelId ?? a.channel_id;
        const userId = (a.user && a.user.id) ?? a.userId ?? a.user_id;
        if (!channelId || !userId) return null;
        return { channelId: String(channelId), user: pickUser(a.user) || resolveUser(String(userId)) || { id: String(userId) }, channel: pickChannel(mod.ChannelStore.getChannel(channelId)) || null };
      }
      default:
        return {};
    }
  }

  // --------------------------------------------------------------- commands
  /** Set only in lab sandboxes (src/lab/lab.js, appended at the marker below). */
  let labCommand = null;
  async function runCommand(cmd) {
    if (!coreReady) throw new Error('the Discord client has not finished loading');
    switch (cmd.kind) {
      case 'send':
        return sendMessage(cmd);
      case 'forward':
        return forwardMessage(cmd);
      case 'openDirect':
        return openDirect(cmd.userId);
      case 'history':
        return history(cmd);
      case 'search':
        return search(cmd);
      case 'walkMembers':
        return walkMembers(cmd);
      case 'threads':
        return threads(cmd);
      case 'markRead':
        return rest('post', `/channels/${cmd.channelId}/messages/${cmd.messageId}/ack`, undefined, { token: null });
      case 'typing':
        return typing(cmd.channelId, !!cmd.stop);
      case 'react': {
        const url = `/channels/${cmd.channelId}/messages/${cmd.messageId}/reactions/${encodeURIComponent(cmd.emoji)}`;
        const type = cmd.burst ? 1 : 0;
        if (cmd.remove) await rest('del', `${url}/${type}/@me`, { location: 'Message', burst: !!cmd.burst });
        else await rest('put', `${url}/@me`, { location: 'Message', type });
        return { ok: true };
      }
      case 'reactors': {
        const url = `/channels/${cmd.channelId}/messages/${cmd.messageId}/reactions/${encodeURIComponent(cmd.emoji)}`;
        const res = await rest('get', url, { limit: 100, type: cmd.burst ? 1 : 0 });
        return { users: ((res && res.body) || []).map(pickUser).filter(Boolean) };
      }
      case 'reactionContext':
        return reactionContext(cmd.channelId);
      case 'guildFolders':
        return guildFolders();
      case 'about':
        return about(cmd);
      case 'configure':
        return configure(cmd);
      case 'profile':
        return profile(cmd);
      case 'setProfile':
        return setProfile(cmd);
      case 'refreshUrls': {
        // What the client sends when it shows an attachment whose link has run out.
        const res = await rest('post', '/attachments/refresh-urls', undefined, { attachment_urls: cmd.urls });
        const list = (res && res.body && res.body.refreshed_urls) || [];
        return { refreshed: list.map((x) => ({ original: x.original, refreshed: x.refreshed })) };
      }
      case 'edit':
        if (mod.MessageActions && mod.MessageActions.editMessage) return mod.MessageActions.editMessage(cmd.channelId, cmd.messageId, { content: cmd.content }), { ok: true };
        return rest('patch', `/channels/${cmd.channelId}/messages/${cmd.messageId}`, undefined, { content: cmd.content });
      case 'call':
        return callCommand(cmd);
      case 'lab':
        if (!labCommand) throw new Error('not a lab sandbox');
        return labCommand(cmd);
      case 'redact':
        if (mod.MessageActions && mod.MessageActions.deleteMessage) return mod.MessageActions.deleteMessage(cmd.channelId, cmd.messageId), { ok: true };
        return rest('del', `/channels/${cmd.channelId}/messages/${cmd.messageId}`);
      case 'inviteResolve': {
        const code = inviteCodeOf(cmd.code);
        return pickInvite(await lookUpInvite(code), code);
      }
      case 'inviteAccept':
        return inviteAccept(cmd);
      case 'person':
        return person(cmd);
      case 'friendAdd':
        return friendAdd(cmd);
      case 'friendAnswer':
        return friendAnswer(cmd);
      case 'friendRemove':
        return friendRemove(cmd);
      case 'addRecipients':
        return addRecipients(cmd);
      case 'createGroupDM':
        return createGroupDM(cmd);
      default:
        throw new Error('unknown command ' + cmd.kind);
    }
  }


  // ------------------------------------------------------------------ calls
  // Bridge mode: the client joins the call itself, exactly as its own button would, and handles
  // the call's media and encryption. Its remote audio is mixed and sent to the device over a
  // second peer connection, and the device's microphone comes back over it and is what the
  // client gets from getUserMedia. Patches exist only while a bridge call does.
  const call = { id: null, mode: null, channelId: null, pc: null, ctx: null, mix: null, mic: null, mixMeter: null, micMeter: null, micSrc: null, unpatch: null, unsub: null, timer: null, joinedAt: 0 };
  const ourPCs = new WeakSet();
  const tapped = new WeakSet();

  function callUp(extra) {
    up({ t: 'call', call: call.id, ...extra });
  }

  async function callCommand(cmd) {
    if (cmd.op === 'join') return callJoin(cmd);
    if (cmd.call !== call.id) return { stale: true };
    if (cmd.op === 'leave') return callLeave(false);
    if (cmd.op === 'mute') return callMute(cmd.muted, cmd.deafened);
    if (cmd.op === 'signal') return bridgeSignal(cmd.data);
    return { ok: true };
  }

  async function callJoin(cmd) {
    if (call.id) await callLeave(false);
    if (!mod.VoiceActions) throw new Error('the client has no voice module (Discord changed?)');
    const channel = mod.ChannelStore.getChannel(cmd.channelId);
    if (!channel) throw new Error('unknown channel');
    if (cmd.mode === 'direct') return directJoin(cmd, channel);
    if (cmd.mode !== 'bridge') throw new Error('unknown call mode');
    Object.assign(call, { id: cmd.call, mode: cmd.mode, channelId: cmd.channelId, joinedAt: Date.now() });
    // The audio graph runs only to feed the bridge; nothing plays in the sandbox.
    call.ctx = new AudioContext({ latencyHint: 'interactive' });
    call.mix = call.ctx.createMediaStreamDestination();
    call.mic = call.ctx.createMediaStreamDestination();
    call.mixMeter = call.ctx.createAnalyser();
    call.micMeter = call.ctx.createAnalyser();
    call.unpatch = patchMedia();
    call.unsub = watchCall();
    mod.VoiceActions.selectVoiceChannel(cmd.channelId);
    if (cmd.muted || cmd.deafened) setTimeout(() => callMute(!!cmd.muted, !!cmd.deafened), 500);
    return {};
  }

  async function callLeave(fromClient) {
    if (!call.id) return { ok: true };
    const id = call.id;
    const wasDirect = call.mode === 'direct';
    try {
      if (!fromClient && mod.SelectedChannelStore && mod.SelectedChannelStore.getVoiceChannelId() === call.channelId) mod.VoiceActions.disconnect();
    } catch (e) {
      log('warn', 'disconnect failed', String(e));
    }
    try {
      call.pc && call.pc.close();
    } catch (e) {}
    try {
      call.ctx && call.ctx.close();
    } catch (e) {}
    try {
      call.unpatch && call.unpatch();
      call.unsub && call.unsub();
    } catch (e) {}
    clearInterval(call.timer);
    // Any voice server handed out from here on is the page's again.
    if (wasDirect) setTimeout(() => (external.active = false), 3000);
    if (fromClient) up({ t: 'call', call: id, ended: fromClient });
    Object.assign(call, { id: null, mode: null, channelId: null, pc: null, ctx: null, mix: null, mic: null, mixMeter: null, micMeter: null, micSrc: null, unpatch: null, unsub: null, timer: null });
    return { ok: true };
  }

  function callMute(muted, deafened) {
    const me = mod.MediaEngineStore;
    const act = mod.AudioActions;
    if (!me || !act) throw new Error('the client has no audio settings module');
    if (!!me.isSelfDeaf() !== !!deafened) act.toggleSelfDeaf();
    // Undeafening restores the previous mute, so read it again.
    if (!!me.isSelfMute() !== !!muted) act.toggleSelfMute();
    return { ok: true };
  }

  /** Participants from the client's own stores, pushed whenever they change (at most every 150 ms). */
  function watchCall() {
    let queued = false;
    let last = '';
    const push = () => {
      queued = false;
      if (!call.id) return;
      const users = [];
      const participants = [];
      let states = {};
      try {
        states = mod.VoiceStateStore.getVoiceStatesForChannel(call.channelId) || {};
      } catch (e) {}
      for (const v of Object.values(states)) {
        const id = v.userId || v.user_id;
        if (!id) continue;
        let speaking = false;
        try {
          speaking = !!(mod.SpeakingStore && mod.SpeakingStore.isSpeaking(id));
        } catch (e) {}
        participants.push({ id, muted: !!(v.selfMute || v.mute), deafened: !!(v.selfDeaf || v.deaf), speaking, video: !!v.selfVideo });
        users.push(resolveUser(id));
      }
      const key = JSON.stringify(participants);
      if (key === last) return;
      last = key;
      callUp({ state: { channelId: call.channelId, participants }, users: users.filter((u) => u && u.username) });
    };
    const onChange = () => {
      if (!queued) {
        queued = true;
        setTimeout(push, 150);
      }
      // The call ended from the client's side: kicked, moved, or the channel went away.
      try {
        const now = mod.SelectedChannelStore && mod.SelectedChannelStore.getVoiceChannelId();
        if (call.id && Date.now() - call.joinedAt > 5000 && now !== call.channelId) void callLeave(now ? 'moved to another channel' : 'disconnected');
      } catch (e) {}
    };
    const stores = [mod.VoiceStateStore, mod.SpeakingStore, mod.SelectedChannelStore].filter(Boolean);
    for (const st of stores) st.addChangeListener(onChange);
    onChange();
    // What the client's own voice connection is doing, for the adapter log (and comparing the modes).
    call.timer = setInterval(() => void logRtc(), 10_000);
    return () => stores.forEach((st) => st.removeChangeListener(onChange));
  }


  // Direct mode: the device speaks the voice protocol itself. The page joins the channel exactly as
  // its own button would (so the gateway's voice state, mute flags and the participant list stay the
  // client's), but the voice server Discord hands out goes to the device, and the page never sees
  // it: one Dispatcher interceptor swallows VOICE_SERVER_UPDATE, so the page's own connection waits
  // for an endpoint that never comes. The voice token is scoped to this one connection; the account's
  // login token stays here.
  const external = { active: false, channelId: null, guildId: null, waiter: null };
  let interceptor = false;
  function installInterceptor() {
    if (interceptor) return true;
    const d = mod.Dispatcher;
    if (!d || typeof d.addInterceptor !== 'function') return false;
    d.addInterceptor((action) => {
      try {
        if (!external.active || !action || action.type !== 'VOICE_SERVER_UPDATE') return false;
        const ours = external.guildId ? action.guildId === external.guildId : !action.guildId && (!action.channelId || action.channelId === external.channelId);
        if (!ours) return false;
        // A null endpoint means the server is still being allocated; another update follows.
        if (action.endpoint) voiceServer(action.endpoint, action.token);
        return true;
      } catch (e) {
        return false;
      }
    });
    interceptor = true;
    return true;
  }

  function voiceServer(endpoint, token) {
    if (external.waiter) {
      const w = external.waiter;
      external.waiter = null;
      w({ endpoint, token });
    } else if (call.id && call.mode === 'direct') {
      // The voice server moved: the device reconnects to the new one.
      callUp({ signal: { kind: 'voice-server', endpoint, token } });
    }
  }

  async function directJoin(cmd, channel) {
    if (!installInterceptor()) throw new Error('the client has no dispatcher interceptor (Discord changed?)');
    const me = currentUser();
    let sessionId = null;
    try {
      sessionId = mod.AuthenticationStore && mod.AuthenticationStore.getSessionId();
    } catch (e) {}
    if (!me || !sessionId) throw new Error('the client has no gateway session yet');
    const guildId = channel.guild_id || (channel.getGuildId && channel.getGuildId()) || null;
    Object.assign(external, { active: true, channelId: cmd.channelId, guildId });
    Object.assign(call, { id: cmd.call, mode: 'direct', channelId: cmd.channelId, joinedAt: Date.now() });
    call.unsub = watchCall();
    let server;
    try {
      server = await new Promise((resolve, reject) => {
        external.waiter = resolve;
        setTimeout(() => reject(new Error('Discord gave no voice server within 20 s')), 20_000);
        mod.VoiceActions.selectVoiceChannel(cmd.channelId);
      });
    } catch (e) {
      external.waiter = null;
      await callLeave(false);
      throw e;
    }
    if (cmd.muted || cmd.deafened) setTimeout(() => callMute(!!cmd.muted, !!cmd.deafened), 200);
    return { direct: { network: 'discord', endpoint: server.endpoint, token: server.token, serverId: guildId || cmd.channelId, channelId: cmd.channelId, userId: me.id, sessionId } };
  }

  /**
   * While a bridge call runs: the client's microphone is the device's, and its peer connections are tapped for remote
   * audio. The patches go where the natives are (the prototypes), read like them, and come off as they were.
   */
  function patchMedia() {
    const restore = [
      cloak.replace(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', (gum) => ({
        getUserMedia(constraints) {
          if (!call.id || !constraints || !constraints.audio || constraints.video) return cloak.apply(gum, this, arguments);
          log('debug', 'the client asked for the microphone; it gets the device\'s');
          return Promise.resolve(new MediaStream([call.mic.stream.getAudioTracks()[0].clone()]));
        },
      }).getUserMedia),
      // With no sound card the list is empty, and the client then refuses to join with a microphone.
      cloak.replace(Object.getPrototypeOf(navigator.mediaDevices), 'enumerateDevices', (enumerate) => ({
        enumerateDevices() {
          return cloak.apply(promiseThen, cloak.apply(enumerate, this, arguments), [(list) => (list.some((d) => d.kind === 'audioinput') ? list : [...list, standInMic()])]);
        },
      }).enumerateDevices),
      cloak.replace(RTCPeerConnection.prototype, 'setRemoteDescription', (srd) => ({
        setRemoteDescription() {
          if (!ourPCs.has(this)) tapPC(this);
          return cloak.apply(srd, this, arguments);
        },
      }).setRemoteDescription),
    ];
    return () => {
      for (const r of restore) r();
    };
  }

  /**
   * The microphone the client is shown when the browser has none: what enumerateDevices gives for one. It is an
   * InputDeviceInfo to instanceof and Object.prototype.toString, has no own properties, and its fields, toJSON and
   * getCapabilities answer as a real one's do. (Its prototype's getters, called on it directly, still refuse it.)
   */
  function standInMic() {
    const fields = { deviceId: 'default', kind: 'audioinput', label: 'Default', groupId: '__MARKHEX_audioGroup__' };
    const Info = window.InputDeviceInfo || window.MediaDeviceInfo;
    const proto = Info ? Info.prototype : Object.prototype;
    const base = window.MediaDeviceInfo ? window.MediaDeviceInfo.prototype : {};
    const methods = {
      toJSON: cloak.native(() => ({ deviceId: fields.deviceId, kind: fields.kind, label: fields.label, groupId: fields.groupId }), base.toJSON || 'toJSON'),
      getCapabilities: cloak.native(
        () => ({
          autoGainControl: [true, false],
          channelCount: { max: 2, min: 1 },
          deviceId: fields.deviceId,
          echoCancellation: [true, false],
          groupId: fields.groupId,
          latency: { max: 0.01, min: 0.01 },
          noiseSuppression: [true, false],
          sampleRate: { max: 48000, min: 48000 },
          sampleSize: { max: 16, min: 16 },
        }),
        proto.getCapabilities || 'getCapabilities',
      ),
    };
    return new Proxy(Object.create(proto), {
      get(target, key, receiver) {
        if (typeof key === 'string' && cloak.apply(hasOwn, fields, [key])) return fields[key];
        if (typeof key === 'string' && cloak.apply(hasOwn, methods, [key]) && (key !== 'getCapabilities' || typeof proto.getCapabilities === 'function')) return methods[key];
        return Reflect.get(target, key, receiver);
      },
    });
  }

  const discordPCs = new Set();
  function tapPC(pc) {
    if (tapped.has(pc)) return;
    tapped.add(pc);
    discordPCs.add(pc);
    pc.addEventListener('track', (e) => mixIn(e.track));
    for (const r of pc.getReceivers()) if (r.track) mixIn(r.track);
  }

  async function logRtc() {
    const out = [];
    for (const pc of discordPCs) {
      if (pc.connectionState === 'closed') {
        discordPCs.delete(pc);
        continue;
      }
      let sent = 0;
      let received = 0;
      let level = null;
      let rtp = 0;
      try {
        (await pc.getStats()).forEach((r) => {
          if (r.type === 'transport') {
            sent += r.bytesSent || 0;
            received += r.bytesReceived || 0;
          }
          if (r.type === 'media-source' && r.kind === 'audio') level = r.audioLevel;
          if (r.type === 'outbound-rtp' && r.kind === 'audio') rtp += r.bytesSent || 0;
        });
      } catch (e) {}
      let senders = [];
      try {
        senders = pc.getTransceivers().map((t) => ({ dir: t.currentDirection, kind: t.sender.track && t.sender.track.kind, en: t.sender.track && t.sender.track.enabled, rs: t.sender.track && t.sender.track.readyState, act: (t.sender.getParameters().encodings || []).map((e) => e.active), tf: t.sender.transform ? t.sender.transform.constructor.name : null, codecs: (t.sender.getParameters().codecs || []).map((c) => c.mimeType).slice(0, 3) }));
        senders.push({ api: { ces: typeof RTCRtpSender.prototype.createEncodedStreams, rst: typeof window.RTCRtpScriptTransform, cfg: JSON.stringify(pc.getConfiguration()).slice(0, 300) } });
      } catch (e) {}
      out.push({ state: pc.connectionState, sent, received, rtp, level, senders });
    }
    const me = currentUser();
    let self = {};
    try {
      const m = mod.MediaEngineStore;
      self = { mute: m.isSelfMute(), deaf: m.isSelfDeaf(), mode: m.getMode && m.getMode(), speaking: !!(me && mod.SpeakingStore.isSpeaking(me.id)) };
    } catch (e) {}
    log('info', 'call rtc', { self, discord: out, bridge: call.pc ? call.pc.connectionState : null, ctx: call.ctx && call.ctx.state, mic: rms(call.micMeter), mix: rms(call.mixMeter) });
  }

  function rms(an) {
    if (!an) return null;
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.round(Math.sqrt(sum / buf.length) * 1000) / 1000;
  }

  // Chrome only feeds a remote track into Web Audio while a media element also plays it.
  const sinks = new WeakMap();
  function mixIn(track) {
    if (!call.ctx || track.kind !== 'audio' || sinks.has(track)) return;
    const stream = new MediaStream([track]);
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    el.play().catch(() => {});
    const src = call.ctx.createMediaStreamSource(stream);
    src.connect(call.mix);
    src.connect(call.mixMeter);
    sinks.set(track, { el, src });
    track.addEventListener('ended', () => {
      try {
        src.disconnect();
      } catch (e) {}
      el.srcObject = null;
    });
  }

  /** The device offers; the sandbox answers with the mix and takes the device's microphone. */
  async function bridgeSignal(data) {
    if (call.mode !== 'bridge') return { ignored: true };
    if (data && data.sdp && data.type === 'offer') {
      if (call.pc) call.pc.close();
      const pc = new RTCPeerConnection({ iceServers: data.iceServers || [] });
      ourPCs.add(pc);
      call.pc = pc;
      pc.onicecandidate = (e) => callUp({ signal: { candidate: e.candidate ? e.candidate.toJSON() : null } });
      pc.ontrack = (e) => {
        if (e.track.kind !== 'audio') return;
        const stream = new MediaStream([e.track]);
        const el = new Audio();
        el.muted = true;
        el.srcObject = stream;
        el.play().catch(() => {});
        try {
          call.micSrc && call.micSrc.disconnect();
        } catch (err) {}
        call.micSrc = call.ctx.createMediaStreamSource(stream);
        call.micSrc.connect(call.mic);
        call.micSrc.connect(call.micMeter);
      };
      pc.onconnectionstatechange = () => log('info', 'bridge ' + pc.connectionState);
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      const t = pc.getTransceivers().find((x) => x.receiver.track && x.receiver.track.kind === 'audio');
      const mixTrack = call.mix.stream.getAudioTracks()[0];
      if (t) {
        t.direction = 'sendrecv';
        await t.sender.replaceTrack(mixTrack);
      } else pc.addTrack(mixTrack, call.mix.stream);
      await pc.setLocalDescription(await pc.createAnswer());
      callUp({ signal: { type: 'answer', sdp: pc.localDescription.sdp } });
      return { ok: true };
    }
    if (data && 'candidate' in data && call.pc) {
      if (data.candidate) await call.pc.addIceCandidate(data.candidate).catch((e) => log('debug', 'candidate refused', String(e)));
      return { ok: true };
    }
    return { ignored: true };
  }

  // ---------------------------------------------------------------- reacting
  const PERM_ADD_REACTIONS = 1n << 6n;
  const PERM_READ_HISTORY = 1n << 16n;
  const EMOJI_INTENT_REACTION = 0;

  function reactionContext(channelId) {
    const channel = mod.ChannelStore.getChannel(channelId);
    const guildId = (channel && (channel.guild_id ?? channel.getGuildId?.())) || null;
    const can = (bit) => {
      try {
        return !guildId || !mod.PermissionStore || mod.PermissionStore.can(bit, channel);
      } catch (e) {
        return true;
      }
    };
    const canRead = can(PERM_READ_HISTORY);
    const nitro = ((currentUser() && currentUser().premiumType) || 0) > 0;
    return {
      canReact: canRead,
      reason: canRead ? undefined : 'You cannot read message history in this channel, which reacting needs.',
      existingOnly: !can(PERM_ADD_REACTIONS),
      custom: customEmojiGroups(channel, guildId, nitro),
      nitro,
    };
  }

  function customEmojiGroups(channel, guildId, nitro) {
    const store = mod.EmojiStore;
    if (!store) return [];
    const usable = (e) => {
      try {
        if (mod.EmojiRules) return mod.EmojiRules.getEmojiUnavailableReason({ emoji: e, channel, intention: EMOJI_INTENT_REACTION }) == null;
      } catch (err) {
        /* fall through to the plain rule */
      }
      return e.available !== false && (nitro || (e.guildId === guildId && !e.animated));
    };
    const ids = Object.keys(store.getGuilds() || {}).sort((a, b) => (b === guildId) - (a === guildId));
    const groups = [];
    for (const id of ids) {
      const emoji = (store.getGuildEmoji(id) || []).filter(usable).map((e) => ({ id: e.id, name: e.name, animated: !!e.animated }));
      if (!emoji.length) continue;
      const guild = mod.GuildStore.getGuild(id);
      groups.push({ guild: pickGuild(guild) || { id, name: 'Server' }, here: id === guildId, emoji });
    }
    return groups;
  }

  // ------------------------------------------------------- about and settings
  // Read from the client's stores alone, so it costs no request. Permissions fail closed: null when the client
  // cannot say, and the adapter offers nothing it was not told yes to (reactionContext fails open on purpose).
  const PERM = {
    createInvite: 1n << 0n,
    manageChannels: 1n << 4n,
    manageGuild: 1n << 5n,
    sendMessages: 1n << 11n,
    manageMessages: 1n << 13n,
    manageRoles: 1n << 28n,
    manageThreads: 1n << 34n,
    pinMessages: 1n << 51n,
  };
  const MEMBER_CAP = 200;
  const CATEGORY = 4;
  const ANNOUNCEMENT = 5;
  const THREAD_TYPES = [10, 11, 12];

  function canAll(subject) {
    const out = {};
    const ps = mod.PermissionStore;
    for (const k of Object.keys(PERM)) {
      let v = null;
      try {
        if (subject && ps && typeof ps.can === 'function') v = ps.can(PERM[k], subject) === true;
      } catch (e) {
        v = null;
      }
      out[k] = v;
    }
    return out;
  }

  /** Whether the @everyone overwrite (its id is the guild's) denies a permission. Store records keep a map, raw ones a list. */
  function everyoneDenies(c, guildId, bit) {
    const ow = c && (c.permissionOverwrites ?? c.permission_overwrites);
    const list = Array.isArray(ow) ? ow : Object.values(ow || {});
    const o = list.find((x) => x && x.id === guildId);
    if (!o || o.deny == null) return false;
    try {
      return (BigInt(String(o.deny)) & bit) !== 0n;
    } catch (e) {
      return false;
    }
  }

  function pickAboutChannel(c) {
    const base = pickChannel(c);
    const guildId = base.guild_id;
    let nsfw = c.nsfw ?? c.nsfw_;
    if (nsfw === undefined && typeof c.isNSFW === 'function') {
      try {
        nsfw = c.isNSFW();
      } catch (e) {}
    }
    // A thread sends by its parent's overwrites.
    const parent = THREAD_TYPES.includes(c.type) && base.parent_id ? mod.ChannelStore.getChannel(base.parent_id) : null;
    return {
      ...base,
      nsfw: !!nsfw,
      rate_limit_per_user: Number(c.rateLimitPerUser ?? c.rate_limit_per_user ?? 0) || 0,
      everyone_denies_send: !!guildId && (c.type === ANNOUNCEMENT || everyoneDenies(parent || c, guildId, PERM.sendMessages)),
    };
  }
  function pickAboutGuild(g) {
    const ownerId = g.ownerId ?? g.owner_id ?? null;
    const features = g.features;
    const has = (f) => !!features && (typeof features.has === 'function' ? features.has(f) : Array.isArray(features) && features.includes(f));
    return {
      ...pickGuild(g),
      owner_id: ownerId,
      owner: ownerId ? resolveUser(ownerId) || null : null,
      verification_level: g.verificationLevel ?? g.verification_level ?? null,
      nsfw_level: g.nsfwLevel ?? g.nsfw_level ?? null,
      community: has('COMMUNITY'),
    };
  }

  const hexColor = (n) => (typeof n === 'number' && n > 0 ? '#' + n.toString(16).padStart(6, '0') : null);
  const pickRole = (r) => ({ id: r.id, name: r.name, color: r.colorString || hexColor(r.color) || null, position: Number(r.position) || 0, hoist: !!r.hoist });

  function guildRoles(g) {
    let roles = null;
    const rs = mod.GuildRoleStore;
    for (const f of ['getSortedRoles', 'getRoles', 'getRolesSnapshot']) {
      if (roles) break;
      try {
        if (rs && typeof rs[f] === 'function') roles = rs[f](g.id);
      } catch (e) {}
    }
    try {
      if (!roles && typeof mod.GuildStore.getRoles === 'function') roles = mod.GuildStore.getRoles(g.id);
    } catch (e) {}
    if (!roles) roles = g.roles;
    const list = Array.isArray(roles) ? roles : Object.values(roles || {});
    return list.filter((r) => r && r.id && typeof r.name === 'string').map(pickRole);
  }

  /** The members the client has loaded (it loads them lazily), this account first so the cap never drops it. */
  function guildMembers(guildId, selfId) {
    const gm = mod.GuildMemberStore;
    if (!gm) return [];
    let list = [];
    try {
      if (typeof gm.getMembers === 'function') list = gm.getMembers(guildId) || [];
      else if (typeof gm.getMemberIds === 'function') list = (gm.getMemberIds(guildId) || []).map((id) => gm.getMember(guildId, id));
    } catch (e) {
      list = [];
    }
    list = Array.isArray(list) ? list : Object.values(list);
    const memberId = (m) => m && (m.userId ?? (m.user && m.user.id));
    const mine = list.find((m) => memberId(m) === selfId);
    const ordered = mine ? [mine, ...list.filter((m) => m !== mine)] : list;
    const out = [];
    for (const m of ordered) {
      if (out.length >= MEMBER_CAP) break;
      const user = resolveUser(memberId(m));
      if (!user || !user.username) continue;
      out.push({ user, roles: Array.isArray(m.roles) ? m.roles.filter((r) => typeof r === 'string') : [], color: m.colorString || null });
    }
    return out;
  }

  function memberCount(g) {
    try {
      const n = mod.GuildMemberCountStore && mod.GuildMemberCountStore.getMemberCount(g.id);
      if (typeof n === 'number') return n;
    } catch (e) {}
    return typeof g.memberCount === 'number' ? g.memberCount : null;
  }

  function aboutGuildParts(out, g, selfId) {
    out.guild = pickAboutGuild(g);
    out.roles = guildRoles(g);
    out.members = guildMembers(g.id, selfId);
    out.memberCount = memberCount(g);
  }

  function about(cmd) {
    const me = currentUser();
    const selfId = (me && me.id) || null;
    const out = { selfId, can: {} };
    if (cmd.target === 'space') {
      const g = mod.GuildStore.getGuild(cmd.id);
      if (g) {
        aboutGuildParts(out, g, selfId);
        out.can = canAll(g);
        return out;
      }
    }
    const c = mod.ChannelStore.getChannel(cmd.id);
    if (!c || (cmd.target === 'space') !== (c.type === CATEGORY)) throw new Error(cmd.target === 'space' ? 'unknown server or category' : 'unknown channel');
    out.channel = pickAboutChannel(c);
    out.can = canAll(c);
    const g = out.channel.guild_id ? mod.GuildStore.getGuild(out.channel.guild_id) : null;
    if (g) {
      aboutGuildParts(out, g, selfId);
      out.guildCan = canAll(g);
    }
    return out;
  }

  // One PATCH through the client's REST module, with only the fields a setting can change.
  const PATCHABLE = { channel: ['name', 'topic', 'rate_limit_per_user', 'nsfw'], guild: ['name'] };
  async function configure(cmd) {
    const which = cmd.guildId ? 'guild' : 'channel';
    const id = cmd.guildId || cmd.channelId;
    if (!/^\d+$/.test(String(id || ''))) throw new Error('which ' + which + '?');
    const body = {};
    for (const k of PATCHABLE[which]) if (cmd.patch && cmd.patch[k] !== undefined) body[k] = cmd.patch[k];
    if (!Object.keys(body).length) throw new Error('nothing to change');
    const res = await rest('patch', which === 'guild' ? `/guilds/${id}` : `/channels/${id}`, undefined, body);
    const raw = res && res.body;
    return which === 'guild' ? { guild: (raw && pickGuild(raw)) || null } : { channel: (raw && pickChannel(raw)) || null };
  }

  // ------------------------------------------------------------------ profiles
  // What the client shows when you open someone's profile. Its own fetch, run as a click on them runs it (which
  // skips one it made in the last minute), then its stores; without those, the same request through its REST client.
  // Every part is optional: a store that is missing or throws leaves its part out.
  const fnSource = (f) => {
    try {
      return Function.prototype.toString.call(f);
    } catch (e) {
      return '';
    }
  };
  const isProfileFetch = (f) => {
    const s = fnSource(f);
    return s.includes('"USER_PROFILE_FETCH_START"') && s.includes('with_mutual_guilds');
  };
  const isProfileOpen = (f) => {
    const s = fnSource(f);
    return s.includes('waitForRefetch') && s.includes('isFetchingProfile');
  };
  /** The one function a module exports that passes `test`; export names are mangled, so it is found by its code. */
  function exportedFn(m, max, test) {
    try {
      const v = Object.values(m);
      return (v.length <= max && v.find((f) => typeof f === 'function' && test(f))) || null;
    } catch (e) {
      return null;
    }
  }
  const CUSTOM_STATUS = 4;
  const FRIEND = 1;
  let profileRescanAt = 0;

  async function profile(cmd) {
    const who = String(cmd.userId || '');
    if (!/^\d+$/.test(who)) throw new Error('whose profile?');
    // The profile modules can come with a later chunk than the finders waited for.
    if ((!mod.UserProfileStore || !(mod.ProfileOpen || mod.ProfileFetch)) && Date.now() - profileRescanAt > 60_000) {
      profileRescanAt = Date.now();
      resolveModules();
    }
    const me = currentUser();
    const selfId = (me && me.id) || null;
    const self = who === selfId;
    let body = null;
    let error;
    try {
      body = await fetchProfile(who, self);
    } catch (e) {
      // Rate limited: say so, rather than answer with a profile missing most of its parts.
      if (e && (e.status === 429 || (e.body && e.body.retry_after))) throw e;
      error = describeError(e);
    }
    const out = { selfId, ...profileParts(who, body), ...relationshipOf(who), custom_status: customStatus(who) };
    if (self) out.friends = friendList();
    if (error) out.error = error;
    return out;
  }

  // Your own bio, saved the way the client's profile settings save it: one PATCH of your profile with only the bio.
  // Then your profile as the client now has it, with the bio Discord answered (its store may not have caught up).
  async function setProfile(cmd) {
    if (typeof cmd.bio !== 'string') throw new Error('nothing to change');
    const me = currentUser();
    if (!me || !me.id) throw new Error('not signed in');
    const res = await rest('patch', '/users/@me/profile', undefined, { bio: cmd.bio });
    const b = (res && res.body) || {};
    const saved = textOf(b.bio ?? (b.user_profile && b.user_profile.bio));
    const out = await profile({ userId: me.id });
    return { ...out, bio: saved ?? cmd.bio };
  }

  async function fetchProfile(who, self) {
    const opts = { type: 'popout', withMutualGuilds: !self, withMutualFriends: !self };
    const open = mod.UserProfileStore && mod.ProfileOpen && exportedFn(mod.ProfileOpen, 2, isProfileOpen);
    if (open) {
      await open(who, undefined, opts);
      return null;
    }
    const run = mod.ProfileFetch && exportedFn(mod.ProfileFetch, 12, isProfileFetch);
    let body = null;
    if (run) {
      await run(who, opts, (b) => {
        body = b;
      });
      return body;
    }
    const res = await rest('get', `/users/${who}/profile`, { type: 'popout', with_mutual_guilds: !self, with_mutual_friends: !self });
    return (res && res.body) || null;
  }

  const isoOf = (t) => (typeof t === 'string' ? t : t && typeof t.toISOString === 'function' ? t.toISOString() : null);
  const numOf = (n) => (typeof n === 'number' ? n : null);

  /**
   * Your server list as the client draws it: each folder (a lone server is a folder of one with no id) with its name,
   * colour and servers in order. Read from the client's stores only: no request goes to Discord.
   */
  function guildFolders() {
    const ids = (v) => (Array.isArray(v) ? v.map(String) : []);
    let raw = null;
    try {
      const st = mod.SortedGuildStore;
      if (st && typeof st.getGuildFolders === 'function') raw = st.getGuildFolders();
    } catch (e) {}
    if (!Array.isArray(raw)) {
      try {
        const st = mod.UserSettingsProtoStore;
        const f = st && st.settings && st.settings.guildFolders;
        raw = f && Array.isArray(f.folders) ? f.folders : null;
      } catch (e) {}
    }
    if (!Array.isArray(raw)) return { folders: null };
    const wrapped = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
    return {
      folders: raw.map((f) => {
        const id = wrapped(f.folderId ?? f.id);
        const color = wrapped(f.folderColor ?? f.color);
        return {
          id: id != null ? String(id) : null,
          name: textOf(wrapped(f.folderName ?? f.name)) || null,
          color: color != null && Number.isFinite(Number(color)) ? Number(color) : null,
          guildIds: ids(f.guildIds),
        };
      }),
    };
  }
  const textOf = (s) => (typeof s === 'string' ? s : null);

  /** The profile proper: the store's copy (camelCase) or the REST body (snake_case), and the user record. */
  function profileParts(who, body) {
    const ps = mod.UserProfileStore;
    const ask = (f, ...a) => {
      try {
        return ps && typeof ps[f] === 'function' ? ps[f](...a) : undefined;
      } catch (e) {
        return undefined;
      }
    };
    const p = ask('getUserProfile', who) || {};
    const b = body || {};
    const bp = b.user_profile || {};
    const bu = b.user || {};
    let rec = null;
    try {
      rec = mod.UserStore.getUser(who) || null;
    } catch (e) {}
    const accounts = Array.isArray(p.connectedAccounts) ? p.connectedAccounts : Array.isArray(b.connected_accounts) ? b.connected_accounts : [];
    let guilds = ask('getMutualGuilds', who);
    if (!Array.isArray(guilds) && Array.isArray(b.mutual_guilds)) guilds = b.mutual_guilds.map((g) => g && { guild: guildOf(g.id) || { id: g.id }, nick: g.nick });
    const friends = ask('getMutualFriends', who);
    const out = {
      user: pickUser(rec) || pickUser(b.user) || null,
      bio: textOf(p.bio ?? bp.bio ?? bu.bio),
      pronouns: textOf(p.pronouns ?? bp.pronouns),
      banner: textOf(p.banner ?? bp.banner ?? bu.banner ?? (rec && rec.banner)),
      accent_color: numOf(p.accentColor ?? bp.accent_color ?? bu.accent_color),
      legacy_username: textOf(p.legacyUsername ?? b.legacy_username),
      connected_accounts: accounts.map(pickConnection).filter(Boolean),
      mutual_guilds: Array.isArray(guilds) ? guilds.map((x) => x && mutualGuild(x.guild, x.nick, who)).filter(Boolean) : null,
      mutual_friends: Array.isArray(friends) ? friends.map((f) => pickUser(f && f.user)).filter(Boolean) : Array.isArray(b.mutual_friends) ? b.mutual_friends.map(pickUser).filter(Boolean) : null,
      mutual_friends_count: numOf(ask('getMutualFriendsCount', who) ?? b.mutual_friends_count),
    };
    // The store keeps why its last fetch failed, also when the client skipped this one for it.
    if (p.fetchError) out.error = describeError(p.fetchError);
    return out;
  }

  function guildOf(id) {
    try {
      return mod.GuildStore.getGuild(id) || null;
    } catch (e) {
      return null;
    }
  }

  /** A shared server: its name, their nickname, and their roles and join date when the client has them as a member. */
  function mutualGuild(g, nick, who) {
    if (!g || !g.id) return null;
    let member = null;
    try {
      member = (mod.GuildMemberStore && mod.GuildMemberStore.getMember(g.id, who)) || null;
    } catch (e) {}
    const out = { id: g.id, name: textOf(g.name) ?? undefined, nick: nick ?? (member && member.nick) ?? null, joined_at: member ? isoOf(member.joinedAt ?? member.joined_at) : null };
    if (member && Array.isArray(member.roles)) {
      const byId = new Map(guildRoles(g).map((r) => [r.id, r]));
      out.roles = member.roles.map((id) => byId.get(id)).filter(Boolean);
    }
    return out;
  }

  /** A connected account, with the name and link the client's own table gives its platform. Ones it does not show are left out. */
  function pickConnection(a) {
    if (!a || typeof a.type !== 'string' || typeof a.name !== 'string') return null;
    const table = mod.Platforms;
    let platform = null;
    try {
      if (table && !table.isSupported(a.type)) return null;
      platform = table ? table.get(a.type) : null;
    } catch (e) {}
    let url = null;
    try {
      if (platform && typeof platform.getPlatformUserUrl === 'function') url = platform.getPlatformUserUrl({ type: a.type, id: a.id, name: a.name });
    } catch (e) {}
    return {
      type: a.type,
      id: a.id != null ? String(a.id) : undefined,
      name: a.name,
      verified: !!a.verified,
      label: platform && typeof platform.name === 'string' ? platform.name : undefined,
      url: typeof url === 'string' && url.startsWith('https://') ? url : undefined,
    };
  }

  function relationshipOf(who) {
    const rs = mod.RelationshipStore;
    if (!rs) return { relationship: null, friend_since: null };
    let type = null;
    try {
      if (typeof rs.getRelationshipType === 'function') type = rs.getRelationshipType(who);
      else type = relationshipTypes().get(who) ?? 0;
    } catch (e) {}
    return { relationship: numOf(type), friend_since: relationshipSince(who) };
  }

  /** When a relationship began (ISO), or null. */
  function relationshipSince(who) {
    try {
      const rs = mod.RelationshipStore;
      return rs && typeof rs.getSince === 'function' ? isoOf(rs.getSince(who)) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Relationships as the snapshot carries them. A friend, a block, a request either way: when it began and (withUsers)
   * who; a request waiting on you also Discord's own flags on it. Any other (implicit ones): whose, and its type.
   * Never the record itself: it holds your nickname for them.
   */
  function relationshipList(records, withUsers) {
    return Array.from(records, ([id, rec]) => {
      const type = typeOfRecord(rec);
      if (!LISTED.includes(type)) return { id, type };
      return { id, type, since: relationshipSince(id), ...(type === INCOMING ? requestFlags(id, rec) : {}), ...(withUsers ? { user: resolveUser(id) } : {}) };
    });
  }

  /**
   * A relationship coming, changing or going: whose, its type (for a remove, the one it had), when it began, and for a
   * request waiting on you Discord's flags on it. Never your nickname for them.
   */
  function relationshipChange(event, a) {
    const r = (a && a.relationship) || a || {};
    const id = r.id ?? (r.user && r.user.id) ?? r.userId;
    if (!id) return null;
    const uid = String(id);
    const type = typeof r.type === 'number' ? r.type : null;
    const removed = event === 'RELATIONSHIP_REMOVE';
    return {
      id: uid,
      type,
      user: removed ? null : pickUser(r.user) || resolveUser(uid) || null,
      since: !removed && LISTED.includes(type) ? isoOf(r.since) || relationshipSince(uid) : null,
      ...(!removed && type === INCOMING ? requestFlags(uid, r) : {}),
    };
  }

  /** The client learning whether someone is a stranger: for a request waiting on you, that request with its flags anew. */
  function strangerStatus(a) {
    const id = a && (a.userId ?? a.user_id);
    if (!id || !mod.RelationshipStore) return null;
    const uid = String(id);
    if (relationshipOf(uid).relationship !== INCOMING) return null;
    const flags = requestFlags(uid, relationshipRecords().get(uid));
    return { id: uid, type: INCOMING, user: resolveUser(uid), since: relationshipSince(uid), spam: flags.spam, stranger: typeof a.isStranger === 'boolean' ? a.isStranger : flags.stranger };
  }

  /**
   * Discord's own flags on a request waiting on you: filed as possible spam, and from a stranger (no server or friend in
   * common: Discord wants an accept confirmed). The store's answer first, else the record's; stranger is null while
   * neither says (the store keeps it for a while only). Two booleans, never the record.
   */
  function requestFlags(id, rec) {
    const rs = mod.RelationshipStore;
    const ask = (name) => {
      try {
        const v = rs && typeof rs[name] === 'function' ? rs[name](id) : undefined;
        return typeof v === 'boolean' ? v : undefined;
      } catch (e) {
        return undefined;
      }
    };
    const said = (...keys) => {
      if (!rec || typeof rec !== 'object') return undefined;
      for (const k of keys) if (typeof rec[k] === 'boolean') return rec[k];
      return undefined;
    };
    return { spam: ask('isSpam') ?? said('isSpamRequest', 'is_spam_request') ?? false, stranger: ask('isStranger') ?? said('isStrangerRequest', 'is_stranger_request') ?? null };
  }

  /** Every relationship's record by user id (an object, or in some builds a bare type), whichever shape this build keeps. */
  function relationshipRecords() {
    const rs = mod.RelationshipStore;
    const all = typeof rs.getMutableRelationships === 'function' ? rs.getMutableRelationships() : typeof rs.getRelationships === 'function' ? rs.getRelationships() : null;
    return new Map(all instanceof Map ? Array.from(all.entries()) : Object.entries(all || {}));
  }
  const typeOfRecord = (r) => (typeof r === 'number' ? r : r && r.type);

  /** Every relationship's type by user id. */
  function relationshipTypes() {
    return new Map(Array.from(relationshipRecords(), ([id, r]) => [id, typeOfRecord(r)]));
  }

  function friendList() {
    const rs = mod.RelationshipStore;
    let ids = [];
    try {
      if (typeof rs.getFriendIDs === 'function') ids = rs.getFriendIDs() || [];
      else ids = Array.from(relationshipTypes()).filter(([, t]) => t === FRIEND).map(([id]) => id);
    } catch (e) {}
    return Array.from(ids).map((id) => resolveUser(id) || { id });
  }

  function customStatus(who) {
    let acts = null;
    try {
      acts = mod.PresenceStore && mod.PresenceStore.getActivities(who);
    } catch (e) {}
    return customOf(acts);
  }

  // ------------------------------------------------------------------ adding
  // Joining from invites, adding friends and answering friend requests (the chat hub's docs/add.md), through what the
  // client's own Join a Server dialog, Add Friend form and friends list call: never a request of ours. Each runs once,
  // from the owner's click on the hub; nothing here retries one that may have acted.
  //
  // A check Discord wants is never answered here. A captcha, verifying the account or its phone, and a server's rules
  // come back as { check } with nothing done; the owner does it in the live view (a captcha the client put on screen
  // is left there for them). Lookups only read: they join nothing and tell nobody.
  const BLOCKED = 2;
  const INCOMING = 3;
  const OUTGOING = 4;
  // The relationships the snapshot says when and with whom: friends, blocks, and requests either way (not implicit ones).
  const LISTED = [FRIEND, BLOCKED, INCOMING, OUTGOING];
  // Discord's refusal of an accept that wants confirming: "You must confirm the friend request to add this user."
  const NEEDS_CONFIRM = 80013;
  const INVITE_FRIEND = 2;
  const GROUP_DM = 3;
  const VERY_HIGH = 4; // a server's verification level: a verified phone
  const INVITE_CODE = /^[A-Za-z0-9-]{2,32}$/;
  const USERNAME = /^(?!.*\.\.)[a-z0-9_.]{2,32}$/;
  const USER_ID = /^\d{15,22}$/;
  // Where the client's own calls say they come from (analytics context, as its dialogs send it).
  const JOIN_CONTEXT = 'Join Guild';
  const FRIEND_CONTEXT = 'Add Friend';
  const FRIENDS_CONTEXT = 'Friends';
  const ACCEPT_WAIT_MS = 80_000; // the hub waits 90 s for a join
  const FRIEND_WAIT_MS = 40_000;
  const LAND_WAIT_MS = 10_000; // for the gateway's GUILD_CREATE or CHANNEL_CREATE after an accept
  const EXPIRED = 'This invite has expired or was revoked';
  const BANNED = 'You are banned from this server';
  // The few refusals said more plainly than Discord's API says them; the rest are its own sentence.
  const SENTENCE = { 10006: EXPIRED, 40007: BANNED };

  let addRescanAt = 0;
  /** A module adding needs. One that came with a later chunk is looked for again, at most once a minute. */
  function needModule(name, what) {
    if (!mod[name] && Date.now() - addRescanAt > 60_000) {
      addRescanAt = Date.now();
      report(resolveModules());
    }
    if (!mod[name]) throw new Error(`Discord's own ${what} was not found in this client (Discord changed?), so this is not available`);
    return mod[name];
  }

  /**
   * One of the client's actions. Current builds take one object ({ userId, context }), older ones plain arguments
   * (userId, context); the function's own arity says which. Always a promise, so a throw is a refusal.
   */
  function clientAction(owner, name, obj, args) {
    return Promise.resolve().then(() => {
      const f = owner[name];
      return takesObject(f, obj) ? f.call(owner, obj) : f.apply(owner, args);
    });
  }

  /**
   * Whether one of the client's actions wants one object ({ userId, context, ... }) or positional arguments. Arity alone
   * can't say: the live addRelationship(e, t) declares two parameters but takes userId and the rest apart from its
   * first, while removeRelationship(e, t, n) is positional. So read the function's own text: a first parameter that is
   * itself a pattern, or that the body takes apart by one of the object's keys (`{userId: n, ...} = e`, `e.userId`),
   * wants the object. Otherwise one parameter wants the object and two or more the positional form, as before.
   */
  function takesObject(f, obj) {
    let src = '';
    try {
      src = Function.prototype.toString.call(f);
    } catch {
      return f.length < 2;
    }
    const arrow = /^\s*(?:async\s+)?([\w$]+)\s*=>/.exec(src);
    const open = arrow ? null : /\(\s*([\w$]+|\{)/.exec(src);
    const first = arrow ? arrow[1] : open ? open[1] : null;
    if (first === '{') return true;
    if (first) {
      const keys = Object.keys(obj).map((k) => k.replace(/[$]/g, '\\$&')).join('|');
      const p = first.replace(/[$]/g, '\\$&');
      if (new RegExp(`\\{[^{}]*\\b(?:${keys})\\b[^{}]*\\}\\s*=\\s*${p}(?![\\w$])`).test(src)) return true;
      if (new RegExp(`(?<![\\w$.])${p}\\??\\.(?:${keys})\\b`).test(src)) return true;
    }
    return f.length < 2;
  }

  /** What a refusal says: the REST client's response object, or an error built on one. Never its captcha keys. */
  function refusal(err) {
    const e = err && typeof err === 'object' ? err : {};
    const b = e.body && typeof e.body === 'object' ? e.body : {};
    return {
      status: typeof e.status === 'number' ? e.status : null,
      code: typeof b.code === 'number' ? b.code : typeof e.code === 'number' ? e.code : null,
      message: typeof b.message === 'string' ? b.message : fieldMessage(b) || (typeof e.message === 'string' ? e.message : ''),
      retryAfter: Number(b.retry_after ?? e.retryAfter ?? e.retry_after) || null,
      captcha: Array.isArray(b.captcha_key) || !!b.captcha_sitekey || !!e.captchaFields,
    };
  }

  /**
   * A form error as the client's REST module hands it on with oldFormErrors (as its PrivateChannelActions send):
   * Discord's 50035 body flattened to { field: [sentence, ...] }, with no message or code left. The first sentence.
   */
  function fieldMessage(b) {
    for (const [k, v] of Object.entries(b)) if (!/^captcha_/.test(k) && Array.isArray(v) && typeof v[0] === 'string') return v[0];
    return '';
  }

  /** The check a refusal wants, which only the owner can do; null for an ordinary refusal. */
  function checkOf(err) {
    const r = refusal(err);
    if (r.captcha) return 'captcha';
    // 40002: verify the account first; 60003: two-factor first.
    if (r.code === 40002 || r.code === 60003 || (r.status === 403 && /verif/i.test(r.message))) return /phone/i.test(r.message) ? 'phone' : 'verify';
    return null;
  }

  const inSeconds = (s) => (s < 90 ? `${Math.ceil(s)} seconds` : `${Math.ceil(s / 60)} minutes`);

  /** A refusal in Discord's own words; a rate limit with when it frees up (and retry_after, so the adapter waits too). */
  function refused(err, what) {
    const r = refusal(err);
    if (r.status === 429 || r.retryAfter) {
      const e = Object.assign(new Error(`Discord is limiting how often this account can ${what}: try again in ${r.retryAfter ? inSeconds(r.retryAfter) : 'a minute or so'}`), { limited: true });
      return r.retryAfter ? Object.assign(e, { body: { retry_after: r.retryAfter } }) : e;
    }
    const said = SENTENCE[r.code] || r.message;
    // refusal: Discord answered this request with a no, which says nothing of the next one.
    return Object.assign(new Error(said || describeError(err)), { refusal: true });
  }

  /** The client's captcha on screen: it puts one up for some requests itself, and waits for an answer. */
  function captchaOnScreen() {
    try {
      return !!document.querySelector('iframe[src*="hcaptcha"], iframe[src*="captcha"]');
    } catch (e) {
      return false;
    }
  }

  /**
   * The client's action, until it settles or a check stops it: a refusal that wants one, or a captcha the client put
   * up while it waited (left there for the owner). { value } or { check }; never retried. confirmable: an accept sent
   * without the owner's confirm, whose "confirm it first" refusal is { confirm: Discord's sentence }, nothing done.
   */
  function untilSettled(promise, ms, what, confirmable) {
    const before = captchaOnScreen();
    return new Promise((resolve, reject) => {
      let done = false;
      let watch = null;
      const end = (fn, v) => {
        if (done) return;
        done = true;
        if (watch !== null) clearInterval(watch);
        fn(v);
      };
      watch = setInterval(() => {
        if (!before && captchaOnScreen()) end(resolve, { check: 'captcha' });
      }, 500);
      setTimeout(() => end(reject, new Error(`Discord did not answer in ${ms / 1000} seconds; it may still go through`)), ms);
      promise.then(
        (value) => end(resolve, { value }),
        (err) => {
          const check = checkOf(err);
          if (check) end(resolve, { check });
          else if (confirmable && refusal(err).code === NEEDS_CONFIRM) end(resolve, { confirm: refusal(err).message });
          else end(reject, refused(err, what));
        },
      );
    });
  }

  /** What the gateway brings in after an action, from the client's stores: at once when it is there, else soon. */
  async function landed(get, ms) {
    const until = Date.now() + ms;
    for (;;) {
      let v = null;
      try {
        v = get();
      } catch (e) {}
      if (v || Date.now() >= until) return v || null;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  function inviteCodeOf(code) {
    const c = String(code || '');
    if (!INVITE_CODE.test(c)) throw new Error('That is not a Discord invite code');
    return c;
  }

  /** The client's own copy of an invite it has looked up already (its invite embeds and dialog keep them), or null. */
  function storedInvite(code) {
    try {
      const s = mod.InviteStore && mod.InviteStore.getInvite(code);
      return s && !['RESOLVING', 'EXPIRED', 'BANNED', 'ERROR'].includes(s.state) && (s.guild || s.channel || s.inviter) ? s : null;
    } catch (e) {
      return null;
    }
  }

  /** The client's own invite lookup, with counts and expiry, as its Join a Server dialog runs it. */
  async function lookUpInvite(code) {
    const ia = needModule('InviteActions', 'invite module');
    let res;
    try {
      res = await ia.resolveInvite(code, JOIN_CONTEXT);
    } catch (e) {
      throw refused(e, 'look up invites');
    }
    const inv = res && typeof res === 'object' && 'invite' in res ? res.invite : res;
    if (inv && typeof inv === 'object' && (inv.guild || inv.channel || inv.inviter)) return inv;
    // It answers a dead invite with none, and its store says why.
    let state = null;
    try {
      const s = mod.InviteStore && mod.InviteStore.getInvite(code);
      state = s && s.state;
    } catch (e) {}
    throw new Error(state === 'BANNED' ? BANNED : EXPIRED);
  }

  /** An invite, whitelisted: what it leads to, its counts and expiry, who made it, and whether this account is in it. */
  function pickInvite(inv, code) {
    const g = inv.guild || null;
    const c = inv.channel || null;
    const inviter = pickUser(inv.inviter) || null;
    const features = g && g.features;
    const has = (f) => !!features && (typeof features.has === 'function' ? features.has(f) : Array.isArray(features) && features.includes(f));
    const type = typeof inv.type === 'number' ? inv.type : g ? 0 : c && c.type === GROUP_DM ? 1 : INVITE_FRIEND;
    return {
      code: String(inv.code || code),
      type,
      guild: g && g.id ? { id: String(g.id), name: String(g.name || ''), icon: g.icon ?? null, description: g.description ?? null, verification_level: numOf(g.verification_level ?? g.verificationLevel), screening: has('MEMBER_VERIFICATION_GATE_ENABLED') } : null,
      channel: c && c.id ? { id: String(c.id), type: c.type, name: c.name ?? null, icon: c.icon ?? null, ...(Array.isArray(c.recipients) ? { recipients: c.recipients.map((r) => r && r.username).filter((n) => typeof n === 'string') } : {}) } : null,
      inviter,
      expires_at: isoOf(inv.expires_at ?? inv.expiresAt),
      members: numOf(inv.approximate_member_count ?? inv.approximateMemberCount),
      online: numOf(inv.approximate_presence_count ?? inv.approximatePresenceCount),
      joined: joinedBy(g, c),
      relationship: type === INVITE_FRIEND && inviter ? relationshipOf(inviter.id).relationship : null,
    };
  }

  /** Already in what an invite leads to, by the client's own stores. */
  function joinedBy(g, c) {
    if (g && g.id && guildOf(g.id)) return { space: String(g.id) };
    try {
      if (!g && c && c.type === GROUP_DM && mod.ChannelStore.getChannel(c.id)) return { conversation: String(c.id) };
    } catch (e) {}
    return null;
  }

  /** Joins what an invite leads to (or, for a friend invite with cmd.friend, adds its maker), as the client's Join button does. */
  async function inviteAccept(cmd) {
    const code = inviteCodeOf(cmd.code);
    const ia = needModule('InviteActions', 'invite module');
    // What the client's dialog shows before its Join button: its own copy when it has looked this one up already.
    const inv = pickInvite(storedInvite(code) || (await lookUpInvite(code)), code);
    const forFriend = inv.type === INVITE_FRIEND;
    if (forFriend !== !!cmd.friend) throw new Error(forFriend ? 'This is a friend invite: Add friend accepts it' : 'This invite joins a server or group, not a friend');
    if (forFriend && !inv.inviter) throw new Error('Discord did not say whose friend invite this is');
    if (inv.joined || (forFriend && inv.relationship === FRIEND)) return { invite: inv, already: true };
    const context = { location: JOIN_CONTEXT };
    const noop = () => {};
    const out = await untilSettled(clientAction(ia, 'acceptInvite', { inviteKey: code, context, callback: noop }, [code, context, noop]), ACCEPT_WAIT_MS, forFriend ? 'add friends' : 'join servers');
    if (out.check) return { invite: inv, check: out.check };
    const body = (out.value && out.value.body) || out.value || {};
    if (forFriend) {
      const id = inv.inviter.id;
      await landed(() => relationshipOf(id).relationship === FRIEND, 3000);
      return { invite: inv, friend: inv.inviter, relationship: relationshipOf(id).relationship ?? FRIEND };
    }
    if (inv.guild) return joinedGuild(inv, body);
    const c = inv.channel;
    const got = await landed(() => mod.ChannelStore.getChannel(c.id), LAND_WAIT_MS);
    return { invite: inv, channel: got ? pickChannel(got) : { id: c.id, type: GROUP_DM, name: c.name, icon: c.icon, recipients: [] } };
  }

  /** A server just joined, as the client now has it: its channels, and whether its rules still wait for the owner. */
  async function joinedGuild(inv, body) {
    const gid = inv.guild.id;
    const g = await landed(() => guildOf(gid), LAND_WAIT_MS);
    const fromBody = body.guild && String(body.guild.id) === gid ? body.guild : null;
    const guild = pickGuild(g) || pickGuild(fromBody) || { id: gid, name: inv.guild.name, icon: inv.guild.icon, description: inv.guild.description, rules_channel_id: null };
    const lead = inv.channel && inv.channel.type !== GROUP_DM ? inv.channel : null;
    // Not in the stores yet: the channel the invite leads to is all there is to say; the gateway brings the rest.
    const channels = g ? guildChannels(gid) : lead ? [{ id: lead.id, type: lead.type, guild_id: gid, name: lead.name, topic: null, parent_id: null }] : [];
    const me = currentUser();
    return { invite: inv, guild, channels, channelId: lead ? lead.id : null, rules: rulesWait(gid, body, inv), phone: inv.guild.verification_level === VERY_HIGH && !(me && me.phone) };
  }

  /** Membership screening still to do: the accept says so, or the client holds this member as pending. */
  function rulesWait(gid, body, inv) {
    if (body && body.show_verification_form === true) return true;
    const me = currentUser();
    let m = null;
    try {
      m = me && mod.GuildMemberStore ? mod.GuildMemberStore.getMember(gid, me.id) : null;
    } catch (e) {}
    if (m) return m.isPending === true || m.pending === true;
    return !!(inv.guild.screening && body && body.new_member === true);
  }

  /** Who the client's stores know by that user id or username. No request, so nobody is told. */
  function person(cmd) {
    const handle = String(cmd.handle || '');
    const me = currentUser();
    const selfId = (me && me.id) || null;
    let u = null;
    if (USER_ID.test(handle)) {
      try {
        u = mod.UserStore.getUser(handle) || null;
      } catch (e) {}
    } else if (USERNAME.test(handle)) u = userNamed(handle);
    else throw new Error('That is not a Discord username or user id');
    const user = pickUser(u);
    if (!user || !user.id || !user.username) return { selfId, user: null };
    let direct = false;
    try {
      direct = !!(mod.ChannelStore.getDMFromUserId && mod.ChannelStore.getDMFromUserId(user.id));
    } catch (e) {}
    return { selfId, user, relationship: relationshipOf(user.id).relationship, direct };
  }

  /** Someone the client has seen under a username. Current names only: an old name#1234 is not unique. */
  function userNamed(name) {
    const us = mod.UserStore;
    const is = (u) => !!u && typeof u.username === 'string' && u.username.toLowerCase() === name && (!u.discriminator || u.discriminator === '0');
    try {
      const u = typeof us.findByTag === 'function' ? us.findByTag(name) : null;
      if (is(u)) return u;
    } catch (e) {}
    try {
      const all = typeof us.getUsers === 'function' ? us.getUsers() : null;
      for (const u of all instanceof Map ? all.values() : Object.values(all || {})) if (is(u)) return u;
    } catch (e) {}
    return null;
  }

  /** The user a relationship is with, by their username. */
  function relatedNamed(name) {
    if (!mod.RelationshipStore) return null;
    for (const id of relationshipTypes().keys()) {
      const u = resolveUser(id);
      if (u && typeof u.username === 'string' && u.username.toLowerCase() === name) return id;
    }
    return null;
  }

  /**
   * A friend request, as the client's Add Friend form sends one by username, or its Add Friend button on a profile by
   * user id (which accepts theirs, when they asked first).
   */
  async function friendAdd(cmd) {
    const ra = needModule('RelationshipActions', 'friends module');
    const me = currentUser();
    const context = { location: FRIEND_CONTEXT };
    // By user id it accepts theirs when they asked first, which Discord may want confirmed: only the owner confirms.
    const confirm = cmd.userId !== undefined && cmd.confirm === true;
    let run;
    let who;
    if (cmd.userId !== undefined) {
      const id = String(cmd.userId);
      if (!USER_ID.test(id)) throw new Error('That is not a Discord user id');
      if (me && me.id === id) throw new Error('That is this account');
      run = () => addFriendCall(ra, id, context, confirm);
      who = () => id;
    } else {
      const name = String(cmd.username || '');
      if (!USERNAME.test(name)) throw new Error('That is not a Discord username');
      if (me && typeof me.username === 'string' && me.username.toLowerCase() === name) throw new Error('That is this account');
      run = () => clientAction(ra, 'sendRequest', { discordTag: name, username: name, context }, [name, context]);
      who = () => relatedNamed(name);
    }
    const out = await untilSettled(run(), FRIEND_WAIT_MS, 'send friend requests', cmd.userId !== undefined && !confirm);
    if (out.check) return { check: out.check };
    if (out.confirm !== undefined) return { confirm: out.confirm };
    // Discord names who it was only in the relationship it then adds (RELATIONSHIP_ADD), a moment later.
    const id = await landed(() => {
      const id = who();
      const t = id && relationshipOf(id).relationship;
      return t === OUTGOING || t === FRIEND ? id : null;
    }, 5000);
    if (!id) return { user: null, relationship: OUTGOING };
    return { user: resolveUser(id), relationship: relationshipOf(id).relationship };
  }

  /** A friend request waiting on you, answered as the client's friends list does: accept, ignore, or block. */
  async function friendAnswer(cmd) {
    const ra = needModule('RelationshipActions', 'friends module');
    const id = String(cmd.userId || '');
    if (!USER_ID.test(id)) throw new Error('That is not a Discord user id');
    if (relationshipOf(id).relationship !== INCOMING) throw new Error('That request is not waiting any more');
    const context = { location: FRIENDS_CONTEXT };
    // Only an accept is ever confirmed, and only when the owner said so; decline and block need none.
    const accept = cmd.answer === 'accept';
    const confirm = accept && cmd.confirm === true;
    let run;
    if (accept) run = () => addFriendCall(ra, id, context, confirm);
    else if (cmd.answer === 'decline') run = () => clientAction(ra, 'removeRelationship', { userId: id, context }, [id, context]);
    else if (cmd.answer === 'block') run = () => clientAction(ra, 'addRelationship', { userId: id, context, type: BLOCKED }, [id, context, BLOCKED]);
    else throw new Error('Accept, decline or block?');
    const out = await untilSettled(run(), FRIEND_WAIT_MS, 'answer friend requests', accept && !confirm);
    if (out.check) return { check: out.check };
    if (out.confirm !== undefined) return { confirm: out.confirm };
    const want = cmd.answer === 'accept' ? FRIEND : cmd.answer === 'block' ? BLOCKED : 0;
    await landed(() => (relationshipOf(id).relationship || 0) === want, 3000);
    const now = relationshipOf(id).relationship;
    // Discord took it; a store that has not caught up yet still says the request.
    return { user: resolveUser(id), relationship: now === INCOMING ? want : now };
  }

  /**
   * addRelationship for an accept, or Add friend by user id. confirmStrangerRequest goes along only when the owner
   * confirmed (their "Accept anyway"), never on our own. Plain arguments have no place for it, so a build that takes
   * them cannot carry a confirm.
   */
  function addFriendCall(ra, id, context, confirm) {
    if (!confirm) return clientAction(ra, 'addRelationship', { userId: id, context }, [id, context]);
    const obj = { userId: id, context, confirmStrangerRequest: true };
    if (!takesObject(ra.addRelationship, obj)) throw new Error("This Discord client's friends module has no way to confirm a request: accept it in the live view");
    return clientAction(ra, 'addRelationship', obj, [id, context]);
  }

  // What ending each relationship is, in the client's friends list: Remove Friend, Cancel (a request sent), Unblock.
  const ENDS = { [FRIEND]: 'remove friends', [OUTGOING]: 'cancel friend requests', [BLOCKED]: 'unblock people' };

  /**
   * Ends a relationship as the client's friends list does, all three through its removeRelationship: unfriend, cancel a
   * request you sent, unblock. Only when the client's store still has the relationship the owner saw (cmd.type).
   */
  async function friendRemove(cmd) {
    const ra = needModule('RelationshipActions', 'friends module');
    needModule('RelationshipStore', 'relationship store');
    const id = String(cmd.userId || '');
    if (!USER_ID.test(id)) throw new Error('That is not a Discord user id');
    const me = currentUser();
    if (me && me.id === id) throw new Error('That is this account');
    const want = Number(cmd.type);
    if (!ENDS[want]) throw new Error('Only a friend, a request you sent or a block can be removed');
    if ((relationshipOf(id).relationship || 0) !== want) throw new Error('That changed; look again');
    const context = { location: FRIENDS_CONTEXT };
    const out = await untilSettled(clientAction(ra, 'removeRelationship', { userId: id, context }, [id, context]), FRIEND_WAIT_MS, ENDS[want]);
    if (out.check) return { check: out.check };
    await landed(() => !relationshipOf(id).relationship, 3000);
    const now = relationshipOf(id).relationship || 0;
    // Discord took it; a store that has not caught up yet still says what it was.
    return { user: resolveUser(id), relationship: now === want ? 0 : now };
  }

  // ------------------------------------------------------- adding to a group
  // What the client's Add Friends popout in a group DM ends in: one PUT per person through its REST module. Never its
  // PrivateChannelActions.addRecipient(s): those can move the sandbox's page to the group (see openDirect).
  const NOT_FRIEND = 'Discord adds only your friends to a group.';
  const GROUP_WAIT_MS = 5000; // for the gateway's CHANNEL_RECIPIENT_ADD after the PUTs
  const PUT_WAIT_MS = 20_000;
  const ADD_ALL_MS = 80_000; // the hub waits 120 s for the whole command
  const sentence = (s) => (/[.!?]$/.test(s) ? s : s + '.');
  const recipientIds = (channelId) => {
    const c = mod.ChannelStore.getChannel(channelId);
    const list = c && Array.isArray(c.recipients) ? c.recipients : [];
    return list.map((r) => String(typeof r === 'string' ? r : r && r.id));
  };

  /**
   * Adds friends to a group DM, one at a time. Someone not a friend is refused with no request; a refusal is that
   * person's, in Discord's words, and the rest still go. A check (a captcha, verifying), a rate limit or no answer stops
   * the rest: each would meet it too. Reply: who is in now, who was refused and why, their users, and the group as the
   * store then has it.
   */
  async function addRecipients(cmd) {
    needModule('RelationshipStore', 'relationship store');
    const channelId = String(cmd.channelId || '');
    if (!/^\d+$/.test(channelId)) throw new Error('which group?');
    const c = mod.ChannelStore.getChannel(channelId);
    // A PUT on a 1:1 DM makes a new group instead.
    if (!c || c.type !== GROUP_DM) throw new Error('Discord adds people only to group DMs');
    const ids = Array.isArray(cmd.userIds) ? cmd.userIds.map(String) : [];
    if (!ids.length || ids.length > 10) throw new Error('add 1 to 10 people at a time');
    const me = currentUser();
    const added = [];
    const failed = [];
    const until = Date.now() + ADD_ALL_MS;
    let stop = null;
    for (const id of ids) {
      if (!stop && Date.now() > until) stop = 'Not tried: Discord was answering too slowly.';
      if (stop) {
        failed.push({ id, reason: stop });
        continue;
      }
      if (!USER_ID.test(id)) {
        failed.push({ id, reason: 'That is not a Discord user id.' });
        continue;
      }
      if ((me && me.id === id) || recipientIds(channelId).includes(id)) {
        added.push(id);
        continue;
      }
      if (relationshipOf(id).relationship !== FRIEND) {
        failed.push({ id, reason: NOT_FRIEND });
        continue;
      }
      try {
        const out = await untilSettled(rest('put', `/channels/${channelId}/recipients/${id}`), PUT_WAIT_MS, 'add people to groups');
        if (out.check) {
          stop = out.check === 'captcha' ? 'Discord asked for a captcha: add them in the live view.' : 'Discord wants this account verified first: open the live view.';
          failed.push({ id, reason: stop });
        } else added.push(id);
      } catch (e) {
        const reason = sentence(String((e && e.message) || e));
        failed.push({ id, reason });
        // A rate limit, or no answer at all: each one after would meet the same.
        if (!(e && e.refusal)) stop = e && e.limited ? reason : 'Not tried: Discord stopped answering.';
      }
    }
    // The gateway's CHANNEL_RECIPIENT_ADD puts them in the store; a PUT that timed out may have gone through.
    await landed(() => added.every((id) => (me && me.id === id) || recipientIds(channelId).includes(id)), GROUP_WAIT_MS);
    const now = recipientIds(channelId);
    const late = failed.filter((f) => now.includes(f.id));
    return {
      added: [...added, ...late.map((f) => f.id)],
      failed: failed.filter((f) => !late.includes(f)),
      users: [...added, ...late.map((f) => f.id)].filter((id) => !me || me.id !== id).map((id) => resolveUser(id) || { id }),
      channel: pickChannel(mod.ChannelStore.getChannel(channelId)) || null,
    };
  }

  // ------------------------------------------------------- making a group DM
  // The client's New Group DM (build 670026) confirms with openPrivateChannel({ recipientIds, location: 'New Group DM' }):
  // POST /users/@me/channels { recipients } through its REST client, with X-Context-Properties naming that location,
  // up to 3 more tries on a 5xx or a dropped connection, then the page moved to the group. Here: the same module's
  // ensurePrivateChannel(friendIds), the same POST and body without that header and without the retries, which puts
  // the group in the store itself and resolves to its id; the page stays where it is (isGroupMaker checks that shape).
  // Sent once: no answer is an error, never a second group. Like the client, a group with exactly these people
  // already there is no reason not to make a new one (its picker asks first; the owner's command is the asking); the
  // reply says so in a note.
  const GROUP_OTHERS_MAX = 9; // Discord: 10 in a group DM, you included
  const GROUP_NAME_MAX = 100;
  const CREATE_WAIT_MS = 30_000;
  const NAME_WAIT_MS = 20_000;
  const MIN_FRIENDS = 'A Discord group DM starts with at least 2 friends';

  /** The group DMs the store has with exactly these people besides you: the ones the client's picker warns of. */
  function sameGroups(ids) {
    const want = JSON.stringify([...ids].sort());
    try {
      const all = mod.ChannelStore.getMutablePrivateChannels ? Object.values(mod.ChannelStore.getMutablePrivateChannels() || {}) : getSortedPrivate();
      return all.filter((c) => c && c.type === GROUP_DM && JSON.stringify(recipientIds(c.id).sort()) === want).map((c) => String(c.id));
    } catch (e) {
      return [];
    }
  }

  /**
   * Makes a group DM with friends. Someone not a friend is refused with no request, and the rest still go, as long as
   * 2 friends are left (with one it would be a DM). A name, when given, is set after, as the group's settings rename
   * it (one PATCH through the client's REST module, as configure does); a refused name leaves the group made, with a
   * note. Reply: the group's id, who is in, who was refused and why, their users, the group as the store has it.
   */
  async function createGroupDM(cmd) {
    // When each step was done, in ms from the start: the adapter puts them on its span (src/trace.ts). Times only.
    const t0 = performance.now();
    const phases = [];
    const mark = (name) => phases.push({ name, ms: Math.round(performance.now() - t0) });
    needModule('RelationshipStore', 'relationship store');
    const actions = needModule('GroupDMCreate', 'action for a new group DM');
    const me = currentUser();
    const ids = [...new Set((Array.isArray(cmd.userIds) ? cmd.userIds : []).map(String))].filter((id) => !me || me.id !== id);
    const name = typeof cmd.name === 'string' ? cmd.name.trim() : '';
    if (name.length > GROUP_NAME_MAX) throw new Error(`A Discord group DM's name is at most ${GROUP_NAME_MAX} characters`);
    const failed = [];
    const friends = [];
    for (const id of ids) {
      if (!USER_ID.test(id)) failed.push({ id, reason: 'That is not a Discord user id.' });
      else if (relationshipOf(id).relationship !== FRIEND) failed.push({ id, reason: NOT_FRIEND });
      else friends.push(id);
    }
    if (friends.length < 2) throw new Error(failed.length ? `${NOT_FRIEND} ${MIN_FRIENDS}` : MIN_FRIENDS);
    if (friends.length > GROUP_OTHERS_MAX) throw new Error(`A Discord group DM holds 10 people, you included: pick at most ${GROUP_OTHERS_MAX}`);
    const before = sameGroups(friends);
    mark('friends checked');

    const out = await untilSettled(
      Promise.resolve().then(() => actions.ensurePrivateChannel(friends)),
      CREATE_WAIT_MS,
      'make group DMs',
    );
    if (out.check) throw new Error(out.check === 'captcha' ? 'Discord asked for a captcha: answer it in the live view, and the group is made there.' : 'Discord wants this account verified first: open the live view.');
    // The client's own answer is the new channel's id, after its CHANNEL_CREATE has put the group in the store.
    const channelId = typeof out.value === 'string' ? out.value : '';
    if (!/^\d+$/.test(channelId)) throw new Error('The Discord client did not say which group it made: it shows up here once Discord sends it.');
    mark('group made');
    const stored = () => mod.ChannelStore.getChannel(channelId);
    const c = (await landed(() => {
      const x = stored();
      return x && (x.type !== GROUP_DM || friends.every((id) => recipientIds(channelId).includes(id))) ? x : null;
    }, GROUP_WAIT_MS)) || stored();
    if (c && c.type !== GROUP_DM) throw new Error('The Discord client opened a DM, not a group: making group DMs is not built for this client.');
    mark('group in the store');

    const notes = [];
    if (before.includes(channelId)) notes.push('Discord gave back the group DM you already had with exactly these people: no new group was made.');
    else if (before.length) notes.push(`You already had ${before.length === 1 ? 'a group DM' : `${before.length} group DMs`} with exactly these people; Discord made a new one, as its own New Group DM does once you confirm.`);
    let named = null;
    if (name) {
      try {
        const r = await untilSettled(rest('patch', `/channels/${channelId}`, undefined, { name }), NAME_WAIT_MS, 'rename group DMs');
        if (r.check) notes.push('Discord made the group DM but wants a check before it takes the name: rename it in the live view.');
        else named = (r.value && r.value.body) || null;
      } catch (e) {
        notes.push(`Discord made the group DM but did not take its name: ${sentence(String((e && e.message) || e))}`);
      }
      mark('named');
    }
    const now = recipientIds(channelId);
    const inIt = now.length ? friends.filter((id) => now.includes(id)) : friends;
    for (const id of friends) if (!inIt.includes(id)) failed.push({ id, reason: 'Discord did not add them.' });
    const channel = pickChannel(stored() || c) || null;
    if (channel && named && typeof named.name === 'string') channel.name = named.name;
    return {
      channelId,
      added: inIt,
      failed,
      users: inIt.map((id) => resolveUser(id) || { id }),
      channel,
      notes,
      phases,
    };
  }

  // How the client itself sends files: ask for upload URLs, PUT the bytes straight to storage, then post
  // a message that names them. Nothing but the message goes through Discord's API proper.
  async function sendWithFiles(cmd) {
    const declared = cmd.files.map((f, i) => ({ id: String(i), filename: f.name, file_size: f.size }));
    const slots = await rest('post', `/channels/${cmd.channelId}/attachments`, undefined, { files: declared });
    const attachments = await Promise.all(
      slots.body.attachments.map(async (slot) => {
        const f = cmd.files[Number(slot.id)];
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        const put = await fetch(slot.upload_url, { method: 'PUT', body: bytes, headers: { 'content-type': f.mime } });
        if (!put.ok) throw new Error(`uploading ${f.name} failed: HTTP ${put.status}`);
        return { id: slot.id, filename: f.name, uploaded_filename: slot.upload_filename };
      }),
    );
    const body = { content: cmd.content, nonce: cmd.nonce, tts: false, channel_id: cmd.channelId, type: 0, sticker_ids: [], attachments };
    if (cmd.replyTo) body.message_reference = { channel_id: cmd.channelId, message_id: cmd.replyTo };
    const res = await rest('post', `/channels/${cmd.channelId}/messages`, undefined, body);
    return { nativeId: res && res.body ? res.body.id : null, nonce: cmd.nonce };
  }

  async function sendMessage(cmd) {
    if (cmd.files && cmd.files.length) return sendWithFiles(cmd);
    const ma = mod.MessageActions;
    if (ma && ma.sendMessage) {
      const options = { nonce: cmd.nonce, ...(cmd.replyTo ? { messageReference: { channel_id: cmd.channelId, message_id: cmd.replyTo } } : {}) };
      // false: by default this waits for the channel to load, which only happens once it is on screen.
      const res = await ma.sendMessage(cmd.channelId, { content: cmd.content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, false, options);
      return { nativeId: res && res.body ? res.body.id : null, nonce: cmd.nonce };
    }
    const body = { content: cmd.content, nonce: cmd.nonce, tts: false };
    if (cmd.replyTo) body.message_reference = { channel_id: cmd.channelId, message_id: cmd.replyTo };
    const res = await rest('post', `/channels/${cmd.channelId}/messages`, undefined, body);
    return { nativeId: res && res.body ? res.body.id : null, nonce: cmd.nonce };
  }

  // Forwarding, as the client's Forward dialog does it: a message with no content whose message_reference has
  // type FORWARD, which the client's own send turns into a forward (MessageActions._sendMessage checks for it),
  // then the note as an ordinary message. The dialog itself is a lazily loaded chunk; its send ends in the same call.
  const REFERENCE_FORWARD = 1;
  async function forwardMessage(cmd) {
    const source = mod.ChannelStore.getChannel(cmd.source.channelId);
    const reference = { guild_id: (source && (source.guild_id ?? source.guildId)) || undefined, channel_id: cmd.source.channelId, message_id: cmd.source.messageId, type: REFERENCE_FORWARD };
    const ma = mod.MessageActions;
    let res;
    if (ma && ma.sendMessage) res = await ma.sendMessage(cmd.channelId, { content: '', tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, false, { nonce: cmd.nonce, messageReference: reference });
    else res = await rest('post', `/channels/${cmd.channelId}/messages`, undefined, { content: '', nonce: cmd.nonce, tts: false, message_reference: reference });
    const id = res && res.body ? res.body.id : null;
    if (cmd.note && cmd.note.trim()) await sendMessage({ channelId: cmd.channelId, content: cmd.note, nonce: nextNonce(cmd.nonce) });
    return { nativeId: id };
  }
  // A snowflake-shaped nonce just after another, for the note that follows a forward.
  const nextNonce = (n) => {
    try {
      return String(BigInt(n) + 1n);
    } catch (e) {
      return String(Date.now());
    }
  };

  // Never openPrivateChannel itself: that also navigates the sandbox's page to the DM.
  async function openDirect(userId) {
    const describe = (channelId, existed, raw) => ({ channelId, existed, channel: pickChannel(raw || mod.ChannelStore.getChannel(channelId)) || null });
    const known = mod.ChannelStore.getDMFromUserId && mod.ChannelStore.getDMFromUserId(userId);
    if (known) return describe(known, true);
    const actions = mod.PrivateChannelActions;
    const ensure = actions && (actions.getOrEnsurePrivateChannel || actions.ensurePrivateChannel);
    if (ensure) {
      const r = await ensure.call(actions, userId);
      const id = typeof r === 'string' ? r : r && ((r.body && r.body.id) || r.id);
      if (!id) throw new Error('the Discord client did not say which channel it opened');
      return describe(id, false, r && r.body);
    }
    const res = await rest('post', '/users/@me/channels', undefined, { recipients: [userId] });
    return describe(res.body.id, false, res.body);
  }

  async function history(cmd) {
    const query = { limit: Math.min(cmd.limit || 50, 100) };
    if (cmd.beforeId) query.before = cmd.beforeId;
    const res = await rest('get', `/channels/${cmd.channelId}/messages`, query);
    const arr = (res && res.body) || [];
    return { messages: arr.map(pickMessage).filter(Boolean) };
  }

  /**
   * Discord's message search, as the client's search bar runs it: GET /guilds/{id}/messages/search for a server (a
   * server channel is searched as its server's, narrowed to it), /channels/{id}/messages/search for a DM. 202 means
   * the place is still being indexed: { indexing: retry_after seconds }. Otherwise the hits (the one marked `hit` in
   * each group, else its first), with the channels and threads they are in and the people named.
   */
  async function search(cmd) {
    const params = Object.assign({}, cmd.params);
    let url;
    let guildId = cmd.guildId ? String(cmd.guildId) : null;
    if (guildId) url = `/guilds/${guildId}/messages/search`;
    else {
      const channelId = String(cmd.channelId);
      const c = mod.ChannelStore.getChannel(channelId);
      guildId = (c && (c.guild_id ?? c.guildId)) || null;
      if (guildId) {
        url = `/guilds/${guildId}/messages/search`;
        params.channel_id = [channelId];
      } else url = `/channels/${channelId}/messages/search`;
    }
    let res;
    try {
      res = await rest('get', url, params);
    } catch (err) {
      // A REST client that rejects every non-200 still says 202 by its status.
      if (err && err.status === 202) res = err;
      else throw err;
    }
    const body = (res && res.body) || {};
    if (res && res.status === 202) return { indexing: typeof body.retry_after === 'number' ? body.retry_after : null };
    const messages = [];
    for (const group of Array.isArray(body.messages) ? body.messages : []) {
      const list = Array.isArray(group) ? group : [group];
      const hit = list.find((m) => m && m.hit) || list[0];
      const m = pickMessage(hit);
      if (!m) continue;
      if (!m.guild_id && guildId) m.guild_id = guildId;
      messages.push(m);
    }
    const channels = new Map();
    for (const t of Array.isArray(body.threads) ? body.threads : []) {
      const c = pickChannel(t);
      if (c && c.id) channels.set(c.id, c);
    }
    for (const m of messages) {
      if (channels.has(m.channel_id)) continue;
      let c = null;
      try {
        c = pickChannel(mod.ChannelStore.getChannel(m.channel_id));
      } catch (e) {}
      if (c && c.id) channels.set(c.id, c);
    }
    // The answer's `members` are your memberships of the hits' threads (thread id, user id), not people: the authors
    // come with the messages.
    const users = [];
    return { total: typeof body.total_results === 'number' ? body.total_results : null, messages, channels: [...channels.values()], users };
  }

  /**
   * A page of a channel's threads, newest activity first: what a user account may ask (bots use /threads/archived),
   * as DiscordChatExporter lists them for a user token. `has_more` says whether to ask again at offset + the count.
   * The list comes from Discord's search index (a new thread shows a minute or two later), so it may answer 202 like
   * a search: { indexing: retry_after seconds }.
   */
  async function threads(cmd) {
    let res;
    try {
      res = await rest('get', `/channels/${cmd.channelId}/threads/search`, {
        archived: !!cmd.archived,
        sort_by: 'last_message_time',
        sort_order: 'desc',
        offset: Math.max(0, Number(cmd.offset) || 0),
      });
    } catch (err) {
      if (err && err.status === 202) res = err;
      else throw err;
    }
    const body = (res && res.body) || {};
    if (res && res.status === 202) return { indexing: typeof body.retry_after === 'number' ? body.retry_after : null, threads: [], more: false };
    const list = (Array.isArray(body.threads) ? body.threads : []).map(pickChannel).filter((c) => c && c.id);
    return { threads: list, more: !!body.has_more };
  }

  // Servers with a walk waiting on their chunks: guild id -> how many. And the chunks walks took, so the passive path
  // leaves them alone even when it hears them after the walk is over.
  const walking = new Map();
  const walkTook = new WeakSet();
  // A recent page holds at most this many (op 35 answers 1,000 at a time).
  const RECENT_PAGE = 1000;
  /**
   * One request for a server's members, answered by the gateway's chunks, never more than one request:
   * - by name: those whose name starts with `query`, as the client's own member search asks (op 8
   *   REQUEST_GUILD_MEMBERS, through the guild actions' requestMembers, else the GUILD_MEMBERS_REQUEST action its
   *   gateway store sends on). Never an empty query: a user account may not ask for everyone.
   * - `recent`: a page of the most recently joined (op 35 SEARCH_RECENT_MEMBERS, as the server's member page asks,
   *   through searchRecentMembers, else the GUILD_SEARCH_RECENT_MEMBERS action), from `after`, the page before's
   *   `next`: its earliest joined member. A full page has a `next`; a short one is the end.
   * The live client (2026-11) hands chunks on as GUILD_MEMBERS_CHUNK_BATCH, without chunk_index or chunk_count, and
   * keeps a query's nonce to itself, so the walk takes this server's chunks that carry no nonce (one that does answers
   * someone else's by-id request): a batch is the whole answer; a lone chunk ends the walk when it says it is the
   * last, else after a short wait. At most 5 s.
   */
  function walkMembers(cmd) {
    const guildId = String(cmd.guildId);
    const g = guildOf(guildId);
    if (!g) throw new Error('this account is not in that server');
    const recent = !!cmd.recent;
    const query = typeof cmd.query === 'string' ? cmd.query : '';
    if (!recent && !query) throw new Error('a member walk by name needs a query: an account may not ask for everyone');
    const after = recent && cmd.after ? String(cmd.after) : undefined;
    const limit = Math.min(100, Math.max(1, Number(cmd.limit) || 100));
    const d = mod.Dispatcher;
    const got = new Map();
    let earliest = null;
    return new Promise((resolve, reject) => {
      let done = false;
      let settle = null;
      const finish = () => {
        if (done) return;
        done = true;
        for (const [ev, fn] of subs) {
          try {
            d.unsubscribe(ev, fn);
          } catch (e) {}
        }
        const n = (walking.get(guildId) || 1) - 1;
        if (n > 0) walking.set(guildId, n);
        else walking.delete(guildId);
        const out = { guildId, members: [...got.values()], total: memberCount(g) };
        if (recent) out.next = got.size >= RECENT_PAGE && earliest ? earliest.id : null;
        resolve(out);
      };
      const ours = (c) => !!c && String(c.guildId ?? c.guild_id) === guildId && !c.nonce;
      const take = (c) => {
        walkTook.add(c);
        for (const m of Array.isArray(c.members) ? c.members : []) {
          const user = m && m.user && pickUser(m.user);
          if (!user || !user.id || got.has(user.id)) continue;
          const joined = isoOf(m.joined_at ?? m.joinedAt);
          got.set(user.id, { user, nick: typeof m.nick === 'string' && m.nick ? m.nick : null, roles: roleNames(guildId, m.roles), joined_at: joined });
          const at = joined ? Date.parse(joined) : NaN;
          if (!earliest || (Number.isFinite(at) && (!Number.isFinite(earliest.at) || at < earliest.at))) earliest = { id: user.id, at };
        }
      };
      const chunk = (c) => {
        if (done || !ours(c)) return;
        take(c);
        const index = c.chunkIndex ?? c.chunk_index;
        const count = c.chunkCount ?? c.chunk_count;
        if (typeof index === 'number' && typeof count === 'number' && index + 1 >= count) return finish();
        if (!settle) settle = setTimeout(finish, 750);
      };
      const batch = (a) => {
        if (done) return;
        const mine = (Array.isArray(a && a.chunks) ? a.chunks : []).filter(ours);
        if (!mine.length) return;
        mine.forEach(take);
        finish();
      };
      const subs = [
        ['GUILD_MEMBERS_CHUNK', chunk],
        ['GUILD_MEMBERS_CHUNK_BATCH', batch],
      ];
      for (const [ev, fn] of subs) d.subscribe(ev, fn);
      walking.set(guildId, (walking.get(guildId) || 0) + 1);
      try {
        const actions = mod.MemberActions;
        if (recent) {
          if (actions && typeof actions.searchRecentMembers === 'function') actions.searchRecentMembers(guildId, { query: '', continuationToken: after });
          else d.dispatch({ type: 'GUILD_SEARCH_RECENT_MEMBERS', guildId, query: '', continuationToken: after });
        } else if (actions) actions.requestMembers(guildId, query, limit, false);
        else d.dispatch({ type: 'GUILD_MEMBERS_REQUEST', guildIds: [guildId], query, limit, presences: false });
      } catch (e) {
        finish();
        return reject(e);
      }
      setTimeout(finish, 5000);
    });
  }

  async function rest(verb, url, query, body) {
    const r = mod.Rest;
    if (!r || typeof r[verb] !== 'function') throw new Error('REST module unavailable (' + verb + ')');
    const res = await r[verb]({ url, query, body });
    return res;
  }

  // ------------------------------------------------------------- signing in
  // When a login fails, the page just starts over. Discord's own log says why, so pass that on, while
  // signing in only: the route, the status, the captcha verdict and the message. Never tickets or tokens.
  const isLogReader = (f) => typeof f === 'function' && f.length <= 1 && /\.toArray\(\)\.filter\(/.test(Function.prototype.toString.call(f));
  const LOGIN_ROUTE = /\/(auth\/[\w/-]+|users\/@me\/remote-auth[\w/-]*)/;
  let trailUpTo = '';

  function readLoginTrail() {
    if (!mod.ClientLog || snapshotSent) return;
    let lines;
    try {
      lines = Object.values(mod.ClientLog).find(isLogReader)(['Network']).split('\n');
    } catch (e) {
      return;
    }
    for (const line of lines) {
      const hit = line.match(/^(\S+) -> .*Completed \w+ to (\S+) with status: (\d+) and body: (.*)$/);
      if (!hit || hit[1] <= trailUpTo) continue;
      const route = hit[2].match(LOGIN_ROUTE);
      if (!route) continue;
      trailUpTo = hit[1];
      let body = {};
      try {
        body = JSON.parse(hit[4]);
      } catch (e) {
        /* not JSON: the status is still worth having */
      }
      up({
        t: 'loginIssue',
        route: route[1],
        status: Number(hit[3]),
        captcha: Array.isArray(body.captcha_key) ? String(body.captcha_key[0]) : undefined,
        message: typeof body.message === 'string' ? body.message.slice(0, 160) : undefined,
        code: typeof body.code === 'number' ? body.code : undefined,
      });
    }
  }

  /** The WebGL renderer the page sees, for the log: a sandbox without one looks nothing like a desktop browser. */
  function webglRenderer() {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return gl ? (info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'on') : 'off';
    } catch (e) {
      return 'off';
    }
  }

  // --------------------------------------------------------------- page state
  function detectPageState() {
    const href = location.href;
    const path = location.pathname;
    let state = 'loading';
    if (/\/login|\/register/.test(path)) state = 'login';
    else if (/^\/(app|channels)/.test(path)) state = 'app';
    // captcha / verification overlays
    if (captchaOnScreen()) state = 'captcha';
    const bodyText = (document.body && document.body.innerText) || '';
    if (/suspicious activity|verify your|phone number to continue|verification required/i.test(bodyText)) state = 'verify';
    // Discord's full-page error when a lazy chunk will not load.
    if (/Loading chunk \S+ failed/i.test(bodyText)) {
      state = 'crashed';
      reloadAfterCrash();
    }
    up({ t: 'page', state, url: href });
    return state;
  }

  // A reload is what a person would do here, and it nearly always works. At most
  // three per ten minutes, so a page that keeps failing stays up for the live view.
  let reloadScheduled = false;
  function reloadAfterCrash() {
    if (reloadScheduled) return;
    const key = '__MARK_reloads__';
    let recent = [];
    try {
      recent = JSON.parse(sessionStorage.getItem(key) || '[]').filter((t) => Date.now() - t < 10 * 60_000);
    } catch (e) {}
    if (recent.length >= 3) return;
    reloadScheduled = true;
    recent.push(Date.now());
    try {
      sessionStorage.setItem(key, JSON.stringify(recent));
    } catch (e) {}
    log('warn', 'Discord could not load a chunk; reloading the page');
    setTimeout(() => location.reload(), 5000);
  }

  // The REST client rejects with its response object, not an Error.
  function describeError(err) {
    if (err && err.status) return `${(err.body && err.body.message) || 'HTTP error'} (${err.status})`;
    return String((err && err.message) || err);
  }

  // ------------------------------------------------------------------- wiring
  cloak.onDown((payload) => {
    if (payload.t === 'cmd') {
      Promise.resolve()
        .then(() => runCommand(payload.cmd))
        .then((result) => up({ t: 'reply', id: payload.id, ok: true, result }))
        .catch((err) => up({ t: 'reply', id: payload.id, ok: false, error: describeError(err), retryAfter: err && err.body && err.body.retry_after }));
    }
  });

  /*@lab@*/
  installWebpackHook();
  setTimeout(resolveTick, 500);

  // Page-state polling so the adapter can show login / captcha / verify promptly.
  const poll = () => {
    detectPageState();
    readLoginTrail();
    // CONNECTION_OPEN may have fired before we subscribed; it re-sends the full picture when it does fire.
    if (coreReady && !snapshotSent && currentUser()) maybeSendSnapshot('logged in');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poll);
  poll();
  setInterval(poll, 3000);
  // Surfaced in the adapter log so the "not automated" property is easy to confirm.
  log('info', 'hook.js installed; navigator.webdriver=' + String(navigator.webdriver) + '; devicePixelRatio=' + window.devicePixelRatio + '; webgl=' + webglRenderer());
})();
