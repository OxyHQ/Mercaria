/**
 * Every v1 wire contract this server still serves, and what proves it still does.
 *
 * Epic #367 line 74: *"Preserve compatibility with current production data
 * through staged, reversible migrations and feature flags."* Three mechanisms
 * answer the first half — migrations carry a `-- oxy:deploy-phase=` marker and a
 * `-- oxy:rollback=` posture, and `middleware/catalog-rollout.ts` carries the
 * flags. None of them answers the second half, which is the requirement itself:
 * **data written by the PREVIOUS image is still served correctly by the current
 * one.**
 *
 * In this repository that promise is kept by the VERSIONED WIRE CONTRACT
 * convention `docs/house-invariants.md` states — "a versioned wire contract,
 * never a `@deprecated` alias. A shipped mobile build cannot be recalled; state
 * `retiresWhen` and keep serving both." Twelve fields are held open under it.
 *
 * ## What was measured, and why this file exists
 *
 * The convention was a promise. Measured on the tree this landed against, by
 * mutating the production serving site and running the WHOLE backend suite
 * (`bun run --cwd packages/backend test`, 670 files / 10,503 tests) plus
 * `tsc --noEmit`:
 *
 * | mutation | suite |
 * |---|---|
 * | delete the v1 `addressId` mapping branch | **5 files / 29 tests FAILED** |
 * | `Listing.condition` hardcoded to `'new'` | 670 passed / 10,500 passed |
 * | `Listing.category` hardcoded to `''` | 670 passed / 10,500 passed |
 * | delete the `Order.buyerOxyUserId` serving line | 670 passed / 10,500 passed |
 *
 * The first row is the POSITIVE CONTROL and it is the reason the other three
 * mean anything. An absence found by an instrument that cannot detect a presence
 * is not a finding — a search that cannot see a gate returns the same empty
 * result whether or not one exists. Same command, same tree, one subject known
 * to be gated going red is what separates "no gate" from "no instrument".
 *
 * So three of the four v1 contracts #367 line 74 is about could stop being
 * served, or start being served WRONG, with a green build. A v1 client would
 * show every used listing as new, every listing as uncategorised, and every
 * order with no buyer.
 *
 * All three now have a proof, as do the two v1 QUERY spellings — whose one
 * translation, `toFilters`, had no test importer anywhere in the repository.
 * Four contracts still have none and are counted rather than hidden; see
 * {@link V1_CONTRACTS_WITHOUT_PROOF}.
 *
 * ## Why the population is DERIVED and not written here
 *
 * `v1-wire-contract-census.test.ts` walks `packages/shared-types/src` with the
 * TypeScript compiler and recovers every property whose OWN docblock declares it
 * a v1 contract, then asserts this list covers exactly that set. A hand list is
 * blind in the one direction that matters — an ADDED contract — and
 * `docs/isolation-gates.md` records the measured cost of that blindness across
 * twenty-seven gates in this repository.
 *
 * The derivation is over PROSE, which is a real limitation and is stated rather
 * than hidden: a field held open for an old client with no docblock saying so is
 * invisible to it. Two things narrow that gap. The house convention IS to
 * document them — every one of the twelve is — and
 * `scripts/validate-catalog-identity-contracts.mjs` independently catches the
 * AMBIGUOUS-STRING subset from the type declaration alone, with no prose
 * involved. Neither net is complete; they have different holes.
 *
 * ## What `provenBy` may and may not claim
 *
 * A census proves a member exists and was classified. It can never prove the
 * classification is TRUE. So `provenBy` names a test whose failure is the
 * evidence — not a comment asserting coverage — and the census checks the named
 * title is really in the named file. What it cannot check is that the test's
 * body asserts anything, which is what review is for.
 *
 * `provenBy: null` is a first-class, exact-counted state. It is what an
 * un-gated contract looks like, and pinning the count is what makes ADDING one
 * a visible edit somebody has to justify.
 */

/**
 * Which direction of the wire a contract is about.
 *
 * They fail differently, which is why one value would not do. A `read` contract
 * fails by serving the wrong value to a client that cannot be recalled; a
 * `write` contract fails by refusing a body that build still sends; a `query`
 * contract fails by returning the wrong ROWS, which looks like an empty
 * catalogue rather than an error.
 *
 * `successor` is the fourth and it is not a v1 contract at all — it is the
 * TYPED FIELD that replaces one, which mentions v1 in its docblock precisely
 * because it names what it supersedes. The derivation cannot tell the two apart
 * (both talk about v1) so the disposition is recorded here rather than the entry
 * being dropped: an entry silently missing from a derived set is the failure
 * this whole file is written against.
 */
