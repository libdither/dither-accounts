/** Every interface, by name. An extractor's manifest names the ones it implements. */
import type { Iface } from '@dither-accounts/spec';
import { calendar } from './calendar.ts';
import { chat } from './chat.ts';
import { claude } from './claude.ts';
import { contacts } from './contacts.ts';
import { desktop } from './desktop.ts';
import { dns } from './dns.ts';
import { exchange } from './exchange.ts';
import { googleCalendar } from './google-calendar.ts';
import { mail } from './mail.ts';
import { moneroView } from './monero-view.ts';
import { notifications } from './notifications.ts';
import { privacySession } from './privacy.ts';
import { statements } from './statements.ts';
import { testEcho } from './test.ts';

export { calendar, chat, claude, contacts, desktop, dns, exchange, googleCalendar, mail, moneroView, notifications, privacySession, statements, testEcho };
export type * from './calendar.ts';
export type * from './claude.ts';
export type * from './contacts.ts';
export type * from './desktop.ts';
export type * from './dns.ts';
export type * from './exchange.ts';
export type * from './mail.ts';
export type * from './notifications.ts';
export type * from './privacy.ts';
export type * from './statements.ts';

export const IFACES: Record<string, Iface> = Object.fromEntries([chat, googleCalendar, calendar, contacts, mail, notifications, desktop, exchange, privacySession, statements, moneroView, dns, claude, testEcho].map((i) => [i.name, i]));
