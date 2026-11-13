/** The node's messages (proto/grpc.proto, camelCased by proto-loader) as the `exchange` interface's types. */
import type { ExchangeBalances, ExchangeChatMessage, ExchangeOffer, ExchangePaymentAccount, ExchangeTrade } from '@dither-accounts/interfaces';

const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const opt = (v: unknown) => (v == null || v === '' ? null : String(v));

export function balances(r: any): ExchangeBalances {
  const x = r?.balances?.xmr ?? {};
  return {
    currency: 'XMR',
    decimals: 12,
    balance: str(x.balance || '0'),
    available: str(x.availableBalance || '0'),
    pending: str(x.pendingBalance || '0'),
    reservedOffers: str(x.reservedOfferBalance || '0'),
    reservedTrades: str(x.reservedTradeBalance || '0'),
  };
}

export function offer(o: any): ExchangeOffer {
  const dep = Math.max(num(o?.buyerSecurityDepositPct), num(o?.sellerSecurityDepositPct));
  return {
    id: str(o?.id),
    direction: o?.direction === 'BUY' ? 'BUY' : 'SELL',
    currency: str(o?.counterCurrencyCode),
    price: str(o?.price),
    marketMarginPct: o?.useMarketBasedPrice ? num(o?.marketPriceMarginPct) : null,
    amount: str(o?.amount || '0'),
    minAmount: str(o?.minAmount || '0'),
    volume: str(o?.volume),
    minVolume: str(o?.minVolume),
    paymentMethod: str(o?.paymentMethodId),
    paymentMethodName: str(o?.paymentMethodShortName || o?.paymentMethodId),
    paymentAccountId: o?.isMyOffer ? opt(o?.paymentAccountId) : null,
    securityDepositPct: dep,
    mine: !!o?.isMyOffer,
    state: str(o?.state),
    activated: !!o?.isActivated,
    private: !!o?.isPrivateOffer,
    extraInfo: opt(o?.extraInfo),
    countries: Array.isArray(o?.acceptedCountryCodes) ? o.acceptedCountryCodes.map(String) : [],
    at: num(o?.date),
  };
}

export function trade(t: any): ExchangeTrade {
  const deadline = num(t?.deadlineTime);
  return {
    id: str(t?.tradeId),
    shortId: str(t?.shortId),
    at: num(t?.date),
    role: str(t?.role),
    offer: offer(t?.offer ?? {}),
    amount: str(t?.amount || '0'),
    price: str(t?.price),
    volume: str(t?.tradeVolume),
    state: str(t?.state),
    phase: str(t?.phase),
    payoutState: str(t?.payoutState),
    disputeState: str(t?.disputeState),
    depositsUnlocked: !!t?.isDepositsUnlocked,
    paymentSent: !!t?.isPaymentSent,
    paymentReceived: !!t?.isPaymentReceived,
    payoutPublished: !!t?.isPayoutPublished,
    payoutUnlocked: !!t?.isPayoutUnlocked,
    completed: !!t?.isCompleted,
    deadline: deadline > 0 ? deadline : null,
    peer: opt(t?.tradePeerNodeAddress),
  };
}

const address = (a: any) => (a?.hostName ? `${a.hostName}:${a.port ?? ''}` : null);

/** `peer` and `arbitrator`: the trade's node addresses (host:port), to say who wrote a message. */
export function chatMessage(m: any, who: { peer: string | null; arbitrator: string | null }): ExchangeChatMessage {
  const from = address(m?.senderNodeAddress);
  return {
    uid: str(m?.uid),
    tradeId: str(m?.tradeId),
    at: num(m?.date),
    from: m?.isSystemMessage ? 'system' : from && from === who.peer ? 'peer' : from && from === who.arbitrator ? 'support' : 'me',
    text: str(m?.message),
    arrived: !!m?.arrived,
    acknowledged: !!m?.acknowledged,
    error: opt(m?.sendMessageError) ?? opt(m?.ackError),
    attachments: Array.isArray(m?.attachments) ? m.attachments.length : 0,
  };
}

export function paymentAccount(a: any): ExchangePaymentAccount {
  const created = num(a?.creationDate);
  return {
    id: str(a?.id),
    name: str(a?.accountName),
    method: str(a?.paymentMethod?.id),
    currencies: Array.isArray(a?.tradeCurrencies) ? a.tradeCurrencies.map((c: any) => str(c?.code)).filter(Boolean) : [],
    currency: opt(a?.selectedTradeCurrency?.code),
    at: created > 0 ? created : null,
  };
}

/** XMR in piconero as words for a status line: "9.4493 XMR". */
export function xmr(pico: string): string {
  const n = BigInt(pico || '0');
  const whole = n / 1_000_000_000_000n;
  const frac = (n % 1_000_000_000_000n).toString().padStart(12, '0').slice(0, 4);
  return `${whole}.${frac} XMR`;
}
