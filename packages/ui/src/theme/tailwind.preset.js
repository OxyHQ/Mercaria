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
        // lineHeight + fontWeight so `text-captionBold` carries weight 700, etc.
        // Additive — the default `text-xs`/`text-sm`/`text-base` ramp is untouched.
        caption: ["12px", { lineHeight: "16px", fontWeight: "400" }],
        captionMedium: ["12px", { lineHeight: "16px", fontWeight: "500" }],
        captionBold: ["12px", { lineHeight: "16px", fontWeight: "700" }],
        badge: ["11px", { lineHeight: "14px", fontWeight: "500" }],
        badgeBold: ["11px", { lineHeight: "14px", fontWeight: "700" }],
        bodySmall: ["14px", { lineHeight: "20px", fontWeight: "400" }],
        body: ["16px", { lineHeight: "24px", fontWeight: "400" }],
        bodyTitleSmall: ["14px", { lineHeight: "20px", fontWeight: "600" }],
        bodyTitleLarge: ["18px", { lineHeight: "24px", fontWeight: "700" }],
        subtitle: ["18px", { lineHeight: "24px", fontWeight: "600" }],
        sectionTitle: ["22px", { lineHeight: "28px", fontWeight: "700" }],
        header: ["28px", { lineHeight: "32px", fontWeight: "400" }],
        headerBold: ["28px", { lineHeight: "32px", fontWeight: "700" }],
        buttonSmall: ["13px", { lineHeight: "16px", fontWeight: "600" }],
        buttonMedium: ["14px", { lineHeight: "20px", fontWeight: "600" }],
        buttonLarge: ["16px", { lineHeight: "20px", fontWeight: "600" }],
      },
      fontWeight: {
        // Matching `font-<key>` weight tokens so the original's `font-X text-X`
        // pairs resolve verbatim. Additive — default `font-bold`/`font-semibold`
        // are untouched.
        caption: "400",
        captionMedium: "500",
        captionBold: "700",
        badge: "500",
        badgeBold: "700",
        bodySmall: "400",
        body: "400",
        bodyTitleSmall: "600",
        bodyTitleLarge: "700",
        subtitle: "600",
        sectionTitle: "700",
        header: "400",
        headerBold: "700",
        buttonSmall: "600",
        buttonMedium: "600",
        buttonLarge: "600",
      },
      colors: {
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
        "bg-fill-secondary": "var(--secondary)",
        "bg-fill-secondary-hover": "var(--secondary)",
        "bg-fill-brand": "var(--primary)",
        "bg-fill-brand-hover": "var(--primary)",
        "bg-fill-inverse": "var(--foreground)",
        "bg-fill-inverse-hover": "var(--foreground)",
        "bg-fill-hover": "var(--muted)",
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
    },
  },
  plugins: [require("tailwindcss-animate")],
};
