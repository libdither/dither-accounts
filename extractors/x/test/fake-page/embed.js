/*
 * The fake XChat embed: its own React copy, drawn into an open shadow root, holding the Kotlin core's objects the way
 * the real embed does (docs/x.md): the object graph in a context provider, the inbox's conversation list component
 * and the open conversation's DM component made in useMemo as { component, cancellation }, a container provider per
 * conversation, state followed through the flows' subscribe, and, like the real UI, whatever is on screen reported as
 * read (VisibleReadableItemsChanged) from an effect. The PIN screen is /i/chat/pin/<mode>, as X's.
 * Bundled by test/fake-x.ts with Bun.build; the core is imported at run time from its own module.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';

const h = React.createElement;
const GraphContext = React.createContext(null);
const ContainerContext = React.createContext(null);

export const contractVersion = 1;
export function preload() {}

function useFlow(flow) {
  const [value, setValue] = React.useState(() => (flow ? flow.state : null));
  React.useEffect(() => {
    if (!flow) return undefined;
    const s = flow.subscribe((v) => setValue(v));
    return () => s.cancel();
  }, [flow]);
  return value;
}

function usePath() {
  const [path, setPath] = React.useState(location.pathname);
  React.useEffect(() => {
    const f = () => setPath(location.pathname);
    addEventListener('popstate', f);
    addEventListener('x-nav', f);
    return () => {
      removeEventListener('popstate', f);
      removeEventListener('x-nav', f);
    };
  }, []);
  return path;
}

function PinScreen({ host, mode }) {
  const graph = React.useContext(GraphContext);
  const { component } = React.useMemo(() => ({ component: graph.dmPinEntryComponent(null, undefined, null, { cancel() {} }) }), [graph]);
  React.useEffect(() => {
    const t = setInterval(async () => {
      const r = await fetch('/__fake/api/keys', { credentials: 'include' }).then((x) => x.json());
      if (r.unlocked) host.navigateToPath(host.base, true);
    }, 500);
    return () => clearInterval(t);
  }, [host]);
  return h('div', { 'data-testid': 'pin-code-input-container' }, h('h1', { 'data-testid': 'pin-title' }, `Enter your passcode (${mode})`), h('input', { type: 'password', inputMode: 'numeric', 'aria-label': 'PIN', key: component ? 'pin' : 'none' }));
}

/** A conversation id in a path, as x.com writes it: its ':' as '-' (the client's own toConversation). */
const pathId = (id) => id.replaceAll(':', '-');
/** And back: the conversation the store has under that path, else a new one-to-one (`a:b`) nobody has written in. */
function convOfPath(graph, seg) {
  for (const id of graph.a2k_1.convs.keys()) if (id === seg || pathId(id) === seg) return id;
  return /^\d+-\d+$/.test(seg) ? seg.replace('-', ':') : seg;
}
function cancellation() {
  let f = null;
  return {
    subscribe(cb) {
      f = cb;
    },
    cancel() {
      f && f();
    },
  };
}

/** The Requests page (/i/chat/requests): the message requests component the core makes for it, its rows and buttons. */
function Requests({ host }) {
  const graph = React.useContext(GraphContext);
  const { component, cancel } = React.useMemo(() => {
    const c = cancellation();
    const callbacks = {
      onConversationCtaActivated: (cid) => host.navigateToPath(`${host.base}/requests/${pathId(cid.id)}`),
      onLinkClicked() {},
      onOtherClicked() {},
    };
    return { component: graph[window.__REQUESTS_FACTORY__ || 'messageRequestsComponent'](callbacks, c, false), cancel: c };
  }, [graph, host]);
  React.useEffect(() => () => cancel.cancel(), [cancel]);
  const st = useFlow(component.state);
  const previews = st ? st.previews.asJsReadonlyArrayView() : [];
  return h(
    'div',
    { 'data-testid': 'dm-message-requests', style: { width: 320, float: 'left' } },
    h('h2', null, 'Message requests'),
    previews.map((p) => h('div', { key: p.conversationId.id, role: 'option' }, p.conversationId.id)),
  );
}

function Inbox({ host, core }) {
  const graph = React.useContext(GraphContext);
  const { component } = React.useMemo(() => {
    const cancellation = { cancel() {} };
    const callbacks = {
      onConversationClicked: (cid) => host.navigateToPath(`${host.base}/${pathId(cid.id)}`),
      onLocalKeysMissing: () => host.navigateToPath(`${host.base}/pin/verify`, true),
    };
    return { component: graph.conversationListComponent(callbacks, cancellation, false), cancellation };
  }, [graph, host]);
  const st = useFlow(component.state);
  const previews = st ? st.previews.asJsReadonlyArrayView() : [];
  return h(
    'div',
    { 'data-testid': 'dm-inbox-panel', style: { width: 320, float: 'left' } },
    h('h2', { 'data-testid': 'dm-inbox-title' }, 'Chat'),
    h(
      'div',
      { 'data-testid': 'dm-conversation-list', role: 'listbox' },
      previews.map((p) =>
        h('div', { key: p.conversationId.id, role: 'option', onClick: () => component.onEvent(new core.ConversationListEvent.RowClicked(p)) }, p.metadata.metadata.attributes.customTitle || p.conversationId.id),
      ),
    ),
  );
}

