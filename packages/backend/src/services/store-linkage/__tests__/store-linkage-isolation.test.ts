/**
 * The walls around merchant → native store linkage (#84), asserted
 * STRUCTURALLY.
 *
 * Six properties, each a scan or a schema read rather than a fixture, because
 * "cannot" is a stronger statement than "did not in this case":
 *
 *  1. **No name-only automatic linkage** (the issue's flat prohibition), in all
 *     four of the places that make it structural: the vocabulary has no
 *     `name_match` source, the four tables have no name/score/similarity column,
 *     the `.strict()` request schemas carry no field a name could ride in on,
 *     and `linkage-candidates.ts` takes no name as a parameter.
 *  2. **Linking grants no BADGE** (acceptance 7) — no module here reaches #55's
 *     relationship or brand layer, so claiming plus linking still produces no
 *     official-store status.
 *  3. **Linkage writes no `offers` row and deletes none** (catalog rules 2, 3,
 *     5) — it reaches #57 through exactly one function, the convergence enqueue.
 *  4. **Linkage cannot rewrite a canonical product fact** (catalog rule 7) — it
 *     imports no canonical write service.
 *  5. **Linkage leaves the store's operational data alone** (existing-store rule
 *     4, revocation rule 3) — no membership, policy, collection, inventory,
 *     customer, order or report write, and no follow-target call.
 *  6. **The revocation composition survives a refactor** — the operator handler
 *     that revokes a claim must still perform the unlink beside it, because the
 *     merchant-claim domain is forbidden from doing it itself.
 *
 * The scanner carries the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor, so a moved or emptied file fails the gate rather than shrinking it
 * silently, and a mutation self-test, so a rotted regex cannot pass by matching
 * nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import {
  STORE_LINKAGE_CANDIDATE_SOURCES,
  STORE_LINKAGE_PROFILE_FIELDS,
  STORE_LINKAGE_PROFILE_SOURCES,
} from '@mercaria/shared-types';
import {
  storeLinkageCandidates,
  storeLinkageOfferOverlaps,
  storeLinkageProfileAdoptions,
  storeLinkageRequests,
} from '../../../db/schema/storeLinkage.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every module of the linkage domain — services, repository, routes, controllers. */
const LINKAGE_DOMAIN_PATHS = [
  'services/store-linkage/store-linkage.service.ts',
  'services/store-linkage/linkage-candidates.ts',
  'services/store-linkage/linkage-diff.ts',
  'services/store-linkage/offer-overlap.ts',
  'services/store-linkage/canonical-matcher.port.ts',
  'db/store-linkage/storeLinkageRepository.ts',
  'routes/store-linkage.ts',
  'controllers/store-linkage.controller.ts',
  'controllers/store-linkage-operator.controller.ts',
  'middleware/store-linkage-schemas.ts',
];

/** The module that decides which stores are candidates. The name-match wall. */
const CANDIDATE_DISCOVERY_PATH = 'services/store-linkage/linkage-candidates.ts';

/** The `.strict()` request schemas — the API half of the same wall. */
const REQUEST_SCHEMA_PATH = 'middleware/store-linkage-schemas.ts';

/** The handler that must keep performing BOTH halves of an audited revocation. */
const REVOCATION_HANDLER_PATH = 'controllers/store-linkage-operator.controller.ts';

/**
 * What a NAME-BASED linkage path would need. Case-insensitive, because
 * `storeName` and `store_name` are one rule rather than two spellings to keep in
 * step, and because a `Levenshtein` helper capitalises differently from a
 * `levenshtein` one.
 *
 * Three shapes, and the third was added because the mutation self-test caught
 * its absence: a comparison does not have to BIND a variable called
 * `storeName` — the shortest way to write this bug is
 * `store.name === merchant.name`, straight off two rows, and a pattern that
 * only knew the camel-case identifiers would have passed that violation.
 *
 * Deliberately NOT a bare `/name/`: `namedStoreId` and the
 * `claimant_named`/`claim_native_store_intent` sources all contain the letters
 * and all mean "the claimant supplied an explicit ID", which is the opposite of
 * a name match. A gate that cried wolf on those would be loosened by whoever hit
 * it next, which is how a gate stops meaning anything.
 */
const NAME_MATCH_REFERENCE =
  /name_?match|\bstoreName\b|\bmerchantName\b|store\.name\b|merchant\.name\b|similar(ity)?|levenshtein|jaro|winkler|fuzzy|trigram|matchScore|nameScore|\bslugify\b/i;

/**
 * The same question asked of a candidate-source VALUE rather than of source
 * code. Narrower than the pattern above on purpose: a source value is a short
 * closed-set member, so `similar`/`score` are the words that would appear in one
 * and the identifier shapes cannot.
 */
