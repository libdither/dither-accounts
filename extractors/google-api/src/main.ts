/**
 * The google-api extractor: one Google account connected with your own OAuth client (its token in secret.json, written
 * by the manager's google provider), answering `google.calendar` over Google's REST API. It logs ids and statuses,
 * never tokens or contents. extractors/google does the same from a signed-in browser instead (docs/google.md).
 */
import { linkManager, StatusError, type Command } from '@dither-accounts/link';
import { Rest, type Secret, SignInNeeded } from './rest.ts';

const enc = encodeURIComponent;
/** Set once Google refused the grant: calls fail at once until the account is connected again (which restarts this). */
let signIn: string | null = null;

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', network: 'google', version: '1', capabilities: [] });
    status();
  },
  async onCommand(cmd) {
    if (signIn) throw new StatusError(signIn, 401);
    try {
      return await run(cmd);
    } catch (e) {
      if (e instanceof SignInNeeded) {
        signIn = e.message;
        link.log('warn', 'Google refused the sign-in; the account needs connecting again');
        status();
        throw new StatusError(e.message, 401);
      }
      throw e;
    }
  },
});

const rest = new Rest(
  () => link.secret<Secret>(),
  (s) => link.saveSecret(s),
);

function status() {
  const s = link.secret<Secret>();
  if (signIn || !s.refreshToken) link.emit({ t: 'status', status: 'attention', attention: { kind: 'login', message: signIn ?? 'Google is not signed in; connect it on the accounts page' } });
  else link.emit({ t: 'status', status: 'online', attention: null, self: { email: s.email } });
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

async function run(cmd: Command): Promise<unknown> {
  switch (cmd.t) {
    case 'calendar.calendarList.list': {
      const page = await rest.req('GET', '/calendar/v3/users/me/calendarList', { query: { pageToken: str(cmd.pageToken), maxResults: cmd.maxResults as number | undefined, syncToken: str(cmd.syncToken) } });
      return { items: page.items ?? [], ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}), ...(page.nextSyncToken ? { nextSyncToken: page.nextSyncToken } : {}) };
    }
    case 'calendar.calendarList.patch':
      return rest.req('PATCH', `/calendar/v3/users/me/calendarList/${enc(String(cmd.calendarId))}`, { query: { colorRgbFormat: cmd.colorRgbFormat as boolean | undefined }, body: cmd.body });
    case 'calendar.calendars.insert':
      return rest.req('POST', '/calendar/v3/calendars', { body: cmd.body });
    case 'calendar.events.list': {
      const q = {
        syncToken: str(cmd.syncToken),
        pageToken: str(cmd.pageToken),
        maxResults: cmd.maxResults as number | undefined,
        singleEvents: cmd.singleEvents as boolean | undefined,
        showDeleted: cmd.showDeleted as boolean | undefined,
        timeMin: str(cmd.timeMin),
        timeMax: str(cmd.timeMax),
      };
      const page = await rest.req('GET', `/calendar/v3/calendars/${enc(String(cmd.calendarId))}/events`, { query: q });
      return { items: page.items ?? [], ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}), ...(page.nextSyncToken ? { nextSyncToken: page.nextSyncToken } : {}) };
    }
    case 'calendar.events.insert':
      return rest.req('POST', `/calendar/v3/calendars/${enc(String(cmd.calendarId))}/events`, { body: cmd.body });
    case 'calendar.events.patch':
      return rest.req('PATCH', `/calendar/v3/calendars/${enc(String(cmd.calendarId))}/events/${enc(String(cmd.eventId))}`, { body: cmd.body });
    case 'calendar.events.delete':
      await rest.req('DELETE', `/calendar/v3/calendars/${enc(String(cmd.calendarId))}/events/${enc(String(cmd.eventId))}`);
      return {};
    default:
      throw new Error(`google has no operation "${cmd.t}"`);
  }
}
