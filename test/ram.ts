/**
 * A directory for a test's data in RAM (/dev/shm), or the usual temporary directory where there is none.
 *
 * For tests whose data is written with fsyncs (the registry, secret.json) but that check something else: on a machine
 * where other processes sync their own files, one fsync can take seconds, longer than such a test is given. On tmpfs an
 * fsync returns at once. A test about what survives on disk keeps to tmpdir().
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

export const ramdir = existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
