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
      },
      colors: {
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