export type V1ContractDirection = 'read' | 'write' | 'query' | 'successor';

/** A production site that serves or accepts a v1 contract. */
export interface V1ServingSite {
  /** Path under `packages/backend/src/`. */
  readonly module: string;
  /** An exported symbol of that module — asserted to be exported, so a rename breaks the gate. */
  readonly symbol: string;
}

/** The test whose failure is the evidence that a contract is still served. */
export interface V1ContractProof {
  /** Path under `packages/backend/src/`. */
  readonly file: string;
  /** A `describe`/`it` title present in that file. */
  readonly title: string;
}

export interface V1WireContract {
  /** The owner chain the derivation produces, e.g. `Listing.condition`. */
  readonly path: string;
  /** The declaring module under `packages/shared-types/src`. */
  readonly file: string;
  readonly direction: V1ContractDirection;
  /** The typed field that replaces it, or `null` when nothing does yet. */
  readonly supersededBy: string | null;
  /** Where production serves or accepts it. `null` only for a `successor`. */
  readonly servedBy: V1ServingSite | null;
  /** The behavioural test that fails if it stops. `null` is an un-gated contract. */
  readonly provenBy: V1ContractProof | null;
  readonly why: string;
}

/** The `hydrateListings` entry point — the ONE place a `Listing` DTO is built. */
const LISTING_HYDRATION: V1ServingSite = {
  module: 'services/catalog-hydration.service.ts',
  symbol: 'hydrateListings',
};

/** The ONE translation of the v1 query spellings into repository filters. */
const LISTING_QUERY_FILTERS: V1ServingSite = {
  module: 'services/search.service.ts',
  symbol: 'toFilters',
};

/** Where the new serving proofs live. */
const SERVING_PROOF = 'services/__tests__/v1-wire-contract-serving.test.ts';

/**
 * Every v1 wire contract, with its serving site and its evidence.
 *
 * Ordered by declaring file so a reader can hold it beside the derivation
 * output. There is deliberately no per-entry `count` — the `LEGACY_AMBIGUOUS_CONTRACTS`
 * device this otherwise follows needs one because its walk can produce the same
 * path twice. Here it cannot: the census asserts the derived paths are DISTINCT
 * before comparing them as a set, so one entry can never quietly excuse a second
 * declaration of the same field. That assertion is what makes the absent `count`
 * safe rather than an omission.
 */
