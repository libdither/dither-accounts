/**
 * The haveno extractor: one Haveno node (the daemon's gRPC API, 127.0.0.1:1201 by default) as an `exchange` account
 * (docs/haveno.md), and the Haveno desktop app on the same data in a sandbox with a live view, on demand (app.ts).
 *
 *   daemon answers? → account open? → wallet and network ready? → online: the notification stream (trades, chats,
 *   errors) and a poll of balances and open trades → exchange.balances / exchange.trade / exchange.chat / notice
 *
 * The account password opens the account (action unlock). It is kept in memory, so the account opens again by
 * itself when the daemon restarts (after the desktop app, an upgrade, a reboot), and on disk (secret.json) only when
 * unlock is given remember: true. The API password is the daemon's (secret.json apiPassword, or
 * HAVENO_API_PASSWORD in ~/.config/haveno/daemon.env, which the daemon's own unit can read too).
 *
 * The node runs outside the manager (a system service), so restarting dither-accounts never stops it; only the
 * desktop app, while open, lives in this extractor's sandbox. Logs and status carry states, counts and ids; never a
 * password, a chat message or a payment account's details.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExchangeBalances, ExchangeTrade } from '@dither-accounts/interfaces';
import { type Command, linkManager, StatusError } from '@dither-accounts/link';
import { HavenoApi, HavenoError, type Stream } from './api.ts';
import { HavenoApp } from './app.ts';
import * as map from './map.ts';

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const CHECK_MS = num('DITHER_HAVENO_CHECK_MS', 10_000);
const POLL_MS = num('DITHER_HAVENO_POLL_MS', 60_000);
/** How long the daemon gets to stop before the desktop app takes its place anyway (the app then waits on the lock). */
const HANDOVER_MS = num('DITHER_HAVENO_HANDOVER_MS', 90_000);

type Phase = 'starting' | 'down' | 'denied' | 'locked' | 'opening' | 'syncing' | 'online' | 'handover' | 'app';
type Layer = { name: string; state: 'ok' | 'waiting' | 'failed' | 'off'; note?: string };

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', network: 'haveno', version: '1', capabilities: [] });
    status(true);
  },
  onCommand: (cmd) => run(cmd),
  onShutdown: () => shutdown(),
});

const config = link.config as { address?: string; dataDir?: string; envFile?: string };
const address = (typeof config.address === 'string' && config.address.trim()) || '127.0.0.1:1201';
const dataDir = (typeof config.dataDir === 'string' && config.dataDir.trim()) || join(homedir(), '.local/share/Haveno-reto');
const envFile = (typeof config.envFile === 'string' && config.envFile.trim()) || join(homedir(), '.config/haveno/daemon.env');

type Secret = { apiPassword?: string; accountPassword?: string };
const secret = () => link.secret<Secret>();

function apiPassword(): string | null {
  const s = secret().apiPassword;
  if (typeof s === 'string' && s) return s;
  try {
    const m = readFileSync(envFile, 'utf8').match(/^\s*HAVENO_API_PASSWORD\s*=\s*"?([^"\n]*)"?\s*$/m);
    return m?.[1] || null;
  } catch {
    return null;
  }
}

let phase: Phase = 'starting';
let problem: string | null = null;
let version: string | null = null;
/** The account password, in memory (and in secret.json only when remembered). */
let accountPassword: string | null = typeof secret().accountPassword === 'string' ? (secret().accountPassword as string) : null;
let unlockRefused: string | null = null;
let wallet: { height: number; target: number } | null = null;
let bal: ExchangeBalances | null = null;
const trades = new Map<string, ExchangeTrade>();
let tradesKnown = false;
let stream: Stream | null = null;
let streamState: 'off' | 'open' | 'ended' = 'off';
let lastPollAt: number | null = null;
let checking = false;
let handoverSince = 0;
let settle = Promise.withResolvers<void>();

