/**
 * EU 42, US Men's 9 and UK 8 are three sizes and stay three sizes
 * (#367 Workstream 4: "add tests proving EU 42, US Men's 9 and UK 8 are not
 * collapsed without the required context", and "model size system explicitly").
 *
 * ## The case that matters is the one asserting they do NOT interconvert
 *
 * A file exercising conversions inside one system measures nothing about
 * non-equivalence: every assertion in it passes against an implementation that
 * happily maps EU 42 onto UK 8. So every claim here is a REFUSAL, and every
 * refusal is paired with the comparison that must SUCCEED — because a
 * `compareSizeDeclarations` that refused everything would satisfy all of the
 * first kind and is the failure with the widest blast radius (nothing in the
 * catalogue would ever match a size filter again).
 *
 * ## Two hazards this file is shaped around
 *
 * 1. **The numeric coincidence.** A US men's 9 and a UK 9 carry the identical
 *    token `9`. Any comparison that reaches the VALUE before it has settled the
 *    SYSTEM answers "equal" and is wrong by a full size. That pair is asserted
 *    explicitly rather than left to the exhaustive walk, because it is the one
 *    a plausible implementation gets wrong.
 * 2. **Two silences agreeing.** Two systems that both decline to state an
 *    audience must not match each other — `unspecified` is "nobody said", not a
 *    department. Asserted before the equality path, which is also the order the
 *    implementation checks in.
 *
 * ## Where the real catalogue already holds this, and what this adds
 *
 * `scripts/seed-verticals/__tests__/verticals-footwear.realdb.test.ts` proves it
 * against a real database for the footwear package — four systems, four facets,
 * no bucket of one reaching another — and `facet-isolation.test.ts` scans the
 * FACET domain for a conversion helper. Both are scoped to one domain. What is
 * added here is the property over the MODEL, exhaustively, plus a scan that
 * covers the whole backend rather than one directory.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIZE_AUDIENCES,
  SIZE_COMPARISON_REFUSALS,
  SIZE_DOMAINS,
  SIZE_MEASUREMENT_BASES,
  SIZE_REGIONS,
  SIZE_SYSTEM_FORBIDDEN_OPERATIONS,
  SIZE_VALUE_SHAPES,
  compareSizeDeclarations,
  type SizeDeclaration,
  type SizeSystem,
} from '@mercaria/shared-types';

const BACKEND_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHARED_TYPES_SRC = join(BACKEND_SRC, '..', '..', 'shared-types', 'src');

/**
 * The systems the launch footwear package actually declares, as descriptors.
 *
 * Derived from the four attribute keys `scripts/seed-verticals/footwear.ts`
 * publishes rather than invented, so the pairs walked below are the pairs a
 * shopper can really produce. `shoe_size_cm` is the one worth reading: it is a
 * real foot LENGTH in the `length` unit family, where the other three are
 * manufacturer labels — a different measurement basis, which is why no amount
 * of arithmetic relates them.
 */
const FOOTWEAR: readonly SizeSystem[] = [
  {
    key: 'shoe_size_eu',
    domain: 'footwear',
    region: 'eu',
    audience: 'unisex',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    key: 'shoe_size_uk',
    domain: 'footwear',
    region: 'uk',
    audience: 'unisex',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    key: 'shoe_size_us_mens',
    domain: 'footwear',
    region: 'us',
    audience: 'mens',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    key: 'shoe_size_us_womens',
    domain: 'footwear',
    region: 'us',
    audience: 'womens',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    key: 'shoe_size_cm',
    domain: 'footwear',
    region: 'international',
    audience: 'unisex',
    measurementBasis: 'foot_length',
    valueShape: 'measurement',
  },
];

/** One system from another domain, and one that never stated an audience. */
const APPAREL_UK: SizeSystem = {
  key: 'dress_size_uk',
  domain: 'apparel',
  region: 'uk',
  audience: 'womens',
  measurementBasis: 'manufacturer_label',
  valueShape: 'numeric',
};

const UNDECLARED_AUDIENCE: SizeSystem = {
  key: 'shoe_size_legacy',
  domain: 'footwear',
  region: 'eu',
  audience: 'unspecified',
  measurementBasis: 'manufacturer_label',
  valueShape: 'numeric',
};

