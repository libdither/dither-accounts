/**
 * Proton's keys and messages, opened with openpgp (docs/proton.md, "Keys" and "Messages"). Written from the formats;
 * no Proton code is copied.
 *
 * - User keys (`GET core/v4/users` → User.Keys[].PrivateKey, armored) are locked with the key password itself. The
 *   first (primary) one must open, or nothing does.
 * - Address keys (`GET core/v4/addresses` → Addresses[].Keys[]) are locked with a passphrase that is, for every account
 *   made or migrated since 2021, `Token`: an armored message encrypted to the user key, whose detached `Signature`
 *   (also armored) by the user key must verify. Without a Token (a legacy account) the passphrase is the key password.
 *   `Activation` (a key an organisation made for you, not yet activated) is a message encrypted and signed by the user
 *   key whose text is the passphrase.
 * - A message body (`Message.Body`) is one armored message encrypted to an address key; its MIMEType says whether the
 *   text is HTML, plain text, or a whole MIME message (multipart/mixed: PGP/MIME, with its own parts).
 * - An attachment is two halves: `KeyPackets` (base64, from the message) holds the session key encrypted to the
 *   address key, and `GET mail/v4/attachments/<id>` answers the data packet. Together they are one OpenPGP message.
 *
 * Signatures on bodies and attachments are not checked: this reads mail, it does not vouch for who wrote it.
 * Keys and passwords stay in this process's memory; nothing here writes or logs them.
 */
import * as openpgp from 'openpgp';

/** For the tests and the fake, which live outside this package. */
export { openpgp };

/** What old Proton keys need to open: messages from 2015–16 encrypted to signing-only RSA keys, keys reformatted on
 * import, 1024-bit RSA, any curve. The same settings Proton's own client runs with. */
export const COMPAT: openpgp.PartialConfig = {
  allowInsecureDecryptionWithSigningKeys: true,
  allowInsecureVerificationWithReformattedKeys: true,
  rejectPublicKeyAlgorithms: new Set(),
  rejectCurves: new Set(),
  minRSABits: 1023,
  enableParsingV5Entities: true,
};

export interface ProtonKey {
  ID: string;
  PrivateKey: string;
  Primary?: number;
  Active?: number;
  Flags?: number;
  Token?: string | null;
  Signature?: string | null;
  Activation?: string | null;
}
export interface ProtonUser {
  ID: string;
  Name?: string | null;
  DisplayName?: string | null;
  Email?: string | null;
  Keys: ProtonKey[];
  OrganizationPrivateKey?: string | null;
}
export interface ProtonAddress {
  ID: string;
  Email: string;
  DisplayName?: string | null;
  Status?: number;
  Receive?: number;
  Send?: number;
  Order?: number;
  Type?: number;
  Keys: ProtonKey[];
}

export interface AddressKeys {
  id: string;
  email: string;
  displayName: string | null;
  /** Opened keys, primary first. */
  keys: openpgp.PrivateKey[];
  /** The primary key's public half, for sending. */
  primary: openpgp.PrivateKey | null;
}

export interface Unlocked {
  user: openpgp.PrivateKey[];
  addresses: AddressKeys[];
  /** Every opened address key (and the user keys last), for decrypting anything sent to any address. */
  all: openpgp.PrivateKey[];
  /** Counts only, for the status: never which key. */
  counts: { userKeys: number; userOpened: number; addressKeys: number; addressOpened: number; addresses: number };
}

export class KeyError extends Error {}

async function openKey(armored: string, passphrase: string): Promise<openpgp.PrivateKey> {
  const key = await openpgp.readPrivateKey({ armoredKey: armored, config: COMPAT });
  return key.isDecrypted() ? key : openpgp.decryptKey({ privateKey: key, passphrase, config: COMPAT });
}

/** An address key's passphrase, by the rules above. */
async function addressPassphrase(k: ProtonKey, user: openpgp.PrivateKey[], keyPassword: string): Promise<string> {
  const pubs = user.map((u) => u.toPublic());
  if (k.Activation) {
    const r = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: k.Activation }), decryptionKeys: user, verificationKeys: pubs, expectSigned: true, config: COMPAT });
    return String(r.data);
  }
  if (k.Token) {
    if (!k.Signature) throw new KeyError('an address key has a token but no signature (an organisation-managed key)');
    const r = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: k.Token }),
      signature: await openpgp.readSignature({ armoredSignature: k.Signature }),
      decryptionKeys: user,
      verificationKeys: pubs,
      expectSigned: true,
      config: COMPAT,
    });
    return String(r.data);
  }
  return keyPassword;
}

