# The vertical end-to-end journeys (#367 Workstream 18)

Five real-database suites under
`packages/backend/src/__tests__/vertical-e2e/`, driving a merchant's whole
journey over the three reference verticals — authoring, publication, offers,
search, filtering and the product page — plus the four cross-cutting flows the
epic asks for by name.

| File | What it drives |
|---|---|
| `vertical-locales-markets.e2e.realdb.test.ts` | The footwear and smartphone critical flow, twice: once per (language variant, market) pair |
| `vertical-locale-switch.e2e.realdb.test.ts` | Locale switching mid-draft, and telling an absent translation from a present one that reads the same |
| `vertical-publication-recovery.e2e.realdb.test.ts` | Rollback and error recovery from a failed publication |
| `vertical-automotive-fitment.e2e.realdb.test.ts` | Fitment authoring, the vehicle walk to a buyable part, and why a vehicle is not a catalogue filter |
| `vertical-matrix-and-new-product.e2e.realdb.test.ts` | The order-independent duplicate refusal at three grains, the whole eight-configuration matrix, and a new model from proposal to a findable listing |
| `journey.ts` | Shared permissions, the two schema fingerprints, an enum lookup, two counters, the population report. NOT a test file |

## How this differs from the Workstream 14 vertical suites

`scripts/seed-verticals/__tests__/verticals-{footwear,smartphone,brake-pad}.realdb.test.ts`
prove the MODELLING each vertical exists to prove — five size systems, a
spec-sheet fact that is not an axis, thirteen vehicle configurations behind one
SKU — each in one locale and one market. The footwear and smartphone suites do
publish a listing; the brake-pad one creates no store, listing or offer at all.

These five take the same seeded catalogues and drive the parts that need a
merchant on top of them:

- **Offers exist.** No Workstream 14 file calls
  `convergeNativeOffersForListing`, so no `offers` row ever exists there — and the
  footwear one could not produce any if it did, since its published variant
  selects no canonical configuration. Here every published variant SELECTS one
  and the converger is driven.
- **A shopper's search is driven.** Footwear stops at facets; the smartphone suite
  does drive `runCanonicalSearch`, for its ALIAS stages over a catalogue with no
  offers in it. What is new is the search over a product a merchant has published,
  with the offer projection populated and a market filter applied.
- **The failure paths are driven**, which is what
  `docs/catalog-authoring.md` lists as deferred.
- **Order-independence is driven.** Workstream 14's duplicate case asks for one
  combination twice in the SAME order, so the sort inside
  `typedVariantSignature` is untested and "reject duplicate combinations after
  normalization" is only true for the order somebody typed.
- **The proposal path reaches a sale.** Workstream 14 stops at the minted
  product; a merchant's purpose is to sell the thing.

## No new step, deliberately

Every file matches `vitest.config.ts`'s existing `src/**/*.test.ts` include and
runs in the `test` job CI already has. A `test:vertical-e2e` script and a second
CI step would be a second way to run the same files, and the one that is not in
CI is the one that rots. Nothing here needs a migration: no schema changed.

## Running them

```bash
docker compose -f docker-compose.postgres.yml up -d postgres
bun run --cwd packages/backend test -- src/__tests__/vertical-e2e/
```

Each file seeds its own namespaced copy of a package into the SHARED throwaway
database and tears it down; see `scripts/seed-verticals/__tests__/vertical-fixture.ts`
for what the teardown cannot remove and why. Product NAMES are not namespaced by
the seed — only keys, slugs and handles are — so every search assertion here
names an ID and never a count.

Three cleanups these files add beyond `teardownVertical`, each forced by a real
`RESTRICT` failure rather than added defensively: the proposal trail
(`catalog_proposals.store_id` blocks the store's own delete, and
`catalog_review_events` refuses DELETE by trigger), the locale-switch file's own
`fr` localization rows (the categories are RETIRED rather than deleted, so nothing
cascades them), and the minted canonical product — which must go AFTER the store's
listings, because a listing declares a link onto its configuration.

With those three in place, a residue probe run last and then thrown away shows
these five files leave no rows of their own. What survives belongs to the SEED
packages: attribute and product-type definitions the server refuses to delete once
published, and the categories they cite, moved to `deprecated`, which every read
treats as inactive. `vertical-fixture.ts` documents both. It does not mention a
third — those categories' own `category_localizations` rows, which cascade only on
a category DELETE and so survive with the retired category. Harmless (nothing
shopper-visible reaches an inactive category) and not this branch's to fix.

