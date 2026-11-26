/**
 * Which screen the sandboxes draw on (docs/browser.md "Display backends"): the manager's default, on the home page
 * (Screens), and an account's own, in its pane, for a kind with a screen. A backend built from a fork this project keeps
 * says so ("Experimental fork", and where it comes from). Changing either restarts the sandboxes it moves.
 */
import type { AccountInfo, BackendView, DisplayState } from '../../../src/api-types.ts';
import { act, confirm, named, state } from '../state.ts';
import { Icon } from './icons.tsx';

const viewOf = (d: DisplayState, name: string) => d.backends.find((b) => b.name === name);
const title = (b: BackendView | undefined, name: string) => (b ? `${b.label} · ${b.name}` : name);

/** "Experimental fork", with where it comes from on hover and below. */
export function ForkBadge({ b }: { b: BackendView | undefined }) {
  if (!b?.experimental) return null;
  return (
    <span class="pill fork" title={b.note ?? undefined} data-experimental={b.name}>
      Experimental fork
    </span>
  );
}

function Choice({ d, name }: { d: DisplayState; name: string }) {
  const b = viewOf(d, name);
  return (
    <>
      <div class="row nowrap small">
        <span>
          Now: <strong>{title(b, name)}</strong>
        </span>
        <ForkBadge b={b} />
      </div>
      {b?.experimental && b.note && (
        <p class="muted small" data-fork-note>
          {b.note}.
        </p>
      )}
    </>
  );
}

/**
 * A picker's change: done, or (declined, refused) the select put back on what it shows. A controlled <select> is not
 * redrawn when its value prop has not changed, so the browser would go on showing the choice that was declined.
 */
const picked = (pick: (v: string) => Promise<boolean>, shown: () => string) => (e: Event) => {
  const el = e.currentTarget as HTMLSelectElement;
  void pick(el.value).then((ok) => {
    if (!ok) el.value = shown();
  });
};

const option = (b: BackendView) => `${title(b, b.name)}${b.experimental ? ' · experimental fork' : ''}`;

/** The manager's default, for every account of a kind with a screen that names none of its own. */
export function Screens() {
  const s = state.value!;
  const d = s.display;
  const following = s.accounts.filter((a) => a.display && a.display.own === null);
  const running = following.filter((a) => a.running);
  const pick = async (v: string) => {
    const next = v === '' ? d.config : v;
    if (next === d.default && (v === '') === (d.chosen === null)) return false;
    const b = viewOf(d, next);
    const who = running.length ? `${running.length === 1 ? `${named(running[0]!)} restarts` : `${running.length} accounts restart`} on it: ${running.map(named).join(', ')}.` : 'No running account follows the default, so nothing restarts now.';
    if (next !== d.default && !(await confirm(`Draw sandboxes on ${title(b, next)}?`, `${b?.experimental ? `${b.note}. ` : ''}Accounts that follow the default use it from their next start. ${who}`, 'Change and restart', false))) return false;
    return !!(await act('/api/display', { method: 'PUT', body: { default: v === '' ? null : v } }, v === '' ? `The default is config.toml's again (${next})` : `The default is ${next}`));
  };
  return (
    <section class="ov-cat" data-screens>
      <div class="ov-cat-head">
        <Icon glyph="desktop" size={18} />
        <h2>Screens</h2>
        <span class="faint small">
          {following.length} of {s.accounts.filter((a) => a.display).length} follow the default
        </span>
      </div>
      <div class="screens-card">
        <label class="row nowrap small screen-pick">
          <span>Sandboxes draw on</span>
          <select value={d.chosen ?? ''} onChange={picked(pick, () => state.value!.display.chosen ?? '')} data-default-backend>
            <option value="">config.toml's: {title(viewOf(d, d.config), d.config)}</option>
            {d.backends.map((b) => (
              <option key={b.name} value={b.name}>
                {option(b)}
              </option>
            ))}
          </select>
        </label>
        <Choice d={d} name={d.default} />
        <p class="muted small">
          {d.chosen ? 'Chosen here: it wins over config.toml’s display_backend until you pick config.toml’s again.' : 'From config.toml’s display_backend (x11 when it names none).'} An account can have its own in its pane. Changing it restarts the running accounts that follow it.
        </p>
      </div>
    </section>
  );
}

/** An account's own backend, or the manager's default. */
export function AccountScreen({ a, reload }: { a: AccountInfo; reload: () => void }) {
  const d = state.value!.display;
  const own = a.display!.own;
  const pick = async (v: string) => {
    if ((v || null) === own) return false;
    const next = v || d.default;
    const b = viewOf(d, next);
    if (
      a.running &&
      next !== a.display!.uses &&
      !(await confirm(`Move ${named(a)} to ${title(b, next)}?`, `${b?.experimental ? `${b.note}. ` : ''}Its sandbox restarts on the new screen; the site stays signed in.`, 'Change and restart', false))
    )
      return false;
    if (!(await act(`/api/accounts/${a.id}`, { method: 'PATCH', body: { settings: { displayBackend: v || null } } }, `${named(a)}: ${v ? next : `the manager's default (${next})`}${a.running && next !== a.display!.uses ? ', restarting it' : ''}`))) return false;
    reload();
    return true;
  };
  return (
    <section class="pane-section" data-screen>
      <h4>Screen</h4>
      <label class="row nowrap small screen-pick">
        <span>Draws on</span>
        <select value={own ?? ''} onChange={picked(pick, () => own ?? '')} data-account-backend>
          <option value="">The manager’s default: {title(viewOf(d, d.default), d.default)}</option>
          {d.backends.map((b) => (
            <option key={b.name} value={b.name}>
              {option(b)}
            </option>
          ))}
        </select>
      </label>
      <Choice d={d} name={a.display!.uses} />
      <p class="muted small">Changing it restarts this account’s sandbox.</p>
    </section>
  );
}
