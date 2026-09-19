/**
 * The three walls around digital analytics, asserted STRUCTURALLY.
 *
 *  1. **No IP, raw, hashed or geo-derived** — `~/AGENTS.md`'s invariant, which
 *     `asset_download_events` already honours by carrying no such column and which
 *     ADR 0010 D10 extends into the tax path. Held here as an allow-list over every
 *     field name this directory declares, because the cheap way to break the
 *     invariant is a field called `ipCountry` that somebody thinks is aggregate
 *     enough.
 *  2. **No property bag** — `docs/analytics.md`'s founding rule for the sibling
 *     domain: *"an allow-list of typed columns, never a free property bag"*. An
 *     index signature, a `Record<string, unknown>` or a bare `unknown` would let
 *     every field the first wall forbids through in a shape no scan can read.
 *  3. **Ranking cannot read this, and this cannot read commercial standing** —
 *     #1015 W13's closing rule and boundary 12. `analytics-ranking-isolation.test.ts`
 *     is the precedent and this is the same shape pointed at a new directory,
 *     reusing the ONE derived ranking surface rather than copying a path list
 *     (#460 is what copied lists do).
 *
 * All three scanners carry the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor, so a broken walk cannot pass by scanning nothing, and a mutation self-test,
 * so a detector that matches nothing cannot pass by detecting nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../../__tests__/ranking-surface.js';
import { assertEachOf } from '../../../../__tests__/assert-each-of.js';
import { DIGITAL_ANALYTICS_FORBIDDEN_FIELD_SEGMENTS } from '../facts.js';
import { DIGITAL_METRIC_SCOPES } from '../metrics.js';

const ANALYTICS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every module of the directory, excluding the test tree. Walked, never listed. */
function analyticsModules(): string[] {
  return readdirSync(ANALYTICS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name);
}

const MODULES = analyticsModules();

function sourceOf(name: string): string {
  const source = readFileSync(join(ANALYTICS_ROOT, name), 'utf8');
  expect(source.length, `${name} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * One module's source with every comment line removed.
 *
 * The scans below look for shapes a module DECLARES, and every docblock in this
 * directory quotes the shapes it refuses — `facts.ts` names
 * `Record<string, unknown>` in the paragraph explaining why it has none. A scanner
 * that read prose as code would report the explanation as the offence, and the
 * cheapest way to green that is to delete the explanation.
 */
function codeOf(name: string): string {
  return sourceOf(name)
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

/**
 * Every field name this directory declares.
 *
 * Read from the SOURCE rather than from runtime objects, because the hazard is a
 * declared field on a type nothing has constructed yet — which is exactly the state
 * a field is in between being added and being populated.
 */
function declaredFieldNames(): { module: string; field: string }[] {
  const found: { module: string; field: string }[] = [];
  for (const name of MODULES) {
    for (const line of sourceOf(name).split('\n')) {
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue;
      const match = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??:\s/.exec(line);
      if (match !== null) found.push({ module: name, field: match[1] });
    }
  }
  return found;
}

/** `ipAddress` → `['ip', 'address']`; `latency_ms` → `['latency', 'ms']`. */
function segmentsOf(field: string): string[] {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter((segment) => segment.length > 0);
}

/** The forbidden segments this name carries, if any. */
function forbiddenSegmentsIn(field: string): string[] {
  const segments = segmentsOf(field);
  return DIGITAL_ANALYTICS_FORBIDDEN_FIELD_SEGMENTS.filter((forbidden) =>
    segments.includes(forbidden),
  );
}

describe('#1015 W6 — the population these gates scan', () => {
  it('is the whole directory, and it is not empty', () => {
    // Five modules today: facts, metrics, geography, creator-analytics,
    // launch-metrics. The vacuity floor.
    expect(MODULES.length).toBeGreaterThanOrEqual(5);
    for (const name of MODULES) {
      expect(statSync(join(ANALYTICS_ROOT, name)).isFile(), `${name} is not a file`).toBe(true);
    }
    expect(MODULES.filter((name) => name.includes('.test.'))).toEqual([]);
  });

  it('and the field scan really found fields', () => {
    // A floor on the SCAN, not on the offence list. A regex that stopped matching
    // would make every assertion below vacuous while staying green.
    expect(declaredFieldNames().length).toBeGreaterThan(60);
  });
});

describe('~/AGENTS.md — no IP, raw, hashed or geo-derived, anywhere', () => {
  it('no declared field name carries a forbidden segment', () => {
    const offenders = declaredFieldNames()
      .map(({ module, field }) => ({ module, field, hits: forbiddenSegmentsIn(field) }))
      .filter((entry) => entry.hits.length > 0)
      .map((entry) => `${entry.module}:${entry.field} (${entry.hits.join(', ')})`);
    expect(offenders).toEqual([]);
  });

  it('the detector detects — the mutation self-test', () => {
    // The hashed and geo-derived forms, which the invariant forbids as explicitly
    // as the raw one and which a substring scan for "ip_address" would miss.
    assertEachOf(
      ['ipAddress', 'ipHash', 'ipCountry', 'geoipRegion', 'deviceFingerprint', 'userAgent', 'postalCode', 'buyerKey', 'pseudonymousSessionId'],
      9,
      (seeded) => {
        expect(forbiddenSegmentsIn(seeded), `${seeded} was not caught`).not.toEqual([]);
      },
    );
    // And the innocent names the sibling gate's rewrite had to rescue: a segment
    // match, not a substring match, is what keeps these legal.
    assertEachOf(['latencyMs', 'supplyCountry', 'assetId', 'licenceVersionId', 'grossAmount'], 5, (innocent) => {
      expect(forbiddenSegmentsIn(innocent), `${innocent} was wrongly caught`).toEqual([]);
    });
  });

  it('`supplyCountry` is the ONE place fact, and the narrower ones are forbidden', () => {
    // ADR 0010 D10: a digital supply establishes a COUNTRY and nothing narrower,
    // and `FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS` forbids deriving even that from
    // an IP. So `country` must be legal and `region`, `postal` and the coordinate
    // family must not.
    expect(forbiddenSegmentsIn('supplyCountry')).toEqual([]);
    assertEachOf(['supplyRegion', 'supplyPostalCode', 'supplyLatitude', 'supplyCity'], 4, (field) => {
      expect(forbiddenSegmentsIn(field), `${field} is not forbidden`).not.toEqual([]);
    });
  });

  it('the forbidden list is a real list, not an empty one', () => {
    expect(DIGITAL_ANALYTICS_FORBIDDEN_FIELD_SEGMENTS.length).toBeGreaterThanOrEqual(25);
  });
});

describe('docs/analytics.md — an allow-list of typed fields, never a property bag', () => {
  const BAG_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
    { label: 'an index signature', pattern: /\[\s*\w+\s*:\s*string\s*\]\s*:/ },
    { label: 'a string-keyed Record of unknown', pattern: /Record<\s*string\s*,\s*unknown\s*>/ },
    { label: 'a string-keyed Record of any', pattern: /Record<\s*string\s*,\s*any\s*>/ },
    { label: 'a bare `unknown` field', pattern: /^\s*(?:readonly\s+)?\w+\??:\s*unknown/m },
    { label: 'a bare `any` field', pattern: /^\s*(?:readonly\s+)?\w+\??:\s*any\b/m },
    { label: 'a JSON blob', pattern: /:\s*(?:JsonValue|object)\b/ },
  ];

  it('no module declares one', () => {
    const offenders: string[] = [];
    for (const name of MODULES) {
      const code = codeOf(name);
      for (const { label, pattern } of BAG_PATTERNS) {
        if (pattern.test(code)) offenders.push(`${name} declares ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the detector detects — the mutation self-test', () => {
    assertEachOf(
      [
        'export interface Bad { readonly [key: string]: number }',
        'readonly properties: Record<string, unknown>;',
        'readonly extra: unknown;',
        'readonly payload: any;',
      ],
      4,
      (seeded) => {
        expect(
          BAG_PATTERNS.some(({ pattern }) => pattern.test(seeded)),
          `${seeded} was not caught`,
        ).toBe(true);
      },
    );
    const innocent = 'readonly amounts: readonly DigitalCurrencyAmount[];';
    expect(BAG_PATTERNS.some(({ pattern }) => pattern.test(innocent))).toBe(false);
  });
});

