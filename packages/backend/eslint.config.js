import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  {
    /**
     * `scripts/**` is here as well as `src/**` (#374), and it needs the SAME
     * block rather than one of its own.
     *
     * Widening only the `lint` script would have been worse than leaving it
     * alone: this is the one config object that installs the TypeScript parser,
     * so a file outside it is read by espree, which rejects the first type
     * annotation it meets. Nothing else here is scoped per directory — in
     * particular `no-console` is enabled NOWHERE (it is not part of
     * `js.configs.recommended`), so the rule a benchmark and an E2E driver
     * would have to be exempted from is one nothing applies to `src/` either.
     * A second block existing purely to turn it off would be a rule with no
     * subject.
     */
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
      },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-unused-vars": "off",
      // `ignoreRestSiblings` makes OMIT-BY-REST-DESTRUCTURE lintable, and this
      // codebase needs it for a security property rather than for tidiness:
      // `hydrateOrdersForMerchant` (#106) builds a `MerchantOrder` by naming
      // every buyer-identity field and discarding it into a rest spread, so a
      // field added to `Order` cannot arrive in a merchant response by being
      // picked up automatically. A `{...dto}` spread would carry it silently.
      // The named-and-discarded siblings ARE the enforcement, so flagging them
      // as unused would push the code back toward the unsafe form.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-undef": "off", // TypeScript handles this
    },
  },
];
