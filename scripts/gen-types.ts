/**
 * The interfaces' TypeScript types, as text for the manager's page: each op's input and output, each event, and the
 * named types they use, expanded the way the client sees them (`InputOf<typeof chat, 'send'>`), plus an example
 * input to start from. Runtime schemas only know "an object" for types taken from elsewhere (dither-chat's
 * protocol), so the compiler is asked instead.
 *
 *   bun scripts/gen-types.ts           # writes packages/interfaces/src/types.generated.json
 *   bun scripts/gen-types.ts --check   # fails if that file is stale (test/types.test.ts runs this)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { IFACES } from '@dither-accounts/interfaces';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
export const OUT = join(ROOT, 'packages/interfaces/src/types.generated.json');

export interface OpTypes {
  input: string;
  output: string;
  example: unknown;
}
export interface IfaceTypes {
  ops: Record<string, OpTypes>;
  events: Record<string, string>;
  /** Named types the ops and events use, by name: `interface About { … }`. */
  defs: Record<string, string>;
}
export type Types = Record<string, IfaceTypes>;

/** Aliases that read better expanded than named. */
const EXPAND = new Set(['Omit', 'Pick', 'Extract', 'Exclude', 'Partial', 'Required', 'NonNullable', 'InputOf', 'OutputOf', 'EventOf', 'Infer', 'ObjectOf']);
const MAX_DEPTH = 6;
const WIDTH = 100;

const exportName: Record<string, string> = { chat: 'chat', 'google.calendar': 'googleCalendar', 'test.echo': 'testEcho', calendar: 'calendar', contacts: 'contacts', mail: 'mail', notifications: 'notifications', desktop: 'desktop', exchange: 'exchange', 'privacy.session': 'privacySession', statements: 'statements', 'monero.view': 'moneroView', dns: 'dns' };

export function generate(): Types {
  const cfgPath = join(ROOT, 'tsconfig.json');
  const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => console.error(d.messageText) })!;
  const probe = join(ROOT, 'scripts/__types_probe__.ts');
  const lines = [`import * as I from '@dither-accounts/interfaces';`, `import type { Infer, InputOf, OutputOf } from '@dither-accounts/spec';`];
  const names: { iface: string; kind: 'in' | 'out' | 'ev'; key: string; alias: string }[] = [];
  let n = 0;
  for (const i of Object.values(IFACES)) {
    const ex = exportName[i.name];
    if (!ex) throw new Error(`gen-types: add ${i.name} to exportName`);
    for (const op of Object.keys(i.ops)) {
      const a = `T${n++}`;
      lines.push(`export type ${a} = InputOf<typeof I.${ex}, ${JSON.stringify(op)}>;`);
      names.push({ iface: i.name, kind: 'in', key: op, alias: a });
      const b = `T${n++}`;
      lines.push(`export type ${b} = OutputOf<typeof I.${ex}, ${JSON.stringify(op)}>;`);
      names.push({ iface: i.name, kind: 'out', key: op, alias: b });
    }
    for (const e of Object.keys(i.events)) {
      const a = `T${n++}`;
      lines.push(`export type ${a} = Infer<(typeof I.${ex})['events'][${JSON.stringify(e)}]['schema']>;`);
      names.push({ iface: i.name, kind: 'ev', key: e, alias: a });
    }
  }
  const text = lines.join('\n');
  const host = ts.createCompilerHost(cfg.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, ...rest) => (f === probe ? ts.createSourceFile(f, text, lang) : getSourceFile(f, lang, ...rest));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (f) => f === probe || fileExists(f);
  const program = ts.createProgram([probe], cfg.options, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(probe)!;
  const aliases = new Map<string, ts.TypeAliasDeclaration>();
  sf.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node);
  });

  const out: Types = {};
  for (const i of Object.values(IFACES)) out[i.name] = { ops: {}, events: {}, defs: {} };
  for (const { iface, kind, key, alias } of names) {
    const decl = aliases.get(alias)!;
    const t = checker.getTypeAtLocation(decl.name);
    const p = new Printer(checker, decl);
    const str = p.print(t, 0);
    const it = out[iface];
    if (kind === 'ev') it.events[key] = str;
    else {
      const op = (it.ops[key] ??= { input: '', output: '', example: null });
      if (kind === 'in') {
        op.input = str;
        op.example = new Example(checker, decl).of(t, 0);
      } else op.output = str;
    }
    p.flushDefs(it.defs);
  }
  for (const it of Object.values(out)) it.defs = Object.fromEntries(Object.entries(it.defs).sort(([a], [b]) => a.localeCompare(b)));
  return out;
}

