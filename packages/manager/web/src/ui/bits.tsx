/** Small pieces the sections share: level pills, status dots, avatars, the account picker, toasts and the confirm dialog. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AccountInfo } from '../../../src/api-types.ts';
import { markOf } from '../catalog.ts';
import { accountName, confirming, kindName, named, state, toasts } from '../state.ts';
import { brandColor, Icon } from './icons.tsx';

export type Level = 'read' | 'write' | 'manage';
export const LEVELS: Level[] = ['read', 'write', 'manage'];
export const LEVEL_WORD: Record<Level, string> = { read: 'Read', write: 'Write', manage: 'Manage' };

export function LevelPill({ level }: { level: Level }) {
  return <span class={`pill level-${level}`}>{LEVEL_WORD[level]}</span>;
}

/** A kind's mark (its brand, or a glyph) on a soft square of its colour. */
export function KindMark({ kind, interfaces, size = 32 }: { kind: string; interfaces?: string[]; size?: number }) {
  const m = markOf(kind, interfaces);
  const tint = m.brand ? brandColor(m.brand) : null;
  return (
    <span class="mark" style={{ width: `${size}px`, height: `${size}px`, ...(tint ? { '--tint': tint } : {}) }} aria-hidden="true">
      <Icon brand={m.brand} glyph={m.glyph} size={Math.round(size * 0.56)} />
    </span>
  );
}

/**
 * An account's picture (who it is, or was last, signed in as) with its kind's mark in the corner; without a picture,
 * its kind's mark.
 */
export function Avatar({ a, size = 32, badge = true }: { a: AccountInfo; size?: number; badge?: boolean }) {
  const [broken, setBroken] = useState(false);
  const pic = (a.self ?? a.seenAs)?.avatar;
  if (!pic || broken) return <KindMark kind={a.kind} interfaces={a.interfaces} size={size} />;
  const m = markOf(a.kind, a.interfaces);
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <img src={pic} alt="" referrerpolicy="no-referrer" onError={() => setBroken(true)} />
      {badge && size >= 28 && (
        <span class="avatar-badge">
          <Icon brand={m.brand} glyph={m.glyph} size={Math.max(10, Math.round(size * 0.3))} />
        </span>
      )}
    </span>
  );
}

export type Tone = 'good' | 'warn' | 'danger' | 'off';
/** What the account needs from you, from its status's attention. */
export function attentionOf(a: AccountInfo): { message: string; liveView: boolean } | null {
  const at = a.status?.attention as { message?: string; kind?: string; liveView?: boolean } | undefined;
  if (!at) return null;
  return { message: at.message ?? at.kind ?? 'It needs you', liveView: !!at.liveView };
}
/** Its state in a word and a colour: disabled, not running, needs you, connecting… online. */
export function condition(a: AccountInfo): { tone: Tone; text: string } {
  if (!a.enabled) return { tone: 'off', text: 'Disabled' };
  if (a.error) return { tone: 'danger', text: 'Not running' };
  if (attentionOf(a)) return { tone: 'warn', text: 'Needs you' };
  // Its extractor is connected; what it says of the service itself (still connecting, unreachable, failing) comes next.
  const said = a.status?.status;
  if (a.online && said === 'connecting') return { tone: 'warn', text: 'Connecting' };
  if (a.online && said === 'offline') return { tone: 'warn', text: 'Service unreachable' };
  if (a.online && said === 'error') return { tone: 'danger', text: 'Failing' };
  if (a.online) return { tone: 'good', text: 'Online' };
  if (a.running) return { tone: 'warn', text: 'Starting' };
  return { tone: 'off', text: 'Stopped' };
}

export function Dot({ tone, title }: { tone: 'good' | 'warn' | 'danger' | 'off'; title?: string }) {
  return <span class={`dot ${tone}`} title={title} aria-hidden="true" />;
}

/** Accounts an interface (or, for "accounts", a kind list) can name. */
export function candidates(iface: string, kinds: string[] | null): AccountInfo[] {
  const s = state.value;
  if (!s) return [];
  const implementing = new Set(s.kinds.filter((k) => iface === 'accounts' || k.interfaces.includes(iface)).map((k) => k.kind));
  // The manager's own accounts are not an app's to manage.
  return s.accounts.filter((a) => implementing.has(a.kind) && (!kinds || kinds.includes(a.kind)) && !(iface === 'accounts' && a.builtin));
}

export function accountLabel(id: string): string {
  const a = accountName.value.get(id);
  return a ? `${named(a)} (${kindName.value.get(a.kind) ?? a.kind})` : id;
}

export function AccountsSummary({ accounts, kinds }: { accounts: '*' | string[]; kinds: string[] | null }) {
  const of = kinds?.length ? ` of kind ${kinds.map((k) => kindName.value.get(k) ?? k).join(', ')}` : '';
  if (accounts === '*') return <span>All accounts{of}</span>;
  if (!accounts.length) return <span class="muted">No accounts</span>;
  return <span>{accounts.map(accountLabel).join(', ')}</span>;
}

/** "All accounts" or some of them. */
export function AccountPicker(props: { iface: string; kinds: string[] | null; all: boolean; picked: string[]; onChange: (all: boolean, picked: string[]) => void }) {
  const list = candidates(props.iface, props.kinds);
  return (
    <div class="picker">
      <label class="check">
        <input type="checkbox" checked={props.all} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked, props.picked)} />
        <span>All accounts{props.kinds?.length ? ` of kind ${props.kinds.join(', ')}` : ''}, now and later</span>
      </label>
      {!props.all &&
        (list.length ? (
          list.map((a) => (
            <label class="check indent" key={a.id}>
              <input
                type="checkbox"
                checked={props.picked.includes(a.id)}
                onChange={(e) => props.onChange(false, (e.target as HTMLInputElement).checked ? [...props.picked, a.id] : props.picked.filter((x) => x !== a.id))}
              />
              <span>
                {named(a)} <span class="muted">{kindName.value.get(a.kind) ?? a.kind}</span>
              </span>
            </label>
          ))
        ) : (
          <p class="muted indent">No accounts offer this yet.</p>
        ))}
    </div>
  );
}

export function Card({ children, class: cls = '', ...rest }: { children: ComponentChildren; class?: string; [k: string]: unknown }) {
  return (
    <section class={`card ${cls}`} {...rest}>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class="empty">{children}</div>;
}

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const c = confirming.value;
  const yes = useRef<HTMLButtonElement>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!c) return;
    setChecked(false);
    yes.current?.focus();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && done(false);
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [c]);
  if (!c) return null;
  const done = (ok: boolean) => {
    confirming.value = null;
    c.resolve(ok, checked);
  };
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && done(false)}>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{c.title}</h2>
        <p>{c.body}</p>
        {c.check && (
          <label class="check confirm-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked((e.target as HTMLInputElement).checked)} data-confirm-check />
            <span>{c.check}</span>
          </label>
        )}
        <div class="row end">
          <button class="btn ghost" onClick={() => done(false)}>
            Cancel
          </button>
          <button ref={yes} class={`btn ${c.danger ? 'danger' : 'primary'}`} data-confirm onClick={() => done(true)}>
            {c.yes}
          </button>
        </div>
      </div>
    </div>
  );
}
