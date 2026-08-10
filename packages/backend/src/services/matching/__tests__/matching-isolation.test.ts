/**
 * The walls around the matching domain (#58), asserted STRUCTURALLY.
 *
 * Four properties, each a scan rather than a fixture, because "cannot" is a
 * stronger statement than "did not in this case":
 *
 * 1. **Matching cannot become a paid boost.** No feed, search or catalogue-read
 *    module may reference this domain, and this domain may reference no fee,
 *    payment or referral module — the `fee-ranking-isolation` and
 *    `relationship-ranking-isolation` precedent, for the same reason: a matcher
 *    that could read what a seller pays is a ranking signal wearing a
 *    correctness function's clothes.
 * 2. **The matcher never writes an offer.** It writes a `native_listing_links`
 *    row through #57's repository and asks the offer converger to run; nothing
 *    here imports the offer repository or names the `offers` table. The offer
 *    domain asserts the mirror of this from its own side.
 * 3. **The matcher never MINTS a canonical entity.** `create_new` is a
 *    recommendation for #60's backfill and #59's tooling, so no module here may
 *    import a canonical WRITE service. A matcher able to mint on its own doubt
 *    manufactures the duplicates it exists to prevent.
 * 4. **No HTTP caller can post an outcome.** The operator schemas carry no
 *    `outcome`, `confidence`, `blockers` or matched-id field, so the decision
 *    procedure has no route around it.
 *
 * The scanner follows the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor, so a moved file fails the gate instead of silently shrinking it, and a
 * mutation self-test, so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every module of the matching domain — services, repositories, routes. */
const MATCHING_DOMAIN_PATHS = [
  'services/matching/pipeline.ts',
  'services/matching/features.ts',
  'services/matching/policy.ts',
  'services/matching/relation-detection.ts',
  'services/matching/text-similarity.ts',
  'services/matching/candidate-source.ts',
  'services/matching/postgres-candidate-source.ts',
  'services/matching/subject.ts',
  'services/matching/subject-loader.ts',
  'services/matching/semantic.ts',
  'services/matching/match.service.ts',
  'services/matching/match-policy.service.ts',
  'services/matching/match-queue-dispatcher.ts',
  'services/matching/match-sweep.service.ts',
  'db/matching/matchDecisionRepository.ts',
  'db/matching/matchPolicyRepository.ts',
  'db/matching/matchQueueRepository.ts',
  'db/matching/matchBlockedPairRepository.ts',
  'db/matching/matchBenchmarkRepository.ts',
  'db/matching/matchSweepRepository.ts',
  'routes/internal-matching.ts',
  'controllers/matching-operator.controller.ts',
];

/**
 * The organic discovery surface. A new ranking module belongs on this list — the
 * floor below is what forces whoever adds one to look here.
 */
const RANKING_PATHS = [
  'services/feed.service.ts',
  'services/search.service.ts',
  'services/catalog-hydration.service.ts',
  'controllers/feed.controller.ts',
  'controllers/listings.controller.ts',
  'routes/feed.ts',
  'routes/listings.ts',
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

/** Reaching the matching domain, from any direction. */
const MATCHING_REFERENCE =
  /matching\/|matchDecision|matchQueue|matchPolicy|match_decisions|match_queue|match_policy_versions|evaluateMatch/;

/** Any commercial domain. A correctness function must not be able to read one. */
const COMMERCIAL_REFERENCE = /fees\/|payments\/|referrals\/|feeSchedule|orderFeeSnapshot|ledgerRepository/;

/**
 * The OFFER write path this domain must not take.
 *
 * `nativeListingLinkRepository` is deliberately NOT here: writing that
 * attachment is exactly what #57 left for #58, and `native-offer.service` is
 * reached only for `requestNativeOfferSync`, which enqueues a convergence rather
 * than writing an offer.
 */
const OFFER_WRITE_REFERENCE = /offerRepository|upsertNativeOffer|retireOffers|\boffers\b\s*\)/;

/** The canonical WRITE services — minting, renaming or re-pointing an entity. */
const CANONICAL_WRITE_REFERENCE =
  /canonical-product\.service|canonical-variant\.service|product-family\.service|brand\.service|organization\.service|catalog-write\.service/;

/**
 * Strip comments before scanning, and keep the vacuity floor on the RAW file.
 *
 * Every module in this domain explains, in prose, which write service it
 * deliberately does not call and which field a schema deliberately does not
 * accept — so a scanner that reads comments fires on the documentation of the
 * rule it is enforcing. That is the "cries wolf" shape `~/Oxy/AGENTS.md` warns
 * about: the next person to hit it weakens the regex, and the gate is gone.
 *
 * The floor is measured on the raw source on purpose, so a file emptied down to
 * a comment block still fails as "did it move?" rather than passing as "no code
 * to match".
 */
