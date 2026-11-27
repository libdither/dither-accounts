/**
 * Signing in with another account here, a browser kind's side (docs/signin-relay.md). Two roles:
 *
 * - **Asking** (a kind whose manifest has `signIn`, Luma): its site's "Continue with Google" sends a tab to Google's
 *   authorize page; the extension (page/signin-worker.js) sends that tab to a chooser page instead and tells the
 *   extractor. `SignInAsker` asks the manager which accounts could answer (`signin.choices`), shows them, and on a pick
 *   asks the manager to have that account answer (`signin.relay`). The answer, the site's own redirect address with the
 *   provider's one-time code, is loaded in the tab, and the site finishes its own sign-in with its own cookies.
 *   `start()` (the manager's `signin.start`) sets one off without you: it clicks the site's own "Continue with Google"
 *   (after its "Sign in", where that is the way to it) with real input, and a linked account answers the rest.
 * - **Answering** (a kind whose manifest has `signsIn`, Google): the manager sends `signin.authorize`;
 *   `SignInAnswerer` checks the link and has the extension open it in a tab of its own, which the provider's session
 *   there answers, stopped before it loads the redirect address. That address comes back. The provider may ask to
 *   pick an account and to allow the site: with `auto` (a link you set up, for a site that asks only who you are) the
 *   answerer presses those itself, with real input on its screen (screen.ts); otherwise, and for anything else the provider asks
 *   (a password, a code, a check), you answer in the live view.
 *
 * A kind takes part with its worker's `include signin-worker` comment, a line in its worker's command routing
 * (`if (signinRelay.command(msg)) return;`), `signinRelay.start(sendUp, cfg.signIn)` once its config is read, its tab
 * reports leaving out `signinRelay.owns(id)`, and one of these classes on its bridge. The sandbox adds the chooser
 * page and the permissions it needs to the extension's copy (addSignInPage).
 *
 * Never logged: the link (its state, client and scopes ride in it) or the code.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAnswer, onlyIdentity, readAuthorize, SIGN_IN_PROVIDERS } from '@dither-accounts/spec/signin';
import type { Log } from './sandbox.ts';
import type { ScreenInput } from './screen.ts';

const PAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'page');
const INCLUDE = '/*@include signin-worker@*/';
/** The chooser's files, beside the worker in the copy. */
export const SIGN_IN_PAGE = ['signin.html', 'signin-page.js'];

/**
 * An extension copy whose worker has the `include signin-worker` comment gets the chooser page, and the permissions
 * the worker uses: webNavigation (a sign-in seen before it loads) and declarativeNetRequest (an answering tab stopped
 * before the redirect: a block rule, which needs no host permission).
 */
export function addSignInPage(dir: string): boolean {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return false;
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const worker = m.background?.service_worker;
  if (typeof worker !== 'string' || !existsSync(join(dir, worker)) || !readFileSync(join(dir, worker), 'utf8').includes(INCLUDE)) return false;
  for (const f of SIGN_IN_PAGE) copyFileSync(join(PAGE_DIR, f), join(dir, f));
  const perms = new Set<string>(m.permissions ?? []);
  // scripting: an answering tab's provider page read (signin.look), where its manifest lets it reach the provider.
  for (const p of ['tabs', 'webNavigation', 'declarativeNetRequest', 'scripting']) perms.add(p);
  m.permissions = [...perms];
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  return true;
}

/** What an asking kind's extension looks for (its config.json's `signIn`): each provider's authorize pages. */
export function signInConfig(testOrigins: Record<string, string> = {}) {
  return {
    consume: Object.values(SIGN_IN_PROVIDERS).map((p) => ({
      id: p.id,
      name: p.name,
      origins: [...p.hosts.map((h) => `https://${h}`), ...(testOrigins[p.id] ? [testOrigins[p.id]!] : [])],
      paths: p.paths,
    })),
  };
}

/** What the extension's worker is: the bridge's requests. */
interface Bridge {
  // biome-ignore lint: each kind's bridge has its own command type; these are the worker's own `signin.*` ones.
  request<T = unknown>(cmd: any, timeoutMs?: number, opts?: { diagnose?: boolean }): Promise<T>;
}

