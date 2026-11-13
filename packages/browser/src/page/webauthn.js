/*
 * A hook's passkey (docs/passkeys.md). Not a file of the extension: the copy step (packages/browser/src/markers.ts)
 * puts it in place of a hook.js's `include webauthn` marker, inside the hook's own function and after main-world.js
 * (it uses `cloak`). It takes over navigator.credentials.create and .get for public-key requests and hands them, as
 * plain data, to the extractor (through content.js and the service worker, which adds the caller's origin and frames
 * as Chromium reports them: webauthn-worker.js). The extractor checks who asks and the rpId, makes or uses the key
 * and keeps it; the private key never comes into the page. What comes back is built into objects shaped like the
 * browser's own PublicKeyCredential.
 *
 *   - create (publicKey): answered by the extractor (that is how the site enrolls this browser's passkey).
 *   - get (publicKey, modal): answered when the extractor holds a credential the request allows; otherwise the
 *     browser's own get runs, as if this authenticator were not there.
 *   - get with mediation "conditional" (passkey autofill), and anything that is not a publicKey request (passwords,
 *     federated, OTP): the browser's own, untouched.
 *   - In a frame that the page's permissions policy does not let use passkeys (a cross-origin frame without
 *     allow="publickey-credentials-get" or "-create"), the browser's own call runs, and refuses as it would.
 *
 * It says it is a platform authenticator with user verification (isUserVerifyingPlatformAuthenticatorAvailable,
 * getClientCapabilities), so the site offers passkeys on this browser. When the extractor refuses, or does not answer
 * in time, it rejects as Chromium's own WebAuthn does (the same DOMException names and messages). A request it cannot
 * read is left to the browser's own create or get, which rejects it as it would.
 */
