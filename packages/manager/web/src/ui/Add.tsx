/**
 * Adding an account: a sheet of services by category (all of them, or one category's from its section's +), each a
 * mark and a name; then the service: its ways as buttons when there is more than one, the fields that way needs, and
 * the rest under "More options". A service with nothing to fill in is one click on Add. What happens next (a code to
 * scan, the live view to sign in) shows on the account once it is made.
 */
import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AddField, ManagerState } from '../../../src/api-types.ts';
import { CATEGORIES, type CategoryId, choicesOf, formOf, type Service, services, type Way } from '../catalog.ts';
import { act, addedNote, copy, go, openWhenReady, state, takeQuery, toast } from '../state.ts';
import { KindMark } from './bits.tsx';
import { brandColor, Icon } from './icons.tsx';

/** The sheet, when open: from the top bar's Add (everything), a section's + (its category) or a service's mark. */
export const adding = signal<{ category: CategoryId | null; service: string | null } | null>(null);
export const openAdd = (category: CategoryId | null = null, service: string | null = null) => (adding.value = { category, service });

/**
 * `?add=<service or category>` (`#/?add=discord`, `#/?add=mail`) opens the sheet there: an app can send you to add
 * the account it wants. `?add` alone opens it whole.
 */
export function openAddFromQuery(s: ManagerState) {
  const want = takeQuery('add');
  if (want === null) return;
  const sv = services(s).find((x) => x.id === want);
  const cat = CATEGORIES.find((c) => c.id === want)?.id ?? null;
  openAdd(sv?.category ?? cat, sv?.id ?? null);
}

interface GoogleStatus {
  configured: boolean;
  redirectUri: string;
  error: string | null;
}

/** A service's mark on its colour, as on the tiles. */
export function ServiceMark({ sv, size = 36 }: { sv: Service; size?: number }) {
  const tint = sv.mark.brand ? brandColor(sv.mark.brand) : null;
  return (
    <span class="mark" style={{ width: `${size}px`, height: `${size}px`, ...(tint ? { '--tint': tint } : {}) }} aria-hidden="true">
      <Icon brand={sv.mark.brand} glyph={sv.mark.glyph} size={Math.round(size * 0.56)} />
    </span>
  );
}

/** ⓘ with its text on hover (and on focus, for keyboards and phones: it is a button). */
export function Tip({ text }: { text: string }) {
  return (
    <button type="button" class="tip" title={text} aria-label={text} onClick={(e) => (e.preventDefault(), toast(text))}>
      <Icon glyph="info" size={14} />
    </button>
  );
}

export function AddSheet() {
  const open = adding.value;
  const s = state.value;
  const all = useMemo(() => (s ? services(s) : []), [s?.kinds, s?.providers]);
  const [query, setQuery] = useState('');
  useEffect(() => setQuery(''), [open?.category, open?.service, !!open]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [!!open]);
  if (!open || !s) return null;
  const close = () => (adding.value = null);
  const sv = open.service ? all.find((x) => x.id === open.service) : undefined;
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog sheet" role="dialog" aria-modal="true" aria-labelledby="add-title" data-add-dialog>
        {sv ? (
          <ServiceForm sv={sv} onBack={() => (adding.value = { category: open.category, service: null })} onClose={close} />
        ) : (
          <Picker all={all} category={open.category} query={query} setQuery={setQuery} onClose={close} />
        )}
      </div>
    </div>
  );
}

