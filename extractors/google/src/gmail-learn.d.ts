/** Types for gmail-learn.js (plain JS: the same block runs in the Gmail page's hook). */

/** Type tags (e, h16, d, ts, url, b64, s0 … s1k+, n, n:ms, n:s, len:<n>, …) and anchors only: never a value. */
export type Shape = null | boolean | number | string | Shape[] | { [key: string]: Shape };

export type BodyShape =
  | null
  | { json: Shape }
  | { chunks: Shape[] }
  | { form: Record<string, Shape> }
  | { multipart: Record<string, Shape> }
  | { binary: string }
  | { text: string };

export interface RequestShape {
  query?: Record<string, Shape>;
  body?: BodyShape;
}

export function shape(v: unknown): Shape;
export function shapeBody(body: unknown, contentType?: string | null): BodyShape;
export function requestShape(search: string | null | undefined, contentType: string | null | undefined, body: unknown): RequestShape;
export function pathTemplate(path: string): string;
export function mediaType(contentType: string | null | undefined): string | null;
/** The hash a gmail.nav may set, in Gmail's own form; throws (saying why, never what the search held) if none. */
export function navHash(hash: unknown): string;
/** What a non-mail answer reads as: a sign-in page, a verification or captcha page, or neither. Never its text. */
export function pageKind(status: number, contentType: string | null | undefined, text: string | null | undefined, url: string | null | undefined): 'signin' | 'challenge' | null;
export const OPS: readonly string[];
export const VIEWS: readonly string[];
