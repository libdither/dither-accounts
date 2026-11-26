/**
 * Signing in with an account you already have here (docs/signin-relay.md): the manager's side. A browser account whose
 * kind lists `signIn` (Luma) asks, through its link's `ask`, which accounts could answer a sign-in link its browser was
 * sent to, and then asks one of them to answer it. The answering account's kind lists the provider in `signsIn`
 * (Google): its own browser, already signed in there, opens the link and hands back the address the provider sent it
 * to, with the one-time code, which the asking browser then loads. Nothing else of the provider's session moves.
 *
 * Checked here, whatever the asking extractor says:
 * - the link is a provider's authorize page that answers with a code in the address (spec/signin.ts readAuthorize);
 * - its redirect_uri is on one of the asking kind's own sites (its manifest's `signIn.sites`, or the account's test
 *   origin), so a code only ever goes to the site whose browser asked;
 * - the answering account is one of a kind that `signsIn` that provider, and is enabled;
 * - the answer it gives is that redirect address, with a code (or the provider's error).
 *
 * `signin.relay` with `remember` keeps the choice in the asking account's config (`signInWith`, by provider), so the
 * next sign-in on that site goes ahead with it; a pick without it forgets it. That choice is a link you set up: while
 * it stands, and the site asks the provider for no more than who you are (spec/signin.ts onlyIdentity), the answering
 * browser goes through the provider's own screens for you (picks that account, presses Continue), with `auto`. Logs
 * name the accounts, the provider and the site: never the link, its state or the code.
 *
 * start() sets that link up by your word (the add form's "Sign in with", the CLI's `sign-in`) and has the asking
 * browser press its site's own "Continue with Google" (`signin.start`), so a new account signs itself in.
 */
import { type Authorize, isAnswer, onlyIdentity, readAuthorize, scopeWords, SIGN_IN_PROVIDERS } from '@dither-accounts/spec/signin';
import type { Row, Store } from './db.ts';
import type { Kind } from './kinds.ts';

/** How long a relay may take: Google can ask you to pick an account and to allow it, in its live view. */
export const RELAY_MS = 5 * 60_000;
/** How long start() keeps trying an account whose browser is still starting, and how often. */
export const START_WAIT_MS = 4 * 60_000;
const START_RETRY_MS = 5_000;

export interface SignInChoice {
  id: string;
  label: string;
  /** Who it is signed in as, when known (its email). */
  who: string | null;
  online: boolean;
}

export interface SignInDeps {
  store: Store;
  kinds: Map<string, Kind>;
  /** The account's last status ('online', 'attention'…), or null. */
  statusOf: (id: string) => string | null;
  /** A command to an account's extractor (Supervisor.command). */
  command: (id: string, cmd: Record<string, unknown> & { t: string }, timeoutMs: number) => Promise<unknown>;
  log?: (msg: string) => void;
}

