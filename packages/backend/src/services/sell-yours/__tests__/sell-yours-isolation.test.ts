/**
 * The five walls #91 asks for, asserted STRUCTURALLY rather than promised.
 *
 * 1. **A canonical specification is never evidence about the item.**
 *    `SELLER_PREFILLABLE_FIELDS` and `SELLER_OWNED_FIELDS` are DISJOINT, and no
 *    module in the domain can write a canonical image, title or attribute into a
 *    draft column.
 * 2. **This domain never writes to the canonical graph** (#91 acceptance 4). A
 *    seller changing their mind must not be able to corrupt a product page, so
 *    no module here may call a canonical WRITE service or issue an insert,
 *    update or delete against a `canonical_*` table.
 * 3. **Guidance is not a ranking input, in both directions.** No feed, search,
 *    catalogue or ranking module can reach this domain, and no module here can
 *    reach the fee, referral or ranking domains — the `fee-ranking-isolation`
 *    wall, pointed at a seller-facing price hint, which is the number most
 *    likely to be reached for by accident.
 * 4. **Identity evidence is refused BY NAME and stored nowhere** (#91
 *    seller-owned field 10). No column of the four tables could hold a serial,
 *    an IMEI or a document, and the refusal names each kind.
 * 5. **A seller's declaration cannot bypass #58's blockers.** The exempt set and
 *    the refusing set are complements over `MATCH_BLOCKERS`, the refusing set
 *    contains every pair-level fact, and nothing in the domain writes a
 *    `native_listing_links` row outside the publication path that runs the gate.
 *
 * Every scanner carries the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor so a moved file fails instead of silently shrinking the scan, and a
 * mutation self-test so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import {
  MATCH_BLOCKERS,
  SELLER_OWNED_FIELDS,
  SELLER_PREFILLABLE_FIELDS,
  SELLER_PROOF_FIELD_KINDS,
} from '@mercaria/shared-types';
import {
  sellerDraftConditionDetails,
  sellerDraftImages,
  sellerDraftMatchAssertions,
  sellerListingDrafts,
} from '../../../db/schema/sellYours.js';
import {
  SELLER_DECLARATION_BLOCKERS,
  SELLER_DECLARATION_EXEMPT_BLOCKERS,
} from '../match-gate.js';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every module of the domain, enumerated from disk. */
function domainSources(): { relative: string; source: string }[] {
  const roots = ['services/sell-yours', 'db/sellYours'];
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
 * detectors look for — `prefill.service.ts` says "never copied into
 * `seller_draft_images`" in as many words. Scanning raw source would make the
 * gate fire on its own explanation, and the fix somebody would reach for is to
 * delete the explanation.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A WRITE against the canonical graph, from any direction. */
const CANONICAL_WRITE =
  /insertCanonical\w*\(|updateCanonical\w*\(|replaceVariantAttributes\(|insertIdentifierAssertion\(|markCanonical\w*Merged\(|\.insert\(\s*canonical\w*|\.update\(\s*canonical\w*|\.delete\(\s*canonical\w*|from\s+'[^']*canonical-product\.service|from\s+'[^']*canonical-write/;

/**
 * Reaching a commercial or ranking domain, from any direction.
 *
 * The import half matches `'…/fees/…'` rather than `'…/services/fees/…'`,
 * because a module INSIDE `services/sell-yours/` reaches a sibling domain as
 * `'../fees/plan.js'` — with no `services/` segment in the string at all. The
 * first spelling of this detector had it, and its own mutation self-test caught
 * the gap (the same shape #125's did).
 */
const COMMERCIAL_REFERENCE =
  /from\s+'[^']*\/(fees|referrals|ranking|retail-pricing)\/|feeSchedules?\b|marketplace_fees?\b|commission\w*\(|referral_\w+|ranking_policy_versions\b|rankOffers\(|rankOfferComparison\(/;

/** Reaching the "Sell yours" domain, from any direction. */
const SELL_YOURS_REFERENCE =
  /sell-yours\/|sellYours\/|sellerListingDrafts\b|seller_listing_drafts\b|buildSellerPriceGuidance\(|deriveSellerDraftReadiness\(/;


/** A `native_listing_links` INSERT, from any direction. */
const ATTACHMENT_WRITE = /insertNativeListingLink\(/;

describe('the "Sell yours" flow cannot speak for the item, the graph or a ranking', () => {
  const domain = domainSources();

  it('is not vacuous: the domain has real modules and they are not empty', () => {
    // The floor catches a renamed directory, which would otherwise make every
    // scan below pass against an empty list.
    expect(domain.length).toBeGreaterThanOrEqual(7);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('WALL 1: what a product may prefill and what only a seller may state are DISJOINT', () => {
    const overlap = SELLER_PREFILLABLE_FIELDS.filter((field) =>
      (SELLER_OWNED_FIELDS as readonly string[]).includes(field),
    );
    expect(
      overlap,
      'a seller-owned field joined the prefillable tuple; #91 forbids treating a canonical ' +
        "specification as evidence about the seller's exact item",
    ).toEqual([]);
    // The two facts the issue is most explicit about, pinned by name.
    expect(SELLER_OWNED_FIELDS).toContain('condition');
    expect(SELLER_OWNED_FIELDS).toContain('item_photos');
    expect(SELLER_PREFILLABLE_FIELDS).toContain('reference_image');
  });

  it('WALL 2: no module in the domain writes to the canonical graph', () => {
    for (const file of domain) {
      expect(
        CANONICAL_WRITE.test(withoutComments(file.source)),
        `${file.relative} writes to the canonical graph; #91 acceptance 4 is that a seller ` +
          'changing an incorrect match cannot corrupt the canonical product',
      ).toBe(false);
    }
  });

  it('WALL 3a: no module in the domain reaches a fee, referral or ranking domain', () => {
    for (const file of domain) {
      expect(
        COMMERCIAL_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches a commercial or ranking domain; price guidance is a hint to a ` +
          'seller and must never become an input to what a buyer is shown',
      ).toBe(false);
    }
  });

  it('WALL 3b: no ranking module reaches the "Sell yours" domain', () => {
    let scanned = 0;
    assertRankingSurfaceIsWhole();
    for (const relative of RANKING_SURFACE_PATHS) {
      const source = readRankingSurfaceFile(relative);
      expect(
        SELL_YOURS_REFERENCE.test(source),
        `${relative} references the "Sell yours" domain; how a seller was guided to a price is ` +
          'not a fact about how good their offer is',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_SURFACE_PATHS.length);
  });

  it('WALL 4: no column of the four tables could hold identity evidence', () => {
    const forbidden =
      /serial|imei|passport|document|certificate|receipt|invoice|proof|email|phone|postal|full_?name|ip_?address|user_?agent|fingerprint|token/i;
    const tables = [
      { name: 'seller_listing_drafts', columns: Object.keys(getTableColumns(sellerListingDrafts)) },
      {
        name: 'seller_draft_condition_details',
        columns: Object.keys(getTableColumns(sellerDraftConditionDetails)),
      },
      { name: 'seller_draft_images', columns: Object.keys(getTableColumns(sellerDraftImages)) },
      {
        name: 'seller_draft_match_assertions',
        columns: Object.keys(getTableColumns(sellerDraftMatchAssertions)),
      },
    ];
    // The vacuity floor: a broken reflection would return no columns and pass.
    const total = tables.reduce((sum, table) => sum + table.columns.length, 0);
    expect(total).toBeGreaterThanOrEqual(50);

    for (const table of tables) {
      for (const column of table.columns) {
        expect(
          forbidden.test(column),
          `${table.name}.${column} looks like identity evidence; #91 seller-owned field 10 needs ` +
            'a reviewed non-public workflow that does not exist yet, and a write-only protected ' +
            'store with no reviewer carries every risk and none of the benefit',
        ).toBe(false);
      }
    }
  });

  it('WALL 4: the refusal names every proof kind as a VALUE', () => {
    expect(SELLER_PROOF_FIELD_KINDS).toContain('serial_number');
    expect(SELLER_PROOF_FIELD_KINDS).toContain('imei');
    expect(SELLER_PROOF_FIELD_KINDS.length).toBeGreaterThanOrEqual(4);
    // The positive control: the refusal exists and names the kinds, rather than
    // the gap being an omission nobody documented.
    const draftService = domain.find((file) => file.relative.endsWith('draft.service.ts'));
    expect(draftService?.source).toContain('SELLER_PROOF_FIELD_KINDS');
  });

  it('WALL 5: the exempt and refusing blocker sets partition MATCH_BLOCKERS exactly', () => {
    const union = [...SELLER_DECLARATION_BLOCKERS, ...SELLER_DECLARATION_EXEMPT_BLOCKERS].sort();
    expect(union).toEqual([...MATCH_BLOCKERS].sort());
    const overlap = SELLER_DECLARATION_BLOCKERS.filter((blocker) =>
      SELLER_DECLARATION_EXEMPT_BLOCKERS.includes(blocker),
    );
    expect(overlap).toEqual([]);
  });

  it('WALL 5: every PAIR-LEVEL fact refuses a seller declaration', () => {
    // These are the facts about (this listing, that product) rather than about a
    // scorer's confidence. Exempting one would be the false merge #58's whole
    // domain exists to prevent, with a person's tap as the excuse.
    for (const blocker of [
      'conflicting_identifier',
      'brand_mismatch',
      'variant_attribute_mismatch',
      'bundle_mismatch',
      'multipack_mismatch',
      'accessory_mismatch',
      'replacement_part_mismatch',
      'regional_variant_mismatch',
      'category_mismatch',
      'blocked_pair',
    ] as const) {
      expect(
        SELLER_DECLARATION_BLOCKERS,
        `${blocker} stopped refusing a seller-declared match`,
      ).toContain(blocker);
    }
  });

  it('WALL 5: only the publication path writes an attachment', () => {
    const writers = domain.filter((file) => ATTACHMENT_WRITE.test(withoutComments(file.source)));
    expect(
      writers.map((file) => file.relative),
      'a module other than the publication path writes a `native_listing_links` row; the gate ' +
        'runs there and nowhere else',
    ).toEqual(['services/sell-yours/publish.service.ts']);
  });

  it('MUTATION SELF-TEST: every detector actually detects', () => {
    // A scanner whose regex rotted would pass every assertion above vacuously.
    expect(CANONICAL_WRITE.test('await insertCanonicalProduct(tx, row);')).toBe(true);
    expect(CANONICAL_WRITE.test('await tx.update(canonicalProducts).set({ name });')).toBe(true);
    expect(CANONICAL_WRITE.test("import { x } from '../canonical/canonical-product.service.js';")).toBe(
      true,
    );
    expect(COMMERCIAL_REFERENCE.test("import { planFees } from '../fees/plan.js';")).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('const ranked = rankOffers(candidates);')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('select * from ranking_policy_versions')).toBe(true);
    expect(SELL_YOURS_REFERENCE.test("import { x } from '../sell-yours/draft.service.js';")).toBe(
      true,
    );
    expect(SELL_YOURS_REFERENCE.test('select * from seller_listing_drafts')).toBe(true);
    expect(ATTACHMENT_WRITE.test('await insertNativeListingLink(tx, row);')).toBe(true);

    // …and does NOT fire on what the domain legitimately does: it READS the
    // canonical graph on every prefill, and it reads OFFERS for guidance.
    expect(CANONICAL_WRITE.test('const product = await findCanonicalProductById(db, id);')).toBe(
      false,
    );
    expect(COMMERCIAL_REFERENCE.test("import { listOffers } from '../offers/offer.service.js';")).toBe(
      false,
    );
  });
});