## The measurement discipline

An E2E suite is the easiest place in this epic to produce something that LOOKS
like proof. Five mechanisms answer that.

### 1. `reportPopulation` prints on success and refuses a zero

Two refusals rather than one. A total of zero means nothing ran; a single zero
among positive siblings means one step did nothing — and the second is the one
that hides, because every count it is compared against is also zero. A count
that is zero BY DESIGN (a brake pad's variant axes) is deliberately kept OUT of
the report and asserted separately, where the zero is the claim rather than a
size.

### 2. Every claim names a control, and the controls have found real problems

- The **market** claim is the sharpest. A native offer is market-LESS
  (`offers.country` is NULL), so both markets legitimately see it — and
  asserting that alone would pass against a build whose market predicate had
  been deleted. So the same search runs again inside a ROLLED-BACK transaction
  with every offer on the product pinned to one market, and the other market is
  shown to drop it. The pin itself carries a vacuity floor, because an UPDATE
  that matched nothing would leave both markets reaching the product.
- The **locale** claim is asserted in BOTH directions: the semantic fingerprints
  must be EQUAL and the text fingerprints must DIFFER. Equality alone would pass
  against a composer that had stopped localizing; difference alone would pass
  against one that had started varying a requirement by locale. Both fingerprints
  carry a mutation self-test — each is shown to notice a change in its own half,
  ignore one in the other's, and ignore key order.
- The **fallback** claim drives one field through both states with the same
  returned string, and then REMOVES the row to show the assertion notices.
- The **rollback** claim gets positive evidence rather than only absences: see
  below.
- The **reverse-fitment** claim was rewritten twice, and both failures are worth
  keeping. Its first version asserted `0 < length < vehicleConfigurations`, whose
  upper half could not fail: `listPublishedVehiclesForPart` returns fitment
  STATEMENTS, of which the package declares nine for the part against thirteen
  configurations — and, worse, statements are SCOPED, so nine can cover all
  thirteen cars. Its second version replaced that with an EQUALITY against the
  count production's own `publishable` predicate admits, plus a floor asserting
  some statements are withheld — which is FALSE for this part, and the suite said
  so: the exclusion is `does_not_apply` at `candidate`, which the negative rule
  admits, so all nine publish. The predicate is now mutation-tested directly (an
  `unknown` applicability can never publish, a `candidate` POSITIVE cannot, a
  `candidate` NEGATIVE can), the count is asserted to be neither the namespace's
  eleven statements nor its thirteen configurations, and the exclusion is asserted
  to be IN the list beside the fit it overrides.

### 3. A narrowing is counted unfiltered first

Every filter assertion takes the unfiltered count before narrowing, so "the
filter matched one product" is a narrowing rather than an empty catalogue.

### 4. A nonsense term has to share no trigram

Recorded because it fired: `zzzz-no-such-brake-pad-zzzz` REACHED the brake pad,
correctly, through the fuzzy trigram stage — it shares `brake` and `pad` with
the catalogue. A "this term finds nothing" control written from the product's own
vocabulary passes only for products whose names happen to avoid the words the
tester reached for.

### 5. Absences are not enough for a rollback

`publishDraft` is one transaction, so a failure inside it leaves nothing — and
"nothing was created" is exactly what a refusal BEFORE any write also leaves.
The rollback case therefore gets positive evidence out of the failure itself: the
draft carries TWO variants and only the second is wrong, the guard's message
names `variant.position + 1`, and the `native_listing_links` insert sits in the
same loop iteration immediately after the check. So a message naming **variant 2**
means position 0's link was written before the unwind. A companion case puts the
wrong variant first and asserts the message says **variant 1**, so the number is
shown to track the position rather than being a constant.

## Facts these suites measured, each recorded where it bites

- **A draft's `locale` is FROZEN at creation** by
  `catalog_authoring_drafts_pins_frozen`, and no service signature, HTTP schema
  or `DraftPatch` member accepts one afterwards. So "locale switching mid-draft"
  is not a switch the schema permits — what a merchant switching language does is
  re-READ the same draft through a schema composed in the new locale, and the
  property to test is that the stored answers do not move. They cannot: every
  answer cites an attribute definition id, a version and an enum value id, and
  carries no label.
- **A draft stores the FOLDED locale.** `createDraft` writes the composer's
  already-folded value, so a request that said `es-MX` produces a draft whose
  `locale` is `es-mx`.
- **Nothing in the composer varies by MARKET today.** The market is carried
  verbatim into the schema, pinned onto the draft and frozen there. Stating that
  is more useful than an assertion implying otherwise; the market dimension that
  does bite on the read side is `offers.country`, and it is driven above.
- **With `STRIPE_ENABLED` off, no native offer can appear in an offer
  comparison.** `readSellerPaymentReadiness` returns an EMPTY map and
  `offer-projection.ts` coerces the miss to `false`, so
  `deriveNativeCheckoutEligibility` reports `seller_not_payment_ready` and #74's
  rule 7 excludes the offer — while the search result's own offer SUMMARY still
  carries it, and `assertSellerGroupsPaymentReady` deliberately admits that same
  seller at checkout. The footwear case asserts the exclusion BY REASON, which is
  what makes it a control on the search case beside it rather than a puzzle.
  Whether the two reads should disagree is a decision for the offer and ranking
  domains; this suite records it.
- **A duplicate SKU is not a failure path.** `product_variants.sku` is unique at
  NO grain (#296), so the obvious way to force a mid-transaction database failure
  does not work. A case pins the duplicate PUBLISHING, because a later reader
  would otherwise write the same wrong test.
- **Authoring a fitment reference records a CLAIM and creates no fitment.** A
  compatibility-scoped answer becomes a `native_listing_attribute_claims` row;
  `automotive_fitments` is untouched. That is the epic's "keep seller claims
  separate from selected canonical facts" as a measurement.
- **`previewVariantSignature` does not fold — it THROWS on a value that is not
  already normalized.** That is what stops a caller storing the raw value in the
  column and the folded one in the digest, which produces a row nothing can
  recompute. A folding digest would pass every other case in these suites, so the
  refusal is asserted directly.

## What these suites do NOT cover, and why

- **A catalogue-wide vehicle filter.** There is no "which parts fit this vehicle"
  read at any layer a route or service can reach: `SearchFilters` has no vehicle,
  fitment or compatibility member; the three `/compatibility` routes that answer
  ABOUT a part each require exactly one SUBJECT (the four
  `/compatibility/vehicles/*` picker routes require none, and none returns a part);
  and the one repository primitive that could answer it —
  `listFitmentsForVehicle` with `filter.subject` omitted — is called by no route
  and no service, `fitment.service.ts` always passing a subject.
  `verticals-brake-pad.realdb.test.ts` does call it that way, which is how the
  shape is known to work; what is missing is a caller a shopper can reach. Vehicle
  filtering today is `answerFitment` for a part already in hand plus the selector
  walk — which is what the automotive file drives. A test asserting a
  catalogue-wide filter would have had to invent the read it was testing.
- **The post-commit failure window.** `finishStoreProductCreation` runs after the
  publication commits and has no `try`/`catch`, so a throw there answers 500 with
  the listing already created and the draft already stamped. Reaching it needs a
  partial module mock of `catalog-write.service`, which the same file imports for
  the write path — so the property is covered instead by the idempotency
  convergence cases, which are what a client's retry after that 500 actually
  takes.
- **RTL layout, keyboard and accessibility behaviour** (two further Workstream 18
  checkboxes). All three Expo apps DO have a vitest runner, so the limit is not
  tooling — it is that these are RENDERED properties, and nothing in this repo
  mounts a screen or drives a keyboard. What exists instead is static: `bun run
  validate:rtl-classes` and `validate:bidi-isolation` gate the mirroring rules
  across all four client packages. Closing these two checkboxes needs a rendering
  harness, which is its own piece of work and not a backend one.
- **A merchant PROPOSING an attribute value.** These suites drive the
  `canonical_product` type, because that is the one the epic's smartphone
  new-product flow names, and its review path is `mergeProposalIntoExisting` onto a
  product an operator minted. A `controlled_value` proposal takes a genuinely
  DIFFERENT path: it is the sole member of `CATALOG_PROPOSAL_MINTABLE_TYPES`, so
  `approveProposal` → `mintForProposal` inserts the `attribute_enum_values` row
  itself — which `mintForProposal` explicitly forbids for a `canonical_product`.
  That path is untested here, and the controller additionally hard-codes
  `canProposeValues: false`, so it is unreachable over HTTP today whatever the
  service accepts.