function readDomainFile(relative: string): string {
  const raw = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(raw.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  const code = raw.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
  expect(code.length, `${relative} is all comments — did its code move?`).toBeGreaterThan(100);
  return code;
}

describe('matching cannot become a ranking signal', () => {
  it('no feed, search or catalogue-read module references the matching domain', () => {
    let scanned = 0;
    for (const relative of RANKING_PATHS) {
      const source = readDomainFile(relative);
      expect(
        MATCHING_REFERENCE.test(source),
        `${relative} references the matching domain; organic ranking must not read match data`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_PATHS.length);
  });

  it('no matching module references a fee, payment or referral module', () => {
    let scanned = 0;
    for (const relative of MATCHING_DOMAIN_PATHS) {
      const source = readDomainFile(relative);
      expect(
        COMMERCIAL_REFERENCE.test(source),
        `${relative} reaches a commercial domain; what a seller pays cannot influence what their listing IS`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(MATCHING_DOMAIN_PATHS.length);
  });
});

describe('the matcher writes an attachment and never an offer', () => {
  it('no matching module writes an `offers` row', () => {
    for (const relative of MATCHING_DOMAIN_PATHS) {
      const source = readDomainFile(relative);
      expect(
        OFFER_WRITE_REFERENCE.test(source),
        `${relative} writes offers; the matcher decides an ATTACHMENT and the offer domain decides what one means`,
      ).toBe(false);
    }
  });

  it('exactly ONE module reaches the native-listing-link writer, and it is the seam', () => {
    const writers = MATCHING_DOMAIN_PATHS.filter((relative) =>
      /insertNativeListingLink|supersedeNativeListingLink/.test(readDomainFile(relative)),
    );
    // Concentrating the write in one place is what makes "how does a listing
    // become an offer" answerable by reading one function.
    expect(writers).toEqual(['services/matching/match.service.ts']);
  });
});

describe('the matcher never mints a canonical entity', () => {
  it('no matching module imports a canonical or catalogue WRITE service', () => {
    for (const relative of MATCHING_DOMAIN_PATHS) {
      const source = readDomainFile(relative);
      expect(
        CANONICAL_WRITE_REFERENCE.test(source),
        `${relative} imports a write service; \`create_new\` is a RECOMMENDATION for #60, not an action`,
      ).toBe(false);
    }
  });
});

describe('no HTTP caller can post a decision', () => {
  it('the operator schemas carry no outcome, confidence, blocker or matched-id field', () => {
    // Comments stripped: this file's own docblock explains exactly which fields
    // it refuses, which is the prose a naive scan would trip over.
    const schemas = readDomainFile('middleware/matching-schemas.ts');
    for (const forbidden of [
      'outcome:',
      'confidence:',
      'blockers:',
      'matchedCanonicalVariantId',
      'matchedCanonicalProductId',
      'decidedStage',
    ]) {
      expect(
        schemas.includes(forbidden),
        `matching-schemas.ts accepts '${forbidden}'; a route that can post a decision is a route around the whole pipeline`,
      ).toBe(false);
    }
    // And every schema is closed, so an unknown key is a 400 rather than an
    // ignored one.
    const strictCount = (schemas.match(/\.strict\(\)/gu) ?? []).length;
    expect(strictCount).toBeGreaterThanOrEqual(7);
  });
});

describe('the scanner itself is not vacuous', () => {
  it('every detector fires on a seeded positive', () => {
    // A rotted regex passes every assertion above by matching nothing. These
    // are the mutation self-tests that make the gate mean something.
    expect(MATCHING_REFERENCE.test("import { evaluateMatch } from '../matching/pipeline.js';")).toBe(
      true,
    );
    expect(COMMERCIAL_REFERENCE.test("import { x } from '../fees/fee.service.js';")).toBe(true);
    expect(OFFER_WRITE_REFERENCE.test('await upsertNativeOffer(db, row);')).toBe(true);
    expect(
      CANONICAL_WRITE_REFERENCE.test("import { createProduct } from '../canonical/canonical-product.service.js';"),
    ).toBe(true);
  });

  it('scans a floor of modules, so a domain that moved cannot shrink the gate', () => {
    expect(MATCHING_DOMAIN_PATHS.length).toBeGreaterThanOrEqual(20);
    expect(RANKING_PATHS.length).toBeGreaterThanOrEqual(7);
  });

  it('strips comments without stripping code', () => {
    // The comment stripper is now load-bearing: if it ate too much, every scan
    // above would pass vacuously. This pins both directions on a real file.
    const source = readDomainFile('services/matching/pipeline.ts');
    expect(source).not.toContain('canonical-product.service');
    expect(source).toContain('export async function evaluateMatch');
  });
});
