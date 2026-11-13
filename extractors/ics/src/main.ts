/**
 * The ics extractor: one read-only .ics / webcal feed as the `calendar` interface (feed.ts). It logs the feed's host
 * and statuses, never its URL (a private feed's URL is a password) or what its events say. docs/ics.md.
 */
import { linkManager, StatusError, type Command } from '@dither-accounts/link';
import { Feed } from './feed.ts';

let feed: Feed;
const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', kind: 'ics', version: '1', interfaces: ['calendar'] });
    feed.status(true);
  },
  onShutdown: () => feed.stop(),
  async onCommand(cmd: Command) {
    const i = cmd as any;
    switch (cmd.t) {
      case 'cal.calendars':
        return feed.calendars();
      case 'cal.events':
        return feed.events(i);
      case 'cal.changes':
        return feed.changes(i);
      case 'cal.put':
      case 'cal.delete':
        return feed.readOnly();
      default:
        throw new StatusError(`ics has no operation "${cmd.t}"`, 400);
    }
  },
});
feed = new Feed(link);
feed.start();
