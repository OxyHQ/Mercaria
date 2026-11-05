/**
 * The walls around the store price-analytics tool (#89's paid
 * `competitive_price_analytics`), asserted STRUCTURALLY.
 *
 * The tool is a plan-gated surface that reads the comparison, so it sits between
 * two things that must never meet: a merchant plan and the ordering of what a
 * buyer sees. `merchant-plan-isolation.test.ts` holds the plan domain's own
 * walls; these hold this tool's:
 *
 *  1. No ranking, search or discovery module references this tool — a plan's
 *     tool cannot become an ordering input.
 *  2. This tool reaches no ordering ENGINE directly. It reads the comparison
 *     through #82's price-signal context and #78's derivation, the same reads the
 *     free surfaces use, never through `services/ranking/`, `services/search/`,
 *     their repositories or the listing-first engines.
 *  3. It writes nothing — no insert, update or delete, no catalogue write, no
 *     offer convergence: it never changes a price.
 *  4. Its copy never relates a price to placement: the dashboard's strings for
 *     the tool name no rank, placement, visibility or boost.
 *
 * Each scan has a vacuity floor and a mutation self-test.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';
import {
  PACKAGES_ROOT,
  SRC_ROOT,
  namedInSharedDirectories,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';

/** Source with comments removed — what a reachability detector must scan. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

/**
 * The tool's modules are named `price-benchmark` rather than `price-analytics`
 * on purpose: `analytics` is the platform analytics domain's slug, and a module
 * carrying it would sit inside that domain's derived populations and walls.
 */
const DOMAIN_NAMED = /store-price-benchmark|storePriceBenchmark|price-benchmark/;

function population(): string[] {
  return [
    ...walkOwnedDirectory('services/store-price-benchmark'),
    ...walkOwnedDirectory('db/storePriceBenchmark'),
    ...namedInSharedDirectories(['controllers', 'routes', 'middleware'], DOMAIN_NAMED),
  ];
}

/** Reaching this tool, from anywhere. */
const TOOL_REFERENCE =
  /store-price-benchmark|storePriceBenchmark|price-benchmark|price-analytics|readStorePrice/;

/** Reaching an ordering engine directly. */
const ENGINE_REFERENCE =
  /services\/ranking\/|services\/search\/|\.\.\/ranking\/|\.\.\/search\/|db\/ranking\/|db\/search\/|catalog-hydration|db\/catalog\/listingRepository|feed\.service|search\.service|rankOffers|relevanceScore/;

/** Writing anything. */
const WRITE_REFERENCE =
  /\.insert\(|\.update\(|\.delete\(|catalog-write|upsertNativeOffer|requestNativeOfferSync|enqueueOfferConvergence|retireOffers/;

/** Copy that ties a price to placement. */
const PLACEMENT_COPY = /\brank|placement|visibility|boost|search position|appear (higher|first)/i;

describe('the population', () => {
  it('is the tool and nothing has silently shrunk', () => {
    const paths = population();
    const from = (prefix: string) => paths.filter((path) => path.startsWith(prefix)).length;
    expect(from('services/store-price-benchmark/')).toBeGreaterThanOrEqual(3);
    expect(from('db/storePriceBenchmark/')).toBeGreaterThanOrEqual(1);
    expect(from('controllers/')).toBeGreaterThanOrEqual(1);
    expect(from('routes/')).toBeGreaterThanOrEqual(1);
    expect(from('middleware/')).toBeGreaterThanOrEqual(1);
  });
});

describe('the tool and the ordering of what a buyer sees never meet', () => {
  it('no ranking, search or discovery module references the tool', () => {
    assertRankingSurfaceIsWhole();
    for (const relative of RANKING_SURFACE_PATHS) {
      const source = withoutComments(readRankingSurfaceFile(relative));
      expect(TOOL_REFERENCE.test(source), `${relative} references the price-analytics tool`).toBe(
        false,
      );
    }
  });

  it('no module of the tool reaches an ordering engine directly', () => {
    for (const relative of population()) {
      const source = withoutComments(readFileSync(join(SRC_ROOT, relative), 'utf8'));
      expect(ENGINE_REFERENCE.test(source), `${relative} reaches an ordering engine`).toBe(false);
    }
  });

  it('no module of the tool writes anything — it never changes a price', () => {
    for (const relative of population()) {
      const source = withoutComments(readFileSync(join(SRC_ROOT, relative), 'utf8'));
      expect(WRITE_REFERENCE.test(source), `${relative} writes`).toBe(false);
    }
  });

  it("the tool's dashboard copy never relates a price to placement", () => {
    const locale = JSON.parse(
      readFileSync(join(PACKAGES_ROOT, 'dashboard/lib/i18n/locales/en.json'), 'utf8'),
    ) as Record<string, unknown>;
    const copy = locale.priceAnalytics as Record<string, unknown> | undefined;
    expect(copy, 'the tool has no copy namespace').toBeDefined();
    const strings: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(copy);
    expect(strings.length).toBeGreaterThanOrEqual(20);
    for (const text of strings) {
      expect(PLACEMENT_COPY.test(text), `"${text}" ties a price to placement`).toBe(false);
    }
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('each detector fires on a seeded positive and not on an innocent line', () => {
    expect(
      TOOL_REFERENCE.test(
        "import { readStorePriceAnalytics } from '../store-price-benchmark/x.js';",
      ),
    ).toBe(true);
    expect(TOOL_REFERENCE.test("import { getCart } from './cart.service.js';")).toBe(false);

    // A sibling-relative import from `services/store-price-benchmark/` resolves
    // into `services/ranking/` too, so it is caught as well.
    expect(ENGINE_REFERENCE.test("import { selectEligibleOffers } from '../ranking/x.js';")).toBe(
      true,
    );
    expect(
      ENGINE_REFERENCE.test("import { selectEligibleOffers } from '../services/ranking/x.js';"),
    ).toBe(true);
    expect(ENGINE_REFERENCE.test("from '../../db/catalog/listingRepository.js'")).toBe(true);
    expect(ENGINE_REFERENCE.test("from '../price-signals/context.service.js'")).toBe(false);

    expect(WRITE_REFERENCE.test('await db.update(productVariants).set({ priceAmount })')).toBe(
      true,
    );
    expect(WRITE_REFERENCE.test('await db.select().from(offers)')).toBe(false);

    expect(PLACEMENT_COPY.test('Lower your price to rank higher')).toBe(true);
    expect(PLACEMENT_COPY.test('Your price is the lowest of 4 sellers')).toBe(false);
  });

  it('comment stripping keeps a real import', () => {
    const stripped = withoutComments(
      [
        '/** services/ranking/ in a docblock */',
        "import { x } from '../../services/ranking/x.js';",
      ].join('\n'),
    );
    expect(ENGINE_REFERENCE.test(stripped)).toBe(true);
    expect(stripped.includes('docblock')).toBe(false);
  });
});
