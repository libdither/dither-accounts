/**
 * A file for signal-cli's `send` (`attachment`). Given a path, signal-cli names the file by the path and takes its type
 * from the name's extension (Java's probe, which finds no mime.types on many systems), else from its first bytes; a
 * file the hub spooled has neither name nor extension, so every file went out under the spool's random name, and a
 * WebP's RIFF header read as WAV audio. A data URI says both: `data:<type>;filename=<name>;base64,<bytes>`
 * (signal-cli's DataURI, which URL-decodes the name). It carries the bytes in the request, so a big file still goes by
 * its path.
 */
import { readFileSync } from 'node:fs';

/** The largest file sent as a data URI (it rides in the JSON-RPC line, a third bigger). */
export const DATA_URI_MAX = 25 * 1024 * 1024;

const TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export function attachmentArg(f: { path: string; name: string; mime: string; size: number }, read: (path: string) => Buffer = readFileSync): string {
  if (!(f.size >= 0 && f.size <= DATA_URI_MAX)) return f.path;
  const type = TYPE.test(f.mime) ? f.mime.toLowerCase() : 'application/octet-stream';
  // Path parts and control characters out; what is left is URL-encoded, so ; , and = stay inside the value.
  const name = f.name.replace(/[\u0000-\u001f\u007f/\\]+/g, '_').trim().slice(0, 200);
  const named = name ? `;filename=${encodeURIComponent(name)}` : '';
  return `data:${type}${named};base64,${read(f.path).toString('base64')}`;
}
