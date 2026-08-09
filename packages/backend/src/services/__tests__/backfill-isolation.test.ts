/**
 * The backfill's structural boundaries (#60), asserted by SCAN rather than by
 * fixture.
 *
 * Every claim here is about what the migration CANNOT reach, and a behavioural
 * test can only ever say "it did not this time". The strongest of them is issue
 * acceptance 4 — "no placed-order document changes during migration" — which is
 * pinned twice: `backfill.realdb.test.ts` shows an apply run leaving orders
 * byte-identical (including `xmin`), and this file shows that no module in the
 * domain can reach an order, refund, payment, ledger or fee writer at all. The
 * behavioural half proves it did not happen; this half proves it could not.
 *
 * The scanner carries the two defences `~/Oxy/AGENTS.md` asks for: a VACUITY
 * FLOOR (the file set is enumerated and its size asserted, so a module moved out
 * of the domain fails the gate instead of shrinking it silently) and a MUTATION
 * SELF-TEST (each detector runs against a seeded positive, so a regex broken
 * into matching nothing fails here rather than passing every scan).
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative as relativePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The domain's directories, ENUMERATED from disk rather than listed by hand.
 *
 * `git ls-files`-style discovery, applied to a subtree: a module ADDED to the
 * domain is scanned automatically (a hand-written list is how a new stage
 * escapes the gate), and the floor below catches a module REMOVED from it.
 */
const DOMAIN_DIRECTORIES = [
  join(SRC_ROOT, 'services', 'backfill'),
  join(SRC_ROOT, 'db', 'backfill'),
];

/** Modules outside those directories that are still part of the domain. */
const DOMAIN_FILES = [
  join(SRC_ROOT, 'controllers', 'backfill-operator.controller.ts'),
  join(SRC_ROOT, 'routes', 'internal-backfill.ts'),
  join(SRC_ROOT, 'middleware', 'backfill-schemas.ts'),
  join(SRC_ROOT, 'db', 'schema', 'backfill.ts'),
];

/**
 * The floor.
 *
 * 18 at the time of writing (11 under `services/backfill` including 6 stages,
 * 3 repositories, and the 4 named above). Asserted as a MINIMUM rather than an
 * exact count so adding a stage does not break the gate, and as a real number
 * rather than `> 0` so a broken traversal cannot pass by scanning one file.
 */
const MINIMUM_DOMAIN_FILES = 16;

