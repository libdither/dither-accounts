/**
 * The dav extractor: one CalDAV/CardDAV account (Nextcloud, Fastmail, iCloud with an app password, Radicale,
 * Baïkal…) answering `calendar` and `contacts` (account.ts). It logs paths and statuses, never passwords or what an
 * event or contact says. docs/dav.md.
 */
import { linkManager, StatusError, type Command } from '@dither-accounts/link';
import { DavAccount } from './account.ts';

let acc: DavAccount;
const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', kind: 'dav', version: '1', interfaces: ['calendar', 'contacts'] });
    acc.status(true);
  },
  onShutdown: () => acc.stop(),
  async onCommand(cmd: Command) {
    const i = cmd as any;
    switch (cmd.t) {
      case 'cal.calendars':
        return acc.calendars();
      case 'cal.events':
        return acc.events(i);
      case 'cal.changes':
        return acc.changes(i);
      case 'cal.put':
        return acc.putEvent(i);
      case 'cal.delete':
        return acc.deleteEvent(i);
      case 'contacts.books':
        return acc.books();
      case 'contacts.list':
        return acc.contactsList(i);
      case 'contacts.changes':
        return acc.contactsChanges(i);
      case 'contacts.put':
        return acc.putContact(i);
      case 'contacts.delete':
        return acc.deleteContact(i);
      default:
        throw new StatusError(`dav has no operation "${cmd.t}"`, 400);
    }
  },
});
acc = new DavAccount(link);
acc.start();