/** Tests: another program than haveno-desktop in the sandbox (a JSON array), and its network. */
const appCommand = process.env.DITHER_HAVENO_APP_COMMAND ? (JSON.parse(process.env.DITHER_HAVENO_APP_COMMAND) as string[]) : undefined;
const appNetwork = process.env.DITHER_HAVENO_APP_NETWORK as 'pasta' | 'host' | 'none' | undefined;

const api = new HavenoApi(address, apiPassword);
const app = new HavenoApp({
  accountDir: link.accountDir,
  dataDir,
  command: appCommand,
  network: appNetwork,
  log: (l, m, d) => link.log(l, m, d),
  onChange: () => status(),
  onExit: () => {
    // The daemon comes back by itself once the app's lock is gone; look for it soon.
    setPhase('down', 'the desktop app quit; the node is starting again');
    setTimeout(check, 3_000);
  },
});

function setPhase(p: Phase, why: string | null = null) {
  if (p !== 'online') stopStream();
  phase = p;
  problem = why;
  if (p !== 'starting') settle.resolve();
  status();
}

// ------------------------------------------------------------------ the node's state

async function check() {
  if (checking || app.running) return;
  if (phase === 'handover') return;
  checking = true;
  try {
    await checkOnce();
  } finally {
    checking = false;
  }
}

async function checkOnce() {
  try {
    const v = await api.call('GetVersion', 'GetVersion', {}, 10_000);
    version = v?.version ?? null;
  } catch (e) {
    const h = e as HavenoError;
    if (h.kind === 'denied') return setPhase('denied', 'the daemon refused the API password (secret.json apiPassword, or HAVENO_API_PASSWORD in the env file)');
    return setPhase('down', `the daemon at ${address} is not answering`);
  }
  let open: boolean;
  try {
    open = !!(await api.call('Account', 'IsAccountOpen', {}, 15_000))?.isAccountOpen;
  } catch (e) {
    return setPhase('down', `the daemon did not say whether the account is open (${(e as Error).message.slice(0, 120)})`);
  }
  if (!open) {
    if (accountPassword && !unlockRefused) {
      setPhase('opening', 'opening the account');
      try {
        await openAccount(accountPassword);
      } catch (e) {
        unlockRefused = (e as Error).message.slice(0, 200);
        link.log('warn', `the account did not open with the kept password: ${unlockRefused}`);
        return setPhase('locked', `the account did not open with the password kept for it (${unlockRefused}); unlock it again`);
      }
      return checkOnce();
    }
    return setPhase('locked', 'the account is locked: unlock it with its password');
  }
  let ready = false;
  try {
    ready = !!(await api.call('Account', 'IsAppInitialized', {}, 15_000))?.isAppInitialized;
  } catch {}
  try {
    const h = await api.call('Wallets', 'GetHeight', {}, 15_000);
    wallet = { height: Number(h?.height ?? 0), target: Number(h?.targetHeight ?? 0) };
  } catch {}
  if (!ready) return setPhase('syncing', wallet?.target ? `the wallet syncs: block ${wallet.height} of ${wallet.target}` : 'the wallet and the network are starting');
  if (phase !== 'online') {
    setPhase('online');
    startStream();
    void poll();
  }
}

async function openAccount(password: string) {
  await api.call('Account', 'OpenAccount', { password }, 120_000);
  unlockRefused = null;
  link.log('info', 'the account is open');
}

// ------------------------------------------------------------------ while online

function startStream() {
  if (stream) return;
  streamState = 'open';
  stream = api.notifications(
    (m) => onNotification(m),
    (e) => {
      stream = null;
      streamState = 'ended';
      if (phase === 'online') {
        link.log('info', `the notification stream ended${e ? ` (${e.kind})` : ''}; checking the node`);
        setTimeout(() => {
          if (phase === 'online' && !stream) startStream();
          void check();
        }, 5_000);
      }
      status();
    },
  );
  status();
}

