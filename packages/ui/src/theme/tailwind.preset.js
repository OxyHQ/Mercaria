/**
 * @mercaria/ui Tailwind preset — the SHARED design tokens.
 *
 * Carries the `theme.extend` (fontFamily, borderRadius, the `var(--…)` color
 * mappings), `tailwindcss-animate`, and `darkMode: 'class'`. Apps spread this
 * via `presets: [require('@mercaria/ui/theme/tailwind.preset')]` and keep only
 * app-specific `content` / `important` in their own config, so the token set is
 * defined ONCE here and every consuming app stays in sync.
 *
 * A Tailwind preset may carry `theme`, `plugins`, `darkMode`; `content` /
 * `important` are intentionally NOT set here (they stay app-local). The base
 * `--…` custom properties these utilities reference are defined in the shared
 * `global.css` (`@theme` / `:root`).
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "sans-serif"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        // Shopify "Shop" radius scale (`rounded-radius-N`). Additive — does NOT
        // override Tailwind's default `rounded-3xl`/`rounded-2xl`/etc.
        "radius-8": "8px",
        "radius-12": "12px",
        "radius-16": "16px",
        "radius-20": "20px",
        "radius-24": "24px",
        "radius-28": "28px",
        "radius-max": "9999px",
      },
      spacing: {
        // Shopify "Shop" spacing scale (`gap-space-N`, `p-space-N`, `size-space-N`,
        // `w-space-N`, `min-h-space-N`, …) — `space-N` is N px. Additive: the
        // default Tailwind numeric scale (`gap-4`, `p-5`, …) is untouched.
        "space-0": "0px",
        "space-2": "2px",
        "space-4": "4px",
        "space-6": "6px",
        "space-8": "8px",
        "space-10": "10px",
        "space-12": "12px",
        "space-16": "16px",
        "space-20": "20px",
        "space-24": "24px",
        "space-32": "32px",
        "space-36": "36px",
        "space-40": "40px",
        "space-48": "48px",
        "space-64": "64px",
      },
      fontSize: {
        // Shopify "Shop" type ramp (`text-<key>`). Each token bakes in size +
        // lineHeight + fontWeight + letterSpacing; mirrored in shop-typography.css.
        // Additive — the default `text-xs`/`text-sm`/`text-base` ramp is untouched.
        caption: ["12px", { lineHeight: "16px", fontWeight: "400", letterSpacing: "-.2px" }],
        captionMedium: ["12px", { lineHeight: "16px", fontWeight: "500", letterSpacing: "-.2px" }],
        captionBold: ["12px", { lineHeight: "16px", fontWeight: "600", letterSpacing: "-.2px" }],
        badge: ["10px", { lineHeight: "13px", fontWeight: "400", letterSpacing: "-.2px" }],
        badgeBold: ["10px", { lineHeight: "13px", fontWeight: "600", letterSpacing: "-.2px" }],
        bodySmall: ["14px", { lineHeight: "18px", fontWeight: "400", letterSpacing: "-.2px" }],
        body: ["16px", { lineHeight: "24px", fontWeight: "400" }],
        bodyTitleSmall: ["14px", { lineHeight: "18px", fontWeight: "600", letterSpacing: "-.2px" }],
        bodyTitleLarge: ["16px", { lineHeight: "22px", fontWeight: "600", letterSpacing: "-.5px" }],
        subtitle: ["18px", { lineHeight: "20px", fontWeight: "600", letterSpacing: "-.5px" }],
        sectionTitle: ["20px", { lineHeight: "22px", fontWeight: "600", letterSpacing: "-1px" }],
        header: ["28px", { lineHeight: "30px", fontWeight: "700", letterSpacing: "-1.75px" }],
        headerBold: ["24px", { lineHeight: "26px", fontWeight: "600", letterSpacing: "-1px" }],
        buttonSmall: ["12px", { lineHeight: "16px", fontWeight: "600", letterSpacing: "-.2px" }],
        buttonMedium: ["14px", { lineHeight: "16px", fontWeight: "600", letterSpacing: "-.2px" }],
        buttonLarge: ["16px", { lineHeight: "20px", fontWeight: "600", letterSpacing: "-.5px" }],
        // The category page's poster headline (md breakpoint up) — bigger than
        // any size the ramp above carries, so it is its own token rather than a
        // variant of `header`.
        posterXS: ["36px", { lineHeight: "38px", fontWeight: "800", letterSpacing: "-1px" }],
      },
      fontWeight: {
        // Matching `font-<key>` weight tokens so the original's `font-X text-X`
        // pairs resolve verbatim. Additive — default `font-bold`/`font-semibold`
        // are untouched.
        caption: "400",
        captionMedium: "500",
        captionBold: "600",
        badge: "400",
        badgeBold: "600",
        bodySmall: "400",
        body: "400",
        bodyTitleSmall: "600",
        bodyTitleLarge: "600",
        subtitle: "600",
        sectionTitle: "600",
        header: "700",
        headerBold: "600",
        buttonSmall: "600",
        buttonMedium: "600",
        buttonLarge: "600",
        // Matches `fontSize.posterXS` so `font-posterXS text-posterXS` resolves
        // verbatim, same as every other pair in this block.
        posterXS: "800",
      },
      colors: {
        // NOT the source of truth under Tailwind v4: colours are generated from
        // the `--color-*` variables in `global.css`'s `@theme` block, not from
        // this object. A key added here alone compiles to nothing — see the six
        // `bg-bg-overlay-*` classes that shipped broken because this file had
        // the entry and `global.css` did not. Add new colours to `global.css`
        // (all four apps' copies) FIRST; this block is legacy and kept for the
        // pre-v4 entries below, not for adding to.
        // ── Shopify "Shop" semantic color names ──────────────────────────────
        // Class = `<prefix>-<key>` (e.g. `bg-bg-fill`, `text-text`,
        // `border-border-secondary`). Each maps to an existing Mercaria runtime
        // CSS var so dark/light still resolve; only the CLASS NAME is Shopify's.
        // `*-fixed-*` and `overlay-*` are intentionally theme-independent constants.
        text: "var(--foreground)",
        "text-secondary": "var(--muted-foreground)",
        "text-tertiary": "var(--muted-foreground)",
        "text-brand": "var(--primary)",
        "text-inverse": "var(--background)",
        "text-fixed-light": "#ffffff",
        "text-fixed-dark": "#111111",
        "text-placeholder": "var(--muted-foreground)",
        bg: "var(--background)",
        "bg-fill": "var(--card)",
        // `--secondary` is Bloom's secondary ACCENT family (a hue rotated off
        // the seed, consumed only by Bloom's FAB), not a quiet surface — on a
        // cool seed it lands on red. Bloom spells this slot
        // `fill-secondary: var(--muted)` / `fill-hover: var(--accent)`.
        "bg-fill-secondary": "var(--muted)",
        "bg-fill-secondary-hover": "var(--accent)",
        "bg-fill-brand": "var(--primary)",
        "bg-fill-brand-hover": "var(--primary)",
        "bg-fill-inverse": "var(--foreground)",
        "bg-fill-inverse-hover": "var(--foreground)",
        "bg-fill-hover": "var(--muted)",
        // The discovery feed's pagination-dot / scrim fill — a third surface
        // beside `bg-fill`/`bg-fill-secondary`, same muted var as the others.
        "bg-fill-tertiary": "var(--muted)",
        brand: "var(--primary)",
        "fill-fixed-dark": "#111111",
        "fill-fixed-light": "#ffffff",
        "border-secondary": "var(--border)",
        "border-tertiary": "var(--border)",
        "border-input": "var(--border)",
        "border-input-active": "var(--ring)",
        "border-image": "var(--border)",
        "overlay-inverse-04": "rgba(0,0,0,0.04)",
        "overlay-inverse-06": "rgba(0,0,0,0.06)",
        "overlay-fixed-icon": "rgba(0,0,0,0.45)",
        "overlay-fixed-dark-20": "rgba(0,0,0,0.20)",
        "overlay-fixed-dark-40": "rgba(0,0,0,0.40)",
        "overlay-highlight": "rgba(255,255,255,0.6)",
        // Scrim and pagination-dot values from the discovery capture, filling
        // out the `dark`/`light` ramp beside `overlay-fixed-dark-20`/`-40`
        // above. Theme-independent constants by design, like every other
        // `fixed`/`overlay` token in this block.
        "overlay-fixed-dark-04": "rgba(0,0,0,0.04)",
        "overlay-fixed-dark-10": "rgba(0,0,0,0.10)",
        "overlay-fixed-light-20": "rgba(255,255,255,0.20)",
        "overlay-fixed-light-40": "rgba(255,255,255,0.40)",
        "overlay-fixed-light-75": "rgba(255,255,255,0.75)",
        // ── Existing Mercaria tokens (unchanged) ─────────────────────────────
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "hsl(0 0% 100%)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        surface: {
          DEFAULT: "var(--surface)",
          foreground: "var(--surface-foreground)",
        },
        "content-area": {
          DEFAULT: "var(--content-area)",
        },
        chart: {
          1: "var(--chart-1)",
          2: "var(--chart-2)",
          3: "var(--chart-3)",
          4: "var(--chart-4)",
          5: "var(--chart-5)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar)",
          foreground: "var(--sidebar-foreground)",
          primary: "var(--sidebar-primary)",
          "primary-foreground": "var(--sidebar-primary-foreground)",
          accent: "var(--sidebar-accent)",
          "accent-foreground": "var(--sidebar-accent-foreground)",
          border: "var(--sidebar-border)",
          ring: "var(--sidebar-ring)",
        },
      },
      boxShadow: {
        // Marketplace-only ramp; Bloom owns the unprefixed shadow tokens.
        "shop-s": "0 2px 8px #0000000f",
        "shop-m": "0 4px 24px #0000001f",
        "shop-l": "0 8px 40px #0000003d",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
