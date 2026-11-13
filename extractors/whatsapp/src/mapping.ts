/**
 * Bridge events -> dither-chat facts. Pure apart from the State it reads and the aliases it pins,
 * so the tests drive it with fixtures (test/fixtures/events.jsonl, printed by the bridge itself).
 *
 * Native ids
 *   identity       a user JID, bare (no device): "<phone>@s.whatsapp.net" or "<lid>@lid", whichever
 *                  was seen first (see Aliases)
 *   conversation   DM: the peer's identity id (your own for "Message yourself"); group: "<id>@g.us"
 *   space          a community: its parent group's JID
 *   message        "<conversation>/<WhatsApp message id>"
 *   media          "wa-media:<message native id>", resolved by fetchMedia
 *   avatars        "wa-avatar:<jid>[?<picture id>]", resolved by fetchMedia
 */

import type * as P from '@dither-chat/protocol';
import { attachmentKind } from '@dither-chat/protocol';
import { fromWhatsApp } from './format.ts';
import type { StoredMsg, State } from './state.ts';
import type { WaContextInfo, WaGroup, WaHistoryConversation, WaInfo, WaMedia, WaMessage, WaPin, WaWebInfo } from './types.ts';

// ---------------------------------------------------------------- JIDs

export const USER = '@s.whatsapp.net';
export const LID = '@lid';
export const GROUP = '@g.us';

/** Drop the device and agent parts: "123.0:7@s.whatsapp.net" -> "123@s.whatsapp.net". */
export function bare(jid: string | undefined | null): string {
  if (!jid) return '';
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(':')[0].split('.')[0];
  const server = jid.slice(at);
  return user + (server === '@c.us' ? USER : server);
}
export const isGroup = (jid: string) => jid.endsWith(GROUP);
export const isUser = (jid: string) => jid.endsWith(USER) || jid.endsWith(LID);
export const isPhoneJid = (jid: string) => jid.endsWith(USER);
export const phoneOf = (jid: string) => (isPhoneJid(jid) ? '+' + jid.slice(0, jid.indexOf('@')) : undefined);
/** Stories, channels and broadcast lists' own chats: nothing the hub shows. */
export const ignoredChat = (jid: string) => jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast') || jid.endsWith('@bot');

/** The most a WhatsApp About takes, in characters. */
export const ABOUT_MAX = 139;

/** An About WhatsApp would take, or a plain error saying why not. */
export function checkAbout(about: unknown): string {
  if (typeof about !== 'string') throw new Error('nothing to change: only the About can be set');
  const n = [...about].length;
  if (n > ABOUT_MAX) throw new Error(`a WhatsApp About takes ${ABOUT_MAX} characters, this one has ${n}`);
  return about;
}

export const msgId = (conversation: string, wid: string) => `${conversation}/${wid}`;
export function parseMsgId(id: string): { conversation: string; wid: string } {
  const i = id.lastIndexOf('/');
  if (i < 0) throw new Error(`not a WhatsApp message id: ${id}`);
  return { conversation: id.slice(0, i), wid: id.slice(i + 1) };
}
export const mediaUrl = (messageNativeId: string) => `wa-media:${messageNativeId}`;
export const avatarUrl = (jid: string, pictureId?: string) => `wa-avatar:${jid}${pictureId ? `?${pictureId}` : ''}`;

// ---------------------------------------------------------------- aliases

/**
 * One person, two addresses: WhatsApp moved users to LIDs (…@lid) and shows the phone-number JID
 * only where it knows it. Each JID is pinned to the native id it was first published under, so
 * ids never change and a person never splits in two. A pair learned before either is published
 * is pinned to the phone number, which is what the address book and other networks know.
 */
export class Aliases {
  constructor(private st: State) {}

  /** The two addresses of one user. */
  link(a?: string | null, b?: string | null) {
    const x = bare(a);
    const y = bare(b);
    if (!x || !y || x === y || !isUser(x) || !isUser(y)) return;
    const px = this.st.aliasOf(x);
    const py = this.st.aliasOf(y);
    if (px && py) return; // both published already; nothing to reconcile without a merge
    if (px) this.st.setAlias(y, px);
    else if (py) this.st.setAlias(x, py);
    else {
      const pn = isPhoneJid(x) ? x : isPhoneJid(y) ? y : x;
      this.st.setAlias(x, pn);
      this.st.setAlias(y, pn);
    }
  }

