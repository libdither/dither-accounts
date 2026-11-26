/*
 * The chooser a sandbox's tab is sent to when its site starts a "Continue with <provider>" sign-in
 * (signin-worker.js): which of your accounts answers it, or signing in to the provider in this browser instead. It
 * asks the worker for what to show every half second and sends it the pick; it never sees the link.
 */
'use strict';
const rid = location.hash.slice(1);
const main = document.getElementById('main');
let shown = '';
let remember = true;

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== undefined) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};
const send = (m) => chrome.runtime.sendMessage({ ...m, rid }).then(render, () => {});

function choices(v) {
  const list = v.choices || [];
  if (!list.length) return [el('p', {}, `None of your accounts here can sign in with ${v.name}. Add one on your accounts page, or sign in here.`)];
  return [
    el(
      'div',
      { class: 'choices' },
      list.map((c) =>
        el(
          'button',
          { class: 'pick', disabled: !c.online, onclick: () => send({ t: 'signin.pick', account: c.id, remember }) },
          el('strong', {}, c.who || c.label),
          el('span', { class: 'mute' }, c.who && c.who !== c.label ? c.label : '', c.online ? '' : ' (offline)'),
        ),
      ),
    ),
    el(
      'label',
      {},
      el('input', { type: 'checkbox', checked: remember, onchange: (e) => (remember = e.target.checked) }),
      `Link it: use it next time ${v.site ? v.site.replace(/^https:\/\//, '') : 'this site'} asks, and go through ${v.name}'s screens for me`,
    ),
  ];
}

function render(v) {
  if (!v) return;
  // Not on `remember`: the box keeps its own tick, and drawing again would take the focus off it.
  const key = JSON.stringify(v);
  if (key === shown) return;
  shown = key;
  const name = v.name || 'the provider';
  const site = v.site ? v.site.replace(/^https:\/\//, '') : 'this site';
  const asks = v.asks && v.asks.length ? el('div', {}, el('p', { class: 'mute' }, `${site} asks ${name} for:`), el('ul', {}, v.asks.map((a) => el('li', {}, a)))) : null;
  const here = el('button', { class: 'link', onclick: () => send({ t: 'signin.here' }) }, `Sign in to ${name} in this browser instead`);
  const cancel = el('button', { class: 'link', onclick: () => send({ t: 'signin.cancel' }) }, 'Cancel');
  let body;
  if (v.state === 'gone') body = [el('h1', {}, 'This sign-in is over'), el('p', { class: 'mute' }, 'You can close this tab.')];
  else if (v.state === 'asking') body = [el('h1', {}, `Sign in with ${name}`), el('p', { class: 'mute' }, 'Looking for your accounts…')];
  else if (v.state === 'waiting') {
    const c = (v.choices || []).find((x) => x.id === v.account);
    const who = c ? c.who || c.label : 'your account';
    body = [
      el('h1', {}, `Signing in to ${site}`),
      el('p', {}, `with ${who}.`),
      el(
        'p',
        { class: 'mute' },
        v.linked
          ? `Linked: ${name}'s account chooser and Continue are pressed for you. If ${name} asks for anything else, answer it in the live view of ${c ? c.label : 'that account'} on your accounts page.`
          : `If ${name} asks you to pick an account or to allow it, answer it in the live view of ${c ? c.label : 'that account'} on your accounts page.`,
      ),
      asks,
      el('div', { class: 'row' }, cancel),
    ];
  } else if (v.state === 'failed') body = [el('h1', {}, `Sign in to ${site} with ${name}`), el('p', { class: 'bad' }, v.error || 'That did not work.'), ...(v.choices ? choices(v) : []), el('div', { class: 'row' }, here, cancel)];
  else body = [el('h1', {}, `Sign in to ${site} with ${name}`), asks, ...choices(v), el('div', { class: 'row' }, here, cancel)];
  main.replaceChildren(...body.filter(Boolean));
  // Drawn: the accounts can be picked now (the worker tells the extractor, once a state).
  chrome.runtime.sendMessage({ t: 'signin.shown', rid, state: v.state }).catch(() => {});
}

const poll = () => send({ t: 'signin.get' });
poll();
setInterval(poll, 500);
