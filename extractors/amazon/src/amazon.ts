/**
 * dither-finance's connectors/amazon.py as pure functions (docs/amazon.md): what it read off Amazon's order pages and
 * how it wrote it. The extension hands over what the page shows (innerText and attributes, the same things Playwright
 * read: page.js), and everything that decides a byte of the output is here: the regular expressions (Python's: \d is
 * any Unicode digit), str.strip/splitlines, strptime's month names, dict order and json.dumps(…, indent=1).
 */
import { py } from '@dither-accounts/statements-common';
import { pyStrip, splitlines } from '@dither-accounts/statements-common/pystr';

type PyValue = py.PyValue;
const { PyObj, PyInt } = py;

// ------------------------------------------------------------------ helpers
const MONEY = /-?\$\s?([\p{Nd},]+\.\p{Nd}\p{Nd})/u;
const CARD = /(Visa|MasterCard|Mastercard|American Express|Amex|Discover)\P{Nd}{0,12}(\p{Nd}{4})/u;
const ORDER = /ORDER #\s*([0-9D][0-9-]{10,})/u;
const ASIN = /\/dp\/([A-Z0-9]{10})/;
const STATUS = /^(Delivered|Arriving|Now arriving|Shipped|Cancell?ed|Return|Refund|Order placed|Preparing)/u;

