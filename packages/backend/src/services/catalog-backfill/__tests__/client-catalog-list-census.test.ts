/**
 * The shared and POS client trees carry no hard-coded catalog list (#367
 * workstream 13's inventory box).
 *
 * ## Why this exists at all, given two gates already do this
 *
 * It was written when workstream 8's and workstream 9's validators were each
 * PREFIX-SCOPED to one package — `packages/dashboard/` and `packages/frontend/`
 * — so neither reached `packages/pos` or `packages/ui`, and a hard-coded
 * option-name list moved one package sideways was invisible to the gate that
 * exists to forbid it. This census OBSERVED that hole and did not close it.
 *
 * **#478 closed it at the topology.** Both validators now scan the trees their
 * app actually COMPILES rather than the package it is filed under:
 * `validate-storefront-catalog-driven.mjs` reads `packages/frontend/`,
 * `packages/ui/src/` and `packages/pos/`, and
 * `validate-authoring-schema-driven.mjs` reads `packages/dashboard/` and
 * `packages/ui/src/`. Every root below is now under a deeper gate, and #478 also
 * taught wall 1 the `option.name` shape that this census's second and third
 * probes had to cover alone.
 *
 * ## So why is it still here
 *
 * Because its FIRST probe catches something the validators deliberately do not,
 * and the two disagreeing is the point rather than a defect. Wall 5 refuses an
 * array that re-lists a `@mercaria/shared-types` vocabulary, identified by the
 * TYPE ANNOTATION — and it has a standing negative control saying that an array
 * of literals with no such annotation is fine, because one is an ordinary local
 * constant. `HARDCODED_CATALOG_LIST` keys on the constant's NAME instead, so a
 * bare `const CATEGORY_NAMES = ['electronics', 'books']` with no type at all is
 * caught here and nowhere else. Measured at #478: probes 2 and 3 are now also
 * caught by wall 1, probe 1 is not.
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
 * The client roots this census reads.
 *
 * `frontend` and `dashboard` are deliberately absent, and stay absent after
 * #478: each is scanned by a validator that goes far deeper than this on every
 * shape but the unannotated list, and re-asserting the deep property here would
 * be a second authority over it whose two answers could disagree. These two are
 * kept because probe 1 is genuinely this census's own — see the header.
 *
 * The NAME is no longer "ungated": both roots have been under
 * `validate-storefront-catalog-driven.mjs` since #478, and `packages/ui/src`
 * under the authoring validator too.
 */
const CENSUSED_CLIENT_ROOTS = [
  join('packages', 'pos'),
  join('packages', 'ui', 'src'),
];