const ALL_SYSTEMS: readonly SizeSystem[] = [...FOOTWEAR, APPAREL_UK, UNDECLARED_AUDIENCE];

function sized(system: SizeSystem, value: string): SizeDeclaration {
  return { system, value };
}

function systemNamed(key: string): SizeSystem {
  const found = ALL_SYSTEMS.find((system) => system.key === key);
  if (found === undefined) throw new Error(`no fixture system '${key}'`);
  return found;
}

describe('the four facets are four closed vocabularies', () => {
  it('carries a member for every fact a size system consists of', () => {
    // Vacuity floors on each tuple. An emptied one makes every descriptor below
    // unbuildable at the type level but leaves a runtime walk over it silent.
    expect(SIZE_DOMAINS.length).toBeGreaterThanOrEqual(3);
    expect(SIZE_REGIONS.length).toBeGreaterThanOrEqual(4);
    expect(SIZE_AUDIENCES.length).toBeGreaterThanOrEqual(4);
    expect(SIZE_MEASUREMENT_BASES.length).toBeGreaterThanOrEqual(4);
    expect(SIZE_VALUE_SHAPES.length).toBeGreaterThanOrEqual(3);
    expect(SIZE_COMPARISON_REFUSALS.length).toBeGreaterThanOrEqual(5);

    // The requirement is "footwear, apparel, rings and other FUTURE domains
    // without one generic `size` enum". A domain that has to be added before an
    // apparel size can be modelled is that enum arriving by another route.
    for (const domain of ['footwear', 'apparel', 'ring']) {
      expect(SIZE_DOMAINS as readonly string[]).toContain(domain);
    }
    // `unisex` and `unspecified` are different members, or "nobody stated an
    // audience" becomes a department.
    expect(SIZE_AUDIENCES as readonly string[]).toContain('unisex');
    expect(SIZE_AUDIENCES as readonly string[]).toContain('unspecified');
    expect(new Set(SIZE_AUDIENCES).size).toBe(SIZE_AUDIENCES.length);
  });

  it('separates a manufacturer label from a real measurement', () => {
    // The facet a reader assumes away. `shoe_size_eu` is a token on a box;
    // `shoe_size_cm` is a foot. Treating the first like the second is how
    // "EU 42 is 26.5 cm" becomes a fact the catalogue asserts about every brand.
    expect(SIZE_MEASUREMENT_BASES as readonly string[]).toContain('manufacturer_label');
    expect(SIZE_MEASUREMENT_BASES as readonly string[]).toContain('foot_length');
    expect(systemNamed('shoe_size_eu').measurementBasis).toBe('manufacturer_label');
    expect(systemNamed('shoe_size_cm').measurementBasis).toBe('foot_length');
  });
});

describe('EU 42, US Men’s 9 and UK 8 are three sizes', () => {
  const eu42 = sized(systemNamed('shoe_size_eu'), '42');
  const us9 = sized(systemNamed('shoe_size_us_mens'), '9');
  const uk8 = sized(systemNamed('shoe_size_uk'), '8');

  it('refuses every pair of them, naming the facet that differs', () => {
    expect(compareSizeDeclarations(eu42, us9)).toEqual({
      outcome: 'refused',
      reason: 'different_audience',
    });
    expect(compareSizeDeclarations(us9, uk8)).toEqual({
      outcome: 'refused',
      reason: 'different_audience',
    });
    expect(compareSizeDeclarations(eu42, uk8)).toEqual({
      outcome: 'refused',
      reason: 'different_region',
    });
    // Symmetric, because a comparison that answered differently by argument
    // order would be resolvable by whichever side a caller happened to put
    // first.
    for (const [left, right] of [
      [eu42, us9],
      [us9, uk8],
      [eu42, uk8],
    ] as const) {
      expect(compareSizeDeclarations(left, right)).toEqual(compareSizeDeclarations(right, left));
    }
  });

  it('still compares each with ITSELF — the arm that fails if it refuses everything', () => {
    for (const declaration of [eu42, us9, uk8]) {
      expect(compareSizeDeclarations(declaration, declaration)).toEqual({
        outcome: 'equal',
        systemKey: declaration.system.key,
      });
    }
  });

  it('tells one system’s two values apart WITHOUT refusing them', () => {
    // `different_value` is not a refusal: EU 42 and EU 43 are comparable and
    // different, which is what a size filter inside one system needs.
    expect(compareSizeDeclarations(eu42, sized(systemNamed('shoe_size_eu'), '43'))).toEqual({
      outcome: 'different_value',
      systemKey: 'shoe_size_eu',
    });
  });
});