  /** The native id for a JID, pinning it if new. */
  id(jid: string): string {
    const j = bare(jid);
    if (!j) return j;
    const p = this.st.aliasOf(j);
    if (p) return p;
    this.st.setAlias(j, j);
    return j;
  }

  peek(jid: string): string | undefined {
    return this.st.aliasOf(bare(jid));
  }

  /** The JIDs a native id stands for: the phone-number one first. */
  jids(id: string): string[] {
    const all = this.st.jidsOf(id);
    if (!all.includes(id)) all.push(id);
    return all.sort((a, b) => Number(isPhoneJid(b)) - Number(isPhoneJid(a)));
  }
}

// ---------------------------------------------------------------- content

const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'ptvMessage', 'audioMessage', 'documentMessage', 'stickerMessage'] as const;
type MediaKey = (typeof MEDIA_KEYS)[number];

/** Parts of a message that carry nothing to show on their own. */
const SILENT = new Set(['senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage', 'pinInChatMessage', 'encReactionMessage', 'encEventResponseMessage', 'secretEncryptedMessage', 'deviceSentMessage', 'botInvokeMessage', 'appStateSyncKeyShare', 'call']);

/** The contextInfo of whichever part of the message carries one. */
export function contextOf(m: WaMessage | null | undefined): WaContextInfo | undefined {
  if (!m) return undefined;
  for (const v of Object.values(m)) {
    if (v && typeof v === 'object' && 'contextInfo' in v && (v as any).contextInfo) return (v as any).contextInfo as WaContextInfo;
  }
  return undefined;
}

export function mediaOf(m: WaMessage | null | undefined): { key: MediaKey; media: WaMedia } | undefined {
  if (!m) return undefined;
  for (const key of MEDIA_KEYS) if (m[key]) return { key, media: m[key]! };
  return undefined;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'application/pdf': 'pdf' };

function attachmentOf(key: MediaKey, media: WaMedia, nativeId: string): P.AttachmentFact {
  const mime = media.mimetype || (key === 'stickerMessage' ? 'image/webp' : key === 'imageMessage' ? 'image/jpeg' : key === 'audioMessage' ? 'audio/ogg' : key.startsWith('video') || key === 'ptvMessage' ? 'video/mp4' : 'application/octet-stream');
  const base = mime.split(';')[0].trim();
  const stem = key === 'audioMessage' && media.PTT ? 'voice-message' : key.replace('Message', '').replace('ptv', 'video-note');
  const a: P.AttachmentFact = { kind: key === 'stickerMessage' ? 'image' : attachmentKind(base), mime, name: media.fileName || `${stem}.${EXT[base] ?? base.split('/')[1] ?? 'bin'}`, url: mediaUrl(nativeId) };
  if (media.fileLength) a.size = Number(media.fileLength);
  if (media.width) a.width = media.width;
  if (media.height) a.height = media.height;
  return a;
}

function vcardLine(vcard: string | undefined): string | undefined {
  if (!vcard) return undefined;
  const tel = vcard.match(/TEL[^:\n]*:([^\n]+)/);
  return tel?.[1].trim();
}

/** How long a pin lasts when the message does not say: WhatsApp's own default, 7 days. */
export const PIN_DEFAULT_SECS = 7 * 86_400;

/** History-sync stubs that make someone an admin (true) or take it away (false). */
const ROLE_STUBS: Record<string, boolean> = { GROUP_PARTICIPANT_PROMOTE: true, GROUP_PARTICIPANT_DEMOTE: false };

