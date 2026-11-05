/**
 * The wall around the paid store-page merchandising rules (#89,
 * `advanced_merchandising_rules`), asserted STRUCTURALLY.
 *
 * A plan never buys reach (`MERCHANT_PLAN_FORBIDDEN_BENEFITS`): a merchant's
 * rules may arrange THEIR OWN store page and nothing that orders listings across
 * stores. A behavioural fixture can show today's search does not read a rule;
 * the risk is tomorrow's import. So, in both directions:
 *
 *  1. No module of the derived ranking surface (`__tests__/ranking-surface.ts` —
 *     search, ranking, the feed, catalog hydration, and every controller and
 *     route that orders through them, the public store page's included) imports
 *     a merchandising-rule module or names its tables.
 *  2. No merchandising-rule module imports an ordering engine — which is also
 *     what keeps the rule-applying controller OUT of the derived surface.
 *  3. And none of them is in the surface at all.
 *
 * `merchant-plan-isolation.test.ts` asserts the plan domain's own wall; this file
 * asserts the one tool that reaches a buyer-facing page. Each scan has a vacuity
 * floor and a mutation self-test.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../__tests__/ranking-surface.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Comments removed, so a docblock explaining the wall cannot trip it. */
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

/** The tool's own modules: one directory walked, plus the named flat ones. */
const NAMED_MODULES = [
  'db/schema/merchandisingRules.ts',
  'db/merchandising/merchandisingRuleRepository.ts',
  'middleware/merchandising-rules-schemas.ts',
  'controllers/store-merchandising.controller.ts',
  'controllers/admin/merchandising-rules.controller.ts',
  'routes/store-merchandising.ts',
  'routes/admin/merchandising.ts',
] as const;

function walk(relative: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(SRC_ROOT, relative), { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(child));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

function toolModules(): string[] {
  return [...walk('services/merchandising'), ...NAMED_MODULES];
}

/** Reaching the rule tool from anywhere: an import of one of its modules, or its tables. */
const RULE_REFERENCE =
  /services\/merchandising\/|merchandisingRuleRepository|schema\/merchandisingRules|merchandising-rules-schemas|store-merchandising|merchandising_rules|merchandising_rule_pins|merchandisingRules\b|merchandisingRulePins/;

/** Reaching an ordering engine marketplace discovery runs on. */
const ENGINE_REFERENCE =
  /services\/ranking\/|services\/search\/|db\/ranking\/|db\/search\/|catalog\/listingRepository|catalog-hydration\.service|\/feed\.service|\/search\.service|commerce-graph\/relationship/;

describe('a merchandising rule cannot reach marketplace discovery', () => {
  it('no module of the ranking surface references the rule tool', () => {
    assertRankingSurfaceIsWhole();
    for (const relative of RANKING_SURFACE_PATHS) {
      const source = withoutComments(readRankingSurfaceFile(relative));
      expect(
        RULE_REFERENCE.test(source),
        `${relative} reaches the paid merchandising rules; a plan must never order anything ` +
          "outside the store's own page",
      ).toBe(false);
    }
  });

  it('no rule module imports an ordering engine, and none is in the ranking surface', () => {
    const modules = toolModules();
    // Vacuity floor: the walk and the named list together.
    expect(
      modules.length,
      'the rule tool population is too small to be real',
    ).toBeGreaterThanOrEqual(10);
    const surface = new Set(RANKING_SURFACE_PATHS);
    for (const relative of modules) {
      const raw = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(raw.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        ENGINE_REFERENCE.test(withoutComments(raw)),
        `${relative} imports an ordering engine; the rule tool orders ONE store's page through ` +
          'its own repository',
      ).toBe(false);
      expect(surface.has(relative), `${relative} was derived into the ranking surface`).toBe(false);
    }
  });

  it('the store page itself IS in the surface — the reason the rule read has its own router', () => {
    // The premise of this whole file: if the public store router left the
    // surface, the separate mount would no longer be what keeps the wall.
    expect(RANKING_SURFACE_PATHS).toContain('routes/stores.ts');
    expect(RANKING_SURFACE_PATHS).toContain('controllers/stores.controller.ts');
  });

  it('the detectors actually detect — the mutation self-test', () => {
    expect(
      RULE_REFERENCE.test(
        "import { readStorefrontMerchandising } from '../services/merchandising/storefront-merchandising.service.js';",
      ),
    ).toBe(true);
    expect(RULE_REFERENCE.test('select * from merchandising_rules')).toBe(true);
    // The FREE collection domain shares the word and must stay importable.
    expect(
      RULE_REFERENCE.test(
        "import { findCollectionById } from '../db/merchandising/collectionRepository.js';",
      ),
    ).toBe(false);
    expect(
      ENGINE_REFERENCE.test("import { hydrateListings } from '../catalog-hydration.service.js';"),
    ).toBe(true);
    expect(
      ENGINE_REFERENCE.test(
        "import { findListingsByIds } from '../../db/catalog/listingRepository.js';",
      ),
    ).toBe(true);
    expect(ENGINE_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });
});