const NAME_MATCH_VALUE = /name_?match|similar|fuzzy|score|distance|approx/i;

/** #55's relationship and brand layer. Linking grants no badge (acceptance 7). */
const RELATIONSHIP_REFERENCE =
  /commerce_relationship|commerceRelationship|relationship_evidence|relationshipEvidence|official_channel|officialChannel|authorized_reseller|authorizedReseller|\bbrands\b|brandRepository|brand\.service|relationship\.service/i;

/**
 * A direct write to the offer table, or a retirement. Linkage may ASK #57 to
 * converge and may do nothing else to an offer.
 *
 * `insertOffer`/`upsert…Offer`/`retireOffer…`/`updateOffer` are the offer
 * repository's own writers, and `db/offers/offerRepository` catches an import of
 * the module they live in.
 */
const OFFER_WRITE_REFERENCE =
  /insertOffer|upsertNativeOffer|upsertExternalOffer|retireOffers|retireLapsedExternalOffers|retireOffersMissingFromSource|updateOffer\b|offerRepository/;

/** The ONE offer-domain function linkage may call, and the module it lives in. */
const OFFER_SYNC_SEAM = 'offers/native-offer.service.js';

/** The canonical WRITE services — minting, renaming or re-pointing a product. */
const CANONICAL_WRITE_REFERENCE =
  /canonical-product\.service|canonical-variant\.service|product-family\.service|brand\.service|organization\.service|product-identifier\.service|canonicalProductRepository|canonicalVariantRepository/;

/**
 * Writes to a store's OPERATIONAL data. Linkage touches a store's `name` and
 * `description` through `updateStoreColumns` and nothing else.
 *
 * `updateStoreColumns` is deliberately NOT on this list — it is the sanctioned
 * path, and the fields it may carry are bounded by
 * `STORE_LINKAGE_PROFILE_FIELDS`, which the schema assertion below pins.
 */
