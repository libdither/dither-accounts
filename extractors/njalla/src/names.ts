/** Record names as Njalla keeps them: relative to the zone, `@` for the zone itself. */

/** A name relative to the zone: `@` for the zone itself; a full name (with or without its final dot) is cut down. */
export function relName(name: string, zone: string): string {
  const n = String(name ?? '').trim().replace(/\.$/, '');
  const l = n.toLowerCase();
  if (l === '' || l === '@' || l === zone) return '@';
  if (l.endsWith(`.${zone}`)) return n.slice(0, n.length - zone.length - 1);
  return n;
}
