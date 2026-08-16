import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Typed routes are ARMED in all three Expo apps.
 *
 * ## What this replaced, and why
 *
 * `product-page-isolation.test.ts` used to carry WALL 6: a hand-rolled walk of
 * the storefront's `app/` tree that resolved every literal `router.push` target
 * against it. It existed because `typedRoutes: true` was INERT —
 * `.expo/types/router.d.ts` is gitignored and nothing generated it before
 * `tsc`, so `Href` degraded to `string` and a bogus route type-checked clean
 * (#330). It caught a real one: a "Report a problem" control pointing at
 * `/settings/support`.
 *
 * #330 generates that declaration inside every app's `typecheck`, so the
 * COMPILER now answers the same question — over all three apps and 2,300-odd
 * files rather than one page's twenty, and without a resolver of our own to get
 * wrong. WALL 6's own history is the argument against keeping it: it read only
 * the ARGUMENT of `router.push`, so a route composed in a `buildHref` helper was
 * invisible (`/p/:handle`, the most-linked route in the storefront, was never
 * gated), and an interpolated query string became one segment containing `${`,
 * which its resolver read as a WILDCARD matching any two-segment route. Both
 * were found on the one day somebody looked closely, and both failed PERMISSIVE.
 *
 * So the route-resolution half was retired rather than kept green for the wrong
 * reason. What survives here is the part the compiler genuinely cannot do.
 *
 * ## What the compiler cannot check
 *
 * That it was given the union. Every route check in all three apps rests on
 * three configuration facts, and each can be removed in a change whose diff
 * looks entirely reasonable:
 *
 *   1. `experiments.typedRoutes` is on, or the generator writes nothing;
 *   2. `typecheck` generates the declaration before `tsc`, or CI reads a tree
 *      in which it does not exist;
 *   3. tsconfig `include`s `.expo/types`, or `tsc` never loads it.
 *
 * Break any one and `Href` silently degrades to `string` again. Nothing goes
 * red — that IS the failure — so the check has to be here, on the mechanism,
 * because a compiler cannot report that it was configured not to look.
 */

/** Repo root from `packages/backend/src/__tests__`. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

/**
 * Every app whose navigation the typed-route union protects, and the config
 * file that carries its `experiments` block. An EXACT list rather than a
 * directory scan: "I found no apps" and "every app is fine" are the same
 * passing run, and this file exists precisely to refuse that equivalence.
 */
const TYPED_ROUTE_APPS = [
  { name: 'frontend', config: 'app.json' },
  { name: 'dashboard', config: 'app.json' },
  { name: 'pos', config: 'app.config.js' },
] as const;

/** The script `typecheck` must run before `tsc`, and where it lives. */
const GENERATOR = 'scripts/generate-router-types.mjs';

function packageJsonOf(app: string): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'packages', app, 'package.json'), 'utf8'));
}

function tsconfigOf(app: string): { include?: string[] } {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'packages', app, 'tsconfig.json'), 'utf8'));
}

/**
 * Does a `typecheck` script generate the declaration BEFORE type-checking?
 *
 * Order is the property, not presence: generating after `tsc` would satisfy a
 * substring check and leave the first run of a clean checkout reading nothing.
 */
function generatesBeforeTypecheck(script: string): boolean {
  const generator = script.indexOf(GENERATOR);
  const tsc = script.indexOf('tsc');
  return generator !== -1 && tsc !== -1 && generator < tsc;
}

/** Does an `include` list bring `.expo/types` into the program? */
function includesGeneratedTypes(include: readonly string[] | undefined): boolean {
  return (include ?? []).some((entry) => entry.includes('.expo/types'));
}

describe('typed routes are armed in every Expo app', () => {
  it('the generator script exists', () => {
    // A floor on the file itself: every assertion below names it, and all three
    // would go on passing against a script somebody deleted.
    const source = readFileSync(join(REPO_ROOT, GENERATOR), 'utf8');
    expect(source).toContain('startTypescriptTypeGenerationAsync');
  });

  it.each(TYPED_ROUTE_APPS)('$name: experiments.typedRoutes is on', ({ name, config }) => {
    const source = readFileSync(join(REPO_ROOT, 'packages', name, config), 'utf8');
    // Read as TEXT because the POS carries a JS config; a `false` here is not a
    // smaller check, it is no check at all in that app.
    expect(
      /["']?typedRoutes["']?\s*:\s*true/u.test(source),
      `${name}/${config} does not set experiments.typedRoutes: true, so every route ` +
        'literal in that app type-checks against `string`',
    ).toBe(true);
  });

  it.each(TYPED_ROUTE_APPS)('$name: typecheck generates the union first', ({ name }) => {
    const script = packageJsonOf(name).scripts?.typecheck ?? '';
    expect(
      generatesBeforeTypecheck(script),
      `packages/${name} typecheck is "${script}", which does not run ${GENERATOR} before tsc — ` +
        'CI would type-check a tree in which .expo/types/router.d.ts does not exist',
    ).toBe(true);
  });

  it.each(TYPED_ROUTE_APPS)('$name: tsconfig includes the generated types', ({ name }) => {
    expect(
      includesGeneratedTypes(tsconfigOf(name).include),
      `packages/${name}/tsconfig.json does not include .expo/types, so tsc never loads the ` +
        'generated union even when it is written',
    ).toBe(true);
  });

  it('the detectors actually detect — the mutation self-test', () => {
    // Each detector is fed the exact shape it exists to refuse. Without this a
    // predicate that returned `true` unconditionally would pass every case above.
    expect(generatesBeforeTypecheck(`bun ../../${GENERATOR} && tsc --noEmit`)).toBe(true);
    expect(generatesBeforeTypecheck('tsc --noEmit')).toBe(false);
    // The ORDER, which a substring check cannot see.
    expect(generatesBeforeTypecheck(`tsc --noEmit && bun ../../${GENERATOR}`)).toBe(false);

    expect(includesGeneratedTypes(['**/*.ts', '.expo/types/**/*.ts'])).toBe(true);
    expect(includesGeneratedTypes(['**/*.ts'])).toBe(false);
    expect(includesGeneratedTypes(undefined)).toBe(false);
  });
});
