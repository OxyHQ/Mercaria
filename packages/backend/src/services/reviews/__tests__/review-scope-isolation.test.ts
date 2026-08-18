/**
 * The structural walls #76 is built on, asserted rather than promised.
 *
 * Four independent gates, each answering a requirement the issue states as a
 * prohibition. They follow the metro-gate defences from `~/Oxy/AGENTS.md`: every
 * scan carries a VACUITY FLOOR (a moved or emptied file fails the gate instead
 * of silently shrinking it) and a MUTATION SELF-TEST (the detector is run
 * against a seeded positive, so a rotted regex cannot pass by matching nothing).
 *
 *  1. **No brand rating** (#76 review scopes, "do not create a general brand
 *     rating by averaging product reviews"). Two halves: the vocabulary refuses
 *     it, and no module in the domain can reach the brand layer to compute it.
 *  2. **No buyer contact or payment data anywhere in the domain** (#76 model
 *     rule 12, privacy rules 1 and 3). Scanned against the real drizzle COLUMN
 *     sets, not against source text — a column is what a serializer can actually
 *     ship.
 *  3. **No forbidden evidence source can be an evidence type** (#76 verification
 *     rules 3, 9 and 10). The two unions are disjoint.
 *  4. **The eligibility domain cannot reach the payment or referral domains.**
 *     A module that cannot read a Stripe Customer cannot derive eligibility from
 *     one, which is a stronger statement than any fixture.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  REVIEW_EVIDENCE_TYPES,
  REVIEW_FORBIDDEN_EVIDENCE_SOURCES,
  REVIEW_FORBIDDEN_SCOPES,
  REVIEW_SCOPE_DIMENSION_KEYS,
  REVIEW_SCOPES,
} from '@mercaria/shared-types';
import {
  reviewAggregates,
  reviewDimensionAggregates,
  reviewDimensions,
  reviewEligibilities,
  reviews,
  reviewTargetMigrations,
} from '../../../db/schema/reviews.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The domain's HTTP surface, derived from the filename convention these flat
 * directories already follow (#472's device).
 *
 * Both modules it finds — `controllers/reviews.controller.ts` and
 * `routes/reviews.ts` — were absent from the hand list this replaces, so the
 * review HTTP surface was behind none of the four walls below.
 */
const SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

function httpSurface(readDir: DirectoryReader = readSrcDirectory): string[] {
  // RECURSIVE and matching the PATH, where this was one level deep and matched
  // the filename beside a recursive `walk()` (#460). `db/schema` joins the list
  // for the same reason: the five tables this domain owns were in no population
  // and behind none of the four walls below, which is the one directory where a
  // brand-shaped COLUMN — the thing wall 1 exists to make unrepresentable —
  // would actually be declared.
  return namedInSharedDirectories(SHARED_DIRECTORIES, /(?:^|\/)reviews?[-.]/i, readDir);
}

/**
 * The legacy review service, which has no directory of its own.
 *
 * `services/review.service.ts` predates `services/reviews/` and sits flat among
 * ~150 unrelated modules, so no rule derives it without also deriving something
 * that is not this domain — a `review` prefix over `services/` takes nothing
 * else today but would take the first module anyone names for a review of
 * something else. Kept as a hand list of ONE with its count asserted exactly,
 * which is what #483 did with `LEGACY_ENGINE_PATHS` and for the same reason: a
 * hand list without a count is a predicate rather than an identity (#448).
 */
const LEGACY_REVIEW_PATHS = ['services/review.service.ts'];

/**
 * Every module of the review domain, WALKED rather than listed (#460).
 *
 * The list this replaces named 11 modules; the derivation finds 13.
 */
function reviewDomainPaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...walkOwnedDirectory('services/reviews', readDir),
    ...walkOwnedDirectory('db/reviews', readDir),
    ...httpSurface(readDir),
    ...LEGACY_REVIEW_PATHS,
  ];
}

const REVIEW_DOMAIN_PATHS = reviewDomainPaths();

/** The five tables of the domain, with their SQL names for readable failures. */
const REVIEW_TABLES = [
  ['reviews', reviews],
  ['review_dimensions', reviewDimensions],
  ['review_eligibilities', reviewEligibilities],
  ['review_aggregates', reviewAggregates],
  ['review_dimension_aggregates', reviewDimensionAggregates],
  ['review_target_migrations', reviewTargetMigrations],
] as const;