type Choices = { provider: string; name: string; site: string; asks: string[]; choices: { id: string; label: string; who: string | null; online: boolean }[]; remembered: string | null };
type Up = { t: string; rid?: unknown; provider?: unknown; url?: unknown; account?: unknown; remember?: unknown; why?: unknown; state?: unknown };

/** How long a relay may take (the manager's RELAY_MS, and a little). */
const RELAY_MS = 5 * 60_000 + 15_000;

/** How a sign-in went, for start(): `ok` once the provider's answer went to the site's tab. */
export type SignInOutcome = { ok: boolean; note: string };
/** What signin-worker.js seekPage found on the site's page. */
type Seek = { step: 'provider' | 'login' | 'none' | 'loading' | 'hidden'; x?: number; y?: number; why?: string };

/** How long start() looks for the site's button, and how many of each it presses. */
const SEEK_MS = 60_000;
const SEEK_EVERY_MS = 1_500;
const MAX_PROVIDER_PRESSES = 2;
const MAX_LOGIN_PRESSES = 3;

/** The asking side: the bridge's `signin*` frames go to onMessage. */
export class SignInAsker {
  private relays = new Map<string, { provider: string; url: string; view: Choices | null; since: number }>();
  /** start()'s ear for how each sign-in ended. */
  private listeners = new Set<(rid: string, o: SignInOutcome) => void>();
  private starting = false;