const parse = <T>(s: unknown, d: T): T => {
  try {
    return typeof s === 'string' ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
};
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** An https address's origin, or null. */
const httpsOrigin = (v: unknown) => {
  try {
    const u = new URL(String(v ?? ''));
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
};

/** A sign-in start() began: under way, or how it ended. */
export interface SignInStart {
  provider: string;
  account: string;
  at: number;
  running: boolean;
  ok: boolean | null;
  note: string | null;
}

export class SignInRelays {
  /** Each asking account's last start(), for whoever asked for it (the CLI waits on it). */
  readonly starts = new Map<string, SignInStart>();

  constructor(private d: SignInDeps) {}

  /** start() in the background, its outcome kept in `starts`; checks first, so a wrong pick is refused at once. */
  begin(askerId: string, provider: string, account: string, waitMs = START_WAIT_MS): SignInStart {
    this.linkable(askerId, provider, account);
    const was = this.starts.get(askerId);
    if (was?.running) return was;
    const s: SignInStart = { provider, account, at: Date.now(), running: true, ok: null, note: null };
    this.starts.set(askerId, s);
    this.start(askerId, provider, account, waitMs).then(
      (o) => Object.assign(s, { running: false, ok: o.ok, note: o.note }),
      (e) => Object.assign(s, { running: false, ok: false, note: String((e as Error)?.message ?? e).slice(0, 400) }),
    );
    return s;
  }

  private log(msg: string) {
    (this.d.log ?? ((m: string) => console.log(`[signin] ${m}`)))(msg);
  }

  /** The asking account's sites: its kind's, the one its config names (siteSetting), and its test origin. */
  sitesOf(a: Row): string[] {
    const k = this.d.kinds.get(a.kind);
    const cfg = parse<Record<string, unknown>>(a.config, {});
    const test = str(cfg.testOrigin)?.replace(/\/$/, '');
    const key = k?.signIn?.siteSetting;
    const own = key ? httpsOrigin(cfg[key]) : null;
    return [...(k?.signIn?.sites ?? []), ...(own ? [own] : []), ...(test ? [test] : [])];
  }

  /** The link read and checked for the asking account, or a refusal said in a sentence. */
  check(asker: Row, url: unknown): Authorize {
    const k = this.d.kinds.get(asker.kind);
    if (!k?.signIn) throw new Error(`${asker.kind} accounts do not sign in with other accounts`);
    if (typeof url !== 'string' || url.length > 8000) throw new Error('no sign-in link');
    const cfg = parse<Record<string, unknown>>(asker.config, {});
    // Tests: the provider's stand-in origin (spec/signin.ts providerOf), only an account with a test origin of its own.
    const testOrigins = cfg.testOrigin && cfg.testSignInOrigins && typeof cfg.testSignInOrigins === 'object' ? (cfg.testSignInOrigins as Record<string, string>) : {};
    const r = readAuthorize(url, { testOrigins, allowLoopback: !!cfg.testOrigin });
    if ('error' in r) throw new Error(`Not relayed: ${r.error}`);
    if (!this.sitesOf(asker).includes(r.site)) throw new Error(`Not relayed: the sign-in is for ${r.site}, not for this account's site`);
    return r;
  }

  /** Accounts that can answer `provider`'s sign-ins. */
  answerers(provider: string): Row[] {
    return this.d.store.accounts().filter((a) => a.enabled && this.d.kinds.get(a.kind)?.signsIn?.includes(provider));
  }

  choiceOf(a: Row): SignInChoice {
    const seen = parse<Record<string, unknown> | null>(a.seen_as, null);
    return { id: a.id, label: a.label, who: str(seen?.email) ?? str(seen?.handle), online: this.d.statusOf(a.id) === 'online' };
  }

  /** `signin.choices`: who could answer the link, the one remembered for it, and what it asks for. */
  choices(askerId: string, input: Record<string, unknown>) {
    const asker = this.d.store.account(askerId);
    if (!asker) throw new Error('no such account');
    const r = this.check(asker, input.url);
    const p = SIGN_IN_PROVIDERS[r.provider]!;
    const remembered = str(parse<Record<string, any>>(asker.config, {}).signInWith?.[r.provider]);
    const choices = this.answerers(r.provider).map((a) => this.choiceOf(a));
    return { provider: p.id, name: p.name, site: r.site, asks: scopeWords(r.provider, r.scopes), choices, remembered: remembered && choices.some((c) => c.id === remembered) ? remembered : null };
  }

  /** `signin.relay`: the chosen account answers the link; its answer (the redirect address with the code) comes back. */
  async relay(askerId: string, input: Record<string, unknown>): Promise<{ url: string }> {
    const asker = this.d.store.account(askerId);
    if (!asker) throw new Error('no such account');
    const r = this.check(asker, input.url);
    const p = SIGN_IN_PROVIDERS[r.provider]!;
    const who = typeof input.account === 'string' ? this.d.store.account(input.account) : null;
    if (!who || !who.enabled || !this.d.kinds.get(who.kind)?.signsIn?.includes(r.provider)) throw new Error(`That account cannot sign in with ${p.name} here`);
    if (typeof input.remember === 'boolean') this.remember(asker, r.provider, input.remember ? who.id : null);
    // A link you set up (this account, kept for this site) answers the provider's screens for you, when the site asks
    // for nothing past who you are; anything more, or no link, is yours to answer in the live view.
    const linked = str(parse<Record<string, any>>(this.d.store.account(asker.id)?.config, {}).signInWith?.[r.provider]) === who.id;
    const auto = linked && onlyIdentity(r.provider, r.scopes);
    this.log(`${asker.id} (${asker.kind}) signs in to ${r.site} with ${who.id}'s ${p.name}${auto ? `, ${p.name}'s screens answered for you (a linked account)` : ''}`);
    let answer: unknown;
    try {
      // `who`: the account as it was last seen signed in (its email), the one its provider's chooser picks.
      const as = this.choiceOf(who).who;
      answer = await this.d.command(who.id, { t: 'signin.authorize', provider: r.provider, url: input.url as string, redirect: r.redirect, site: r.site, auto, ...(as ? { who: as } : {}), ms: RELAY_MS - 10_000 }, RELAY_MS);
    } catch (e) {
      this.log(`${asker.id}: ${who.id} did not answer the sign-in: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      throw e;
    }
    const url = (answer as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || !isAnswer(url, r.redirect)) {
      this.log(`${asker.id}: ${who.id} answered something that is not the sign-in's redirect`);
      throw new Error(`${p.name} did not send the sign-in back to ${r.site}`);
    }
    const error = new URL(url).searchParams.get('error');
    this.log(`${asker.id}: ${p.name} answered${error ? ` with an error (${error.slice(0, 40)})` : ' with a code'}; it goes to ${asker.id}'s browser`);
    return { url };
  }

  /**
   * Link `account` to answer `provider` for this asker (as a pick with Link it on does), and start a sign-in with it:
   * the asker's browser presses its site's "Continue with Google" itself (SignInAsker.start), and, the account being
   * linked, the rest goes ahead with nothing for you to press. For an account just added, whose browser is still
   * starting, it tries again until `waitMs`. Answers how it ended.
   */
  async start(askerId: string, provider: string, account: string, waitMs = START_WAIT_MS): Promise<{ ok: boolean; note: string }> {
    const who = this.linkable(askerId, provider, account);
    const asker = this.d.store.account(askerId)!;
    this.remember(asker, provider, who.id);
    const p = SIGN_IN_PROVIDERS[provider]!;
    this.log(`${asker.id} (${asker.kind}): starting a sign-in with ${who.id}'s ${p.name}`);
    const end = Date.now() + waitMs;
    let last = '';
    for (;;) {
      try {
        const r = (await this.d.command(asker.id, { t: 'signin.start', provider }, RELAY_MS + 90_000)) as { ok?: unknown; note?: unknown } | null;
        const out = { ok: r?.ok === true, note: typeof r?.note === 'string' ? r.note.slice(0, 400) : r?.ok === true ? 'signed in' : 'it did not say' };
        this.log(`${asker.id}: the sign-in it started ${out.ok ? 'went through' : `did not: ${out.note}`}`);
        return out;
      } catch (e) {
        last = String((e as Error)?.message ?? e).slice(0, 200);
        if (Date.now() + START_RETRY_MS >= end || !this.d.store.account(asker.id)?.enabled) {
          this.log(`${asker.id}: could not start a sign-in: ${last}`);
          throw new Error(`Could not start the sign-in: ${last}`);
        }
      }
      await Bun.sleep(START_RETRY_MS);
    }
  }

  /** The answering account for a link you set up by hand: one that can answer `provider`, for an asker that asks. */
  linkable(askerId: string, provider: string, account: string): Row {
    const asker = this.d.store.account(askerId);
    if (!asker) throw new Error('no such account');
    if (!this.d.kinds.get(asker.kind)?.signIn) throw new Error(`${asker.kind} accounts do not sign in with other accounts`);
    const p = SIGN_IN_PROVIDERS[provider];
    if (!p) throw new Error(`no sign-in provider "${provider}"`);
    const who = this.d.store.account(account);
    if (!who || !who.enabled || !this.d.kinds.get(who.kind)?.signsIn?.includes(provider)) throw new Error(`That account cannot sign in with ${p.name} here`);
    return who;
  }

  /** Keep (or forget, with null) which account answers `provider` for this asker. */
  private remember(asker: Row, provider: string, id: string | null) {
    const cfg = parse<Record<string, any>>(asker.config, {});
    const was = cfg.signInWith?.[provider] ?? null;
    if (was === id) return;
    const next = { ...(cfg.signInWith && typeof cfg.signInWith === 'object' ? cfg.signInWith : {}) };
    if (id) next[provider] = id;
    else delete next[provider];
    if (Object.keys(next).length) cfg.signInWith = next;
    else delete cfg.signInWith;
    this.d.store.run('UPDATE account SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify(cfg), Date.now(), asker.id);
  }
}