const isLib = (d: ts.Declaration | undefined) => !!d && /node_modules\/(typescript|@types|bun-types)\//.test(d.getSourceFile().fileName);

class Printer {
  private defs = new Map<string, string>();
  private pending: { name: string; type: ts.Type; decl: ts.Declaration }[] = [];
  private named = new Set<string>();
  constructor(
    private c: ts.TypeChecker,
    private at: ts.Node,
  ) {}

  /** A named type the page lists under the op (`About`), or null to expand it in place. */
  private nameOf(t: ts.Type): { name: string; decl: ts.Declaration } | null {
    const alias = t.aliasSymbol;
    if (alias) {
      const decl = alias.declarations?.[0];
      if (EXPAND.has(alias.name) || isLib(decl) || !decl) return null;
      const args = t.aliasTypeArguments?.length ? `<${t.aliasTypeArguments.map((a) => this.print(a, MAX_DEPTH)).join(', ')}>` : '';
      return { name: alias.name + args, decl };
    }
    const sym = t.getSymbol();
    if (sym && (sym.flags & ts.SymbolFlags.Interface || sym.flags & ts.SymbolFlags.Class) && !(t.flags & ts.TypeFlags.Union)) {
      const decl = sym.declarations?.[0];
      if (!decl || isLib(decl)) return null;
      return { name: sym.name, decl };
    }
    return null;
  }

  print(t: ts.Type, depth: number, top = true): string {
    if (!top || depth > 0) {
      const nm = this.nameOf(t);
      if (nm) {
        const base = nm.name.replace(/<.*$/, '');
        if (!this.named.has(base)) {
          this.named.add(base);
          this.pending.push({ name: base, type: t, decl: nm.decl });
        }
        return nm.name;
      }
    }
    if (depth >= MAX_DEPTH) return this.c.typeToString(t, this.at, ts.TypeFormatFlags.NoTruncation);
    // Record<string, any> and friends read better as written.
    if (t.aliasSymbol && !EXPAND.has(t.aliasSymbol.name) && isLib(t.aliasSymbol.declarations?.[0])) return this.c.typeToString(t, this.at, ts.TypeFormatFlags.NoTruncation);
    if (t.isUnion()) return this.union(t, depth, false);
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.BooleanLike | ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike)) {
      return this.c.typeToString(t, this.at, ts.TypeFormatFlags.NoTruncation);
    }
    if (this.c.isArrayType(t)) {
      const el = this.c.getTypeArguments(t as ts.TypeReference)[0];
      const s = this.print(el, depth + 1, false);
      return (el.isUnion() || el.isIntersection()) && !this.nameOf(el) && !/^(boolean|\w+)$/.test(s) ? `(${s})[]` : `${s}[]`;
    }
    if (this.c.isTupleType(t)) return `[${this.c.getTypeArguments(t as ts.TypeReference).map((x) => this.print(x, depth + 1, false)).join(', ')}]`;
    if (t.getCallSignatures().length) return this.c.typeToString(t, this.at, ts.TypeFormatFlags.NoTruncation);
    if (t.flags & ts.TypeFlags.Object || t.isIntersection()) return this.object(t, depth);
    return this.c.typeToString(t, this.at, ts.TypeFormatFlags.NoTruncation);
  }

  private union(t: ts.UnionType, depth: number, optional: boolean): string {
    const parts = this.unionParts(t)
      .filter((x) => !(optional && x.flags & ts.TypeFlags.Undefined))
      .map((x) => this.print(x, depth + 1, false));
    const uniq = [...new Set(parts)];
    const one = uniq.join(' | ');
    return one.length <= WIDTH && !one.includes('\n') ? one : uniq.join('\n| ');
  }

  /** `true | false` reads as boolean, and an optional property's `undefined` is its `?`. */
  private unionParts(t: ts.UnionType): ts.Type[] {
    const ts_ = t.types;
    const hasTrue = ts_.some((x) => x.flags & ts.TypeFlags.BooleanLiteral && this.c.typeToString(x) === 'true');
    const hasFalse = ts_.some((x) => x.flags & ts.TypeFlags.BooleanLiteral && this.c.typeToString(x) === 'false');
    if (hasTrue && hasFalse) {
      const rest = ts_.filter((x) => !(x.flags & ts.TypeFlags.BooleanLiteral));
      return [...rest, this.c.getBooleanType()];
    }
    return [...ts_];
  }

  private object(t: ts.Type, depth: number): string {
    const props = this.c.getPropertiesOfType(t);
    const idx = this.c.getIndexInfosOfType(t);
    if (!props.length && !idx.length) return '{}';
    const pad = '  ';
    const fields: string[] = [];
    for (const ix of idx) fields.push(`[key: ${this.c.typeToString(ix.keyType)}]: ${this.print(ix.type, depth + 1, false)}`);
    for (const p of props) {
      const opt = !!(p.flags & ts.SymbolFlags.Optional);
      const pt = this.c.getTypeOfSymbolAtLocation(p, this.at);
      const doc = ts.displayPartsToString(p.getDocumentationComment(this.c)).replace(/\s+/g, ' ').trim().slice(0, 240);
      const key = /^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : JSON.stringify(p.name);
      const type = opt && pt.isUnion() && !pt.aliasSymbol ? this.union(pt, depth, true) : this.print(pt, depth + 1, false);
      fields.push(`${doc ? `/** ${doc} */\n` : ''}${key}${opt ? '?' : ''}: ${type}`);
    }
    const one = `{ ${fields.join('; ')} }`;
    if (one.length + depth * 2 <= WIDTH && !one.includes('\n')) return one;
    return `{\n${fields.map((f) => pad + f.replace(/\n/g, '\n' + pad) + ';').join('\n')}\n}`;
  }

  /** Write the named types met so far (and the ones they name) into `defs`. */
  flushDefs(defs: Record<string, string>) {
    while (this.pending.length) {
      const { name, type, decl } = this.pending.shift()!;
      if (defs[name] || this.defs.has(name)) continue;
      const declared = this.c.getDeclaredTypeOfSymbol((type.aliasSymbol ?? type.getSymbol())!);
      const body = this.print(type.aliasSymbol ? type : declared, 0, true);
      const params = ts.isTypeAliasDeclaration(decl) || ts.isInterfaceDeclaration(decl) ? decl.typeParameters?.map((p) => p.getText()).join(', ') : undefined;
      const head = `${name}${params ? `<${params}>` : ''}`;
      const doc = (decl as any).jsDoc?.[0]?.comment;
      const text = `${typeof doc === 'string' ? `/** ${doc.split('\n')[0]} */\n` : ''}type ${head} = ${body};`;
      this.defs.set(name, text);
      defs[name] = text;
    }
  }
}

