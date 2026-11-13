/**
 * What a file is, by its bytes rather than by the type a network gave it (docs/files.md). The hub works it out once
 * the bytes are kept (packages/hub/src/fileinfo.ts) and sends it with the attachment; the app picks a viewer by it,
 * and by the name and type alone until then.
 */

/**
 * Which of the app's viewers shows the file. 'text' covers code and markup too (HTML, SVG and XML are shown as their
 * source, never rendered); 'binary' has no viewer.
 */
export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'markdown' | 'json' | 'csv' | 'archive' | 'binary';

export interface ArchiveEntry {
  name: string;
  /** Uncompressed, in bytes. */
  size: number;
  dir?: boolean;
}

export interface FileInfo {
  /** The type by the bytes: a plain `type/subtype`. */
  mime: string;
  kind: FileKind;
  /** In bytes. */
  size: number;
  /** PDF. */
  pages?: number;
  /** Text: 'utf-8', 'utf-16le', 'utf-16be' or 'windows-1252'. */
  encoding?: string;
  lines?: number;
  /** Text: a language for highlighting, from the name and the content (LANGUAGES). */
  language?: string;
  /** Archive: how many entries. */
  entries?: number;
  /** Archive: the first entries, names and sizes. Nothing is extracted. */
  list?: ArchiveEntry[];
  width?: number;
  height?: number;
  /** Audio and video, in seconds. */
  duration?: number;
  /** Lines or entries were counted in the first part of a large file only: there are at least this many. */
  partial?: boolean;
}

/** Highlighting languages by extension (lower case), and the type each is known by on a desktop (shared-mime-info). */
const LANG: [lang: string, mime: string, exts: string][] = [
  ['javascript', 'text/javascript', 'js mjs cjs jsx'],
  ['typescript', 'text/x-typescript', 'ts mts cts tsx'],
  ['python', 'text/x-python', 'py pyw pyi'],
  ['ruby', 'application/x-ruby', 'rb rake gemspec'],
  ['rust', 'text/rust', 'rs'],
  ['go', 'text/x-go', 'go'],
  ['c', 'text/x-csrc', 'c h'],
  ['cpp', 'text/x-c++src', 'cpp cc cxx hpp hh hxx ino'],
  ['csharp', 'text/x-csharp', 'cs'],
  ['java', 'text/x-java', 'java'],
  ['kotlin', 'text/x-kotlin', 'kt kts'],
  ['swift', 'text/x-swift', 'swift'],
  ['scala', 'text/x-scala', 'scala sc'],
  ['dart', 'text/plain', 'dart'],
  ['php', 'application/x-php', 'php'],
  ['perl', 'application/x-perl', 'pl pm'],
  ['lua', 'text/x-lua', 'lua'],
  ['r', 'text/x-r', 'r'],
  ['haskell', 'text/x-haskell', 'hs'],
  ['ocaml', 'text/x-ocaml', 'ml mli'],
  ['elixir', 'text/plain', 'ex exs'],
  ['erlang', 'text/x-erlang', 'erl hrl'],
  ['clojure', 'text/plain', 'clj cljs cljc edn'],
  ['lisp', 'text/plain', 'el lisp scm rkt'],
  ['julia', 'text/plain', 'jl'],
  ['zig', 'text/plain', 'zig'],
  ['nix', 'text/x-nix', 'nix'],
  ['shell', 'application/x-shellscript', 'sh bash zsh ksh fish'],
  ['powershell', 'text/plain', 'ps1 psm1'],
  ['batch', 'text/plain', 'bat cmd'],
  ['sql', 'application/sql', 'sql'],
  ['graphql', 'text/plain', 'graphql gql'],
  ['css', 'text/css', 'css scss sass less'],
  ['html', 'text/html', 'html htm xhtml vue svelte'],
  ['xml', 'application/xml', 'xml xsd xsl xslt plist rss atom csproj svg'],
  ['json', 'application/json', 'json jsonc json5 geojson webmanifest ipynb'],
  ['yaml', 'application/yaml', 'yaml yml'],
  ['toml', 'application/toml', 'toml'],
  ['ini', 'text/plain', 'ini cfg conf properties env editorconfig'],
  ['markdown', 'text/markdown', 'md markdown mdown mkd'],
  ['csv', 'text/csv', 'csv'],
  ['tsv', 'text/tab-separated-values', 'tsv tab'],
  ['diff', 'text/x-patch', 'diff patch'],
  ['latex', 'text/x-tex', 'tex sty cls bib'],
  ['protobuf', 'text/plain', 'proto'],
  ['hcl', 'text/plain', 'tf hcl'],
  ['groovy', 'text/x-groovy', 'gradle groovy'],
  ['asm', 'text/plain', 'asm s'],
  ['dockerfile', 'text/plain', 'dockerfile containerfile'],
  ['makefile', 'text/x-makefile', 'mk mak'],
];
/** Whole names that say their language. */
const NAMES: Record<string, string> = { dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', justfile: 'makefile', 'cmakelists.txt': 'makefile', gemfile: 'ruby', rakefile: 'ruby', 'flake.lock': 'json', '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell' };

export const LANGUAGE_BY_EXT: Record<string, string> = Object.fromEntries(LANG.flatMap(([l, , exts]) => exts.split(' ').map((e) => [e, l])));
export const MIME_BY_LANGUAGE: Record<string, string> = Object.fromEntries(LANG.map(([l, m]) => [l, m]));
/** Plain text by name. */
const TEXT_EXTS = new Set(['txt', 'text', 'log', 'nfo', 'rst', 'adoc', 'org', 'srt', 'vtt', 'lst', 'readme']);

/**
 * A file name as it may be shown or looked at: no control or direction-changing characters (a name can use those to
 * look like it ends in another extension), at most 200 characters.
 */
export function cleanName(name: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  return Array.from((name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '')).slice(0, 200).join('');
}

/** The extension, lower case, of the last part of a path: '' for none or for one that is no plain extension. */
export function extOf(name: string | null | undefined): string {
  const base = cleanName(name).split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 && !/^\.[a-z]+rc$/i.test(base)) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9+_-]{1,12}$/.test(ext) ? ext : '';
}

