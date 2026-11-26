/**
 * Which screen the sandboxes draw on (docs/browser.md "Display backends"): the manager's default, on the home page
 * (Screens), and an account's own, in its pane, for a kind with a screen. A backend built from a fork this project keeps
 * says so ("Experimental fork", and where it comes from). Changing either restarts the sandboxes it moves. One that
 * cannot run here now is offered disabled, saying why ("building…", or what is missing); one whose fork's servers were
 * never built says that picking it builds them (the manager refuses it meanwhile: picked again once ready).
 */
import type { AccountInfo, BackendView, DisplayState } from '../../../src/api-types.ts';
import { act, api, confirm, loadState, named, state, toast } from '../state.ts';
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

const availabilityNote = (b: BackendView) =>
  b.availability === 'building' ? ' · building…' : b.availability === 'unbuilt' ? ' · built when picked' : b.availability === 'missing' ? ` · cannot run here: ${b.why}` : '';
const option = (b: BackendView) => `${title(b, b.name)}${b.experimental ? ' · experimental fork' : ''}${availabilityNote(b)}`;

/** Not disabled in the picker: ready, or a fork's servers not built yet (picking it builds them). */
const pickable = (b: BackendView) => b.availability === 'ready' || b.availability === 'unbuilt';

/**
 * A fork's backend whose servers were never built: picking it, once confirmed, starts that build. The manager refuses
 * the pick meanwhile (409), so it is never taken: picked again once the option says it is ready.
 */
async function build(b: BackendView, path: string, opts: { method: string; body: unknown }): Promise<false> {
  if (!(await confirm(`Build ${title(b, b.name)}?`, `${b.note ? `${b.note}. ` : ''}Its servers are built on this machine first, from source where no cache has them: that takes minutes. Nothing moves now; pick it again once it no longer says “built when picked”.`, 'Build it', false))) return false;
  // The manager answers 409 with what it started: said as news, not as a failure.
  await api(path, opts).then(
    () => toast(`${b.label}: picked`),
    (e: Error) => toast(e.message, /being built now/.test(e.message) ? 'ok' : 'error'),
  );
  void loadState();
  return false;
}

/** A backend as a picker's option: disabled while it is being built or cannot run, with why on hover. */
function Option({ b }: { b: BackendView }) {
  return (
    <option value={b.name} disabled={b.availability === 'building' || b.availability === 'missing'} title={b.why ?? undefined} data-availability={b.availability}>
      {option(b)}
    </option>
  );
}

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
    if (v !== '' && b && !pickable(b)) return false;
    if (v !== '' && b?.availability === 'unbuilt') return build(b, '/api/display', { method: 'PUT', body: { default: v } });
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
              <Option key={b.name} b={b} />
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
    if (v && b && !pickable(b)) return false;
    if (v && b?.availability === 'unbuilt') return build(b, `/api/accounts/${a.id}`, { method: 'PATCH', body: { settings: { displayBackend: v } } });
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
            <Option key={b.name} b={b} />
          ))}
        </select>
      </label>
      <Choice d={d} name={a.display!.uses} />
      <p class="muted small">Changing it restarts this account’s sandbox.</p>
    </section>
  );
}
