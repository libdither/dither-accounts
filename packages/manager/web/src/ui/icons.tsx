/** Icons: a brand's mark (icon-data.ts) in its colour, or a glyph. */
import type { JSX } from 'preact';
import { type Brand, BRANDS, G, type Glyph } from '../icon-data.ts';

export type { Brand, Glyph };

/** Brands whose colour is near black (X, GitHub, Matrix) take the text colour, so they show on the dark theme too. */
const dark = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.12;
};
export const brandColor = (b: Brand): string | null => (dark(BRANDS[b].hex) ? null : BRANDS[b].hex);

/** A brand's mark in its colour (or the current colour), or a glyph. */
export function Icon({ brand, glyph, size = 20, mono = false, class: cls, title }: { brand?: Brand; glyph?: Glyph; size?: number; mono?: boolean; class?: string; title?: string }): JSX.Element {
  if (brand) {
    const b = BRANDS[brand];
    return (
      <svg class={`icon brand ${cls ?? ''}`} width={size} height={size} viewBox="0 0 24 24" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : 'true'} fill={mono || dark(b.hex) ? 'currentColor' : b.hex}>
        {title && <title>{title}</title>}
        <path d={b.path} />
      </svg>
    );
  }
  return (
    <svg
      class={`icon glyph ${cls ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {title && <title>{title}</title>}
      <path d={G[glyph ?? 'grid']} />
    </svg>
  );
}