function Picker({ all, category, query, setQuery, onClose }: { all: Service[]; category: CategoryId | null; query: string; setQuery: (q: string) => void; onClose: () => void }) {
  const q = query.trim().toLowerCase();
  const shown = all.filter((sv) => (!category || q || sv.category === category) && (!q || `${sv.name} ${sv.line} ${sv.category}`.toLowerCase().includes(q)));
  const cats = CATEGORIES.filter((c) => all.some((sv) => sv.category === c.id));
  const pick = (sv: Service) => (adding.value = { category, service: sv.id });
  return (
    <>
      <div class="sheet-head">
        <h2 id="add-title">Add an account</h2>
        <span class="grow" />
        <button class="btn sm ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div class="sheet-filters">
        <input
          class="sheet-search"
          type="search"
          placeholder="Search"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          aria-label="Search services"
          autoFocus={matchMedia('(pointer: fine)').matches}
          data-add-search
          onKeyDown={(e) => e.key === 'Enter' && shown.length === 1 && pick(shown[0])}
        />
        <div class="chips-row" role="group" aria-label="Category">
          <button class={`chip-btn ${!category ? 'on' : ''}`} aria-pressed={!category} onClick={() => (adding.value = { category: null, service: null })}>
            All
          </button>
          {cats.map((c) => (
            <button key={c.id} class={`chip-btn ${category === c.id ? 'on' : ''}`} aria-pressed={category === c.id} onClick={() => (adding.value = { category: c.id, service: null })} data-add-category={c.id}>
              <Icon glyph={c.glyph} size={14} />
              {c.name}
            </button>
          ))}
        </div>
      </div>
      <div class="sheet-body">
        {cats.map((c) => {
          const list = shown.filter((sv) => sv.category === c.id);
          if (!list.length) return null;
          return (
            <section key={c.id} class="tile-group">
              <h3 class="section-title">{c.name}</h3>
              <div class="tiles">
                {list.map((sv) => (
                  <button key={sv.id} class="tile" title={sv.line} onClick={() => pick(sv)} data-add-service={sv.id}>
                    <ServiceMark sv={sv} size={40} />
                    <span class="tile-name">{sv.name}</span>
                    {sv.ways.length > 1 && (
                      <span class="tile-ways" aria-label={`${sv.ways.length} ways`}>
                        {sv.ways.map((w) => (
                          <Icon key={w.id} glyph={w.glyph} size={12} />
                        ))}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {!shown.length && <p class="muted small">Nothing matches “{query}”.</p>}
      </div>
    </>
  );
}

function ServiceForm({ sv, onBack, onClose }: { sv: Service; onBack: () => void; onClose: () => void }) {
  const s = state.value!;
  const [wayId, setWay] = useState(sv.ways[0].id);
  const way = sv.ways.find((w) => w.id === wayId) ?? sv.ways[0];
  return (
    <>
      <div class="sheet-head">
        <button class="btn sm ghost" onClick={onBack} aria-label="All services" data-add-back>
          <Icon glyph="back" size={16} />
        </button>
        <ServiceMark sv={sv} size={36} />
        <div class="sheet-title">
          <h2 id="add-title">{sv.name}</h2>
          <p class="small muted">{sv.line}</p>
        </div>
        <span class="grow" />
        <button class="btn sm ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {sv.ways.length > 1 && (
        <div class="ways" role="radiogroup" aria-label="How to add it">
          {sv.ways.map((w) => (
            <button key={w.id} type="button" role="radio" aria-checked={w.id === way.id} class={`way ${w.id === way.id ? 'on' : ''}`} title={w.tip} onClick={() => setWay(w.id)} data-add-way={w.id}>
              <Icon glyph={w.glyph} size={20} />
              <span>{w.label}</span>
            </button>
          ))}
        </div>
      )}
      <p class="small muted way-tip">{way.tip}</p>
      {way.oauth === 'google' ? (
        <GoogleApiSetup g={s.providers.google as GoogleStatus} onDone={onClose} />
      ) : (
        <KindForm sv={sv} way={way} key={`${sv.id}/${way.id}`} onClose={onClose} />
      )}
    </>
  );
}

function KindForm({ sv, way, onClose }: { sv: Service; way: Way; onClose: () => void }) {
  const s = state.value!;
  const kind = s.kinds.find((k) => k.kind === way.kind);
  const { main, more, preset } = formOf(kind ?? undefined, way);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries([...main, ...more].filter((f) => f.default && choicesOf(f)).map((f) => [f.key, f.default!])));
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => void (matchMedia('(pointer: fine)').matches && first.current?.focus()), []);
  if (!kind) return null;
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));
  const add = async (e: Event) => {
    e.preventDefault();
    const config: Record<string, string> = { ...preset };
    const secret: Record<string, string> = {};
    for (const f of [...main, ...more]) if (values[f.key]?.trim()) (f.secret ? secret : config)[f.key] = values[f.key].trim();
    for (const f of main) if (!f.optional && !values[f.key]?.trim() && !f.default) return toast(`${f.label} is needed`, 'error');
    setBusy(true);
    const r = await act<{ id: string }>(
      '/api/accounts',
      { method: 'POST', body: { kind: kind.kind, ...(nickname.trim() ? { label: nickname.trim() } : {}), config, ...(Object.keys(secret).length ? { secret } : {}) } },
      `Added ${nickname.trim() || sv.name}`,
    );
    setBusy(false);
    if (r?.id) {
      openWhenReady.value = r.id;
      addedNote.value = kind.add?.next ? { id: r.id, text: kind.add.next } : null;
      onClose();
      go('accounts', r.id);
    }
  };
  return (
    <form onSubmit={add} class="add-form" data-add-kind={kind.kind}>
      {main.map((f, i) => (
        <Field key={f.key} f={f} value={values[f.key] ?? ''} onChange={(v) => set(f.key, v)} inputRef={i === 0 ? first : undefined} />
      ))}
      <details class="more" open={false}>
        <summary>More options</summary>
        <div class="add-form">
          {more.map((f) => (
            <Field key={f.key} f={f} value={values[f.key] ?? ''} onChange={(v) => set(f.key, v)} />
          ))}
          <label class="field">
            <span class="field-label">
              Nickname <Tip text={`Only if you want one: otherwise it is called by the name it signs in as (or “${sv.name}” until then).`} />
            </span>
            <input value={nickname} placeholder="e.g. Work" onInput={(e) => setNickname((e.target as HTMLInputElement).value)} data-add-nickname />
          </label>
        </div>
      </details>
      <div class="row end">
        {kind.add?.next && (
          <span class="small faint next-hint">
            What happens next <Tip text={kind.add.next} />
          </span>
        )}
        <span class="grow" />
        <button class="btn primary" disabled={busy} data-add-confirm>
          <Icon glyph="plus" size={16} />
          Add {sv.name.replace(/^Other /, '')}
        </button>
      </div>
    </form>
  );
}

/** One field: a choice of a few words as buttons, else an input (a password box for secrets); its hint as ⓘ. */
function Field({ f, value, onChange, inputRef }: { f: AddField; value: string; onChange: (v: string) => void; inputRef?: preact.Ref<HTMLInputElement> }) {
  const choices = choicesOf(f);
  const label = (
    <span class="field-label">
      {f.label}
      {f.optional && <span class="faint"> (optional)</span>}
      {f.secret && (
        <span class="lock" title="Kept in its secret.json on this machine, where only its extractor reads it; the page never shows it again.">
          <Icon glyph="key" size={13} />
        </span>
      )}
      {f.hint && <Tip text={f.hint} />}
    </span>
  );
  if (choices)
    return (
      <div class="field" role="group" aria-label={f.label} data-add-field={f.key}>
        {label}
        <div class="seg">
          {choices.map((c) => (
            <button key={c} type="button" class={`seg-btn ${value === c ? 'on' : ''}`} aria-pressed={value === c} onClick={() => onChange(value === c && f.optional ? '' : c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <label class="field">
      {label}
      <input
        ref={inputRef}
        type={(f.secret ? 'password' : 'text') as 'text'}
        autocomplete="off"
        spellcheck={false}
        placeholder={f.placeholder}
        value={value}
        required={!f.optional && !f.default}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        data-add-field={f.key}
      />
    </label>
  );
}

function GoogleApiSetup({ g, onDone }: { g: GoogleStatus; onDone: () => void }) {
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const save = async (e: Event) => {
    e.preventDefault();
    if (!clientId.trim() || !secret.trim()) return toast('Both the client ID and the secret are needed', 'error');
    if (await act('/api/providers/google/client', { method: 'PUT', body: { clientId: clientId.trim(), clientSecret: secret.trim() } }, 'Google client saved')) {
      setClientId('');
      setSecret('');
    }
  };
  if (g.configured)
    return (
      <div class="add-form" data-google>
        {g.error && <p class="banner error">{g.error}</p>}
        <div class="row end">
          <span class="small muted grow">Your OAuth client is saved; Google asks which account.</span>
          <button
            class="btn primary"
            onClick={() => {
              onDone();
              location.href = '/oauth/google/start';
            }}
            data-google-connect
          >
            <Icon brand="google" mono size={16} />
            Connect with Google
          </button>
        </div>
      </div>
    );
  return (
    <form onSubmit={save} class="add-form" data-google>
      {g.error && <p class="banner error">{g.error}</p>}
      <ol class="small steps">
        <li>In the Google Cloud console, make a project and enable the Google Calendar API.</li>
        <li>Set up the OAuth consent screen (External) with yourself as a test user, or publish it so sign-ins do not lapse after 7 days.</li>
        <li>Make an OAuth client ID of type Web application, with this redirect URI:</li>
      </ol>
      <div class="copy-row">
        <code data-redirect>{g.redirectUri}</code>
        <button type="button" class="btn sm" onClick={() => copy(g.redirectUri)}>
          Copy
        </button>
      </div>
      <label class="field">
        <span class="field-label">Client ID</span>
        <input value={clientId} onInput={(e) => setClientId((e.target as HTMLInputElement).value)} autocomplete="off" spellcheck={false} />
      </label>
      <label class="field">
        <span class="field-label">Client secret</span>
        <input type="password" value={secret} onInput={(e) => setSecret((e.target as HTMLInputElement).value)} autocomplete="off" spellcheck={false} />
      </label>
      <div class="row end">
        <button class="btn primary" type="submit">
          Save
        </button>
      </div>
    </form>
  );
}