(() => {
  const CC = window.CredentialsContainer && window.CredentialsContainer.prototype;
  const PKC = window.PublicKeyCredential;
  if (!CC || !PKC) return;
  const nativeCreate = CC.create;
  const nativeGet = CC.get;
  const btoa_ = window.btoa.bind(window);
  const atob_ = window.atob.bind(window);
  const ANSWER_MS = 60000;
  const pending = new Map();
  let seq = 0;

  cloak.onDown((p) => {
    if (p && p.t === 'webauthn.answer' && pending.has(p.id)) {
      const settle = pending.get(p.id);
      pending.delete(p.id);
      settle(p);
    }
  });

  // ------------------------------------------------------------ the frame's permissions policy
  let isTop = true;
  try {
    isTop = window.top === window;
  } catch (e) {
    isTop = false;
  }
  const policy = (() => {
    try {
      return document.featurePolicy || null;
    } catch (e) {
      return null;
    }
  })();
  /** Whether this frame may use passkeys at all, as Chromium's permissions policy says (the top frame always may). */
  function allowed(feature) {
    if (isTop || !policy) return true;
    try {
      if (typeof policy.features === 'function' && policy.features().indexOf(feature) < 0) return true;
      return policy.allowsFeature(feature) !== false;
    } catch (e) {
      return true;
    }
  }

  // ------------------------------------------------------------ bytes
  function bytes(v, what) {
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    throw new TypeError(`${what} is not a BufferSource`);
  }
  function enc(v, what) {
    const b = bytes(v, what);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa_(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function dec(s) {
    const t = atob_(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(s).length % 4)) % 4));
    const b = new Uint8Array(t.length);
    for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
    return b.buffer;
  }
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const descriptors = (list, what) => (Array.isArray(list) ? list : []).map((d) => ({ type: str(d && d.type), id: enc(d && d.id, what) }));

  // ------------------------------------------------------------ requests, as plain data
  function createRequest(pk) {
    if (!pk.rp || !pk.user) throw new TypeError('rp and user are required');
    const sel = pk.authenticatorSelection || {};
    return {
      rp: { id: str(pk.rp.id), name: str(pk.rp.name) },
      user: { id: enc(pk.user.id, 'user.id'), name: str(pk.user.name), displayName: str(pk.user.displayName) },
      challenge: enc(pk.challenge, 'challenge'),
      pubKeyCredParams: (Array.isArray(pk.pubKeyCredParams) ? pk.pubKeyCredParams : []).map((p) => ({ type: str(p && p.type), alg: Number(p && p.alg) })),
      excludeCredentials: descriptors(pk.excludeCredentials, 'excludeCredentials[].id'),
      authenticatorSelection: { authenticatorAttachment: str(sel.authenticatorAttachment), residentKey: str(sel.residentKey), requireResidentKey: !!sel.requireResidentKey, userVerification: str(sel.userVerification) },
      attestation: str(pk.attestation),
      extensions: { credProps: !!(pk.extensions && pk.extensions.credProps) },
    };
  }
  function getRequest(pk) {
    return {
      rpId: str(pk.rpId),
      challenge: enc(pk.challenge, 'challenge'),
      allowCredentials: descriptors(pk.allowCredentials, 'allowCredentials[].id'),
      userVerification: str(pk.userVerification),
      extensions: {},
    };
  }

  // What Chromium's own WebAuthn rejects with (its messages, as Chromium 155 has them), by DOMException name.
  const NOT_ALLOWED = 'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.';
  const REFUSALS = {
    NotAllowedError: NOT_ALLOWED,
    InvalidStateError: 'The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.',
    NotSupportedError: 'None of the algorithms specified in `pubKeyCredParams` are supported by this device.',
    AbortError: 'Request has been aborted.',
  };
  const BAD_RP_ID = 'The relying party ID is not a registrable domain suffix of, nor equal to the current domain. Subsequently, an attempt to fetch the .well-known/webauthn resource of the claimed RP ID failed.';
  /** The extractor's refusal (its reason stays in its own log) as Chromium would have put it. */
  function refusal(code, why) {
    const name = typeof code === 'string' && (REFUSALS[code] || code === 'SecurityError') ? code : 'NotAllowedError';
    if (name === 'SecurityError') return new DOMException(/rpId/i.test(String(why || '')) ? BAD_RP_ID : 'This is an invalid domain.', name);
    return new DOMException(REFUSALS[name], name);
  }
  function abortError(signal) {
    return signal && signal.reason !== undefined ? signal.reason : new DOMException(REFUSALS.AbortError, 'AbortError');
  }

  function ask(op, options, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError(signal));
      const id = `p${++seq}.${Math.random().toString(36).slice(2)}`;
      const onAbort = () => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        reject(abortError(signal));
      };
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new DOMException(NOT_ALLOWED, 'NotAllowedError'));
      }, ANSWER_MS);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, (p) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (p.ok) resolve(p.result);
        else reject(refusal(p.code, p.error));
      });
      cloak.send({ t: 'webauthn', id, op, options });
    });
  }

  // ------------------------------------------------------------ answers, as PublicKeyCredential
  function def(o, props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      Object.defineProperty(o, k, { value: typeof v === 'function' ? cloak.native(v, k) : v, enumerable: true, configurable: true });
    }
    return o;
  }
  const clone = (v) => JSON.parse(JSON.stringify(v || {}));
  function credential(r, response) {
    return def(Object.create(PKC.prototype), {
      id: r.id,
      rawId: dec(r.id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response,
      getClientExtensionResults: () => clone(r.clientExtensionResults),
      toJSON: () => ({ id: r.id, rawId: r.id, type: 'public-key', authenticatorAttachment: 'platform', response: response.toJSON(), clientExtensionResults: clone(r.clientExtensionResults) }),
    });
  }
  function attestation(r) {
    const proto = window.AuthenticatorAttestationResponse ? window.AuthenticatorAttestationResponse.prototype : Object.prototype;
    const authData = dec(r.authenticatorData);
    const publicKey = dec(r.publicKey);
    const response = def(Object.create(proto), {
      clientDataJSON: dec(r.clientDataJSON),
      attestationObject: dec(r.attestationObject),
      getTransports: () => r.transports.slice(),
      getAuthenticatorData: () => authData.slice(0),
      getPublicKey: () => publicKey.slice(0),
      getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
      toJSON: () => ({ clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, transports: r.transports.slice(), publicKey: r.publicKey, publicKeyAlgorithm: r.publicKeyAlgorithm, attestationObject: r.attestationObject }),
    });
    return credential(r, response);
  }
  function assertion(r) {
    const proto = window.AuthenticatorAssertionResponse ? window.AuthenticatorAssertionResponse.prototype : Object.prototype;
    const response = def(Object.create(proto), {
      clientDataJSON: dec(r.clientDataJSON),
      authenticatorData: dec(r.authenticatorData),
      signature: dec(r.signature),
      userHandle: r.userHandle ? dec(r.userHandle) : null,
      toJSON: () => {
        const o = { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature };
        if (r.userHandle) o.userHandle = r.userHandle;
        return o;
      },
    });
    return credential(r, response);
  }

  // ------------------------------------------------------------ navigator.credentials
  // A request this cannot read (not what WebIDL would take), or one this frame may not make: the browser's own create
  // or get handles it, as it would.
  const patched = {
    create(options) {
      if (!options || !options.publicKey || !allowed('publickey-credentials-create')) return cloak.apply(nativeCreate, this, arguments);
      let req;
      try {
        req = createRequest(options.publicKey);
      } catch (e) {
        return cloak.apply(nativeCreate, this, arguments);
      }
      return ask('create', req, options.signal).then(attestation);
    },
    get(options) {
      if (!options || !options.publicKey || options.mediation === 'conditional' || !allowed('publickey-credentials-get')) return cloak.apply(nativeGet, this, arguments);
      let req;
      try {
        req = getRequest(options.publicKey);
      } catch (e) {
        return cloak.apply(nativeGet, this, arguments);
      }
      // No credential here for this request: the browser's own authenticators get their turn.
      return ask('get', req, options.signal).then((r) => (r && r.none ? cloak.apply(nativeGet, this, [options]) : assertion(r)));
    },
  };
  for (const name of ['create', 'get']) cloak.replace(CC, name, () => patched[name]);

  try {
    cloak.replace(PKC, 'isUserVerifyingPlatformAuthenticatorAvailable', () => ({ isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true) }).isUserVerifyingPlatformAuthenticatorAvailable);
  } catch (e) {}
  if (typeof PKC.getClientCapabilities === 'function') {
    try {
      cloak.replace(PKC, 'getClientCapabilities', (nativeCaps) => ({
        getClientCapabilities() {
          return Promise.resolve(cloak.apply(nativeCaps, PKC, []))
            .catch(() => ({}))
            .then((c) => Object.assign({}, c, { passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true }));
        },
      }).getClientCapabilities);
    } catch (e) {}
  }
})();