/** A value of the type to start editing from: required fields only, the first choice of a union. */
class Example {
  constructor(
    private c: ts.TypeChecker,
    private at: ts.Node,
  ) {}
  of(t: ts.Type, depth: number): unknown {
    if (depth > 5) return null;
    if (t.isUnion()) {
      const choices = t.types.filter((x) => !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
      if (choices.every((x) => x.flags & ts.TypeFlags.BooleanLiteral)) return false;
      return choices.length ? this.of(choices[0], depth) : null;
    }
    if (t.isStringLiteral()) return t.value;
    if (t.isNumberLiteral()) return t.value;
    if (t.flags & ts.TypeFlags.BooleanLiteral) return this.c.typeToString(t) === 'true';
    if (t.flags & ts.TypeFlags.StringLike) return '';
    if (t.flags & ts.TypeFlags.NumberLike) return 0;
    if (t.flags & ts.TypeFlags.BooleanLike) return false;
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
    if (this.c.isArrayType(t) || this.c.isTupleType(t)) return [];
    if (t.flags & ts.TypeFlags.Object || t.isIntersection()) {
      const o: Record<string, unknown> = {};
      for (const p of this.c.getPropertiesOfType(t)) {
        if (p.flags & ts.SymbolFlags.Optional) continue;
        o[p.name] = this.of(this.c.getTypeOfSymbolAtLocation(p, this.at), depth + 1);
      }
      return o;
    }
    return null;
  }
}

if (import.meta.main) {
  const text = JSON.stringify(generate(), null, 1) + '\n';
  if (process.argv.includes('--check')) {
    const cur = (() => {
      try {
        return readFileSync(OUT, 'utf8');
      } catch {
        return '';
      }
    })();
    if (cur !== text) {
      console.error('packages/interfaces/src/types.generated.json is stale: run bun scripts/gen-types.ts');
      process.exit(1);
    }
    console.log('types are current');
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT} (${Math.round(text.length / 1024)} KB)`);
  }
}