function stopStream() {
  stream?.cancel();
  stream = null;
  streamState = 'off';
}

function onNotification(m: any) {
  switch (m?.type) {
    case 'TRADE_UPDATE': {
      if (!m.trade?.tradeId) return;
      const t = map.trade(m.trade);
      trades.set(t.id, t);
      link.emit({ t: 'exchange.trade', trade: t });
      void refreshBalances();
      return;
    }
    case 'CHAT_MESSAGE': {
      if (!m.chatMessage) return;
      const tr = trades.get(String(m.chatMessage.tradeId ?? ''));
      const raw = m.trade?.tradeId ? m.trade : null;
      const who = { peer: raw?.tradePeerNodeAddress ?? tr?.peer ?? null, arbitrator: raw?.arbitratorNodeAddress ?? null };
      link.emit({ t: 'exchange.chat', message: map.chatMessage(m.chatMessage, who) });
      return;
    }
    case 'ERROR':
      link.emit({ t: 'exchange.notice', notice: { kind: 'error', title: String(m.title ?? ''), message: String(m.message ?? ''), tradeId: m.trade?.tradeId ?? null, at: Number(m.timestamp) || Date.now() } });
      return;
    case 'APP_INITIALIZED':
      void check();
      return;
    default:
      return;
  }
}

async function refreshBalances() {
  try {
    const b = map.balances(await api.call('Wallets', 'GetBalances', {}, 30_000));
    const changed = JSON.stringify(b) !== JSON.stringify(bal);
    bal = b;
    if (changed) {
      link.emit({ t: 'exchange.balances', balances: b });
      status();
    }
  } catch (e) {
    link.log('debug', `balances: ${(e as Error).message.slice(0, 120)}`);
  }
}

const tradeKey = (t: ExchangeTrade) => JSON.stringify([t.state, t.phase, t.payoutState, t.disputeState, t.paymentSent, t.paymentReceived, t.payoutPublished, t.payoutUnlocked, t.completed]);

async function poll() {
  if (phase !== 'online') return;
  lastPollAt = Date.now();
  await refreshBalances();
  try {
    const r = await api.call('Trades', 'GetTrades', { category: 'OPEN' }, 60_000);
    for (const raw of r?.trades ?? []) {
      const t = map.trade(raw);
      const old = trades.get(t.id);
      trades.set(t.id, t);
      if (tradesKnown && (!old || tradeKey(old) !== tradeKey(t))) link.emit({ t: 'exchange.trade', trade: t });
    }
    tradesKnown = true;
  } catch (e) {
    link.log('debug', `trades: ${(e as Error).message.slice(0, 120)}`);
  }
  status();
}

// ------------------------------------------------------------------ the desktop app

async function openApp() {
  if (app.running) return { already: true };
  if (phase === 'handover') throw new StatusError('already handing the node over to the desktop app', 409);
  setPhase('handover', 'stopping the node for the desktop app');
  handoverSince = Date.now();
  try {
    try {
      await api.call('ShutdownServer', 'Stop', {}, 30_000);
    } catch (e) {
      if ((e as HavenoError).kind !== 'down') link.log('warn', `the node's stop said: ${(e as Error).message.slice(0, 160)}`);
    }
    // Gone once it stops answering; the app's launcher then waits for its lock anyway.
    while (Date.now() - handoverSince < HANDOVER_MS) {
      try {
        await api.call('GetVersion', 'GetVersion', {}, 3_000);
        await Bun.sleep(1_000);
      } catch {
        break;
      }
    }
    await app.start();
    setPhase('app', null);
    return { started: true };
  } catch (e) {
    const why = (e as Error).message.slice(0, 300);
    link.log('error', `the desktop app did not start: ${why}`);
    setPhase('down', `the desktop app did not start (${why}); the node comes back by itself`);
    setTimeout(check, 5_000);
    throw new StatusError(`the desktop app did not start: ${why}`, 500);
  }
}

// ------------------------------------------------------------------ ops

