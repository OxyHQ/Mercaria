/**
 * The client packages no existing gate scans carry no hard-coded catalog list
 * (#367 workstream 13's inventory box).
 *
 * ## Why this exists at all, given two gates already do this
 *
 * Workstream 8 and workstream 9 each shipped a validator, and each is
 * PREFIX-SCOPED: `validate-authoring-schema-driven.mjs` scans
 * `packages/dashboard/` and `validate-storefront-catalog-driven.mjs` scans
 * `packages/frontend/`. Neither reaches `packages/pos` or `packages/ui` — and
 * `packages/ui` is the one that matters, because the storefront IMPORTS from it.
 * A hard-coded option-name list moved one package sideways is invisible to the
 * gate that exists to forbid it.
 *
 * The inventory itself is `docs/catalog-backfill.md`; a document rots and a
 * census does not, so the finding lives here as well.
 *
 * ## It reads the client packages as TEXT, and never imports one
 *
 * Load-bearing rather than stylistic. `packages/backend` is the one package
 * compiled with `strict: false`; `frontend`, `dashboard`, `pos` and `ui` are all
 * `strict: true`. A test that IMPORTED client source would pull that module into
 * the backend's program and compile it under the backend's settings, silently
 * dropping every null-safety check the module was written to rely on. The
 * failure direction is the bad one: it hides errors rather than inventing them,
 * so nothing would ever go red.
 *
 * ## It does NOT strip comments
 *
 * `listing-publication-chokepoint.test.ts`'s ruling, and it cost this workstream
 * two real failures to relearn: scanning raw source fails toward a false
 * POSITIVE, corrected in one line, while comment stripping truncates at a `//`
 * inside a string literal and can hide a real hit.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The monorepo root — four levels up from `src/services/catalog-backfill/__tests__`. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');

/**
 * The client packages NO existing validator scans.
 *
 * `frontend` and `dashboard` are deliberately absent: each already has a gate
 * that goes far deeper than this one, and duplicating them here would be a
 * second authority over one property whose two answers could disagree.
 */
const UNGATED_CLIENT_ROOTS = [
  join('packages', 'pos'),
  join('packages', 'ui', 'src'),
];

/** Every client source file under the ungated roots, as `{relative path → text}`. */
function ungatedClientSources(): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.expo' || entry === 'dist') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
      if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
      const rel = relative(REPO_ROOT, path);
      if (rel.split(sep).includes('__tests__')) continue;
      sources.set(rel.split(sep).join('/'), readFileSync(path, 'utf8'));
    }
  };
  for (const root of UNGATED_CLIENT_ROOTS) walk(join(REPO_ROOT, root));
  return sources;
}

/**
 * A constant naming a catalog concept and BOUND TO A LIST.
 *
 * The list is what makes it a hardcoded vocabulary rather than a value. The
 * first version of this probe accepted any value and fired on
 * `const CATEGORY_SLOT_CLASS = 'w-[330px]'` — a Tailwind class — which is the
 * shape a gate erodes into a directory listing through. `[^\]]*` rather than a
 * greedy match, so one array does not swallow the file to the next `]`.
 */
const HARDCODED_CATALOG_LIST =
  /const\s+[A-Z_]*(?:OPTION_NAMES|CATEGORY|CATEGORIES|PRODUCT_TYPES|FACET|FILTER)[A-Z_]*[^=]*=\s*(?:new Set\(\s*)?\[[^\]]*\]/u;

/**
 * A branch on a catalog concept's NAME against a string literal — the two-line
 * version of the same hardcoding.
 */
const HARDCODED_CATALOG_COMPARISON =
  /(?:option|category|productType|facet)\.(?:name|slug|key)\s*(?:===|!==|==)\s*'[^']+'|\.(?:name|slug|key)\.toLowerCase\(\)\s*(?:===|!==)\s*'/u;

/**
 * The known offenders, with a disposition each.
 *
 * `untouched WITH A REASON is a decision the census accepts; silence is not` —
 * `merge-plan-census.test.ts`'s ruling. An exact array rather than a prefix rule,
 * so it cannot be widened by accident.
 */
const PERMITTED: readonly { readonly path: string; readonly disposition: string }[] = [
  {
    path: 'packages/ui/src/components/marketplace/VariantSwatches.tsx',
    disposition:
      'PRESENTATION, not a mapping: `COLOR_OPTION_NAMES` picks a widget (round swatches vs text ' +
      'pills) from the legacy free-text `ListingOption.name`. It asserts no fact, writes nothing, ' +
      'and cannot make `Colour` and `Tono` one attribute — but it does render `Colour` as colour ' +
      'and `Tono` as a pill, which is the same false-equivalence shape one layer down. The fix ' +
      'belongs with #367 step 4’s typed axes, which know which attribute an option resolved to; ' +
      'nothing in workstream 13 writes to `packages/ui`',
  },
];

