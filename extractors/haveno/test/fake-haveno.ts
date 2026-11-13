/**
 * A fake Haveno daemon for tests: the real gRPC services (proto/grpc.proto) with a small in-memory node behind them:
 * an account behind a password, a wallet that syncs, offers, trades with chats, payment accounts, the notification
 * stream, and ShutdownServer.Stop, which takes it down until `up()` again (as systemd would restart it).
 */
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';

const pkg: any = (grpc.loadPackageDefinition(
  loader.loadSync('grpc.proto', { includeDirs: [join(import.meta.dir, '..', 'proto')], keepCase: false, longs: String, enums: String, defaults: true, oneofs: true }),
) as any).io.haveno.protobuffer;

export const PEER = 'peerpeerpeer.onion:9999';
export const ARBITRATOR = 'arbiarbiarbi.onion:9999';

export function offerInfo(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    direction: 'SELL',
    price: '612.50',
    useMarketBasedPrice: false,
    marketPriceMarginPct: 0,
    amount: '1000000000000',
    minAmount: '500000000000',
    buyerSecurityDepositPct: 0.15,
    sellerSecurityDepositPct: 0.15,
    volume: '612.50',
    minVolume: '306.25',
    paymentMethodId: 'ZELLE',
    paymentMethodShortName: 'Zelle',
    paymentAccountId: 'acct-zelle',
    counterCurrencyCode: 'USD',
    baseCurrencyCode: 'XMR',
    date: '1800000000000',
    state: 'AVAILABLE',
    isActivated: true,
    isMyOffer: false,
    isPrivateOffer: false,
    extraInfo: '',
    acceptedCountryCodes: ['US'],
    ...over,
  };
}

export function tradeInfo(id: string, over: Record<string, unknown> = {}) {
  return {
    tradeId: id,
    shortId: id.slice(0, 7),
    date: '1800000000000',
    role: 'XMR buyer as taker',
    offer: offerInfo(`offer-${id}`),
    amount: '1000000000000',
    price: '612.50',
    tradeVolume: '612.50',
    state: 'DEPOSIT_TXS_UNLOCKED_IN_BLOCKCHAIN',
    phase: 'DEPOSITS_UNLOCKED',
    payoutState: 'PAYOUT_UNPUBLISHED',
    disputeState: 'NO_DISPUTE',
    tradePeerNodeAddress: PEER,
    arbitratorNodeAddress: ARBITRATOR,
    isDepositsUnlocked: true,
    isPaymentSent: false,
    isPaymentReceived: false,
    isPayoutPublished: false,
    isPayoutUnlocked: false,
    isCompleted: false,
    deadlineTime: '1800086400000',
    ...over,
  };
}

const fail = (code: grpc.status, details: string) => Object.assign(new Error(details), { code, details });

export interface FakeHaveno {
  port: number;
  address: string;
  apiPassword: string;
  accountPassword: string;
  state: { open: boolean; initialized: boolean; up: boolean; stops: number; opens: number };
  offers: any[];
  myOffers: any[];
  trades: any[];
  chats: Map<string, any[]>;
  calls: string[];
  /** Push a notification to every listener. */
  notify(m: Record<string, unknown>): void;
  /** Back up (after Stop), with the account closed, as after a restart. */
  up(): Promise<void>;
  down(): void;
  stop(): void;
}

