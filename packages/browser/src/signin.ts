/**
 * Signing in with another account here, a browser kind's side (docs/signin-relay.md). Two roles:
 *
 * - **Asking** (a kind whose manifest has `signIn`, Luma): its site's "Continue with Google" sends a tab to Google's
 *   authorize page; the extension (page/signin-worker.js) sends that tab to a chooser page instead and tells the
 *   extractor. `SignInAsker` asks the manager which accounts could answer (`signin.choices`), shows them, and on a pick
 *   asks the manager to have that account answer (`signin.relay`). The answer, the site's own redirect address with the
 *   provider's one-time code, is loaded in the tab, and the site finishes its own sign-in with its own cookies.
 * - **Answering** (a kind whose manifest has `signsIn`, Google): the manager sends `signin.authorize`;
 *   `SignInAnswerer` checks the link and has the extension open it in a tab of its own, which the provider's session
 *   there answers (you pick an account and allow it in the live view when the provider asks), stopped before it loads
 *   the redirect address. That address comes back.
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
import { isAnswer, readAuthorize, SIGN_IN_PROVIDERS } from '@dither-accounts/spec/signin';
import type { Log } from './sandbox.ts';

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
  for (const p of ['tabs', 'webNavigation', 'declarativeNetRequest']) perms.add(p);
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

/** The asking side: the bridge's `signin*` frames go to onMessage. */
export class SignInAsker {
  private relays = new Map<string, { provider: string; url: string; view: Choices | null; since: number }>();

  constructor(
    private o: {
      bridge: Bridge;
      /** The link's ask to the manager. */
      ask: (what: string, input: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
      log: Log;
      onChange?: () => void;
    },
  ) {}

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
      if (this.relays.delete(rid)) this.o.log('info', `sign-in ${rid}: ${msg.why === 'here' ? 'let through, to sign in in this browser' : msg.why === 'cancelled' ? 'cancelled' : 'its tab closed'}`);
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
      return this.show(rid, 'signin.failed', { site: null }, why);
    }
    const r = this.relays.get(rid);
    if (!r) return;
    r.view = c;
    this.o.log('info', `sign-in ${rid}: ${c.name} for ${c.site}, ${c.choices.length} account(s) could answer${c.remembered ? ', one remembered' : ''}`);
    const view = { state: 'choose', site: c.site, asks: c.asks, choices: c.choices };
    const remembered = c.remembered ? c.choices.find((x) => x.id === c.remembered && x.online) : undefined;
    if (remembered) {
      await this.show(rid, 'signin.show', { ...view, state: 'waiting', account: remembered.id });
      return this.pick(rid, remembered.id, true);
    }
    await this.show(rid, 'signin.show', view);
  }

  private async pick(rid: string, account: string, remember: boolean) {
    const r = this.relays.get(rid);
    if (!r?.view) return;
    const view = { site: r.view.site, asks: r.view.asks, choices: r.view.choices };
    await this.show(rid, 'signin.show', { ...view, state: 'waiting', account });
    let answer: { url?: unknown };
    try {
      answer = (await this.o.ask('signin.relay', { url: r.url, account, remember }, RELAY_MS)) as { url?: unknown };
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 300);
      this.o.log('warn', `sign-in ${rid}: the relay failed: ${why}`);
      if (this.relays.has(rid)) await this.show(rid, 'signin.failed', view, why);
      return;
    }
    if (!this.relays.has(rid)) return void this.o.log('info', `sign-in ${rid}: answered after its tab went; dropped`);
    this.relays.delete(rid);
    this.o.onChange?.();
    try {
      await this.o.bridge.request({ kind: 'signin.done', rid, url: answer.url }, 15_000, { diagnose: false });
      this.o.log('info', `sign-in ${rid}: the answer went to the tab`);
    } catch (e) {
      this.o.log('warn', `sign-in ${rid}: the answer could not go to the tab: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
}

/** The answering side: the manager's `signin.authorize` goes to authorize(). */
export class SignInAnswerer {
  /** The sign-in being answered: for the account's status (Google may be asking you in the live view). */
  current: { site: string; since: number } | null = null;

  constructor(
    private o: {
      bridge: Bridge;
      /** The provider this kind answers for: `google`. */
      provider: string;
      /** Tests: the origin standing for the provider. */
      testOrigin?: string | null;
      log: Log;
      onChange?: () => void;
    },
  ) {}

  async authorize(cmd: { url?: unknown; redirect?: unknown; ms?: unknown }): Promise<{ url: string }> {
    if (this.current) throw new Error('another sign-in is being answered here; try again in a moment');
    const url = typeof cmd.url === 'string' ? cmd.url : '';
    const testOrigins = this.o.testOrigin ? { [this.o.provider]: this.o.testOrigin } : {};
    const r = readAuthorize(url, { testOrigins, allowLoopback: !!this.o.testOrigin });
    if ('error' in r) throw new Error(`not answered: ${r.error}`);
    if (r.provider !== this.o.provider) throw new Error(`this account signs in with ${this.o.provider}, not ${r.provider}`);
    if (cmd.redirect !== r.redirect) throw new Error('the redirect is not the one the link names');
    const ms = Math.max(10_000, Math.min(Number(cmd.ms) || 120_000, 10 * 60_000));
    this.current = { site: r.site, since: Date.now() };
    this.o.onChange?.();
    const nudge = setTimeout(() => this.o.onChange?.(), 3_100);
    this.o.log('info', `answering a sign-in to ${r.site}`);
    try {
      const res = await this.o.bridge.request<{ url?: unknown }>({ kind: 'signin.authorize', url, redirect: r.redirect, ms }, ms + 5_000, { diagnose: false });
      if (typeof res?.url !== 'string' || !isAnswer(res.url, r.redirect)) throw new Error('the browser did not come back to the sign-in address');
      this.o.log('info', `the sign-in to ${r.site} was answered`);
      return { url: res.url };
    } catch (e) {
      this.o.log('warn', `the sign-in to ${r.site} was not answered: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      throw e;
    } finally {
      clearTimeout(nudge);
      this.current = null;
      this.o.onChange?.();
    }
  }

  /** While it waits a while: what the account needs from you (the provider's page in the live view). */
  attention(now = Date.now()): { kind: 'verify'; message: string; liveView: true } | null {
    if (!this.current || now - this.current.since < 3_000) return null;
    const name = SIGN_IN_PROVIDERS[this.o.provider]?.name ?? this.o.provider;
    return { kind: 'verify', message: `${name} may be asking you to allow a sign-in to ${this.current.site}: answer it in the live view`, liveView: true };
  }
}
