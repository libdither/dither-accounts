/**
 * `exchange`: a peer-to-peer exchange account, a Haveno node today (docs/haveno.md): its wallet's balances, the offer
 * book, your offers and trades, a trade's chat, and your payment accounts. What an app may do is by level:
 *
 *   read    look: balances, prices, offers, trades, chats, payment accounts
 *   write   trade: post and cancel offers, take offers, say a payment was sent or received, chat with the peer
 *   manage  payment accounts, and the account actions (unlock, the app in the live view)
 *
 * No level sends money out of the wallet: withdrawals and transfers are not here on purpose, so a granted app or bot
 * can trade but never empty the wallet. Amounts of the base currency (XMR) are atomic units (piconero, 12 decimals) as
 * decimal strings; prices and volumes are the node's own decimal strings, in the counter currency. Times are
 * milliseconds since the epoch.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

/** XMR, in piconero. */
export interface ExchangeBalances {
  currency: 'XMR';
  decimals: 12;
  /** Everything the wallet holds. */
  balance: string;
  /** Free to use for a new offer or trade. */
  available: string;
  /** Received but not yet unlocked. */
  pending: string;
  /** Held for your open offers. */
  reservedOffers: string;
  /** Held in your trades' deposits. */
  reservedTrades: string;
}

export interface ExchangeOffer {
  id: string;
  /** The maker's side, for XMR: BUY = the maker buys XMR. */
  direction: 'BUY' | 'SELL';
  /** The counter currency: USD, EUR, BTC… */
  currency: string;
  price: string;
  /** Percent above (positive) or below the market price, when the price follows the market; else null. */
  marketMarginPct: number | null;
  amount: string;
  minAmount: string;
  volume: string;
  minVolume: string;
  paymentMethod: string;
  paymentMethodName: string;
  /** Yours only: the payment account it was posted with. */
  paymentAccountId: string | null;
  securityDepositPct: number;
  mine: boolean;
  state: string;
  activated: boolean;
  private: boolean;
  /** The maker's own words. */
  extraInfo: string | null;
  countries: string[];
  at: number;
}

export interface ExchangeTrade {
  id: string;
  shortId: string;
  at: number;
  /** In the node's words: "XMR buyer as taker"… */
  role: string;
  offer: ExchangeOffer;
  amount: string;
  price: string;
  volume: string;
  state: string;
  phase: string;
  payoutState: string;
  disputeState: string;
  depositsUnlocked: boolean;
  paymentSent: boolean;
  paymentReceived: boolean;
  payoutPublished: boolean;
  payoutUnlocked: boolean;
  completed: boolean;
  /** When the trade period ends, or null. */
  deadline: number | null;
  /** The peer's node address (an onion), the way the node names it. */
  peer: string | null;
}

export interface ExchangeChatMessage {
  uid: string;
  tradeId: string;
  at: number;
  /** me, the peer, an arbitrator or mediator (support), or the node itself (system). */
  from: 'me' | 'peer' | 'support' | 'system';
  text: string;
  arrived: boolean;
  acknowledged: boolean;
  error: string | null;
  attachments: number;
}

export interface ExchangePaymentAccount {
  id: string;
  name: string;
  /** The payment method's id: ZELLE, SEPA, PAYPAL, BLOCK_CHAINS… */
  method: string;
  currencies: string[];
  /** The selected currency, when the account has one. */
  currency: string | null;
  at: number | null;
}

export interface ExchangeNotice {
  /** error: the node reports a failure; trade and chat come as their own events. */
  kind: 'error' | 'info';
  title: string;
  message: string;
  tradeId: string | null;
  at: number;
}

const dir = s.enum('BUY', 'SELL');
const id = s.object({ id: s.string });