/** Every client source file under the censused roots, as `{relative path → text}`. */
function censusedClientSources(): Map<string, string> {
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
  for (const root of CENSUSED_CLIENT_ROOTS) walk(join(REPO_ROOT, root));
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
 *
 * BOTH quote styles (#478). This was single-quote only, and the population it
 * guards is largely DOUBLE-quoted — `packages/ui` included, `VariantSwatches`
 * included — so the two-line form of the very hardcoding this census exists to
 * find was invisible in the package that matters. Measured at the widening:
 * ZERO new offenders, so it is pure hardening rather than a rule change.
 */
const HARDCODED_CATALOG_COMPARISON =
  /(?:option|category|productType|facet)\.(?:name|slug|key)\s*(?:===|!==|==)\s*(['"])[^'"]+\1|\.(?:name|slug|key)\.toLowerCase\(\)\s*(?:===|!==)\s*['"]/u;

/**
 * A catalog concept's NAME used as a lookup key into some collection — the
 * shape #478 actually had:
 *
 * ```ts
 * const COLOR_OPTION_NAMES = new Set(["color", "colour", "shade"]);
 * return COLOR_OPTION_NAMES.has(option.name.trim().toLowerCase());
 * ```
 *
 * This probe exists because the other two key on the CONSTANT'S NAME, and a
 * rename walks out from under both: `COLOR_NAMES`, `SWATCH_NAMES`, `SIZE_ORDER`,
 * `ATTRIBUTE_NAMES`, `CONDITION_WORDS`, `AXIS_NAMES` and `MATERIAL_LIST` were
 * each measured `false` against the list probe. This one keys on the USE — a
 * catalog concept's free text being looked up — so it is rename-proof by
 * construction and does not care what the collection is called or where it was
 * declared.
 *
 * Broadening the list probe's NOUNS was measured and REJECTED instead of this.
 * `SIZE` flags `FONT_SIZE_TOKENS` (typography) and `COLOR`/`OPTION` flags
 * `COLOR_OPTIONS` (a hex palette in a generic colour picker) — design-system
 * vocabulary a name-matching detector cannot tell from catalog vocabulary. Each
 * would need an allow-list entry, re-growing from zero the list #478 just
 * emptied, to catch strictly less than this probe does.
 */
const HARDCODED_CATALOG_MEMBERSHIP =
  /\.(?:has|includes)\(\s*(?:option|category|productType|facet|attribute)\.(?:name|slug|key)\b/u;

/**
 * The known offenders, with a disposition each.
 *
 * `untouched WITH A REASON is a decision the census accepts; silence is not` —
 * `merge-plan-census.test.ts`'s ruling. An exact array rather than a prefix rule,
 * so it cannot be widened by accident.
 *
 * EMPTY as of #478, which removed the last entry rather than re-dispositioning
 * it: `VariantSwatches` picked a widget from `COLOR_OPTION_NAMES`, three English
 * words, and drew a colour it had invented — no `attribute_enum_values` colour
 * column and no per-value image exists, so the swatch showed a cycled gallery
 * photo or a hash of the value string. It now renders pills for every option.
 *
 * An empty list costs this census the positive control the entry was doubling
 * as — see `still catches a hardcoded list in a source the walk really read`,
 * which replaces it at the same seam.
 */
const PERMITTED: readonly { readonly path: string; readonly disposition: string }[] = [];

describe('the censused client packages', () => {
  it('reads a real, non-trivial set of client sources', () => {
    // The vacuity floor, and it is the whole assertion: a walk that found
    // nothing passes every probe below, and a moved directory or a changed
    // extension filter produces exactly that. Printed on SUCCESS by being the
    // number this compares.
    const sources = censusedClientSources();
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
    const offenders = [...censusedClientSources()]
      .filter(([, source]) => HARDCODED_CATALOG_LIST.test(source))
      .map(([path]) => path)
      .sort();

    // Exact identity, never containment: an allow-list that may only grow is the
    // gate switching itself off one defensible entry at a time.
    //
    // While PERMITTED held an entry this was ALSO its own positive control — it
    // could only pass by having FOUND that list. #478 emptied it, so this
    // assertion now passes two ways: because no client package hardcodes a
    // catalog vocabulary, or because the walk and the probe stopped composing.
    // The test below restores the control; do not delete it while this list is
    // empty.
    expect(
      offenders,
      'a client package outside the two scanned by WS8/WS9 hardcodes a catalog vocabulary. ' +
        'Read it from the server, or add it here with a disposition (#367 workstream 13)',
    ).toEqual([...PERMITTED].map((entry) => entry.path).sort());
  });

  it('still catches a hardcoded list in a source the walk really read', () => {
    // The positive control the allow-list used to provide for free, restored at
    // the same seam after #478 emptied it. The mutation self-test below already
    // proves the REGEX fires, but it feeds it a bare literal — which says
    // nothing about whether that regex is still being applied to file content
    // this walk produced. A control has to take production's path, so this one
    // takes a source the walk really read and appends a known offender to it.
    const sources = censusedClientSources();
    const [path, source] = [...sources].sort(([a], [b]) => a.localeCompare(b))[0] ?? [];
    expect(path, 'the walk read nothing to control against').toBeTypeOf('string');

    // Guards the arrangement rather than the conclusion: if this file already
    // matched, the assertion below would pass without the appended line and
    // would be measuring nothing.
    expect(HARDCODED_CATALOG_LIST.test(source ?? ''), `${path} already matches`).toBe(false);
    expect(
      HARDCODED_CATALOG_LIST.test(
        `${source ?? ''}\nconst COLOR_OPTION_NAMES = new Set(["color", "colour"]);\n`,
      ),
      'the walk/probe composition no longer catches a known hardcoded catalog list',
    ).toBe(true);
  });

  it('branches on no catalog concept’s name', () => {
    for (const [path, source] of censusedClientSources()) {
      expect(
        HARDCODED_CATALOG_COMPARISON.test(source),
        `${path} compares a catalog concept's name against a string literal`,
      ).toBe(false);
    }
  });

  it('looks no catalog concept’s name up in a hardcoded collection', () => {
    for (const [path, source] of censusedClientSources()) {
      expect(
        HARDCODED_CATALOG_MEMBERSHIP.test(source),
        `${path} looks a catalog concept's name up in a collection — the #478 shape. ` +
          'Read the concept from the server (a typed axis, a registry key) rather than ' +
          'matching its free text',
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

    // The DOUBLE-quoted half (#478). Listed separately from the positives above
    // because these exact spellings were measured `false` before the widening,
    // in a population that is largely double-quoted — so they are the control
    // that would catch the probe narrowing back to `'` alone.
    for (const positive of [
      'if (option.name === "Color") return true;',
      'if (option.name.toLowerCase() === "colour") return true;',
      'category.slug === "shoes"',
    ]) {
      expect(
        HARDCODED_CATALOG_COMPARISON.test(positive),
        `comparison probe missed a double-quoted literal: ${positive}`,
      ).toBe(true);
    }

    // The membership probe, and the RENAMES are the point: the list probe keys
    // on the constant's name and each of these was measured `false` against it.
    for (const positive of [
      'return COLOR_OPTION_NAMES.has(option.name.trim().toLowerCase());',
      'return SWATCH_WORDS.has(option.name.trim().toLowerCase());',
      'return PALETTE.includes(option.slug);',
      'if (KNOWN.has(category.key)) return true;',
    ]) {
      expect(
        HARDCODED_CATALOG_MEMBERSHIP.test(positive),
        `membership probe missed: ${positive}`,
      ).toBe(true);
    }
    for (const negative of [
      // A collection keyed on an ID or a server-derived value is the normal,
      // correct shape — the probe must not fire on selection state.
      'if (selected.has(variant.id)) return true;',
      'const s = new Set(response.buckets.map((b) => b.key));',
      'if (chosen.includes(listing.id)) return true;',
    ]) {
      expect(
        HARDCODED_CATALOG_MEMBERSHIP.test(negative),
        `membership probe over-matched: ${negative}`,
      ).toBe(false);
    }
  });

  it('names an exception path the walk actually read, and states a reason', () => {
    const sources = censusedClientSources();
    for (const entry of PERMITTED) {
      // A stale path permits nothing and reads exactly like a correct run.
      expect(sources.has(entry.path), `permitted path is stale: ${entry.path}`).toBe(true);
      expect(entry.disposition.trim().length, `${entry.path} has no disposition`).toBeGreaterThan(
        80,
      );
    }
    // The exact-count assertion on the exemptions themselves. ZERO as of #478;
    // it is not a formality, because the loop above is vacuous at this length
    // and this line is the only thing that notices an entry coming back.
    expect(PERMITTED).toHaveLength(0);
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
