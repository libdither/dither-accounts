/**
 * Chromium flags every account browser shares, and the merging of feature switches.
 *
 * Each account runs a browser of its own, so a process Chromium adds to every browser is paid once per account.
 * Measured on a fresh profile with one page open (Chromium 155; scripts/mem.ts reads PSS), these cost about 40 MiB
 * a browser and nothing an account uses:
 * - The address bar's suggestion popup is a WebUI page (chrome://omnibox-popup.top-chrome), and Chromium keeps it
 *   loaded in a renderer of its own from the start: about 22 MiB to 33 MiB. With the WebUI popup off, the address
 *   bar shows its suggestions in the native popup, and only while you type in it (the live view).
 * - A spare renderer, started ahead of the next navigation to a new site: about 8 MiB, idle nearly all the time. A
 *   navigation now starts its renderer when it needs one.
 * Site isolation stays on: each site still gets its own renderer.
 */
export const MEMORY_DISABLED_FEATURES = [
  'SpareRendererForSitePerProcess',
  'PreloadTopChromeWebUI',
  'WebUIOmniboxPopup',
  'WebUIOmniboxFullPopup',
  'WebUIOmniboxAimPopup',
];

const FEATURE_SWITCHES = ['--enable-features=', '--disable-features='];

/**
 * Chromium reads only the last --enable-features and the last --disable-features on its command line, so two of
 * either would silently drop the first one's features (the extension switch, the GPU's). Fold each into one, at the
 * first one's place, keeping every feature once and in order.
 */
export function mergeFeatureFlags(flags: string[]): string[] {
  const features = new Map<string, string[]>();
  const out: string[] = [];
  for (const flag of flags) {
    const sw = FEATURE_SWITCHES.find((s) => flag.startsWith(s));
    if (!sw) {
      out.push(flag);
      continue;
    }
    if (!features.has(sw)) {
      features.set(sw, []);
      out.push(sw);
    }
    const list = features.get(sw)!;
    for (const f of flag.slice(sw.length).split(',')) if (f && !list.includes(f)) list.push(f);
  }
  return out.map((f) => (features.has(f) ? f + features.get(f)!.join(',') : f));
}