/**
 * What reaching the BRAND layer looks like, from any direction: an import of a
 * brand/organization module, a reference to one of their table objects, or a
 * raw-SQL mention of the tables themselves.
 *
 * `brandId` is in the pattern because a column of that name on a review would be
 * the brand rating, whatever it was called in prose.
 */
const BRAND_REFERENCE =
  /schema\/organizations|brand\.service|brandRepository|\bbrands\b|\bbrand_id\b|\bbrandId\b|organization_aliases|canonicalProductFamilies|product_families/;

/**
 * What reaching the PAYMENT or REFERRAL domains looks like. Either would let
 * eligibility be derived from a Stripe Customer or an affiliate click, which is
 * exactly what #76 verification rules 3 and 10 forbid.
 *
 * The path fragments are deliberately UNANCHORED (`payments/`, not
 * `services/payments/`): every module on the scan list lives one or two
 * directories deep, so a real import of the payment domain from
 * `services/reviews/` is written `'../payments/…'` and an anchored pattern
 * would miss the only spelling that can actually occur. Found by the mutation
 * self-test below, which is what it is for.
 */
const PAYMENT_OR_REFERRAL_REFERENCE =
  /payments\/|referrals\/|providerAccounts|paymentRepository|referralTouches|referral_touches|stripe/i;

/**
 * A column name that could hold buyer contact data, a payment identifier, or a
 * credential. Matched against real column names, since a comment mentioning
 * "email" is harmless and a COLUMN named `email` is not.
 */
const FORBIDDEN_COLUMN_SHAPE =
  /email|phone|contact|address|token|secret|password|card|fingerprint|wallet|stripe|payment_method|paymentMethod|ipAddress|ip_address|device/i;

/**
 * A domain module's source with COMMENTS REMOVED — what the two import walls
 * scan.
 *
 * Not a convenience, and not a narrowing taken to make the widened population
 * fit. `db/schema/reviews.ts` is the module that DOCUMENTS this domain's
 * central claims, in exactly the vocabulary the detectors look for: its header
 * says "**A brand rating.** No `brand_id`, no `organization_id`" and "no
 * affiliate/referral column — so a matching email, a Stripe Customer, a wallet,
 * a saved card…". Every hit is inside a docblock; the CODE is clean, measured.
 *
 * Scanning prose would make each honest explanation a violation, and a gate
 * with known false positives is one whoever hits it next disables — which is
 * how the wall would really be lost. `analytics-ranking-isolation.test.ts`
 * reached the same place for the same reason.
 */
function readDomainCode(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  // The vacuity floor: an emptied or moved file must fail here, not pass the
  // scan by having nothing to match.
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(400);
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // A vacuity floor on the STRIPPED text too: a stripper that ate the file would
  // make every assertion below pass against nothing.
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(100);
  return stripped;
}

