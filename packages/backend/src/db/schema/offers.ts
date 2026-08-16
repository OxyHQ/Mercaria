/**
 * The unified offer model — issue #57, bound by ADR 0002 D6/D7/D8/D18/D25:
 * `offers`, `native_listing_links`, `offer_outboxes`.
 *
 * An OFFER is one seller/channel offering one exact canonical variant under
 * specific commercial terms at a point in time. A native listing's offer and a
 * crawled retailer's offer are the SAME row shape, because a product page has to
 * compare them; they differ in exactly one structural way, and it is the one
 * that matters.
 *
 * ## The five properties this file makes STRUCTURAL rather than conventional
 *
 * 1. **An external offer cannot enter the cart.** Cart and checkout operate on
 *    `product_variants` and nothing else, and `offers_kind_shape_check` makes
 *    `product_variant_id` NULL on every kind but `native`. So "external offers
 *    never enter the Mercaria cart" (issue external rule 1) is a shape rather
 *    than a rule somebody remembers — there is no id for a cart line to hold.
 *    `offer-isolation.test.ts` pins the other direction: no cart or checkout
 *    module may import this domain at all.
 * 2. **Marketplace-ness is not storable.** There is no `is_marketplace` column
 *    and no `platform_merchant_id`. An offer names its seller of record
 *    (`merchant_id`) and its channel (`storefront_id`); the channel's operator
 *    is `storefronts.merchant_id`, one join away, and the comparison of the two
 *    IS the fact (ADR 0002 D8). Two representations can disagree; one cannot.
 * 3. **Unknown delivery is a MISSING money pair, never a zero.** Both halves are
 *    nullable together by CHECK, so a source that said nothing stores nothing —
 *    and `deriveOfferDelivery` hands the reader a discriminated union whose
 *    unknown branch has no `cost` property to misread (issue acceptance 4).
 * 4. **Expiry never deletes anything.** Retirement is a status transition with a
 *    reason; the row, its `source_record_id` and the append-only
 *    `source_records` chain behind it all survive (issue external rule 4,
 *    acceptance 5). Nothing in this domain issues a DELETE.
 * 5. **There is no stored checkout-eligibility verdict**, deliberately. It is a
 *    conjunction over the LIVE listing status, the LIVE variant stock and the
 *    seller's payment readiness — three facts owned elsewhere — so a column here
 *    would be wrong for exactly as long as it took a converger to notice, and
 *    that window is when a restricted listing must not be buyable. The
 *    derivation is `deriveNativeCheckoutEligibility` in shared-types, following
 *    `merchants`' native-checkout rule and `procurement-eligibility`'s verdict.
 *
 * ## What is deliberately NOT here
 *
 * - **No canonical PRODUCT id.** Offers attach at the variant grain (D13/D18)
 *   and a product-page read reaches them through `canonical_variants.product_id`,
 *   which is indexed. A denormalized copy would be a second representation that
 *   a variant merge could put out of step with the first.
 * - **No native STORE id.** `listings.store_id` already holds it and cannot
 *   disagree with itself; the offer names the listing, and the store is one hop
 *   through the row that owns the fact.
 * - **No `catalog_sources` id.** The adapter is `source_records.source_id`
 *   (D19); a copy here could name a different source than the observation does.
 * - **No price-history table.** ADR 0002 D18 assigns price HISTORY to #78 and
 *   this table to current state. The history the issue's external rule 4
 *   protects already exists: `source_records` is append-only and mints a NEW row
 *   whenever content changes, so the sequence of records IS the observed price
 *   history, and retiring an offer touches none of it.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CONDITION_MAPPING_STATES,
  MAX_MONEY_MINOR_UNITS,
  NATIVE_LISTING_LINK_METHODS,
  NATIVE_LISTING_LINK_STATUSES,
  OFFER_AVAILABILITY_STATES,
  OFFER_CONDITION_KEYS,
  OFFER_CUSTOMER_ELIGIBILITIES,
  OFFER_KINDS,
  OFFER_PICKUP_STATES,
  OFFER_QUALITY_SIGNALS,
  OFFER_RETIREMENT_REASONS,
  OFFER_STATUSES,
} from '@mercaria/shared-types';
import type { OfferConditionKey } from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf } from './columns';
import { canonicalVariants } from './canonicalCatalog';
import { listings, productVariants } from './catalog';
import { CONDITION_MAPPING_CONFIDENCE_FLOOR_SQL, conditionMappingRulesets } from './condition';
import { merchants, storefronts } from './merchants';
import { sourceRecords } from './provenance';

/**
 * The value set `offers.condition` accepts — #90's nine taxonomy keys plus
 * `unknown`.
 *
 * The `listings.condition` two-phase story verbatim, and it mattered here for a
 * second reason: `commercial_key` is GENERATED from this column, so the previous
 * image writing `'used'` against a narrowed CHECK would have failed the offer
 * converger on every native listing at once.
 */
export const OFFER_CONDITION_VALUES: readonly OfferConditionKey[] = OFFER_CONDITION_KEYS;

/** The lifecycle of one native-offer convergence job. */
export const OFFER_OUTBOX_STATUSES = ['pending', 'processing', 'done', 'dead_letter'] as const;

/** Bound on a stored dispatch error — `offer_outboxes_last_error_length_check`. */
export const OFFER_OUTBOX_MAX_LAST_ERROR_LENGTH = 2_000;