/** amazon.py `_money`: the first $ amount, without its commas, keeping a leading minus. */
export function money(s: string | null | undefined): string | null {
  const m = MONEY.exec(s || '');
  return m ? (m[0].startsWith('-') ? '-' : '') + m[1].replaceAll(',', '') : null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ABBR = MONTHS.map((m) => m.slice(0, 3));
/** A Unicode decimal digit's value: Nd digits come in aligned runs of ten. */
function unicodeDigit(c: string): number {
  const cp = c.codePointAt(0)!;
  let z = cp;
  while (z > 0 && /\p{Nd}/u.test(String.fromCodePoint(z - 1))) z--;
  return (cp - z) % 10;
}
/** What Python's int() makes of a run of digits (any Unicode decimal digits). */
const digitsValue = (s: string) => Number([...s].map((c) => (/\p{Nd}/u.test(c) ? String(unicodeDigit(c)) : c)).join(''));
/** amazon.py `_day`: strptime "%B %d, %Y" or "%b %d, %Y" (C locale, any case) → ISO date, else null. */
export function day(s: string): string | null {
  const t = pyStrip(s);
  for (const names of [MONTHS, ABBR]) {
    const re = new RegExp(`^(${names.join('|')})\\s+(3[01]|[12]\\p{Nd}|0[1-9]|[1-9]| [1-9]),\\s+(\\p{Nd}{4})$`, 'iu');
    const m = re.exec(t);
    if (!m) continue;
    const mo = names.indexOf(m[1].toLowerCase()) + 1;
    const d = digitsValue(m[2].trim());
    const y = digitsValue(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1) continue;
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** amazon.py `_after`: the line after the first one that is `label` (stripped, upper-cased), stripped. */
export function after(lines: string[], label: string): string | null {
  for (let i = 0; i < lines.length; i++) if (pyStrip(lines[i]).toUpperCase() === label && i + 1 < lines.length) return pyStrip(lines[i + 1]);
  return null;
}

// ---------------------------------------------------------------- the pages
/** What page.js `orderList` reads off a Your Orders page. */
export interface RawList {
  years: (string | null)[];
  cards: { text: string; links: { href: string | null; text: string }[] }[];
  /** An `a[href*='page=<n+1>']` is on the page. */
  next: boolean;
}
/** What page.js `orderDetails` reads off an order's details page. */
export interface RawDetails {
  ship: string | null;
  items: { title: string | null; href: string | null; hasLink: boolean; price: string | null; qty: string | null; seller: string | null }[];
  charge: string | null;
  body: string;
}

/** The `years` amazon.py read from the time filter: `year-YYYY` values, newest first (this year if none). */
export function years(raw: (string | null)[], today: Date): number[] {
  const ys: number[] = [];
  for (const v0 of raw) {
    const v = v0 || '';
    if (!v.startsWith('year-')) continue;
    const n = pyStrip(v.slice(5)).replaceAll('_', '');
    if (!/^[+-]?\p{Nd}+$/u.test(n)) throw new Error(`a time filter value amazon.py could not read: ${JSON.stringify(v).slice(0, 40)}`);
    ys.push(digitsValue(n.replace(/^\+/, '')) * (n.startsWith('-') ? -1 : 1));
  }
  return (ys.length ? ys : [today.getFullYear()]).sort((a, b) => b - a);
}

/** amazon.py `_cards`: one dict per order card, in its key order. */
export function cards(raw: RawList): InstanceType<typeof PyObj>[] {
  const out: InstanceType<typeof PyObj>[] = [];
  for (const c of raw.cards) {
    const lines = splitlines(c.text).filter((l) => pyStrip(l));
    const text = lines.join('\n');
    const oid = ORDER.exec(text);
    if (!oid) continue;
    const items: PyValue[] = [];
    const seen = new Set<string>();
    for (const a of c.links) {
      const asin = ASIN.exec(a.href || '');
      const title = pyStrip(a.text || '');
      if (asin && title && !seen.has(asin[1])) {
        seen.add(asin[1]);
        items.push(new PyObj([
          ['title', title],
          ['asin', asin[1]],
        ]));
      }
    }
    const statusLine = lines.find((l) => STATUS.test(pyStrip(l)));
    const ship = after(lines, 'SHIP TO');
    out.push(
      new PyObj([
        ['id', oid[1]],
        ['placed', day(after(lines, 'ORDER PLACED') || '')],
        ['total', money(after(lines, 'TOTAL'))],
        ['ship_to', ship ? pyStrip(ship) : null],
        ['status', statusLine !== undefined ? pyStrip(statusLine) : null],
        ['items', items],
        ['digital', oid[1].startsWith('D')],
      ]),
    );
  }
  return out;
}

/** amazon.py `_details` (after its page load): ship-to name, items, the order summary, the card. */
export function details(raw: RawDetails, oid: string): InstanceType<typeof PyObj> {
  const d = new PyObj([['id', oid]]);
  if (raw.ship !== null) {
    const lines = splitlines(raw.ship)
      .map(pyStrip)
      .filter((l) => l && l.toLowerCase() !== 'ship to');
    d.set('ship_to', lines.length ? lines[0] : null);
  }
  const items: PyValue[] = [];
  for (const it of raw.items) {
    const q = it.qty !== null ? /\p{Nd}+/u.exec(it.qty) : null;
    const asin = it.hasLink ? (ASIN.exec(it.href || '')?.[1] ?? null) : null;
    const title = it.title !== null ? pyStrip(it.title) : null;
    if (!title) continue; // [i for i in items if i["title"]]
    items.push(
      new PyObj([
        ['title', title],
        ['asin', asin],
        ['price', it.price !== null ? money(it.price) : null],
        ['qty', new PyInt(q ? digitsValue(q[0]) : 1)],
        ['seller', it.seller !== null ? pyStrip(it.seller).replace(/^Sold by:\s*/u, '') : null],
      ]),
    );
  }
  d.set('items', items);
  const summary = new PyObj();
  if (raw.charge !== null) {
    const lines = splitlines(raw.charge)
      .map(pyStrip)
      .filter((l) => l);
    for (let i = 0; i + 1 < lines.length; i++) {
      const label = lines[i];
      const value = lines[i + 1];
      if (label.endsWith(':') && money(value) !== null) {
        const key = label.slice(0, -1).toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
        summary.set(key, money(value));
      }
    }
  }
  d.set('summary', summary);
  const m = CARD.exec(raw.body);
  if (m) d.set('payment', `${m[1]} ${m[2]}`);
  return d;
}

/** `o.update({k: v for k, v in d.items() if v not in (None, [], {})}, summary=d.get("summary", {}))`. */
export function merge(o: InstanceType<typeof PyObj>, d: InstanceType<typeof PyObj>) {
  for (const [k, v] of d.entries()) {
    const empty = v === null || (Array.isArray(v) && v.length === 0) || (v instanceof PyObj && v.size === 0);
    if (!empty) o.set(k, v);
  }
  o.set('summary', d.get('summary') ?? new PyObj());
}

// ------------------------------------------------------------------- state
/** state.json: amazon.py `_known()` over data/raw/amazon, kept here instead: order id → its details were read. */
export interface AmazonState {
  orders: Record<string, { details: boolean }>;
  /** Insertion order of `orders` (JSON objects move integer-like keys; order ids are not, but keep it explicit). */
  order?: string[];
  backfilled?: boolean;
  /** A pull stopped for you (a captcha, a checkpoint, a sign-in): no pull until the live view shows it cleared. */
  hold?: { kind: string; message: string; since: number } | null;
}

/** id → done, in the order first seen. */
export function knownOf(st: AmazonState): Map<string, boolean> {
  const ids = st.order?.length ? st.order.filter((i) => i in st.orders) : Object.keys(st.orders);
  for (const i of Object.keys(st.orders)) if (!ids.includes(i)) ids.push(i);
  return new Map(ids.map((i) => [i, !!st.orders[i].details]));
}
/** What a file's orders teach: `out[id] = out.get(id, False) or summary is not None`. */
export function learn(st: AmazonState, orders: PyValue[]) {
  st.order ??= Object.keys(st.orders);
  for (const o of orders) {
    if (!(o instanceof PyObj)) continue;
    const id = o.get('id');
    if (typeof id !== 'string') continue;
    const done = o.has('summary') && o.get('summary') !== null;
    if (!(id in st.orders)) {
      st.orders[id] = { details: false };
      st.order.push(id);
    }
    st.orders[id].details ||= done;
  }
}

/** The order-detail pages to read: this run's orders newest first, then known ones never read, as amazon.py did. */
export function todo(orders: InstanceType<typeof PyObj>, known: Map<string, boolean>): string[] {
  const placed = (o: PyValue | undefined) => (o instanceof PyObj && typeof o.get('placed') === 'string' ? (o.get('placed') as string) : '');
  const list = orders
    .entries()
    .map(([id, o]) => ({ id, o, key: placed(o) }))
    // sorted(..., reverse=True) is stable: equal keys keep their order.
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
    .filter(({ id, o }) => o instanceof PyObj && o.get('digital') !== true && !known.get(id))
    .map(({ id }) => id);
  const inTodo = new Set(list);
  for (const [id, done] of known) if (!done && !inTodo.has(id) && !id.startsWith('D')) list.push(id);
  return list;
}

/** The file amazon.py wrote: `json.dumps({"source": "amazon-orders", "pulled_at": stamp, "orders": [...]}, indent=1)`. */
export function fileBody(stamp: string, orders: InstanceType<typeof PyObj>): string {
  return py.dumps(
    new PyObj([
      ['source', 'amazon-orders'],
      ['pulled_at', stamp],
      ['orders', orders.entries().map(([, o]) => o)],
    ]),
    1,
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
/** %Y%m%dT%H%M%SZ in UTC. */
export const stampUtc = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

// --------------------------------------------------------------------- the pull
export class NeedsYouHere extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}

export interface PullDeps {
  base: string;
  /** Load the URL, get past a sign-in prompt (the stored password), stop at a captcha or checkpoint (NeedsYouHere). */
  visit: (url: string) => Promise<void>;
  list: (n: number) => Promise<RawList>;
  details: () => Promise<RawDetails>;
  pause: (lo: number, hi: number) => Promise<void>;
  now: () => Date;
  log: (msg: string) => void;
}

/**
 * amazon.py `pull` between attaching and writing: the order lists (every year when backfilling, else this year until
 * a page has nothing new), then up to `maxDetails` detail pages. A NeedsYouHere stops it with what it has so far,
 * as amazon.py's NeedsYou did; any other error goes up and nothing is written, as there.
 */
export async function pullOrders(st: AmazonState, opts: { backfill?: boolean; details?: number }, d: PullDeps): Promise<{ orders: InstanceType<typeof PyObj>; needs: NeedsYouHere | null }> {
  const known = knownOf(st);
  const backfill = !!opts.backfill || known.size === 0;
  const maxDetails = opts.details ?? 25;
  const orders = new PyObj();
  let needs: NeedsYouHere | null = null;
  try {
    await d.visit(`${d.base}/your-orders/orders`);
    const ys = years((await d.list(0)).years, d.now());
    for (const y of backfill ? ys : ys.slice(0, 1)) {
      for (let n = 0; n < 100; n++) {
        await d.pause(3, 6);
        await d.visit(`${d.base}/your-orders/orders?timeFilter=year-${y}&page=${n}`);
        const raw = await d.list(n);
        const cs = cards(raw);
        if (!cs.length) break;
        const fresh = cs.filter((c) => !known.has(c.get('id') as string));
        for (const c of cs) orders.set(c.get('id') as string, c);
        d.log(`${y} page ${n + 1}: ${cs.length} orders, ${fresh.length} new`);
        if (!backfill && !fresh.length) break;
        if (!raw.next) break;
      }
    }
    for (const oid of todo(orders, known).slice(0, Math.max(0, maxDetails))) {
      await d.pause(4, 8);
      await d.visit(`${d.base}/your-orders/order-details?orderID=${oid}`);
      const det = details(await d.details(), oid);
      let o = orders.get(oid);
      if (!(o instanceof PyObj)) {
        o = new PyObj([
          ['id', oid],
          ['digital', false],
        ]);
        orders.set(oid, o);
      }
      merge(o, det);
      const items = det.get('items');
      d.log(`details ${oid.slice(0, 3)}…: ${Array.isArray(items) ? items.length : 0} item(s)`);
    }
  } catch (e) {
    if (e instanceof NeedsYouHere) needs = e;
    else throw e;
  }
  if (backfill && !needs) st.backfilled = true;
  return { orders, needs };
}
