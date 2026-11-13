/**
 * A Monero account's key images (docs/monero.md): the file the full wallet exports (Feather: Wallet → Advanced →
 * Export key images; CLI: export_key_images FILE), given to the account's own `monero.keyImages` here on its page, so
 * its view-only wallet sees what it spent. The page calls it as itself (POST /api/accounts/:id/call), behind the login;
 * no app needs monero.view for it. The file goes to the account's directory and its next pull imports it.
 */
import { useState } from 'preact/hooks';
import type { AccountInfo, PageCallResult } from '../../../src/api-types.ts';
import { api, toast } from '../state.ts';

const MAGIC = 'Monero key image export';

export function MoneroKeyImages({ a }: { a: AccountInfo }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const d = (a.status?.details ?? {}) as { keyImagesImported?: boolean; keyImagesWaiting?: boolean };
  const now = d.keyImagesWaiting ? 'Key images are stored; the next pull imports them.' : d.keyImagesImported ? 'Key images are imported: the wallet sees what it spent.' : 'No key images yet: the wallet sees what it received, not what it spent.';
  const send = async (e: Event) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (new TextDecoder('latin1').decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error(`That is not a key image export (it starts with "${MAGIC}")`);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await api<PageCallResult>(`/api/accounts/${a.id}/call`, { method: 'POST', body: { op: 'monero.keyImages', input: { base64: btoa(bin) } } });
      if (!r.ok) throw new Error(r.error?.message ?? 'the account did not take them');
      toast('Key images stored; the next pull imports them');
      setFile(null);
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="stack pane-banner" onSubmit={send} data-monero-key-images>
      <p class="small">
        <strong>Key images.</strong> {now} Export them from the full wallet (Feather: Wallet → Advanced → Export key images; CLI: <code>export_key_images FILE</code>) and give the file here. They let the view-only wallet see spends; it still cannot spend.
      </p>
      <div class="row">
        <input type="file" onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} aria-label="Key image file" data-key-image-file />
        <button class="btn sm primary" disabled={busy || !file || !a.running} data-key-image-send>
          {busy ? 'Sending…' : 'Give key images'}
        </button>
      </div>
    </form>
  );
}
