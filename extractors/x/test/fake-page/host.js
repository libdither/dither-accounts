/*
 * The fake x-web host: its own React copy (as x.com's host app has), a layout, and on /i/chat the XChat embed's
 * "route" surface, loaded at run time from the embed's own module (as x.com loads it through Module Federation).
 * Around it, as x.com's signed-in client does, react-redux's Provider: the store (made by the responsive-web main chunk,
 * rw-main.js) in a context value `{ store, subscription }`.
 * Bundled by test/fake-x.ts with Bun.build.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';

const h = React.createElement;

function navigateToPath(path, replace) {
  history[replace ? 'replaceState' : 'pushState'](history.state, '', path);
  dispatchEvent(new Event('x-nav'));
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

function ChatSurface() {
  const ref = React.useRef(null);
  React.useEffect(() => {
    let surface = null;
    let gone = false;
    import(window.__EMBED__).then(async (m) => {
      const instance = await m.start({ userId: window.__FAKE_USER__, navigateToPath, base: '/i/chat' });
      if (!gone) surface = instance.render('route', ref.current, {});
    });
    return () => {
      gone = true;
      surface && surface.unmount();
    };
  }, []);
  return h('div', { ref, 'data-testid': 'xchat-route', style: { height: '100%' } });
}

function App() {
  const path = usePath();
  const onChat = path === '/i/chat' || path.startsWith('/i/chat/');
  return h(
    'div',
    { id: 'layout', style: { display: 'flex', height: '100vh' } },
    h('nav', { 'aria-label': 'Primary', style: { width: 80 } }, h('a', { href: '/home', 'data-testid': 'AppTabBar_Home_Link' }, 'Home')),
    h('main', { style: { flex: 1 } }, onChat ? h(ChatSurface) : h('div', { 'data-testid': 'primaryColumn' }, 'Home timeline')),
  );
}

const ReactReduxContext = React.createContext(null);
function Provider({ store, children }) {
  const value = React.useMemo(() => ({ store, subscription: { trySubscribe() {}, tryUnsubscribe() {}, getListenersCount: () => 0 }, getServerState: undefined }), [store]);
  return h(ReactReduxContext.Provider, { value }, children);
}

const store = self.__FAKE_STORE__;
createRoot(document.getElementById('react-root')).render(store ? h(Provider, { store }, h(App)) : h(App));
