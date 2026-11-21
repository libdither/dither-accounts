/**
 * Native ids for one Zulip server. Zulip's own ids are numbers unique on one server only, so each id starts with the
 * server's host (and port): two accounts on one server share people, channels and messages, and two servers never
 * collide.
 *
 *   the organization (a space)       <host>
 *   a channel folder (a section)     <host>/f/<folder id>
 *   a person                         <host>/u/<user id>
 *   a channel (a forum)              <host>/s/<channel id>
 *   a topic (a thread in it)         <host>/s/<channel id>/t/<topic, lowercased, URI-encoded>
 *   a direct conversation            <host>/dm/<user ids, ascending, comma-separated, yours included>
 *   a message                        <host>/m/<message id>
 *
 * Zulip compares topic names without case, so a topic's id is its name in lower case; the name as last written is the
 * conversation's name. The empty topic ("general chat" since Zulip 10) is `…/t/`.
 */

export type Place =
  | { kind: 'channel'; stream: number }
  | { kind: 'topic'; stream: number; topic: string }
  | { kind: 'dm'; users: number[] };

export class Ids {
  constructor(readonly host: string) {}

  get space() {
    return this.host;
  }
  folder(id: number) {
    return `${this.host}/f/${id}`;
  }
  user(id: number) {
    return `${this.host}/u/${id}`;
  }
  channel(id: number) {
    return `${this.host}/s/${id}`;
  }
  /** A topic's id: its name lowercased (Zulip's topics are), without the ✔ of a resolved one, so resolving keeps it. */
  topic(stream: number, topic: string) {
    const name = topic.startsWith(RESOLVED) ? topic.slice(RESOLVED.length) : topic;
    return `${this.host}/s/${stream}/t/${encodeURIComponent(name.toLowerCase())}`;
  }
  dm(users: number[]) {
    return `${this.host}/dm/${[...new Set(users)].sort((a, b) => a - b).join(',')}`;
  }
  message(id: number) {
    return `${this.host}/m/${id}`;
  }

  private local(nativeId: string): string | null {
    const p = `${this.host}/`;
    return nativeId.startsWith(p) ? nativeId.slice(p.length) : null;
  }

  /** A person's Zulip user id, or null for an id that is not one of this server's people. */
  userId(nativeId: string): number | null {
    const m = this.local(nativeId)?.match(/^u\/(\d+)$/);
    return m ? Number(m[1]) : null;
  }
  messageId(nativeId: string): number | null {
    const m = this.local(nativeId)?.match(/^m\/(\d+)$/);
    return m ? Number(m[1]) : null;
  }
  folderId(nativeId: string): number | null {
    const m = this.local(nativeId)?.match(/^f\/(\d+)$/);
    return m ? Number(m[1]) : null;
  }
  /** A conversation id as a place. Topic names come back lowercased: ask the topics' map for the name as written. */
  place(nativeId: string): Place | null {
    const l = this.local(nativeId);
    if (l === null) return null;
    let m = l.match(/^s\/(\d+)$/);
    if (m) return { kind: 'channel', stream: Number(m[1]) };
    m = l.match(/^s\/(\d+)\/t\/(.*)$/s);
    if (m) {
      try {
        return { kind: 'topic', stream: Number(m[1]), topic: decodeURIComponent(m[2]) };
      } catch {
        return null;
      }
    }
    m = l.match(/^dm\/(\d+(?:,\d+)*)$/);
    if (m) return { kind: 'dm', users: m[1].split(',').map(Number) };
    return null;
  }
}

/**
 * A message's time for the hub, ms. Zulip's are whole seconds, and the hub orders by time: messages of one second
 * would come in any order. Their ids grow, so the id's last three digits stand for the milliseconds.
 */
export const msOf = (m: { id: number; timestamp: number }) => m.timestamp * 1000 + (m.id % 1000);

/** Zulip marks a resolved topic by this in front of its name. */
export const RESOLVED = '✔ ';

/** Zulip's narrow link to a message, as its web client writes one (`#narrow/channel/12-design/topic/colors/near/345`). */
export function narrowLink(base: string, where: { stream?: number; streamName?: string; topic?: string; dm?: number[] }, messageId?: number): string {
  // Zulip's hash encoding (its web client's encodeHashComponent): encodeURIComponent, then the characters Markdown or
  // a URL would take as their own (`%!'()*` and `.`) written as `.` and their hex, so a link survives in Markdown.
  const HASH: Record<string, string> = { '%': '.', '!': '.21', "'": '.27', '(': '.28', ')': '.29', '*': '.2A', '.': '.2E' };
  const enc = (s: string) => encodeURIComponent(s).replace(/[%!'()*.]/g, (c) => HASH[c]!);
  const parts: string[] = [];
  if (where.stream !== undefined) {
    const slug = (where.streamName ?? '').replace(/[^\p{L}\p{N}]+/gu, '-');
    parts.push('channel', enc(slug ? `${where.stream}-${slug}` : String(where.stream)));
    if (where.topic !== undefined) parts.push('topic', enc(where.topic));
  } else if (where.dm) parts.push('dm', `${where.dm.join(',')}-dm`);
  if (messageId !== undefined) parts.push('near', String(messageId));
  return `${base}/#narrow/${parts.join('/')}`;
}

/** The message id a narrow link points at (`…/near/345` or `…/with/345`), or null. */
export function linkedMessage(url: string): number | null {
  const m = url.match(/#narrow\/.*\/(?:near|with)\/(\d+)\b/);
  return m ? Number(m[1]) : null;
}