export async function startFakeHaveno(opts: { apiPassword?: string; accountPassword?: string; port?: number } = {}): Promise<FakeHaveno> {
  const listeners = new Set<grpc.ServerWritableStream<any, any>>();
  let server: grpc.Server | null = null;
  const f: FakeHaveno = {
    port: opts.port ?? 0,
    address: '',
    apiPassword: opts.apiPassword ?? 'api-secret',
    accountPassword: opts.accountPassword ?? 'account-secret',
    state: { open: false, initialized: false, up: false, stops: 0, opens: 0 },
    offers: [offerInfo('offer-1'), offerInfo('offer-2', { price: '620.00', paymentMethodId: 'PAYPAL', paymentMethodShortName: 'PayPal' })],
    myOffers: [],
    trades: [tradeInfo('trade-aaaaaaaa')],
    chats: new Map([['trade-aaaaaaaa', [{ uid: 'c1', tradeId: 'trade-aaaaaaaa', date: '1800000001000', message: 'hello', senderNodeAddress: { hostName: 'peerpeerpeer.onion', port: 9999 }, arrived: true, acknowledged: true }]]]),
    calls: [],
    notify(m) {
      for (const l of listeners) l.write({ id: String(Math.random()), timestamp: String(Date.now()), title: '', message: '', ...m });
    },
    up: async () => {
      await listen();
    },
    down: () => {
      for (const l of listeners) l.destroy(fail(grpc.status.UNAVAILABLE, 'shutting down'));
      listeners.clear();
      server?.forceShutdown();
      server = null;
      f.state.up = false;
    },
    stop: () => f.down(),
  };

  // Every call: the API password, then the account where it is needed.
  const guard = (name: string, needsOpen: boolean, h: (req: any) => any) => (call: any, cb: any) => {
    f.calls.push(name);
    if (call.metadata.get('password')[0] !== f.apiPassword) return cb(fail(grpc.status.UNAUTHENTICATED, 'incorrect password'));
    if (needsOpen && !f.state.open) return cb(fail(grpc.status.UNKNOWN, 'Account not open'));
    if (needsOpen && !f.state.initialized) return cb(fail(grpc.status.UNKNOWN, 'wallet and network is not yet initialized'));
    try {
      cb(null, h(call.request));
    } catch (e) {
      cb(e);
    }
  };

  const services = (srv: grpc.Server) => {
    srv.addService(pkg.GetVersion.service, { getVersion: guard('GetVersion', false, () => ({ version: '1.12.0' })) });
    srv.addService(pkg.Account.service, {
      isAccountOpen: guard('IsAccountOpen', false, () => ({ isAccountOpen: f.state.open })),
      isAppInitialized: guard('IsAppInitialized', false, () => ({ isAppInitialized: f.state.open && f.state.initialized })),
      openAccount: guard('OpenAccount', false, (req) => {
        if (req.password !== f.accountPassword) throw fail(grpc.status.UNKNOWN, 'Incorrect password');
        f.state.open = true;
        f.state.opens++;
        setTimeout(() => (f.state.initialized = true), 300);
        return {};
      }),
      closeAccount: guard('CloseAccount', false, () => {
        f.state.open = false;
        f.state.initialized = false;
        return {};
      }),
    });
    srv.addService(pkg.Wallets.service, {
      getBalances: guard('GetBalances', true, () => ({ balances: { xmr: { balance: '1250500000000', availableBalance: '1250500000000', pendingBalance: '0', reservedOfferBalance: '0', reservedTradeBalance: '0' } } })),
      getHeight: guard('GetHeight', false, () => ({ height: '3802170', targetHeight: '3802170' })),
    });
    srv.addService(pkg.Offers.service, {
      getOffers: guard('GetOffers', true, (req) => ({ offers: f.offers.filter((o) => o.direction === req.direction && o.counterCurrencyCode === req.currencyCode) })),
      getMyOffers: guard('GetMyOffers', true, () => ({ offers: f.myOffers })),
      postOffer: guard('PostOffer', true, (req) => {
        const o = offerInfo(`mine-${f.myOffers.length + 1}`, { isMyOffer: true, direction: req.direction, counterCurrencyCode: req.currencyCode, amount: req.amount, minAmount: req.minAmount, paymentAccountId: req.paymentAccountId, useMarketBasedPrice: req.useMarketBasedPrice, marketPriceMarginPct: req.marketPriceMarginPct, price: req.price || '600.00' });
        f.myOffers.push(o);
        return { offer: o };
      }),
      cancelOffer: guard('CancelOffer', true, (req) => {
        const i = f.myOffers.findIndex((o) => o.id === req.id);
        if (i < 0) throw fail(grpc.status.NOT_FOUND, `offer with id '${req.id}' not found`);
        f.myOffers.splice(i, 1);
        return {};
      }),
    });
    srv.addService(pkg.Trades.service, {
      getTrades: guard('GetTrades', true, (req) => ({ trades: req.category === 'OPEN' ? f.trades.filter((t) => !t.isCompleted) : f.trades.filter((t) => t.isCompleted) })),
      getTrade: guard('GetTrade', true, (req) => {
        const t = f.trades.find((x) => x.tradeId === req.tradeId);
        if (!t) throw fail(grpc.status.NOT_FOUND, `trade with id '${req.tradeId}' not found`);
        return { trade: t };
      }),
      getChatMessages: guard('GetChatMessages', true, (req) => ({ message: f.chats.get(req.tradeId) ?? [] })),
      sendChatMessage: guard('SendChatMessage', true, (req) => {
        const list = f.chats.get(req.tradeId) ?? [];
        list.push({ uid: `c${list.length + 1}`, tradeId: req.tradeId, date: String(Date.now()), message: req.message, senderNodeAddress: { hostName: 'me.onion', port: 9999 } });
        f.chats.set(req.tradeId, list);
        return {};
      }),
      confirmPaymentSent: guard('ConfirmPaymentSent', true, (req) => {
        const t = f.trades.find((x) => x.tradeId === req.tradeId);
        if (!t) throw fail(grpc.status.NOT_FOUND, 'no such trade');
        t.isPaymentSent = true;
        t.phase = 'PAYMENT_SENT';
        return {};
      }),
      takeOffer: guard('TakeOffer', true, (req) => {
        if (req.offerId === 'offer-gone') return { failureReason: { availabilityResult: 'OFFER_TAKEN', description: 'Offer is already taken' } };
        const t = tradeInfo(`trade-${req.offerId}`);
        f.trades.push(t);
        return { trade: t };
      }),
    });
    srv.addService(pkg.PaymentAccounts.service, {
      getPaymentAccounts: guard('GetPaymentAccounts', true, () => ({
        paymentAccounts: [{ id: 'acct-zelle', accountName: 'Zelle: me', creationDate: '1732400000000', paymentMethod: { id: 'ZELLE' }, tradeCurrencies: [{ code: 'USD' }], selectedTradeCurrency: { code: 'USD' } }],
      })),
    });
    srv.addService(pkg.Price.service, { getMarketPrices: guard('GetMarketPrices', true, () => ({ marketPrice: [{ currencyCode: 'USD', price: 604.3 }, { currencyCode: 'EUR', price: 560.1 }] })) });
    srv.addService(pkg.ShutdownServer.service, {
      stop: guard('Stop', false, () => {
        f.state.stops++;
        setTimeout(() => f.down(), 50);
        return {};
      }),
    });
    srv.addService(pkg.Notifications.service, {
      registerNotificationListener: (call: grpc.ServerWritableStream<any, any>) => {
        f.calls.push('RegisterNotificationListener');
        if (call.metadata.get('password')[0] !== f.apiPassword) return call.destroy(fail(grpc.status.UNAUTHENTICATED, 'incorrect password'));
        listeners.add(call);
        call.on('cancelled', () => listeners.delete(call));
      },
    });
  };

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      const srv = new grpc.Server();
      services(srv);
      srv.bindAsync(`127.0.0.1:${f.port}`, grpc.ServerCredentials.createInsecure(), (e, port) => {
        if (e) return reject(e);
        f.port = port;
        f.address = `127.0.0.1:${port}`;
        server = srv;
        f.state.up = true;
        f.state.open = false;
        f.state.initialized = false;
        resolve();
      });
    });
  await listen();
  return f;
}
