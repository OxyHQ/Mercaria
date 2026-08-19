/**
 * The five walls #80 asks for, asserted STRUCTURALLY rather than promised.
 *
 * 1. **Saving creates no alert** (#80 API rule 6). No module in the domain can
 *    reach a subscription, a watch or a notification preference.
 * 2. **A save is not a ranking input** (#74's to decide, not #80's). No feed,
 *    search or catalogue-read module can reach the save domain — the
 *    `fee-ranking-isolation` wall, pointed at popularity instead of money,
 *    which is the signal most likely to be reached for by accident.
 * 3. **The migration never removes a favorite** (#80 acceptance 2). No module
 *    in the domain issues a delete or an update against `favorites`.
 * 4. **A saved list cannot be public** (#80 privacy rule 6). The permitted and
 *    forbidden visibility sets are DISJOINT, and the only permitted one is
 *    `private`.
 * 5. **The domain stores nothing about a person but their account id** (#80
 *    privacy rule 5). No column of the three tables carries a contact detail, a
 *    display name or a device identifier.
 *
 * Every scanner carries the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor so a moved file fails instead of silently shrinking the scan, and a
 * mutation self-test so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import { getTableColumns } from 'drizzle-orm';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';
import {
  PRODUCT_SAVE_FORBIDDEN_SIDE_EFFECTS,
  PRODUCT_SAVE_FORBIDDEN_VISIBILITIES,
  PRODUCT_SAVE_VISIBILITIES,
} from '@mercaria/shared-types';
import {
  productSaveAggregates,
  productSaveSources,
  productSaves,
} from '../../../db/schema/productSaves.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** What a module of this domain is called, wherever it lives. */
const SAVE_NAME_PATTERN = /product-?saves?/i;

/** The two directories this domain owns outright. */
const OWNED_DIRECTORIES = ['services/product-saves', 'db/productSaves'] as const;

/**
 * The flat directories a module of this domain lives in under a domain NAME.
 *
 * The population was the two owned directories and NOTHING ELSE, read one level
 * deep. So SIX modules were behind none of the walls below (#460): both routes,
 * the request schemas, both controllers — including the operator surface — and
 * `db/schema/productSaves.ts`, which is where `UNIQUE(oxy_user_id,
 * canonical_product_id)` and the `save_intent` CHECK are actually DECLARED.
 *
 * The hyphen is optional and the plural optional because `db/productSaves/` and
 * `db/schema/productSaves.ts` are camelCase; a widening that changes nothing
 * looks exactly like a fix, so it is measured: `/product-?saves?/i` over the
 * whole of `src/` selects 19 modules and every one is this domain's.
 */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    // RECURSIVE, where this read one directory level.
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, SAVE_NAME_PATTERN, readDir),
  ];
}