/**
 * `offers` — one seller/channel × one canonical variant × commercial terms ×
 * an instant (ADR 0002 D18).
 *
 * ### Two GENERATED keys, and why a plain multi-column unique will not do
 *
 * Postgres treats NULLs as DISTINCT, and both of this table's uniqueness rules
 * span columns that are legitimately NULL — a feed with no account concept, an
 * offer on no particular storefront. A plain unique over them admits exactly the
 * duplicates it exists to refuse. `source_key` and `commercial_key` collapse
 * their columns into one text value with `coalesce`, the
 * `commerce_relationships.endpoint_key` device (#55), and the partial uniques
 * are taken on those.
 *
 * The separator is `|`, which no uuid v7, ObjectId hex or currency code
 * contains, so two different tuples cannot render to one key.
 *
 * ### The currency columns carry a SHAPE check, not the tuple check
 *
 * ADR 0002 D18 names this the documented CHECK exception: an external platform
 * reports whatever currency it trades in, which may be outside
 * `ALL_CURRENCY_CODES` (Mercaria's PRESENTMENT set), and refusing the row would
 * break the observation rather than a price. This is the third member of the
 * class `connections.shop_currency` and `storefronts.currency` already define,
 * and it is why `money()`/`optionalMoney()` are NOT used here: those helpers
 * type the column from the presentment tuple by construction. Nothing prices
 * against these columns; display converts through `FxContext`, which fails
 * closed on a pair it cannot resolve.
 */