const osm = (lat?: number, lng?: number) => (lat === undefined || lng === undefined ? '' : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`);

export interface Content {
  body: string;
  kind: P.MessageKind;
  attachments: P.AttachmentFact[];
  ctx?: WaContextInfo;
  extra?: Record<string, unknown>;
}

/**
 * What a message shows. undefined: nothing (a key share, a poll vote, an empty envelope).
 * `resolve` turns a mentioned JID into its native id.
 */
export function contentOf(m: WaMessage | null | undefined, nativeId: string, resolve: (jid: string) => string, viewOnce = false): Content | undefined {
  if (!m) return undefined;
  const ctx = contextOf(m);
  const text = (s: string | undefined) => fromWhatsApp(s, { mentions: ctx?.mentionedJID, resolve });
  const media = mediaOf(m);
  if (media) {
    const { key, media: x } = media;
    if (x.viewOnce || viewOnce) {
      const what = key === 'videoMessage' ? 'video' : key === 'audioMessage' ? 'voice message' : 'photo';
      return { body: `View-once ${what}. For privacy, it opens only on your phone.`, kind: 'text', attachments: [], ctx };
    }
    const caption = text(x.caption);
    const kind: P.MessageKind = key === 'stickerMessage' ? 'sticker' : caption ? 'text' : 'media';
    return { body: caption, kind, attachments: [attachmentOf(key, x, nativeId)], ctx };
  }
  if (typeof m.conversation === 'string' && m.conversation) return { body: text(m.conversation), kind: 'text', attachments: [], ctx };
  if (m.extendedTextMessage) return { body: text(m.extendedTextMessage.text), kind: 'text', attachments: [], ctx };
  if (m.locationMessage || m.liveLocationMessage) {
    const l = m.locationMessage ?? m.liveLocationMessage!;
    const name = (l as any).name || (l as any).caption || (m.liveLocationMessage ? 'Live location' : 'Location');
    const lines = [`📍 ${name}`, (l as any).address, osm(l.degreesLatitude, l.degreesLongitude)].filter(Boolean);
    return { body: lines.join('\n'), kind: 'text', attachments: [], ctx };
  }
  if (m.contactMessage) {
    const tel = vcardLine(m.contactMessage.vcard);
    return { body: `👤 ${m.contactMessage.displayName ?? 'Contact'}${tel ? ` · ${tel}` : ''}`, kind: 'text', attachments: [], ctx };
  }
  if (m.contactsArrayMessage) {
    const list = (m.contactsArrayMessage.contacts ?? []).map((c) => `👤 ${c.displayName ?? 'Contact'}${vcardLine(c.vcard) ? ` · ${vcardLine(c.vcard)}` : ''}`);
    return { body: list.join('\n') || `👤 ${m.contactsArrayMessage.displayName ?? 'Contacts'}`, kind: 'text', attachments: [], ctx };
  }
  const poll = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3 ?? m.pollCreationMessageV5;
  if (poll) {
    const opts = (poll.options ?? []).map((o) => `• ${o.optionName ?? ''}`);
    return { body: [`📊 **${poll.name ?? 'Poll'}**`, ...opts, '_Vote on your phone._'].join('\n'), kind: 'text', attachments: [], ctx };
  }
  if (m.groupInviteMessage) {
    const g = m.groupInviteMessage;
    const body = [`Invitation to join “${g.groupName ?? 'a group'}”`, text(g.caption)].filter(Boolean).join('\n');
    // Kept for joining from the message later (whatsmeow JoinGroupWithInvite: the group, this code, its expiry and
    // the message's author as the inviter). Nothing joins from it yet.
    const expires = Number(g.inviteExpiration ?? 0) * 1000;
    const invite = g.groupJID && g.inviteCode ? { waGroupInvite: { group: bare(g.groupJID), code: g.inviteCode, ...(expires > 0 ? { expires } : {}) } } : undefined;
    return { body, kind: 'text', attachments: [], ctx, ...(invite ? { extra: invite } : {}) };
  }
  if (m.eventMessage) {
    const e = m.eventMessage;
    const when = e.startTime ? new Date(Number(e.startTime) * 1000).toUTCString() : '';
    return { body: [`📅 **${e.name ?? 'Event'}**`, when, e.location?.name, text(e.description)].filter(Boolean).join('\n'), kind: 'text', attachments: [], ctx };
  }
  if (m.callLogMessage) {
    const c = m.callLogMessage;
    const what = c.isVideo ? 'Video call' : 'Voice call';
    const missed = /MISSED|REJECTED/.test(c.callOutcome ?? '');
    return { body: missed ? `Missed ${what.toLowerCase()}` : what, kind: 'call', attachments: [], ctx };
  }
  const biz =
    m.buttonsMessage?.contentText ??
    m.buttonsMessage?.text ??
    m.templateMessage?.hydratedTemplate?.hydratedContentText ??
    m.interactiveMessage?.body?.text ??
    (m.listMessage ? [m.listMessage.title, m.listMessage.description].filter(Boolean).join('\n') : undefined) ??
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.listResponseMessage?.title;
  if (biz) return { body: text(biz), kind: 'text', attachments: [], ctx };
  const unknown = Object.keys(m).filter((k) => !SILENT.has(k) && k !== 'protocolMessage' && k !== 'reactionMessage');
  if (unknown.length) return { body: 'This kind of WhatsApp message cannot be shown here. Open it on your phone.', kind: 'system', attachments: [], ctx, extra: { waType: unknown[0] } };
  return undefined;
}

// ---------------------------------------------------------------- the mapper

export interface SelfIds {
  /** Own native id. */
  id: string;
  /** Own JIDs (phone number and LID). */
  jids: string[];
}

export interface MapOut {
  events: P.AdapterEvent[];
  /** Messages to remember (for replies, reactions, edits, downloads). */
  remember: StoredMsg[];
  /** Messages to forget (deleted). */
  forget: string[];
  /** Conversations this event touched, with the chat JID to address them by. */
  touched: { id: string; jid: string; ts: number; group: boolean }[];
}

export class Mapper {
  constructor(
    private st: State,
    readonly aliases: Aliases,
    private self: () => SelfIds,
    private nameOf: (id: string) => string = (id) => id,
  ) {}

  isSelf(jid: string | undefined): boolean {
    if (!jid) return false;
    const s = this.self();
    const b = bare(jid);
    return s.jids.includes(b) || this.aliases.peek(b) === s.id;
  }

  /** Native id of a user JID; you are always your own id. */
  who(jid: string): string {
    return this.isSelf(jid) ? this.self().id : this.aliases.id(jid);
  }

  /** Conversation native id for a chat JID. */
  convId(chat: string): string {
    const c = bare(chat);
    return isGroup(c) ? c : this.who(c);
  }

  private out(): MapOut {
    return { events: [], remember: [], forget: [], touched: [] };
  }

  message(ev: { info: WaInfo; message: WaMessage | null; flags?: string[]; history?: boolean; web?: WaWebInfo }): MapOut {
    const o = this.out();
    const info = ev.info;
    let chat = bare(info.chat);
    // An incoming broadcast-list message shows in the DM with its sender.
    if (chat.endsWith('@broadcast') && chat !== 'status@broadcast' && !info.fromMe) chat = bare(info.sender);
    if (ignoredChat(chat)) return o;
    this.aliases.link(info.sender, info.senderAlt);
    if (!info.isGroup) this.aliases.link(chat, info.chatAlt ?? info.recipientAlt);
    const conv = this.convId(chat);
    const author = info.fromMe ? this.self().id : this.who(info.sender);
    const live = !ev.history;
    const m = ev.message ?? {};
    o.touched.push({ id: conv, jid: chat, ts: info.ts, group: isGroup(chat) });

    if (ev.web?.messageStubType) {
      const web = ev.web;
      if (web.pinInChat) return this.pin(o, conv, web.pinInChat, author, info.ts, web.pinInChat.messageAddOnContextInfo?.messageAddOnDurationInSecs);
      const body = this.stub(web, author);
      if (body) {
        const fact: P.MessageFact = { nativeId: msgId(conv, info.id), conversation: conv, author, ts: info.ts, kind: 'system', body };
        o.events.push({ t: 'message', message: fact, live: false });
      }
      const given = ROLE_STUBS[web.messageStubType ?? ''];
      if (given !== undefined && isGroup(chat)) {
        for (const member of this.stubPeople(web)) o.events.push({ t: 'role', target: { kind: 'conversation', nativeId: conv }, member, role: 'Admin', given, ...(author ? { by: author } : {}), ts: info.ts });
      }
      return o;
    }

    if (m.reactionMessage) {
      const r = m.reactionMessage;
      const target = msgId(conv, r.key?.ID ?? '');
      const prev = this.st.reaction(target, author);
      if (r.text) {
        if (prev && prev !== r.text) o.events.push({ t: 'reaction', conversation: conv, message: target, author, key: prev, remove: true });
        o.events.push({ t: 'reaction', conversation: conv, message: target, author, key: r.text });
        this.st.setReaction(target, author, r.text);
      } else if (prev) {
        o.events.push({ t: 'reaction', conversation: conv, message: target, author, key: prev, remove: true });
        this.st.setReaction(target, author, null);
      }
      return o;
    }

    if (m.pinInChatMessage) return this.pin(o, conv, m.pinInChatMessage, author, info.ts, m.messageContextInfo?.messageAddOnDurationInSecs);

    const pm = m.protocolMessage;
    if (pm) {
      const target = msgId(conv, pm.key?.ID ?? '');
      if (pm.type === 'REVOKE') {
        o.events.push({ t: 'delete', conversation: conv, nativeId: target });
        o.forget.push(target);
        return o;
      }
      if (pm.type === 'MESSAGE_EDIT' && pm.editedMessage) return this.edit(o, conv, chat, target, pm.editedMessage, info, author, live);
      if (pm.type === 'EPHEMERAL_SETTING') {
        const s = pm.ephemeralExpiration ?? 0;
        // The chat's timer, for what is sent next and for the About panel. Not from history: that may be an old one.
        if (live) this.st.set(`timer:${conv}`, s ? String(s) : null);
        const who = info.fromMe ? 'You' : this.nameOf(author);
        const body = s ? `${who} turned on disappearing messages: ${describeTimer(s)}.` : `${who} turned off disappearing messages.`;
        o.events.push({ t: 'message', message: { nativeId: msgId(conv, info.id), conversation: conv, author, ts: info.ts, kind: 'system', body }, live });
      }
      return o;
    }

    const nativeId = msgId(conv, info.id);
    const c = contentOf(m, nativeId, (jid) => this.who(jid), ev.flags?.includes('viewOnce'));
    if (!c) return o;
    const fact: P.MessageFact = { nativeId, conversation: conv, author, ts: info.ts, kind: c.kind, body: c.body };
    if (c.attachments.length) fact.attachments = c.attachments;
    this.decorate(fact, c.ctx, conv);
    if (c.extra) fact.extra = c.extra;
    if (ev.flags?.includes('edit')) fact.editedTs = info.ts;
    if (ev.web?.reactions?.length) {
      const reactions = this.historyReactions(ev.web.reactions, chat);
      if (reactions.length) fact.reactions = reactions;
      for (const r of reactions) for (const a of r.authors) this.st.setReaction(nativeId, a, r.key);
    }
    o.events.push({ t: 'message', message: fact, live });
    const exp = c.ctx?.expiration;
    o.remember.push({
      id: nativeId,
      conversation: conv,
      chat,
      wid: info.id,
      sender: info.fromMe ? '' : bare(info.sender),
      author,
      fromMe: info.fromMe,
      ts: info.ts,
      // View-once media stays on the phone: keep nothing that could open or forward it.
      content: ev.flags?.includes('viewOnce') || mediaOf(m)?.media.viewOnce ? null : m,
      ...(exp ? { expires: info.ts + exp * 1000 } : {}),
    });
    return o;
  }

  /**
   * A message pinned or unpinned for everyone. A pin lapses after the time the pinner chose and WhatsApp sends
   * nothing then, so the state remembers when; the adapter's sweep unpins it.
   */
  private pin(o: MapOut, conv: string, p: WaPin, by: string, ts: number, secs: number | undefined): MapOut {
    if (!p.key?.ID || (p.type !== 'PIN_FOR_ALL' && p.type !== 'UNPIN_FOR_ALL')) return o;
    const message = msgId(conv, p.key.ID);
    const pinned = p.type === 'PIN_FOR_ALL';
    o.events.push({ t: 'pin', conversation: conv, message, pinned, ...(by ? { by } : {}), ts });
    this.st.putPin(message, conv, ts, pinned ? ts + (secs || PIN_DEFAULT_SECS) * 1000 : null);
    return o;
  }

  /** Replies, forwards and mentions of you, from a message's contextInfo. */
  private decorate(fact: P.MessageFact, ctx: WaContextInfo | undefined, conv: string) {
    if (!ctx) return;
    if (ctx.stanzaID) fact.replyTo = msgId(conv, ctx.stanzaID);
    if (ctx.isForwarded) {
      fact.forward = {};
      if ((ctx.forwardingScore ?? 0) >= 5) fact.extra = { ...fact.extra, forwardedManyTimes: true };
    }
    const quotesMe = !!ctx.stanzaID && !!ctx.participant && this.isSelf(ctx.participant);
    if (quotesMe || (ctx.mentionedJID ?? []).some((j) => this.isSelf(j))) fact.mentionsSelf = true;
  }

  private edit(o: MapOut, conv: string, chat: string, target: string, edited: WaMessage, info: WaInfo, author: string, live: boolean): MapOut {
    const orig = this.st.msg(target);
    let content = edited;
    // A caption edit carries only the caption: keep the media.
    const om = mediaOf(orig?.content);
    const em = mediaOf(edited);
    if (om && !em) {
      const caption = edited.conversation ?? edited.extendedTextMessage?.text ?? '';
      content = { ...orig!.content, [om.key]: { ...om.media, caption } };
    }
    const c = contentOf(content, target, (jid) => this.who(jid));
    if (!c) return o;
    const fact: P.MessageFact = { nativeId: target, conversation: conv, author: orig?.author ?? author, ts: orig?.ts ?? info.ts, editedTs: info.ts, kind: c.kind, body: c.body };
    if (c.attachments.length) fact.attachments = c.attachments;
    this.decorate(fact, contextOf(orig?.content) ?? c.ctx, conv);
    o.events.push({ t: 'message', message: fact, live });
    if (orig) o.remember.push({ ...orig, content });
    else o.remember.push({ id: target, conversation: conv, chat, wid: parseMsgId(target).wid, sender: info.fromMe ? '' : bare(info.sender), author, fromMe: info.fromMe, ts: info.ts, content });
    return o;
  }

  private historyReactions(list: NonNullable<WaWebInfo['reactions']>, chat: string): P.ReactionFact[] {
    const by = new Map<string, string[]>();
    for (const r of list) {
      if (!r.text) continue;
      const author = r.key?.fromMe ? this.self().id : r.key?.participant ? this.who(r.key.participant) : isGroup(chat) ? '' : this.who(chat);
      if (!author) continue;
      const authors = by.get(r.text) ?? by.set(r.text, []).get(r.text)!;
      if (!authors.includes(author)) authors.push(author);
    }
    return [...by].map(([key, authors]) => ({ key, authors }));
  }

  /** The people a stub is about (added, removed, made admin), as native ids. */
  private stubPeople(web: WaWebInfo): string[] {
    return (web.messageStubParameters ?? []).map((p) => {
      let jid = p;
      if (p.startsWith('{')) {
        try {
          const j = JSON.parse(p);
          jid = j.id ?? j.jid ?? j.phone_number ?? p;
        } catch {}
      }
      return this.who(jid);
    });
  }

  /** History-sync system messages ("stubs"). undefined: not worth a line. */
  private stub(web: WaWebInfo, author: string): string | undefined {
    const who = author === this.self().id ? 'You' : this.nameOf(author);
    const people = this.stubPeople(web).map((id) => (id === this.self().id ? 'you' : this.nameOf(id)));
    const p0 = web.messageStubParameters?.[0];
    switch (web.messageStubType) {
      case 'GROUP_CREATE':
        return `${who} created the group${p0 ? ` “${p0}”` : ''}.`;
      case 'GROUP_CHANGE_SUBJECT':
        return `${who} renamed the group to “${p0 ?? ''}”.`;
      case 'GROUP_CHANGE_DESCRIPTION':
        return `${who} changed the group description.`;
      case 'GROUP_CHANGE_ICON':
        return `${who} changed the group icon.`;
      case 'GROUP_PARTICIPANT_ADD':
        return `${who} added ${people.join(', ')}.`;
      case 'GROUP_PARTICIPANT_REMOVE':
        return `${who} removed ${people.join(', ')}.`;
      case 'GROUP_PARTICIPANT_LEAVE':
        return `${people.join(', ') || who} left.`;
      case 'GROUP_PARTICIPANT_INVITE':
      case 'GROUP_PARTICIPANT_LINKED_GROUP_JOIN':
      case 'GROUP_PARTICIPANT_ACCEPT':
        return `${people.join(', ') || who} joined.`;
      case 'GROUP_PARTICIPANT_PROMOTE':
        return `${who} made ${people.join(', ')} ${people.length > 1 ? 'admins' : 'an admin'}.`;
      case 'GROUP_PARTICIPANT_DEMOTE':
        return `${who} removed ${people.join(', ')} as admin.`;
      case 'CALL_MISSED_VOICE':
      case 'CALL_MISSED_GROUP_VOICE':
        return 'Missed voice call.';
      case 'CALL_MISSED_VIDEO':
      case 'CALL_MISSED_GROUP_VIDEO':
        return 'Missed video call.';
    }
    return undefined;
  }

  // ------------------------------------------------------------ conversations and spaces

  /** A DM's conversation fact. */
  direct(chat: string, extra: Partial<P.ConversationFact> = {}): P.ConversationFact {
    const id = this.convId(chat);
    const self = this.self().id;
    if (id === self) return { nativeId: id, shape: 'self', name: 'Message yourself', participants: [self], encrypted: true, ...extra };
    return { nativeId: id, shape: 'direct', participants: [self, id], encrypted: true, ...extra };
  }

  /**
   * A group's conversation fact, and the community space it sits in. A community's own parent
   * group is the space; its announcement group is a read-only channel in it.
   */
  group(g: WaGroup): { conversation?: P.ConversationFact; space?: P.SpaceFact } {
    if (g.isParent) {
      return { space: { nativeId: g.jid, kind: 'community', name: g.name || 'Community', topic: g.topic || undefined, iconUrl: avatarUrl(g.jid) } };
    }
    const participants = g.participants.map((p) => this.who(p.jid));
    for (const p of g.participants) this.aliases.link(p.pn, p.lid);
    const c: P.ConversationFact = {
      nativeId: g.jid,
      shape: g.linkedParent ? 'channel' : 'group',
      variant: g.isAnnounce ? 'announcement' : 'text',
      name: g.name || 'Group',
      topic: g.topic || undefined,
      avatarUrl: avatarUrl(g.jid),
      encrypted: true,
    };
    if (g.linkedParent) c.spaces = [{ nativeId: g.linkedParent, position: g.isDefaultSub ? '0' : '1' }];
    // Big groups: members are not worth a list (the protocol keeps participants for small ones).
    if (participants.length <= 256) c.participants = participants;
    return { conversation: c };
  }

  /** History-sync conversation metadata -> partial conversation facts. */
  historyConversation(c: WaHistoryConversation): { chat: string; patch: Partial<P.ConversationFact>; unread?: number; lastTs?: number } | undefined {
    const chat = bare(c.ID);
    if (ignoredChat(chat) || c.isParentGroup) return undefined;
    if (!isGroup(chat)) this.aliases.link(chat, c.pnJID ?? c.lidJID);
    const patch: Partial<P.ConversationFact> = {};
    if (c.archived !== undefined) patch.archived = !!c.archived;
    const mute = Number(c.muteEndTime ?? 0);
    if (mute) patch.mute = { level: 'none', until: mute < 0 || mute > 1e11 ? undefined : mute * 1000 };
    const last = Number(c.lastMsgTimestamp ?? c.conversationTimestamp ?? 0) * 1000;
    if (last) patch.lastMessageAt = last;
    if (isGroup(chat) && (c.name || c.displayName)) patch.name = c.name || c.displayName;
    return { chat, patch, unread: c.markedAsUnread && !c.unreadCount ? 1 : c.unreadCount, lastTs: last || undefined };
  }
}

export function describeTimer(s: number): string {
  if (s % 86_400 === 0) return s === 86_400 ? '1 day' : `${s / 86_400} days`;
  if (s % 3600 === 0) return s === 3600 ? '1 hour' : `${s / 3600} hours`;
  return `${Math.round(s / 60)} minutes`;
}