async function ready() {
  if (phase === 'starting') await Promise.race([settle.promise, Bun.sleep(15_000)]);
  if (phase === 'online') return;
  const words: Record<Phase, string> = {
    starting: 'the node has not answered yet',
    down: problem ?? 'the node is not answering',
    denied: problem ?? 'the node refused the API password',
    locked: problem ?? 'the account is locked',
    opening: 'the account is opening',
    syncing: problem ?? 'the wallet is syncing',
    online: '',
    handover: 'the node is handing over to the desktop app',
    app: 'the desktop app has the account now (quit it, or closeApp, and the node comes back)',
  };
  throw new StatusError(words[phase], phase === 'locked' || phase === 'denied' ? 401 : 503);
}

const need = (cmd: Command, k: string): string => {
  const v = cmd[k];
  if (typeof v !== 'string' || !v.trim()) throw new StatusError(`${k} is missing`, 400);
  return v.trim();
};
const piconero = (cmd: Command, k: string): string | undefined => {
  const v = cmd[k];
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string' || !/^\d{1,20}$/.test(v)) throw new StatusError(`${k}: piconero as a whole number in a string`, 400);
  return v;
};

async function call<T = any>(service: string, method: string, req: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  try {
    return await api.call<T>(service, method, req, timeoutMs);
  } catch (e) {
    const h = e as HavenoError;
    if (h.kind === 'down' || h.kind === 'locked' || h.kind === 'syncing') void check();
    throw new StatusError(h.message, h.kind === 'down' ? 503 : h.kind === 'locked' || h.kind === 'denied' ? 401 : h.kind === 'syncing' ? 503 : 400);
  }
}