  constructor(
    private o: {
      bridge: Bridge;
      /** The link's ask to the manager. */
      ask: (what: string, input: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
      /** The account's screen, for start()'s real clicks (screen.ts); null when there is none. */
      screen?: () => ScreenInput | null;
      log: Log;
      onChange?: () => void;
    },
  ) {}

  private settle(rid: string, ok: boolean, note: string) {
    for (const f of this.listeners) f(rid, { ok, note });
  }

  /**
   * Start a sign-in with `provider` on the site, as you would: find the site's "Continue with Google" in its tab in
   * front (or its "Sign in" first, the way to one) and click it, with real input on the account's screen. What that
   * sets off is an ordinary sign-in (the chooser, or the account linked for it, which then goes ahead by itself). It
   * answers how it ended: signed in (the provider's answer went to the tab), or why not. The manager sends it
   * (`signin.start`) when you add an account with a Google account to sign in with, or ask for it (docs/signin-relay.md).
   */
  async start(provider: string, ms = SEEK_MS): Promise<SignInOutcome> {
    const p = SIGN_IN_PROVIDERS[provider];
    if (!p) throw new Error(`no sign-in provider "${provider}"`);
    const screen = this.o.screen?.();
    if (!screen) throw new Error('no display to click on yet');
    if (this.starting) throw new Error('a sign-in is already being started here');
    if (this.relays.size) return { ok: false, note: 'a sign-in is already under way here (its chooser is in the live view)' };
    this.starting = true;
    const ended = new Map<string, SignInOutcome>();
    const ear = (rid: string, o: SignInOutcome) => ended.set(rid, o);
    this.listeners.add(ear);
    try {
      const end = Date.now() + ms;
      let pressed = 0;
      let logins = 0;
      let seen = '';
      const begun = () => this.relays.size > 0 || ended.size > 0;
      while (Date.now() < end && !begun()) {
        let s: Seek;
        try {
          s = await this.o.bridge.request<Seek>({ kind: 'signin.seek', names: [p.name] }, 10_000, { diagnose: false });
        } catch (e) {
          s = { step: 'none', why: String((e as Error)?.message ?? e).slice(0, 120) };
        }
        if (begun()) break;
        const what = `${s.step}${s.why ? ` (${s.why})` : ''}`;
        if (what !== seen) this.o.log('debug', `starting a ${p.name} sign-in: the site's page shows ${(seen = what)}`);
        const at = Number.isFinite(s.x) && Number.isFinite(s.y);
        if (s.step === 'provider' && at && pressed < MAX_PROVIDER_PRESSES) {
          await screen.click(Math.round(s.x!), Math.round(s.y!));
          pressed++;
          this.o.log('info', `starting a ${p.name} sign-in: pressed the site's ${p.name} button`);
          const until = Date.now() + 10_000;
          while (Date.now() < until && !begun()) await Bun.sleep(200);
          continue;
        }
        if (s.step === 'login' && at && logins < MAX_LOGIN_PRESSES && pressed === 0) {
          await screen.click(Math.round(s.x!), Math.round(s.y!));
          logins++;
          this.o.log('info', `starting a ${p.name} sign-in: pressed the site's own Sign in`);
          await Bun.sleep(2_500);
          continue;
        }
        await Bun.sleep(SEEK_EVERY_MS);
      }
      if (!begun()) {
        const note = `no ${p.name} sign-in started on the site's page (${seen || 'nothing read'}); it may already be signed in, or its button is one this does not know: use the live view`;
        this.o.log('info', note);
        return { ok: false, note };
      }
      // The sign-in it set off: wait for how it ends (a chooser waiting on you counts as an end).
      const until = Date.now() + RELAY_MS;
      while (Date.now() < until && !ended.size) await Bun.sleep(200);
      const o = [...ended.values()][0] ?? { ok: false, note: `the ${p.name} sign-in did not end in ${Math.round(RELAY_MS / 60_000)} minutes` };
      this.o.log('info', `starting a ${p.name} sign-in: ${o.ok ? 'signed in' : o.note}`);
      return o;
    } finally {
      this.listeners.delete(ear);
      this.starting = false;
    }
  }

  /** A sign-in in progress, for the account's status: since when. */
  get pending(): number | null {
    let first: number | null = null;
    for (const r of this.relays.values()) first = first === null ? r.since : Math.min(first, r.since);
    return first;
  }

  /** A frame from the extension: true when it was one of ours. */
  onMessage(msg: Up): boolean {
    if (msg.t !== 'signin' && msg.t !== 'signin.pick' && msg.t !== 'signin.closed' && msg.t !== 'signin.shown') return false;
    const rid = typeof msg.rid === 'string' ? msg.rid.slice(0, 80) : null;
    if (!rid) return true;
    if (msg.t === 'signin') void this.begin(rid, String(msg.provider ?? ''), String(msg.url ?? ''));
    else if (msg.t === 'signin.pick') void this.pick(rid, String(msg.account ?? ''), msg.remember === true);
    else if (msg.t === 'signin.shown') this.o.log('info', `sign-in ${rid}: the chooser shows ${msg.state === 'choose' ? 'the accounts' : String(msg.state ?? '').slice(0, 20)}`);
    else {
      const why = msg.why === 'here' ? 'let through, to sign in in this browser' : msg.why === 'cancelled' ? 'cancelled' : 'its tab closed';
      if (this.relays.delete(rid)) {
        this.o.log('info', `sign-in ${rid}: ${why}`);
        this.settle(rid, false, `the sign-in was ${why}`);
      }
      this.o.onChange?.();
    }
    return true;
  }

  private async show(rid: string, kind: 'signin.show' | 'signin.failed', view: Record<string, unknown>, error?: string) {
    try {
      await this.o.bridge.request({ kind, rid, view, ...(error ? { error } : {}) }, 10_000, { diagnose: false });
    } catch {}
  }

  private async begin(rid: string, provider: string, url: string) {
    this.relays.set(rid, { provider, url, view: null, since: Date.now() });
    this.o.onChange?.();
    let c: Choices;
    try {
      c = (await this.o.ask('signin.choices', { url })) as Choices;
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 300);
      this.o.log('info', `sign-in ${rid} (${provider}): not relayed: ${why}`);
      this.settle(rid, false, why);
      return this.show(rid, 'signin.failed', { site: null }, why);
    }
    const r = this.relays.get(rid);
    if (!r) return;
    r.view = c;
    this.o.log('info', `sign-in ${rid}: ${c.name} for ${c.site}, ${c.choices.length} account(s) could answer${c.remembered ? ', one remembered' : ''}`);
    const view = { state: 'choose', site: c.site, asks: c.asks, choices: c.choices };
    const remembered = c.remembered ? c.choices.find((x) => x.id === c.remembered && x.online) : undefined;
    if (remembered) {
      await this.show(rid, 'signin.show', { ...view, state: 'waiting', account: remembered.id, linked: true });
      return this.pick(rid, remembered.id, true);
    }
    await this.show(rid, 'signin.show', view);
    this.settle(rid, false, `no ${c.name} account is linked for ${c.site} (or it is not online): the chooser waits for a pick in the live view`);
  }

