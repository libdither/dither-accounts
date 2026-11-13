/*
 * Privacy's hook: navigator.credentials, PublicKeyCredential's statics, fetch and XMLHttpRequest read as the natives;
 * when the extractor refuses, the page gets Chromium's own WebAuthn errors; a request the hook cannot read is the
 * browser's to refuse, as it would without the hook.
 */
(async () => {
  const { P, check, native, throwsLikeNative, finish } = PROBE;
  const CC = CredentialsContainer.prototype;
  for (const k of ['create', 'get']) native(`CredentialsContainer.prototype.${k}`, CC, P().CredentialsContainer.prototype, k);
  for (const k of ['isUserVerifyingPlatformAuthenticatorAvailable', 'getClientCapabilities']) if (typeof P().PublicKeyCredential[k] === 'function') native(`PublicKeyCredential.${k}`, PublicKeyCredential, P().PublicKeyCredential, k);
  native('fetch', window, P(), 'fetch');
  for (const k of ['open', 'setRequestHeader', 'send']) native(`XMLHttpRequest.prototype.${k}`, XMLHttpRequest.prototype, P().XMLHttpRequest.prototype, k);
  throwsLikeNative(
    'XMLHttpRequest open, bad method',
    () => new XMLHttpRequest().open('bad method', '/'),
    () => new (P().XMLHttpRequest)().open('bad method', '/'),
  );
  check('a platform authenticator, it says', (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) === true);

  const err = (p) => p.then(() => null, (e) => e);
  // The test's extractor refuses a get (NotAllowedError) and a create (InvalidStateError).
  const got = await err(navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), userVerification: 'preferred' } }));
  check('a refused get: DOMException NotAllowedError', got instanceof DOMException && got.name === 'NotAllowedError', got && [got.name, got.message]);
  check('a refused get: Chromium’s message', !!got && got.message === 'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.', got && got.message);
  const made = await err(
    navigator.credentials.create({
      publicKey: { rp: { id: location.hostname, name: 'probe' }, user: { id: new Uint8Array(8), name: 'p', displayName: 'p' }, challenge: new Uint8Array(32), pubKeyCredParams: [{ type: 'public-key', alg: -7 }] },
    }),
  );
  check('a refused create: DOMException InvalidStateError', made instanceof DOMException && made.name === 'InvalidStateError', made && [made.name, made.message]);
  check('a refused create: Chromium’s message', !!made && made.message === 'The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.', made && made.message);
  // Not a request the hook can read: the browser's own create refuses it, with its own words.
  const bad = await err(navigator.credentials.create({ publicKey: { challenge: new Uint8Array(4) } }));
  const pbad = await err(P().navigator.credentials.create({ publicKey: { challenge: new Uint8Array(4) } }));
  check('a malformed create: what the browser throws', !!bad && !!pbad && bad.name === pbad.name && bad.message === pbad.message, bad && [bad.name, bad.message, pbad && pbad.message]);
  await finish();
})();
