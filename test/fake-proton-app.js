/*
 * The stand-in Proton Mail web app the fake (fake-proton.ts) serves to the sandbox's Chromium: a webpack-style runtime
 * and chunks shaped like the live mail.proton.me bundle's (docs/proton.md, "The hook"), so the extension's hook meets
 * what it meets there:
 *
 *   - one runtime on `webpackChunkproton_mail`, whose module cache is private (no `__webpack_require__.c`), exports
 *     defined with `__webpack_require__.d` in its array form;
 *   - an index chunk with the CryptoProxy (over openpgp, served next to this), the thunk argument the store hands its
 *     thunks (`{ api, authentication, … }`, filled after sign-in as `extendStore` does), the thunk that picks an
 *     address's keys by usage, and the entry module, which signs in, opens the keys with the key password the page
 *     holds, makes a Redux-shaped store and puts it on a React-shaped root (`.app-root`'s `__reactContainer$…`);
 *   - a lazily loaded "MainContainer" chunk that exports only its component, as the live build has it (the composer's
 *     send functions are folded inside it there, and the hook does not look for them).
 *
 * `withhold` (the fake's option) hides the CryptoProxy or the keys-by-usage thunk one level down, where the hook's
 * finders do not look, to stand for a build where one of them moved. Written for this fake, not taken from Proton's
 * code; the names and argument shapes are Proton's, so the hook's finders can be tested.
 *
 * Its own API calls carry `x-fake-caller: page`, so the fake can tell the app's calls from the hook's.
 */