const OPERATIONAL_WRITE_REFERENCE =
  /insertStoreMember|updateStoreMember|deleteStoreMember|inviteMember|removeMember|updateMember\b|insertLocation|adjustInventory|insertCollection|upsertCustomer|insertOrder|transition\(|refund\.service|report\.service/;

/** The follow graph. Mercaria's backend never touches it, and linkage least of all. */
const FOLLOW_TARGET_REFERENCE = /ensureFollowTarget|storeFollowUri|STORE_FOLLOW_KIND|followNamespace/;

function readDomainFile(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  // The vacuity floor: an empty or moved file must fail here, not pass the scan
  // by having nothing to match.
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The gate is about what the code can REACH, so comments are stripped first.
 *
 * Not leniency — the point. Every module in this domain explains in prose what
 * it must not do ("there is no `name_match` member", "#57 materializes the
 * offers"), and a scanner that forbade those sentences would push the reasoning
 * out of the files where a reviewer actually reads it, which is the opposite of
 * what this gate is for. `merchant-claims/__tests__/relationship-isolation.test.ts`
 * made the same call for the same reason.
 */
function strippedSource(relative: string): string {
  return readDomainFile(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no name-only automatic linkage (the issue’s flat prohibition)', () => {
  it('wall 1 — the candidate-source vocabulary has no name-match member', () => {
    for (const source of STORE_LINKAGE_CANDIDATE_SOURCES) {
      expect(source, `${source} is a name-shaped candidate source`).not.toMatch(NAME_MATCH_VALUE);
    }
    // The vacuity floor for the loop above: an emptied tuple would pass it.
    expect(STORE_LINKAGE_CANDIDATE_SOURCES.length).toBeGreaterThanOrEqual(6);
    // And the detector is not vacuous either: `claimant_named` must PASS (it
    // means an explicit id) while `name_match` must FAIL, which is exactly the
    // distinction the narrower value pattern exists to draw.
    expect(NAME_MATCH_VALUE.test('claimant_named')).toBe(false);
    expect(NAME_MATCH_VALUE.test('claim_native_store_intent')).toBe(false);
    expect(NAME_MATCH_VALUE.test('name_match')).toBe(true);
    expect(NAME_MATCH_VALUE.test('name_similarity')).toBe(true);
  });

  it('wall 2 — no linkage table has a name, similarity or score column', () => {
    const tables = {
      store_linkage_requests: storeLinkageRequests,
      store_linkage_candidates: storeLinkageCandidates,
      store_linkage_profile_adoptions: storeLinkageProfileAdoptions,
      store_linkage_offer_overlaps: storeLinkageOfferOverlaps,
    };

    let scannedColumns = 0;
    for (const [tableName, table] of Object.entries(tables)) {
      const columns = Object.keys(getTableColumns(table));
      scannedColumns += columns.length;
      expect(
        columns.filter((column) => /similar|score|confidence|fuzzy|distance|threshold/i.test(column)),
        `${tableName} has a similarity-shaped column; a name match would have somewhere to live`,
      ).toEqual([]);

      /**
       * `name` is checked separately and NOT by the pattern above, because
       * `store_linkage_profile_adoptions.field` legitimately CARRIES the string
       * `'name'` as a VALUE — the store's display name is one of the two
       * adoptable fields. A value is not a column, and conflating the two would
       * force this gate to be loosened for a legitimate case, which is how a
       * gate stops meaning anything.
       */
      expect(
        columns.filter((column) => /^(store|merchant|matched)?[Nn]ame$/.test(column)),
        `${tableName} stores a name; linkage decisions must not be able to read one`,
      ).toEqual([]);
    }
    // Anti-vacuity: a broken traversal would report four clean tables of nothing.
    expect(scannedColumns).toBeGreaterThan(50);
  });

  it('wall 3 — no request schema carries a field a name could arrive in', () => {
    const source = strippedSource(REQUEST_SCHEMA_PATH);
    expect(
      NAME_MATCH_REFERENCE.test(source),
      'a linkage request schema admits a name-shaped field',
    ).toBe(false);
    // Every body must be `.strict()`, which is what makes the absence above a
    // refusal rather than an omission. Four schemas take a body today.
    expect(source.match(/\.strict\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('wall 4 — candidate discovery takes no name as a parameter', () => {
    const source = strippedSource(CANDIDATE_DISCOVERY_PATH);
    expect(
      NAME_MATCH_REFERENCE.test(source),
      'candidate discovery reads a name; linkage must rest on proven facts only',
    ).toBe(false);
  });

  it('detects a seeded violation of the name-match detector (it is not vacuous)', () => {
    // Mutation self-test: a broken regex passes every assertion above by
    // matching nothing at all. These are the exact strings the gate exists to
    // catch, and each must be seen.
    expect(NAME_MATCH_REFERENCE.test("if (store.name === merchant.name) link()")).toBe(true);
    expect(NAME_MATCH_REFERENCE.test('const s = similarity(a, b)')).toBe(true);
    expect(NAME_MATCH_REFERENCE.test('source: "name_match"')).toBe(true);
    expect(NAME_MATCH_REFERENCE.test('levenshtein(storeHandle, merchantSlug)')).toBe(true);
    expect(NAME_MATCH_REFERENCE.test('matchScore: 0.92')).toBe(true);
  });
});

describe('linking grants no official-brand status (#84 acceptance 7)', () => {
  it('no linkage module references the relationship or brand layer', () => {
    let scanned = 0;
    for (const relative of LINKAGE_DOMAIN_PATHS) {
      const source = strippedSource(relative);
      expect(
        RELATIONSHIP_REFERENCE.test(source),
        `${relative} reaches #55's relationship layer; linking must grant no badge`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(LINKAGE_DOMAIN_PATHS.length);
  });
});

describe('linkage materializes offers through #57 and writes none itself', () => {
  it('reaches the offer domain through exactly one function', () => {
    for (const relative of LINKAGE_DOMAIN_PATHS) {
      const source = strippedSource(relative);
      expect(
        OFFER_WRITE_REFERENCE.test(source),
        `${relative} writes the offers table directly; #57 owns offer rows`,
      ).toBe(false);
    }

    // And the positive half: the convergence enqueue IS reached, from the
    // service, or nothing would materialize at all. A wall with no door is a
    // gate that passes because the feature is missing.
    const service = strippedSource('services/store-linkage/store-linkage.service.ts');
    expect(service).toContain(OFFER_SYNC_SEAM);
    expect(service).toContain('requestNativeOfferSync');
  });

  it('issues no offer DELETE anywhere in the domain', () => {
    // Issue catalog rules 3 and 5: an external offer is never deleted because
    // the merchant now sells natively, and prior clicks, price history and
    // source records all survive.
    for (const relative of LINKAGE_DOMAIN_PATHS) {
      const source = strippedSource(relative);
      expect(
        /\.delete\(\s*offers|deleteOffer|DELETE\s+FROM\s+offers/i.test(source),
        `${relative} deletes offers; the overlap finding is a record, never a removal`,
      ).toBe(false);
    }
  });

  it('cannot rewrite a canonical product fact (catalog rule 7)', () => {
    for (const relative of LINKAGE_DOMAIN_PATHS) {
      const source = strippedSource(relative);
      expect(
        CANONICAL_WRITE_REFERENCE.test(source),
        `${relative} imports a canonical write service; merchant catalogue updates must not reach canonical facts`,
      ).toBe(false);
    }
  });

  it('detects a seeded violation of the offer and canonical detectors', () => {
    expect(OFFER_WRITE_REFERENCE.test('await upsertNativeOffer(db, row)')).toBe(true);
    expect(OFFER_WRITE_REFERENCE.test("from '../../db/offers/offerRepository.js'")).toBe(true);
    expect(CANONICAL_WRITE_REFERENCE.test("from '../canonical/canonical-product.service.js'")).toBe(
      true,
    );
  });
});

describe('linkage leaves operational data and the follow graph alone', () => {
  it('writes no membership, policy, inventory, customer, order or report', () => {
    for (const relative of LINKAGE_DOMAIN_PATHS) {
      const source = strippedSource(relative);
      expect(
        OPERATIONAL_WRITE_REFERENCE.test(source),
        `${relative} writes store operational data; linkage changes identity and nothing else`,
      ).toBe(false);
    }
  });

  it('never constructs or ensures a follow target', () => {
    /**
     * Issue store-creation rule 5 asks for exactly ONE `mercaria.store` follow
     * target, and the way that is guaranteed is worth stating because there is
     * no index to point at.
     *
     * A target's identity is `https://mercaria.co/stores/<storeId>` (frontend
     * `lib/follow-graph.ts`), keyed on the store's IMMUTABLE id, and
     * `ensureFollowTarget` is idempotent on that URI. So "exactly one follow
     * target" is the same fact as "exactly one store, whose id never moves" —
     * which `store_linkage_requests_open_key` plus the write-once
     * `resolved_store_id` already guarantee.
     *
     * The backend's contribution is therefore to touch NOTHING: no target
     * created, no URI constructed, no store id changed. This is that assertion.
     */
    for (const relative of LINKAGE_DOMAIN_PATHS) {
      const source = strippedSource(relative);
      expect(
        FOLLOW_TARGET_REFERENCE.test(source),
        `${relative} reaches the follow graph; a store's follow target is derived from its immutable id and must not be touched`,
      ).toBe(false);
    }
  });

  it('adopts only the two safe public fields, and never the handle', () => {
    // Issue existing-store rule 7 and acceptance 2: `/m/<handle>` stays stable.
    // The tuple is the whole permission, so this reads it rather than a comment.
    expect([...STORE_LINKAGE_PROFILE_FIELDS]).toEqual(['name', 'description']);
    expect([...STORE_LINKAGE_PROFILE_SOURCES]).toEqual(['canonical_merchant']);
    for (const field of STORE_LINKAGE_PROFILE_FIELDS) {
      expect(field).not.toBe('handle');
      expect(field).not.toBe('defaultCurrency');
      expect(field).not.toBe('status');
    }
  });

  it('detects a seeded violation of the operational and follow detectors', () => {
    expect(OPERATIONAL_WRITE_REFERENCE.test('await insertStoreMember(storeId, member)')).toBe(true);
    expect(OPERATIONAL_WRITE_REFERENCE.test('await insertLocation(store.id, {})')).toBe(true);
    expect(FOLLOW_TARGET_REFERENCE.test('await oxyServices.ensureFollowTarget({})')).toBe(true);
    expect(FOLLOW_TARGET_REFERENCE.test('const uri = storeFollowUri(store.id)')).toBe(true);
  });
});

describe('claim revocation still removes the management linkage (revocation rule 1)', () => {
  it('the operator handler performs BOTH audited acts', () => {
    /**
     * The composition lives in a controller because `services/merchant-claims/`
     * may not name `native_store_links` — #83's own
     * `relationship-isolation.test.ts` fails the build if it does. That makes
     * the composition the one thing a refactor could silently drop, so it is
     * asserted here: the handler must still call the claim revocation AND the
     * unlink, in that order.
     */
    const source = strippedSource(REVOCATION_HANDLER_PATH);
    expect(source).toContain('revokeClaim(');
    expect(source).toContain('unlinkOnClaimRevocation(');

    const revokeAt = source.indexOf('await revokeClaim(');
    const unlinkAt = source.indexOf('await unlinkOnClaimRevocation(');
    expect(revokeAt, 'the handler no longer revokes the claim').toBeGreaterThan(-1);
    expect(unlinkAt, 'the handler no longer removes the linkage').toBeGreaterThan(-1);
    // The claim is revoked FIRST: the other order would leave a store unlinked
    // under a claim that still says somebody operates it, which reads as a
    // working configuration and is not one.
    expect(revokeAt).toBeLessThan(unlinkAt);
  });

  it('the merchant-claim domain still cannot reach linkage itself', () => {
    // The other half of the same property, asserted from this side so a reader
    // of THIS file learns why the composition is where it is. #83's own test
    // owns the authoritative version.
    const claimService = strippedSource('services/merchant-claims/merchant-claim.service.ts');
    expect(/native_store_links|nativeStoreLink/i.test(claimService)).toBe(false);
  });
});
