/**
 * The shared ESLint flat config for the three Expo apps (#496).
 *
 * ## Why one shared base and not three copies
 *
 * `frontend`, `dashboard` and `pos` are the same kind of package — an Expo
 * Router app with a Cloudflare worker and a postcss config beside it — and
 * #496's measurement found them in the same state, not three different ones.
 * Three identical seventy-line configs would drift, and the drift would be
 * silent: a rule quietly missing from one app looks exactly like a rule nobody
 * violates there. Each app's `eslint.config.js` imports this and adds nothing,
 * so a per-app divergence has to be written down as a divergence.
 *
 * `backend` deliberately keeps its OWN config rather than importing this. It
 * lints server TypeScript with a type-aware parser project and no JSX, no
 * browser globals and no React rules; folding the two together would mean one
 * file whose every block is conditional on which package is being linted.
 *
 * ## The rule set is the house set plus React
 *
 * The `@typescript-eslint/no-unused-vars` options are copied from
 * `packages/backend/eslint.config.js` verbatim, `ignoreRestSiblings` included —
 * see that file for why that one is a security property rather than tidiness.
 *
 * The React rules are the ones that catch bugs a typechecker cannot:
 * `rules-of-hooks` (a hook behind a condition is a runtime crash `tsc` is happy
 * with) and `exhaustive-deps`. `exhaustive-deps` is a WARNING rather than an
 * error on purpose — AGENTS.md tells this codebase to avoid `useEffect` in the
 * first place, so the remaining ones are deliberate and each wants reading
 * rather than silencing.
 *
 * ## The three file kinds, and why each needs its own block
 *
 * An Expo app package is not one language surface. `*.js`/`*.cjs` at the root
 * are CommonJS config files (babel, metro, tailwind); `.mjs` and
 * `public/_worker.js` are ES modules running on a Worker rather than in Node;
 * and the `.ts`/`.tsx` tree is the app itself. Measured while writing this:
 * giving the whole package one block produced 59 `no-undef` errors that were
 * entirely an artefact of the config — every one in a `.js` file, none in the
 * app source.
 *
 * (Globs are spelled without a leading `**` in this docblock on purpose: the
 * sequence that ends a block comment appears inside one, so writing the pattern
 * out terminates the comment and the rest of the file becomes syntax errors.)
 */

import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

/** Globals every surface here shares. `no-undef` is off for TS, which has its own. */
const WEB_GLOBALS = {
  console: "readonly",
  process: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  setInterval: "readonly",
  clearTimeout: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  localStorage: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  FormData: "readonly",
  Blob: "readonly",
  Headers: "readonly",
  Request: "readonly",
  Response: "readonly",
  HTMLElement: "readonly",
  globalThis: "readonly",
  __DEV__: "readonly",
  React: "readonly",
};

/** Present only in `public/_worker.js` and the service worker. */
const WORKER_GLOBALS = {
  self: "readonly",
  caches: "readonly",
  addEventListener: "readonly",
  skipWaiting: "readonly",
  clients: "readonly",
};

export default [
  {
    // `.expo/` is generated on every build and `expo-env.d.ts`/`nativewind-env.d.ts`
    // are generated ambient declarations — linting either reports findings
    // nobody can fix in the source.
    ignores: ["dist/**", "node_modules/**", ".expo/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  {
    /** Root CommonJS config files: babel, metro, tailwind. */
    files: ["*.js", "*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...WEB_GLOBALS,
        module: "writable",
        exports: "writable",
        require: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
  {
    /** ES modules that are not app source: postcss config, the Cloudflare worker. */
    files: ["*.mjs", "public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...WEB_GLOBALS, ...WORKER_GLOBALS },
    },
  },
  {
    /** The app itself. */
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tsparser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: WEB_GLOBALS,
    },
    plugins: {
      "@typescript-eslint": tseslint,
      react,
      "react-hooks": reactHooks,
    },
    settings: { react: { version: "detect" } },
    rules: {
      "no-unused-vars": "off",
      // Verbatim from packages/backend/eslint.config.js — see its comment.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-undef": "off", // TypeScript handles this
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react/jsx-key": "error",
      "react/no-danger": "warn",
    },
  },
];
