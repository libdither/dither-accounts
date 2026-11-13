/** A JSON file in the account's directory, written whole or not at all (a temporary file renamed over it). */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class JsonFile<T> {
  constructor(
    readonly path: string,
    private empty: () => T,
  ) {}

  load(): T {
    if (!existsSync(this.path)) return this.empty();
    try {
      return { ...this.empty(), ...JSON.parse(readFileSync(this.path, 'utf8')) };
    } catch {
      return this.empty();
    }
  }

  save(value: T) {
    const tmp = join(dirname(this.path), `.${Math.random().toString(36).slice(2)}.tmp`);
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}

/** Sync tokens handed to apps: a prefix and base64url JSON, so a token from elsewhere is told apart (and is stale). */
export const encodeToken = (prefix: string, v: unknown) => `${prefix}.${Buffer.from(JSON.stringify(v)).toString('base64url')}`;
export function decodeToken<T>(prefix: string, s: string): T | null {
  if (typeof s !== 'string' || !s.startsWith(`${prefix}.`)) return null;
  try {
    return JSON.parse(Buffer.from(s.slice(prefix.length + 1), 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}