describe('#1015 W13 — downloads and fee yield are not an organic-ranking boost', () => {
  it('no ranking surface imports this directory', () => {
    // The ONE derived surface, floors and all. A copied path list is what #460
    // measured going stale in eleven gates at once.
    assertRankingSurfaceIsWhole();
    const offenders = RANKING_SURFACE_PATHS.filter((path) =>
      readRankingSurfaceFile(path).includes('digital/analytics'),
    );
    expect(offenders).toEqual([]);
  });

  it('and the detector would notice if one did — the mutation self-test', () => {
    const seeded = "import { computeLaunchMetrics } from '../services/digital/analytics/launch-metrics.js';";
    expect(seeded.includes('digital/analytics')).toBe(true);
    const innocent = "import { rankOffers } from '../services/ranking/score.js';";
    expect(innocent.includes('digital/analytics')).toBe(false);
  });

  it('nothing here reads an ordering engine, a fee schedule, a plan or a referral', () => {
    const FORBIDDEN = ['services/ranking', 'db/ranking', 'services/search', 'db/search', 'fees', 'merchantPlans', 'referral'] as const;
    const offenders: string[] = [];
    for (const name of MODULES) {
      for (const specifier of [...codeOf(name).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])) {
        for (const target of FORBIDDEN) {
          if (specifier.includes(target)) offenders.push(`${name} imports ${specifier}`);
        }
      }
    }
    // A metric weighted by what a merchant pays is the same defect from the other
    // direction, and the sibling gate names it as the second of its two walls.
    expect(offenders).toEqual([]);
  });

  it('there is no metric scope an ordering engine could consume', () => {
    // Two members. A listing, offer, variant or canonical-product scope is the
    // shape ranking can order by, and there is none to declare a metric in.
    expect([...DIGITAL_METRIC_SCOPES]).toEqual(['store', 'deployment']);
    assertEachOf(['listing', 'offer', 'variant', 'canonical_product', 'product'], 5, (scope) => {
      expect([...DIGITAL_METRIC_SCOPES] as string[]).not.toContain(scope);
    });
  });

  it('and no output type is keyed by a thing ranking orders', () => {
    const offenders = declaredFieldNames().filter(({ field }) =>
      ['listingId', 'offerId', 'variantId', 'canonicalProductId', 'canonicalVariantId', 'rank', 'score', 'boost', 'weight'].includes(
        field,
      ),
    );
    // `assetId` is deliberately allowed and is the finest grain here: an asset is
    // not a listing, a variant or an offer (ADR 0010 D2), and scoring an offer from
    // it would need the `asset_variant_bindings` join nothing here imports.
    expect(offenders).toEqual([]);
    expect(declaredFieldNames().some(({ field }) => field === 'assetId')).toBe(true);
  });
});