export const exchange = iface({
  name: 'exchange',
  version: 1,
  describe: 'A peer-to-peer exchange account: balances, offers, trades and their chats, payment accounts.',
  levels: {
    read: 'See your balances, offers, trades, trade chats and payment accounts, and the offer book',
    write: 'Trade as you: post and cancel offers, take offers, confirm payments, chat with trading peers',
    manage: 'Add and remove payment accounts, unlock the account, and open its app in the live view',
  },
  ops: {
    'exchange.balances': op('read', "The wallet's balances, in piconero", s.object({}), s.typed<ExchangeBalances>()),
    'exchange.prices': op(
      'read',
      'Market prices of XMR, in each counter currency (all, without a list)',
      s.object({ currencies: s.optional(s.array(s.string, 200)) }),
      s.typed<{ prices: { currency: string; price: number }[] }>(),
    ),
    'exchange.offers': op(
      'read',
      "The offer book for one currency and the maker's side (BUY: makers buying XMR, which you would sell to)",
      s.object({ direction: dir, currency: s.string }),
      s.typed<{ offers: ExchangeOffer[] }>(),
      60_000,
    ),
    'exchange.myOffers': op('read', 'Your offers', s.object({ direction: s.optional(dir), currency: s.optional(s.string) }), s.typed<{ offers: ExchangeOffer[] }>()),
    'exchange.trades': op(
      'read',
      'Your trades: open (default), closed or failed',
      s.object({ category: s.optional(s.enum('open', 'closed', 'failed')) }),
      s.typed<{ trades: ExchangeTrade[] }>(),
    ),
    'exchange.trade': op('read', 'One trade', id, s.typed<{ trade: ExchangeTrade }>()),
    'exchange.chat': op('read', "A trade's chat with the peer", s.object({ tradeId: s.string }), s.typed<{ messages: ExchangeChatMessage[] }>()),
    'exchange.paymentAccounts': op('read', 'Your payment accounts', s.object({}), s.typed<{ accounts: ExchangePaymentAccount[] }>()),
    'exchange.paymentMethods': op('read', 'The payment methods the node supports', s.object({}), s.typed<{ methods: { id: string; maxTradePeriodMs: number | null }[] }>()),
    'exchange.paymentAccountForm': op(
      'read',
      "A payment method's empty account form (fill its fields' values and give it to exchange.createPaymentAccount)",
      s.object({ method: s.string }),
      s.typed<{ form: unknown }>(),
    ),

    'exchange.postOffer': op(
      'write',
      'Post an offer. A fixed price, or marketMarginPct to follow the market; amounts in piconero; funds are reserved for it',
      s.object({
        direction: dir,
        currency: s.string,
        amount: s.string,
        minAmount: s.optional(s.string),
        price: s.optional(s.string),
        marketMarginPct: s.optional(s.number),
        triggerPrice: s.optional(s.string),
        securityDepositPct: s.optional(s.number),
        paymentAccountId: s.string,
        reserveExactAmount: s.optional(s.boolean),
        private: s.optional(s.boolean),
        buyerAsTakerWithoutDeposit: s.optional(s.boolean),
        extraInfo: s.optional(s.string),
      }),
      s.typed<{ offer: ExchangeOffer }>(),
      180_000,
    ),
    'exchange.cancelOffer': op('write', 'Cancel one of your offers (its funds are freed)', id, s.object({}), 120_000),
    'exchange.takeOffer': op(
      'write',
      "Take an offer with one of your payment accounts, for its whole amount or part of it (piconero); a private offer needs its challenge",
      s.object({ offerId: s.string, paymentAccountId: s.string, amount: s.optional(s.string), challenge: s.optional(s.string) }),
      s.typed<{ trade: ExchangeTrade }>(),
      300_000,
    ),
    'exchange.paymentSent': op('write', 'As the buyer: say you sent the payment', s.object({ tradeId: s.string }), s.object({}), 120_000),
    'exchange.paymentReceived': op('write', 'As the seller: say the payment arrived (this releases the XMR)', s.object({ tradeId: s.string }), s.object({}), 120_000),
    'exchange.completeTrade': op('write', 'Close a finished trade (moves it to closed)', s.object({ tradeId: s.string }), s.object({})),
    'exchange.sendChat': op('write', "Write in a trade's chat", s.object({ tradeId: s.string, text: s.string }), s.object({})),

    'exchange.createPaymentAccount': op('manage', 'Add a payment account from a filled form (exchange.paymentAccountForm)', s.object({ form: s.unknown }), s.typed<{ account: ExchangePaymentAccount }>()),
    'exchange.deletePaymentAccount': op('manage', 'Remove a payment account', id, s.object({})),
    action: op(
      'manage',
      "An account action: unlock {password, remember?}, lock, openApp (the desktop app in the live view, instead of the node), closeApp, status",
      s.object({ action: s.string, args: s.optional(s.typed<Record<string, unknown>>()) }),
      s.typed<unknown>(),
      180_000,
    ),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
    'exchange.balances': ev('The balances changed', s.typed<{ balances: ExchangeBalances }>()),
    'exchange.trade': ev('A trade is new or moved on', s.typed<{ trade: ExchangeTrade }>()),
    'exchange.chat': ev("A new message in a trade's chat", s.typed<{ message: ExchangeChatMessage }>()),
    'exchange.notice': ev('Something the node reports', s.typed<{ notice: ExchangeNotice }>()),
  },
});
