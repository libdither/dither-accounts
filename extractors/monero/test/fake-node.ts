/** A fake monerod for tests: only what a pull asks a node directly (get_info, to pick a node). */
export function fakeNode(opts: { synchronized?: boolean } = {}) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const b = (await req.json().catch(() => ({}))) as { method?: string };
      if (b.method !== 'get_info') return Response.json({ error: { message: 'no' } });
      return Response.json({ id: '0', jsonrpc: '2.0', result: { height: Number(process.env.FAKE_MONERO_TIP || 3500000), synchronized: opts.synchronized ?? true, offline: false, status: 'OK' } });
    },
  });
}

/** What a key image export file starts with; the rest is never read by the fakes. */
export const KEY_IMAGES = Buffer.concat([Buffer.from('Monero key image export\x03', 'latin1'), Buffer.alloc(64, 7)]);
export const ADDRESS = '4' + 'A'.repeat(94);
export const VIEW_KEY = 'ab'.repeat(32);
/** The UTC second the fixture's pulled_at was fixed at. */
export const FIXED = '2026-11-09T14:14:03Z';
