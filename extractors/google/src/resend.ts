/**
 * What the google kind's bridge sends again when its page has not said it has a command (packages/browser bridge.ts):
 * reads, and Gmail label changes (the same done twice: read, starred, moved, trashed). Never a Calendar write (a
 * gfetch other than GET: an event others may be invited to), a draft or a send, an upload, or a learn run's steering
 * (a second `back` would leave Gmail): a copy that reached a page whose word was lost, and a resend that lands in the
 * page after a reload, would make it twice.
 */
export const RESEND_KINDS: readonly string[] = ['page.state', 'gfetch', 'gmail.shapes', 'gmail.syncInfo', 'gmail.sync', 'gmail.raw', 'gmail.rawChunk', 'gmail.rawDrop', 'gmail.contacts', 'gmail.write'];

/** A gmail.write made of label changes only (each change's part 6, write.ts labelChange), never a draft's or a send's. */
export function labelsOnly(body: unknown): boolean {
  if (!Array.isArray(body) || body[0] !== null || !Array.isArray(body[1])) return false;
  const changes = body[1][0];
  return Array.isArray(changes) && changes.length > 0 && changes.every((ch) => Array.isArray(ch) && Array.isArray(ch[1]) && Array.isArray(ch[1][1]) && ch[1][1].findIndex((x: unknown) => x !== null) === 6);
}

/** Of RESEND_KINDS, whether this one may be sent again. */
export function resendable(c: { kind: string; method?: unknown; body?: unknown }): boolean {
  if (c.kind === 'gfetch') return String(c.method ?? '').toUpperCase() === 'GET';
  if (c.kind === 'gmail.write') return labelsOnly(c.body);
  return RESEND_KINDS.includes(c.kind);
}
