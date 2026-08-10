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
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
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

/** Every module of the product-save domain, enumerated from disk. */
function domainSources(): { relative: string; source: string }[] {
  const roots = ['services/product-saves', 'db/productSaves'];
  const files: { relative: string; source: string }[] = [];
  for (const root of roots) {
    for (const name of readdirSync(join(SRC_ROOT, root))) {
      if (!name.endsWith('.ts')) continue;
      files.push({
        relative: `${root}/${name}`,
        source: readFileSync(join(SRC_ROOT, root, name), 'utf8'),
      });
    }
  }
  return files;
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
 * The organic discovery surface — the same list `fee-ranking-isolation.test.ts`
 * scans, and for the same reason: a new ranking module belongs on it, and the
 * floor below is what forces whoever moves one to look here.
 */
const RANKING_PATHS = [
  'services/feed.service.ts',
  'services/search.service.ts',
  'services/catalog-hydration.service.ts',
  'controllers/feed.controller.ts',
  'controllers/listings.controller.ts',
  'routes/feed.ts',
  'routes/listings.ts',
  'db/catalog/listingRepository.ts',
  // The offer comparison (#74) — the surface that now decides which offers a
  // shopper sees and in what order. It joined this list with the domain that
  // created it, which is what these lists are for.
  'services/ranking/eligibility.ts',
  'services/ranking/ranking.ts',
  'services/ranking/labels.ts',
  'services/ranking/facts.ts',
  'services/ranking/comparison.service.ts',
  'controllers/offer-comparison.controller.ts',
  'routes/offer-comparison.ts',
];

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
    for (const relative of RANKING_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        SAVE_DOMAIN_REFERENCE.test(source),
        `${relative} references the product-save domain; how many people saved something is #74's ` +
          'decision to make deliberately, not one a feed inherits by importing a counter',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_PATHS.length);
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