export const V1_WIRE_CONTRACTS: readonly V1WireContract[] = [
  /* ---- listing.ts ------------------------------------------------------- */
  {
    path: 'Listing.itemCondition',
    file: 'listing.ts',
    direction: 'successor',
    supersededBy: null,
    servedBy: null,
    provenBy: null,
    why:
      'The #90 AUTHORITY, not a v1 contract. Its docblock names v1 only to say that `condition` '
      + 'below is its derived projection, which is exactly the sentence the derivation matches on.',
  },
  {
    path: 'Listing.condition',
    file: 'listing.ts',
    direction: 'read',
    supersededBy: 'itemCondition',
    servedBy: LISTING_HYDRATION,
    provenBy: { file: SERVING_PROOF, title: 'serves the v1 binary condition derived from itemCondition.key' },
    why:
      'The v1 binary read, computed from `itemCondition.key` on every read and stored nowhere '
      + '(`LEGACY_CONDITION_CONTRACT`). The pure mapping `legacyBinaryConditionFor` was already '
      + 'pinned exhaustively by `condition-taxonomy.test.ts`; the CALL at the hydration site was '
      + 'not, which is the green-and-inert shape — hardcoding the value there left the whole '
      + 'suite green.',
  },
  {
    path: 'Listing.category',
    file: 'listing.ts',
    direction: 'read',
    supersededBy: 'categoryId (`listings.category_id`; not published on any DTO yet)',
    servedBy: LISTING_HYDRATION,
    provenBy: { file: SERVING_PROOF, title: 'serves the v1 category slug as the LEAF of the materialized path' },
    why:
      'The v1 category read, derived from the leaf of `listings.category_slugs` '
      + '(`LEGACY_LISTING_CATEGORY_CONTRACT`, ADR 0007 D13). Its EXISTENCE is gated twice — '
      + '`catalog-identity-isolation.test.ts` CLAUSE 3 and '
      + '`scripts/validate-catalog-identity-contracts.mjs` — and its VALUE was gated nowhere.',
  },
  {
    path: 'CreateP2PListingInput.condition',
    file: 'listing.ts',
    direction: 'write',
    supersededBy: 'itemCondition',
    servedBy: { module: 'services/condition/condition-input.ts', symbol: 'resolveConditionInput' },
    provenBy: {
      file: 'services/condition/__tests__/condition-taxonomy.test.ts',
      title: 'maps a v1 `used` to the conservative generic key, never `like new`',
    },
    why: 'The v1 binary write. `resolveConditionInput` is the ONE place the two spellings meet.',
  },
  {
    path: 'CreateP2PListingInput.category',
    file: 'listing.ts',
    direction: 'write',
    supersededBy: 'categoryId',
    servedBy: { module: 'services/catalog-write.service.ts', symbol: 'createP2PListing' },
    provenBy: null,
    why:
      'The v1 slug on a P2P create. No proof is claimed here, and the reason is a limit of what '
      + 'was measured rather than a finding: the 28 `createP2PListing(`/`createStoreProduct(` call '
      + 'sites across 8 test files all pass `category:` as fixture input, and whether any of them '
      + 'asserts that the SLUG resolved to the right `category_id` is not a question grep can '
      + 'settle — the tree carries 39 assertions naming `categoryId`/`categorySlugs` and they are '
      + 'about other things. Closing it means a realdb case against a provisioned taxonomy that '
      + 'creates with a slug and reads the resolved identity back, which is a different harness '
      + 'from the read proofs here.',
  },
  {
    path: 'CreateStoreProductInput.condition',
    file: 'listing.ts',
    direction: 'write',
    supersededBy: 'itemCondition',
    servedBy: { module: 'services/condition/condition-input.ts', symbol: 'resolveConditionInput' },
    provenBy: {
      file: 'services/condition/__tests__/condition-taxonomy.test.ts',
      title: 'refuses BOTH spellings rather than picking one',
    },
    why: 'The v1 binary write on the store path — the same resolver, the same contract.',
  },
  {
    path: 'CreateStoreProductInput.category',
    file: 'listing.ts',
    direction: 'write',
    supersededBy: 'categoryId',
    servedBy: { module: 'services/catalog-write.service.ts', symbol: 'createStoreProduct' },
    provenBy: null,
    why:
      'The v1 slug on a store create. No proof is claimed, for the reason its P2P sibling states — '
      + 'both go through the same `resolveCategory` step and one realdb case would close both.',
  },
  {
    path: 'ListingQuery.category',
    file: 'listing.ts',
    direction: 'query',
    supersededBy: 'categoryId',
    servedBy: LISTING_QUERY_FILTERS,
    provenBy: { file: SERVING_PROOF, title: 'carries the v1 category slug through to the repository filter' },
    why:
      'The v1 category FILTER. `toFilters` is the one translation and had no test importer in the '
      + 'repository at all — a query contract fails by returning the wrong ROWS, which reads as an '
      + 'empty catalogue rather than as an error.',
  },
  {
    path: 'ListingQuery.condition',
    file: 'listing.ts',
    direction: 'query',
    supersededBy: 'conditionKeys / conditionGroups',
    servedBy: LISTING_QUERY_FILTERS,
    provenBy: { file: SERVING_PROOF, title: 'widens a v1 `used` filter to every non-new condition GROUP' },
    why:
      'The v1 condition FILTER, and the widening is the load-bearing part: `used` must select '
      + 'every non-`new` GROUP, because a v1 client cannot name a segment and meant "not '
      + 'factory-sealed". Mapping it to one key hides refurbished and for-parts listings from '
      + 'every shipped mobile build, silently.',
  },

  /* ---- order.ts --------------------------------------------------------- */
  {
    path: 'Order.buyerOxyUserId',
    file: 'order.ts',
    direction: 'read',
    supersededBy: 'buyer.oxyUserId',
    servedBy: { module: 'services/order-hydration.service.ts', symbol: 'hydrateOrders' },
    provenBy: {
      file: 'services/__tests__/v1-order-buyer-serving.test.ts',
      title: 'serves the v1 buyer id on an oxy-origin order',
    },
    why:
      'The v1 buyer read (#106, ADR 0003 D6). It was the worst-exposed of the four: there was no '
      + '`order-hydration.service` test file at all, every test referencing `hydrateOrders` '
      + 'MOCKED it, and the field is OPTIONAL on `Order` — so unlike `Listing.condition` not even '
      + 'its PRESENCE was gated, and deleting the serving line left `tsc` and all 10,500 tests '
      + 'green. The proof also pins the two failures either side of it: a CLAIMED guest order '
      + 'must not carry the claimant (a silent misattribution that looks exactly like the field '
      + 'working), and a MERCHANT projection must not carry it at all — checked on the emitted '
      + 'object, because `MerchantOrder`\'s `Omit` cannot see a runtime spread.',
  },
  {
    path: 'CheckoutInput.destination',
    file: 'order.ts',
    direction: 'successor',
    supersededBy: null,
    servedBy: null,
    provenBy: null,
    why:
      'The #105 SUCCESSOR, not a v1 contract. Its docblock says the field is required "unless the '
      + 'v1 `addressId` is used", which is the sentence the derivation matches on.',
  },
  {
    path: 'CheckoutInput.addressId',
    file: 'order.ts',
    direction: 'write',
    supersededBy: 'destination (`{type: "saved_address", addressId}`)',
    servedBy: { module: 'services/checkout/destination.ts', symbol: 'destinationFromInput' },
    provenBy: {
      file: 'services/checkout/__tests__/destination.test.ts',
      title: 'maps a v1 `addressId` body to a saved_address destination',
    },
    why:
      'The only v1 contract that was already gated, and the POSITIVE CONTROL for the whole '
      + 'measurement: deleting its mapping branch turns 5 files and 29 tests red. Its docblock is '
      + 'also the precedent every proof here follows — "exported so the contract-version tests can '
      + 'drive it directly".',
  },

  /* ---- taxonomy.ts / taxonomy-classification.ts ------------------------- */
  {
    path: 'TaxonomyCategory.ancestorSlugs',
    file: 'taxonomy.ts',
    direction: 'read',
    supersededBy: 'ancestorIds',
    servedBy: { module: 'db/taxonomy/taxonomyRepository.ts', symbol: 'toTaxonomyCategory' },
    provenBy: null,
    why:
      'ADR 0007 D13 retains `categories.ancestor_slugs` as a v1 read contract, retired in a later '
      + '`post` migration once no reader remains. Different failure mode from the projections '
      + 'above — it is a STORED column served verbatim, so what would remove it is a migration, '
      + 'and `migration-rollback-posture.test.ts` covers that side. What is UNGATED is the READ: '
      + 'all six `expect(...ancestorSlugs)` sites in the repository assert the COLUMN through a '
      + 'direct `db.select`, never the served field, which is the misleading part — the column '
      + 'maintenance is well tested and reads as coverage for the projection.',
  },
  {
    path: 'PrimaryClassification.ancestorSlugs',
    file: 'taxonomy-classification.ts',
    direction: 'read',
    supersededBy: 'ancestorIds',
    servedBy: { module: 'db/taxonomy/classificationRepository.ts', symbol: 'findProductClassification' },
    provenBy: null,
    why:
      'The same D13 v1 read contract on the classification projection, ungated for the same '
      + 'reason. `taxonomy-classification.realdb.test.ts` uses `ancestorSlugs` only as INSERT '
      + 'fixture values and asserts `categoryId` on the responses.',
  },
];

/**
 * How many contracts have no behavioural proof today.
 *
 * Pinned EXACTLY rather than as a ceiling, in both directions, and the two
 * directions catch different things. Upward: a new v1 contract landing without a
 * proof fails the build, which is the whole point — the convention stops being a
 * promise. Downward: closing one forces the number down in the same diff, so a
 * proof somebody wrote is recorded rather than absorbed.
 *
 * A ceiling (`<=`) would admit the second failure silently and is exactly the
 * shape `docs/isolation-gates.md` warns about; a floor (`>=`) would admit the
 * first. Neither alone is a bound.
 */
export const V1_CONTRACTS_WITHOUT_PROOF = 4;

/**
 * How many derived members are SUCCESSORS rather than v1 contracts.
 *
 * Pinned for the same reason and with a sharper edge: `successor` is the one
 * disposition that excuses an entry from needing a serving site at all, so it is
 * the disposition a future reader would reach for to make a red census green.
 */
export const V1_SUCCESSOR_MEMBERS = 2;
