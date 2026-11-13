/** Who a new direct conversation can be addressed to on each network. Shared so the composer and the hub agree. */
import type { Network } from './ontology.ts';

const MXID = /^@[^\s:]+:[^\s:]+(:\d+)?$/;
const ACI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHONE = /^\+[1-9]\d{6,14}$/;
const SNOWFLAKE = /^\d{15,22}$/;

const phone = (s: string) => s.replace(/[\s().-]/g, '');

const WAJID = /^\d{5,20}@(s\.whatsapp\.net|lid)$/;
/** A Telegram username: 5 to 32 letters, digits and underscores, starting with a letter. */
const TG_USER = /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/;
const TG_ID = /^\d{5,15}$/;

/** The network a typed address can only belong to. Names and Discord ids answer null: pick those from a list. */
export function guessDirectNetwork(input: string): Network | null {
  return guessDirectNetworks(input)[0] ?? null;
}

/** Every network a typed address could belong to: a phone number fits Signal, WhatsApp, Telegram and Google Messages. */
export function guessDirectNetworks(input: string): Network[] {
  const s = input.trim();
  if (MXID.test(s)) return ['matrix'];
  if (WAJID.test(s)) return ['whatsapp'];
  if (ACI.test(s.toLowerCase())) return ['signal'];
  if (PHONE.test(phone(s))) return ['signal', 'whatsapp', 'telegram', 'gmessages'];
  if (s.startsWith('@') && TG_USER.test(s)) return ['telegram'];
  return [];
}

/** The native address to give an adapter's openDirect, or what is wrong with this one. */
export function directTarget(network: Network, input: string): { peer: string } | { error: string } {
  const s = input.trim();
  if (network === 'matrix') return MXID.test(s) ? { peer: s } : { error: 'A Matrix ID looks like @name:server.org' };
  if (network === 'signal') {
    if (ACI.test(s.toLowerCase())) return { peer: s.toLowerCase() };
    return PHONE.test(phone(s)) ? { peer: phone(s) } : { error: 'A phone number needs its country code, like +15551234567' };
  }
  if (network === 'whatsapp') {
    if (WAJID.test(s)) return { peer: s };
    return PHONE.test(phone(s)) ? { peer: phone(s) } : { error: 'A phone number needs its country code, like +15551234567' };
  }
  if (network === 'telegram') {
    if (PHONE.test(phone(s))) return { peer: phone(s) };
    if (TG_USER.test(s)) return { peer: s.startsWith('@') ? s : `@${s}` };
    return TG_ID.test(s) ? { peer: s } : { error: 'A Telegram @username, or a phone number with its country code, like +15551234567' };
  }
  // A T3 thread starts in a project, in T3 Code (dither-accounts' docs/t3.md).
  if (network === 't3') return { error: 'New T3 threads start in T3 Code for now; they show up here once they exist' };
  if (network === 'gmessages') return PHONE.test(phone(s)) ? { peer: phone(s) } : { error: 'A phone number needs its country code, like +15551234567' };
  // Their extractors read and answer chats but can't open a new one yet: start it in the account's live view.
  if (network === 'messenger' || network === 'instagram' || network === 'x') {
    const name = network === 'x' ? 'X' : network === 'instagram' ? 'Instagram' : 'Messenger';
    return { error: `New ${name} chats start in the account's live view for now; they show up here once they exist` };
  }
  return SNOWFLAKE.test(s) ? { peer: s } : { error: 'Pick someone you know on Discord: it needs their user id' };
}