export const offers = pgTable(
  'offers',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(OFFER_KINDS) }).notNull(),
    status: text({ enum: asEnumValues(OFFER_STATUSES) }).notNull().default('active'),
    /** Present EXACTLY when retired — a biconditional CHECK, both ways. */
    retirementReason: text({ enum: asEnumValues(OFFER_RETIREMENT_REASONS) }),
    retiredAt: timestamptz(),

    // ── Identity: what is being offered (issue identity 1) ───────────────────
    /**
     * The exact configuration. NOT NULL and RESTRICT (ADR 0002 D18/D20): every
     * product has at least one variant (D13), so there is no product-grain
     * offer to represent, and a canonical variant is never hard-deleted out
     * from under the offers that price it.
     */
    canonicalVariantId: text()
      .notNull()
      .references(() => canonicalVariants.id, { onDelete: 'restrict' }),

    // ── Identity: who is selling, and where (issue identity 2/3/4, ADR D8) ───
    /**
     * The seller of record. NULL on a native offer, where the seller is the
     * listing's owner and may be a P2P user with no merchant row at all (D9).
     */
    merchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    /**
     * The channel the offer is published on. The MARKETPLACE OPERATOR is
     * `storefronts.merchant_id` and is deliberately not copied here: comparing
     * it with `merchant_id` is what makes an offer a marketplace offer, and a
     * stored copy of one side would let the two disagree (D8).
     */
    storefrontId: text().references(() => storefronts.id, { onDelete: 'restrict' }),

    // ── Identity: the native binding (issue identity 5) ──────────────────────
    /**
     * The native variant this offer projects. CASCADE from `product_variants`
     * (ADR 0002 D20): a seller deleting their listing is an existing,
     * legitimate flow that the graph must not block, and the canonical variant
     * and every other offer on it are untouched.
     */
    productVariantId: text().references(() => productVariants.id, { onDelete: 'cascade' }),
    /**
     * The variant's listing — a denormalized parent pointer, the
     * `inventory_levels.listing_id` precedent, and it earns its place: "every
     * offer of this listing" is the query the converger, the moderation path
     * and the operator trace all run, and reaching it through the variant would
     * make the hottest write path a join. CASCADE for the same reason as above.
     */
    listingId: text().references(() => listings.id, { onDelete: 'cascade' }),

    // ── Identity: the source binding (issue identity 6/7) ────────────────────
    /**
     * The observation these terms came from. RESTRICT (D19): provenance must be
     * able to block a delete, not vanish with it — which is also what keeps the
     * observed price history reachable after the offer retires.
     */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /**
     * The adapter or platform id, as the ingesting source names itself. An OPEN
     * set with a machine-slug shape CHECK — external key spaces are not
     * Mercaria's to enumerate, and gating the durable RECORD of an observation
     * on Mercaria having shipped an adapter for it would invert "gate the loop,
     * never the record" (`supplier_accounts.provider`, same reasoning).
     */
    provider: text(),
    /**
     * WHICH account at that provider observed it — a feed, a shop, a network
     * seat. Part of the idempotent source key (issue index 1). No foreign key:
     * a foreign system's key space, and named `_ref` rather than `_id` so it
     * reads as one.
     */
    sourceAccountRef: text(),
    /**
     * The provider's own id for this offer, and the third component of the
     * idempotent source key (issue identity 7).
     *
     * These three columns are NOT a second representation of `source_record_id`:
     * that names ONE observation, while this names the thing observed ACROSS
     * observations — which is what a convergence key has to be, since an upsert
     * must find the existing offer before it has minted a record for the new
     * observation.
     */
    externalOfferId: text(),

    // ── Commercial facts (issue commercial 1–4) ──────────────────────────────
    /**
     * The seller's own price in the seller's own currency, in minor units.
     *
     * `bigint`, matching every other money column: FAIR carries eight decimals,
     * so a signed `integer` tops out at 21.47 ⊜ (see `columns.ts`). Written by
     * hand rather than through `optionalMoney()` because the currency column
     * needs the open shape CHECK — see the table docblock.
     */
    priceAmount: bigint({ mode: 'number' }),
    priceCurrency: text(),
    compareAtPriceAmount: bigint({ mode: 'number' }),
    compareAtPriceCurrency: text(),

    availability: text({ enum: asEnumValues(OFFER_AVAILABILITY_STATES) })
      .notNull()
      .default('unknown'),
    /**
     * Present ONLY when the source supplies it (issue commercial fact 3).
     * NULL means "not published", which is not zero: a nullable integer is the
     * whole mechanism, and a `0` default would make every silent feed read as
     * sold out.
     */
    availableQuantity: integer(),
    /**
     * The normalized #90 taxonomy key, or `unknown`.
     *
     * `unknown` is the DEFAULT and stays the answer whenever the mapping did not
     * clear the confidence floor — see the mapping CHECKs below, which are what
     * make #90 evidence rule 6 unrepresentable-otherwise rather than a promise
     * the mapper keeps.
     */
    condition: text({ enum: asEnumValues(OFFER_CONDITION_VALUES) }).notNull().default('unknown'),
    /**
     * The source's own wording, EXACTLY as published (#90 evidence rule 5).
     *
     * Preserved beside the normalized key rather than replaced by it, because a
     * shopper comparing "Ricondizionato — Grado B" against `refurbished_seller`
     * can judge the mapping, and an operator correcting the RULE needs to see
     * what the rule was given.
     */
    conditionSourceLabel: text(),
    /**
     * How the key was arrived at.
     *
     * NO DEFAULT: every writer builds all five condition columns together
     * (`declaredOfferCondition` / `mapSourceCondition` return them as one
     * object), because the shape CHECKs constrain the COMBINATION and a default
     * on one of five is how an impossible combination gets assembled. `0030`
     * carried a `declared` default for the previous image and `0031` drops it.
     */
    conditionMappingState: text({ enum: asEnumValues(CONDITION_MAPPING_STATES) }).notNull(),
    /** 0–1, present exactly on a row a source mapping produced. */
    conditionMappingConfidence: doublePrecision(),
    /**
     * The ruleset version that read the label.
     *
     * `restrict`: an offer's mapping provenance must stay answerable, and
     * `set null` would quietly turn "read under v1" into "read under nothing"
     * the moment somebody tidied an old ruleset away — which is exactly the
     * claim #90 migration rule 5 makes impossible.
     */
    conditionMappingRulesetId: text().references(() => conditionMappingRulesets.id, {
      onDelete: 'restrict',
    }),

    /** The seller's own SKU — source-scoped, and never a `product_identifiers` row (D14). */
    sellerSku: text(),
    /** The merchant's own words for the product. */
    merchantTitle: text(),
    /** The merchant's own words for the configuration ("256GB / Negro"). */
    merchantVariantText: text(),

    // ── Destination and affiliate routing (issue commercial fact 5) ──────────
    /**
     * Where the offer lives, exactly as the source gave it — the ORIGINAL, and
     * it is never rewritten.
     *
     * There is deliberately no composed affiliate URL column beside it: one
     * stored URL plus one composed URL is two addresses for one page, and the
     * composed one goes stale the moment the network changes its parameters.
     *
     * #67's redirect hands over `affiliate_tracking_template` when the provider
     * minted one and this column otherwise, VERBATIM in both cases — it
     * composes nothing (#65's `EBAY_FORBIDDEN_LINK_OPERATIONS`, #66's "Mercaria
     * never CONSTRUCTS a tracking URL"). This column is also what a public page
     * DISCLOSES the host of, because it names the merchant while the attributed
     * link may name the network's redirector.
     */
    destinationUrl: text(),
    /** The affiliate network that would be credited (`awin`, `impact`, …). */
    affiliateNetwork: text(),
    /** The programme or advertiser id within that network. */
    affiliateProgramRef: text(),
    /** The publisher/site id Mercaria is paid under. */
    affiliatePublisherRef: text(),
    /**
     * The provider's OWN minted, already-attributed URL — Awin's `aw_deep_link`
     * (host-admitted at ingestion) or eBay's `itemAffiliateWebUrl`.
     *
     * The name is a leftover from a design that never shipped: it was described
     * as "a template carrying a `{destination}` placeholder", and NOTHING in
     * this repository has ever interpolated one. `ingest.service.ts` writes the
     * complete attributed URL and #67's redirect hands it over verbatim. Kept
     * rather than renamed because the column is live in production and a rename
     * is a migration for a comment.
     */
    affiliateTrackingTemplate: text(),

    // ── Market and audience scope (issue commercial fact 6) ──────────────────
    /**
     * ISO 3166-1 alpha-2, shape-CHECKed to match `storefronts.country` — the
     * sibling column scoping the very same markets one table over. Two
     * different validations of one vocabulary inside one graph is the
     * disagreement these conventions exist to prevent (#55's reasoning).
     */
    country: text(),
    /** A sub-national region, in the source's own words. Free text by nature. */
    region: text(),
    /** BCP-47 tag of the offer's own text. */
    language: text(),
    customerEligibility: text({ enum: asEnumValues(OFFER_CUSTOMER_ELIGIBILITIES) })
      .notNull()
      .default('unknown'),

    // ── Delivery and pickup: known facts only (issue commercial fact 7) ──────
    /**
     * What delivery costs. BOTH halves absent means UNKNOWN and zero means FREE
     * — two different facts with two different representations, which is the
     * whole of acceptance 4. The paired CHECK below is what stops a half-filled
     * row collapsing the distinction.
     */
    deliveryCostAmount: bigint({ mode: 'number' }),
    deliveryCostCurrency: text(),
    /** The basket value above which delivery is free, when the source states one. */
    deliveryFreeOverAmount: bigint({ mode: 'number' }),
    deliveryFreeOverCurrency: text(),
    deliveryMinDays: integer(),
    deliveryMaxDays: integer(),
    /** Three states, not a nullable boolean — see `OfferPickupState`. */
    pickupState: text({ enum: asEnumValues(OFFER_PICKUP_STATES) }).notNull().default('unknown'),

    // ── Returns (issue commercial fact 8) ────────────────────────────────────
    returnPolicyUrl: text(),
    returnPolicyWindowDays: integer(),
    /** The source's own identifier for the policy — a reference, not a copy of it. */
    returnPolicyRef: text(),

    // ── Freshness and quality (issue identity 9, commercial fact 9) ──────────
    /** When the source was READ. May legitimately predate the row. */
    observedAt: timestamptz().notNull(),
    /** The first time this offer was ever seen; never moves after insert. */
    firstSeenAt: timestamptz().notNull(),
    /** The last time ANY observation touched it, whether or not the terms changed. */
    lastSeenAt: timestamptz().notNull(),
    /**
     * The last time the source RE-STATED these exact terms.
     *
     * Distinct from `last_seen_at` (the source was read and mentioned this
     * offer) and from `observed_at` (when the CURRENT terms were read): a
     * listing seen in a feed whose price block was omitted moves the first and
     * neither of the others, and collapsing them would make one of the three a
     * lie — the `storefronts.last_refreshed_at` reasoning.
     */
    lastConfirmedAt: timestamptz(),
    /**
     * When the terms stop being trustworthy — the issue's EXPIRY and ADR 0002
     * D18's `stale_at` are ONE deadline, not two.
     *
     * A second column would need a rule for which one wins, and a reader would
     * have to know it. Staleness is `status = 'active' AND stale_at <= now()`,
     * derived, so a sweep that has not run cannot make a lapsed offer read as
     * current. NOT registered in `db/expiryTargets.ts`: this is a VALIDITY
     * deadline, not a retention one (the retail-pricing rule), and these rows
     * are the historical reference acceptance 5 protects.
     */
    staleAt: timestamptz().notNull(),
    /**
     * When the SOURCE ITSELF declared this offer's object gone (#68).
     *
     * A positive statement, and therefore evidence from ANY run — an eBay item
     * that 404s on a targeted re-read, a feed row carrying an explicit deletion
     * marker. That is what makes it different from `source_disappeared`, which
     * is INFERRED from absence and is only evidence when the enumeration was
     * complete (#68 acceptance 2 versus 3).
     *
     * It is stored rather than derived because it is a fact somebody told us,
     * not a deadline against a clock — the same reason `retired_at` is stored
     * while staleness is not. `assessOfferFreshness` reads it FIRST, so an
     * offer the source says is gone reads `unavailable` whatever its TTL says,
     * in the window before the retirement commits.
     */
    declaredUnavailableAt: timestamptz(),
    /**
     * 0–1 machine confidence in the canonical attachment, CHECKed to appear
     * only on rows an external source produced. A native offer is a projection
     * of a row Mercaria already holds and has nothing to be unsure about.
     */
    sourceConfidence: doublePrecision(),
    /**
     * Bounded reason codes a ranking or an explanation surface may read.
     * A closed `text[]`, never free text and never a score — #74 owns ranking,
     * and a number computed here would be a second ranking input nothing could
     * explain.
     */
    qualitySignals: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    createdAt: createdAt(),
    updatedAt: updatedAt(),

    /**
     * The IDEMPOTENT SOURCE KEY (issue identity 7, index 1), GENERATED so no
     * write path can supply one that disagrees with the columns it summarises.
     * `coalesce` and `||` are both IMMUTABLE, which a stored generated column
     * requires.
     */
    sourceKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`coalesce("provider", '') || '|' || coalesce("source_account_ref", '') || '|' ||
            coalesce("external_offer_id", '')`,
      ),
    /**
     * The ACTIVE-OFFER key ADR 0002 D18 specifies: one active offer per
     * (canonical variant, seller, channel, condition).
     *
     * The ADR suggests paired partial indexes for the NULLS-NOT-DISTINCT
     * semantics; this is the same constraint through the generated-key device
     * #55 already uses for the same reason, which needs one index instead of
     * two and cannot fall out of step with itself.
     */
    commercialKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`coalesce("canonical_variant_id", '') || '|' || coalesce("merchant_id", '') || '|' ||
            coalesce("storefront_id", '') || '|' || coalesce("condition", '')`,
      ),
  },
  (t) => [
    checkOneOf('offers_kind_check', t.kind, OFFER_KINDS),
    checkOneOf('offers_status_check', t.status, OFFER_STATUSES),
    checkOneOf('offers_retirement_reason_check', t.retirementReason, OFFER_RETIREMENT_REASONS),
    checkOneOf('offers_availability_check', t.availability, OFFER_AVAILABILITY_STATES),
    checkOneOf('offers_condition_check', t.condition, OFFER_CONDITION_VALUES),
    checkOneOf(
      'offers_condition_mapping_state_check',
      t.conditionMappingState,
      CONDITION_MAPPING_STATES,
    ),
    /**
     * #90 EVIDENCE RULE 6 and ACCEPTANCE 5, as four constraints rather than as
     * discipline in the mapper.
     *
     * The property they hold together: a source's wording can only carry a
     * taxonomy key when a RECORDED rule mapped it at or above
     * `CONDITION_MAPPING_CONFIDENCE_FLOOR`. Every other outcome — no rule
     * matched, a rule matched but was not confident enough — leaves `unknown`,
     * which a comparison surface shows as an absence rather than as a claim.
     *
     * There is deliberately no state in which a guess sits beside a key, so
     * "low-confidence mappings do not silently become higher-quality
     * conditions" holds against the mapping service, a replay, a manual
     * `UPDATE` and a future ingestion path nobody has written yet.
     */
    check(
      'offers_condition_asserted_check',
      sql`${t.condition} = 'unknown' or ${t.conditionMappingState} in ('declared', 'mapped')`,
    ),
    check(
      'offers_condition_declared_shape_check',
      sql`${t.conditionMappingState} <> 'declared'
          or (${t.conditionSourceLabel} is null
              and ${t.conditionMappingConfidence} is null
              and ${t.conditionMappingRulesetId} is null)`,
    ),
    check(
      'offers_condition_mapped_shape_check',
      sql`${t.conditionMappingState} <> 'mapped'
          or (${t.conditionSourceLabel} is not null
              and ${t.conditionMappingRulesetId} is not null
              and ${t.conditionMappingConfidence} >= ${sql.raw(
                CONDITION_MAPPING_CONFIDENCE_FLOOR_SQL,
              )})`,
    ),
    check(
      'offers_condition_review_pending_shape_check',
      sql`${t.conditionMappingState} <> 'review_pending'
          or (${t.condition} = 'unknown'
              and ${t.conditionSourceLabel} is not null
              and ${t.conditionMappingRulesetId} is not null
              and ${t.conditionMappingConfidence} < ${sql.raw(
                CONDITION_MAPPING_CONFIDENCE_FLOOR_SQL,
              )})`,
    ),
    check(
      'offers_condition_unmapped_shape_check',
      sql`${t.conditionMappingState} <> 'unmapped'
          or (${t.condition} = 'unknown' and ${t.conditionMappingConfidence} is null)`,
    ),
    check(
      'offers_condition_mapping_confidence_range_check',
      sql`${t.conditionMappingConfidence} is null
          or (${t.conditionMappingConfidence} >= 0 and ${t.conditionMappingConfidence} <= 1)`,
    ),
    checkOneOf('offers_pickup_state_check', t.pickupState, OFFER_PICKUP_STATES),
    checkOneOf(
      'offers_customer_eligibility_check',
      t.customerEligibility,
      OFFER_CUSTOMER_ELIGIBILITIES,
    ),
    checkEveryElementOf('offers_quality_signals_check', t.qualitySignals, OFFER_QUALITY_SIGNALS),

    /**
     * The per-kind shape (ADR 0002 D18), and `else false` is the load-bearing
     * branch: an unrecognised kind is unrepresentable even with the kind CHECK
     * removed, so widening the tuple without widening this constraint fails the
     * first write instead of admitting a shapeless offer.
     *
     * This is also where "an external offer cannot enter the cart" lives:
     * `product_variant_id is null` on every non-native kind, so there is no id
     * a cart line could hold.
     */
    check(
      'offers_kind_shape_check',
      sql`case ${t.kind}
        when 'native' then
          ${t.productVariantId} is not null and ${t.listingId} is not null
          and ${t.merchantId} is null and ${t.storefrontId} is null
          and ${t.sourceRecordId} is null and ${t.destinationUrl} is null
        when 'external' then
          ${t.merchantId} is not null and ${t.sourceRecordId} is not null
          and ${t.destinationUrl} is not null
          and ${t.productVariantId} is null and ${t.listingId} is null
        when 'affiliate' then
          ${t.merchantId} is not null and ${t.sourceRecordId} is not null
          and ${t.destinationUrl} is not null
          and ${t.productVariantId} is null and ${t.listingId} is null
        when 'informational' then
          ${t.merchantId} is not null and ${t.sourceRecordId} is not null
          and ${t.destinationUrl} is null
          and ${t.productVariantId} is null and ${t.listingId} is null
        else false
      end`,
    ),
    // Retirement carries its reason and its time, or it is not a retirement
    // anybody can audit — and a live row carrying either would read as one.
    check(
      'offers_retired_state_check',
      sql`(${t.status} = 'retired') = (${t.retirementReason} is not null and ${t.retiredAt} is not null)`,
    ),
    // Every `Money` is two columns that are absent TOGETHER. Without these an
    // amount could be stored with no currency, which is not a price.
    check(
      'offers_price_paired_check',
      sql`(${t.priceAmount} is null) = (${t.priceCurrency} is null)`,
    ),
    check(
      'offers_compare_at_price_paired_check',
      sql`(${t.compareAtPriceAmount} is null) = (${t.compareAtPriceCurrency} is null)`,
    ),
    check(
      'offers_delivery_cost_paired_check',
      sql`(${t.deliveryCostAmount} is null) = (${t.deliveryCostCurrency} is null)`,
    ),
    check(
      'offers_delivery_free_over_paired_check',
      sql`(${t.deliveryFreeOverAmount} is null) = (${t.deliveryFreeOverCurrency} is null)`,
    ),
    // A free-delivery THRESHOLD with no delivery cost states nothing: it says
    // what you would stop paying without ever saying what you pay.
    check(
      'offers_delivery_free_over_requires_cost_check',
      sql`${t.deliveryFreeOverAmount} is null or ${t.deliveryCostAmount} is not null`,
    ),
    // ADR 0002 D18's documented CHECK exception: shape, not the presentment
    // tuple. See the table docblock.
    check(
      'offers_price_currency_check',
      sql`${t.priceCurrency} is null or ${t.priceCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    check(
      'offers_compare_at_price_currency_check',
      sql`${t.compareAtPriceCurrency} is null or ${t.compareAtPriceCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    check(
      'offers_delivery_cost_currency_check',
      sql`${t.deliveryCostCurrency} is null or ${t.deliveryCostCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    check(
      'offers_delivery_free_over_currency_check',
      sql`${t.deliveryFreeOverCurrency} is null or ${t.deliveryFreeOverCurrency} ~ '^[A-Z]{3,4}$'`,
    ),
    // Money never goes negative on an offer: a negative price is a parse error
    // and a negative delivery cost is a discount the source did not offer.
    check(
      'offers_non_negative_money_check',
      sql`coalesce(${t.priceAmount}, 0) >= 0 and coalesce(${t.compareAtPriceAmount}, 0) >= 0
          and coalesce(${t.deliveryCostAmount}, 0) >= 0 and coalesce(${t.deliveryFreeOverAmount}, 0) >= 0`,
    ),
    check(
      'offers_available_quantity_check',
      sql`${t.availableQuantity} is null or ${t.availableQuantity} >= 0`,
    ),
    check(
      'offers_delivery_days_check',
      sql`(${t.deliveryMinDays} is null or ${t.deliveryMinDays} >= 0)
          and (${t.deliveryMaxDays} is null or ${t.deliveryMaxDays} >= 0)
          and (${t.deliveryMinDays} is null or ${t.deliveryMaxDays} is null
               or ${t.deliveryMaxDays} >= ${t.deliveryMinDays})`,
    ),
    check(
      'offers_return_window_check',
      sql`${t.returnPolicyWindowDays} is null or ${t.returnPolicyWindowDays} >= 0`,
    ),
    check('offers_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check(
      'offers_provider_shape_check',
      sql`${t.provider} is null or ${t.provider} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`,
    ),
    // A native offer is a projection of a row Mercaria already owns: it has no
    // source to be unsure about, and a confidence on one would read as doubt
    // about the seller's own listing.
    check(
      'offers_confidence_check',
      sql`${t.sourceConfidence} is null
          or (${t.sourceConfidence} >= 0 and ${t.sourceConfidence} <= 1 and ${t.kind} <> 'native')`,
    ),
    // A native offer has no external key space to converge on. Letting one
    // carry a provider or an external id would enrol it in the source-mapping
    // unique below, where it would collide with the next native offer that did
    // the same — a constraint failure on a write that has nothing to do with
    // any source.
    check(
      'offers_native_source_key_check',
      sql`${t.kind} <> 'native'
          or (${t.provider} is null and ${t.sourceAccountRef} is null and ${t.externalOfferId} is null)`,
    ),
    // Observation ordering: an offer cannot have been seen before it first
    // existed, and a deadline before the observation is a source publishing the
    // past — accepted (the freshness derivation handles it) but not silently.
    check('offers_seen_order_check', sql`${t.lastSeenAt} >= ${t.firstSeenAt}`),
    check(
      'offers_confirmed_order_check',
      sql`${t.lastConfirmedAt} is null or ${t.lastConfirmedAt} >= ${t.firstSeenAt}`,
    ),
    /**
     * A NATIVE offer has no source that could declare it gone (#68).
     *
     * Its lifecycle follows its listing, through the convergence outbox, and a
     * declaration on one would put a second authority beside `listings.status`
     * — which is the exact arrangement #57 refused when it made checkout
     * eligibility a live derivation rather than a column.
     */
    check(
      'offers_declared_unavailable_shape_check',
      sql`${t.declaredUnavailableAt} is null or ${t.kind} <> 'native'`,
    ),
    /**
     * `source_unavailable` names a declaration, so there must be one (#68).
     *
     * Without this the reason would be writable by any path that felt like it,
     * and the distinction between "the source said so" and "we inferred it from
     * a snapshot" — which is what an operator opens the trace to check — would
     * be a convention rather than a fact about the row.
     */
    check(
      'offers_source_unavailable_reason_check',
      sql`${t.retirementReason} is distinct from 'source_unavailable'
          or ${t.declaredUnavailableAt} is not null`,
    ),

    /**
     * ISSUE INDEX 1 (#57), NARROWED BY #68 — the unique source mapping by
     * provider, source account and external id, for the offer's WHOLE LIFE.
     *
     * On the GENERATED key, because Postgres treats NULLs as distinct and a
     * source with no account concept would otherwise be able to register the
     * same external offer id twice. Partial on `external_offer_id is not null`
     * so native offers, which have no external identity at all, do not collide
     * with one another on an all-empty key.
     *
     * ### `status = 'active'` was in this predicate and #68 removed it
     *
     * With it, a RETIRED offer whose source published the object again did not
     * conflict — so the upsert inserted a SECOND row for one external object,
     * splitting its observed history across two ids with nothing to rejoin
     * them. #68 acceptance 5 asks that a returning offer revive the same
     * identity, and the only way to make that a property rather than a habit is
     * for the identity to be unique across the whole life of the row: the
     * upsert then finds the retired offer and brings it back, keeping its id,
     * its `first_seen_at` and every link into it.
     *
     * ### `superseded` is excluded, and that is what makes the migration safe
     *
     * `superseded` already means "a newer offer took this one's active source
     * mapping" (#57's own vocabulary). Excluding it gives the `post` migration
     * a way to collapse any pre-existing duplicate WITHOUT deleting a row or
     * blanking its provenance: the older copies are retired with that reason
     * and leave the index, which is a decision an operator can read afterwards
     * rather than a row that vanished.
     */
    uniqueIndex('offers_source_identity_key')
      .on(t.sourceKey)
      .where(
        sql`${t.externalOfferId} is not null
            and (${t.retirementReason} is null or ${t.retirementReason} <> 'superseded')`,
      ),
    /**
     * ADR 0002 D18's active-offer uniqueness for the NATIVE kind: one active
     * offer per native variant. A second would double the seller in every
     * comparison.
     */
    uniqueIndex('offers_active_native_variant_key')
      .on(t.productVariantId)
      .where(sql`${t.kind} = 'native' and ${t.status} = 'active'`),
    /**
     * ADR 0002 D18's active-offer uniqueness for every other kind: one active
     * offer per (canonical variant, seller, channel, condition). Twenty
     * merchants listing one variant produce twenty rows (issue acceptance 1);
     * ONE merchant listing it twice on one channel in one condition does not.
     */
    uniqueIndex('offers_active_commercial_key')
      .on(t.commercialKey)
      .where(sql`${t.status} = 'active' and ${t.kind} <> 'native'`),

    /**
     * ISSUE INDEX 2 — the comparison read.
     *
     * The product page asks for the active offers on a variant ordered by
     * price, so the index is that query's own shape: the equality columns
     * first, then the sort key, then `id` to make the keyset cursor total.
     * Partial on `status = 'active'`, which keeps it the size of the set every
     * comparison actually scans rather than of every offer that ever existed.
     *
     * Measured on a seeded million rows, hottest variant carrying 500 offers:
     * 0.44 ms. The index serves the SCAN and not yet the SORT — the read orders
     * by `coalesce(price_amount, <sentinel>)` so unpriced `informational`
     * records land last, and that expression is not what this index stores, so
     * the planner adds a top-N heapsort over the variant's own offers. It costs
     * about a quarter of a millisecond at 500 rows and is left as measured:
     * removing it means either an expression index or a cursor that can page
     * across NULLs, and ADR 0002 D21 gives #61 the authority to add indexes and
     * projections WITH numbers attached rather than ahead of them.
     */
    index('offers_variant_comparison_idx')
      .on(t.canonicalVariantId, t.priceAmount, t.id)
      .where(sql`${t.status} = 'active'`),
    /**
     * #61 — the sort the index above could not serve, as an EXPRESSION index.
     *
     * The docblock above states the gap and hands the fix to #61 with numbers
     * attached; these are the numbers. `listOffersForComparison` orders by
     * `coalesce(price_amount, <sentinel>)` so unpriced `informational` records
     * land last, and a plain index on `price_amount` does not store that
     * expression — so the planner read every active offer on the variant and
     * top-N sorted them. Indexing the expression the reader actually sorts by
     * makes it an ordered index scan that stops at the LIMIT.
     *
     * Measured on the seeded `medium` scale, hottest variant carrying 609
     * offers: **0.564 ms → 0.049 ms**, rows scanned **580 → 20**, and the Sort
     * node disappears from the plan. The market-scoped branch
     * (`country = $1 or country is null`) takes the same index.
     *
     * ## The sentinel is `sql.raw` and that is not a style choice
     *
     * A value interpolated into a `sql` template inside a schema DEFINITION is
     * written into the generated migration as the bound-parameter placeholder
     * `$1`, and DDL cannot carry a parameter — so the migration fails at APPLY
     * time while generating perfectly (`~/Oxy/AGENTS.md` §Drizzle `sql`
     * templates). `sql.raw` emits the constant as text. It is rendered from
     * `MAX_MONEY_MINOR_UNITS`, the SAME constant `UNPRICED_SORT_KEY` in
     * `offerRepository.ts` reads, because an expression index whose constant
     * differs from the reader's by one is not a slightly worse index — it is an
     * index the planner silently cannot use.
     */
    index('offers_variant_price_sort_idx')
      .on(
        t.canonicalVariantId,
        sql`coalesce(${t.priceAmount}, ${sql.raw(String(MAX_MONEY_MINOR_UNITS))}::bigint)`,
        t.id,
      )
      .where(sql`${t.status} = 'active'`),
    /**
     * The same read, narrowed by market — the shape a country-scoped product
     * page runs (issue index 5, the regional half). Separate from the index
     * above rather than replacing it, because `country` is NULL on an offer
     * published for no particular market and those must still appear.
     */
    index('offers_variant_country_idx')
      .on(t.canonicalVariantId, t.country, t.priceAmount)
      .where(sql`${t.status} = 'active'`),
    /**
     * ISSUE INDEX 3 — merchant browse: everything one seller currently offers,
     * most recently seen first.
     *
     * ### `last_seen_at` is ASCENDING here, and that is the fix rather than the bug
     *
     * The obvious spelling is `.desc()`, matching the browse's own ORDER BY.
     * Drizzle renders that `DESC NULLS LAST`, while a plain `ORDER BY
     * last_seen_at DESC` means `DESC NULLS FIRST` — so the orderings do NOT
     * match, Postgres cannot use the index for the sort, and it falls back to a
     * bitmap scan plus a top-N sort over every one of that seller's offers.
     *
     * Measured on a seeded million rows, one seller holding 25,000 of them:
     * 103.7 ms with `.desc()` and a plain `ORDER BY … DESC`, 0.113 ms once the
     * reader spells `DESC NULLS LAST`, and **0.071 ms with this ASCENDING index
     * and the plain, natural `ORDER BY … DESC`** — which Postgres serves with a
     * BACKWARD scan, and a backward scan of `ASC NULLS LAST` is exactly
     * `DESC NULLS FIRST`.
     *
     * So the ascending index is the one that does not depend on every future
     * reader remembering a NULLS clause. `last_seen_at` is NOT NULL, so the two
     * directions are semantically identical here and only the planner can tell
     * them apart. Do not "tidy" this back to `.desc()`.
     */
    index('offers_merchant_browse_idx')
      .on(t.merchantId, t.status, t.lastSeenAt)
      .where(sql`${t.merchantId} is not null`),
    /** ISSUE INDEX 3 — storefront browse, the channel-scoped half, same rule. */
    index('offers_storefront_browse_idx')
      .on(t.storefrontId, t.status, t.lastSeenAt)
      .where(sql`${t.storefrontId} is not null`),
    /**
     * ISSUE INDEX 4 — the native reverse lookups.
     *
     * By LISTING, because that is the grain the converger, the moderation path
     * and the operator trace all address; the variant lookup is served by the
     * active-native unique above, which is a btree on `product_variant_id`.
     */
    index('offers_native_listing_idx')
      .on(t.listingId)
      .where(sql`${t.listingId} is not null`),
    /**
     * ISSUE INDEX 5 — the freshness filter, and the refresh sweep's own order.
     *
     * `(status, stale_at)` is what "which active offers have lapsed" scans, and
     * #68's refresh loop reads it in exactly this order.
     */
    index('offers_freshness_idx').on(t.status, t.staleAt),
    /** The reverse lookup from an observation to the offers it produced. */
    index('offers_source_record_idx')
      .on(t.sourceRecordId)
      .where(sql`${t.sourceRecordId} is not null`),
  ],
);

/**
 * `native_listing_links` — the attachment of one native `product_variants` row
 * to one canonical variant (ADR 0002 D6, owned by #57 per D25(a)).
 *
 * An ATTACHMENT, never a migration: the listing stays the operational record and
 * the seller's property, keeps its own price, photos, stock and words, and
 * removing this row touches none of them. Forty P2P listings of a used iPhone
 * and three store listings of the new one all point at the same canonical
 * variant; that is what makes them comparable without making them one thing.
 *
 * The method set has NO `name_match` member — the `native_store_links` and
 * `commerce_relationships` device. A matcher acting on a title similarity must
 * record `matcher` with a rule id and a confidence, which #59 can review; there
 * is no value that means "attached because the names looked alike".
 */
export const nativeListingLinks = pgTable(
  'native_listing_links',
  {
    id: generatedId(),
    /** CASCADE from the native side (ADR 0002 D20) — a seller's delete is not blocked. */
    productVariantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    /** Denormalized parent, for "which of this listing's variants are attached". */
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** RESTRICT: a canonical variant is never hard-deleted under its attachments. */
    canonicalVariantId: text()
      .notNull()
      .references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    method: text({ enum: asEnumValues(NATIVE_LISTING_LINK_METHODS) }).notNull(),
    /** The explainable rule id that produced this link; #58 owns the vocabulary. */
    matchRule: text().notNull(),
    /**
     * 0–1, and CHECK-restricted to `matcher` rows. A deterministic identifier
     * match, a connector declaration and an operator decision are all certain
     * by construction, so a number on one could only be read as doubt about a
     * fact nobody doubted.
     */
    confidence: doublePrecision(),
    status: text({ enum: asEnumValues(NATIVE_LISTING_LINK_STATUSES) })
      .notNull()
      .default('active'),
    /** The observation behind an ingested link. RESTRICT (D19). */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    decidedByOxyUserId: text(),
    revokedAt: timestamptz(),
    /** An Oxy account id — no foreign key. */
    revokedByOxyUserId: text(),
    revokeReason: text(),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('native_listing_links_method_check', t.method, NATIVE_LISTING_LINK_METHODS),
    checkOneOf('native_listing_links_status_check', t.status, NATIVE_LISTING_LINK_STATUSES),
    check(
      'native_listing_links_confidence_check',
      sql`${t.confidence} is null
          or (${t.confidence} >= 0 and ${t.confidence} <= 1 and ${t.method} = 'matcher')`,
    ),
    check(
      'native_listing_links_revoked_state_check',
      sql`${t.status} <> 'revoked' or (${t.revokedAt} is not null and ${t.revokedByOxyUserId} is not null)`,
    ),
    check('native_listing_links_match_rule_check', sql`btrim(${t.matchRule}) <> ''`),
    /**
     * ADR 0002 D6/D20: at most ONE active attachment per native variant. A
     * second would make "which canonical variant is this listing" ambiguous at
     * the exact moment a comparison needs the answer.
     */
    uniqueIndex('native_listing_links_active_variant_key')
      .on(t.productVariantId)
      .where(sql`${t.status} = 'active'`),
    index('native_listing_links_canonical_variant_idx').on(t.canonicalVariantId, t.status),
    index('native_listing_links_listing_idx').on(t.listingId, t.status),
    index('native_listing_links_source_record_idx')
      .on(t.sourceRecordId)
      .where(sql`${t.sourceRecordId} is not null`),
  ],
);

/**
 * `offer_outboxes` — the durable promise that a listing's native offers will be
 * brought back into agreement with the listing (issue native rule 4).
 *
 * ### One row per LISTING, and that is what makes it a convergence queue
 *
 * The moderation and payment outboxes are one row per EVENT, keyed on a
 * deterministic event id, because each one delivers a distinct thing exactly
 * once. This queue delivers a FIXED POINT: whatever the listing looks like when
 * the worker runs is the answer, so five writes in a second owe one convergence,
 * not five. `UNIQUE(listing_id)` states that, and the enqueue is an
 * `ON CONFLICT DO UPDATE` that bumps `requested_revision` — deliberately unlike
 * `enqueueModerationOutboxEvent`, whose `DO NOTHING` is load-bearing for the
 * opposite reason.
 *
 * ### The revision pair is what stops a write being lost to a race
 *
 * A request that arrives while the worker is mid-convergence would otherwise be
 * swallowed by the completion that follows it. The claim copies
 * `requested_revision` into `claimed_revision`; completion compares the two and
 * leaves the row `pending` when a newer request came in during the run. Without
 * it, a moderation restriction landing one millisecond after a claim would sit
 * unconverged until the next unrelated write to that listing.
 *
 * ### No `expires_at`, and therefore no `expiryTargets.ts` entry
 *
 * The moderation outbox needs a retention sweep because it grows one row per
 * report forever. This table cannot: there is one row per listing and it
 * CASCADEs with the listing, so its size is bounded by the catalogue itself. A
 * retention column here would delete pending convergence work on a clock, which
 * is the one thing the sweep must never do.
 */
export const offerOutboxes = pgTable(
  'offer_outboxes',
  {
    id: generatedId(),
    /**
     * The listing whose native offers are owed a convergence. CASCADE: a
     * deleted listing takes its offers with it (both are CASCADE from the
     * native side), so there is nothing left for a job to converge.
     */
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** Bumped by every enqueue. Monotonic per row; never a clock. */
    requestedRevision: bigint({ mode: 'number' }).notNull().default(1),
    /** The revision this claim is answering. NULL before the first claim. */
    claimedRevision: bigint({ mode: 'number' }),
    status: text({ enum: asEnumValues(OFFER_OUTBOX_STATUSES) }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull(),
    /** Which task holds the lease. An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    processedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('offer_outboxes_status_check', t.status, OFFER_OUTBOX_STATUSES),
    check('offer_outboxes_attempts_check', sql`${t.attempts} >= 0`),
    check('offer_outboxes_requested_revision_check', sql`${t.requestedRevision} >= 1`),
    check(
      'offer_outboxes_claimed_revision_check',
      sql`${t.claimedRevision} is null or ${t.claimedRevision} <= ${t.requestedRevision}`,
    ),
    check(
      'offer_outboxes_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(OFFER_OUTBOX_MAX_LAST_ERROR_LENGTH))}`,
    ),
    /** The convergence key: one outstanding job per listing, ever. */
    uniqueIndex('offer_outboxes_listing_key').on(t.listingId),
    // The claim query is a two-branch `or` — due PENDING work, and PROCESSING
    // work whose lease has expired — so one partial index per branch, neither
    // scanning the other's rows. The moderation outbox's shape, for its reasons.
    index('offer_outboxes_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('offer_outboxes_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.status} = 'processing'`),
  ],
);