describe('#76 wall 1 — a brand rating is unrepresentable', () => {
  it('no forbidden scope is also a real scope', () => {
    // The two unions must be DISJOINT. A later widening that admitted `brand`
    // into `REVIEW_SCOPES` would make every refusal below vacuous.
    const scopes = new Set<string>(REVIEW_SCOPES);
    expect(REVIEW_SCOPES.length).toBeGreaterThanOrEqual(5);
    expect(REVIEW_FORBIDDEN_SCOPES.length).toBeGreaterThanOrEqual(5);
    for (const forbidden of REVIEW_FORBIDDEN_SCOPES) {
      expect(scopes.has(forbidden), `'${forbidden}' must not be a review scope`).toBe(false);
    }
    expect(REVIEW_FORBIDDEN_SCOPES).toContain('brand');
  });

  it('no review-domain module can reach the brand layer', () => {
    let scanned = 0;
    for (const relative of REVIEW_DOMAIN_PATHS) {
      expect(
        BRAND_REFERENCE.test(readDomainCode(relative)),
        `${relative} references the brand layer; a brand rating must be uncomputable here`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(REVIEW_DOMAIN_PATHS.length);
  });

  it('the domain derivation is whole', () => {
    // Vacuity floors PER SHAPE rather than one on the total: the four sources
    // break independently, and one total would let a walk collapse to zero while
    // the others carried the number. Each is today's count, so a SHRINK stops
    // the build rather than quietly narrowing all four walls at once.
    const from = (prefix: string) =>
      REVIEW_DOMAIN_PATHS.filter((path) => path.startsWith(prefix)).length;
    expect(from('services/reviews/'), 'the service walk found nothing').toBeGreaterThanOrEqual(5);
    expect(from('db/reviews/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(5);
    expect(httpSurface().length, 'the HTTP surface derivation found nothing').toBeGreaterThanOrEqual(
      2,
    );
    // EXACT: the one hand list left is an identity, not a predicate (#448).
    expect(LEGACY_REVIEW_PATHS.length, 'the legacy review list changed size').toBe(1);

    // The walk really reads the disk, and no test file enters the scanned set.
    for (const path of REVIEW_DOMAIN_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
    expect(REVIEW_DOMAIN_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
  });

  it('no review table carries a brand-shaped target column', () => {
    for (const [name, table] of REVIEW_TABLES) {
      for (const column of Object.keys(getTableColumns(table))) {
        expect(
          /brand|organization|productFamily|family/i.test(column),
          `${name}.${column} would be a brand-grain target`,
        ).toBe(false);
      }
    }
  });

  it('the brand detector actually detects — the mutation self-test', () => {
    // Break the thing the gate guards, in miniature, and confirm the gate sees
    // it: a scanner whose regex rotted would pass the scan above vacuously and
    // fail this one loudly.
    expect(BRAND_REFERENCE.test("import { brands } from '../schema/organizations.js';")).toBe(true);
    expect(BRAND_REFERENCE.test('select avg(rating) from reviews join brands')).toBe(true);
    expect(BRAND_REFERENCE.test('brandId: text()')).toBe(true);
    expect(BRAND_REFERENCE.test("import { reviews } from '../schema/reviews.js';")).toBe(false);
  });
});

describe('#76 wall 2 — no buyer contact or payment data in the domain', () => {
  it('no review table has a column that could hold contact, payment or credential data', () => {
    let columnsScanned = 0;
    for (const [name, table] of REVIEW_TABLES) {
      const columns = Object.keys(getTableColumns(table));
      // Per-table vacuity floor: a broken traversal returning nothing would pass
      // the loop below without checking anything at all.
      expect(columns.length, `${name} reported no columns`).toBeGreaterThan(4);
      for (const column of columns) {
        expect(
          FORBIDDEN_COLUMN_SHAPE.test(column),
          `${name}.${column} could hold buyer contact or payment data (#76 model rule 12)`,
        ).toBe(false);
        columnsScanned += 1;
      }
    }
    // The whole-domain floor: 6 tables of real columns.
    expect(columnsScanned).toBeGreaterThan(60);
  });

  it('the column detector actually detects — the mutation self-test', () => {
    expect(FORBIDDEN_COLUMN_SHAPE.test('buyerEmail')).toBe(true);
    expect(FORBIDDEN_COLUMN_SHAPE.test('portalToken')).toBe(true);
    expect(FORBIDDEN_COLUMN_SHAPE.test('cardFingerprint')).toBe(true);
    expect(FORBIDDEN_COLUMN_SHAPE.test('stripeCustomerId')).toBe(true);
    // …and does NOT fire on the columns the domain legitimately has, or the
    // gate would be unsatisfiable and somebody would delete it.
    expect(FORBIDDEN_COLUMN_SHAPE.test('eligibilityId')).toBe(false);
    expect(FORBIDDEN_COLUMN_SHAPE.test('orderItemId')).toBe(false);
    expect(FORBIDDEN_COLUMN_SHAPE.test('canonicalProductId')).toBe(false);
    expect(FORBIDDEN_COLUMN_SHAPE.test('classificationState')).toBe(false);
  });

  it('the eligibility table names an ORDER LINE and no identity beyond an Oxy id', () => {
    // The positive half of the same claim: the evidence really is a purchase.
    const columns = new Set(Object.keys(getTableColumns(reviewEligibilities)));
    expect(columns.has('orderId')).toBe(true);
    expect(columns.has('orderItemId')).toBe(true);
    expect(columns.has('oxyUserId')).toBe(true);
    expect(columns.has('evidenceType')).toBe(true);
  });
});

describe('#76 wall 3 — no forbidden signal can be an evidence type', () => {
  it('the evidence and forbidden-source unions are disjoint', () => {
    const evidence = new Set<string>(REVIEW_EVIDENCE_TYPES);
    expect(REVIEW_EVIDENCE_TYPES).toHaveLength(2);
    expect(REVIEW_FORBIDDEN_EVIDENCE_SOURCES.length).toBeGreaterThanOrEqual(14);
    for (const forbidden of REVIEW_FORBIDDEN_EVIDENCE_SOURCES) {
      expect(evidence.has(forbidden), `'${forbidden}' must not be an evidence type`).toBe(false);
    }
  });

  it('names every source the issue calls out by name', () => {
    // A list that lost an entry would still be "disjoint" and would stop
    // refusing the thing it was written for, so the entries are pinned.
    for (const named of [
      'email_match',
      'stripe_customer',
      'stripe_link',
      'wallet',
      'card_fingerprint',
      'payment_method',
      'affiliate_click',
      'conversion_report',
      'portal_token',
      'checkout_token',
      'guest_session_possession',
    ]) {
      expect(REVIEW_FORBIDDEN_EVIDENCE_SOURCES).toContain(named);
    }
  });

  it('both evidence types are a PURCHASE', () => {
    expect([...REVIEW_EVIDENCE_TYPES].sort()).toEqual([
      'authenticated_purchase',
      'claimed_guest_purchase',
    ]);
  });
});

describe('#76 wall 4 — the domain cannot reach payments or referrals', () => {
  it('no review-domain module imports the payment or referral domain', () => {
    let scanned = 0;
    for (const relative of REVIEW_DOMAIN_PATHS) {
      expect(
        PAYMENT_OR_REFERRAL_REFERENCE.test(readDomainCode(relative)),
        `${relative} can reach payment or referral data; eligibility must come from an order line`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(REVIEW_DOMAIN_PATHS.length);
  });

  it('the payment/referral detector actually detects — the mutation self-test', () => {
    expect(
      PAYMENT_OR_REFERRAL_REFERENCE.test(
        "import { findPaymentById } from '../../db/payments/paymentRepository.js';",
      ),
    ).toBe(true);
    expect(
      PAYMENT_OR_REFERRAL_REFERENCE.test(
        "import { resolveAttribution } from '../referrals/attribution.service.js';",
      ),
    ).toBe(true);
    expect(PAYMENT_OR_REFERRAL_REFERENCE.test('const customer = stripeCustomerId;')).toBe(true);
    expect(
      PAYMENT_OR_REFERRAL_REFERENCE.test("import { findOrderById } from '../orders/x.js';"),
    ).toBe(false);
  });
});

describe('#76 — the scope/dimension vocabulary keeps product and service apart', () => {
  it('no product-grain scope admits a fulfilment dimension', () => {
    // Acceptance criterion 1, stated over the vocabulary: "a bad shipping
    // experience cannot lower the canonical product-quality rating" needs
    // `delivery_speed` to be unrepresentable on a product review.
    for (const key of REVIEW_SCOPE_DIMENSION_KEYS.product) {
      expect(['delivery_speed', 'packaging', 'communication', 'order_accuracy']).not.toContain(key);
    }
    expect(REVIEW_SCOPE_DIMENSION_KEYS.product).toContain('quality');
  });

  it('no service-grain scope admits a product-quality dimension', () => {
    // Acceptance criterion 2, the mirror: a product defect cannot be counted as
    // merchant service feedback.
    for (const scope of ['merchant', 'native_transaction'] as const) {
      for (const key of REVIEW_SCOPE_DIMENSION_KEYS[scope]) {
        expect(['quality', 'durability', 'value_for_money']).not.toContain(key);
      }
    }
    expect(REVIEW_SCOPE_DIMENSION_KEYS.merchant).toContain('delivery_speed');
  });

  it('condition feedback belongs to the used LISTING and to nothing else', () => {
    // #76 UI rule 5: a used listing's condition feedback is never presented as a
    // product-quality rating. The vocabulary is what makes that structural.
    for (const scope of REVIEW_SCOPES) {
      const admitsCondition = REVIEW_SCOPE_DIMENSION_KEYS[scope].includes('condition_accuracy');
      expect(admitsCondition, `only p2p_listing may rate condition; ${scope} does`).toBe(
        scope === 'p2p_listing',
      );
    }
  });

  it('every scope declares at least one dimension — the vacuity floor', () => {
    // A scope with an empty list would pass every exclusion above by having
    // nothing to exclude.
    for (const scope of REVIEW_SCOPES) {
      expect(REVIEW_SCOPE_DIMENSION_KEYS[scope].length, `${scope} declares no dimensions`)
        .toBeGreaterThan(0);
    }
  });
});

/**
 * The population's own defence, and the general form of the `db/schema` fix.
 *
 * Adding one directory closes today's gap; this closes the class. The DIRECTORY
 * list above is the last hand list in this gate, and hand lists fail silently —
 * every floor and count stayed green while the five tables this domain owns sat
 * outside every wall.
 *
 * The sweep pattern is ANCHORED rather than a bare `/review/i`, and the anchor
 * is what makes the exclusion set empty. `review` is a word five other domains
 * use for their own workflows — `services/catalog-governance/review.service.ts`,
 * `services/catalog-proposals/review.service.ts`,
 * `services/curation/review-queue.service.ts`,
 * `services/attributes/review-queue.service.ts` and
 * `services/referrals/application-review.service.ts` — so an unanchored sweep
 * would demand five exclusions naming other domains' modules, and that list
 * would need an entry every time one of them grew a file. Requiring `reviews`
 * at a path-segment boundary, plus the ONE legacy module by its exact path,
 * selects 14 modules and every one of them is this domain's.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  /**
   * `reviews` at a segment boundary, or the legacy service by exact path.
   *
   * `^services/review\.service\.ts$` is exact rather than a `review.service`
   * suffix rule, because five other domains name a module exactly that and a
   * suffix rule would take all of them.
   */
  const REVIEW_TREE_PATTERN = /(?:^|\/)reviews(?:[-./]|$)|^services\/review\.service\.ts$/i;

  it('every review-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: reviewDomainPaths,
      pattern: REVIEW_TREE_PATTERN,
      notThisDomain: [],
      // Below today's 14 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 10,
      plantIn: 'lib',
      plantName: 'reviews-cache.ts',
    });
  });

  it('the anchor is what keeps the exclusion set empty', () => {
    // A negative control on the pattern itself: without the anchor these five
    // would each need an exclusion, so this asserts the anchor is doing the work
    // the docblock claims rather than the tree happening to be tidy.
    //
    // EVERY path is asserted to EXIST first, and that is not decoration. Both
    // loops below test a regex against a STRING LITERAL, so without the
    // existence check they go on passing after the module is renamed or deleted
    // — the control would then be measuring the pattern against a name nothing
    // in the tree carries, which is a guard whose subject is absent reporting
    // that the guard works. Found by applying `gatesA`'s rule (an anchor
    // mutated away stayed green because its subject did not exist in the
    // scanned directories) to my own already-merged control.
    const foreignModules = [
      'services/catalog-governance/review.service.ts',
      'services/catalog-proposals/review.service.ts',
      'services/curation/review-queue.service.ts',
      'services/attributes/review-queue.service.ts',
      'services/referrals/application-review.service.ts',
    ];
    for (const foreign of foreignModules) {
      expect(
        existsSync(join(SRC_ROOT, foreign)) && statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so testing the pattern against its name proves nothing`,
      ).toBe(true);
      expect(REVIEW_TREE_PATTERN.test(foreign), `${foreign} is another domain's`).toBe(false);
      expect(/review/i.test(foreign), 'the unanchored pattern really would take it').toBe(true);
    }
    expect(foreignModules.length, 'the measured foreign set changed').toBe(5);
    // …and the anchor still admits every shape this domain uses.
    for (const own of [
      'services/reviews/review-scope.ts',
      'db/reviews/reviewRepository.ts',
      'db/schema/reviews.ts',
      'controllers/reviews.controller.ts',
      'services/review.service.ts',
    ]) {
      expect(
        existsSync(join(SRC_ROOT, own)) && statSync(join(SRC_ROOT, own)).isFile(),
        `${own} no longer exists, so asserting the pattern admits it proves nothing`,
      ).toBe(true);
      expect(REVIEW_TREE_PATTERN.test(own), `${own} is this domain's`).toBe(true);
    }
  });
});