  private async pick(rid: string, account: string, remember: boolean) {
    const r = this.relays.get(rid);
    if (!r?.view) return;
    const view = { site: r.view.site, asks: r.view.asks, choices: r.view.choices };
    await this.show(rid, 'signin.show', { ...view, state: 'waiting', account, linked: remember });
    let answer: { url?: unknown };
    try {
      answer = (await this.o.ask('signin.relay', { url: r.url, account, remember }, RELAY_MS)) as { url?: unknown };
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 300);
      this.o.log('warn', `sign-in ${rid}: the relay failed: ${why}`);
      this.settle(rid, false, why);
      if (this.relays.has(rid)) await this.show(rid, 'signin.failed', view, why);
      return;
    }
    if (!this.relays.has(rid)) {
      this.settle(rid, false, 'answered after its tab went');
      return void this.o.log('info', `sign-in ${rid}: answered after its tab went; dropped`);
    }
    this.relays.delete(rid);
    this.o.onChange?.();
    try {
      await this.o.bridge.request({ kind: 'signin.done', rid, url: answer.url }, 15_000, { diagnose: false });
      this.o.log('info', `sign-in ${rid}: the answer went to the tab`);
      this.settle(rid, true, 'the answer went to the site, which finishes its own sign-in');
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 200);
      this.o.log('warn', `sign-in ${rid}: the answer could not go to the tab: ${why}`);
      this.settle(rid, false, `the answer could not go to the tab: ${why}`);
    }
  }
}

/** A provider screen, as signin-worker.js providerPage reads it. */
type Look = { step: 'choose' | 'consent' | 'other' | 'loading' | 'hidden' | 'gone'; x?: number; y?: number; why?: string };

/** How often a linked sign-in's provider tab is looked at, and how many presses it may take in all. */
const LOOK_MS = 1_200;
const MAX_PRESSES = 6;

/** The answering side: the manager's `signin.authorize` goes to authorize(). */
export class SignInAnswerer {
  /** The sign-in being answered: for the account's status (the provider may be asking you in the live view). */
  current: { site: string; since: number; auto: boolean; yours: number | null } | null = null;

  constructor(
    private o: {
      bridge: Bridge;
      /** The provider this kind answers for: `google`. */
      provider: string;
      /** Tests: the origin standing for the provider. */
      testOrigin?: string | null;
      /** The account's screen, for real input (auto: screen.ts, X or Wayland); null when there is none. */
      screen?: () => ScreenInput | null;
      /** Who this account is signed in as (its email): the one its chooser picks. */
      who?: () => string | null;
      log: Log;
      onChange?: () => void;
    },
  ) {}

