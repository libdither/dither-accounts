/*
 * The stand-in Gmail page's own app (test/fake-google.ts serves it to the signed-in page): a thread list drawn with
 * Gmail's row markers (tr.zA; zE unread, yO read; zF an unread sender; unread rows' sender and subject bold), and the
 * calls the page makes to its own origin, as Gmail's do: on load (fetch, JSON body; and a GET of a non-JSON
 * resource), when a row is opened (fetch, JSON body; the hash gets the thread's key and the list is hidden), and
 * when the hash comes back to a list (XMLHttpRequest, a form-encoded f.req body). Every answer is positional JSON
 * after an XSSI prefix, full of the page's marker. window.__fakeGmail gives the marker and the rows.
 *
 * As Gmail's page, every call to /sync/ carries the page's own headers (an XSRF token the server checks, a build
 * header), and on load it syncs once (s, from the sync point it was served with) and makes a /mail/u/0/ call that
 * carries its account key (ik): what the hook learns to make calls of its own.
 */
(() => {
  const { mark, rows, xsrf, ik, history } = window.__fakeGmail;
  const syncHeaders = { 'content-type': 'application/json', 'X-Framework-Xsrf-Token': xsrf, 'X-Gmail-BTAI': '[null,null,[null,null,null,null,null,null,1]]' };
  const list = document.getElementById('list');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  list.innerHTML = rows
    .map(
      (r) =>
        `<tr class="${r.cls}" data-t="${esc(r.t)}" data-k="${r.k}"><td class="yX"><div class="yW"><span class="${r.sender || 'yP'}">${esc(mark)} Person</span></div></td>` +
        `<td class="xY"><div class="xT"><div class="y6"><span${r.bold ? ' style="font-weight:700"' : ''}>Re: ${esc(mark)} plans</span></div></div></td></tr>`,
    )
    .join('');

  const threadKey = () => /\/(FMfcg\w+)$/.exec(location.hash)?.[1] ?? null;
  const listHash = () => location.hash.replace(/\/FMfcg\w+$/, '') || '#inbox';

  // A row opened as Gmail does on a click: the hash gets the thread's key, and the thread is fetched.
  list.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.zA');
    if (!tr) return;
    location.hash = `${listHash()}/${tr.dataset.k}`;
    fetch('/sync/u/0/i/fd?hl=en&c=1&rt=r', { method: 'POST', headers: syncHeaders, body: JSON.stringify([[tr.dataset.t, `Re: ${mark} plans`], 2]) }).catch(() => {});
  });

  // Back on a list: the list again, fetched with Gmail's form-encoded f.req.
  window.addEventListener('hashchange', () => {
    const open = !!threadKey();
    document.body.classList.toggle('thread', open);
    if (open) return;
    const x = new XMLHttpRequest();
    x.open('POST', '/sync/u/0/i/bv?hl=en&c=2&rt=r');
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=utf-8');
    x.setRequestHeader('X-Framework-Xsrf-Token', xsrf);
    x.send(`f.req=${encodeURIComponent(JSON.stringify([['^i', 50], `${mark} search`, 1731300000000]))}&at=${encodeURIComponent('AOuZoY5mPqRsTuVwXyZaBcDeFgH:1731300000000')}`);
  });

  fetch('/sync/u/0/i/bv?hl=en&c=0&rt=r', { method: 'POST', headers: syncHeaders, body: JSON.stringify([['^i', 50, null, [`${mark} words`]], 1731300000000]) }).catch(() => {});
  fetch(`/mail/u/0/x/k9x2v7q1/?ver=${encodeURIComponent(mark)}`)
    .then((r) => r.text())
    .catch(() => {});
  // Gmail's own first sync after it loads, from the sync point it was served with; and a call carrying its account key.
  fetch('/sync/u/0/i/s?hl=en&c=3&rt=r&pt=ji', { method: 'POST', headers: syncHeaders, body: JSON.stringify([[1, null, null, 0], null, [1, null, null, null, [null, 25], null, 1], [null, 1, Date.now(), 0, history], 2]) }).catch(() => {});
  fetch(`/mail/u/0/?ui=2&ik=${ik}&jsver=fake&rid=r1&view=cbl&_reqid=123456&nsc=1&mb=0&rt=j`, { method: 'POST' }).catch(() => {});
})();