/** A highlighting language from the name alone; null when it says none. */
export function languageOf(name: string | null | undefined): string | null {
  const base = (cleanName(name).split(/[\\/]/).pop() ?? '').toLowerCase();
  return NAMES[base] ?? LANGUAGE_BY_EXT[extOf(name)] ?? null;
}

const essence = (mime: string | null | undefined) => (mime ?? '').split(';')[0].trim().toLowerCase();

/**
 * The viewer for a file by its name and the network's type, before the hub has looked at the bytes. Errs towards
 * 'binary': the text viewers decode what they get, but a guess should not open a video as text.
 */
export function guessKind(mime: string | null | undefined, name: string | null | undefined): FileKind {
  const m = essence(mime);
  const ext = extOf(name);
  const lang = languageOf(name);
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(m)) return 'image';
  if (/^video\//.test(m)) return 'video';
  if (/^audio\//.test(m)) return 'audio';
  if (m === 'text/markdown' || lang === 'markdown') return 'markdown';
  if (m === 'application/json' || lang === 'json') return 'json';
  if (m === 'text/csv' || m === 'text/tab-separated-values' || lang === 'csv' || lang === 'tsv') return 'csv';
  if (m === 'application/zip' || m === 'application/x-tar' || m === 'application/gzip' || /^(zip|tar|tgz|gz)$/.test(ext)) return 'archive';
  if (lang || TEXT_EXTS.has(ext) || /^text\//.test(m) || /\+xml$|\/xml$|\/(javascript|x-sh|x-shellscript|toml|yaml|sql)$/.test(m)) return 'text';
  return 'binary';
}