/**
 * Open the user keys with the key password, then every address's keys. A key that does not open is skipped (as
 * Proton's client does), except the primary user key: without it nothing opens, and this throws.
 */
export async function unlockKeys(user: ProtonUser, addresses: ProtonAddress[], keyPassword: string): Promise<Unlocked> {
  if (user.OrganizationPrivateKey) throw new KeyError('this is an organisation-managed (non-private) account; its keys open with the organisation key, which this does not do');
  const keys = user.Keys ?? [];
  if (!keys.length) throw new KeyError('the account has no user keys');
  const opened: openpgp.PrivateKey[] = [];
  try {
    opened.push(await openKey(keys[0].PrivateKey, keyPassword));
  } catch (e) {
    throw new KeyError(`the key password did not open the primary user key (${short(e)})`);
  }
  for (const k of keys.slice(1)) {
    try {
      opened.push(await openKey(k.PrivateKey, keyPassword));
    } catch {}
  }
  const out: AddressKeys[] = [];
  let addressKeys = 0;
  let addressOpened = 0;
  for (const a of addresses) {
    const ordered = [...(a.Keys ?? [])].sort((x, y) => (y.Primary ?? 0) - (x.Primary ?? 0));
    const got: openpgp.PrivateKey[] = [];
    let primary: openpgp.PrivateKey | null = null;
    for (const k of ordered) {
      addressKeys++;
      try {
        const key = await openKey(k.PrivateKey, await addressPassphrase(k, opened, keyPassword));
        got.push(key);
        addressOpened++;
        if (k.Primary === 1 && !primary) primary = key;
      } catch {}
    }
    out.push({ id: a.ID, email: a.Email, displayName: a.DisplayName || null, keys: got, primary: primary ?? got[0] ?? null });
  }
  return {
    user: opened,
    addresses: out,
    all: [...out.flatMap((a) => a.keys), ...opened],
    counts: { userKeys: keys.length, userOpened: opened.length, addressKeys, addressOpened, addresses: addresses.length },
  };
}

const short = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 120);

/** A message body: its bytes, opened with whichever address key it was encrypted to. */
export async function decryptBody(armored: string, keys: openpgp.PrivateKey[]): Promise<Uint8Array> {
  const message = await openpgp.readMessage({ armoredMessage: armored, config: COMPAT });
  const r = await openpgp.decrypt({ message, decryptionKeys: keys, format: 'binary', config: COMPAT });
  return r.data as Uint8Array;
}

/** An attachment: its key packets (base64) and data packet, as one message. */
export async function decryptAttachment(keyPackets: string, data: Uint8Array, keys: openpgp.PrivateKey[]): Promise<Uint8Array> {
  const kp = Buffer.from(keyPackets, 'base64');
  const binary = new Uint8Array(kp.length + data.length);
  binary.set(kp, 0);
  binary.set(data, kp.length);
  const message = await openpgp.readMessage({ binaryMessage: binary, config: COMPAT });
  const r = await openpgp.decrypt({ message, decryptionKeys: keys, format: 'binary', config: COMPAT });
  return r.data as Uint8Array;
}

/**
 * What opens a message: bodies and attachments, by the address they were sent to. Either the keys opened here from the
 * saved session (localDecryptor), or the Mail page's own crypto proxy with the app's own keys (main.ts, when the session
 * unlock fails). Errors that are not StatusErrors mean "no key opened it".
 */
export interface Decryptor {
  /** 'session': keys opened here; 'page': the page's crypto proxy. */
  readonly path: 'session' | 'page';
  body(armored: string, addressID?: string): Promise<Uint8Array>;
  attachment(keyPackets: string, data: Uint8Array, addressID?: string): Promise<Uint8Array>;
}

/** The keys opened here: every address key (and the user keys) tried, as openpgp picks the one a message names. */
export function localDecryptor(u: Unlocked): Decryptor & { unlocked: Unlocked } {
  return { path: 'session', unlocked: u, body: (armored) => decryptBody(armored, u.all), attachment: (kp, data) => decryptAttachment(kp, data, u.all) };
}

/** Proton's text: UTF-8, with CRLF made LF (as its client shows it). */
export const bodyText = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\r\n/g, '\n');
