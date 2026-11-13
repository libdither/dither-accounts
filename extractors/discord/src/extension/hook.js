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
    // Ringing: what the client's call button (call, ring) and its incoming-call Decline (stopRinging) call.
    CallActions: (m) => typeof m.call === 'function' && typeof m.ring === 'function' && typeof m.stopRinging === 'function',
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
      ...attentionChannelFields(c),
      ...threadChannelFields(c),
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
  const pickAttachment = (a) => a && { id: a.id, filename: a.filename, content_type: a.content_type, size: a.size, width: a.width, height: a.height, url: a.url, proxy_url: a.proxy_url, ...pickAttachmentMore(a) };
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
      ...pickEmbedMore(e),
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
      poll: pickPoll(m),
      pinned: typeof m.pinned === 'boolean' ? m.pinned : undefined,
      member: pickMessageMember(m),
      call: pickMessageCall(m.call),
      ...pickRich(m),
    };
  }

  // ---------------------------------------------------------- rich messages
  // What a message carries beyond text, files and plain embeds (rich.ts in the adapter), whitelisted from the
  // gateway's raw object or the client's record alike: flags, a bot's
  // components, roles named, the command it answers, an activity invite; an attachment's alt text, flags and voice
  // waveform; an embed's colour, footer, timestamp, author icon and video.
  const str = (x) => (typeof x === 'string' ? x : undefined);
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const isoish = (t) => (t == null ? undefined : typeof t === 'string' ? t : typeof t.toISOString === 'function' ? t.toISOString() : num(t));
  function pickAttachmentMore(a) {
    return {
      description: str(a.description) ?? null,
      flags: num(a.flags),
      spoiler: a.spoiler === true ? true : undefined,
      duration_secs: num(a.duration_secs ?? a.durationSecs),
      waveform: str(a.waveform),
    };
  }
  function pickEmbedMore(e) {
    const footer = e.footer && { text: str(e.footer.text), icon_url: str(e.footer.iconProxyURL ?? e.footer.proxy_icon_url ?? e.footer.iconURL ?? e.footer.icon_url) };
    const v = e.video;
    return {
      color: num(e.color) ?? str(e.color),
      footer: footer && (footer.text || footer.icon_url) ? footer : undefined,
      timestamp: isoish(e.timestamp),
      author: e.author && { name: e.author.name, url: str(e.author.url), icon_url: str(e.author.iconProxyURL ?? e.author.proxy_icon_url ?? e.author.iconURL ?? e.author.icon_url) },
      video: v ? { url: str(v.url), proxy_url: str(v.proxyURL ?? v.proxy_url), width: num(v.width), height: num(v.height) } : undefined,
    };
  }
  const pickComponentEmoji = (e) => e && { id: e.id ?? null, name: e.name ?? null, animated: !!e.animated };
  function pickMedia(u) {
    if (!u || typeof u !== 'object') return undefined;
    return { url: str(u.url), proxy_url: str(u.proxy_url ?? u.proxyUrl ?? u.proxyURL), content_type: str(u.content_type ?? u.contentType), width: num(u.width), height: num(u.height), attachment_id: str(u.attachment_id ?? u.attachmentId) };
  }
  /** At most this deep and this many: a message's components are a small tree. */
  function pickComponents(list, depth) {
    if (!Array.isArray(list) || depth > 4) return undefined;
    return list.slice(0, 40).map((c) => {
      if (!c || typeof c !== 'object') return null;
      return {
        type: c.type,
        custom_id: str(c.custom_id ?? c.customId),
        style: num(c.style),
        label: str(c.label),
        emoji: pickComponentEmoji(c.emoji),
        url: str(c.url),
        disabled: c.disabled === true ? true : undefined,
        placeholder: str(c.placeholder),
        min_values: num(c.min_values ?? c.minValues),
        max_values: num(c.max_values ?? c.maxValues),
        options: Array.isArray(c.options) ? c.options.slice(0, 25).map((o) => ({ label: str(o.label), value: str(o.value), description: str(o.description), emoji: pickComponentEmoji(o.emoji), default: o.default === true ? true : undefined })) : undefined,
        components: pickComponents(c.components, depth + 1),
        accessory: c.accessory ? (pickComponents([c.accessory], depth + 1) || [])[0] : undefined,
        content: str(c.content),
        media: pickMedia(c.media),
        file: pickMedia(c.file),
        items: Array.isArray(c.items) ? c.items.slice(0, 10).map((it) => ({ media: pickMedia(it && it.media), description: str(it && it.description) ?? null, spoiler: !!(it && it.spoiler) })) : undefined,
        description: str(c.description) ?? null,
        spoiler: c.spoiler === true ? true : undefined,
        divider: typeof c.divider === 'boolean' ? c.divider : undefined,
        name: str(c.name),
        size: num(c.size),
      };
    }).filter(Boolean);
  }
  const pickInteraction = (i) => i && { type: num(i.type), name: str(i.name), user: i.user ? (typeof i.user === 'string' ? resolveUser(i.user) : pickUser(i.user)) : undefined };
  /** The roles a message names (pinged, or written as <@&id>), with names and colours from the client's role store. */
  function mentionRoleNames(m, guildId, pinged) {
    const ids = new Set(pinged);
    for (const x of String(m.content ?? '').matchAll(/<@&(\d+)>/g)) ids.add(x[1]);
    if (!ids.size || !guildId) return undefined;
    const g = guildOf(guildId);
    if (!g) return undefined;
    const out = guildRoles(g).filter((r) => ids.has(r.id)).map((r) => ({ id: r.id, name: r.name, color: r.color || undefined }));
    return out.length ? out : undefined;
  }
  function pickRich(m) {
    const guildId = m.guild_id ?? m.guildId;
    const pinged = Array.isArray(m.mention_roles ?? m.mentionRoles) ? (m.mention_roles ?? m.mentionRoles).filter((r) => typeof r === 'string') : [];
    return {
      flags: num(m.flags),
      components: Array.isArray(m.components) && m.components.length ? pickComponents(m.components, 0) : undefined,
      application_id: str(m.application_id ?? m.applicationId),
      webhook_id: str(m.webhook_id ?? m.webhookId),
      mention_roles: pinged.length ? pinged : undefined,
      mention_role_names: mentionRoleNames(m, guildId, pinged),
      interaction_metadata: pickInteraction(m.interaction_metadata ?? m.interactionMetadata),
      interaction: pickInteraction(m.interaction),
      activity: m.activity ? { type: num(m.activity.type) } : undefined,
      application: m.application && str(m.application.name) ? { name: m.application.name } : undefined,
    };
  }
  /** Your own roles in each server, from the member store: you only, never anyone else (no member request). */
  function selfRoles(guildIds) {
    const me = currentUser();
    const gm = mod.GuildMemberStore;
    if (!me || !gm) return undefined;
    const out = {};
    for (const gid of guildIds) {
      try {
        const mm = gm.getMember(gid, me.id);
        if (mm && Array.isArray(mm.roles)) out[gid] = mm.roles.slice();
      } catch (e) {}
    }
    return out;
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
      data.selfRoles = selfRoles(Object.keys(guilds));
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
  /** The threads this account is in (the others load lazily, as the client's own channel list does). */
  function activeThreads() {
    try {
      return joinedThreadChannels();
    } catch (e) {
      return [];
    }
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
        ...attentionSettingFields(s),
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
    // A moderator's purge, and reactions added in a batch (rich messages).
    'MESSAGE_DELETE_BULK',
    'MESSAGE_REACTION_ADD_MANY',
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
    subscribeSelf();
    subscribeCallStates();
    subscribeInteractions();
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
      case 'MESSAGE_DELETE_BULK':
        return { ids: Array.isArray(a.ids) ? a.ids.filter((x) => typeof x === 'string').slice(0, 500) : [], channelId: a.channelId, guildId: a.guildId };
      case 'MESSAGE_REACTION_ADD_MANY':
        return {
          channelId: a.channelId,
          messageId: a.messageId,
          reactions: (Array.isArray(a.reactions) ? a.reactions : []).slice(0, 50).map((r) => ({ emoji: pickEmoji(r && r.emoji), reactionType: num(r && r.reactionType), users: (Array.isArray(r && r.users) ? r.users : []).slice(0, 100).map((u) => (typeof u === 'string' ? resolveUser(u) || { id: u } : pickUser(u))).filter(Boolean) })),
          ...((Array.isArray(a.reactions) ? a.reactions : []).some((r) => r && r.reactionType === VOTE) ? { poll: pollNow(a.channelId, a.messageId) } : {}),
        };
      case 'MESSAGE_REACTION_ADD':
      case 'MESSAGE_REACTION_REMOVE':
        // A poll vote: the poll as the client now counts it, when it has the message loaded.
        return { channelId: a.channelId, messageId: a.messageId, userId: a.userId, user: resolveUser(a.userId), emoji: pickEmoji(a.emoji), optimistic: !!a.optimistic, colors: a.colors, reactionType: a.reactionType, ...(a.reactionType === VOTE ? { poll: pollNow(a.channelId, a.messageId) } : {}) };
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
        return { guild: pickGuild(a.guild), channels: a.guild && a.guild.id ? guildChannels(a.guild.id) : [], self_roles: a.guild && a.guild.id ? (selfRoles([a.guild.id]) || {})[a.guild.id] : undefined };
      case 'GUILD_UPDATE':
        return { guild: pickGuild(a.guild) };
      case 'GUILD_DELETE':
        return { id: a.guild ? a.guild.id : a.id };
      case 'THREAD_LIST_SYNC':
        return { guildId: a.guildId, threads: Array.isArray(a.threads) ? a.threads.map(pickChannel) : [] };
      case 'MESSAGE_ACK':
        // The gateway's says newMentionCount, and manual when it was marked unread by hand (in any app).
        return { channelId: a.channelId, messageId: a.messageId, mentionCount: a.mentionCount ?? a.newMentionCount, ...(a.manual ? { manual: true } : {}) };
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
        if (SHRINK_THREADS[event]) return SHRINK_THREADS[event](a);
        if (SHRINK_SENDING[event]) return SHRINK_SENDING[event](a);
        return SHRINK_SERVERS[event] ? SHRINK_SERVERS[event](a) : attentionShrink(event, a);
    }
  }

  // --------------------------------------------------------------- commands
  /** Set only in lab sandboxes (src/lab/lab.js, appended at the marker below). */
  let labCommand = null;
  async function runCommand(cmd) {
    if (!coreReady) throw new Error('the Discord client has not finished loading');
    if (Object.prototype.hasOwnProperty.call(ATTENTION_COMMANDS, cmd.kind)) return ATTENTION_COMMANDS[cmd.kind](cmd);
    if (Object.prototype.hasOwnProperty.call(INTERACT_COMMANDS, cmd.kind)) return INTERACT_COMMANDS[cmd.kind](cmd);
    if (Object.prototype.hasOwnProperty.call(THREAD_COMMANDS, cmd.kind)) return THREAD_COMMANDS[cmd.kind](cmd);
    if (Object.prototype.hasOwnProperty.call(SENDING_COMMANDS, cmd.kind)) return SENDING_COMMANDS[cmd.kind](cmd);
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
      case 'mentionables':
        return mentionables(cmd);
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
        return { ...reactionContext(cmd.channelId), manageMessages: canModerateMessages(cmd.channelId) };
      case 'stickers':
        return stickerPage(cmd);
      case 'guildFolders':
        return guildFolders();
      case 'about':
        return aboutMore(about(cmd));
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
      case 'declineCall':
        return declineCall(cmd);
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
        if (hasOwn.call(SELF_COMMANDS, cmd.kind)) return SELF_COMMANDS[cmd.kind](cmd);
        if (SERVER_COMMANDS[cmd.kind]) return SERVER_COMMANDS[cmd.kind](cmd);
        if (POLL_COMMANDS[cmd.kind]) return POLL_COMMANDS[cmd.kind](cmd);
        if (MOD_COMMANDS[cmd.kind]) return MOD_COMMANDS[cmd.kind](cmd);
        throw new Error('unknown command ' + cmd.kind);
    }
  }


  // ------------------------------------------------------------- calls ringing, voice channels
  // Calls that ring you, go on and end in DMs and group DMs, as the gateway tells the client (CALL_CREATE/UPDATE/DELETE,
  // with `ongoingRings`: who is rung, by whom), and who is in which voice channel (VOICE_STATE_UPDATES, for the guilds the
  // client has loaded), with each channel's status line. All of it is what the client was sent anyway: nothing here asks
  // for anything. The adapter turns it into callState, voice and voiceStatus events (src/calls.ts); the hub keeps voice
  // channels' people only with the adversarial voice setting on.
  const calls = new Map(); // channelId -> { messageId, ringing: {userId: senderId} }
  const voiceDue = new Set();
  let voiceTimer = null;

  /** The call object on a call message, as the client keeps it: who was in it, and when it ended. */
  function pickMessageCall(c) {
    if (!c) return undefined;
    const e = c.ended_timestamp ?? c.endedTimestamp;
    return {
      participants: Array.isArray(c.participants) ? c.participants.filter((x) => typeof x === 'string') : [],
      ended_timestamp: e == null ? null : typeof e === 'string' ? e : e.toISOString ? e.toISOString() : String(e),
    };
  }

  function voiceOf(channelId) {
    let states = {};
    try {
      states = (mod.VoiceStateStore && mod.VoiceStateStore.getVoiceStatesForChannel(channelId)) || {};
    } catch (e) {}
    return Object.values(states)
      .filter((v) => v && (v.userId || v.user_id))
      .map((v) => ({ id: v.userId || v.user_id, muted: !!(v.selfMute || v.mute), deafened: !!(v.selfDeaf || v.deaf), video: !!v.selfVideo, streaming: !!v.selfStream }));
  }

  function callUpFor(channelId, deleted) {
    const c = calls.get(channelId);
    if (!c) return;
    const voice = deleted ? [] : voiceOf(channelId);
    for (const v of voice) {
      const u = resolveUser(v.id);
      if (u) up({ t: 'identities', users: [u] });
    }
    up({ t: 'dispatch', event: 'CALL_STATE', data: { channelId, messageId: c.messageId, ringing: Object.keys(c.ringing), rungBy: c.ringing, voice: voice.map((v) => v.id), video: voice.some((v) => v.video), deleted: !!deleted } });
    if (deleted) calls.delete(channelId);
  }

  function onCall(type, a) {
    const channelId = a && (a.channelId ?? a.channel_id);
    if (!channelId) return;
    if (type === 'CALL_DELETE') return callUpFor(channelId, true);
    const rings = a.ongoingRings ?? a.ongoing_rings;
    const ringing = rings && typeof rings === 'object' && !Array.isArray(rings) ? rings : Array.isArray(a.ringing) ? Object.fromEntries(a.ringing.map((id) => [id, null])) : {};
    const prev = calls.get(channelId);
    calls.set(channelId, { messageId: a.messageId ?? a.message_id ?? (prev && prev.messageId) ?? null, ringing });
    callUpFor(channelId, false);
  }

  /** Voice channels whose people changed, at most once a second: each one's whole list, from the client's store. */
  function flushVoice() {
    voiceTimer = null;
    const channels = [];
    for (const channelId of voiceDue) {
      if (calls.has(channelId)) {
        callUpFor(channelId, false);
        continue;
      }
      const ch = mod.ChannelStore && mod.ChannelStore.getChannel(channelId);
      const guildId = ch && (ch.guild_id || (ch.getGuildId && ch.getGuildId()));
      if (!guildId) continue;
      const members = voiceOf(channelId);
      const users = members.map((m) => resolveUser(m.id)).filter(Boolean);
      if (users.length) up({ t: 'identities', users });
      channels.push({ channelId, guildId, members });
    }
    voiceDue.clear();
    if (channels.length) up({ t: 'dispatch', event: 'VOICE_PEOPLE', data: { channels } });
  }
  function voiceChanged(ids) {
    for (const id of ids) if (id) voiceDue.add(id);
    if (!voiceTimer && voiceDue.size) voiceTimer = setTimeout(flushVoice, 1000);
  }

  /** Everyone in voice in the guilds the client has loaded, as it has them now (after connecting). */
  function voiceSnapshot() {
    let all = {};
    try {
      all = (mod.VoiceStateStore && mod.VoiceStateStore.getAllVoiceStates()) || {};
    } catch (e) {}
    const ids = new Set();
    for (const byUser of Object.values(all)) for (const v of Object.values(byUser || {})) if (v && v.channelId) ids.add(v.channelId);
    voiceChanged(ids);
  }

  function subscribeCallStates() {
    const d = mod.Dispatcher;
    if (!d) return;
    const on = (ev, fn) => {
      try {
        d.subscribe(ev, (a) => {
          try {
            fn(a);
          } catch (e) {}
        });
      } catch (e) {
        log('warn', 'subscribe failed for ' + ev, String(e));
      }
    };
    for (const ev of ['CALL_CREATE', 'CALL_UPDATE', 'CALL_DELETE']) on(ev, (a) => onCall(ev, a));
    on('VOICE_STATE_UPDATES', (a) => voiceChanged((a.voiceStates || []).flatMap((v) => [v.channelId, v.oldChannelId])));
    on('VOICE_CHANNEL_STATUS_UPDATE', (a) => up({ t: 'dispatch', event: 'VOICE_STATUS', data: { channels: [{ channelId: a.id, status: a.status ?? null }] } }));
    // The client's own answer when it opens a guild: each voice channel's status.
    on('CHANNEL_INFO', (a) => up({ t: 'dispatch', event: 'VOICE_STATUS', data: { channels: (a.channels || []).map((c) => ({ channelId: c.id, status: c.status ?? null })) } }));
    on('CONNECTION_OPEN', () => setTimeout(voiceSnapshot, 2000));
    // Sounds and emoji in the call this account is in (onEffect ignores every other channel).
    on('VOICE_CHANNEL_EFFECT_SEND', (a) => onEffect(a));
    if (currentUser()) setTimeout(voiceSnapshot, 2000);
  }

  /** Joining a call in a DM or group DM with `ring`: ring the others, as the client's call button does after joining. */
  function ringOthers(cmd) {
    if (!cmd.ring || !mod.CallActions) return;
    const ch = mod.ChannelStore && mod.ChannelStore.getChannel(cmd.channelId);
    if (!ch || (ch.type !== 1 && ch.type !== 3)) return;
    Promise.resolve(mod.CallActions.ring(cmd.channelId)).catch((e) => log('warn', 'ringing the others failed', describeError(e)));
  }

  /** Decline: the incoming call's own Decline, which stops it ringing for you (POST /channels/{id}/call/stop-ringing). */
  async function declineCall(cmd) {
    if (!mod.CallActions) throw new Error('the client has no call module (Discord changed?)');
    await mod.CallActions.stopRinging(cmd.channelId);
    const c = calls.get(cmd.channelId);
    const me = currentUser();
    if (c && me && c.ringing[me.id] !== undefined) {
      delete c.ringing[me.id];
      callUpFor(cmd.channelId, false);
    }
    return { ok: true };
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
    if (hasOwn.call(IN_CALL, cmd.op)) return IN_CALL[cmd.op](cmd);
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
    if (cmd.input) applyInput(cmd.input);
    mod.VoiceActions.selectVoiceChannel(cmd.channelId);
    ringOthers(cmd);
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
    mixed.clear();
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
      const stage = stageOf(call.channelId);
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
        participants.push({ id, muted: !!(v.selfMute || v.mute), deafened: !!(v.selfDeaf || v.deaf), speaking, video: !!v.selfVideo, ...inCallExtras(id, v, stage) });
        users.push(resolveUser(id));
      }
      const key = JSON.stringify([participants, stage]);
      if (key === last) return;
      last = key;
      // The client's per-person volumes may have changed: the bridge's mix follows them.
      regain();
      callUp({ state: { channelId: call.channelId, participants, ...(stage ? { stage } : {}) }, users: users.filter((u) => u && u.username) });
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
    const stores = [mod.VoiceStateStore, mod.SpeakingStore, mod.SelectedChannelStore, mod.MediaEngineStore, mod.StageInstanceStore].filter(Boolean);
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
        ringOthers(cmd);
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
    // A gain per person: the client's own volume and mute for them (its <audio> elements, which the bridge does not hear).
    const gain = call.ctx.createGain();
    src.connect(gain);
    gain.connect(call.mix);
    gain.connect(call.mixMeter);
    sinks.set(track, { el, src, gain });
    mixed.add(track);
    regainTrack(track);
    track.addEventListener('ended', () => {
      try {
        src.disconnect();
        gain.disconnect();
      } catch (e) {}
      mixed.delete(track);
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
      const emoji = byTopEmoji(id, (store.getGuildEmoji(id) || []).filter(usable).map((e) => ({ id: e.id, name: e.name, animated: !!e.animated })));
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
  const pickRole = (r) => ({ id: r.id, name: r.name, color: r.colorString || hexColor(r.color) || null, position: Number(r.position) || 0, hoist: !!r.hoist, ...(r.managed ? { managed: true } : {}) });

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
  const PATCHABLE = { channel: ['name', 'topic', 'rate_limit_per_user', 'nsfw', 'default_auto_archive_duration', 'user_limit', 'bitrate'], guild: ['name', 'description', 'icon'] };
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
    const out = { selfId, ...profileParts(who, body), ...relationshipOf(who), custom_status: customStatus(who), ...(await profileExtras(who, body)) };
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
    // A voice message, as the client's recorder sends one: no text, the flag, and the length and waveform on its file.
    if (cmd.voice && attachments.length === 1) Object.assign(attachments[0], { duration_secs: cmd.voice.duration_secs, waveform: cmd.voice.waveform });
    const body = { content: cmd.voice ? '' : cmd.content, nonce: cmd.nonce, tts: false, channel_id: cmd.channelId, type: 0, sticker_ids: [], attachments, ...restSendFields(cmd) };
    if (cmd.voice) body.flags = (body.flags || 0) | IS_VOICE_MESSAGE;
    if (cmd.replyTo) body.message_reference = { channel_id: cmd.channelId, message_id: cmd.replyTo };
    const res = await rest('post', `/channels/${cmd.channelId}/messages`, undefined, body);
    return { nativeId: res && res.body ? res.body.id : null, nonce: cmd.nonce };
  }

  async function sendMessage(cmd) {
    if (cmd.files && cmd.files.length) return sendWithFiles(cmd);
    if (cmd.stickerIds && cmd.stickerIds.length) return sendStickers(cmd);
    const ma = mod.MessageActions;
    if (ma && ma.sendMessage) {
      const options = { nonce: cmd.nonce, ...(cmd.replyTo ? { messageReference: { channel_id: cmd.channelId, message_id: cmd.replyTo } } : {}), ...sendOptionsOf(cmd) };
      // false: by default this waits for the channel to load, which only happens once it is on screen.
      const res = await ma.sendMessage(cmd.channelId, { content: cmd.content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, false, options);
      return { nativeId: res && res.body ? res.body.id : null, nonce: cmd.nonce };
    }
    const body = { content: cmd.content, nonce: cmd.nonce, tts: false, ...restSendFields(cmd) };
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
    if (cmd.mine) return myArchivedThreads(cmd);
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
    // Each thread's first and latest message come with the page, as the client's forum view shows them.
    return { threads: list, more: !!body.has_more, messages: threadMessages(body) };
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

  // ------------------------------------------------------------------ mentions
  // Who a channel can ping, for the composer's @ list (src/mentionables.ts). From the client's stores: a DM's or a
  // group's recipients; in a server, who wrote in the channel lately (nothing typed), else the loaded members whose
  // names hold the letters typed and those the client's own member search finds for them (op 8, at most 10, as its @
  // list asks), each only if their roles and the channel's overwrites let them see it; the roles that may be pinged;
  // and whether this account may write @everyone. It goes only into the answer: never out as members or people.
  const PERM_VIEW_CHANNEL = 1n << 10n;
  const PERM_MENTION_EVERYONE = 1n << 17n;
  const PERM_ADMINISTRATOR = 1n << 3n;
  /** How long the member search may take before the answer goes without it. */
  const MENTION_SEARCH_WAIT = 1000;
  /** At most this many people go back; the adapter ranks and cuts them. */
  const MENTION_CAP = 60;

  const permOf = (v) => {
    try {
      return v === undefined || v === null ? 0n : typeof v === 'bigint' ? v : BigInt(String(v));
    } catch (e) {
      return 0n;
    }
  };
  const sentAt = (id) => {
    try {
      return Number((BigInt(id) >> 22n) + 1420070400000n);
    } catch (e) {
      return 0;
    }
  };

  /** Who wrote in a channel among the messages the client holds, newest first: user id -> when. */
  function channelSpeakers(channelId) {
    const out = new Map();
    let list = [];
    try {
      const ms = mod.MessageStore && mod.MessageStore.getMessages(channelId);
      list = ms ? (typeof ms.toArray === 'function' ? ms.toArray() : Array.isArray(ms._array) ? ms._array : []) : [];
    } catch (e) {}
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const id = m && m.author && m.author.id;
      if (id && !out.has(id)) out.set(id, sentAt(m.id));
    }
    return out;
  }

  /** A server's roles as the client holds them, with their permissions. */
  function serverRoles(g) {
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
    return (Array.isArray(roles) ? roles : Object.values(roles || {})).filter((r) => r && r.id);
  }

  /**
   * Whether someone can see a server channel, worked out as Discord does from the roles and overwrites the client
   * holds (a thread by its parent's): true, false, or null when the client does not hold them as a member.
   */
  function canSee(g, perms, channel, userId) {
    if ((g.ownerId ?? g.owner_id) === userId) return true;
    let member = null;
    try {
      member = mod.GuildMemberStore && mod.GuildMemberStore.getMember(g.id, userId);
    } catch (e) {}
    if (!member) return null;
    const mine = new Set(Array.isArray(member.roles) ? member.roles : []);
    let p = perms.get(g.id) || 0n;
    for (const id of mine) p |= perms.get(id) || 0n;
    if (p & PERM_ADMINISTRATOR) return true;
    const parentId = channel.parent_id ?? channel.parentId;
    const target = (THREAD_TYPES.includes(channel.type) && parentId && mod.ChannelStore.getChannel(parentId)) || channel;
    const ow = target.permissionOverwrites ?? target.permission_overwrites;
    const list = (Array.isArray(ow) ? ow : Object.values(ow || {})).filter((o) => o && o.id);
    const apply = (o) => o && (p = (p & ~permOf(o.deny)) | permOf(o.allow));
    apply(list.find((o) => o.id === g.id));
    let allow = 0n;
    let deny = 0n;
    for (const o of list)
      if (o.id !== g.id && mine.has(o.id)) {
        allow |= permOf(o.allow);
        deny |= permOf(o.deny);
      }
    p = (p & ~deny) | allow;
    apply(list.find((o) => o.id === userId));
    return (p & PERM_VIEW_CHANNEL) !== 0n;
  }

  async function mentionables(cmd) {
    const channel = mod.ChannelStore.getChannel(String(cmd.channelId));
    if (!channel) throw new Error('this account cannot see that channel');
    const me = currentUser();
    const selfId = (me && me.id) || null;
    const query = String(cmd.query || '')
      .replace(/^@+/, '')
      .trim()
      .toLowerCase();
    const guildId = channel.guild_id ?? channel.guildId ?? null;
    const g = guildId ? guildOf(guildId) : null;
    const spoke = channelSpeakers(channel.id);
    const perms = g ? new Map(serverRoles(g).map((r) => [r.id, permOf(r.permissions)])) : null;
    const found = new Map();
    const add = (u, nick) => {
      const user = pickUser(u);
      if (!user || !user.id || user.id === selfId || found.has(user.id) || found.size >= MENTION_CAP) return;
      const names = [nick, user.global_name, user.username];
      if (query && !names.some((n) => typeof n === 'string' && n.toLowerCase().includes(query))) return;
      if (g && canSee(g, perms, channel, user.id) === false) return;
      found.set(user.id, { user, nick: nick || null });
    };
    const answer = (roles, everyone) => ({ people: [...found.values()].map((x) => ({ ...x, lastSpoke: spoke.get(x.user.id) || undefined })), roles, everyone });
    if (!g) {
      for (const r of Array.isArray(channel.recipients) ? channel.recipients : []) add(typeof r === 'string' ? mod.UserStore.getUser(r) : r, null);
      return answer([], false);
    }
    for (const id of spoke.keys()) add(mod.UserStore.getUser(id), nickOf(g.id, id));
    if (query) {
      let members = [];
      try {
        const gm = mod.GuildMemberStore;
        if (gm && typeof gm.getMembers === 'function') members = gm.getMembers(g.id) || [];
      } catch (e) {}
      for (const m of Array.isArray(members) ? members : Object.values(members)) {
        const id = m && (m.userId ?? (m.user && m.user.id));
        if (id) add(mod.UserStore.getUser(id), m.nick);
      }
      // The client's own member search, as its @ list runs it; its chunks are the walk's, never passed on as seen.
      const net = await Promise.race([walkMembers({ guildId: g.id, query, limit: 10 }).catch(() => null), new Promise((r) => setTimeout(() => r(null), MENTION_SEARCH_WAIT))]);
      for (const m of (net && net.members) || []) add(m.user, m.nick);
    }
    let everyone = false;
    try {
      everyone = !!mod.PermissionStore && mod.PermissionStore.can(PERM_MENTION_EVERYONE, channel) === true;
    } catch (e) {}
    const roles = serverRoles(g)
      .filter((r) => r.id !== g.id && typeof r.name === 'string' && (everyone || r.mentionable) && (!query || r.name.toLowerCase().includes(query)))
      .sort((a, b) => (Number(b.position) || 0) - (Number(a.position) || 0))
      .slice(0, 25)
      .map((r) => ({ id: r.id, name: r.name, color: r.colorString || hexColor(r.color) || null }));
    return answer(roles, everyone);
  }

  async function rest(verb, url, query, body) {
    const r = mod.Rest;
    if (!r || typeof r[verb] !== 'function') throw new Error('REST module unavailable (' + verb + ')');
    const res = await r[verb]({ url, query, body });
    return res;
  }

  // ---------------------------------------------------------------- attention
  // Mentions in places the client had not loaded, the notification center, message requests and spam, notification
  // settings as they change and as the owner changes them from the app, marking unread and many read (the app's
  // docs/research/discord-gaps.md, "Mentions, inbox, notifications"; the adapter's attention.ts). Everything goes
  // through the client's own modules and actions, as a click in it would, or its own REST helper where a module is
  // in a chunk not loaded yet. Read from build 671535 (2026-11-12); the client's source is read, never run.
  Object.assign(FINDERS, {
    // Its Inbox's Mentions tab: fetchRecentMentions GETs /users/@me/mentions and dispatches LOAD_RECENT_MENTIONS_SUCCESS.
    RecentMentionsActions: (m) => typeof m.fetchRecentMentions === 'function' && typeof m.deleteRecentMention === 'function',
    // Its notification settings menus: mute a server, a channel or a DM, with a timer.
    NotificationSettingsActions: (m) => typeof m.updateGuildNotificationSettings === 'function' && typeof m.updateChannelOverrideSettings === 'function',
    // Its message request buttons (a lazy chunk: found once the owner opened requests in the live view, else REST).
    MessageRequestActions: (m) => !!exportedFn(m, 8, isRequestAccept),
  });
  function isRequestAccept(f) {
    const src = Function.prototype.toString.call(f);
    return /MESSAGE_REQUEST_ACCEPT_OPTIMISTIC/.test(src) && /consent_status/.test(src);
  }
  function isRequestReject(f) {
    return /CHANNEL_RECIPIENT_REJECT_BATCH/.test(Function.prototype.toString.call(f));
  }

  FORWARD.push(
    // What the client's Mentions tab loaded, whoever asked (the adapter, or the owner in the live view).
    'LOAD_RECENT_MENTIONS_SUCCESS',
    // The notification center: someone mentioned you, replied, an event started, a friend accepted.
    'NOTIFICATION_CENTER_ITEM_CREATE',
    // Someone reacted to your message, wherever it is.
    'REACTION_NOTIFICATION_SENT',
    // Notification settings, changed here, in another app, or a mute running out.
    'USER_GUILD_SETTINGS_FULL_UPDATE',
    'USER_GUILD_SETTINGS_GUILD_UPDATE',
    'USER_GUILD_SETTINGS_CHANNEL_UPDATE',
    'USER_GUILD_SETTINGS_CHANNEL_UPDATE_BULK',
    'USER_GUILD_SETTINGS_GUILD_AND_CHANNELS_UPDATE',
    'CHANNEL_MUTE_EXPIRED',
    'GUILD_MUTE_EXPIRED',
    // A message request accepted here or in another app.
    'MESSAGE_REQUEST_ACCEPT_OPTIMISTIC',
  );

  /** A DM's request and spam flags, as the client's channel record has them (camelCase) or the API (snake_case). */
  function attentionChannelFields(c) {
    if (!c || (c.type !== 1 && c.type !== 3)) return undefined;
    const request = c.isMessageRequest ?? c.is_message_request;
    const spam = c.isSpam ?? c.is_spam;
    const since = c.isMessageRequestTimestamp ?? c.is_message_request_timestamp;
    const out = {};
    if (typeof request === 'boolean') out.is_message_request = request;
    if (since) out.is_message_request_timestamp = isoOf(since);
    if (typeof spam === 'boolean') out.is_spam = spam;
    return out;
  }

  /** What a guild's settings add beyond mutes: @everyone and role mentions suppressed. */
  function attentionSettingFields(s) {
    const everyone = s.suppressEveryone ?? s.suppress_everyone;
    const roles = s.suppressRoles ?? s.suppress_roles;
    return { ...(typeof everyone === 'boolean' ? { suppress_everyone: everyone } : {}), ...(typeof roles === 'boolean' ? { suppress_roles: roles } : {}) };
  }

  const ME = '@me';
  const guildKey = (id) => (id == null || id === ME ? null : String(id));

  /**
   * One server's notification settings (or the DMs', null) as the store has them now, and every channel they could
   * name: the server's channels, or every DM. A subscriber hears an action once the store took it in.
   */
  function settingsNow(guildId) {
    const all = guildSettings().filter((s) => guildKey(s.guild_id) === guildId);
    const channels = guildId === null ? (Object.values((mod.ChannelStore.getMutablePrivateChannels && mod.ChannelStore.getMutablePrivateChannels()) || {}).map(pickChannel)) : guildChannels(guildId);
    const guild = guildId === null ? null : pickGuild(guildOf(guildId));
    return { guildId, settings: all[0] || { guild_id: guildId, muted: false, channel_overrides: [] }, channels: channels.filter(Boolean), guild };
  }

  function attentionShrink(event, a) {
    switch (event) {
      case 'LOAD_RECENT_MENTIONS_SUCCESS': {
        const messages = (Array.isArray(a.messages) ? a.messages : []).map(pickMessage).filter((m) => m && m.id && m.channel_id && m.author);
        if (!messages.length) return null;
        return { messages, channels: channelsOf(messages) };
      }
      case 'NOTIFICATION_CENTER_ITEM_CREATE': {
        const item = a.item || {};
        const message = item.message ? pickMessage(item.message) : null;
        return { id: String(item.id ?? ''), type: String(item.type ?? ''), other_user: item.other_user ? pickUser(item.other_user) : null, message: message && message.id ? message : null, channels: message && message.id ? channelsOf([message]) : [] };
      }
      case 'REACTION_NOTIFICATION_SENT': {
        const m = a.message || {};
        const channelId = m.channel_id ?? m.channelId;
        if (!m.id || !channelId || !a.reactorUserId || !a.emoji) return null;
        return { channelId: String(channelId), messageId: String(m.id), userId: String(a.reactorUserId), user: resolveUser(String(a.reactorUserId)), emoji: pickEmoji(a.emoji) };
      }
      case 'USER_GUILD_SETTINGS_FULL_UPDATE': {
        // Every server whose settings came: each with its channels.
        const ids = new Set((Array.isArray(a.userGuildSettings) ? a.userGuildSettings : []).map((s) => guildKey(s && (s.guild_id ?? s.guildId))));
        return { changes: [...ids].map(settingsNow) };
      }
      case 'USER_GUILD_SETTINGS_GUILD_UPDATE':
      case 'USER_GUILD_SETTINGS_CHANNEL_UPDATE':
      case 'USER_GUILD_SETTINGS_CHANNEL_UPDATE_BULK':
      case 'USER_GUILD_SETTINGS_GUILD_AND_CHANNELS_UPDATE':
      case 'CHANNEL_MUTE_EXPIRED':
      case 'GUILD_MUTE_EXPIRED':
        return { changes: [settingsNow(guildKey(a.guildId ?? a.guild_id))] };
      case 'MESSAGE_REQUEST_ACCEPT_OPTIMISTIC':
        return a.channelId ? { channelId: String(a.channelId) } : null;
      default:
        return {};
    }
  }

  /** The channels these messages are in, as the client has them (a thread nobody opened is known only so). */
  function channelsOf(messages) {
    const out = [];
    for (const id of new Set(messages.map((m) => m.channel_id))) {
      try {
        const c = pickChannel(mod.ChannelStore.getChannel(id));
        if (c) out.push(c);
      } catch (e) {}
    }
    return out;
  }

  /**
   * Recent mentions, as the client's Mentions tab loads them: its own action, whose answer the subscription above
   * hears and passes on. Without that module, the same request through its REST helper, answered here.
   */
  async function recentMentions(cmd) {
    const limit = Math.max(1, Math.min(50, Number(cmd.limit) || 25));
    const ra = mod.RecentMentionsActions;
    if (ra) {
      await ra.fetchRecentMentions({ limit, roles: true, everyone: true, guildId: null });
      return { via: 'actions' };
    }
    const res = await rest('get', '/users/@me/mentions', { limit, roles: true, everyone: true });
    const messages = ((res && res.body) || []).map(pickMessage).filter((m) => m && m.id && m.channel_id && m.author);
    return { via: 'rest', messages, channels: channelsOf(messages) };
  }

  /**
   * Mute or unmute a server, category, channel or DM, as the client's notification menus do, then the settings as the
   * store has them. A mute with no end lasts until it is turned off (-1, as the client's "Until I turn it back on").
   */
  async function muteCommand(cmd) {
    const id = String(cmd.id || '');
    if (!USER_ID.test(id)) throw new Error('That is not a Discord id');
    const guild = cmd.target === 'space' ? guildOf(id) : null;
    const channel = guild ? null : mod.ChannelStore.getChannel(id);
    if (!guild && !channel) throw new Error('This client does not have that place');
    const until = typeof cmd.until === 'number' && cmd.until > Date.now() ? cmd.until : null;
    const settings = cmd.muted ? { muted: true, mute_config: { selected_time_window: until ? Math.round((until - Date.now()) / 1000) : -1, end_time: until ? new Date(until).toISOString() : null } } : { muted: false };
    const guildId = guild ? guild.id : guildKey(channel.guild_id ?? channel.guildId);
    const na = mod.NotificationSettingsActions;
    if (na) {
      if (guild) na.updateGuildNotificationSettings(guild.id, settings);
      else na.updateChannelOverrideSettings({ guildId, channelId: id, settings });
    } else {
      // The same PATCH its settings store sends; the gateway's settings update follows.
      const body = guild ? settings : { channel_overrides: { [id]: settings } };
      await rest('patch', `/users/@me/guilds/${guildId ?? ME}/settings`, undefined, body);
    }
    const mutedNow = () => {
      const s = settingsNow(guildId).settings;
      const o = guild ? s : (s.channel_overrides || []).find((x) => x.channel_id === id) || { muted: false };
      return !!o.muted === !!cmd.muted ? s : null;
    };
    const s = (await landed(mutedNow, 5000)) || settingsNow(guildId).settings;
    return { guildId, settings: s, channel: channel ? pickChannel(channel) : null, guild: guild ? pickGuild(guild) : null };
  }

  /** Unread from a message on: the client's "Mark Unread", a manual ack of the message before it. */
  async function markUnread(cmd) {
    if (!USER_ID.test(String(cmd.channelId)) || !USER_ID.test(String(cmd.messageId))) throw new Error('That is not a Discord id');
    await rest('post', `/channels/${cmd.channelId}/messages/${cmd.messageId}/ack`, undefined, { manual: true, mention_count: 0 });
    return { ok: true };
  }

  /** Many channels read at once, as the client's "Mark as Read" on a server or folder: its BULK_ACK, which posts them 100 at a time. */
  async function markReadMany(cmd) {
    const channels = (Array.isArray(cmd.items) ? cmd.items : []).filter((x) => x && USER_ID.test(String(x.channelId)) && USER_ID.test(String(x.messageId))).map((x) => ({ channelId: String(x.channelId), messageId: String(x.messageId), readStateType: 0 }));
    if (!channels.length) return { marked: 0 };
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 15_000);
      mod.Dispatcher.dispatch({ type: 'BULK_ACK', channels, context: 'APP', onFinished: () => (clearTimeout(t), resolve()) });
    });
    return { marked: channels.length };
  }

  /** A message request answered as the client's request buttons do: accept, or reject; block is the friends module's, then reject. */
  async function messageRequestAnswer(cmd) {
    const id = String(cmd.channelId || '');
    if (!USER_ID.test(id)) throw new Error('That is not a Discord id');
    const c = mod.ChannelStore.getChannel(id);
    if (!c || !(c.isMessageRequest || c.isSpam)) throw new Error('That request is not waiting any more');
    const actions = mod.MessageRequestActions;
    const fn = (test) => (actions ? Object.values(actions).find((f) => typeof f === 'function' && test(f)) : null);
    if (cmd.answer === 'accept') {
      const accept = fn(isRequestAccept);
      if (accept) await accept(id);
      else {
        await rest('put', `/channels/${id}/recipients/@me`, undefined, { consent_status: 2 });
        mod.Dispatcher.dispatch({ type: 'MESSAGE_REQUEST_ACCEPT_OPTIMISTIC', channelId: id });
      }
      return { ok: true };
    }
    if (cmd.answer === 'block') {
      const ra = needModule('RelationshipActions', 'friends module');
      const userId = Array.isArray(c.recipients) ? String(typeof c.recipients[0] === 'string' ? c.recipients[0] : (c.recipients[0] && c.recipients[0].id) || '') : '';
      if (!USER_ID.test(userId)) throw new Error('Who sent it is not known here');
      await clientAction(ra, 'addRelationship', { userId, context: { location: FRIENDS_CONTEXT }, type: 2 }, [userId, { location: FRIENDS_CONTEXT }, 2]);
    } else if (cmd.answer !== 'decline') throw new Error('Accept, decline or block?');
    const reject = fn(isRequestReject);
    if (reject) await reject([id]);
    else await rest('put', '/channels/recipients/@me/batch-reject', undefined, { channel_ids: [id] });
    return { ok: true };
  }

  const ATTENTION_COMMANDS = { recentMentions, mute: muteCommand, markUnread, markReadMany, messageRequestAnswer };

  // ------------------------------------------------------------ bots and apps
  // A bot's buttons and selects, its slash commands, and the forms it opens in answer (the chat hub's docs/apps.md;
  // the adapter's interact.ts). Each goes through the client's own code, as a click in it would: its component executor
  // (it makes the nonce and sends the session, the message's flags and the application id itself), its command index
  // store (each place's index loaded once, as typing a slash loads it, its permission checks applied), its command
  // executor (options parsed and checked as the client does, autocomplete through the same path), and for a form, which
  // the client sends only from inside its own dialog, its interaction queue, nonce, session and REST helper with the
  // body that dialog builds. One request per command, and the hub sends one per click of the owner's: nothing here
  // retries, presses or runs anything by itself. Read from build 671535 (2026-11-12); the client's source is read,
  // never run.
  Object.assign(FINDERS, {
    // executeMessageComponentInteraction: what a click on a button or a choice in a select runs.
    ComponentInteract: (m) => !!exportedFn(m, 12, isComponentExecutor),
    // executeCommand: what Enter on a slash command, and its autocomplete, run.
    CommandExecute: (m) => !!exportedFn(m, 4, isCommandExecutor),
    CommandIndexStore: isStore('ApplicationCommandIndexStore'),
    AutocompleteStore: isStore('ApplicationCommandAutocompleteStore'),
    // queueInteraction and its failure: what the client's form dialog calls around its submit.
    InteractionQueue: (m) => !!exportedFn(m, 6, isInteractionQueue),
    Snowflakes: (m) => typeof m.fromTimestamp === 'function' && typeof m.extractTimestamp === 'function',
  });
  function isComponentExecutor(f) {
    const s = fnSource(f);
    return s.includes('MESSAGE_COMPONENT') && s.includes('message_flags') && s.includes('canQueueInteraction');
  }
  function isCommandExecutor(f) {
    const s = fnSource(f);
    return s.includes('APPLICATION_COMMAND_USED') && s.includes('optionValues') && s.includes('subCommandPath');
  }
  function isInteractionQueue(f) {
    const s = fnSource(f);
    return s.includes('INTERACTION_QUEUE') && s.includes('preflight');
  }
  function isInteractionFailure(f) {
    const s = fnSource(f);
    return s.includes('INTERACTION_FAILURE') && s.includes('errorMessage');
  }
  // Discord's numbers: interaction types, component types, command types.
  const IX = { COMMAND: 2, COMPONENT: 3, MODAL_SUBMIT: 5 };
  const CT = { ROW: 1, BUTTON: 2, STRING_SELECT: 3, TEXT_INPUT: 4, USER_SELECT: 5, ROLE_SELECT: 6, MENTIONABLE_SELECT: 7, CHANNEL_SELECT: 8, SECTION: 9, TEXT_DISPLAY: 10, CONTAINER: 17, LABEL: 18, FILE_UPLOAD: 19, RADIO_GROUP: 21, CHECKBOX_GROUP: 22, CHECKBOX: 23 };
  const COMMAND_TYPE = { chat: 1, user: 2, message: 3 };
  const OPTION_TYPE = { 3: 'string', 4: 'integer', 5: 'boolean', 6: 'user', 7: 'channel', 8: 'role', 9: 'mentionable', 10: 'number', 11: 'attachment' };
  // The client's context menu origin, for a message command (its CHAT origin is the default).
  const CONTEXT_MENU_ORIGIN = 5;
  /** How long an interaction waits for any word back before it is said to have timed out. */
  const IX_WAIT_MS = 15_000;
  /** A form can be sent this long after it opened (Discord's interaction tokens). */
  const IX_KEEP_MS = 15 * 60_000;
  const IX_INDEX_WAIT_MS = 10_000;
  const IX_SUGGEST_WAIT_MS = 3500;

  /** Interactions sent from here, by nonce, while their outcome is awaited. */
  const ixPending = new Map();
  /** Every interaction sent from here in the last IX_KEEP_MS (a form may open after it was answered). */
  const ixKnown = new Map();
  /** Forms bots opened for them, by their id, as the client's action had them. */
  const ixForms = new Map();
  /** What the next INTERACTION_QUEUE of ours looks like, while one of the client's functions runs. */
  let ixArm = null;
  let ixSuggestArm = null;
  const ixSuggestWait = new Map();
  const ixIndexWait = new Set();
  /** Messages with components heard live, for a press on one the message store no longer holds. */
  const ixSeen = new Map();

  function ixForget(now) {
    for (const [n, k] of ixKnown) if (now - k.at > IX_KEEP_MS) ixKnown.delete(n);
    for (const [id, f] of ixForms) if (now - f.at > IX_KEEP_MS) ixForms.delete(id);
  }
  function ixTrack(nonce, channelId, messageId) {
    const now = Date.now();
    ixForget(now);
    ixKnown.set(nonce, { channelId, messageId, at: now });
    const timer = setTimeout(() => ixOutcome(nonce, 'timedOut'), IX_WAIT_MS);
    ixPending.set(nonce, { channelId, messageId, timer });
    ixOutcome(nonce, 'sending');
  }
  function ixOutcome(nonce, state, error) {
    const p = ixPending.get(nonce);
    if (!p) return;
    if (state !== 'sending') {
      clearTimeout(p.timer);
      ixPending.delete(nonce);
    }
    up({ t: 'dispatch', event: 'INTERACTION_OUTCOME', data: { nonce, channelId: p.channelId, messageId: p.messageId || null, state, ...(error ? { error: String(error).slice(0, 300) } : {}) } });
  }
  function ixError(a) {
    const msg = str(a.errorMessage);
    return msg || 'This interaction failed';
  }

  function subscribeInteractions() {
    const d = mod.Dispatcher;
    if (!d) return;
    const on = (ev, fn) => {
      try {
        d.subscribe(ev, (a) => {
          try {
            fn(a || {});
          } catch (e) {}
        });
      } catch (e) {
        log('warn', 'subscribe failed for ' + ev, String(e));
      }
    };
    on('INTERACTION_QUEUE', (a) => {
      if (!ixArm || ixArm.nonce || a.nonce == null || !ixArm.match(a)) return;
      ixArm.nonce = String(a.nonce);
      ixTrack(ixArm.nonce, ixArm.channelId, ixArm.messageId);
    });
    on('INTERACTION_SUCCESS', (a) => a.nonce != null && ixOutcome(String(a.nonce), 'answered'));
    on('INTERACTION_FAILURE', (a) => {
      if (a.nonce == null) return;
      ixOutcome(String(a.nonce), 'failed', ixError(a));
      ixSuggested(String(a.nonce), null);
    });
    on('MESSAGE_CREATE', (a) => {
      const m = a.message;
      if (m && Array.isArray(m.components) && m.components.length && !a.optimistic) ixRemember(m);
      // The bot's answer carries the interaction's nonce; the client's own placeholder for it (optimistic) does not count.
      if (m && m.nonce != null && !a.optimistic && String(m.id) !== String(m.nonce)) ixOutcome(String(m.nonce), 'answered');
    });
    on('MESSAGE_UPDATE', (a) => {
      const m = a.message;
      if (m && Array.isArray(m.components) && m.components.length) ixRemember(m);
    });
    on('INTERACTION_MODAL_CREATE', (a) => ixForm(a));
    on('INTERACTION_IFRAME_MODAL_CREATE', (a) => a.nonce != null && ixOutcome(String(a.nonce), 'failed', 'The app opened a page of its own, which only Discord shows: answer it there'));
    on('APPLICATION_COMMAND_AUTOCOMPLETE_REQUEST', (a) => {
      if (ixSuggestArm && !ixSuggestArm.nonce && a.channelId === ixSuggestArm.channelId && a.name === ixSuggestArm.name) ixSuggestArm.nonce = String(a.nonce);
    });
    on('APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE', (a) => a.nonce != null && ixSuggested(String(a.nonce), Array.isArray(a.choices) ? a.choices : []));
    const indexDone = () => {
      for (const w of [...ixIndexWait]) w();
    };
    on('APPLICATION_COMMAND_INDEX_FETCH_SUCCESS', indexDone);
    on('APPLICATION_COMMAND_INDEX_FETCH_FAILURE', indexDone);
  }

  function ixRemember(m) {
    const p = pickMessage(m);
    if (!p || !p.id) return;
    ixSeen.delete(p.id);
    ixSeen.set(p.id, { flags: p.flags, application_id: p.application_id, components: p.components, channel_id: p.channel_id });
    while (ixSeen.size > 300) ixSeen.delete(ixSeen.keys().next().value);
  }

  function ixPlace(channelId) {
    const channel = mod.ChannelStore.getChannel(channelId);
    if (!channel) throw new Error('Discord does not have this channel');
    const gid = channel.guild_id ?? channel.guildId ?? null;
    return { channel, guild: gid ? guildOf(gid) : null, guildId: gid };
  }

  /**
   * The component with this custom id in a message's tree, and its path (the client's component id is the path of
   * indexes joined by commas: a section's accessory comes after its texts, a label's field is its 0th).
   */
  function ixFind(list, customId, path) {
    if (!Array.isArray(list)) return null;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || typeof c !== 'object') continue;
      const here = path.concat([i]);
      if ((c.customId ?? c.custom_id) === customId && c.type !== CT.ROW) return { c, id: typeof c.id === 'string' ? c.id : here.join(',') };
      const kids = Array.isArray(c.components) ? c.components : [];
      const inner = ixFind(kids, customId, here);
      if (inner) return inner;
      const acc = c.accessory;
      if (acc && (acc.customId ?? acc.custom_id) === customId) return { c: acc, id: typeof acc.id === 'string' ? acc.id : here.concat([kids.length]).join(',') };
      if (c.component) {
        const f = ixFind([c.component], customId, here);
        if (f) return f;
      }
    }
    return null;
  }

  /** The message as the client has it, else as it was heard, else read once around it (as jumping to it would). */
  async function ixMessage(channelId, messageId) {
    let rec = null;
    try {
      rec = mod.MessageStore && mod.MessageStore.getMessage(channelId, messageId);
    } catch (e) {}
    if (rec && Array.isArray(rec.components) && rec.components.length) return { components: rec.components, flags: num(rec.flags) ?? 0, applicationId: str(rec.applicationId ?? rec.application_id) };
    const seen = ixSeen.get(messageId);
    if (seen && seen.channel_id === channelId) return { components: seen.components, flags: num(seen.flags) ?? 0, applicationId: str(seen.application_id) };
    const res = await rest('get', `/channels/${channelId}/messages`, { around: messageId, limit: 1 });
    const raw = ((res && res.body) || []).find((x) => x && String(x.id) === messageId);
    if (!raw) throw new Error('Discord no longer has this message');
    const p = pickMessage(raw);
    return { components: p.components, flags: num(p.flags) ?? 0, applicationId: str(p.application_id) };
  }

  /** Press a button, or choose in a select (`values`). */
  async function ixComponent(cmd) {
    const exec = exportedFn(mod.ComponentInteract || {}, 12, isComponentExecutor);
    if (!exec) throw new Error("Pressing isn't available: the hook did not find Discord's own module for it (Discord changed?)");
    const { guildId } = ixPlace(cmd.channelId);
    const msg = await ixMessage(cmd.channelId, cmd.messageId);
    const hit = ixFind(msg.components, cmd.customId, []);
    if (!hit) throw new Error('This message no longer has that control');
    const c = hit.c;
    const type = c.type;
    if (c.disabled) throw new Error('The bot turned this off');
    if (!msg.applicationId) throw new Error('This message is not from a bot');
    const values = Array.isArray(cmd.values) ? cmd.values.map(String) : null;
    if (type === CT.BUTTON) {
      if (values) throw new Error('A button takes no values');
      if (c.url || c.style === 5 || c.style === 6) throw new Error('This button is not pressed from here');
    } else if (type >= CT.STRING_SELECT && type <= CT.CHANNEL_SELECT && type !== CT.TEXT_INPUT) {
      if (!values) throw new Error('Choose something first');
    } else throw new Error('This control is not pressed from here');
    // As the client's selects hand it their state: a string select its values, the others the options picked.
    const localState = values ? (type === CT.STRING_SELECT ? { type, values } : { type, selectedOptions: values.map((v) => ({ value: v })) }) : null;
    let nonce = null;
    ixArm = { channelId: cmd.channelId, messageId: cmd.messageId, nonce: null, match: (a) => String(a.messageId) === cmd.messageId && !!a.data && a.data.customId === cmd.customId };
    try {
      await exec({ componentType: type, messageId: cmd.messageId, messageFlags: msg.flags, customId: cmd.customId, componentId: hit.id, applicationId: msg.applicationId, channelId: cmd.channelId, guildId: guildId ?? undefined, localState });
    } finally {
      nonce = ixArm && ixArm.nonce;
      ixArm = null;
    }
    if (!nonce) throw new Error('Discord did not send it: the last press on this message is still waiting for the bot');
    return { nonce };
  }

  // ------------------------------------------------------------ commands
  function ixQuery(channel, kind, allowFetch) {
    return mod.CommandIndexStore.query({ type: 'channel', channel }, { commandTypes: [COMMAND_TYPE[kind] || 1], builtIns: 'deny' }, { placeholderCount: 0, scoreMethod: 'command_only', allowFetch, allowApplicationState: false });
  }
  /** The place's commands as the client's slash list has them: its index loaded once if it has none yet, then kept. */
  async function ixCommandsOf(channel, kind) {
    if (!mod.CommandIndexStore) throw new Error("Slash commands aren't available: the hook did not find Discord's own command list (Discord changed?)");
    let res = ixQuery(channel, kind, true);
    const until = Date.now() + IX_INDEX_WAIT_MS;
    while (res && res.loading && Date.now() < until) {
      await new Promise((resolve) => {
        const done = () => {
          ixIndexWait.delete(done);
          resolve();
        };
        ixIndexWait.add(done);
        setTimeout(done, 1500);
      });
      res = ixQuery(channel, kind, false);
    }
    return res || { commands: [], descriptors: [] };
  }
  function ixIcon(d) {
    const icon = str(d && (d.icon ?? (d.application && d.application.icon)));
    if (!icon) return undefined;
    if (/^https:\/\//.test(icon)) return icon;
    if (/^[a-f0-9_]+$/i.test(icon) && d.id) return `https://cdn.discordapp.com/app-icons/${d.id}/${icon}.png?size=64`;
    return undefined;
  }
  const pickChoice = (ch) => ch && { name: str(ch.displayName ?? ch.name_localized ?? ch.name) ?? String(ch.value), value: typeof ch.value === 'number' ? ch.value : String(ch.value) };
  function pickCommandOption(o) {
    return {
      type: OPTION_TYPE[o.type] ?? null,
      name: String(o.name),
      description: str(o.displayDescription ?? o.description),
      required: o.required === true ? true : undefined,
      autocomplete: o.autocomplete === true ? true : undefined,
      choices: Array.isArray(o.choices) && o.choices.length ? o.choices.slice(0, 25).map(pickChoice).filter(Boolean) : undefined,
      min: num(o.minValue ?? o.min_value),
      max: num(o.maxValue ?? o.max_value),
      min_length: num(o.minLength ?? o.min_length),
      max_length: num(o.maxLength ?? o.max_length),
    };
  }
  function pickCommand(c) {
    return {
      id: String(c.id),
      name: String(c.untranslatedName ?? c.displayName ?? c.name),
      description: str(c.displayDescription ?? c.untranslatedDescription),
      app: str(c.applicationId),
      type: num(c.type) ?? 1,
      nsfw: c.nsfw === true ? true : undefined,
      options: (Array.isArray(c.options) ? c.options : []).slice(0, 25).map(pickCommandOption),
    };
  }
  function pickApp(d) {
    const bot = d.application && d.application.bot;
    return { id: String(d.id), name: str(d.name) ?? (d.application && str(d.application.name)) ?? 'An app', icon: ixIcon(d), bot: bot ? pickUser(bot) : d.botId ? resolveUser(String(d.botId)) || { id: String(d.botId) } : undefined };
  }
  /** Bot commands only: the client's own built-ins (its /nick, /me and the like) are left out. */
  const isBotCommand = (c) => c && c.inputType === 3 && typeof c.execute !== 'function' && !!c.applicationId;

  async function ixCommands(cmd) {
    const { channel } = ixPlace(cmd.channelId);
    const res = await ixCommandsOf(channel, cmd.commandKind || 'chat');
    const commands = (res.commands || []).filter(isBotCommand).slice(0, 500);
    const apps = new Set(commands.map((c) => String(c.applicationId)));
    return { commands: commands.map(pickCommand), apps: (res.descriptors || []).filter((d) => d && apps.has(String(d.id))).map(pickApp), loading: !!res.loading };
  }
  async function ixFindCommand(channel, kind, id, app) {
    const res = await ixCommandsOf(channel, kind);
    const c = (res.commands || []).find((x) => isBotCommand(x) && String(x.id) === id && (!app || String(x.applicationId) === app));
    if (!c) throw new Error('This command is not offered here any more');
    return c;
  }
  /** The owner's values as the client's composer hands them over: one node each, a mention where a native id was picked. */
  function ixOptionValues(c, given) {
    const out = {};
    for (const g of Array.isArray(given) ? given : []) {
      const o = (c.options || []).find((x) => x.name === g.name);
      if (!o) throw new Error(`/${c.untranslatedName} has no option ${g.name}`);
      const v = g.value;
      if (g.ref === 'user') out[o.name] = [{ type: 'userMention', userId: String(v) }];
      else if (g.ref === 'role') out[o.name] = [{ type: 'roleMention', roleId: String(v) }];
      else if (g.ref === 'channel') out[o.name] = [{ type: 'channelMention', channelId: String(v) }];
      else out[o.name] = [{ type: 'text', text: String(v) }];
    }
    return out;
  }

  /** Run a slash command (or, with `targetId`, a message or user command) through the client's executor. */
  async function ixRun(cmd) {
    const exec = exportedFn(mod.CommandExecute || {}, 4, isCommandExecutor);
    if (!exec) throw new Error("Running commands isn't available: the hook did not find Discord's own module for it (Discord changed?)");
    const { channel, guild } = ixPlace(cmd.channelId);
    const kind = cmd.commandKind || 'chat';
    const c = await ixFindCommand(channel, kind, cmd.commandId, cmd.app);
    if ((c.options || []).some((o) => o.type === 11 && o.required)) throw new Error('This command wants a file: run it on Discord');
    const optionValues = ixOptionValues(c, cmd.options);
    let nonce = null;
    ixArm = { channelId: cmd.channelId, messageId: null, nonce: null, match: (a) => !!a.data && a.data.interactionType === IX.COMMAND && String(a.data.applicationId) === String(c.applicationId) && String(a.data.channelId) === cmd.channelId };
    try {
      await exec({ command: c, optionValues, context: { channel, guild }, ...(cmd.targetId ? { commandTargetId: cmd.targetId, commandOrigin: CONTEXT_MENU_ORIGIN } : {}) });
    } finally {
      nonce = ixArm && ixArm.nonce;
      ixArm = null;
    }
    if (!nonce) throw new Error('Discord did not send it');
    return { nonce };
  }

  function ixSuggested(nonce, choices) {
    const w = ixSuggestWait.get(nonce);
    if (!w) return;
    ixSuggestWait.delete(nonce);
    w(choices);
  }
  const pickSuggestions = (list) => ({ choices: (list || []).slice(0, 25).map(pickChoice).filter(Boolean) });

  /** The app's suggestions for one option as the owner types, through the client's executor in its autocomplete mode. */
  async function ixSuggest(cmd) {
    const exec = exportedFn(mod.CommandExecute || {}, 4, isCommandExecutor);
    if (!exec) throw new Error("Suggestions aren't available: the hook did not find Discord's own module for them");
    const { channel, guild } = ixPlace(cmd.channelId);
    const c = await ixFindCommand(channel, 'chat', cmd.commandId, cmd.app);
    const o = (c.options || []).find((x) => x.name === cmd.focused);
    if (!o || !o.autocomplete) throw new Error('This option has no suggestions');
    const store = mod.AutocompleteStore;
    const cached = () => {
      try {
        return store ? store.getAutocompleteChoices(channel.id, cmd.focused, cmd.query) : null;
      } catch (e) {
        return null;
      }
    };
    const had = cached();
    if (had) return pickSuggestions(had);
    const given = (Array.isArray(cmd.options) ? cmd.options : []).filter((g) => g.name !== cmd.focused);
    const optionValues = { ...ixOptionValues(c, given), [cmd.focused]: [{ type: 'text', text: String(cmd.query) }] };
    let nonce = null;
    ixSuggestArm = { channelId: channel.id, name: cmd.focused, nonce: null };
    try {
      await exec({ command: c, optionValues, context: { channel, guild, autocomplete: { name: cmd.focused, query: String(cmd.query) } } });
    } finally {
      nonce = ixSuggestArm && ixSuggestArm.nonce;
      ixSuggestArm = null;
    }
    const now = cached();
    if (now) return pickSuggestions(now);
    if (!nonce) return { choices: [] };
    const raw = await new Promise((resolve) => {
      ixSuggestWait.set(nonce, resolve);
      setTimeout(() => ixSuggested(nonce, null), IX_SUGGEST_WAIT_MS);
    });
    if (raw === null) throw new Error('The app suggested nothing in time');
    return pickSuggestions(raw.map((x) => ({ name: x.name_localized ?? x.name, value: x.value })));
  }

  // ------------------------------------------------------------ forms
  const pickFieldOption = (o) => o && { label: str(o.label) ?? String(o.value), value: String(o.value), description: str(o.description), default: o.default === true ? true : undefined };
  const SELECT_OF = { 3: 'string', 5: 'user', 6: 'role', 7: 'mentionable', 8: 'channel' };
  /** The form's fields, flat, from the client's components: a label's text goes onto the field it holds. */
  function pickFields(list, label, description, out) {
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c !== 'object' || out.length >= 25) continue;
      const id = str(c.customId ?? c.custom_id);
      const lbl = label ?? str(c.label);
      const base = { ...(lbl ? { label: lbl } : {}), ...(description ? { description } : {}) };
      switch (c.type) {
        case CT.ROW:
          pickFields(c.components, undefined, undefined, out);
          break;
        case CT.LABEL:
          pickFields([c.component], str(c.label), str(c.description), out);
          break;
        case CT.TEXT_INPUT:
          out.push({ kind: 'text', id, ...base, style: c.style === 2 ? 'paragraph' : 'short', placeholder: str(c.placeholder), value: str(c.value), required: c.required === true ? true : undefined, minLength: num(c.minLength ?? c.min_length), maxLength: num(c.maxLength ?? c.max_length) });
          break;
        case CT.STRING_SELECT:
        case CT.USER_SELECT:
        case CT.ROLE_SELECT:
        case CT.MENTIONABLE_SELECT:
        case CT.CHANNEL_SELECT:
          out.push({ kind: 'select', id, ...base, select: SELECT_OF[c.type], options: Array.isArray(c.options) ? c.options.slice(0, 25).map(pickFieldOption).filter(Boolean) : undefined, placeholder: str(c.placeholder), min: num(c.minValues ?? c.min_values), max: num(c.maxValues ?? c.max_values), required: c.required === true ? true : undefined });
          break;
        case CT.RADIO_GROUP:
          out.push({ kind: 'radio', id, ...base, options: (Array.isArray(c.options) ? c.options : []).slice(0, 25).map(pickFieldOption).filter(Boolean), required: c.required === true ? true : undefined });
          break;
        case CT.CHECKBOX_GROUP:
          out.push({ kind: 'checkboxes', id, ...base, options: (Array.isArray(c.options) ? c.options : []).slice(0, 25).map(pickFieldOption).filter(Boolean), min: num(c.minValues ?? c.min_values), max: num(c.maxValues ?? c.max_values), required: c.required === true ? true : undefined });
          break;
        case CT.CHECKBOX:
          out.push({ kind: 'checkbox', id, ...base, default: c.default === true ? true : undefined });
          break;
        case CT.FILE_UPLOAD:
          out.push({ kind: 'file', id, ...base, required: c.required === true ? true : undefined });
          break;
        case CT.TEXT_DISPLAY:
          if (str(c.content)) out.push({ kind: 'display', text: c.content });
          break;
        default:
          out.push({ kind: 'display', text: 'A part of this form that is answered on Discord' });
      }
    }
    return out;
  }
  /** A form a bot opened: passed on only when it answers an interaction sent from here. */
  function ixForm(a) {
    if (a.nonce == null || a.id == null) return;
    const nonce = String(a.nonce);
    const k = ixKnown.get(nonce);
    if (!k) return;
    ixForget(Date.now());
    ixForms.set(String(a.id), { action: a, at: Date.now() });
    const app = a.application || {};
    up({
      t: 'dispatch',
      event: 'INTERACTION_FORM',
      data: { id: String(a.id), nonce, channelId: String(a.channelId ?? k.channelId), title: str(a.title) ?? 'A form', application: { id: String(app.id), name: str(app.name) ?? 'An app', icon: ixIcon(app), bot: app.bot ? pickUser(app.bot) : undefined }, fields: pickFields(a.components, undefined, undefined, []) },
    });
    ixOutcome(nonce, 'modal');
  }
  /** The owner's answers into the body the client's form dialog builds: every field, a null where nothing was given. */
  function ixFormBody(list, answers) {
    return list.map((c) => {
      const id = c.customId ?? c.custom_id;
      const v = id != null ? answers.get(String(id)) : undefined;
      switch (c.type) {
        case CT.ROW:
          return { type: c.type, components: ixFormBody(c.components || [], answers) };
        case CT.LABEL:
          return { type: c.type, component: ixFormBody([c.component], answers)[0] };
        case CT.TEXT_INPUT:
        case CT.RADIO_GROUP:
          return { type: c.type, custom_id: id, value: v && typeof v.value === 'string' ? v.value : null };
        case CT.STRING_SELECT:
        case CT.USER_SELECT:
        case CT.ROLE_SELECT:
        case CT.MENTIONABLE_SELECT:
        case CT.CHANNEL_SELECT:
        case CT.CHECKBOX_GROUP:
          return { type: c.type, custom_id: id, values: v && Array.isArray(v.values) ? v.values.map(String) : null };
        case CT.CHECKBOX:
          return { type: c.type, custom_id: id, value: !!(v && v.checked === true) };
        case CT.FILE_UPLOAD:
          return { type: c.type, custom_id: id, values: null };
        case CT.TEXT_DISPLAY:
          return { type: c.type };
        default:
          throw new Error('This form has a part only Discord fills in: answer it there');
      }
    });
  }
  /** Send the owner's answers to a form, once. */
  async function ixSubmit(cmd) {
    const kept = ixForms.get(String(cmd.formId));
    if (!kept || Date.now() - kept.at > IX_KEEP_MS) throw new Error('This form has closed: do what opened it again');
    const queue = exportedFn(mod.InteractionQueue || {}, 6, isInteractionQueue);
    const failed = exportedFn(mod.InteractionQueue || {}, 6, isInteractionFailure);
    if (!queue || !mod.Snowflakes || !mod.AuthenticationStore) throw new Error("Sending forms isn't available: the hook did not find Discord's own modules for it (Discord changed?)");
    const a = kept.action;
    const app = a.application || {};
    const { channel, guildId } = ixPlace(String(a.channelId));
    const answers = new Map((Array.isArray(cmd.values) ? cmd.values : []).map((v) => [String(v.field), v]));
    const components = ixFormBody(a.components || [], answers);
    ixForms.delete(String(cmd.formId));
    const nonce = String(mod.Snowflakes.fromTimestamp(Date.now()));
    queue(nonce, { data: { interactionType: IX.MODAL_SUBMIT, applicationId: String(app.id) } });
    ixTrack(nonce, String(a.channelId), null);
    try {
      await rest('post', '/interactions', undefined, { type: IX.MODAL_SUBMIT, application_id: String(app.id), channel_id: channel.id, guild_id: guildId ?? undefined, data: { id: String(a.id), custom_id: a.customId ?? a.custom_id, components }, session_id: mod.AuthenticationStore.getSessionId(), nonce });
    } catch (e) {
      // Told to the client's stores as its dialog tells them; never sent again from here.
      if (failed) failed(nonce);
      ixOutcome(nonce, 'failed', describeError(e));
      throw e;
    }
    return { nonce };
  }

  const INTERACT_COMMANDS = { ixComponent, ixCommands, ixRun, ixSuggest, ixSubmit };

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
    // AutoMod refused the message (Discord's codes 200000 and 200001): said as such, not as a bare HTTP error.
    if (err && err.body && (err.body.code === 200000 || err.body.code === 200001)) return `This server's AutoMod blocked it: ${err.body.message || 'the message breaks a rule'}`;
    if (err && err.status) return `${(err.body && err.body.message) || 'HTTP error'} (${err.status})`;
    return String((err && err.message) || err);
  }

  // ------------------------------------------------------------- your own self
  // The account itself (src/self.ts): what Discord wants done on it (a required action, the
  // account's standing once the client has read it), your status and custom status, your server folders and privacy
  // as the client's settings store keeps them, whom you ignore, your notes, and where you are signed in. Read from the
  // client's stores as they change; written through the client's own settings path and REST module, as its settings
  // pages and profile buttons write them. A verification is never done here: it is said, and done in the live view.
  Object.assign(FINDERS, {
    // The settings the client keeps in its proto (status, custom status, folders, privacy), and what writes them.
    UserSettingsProtoStore: isStore('UserSettingsProtoStore'),
    SettingsActions: (m) => typeof m.updateAsync === 'function' && !!m.ProtoClass && m.ProtoClass.typeName === 'discord_protos.discord_users.v1.PreloadedUserSettings',
    // "Verify your phone" and its kind: what the gateway says the account must do.
    UserRequiredActionStore: isStore('UserRequiredActionStore'),
    // The account's standing, once the client has read it (its Safety Hub).
    SafetyHubStore: isStore('SafetyHubStore'),
    NoteStore: isStore('NoteStore'),
  });

  const SELF_EVENTS = ['CONNECTION_OPEN', 'USER_REQUIRED_ACTION_UPDATE', 'USER_SETTINGS_PROTO_UPDATE', 'SAFETY_HUB_FETCH_SUCCESS', 'RELATIONSHIP_ADD', 'RELATIONSHIP_UPDATE', 'RELATIONSHIP_REMOVE', 'RELATIONSHIP_IGNORE_USER_SUCCESS', 'LOAD_RELATIONSHIPS_SUCCESS', 'CURRENT_USER_UPDATE'];
  const selfSent = { notices: '', state: '', ignored: '' };
  let selfSubscribed = false;
  let selfTimer = null;
  const wrapped = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

  /** Listens for changes to the account itself; called once the core modules are there (subscribeDispatch). */
  function subscribeSelf() {
    const d = mod.Dispatcher;
    if (selfSubscribed || !d) return;
    selfSubscribed = true;
    for (const ev of SELF_EVENTS) {
      try {
        d.subscribe(ev, selfSoon);
      } catch (e) {}
    }
    selfSoon();
  }
  /** Several of these come together (a reconnect): one look after them. */
  function selfSoon() {
    if (selfTimer !== null) return;
    selfTimer = setTimeout(() => {
      selfTimer = null;
      try {
        sendSelf();
      } catch (e) {
        log('debug', 'reading the account itself failed', String(e));
      }
    }, 300);
  }
  /** Each part as it now is, when it changed since last sent. */
  function sendSelf() {
    if (!currentUser()) return;
    const parts = { notices: selfNotices(), state: selfState(), ignored: ignoredList() };
    for (const k of Object.keys(parts)) {
      if (parts[k] === null) continue;
      const key = JSON.stringify(parts[k]);
      if (key === selfSent[k]) continue;
      selfSent[k] = key;
      up({ t: 'self', part: k, data: parts[k] });
    }
  }
  /** What Discord wants done: the required action, the standing if the client read it, the user's age check. */
  function selfNotices() {
    let action = null;
    try {
      action = mod.UserRequiredActionStore ? mod.UserRequiredActionStore.getAction() || null : null;
    } catch (e) {}
    let standing = null;
    try {
      const sh = mod.SafetyHubStore;
      if (sh && sh.isInitialized()) {
        const s = sh.getAccountStanding();
        standing = s && typeof s.state === 'number' ? s.state : null;
      }
    } catch (e) {}
    const me = currentUser();
    const age = me ? numOf(me.ageVerificationStatus ?? me.age_verification_status) : null;
    return { requiredAction: typeof action === 'string' ? action : null, standing, age };
  }

  /** Your status, custom status, folders and privacy as the client's settings store has them. null: not loaded. */
  function selfState() {
    const store = mod.UserSettingsProtoStore;
    if (!store) return null;
    let proto = null;
    try {
      proto = store.settings;
    } catch (e) {}
    if (!proto) return null;
    const st = proto.status || {};
    const cs = st.customStatus || null;
    let folders = null;
    try {
      folders = typeof store.getGuildFolders === 'function' ? store.getGuildFolders() : null;
    } catch (e) {}
    const pr = proto.privacy || {};
    const ids = (v) => (Array.isArray(v) ? v.map(String) : []);
    return {
      status: textOf(wrapped(st.status)) || null,
      statusExpiresAt: Number(st.statusExpiresAtMs || 0) || null,
      custom: cs && (cs.text || cs.emojiName || cs.emojiId) ? { text: textOf(cs.text) || null, emojiId: cs.emojiId && String(cs.emojiId) !== '0' ? String(cs.emojiId) : null, emojiName: textOf(cs.emojiName) || null, expiresAt: Number(cs.expiresAtMs || 0) || null } : null,
      folders: Array.isArray(folders) ? folders.map((f) => ({ id: f.folderId != null ? String(f.folderId) : null, name: textOf(f.folderName) || null, color: numOf(f.folderColor), guildIds: ids(f.guildIds) })) : null,
      privacy: {
        restrictedGuilds: ids(pr.restrictedGuildIds).length,
        defaultGuildsRestricted: !!wrapped(pr.defaultGuildsRestricted),
        requestRestrictedGuilds: ids(pr.messageRequestRestrictedGuildIds).length,
        defaultRequestRestricted: wrapped(pr.defaultMessageRequestRestricted) == null ? null : !!wrapped(pr.defaultMessageRequestRestricted),
      },
    };
  }

  /** Everyone you ignore, by user id. */
  function ignoredList() {
    const rs = mod.RelationshipStore;
    if (!rs) return null;
    const out = [];
    try {
      for (const [id, rec] of relationshipRecords()) {
        let on = false;
        try {
          on = typeof rs.isIgnored === 'function' ? !!rs.isIgnored(id) : !!(rec && typeof rec === 'object' && rec.userIgnored);
        } catch (e) {}
        if (on) out.push(String(id));
      }
    } catch (e) {
      return null;
    }
    return out.sort();
  }

  // Each takes the shape the settings proto's own types make, read from the proto's description, so the store keeps a
  // message it can encode; a plain object only when those cannot be read.
  function protoType(T, field) {
    try {
      const f = T && Array.isArray(T.fields) ? T.fields.find((x) => x.localName === field || x.name === field) : null;
      return f && typeof f.T === 'function' ? f.T() : null;
    } catch (e) {
      return null;
    }
  }
  const make = (T, v) => (T && typeof T.create === 'function' ? T.create(v) : v);

  /**
   * Your status and custom status, written as the client's own status picker writes them: one update of the
   * settings proto's status part, which the client then sends to Discord and to its gateway presence.
   */
  async function selfPresence(cmd) {
    const sa = needModule('SettingsActions', 'settings module');
    const states = ['online', 'idle', 'dnd', 'invisible'];
    if (cmd.state !== undefined && !states.includes(cmd.state)) throw new Error('unknown status');
    const StatusT = protoType(sa.ProtoClass, 'status');
    const StringT = protoType(StatusT, 'status');
    const CustomT = protoType(StatusT, 'customStatus');
    const now = Date.now();
    await sa.updateAsync(
      'status',
      (s) => {
        if (cmd.state !== undefined) {
          s.status = make(StringT, { value: cmd.state });
          s.statusExpiresAtMs = '0';
        }
        if (cmd.status === null) s.customStatus = undefined;
        else if (cmd.status) {
          const c = cmd.status;
          const custom = { text: c.text || '', createdAtMs: String(now), expiresAtMs: c.expiresAt ? String(Math.floor(c.expiresAt)) : '0' };
          if (c.emojiId) custom.emojiId = String(c.emojiId);
          if (c.emojiName) custom.emojiName = c.emojiName;
          s.customStatus = make(CustomT, custom);
        }
      },
      0,
    );
    await landed(() => {
      const st = selfState();
      return !!st && (cmd.state === undefined || st.status === cmd.state);
    }, 3000);
    return selfState();
  }

  /** Block someone, as the client's Block button does: its addRelationship with the block type. */
  async function selfBlock(cmd) {
    const ra = needModule('RelationshipActions', 'friends module');
    const id = String(cmd.userId || '');
    if (!USER_ID.test(id)) throw new Error('That is not a Discord user id');
    const me = currentUser();
    if (me && me.id === id) throw new Error('That is this account');
    if (relationshipOf(id).relationship === BLOCKED) return { user: resolveUser(id), relationship: BLOCKED };
    const context = { location: 'ContextMenu' };
    const out = await untilSettled(clientAction(ra, 'addRelationship', { userId: id, context, type: BLOCKED }, [id, context, BLOCKED]), FRIEND_WAIT_MS, 'block people');
    if (out.check) return { check: out.check };
    await landed(() => relationshipOf(id).relationship === BLOCKED, 3000);
    return { user: resolveUser(id), relationship: BLOCKED };
  }

  /**
   * Ignore someone or stop, as the client's Ignore button does. Its ignoreUser shows a toast when Discord refuses and
   * says nothing more, so the store is what says whether it took.
   */
  async function selfIgnore(cmd) {
    const ra = needModule('RelationshipActions', 'friends module');
    const rs = needModule('RelationshipStore', 'relationship store');
    const id = String(cmd.userId || '');
    if (!USER_ID.test(id)) throw new Error('That is not a Discord user id');
    const want = !!cmd.ignored;
    const fn = want ? ra.ignoreUser : ra.unignoreUser;
    if (typeof fn !== 'function' || typeof rs.isIgnored !== 'function') throw new Error("Discord's own ignore was not found in this client (Discord changed?), so this is not available");
    if (!!rs.isIgnored(id) !== want) await fn.call(ra, id, 'ContextMenu', undefined);
    // An ignore that took is in the store before the call resolves (its success dispatches it); an unignore comes
    // back with the gateway's relationship update, soon after.
    const now = want ? rs.isIgnored(id) : await landed(() => !rs.isIgnored(id), 5000);
    if (!now) throw new Error(`Discord did not ${want ? 'ignore' : 'stop ignoring'} them`);
    selfSoon();
    return { ignored: want };
  }

  /** Your note on someone, as the client's profile shows it: its store, else the request its profile makes for it. */
  async function noteOf(id) {
    const ns = mod.NoteStore;
    try {
      const n = ns && ns.getNote(id);
      if (n && !n.loading) return textOf(n.note) || null;
    } catch (e) {}
    try {
      const res = await rest('get', `/users/@me/notes/${id}`);
      const b = (res && res.body) || {};
      if (b.note_user_id !== undefined && String(b.note_user_id) !== id) return undefined;
      mod.Dispatcher.dispatch({ type: 'USER_NOTE_UPDATE', id, note: b.note });
      return textOf(b.note) || null;
    } catch (e) {
      // 404: there is none. Anything else: not known, which is not the same as none.
      return e && e.status === 404 ? null : undefined;
    }
  }

  /** Your note on someone saved, as the client's note field saves it. */
  async function selfNote(cmd) {
    const id = String(cmd.userId || '');
    if (!USER_ID.test(id)) throw new Error('That is not a Discord user id');
    const note = typeof cmd.note === 'string' ? cmd.note : '';
    await rest('put', `/users/@me/notes/${id}`, undefined, { note });
    return { note };
  }

  /** Where you are signed in, as the client's Devices page lists it; the sandbox's own session marked. */
  async function selfSessions() {
    const res = await rest('get', '/auth/sessions');
    const list = (res && res.body && res.body.user_sessions) || [];
    let mine = null;
    try {
      mine = mod.AuthenticationStore && typeof mod.AuthenticationStore.getAuthSessionIdHash === 'function' ? mod.AuthenticationStore.getAuthSessionIdHash() : null;
    } catch (e) {}
    return {
      sessions: list.map((s) => ({
        id: String(s.id_hash),
        current: !!mine && s.id_hash === mine,
        os: textOf(s.client_info && s.client_info.os),
        platform: textOf(s.client_info && s.client_info.platform),
        location: textOf(s.client_info && s.client_info.location),
        last_used: isoOf(s.approx_last_used_time),
      })),
    };
  }

  /**
   * Your profile beyond the bio, saved as the client's profile settings save it: your name and picture on your user
   * (PATCH /users/@me), the rest on your profile (PATCH /users/@me/profile). Pictures go as data URLs, as there.
   */
  async function selfProfile(cmd) {
    const me = currentUser();
    if (!me || !me.id) throw new Error('not signed in');
    const dataUrl = (f) => (f ? `data:${f.mime};base64,${f.base64}` : null);
    const user = {};
    if (cmd.displayName !== undefined) user.global_name = cmd.displayName || null;
    if (cmd.avatar !== undefined) user.avatar = dataUrl(cmd.avatar);
    const prof = {};
    if (cmd.bio !== undefined) prof.bio = cmd.bio;
    if (cmd.pronouns !== undefined) prof.pronouns = cmd.pronouns;
    if (cmd.banner !== undefined) prof.banner = dataUrl(cmd.banner);
    if (cmd.accent !== undefined) prof.accent_color = cmd.accent === null ? null : parseInt(String(cmd.accent).slice(1), 16);
    if (!Object.keys(user).length && !Object.keys(prof).length) throw new Error('nothing to change');
    if (Object.keys(user).length) await rest('patch', '/users/@me', undefined, user);
    if (Object.keys(prof).length) await rest('patch', '/users/@me/profile', undefined, prof);
    return profile({ userId: me.id });
  }

  /** What a profile shows beyond its text: badges, the frame on the picture, its colours, and your note on them. */
  async function profileExtras(who, body) {
    const out = {};
    let p = null;
    try {
      p = mod.UserProfileStore && mod.UserProfileStore.getUserProfile(who);
    } catch (e) {}
    const b = body || {};
    const badges = (p && p.badges) || b.badges;
    if (Array.isArray(badges)) out.badges = badges.map((x) => x && { id: textOf(x.id), description: textOf(x.description), icon: textOf(x.icon) }).filter((x) => x && x.description);
    const colors = (p && p.themeColors) || (b.user_profile && b.user_profile.theme_colors);
    if (Array.isArray(colors)) out.theme_colors = colors.filter((c) => typeof c === 'number');
    let rec = null;
    try {
      rec = mod.UserStore.getUser(who);
    } catch (e) {}
    const deco = (rec && (rec.avatarDecorationData || rec.avatarDecoration)) || (b.user && b.user.avatar_decoration_data);
    if (deco && typeof deco.asset === 'string') out.decoration = deco.asset;
    const me = currentUser();
    if (!me || me.id !== who) {
      const note = await noteOf(who);
      if (note !== undefined) out.note = note;
    }
    return out;
  }

  const SELF_COMMANDS = { selfPresence, selfBlock, selfIgnore, selfNote, selfSessions, selfProfile };
  // ------------------------------------------------------------------ servers
  // A server beyond its channels (the chat hub's docs/servers.md): its scheduled events and your Interested, leaving
  // it, its invite links, your nickname, and what it asks of a new member (its rules, an application, onboarding).
  // Reads come from the client's stores; writes and the few reads a click makes go through the client's own actions,
  // each from the owner's click on the hub. Nothing here agrees to rules or answers a form for the owner: the hub sends
  // their own answer, and a missing "agree" is refused here too.
  Object.assign(FINDERS, {
    GuildScheduledEventStore: isStore('GuildScheduledEventStore'),
    // What the client's Interested button and its events list call.
    EventActions: (m) => typeof m.createRsvpForGuildEvent === 'function' && typeof m.deleteRsvpForGuildEvent === 'function' && typeof m.getGuildEventsForCurrentUser === 'function',
    // What its Leave Server confirm calls.
    GuildActions: (m) => typeof m.leaveGuild === 'function' && typeof m.updateMemberRoles === 'function',
    // Membership screening: the form a new member sees, and its submit (a PUT to /requests/@me).
    VerificationActions: (m) => typeof m.fetchVerificationForm === 'function' && typeof m.submitVerificationForm === 'function',
    OnboardingStore: isStore('GuildOnboardingPromptsStore'),
    OnboardingActions: (m) => typeof m.selectOption === 'function' && typeof m.completeOnboarding === 'function' && typeof m.finishOnboarding === 'function',
    OnboardingFetch: (m) => !!exportedFn(m, 8, isOnboardingFetch),
    // What the client's Change Nickname dialog calls.
    NickActions: (m) => typeof m.changeNickname === 'function' && /nick/.test(fnSource(m.changeNickname)),
  });
  // Change Nickname, read with the others by canAll.
  Object.assign(PERM, { changeNickname: 1n << 26n });
  /** The client's fetch of a server's onboarding: it says it starts, asks, and fills its store. Read, never run to find it. */
  function isOnboardingFetch(f) {
    const s = fnSource(f);
    return s.includes('GUILD_ONBOARDING_PROMPTS_FETCH_START') && s.includes('GUILD_ONBOARDING_PROMPTS_FETCH_SUCCESS');
  }
  // Discord's numbers: an RSVP's answer, a member flag, the events a server's members see.
  const RSVP_INTERESTED = 1;
  const RSVP_UNINTERESTED = 0;
  const COMPLETED_ONBOARDING = 2;
  const EVENTS_MAX = 50;
  const SERVER_WAIT_MS = 30_000;
  const ONBOARDING_NEW_MS = 14 * 24 * 3600_000;
  const OWNER_LEAVE = 'You own this server: Discord lets you leave only after you give it to someone else (Server Settings → Members) or delete it, in Discord';
  FORWARD.push(
    'GUILD_SCHEDULED_EVENT_CREATE',
    'GUILD_SCHEDULED_EVENT_UPDATE',
    'GUILD_SCHEDULED_EVENT_DELETE',
    'GUILD_SCHEDULED_EVENT_USER_ADD',
    'GUILD_SCHEDULED_EVENT_USER_REMOVE',
    'GUILD_SCHEDULED_EVENT_EXCEPTION_CREATE',
    'GUILD_SCHEDULED_EVENT_EXCEPTION_UPDATE',
    'GUILD_SCHEDULED_EVENT_EXCEPTION_DELETE',
    // An application's outcome: the gateway's, and the client's own after a submit.
    'GUILD_JOIN_REQUEST_UPDATE',
    'USER_GUILD_JOIN_REQUEST_UPDATE',
  );
  /** Servers whose RSVPs the client has loaded, so a missing one means "not interested" rather than "not known". */
  const rsvpLoaded = new Set();
  /** Links this account made or listed, per server, newest first: what the about shows without asking again. */
  const keptLinks = new Map();

  function eventStore() {
    return mod.GuildScheduledEventStore || null;
  }
  /** One event as the adapter reads it: the API's own shape, with the count and your answer from the client's store. */
  function pickEvent(e) {
    if (!e || !e.id) return null;
    const ss = eventStore();
    const me = currentUser();
    const meId = me && me.id;
    const gid = String(e.guild_id ?? e.guildId ?? '');
    const answer = (exceptionId) => {
      try {
        const r = ss && meId ? ss.getRsvp(e.id, exceptionId, meId) : null;
        if (r && typeof r.response === 'number') return r.response;
      } catch (x) {}
      return rsvpLoaded.has(gid) ? 'none' : null;
    };
    let count = null;
    try {
      if (ss && ss.hasUserCount(e.id, null)) count = ss.getUserCount(e.id, null);
    } catch (x) {}
    if (count === null && typeof e.user_count === 'number') count = e.user_count;
    const rr = e.recurrence_rule ?? e.recurrenceRule ?? null;
    const exceptions = Array.isArray(e.guild_scheduled_event_exceptions) ? e.guild_scheduled_event_exceptions : [];
    return {
      id: String(e.id),
      guild_id: gid,
      channel_id: e.channel_id ?? e.channelId ?? null,
      creator_id: e.creator_id ?? e.creatorId ?? null,
      creator: e.creator ? pickUser(e.creator) : null,
      name: String(e.name ?? ''),
      description: typeof e.description === 'string' ? e.description : null,
      scheduled_start_time: isoOf(e.scheduled_start_time ?? e.scheduledStartTime),
      scheduled_end_time: isoOf(e.scheduled_end_time ?? e.scheduledEndTime),
      status: numOf(e.status),
      entity_type: numOf(e.entity_type ?? e.entityType),
      location: textOf((e.entity_metadata ?? e.entityMetadata ?? {}).location),
      image: textOf(e.image),
      recurrence_rule: rr && typeof rr === 'object' ? { start: isoOf(rr.start), end: isoOf(rr.end), frequency: numOf(rr.frequency), interval: numOf(rr.interval), by_weekday: rr.by_weekday ?? rr.byWeekday ?? null, by_n_weekday: rr.by_n_weekday ?? rr.byNWeekday ?? null, by_month: rr.by_month ?? rr.byMonth ?? null, by_month_day: rr.by_month_day ?? rr.byMonthDay ?? null, by_year_day: rr.by_year_day ?? rr.byYearDay ?? null, count: numOf(rr.count) } : null,
      exceptions: exceptions.map((x) => ({ id: String(x.event_exception_id), is_canceled: !!x.is_canceled, scheduled_start_time: isoOf(x.scheduled_start_time), scheduled_end_time: isoOf(x.scheduled_end_time), rsvp: answer(String(x.event_exception_id)) })),
      user_count: count,
      rsvp: answer(null),
    };
  }
  function guildEvents(gid) {
    const ss = eventStore();
    if (!ss) return [];
    let list = [];
    try {
      list = ss.getGuildScheduledEventsForGuild(gid) || [];
    } catch (e) {}
    return list.slice(0, EVENTS_MAX).map(pickEvent).filter(Boolean);
  }
  function inGuild(gid) {
    const g = guildOf(String(gid || ''));
    if (!g) throw new Error('This account is not in that server');
    return g;
  }

  /** Every server's events from the store, no request: after the snapshot, and for a server just joined. */
  function serverEventsAll(cmd) {
    const out = {};
    const ids = cmd.guildId ? [String(cmd.guildId)] : Object.keys((mod.GuildStore && mod.GuildStore.getGuilds()) || {});
    for (const gid of ids) out[gid] = guildEvents(gid);
    return { known: !!eventStore(), guilds: out };
  }

  /** One server's events as opening its events list reads them: your answers loaded, and each event's count. */
  async function serverEvents(cmd) {
    const g = inGuild(cmd.guildId);
    const ea = mod.EventActions;
    if (ea && !rsvpLoaded.has(g.id)) {
      try {
        await ea.getGuildEventsForCurrentUser(g.id);
        rsvpLoaded.add(g.id);
      } catch (e) {
        log('info', 'loading your event answers failed', describeError(e));
      }
    }
    if (ea && typeof ea.fetchGuildEventUserCounts === 'function') {
      for (const e of guildEvents(g.id)) {
        try {
          await ea.fetchGuildEventUserCounts(g.id, e.id, e.exceptions.map((x) => x.id));
        } catch (x) {}
      }
    }
    return { events: guildEvents(g.id) };
  }

  /** Interested, or not, in an event or one of its occurrences: the client's own RSVP calls, as its button makes them. */
  async function rsvp(cmd) {
    const g = inGuild(cmd.guildId);
    const ea = needModule('EventActions', 'events module');
    const ss = eventStore();
    const e = ss && ss.getGuildScheduledEvent(cmd.eventId);
    if (!e || String(e.guild_id ?? e.guildId) !== g.id) throw new Error('Discord does not know that event here');
    const me = currentUser();
    const has = (x) => {
      try {
        return ss.getRsvp(e.id, x, me.id) || null;
      } catch (err) {
        return null;
      }
    };
    const ex = cmd.exceptionId ? String(cmd.exceptionId) : null;
    let call;
    if (!ex) call = cmd.interested ? (has(null) ? null : () => ea.createRsvpForGuildEvent(e.id, null, g.id, RSVP_INTERESTED)) : has(null) ? () => ea.deleteRsvpForGuildEvent(e.id, null, g.id) : null;
    else {
      // One occurrence: an answer of its own only where it differs from the series', as the client keeps them.
      const series = (has(null) || {}).response === RSVP_INTERESTED;
      call = cmd.interested === series ? (has(ex) ? () => ea.deleteRsvpForGuildEvent(e.id, ex, g.id) : null) : () => ea.createRsvpForGuildEvent(e.id, ex, g.id, cmd.interested ? RSVP_INTERESTED : RSVP_UNINTERESTED);
    }
    if (call) {
      const out = await untilSettled(Promise.resolve().then(call), SERVER_WAIT_MS, 'answer events');
      if (out.check) return { check: out.check };
    }
    rsvpLoaded.add(g.id);
    return { event: pickEvent(ss.getGuildScheduledEvent(e.id)) };
  }

  /** Leaving a server, as its Leave Server confirm does. Refused before anything when you own it. */
  async function leaveGuild(cmd) {
    const g = inGuild(cmd.guildId);
    const me = currentUser();
    if (me && (g.ownerId ?? g.owner_id) === me.id) throw new Error(OWNER_LEAVE);
    const ga = needModule('GuildActions', 'server module');
    // What goes with it, read before the stores let it go: its categories and channels.
    const channels = guildChannels(g.id).map((c) => ({ id: c.id, type: c.type }));
    const out = await untilSettled(Promise.resolve().then(() => ga.leaveGuild(g.id)), SERVER_WAIT_MS, 'leave servers');
    if (out.check) return { check: out.check };
    keptLinks.delete(g.id);
    return { left: true, guildId: g.id, channels };
  }

  /** An invite link as the adapter reads it. */
  function pickLink(i) {
    if (!i || !i.code) return null;
    const c = i.channel || {};
    return {
      code: String(i.code),
      channel_id: c.id ?? i.channel_id ?? null,
      inviter_id: (i.inviter && i.inviter.id) || i.inviter_id || null,
      inviter: i.inviter ? pickUser(i.inviter) : null,
      uses: numOf(i.uses),
      max_uses: numOf(i.max_uses ?? i.maxUses),
      max_age: numOf(i.max_age ?? i.maxAge),
      created_at: isoOf(i.created_at ?? i.createdAt),
      expires_at: isoOf(i.expires_at ?? i.expiresAt),
      temporary: !!i.temporary,
    };
  }

  /** What a server's About adds from the client's stores, no request: who owns it, your nickname, its vanity code, links kept. */
  function serverAbout(cmd) {
    const g = inGuild(cmd.guildId);
    const me = currentUser();
    let member = null;
    try {
      member = me && mod.GuildMemberStore ? mod.GuildMemberStore.getMember(g.id, me.id) : null;
    } catch (e) {}
    return {
      guildId: g.id,
      selfId: me ? me.id : null,
      ownerId: g.ownerId ?? g.owner_id ?? null,
      nick: (member && typeof member.nick === 'string' && member.nick) || null,
      vanity: g.vanityURLCode ?? g.vanity_url_code ?? null,
      can: canAll(g),
      links: keptLinks.get(g.id) || [],
      inviteChannelId: inviteChannel(g),
      modules: { leave: !!mod.GuildActions, nick: !!mod.NickActions, invites: !!(mod.InviteActions && mod.InviteActions.createInvite && mod.InviteActions.revokeInvite) },
    };
  }

  /** Where a new link leads: the rules channel, else the system channel, else the first text channel you may invite to. */
  function inviteChannel(g) {
    const ok = (id) => {
      const c = id && mod.ChannelStore.getChannel(id);
      if (!c) return false;
      try {
        return !mod.PermissionStore || mod.PermissionStore.can(PERM.createInvite, c) === true;
      } catch (e) {
        return false;
      }
    };
    for (const id of [g.rulesChannelId ?? g.rules_channel_id, g.systemChannelId ?? g.system_channel_id]) if (ok(id)) return String(id);
    const first = guildChannels(g.id).filter((c) => c.type === 0).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).find((c) => ok(c.id));
    return first ? String(first.id) : null;
  }

  /** A server's links, as its settings' Invites tab loads them: only for someone who may manage the server. */
  async function listInvites(cmd) {
    const g = inGuild(cmd.guildId);
    if (canAll(g).manageGuild !== true) return { links: keptLinks.get(g.id) || [] };
    const res = await rest('get', `/guilds/${g.id}/invites`);
    const links = ((res && res.body) || []).map(pickLink).filter(Boolean).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    keptLinks.set(g.id, links);
    return { links };
  }

  /** A new link, as the client's Invite People dialog makes one with the expiry and uses picked. */
  async function createInvite(cmd) {
    const g = inGuild(cmd.guildId);
    const ia = needModule('InviteActions', 'invite module');
    const channelId = cmd.channelId || inviteChannel(g);
    if (!channelId) throw new Error('There is no channel here you may invite people to');
    const body = { max_age: cmd.maxAge, max_uses: cmd.maxUses, temporary: !!cmd.temporary };
    const out = await untilSettled(Promise.resolve().then(() => ia.createInvite(channelId, body, 'Guild Header')), SERVER_WAIT_MS, 'make invites');
    if (out.check) return { check: out.check };
    const link = pickLink(out.value && out.value.body ? out.value.body : out.value);
    if (link) keptLinks.set(g.id, [link, ...(keptLinks.get(g.id) || []).filter((l) => l.code !== link.code)]);
    return { link };
  }

  /** A link turned off, as the client's Invites tab does it. */
  async function revokeInvite(cmd) {
    const g = inGuild(cmd.guildId);
    const ia = needModule('InviteActions', 'invite module');
    const kept = (keptLinks.get(g.id) || []).find((l) => l.code === cmd.code);
    const channelId = cmd.channelId || (kept && kept.channel_id);
    if (!channelId) throw new Error('Which channel does that link lead to? Look at the links again');
    const inv = { code: String(cmd.code), channel: { id: String(channelId) }, uses: kept ? kept.uses : 0, maxUses: kept ? kept.max_uses : 0, maxAge: kept ? kept.max_age : 0, type: 0 };
    const out = await untilSettled(Promise.resolve().then(() => ia.revokeInvite(inv)), SERVER_WAIT_MS, 'turn invites off');
    if (out.check) return { check: out.check };
    keptLinks.set(g.id, (keptLinks.get(g.id) || []).filter((l) => l.code !== cmd.code));
    return { revoked: true };
  }

  /** Your nickname here, as the client's Change Nickname dialog sets it ('' clears it). */
  async function setNick(cmd) {
    const g = inGuild(cmd.guildId);
    const na = needModule('NickActions', 'nickname module');
    if (canAll(g).changeNickname === false) throw new Error('You need the Change Nickname permission here');
    const out = await untilSettled(Promise.resolve().then(() => na.changeNickname(g.id, null, '@me', String(cmd.nick || ''))), SERVER_WAIT_MS, 'change nicknames');
    if (out.check) return { check: out.check };
    return { ok: true };
  }

  /** The member this account is in a server: pending (screening not done), and its flags. */
  function selfMember(gid) {
    const me = currentUser();
    try {
      return me && mod.GuildMemberStore ? mod.GuildMemberStore.getMember(gid, me.id) : null;
    } catch (e) {
      return null;
    }
  }
  const hasFeature = (g, f) => !!g && !!g.features && (typeof g.features.has === 'function' ? g.features.has(f) : Array.isArray(g.features) && g.features.includes(f));
  /** The latest outcome of an application here, as the gateway or the client said it. */
  const applications = new Map();

  /** The screening form, as the client fetches it to show it. */
  async function screeningForm(gid) {
    const va = needModule('VerificationActions', 'membership screening module');
    const body = await va.fetchVerificationForm(gid);
    if (!body || !Array.isArray(body.form_fields)) throw new Error('Discord did not send its rules form');
    return body;
  }

  /** What a server asks of this account now: its rules or application while the member is pending, else its onboarding. */
  async function gate(cmd) {
    const g = inGuild(cmd.guildId);
    const m = selfMember(g.id);
    const app = applications.get(g.id);
    if (app && (app.status === 'SUBMITTED' || app.status === 'REJECTED')) return { kind: 'apply', guildId: g.id, status: app.status, reason: app.reason ?? null, form: app.form ?? null };
    if (m && (m.isPending === true || m.pending === true)) {
      const form = await screeningForm(g.id);
      return { kind: 'screening', guildId: g.id, form: { version: form.version ?? null, description: form.description ?? null, form_fields: form.form_fields } };
    }
    const flags = (m && m.flags) || 0;
    // Onboarding is for new members, as Discord shows it: someone in the server from before it had onboarding never
    // finished it either, and is not asked.
    const joined = Date.parse(isoOf(m && (m.joinedAt ?? m.joined_at)) || '');
    const recent = Number.isFinite(joined) && Date.now() - joined < ONBOARDING_NEW_MS;
    if (recent && hasFeature(g, 'GUILD_ONBOARDING') && !(flags & COMPLETED_ONBOARDING)) {
      const fetch = mod.OnboardingFetch && exportedFn(mod.OnboardingFetch, 8, isOnboardingFetch);
      if (fetch) {
        try {
          await fetch(g.id);
        } catch (e) {}
      }
      const os = mod.OnboardingStore;
      let prompts = [];
      try {
        prompts = (os && (os.getOnboardingPromptsForOnboarding(g.id) || os.getOnboardingPrompts(g.id))) || [];
      } catch (e) {}
      const shown = prompts.filter((p) => p && (p.inOnboarding ?? p.in_onboarding) !== false);
      if (shown.length) return { kind: 'onboarding', guildId: g.id, prompts: shown.map(pickPrompt) };
    }
    return null;
  }
  function pickPrompt(p) {
    return {
      id: String(p.id),
      title: String(p.title ?? ''),
      single_select: !!(p.singleSelect ?? p.single_select),
      required: !!p.required,
      options: (p.options || []).map((o) => ({ id: String(o.id), title: String(o.title ?? ''), description: textOf(o.description), emoji: o.emoji ? textOf(o.emoji.name ?? o.emojiName) : textOf(o.emojiName) })),
    };
  }

  /** The owner's answer, through the client's own submit. A rules field is ticked only when they ticked it. */
  async function answerGate(cmd) {
    const g = inGuild(cmd.guildId);
    const a = cmd.answer || {};
    if (a.kind === 'rules' || a.kind === 'apply') {
      const va = needModule('VerificationActions', 'membership screening module');
      const form = await screeningForm(g.id);
      const fields = form.form_fields.map((f, i) => {
        const type = f.field_type ?? f.fieldType;
        if (type === 'TERMS') {
          if (a.agree !== true) throw new Error('Agreeing to the rules is yours to do: tick that you agree');
          return { ...f, response: true };
        }
        const v = a.answers ? a.answers[String(i)] : undefined;
        if (v === undefined || v === null || v === '') {
          if (f.required) throw new Error(`Answer "${f.label}"`);
          return { ...f, response: null };
        }
        return { ...f, response: type === 'MULTIPLE_CHOICE' ? Number(v) : String(v) };
      });
      const out = await untilSettled(Promise.resolve().then(() => va.submitVerificationForm(g.id, { version: form.version, formFields: fields }, -1)), SERVER_WAIT_MS, 'answer server rules');
      if (out.check) return { check: out.check };
      const req = (out.value && out.value.body) || out.value || {};
      const status = req.application_status ?? req.applicationStatus ?? null;
      if (status) applications.set(g.id, { status, reason: req.rejection_reason ?? null });
      return { status, next: status === 'SUBMITTED' ? null : await gate({ guildId: g.id }).catch(() => null) };
    }
    if (a.kind === 'onboarding') {
      const oa = needModule('OnboardingActions', 'onboarding module');
      const os = mod.OnboardingStore;
      const prompts = (os && (os.getOnboardingPromptsForOnboarding(g.id) || [])) || [];
      if (!prompts.length) throw new Error('Discord has not loaded its onboarding: look again');
      const picks = new Set((a.picks || []).map(String));
      for (const p of prompts) for (const o of p.options || []) if (picks.has(String(o.id))) oa.selectOption(g.id, p.id, o.id, true);
      oa.completeOnboarding(g.id, prompts);
      oa.finishOnboarding(g.id);
      // Its member flag says it is done once Discord took the answers in.
      await landed(() => ((selfMember(g.id) || {}).flags || 0) & COMPLETED_ONBOARDING, 10_000);
      return { status: null, next: null };
    }
    throw new Error('That answers nothing Discord asks');
  }

  /** The events' and applications' dispatches, shrunk: an event as the store now has it, or the outcome of your own application. */
  const SHRINK_SERVERS = {
    GUILD_SCHEDULED_EVENT_CREATE: (a) => ({ event: pickEvent(a.guildScheduledEvent) }),
    GUILD_SCHEDULED_EVENT_UPDATE: (a) => ({ event: pickEvent(a.guildScheduledEvent) }),
    GUILD_SCHEDULED_EVENT_DELETE: (a) => (a.guildScheduledEvent ? { gone: { id: String(a.guildScheduledEvent.id), guild_id: String(a.guildScheduledEvent.guild_id) } } : null),
    // Anyone's answer moves the count; only yours is said, and never who else.
    GUILD_SCHEDULED_EVENT_USER_ADD: (a) => eventNow(a.guildEventId),
    GUILD_SCHEDULED_EVENT_USER_REMOVE: (a) => eventNow(a.guildEventId),
    GUILD_SCHEDULED_EVENT_EXCEPTION_CREATE: (a) => eventNow(a.eventException && a.eventException.event_id),
    GUILD_SCHEDULED_EVENT_EXCEPTION_UPDATE: (a) => eventNow(a.eventException && a.eventException.event_id),
    GUILD_SCHEDULED_EVENT_EXCEPTION_DELETE: (a) => eventNow(a.eventException && a.eventException.event_id),
    GUILD_JOIN_REQUEST_UPDATE: (a) => joinRequest(a.guildId ?? a.guild_id, a.request, a.status),
    USER_GUILD_JOIN_REQUEST_UPDATE: (a) => joinRequest(a.guildId ?? a.guild_id, a.request, null),
  };
  function eventNow(id) {
    const ss = eventStore();
    const e = id && ss ? ss.getGuildScheduledEvent(id) : null;
    return e ? { event: pickEvent(e) } : null;
  }
  function joinRequest(gid, req, status) {
    const me = currentUser();
    if (!gid || !req || !me || String(req.user_id ?? req.userId ?? me.id) !== me.id) return null;
    const s = status ?? req.application_status ?? req.applicationStatus ?? null;
    if (!s) return null;
    applications.set(String(gid), { status: s, reason: req.rejection_reason ?? req.rejectionReason ?? null });
    return { application: { guild_id: String(gid), status: s, reason: req.rejection_reason ?? req.rejectionReason ?? null } };
  }

  const SERVER_COMMANDS = {
    serverEventsAll,
    serverEvents,
    rsvp,
    leaveGuild,
    serverAbout,
    listInvites,
    createInvite,
    revokeInvite,
    setNick,
    gate,
    answerGate,
  };

  // ------------------------------------------------------------------- stickers
  // The stickers this account may send in a channel, as the client's own sticker picker lists them: this server's,
  // other servers', then the standard packs the client already holds, each kept only where the client's own rule
  // (the function its picker and its send check with) says SENDABLE. Nothing is fetched: packs the client has not
  // loaded are not listed. A sticker that needs Nitro is left out, never sent some other way.
  const IS_VOICE_MESSAGE = 8192;
  const STICKER_SENDABLE = 0;
  const STICKER_NEEDS_PREMIUM = 1;
  Object.assign(FINDERS, {
    StickersStore: isStore('StickersStore'),
    // The client's "can this account send this sticker here": (sticker, user, channel) -> 0 sendable, 1 with Nitro,
    // 2 not, 3 with a boosted server.
    StickerRules: (m) => !!exportedFn(m, 4, isStickerRule),
  });
  function isStickerRule(f) {
    if (f.length !== 3) return false;
    const src = Function.prototype.toString.call(f);
    return /canUseCustomStickersEverywhere/.test(src) && /getSelfMember/.test(src);
  }
  function stickerSendability(st, channel, guildId) {
    const rule = mod.StickerRules && exportedFn(mod.StickerRules, 4, isStickerRule);
    if (rule) {
      try {
        return rule(st, currentUser(), channel);
      } catch (e) {
        /* the plain rule below */
      }
    }
    // Without the client's rule, only what any member may send: this server's own, and standard packs it holds.
    if (st.pack_id) return STICKER_SENDABLE;
    return st.guild_id && st.guild_id === guildId && st.available !== false ? STICKER_SENDABLE : 2;
  }
  const pickSticker = (st) => ({ id: String(st.id), name: String(st.name || 'sticker'), format_type: Number(st.format_type ?? st.formatType ?? 1), tags: typeof st.tags === 'string' ? st.tags : '' });

  function stickerPage(cmd) {
    const store = mod.StickersStore;
    if (!store) return { packs: [], next: null, note: 'The Discord client has not loaded its stickers yet.' };
    const channel = mod.ChannelStore.getChannel(cmd.channelId);
    const guildId = (channel && (channel.guild_id ?? channel.getGuildId?.())) || null;
    let nitro = false;
    const usable = (list) =>
      (list || []).filter((st) => {
        const r = stickerSendability(st, channel, guildId);
        if (r === STICKER_NEEDS_PREMIUM) nitro = true;
        return r === STICKER_SENDABLE;
      });
    const packs = [];
    let byGuild = null;
    try {
      byGuild = store.getAllGuildStickers();
    } catch (e) {}
    const guildIds = byGuild ? [...(byGuild instanceof Map ? byGuild.keys() : Object.keys(byGuild))] : [];
    guildIds.sort((a, b) => (b === guildId) - (a === guildId));
    for (const id of guildIds) {
      const list = usable(byGuild instanceof Map ? byGuild.get(id) : byGuild[id]);
      if (!list.length) continue;
      const g = mod.GuildStore.getGuild(id);
      packs.push({ id: String(id), name: (g && g.name) || 'Server', source: 'server', stickers: list.map(pickSticker) });
    }
    let premium = [];
    try {
      premium = store.getPremiumPacks() || [];
    } catch (e) {}
    for (const p of premium) {
      const list = usable(p.stickers);
      if (list.length) packs.push({ id: String(p.id), name: p.name || 'Stickers', source: 'standard', cover: p.cover_sticker_id ? String(p.cover_sticker_id) : undefined, stickers: list.map(pickSticker) });
    }
    const from = Math.max(0, Number(cmd.offset) || 0);
    const size = Math.max(1, Math.min(20, Number(cmd.limit) || 8));
    return {
      packs: packs.slice(from, from + size),
      next: from + size < packs.length ? from + size : null,
      note: nitro ? 'Stickers from other servers need Nitro.' : !packs.length ? 'No stickers you may send here.' : undefined,
    };
  }

  /** Send stickers the way the client's picker does (MessageActions.sendStickers), its REST send without it. */
  async function sendStickers(cmd) {
    const ma = mod.MessageActions;
    const options = { nonce: cmd.nonce, ...(cmd.replyTo ? { messageReference: { channel_id: cmd.channelId, message_id: cmd.replyTo } } : {}), ...sendOptionsOf(cmd) };
    if (ma && typeof ma.sendStickers === 'function') {
      const res = await ma.sendStickers(cmd.channelId, cmd.stickerIds, cmd.content || '', options);
      return { nativeId: res && res.body ? res.body.id : null, nonce: cmd.nonce };
    }
    const body = { content: cmd.content || '', nonce: cmd.nonce, tts: false, sticker_ids: cmd.stickerIds, ...restSendFields(cmd) };
    if (cmd.replyTo) body.message_reference = { channel_id: cmd.channelId, message_id: cmd.replyTo };
    const res = await rest('post', `/channels/${cmd.channelId}/messages`, undefined, body);
    return { nativeId: res && res.body ? res.body.id : null, nonce: cmd.nonce };
  }


  // ------------------------------------------------------------------- polls and pins
  // A poll's question, answers and counts as the client keeps them (its votes ride on the message's reactions, as a
  // kind of their own), voting and ending one with the client's own poll actions, making one with its own send, and
  // pinning and the pinned list as its pin button and pins popout do. Who voted for what is never asked for: the client
  // asks only when someone clicks a count.
  const VOTE = 2;
  const PINS_PAGE = 25;
  const PINS_PAGES = 4;
  Object.assign(FINDERS, {
    // Its poll's Vote and End Now buttons: a PUT of your answers and a POST that ends it.
    PollActions: (m) => !!exportedFn(m, 4, isPollVote) && !!exportedFn(m, 4, isPollExpire),
    // Its pin button and pins popout (a chunk loaded once pins were opened in the live view).
    PinActions: (m) => typeof m.pinMessage === 'function' && typeof m.unpinMessage === 'function' && typeof m.ackPins === 'function' && typeof m.fetchPins === 'function',
  });
  function isPollVote(f) {
    const src = fnSource(f);
    return src.includes('POLL_ANSWERS') && src.includes('answer_ids');
  }
  function isPollExpire(f) {
    return fnSource(f).includes('POLL_EXPIRE');
  }

  /** A poll from the gateway's object or the client's record: its counts from `results`, or from its vote reactions. */
  function pickPoll(m) {
    const p = m && m.poll;
    if (!p || !p.question) return undefined;
    const results = p.results || null;
    const counts = {};
    const mine = [];
    const counted = !!results || Array.isArray(m.reactions);
    for (const c of results && Array.isArray(results.answer_counts) ? results.answer_counts : []) {
      counts[String(c.id)] = num(c.count) || 0;
      if (c.me_voted === true) mine.push(String(c.id));
    }
    for (const r of Array.isArray(m.reactions) ? m.reactions : []) {
      const v = r && r.count_details && r.count_details.vote;
      if (typeof v !== 'number' || !r.emoji || r.emoji.id == null) continue;
      const id = String(r.emoji.id);
      counts[id] = v;
      if (r.me_vote === true && !mine.includes(id)) mine.push(id);
    }
    return {
      question: str(p.question.text) ?? '',
      answers: (Array.isArray(p.answers) ? p.answers : []).map((a) => ({ id: String(a.answer_id ?? a.answerId), text: str(a.poll_media && a.poll_media.text) ?? '', emoji: (a.poll_media && pickEmoji(a.poll_media.emoji)) || undefined })),
      expiry: isoish(p.expiry) ?? null,
      allow_multiselect: !!(p.allow_multiselect ?? p.allowMultiselect),
      finalized: !!(results && results.is_finalized),
      ...(counted ? { counts, mine } : {}),
    };
  }

  /** The poll as the client's store has it now, when it has the message loaded. */
  function pollNow(channelId, messageId) {
    try {
      const m = mod.MessageStore && mod.MessageStore.getMessage(channelId, messageId);
      return (m && pickPoll(m)) || null;
    } catch (e) {
      return null;
    }
  }

  /** Vote, replacing your vote ([] takes it back), as the poll's Vote button sends it. */
  async function pollVote(cmd) {
    const answerIds = (Array.isArray(cmd.answerIds) ? cmd.answerIds : []).map(String);
    const vote = mod.PollActions && exportedFn(mod.PollActions, 4, isPollVote);
    const call = () => (vote ? vote({ channelId: cmd.channelId, messageId: cmd.messageId, answerIds }) : rest('put', `/channels/${cmd.channelId}/polls/${cmd.messageId}/answers/@me`, undefined, { answer_ids: answerIds }));
    const out = await untilSettled(Promise.resolve().then(call), SERVER_WAIT_MS, 'vote');
    if (out.check) return { check: out.check };
    return { poll: pollNow(cmd.channelId, cmd.messageId) };
  }

  /** End your poll now, as its End Now button does. */
  async function pollEnd(cmd) {
    const expire = mod.PollActions && exportedFn(mod.PollActions, 4, isPollExpire);
    const call = () => (expire ? expire({ channelId: cmd.channelId, messageId: cmd.messageId }) : rest('post', `/channels/${cmd.channelId}/polls/${cmd.messageId}/expire`));
    const out = await untilSettled(Promise.resolve().then(call), SERVER_WAIT_MS, 'end polls');
    if (out.check) return { check: out.check };
    return { ok: true };
  }

  /** A poll, as the client's Create Poll dialog sends it: its own sendPollMessage, a message with no content. */
  async function pollCreate(cmd) {
    const poll = {
      question: { text: String(cmd.question) },
      answers: (cmd.answers || []).map((text) => ({ poll_media: { text: String(text) } })),
      allow_multiselect: !!cmd.multi,
      duration: Number(cmd.hours),
      layout_type: 1,
    };
    const ma = mod.MessageActions;
    const call = () => (ma && typeof ma.sendPollMessage === 'function' ? ma.sendPollMessage(cmd.channelId, poll, { nonce: cmd.nonce }) : rest('post', `/channels/${cmd.channelId}/messages`, undefined, { content: '', nonce: cmd.nonce, tts: false, poll }));
    const out = await untilSettled(Promise.resolve().then(call), SERVER_WAIT_MS, 'make polls');
    if (out.check) return { check: out.check };
    const res = out.value;
    return { nativeId: res && res.body ? res.body.id : null };
  }

  /**
   * Pin or unpin, the request the pin button makes. Its own pinMessage turns a refusal into a dialog in the page and
   * resolves either way, so the same request goes through the client's REST helper, where a refusal can be told.
   */
  async function pinCommand(cmd) {
    const c = mod.ChannelStore.getChannel(cmd.channelId);
    if (!c) throw new Error('Discord does not know that channel');
    const meta = c.threadMetadata || c.thread_metadata;
    if (meta && meta.archived) throw new Error('This thread is archived: open it in Discord to pin in it');
    const url = `/channels/${cmd.channelId}/messages/pins/${cmd.messageId}`;
    const out = await untilSettled(rest(cmd.remove ? 'del' : 'put', url), SERVER_WAIT_MS, cmd.remove ? 'unpin messages' : 'pin messages');
    if (out.check) return { check: out.check };
    return { ok: true };
  }

  /**
   * A channel's pinned messages, newest pin first, the pages the pins popout loads as it is scrolled (its fetchPins
   * only fills its own store and says nothing back, so its request goes through the client's REST helper), then seen,
   * as the popout marks them.
   */
  async function pinnedList(cmd) {
    const channelId = String(cmd.channelId);
    const items = [];
    let more = true;
    let before;
    for (let page = 0; more && page < PINS_PAGES; page++) {
      const res = await rest('get', `/channels/${channelId}/messages/pins`, { limit: PINS_PAGE, ...(before ? { before } : {}) });
      const body = (res && res.body) || {};
      const list = Array.isArray(body.items) ? body.items : [];
      items.push(...list);
      more = !!body.has_more && list.length > 0;
      before = list.length ? list[list.length - 1].pinned_at : undefined;
    }
    try {
      if (mod.PinActions) mod.PinActions.ackPins(channelId);
      else mod.Dispatcher.dispatch({ type: 'CHANNEL_PINS_ACK', channelId });
    } catch (e) {}
    return { pins: items.map((x) => ({ pinned_at: isoish(x.pinned_at) ?? null, message: pickMessage(x.message) })).filter((x) => x.message), more };
  }

  const POLL_COMMANDS = { pollVote, pollEnd, pollCreate, pin: pinCommand, pinnedList };

  // ------------------------------------------------------------------ threads
  // Threads this account follows and how each notifies it, starting threads and forum posts, archiving and locking,
  // a forum's tags, publishing in an announcement channel, and running a group DM it owns (the adapter's threads.ts).
  // Reads come from the client's stores. Writes go through its own thread and private channel actions, as a click on
  // them does, or through its REST helper with the body the client itself sends where its action lives in a React
  // hook (starting a thread or a post) or swallows a refusal into a dialog (joining, publishing, closing a DM). Each
  // write comes from the owner's click on the hub. Read from build 671535 (2026-11-12); the source is read, never run.
  Object.assign(FINDERS, {
    // Which threads this account is in, with each one's notification flags and mute.
    JoinedThreadsStore: isStore('JoinedThreadsStore'),
    // What a thread's header and menus call: join, leave, archive, lock, its notification settings.
    ThreadActions: (m) => typeof m.joinThread === 'function' && typeof m.leaveThread === 'function' && typeof m.archiveThread === 'function' && typeof m.unarchiveThread === 'function' && typeof m.setNotificationSettings === 'function',
  });
  FORWARD.push(
    // This account's own membership of a thread: joined, left, its settings changed (here, in another app, or a mute
    // running out). Other people's are never relayed: no member lists.
    'THREAD_MEMBER_UPDATE',
    'THREAD_MEMBERS_UPDATE',
    // What the client's forum view and thread browser loaded, whoever opened them: posts with their first messages.
    'LOAD_FORUM_POSTS',
    'LOAD_ARCHIVED_THREADS_SUCCESS',
    'LOAD_THREADS_SUCCESS',
  );
  // Discord's numbers: thread member flags, a thread's and a forum's flags, the channel types beyond the old ones.
  const THREAD_FLAG = { HAS_INTERACTED: 1, ALL_MESSAGES: 2, ONLY_MENTIONS: 4, NO_MESSAGES: 8 };
  const POST_PINNED = 2;
  const MEDIA_THREAD = 19;
  const FORUM_TYPES = [15, 16];
  const THREAD_WAIT_MS = 30_000;
  const DEFAULT_ARCHIVE_MINUTES = 4320;
  const THREAD_LOCATION = 'Thread Browser';
  const isThreadType = (t) => THREAD_TYPES.includes(t) || t === MEDIA_THREAD;
  const flagsOf = (c) => num(typeof c.flags === 'number' ? c.flags : c.flags_);

  /** This account's membership of a thread from the store: null when it is not in it, undefined when unknown. */
  function joinedOf(id) {
    const js = mod.JoinedThreadsStore;
    if (!js || !id) return undefined;
    try {
      if (!js.hasJoined(id)) return null;
      const mc = js.getMuteConfig(id);
      return { flags: num(js.flags(id)) ?? 0, muted: js.isMuted(id) === true, mute_end: mc && mc.end_time ? isoOf(mc.end_time) : null };
    } catch (e) {
      return undefined;
    }
  }

  /** What pickChannel adds for a thread (membership, tags, when it started) or a forum (its tags, default order). */
  function threadChannelFields(c) {
    if (!c) return undefined;
    if (isThreadType(c.type)) {
      const tm = c.threadMetadata || c.thread_metadata || {};
      const tags = c.appliedTags ?? c.applied_tags;
      const member = joinedOf(c.id);
      return {
        create_timestamp: isoOf(tm.createTimestamp ?? tm.create_timestamp) ?? undefined,
        applied_tags: Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : undefined,
        message_count: num(c.messageCount ?? c.message_count),
        flags: flagsOf(c),
        invitable: typeof (tm.invitable) === 'boolean' ? tm.invitable : undefined,
        ...(member !== undefined ? { member } : {}),
      };
    }
    if (FORUM_TYPES.includes(c.type)) {
      const tags = c.availableTags ?? c.available_tags;
      return {
        available_tags: Array.isArray(tags) ? tags.map((t) => t && { id: String(t.id), name: String(t.name ?? ''), emoji_name: textOf(t.emojiName ?? t.emoji_name), emoji_id: textOf(t.emojiId ?? t.emoji_id), moderated: !!t.moderated }).filter(Boolean) : undefined,
        default_sort_order: num(c.defaultSortOrder ?? c.default_sort_order),
        default_forum_layout: num(c.defaultForumLayout ?? c.default_forum_layout),
        flags: flagsOf(c),
      };
    }
    return undefined;
  }

  /** Every thread this account is in that the client has, as the snapshot's threads. */
  function joinedThreadChannels() {
    const js = mod.JoinedThreadsStore;
    if (!js || typeof js.getInitialOverlayState !== 'function') return [];
    const out = [];
    for (const j of js.getInitialOverlayState() || []) {
      const c = j && mod.ChannelStore.getChannel(j.threadId);
      if (c) out.push(pickChannel(c));
    }
    return out.filter(Boolean);
  }

  /** A thread this account can see, from the store. */
  function threadOf(id) {
    const c = mod.ChannelStore.getChannel(String(id || ''));
    if (!c || !isThreadType(c.type)) throw new Error('Discord does not know that thread');
    return c;
  }
  const channelNow = (id) => pickChannel(mod.ChannelStore.getChannel(id)) || null;

  /** Its own messages as the client lists threads: first and latest messages, picked. */
  function threadMessages(body) {
    const out = [];
    for (const k of ['first_messages', 'most_recent_messages']) for (const m of Array.isArray(body[k]) ? body[k] : []) out.push(pickMessage(m));
    return out.filter((m) => m && m.id && m.channel_id && m.author);
  }

  /** Follow or unfollow a thread: Join Thread's request without its error dialog, and Leave Thread's own action. */
  async function followThread(cmd) {
    const c = threadOf(cmd.channelId);
    if (cmd.follow) {
      if (!joinedOf(c.id)) {
        const out = await untilSettled(rest('post', `/channels/${c.id}/thread-members/@me`, { location: THREAD_LOCATION }), THREAD_WAIT_MS, 'follow threads');
        if (out.check) return { check: out.check };
        if (!(await landed(() => joinedOf(c.id), 10_000))) throw new Error('Discord took the request but does not list this account in the thread yet; look again soon');
      }
    } else if (joinedOf(c.id) !== null) {
      const ta = needModule('ThreadActions', 'thread module');
      const out = await untilSettled(Promise.resolve().then(() => ta.leaveThread(c, THREAD_LOCATION)), THREAD_WAIT_MS, 'leave threads');
      if (out.check) return { check: out.check };
      await landed(() => joinedOf(c.id) === null, 10_000);
    }
    return { channel: channelNow(c.id) };
  }

  /** How a thread notifies this account, as its bell menu sets it (it joins the thread first when it must). */
  async function threadNotify(cmd) {
    const c = threadOf(cmd.channelId);
    const ta = needModule('ThreadActions', 'thread module');
    const body = {};
    if (cmd.notify) {
      const bit = cmd.notify === 'all' ? THREAD_FLAG.ALL_MESSAGES : cmd.notify === 'mentions' ? THREAD_FLAG.ONLY_MENTIONS : THREAD_FLAG.NO_MESSAGES;
      body.flags = (((joinedOf(c.id) || {}).flags || 0) & THREAD_FLAG.HAS_INTERACTED) | bit;
    }
    if (typeof cmd.muted === 'boolean') {
      body.muted = cmd.muted;
      body.mute_config = cmd.muted && cmd.until ? { end_time: new Date(cmd.until).toISOString() } : null;
    }
    if (!Object.keys(body).length) throw new Error('nothing to change');
    const out = await untilSettled(Promise.resolve().then(() => ta.setNotificationSettings(c, body)), THREAD_WAIT_MS, 'change thread notifications');
    if (out.check) return { check: out.check };
    if (!out.value) throw new Error('Discord is limiting how often this account can change notifications: try again in a minute or so');
    await landed(() => {
      const j = joinedOf(c.id);
      return j && (body.flags === undefined || j.flags === body.flags) && (body.muted === undefined || j.muted === body.muted);
    }, 10_000);
    return { channel: channelNow(c.id) };
  }

  /** Archive, unarchive, lock or unlock: the client's own thread actions, which also tell its stores. */
  async function threadState(cmd) {
    const c = threadOf(cmd.channelId);
    const ta = needModule('ThreadActions', 'thread module');
    const steps = [];
    if (cmd.locked === true) steps.push(() => ta.lockThread(c));
    if (cmd.locked === false) steps.push(() => ta.unlockThread(mod.ChannelStore.getChannel(c.id)));
    if (cmd.archived === true) steps.push(() => ta.archiveThread(mod.ChannelStore.getChannel(c.id), false));
    if (cmd.archived === false) steps.push(() => ta.unarchiveThread(mod.ChannelStore.getChannel(c.id), false));
    if (!steps.length) throw new Error('nothing to change');
    for (const step of steps) {
      const out = await untilSettled(Promise.resolve().then(step), THREAD_WAIT_MS, 'change threads');
      if (out.check) return { check: out.check };
    }
    return { channel: channelNow(c.id) };
  }

  /** How the client sends files: upload slots for the channel, bytes straight to storage, then what names them. */
  async function uploadSlots(channelId, files) {
    const declared = files.map((f, i) => ({ id: String(i), filename: f.name, file_size: f.size }));
    const slots = await rest('post', `/channels/${channelId}/attachments`, undefined, { files: declared });
    return Promise.all(
      slots.body.attachments.map(async (slot) => {
        const f = files[Number(slot.id)];
        const bytes = Uint8Array.from(atob(f.base64), (ch) => ch.charCodeAt(0));
        const put = await fetch(slot.upload_url, { method: 'PUT', body: bytes, headers: { 'content-type': f.mime } });
        if (!put.ok) throw new Error(`uploading ${f.name} failed: HTTP ${put.status}`);
        return { id: slot.id, filename: f.name, uploaded_filename: slot.upload_filename };
      }),
    );
  }

  /** A thread from a message or in a channel, with the body its thread form posts; then its first message, if any. */
  async function createThread(cmd) {
    const parent = mod.ChannelStore.getChannel(String(cmd.channelId || ''));
    if (!parent) throw new Error('Discord does not know that channel');
    const type = cmd.private ? 12 : parent.type === ANNOUNCEMENT ? 10 : 11;
    const body = { name: String(cmd.name), type, auto_archive_duration: num(parent.defaultAutoArchiveDuration ?? parent.default_auto_archive_duration) ?? DEFAULT_ARCHIVE_MINUTES };
    const url = cmd.messageId ? `/channels/${parent.id}/messages/${cmd.messageId}/threads` : `/channels/${parent.id}/threads`;
    const out = await untilSettled(rest('post', url, undefined, body), THREAD_WAIT_MS, 'start threads');
    if (out.check) return { check: out.check };
    const raw = out.value && out.value.body;
    if (!raw || !raw.id) throw new Error('Discord did not say which thread it started');
    let message = null;
    if ((cmd.content && String(cmd.content).trim()) || (cmd.files && cmd.files.length)) {
      const sent = await sendMessage({ channelId: raw.id, content: String(cmd.content || ''), nonce: String(cmd.nonce || Date.now()), files: cmd.files });
      message = sent && sent.nativeId;
    }
    return { channel: pickChannel(raw) || channelNow(raw.id), message };
  }

  /** A forum post as its New Post form sends it: name, tags and first message in one request, files uploaded first. */
  async function createPost(cmd) {
    const forum = mod.ChannelStore.getChannel(String(cmd.channelId || ''));
    if (!forum || !FORUM_TYPES.includes(forum.type)) throw new Error('That is not a forum Discord knows');
    const message = { content: String(cmd.content || ''), sticker_ids: [] };
    if (cmd.files && cmd.files.length) message.attachments = await uploadSlots(forum.id, cmd.files);
    const body = { name: String(cmd.name), auto_archive_duration: num(forum.defaultAutoArchiveDuration ?? forum.default_auto_archive_duration) ?? DEFAULT_ARCHIVE_MINUTES, applied_tags: Array.isArray(cmd.tags) ? cmd.tags.map(String) : [], message };
    const out = await untilSettled(rest('post', `/channels/${forum.id}/threads`, { use_nested_fields: true }, body), THREAD_WAIT_MS, 'start posts');
    if (out.check) return { check: out.check };
    const raw = out.value && out.value.body;
    if (!raw || !raw.id) throw new Error('Discord did not say which post it started');
    return { channel: pickChannel(raw) || channelNow(raw.id), message: raw.message ? pickMessage(raw.message) : null };
  }

  /** Publish to the channels that follow this one: the request the client's Publish button makes, refusals kept. */
  async function crosspost(cmd) {
    const out = await untilSettled(rest('post', `/channels/${cmd.channelId}/messages/${cmd.messageId}/crosspost`), THREAD_WAIT_MS, 'publish messages');
    if (out.check) return { check: out.check };
    return { message: out.value && out.value.body ? pickMessage(out.value.body) : null };
  }

  /** A group DM this account is in, from the store. */
  function groupOf(id) {
    const c = mod.ChannelStore.getChannel(String(id || ''));
    if (!c || (c.type !== 1 && c.type !== 3)) throw new Error('Discord does not know that conversation');
    return c;
  }

  /** Leave a group DM (silently where asked) or close a DM: the request the client's Leave Group and Close DM make. */
  async function leaveGroupDM(cmd) {
    const c = groupOf(cmd.channelId);
    const out = await untilSettled(rest('del', `/channels/${c.id}`, c.type === 3 ? { silent: !!cmd.silent } : undefined), THREAD_WAIT_MS, c.type === 3 ? 'leave groups' : 'close DMs');
    if (out.check) return { check: out.check };
    return { left: true };
  }

  /** Take someone out of a group DM, or hand it to them: the client's own private channel actions. */
  async function groupMember(cmd) {
    const c = groupOf(cmd.channelId);
    if (c.type !== 3) throw new Error('Only a group DM has an owner');
    const pa = mod.PrivateChannelActions;
    const userId = String(cmd.userId || '');
    if (!/^\d+$/.test(userId)) throw new Error('who?');
    const call =
      cmd.op === 'remove'
        ? () => (pa && typeof pa.removeRecipient === 'function' ? pa.removeRecipient(c.id, userId) : rest('del', `/channels/${c.id}/recipients/${userId}`))
        : () => (pa && typeof pa.setDMOwner === 'function' ? pa.setDMOwner(c.id, userId) : rest('patch', `/channels/${c.id}`, undefined, { owner: userId }));
    const out = await untilSettled(Promise.resolve().then(call), THREAD_WAIT_MS, cmd.op === 'remove' ? 'remove people from groups' : 'hand groups over');
    if (out.check) return { check: out.check };
    if (cmd.op === 'remove') await landed(() => !((mod.ChannelStore.getChannel(c.id) || {}).recipients || []).includes(userId), 5000);
    else await landed(() => (mod.ChannelStore.getChannel(c.id) || {}).ownerId === userId, 5000);
    return { channel: channelNow(c.id) };
  }

  /** A group DM's picture (a data URL) or none: the body its Change Icon sends. */
  async function groupIcon(cmd) {
    const c = groupOf(cmd.channelId);
    if (c.type !== 3) throw new Error('Only a group DM has a picture');
    const icon = cmd.dataUrl ? String(cmd.dataUrl) : null;
    if (icon && !/^data:image\/(png|jpeg|gif|webp);base64,/.test(icon)) throw new Error('A picture is a PNG, JPEG, GIF or WebP');
    const out = await untilSettled(rest('patch', `/channels/${c.id}`, undefined, { icon }), THREAD_WAIT_MS, 'change group pictures');
    if (out.check) return { check: out.check };
    const raw = out.value && out.value.body;
    return { channel: (raw && pickChannel(raw)) || channelNow(c.id) };
  }

  /** Where each page of a channel's private archived threads starts: the archive time the page before ended at. */
  const myBefore = new Map();
  /** The private archived threads this account is in, as the thread browser's Private tab lists them. */
  async function myArchivedThreads(cmd) {
    const offset = Math.max(0, Number(cmd.offset) || 0);
    const before = offset ? myBefore.get(`${cmd.channelId}:${offset}`) : undefined;
    if (offset && !before) return { threads: [], more: false, messages: [] };
    const res = await rest('get', `/channels/${cmd.channelId}/users/@me/threads/archived/private`, { limit: 50, ...(before ? { before } : {}) });
    const body = (res && res.body) || {};
    const list = (Array.isArray(body.threads) ? body.threads : []).map(pickChannel).filter((c) => c && c.id);
    const last = (Array.isArray(body.threads) ? body.threads : []).slice(-1)[0];
    const at = last && last.thread_metadata && last.thread_metadata.archive_timestamp;
    if (body.has_more && at) myBefore.set(`${cmd.channelId}:${offset + list.length}`, at);
    return { threads: list, more: !!body.has_more && !!at, messages: [] };
  }

  /** The dispatches, shrunk: only this account's own membership, and what the client's own views loaded. */
  const SHRINK_THREADS = {
    THREAD_MEMBER_UPDATE: (a) => {
      const me = currentUser();
      if (!me || String(a.userId ?? a.user_id) !== me.id) return null;
      const c = channelNow(String(a.id));
      return c ? { channels: [c] } : null;
    },
    THREAD_MEMBERS_UPDATE: (a) => {
      const me = currentUser();
      if (!me) return null;
      const added = (a.addedMembers || []).some((m) => m && String(m.userId ?? m.user_id) === me.id);
      const removed = (a.removedMemberIds || []).map(String).includes(me.id);
      if (!added && !removed) return null;
      const c = channelNow(String(a.id));
      return c ? { channels: [c] } : null;
    },
    LOAD_FORUM_POSTS: (a) => {
      const messages = [];
      for (const v of Object.values(a.threads || {})) if (v && (v.first_message || v.firstMessage)) messages.push(pickMessage(v.first_message || v.firstMessage));
      const ok = messages.filter((m) => m && m.id && m.channel_id && m.author);
      return ok.length ? { messages: ok, channels: channelsOf(ok) } : null;
    },
    LOAD_ARCHIVED_THREADS_SUCCESS: (a) => loadedThreads(a),
    LOAD_THREADS_SUCCESS: (a) => loadedThreads(a),
  };
  function loadedThreads(a) {
    const channels = (Array.isArray(a.threads) ? a.threads : []).map(pickChannel).filter((c) => c && c.id);
    const messages = threadMessages({ first_messages: a.firstMessages, most_recent_messages: a.mostRecentMessages });
    return channels.length || messages.length ? { channels, messages } : null;
  }

  const THREAD_COMMANDS = { followThread, threadNotify, threadState, createThread, createPost, crosspost, leaveGroupDM, groupMember, groupIcon, myArchivedThreads };

  // ---------------------------------------------------------------- in a call
  // What the call you are in offers beyond joining it (docs/calls.md "In a call"): one person's volume and mute for this
  // account only, the microphone's handling, stages, the soundboard and voice effects. The client's own settings
  // actions and its own requests, as its call view, user menu and soundboard run them. Read from build 671535
  // (2026-11-12); the client's source is read, never run.
  Object.assign(FINDERS, {
    // Its user menu's volume slider and Mute: the audio settings module, with these two.
    LocalVolume: (m) => typeof m.setLocalVolume === 'function' && typeof m.toggleLocalMute === 'function' && typeof m.toggleSelfMute === 'function',
    // Its Voice settings: input mode with the sensitivity threshold, and noise suppression.
    InputSettings: (m) => typeof m.setMode === 'function' && typeof m.setNoiseSuppression === 'function' && typeof m.toggleSelfMute === 'function',
    StageInstanceStore: isStore('StageInstanceStore'),
    SoundboardStore: isStore('SoundboardStore'),
  });
  Object.assign(PERM, { muteMembers: 1n << 22n, deafenMembers: 1n << 23n, moveMembers: 1n << 24n, useSoundboard: 1n << 42n });
  const STAGE = 13;
  const VOLUME_MAX = 200;
  /** Remote tracks in the bridge's mix, each with its own gain. */
  const mixed = new Set();

  /** A stage's role for a voice state: speaking, listening, hand up, or invited and not yet answered (the client's own reading). */
  function stageRole(v) {
    const hand = v.requestToSpeakTimestamp ?? v.request_to_speak_timestamp ?? null;
    if (v.suppress) return hand ? 'hand' : 'audience';
    return hand ? 'invited' : 'speaker';
  }

  /** What a participant adds beyond mute and speaking: Go Live, a server mute, your volume for them, their place on a stage. */
  function inCallExtras(id, v, stage) {
    const out = {};
    if (v.selfStream) out.streaming = true;
    if (v.mute) out.serverMuted = true;
    if (v.deaf) out.serverDeafened = true;
    const me = currentUser();
    const ms = mod.MediaEngineStore;
    if (ms && !(me && me.id === id)) {
      try {
        const vol = typeof ms.getLocalVolume === 'function' ? ms.getLocalVolume(id) : null;
        if (typeof vol === 'number' && Math.round(vol) !== 100) out.volume = Math.max(0, Math.min(VOLUME_MAX, Math.round(vol)));
      } catch (e) {}
      try {
        if (typeof ms.isLocalMute === 'function' && ms.isLocalMute(id)) out.localMute = true;
      } catch (e) {}
    }
    if (stage) out.stage = stageRole(v);
    return out;
  }

  /** A stage's own facts, or null when the call is not on one. */
  function stageOf(channelId) {
    const ch = mod.ChannelStore.getChannel(channelId);
    if (!ch || ch.type !== STAGE) return null;
    let topic = null;
    try {
      const si = mod.StageInstanceStore && mod.StageInstanceStore.getStageInstanceByChannel(channelId);
      topic = (si && si.topic) || null;
    } catch (e) {}
    return { topic, moderator: strictly(PERM.muteMembers, ch) };
  }

  /** Whose a remote track is, by the client's own per-person outputs; null when it cannot say. */
  function trackOwner(track) {
    let owner = null;
    try {
      const eng = mod.MediaEngineStore && mod.MediaEngineStore.getMediaEngine();
      if (!eng || typeof eng.eachConnection !== 'function') return null;
      eng.eachConnection((c) => {
        const outs = (c && c.conn && c.conn.outputs) || (c && c.outputs) || {};
        for (const id of Object.keys(outs)) {
          const o = outs[id];
          if (o && o.stream && typeof o.stream.getTracks === 'function' && o.stream.getTracks().includes(track)) owner = id;
        }
      });
    } catch (e) {}
    return owner;
  }

  /** One track's gain in the mix: the client's volume and mute for its owner, or as it is when the owner is unknown. */
  function regainTrack(track) {
    const sink = sinks.get(track);
    if (!sink || !sink.gain) return;
    const owner = trackOwner(track);
    let g = 1;
    const ms = mod.MediaEngineStore;
    if (owner && ms) {
      try {
        if (typeof ms.isLocalMute === 'function' && ms.isLocalMute(owner)) g = 0;
        else if (typeof ms.getLocalVolume === 'function') g = Math.max(0, Math.min(VOLUME_MAX, Number(ms.getLocalVolume(owner)) || 0)) / 100;
      } catch (e) {}
    }
    sink.gain.gain.value = g;
  }
  function regain() {
    for (const t of mixed) regainTrack(t);
  }

  /** One person's volume or mute, for this account only, as its user menu sets them. */
  function callLocal(cmd) {
    const act = mod.AudioActions;
    const ms = mod.MediaEngineStore;
    if (!act || typeof act.setLocalVolume !== 'function' || typeof act.toggleLocalMute !== 'function' || !ms) throw new Error('the client has no per-person volume (Discord changed?)');
    const uid = String(cmd.user || '');
    if (!/^\d+$/.test(uid)) throw new Error('whom?');
    const me = currentUser();
    if (me && uid === me.id) throw new Error('That is you');
    if (typeof cmd.volume === 'number' && Number.isFinite(cmd.volume)) act.setLocalVolume(uid, Math.max(0, Math.min(VOLUME_MAX, Math.round(cmd.volume))));
    if (typeof cmd.muted === 'boolean' && !!ms.isLocalMute(uid) !== cmd.muted) act.toggleLocalMute(uid);
    regain();
    return { ok: true };
  }

  /** The microphone's handling, in the client's own voice settings: noise suppression, and when it counts as speaking. */
  function applyInput(input) {
    const act = mod.AudioActions;
    const ms = mod.MediaEngineStore;
    if (!act || typeof act.setMode !== 'function' || typeof act.setNoiseSuppression !== 'function' || !ms) throw new Error('the client has no voice settings module (Discord changed?)');
    const i = input || {};
    const ns = i.noiseSuppression !== false;
    // Its stronger noise cancellation (Krisp) turns plain suppression off; off means both off.
    try {
      if (!ns && typeof ms.getNoiseCancellation === 'function' && ms.getNoiseCancellation() && typeof act.setNoiseCancellation === 'function') act.setNoiseCancellation(false);
    } catch (e) {}
    try {
      if (typeof ms.getNoiseSuppression !== 'function' || !!ms.getNoiseSuppression() !== ns) act.setNoiseSuppression(ns);
    } catch (e) {}
    const auto = i.sensitivity === 'auto' || typeof i.sensitivity !== 'number';
    const threshold = auto ? null : Math.max(-100, Math.min(0, Math.round(i.sensitivity)));
    let mode = 'VOICE_ACTIVITY';
    try {
      mode = (ms.getMode && ms.getMode()) || mode;
    } catch (e) {}
    // Push to talk has no threshold; a bridge never pushes, so it only matters for voice activity.
    if (mode === 'VOICE_ACTIVITY') act.setMode('VOICE_ACTIVITY', auto ? { autoThreshold: true } : { autoThreshold: false, threshold });
    return { ok: true };
  }

  function callChannel() {
    const ch = call.channelId && mod.ChannelStore.getChannel(call.channelId);
    if (!ch) throw new Error('not in a call');
    return ch;
  }
  function guildIdOf(ch) {
    return ch.guild_id || (typeof ch.getGuildId === 'function' ? ch.getGuildId() : null);
  }

  /**
   * A stage action: your hand up or down, speaking when invited (or as a moderator), back to the audience; a moderator's
   * invite to speak and move to the audience. The requests the client's stage module sends (PATCH voice-states).
   */
  async function callStage(cmd) {
    const ch = callChannel();
    if (ch.type !== STAGE) throw new Error('This call is not on a stage');
    const gid = guildIdOf(ch);
    const me = currentUser();
    const moderator = strictly(PERM.muteMembers, ch);
    let mine = null;
    try {
      mine = me && mod.VoiceStateStore.getVoiceStatesForChannel(ch.id)[me.id];
    } catch (e) {}
    const url = (u) => `/guilds/${gid}/voice-states/${u || '@me'}`;
    const other = () => {
      const uid = String(cmd.user || '');
      if (!/^\d+$/.test(uid)) throw new Error('whom?');
      if (!moderator) throw new Error('Only a stage moderator can do that (Mute Members)');
      return uid;
    };
    switch (cmd.action) {
      case 'raiseHand':
        await rest('patch', url(), undefined, { request_to_speak_timestamp: new Date().toISOString(), channel_id: ch.id });
        break;
      case 'lowerHand':
        await rest('patch', url(), undefined, { request_to_speak_timestamp: null, channel_id: ch.id });
        break;
      case 'speak':
        if (!moderator && !(mine && stageRole(mine) === 'invited')) throw new Error('Raise your hand: a moderator invites you to speak');
        await rest('patch', url(), undefined, { suppress: false, request_to_speak_timestamp: null, channel_id: ch.id });
        break;
      case 'listen':
        await rest('patch', url(), undefined, { suppress: true, channel_id: ch.id, self_video: false, self_stream: false });
        break;
      case 'invite':
        await rest('patch', url(other()), undefined, { suppress: false, request_to_speak_timestamp: new Date().toISOString(), channel_id: ch.id });
        break;
      case 'audience':
        await rest('patch', url(other()), undefined, { suppress: true, channel_id: ch.id, self_video: false, self_stream: false });
        break;
      default:
        throw new Error('not a stage action');
    }
    return { ok: true };
  }

  /** The soundboard's sounds this account may play here: the server's own and Discord's defaults, as the client has them. */
  function callSounds() {
    const ch = callChannel();
    if (!mod.SoundboardStore) throw new Error('the client has no soundboard (Discord changed?)');
    if (!strictly(PERM.useSoundboard, ch)) return { sounds: [], reason: 'You need the Use Soundboard permission here.' };
    let all = null;
    try {
      all = mod.SoundboardStore.getSounds();
    } catch (e) {}
    const of = (g) => {
      try {
        return (all && typeof all.get === 'function' ? all.get(g) : all && all[g]) || [];
      } catch (e) {
        return [];
      }
    };
    const gid = guildIdOf(ch);
    const list = [...(gid ? of(gid) : []), ...of('0')].filter((x) => x && x.soundId && x.available !== false);
    if (!list.length) return { sounds: [], reason: 'Discord has not loaded any sounds here yet: open the soundboard once in Discord.' };
    return {
      sounds: list.slice(0, 200).map((x) => ({ id: String(x.soundId), name: String(x.name || 'sound'), guild: String(x.guildId ?? '0'), ...(x.emojiName && !x.emojiId ? { emoji: String(x.emojiName) } : {}) })),
    };
  }

  /** Play a sound to everyone in the call, as the client's soundboard sends it. */
  async function callSound(cmd) {
    const ch = callChannel();
    if (!strictly(PERM.useSoundboard, ch)) throw new Error('You need the Use Soundboard permission here');
    const g = String(cmd.guild || '');
    if (g !== '0' && g !== guildIdOf(ch)) throw new Error("Only this server's sounds and Discord's own");
    let sound = null;
    try {
      sound = mod.SoundboardStore && mod.SoundboardStore.getSound(g, String(cmd.sound || ''));
    } catch (e) {}
    if (!sound) throw new Error('No such sound here');
    const body = { sound_id: String(sound.soundId), emoji_id: sound.emojiId ?? null, emoji_name: sound.emojiName ?? null };
    if (g !== '0') body.source_guild_id = g;
    await rest('post', `/channels/${ch.id}/send-soundboard-sound`, undefined, body);
    return { ok: true };
  }

  /** Someone played a sound or sent an emoji in the call this account is in: to the device, and a sound into the bridge's mix. */
  function onEffect(a) {
    if (!call.id || !a || (a.channelId ?? a.channel_id) !== call.channelId) return;
    const who = a.userId ?? a.user_id;
    if (!who) return;
    const e = a.emoji;
    const effect = { who: String(who) };
    if (e && e.name) effect.emoji = String(e.name);
    const soundId = a.soundId ?? a.sound_id;
    if (soundId) {
      let name = a.soundName ?? null;
      try {
        const known = mod.SoundboardStore && mod.SoundboardStore.getSoundById(String(soundId));
        name = name || (known && known.name) || null;
      } catch (err) {}
      effect.sound = { id: String(soundId), name: name || 'a sound' };
      playIntoMix(String(soundId), a.soundVolume ?? a.sound_volume);
    }
    if (effect.emoji || effect.sound) callUp({ effect });
  }

  /** A sound is played by every client itself, never sent as audio: the bridge plays it into its mix, from the same link the client uses. */
  function playIntoMix(soundId, volume) {
    if (call.mode !== 'bridge' || !call.ctx || !/^\d+$/.test(soundId)) return;
    try {
      const el = new Audio();
      el.crossOrigin = 'anonymous';
      el.src = `https://cdn.discordapp.com/soundboard-sounds/${soundId}`;
      const src = call.ctx.createMediaElementSource(el);
      const g = call.ctx.createGain();
      g.gain.value = typeof volume === 'number' && volume >= 0 ? Math.min(1, volume) : 1;
      src.connect(g);
      g.connect(call.mix);
      el.addEventListener('ended', () => {
        try {
          src.disconnect();
          g.disconnect();
        } catch (e) {}
      });
      el.play().catch(() => {});
    } catch (e) {
      log('debug', 'a sound did not play into the bridge', String(e));
    }
  }

  const IN_CALL = { local: callLocal, input: (cmd) => applyInput(cmd.input), stage: callStage, sounds: callSounds, sound: callSound };

  // -------------------------------------------------------------- moderation
  // A moderator's actions on a server's members and on others' messages and reactions, each from the owner's click,
  // one at a time: checked again here against the client's own permission and hierarchy checks (PermissionStore.can
  // and canManageUser, failing closed), then the client's own moderation actions as its member menu runs them (Kick,
  // Ban, Timeout, Roles), or its REST helper with the same request where that module is in a chunk not loaded yet.
  // Read from build 671535 (2026-11-12); the client's source is read, never run.
  Object.assign(FINDERS, {
    // Its member menu's Kick, Ban and Timeout and its server settings' Bans list: one module.
    ModActions: (m) => typeof m.kickUser === 'function' && typeof m.banUser === 'function' && typeof m.unbanUser === 'function' && typeof m.setCommunicationDisabledUntil === 'function',
  });
  // Read with the others by canAll, so the about says them too.
  Object.assign(PERM, { kickMembers: 1n << 1n, banMembers: 1n << 2n, moderateMembers: 1n << 40n });
  // The ban dialog's choices for deleting their recent messages, and the longest timeout Discord takes.
  const BAN_DELETE_S = [0, 3600, 21600, 43200, 86400, 259200, 604800];
  const TIMEOUT_MAX_S = 28 * 86400;
  const BANS_MAX = 1000;
  const NEEDS = { kickMembers: 'Kick Members', banMembers: 'Ban Members', moderateMembers: 'Timeout Members', manageRoles: 'Manage Roles', manageMessages: 'Manage Messages' };
  const OUTRANKED = 'They have a role as high as yours, or own the server';

  /** The client's own check, yes only when it says yes. */
  function strictly(bit, subject) {
    try {
      return !!subject && !!mod.PermissionStore && mod.PermissionStore.can(bit, subject) === true;
    } catch (e) {
      return false;
    }
  }
  /** Whether this account may use a permission on this member, by the client's hierarchy check; null when it cannot say. */
  function manages(bit, userId, g) {
    try {
      const ps = mod.PermissionStore;
      return ps && typeof ps.canManageUser === 'function' ? ps.canManageUser(bit, userId, g) === true : null;
    } catch (e) {
      return null;
    }
  }
  function topPosition(g) {
    try {
      const r = mod.PermissionStore && typeof mod.PermissionStore.getHighestRole === 'function' ? mod.PermissionStore.getHighestRole(g) : null;
      return r && typeof r.position === 'number' ? r.position : null;
    } catch (e) {
      return null;
    }
  }
  function memberRecord(guildId, userId) {
    try {
      return (mod.GuildMemberStore && mod.GuildMemberStore.getMember(guildId, userId)) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * What the about adds for moderating, from the stores: per loaded member whether this account may act on them and
   * their timeout, its own top role, the server's boost tier, and the settings a plain PATCH changes.
   */
  function aboutMore(out) {
    const g = out.guild ? guildOf(out.guild.id) : null;
    if (g) {
      out.top_position = topPosition(g);
      out.premium_tier = Number(g.premiumTier ?? g.premium_tier ?? 0) || 0;
      for (const m of out.members || []) {
        const id = m.user && m.user.id;
        if (!id) continue;
        m.manage = { kickMembers: manages(PERM.kickMembers, id, g), banMembers: manages(PERM.banMembers, id, g), moderateMembers: manages(PERM.moderateMembers, id, g), manageRoles: manages(PERM.manageRoles, id, g) };
        const rec = memberRecord(g.id, id);
        const until = rec && (rec.communicationDisabledUntil ?? rec.communication_disabled_until);
        if (until) m.timeout_until = String(until);
      }
    }
    if (out.channel) {
      const c = mod.ChannelStore.getChannel(out.channel.id);
      if (c) {
        out.channel.default_auto_archive_duration = c.defaultAutoArchiveDuration ?? c.default_auto_archive_duration ?? null;
        out.channel.user_limit = c.userLimit ?? c.user_limit ?? null;
        out.channel.bitrate = c.bitrate ?? null;
      }
    }
    return out;
  }

  /** One action on a member: kick, ban (with how much of their history), unban, timeout, a role given or taken. */
  async function moderate(cmd) {
    const g = inGuild(cmd.guildId);
    const me = currentUser();
    const uid = String(cmd.userId || '');
    if (!/^\d+$/.test(uid)) throw new Error('to whom?');
    if (me && uid === me.id) throw new Error('That is you');
    if (VOICE_OPS.includes(cmd.op)) return moderateVoice(g, uid, cmd);
    const need = { kick: 'kickMembers', ban: 'banMembers', unban: 'banMembers', timeout: 'moderateMembers', role: 'manageRoles' }[cmd.op];
    if (!need) throw new Error('unknown action');
    if (!strictly(PERM[need], g)) throw new Error('You need the ' + NEEDS[need] + ' permission');
    // Someone not in the server (a ban of someone who left) has no roles to outrank you with; anyone else must be below you.
    if (cmd.op !== 'unban' && manages(PERM[need], uid, g) === false) throw new Error(OUTRANKED);
    const ma = mod.ModActions;
    switch (cmd.op) {
      case 'kick':
        if (!memberRecord(g.id, uid)) throw new Error('Discord has not loaded them as a member here');
        if (ma) await ma.kickUser(g.id, uid, '');
        else await rest('del', `/guilds/${g.id}/members/${uid}`, { reason: '' });
        break;
      case 'ban': {
        const s = BAN_DELETE_S.includes(cmd.deleteSeconds) ? cmd.deleteSeconds : 0;
        if (ma) await ma.banUser(g.id, uid, s, '');
        else await rest('put', `/guilds/${g.id}/bans/${uid}`, undefined, { delete_message_seconds: s });
        break;
      }
      case 'unban':
        if (ma) await ma.unbanUser(g.id, uid);
        else await rest('del', `/guilds/${g.id}/bans/${uid}`);
        break;
      case 'timeout': {
        const s = Number(cmd.seconds);
        if (!Number.isInteger(s) || s < 0 || s > TIMEOUT_MAX_S) throw new Error('a timeout is at most 28 days');
        if (!memberRecord(g.id, uid)) throw new Error('Discord has not loaded them as a member here');
        const until = s ? new Date(Date.now() + s * 1000).toISOString() : null;
        if (ma) await ma.setCommunicationDisabledUntil({ guildId: g.id, userId: uid, communicationDisabledUntilTimestamp: until, duration: s || null, reason: '', location: 'Member Menu' });
        else await rest('patch', `/guilds/${g.id}/members/${uid}`, undefined, { communication_disabled_until: until });
        break;
      }
      case 'role': {
        const rid = String(cmd.roleId || '');
        const role = guildRoles(g).find((r) => r.id === rid);
        if (!role || rid === g.id) throw new Error('No such role here');
        if (role.managed) throw new Error('That role is managed by an integration or boosting: Discord gives and takes it itself');
        const owner = me && (g.ownerId ?? g.owner_id) === me.id;
        const top = topPosition(g);
        if (!owner && (top === null || role.position >= top)) throw new Error('You can only give or take roles below your own top role');
        const rec = memberRecord(g.id, uid);
        if (!rec) throw new Error('Discord has not loaded them as a member here');
        const now = Array.isArray(rec.roles) ? rec.roles.slice() : [];
        if (cmd.remove ? !now.includes(rid) : now.includes(rid)) return { ok: true, unchanged: true };
        const next = cmd.remove ? now.filter((r) => r !== rid) : [...now, rid];
        const ga = mod.GuildActions;
        if (ga && typeof ga.updateMemberRoles === 'function') await ga.updateMemberRoles(g.id, uid, next, cmd.remove ? [] : [rid], cmd.remove ? [rid] : []);
        else await rest('patch', `/guilds/${g.id}/members/${uid}`, undefined, { roles: next });
        break;
      }
    }
    return { ok: true };
  }

  const VOICE_OPS = ['voiceMute', 'voiceDeafen', 'move', 'disconnect'];
  const VOICE_NEEDS = { voiceMute: ['muteMembers', 'Mute Members'], voiceDeafen: ['deafenMembers', 'Deafen Members'], move: ['moveMembers', 'Move Members'], disconnect: ['moveMembers', 'Move Members'] };

  /** Where someone is in voice in this server now, by the client's voice states; null when nowhere. */
  function voiceStateIn(g, uid) {
    try {
      const all = (mod.VoiceStateStore && mod.VoiceStateStore.getAllVoiceStates()) || {};
      const v = (all[g.id] || {})[uid];
      return v && (v.channelId || v.channel_id) ? v : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Someone in voice: server mute or deafen, move, disconnect, as the client's member menu runs them (its guild
   * actions' setServerMute, setServerDeaf and setChannel), after its permission check in the channel they are in.
   * No rank is needed above theirs, as in the client.
   */
  async function moderateVoice(g, uid, cmd) {
    const [perm, name] = VOICE_NEEDS[cmd.op];
    const v = voiceStateIn(g, uid);
    if (!v) throw new Error('They are not in a voice channel here');
    const here = mod.ChannelStore.getChannel(v.channelId || v.channel_id);
    if (!strictly(PERM[perm], here || g)) throw new Error('You need the ' + name + ' permission there');
    const ga = mod.GuildActions;
    const patch = (body) => rest('patch', `/guilds/${g.id}/members/${uid}`, undefined, body);
    switch (cmd.op) {
      case 'voiceMute':
        if (ga && typeof ga.setServerMute === 'function') await ga.setServerMute(g.id, uid, !!cmd.on);
        else await patch({ mute: !!cmd.on });
        break;
      case 'voiceDeafen':
        if (ga && typeof ga.setServerDeaf === 'function') await ga.setServerDeaf(g.id, uid, !!cmd.on);
        else await patch({ deaf: !!cmd.on });
        break;
      case 'move': {
        const to = mod.ChannelStore.getChannel(String(cmd.channelId || ''));
        if (!to || guildIdOf(to) !== g.id || (to.type !== 2 && to.type !== STAGE)) throw new Error('Move them to a voice channel of this server');
        if (to.id === (v.channelId || v.channel_id)) return { ok: true, unchanged: true };
        if (!strictly(PERM.moveMembers, to)) throw new Error('You need the Move Members permission in that channel');
        // Its setChannel sends this without handing back the answer: the helper, so a refusal comes back in words.
        await patch({ channel_id: to.id });
        break;
      }
      case 'disconnect':
        await patch({ channel_id: null });
        break;
    }
    return { ok: true };
  }

  /** The server's Bans list, one read of up to a thousand as its settings page makes it. */
  async function bans(cmd) {
    const g = inGuild(cmd.guildId);
    if (!strictly(PERM.banMembers, g)) throw new Error('You need the Ban Members permission');
    const res = await rest('get', `/guilds/${g.id}/bans`, { limit: BANS_MAX });
    const list = Array.isArray(res && res.body) ? res.body : [];
    return { bans: list.map((b) => ({ user: pickUser(b && b.user), reason: (b && b.reason) || null })).filter((b) => b.user), more: list.length >= BANS_MAX };
  }

  /** Others' messages here: what this account may do to them (delete, clear reactions), by Manage Messages. */
  function canModerateMessages(channelId) {
    const c = mod.ChannelStore.getChannel(channelId);
    const guildId = c && (c.guild_id ?? (typeof c.getGuildId === 'function' ? c.getGuildId() : null));
    return !!guildId && strictly(PERM.manageMessages, c);
  }

  /** Reactions taken off as a moderator: all, one emoji's, or one person's normal reaction, as the client's own menus do. */
  async function clearReactions(cmd) {
    if (!canModerateMessages(cmd.channelId)) throw new Error('You need the Manage Messages permission here');
    const base = `/channels/${cmd.channelId}/messages/${cmd.messageId}/reactions`;
    if (!cmd.emoji) await rest('del', base);
    else if (!cmd.userId) await rest('del', `${base}/${encodeURIComponent(cmd.emoji)}`);
    else await rest('del', `${base}/${encodeURIComponent(cmd.emoji)}/0/${cmd.userId}`, { location: 'Message', burst: false });
    return { ok: true };
  }

  /** Someone else's message deleted as a moderator: the same delete, after the client says Manage Messages here. */
  async function modRedact(cmd) {
    if (!canModerateMessages(cmd.channelId)) throw new Error('You need the Manage Messages permission here');
    if (mod.MessageActions && mod.MessageActions.deleteMessage) return mod.MessageActions.deleteMessage(cmd.channelId, cmd.messageId), { ok: true };
    await rest('del', `/channels/${cmd.channelId}/messages/${cmd.messageId}`);
    return { ok: true };
  }

  const MOD_COMMANDS = { moderate, bans, clearReactions, modRedact };

  // ------------------------------------------------------------- sending extras
  // A send's silent and no-ping options, previews off your own message, saved messages and reminders, Discord's own
  // scheduled messages, and the emoji picker's order (the adapter's sending.ts). Everything goes through the client's
  // own modules or its REST helper with the request its own button sends. Read from the client's source (build of
  // 2026-11-12), never run.
  Object.assign(FINDERS, {
    // Its Saved list's store: reminders and saved messages, which it loads by itself on connecting.
    SavedMessagesStore: isStore('SavedMessagesStore'),
    // Its save, remove and Saved-list fetch: where the message menu's Save and Remind me end.
    SavedMessageActions: (m) => !!exportedFn(m, 6, isSavePut),
    // Its Scheduled list's actions (cancel among them).
    ScheduledMessageActions: (m) => !!exportedFn(m, 8, isScheduledCancel),
    // Whether this account has scheduled messages (an experiment), as its composer asks before offering them.
    ScheduledMessageGate: (m) => !!exportedFn(m, 24, isScheduledGate),
    // The servers' most used emoji, as its emoji picker keeps them (persisted; the picker fetches them, never this).
    TopEmojiStore: isStore('TopEmojiStore'),
  });
  const sourceHas = (f, ...words) => {
    const src = fnSource(f);
    return words.every((w) => src.includes(w));
  };
  function isSavePut(f) {
    return sourceHas(f, 'PUT_SAVED_MESSAGE', 'due_at');
  }
  function isSaveDelete(f) {
    return sourceHas(f, 'DELETE_SAVED_MESSAGE');
  }
  function isBookmarksFetch(f) {
    return sourceHas(f, 'GET_BOOKMARKS', 'BOOKMARKS_FETCH_SUCCESS');
  }
  function isScheduledCancel(f) {
    return sourceHas(f, 'SCHEDULED_MESSAGES_DELETE_START');
  }
  function isScheduledGate(f) {
    return f.length === 2 && sourceHas(f, '.getConfig({location:', '.isPrivate()', 'SEND_MESSAGES');
  }

  FORWARD.push(
    // What the client loads by itself on connecting: its reminders whole, the rest by id.
    'SAVED_MESSAGES_UPDATE',
    // Saved or removed here, in another app, or by its own Save.
    'SAVED_MESSAGE_CREATE',
    'SAVED_MESSAGE_DELETE',
    // Its own timer: a reminder is due.
    'MESSAGE_REMINDER_DUE',
  );

  const FLAG_SUPPRESS_EMBEDS = 1 << 2;
  const FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12;
  const MENTION_PARSE = ['users', 'roles', 'everyone'];

  /** A send's silent and no-ping, as the client's own send options (its reply bar's @ toggle and @silent). */
  function sendOptionsOf(cmd) {
    return {
      ...(cmd.silent ? { flags: FLAG_SUPPRESS_NOTIFICATIONS } : {}),
      ...(cmd.replyTo && cmd.mentionReplied === false ? { allowedMentions: { parse: MENTION_PARSE.slice(), replied_user: false } } : {}),
    };
  }
  /** The same, as the request body the client's send makes of them. */
  function restSendFields(cmd) {
    const o = sendOptionsOf(cmd);
    return { ...(o.flags ? { flags: o.flags } : {}), ...(o.allowedMentions ? { allowed_mentions: o.allowedMentions } : {}) };
  }

  /** A server's emoji in the order its picker shows its most used first; the rest as they were. */
  function byTopEmoji(guildId, list) {
    let top = null;
    try {
      top = mod.TopEmojiStore ? mod.TopEmojiStore.getTopEmojiIdsByGuildId(guildId) : null;
    } catch (e) {}
    if (!Array.isArray(top) || !top.length) return list;
    const rank = new Map(top.map((id, i) => [String(id), i]));
    return list
      .map((e, i) => [e, i])
      .sort((a, b) => (rank.get(String(a[0].id)) ?? 1e6 + a[1]) - (rank.get(String(b[0].id)) ?? 1e6 + b[1]))
      .map((x) => x[0]);
  }

  /** A saved message as the client keeps it ({ message, saveData }), in the API's shape. */
  function pickSaved(x) {
    const d = x && x.saveData;
    if (!d || !d.messageId) return null;
    return {
      channel_id: String(d.channelId),
      message_id: String(d.messageId),
      guild_id: d.guildId ?? null,
      saved_at: isoOf(d.savedAt),
      due_at: d.dueAt ? isoOf(d.dueAt) : null,
      notes: textOf(d.notes),
      author_summary: textOf(d.authorSummary),
      channel_summary: textOf(d.channelSummary),
      message_summary: textOf(d.messageSummary),
      message: x.message ? pickMessage(x.message) : null,
    };
  }

  const SHRINK_SENDING = {
    SAVED_MESSAGES_UPDATE: (a) => ({ saved: (Array.isArray(a.reminders) ? a.reminders : []).map(pickSaved).filter(Boolean) }),
    SAVED_MESSAGE_CREATE: (a) => {
      const one = pickSaved(a.savedMessage);
      return one ? { saved: [one] } : null;
    },
    SAVED_MESSAGE_DELETE: (a) => (a.savedMessageData && a.savedMessageData.messageId ? { channel_id: String(a.savedMessageData.channelId), message_id: String(a.savedMessageData.messageId) } : null),
    MESSAGE_REMINDER_DUE: (a) => {
      const one = pickSaved(a.savedMessage);
      return one ? { saved: one } : null;
    },
  };

  /** Previews off your own message: the patch the client's own "Remove embeds" sends, with the flags it has. */
  async function suppressEmbeds(cmd) {
    let flags = null;
    try {
      const held = mod.MessageStore && mod.MessageStore.getMessage(cmd.channelId, cmd.messageId);
      if (held) flags = held.flags || 0;
    } catch (e) {}
    if (flags === null) {
      // Not loaded in the client: read it as jumping to it does.
      const res = await rest('get', `/channels/${cmd.channelId}/messages`, { around: cmd.messageId, limit: 1 });
      const m = res && Array.isArray(res.body) ? res.body.find((x) => x && x.id === cmd.messageId) : null;
      if (!m) throw new Error('Discord does not have that message any more');
      flags = m.flags || 0;
    }
    await rest('patch', `/channels/${cmd.channelId}/messages/${cmd.messageId}`, undefined, { flags: flags | FLAG_SUPPRESS_EMBEDS });
    return {};
  }

  async function saveMessage(cmd) {
    const actions = mod.SavedMessageActions;
    if (cmd.remove) {
      const del = exportedFn(actions, 6, isSaveDelete);
      if (!del) throw new Error("Discord's remove from saved was not found");
      await del({ channelId: cmd.channelId, messageId: cmd.messageId });
      return {};
    }
    const put = exportedFn(actions, 6, isSavePut);
    const saved = await put({ channelId: cmd.channelId, messageId: cmd.messageId, ...(cmd.dueAt ? { dueAt: cmd.dueAt } : {}) });
    return pickSaved(saved) || {};
  }

  /** The client's Saved list as opening it loads it (its next page with `more`), read from its store. */
  async function savedList(cmd) {
    const store = mod.SavedMessagesStore;
    const fetch = exportedFn(mod.SavedMessageActions, 6, isBookmarksFetch);
    if (fetch) await fetch({ loadMore: !!cmd.more });
    const all = (store.getSavedMessages() || []).map(pickSaved).filter(Boolean);
    return { saved: all, more: store.getBookmarksFetchState() === 'LOADED_HAS_MORE' };
  }

  /** Discord's own scheduled messages: the request its Scheduled list makes, only when its gate offers them. */
  async function nativeScheduled() {
    const gate = exportedFn(mod.ScheduledMessageGate, 24, isScheduledGate);
    let enabled = false;
    try {
      enabled = !!gate && !!gate({ isPrivate: () => true }, 'ScheduledMessagesList');
    } catch (e) {}
    if (!enabled) return { enabled: false, scheduled: [] };
    const res = await rest('get', '/users/@me/scheduled-messages');
    const list = res && Array.isArray(res.body) ? res.body : [];
    return {
      enabled: true,
      scheduled: list.map((x) => {
        const data = x.message_send_data || x;
        const ref = data.message_reference || x.message_reference;
        return {
          id: String(x.id),
          channel_id: String(x.channel_id ?? data.channel_id),
          content: data.content ?? '',
          scheduled_timestamp: x.scheduled_timestamp ?? isoOf(x.scheduledTimestamp),
          flags: data.flags ?? 0,
          message_reference: ref && ref.message_id ? { message_id: String(ref.message_id) } : null,
        };
      }),
    };
  }

  async function cancelScheduled(cmd) {
    const cancel = exportedFn(mod.ScheduledMessageActions, 8, isScheduledCancel);
    if (!cancel) throw new Error("Discord's cancel was not found");
    await cancel(cmd.id);
    return {};
  }

  const SENDING_COMMANDS = { suppressEmbeds, save: saveMessage, savedList, nativeScheduled, cancelScheduled };

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