async function run(cmd: Command): Promise<unknown> {
  if (cmd.t === 'action') return action(String(cmd.action ?? ''), (cmd.args ?? {}) as Record<string, unknown>);
  await ready();
  switch (cmd.t) {
    case 'exchange.balances':
      await refreshBalances();
      if (!bal) throw new StatusError('the node did not give its balances', 503);
      return bal;
    case 'exchange.prices': {
      const r = await call('Price', 'GetMarketPrices');
      const want = Array.isArray(cmd.currencies) ? new Set((cmd.currencies as string[]).map((c) => c.toUpperCase())) : null;
      const prices = (r?.marketPrice ?? r?.marketPrices ?? []).map((p: any) => ({ currency: String(p.currencyCode), price: Number(p.price) })).filter((p: any) => !want || want.has(p.currency));
      return { prices };
    }
    case 'exchange.offers': {
      const r = await call('Offers', 'GetOffers', { direction: need(cmd, 'direction'), currencyCode: need(cmd, 'currency') }, 60_000);
      return { offers: (r?.offers ?? []).map(map.offer) };
    }
    case 'exchange.myOffers': {
      const r = await call('Offers', 'GetMyOffers', { direction: typeof cmd.direction === 'string' ? cmd.direction : '', currencyCode: typeof cmd.currency === 'string' ? cmd.currency : '' });
      return { offers: (r?.offers ?? []).map(map.offer) };
    }
    case 'exchange.trades': {
      const category = ({ open: 'OPEN', closed: 'CLOSED', failed: 'FAILED' } as const)[(cmd.category as 'open' | 'closed' | 'failed') ?? 'open'] ?? 'OPEN';
      const r = await call('Trades', 'GetTrades', { category });
      return { trades: (r?.trades ?? []).map(map.trade) };
    }
    case 'exchange.trade': {
      const r = await call('Trades', 'GetTrade', { tradeId: need(cmd, 'id') });
      return { trade: map.trade(r?.trade) };
    }
    case 'exchange.chat': {
      const tradeId = need(cmd, 'tradeId');
      const [r, t] = await Promise.all([call('Trades', 'GetChatMessages', { tradeId }), call('Trades', 'GetTrade', { tradeId }).catch(() => null)]);
      const who = { peer: t?.trade?.tradePeerNodeAddress ?? null, arbitrator: t?.trade?.arbitratorNodeAddress ?? null };
      return { messages: (r?.message ?? r?.messages ?? []).map((m: any) => map.chatMessage(m, who)) };
    }
    case 'exchange.paymentAccounts': {
      const r = await call('PaymentAccounts', 'GetPaymentAccounts');
      return { accounts: (r?.paymentAccounts ?? []).map(map.paymentAccount) };
    }
    case 'exchange.paymentMethods': {
      const r = await call('PaymentAccounts', 'GetPaymentMethods');
      return { methods: (r?.paymentMethods ?? []).map((m: any) => ({ id: String(m.id), maxTradePeriodMs: Number(m.maxTradePeriod) || null })) };
    }
    case 'exchange.paymentAccountForm': {
      const r = await call('PaymentAccounts', 'GetPaymentAccountFormAsJson', { paymentMethodId: need(cmd, 'method') });
      const json = r?.paymentAccountFormAsJson;
      return { form: typeof json === 'string' && json ? JSON.parse(json) : null };
    }
    case 'exchange.postOffer': {
      const fixed = typeof cmd.price === 'string' && cmd.price.trim();
      const margin = typeof cmd.marketMarginPct === 'number';
      if (!!fixed === margin) throw new StatusError('give either price (fixed) or marketMarginPct (following the market)', 400);
      const amount = piconero(cmd, 'amount');
      if (!amount) throw new StatusError('amount is missing', 400);
      const r = await call(
        'Offers',
        'PostOffer',
        {
          currencyCode: need(cmd, 'currency'),
          direction: need(cmd, 'direction'),
          price: fixed ? String(cmd.price) : '',
          useMarketBasedPrice: margin,
          marketPriceMarginPct: margin ? (cmd.marketMarginPct as number) : 0,
          amount,
          minAmount: piconero(cmd, 'minAmount') ?? amount,
          securityDepositPct: typeof cmd.securityDepositPct === 'number' ? cmd.securityDepositPct : 0.15,
          triggerPrice: typeof cmd.triggerPrice === 'string' ? cmd.triggerPrice : '',
          reserveExactAmount: !!cmd.reserveExactAmount,
          paymentAccountId: need(cmd, 'paymentAccountId'),
          isPrivateOffer: !!cmd.private,
          buyerAsTakerWithoutDeposit: !!cmd.buyerAsTakerWithoutDeposit,
          extraInfo: typeof cmd.extraInfo === 'string' ? cmd.extraInfo : '',
        },
        180_000,
      );
      link.log('info', `posted an offer (${r?.offer?.id ?? '?'})`);
      void refreshBalances();
      return { offer: map.offer(r?.offer) };
    }
    case 'exchange.cancelOffer':
      await call('Offers', 'CancelOffer', { id: need(cmd, 'id') }, 120_000);
      link.log('info', `cancelled an offer (${cmd.id})`);
      void refreshBalances();
      return {};
    case 'exchange.takeOffer': {
      const r = await call(
        'Trades',
        'TakeOffer',
        { offerId: need(cmd, 'offerId'), paymentAccountId: need(cmd, 'paymentAccountId'), amount: piconero(cmd, 'amount') ?? '0', challenge: typeof cmd.challenge === 'string' ? cmd.challenge : '' },
        300_000,
      );
      if (!r?.trade?.tradeId) {
        const f = r?.failureReason;
        throw new StatusError(`the offer was not taken${f ? `: ${f.description || f.availabilityResult}` : ''}`, 409);
      }
      const t = map.trade(r.trade);
      trades.set(t.id, t);
      link.log('info', `took an offer: trade ${t.shortId}`);
      void refreshBalances();
      return { trade: t };
    }
    case 'exchange.paymentSent':
      await call('Trades', 'ConfirmPaymentSent', { tradeId: need(cmd, 'tradeId') }, 120_000);
      link.log('info', `payment sent, trade ${cmd.tradeId}`);
      return {};
    case 'exchange.paymentReceived':
      await call('Trades', 'ConfirmPaymentReceived', { tradeId: need(cmd, 'tradeId') }, 120_000);
      link.log('info', `payment received, trade ${cmd.tradeId}`);
      return {};
    case 'exchange.completeTrade':
      await call('Trades', 'CompleteTrade', { tradeId: need(cmd, 'tradeId') });
      return {};
    case 'exchange.sendChat':
      await call('Trades', 'SendChatMessage', { tradeId: need(cmd, 'tradeId'), message: need(cmd, 'text') });
      return {};
    case 'exchange.createPaymentAccount': {
      if (cmd.form == null || typeof cmd.form !== 'object') throw new StatusError('form: the filled form from exchange.paymentAccountForm', 400);
      const r = await call('PaymentAccounts', 'CreatePaymentAccount', { paymentAccountFormAsJson: JSON.stringify(cmd.form) });
      link.log('info', 'added a payment account');
      return { account: map.paymentAccount(r?.paymentAccount) };
    }
    case 'exchange.deletePaymentAccount':
      await call('PaymentAccounts', 'DeletePaymentAccount', { paymentAccountId: need(cmd, 'id') });
      link.log('info', 'removed a payment account');
      return {};
    default:
      throw new StatusError(`unknown op ${cmd.t}`, 404);
  }
}