/** Every module of the product-save domain, enumerated from disk. */
function domainSources(): { relative: string; source: string }[] {
  return domainRelativePaths().map((relative) => ({
    relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/**
 * Strip comments before a reachability scan.
 *
 * These modules DOCUMENT what they refuse to do, in the same vocabulary the
 * detectors look for — `save-migration.service.ts` says "issues no DELETE
 * against `favorites`" in as many words. Scanning raw source would make the
 * gate fire on its own explanation, and the fix somebody would reach for is to
 * delete the explanation.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Reaching an alert, a watch or a notification subscription, from any direction.
 *
 * Written as REACHES rather than as the word "alert", deliberately: this domain
 * carries a `priceAlert` DTO field, and a detector that fired on the field name
 * would fire on the very thing that states what the domain may and may not do —
 * which makes the obvious fix "delete the seam". So it looks for an IMPORT of an
 * alert or notification module, one of the tables such a thing would live in,
 * or a call that creates or sends one.
 *
 * #79 SHIPPED price alerts and closed #80's one-branch seam, and this wall did
 * not move: saving still subscribes to nothing, and the supported branch of
 * `ProductSavePriceAlert` deliberately carries no alert id, no target and no
 * subscription state — because reading one would mean this domain importing
 * `services/price-alerts/`, which the pattern below still refuses.
 */
const ALERT_REFERENCE =
  /from\s+'[^']*(alerts?|notification|watchlist)[^']*'|price_alerts?\b|price_watches\b|alert_subscriptions\b|web_push_subscriptions\b|push_tokens\b|create(Price)?(Alert|Watch)\w*\(|subscribeTo\w*\(|enqueueNotification\w*\(|sendNotification\w*\(|notifyUser\w*\(|createNotification\w*\(/;

/** Reaching the product-save domain, from any direction. */
const SAVE_DOMAIN_REFERENCE =
  /product-saves\/|productSaves\/|productSaveAggregates|product_save_aggregates|product_saves\b|rebuildProductSaveAggregate/;

/** A write against `favorites`, from any direction. */
const FAVORITE_WRITE =
  /\.delete\(\s*favorites|\.update\(\s*favorites|deleteFavorite|updateFavoriteSaveIntent|delete from "?favorites/;

/**
 * The organic discovery surface — ONE derivation shared with the ten sibling
 * gates that assert the same shape of wall (`__tests__/ranking-surface.ts`).
 *
 * This was fifteen hand-written paths said to be "the same list
 * `fee-ranking-isolation.test.ts` scans". It was not: the fee gate's copy had
 * nineteen. Eleven copies of one list is eleven chances to drift, and they had
 * (#460).
 */

describe('saving a product has no side effects and no reach', () => {
  const domain = domainSources();

  it('is not vacuous: the domain has real modules and they are not empty', () => {
    // The floor catches a renamed directory, which would otherwise make every
    // scan below pass against an empty list.
    expect(domain.length).toBeGreaterThanOrEqual(8);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('WALL 1: no module in the domain can create a price alert or a subscription', () => {
    for (const file of domain) {
      expect(
        ALERT_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches an alert or subscription; saving must create neither (#80 API rule 6)`,
      ).toBe(false);
    }
  });

  it('WALL 1 names its prohibitions as VALUES, and the seam it DOES carry is present', () => {
    expect(PRODUCT_SAVE_FORBIDDEN_SIDE_EFFECTS).toContain('price_alert_subscription');
    expect(PRODUCT_SAVE_FORBIDDEN_SIDE_EFFECTS.length).toBeGreaterThanOrEqual(5);
    // The positive control for WALL 1: proving the domain reaches no alert is
    // only half the claim — #80 API rule 6 also asks the API to OFFER the
    // action, so the projection has to actually carry the field rather than
    // omitting it entirely. Since #79 landed, the value is a DEPLOYMENT fact
    // (is the surface mounted) and never a per-save read, which is what keeps
    // it on the right side of the wall above.
    const projection = domain.find((file) => file.relative.endsWith('saved-product-view.ts'));
    expect(projection?.source).toContain('PRODUCT_SAVE_PRICE_ALERT_SUPPORTED');
    expect(projection?.source).toContain('PRODUCT_SAVE_PRICE_ALERT_DISABLED');
  });

  it('WALL 2: no ranking module can reach the product-save domain', () => {
    let scanned = 0;
    assertRankingSurfaceIsWhole();
    for (const relative of RANKING_SURFACE_PATHS) {
      const source = readRankingSurfaceFile(relative);
      expect(
        SAVE_DOMAIN_REFERENCE.test(source),
        `${relative} references the product-save domain; how many people saved something is #74's ` +
          'decision to make deliberately, not one a feed inherits by importing a counter',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_SURFACE_PATHS.length);
  });

  it('WALL 3: no module in the domain writes to `favorites`', () => {
    for (const file of domain) {
      expect(
        FAVORITE_WRITE.test(withoutComments(file.source)),
        `${file.relative} writes to \`favorites\`; #80 acceptance 2 is that no existing favorite is ` +
          'dropped, and the migration achieving that by never having a write is stronger than a ' +
          'migration that has one and does not use it',
      ).toBe(false);
    }
  });

  it('WALL 4: a saved list cannot be public', () => {
    expect([...PRODUCT_SAVE_VISIBILITIES]).toEqual(['private']);
    const overlap = PRODUCT_SAVE_VISIBILITIES.filter((value) =>
      PRODUCT_SAVE_FORBIDDEN_VISIBILITIES.includes(value),
    );
    expect(
      overlap,
      'a forbidden visibility joined the permitted tuple; #80 privacy rule 6 excludes a public ' +
        'saved-list profile from this issue entirely',
    ).toEqual([]);
    expect(PRODUCT_SAVE_FORBIDDEN_VISIBILITIES).toContain('public');
  });

  it('WALL 5: no column of the domain carries anything about a person but their account id', () => {
    const forbidden =
      /email|phone|address|postal|full_?name|display_?name|handle|username|avatar|ip_?address|user_?agent|device|fingerprint|token|session/i;
    const tables = [
      { name: 'product_saves', columns: Object.keys(getTableColumns(productSaves)) },
      { name: 'product_save_sources', columns: Object.keys(getTableColumns(productSaveSources)) },
      {
        name: 'product_save_aggregates',
        columns: Object.keys(getTableColumns(productSaveAggregates)),
      },
    ];
    // The vacuity floor: a broken reflection would return no columns and pass.
    const total = tables.reduce((sum, table) => sum + table.columns.length, 0);
    expect(total).toBeGreaterThanOrEqual(25);

    for (const table of tables) {
      for (const column of table.columns) {
        expect(
          forbidden.test(column),
          `${table.name}.${column} looks like a personal detail; this domain stores an Oxy ` +
            'account id and nothing else about a person (#80 privacy rule 5)',
        ).toBe(false);
      }
    }
  });

  it('the aggregate has NO actor column, which is how the count cannot name anybody', () => {
    // #80 privacy rule 1, held by an absence rather than by a projection
    // somebody has to keep honest.
    const columns = Object.keys(getTableColumns(productSaveAggregates));
    expect(columns).not.toContain('oxyUserId');
    expect(columns.filter((name) => /oxy|user|actor|buyer/i.test(name))).toEqual([]);
  });

  it('MUTATION SELF-TEST: every detector actually detects', () => {
    // A scanner whose regex rotted would pass every assertion above vacuously.
    expect(ALERT_REFERENCE.test("import { createPriceWatch } from '../alerts.js';")).toBe(true);
    expect(ALERT_REFERENCE.test('await createPriceAlert({ productId });')).toBe(true);
    expect(ALERT_REFERENCE.test('select * from price_watches')).toBe(true);
    expect(ALERT_REFERENCE.test('await enqueueNotification(userId, payload);')).toBe(true);
    // …and does NOT fire on the #78 seam this domain legitimately carries,
    // which is the whole reason the detector is written as a reach rather than
    // as the word: firing here would make deleting the refusal the fix.
    expect(ALERT_REFERENCE.test("reason: 'price_alerts_disabled'")).toBe(false);
    expect(ALERT_REFERENCE.test('priceAlert: PRODUCT_SAVE_PRICE_ALERT_SUPPORTED,')).toBe(false);
    // …and DOES fire on the one thing #79 landing could tempt somebody into:
    // reading the alert domain from here to say "you already have one".
    expect(
      ALERT_REFERENCE.test("import { listPriceAlerts } from '../price-alerts/alert.service.js';"),
    ).toBe(true);

    expect(SAVE_DOMAIN_REFERENCE.test("import { x } from '../product-saves/best-offer.js';")).toBe(
      true,
    );
    expect(SAVE_DOMAIN_REFERENCE.test('select count(*) from product_saves')).toBe(true);
    expect(SAVE_DOMAIN_REFERENCE.test("import { getFeed } from './feed.service.js';")).toBe(false);

    expect(FAVORITE_WRITE.test('await db.delete(favorites).where(...)')).toBe(true);
    expect(FAVORITE_WRITE.test('await db.update(favorites).set({...})')).toBe(true);
    expect(FAVORITE_WRITE.test('const rows = await db.select().from(favorites)')).toBe(false);

    // And the comment stripper must not eat real code, or WALL 3 would pass by
    // scanning nothing.
    expect(withoutComments('// a comment\nawait db.delete(favorites);')).toContain(
      'db.delete(favorites)',
    );
    expect(withoutComments('/* issues no db.delete(favorites) */\nconst x = 1;')).not.toContain(
      'db.delete(favorites)',
    );
  });
});

/**
 * The population's own defence.
 *
 * The DIRECTORY list above is the last hand list in this gate. Sweep the whole
 * of `src/` for paths NAMING this domain and require each to be in the
 * population or in a counted exclusion.
 *
 * The exclusion set is EMPTY because it was MEASURED — the sweep selects 19
 * modules and every one is this domain's.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  it('every product-save-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: SAVE_NAME_PATTERN,
      notThisDomain: [],
      // Below today's 19 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 14,
      plantIn: 'lib',
      plantName: 'product-saves-cache.ts',
    });
  });

  it('the six modules the old population could not reach are in it', () => {
    // An identity assertion, not a floor. These are exactly what the two-owned-
    // directory population missed, and a floor set below 19 would be met without
    // any of them — the same shape as the sweep floor that could not see a
    // narrowed pattern.
    const population = domainRelativePaths();
    for (const named of [
      'routes/product-saves.ts',
      'routes/internal-product-saves.ts',
      'middleware/product-save-schemas.ts',
      'controllers/product-saves.controller.ts',
      'controllers/product-saves-operator.controller.ts',
      'db/schema/productSaves.ts',
    ]) {
      expect(population, `${named} is outside the walls again`).toContain(named);
    }
  });
});
