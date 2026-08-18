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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
  type DirectoryReader,
} from '../../__tests__/domain-population.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The domain's directories, ENUMERATED from disk rather than listed by hand.
 *
 * `git ls-files`-style discovery, applied to a subtree: a module ADDED to the
 * domain is scanned automatically (a hand-written list is how a new stage
 * escapes the gate), and the floor below catches a module REMOVED from it.
 */
const DOMAIN_DIRECTORIES = ['services/backfill', 'db/backfill'] as const;

/**
 * The shared flat directories a backfill module lives in under a domain NAME.
 *
 * This replaces four HAND-NAMED paths — `controllers/backfill-operator.controller.ts`,
 * `routes/internal-backfill.ts`, `middleware/backfill-schemas.ts` and
 * `db/schema/backfill.ts`. That list was COMPLETE, which is the point: a hand
 * list of four is complete on the day it is written and silently short the day
 * somebody adds a fifth, and nothing in this file could have told the
 * difference. The population does not move here; what moves is whether it can
 * fall behind.
 */
const DOMAIN_SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

/** Anything whose PATH names a backfill — deliberately broader than this domain. */
const BACKFILL_NAMED = /backfill/i;

/**
 * The domain's own modules, by name, within the shared directories.
 *
 * ANCHORED at a path-segment boundary, unlike the whole-tree sweep: unanchored,
 * `backfill` matches `catalog-backfill` and `catalogBackfill`, and this
 * population would swallow two other domains. `internal-backfill.ts` is named
 * explicitly because the router convention puts the prefix first.
 */
const OWN_SHARED_MODULE = /(?:^|\/)(?:backfill[-.]|internal-backfill\.)/i;

/**
 * Every module of the domain, DERIVED as a function of its reader.
 */
function backfillPopulation(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...DOMAIN_DIRECTORIES.flatMap((directory) => walkOwnedDirectory(directory, readDir)),
    ...namedInSharedDirectories(DOMAIN_SHARED_DIRECTORIES, OWN_SHARED_MODULE, readDir),
  ];
}

/**
 * Everything else in `src/` that is called a backfill and is NOT this domain.
 *
 * FIFTEEN, which is the finding: this repository has five different things
 * called "backfill", and #60's flag-gated catalogue backfill — the one these
 * walls are about — is one of them. An EXACT list of exact paths (#448, and
 * `domain-population.ts`'s rule that a directory-shaped exclusion excuses
 * whatever is added inside it tomorrow).
 *
 * The cost is stated rather than hidden: a new module under
 * `services/catalog-backfill/` turns THIS gate red until somebody adds a line
 * here. That is cross-domain friction and it is the deliberate trade — the
 * alternative is narrowing the sweep until it names only this domain, and then
 * a genuinely-#60 module called `catalog-backfill-repair.ts` would be missed in
 * silence. The failure message names the file and this list.
 */