describe('the hazards a plausible implementation walks into', () => {
  it('does not equate a US men’s 9 with a UK 9, though the token is identical', () => {
    // The sharpest case in the file. Any comparison that reaches the VALUE
    // before it has settled the SYSTEM answers `equal` here and is wrong by a
    // full size.
    const usNine = sized(systemNamed('shoe_size_us_mens'), '9');
    const ukNine = sized(systemNamed('shoe_size_uk'), '9');
    expect(usNine.value).toBe(ukNine.value);
    expect(compareSizeDeclarations(usNine, ukNine)).toEqual({
      outcome: 'refused',
      reason: 'different_audience',
    });
  });

  it('does not equate a US men’s 9 with a US women’s 9', () => {
    // Same domain, same region, same basis, same token — about an inch and a
    // half of foot apart. This is the pair that fails if the audience facet is
    // dropped, and NOTHING else in this file would notice.
    expect(
      compareSizeDeclarations(
        sized(systemNamed('shoe_size_us_mens'), '9'),
        sized(systemNamed('shoe_size_us_womens'), '9'),
      ),
    ).toEqual({ outcome: 'refused', reason: 'different_audience' });
  });

  it('does not let two silences agree with each other', () => {
    const undeclared = sized(UNDECLARED_AUDIENCE, '42');
    expect(compareSizeDeclarations(undeclared, undeclared)).toEqual({
      outcome: 'refused',
      reason: 'undeclared_audience',
    });
    // …and it does not match a system that DID declare one either.
    expect(compareSizeDeclarations(undeclared, sized(systemNamed('shoe_size_eu'), '42'))).toEqual({
      outcome: 'refused',
      reason: 'undeclared_audience',
    });
  });

  it('does not relate a shoe to a dress because both are UK', () => {
    expect(
      compareSizeDeclarations(sized(systemNamed('shoe_size_uk'), '8'), sized(APPAREL_UK, '8')),
    ).toEqual({ outcome: 'refused', reason: 'different_domain' });
  });

  it('does not relate a foot LENGTH to an EU label', () => {
    expect(
      compareSizeDeclarations(
        sized(systemNamed('shoe_size_cm'), '26.5'),
        sized(systemNamed('shoe_size_eu'), '42'),
      ),
    ).toEqual({ outcome: 'refused', reason: 'different_measurement_basis' });
  });
});

