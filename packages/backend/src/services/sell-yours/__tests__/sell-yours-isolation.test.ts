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
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
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

/** Walked whole, so a module added to the domain tomorrow is gated the moment it exists. */
const OWNED_DIRECTORIES = ['services/sell-yours', 'db/sellYours'];

/**
 * The shared directories, where this domain sits beside every other domain's.
 *
 * They were absent entirely. The two-directory read this replaces covered
 * `services/sell-yours/` and `db/sellYours/` and NOTHING else, so the HTTP
 * surface (`controllers/sell-yours.controller.ts`), the request schemas
 * (`middleware/sell-yours-schemas.ts`) and the four tables this domain owns
 * (`db/schema/sellYours.ts`) sat behind NONE of the five walls below — including
 * WALL 4, which is about what a COLUMN of those tables may hold, and whose
 * subject is therefore the one file that was outside it (#460).
 *
 * `namedInSharedDirectories` recurses, so `routes/admin/` and
 * `controllers/admin/` are reached too. Measured: this domain has no module in
 * either today, so the recursion adds nothing HERE and is the class fix rather
 * than a count.
 */
const SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'];

/**
 * What a module BELONGING to this domain is called, wherever it lives.
 *
 * The HYPHEN is optional, and that half is load-bearing rather than tidy: the
 * schema directory names its files in camelCase, so `db/schema/sellYours.ts`
 * cannot match a hyphenated spelling, and adding `db/schema` above WITHOUT this
 * would have changed nothing while looking exactly like a fix. Measured:
 * `/sell-?yours/i` over the whole of `src/` selects 13 modules and every one of
 * them is this domain's, so the widening costs no false wall.
 */
const DOMAIN_NAME_PATTERN = /sell-?yours/i;

/**
 * The floors, PER SHAPE and measured off this branch.
 *
 * One TOTAL floor was the previous spelling, and a total lets one shape collapse
 * to zero behind another's number: the whole shared half disappearing sits
 * comfortably inside a total of 10 as long as the owned directories still hold
 * ten, and every wall below then runs over a domain missing its HTTP surface and
 * its tables.
 *
 * MEASURED: 10 under the owned directories, 3 in the shared ones.
 */
const MINIMUM_OWNED_FILES = 9;
const MINIMUM_SHARED_FILES = 2;

/** Every module of the domain, DERIVED, relative to `src/`. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, DOMAIN_NAME_PATTERN, readDir),
  ];
}

/** Every module of the domain, enumerated from disk. */
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
    // Floored PER SHAPE: a broken traversal of either half scans nothing, and
    // every wall below then passes by having nothing to match — which is
    // exactly what a healthy run also produces.
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, DOMAIN_NAME_PATTERN);
    expect(
      owned.length,
      'the owned directories shrank; a walk that lost a module scans clean',
    ).toBeGreaterThanOrEqual(MINIMUM_OWNED_FILES);
    expect(
      shared.length,
      'no controller, route, middleware or schema module is named for this domain — did the ' +
        'derivation break?',
    ).toBeGreaterThanOrEqual(MINIMUM_SHARED_FILES);
    expect(domain.length).toBe(owned.length + shared.length);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        statSync(join(SRC_ROOT, file.relative)).isFile(),
        `${file.relative} is in the population but is not a file — did it move?`,
      ).toBe(true);
    }
  });

  it('the widening reaches the three modules it exists for', () => {
    // NAMED rather than floored. A floor on the population cannot detect the
    // derivation examining LESS, because the modules it stops examining are
    // exactly the ones a smaller number is consistent with — and the three
    // below are the whole reason the shared half was added, so a floor met by
    // the ten owned modules alone would report a healthy run.
    const population = domainRelativePaths();
    const widening = [
      'controllers/sell-yours.controller.ts',
      'middleware/sell-yours-schemas.ts',
      'db/schema/sellYours.ts',
    ];
    for (const expected of widening) {
      expect(population, `${expected} left the population`).toContain(expected);
    }

    // The half that makes this a measurement rather than an assertion about a
    // tree that happens to be convenient: the OWNED walk alone reaches none of
    // them, so the shared sweep is what is being measured.
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    for (const expected of widening) {
      expect(owned, `${expected} is reached without the shared sweep`).not.toContain(expected);
    }

    // …and the same, one level down, for the optional hyphen: the HYPHEN-ONLY
    // spelling cannot reach the module DECLARING this domain's four tables,
    // which is what WALL 4 is about.
    expect(/sell-yours/i.test('db/schema/sellYours.ts')).toBe(false);
    expect(DOMAIN_NAME_PATTERN.test('db/schema/sellYours.ts')).toBe(true);
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

/**
 * The population's own defence, and the general form of the fix above.
 *
 * Adding the shared directories closes today's gap; this closes the CLASS. The
 * DIRECTORY list is the last hand list in this gate, and a hand list fails
 * silently — every floor and count here stayed green while the controller, the
 * schemas and the four tables sat outside all five walls. A bag directory
 * nobody has invented yet now brings its modules under the walls with no edit.
 *
 * The exclusion set is EMPTY, and that is measured rather than assumed:
 * `/sell-?yours/i` over the whole of `src/` selects 13 modules and all 13 are
 * this domain's.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  it('every sell-yours-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: DOMAIN_NAME_PATTERN,
      notThisDomain: [],
      // Below today's 13 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 11,
      plantIn: 'lib',
      plantName: 'sell-yours-cache.ts',
    });
  });

  it('the derived population really is the one the walls scan', () => {
    // Two spellings of one population can disagree, so this pins them together:
    // every module the detectors run over has a twin here.
    expect(domainRelativePaths(readSrcDirectory).sort()).toEqual(
      domainSources()
        .map((file) => file.relative)
        .sort(),
    );
  });
});
