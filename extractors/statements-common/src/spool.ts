/**
 * An account's pulled files until an app has them (docs/statements.md): `<account>/spool/` (700), each file as
 * `<id>` (600) and `index.json` (the entries, the counter, how far the app acked). A file is written whole (a temporary
 * file, fsync, rename) before its entry goes in the index, and the index the same way, so a crash leaves at worst a
 * stray file the next start removes. Acked files stay 30 days more (a lost write on the app's side can fetch again),
 * then go. Unacked files never go by themselves.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { StatementFile } from '@dither-accounts/interfaces';
import { StatusError } from '@dither-accounts/link';

export const KEEP_ACKED_MS = 30 * 24 * 3600_000;
/** statements.fetch answers in one WebSocket frame (the manager's are 64 MB), so a file's base64 must fit in it. */
export const FETCH_MAX = 40 * 1024 * 1024;

interface Entry extends StatementFile {
  ackedAt?: number;
}
interface Index {
  v: 1;
  seq: number;
  acked: number;
  files: Entry[];
}

/** Written whole or not at all, mode 600. */
export function writeWhole(path: string, data: string | Uint8Array) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export const sha256hex = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex');

export function mimeOf(name: string) {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

const SAFE_NAME = /^[\w.@+-]{1,200}$/;
const SAFE_DIR = /^(?:[\w.-]{1,64}(?:\/[\w.-]{1,64}){0,3})?$/;

export class Spool {
  readonly dir: string;
  private idx: Index;
  constructor(
    accountDir: string,
    private onFile: (f: StatementFile) => void = () => {},
    private now: () => number = Date.now,
  ) {
    this.dir = join(accountDir, 'spool');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.idx = this.load();
    this.sweep();
  }

  private load(): Index {
    const p = join(this.dir, 'index.json');
    if (!existsSync(p)) return { v: 1, seq: 0, acked: 0, files: [] };
    try {
      const x = JSON.parse(readFileSync(p, 'utf8')) as Index;
      return { v: 1, seq: x.seq | 0, acked: x.acked | 0, files: Array.isArray(x.files) ? x.files : [] };
    } catch {
      // A broken index: start a new counter past whatever the files' names say, so seqs never repeat.
      const seqs = readdirSync(this.dir).map((f) => Number(f.split('-')[0])).filter(Number.isFinite);
      return { v: 1, seq: Math.max(0, ...seqs), acked: 0, files: [] };
    }
  }
  private save() {
    writeWhole(join(this.dir, 'index.json'), JSON.stringify(this.idx));
  }
  /** Drop files acked more than 30 days ago, and blobs no entry names (a crash between the file and the index). */
  sweep() {
    const now = this.now();
    const before = this.idx.files.length;
    this.idx.files = this.idx.files.filter((f) => {
      const gone = f.seq <= this.idx.acked && f.ackedAt !== undefined && now - f.ackedAt > KEEP_ACKED_MS;
      if (gone) rmSync(join(this.dir, f.id), { force: true });
      return !gone;
    });
    const named = new Set(this.idx.files.map((f) => f.id));
    for (const f of readdirSync(this.dir)) if (f !== 'index.json' && !named.has(f)) rmSync(join(this.dir, f), { force: true });
    if (this.idx.files.length !== before) this.save();
  }

  get seq() {
    return this.idx.seq;
  }
  get acked() {
    return this.idx.acked;
  }
  get pending() {
    return this.idx.files.filter((f) => f.seq > this.idx.acked).length;
  }
  get lastFile(): StatementFile | null {
    const f = this.idx.files.at(-1);
    return f ? strip(f) : null;
  }
  /** Every file still kept, oldest first (for an extractor's own bookkeeping: what it already pulled). */
  all(): StatementFile[] {
    return this.idx.files.map(strip);
  }

  /** Add a pulled file; `statements.file` goes out once it is whole. */
  add(name: string, dir: string, data: string | Uint8Array, opts: { pulledAt?: number; coverage?: { from: number; to: number }; mime?: string } = {}): StatementFile {
    if (!SAFE_NAME.test(name) || name.startsWith('.')) throw new Error(`a spool file name must be a plain file name: ${JSON.stringify(name)}`);
    if (!SAFE_DIR.test(dir) || dir.split('/').some((p) => p === '..' || p === '.')) throw new Error(`a spool dir must be a plain relative path: ${JSON.stringify(dir)}`);
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const seq = this.idx.seq + 1;
    const sha256 = sha256hex(bytes);
    const id = `${seq}-${sha256.slice(0, 16)}`;
    writeWhole(join(this.dir, id), bytes);
    const f: Entry = { seq, id, name, dir, mime: opts.mime ?? mimeOf(name), size: bytes.length, sha256, pulledAt: opts.pulledAt ?? this.now(), ...(opts.coverage ? { coverage: opts.coverage } : {}) };
    this.idx.seq = seq;
    this.idx.files.push(f);
    this.save();
    this.onFile(strip(f));
    return strip(f);
  }

  list(after = 0, limit = 100): { files: StatementFile[]; next: number } {
    const lim = Math.max(1, Math.min(1000, limit | 0 || 100));
    const files = this.idx.files.filter((f) => f.seq > after).slice(0, lim).map(strip);
    return { files, next: files.length ? files[files.length - 1].seq : Math.max(0, after | 0) };
  }

  fetch(id: string): { name: string; dir: string; mime: string; size: number; sha256: string; base64: string } {
    const f = this.idx.files.find((x) => x.id === id);
    if (!f) throw new StatusError('no such file (or it was acked more than 30 days ago)', 404);
    if (f.size > FETCH_MAX) throw new StatusError(`the file is ${f.size} bytes, over the ${FETCH_MAX} a fetch carries`, 413);
    const p = join(this.dir, f.id);
    if (!existsSync(p) || statSync(p).size !== f.size) throw new StatusError('the spool file is missing or torn', 500);
    const b = readFileSync(p);
    if (sha256hex(b) !== f.sha256) throw new StatusError('the spool file does not match its hash', 500);
    return { name: f.name, dir: f.dir, mime: f.mime, size: f.size, sha256: f.sha256, base64: b.toString('base64') };
  }

  /** The bytes of a kept file, for the extractor itself. */
  read(id: string): Buffer | null {
    const f = this.idx.files.find((x) => x.id === id);
    return f && existsSync(join(this.dir, f.id)) ? readFileSync(join(this.dir, f.id)) : null;
  }

  ack(through: number): { acked: number } {
    const t = Math.min(Math.max(0, through | 0), this.idx.seq);
    if (t > this.idx.acked) {
      const now = this.now();
      for (const f of this.idx.files) if (f.seq <= t && f.ackedAt === undefined) f.ackedAt = now;
      this.idx.acked = t;
      this.save();
    }
    this.sweep();
    return { acked: this.idx.acked };
  }
}

const strip = (f: Entry): StatementFile => {
  const { ackedAt: _, ...rest } = f;
  return rest;
};
