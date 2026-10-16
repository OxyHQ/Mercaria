import type { TextTone } from '@mercaria/shared-types';
import { parseRgb, withAlpha, type BloomColorScopeTokens } from '@oxy.so/bloom/theme';

/** Merchant colors are exact catalog values. Bloom owns their scoped CSS,
 * native context, semantic aliases and portal propagation. */
export function storeThemeTokens(brandColor: string, textTone: TextTone): BloomColorScopeTokens {
  const brand = parseRgb(brandColor) ?? { r: 29, g: 78, b: 216 };
  const light = textTone === 'light';
  const tone = light ? 255 : 17;
  const brandValue = `rgb(${brand.r}, ${brand.g}, ${brand.b})`;
  const toneValue = `rgb(${tone}, ${tone}, ${tone})`;
  const glass = withAlpha(toneValue, light ? 0.14 : 0.06);
  const mutedTone = `rgb(${[brand.r, brand.g, brand.b].map((channel) => Math.round(tone * 0.7 + channel * 0.3)).join(', ')})`;
  const outline = withAlpha(toneValue, 0.22);
  return {
    background: brandValue,
    foreground: toneValue,
    surface: glass,
    'surface-foreground': toneValue,
    'content-area': brandValue,
    card: glass,
    'card-foreground': toneValue,
    popover: glass,
    'popover-foreground': toneValue,
    secondary: glass,
    'secondary-foreground': toneValue,
    'secondary-text': toneValue,
    'secondary-subtle': glass,
    tertiary: glass,
    'tertiary-foreground': toneValue,
    'tertiary-text': toneValue,
    'tertiary-subtle': glass,
    accent: glass,
    'accent-foreground': toneValue,
    muted: glass,
    'muted-foreground': mutedTone,
    border: outline,
    input: outline,
    primary: toneValue,
    'primary-foreground': brandValue,
    'primary-text': toneValue,
    'primary-subtle': glass,
    ring: toneValue,
  };
}