describe('the property over every pair, not over the examples above', () => {
  it('admits exactly the same-key pairs and refuses every other', () => {
    const admitted: string[] = [];
    const refused: string[] = [];
    let pairs = 0;

    for (const left of ALL_SYSTEMS) {
      for (const right of ALL_SYSTEMS) {
        pairs += 1;
        const result = compareSizeDeclarations(sized(left, '42'), sized(right, '42'));
        const label = `${left.key} vs ${right.key}`;
        if (result.outcome === 'refused') refused.push(`${label} (${result.reason})`);
        else admitted.push(label);
      }
    }

    // Both populations asserted, so neither an emptied fixture list nor a
    // comparison that answers one way for everything can pass.
    expect(pairs).toBe(ALL_SYSTEMS.length * ALL_SYSTEMS.length);
    expect(pairs).toBeGreaterThanOrEqual(49);
    // Every system except the one with no declared audience compares with
    // itself, and nothing else compares at all.
    const selfComparable = ALL_SYSTEMS.filter((system) => system.audience !== 'unspecified');
    expect(admitted.sort()).toEqual(
      selfComparable.map((system) => `${system.key} vs ${system.key}`).sort(),
    );
    expect(refused).toHaveLength(pairs - selfComparable.length);
    expect(admitted.length).toBeGreaterThan(0);
  });

  it('makes EACH of the four facets independently load-bearing', () => {
    // One constructed pair per facet, differing in that facet ALONE. This is
    // what makes the four checks separately measured: dropping any one of them
    // turns exactly one row here from its own reason into `no_sourced_mapping`,
    // where a test built only from real-world pairs (which differ in two or
    // three facets at once) would stay green for three of the four.
    const base = systemNamed('shoe_size_eu');
    const cases: readonly { facet: string; variant: SizeSystem; reason: string }[] = [
      {
        facet: 'domain',
        variant: { ...base, key: 'v_domain', domain: 'glove' },
        reason: 'different_domain',
      },
      {
        facet: 'audience',
        variant: { ...base, key: 'v_audience', audience: 'kids' },
        reason: 'different_audience',
      },
      {
        facet: 'measurementBasis',
        variant: { ...base, key: 'v_basis', measurementBasis: 'foot_length' },
        reason: 'different_measurement_basis',
      },
      {
        facet: 'region',
        variant: { ...base, key: 'v_region', region: 'jp' },
        reason: 'different_region',
      },
    ];
    // Derived from the descriptor's own shape rather than hand-counted: every
    // identity facet of a `SizeSystem` other than its key gets a row.
    const identityFacets = Object.keys(base).filter(
      (facet) => facet !== 'key' && facet !== 'valueShape',
    );
    expect(cases.map((entry) => entry.facet).sort()).toEqual(identityFacets.sort());

    for (const { facet, variant, reason } of cases) {
      // The variant really differs in ONE facet and nothing else, or the case
      // below would be measuring a different check than it names.
      const facetOf = (system: SizeSystem, name: string): unknown =>
        (system as unknown as Record<string, unknown>)[name];
      const differing = identityFacets.filter(
        (name) => facetOf(variant, name) !== facetOf(base, name),
      );
      expect(differing, `${facet} variant differs in ${differing.join(', ')}`).toEqual([facet]);
      expect(compareSizeDeclarations(sized(base, '42'), sized(variant, '42'))).toEqual({
        outcome: 'refused',
        reason,
      });
    }
  });

  it('reserves `no_sourced_mapping` for two systems that agree on all four facets', () => {
    // The only refusal that describes something Mercaria could one day have —
    // a per-product chart relating two otherwise identical systems. Reaching it
    // requires every facet to match and the keys to differ, which is what makes
    // it a statement about missing DATA rather than about the systems.
    const twin: SizeSystem = { ...systemNamed('shoe_size_eu'), key: 'shoe_size_eu_legacy' };
    expect(compareSizeDeclarations(sized(systemNamed('shoe_size_eu'), '42'), sized(twin, '42'))).toEqual(
      { outcome: 'refused', reason: 'no_sourced_mapping' },
    );
  });
});

// ─── The scan: nothing in the backend converts a size ─────────────────────────

/**
 * Shapes a size conversion would take.
 *
 * Name-based, and that limitation is stated rather than papered over: this
 * catches the helper somebody writes, not an arbitrary arithmetic. What makes
 * it worth having anyway is that a size conversion is not a line of arithmetic
 * — it is a TABLE, and a table needs a name.
 */