async function action(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'unlock':
    case 'relogin':
    case 'password': {
      const password = typeof args.password === 'string' ? args.password : '';
      if (!password) throw new StatusError('password is missing', 400);
      if (app.running) throw new StatusError('the desktop app has the account: unlock it there, in the live view', 409);
      try {
        await openAccount(password);
      } catch (e) {
        const h = e as HavenoError;
        throw new StatusError(h.kind === 'down' ? 'the node is not answering' : `the account did not open: ${h.message.slice(0, 200)}`, h.kind === 'down' ? 503 : 401);
      }
      accountPassword = password;
      const { accountPassword: _, ...rest } = secret();
      link.saveSecret(args.remember === true ? { ...rest, accountPassword: password } : rest);
      if (args.remember === true) link.log('info', 'the account password is kept in secret.json (remember)');
      status();
      void check();
      return { open: true, remembered: args.remember === true };
    }
    case 'lock':
    case 'forget': {
      accountPassword = null;
      const { accountPassword: _, ...rest } = secret();
      link.saveSecret(rest);
      status();
      if (name === 'lock' && phase !== 'app') await call('Account', 'CloseAccount', {}, 120_000).catch(() => {});
      void check();
      return { locked: name === 'lock' };
    }
    case 'openApp':
      return openApp();
    case 'closeApp':
      if (!app.running) return { running: false };
      if (args.force === true) {
        await app.kill();
        return { killed: true };
      }
      app.quit();
      return { asked: true, note: 'Haveno may ask in the live view first (open trades or offers)' };
    case 'status':
      return { phase, problem, ...details() };
    default:
      throw new StatusError(`unknown action ${name}: unlock, lock, forget, openApp, closeApp, status`, 400);
  }
}

// ------------------------------------------------------------------ status

function attention() {
  if (phase === 'locked') return { kind: 'login', message: problem ?? 'Unlock the Haveno account with its password' };
  if (phase === 'denied') return { kind: 'config', message: problem ?? 'The API password is wrong' };
  if (phase === 'app')
    return { kind: 'app', message: "Haveno's desktop app is open in the live view, and the node is stopped meanwhile. Quit the app there (Ctrl+Q), or with Back to the node, and the node comes back.", liveView: true };
  return null;
}

function statusWord(): string {
  if (phase === 'online') return 'online';
  if (phase === 'down') return 'offline';
  if (phase === 'starting' || phase === 'opening' || phase === 'syncing' || phase === 'handover') return 'connecting';
  return 'attention';
}

