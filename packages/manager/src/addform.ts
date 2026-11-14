import type { AddField } from '@dither-accounts/spec';

/**
 * An add form's answers, split by its fields (Manifest.add.fields): config keys the kind does not name are passed on
 * (tests and kinds without fields send their own config), secret ones never land in the config. A string says what is
 * wrong.
 */
export function addForm(fields: AddField[], config: unknown, secret: unknown): { config: Record<string, unknown>; secret: Record<string, string> | null } | string {
  const c: Record<string, unknown> = config && typeof config === 'object' && !Array.isArray(config) ? { ...(config as Record<string, unknown>) } : {};
  const given: Record<string, unknown> = secret && typeof secret === 'object' && !Array.isArray(secret) ? (secret as Record<string, unknown>) : {};
  const sec: Record<string, string> = {};
  for (const f of fields) {
    const raw = f.secret ? given[f.key] : c[f.key];
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (f.secret) delete c[f.key];
    if (!v) {
      if (f.secret) continue;
      if (f.default !== undefined) c[f.key] = f.default;
      else if (!f.optional) return `${f.label} is needed`;
      else delete c[f.key];
      continue;
    }
    if (f.pattern && !new RegExp(f.pattern).test(v)) return `${f.label}: ${f.hint ?? 'that does not look right'}`;
    if (f.secret) sec[f.key] = v;
    else c[f.key] = v;
  }
  for (const f of fields) if (f.secret && !f.optional && !sec[f.key]) return `${f.label} is needed`;
  return { config: c, secret: Object.keys(sec).length ? sec : null };
}