const NOT_THIS_BACKFILL = [
  // #61's catalogue classification backfill, gated by
  // `services/catalog-backfill/__tests__/catalog-backfill-isolation.test.ts`.
  { path: 'services/catalog-backfill/classification.ts', why: "#61's catalogue classification backfill, which has its own gate" },
  { path: 'services/catalog-backfill/classify.service.ts', why: "#61's catalogue classification backfill, which has its own gate" },
  { path: 'services/catalog-backfill/cohort-argument.ts', why: "#61's catalogue classification backfill, which has its own gate" },
  { path: 'services/catalog-backfill/mapping-matrix.ts', why: "#61's catalogue classification backfill, which has its own gate" },
  { path: 'services/catalog-backfill/product-type-text.ts', why: "#61's catalogue classification backfill, which has its own gate" },
  { path: 'services/catalog-backfill/reconciliation.service.ts', why: "#61's catalogue classification backfill, which has its own gate" },
  { path: 'services/catalog-backfill/repair.service.ts', why: "#61's catalogue classification backfill, which has its own gate" },
  { path: 'db/catalogBackfill/legacyCatalogRepository.ts', why: "#61's catalogue classification backfill, its repository" },
  // Two other domains that each own a module called `backfill.service.ts`.
  { path: 'services/catalog-proposals/backfill.service.ts', why: "the catalog-proposals domain's own backfill, gated by its own isolation test" },
  { path: 'db/catalogProposals/backfillRepository.ts', why: "the catalog-proposals domain's own backfill repository" },
  { path: 'services/variant-axes/backfill.service.ts', why: "the variant-axes domain's own backfill, gated by its own isolation test" },
  // One-off operator scripts, in no domain and behind no gate. They are not
  // silently excused: they are named, so a person decided they are scripts.
  { path: 'scripts/backfill-catalog-classify.ts', why: 'a one-off operator script, not a module of any service domain' },
  { path: 'scripts/backfill-catalog-paths.ts', why: 'a one-off operator script, not a module of any service domain' },
  { path: 'scripts/backfill-catalog-reconcile.ts', why: 'a one-off operator script, not a module of any service domain' },
  { path: 'scripts/backfill-variant-axes.ts', why: 'a one-off operator script, not a module of any service domain' },
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


const DOMAIN_SOURCES: readonly { path: string; source: string }[] = backfillPopulation().map(
  (path) => ({ path, source: readFileSync(join(SRC_ROOT, path), 'utf8') }),
);

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
  /db\/orders\/|db\/payments\/|db\/fees\/|services\/payments\/|\.\.\/payments\/|services\/fees\/|\.\.\/fees\/|services\/refund|order\.service|refund\.service|orderRepository|refundRepository|paymentRepository|ledgerRepository|insertOrder|order_items|ledger_entries|ledger_transactions/;

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
  /services\/reviews\/|review\.service|reviewRepository|review-migration|assignReviewToCanonicalProduct|review_target_migrations/;

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
    // Floors PER SHAPE rather than one on the total: the sources break
    // independently, and a single number lets one collapse to zero while the
    // others carry it.
    const from = (prefix: string) =>
      DOMAIN_SOURCES.filter((entry) => entry.path.startsWith(prefix)).length;
    expect(from('services/backfill/'), 'the service walk found nothing').toBeGreaterThanOrEqual(16);
    expect(from('db/backfill/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(3);
    expect(from('controllers/'), 'no backfill controller was derived').toBeGreaterThanOrEqual(1);
    expect(from('routes/'), 'no backfill route was derived').toBeGreaterThanOrEqual(1);
    expect(from('middleware/'), 'no backfill middleware module was derived').toBeGreaterThanOrEqual(1);
    expect(from('db/schema/'), 'the schema module left the population').toBeGreaterThanOrEqual(1);
    expect(DOMAIN_SOURCES.length).toBeGreaterThanOrEqual(MINIMUM_DOMAIN_FILES);
    expect(STAGE_SOURCES.length).toBeGreaterThanOrEqual(6);
    for (const entry of DOMAIN_SOURCES) {
      expect(entry.source.length, `${entry.path} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('no backfill-named module anywhere in src/ sits outside the population', () => {
    // #460's whole-tree assertion. The population did NOT move here — the four
    // hand-named shared modules it replaces were all four of them — and that is
    // the case worth being explicit about: a complete hand list passes every
    // floor and every count it carries, and the only thing it fails on is the
    // module somebody adds next. So the proof is the planted control below
    // rather than a number that grew.
    //
    // The exclusion list is the other finding: FIFTEEN modules in this
    // repository are called a backfill and are not this one.
    assertNothingOutsideDomainPopulation({
      population: backfillPopulation,
      pattern: BACKFILL_NAMED,
      notThisDomain: NOT_THIS_BACKFILL,
      sweepFloor: 30,
      plantIn: 'lib',
      plantName: 'backfill-cache.ts',
    });
    // EXACT, in both directions (#448). The helper asserts each entry is still
    // REACHED by the sweep and is NOT in the population; this is the count that
    // stops a sixteenth riding in behind them.
    expect(NOT_THIS_BACKFILL.length, 'a sixteenth foreign backfill was excused').toBe(15);
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
      // The known-positive is `assignReviewOnSplit`, chosen because it is the
      // review write RETIRED LAST: it is #76 migration rule 5's operator path,
      // which #59's split job drives and nothing supersedes. Repoint this the
      // day that function moves — a control naming code that no longer exists
      // keeps passing for the wrong reason.
      REVIEW_WRITE_REFERENCE.test("import { assignReviewOnSplit } from '../reviews/review-migration.service.js';"),
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

/* ────────────────────────────────────────────────────────────────────────── */
/* #454: the detector must match the IDIOM, not one spelling of it            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * These detectors named each forbidden domain by its `services/<domain>/` path
 * only, which is not the specifier a module inside this domain writes: a
 * sibling directory is one `../` away, so the real import is `'../<domain>/…'`
 * and it passed the wall untouched. MEASURED on `origin/main` by executing each
 * pattern against that spelling.
 *
 * One relative alternative per domain covers EVERY depth, because however many
 * `../` segments precede it the last always abuts the directory name.
 *
 * The probes below are written from the IDIOM rather than from the regex — a
 * self-test derived from the pattern can only confirm the pattern matches
 * itself. The imported SYMBOL is deliberately neutral in each: the sibling
 * probe in `freshness-isolation.test.ts` imported `rankOffers`, which its
 * pattern matches by function NAME, so it passed without ever exercising the
 * path alternative it appeared to cover.
 */
describe('#454: a relative import cannot walk around these detectors', () => {
  it('ORDER_OR_MONEY_REFERENCE sees a sibling-relative import', () => {
    expect(
      ORDER_OR_MONEY_REFERENCE.test("import { helper } from '../payments/thing.service.js';"),
      "a module here reaches payments as '../payments/…' and that must not pass",
    ).toBe(true);
    expect(ORDER_OR_MONEY_REFERENCE.test("import { helper } from '../../services/payments/thing.service.js';")).toBe(true);
    expect(
      ORDER_OR_MONEY_REFERENCE.test("import { helper } from '../fees/thing.service.js';"),
      "a module here reaches fees as '../fees/…' and that must not pass",
    ).toBe(true);
    expect(ORDER_OR_MONEY_REFERENCE.test("import { helper } from '../../services/fees/thing.service.js';")).toBe(true);
    // The negative half, or the widening would fire on ordinary imports.
    expect(ORDER_OR_MONEY_REFERENCE.test("import { helper } from '../payments-display/format.js';")).toBe(false);
    expect(ORDER_OR_MONEY_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

});