function DmPane({ host, core }) {
  const container = React.useContext(ContainerContext);
  const { component } = React.useMemo(() => {
    const cancellation = { cancel() {} };
    const callbacks = { onFinished: () => host.navigateToPath(host.base), onNoLocalKeypair: () => host.navigateToPath(`${host.base}/pin/verify`, true) };
    return { component: container.dmComponent(callbacks, cancellation, null, null), cancellation };
  }, [container, host]);
  const st = useFlow(component.state);
  const comp = useFlow(component.composer.state);
  const items = st ? st.chatItems.items.asJsReadonlyArrayView() : [];
  React.useEffect(() => {
    component.onEvent(core.DmEvent.UiShown);
  }, [component, core]);
  // As the real UI: what is on screen counts as read.
  const seqs = items.filter((i) => 'sequenceNumberForReadState' in i).map((i) => i.sequenceNumberForReadState);
  const last = seqs.length ? String(seqs[seqs.length - 1]) : '';
  React.useEffect(() => {
    if (seqs.length) component.onEvent(new core.DmEvent.VisibleReadableItemsChanged(true, core.KtList.fromJsArray(seqs)));
  }, [component, core, last]);
  return h(
    'div',
    { 'data-testid': 'dm-conversation-panel', style: { marginLeft: 330 } },
    h('div', { 'data-testid': 'dm-message-list' }, items.map((it, i) => ('textContent' in it ? h('div', { key: it.id }, it.textContent || '') : h('hr', { key: `sep${i}` })))),
    h(
      'form',
      { 'data-testid': 'dm-composer-form', onSubmit: (e) => e.preventDefault() },
      h('input', {
        type: 'file',
        'data-testid': 'dm-composer-file-input',
        onChange: (e) => {
          for (const f of e.target.files) component.composer.onEvent(new core.ChatComposerEvent.OnFileAttached({ name: f.name, mime: f.type, size: f.size, blobUrl: URL.createObjectURL(f) }));
        },
      }),
      h('textarea', { value: comp ? comp.text : '', onChange: (e) => component.composer.onEvent(new core.ChatComposerEvent.UserChangedText(e.target.value, e.target.value.length)) }),
    ),
  );
}

function Conversation({ host, core, convId }) {
  const graph = React.useContext(GraphContext);
  const container = React.useMemo(() => graph.convComponentContainer(convId), [graph, convId]);
  React.useEffect(() => () => queueMicrotask(() => container.dispose()), [container]);
  return h(ContainerContext.Provider, { value: container }, h(DmPane, { host, core, key: convId }));
}

function Route({ host, core }) {
  const graph = React.useContext(GraphContext);
  const path = usePath();
  const rest = path.startsWith(host.base) ? path.slice(host.base.length) : path;
  const [keys, setKeys] = React.useState(null);
  React.useEffect(() => {
    fetch('/__fake/api/keys', { credentials: 'include' })
      .then((r) => r.json())
      .then((r) => setKeys(r.unlocked));
  }, [path]);
  React.useEffect(() => {
    if (keys === false && !rest.startsWith('/pin/')) host.navigateToPath(`${host.base}/pin/verify`, true);
  }, [keys, rest, host]);
  if (rest.startsWith('/pin/')) return h(PinScreen, { host, mode: rest.split('/')[2] || '' });
  if (keys !== true) return h('div', { 'data-testid': 'dm-loading' }, 'Loading');
  const parts = rest.split('/').filter(Boolean);
  const requests = parts[0] === 'requests';
  if (requests) parts.shift();
  const conv = parts.length ? convOfPath(graph, decodeURIComponent(parts[0])) : null;
  return h(
    'div',
    null,
    requests ? h(Requests, { host }) : h(Inbox, { host, core }),
    conv ? h(Conversation, { host, core, convId: conv, key: conv }) : h('div', { 'data-testid': 'dm-empty-conversation-state' }, 'Select a message'),
  );
}

export async function start(host) {
  const mod = await import(window.__DM_CORE__);
  // The embed knows its own imports; the hook does not, and finds them otherwise.
  const core = { WebDmObjectGraph: mod.a, DmEvent: mod.b, ChatComposerEvent: mod.c || window.__FAKE_COMPOSER__, ConversationListEvent: mod.d, KtList: mod.e };
  const graph = new core.WebDmObjectGraph(host.userId);
  return {
    update() {},
    render(kind, el) {
      const shadow = el.shadowRoot || el.attachShadow({ mode: 'open' });
      const div = document.createElement('div');
      shadow.appendChild(div);
      const root = createRoot(div);
      root.render(h(GraphContext.Provider, { value: graph }, h(Route, { host, core })));
      return {
        update() {},
        unmount() {
          root.unmount();
        },
      };
    },
  };
}
