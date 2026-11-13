/**
 * Extractor kinds: every `extractors/<dir>/manifest.ts` in this repo. Only code here runs as an extractor; apps ask
 * for operations, they never bring code.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IFACES } from '@dither-accounts/interfaces';
import type { Iface } from '@dither-accounts/spec';
import type { AddInfo } from './api-types.ts';

export interface Manifest {
  /** What accounts of this kind are called in the registry: `discord`, `google`. */
  kind: string;
  name: string;
  /** Interface names it implements (packages/interfaces). Their op names must not overlap. */
  interfaces: string[];
  /** Relative to the extractor's directory. */
  entry: string;
  /** Extra environment for the process. */
  env?: Record<string, string>;
  /**
   * Accounts of this kind can be added on the manager's page: it makes the account from a label and the form's
   * fields (config, or secret.json for secret ones) and starts its extractor, which asks for whatever else it needs
   * through its status (a QR code to scan, a sign-in in the live view). Apps that manage the kind add them too.
   */
  add?: AddInfo;
  /**
   * Its extractor holds its own passkeys for its site (packages/passkey, docs/passkeys.md): the page lists them, and
   * offers to keep new ones on a paired phone (docs/approver.md).
   */
  passkeys?: boolean;
}

export interface Kind extends Manifest {
  dir: string;
  ifaces: Iface[];
  /** op name → its interface. */
  opIface: Map<string, Iface>;
  /** event name → its interface (account-level events map to every interface that names them). */
  eventIfaces: Map<string, Iface[]>;
}

/**
 * One extractor whose manifest does not load (a syntax error, an interface that does not exist yet) is left out and
 * said so, rather than keeping the manager and every other account from starting. `onSkip` hears about each.
 */
export async function loadKinds(repoRoot: string, onSkip: (dir: string, err: Error) => void = defaultSkip): Promise<Map<string, Kind>> {
  const out = new Map<string, Kind>();
  const root = join(repoRoot, 'extractors');
  for (const d of existsSync(root) ? readdirSync(root).sort() : []) {
    const file = join(root, d, 'manifest.ts');
    if (!existsSync(file)) continue;
    try {
      const m = (await import(file)).default as Manifest;
      if (out.has(m.kind)) throw new Error(`kind "${m.kind}" is already extractors/${out.get(m.kind)!.dir.split('/').pop()}'s`);
      out.set(m.kind, kindOf(m, join(root, d)));
    } catch (e) {
      onSkip(d, e as Error);
    }
  }
  return out;
}

const defaultSkip = (dir: string, err: Error) => console.error(`[kinds] extractors/${dir} left out: ${err.message}`);

export function kindOf(m: Manifest, dir: string): Kind {
  const ifaces = m.interfaces.map((n) => {
    const i = IFACES[n];
    if (!i) throw new Error(`extractor ${m.kind}: no interface "${n}"`);
    return i;
  });
  const opIface = new Map<string, Iface>();
  const eventIfaces = new Map<string, Iface[]>();
  for (const i of ifaces) {
    for (const o of Object.keys(i.ops)) {
      if (opIface.has(o)) throw new Error(`extractor ${m.kind}: op "${o}" is in both ${opIface.get(o)!.name} and ${i.name}`);
      opIface.set(o, i);
    }
    for (const e of Object.keys(i.events)) eventIfaces.set(e, [...(eventIfaces.get(e) ?? []), i]);
  }
  return { ...m, dir, ifaces, opIface, eventIfaces };
}