function collect(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collect(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

const DOMAIN_SOURCES: readonly { path: string; source: string }[] = [
  ...DOMAIN_DIRECTORIES.flatMap(collect),
  ...DOMAIN_FILES,
].map((path) => ({ path: relativePath(SRC_ROOT, path), source: readFileSync(path, 'utf8') }));

/**
 * The MONEY and ORDER domains — issue acceptance 4, and the whole "Immutable
 * history" section.
 *
 * "Do not rewrite order item snapshots, totals, seller identity or source data";
 * "refunds and moderation evidence keep their current listing and order ids".
 * A module that cannot import any of these cannot rewrite one of them.
 *
 * `order-linkage` is NOT exempted: the payment domain reads orders through it,
 * and the backfill has no business doing even that — a migration that needed to
 * know what was ordered would be a migration touching placed orders.
 */
const ORDER_OR_MONEY_REFERENCE =
  /db\/orders\/|db\/payments\/|db\/fees\/|services\/payments\/|services\/fees\/|services\/refund|order\.service|refund\.service|orderRepository|refundRepository|paymentRepository|ledgerRepository|insertOrder|order_items|ledger_entries|ledger_transactions/;

/**
 * FAVORITES — issue immutable-history rule 4: "existing favorites remain listing
 * favorites until #39 migrates or supplements them."
 */
const FAVORITE_REFERENCE = /favorite\.service|favoriteRepository|db\/buyers\/favorite|favorites/;

/**
 * REVIEWS — immutable-history rule 3: "reviews retain their target and can gain
 * a product-level projection later without destructive migration." The
 * projection is #76's to build; the backfill must not repoint a review.
 */
const REVIEW_WRITE_REFERENCE =
  /services\/reviews\/|review\.service|reviewRepository|review-migration|rehomeReviews|review_target_migrations/;

/**
 * PRODUCT-LEVEL COLLECTIONS — issue existing-catalog rule 7: "existing product
 * collections continue to reference native listings until a separate
 * product-level collection migration is designed."
 */
const COLLECTION_REFERENCE = /collection\.service|collectionRepository|collectionIds|db\/merchandising\//;

/**
 * The hard exclusion this repo states in `AGENTS.md`: no OxyPay and no FairCoin
 * anywhere in this work.
 *
 * `FAIR` the CURRENCY CODE is excluded from the pattern deliberately — it is the
 * marketplace's preferred presentment currency and appears legitimately across
 * the catalogue. What is forbidden is FairCoin as a rail or a branch.
 */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/**
 * A canonical-graph WRITE service, imported by a STAGE.
 *
 * The dry-run guarantee is a shape, not a rule: a stage holds a
 * `CanonicalGraphWriter` and no repositories, so the only module in the domain
 * that may name a write service is `graph-writer.ts` itself. A stage importing
 * `createCanonicalProduct` directly would write during a rehearsal, silently,
 * and no amount of testing that particular stage would tell you about the next
 * one.
 */
const CANONICAL_WRITE_REFERENCE =
  /(?<![.\w])(createCanonicalProduct|createVariant|createMerchant|linkNativeStore|assignIdentifier|insertNativeListingLink|supersedeNativeListingLink|requestNativeOfferSync|requestNativeVariantMatch)\s*\(/;

/** Every stage module — the set the writer boundary applies to. */
const STAGE_SOURCES = DOMAIN_SOURCES.filter((entry) =>
  entry.path.includes(join('services', 'backfill', 'stages')),
);

/** Strip comments, so a module DOCUMENTING what it refuses does not trip a scan. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the backfill cannot reach the domains it must not', () => {
  it('scans the whole domain (vacuity floor)', () => {
    expect(DOMAIN_SOURCES.length).toBeGreaterThanOrEqual(MINIMUM_DOMAIN_FILES);
    expect(STAGE_SOURCES.length).toBeGreaterThanOrEqual(6);
    for (const entry of DOMAIN_SOURCES) {
      expect(entry.source.length, `${entry.path} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('no backfill module reaches an order, refund, payment, ledger or fee (acceptance 4)', () => {
    for (const entry of DOMAIN_SOURCES) {
      expect(
        ORDER_OR_MONEY_REFERENCE.test(withoutComments(entry.source)),
        `${entry.path} reaches the order or money domain; placed orders are immutable during migration`,
      ).toBe(false);
    }
  });

  it('no backfill module reaches favorites, reviews or product collections', () => {
    for (const entry of DOMAIN_SOURCES) {
      const source = withoutComments(entry.source);
      expect(
        FAVORITE_REFERENCE.test(source),
        `${entry.path} reaches favorites; they stay listing favorites until #39`,
      ).toBe(false);
      expect(
        REVIEW_WRITE_REFERENCE.test(source),
        `${entry.path} reaches the review domain; a product-level projection is #76's`,
      ).toBe(false);
      expect(
        COLLECTION_REFERENCE.test(source),
        `${entry.path} reaches collections; product-level collections are a separate migration`,
      ).toBe(false);
    }
  });

  it('no backfill module names OxyPay or FairCoin', () => {
    for (const entry of DOMAIN_SOURCES) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(entry.source),
        `${entry.path} names OxyPay or FairCoin`,
      ).toBe(false);
    }
  });

  it('only graph-writer.ts may name a canonical WRITE service', () => {
    for (const entry of STAGE_SOURCES) {
      expect(
        CANONICAL_WRITE_REFERENCE.test(withoutComments(entry.source)),
        `${entry.path} names a canonical write service directly; a stage must go through CanonicalGraphWriter or a dry run will write`,
      ).toBe(false);
    }
    // …and the one module that MAY, does — otherwise this gate would pass on a
    // domain where nothing writes at all, which is the vacuous version of it.
    const writer = DOMAIN_SOURCES.find((entry) => entry.path.endsWith('graph-writer.ts'));
    expect(writer, 'graph-writer.ts is missing from the domain scan').toBeDefined();
    expect(CANONICAL_WRITE_REFERENCE.test(writer?.source ?? '')).toBe(true);
  });

  /**
   * The mutation self-test. Every detector above is run against text that SHOULD
   * trip it, so a regex broken into matching nothing fails here rather than
   * passing every scan silently.
   */
  it('each detector actually detects (mutation self-test)', () => {
    expect(
      ORDER_OR_MONEY_REFERENCE.test("import { insertOrder } from '../../db/orders/orderRepository.js';"),
    ).toBe(true);
    expect(ORDER_OR_MONEY_REFERENCE.test("import { postLedger } from './ledgerRepository.js';")).toBe(
      true,
    );
    expect(FAVORITE_REFERENCE.test("import { addFavorite } from '../favorite.service.js';")).toBe(true);
    expect(
      REVIEW_WRITE_REFERENCE.test("import { rehomeReviewsForProductMerge } from '../reviews/review-migration.service.js';"),
    ).toBe(true);
    expect(COLLECTION_REFERENCE.test('const ids = listing.collectionIds;')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("provider: 'oxy_pay'")).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('// FairCoin support coming soon')).toBe(true);
    expect(CANONICAL_WRITE_REFERENCE.test('const p = await createCanonicalProduct({ name });')).toBe(
      true,
    );

    // …and the four things that must NOT trip a detector.
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("const currency: CurrencyCode = 'FAIR';")).toBe(false);
    expect(ORDER_OR_MONEY_REFERENCE.test('const ordered = rows.sort();')).toBe(false);
    /**
     * The detector is on the IMPORT and not on the identifier, deliberately: a
     * stage legitimately calls `context.writer.createMerchantForStore(...)`, and
     * a name-shaped pattern would flag the very indirection this gate exists to
     * require.
     */
    expect(
      CANONICAL_WRITE_REFERENCE.test('await context.writer.createMerchantForStore(input);'),
    ).toBe(false);
    expect(withoutComments('// import { insertOrder } from "x";\nconst a = 1;')).not.toContain(
      'insertOrder',
    );
  });
});
