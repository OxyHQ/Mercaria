/**
 * Issue #55, product behaviour 5: the ranking service may expose verification as
 * a TRANSPARENT TRUST ATTRIBUTE, and may never turn it into a hidden paid boost.
 *
 * The mirror of `services/fees/__tests__/fee-ranking-isolation.test.ts`, and the
 * distinction it draws is the whole design of this file. Fees are asserted
 * structurally, by a wall: no ranking module may reach the fee domain at all.
 * Verification cannot be walled off that way — a brand page legitimately ranks
 * official channels first, and a product page legitimately shows a badge — so
 * the gate has to be about what verification can be BOUGHT with, not about
 * whether ranking can see it.
 *
 * Three separate claims, each with its own mechanism:
 *
 *  1. A relationship carries no commercial field at all — no fee, plan, spend or
 *     tier column exists for a boost to be priced in.
 *  2. The relationship domain never imports the fee, payment or referral
 *     domains, so a rank cannot be conditioned on what a merchant paid.
 *  3. No feed, search or catalogue-read module reaches the relationship domain
 *     TODAY, which is what makes any future use of it a visible, reviewable
 *     change rather than a silent one.
 *
 * Scanner defences follow the metro gate: a vacuity floor on every scanned file
 * and a mutation self-test on every detector.
 */

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commerceRelationships } from '../../../db/schema/relationships.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The relationship domain's own modules — the source side of claim 2. */
const RELATIONSHIP_PATHS = [
  'services/commerce-graph/relationship.service.ts',
  'services/commerce-graph/relationship-authority.ts',
  'services/commerce-graph/relationship-conflicts.ts',
  'services/commerce-graph/relationship-resolution.ts',
  'db/commerce-graph/relationshipRepository.ts',
  'db/schema/relationships.ts',
];

/** The organic discovery surface — the same list the fee gate scans. */
const RANKING_PATHS = [
  'services/feed.service.ts',
  'services/search.service.ts',
  'services/catalog-hydration.service.ts',
  'controllers/feed.controller.ts',
  'controllers/listings.controller.ts',
  'routes/feed.ts',
  'routes/listings.ts',
  'db/catalog/listingRepository.ts',
];

/**
 * Reaching anything that could price a boost, from any direction. Matched on the
 * bare `<domain>/` path segment rather than `services/<domain>/`, because an
 * import from a sibling directory is written `../fees/…` and would slip past the
 * longer form — the mutation self-test below is what caught that.
 */
const COMMERCIAL_REFERENCE =
  /\bfees\/|\bpayments\/|\breferrals\/|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee|ledgerRepository|referral_programs/;

/** Reaching the relationship domain, from any direction. */
const RELATIONSHIP_REFERENCE =
  /commerce-graph\/relationship|commerceRelationships|commerce_relationships|relationship_evidence|resolveOfficialChannel|listBrandChannels/;

/**
 * Column-name fragments that would let a relationship carry a price. A verified
 * relationship is a factual claim about the world; a column able to hold what it
 * cost is the field a paid boost would live in.
 */
const COMMERCIAL_COLUMN = /fee|price|amount|plan|tier|spend|boost|rank|score|bid|sponsor/i;

describe('verification is a trust attribute, never a purchasable boost', () => {
  it('gives a relationship no column a price could live in', () => {
    const columns = Object.keys(getTableColumns(commerceRelationships));
    // Vacuity floor: a renamed table or a broken import must fail here rather
    // than scan an empty column list and pass.
    expect(columns.length).toBeGreaterThan(25);
    const commercial = columns.filter((name) => COMMERCIAL_COLUMN.test(name));
    expect(commercial, 'a relationship must carry no commercial field').toEqual([]);
  });

  it('the column detector actually detects — the mutation self-test', () => {
    expect(COMMERCIAL_COLUMN.test('boostAmount')).toBe(true);
    expect(COMMERCIAL_COLUMN.test('sponsoredTier')).toBe(true);
    expect(COMMERCIAL_COLUMN.test('rankWeight')).toBe(true);
    expect(COMMERCIAL_COLUMN.test('territories')).toBe(false);
    expect(COMMERCIAL_COLUMN.test('verifiedAt')).toBe(false);
  });

  it('never lets the relationship domain read the fee, payment or referral domains', () => {
    let scanned = 0;
    for (const relative of RELATIONSHIP_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        COMMERCIAL_REFERENCE.test(source),
        `${relative} reaches a commercial domain; verification must not be priceable`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RELATIONSHIP_PATHS.length);
  });

  it('the commercial detector actually detects — the mutation self-test', () => {
    expect(
      COMMERCIAL_REFERENCE.test("import { planFee } from '../fees/order-fees.service.js';"),
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('select * from order_fee_snapshots')).toBe(true);
    expect(
      COMMERCIAL_REFERENCE.test("import { getDb } from '../../db/postgres.js';"),
    ).toBe(false);
  });

  it('keeps organic ranking out of the relationship domain today', () => {
    // Not a permanent wall — a brand page ordering official channels first is
    // legitimate and arrives with #72/#74. What this holds is that the first
    // ranking module to read a verification does so in a diff that changes this
    // list, where a reviewer will see it.
    let scanned = 0;
    for (const relative of RANKING_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        RELATIONSHIP_REFERENCE.test(source),
        `${relative} reads the relationship domain; add it to this gate deliberately`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_PATHS.length);
  });

  it('the relationship detector actually detects — the mutation self-test', () => {
    expect(
      RELATIONSHIP_REFERENCE.test(
        "import { resolveOfficialChannel } from '../commerce-graph/relationship-resolution.js';",
      ),
    ).toBe(true);
    expect(RELATIONSHIP_REFERENCE.test('select * from commerce_relationships')).toBe(true);
    expect(RELATIONSHIP_REFERENCE.test("import { getCart } from './cart.service.js';")).toBe(false);
  });
});
