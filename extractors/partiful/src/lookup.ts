/**
 * Looking people up by id (getUsers) for the names the answers left out, at most once a day each. Partiful gives some
 * ids no name (a deleted account, a profile it keeps to itself, or none at all): those are remembered as asked, in
 * partiful-state.json, so they are asked again a day later, not on every read and not again after a restart.
 */
import * as M from './map.ts';

export const LOOKUP_AGAIN_MS = 24 * 3600_000;
/** At most this many asks are kept between starts, the newest. */
const KEEP = 3000;

/** When each person was last asked for. */
export class LookedUp {
  private readonly at = new Map<string, number>();
  constructor(
    kept?: unknown,
    readonly againMs = LOOKUP_AGAIN_MS,
  ) {
    if (kept && typeof kept === 'object' && !Array.isArray(kept)) {
      const rows = Object.entries(kept).filter((r): r is [string, number] => M.isId(r[0]) && typeof r[1] === 'number' && Number.isFinite(r[1]));
      for (const [id, t] of rows.sort((a, b) => a[1] - b[1])) this.at.set(id, t);
    }
  }
  due(id: string, now: number): boolean {
    return now - (this.at.get(id) ?? 0) > this.againMs;
  }
  mark(ids: Iterable<string>, now: number) {
    for (const id of ids) {
      this.at.delete(id);
      this.at.set(id, now);
    }
  }
  unmark(ids: Iterable<string>) {
    for (const id of ids) this.at.delete(id);
  }
  /** What to keep: the asks still within a day (older ones are due anyway), the newest KEEP. */
  toJSON(now: number): Record<string, number> {
    const live = [...this.at].filter(([, t]) => now - t <= this.againMs);
    return Object.fromEntries(live.slice(-KEEP));
  }
}

export interface Looked {
  /** People asked for. */
  asked: number;
  /** Of those, how many now have a name. */
  named: number;
}

/**
 * Names, pictures and socials for those of `ids` without a name that are due, up to 100 a request and `max` in all.
 * `ask` makes one getUsers request and gives back its rows; when it fails with `unsent(error)` true (the request was
 * never made, as when reads are slowed), that batch is due again at once.
 */
export async function lookUp(ids: Iterable<string>, ctx: M.Ctx, memo: LookedUp, ask: (batch: string[]) => Promise<unknown>, opts: { now?: number; max?: number; unsent?: (e: unknown) => boolean } = {}): Promise<Looked> {
  const now = opts.now ?? Date.now();
  const want = [...new Set(ids)].filter((id) => M.isId(id) && id !== ctx.selfId && id !== M.PARTIFUL_ACTOR && !ctx.users.get(id)?.name && memo.due(id, now)).slice(0, opts.max ?? 200);
  let asked = 0;
  for (let i = 0; i < want.length; i += 100) {
    const batch = want.slice(i, i + 100);
    memo.mark(batch, now);
    let rows: unknown;
    try {
      rows = await ask(batch);
    } catch (e) {
      if (opts.unsent?.(e)) memo.unmark(want.slice(i));
      throw e;
    }
    asked += batch.length;
    for (const x of Array.isArray(rows) ? rows : []) M.userOf(x, ctx);
  }
  return { asked, named: want.slice(0, asked).filter((id) => ctx.users.get(id)?.name).length };
}
