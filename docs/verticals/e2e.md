# The vertical end-to-end journeys (#367 Workstream 18)

Four real-database suites under
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
| `journey.ts` | Shared permissions, the two schema fingerprints, an enum lookup, the population report. NOT a test file |

## How this differs from the Workstream 14 vertical suites

`scripts/seed-verticals/__tests__/verticals-{footwear,smartphone,brake-pad}.realdb.test.ts`
prove the MODELLING each vertical exists to prove — five size systems, a
spec-sheet fact that is not an axis, thirteen vehicle configurations behind one
SKU — each in one locale and one market, and they deliberately create no store,
listing or offer.

These four take the same seeded catalogues and drive the parts that need a
merchant on top of them:

- **Offers exist.** Every published variant SELECTS its canonical configuration,
  so `convergeNativeOffersForListing` materialises real offers — Workstream 14
  publishes without a selection, and a native variant nobody has matched has
  nothing to be an offer on.
- **Search is driven.** `runCanonicalSearch` is an epic checkbox no vertical
  suite reaches; footwear stops at facets.
- **The failure paths are driven**, which is what
  `docs/catalog-authoring.md` lists as deferred.

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

## What these suites do NOT cover, and why

- **A catalogue-wide vehicle filter.** There is no "which parts fit this vehicle"
  read at any layer a route or service can reach: `SearchFilters` has no vehicle,
  fitment or compatibility member, every `/compatibility` route requires exactly
  one SUBJECT, and the one repository primitive that could answer it
  (`listFitmentsForVehicle` with the subject omitted) is called by nothing, with
  its own docblock giving the reason. Vehicle filtering today is `answerFitment`
  for a part a shopper is already looking at, plus the selector walk — which is
  what the automotive file drives. A test asserting a catalogue-wide filter would
  have had to invent the read it was testing.
- **The post-commit failure window.** `finishStoreProductCreation` runs after the
  publication commits and has no `try`/`catch`, so a throw there answers 500 with
  the listing already created and the draft already stamped. Reaching it needs a
  partial module mock of `catalog-write.service`, which the same file imports for
  the write path — so the property is covered instead by the idempotency
  convergence cases, which are what a client's retry after that 500 actually
  takes.
- **RTL layout, keyboard and accessibility behaviour** (two further Workstream 18
  checkboxes). Those are client properties with no backend surface; `bun run
  validate:rtl-classes` and `validate:bidi-isolation` gate the mirroring rules
  across all four client packages, and none of the three Expo apps has a test
  runner.
- **The proposal/review path for a genuinely new model.**
  `verticals-smartphone.realdb.test.ts` already drives submission, review by a
  different operator and resolution onto a minted product; repeating it here would
  be a second copy of one flow.