describe('the ungated client packages', () => {
  it('reads a real, non-trivial set of client sources', () => {
    // The vacuity floor, and it is the whole assertion: a walk that found
    // nothing passes every probe below, and a moved directory or a changed
    // extension filter produces exactly that. Printed on SUCCESS by being the
    // number this compares.
    const sources = ungatedClientSources();
    expect(
      sources.size,
      'the client walk read almost nothing — did packages/pos or packages/ui move?',
    ).toBeGreaterThan(100);

    // Both roots specifically, because one of them silently emptying would leave
    // the total above satisfied by the other.
    for (const root of ['packages/pos/', 'packages/ui/src/']) {
      expect(
        [...sources.keys()].filter((path) => path.startsWith(root)).length,
        `no sources found under ${root}`,
      ).toBeGreaterThan(20);
    }
  });

  it('carries no hard-coded catalog list beyond the one named exception', () => {
    const offenders = [...ungatedClientSources()]
      .filter(([, source]) => HARDCODED_CATALOG_LIST.test(source))
      .map(([path]) => path)
      .sort();

    // Exact identity, never containment: an allow-list that may only grow is the
    // gate switching itself off one defensible entry at a time. It is also its
    // own positive control — it can only pass by having FOUND the known list, so
    // a probe that stopped matching fails here rather than reporting a tidy zero.
    expect(
      offenders,
      'a client package outside the two scanned by WS8/WS9 hardcodes a catalog vocabulary. ' +
        'Read it from the server, or add it here with a disposition (#367 workstream 13)',
    ).toEqual([...PERMITTED].map((entry) => entry.path).sort());
  });

  it('branches on no catalog concept’s name', () => {
    for (const [path, source] of ungatedClientSources()) {
      expect(
        HARDCODED_CATALOG_COMPARISON.test(source),
        `${path} compares a catalog concept's name against a string literal`,
      ).toBe(false);
    }
  });

  it('has probes that fire on the shapes they claim to, and not the rest', () => {
    // The mutation self-test. The negative controls are the ones that earned
    // their place: the first version of the list probe accepted a scalar and
    // fired on a Tailwind class constant.
    for (const positive of [
      'const COLOR_OPTION_NAMES = new Set(["color", "colour"]);',
      "const CATEGORY_SLUGS = ['electronics', 'shoes'];",
      'const PRODUCT_TYPES: readonly string[] = ["smartphone"];',
      "const FILTER_KEYS = ['brand', 'price'];",
    ]) {
      expect(HARDCODED_CATALOG_LIST.test(positive), `list probe missed: ${positive}`).toBe(true);
    }
    for (const negative of [
      "const CATEGORY_SLOT_CLASS = 'w-[330px]';",
      'const categories = useCategories();',
      'const selected = new Set(response.buckets.map((b) => b.key));',
    ]) {
      expect(HARDCODED_CATALOG_LIST.test(negative), `list probe over-matched: ${negative}`).toBe(
        false,
      );
    }

    for (const positive of [
      "if (option.name === 'Color') return true;",
      "if (option.name.toLowerCase() === 'colour') return true;",
      "category.slug === 'shoes'",
    ]) {
      expect(
        HARDCODED_CATALOG_COMPARISON.test(positive),
        `comparison probe missed: ${positive}`,
      ).toBe(true);
    }
    for (const negative of [
      'if (option.name === selectedName) return true;',
      "if (user.name === 'anonymous') return true;",
    ]) {
      expect(
        HARDCODED_CATALOG_COMPARISON.test(negative),
        `comparison probe over-matched: ${negative}`,
      ).toBe(false);
    }
  });

  it('names an exception path the walk actually read, and states a reason', () => {
    const sources = ungatedClientSources();
    for (const entry of PERMITTED) {
      // A stale path permits nothing and reads exactly like a correct run.
      expect(sources.has(entry.path), `permitted path is stale: ${entry.path}`).toBe(true);
      expect(entry.disposition.trim().length, `${entry.path} has no disposition`).toBeGreaterThan(
        80,
      );
    }
    expect(PERMITTED).toHaveLength(1);
  });

  it('imports nothing from a client package', () => {
    // The rule this file's header states, asserted about the file itself: a
    // backend test that imported `strict: true` source would compile it under
    // the backend's `strict: false` program and drop its null-safety checks.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const imports = [...self.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1] ?? '');
    expect(imports.length, 'the import scan found nothing — did the probe break?').toBeGreaterThan(
      2,
    );
    for (const specifier of imports) {
      expect(
        /@mercaria\/(?:ui|frontend|dashboard|pos)|packages\/(?:ui|frontend|dashboard|pos)/u.test(
          specifier,
        ),
        `this census imports client source (${specifier}); it must read it as TEXT`,
      ).toBe(false);
    }
  });
});
