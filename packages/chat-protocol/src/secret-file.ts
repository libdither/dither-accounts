/**
 * An account's secret.json, written so a crash or a full disk never leaves half a file: the new text goes to a
 * temporary file, is flushed to disk and renamed over the old one, and the old one stays as secret.json.bak. The
 * Matrix adapter keeps its encryption store key here, so a torn write would lose the encrypted device.
 */

import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function writeSecretFile(path: string, value: unknown) {
  const text = JSON.stringify(value ?? {}, null, 2);
  const tmp = join(dirname(path), `.secret.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  chmodSync(tmp, 0o600);
  // The last good copy, for readSecretFile when the main one does not parse.
  if (existsSync(path) && parses(path)) {
    copyFileSync(path, path + '.bak');
    chmodSync(path + '.bak', 0o600);
  }
  renameSync(tmp, path);
  // The rename itself, made durable.
  try {
    const dfd = openSync(dirname(path), 'r');
    fsyncSync(dfd);
    closeSync(dfd);
  } catch {}
}

/** secret.json, or its .bak when it does not parse, or {} when there is neither. Never throws on bad JSON. */
export function readSecretFile<T = Record<string, unknown>>(path: string, log?: (msg: string) => void): T {
  for (const p of [path, path + '.bak']) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, 'utf8') || '{}') as T;
    } catch {
      log?.(`${p} does not parse${p === path ? '; trying the backup' : ''}`);
    }
  }
  return {} as T;
}

function parses(p: string): boolean {
  try {
    JSON.parse(readFileSync(p, 'utf8') || '{}');
    return true;
  } catch {
    return false;
  }
}