function details(): Record<string, string | number | boolean | null> {
  return {
    address,
    dataDir,
    version,
    phase,
    balance: bal ? map.xmr(bal.balance) : null,
    available: bal ? map.xmr(bal.available) : null,
    openTrades: tradesKnown ? [...trades.values()].filter((t) => !t.completed).length : null,
    walletHeight: wallet?.height ?? null,
    walletTarget: wallet?.target ?? null,
    stream: streamState,
    passwordKept: accountPassword ? (secret().accountPassword ? 'memory and secret.json' : 'memory') : 'no',
    lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
    calls: api.calls,
    desktopApp: app.running,
  };
}

function layers(): Layer[] {
  const daemon: Layer =
    phase === 'app'
      ? { name: 'node', state: 'off', note: 'stopped while the desktop app runs' }
      : phase === 'down' || phase === 'starting'
        ? { name: 'node', state: phase === 'starting' ? 'waiting' : 'failed', note: problem ?? address }
        : phase === 'denied'
          ? { name: 'node', state: 'failed', note: problem ?? 'API password refused' }
          : phase === 'handover'
            ? { name: 'node', state: 'waiting', note: 'stopping for the desktop app' }
            : { name: 'node', state: 'ok', note: `Haveno ${version ?? '?'} at ${address}` };
  const account: Layer =
    phase === 'locked'
      ? { name: 'account open', state: 'failed', note: problem ?? 'locked' }
      : phase === 'opening'
        ? { name: 'account open', state: 'waiting', note: 'opening' }
        : phase === 'syncing' || phase === 'online'
          ? { name: 'account open', state: 'ok', note: accountPassword ? 'opens again by itself after a restart' : 'opened elsewhere; unlock here to reopen it after restarts' }
          : { name: 'account open', state: 'waiting', note: 'waits for the node' };
  const walletLayer: Layer =
    phase === 'online'
      ? { name: 'wallet and network', state: 'ok', note: bal ? `${map.xmr(bal.balance)}, ${map.xmr(bal.available)} available` : 'ready' }
      : phase === 'syncing'
        ? { name: 'wallet and network', state: 'waiting', note: problem ?? 'syncing' }
        : { name: 'wallet and network', state: 'waiting', note: 'waits for the account' };
  const events: Layer =
    phase !== 'online'
      ? { name: 'notifications', state: 'waiting', note: 'once online' }
      : streamState === 'open'
        ? { name: 'notifications', state: 'ok', note: 'trades, chats and errors as they happen' }
        : { name: 'notifications', state: 'waiting', note: 'reconnecting' };
  return [daemon, account, walletLayer, events, app.layer()];
}

const VOLATILE = ['lastPollAt', 'calls', 'walletHeight'];
let lastKey = '';
let lastSentAt = 0;
function status(force = false) {
  const d = details();
  const lv = app.liveView();
  const ev = { t: 'status', status: statusWord(), attention: attention(), details: d, layers: layers(), ...(lv ? { liveView: lv } : {}) };
  const key = JSON.stringify({ ...ev, details: Object.fromEntries(Object.entries(d).filter(([k]) => !VOLATILE.includes(k))) });
  if (!force && key === lastKey && Date.now() - lastSentAt < 600_000) return;
  lastKey = key;
  lastSentAt = Date.now();
  link.emit(ev);
}

async function shutdown() {
  stopStream();
  if (app.running) {
    // Ask it to quit (it quits at once when nothing is open), then kill what is left.
    try {
      app.quit();
    } catch {}
    for (let i = 0; i < 30 && app.running; i++) await Bun.sleep(500);
    await app.kill();
  }
  api.close();
}

// ------------------------------------------------------------------ start

if (!existsSync(dataDir)) link.log('warn', `the data directory ${dataDir} is not there; the desktop app will not open`);
setInterval(() => void check(), CHECK_MS);
setInterval(() => void poll(), POLL_MS);
void check();
