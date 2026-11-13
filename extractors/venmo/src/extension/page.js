/*
 * The Venmo kind's page functions (run by sw.js with chrome.scripting in the extractor's own /statement tab). Each is
 * self-contained: it is serialized into the page.
 */
self.PAGE = {
  /**
   * In the page's own world: the request Venmo's "Download CSV" button makes (connectors/venmo.py made the same one
   * from the same page). Answers [status, body]; the body is {"jsonData": "<the CSV>"}.
   */
  statement: async (s, e, pid) => {
    const q = new URLSearchParams({ startDate: s, endDate: e, csv: 'true', profileId: pid, accountType: 'personal' });
    const r = await fetch('/api/statement/download-v2?' + q, { credentials: 'include' });
    return [r.status, await r.text()];
  },
};