const SIZE_CONVERSION_SIGNALS: readonly { signal: string; pattern: RegExp }[] = [
  {
    signal: 'conversion_helper',
    pattern: /\b(?:convertSize|toSizeSystem|sizeSystemMap|SIZE_CONVERSIONS?|sizeConversion)\b/i,
  },
  { signal: 'pairwise_helper', pattern: /\b(?:euToUk|ukToEu|usToEu|euToUs|ukToUs|usToUk)\b/i },
  {
    signal: 'universal_chart',
    pattern: /\b(?:universalSizeChart|globalSizeChart|SIZE_CHART_TABLE|sizeEquivalen\w*)\b/i,
  },
  {
    signal: 'system_merge',
    pattern: /\b(?:mergeSizeSystems?|collapseSizeSystems?|unifySizes?)\b/i,
  },
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(directory: string): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      // A test NAMES the prohibition in order to test for it — including this
      // one, whose fixtures below are literally the forbidden spellings.
      if (entry === '__tests__' || entry === 'node_modules') continue;
      files.push(...walk(full));
      continue;
    }
    if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('no module in the backend converts between size systems', () => {
  it('scans the whole backend source tree and finds none', () => {
    const paths = walk(BACKEND_SRC);
    // The gate's own vacuity floor. A walk that found nothing produces zero
    // violations, which is exactly what a healthy run produces. Printed on
    // success so a shrinking population is visible rather than merely allowed.
    //
    // 1500 against 1611 on the day it was derived, and deliberately not the
    // exact count: this walks the WHOLE backend, a population every lane in
    // this epic adds to and removes from, so a floor pinned to the day would go
    // red on somebody else's deletion and be lowered by whoever hit it. What it
    // has to catch is a walk that collapsed — a wrong root, a recursion that
    // stopped at the first directory, a `readdirSync` swallowed by the `catch`
    // — and every one of those lands two orders of magnitude below this.
    expect(paths.length, `scanned ${paths.length} backend modules`).toBeGreaterThanOrEqual(1500);

    const violations: string[] = [];
    for (const path of paths) {
      const source = stripComments(readFileSync(path, 'utf8'));
      for (const { signal, pattern } of SIZE_CONVERSION_SIGNALS) {
        const match = pattern.exec(source);
        if (match !== null) violations.push(`${path} carries ${signal}: ${match[0]}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every detector detects — the mutation self-test, one fixture per signal', () => {
    const positives: Readonly<Record<string, string>> = {
      conversion_helper: "const uk = convertSize(euValue, 'eu', 'uk');",
      pairwise_helper: 'export function euToUk(value: number): number { return value - 33.5; }',
      universal_chart: 'const chart = universalSizeChart[domain];',
      system_merge: 'const one = mergeSizeSystems(eu, uk);',
    };
    // Derived from the scanned set and its length asserted, so a fixture map
    // that fell behind the detector list cannot pass by covering fewer.
    expect(Object.keys(positives).sort()).toEqual(
      SIZE_CONVERSION_SIGNALS.map((entry) => entry.signal).sort(),
    );

    const negative = 'const size = declaration.value; const system = declaration.system.key;';
    for (const { signal, pattern } of SIZE_CONVERSION_SIGNALS) {
      const fixture = positives[signal];
      expect(fixture, `no fixture for ${signal}`).toBeDefined();
      expect(pattern.test(fixture as string), `${signal} did not fire on its own fixture`).toBe(true);
      expect(pattern.test(negative), `${signal} fires on ordinary code`).toBe(false);
    }
  });

  it('strips comments before matching, and the stripper is itself controlled', () => {
    // Every module in this domain documents what it refuses to do in the same
    // words the detectors hunt for, so a scan over raw source would implicate
    // the safest files. The control proves the stripper removes a comment and
    // NOT the code beside it.
    const source = '// convertSize is forbidden\nconst kept = declaration.value;';
    const stripped = stripComments(source);
    expect(stripped).not.toContain('convertSize');
    expect(stripped).toContain('const kept');
  });
});

describe('the forbidden operations are named as values and none of them exists', () => {
  it('is disjoint from everything the module actually exports', () => {
    const source = readFileSync(join(SHARED_TYPES_SRC, 'size-system.ts'), 'utf8');
    const exported = [...source.matchAll(/^export (?:function|const|type|interface) (\w+)/gm)].map(
      (match) => match[1] as string,
    );
    // Population floor: an empty export list makes disjointness vacuous.
    expect(exported.length).toBeGreaterThanOrEqual(10);

    const snake = (name: string) =>
      name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
    // The normalizer's own control, or a broken one makes every comparison
    // below fail to match and the disjointness pass for the wrong reason.
    expect(snake('sizeConversion')).toBe('size_conversion');
    expect(SIZE_SYSTEM_FORBIDDEN_OPERATIONS as readonly string[]).toContain(snake('sizeConversion'));

    const offenders = exported.filter((name) =>
      (SIZE_SYSTEM_FORBIDDEN_OPERATIONS as readonly string[]).includes(snake(name)),
    );
    expect(offenders, `the module exports a forbidden operation: ${offenders.join(', ')}`).toEqual([]);
    expect(SIZE_SYSTEM_FORBIDDEN_OPERATIONS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(SIZE_SYSTEM_FORBIDDEN_OPERATIONS).size).toBe(
      SIZE_SYSTEM_FORBIDDEN_OPERATIONS.length,
    );
  });
});