(() => {
  'use strict';
  const cfg = window.__fakeProton;
  const withheld = (name) => (cfg.withhold || []).includes(name);

  // ------------------------------------------------------------------ the runtime
  const factories = {};
  const cache = {};
  function req(id) {
    const hit = cache[id];
    if (hit !== undefined) return hit.exports;
    const module = (cache[id] = { id, loaded: false, exports: {} });
    factories[id].call(module.exports, module, module.exports, req);
    module.loaded = true;
    return module.exports;
  }
  req.m = factories;
  req.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  req.d = (exp, defs) => {
    if (Array.isArray(defs))
      for (let i = 0; i < defs.length; ) {
        const name = defs[i++];
        const how = defs[i++];
        const desc = how === 0 ? { enumerable: true, value: defs[i++] } : { enumerable: true, get: how };
        if (!req.o(exp, name)) Object.defineProperty(exp, name, desc);
      }
    else for (const k in defs) if (req.o(defs, k) && !req.o(exp, k)) Object.defineProperty(exp, k, { enumerable: true, get: defs[k] });
  };
  const installed = {};
  const loading = {};
  req.e = (chunk) =>
    new Promise((resolve, reject) => {
      if (installed[chunk] === 0) return resolve();
      loading[chunk] = resolve;
      const s = document.createElement('script');
      s.src = `/assets/static/${chunk}.js`;
      s.onerror = () => reject(new Error(`Loading chunk ${chunk} failed`));
      document.head.appendChild(s);
    });
  const onPush = (parent, data) => {
    const [ids, mods, run] = data;
    let out;
    if (ids.some((i) => installed[i] !== 0)) {
      for (const k in mods) if (req.o(mods, k)) req.m[k] = mods[k];
      if (run) out = run(req);
    }
    if (parent) parent(data);
    for (const i of ids) {
      if (loading[i]) {
        loading[i]();
        delete loading[i];
      }
      installed[i] = 0;
    }
    return out;
  };
  const list = (globalThis.webpackChunkproton_mail = globalThis.webpackChunkproton_mail || []);
  list.forEach(onPush.bind(null, 0));
  list.push = onPush.bind(null, list.push.bind(list));

  // ------------------------------------------------------------------ the index chunk
  const b64 = (u) => {
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  (globalThis.webpackChunkproton_mail = globalThis.webpackChunkproton_mail || []).push([
    ['index'],
    {
      // @protontech/crypto's CryptoProxy, over openpgp in this page (the real one talks to a worker).
      crypto(e, t, r) {
        const pgp = window.openpgp;
        const many = (k) => (k === undefined || k === null ? undefined : Array.isArray(k) ? k : [k]);
        const CryptoProxy = {
          setEndpoint() {},
          async releaseEndpoint() {},
          async encryptMessage({ textData, binaryData, encryptionKeys, signingKeys, sessionKey, format = 'armored', detached = false }) {
            const message = await pgp.createMessage(binaryData !== undefined ? { binary: binaryData } : { text: textData });
            const enc = { message, encryptionKeys: many(encryptionKeys), sessionKey, format: format === 'binary' ? 'binary' : 'armored' };
            if (detached) {
              const signature = signingKeys && many(signingKeys).length ? await pgp.sign({ message, signingKeys: many(signingKeys), detached: true, format: 'binary' }) : undefined;
              return { message: await pgp.encrypt(enc), signature };
            }
            return { message: await pgp.encrypt({ ...enc, signingKeys: many(signingKeys) }) };
          },
          async decryptMessage({ armoredMessage, binaryMessage, decryptionKeys, sessionKeys, format = 'utf8' }) {
            const message = armoredMessage !== undefined ? await pgp.readMessage({ armoredMessage }) : await pgp.readMessage({ binaryMessage });
            const r = await pgp.decrypt({ message, decryptionKeys: many(decryptionKeys), sessionKeys: many(sessionKeys), format: format === 'binary' ? 'binary' : 'utf8' });
            return { data: r.data, signatures: [], verificationStatus: 0 };
          },
          async generateSessionKey({ recipientKeys }) {
            return pgp.generateSessionKey({ encryptionKeys: many(recipientKeys) });
          },
          async generateSessionKeyForAlgorithm() {
            return crypto.getRandomValues(new Uint8Array(32));
          },
          async encryptSessionKey({ data, algorithm, encryptionKeys, format = 'armored' }) {
            return pgp.encryptSessionKey({ data, algorithm, encryptionKeys: many(encryptionKeys), format: format === 'binary' ? 'binary' : 'armored' });
          },
          async decryptSessionKey({ armoredMessage, binaryMessage, decryptionKeys }) {
            const message = armoredMessage !== undefined ? await pgp.readMessage({ armoredMessage }) : await pgp.readMessage({ binaryMessage });
            const [sk] = await pgp.decryptSessionKeys({ message, decryptionKeys: many(decryptionKeys) });
            return sk;
          },
          async importPublicKey({ armoredKey }) {
            const key = await pgp.readKey({ armoredKey });
            // PublicKeyReference's own: the key's version.
            key.getVersion = () => key.keyPacket.version;
            return key;
          },
          async canKeyEncrypt({ key, date }) {
            try {
              await key.getEncryptionKey(undefined, date);
              return true;
            } catch (err) {
              return false;
            }
          },
          async exportPublicKey({ key }) {
            return key.toPublic().armor();
          },
        };
        r.d(t, ['K', 0, withheld('CryptoProxy') ? { inner: CryptoProxy } : CryptoProxy]);
      },
      // The thunk argument (extraThunkArguments): empty until the app has signed in.
      extra(e, t, r) {
        r.d(t, ['J', 0, {}]);
      },
      // The address keys the app opened, by address id (the real app keeps them in its store).
      keyring(e, t, r) {
        r.d(t, ['k', 0, new Map()]);
      },
      // getAddressKeysByUsageThunk.
      keysByUsage(e, t, r) {
        const ring = r('keyring').k;
        const getAddressKeysByUsageThunk = (e) => {
          const { withV6SupportForEncryption: v6e, withV6SupportForSigning: v6s, AddressID: id } = e;
          return async () => {
            void v6e;
            void v6s;
            const keys = ring.get(id);
            if (!keys || !keys.length) throw new Error('No keys for that address');
            return { encryptionKey: keys[0], signingKeys: [keys[0]], decryptionKeys: keys.slice() };
          };
        };
        r.d(t, ['D', 0, withheld('AddressKeysByUsage') ? { inner: getAddressKeysByUsageThunk } : getAddressKeysByUsageThunk]);
      },
      // The app: sign-in bootstrap, the API caller, the store and its root, the event loop, then the main chunk.
      entry(e, t, r) {
        const extra = r('extra').J;
        const ring = r('keyring').k;
        // The app's bootstrap imports these and so runs them (it gives the crypto proxy its worker): whatever the hook
        // records, it records as they run.
        r('crypto');
        r('keysByUsage');
        const H = { accept: cfg.accept, 'x-pm-appversion': cfg.appVersion, 'x-pm-uid': cfg.UID, 'x-pm-locale': 'en_US', 'x-fake-caller': 'page' };
        let refreshing = null;
        async function raw(path, init) {
          const go = () => fetch('/api/' + path, { headers: H, credentials: 'include', mode: 'cors', ...(init || {}) });
          let res = await go();
          if (res.status === 401) {
            refreshing =
              refreshing ||
              fetch('/api/auth/refresh', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ ResponseType: 'token', GrantType: 'refresh_token', RefreshToken: '', RedirectURI: 'https://protonmail.com' }) }).finally(() =>
                setTimeout(() => (refreshing = null), 100),
              );
            const rr = await refreshing;
            if (!rr.ok) {
              localStorage.removeItem('ps-' + cfg.localID);
              location.href = '/login';
              throw new Error('signed out');
            }
            res = await go();
          }
          return res;
        }
        // The app's API caller: { method, url, params, data, input } as createApi takes them.
        async function api({ method = 'get', url, params, data, input }) {
          const u = new URL('/api/' + url, location.origin);
          for (const [k, v] of Object.entries(params || {})) if (v !== undefined) u.searchParams.append(k, String(v));
          let body;
          const headers = {};
          if (data !== undefined && input === 'form') {
            body = new FormData();
            for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) body.append(k, v instanceof Blob ? v : String(v));
          } else if (data !== undefined) {
            body = JSON.stringify(data);
            headers['content-type'] = 'application/json;charset=utf-8';
          }
          const res = await raw(u.pathname.slice(5) + u.search, { method: method.toUpperCase(), headers: { ...H, ...headers }, body });
          const text = await res.text();
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (err) {}
          if (!res.ok || (json && json.Code && json.Code !== 1000 && json.Code !== 1001)) throw Object.assign(new Error((json && json.Error) || `HTTP ${res.status}`), { status: res.status, data: json });
          return json;
        }

        const state = {
          addresses: { value: null },
          mailSettings: { value: { AutoSaveContacts: 1, DelaySendSeconds: 0, Sign: 0, PGPScheme: 16, DraftMIMEType: 'text/html', AttachPublicKey: 0 } },
          mailContacts: { contactsMap: {} },
        };
        const store = {
          getState: () => state,
          subscribe: () => () => {},
          replaceReducer() {},
          dispatch: (action) => (typeof action === 'function' ? action(store.dispatch, store.getState, extra) : action),
        };

        async function openKeys() {
          const pgp = window.openpgp;
          const { User } = await api({ url: 'core/v4/users' });
          const { Addresses } = await api({ url: 'core/v4/addresses', params: { Page: 0, PageSize: 50 } });
          const userKey = await pgp.decryptKey({ privateKey: await pgp.readPrivateKey({ armoredKey: User.Keys[0].PrivateKey }), passphrase: cfg.keyPassword });
          for (const a of Addresses) {
            const keys = [];
            for (const k of a.Keys) {
              let pass = cfg.keyPassword;
              if (k.Token) pass = (await pgp.decrypt({ message: await pgp.readMessage({ armoredMessage: k.Token }), decryptionKeys: userKey })).data;
              keys.push(await pgp.decryptKey({ privateKey: await pgp.readPrivateKey({ armoredKey: k.PrivateKey }), passphrase: pass }));
            }
            ring.set(a.ID, keys);
          }
          // As the app's store has them: with their keys' metadata (the hook reads only Flags, Primary, Fingerprint).
          state.addresses.value = Addresses.map((a) => ({ ...a, HasKeys: a.Keys.length ? 1 : 0 }));
        }

        (async () => {
          await openKeys();
          Object.assign(extra, { api, authentication: { getUID: () => cfg.UID, getLocalID: () => cfg.localID, getPassword: () => cfg.keyPassword }, config: { APP_NAME: 'proton-mail', APP_VERSION: cfg.appVersion } });
          // React 18's createRoot(container): the HostRoot fiber on the container, the store provider under it.
          const root = document.querySelector('.app-root');
          root['__reactContainer$' + Math.random().toString(36).slice(2)] = {
            tag: 3,
            child: { tag: 0, memoizedProps: { store, children: null }, sibling: null, child: { tag: 10, memoizedProps: { value: { store }, children: null }, sibling: null, child: null } },
            sibling: null,
          };
          let id = (await (await raw('core/v4/events/latest')).json()).EventID;
          setInterval(async () => {
            try {
              const res = await raw('core/v5/events/' + encodeURIComponent(id) + '?ConversationCounts=1&MessageCounts=1');
              if (res.ok) id = (await res.json()).EventID || id;
            } catch (err) {}
          }, cfg.pagePollMs);
          await r.e('main');
          r('main');
        })();
        history.replaceState(null, '', location.pathname + '?page=secret-query#secret-hash');
      },
    },
    (r) => r('entry'),
  ]);
})();
