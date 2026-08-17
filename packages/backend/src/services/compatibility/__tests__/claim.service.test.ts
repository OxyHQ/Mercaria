/**
 * `assertClaimMatchesSubject` — the guard both promotions run before they open
 * anything.
 *
 * ## Why this file exists
 *
 * `claim.service.ts` said, above that function:
 *
 * > Exported so `claim.service.test.ts` can drive it directly. A pure guard
 * > nobody can call in isolation is a guard nobody mutation-tests.
 *
 * **The file did not exist.** The export was real, the reasoning was right, and
 * the coverage it named was not there — a false claim of coverage, which is worse
 * than an uncovered guard because a reader checking whether the guard is tested
 * finds a sentence saying it is. Found while wiring the operator promotion
 * surface (#367 Workstream 14), which is the first caller either promotion has
 * ever had.
 *
 * It reads no database on purpose: the function takes a row and two ids and
 * returns nothing, so a real server would add a fixture and measure the same
 * three branches.
 */

import { describe, expect, it } from 'vitest';
import { assertClaimMatchesSubject } from '../claim.service.js';
import type { CompatibilityClaimRow } from '../../../db/compatibility/compatibilityClaimRepository.js';

/**
 * A claim row with only the three columns the guard reads.
 *
 * Cast through `Partial` and then to the row type rather than built whole: the
 * table has thirty columns and a fixture naming all of them would make this file
 * fail on every unrelated schema addition, which is a test that measures the
 * schema instead of the guard.
 */
function claim(subjectProductId: string | null, subjectVariantId: string | null): CompatibilityClaimRow {
  const partial: Partial<CompatibilityClaimRow> = {
    id: 'claim_1',
    subjectProductId,
    subjectVariantId,
  };
  return partial as CompatibilityClaimRow;
}

describe('assertClaimMatchesSubject', () => {
  it('accepts a claim about the same PRODUCT as the row it would open', () => {
    expect(() => assertClaimMatchesSubject(claim('prod_1', null), 'prod_1', null)).not.toThrow();
  });

  it('accepts a claim about the same VARIANT', () => {
    expect(() => assertClaimMatchesSubject(claim(null, 'var_1'), null, 'var_1')).not.toThrow();
  });

  it('refuses a claim that does not exist', () => {
    // `findClaimById` returns null for an id nobody has, and the promotion must
    // not open a canonical row for it — the fitment would then cite a claim that
    // is not there, which is a published fact with a dangling provenance.
    expect(() => assertClaimMatchesSubject(null, 'prod_1', null)).toThrow(
      /no such compatibility claim/u,
    );
  });

  it('refuses a claim naming NO subject', () => {
    // `unknown_subject` is a real reason and such a claim is deliberately stored
    // — it is the evidence that a source publishes fitment for products Mercaria
    // has not matched. It cannot be PROMOTED, because there is nothing to promote
    // it onto.
    expect(() => assertClaimMatchesSubject(claim(null, null), 'prod_1', null)).toThrow(
      /names no subject/u,
    );
  });

  it('refuses a claim about a DIFFERENT product', () => {
    // The false merge this guard exists for: claim A's evidence published under
    // B's pairing, with an audit trail that looks complete.
    expect(() => assertClaimMatchesSubject(claim('prod_1', null), 'prod_2', null)).toThrow(
      /different subject/u,
    );
  });

  it('refuses a claim about a different VARIANT', () => {
    expect(() => assertClaimMatchesSubject(claim(null, 'var_1'), null, 'var_2')).toThrow(
      /different subject/u,
    );
  });

  it('refuses a PRODUCT claim promoted onto a VARIANT row, and the reverse', () => {
    // The grain crossing. Both ids are compared, so a claim about the product and
    // a fitment about one of its variants are not the same subject — which is
    // right: a pad that fits a car in one configuration is not a claim about
    // every configuration.
    expect(() => assertClaimMatchesSubject(claim('prod_1', null), null, 'var_1')).toThrow(
      /different subject/u,
    );
    expect(() => assertClaimMatchesSubject(claim(null, 'var_1'), 'prod_1', null)).toThrow(
      /different subject/u,
    );
  });

  it('compares BOTH ids, not just the one that is set', () => {
    // The mutation this catches: a guard written as
    // `if (claim.subjectProductId !== subjectProductId) throw` alone accepts a
    // product claim promoted onto a row that names the same product AND a
    // variant, which is a narrower fact than the claim supports. Asserted as a
    // pair so the second comparison is load-bearing.
    expect(() => assertClaimMatchesSubject(claim('prod_1', null), 'prod_1', 'var_1')).toThrow(
      /different subject/u,
    );
    // The control: with the variant absent it is accepted, so the refusal above
    // is about the extra id and not about the product.
    expect(() => assertClaimMatchesSubject(claim('prod_1', null), 'prod_1', null)).not.toThrow();
  });
});
