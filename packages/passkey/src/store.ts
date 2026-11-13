/**
 * The passkeys in an account's secret.json: `{ passkeys: StoredCredential[], … }`, written whole by the link (tmp
 * file, fsync, rename, mode 600; the last good copy as secret.json.bak), the rest of the file kept as it is.
 */
import { type PasskeyStore, validCredentials } from './authenticator.ts';

/** What of the extractor's link this needs (@dither-accounts/link's Link has both). */
export interface SecretFile {
  secret<T = Record<string, unknown>>(): T;
  saveSecret(value: unknown): void;
}

export function secretStore(link: SecretFile): PasskeyStore {
  return {
    load: () => validCredentials(link.secret<{ passkeys?: unknown }>().passkeys),
    save: (creds) => link.saveSecret({ ...link.secret<Record<string, unknown>>(), passkeys: creds }),
  };
}
