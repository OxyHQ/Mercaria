/**
 * ESLint for @mercaria/dashboard — the Expo env-var rules Biome lacks, only.
 *
 * The rule set is shared with the other two Expo apps — see
 * `eslint.config.apps.mjs` at the repo root for what it contains and why.
 * Everything else is linted by Biome (`biome.jsonc`). Adding a rule HERE is
 * how a deliberate per-app divergence gets recorded; there are none today.
 */
export { default } from "../../eslint.config.apps.mjs";