  async authorize(cmd: { url?: unknown; redirect?: unknown; ms?: unknown; auto?: unknown; who?: unknown }): Promise<{ url: string }> {
    if (this.current) throw new Error('another sign-in is being answered here; try again in a moment');
    const url = typeof cmd.url === 'string' ? cmd.url : '';
    const testOrigins = this.o.testOrigin ? { [this.o.provider]: this.o.testOrigin } : {};
    const r = readAuthorize(url, { testOrigins, allowLoopback: !!this.o.testOrigin });
    if ('error' in r) throw new Error(`not answered: ${r.error}`);
    if (r.provider !== this.o.provider) throw new Error(`this account signs in with ${this.o.provider}, not ${r.provider}`);
    if (cmd.redirect !== r.redirect) throw new Error('the redirect is not the one the link names');
    const ms = Math.max(10_000, Math.min(Number(cmd.ms) || 120_000, 10 * 60_000));
    // The manager's word, checked again here: only a site that asks for who you are.
    // Who this account is: as the manager last saw it, else as its own page says now.
    const me = (typeof cmd.who === 'string' && cmd.who.trim() ? cmd.who.trim().slice(0, 200) : null) ?? this.o.who?.() ?? null;
    const auto = cmd.auto === true && onlyIdentity(r.provider, r.scopes) && !!this.o.screen?.() && !!me;
    const aid = crypto.randomUUID();
    this.current = { site: r.site, since: Date.now(), auto, yours: auto ? null : Date.now() };
    this.o.onChange?.();
    const nudge = setTimeout(() => this.o.onChange?.(), 3_100);
    this.o.log('info', `answering a sign-in to ${r.site}${auto ? ", going through the provider's screens (a linked account)" : ''}`);
    let done = false;
    const asked = this.o.bridge.request<{ url?: unknown }>({ kind: 'signin.authorize', url, redirect: r.redirect, ms, aid }, ms + 5_000, { diagnose: false });
    const driving = auto && me ? this.drive(aid, me, r.site, () => done) : null;
    try {
      const res = await asked;
      if (typeof res?.url !== 'string' || !isAnswer(res.url, r.redirect)) throw new Error('the browser did not come back to the sign-in address');
      this.o.log('info', `the sign-in to ${r.site} was answered`);
      return { url: res.url };
    } catch (e) {
      this.o.log('warn', `the sign-in to ${r.site} was not answered: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      throw e;
    } finally {
      done = true;
      await driving;
      clearTimeout(nudge);
      this.current = null;
      this.o.onChange?.();
    }
  }

  /**
   * A linked sign-in: look at the provider's tab and press what it asks of a person who already said yes (this
   * account in its chooser, its Continue), with real input. A screen it does not know is yours (the status says so);
   * it keeps looking, so a Continue after you answer a password is still pressed. At most MAX_PRESSES in all.
   */
  private async drive(aid: string, me: string, site: string, over: () => boolean) {
    let presses = 0;
    let shown = '';
    let last = '';
    let same = 0;
    while (!over()) {
      await Bun.sleep(LOOK_MS);
      if (over()) return;
      let l: Look;
      try {
        l = await this.o.bridge.request<Look>({ kind: 'signin.look', aid, who: me }, 10_000, { diagnose: false });
      } catch (e) {
        l = { step: 'other', why: String((e as Error)?.message ?? e).slice(0, 120) };
      }
      if (over() || !this.current) return;
      const seen = `${l.step}${l.why ? ` (${l.why})` : ''}`;
      if (seen !== shown) this.o.log('debug', `sign-in to ${site}: the provider's tab shows ${(shown = seen)}`);
      if (l.step === 'gone') return;
      if (l.step === 'loading') continue;
      const press = (l.step === 'choose' || l.step === 'consent') && Number.isFinite(l.x) && Number.isFinite(l.y);
      if (!press) {
        // Not one it presses: yours, after a moment (a screen between two of its own steps is not).
        if (this.current.yours === null) {
          this.current.yours = Date.now();
          setTimeout(() => this.o.onChange?.(), 3_100);
        }
        same = 0;
        last = '';
        continue;
      }
      const key = `${l.step}@${l.x},${l.y}`;
      same = key === last ? same + 1 : 0;
      last = key;
      // The same screen twice after a press: the press did nothing yet; give it once more, then leave it to you.
      if (same === 1) continue;
      if (presses >= MAX_PRESSES || same > 2) {
        if (this.current.yours === null) {
          this.o.log('info', `the provider's screens for ${site} did not move on after ${presses} press(es); left to you in the live view`);
          this.current.yours = Date.now();
          this.o.onChange?.();
        }
        continue;
      }
      if (this.current.yours !== null) {
        this.current.yours = null;
        this.o.onChange?.();
      }
      try {
        await this.click(l.x!, l.y!);
        presses++;
        this.o.log('info', `sign-in to ${site}: pressed ${l.step === 'choose' ? 'this account in the chooser' : 'Continue'}`);
      } catch (e) {
        this.o.log('warn', `sign-in to ${site}: could not press: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        this.current.yours ??= Date.now();
      }
    }
  }

  /** A real click on the account's screen (as the browser interface's): the pointer moves there and clicks. */
  private click(x: number, y: number): Promise<void> {
    const s = this.o.screen?.();
    if (!s) return Promise.reject(new Error('no display'));
    return s.click(Math.round(x), Math.round(y));
  }

  /** What the account needs from you while a sign-in waits on you (the provider's page in the live view). */
  attention(now = Date.now()): { kind: 'verify'; message: string; liveView: true } | null {
    if (!this.current || this.current.yours === null || now - this.current.yours < 3_000) return null;
    const name = SIGN_IN_PROVIDERS[this.o.provider]?.name ?? this.o.provider;
    const message = this.current.auto
      ? `${name} is asking something only you can answer in a sign-in to ${this.current.site}: answer it in the live view`
      : `${name} may be asking you to allow a sign-in to ${this.current.site}: answer it in the live view`;
    return { kind: 'verify', message, liveView: true };
  }
}
