/**
 * A PNG decoder for tests (8-bit RGB or RGBA, not interlaced: what grim, ImageMagick's import and Chromium write), so a
 * test can look at the pixels of a screenshot.
 */
import { inflateSync } from 'node:zlib';

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

export function decodePng(png: Buffer): Pixels {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const body = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) throw new Error(`PNG depth ${depth} color ${color} interlace ${interlace}: not decoded here`);
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = cur[x * channels];
      data[o + 1] = cur[x * channels + 1];
      data[o + 2] = cur[x * channels + 2];
      data[o + 3] = channels === 4 ? cur[x * channels + 3] : 255;
    }
    prev.set(cur);
  }
  return { width, height, data };
}

/** The share of pixels within `tol` of an RGB colour. */
export function shareOf(p: Pixels, rgb: [number, number, number], tol = 8): number {
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) if (Math.abs(p.data[i] - rgb[0]) <= tol && Math.abs(p.data[i + 1] - rgb[1]) <= tol && Math.abs(p.data[i + 2] - rgb[2]) <= tol) n++;
  return n / (p.width * p.height);
}
