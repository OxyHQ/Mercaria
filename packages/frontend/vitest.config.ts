import { defineConfig } from 'vitest/config';

/**
 * The storefront's test runner.
 *
 * ## Narrow on purpose
 *
 * `lib/**` only, the node environment, and no jsdom — so what is testable here
 * is exactly the PURE composition (`lib/catalog/`'s facet grammar, variant-axis
 * availability and comparability rules), which imports types and closed tuples
 * from `@mercaria/shared-types` and nothing else.
 *
 * Those gates are not replaced by this and should not be moved here — they cover
 * the whole tree, including files that import a renderer.
 *
 * ## The decision NOT to widen past `lib/**` (#469), and what it rests on
 *
 * #469 asked whether this runner should grow to `components/**` and `app/**`,
 * and what a component test would be for. It stays as it is. The argument is a
 * measurement rather than a preference.
 *
 * A component test needs a renderer, and a renderer here cannot see the module
 * graph either shipped app is built from. Importing the simplest component in
 * the package — `components/Logo.tsx`, three imports, no state — fails at
 * `react-native/index.js` with `Parse failure: Expected 'from', got 'typeOf'`:
 * React Native ships Flow source that Rollup does not parse. Every component in
 * all three apps reaches `react-native`, directly or through `@mercaria/ui`,
 * `@oxyhq/bloom` or `expo-router`, so this is the floor and not one bad file.
 *
 * Clearing it means aliasing `react-native` to `react-native-web`, adding a
 * Flow-stripping transform for the RN-ecosystem packages that ship untranspiled,
 * and reproducing Metro's platform-extension resolution (`.web.tsx` against
 * `.native.tsx`) inside vitest. The result would then exercise a THIRD module
 * graph — neither the native build nor the Cloudflare Workers web build — which
 * is the shape this repository keeps recording as the expensive kind of green: a
 * check that passes while measuring something production does not run. It is
 * also a standing cost, re-paid at every Expo, React Native and NativeWind bump.
 *
 * `react-test-renderer` is in this package's devDependencies, imported by
 * nothing and pinned at 19.1.0 against React 19.2.3. It is scaffolding left by
 * the template, not a shape somebody chose; it is left alone here because
 * removing it is a dependency change with no bearing on this decision.
 *
 * So what a component test would be FOR is the real question, and the honest
 * answer is that the part worth asserting is never the JSX. It is the
 * derivation behind it — which URL a filter composes, which variant a choice
 * selects, which of two prices is comparable — and that is exactly what moves
 * into `lib/` and gets tested here, under this package's own `strict: true`, at
 * no renderer cost. The rule that follows: when a component grows logic worth a
 * test, extract the logic rather than mount the component. Layout, styling and
 * accessibility — the things a renderer WOULD cover — remain covered by the
 * scanning gates and by review, and that gap is stated rather than closed.
 *
 * ## Why not the backend suite, which runs everything else
 *
 * Its `rootDir` is its own package root by an explicit decision in its
 * `tsconfig.json`, so a backend test cannot IMPORT a file from another package
 * (TS6059) — which is why every storefront check there reads text instead.
 * Excluding one test from that program to get around it also makes
 * `parserOptions.project` unable to parse it, leaving the file neither
 * typechecked nor linted. Measured, on this branch, before this config existed.
 */
export default defineConfig({
  test: {
    include: ['lib/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
