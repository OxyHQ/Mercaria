import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
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
