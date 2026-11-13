/**
 * A passkey held by an extractor for one relying party's domains (docs/passkeys.md): the authenticator, its store in
 * the account's secret.json, and the answer to the page's request. The page and service-worker halves are
 * packages/browser/src/page/webauthn.js and webauthn-worker.js, put into a kind's hook.js and sw.js when its extension
 * is copied.
 */
export * from './approver.ts';
export * from './authenticator.ts';
export { type Cbor, decode, decodeFirst, encode } from './cbor.ts';
export { PasskeySignIn, refusalMessage, refusalNote, type SignInOpts, type StandingRefusal, type Trigger, type Try } from './signin.ts';
export { callerOf, respond, type Responded, type WebauthnAnswer, type WebauthnUp } from './respond.ts';
export { type SecretFile, secretStore } from './store.ts';
