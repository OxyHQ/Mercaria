/** @type {import('tailwindcss').Config} */
module.exports = {
  important: true,
  // Shared design tokens (theme.extend), tailwindcss-animate, and
  // `darkMode: 'class'` live in the @mercaria/ui preset so every app stays in
  // sync. Only `content` / `important` are app-local.
  presets: [require("@mercaria/ui/theme/tailwind.preset")],
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
    "./lib/**/*.{js,jsx,ts,tsx}",
    "./hooks/**/*.{js,jsx,ts,tsx}",
    // Scan the source-consumed shared UI package for its component classes.
    "../ui/src/**/*.{js,jsx,ts,tsx}",
    "../../node_modules/@oxyhq/services/lib/**/*.{js,jsx}",
    "../../node_modules/@oxyhq/bloom/lib/**/*.{js,jsx}",
  ],
};
