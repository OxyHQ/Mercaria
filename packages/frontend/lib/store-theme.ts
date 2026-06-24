import type { TextTone } from "@mercaria/shared-types";

/**
 * Derives a full set of scoped shadcn theme-token overrides from a store's
 * `brandColor` + `textTone`, so the storefront STORE page renders entirely in
 * the merchant's palette (Shopify-style: brand background, translucent-white
 * glassy cards, tone-colored text) instead of the app's default surface.
 *
 * The returned map is fed to NativeWind's `vars()` and applied on a wrapper
 * `View`. Because every shared component below (`ProductCard`, `Input`,
 * `Switch`, `SectionHeader`, the pills, the load-more button) styles itself
 * with the standard tokens (`bg-card`, `bg-background`, `border-border`,
 * `text-foreground`, `text-muted-foreground`, `bg-primary`, …), remapping the
 * tokens once cascades the brand palette to the whole subtree — no per-component
 * edits.
 *
 * Token-format contract (see `@mercaria/ui/theme/global.css` + the built CSS):
 * the Tailwind v4 `@theme { --color-X: var(--X) }` block emits, at `:root`,
 * `--color-card: var(--card)` etc., and the generated utilities read
 * `var(--color-card)`. `var()` resolves lazily at the consuming element, so
 * overriding the base `--card` on a subtree DOES re-resolve there. We
 * nonetheless write BOTH the base `--X` token AND the `--color-X` alias (mirroring
 * Bloom's `BloomColorScope`) so the scope is correct whether a consumer reads
 * `var(--card)` or `var(--color-card)`. All values are FULL CSS color strings
 * (`rgb()`/`rgba()`/hex) — valid anywhere a color is expected (per the Bloom
 * CSS-var contract); we never emit bare HSL/oklch triples.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Light text tone over a (darker) brand-tinted surface. */
const TONE_LIGHT_RGB: Rgb = { r: 255, g: 255, b: 255 };
/** Dark text tone over a (lighter) brand-tinted surface. */
const TONE_DARK_RGB: Rgb = { r: 17, g: 17, b: 17 };

/** Translucent fill alpha for glassy cards when the tone is light (white glass). */
const GLASS_LIGHT_ALPHA = 0.14;
/** Translucent fill alpha for glassy cards when the tone is dark (black glass). */
const GLASS_DARK_ALPHA = 0.06;
/** Secondary-text alpha: tone faded toward the brand background. */
const MUTED_FOREGROUND_ALPHA = 0.7;
/** Border / input outline alpha: a faint tone-colored hairline. */
const OUTLINE_ALPHA = 0.22;

/** Largest valid 8-bit channel value, used to clamp parsed/mixed channels. */
const CHANNEL_MAX = 255;

/** Parse `rgb(r,g,b)` / `rgb(r g b)` into an {@link Rgb}, or `null` if it doesn't match. */
function parseRgbString(value: string): Rgb | null {
  const match = value.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
  };
}

/** Parse `#RGB` / `#RRGGBB` into an {@link Rgb}, or `null` if it doesn't match. */
function parseHexString(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "");
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
}

/** Mercaria's default brand color, used when `brandColor` can't be parsed. */
const FALLBACK_BRAND_RGB: Rgb = { r: 29, g: 78, b: 216 };

/** Parse a full CSS color string (`rgb(...)` or hex) into channels. */
function parseColor(value: string): Rgb {
  return parseRgbString(value) ?? parseHexString(value) ?? FALLBACK_BRAND_RGB;
}

/** Clamp a channel to the valid 0–255 range and round to an integer. */
function clampChannel(channel: number): number {
  return Math.max(0, Math.min(CHANNEL_MAX, Math.round(channel)));
}

/** Format channels as an opaque `rgb(...)` string. */
function rgb({ r, g, b }: Rgb): string {
  return `rgb(${clampChannel(r)}, ${clampChannel(g)}, ${clampChannel(b)})`;
}

/** Format channels + alpha as an `rgba(...)` string. */
function rgba({ r, g, b }: Rgb, alpha: number): string {
  return `rgba(${clampChannel(r)}, ${clampChannel(g)}, ${clampChannel(b)}, ${alpha})`;
}

/** Linearly blend `from` toward `to` by `ratio` (0 = `from`, 1 = `to`). */
function mix(from: Rgb, to: Rgb, ratio: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio,
  };
}

/**
 * Build the scoped theme-token map for a store's palette. Pass the result to
 * NativeWind's `vars()` and apply it on a wrapper `View`.
 */
export function storeThemeVars(
  brandColor: string,
  textTone: TextTone,
): Record<string, string> {
  const brand = parseColor(brandColor);
  const isLight = textTone === "light";
  const tone = isLight ? TONE_LIGHT_RGB : TONE_DARK_RGB;

  const brandValue = rgb(brand);
  const toneValue = rgb(tone);
  const glassValue = rgba(
    isLight ? TONE_LIGHT_RGB : TONE_DARK_RGB,
    isLight ? GLASS_LIGHT_ALPHA : GLASS_DARK_ALPHA,
  );
  // Secondary text: the tone faded toward the brand background so it reads as a
  // softer, lower-contrast variant of the primary tone.
  const mutedForegroundValue = rgb(mix(tone, brand, 1 - MUTED_FOREGROUND_ALPHA));
  const outlineValue = rgba(tone, OUTLINE_ALPHA);

  // Base shadcn tokens (`--X`). The generated utilities resolve these lazily
  // through the `--color-X` aliases, so overriding them here re-themes the scope.
  const base: Record<string, string> = {
    background: brandValue,
    foreground: toneValue,
    card: glassValue,
    "card-foreground": toneValue,
    popover: glassValue,
    "popover-foreground": toneValue,
    secondary: glassValue,
    "secondary-foreground": toneValue,
    accent: glassValue,
    "accent-foreground": toneValue,
    muted: glassValue,
    "muted-foreground": mutedForegroundValue,
    border: outlineValue,
    input: outlineValue,
    // Primary buttons read as tone-on-brand (tone fill, brand label).
    primary: toneValue,
    "primary-foreground": brandValue,
    ring: toneValue,
  };

  // Also write the matching `--color-X` aliases (mirrors Bloom's BloomColorScope)
  // so consumers that read `var(--color-X)` directly are themed too.
  const result: Record<string, string> = {};
  for (const [token, value] of Object.entries(base)) {
    result[token] = value;
    result[`color-${token}`] = value;
  }
  return result;
}
