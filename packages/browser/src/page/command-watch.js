/*
 * A hook's side of telling a silent page apart (packages/browser/src/silence.ts). Not a file of the extension: the
 * copy step (markers.ts) puts it in place of a hook's `include command-watch` marker, after main-world.js, inside the
 * hook's own function. It defines commandWatch({ post, log, name }), which a hook calls once, at document_start, after
 * cloak.once():
 *
 *   const watch = commandWatch({ post, log, name: (cmd) => '…' });
 *   cloak.onDown((p) => {
 *     if (p.t !== 'cmd') return;
 *     const done = watch.take(p);   // says `got` at 'page'; answers `page.state` itself (then null)
 *     if (!done) return;
 *     run(p.cmd).then(reply, fail).finally(done);
 *   });
 *
 * take() tells the extractor the command arrived, and logs `<name> still open after 20 s` when it is. `page.state`
 * answers without the network: visibility, focus, lifecycle events seen, counts of uncaught errors and rejections, and
 * the commands still open with their ages. `name` gives a command's name for a log (default: its kind); it must leave
 * out bodies and ids. Each `log` call gets (level, text, data). A hook that has a `page.state` command of its own
 * passes `ownState: true`, answers it itself, and puts `watch.state()` in its answer.
 *
 * watchPath(path) is a path as a log may name it: segments with digits, or long ones, as `*`.
 */
function watchPath(path) {
  return String(path)
    .split('/')
    .map((s) => (/\d/.test(s) || s.length > 24 ? '*' : s))
    .join('/');
}

function commandWatch(o) {
  const SLOW_MS = o.slowMs || 20000; // tests make it shorter
  const post = o.post;
  const log = o.log;
  const nameOf = o.name || ((c) => String(c.kind));
  const W = window;
  const later = W.setTimeout || setTimeout;
  const stop = W.clearTimeout || clearTimeout;
  const now = Date.now;
  const open = new Map(); // command id -> { what, since, timer }
  const life = { events: [], errors: 0, rejections: 0, startedAt: now() };
  const doc = W.document;
  const visibility = () => {
    try {
      return doc.visibilityState;
    } catch (e) {
      return null;
    }
  };
  function lifeEvent(name) {
    life.events.push({ name, at: now() });
    if (life.events.length > 20) life.events.shift();
    log('info', `page ${name}`, { visibility: visibility() });
  }
  try {
    const listen = (W.EventTarget || EventTarget).prototype.addEventListener;
    if (doc) {
      listen.call(doc, 'visibilitychange', () => lifeEvent(visibility() === 'hidden' ? 'hidden' : 'visible'));
      listen.call(doc, 'freeze', () => lifeEvent('frozen'));
      listen.call(doc, 'resume', () => lifeEvent('resumed'));
    }
    listen.call(W, 'pagehide', (e) => lifeEvent(e && e.persisted ? 'hidden into the back-forward cache' : 'unloading'));
    listen.call(W, 'error', () => life.errors++);
    listen.call(W, 'unhandledrejection', () => life.rejections++);
  } catch (e) {}

  function state() {
    const t = now();
    let focused = null;
    try {
      focused = doc.hasFocus();
    } catch (e) {}
    return {
      visibility: visibility(),
      focused,
      wasDiscarded: !!(doc && doc.wasDiscarded),
      upMs: t - life.startedAt,
      errors: life.errors,
      rejections: life.rejections,
      open: Array.from(open.values(), (w) => ({ what: w.what, ms: t - w.since })),
      events: life.events.map((e) => ({ name: e.name, agoMs: t - e.at })),
    };
  }

  function take(p) {
    post({ t: 'got', id: p.id, at: 'page' });
    const c = p.cmd || {};
    if (c.kind === 'page.state' && !o.ownState) {
      post({ t: 'reply', id: p.id, ok: true, result: state() });
      return null;
    }
    let what;
    try {
      what = String(nameOf(c));
    } catch (e) {
      what = String(c.kind);
    }
    const work = { what, since: now(), timer: 0 };
    work.timer = later(() => log('warn', `${what} still open after ${SLOW_MS / 1000} s`, { visibility: visibility() }), SLOW_MS);
    open.set(p.id, work);
    return () => {
      stop(work.timer);
      open.delete(p.id);
    };
  }

  return { take, state };
}
