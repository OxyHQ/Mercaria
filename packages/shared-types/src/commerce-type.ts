/**
 * What kind of thing Mercaria's catalogue classifies (#367, ADR 0007 D15 as
 * amended by ADR 0010).
 *
 * The answer is **a physical good or a digital good, and nothing else**, and this
 * module is the one place that is written down. It closes the open item ADR 0007
 * carried: *"whether bundles, services and digital goods get their own
 * product-type scopes or are excluded at launch"*.
 *
 * ## `digital_good` was EXCLUDED until #1015, and that history is the mechanism
 *
 * It is admitted here under the procedure this file describes rather than by
 * widening a tuple: its old disposition named seven prerequisites, and
 * {@link DIGITAL_GOOD_PREREQUISITE_DISCHARGES} is a total map over exactly those
 * seven saying what discharged each one. The map is not documentation — it is
 * how the admission stays checkable after the exclusion it replaced is gone,
 * because the prerequisites a classified type no longer states are otherwise
 * unrecoverable from the diff.
 *
 * ## The four verdicts, in one sentence each
 *
 * - **Bundles FIT and get no product type of their own.** ADR 0002 D15 already
 *   decided it and the graph already implements it: a bundle is its OWN
 *   `canonical_products` row, authored under whatever product type its own
 *   category grants, and what it contains is a RELATIONSHIP (`bundle_components`)
 *   rather than an attribute. See {@link PHYSICAL_GOOD_COMPOSITIONS}.
 * - **Multipacks FIT the same way**, as a `pack_count` variant of the same
 *   product with their own GTIN (ADR 0002 D15) — which is why `pack_count` is
 *   deliberately absent from `PRODUCT_TYPE_COMPOSITION_AXIS_KEYS` and a test
 *   pins that absence.
 * - **Digital goods are CLASSIFIED**, since #1015 and ADR 0010: a 3D asset sold
 *   as bytes is a canonical product with canonical variants, and what makes it
 *   deliverable is the asset/licence/right domain rather than a second commerce
 *   stack. See {@link DIGITAL_GOOD_PREREQUISITE_DISCHARGES}.
 * - **Services are EXCLUDED**, and so are the three neighbours the repository
 *   already names in the same breath.
 * - **A future type arrives through a PROCEDURE, not an extension point.**
 *   {@link COMMERCE_TYPE_DISPOSITIONS} is a total `Record`, so a member added to
 *   the tuples below fails `tsc` here until somebody says what happens to it,
 *   and an excluded member's `prerequisites` is a NON-EMPTY tuple type, so it
 *   cannot be excluded for no stated reason either.
 *
 * ## Why there is no `commerce_type` COLUMN, and why that is the enforcement
 *
 * The obvious spelling of this decision is a discriminator on `categories` or
 * `listings` whose CHECK admits one value. It is wrong for the reason
 * `canonicalCatalog.ts` gives for refusing an `is_bundle` flag and
 * `services/analytics/` gives for refusing a property bag: **the ABSENT column
 * is the enforcement.** A column with one legal value answers a question that
 * has one answer, and the moment a second answer is wanted the column is already
 * there to receive it — with no ADR amendment, because widening a CHECK looks
 * like ordinary schema work. So the discriminator does not exist, and
 * `commerce-type-exclusion.test.ts` fails the build if one is introduced.
 *
 * It also would not do the job it appears to do. A category slug is free text; a
 * `digital-goods` category declared `physical_good` is a lie no constraint can
 * see. What CAN be held structurally is the half that matters — that Mercaria's
 * own model never grows a REPRESENTATION of an excluded type by accident — and
 * that is what the gate holds.
 *
 * ## The exclusions are not new walls; they are existing walls, named
 *
 * Every refusal below is already true of this repository and was measured before
 * it was written down. What #367 line 144 adds is the difference between an
 * accident and a decision: each wall is now pinned by a test, so relaxing one is
 * a visible act rather than a quiet one. {@link CommerceTypePrerequisite} is the
 * list of those walls, and it is also the admission procedure — to classify a
 * new type, every prerequisite it names has to be discharged.
 */

/**
 * The commerce types Mercaria's catalogue classifies.
 *
 * TWO members since #1015. It was one for the whole of the catalogue epic, and
 * the second arrived through the procedure at the bottom of this file rather than
 * by an edit here — which is the only reason widening it is safe to do at all.
 * A tuple rather than a bare union because the disjointness test below needs two
 * sets to compare, and because widening it is then a diff that reads as what it
 * is.
 */
export type MercariaCommerceType = 'physical_good' | 'digital_good';

/** The tuple {@link COMMERCE_TYPE_DISPOSITIONS} and the gate both read. */
export const MERCARIA_COMMERCE_TYPES: readonly MercariaCommerceType[] = [
  'physical_good',
  'digital_good',
];

/**
 * The commerce types Mercaria deliberately does not classify.
 *
 * DERIVED rather than imagined: every member is a thing this repository already
 * names somewhere as absent or forbidden, and the citation is in its
 * disposition below. A list invented from what a marketplace could conceivably
 * sell would be unbounded and would say nothing about Mercaria.
 *
 * Disjoint from {@link MERCARIA_COMMERCE_TYPES} by a test — the
 * `RETAIL_FORBIDDEN_COMPONENT_KINDS` device, so a type cannot be admitted and
 * excluded at once.
 */
export type ExcludedCommerceType =
  /** Labour, an appointment, an installation, a repair sold as such. */
  | 'service'
  /** A gift card, a voucher, store credit — a claim on future value. */
  | 'stored_value'
  /** A ticket to a dated event, admission, a seat. */
  | 'event_admission'
  /** A buyer paying on a recurring schedule for a continuing supply. */
  | 'consumer_subscription';

/** The tuple {@link COMMERCE_TYPE_DISPOSITIONS} and the gate both read. */
export const EXCLUDED_COMMERCE_TYPES: readonly ExcludedCommerceType[] = [
  'service',
  'stored_value',
  'event_admission',
  'consumer_subscription',
];

/** Every commerce type this decision has an answer for. */
export type CommerceType = MercariaCommerceType | ExcludedCommerceType;

/* -------------------------------------------------------------------------- */
/* How a physical good may be COMPOSED — the bundle and multipack answer        */
/* -------------------------------------------------------------------------- */

/**
 * The shapes a physical good comes in.
 *
 * These are **not** commerce types and must never become members of
 * {@link MercariaCommerceType}: a bundle and a multipack are both physical
 * goods, and modelling either as a separate type is what would force a
 * `bundle` product type, a `bundle` category branch and a second price basis —
 * the duplication ADR 0002 D15 avoided by making a bundle an ordinary product
 * that happens to name its components.
 */
export type PhysicalGoodComposition = 'single_item' | 'bundle' | 'multipack';

/** The tuple {@link PHYSICAL_GOOD_COMPOSITIONS} is keyed on. */
export const PHYSICAL_GOOD_COMPOSITION_KINDS: readonly PhysicalGoodComposition[] = [
  'single_item',
  'bundle',
  'multipack',
];

/** How one composition shape is carried, and what may never carry it. */
export interface PhysicalGoodCompositionRule {
  /** The mechanism that already represents it. */
  readonly mechanism: string;
  /** Where that mechanism is defined, so a reader can check rather than trust. */
  readonly citation: string;
  /**
   * Whether the shape needs a product type of its own.
   *
   * `false` for all three today, which IS the answer to #367 line 144's first
   * clause: none of them is a schema question, so none of them is a product
   * type.
   */
  readonly needsOwnProductType: boolean;
}

/**
 * A total map over {@link PhysicalGoodComposition}.
 *
 * `tsc` fails if a shape is added without a mechanism, which is the
 * `CHANNEL_ENTITY_POLICY` device: a map that could only express the shapes
 * somebody remembered would leave the rest out silently.
 */
export const PHYSICAL_GOOD_COMPOSITIONS: Readonly<
  Record<PhysicalGoodComposition, PhysicalGoodCompositionRule>
> = {
  single_item: {
    mechanism:
      'One canonical product with one or more variants; the ordinary case and the one every product type is written for.',
    citation: 'ADR 0002 D13',
    needsOwnProductType: false,
  },
  bundle: {
    mechanism:
      'Its OWN canonical product, because it is bought, priced and identified as one thing and usually carries its own GTIN. What it contains is recorded as `bundle_components` rows so comparison can decompose it, and there is no `is_bundle` flag — the rows ARE the fact. Its price is its own price and its stock is its own stock; neither is derived from its components, which is why no pricing, cart or inventory module knows bundles exist.',
    citation: 'ADR 0002 D15; db/schema/canonicalCatalog.ts `bundle_components`',
    needsOwnProductType: false,
  },
  multipack: {
    mechanism:
      'A variant of the SAME canonical product carrying a `pack_count` axis and its own GTIN — reality already models a six-pack as a different trade item from the single, and following it costs nothing. `pack_count` is therefore a legitimate variant axis and is deliberately NOT in `PRODUCT_TYPE_COMPOSITION_AXIS_KEYS`.',
    citation: 'ADR 0002 D15; services/matching/relation-detection.ts',
    needsOwnProductType: false,
  },
};

/* -------------------------------------------------------------------------- */
/* The admission procedure                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a commerce type must supply before Mercaria could classify it.
 *
 * A CLOSED tuple, and that is the whole answer to #367 line 144's *"non-standard
 * future commerce types"*. The tempting shape there is an extension point — an
 * open `type` column, a `metadata` bag, a plugin seam — and this repository
 * refuses those for a reason it has already written down twice: an open bag is
 * the one mechanism by which something reaches production unreviewed
 * (`services/analytics/` has no property bag; `services/payments/redact.ts` is
 * an allow-list because a deny-list is correct only until the provider adds a
 * field).
 *
 * So the future is a PROCEDURE instead. Each member below names a place where
 * Mercaria's commerce path assumes a physical good, measured rather than
 * imagined; admitting a type means discharging the ones it names, in the change
 * that admits it. Because the vocabulary is closed, a type cannot be admitted by
 * inventing a reason it does not need any of them.
 */
export type CommerceTypePrerequisite =
  /**
   * A destination semantics for something with no place to be sent.
   * `destinationFromInput` throws `'A checkout needs a delivery destination.'`
   * when a body carries neither `destination` nor the v1 `addressId`, and
   * `CheckoutDestination`'s three branches are all places.
   */
  | 'delivery_destination'
  /**
   * An order row that can exist without a postal address. `orders` takes
   * `addressColumns('shippingAddress')`, whose recipient, line 1, city, postal
   * code and country are NOT NULL; collection satisfies them by snapshotting
   * the pickup location's own address, so even the one non-shipped path
   * produces a real street.
   */
  | 'order_address_snapshot'
  /**
   * A completion state that is not `shipped` or `delivered`. `OrderStatus` and
   * `SHIPPING_METHODS` are both CHECK-bound tuples describing physical
   * movement, and neither has a member meaning "the bytes were sent" or "the
   * work was performed".
   */
  | 'fulfilment_completion_signal'
  /**
   * A mechanism that actually hands the buyer the thing. Nothing in this
   * repository delivers a non-physical item: there is no download, no key, no
   * redemption and no entitlement a buyer can hold.
   */
  | 'entitlement_delivery'
  /**
   * What stock means for something uncountable. `product_variants.inventoryTracked
   * = false` yields a permanently-in-stock variant with a NULL published
   * quantity, which is close but is not the same statement — it says the count
   * is unknown, not that counting is the wrong question.
   */
  | 'inventory_semantics'
  /**
   * A place-of-supply rule that is not the shipping address. `rateMatchesRegion`
   * reads exactly three inputs — the shipping country, region and postal code —
   * and a supply with no shipment has none of them. Nothing anywhere reads a
   * billing country, a residence or any other consumer-location evidence.
   */
  | 'tax_place_of_supply'
  /**
   * Withdrawal and guarantee windows that are not the goods windows. Mercaria's
   * published terms run the statutory clock from the day the consumer takes
   * physical possession, and the guarantee is the conformity guarantee for
   * goods.
   */
  | 'withdrawal_and_guarantee_terms'
  /**
   * A condition vocabulary for something with no condition. Every one of
   * `ITEM_CONDITION_KEYS`' members describes the state of an object, and the
   * tuple is a CHECK on `order_items`.
   */
  | 'condition_semantics'
  /**
   * A price basis that is not a whole unit. `order_items.quantity` is an
   * integer with a `> 0` CHECK, and no duration, unit of measure or
   * sold-by column exists anywhere.
   */
  | 'pricing_basis';

/** The tuple the gate and the disposition map both read. */
export const COMMERCE_TYPE_PREREQUISITES: readonly CommerceTypePrerequisite[] = [
  'delivery_destination',
  'order_address_snapshot',
  'fulfilment_completion_signal',
  'entitlement_delivery',
  'inventory_semantics',
  'tax_place_of_supply',
  'withdrawal_and_guarantee_terms',
  'condition_semantics',
  'pricing_basis',
];

/**
 * What Mercaria does about ONE commerce type.
 *
 * A discriminated union on a STRING rather than a boolean, because the backend
 * compiles with `strict: false` and TypeScript does not narrow a union on the
 * truthiness of a boolean-literal discriminant there — #68's finding, and it
 * has bitten in this repository twice.
 */
export type CommerceTypeDisposition =
  | {
      readonly verdict: 'classified';
      /** How it is represented, so the entry is checkable rather than a claim. */
      readonly mechanism: string;
    }
  | {
      readonly verdict: 'excluded';
      /**
       * What would have to land first. A NON-EMPTY tuple type, so an exclusion
       * with no stated cost does not compile — the sibling of
       * `assertEachOf`'s mandatory floor.
       */
      readonly prerequisites: readonly [CommerceTypePrerequisite, ...CommerceTypePrerequisite[]];
      /**
       * Where this repository ALREADY says it does not have this, so the
       * exclusion records an existing state rather than announcing a new one.
       */
      readonly evidence: string;
    };

/**
 * The decision, as data.
 *
 * Total over {@link CommerceType}: adding a member to either tuple fails `tsc`
 * here until somebody decides what happens to it. That is the
 * `CHANNEL_ENTITY_POLICY` and `MERGE_REHOMING_PLAN` shape — a type that must NOT
 * be classified is as much a decision as one that must, and a map able to
 * express only "we sell it" would force whoever wrote it to leave the rest out.
 */
export const COMMERCE_TYPE_DISPOSITIONS: Readonly<
  Record<CommerceType, CommerceTypeDisposition>
> = {
  physical_good: {
    verdict: 'classified',
    mechanism:
      'The whole catalogue. Taxonomy, product types, canonical products, variants, listings and offers are written for it, and the three reference verticals — footwear, smartphone, brake pad — are all physical goods. Its three composition shapes are PHYSICAL_GOOD_COMPOSITIONS.',
  },
  service: {
    verdict: 'excluded',
    prerequisites: [
      'delivery_destination',
      'order_address_snapshot',
      'fulfilment_completion_signal',
      'inventory_semantics',
      'condition_semantics',
      'pricing_basis',
      'withdrawal_and_guarantee_terms',
    ],
    evidence:
      'Nothing in the repository represents a service sold to a buyer: no duration, no schedulable resource, no unit of measure, and no line shape other than a catalog variant — `order_items.variantId` is NOT NULL. `services/retail-service-requests/` is a post-sale remedy queue and models nothing sellable; a purchasable warranty does not exist, and `RETAIL_WARRANTY_BASES` carries only a statutory guarantee and a published commercial one.',
  },
  digital_good: {
    verdict: 'classified',
    mechanism:
      'The same catalogue graph as a physical good — category, product type, canonical product, canonical variant, listing, offer — with the DELIVERABLE modelled beside it rather than inside it: `digital_assets` -> `asset_versions` -> `asset_files`, assembled into `asset_packages`, licensed by `asset_licence_versions`, and owned by the buyer as an `asset_rights` row (#1015, ADR 0010). A materially different deliverable is a canonical VARIANT (printable, game-ready, source-files); a file format is not, because several formats belong to one purchased package. Admitted by discharging the seven prerequisites its former exclusion named — DIGITAL_GOOD_PREREQUISITE_DISCHARGES.',
  },
  stored_value: {
    verdict: 'excluded',
    prerequisites: [
      'entitlement_delivery',
      'fulfilment_completion_signal',
      'tax_place_of_supply',
      'condition_semantics',
      'pricing_basis',
    ],
    evidence:
      "Already recorded as an absence rather than a gap: `CHANNEL_ENTITY_POLICY.gift_cards` is `never_synced` for the reason `not_modelled_by_mercaria`, and its note reads 'Mercaria has no gift card record, so there is nothing for one to be imported into.' `gift-cards` is also an EXCLUDED guest-P2P category slug. ADR 0005 excludes gift cards and store credit as a referral payout rail for a different reason, and neither creates a product.",
  },
  event_admission: {
    verdict: 'excluded',
    prerequisites: [
      'delivery_destination',
      'entitlement_delivery',
      'fulfilment_completion_signal',
      'inventory_semantics',
      'condition_semantics',
    ],
    evidence:
      'A dated seat is inventory against an event rather than against a location, and no event, date or seat exists anywhere in the schema. `tickets` appears in this repository only as an EXCLUDED guest-P2P category slug; every other occurrence of the word is a support ticket or a push receipt.',
  },
  consumer_subscription: {
    verdict: 'excluded',
    prerequisites: [
      'fulfilment_completion_signal',
      'pricing_basis',
      'withdrawal_and_guarantee_terms',
      'entitlement_delivery',
    ],
    evidence:
      "A buyer paying on a schedule has no representation: an order is placed once, and `orders` has no recurrence, term or renewal. The subscription machinery that DOES exist is #89's merchant plans — Mercaria billing a merchant for its own software — which is why `merchant_subscription_plan` and `merchant_subscription_tier` are named as FORBIDDEN inputs by the comparison and supplier-preflight domains rather than as products.",
  },
};

/* -------------------------------------------------------------------------- */
/* The admission that was actually performed — `digital_good` (#1015)          */
/* -------------------------------------------------------------------------- */

/**
 * The seven prerequisites `digital_good`'s exclusion named, preserved after the
 * exclusion itself was removed.
 *
 * This tuple is a LEDGER ENTRY, not a live constraint, and it exists because the
 * admission procedure has a hole that only becomes visible the first time
 * somebody walks it: step 1 deletes the very list step 3 is measured against.
 * Once `digital_good` is `classified`, its `prerequisites` field is gone, so
 * "every prerequisite was discharged" is a claim nothing in the repository can
 * check — the next reader would have to dig the old disposition out of git to
 * find out what was promised.
 *
 * Copied VERBATIM from the disposition this change replaced, in the order it
 * stated them. `inventory_semantics` and `pricing_basis` are deliberately absent
 * because that disposition did not name them: a digital line IS a catalog
 * variant bought in whole units, so `order_items.variant_id` and the `quantity > 0`
 * CHECK are untouched by #1015. ADR 0010 D12 still answers what stock means for
 * an asset, because #1015 boundary 1 asks even though the procedure did not.
 */
export const DIGITAL_GOOD_PREREQUISITES = [
  'delivery_destination',
  'order_address_snapshot',
  'fulfilment_completion_signal',
  'entitlement_delivery',
  'tax_place_of_supply',
  'condition_semantics',
  'withdrawal_and_guarantee_terms',
] as const satisfies readonly CommerceTypePrerequisite[];

/** One of {@link DIGITAL_GOOD_PREREQUISITES}. */
export type DigitalGoodPrerequisite = (typeof DIGITAL_GOOD_PREREQUISITES)[number];

/** What discharged ONE prerequisite, and where to check it. */
export interface CommerceTypePrerequisiteDischarge {
  /** What now exists that did not, in one sentence a reviewer can disagree with. */
  readonly mechanism: string;
  /** The symbol, table or module that IS the discharge, so it is checkable. */
  readonly citation: string;
  /**
   * The ADR decision that authorised it.
   *
   * Every entry cites ADR 0010 rather than #1015 directly: an issue records what
   * somebody asked for and an ADR records what was decided, and a discharge is
   * the second kind of fact.
   */
  readonly decision: string;
}

/**
 * How each of {@link DIGITAL_GOOD_PREREQUISITES} was discharged.
 *
 * Total over the tuple, which is the `CHANNEL_ENTITY_POLICY` device again: a
 * prerequisite that was never discharged cannot be left out of this map without
 * failing `tsc`, so "we did six of the seven" is not a state this file can be
 * in. `digital-commerce-walls.test.ts` asserts each citation still resolves to a
 * real exported symbol or a real table, so an entry cannot survive the thing it
 * cites being deleted.
 */
export const DIGITAL_GOOD_PREREQUISITE_DISCHARGES: Readonly<
  Record<DigitalGoodPrerequisite, CommerceTypePrerequisiteDischarge>
> = {
  delivery_destination: {
    mechanism:
      'A fourth checkout destination, `digital_delivery`, which carries no place at all — not an address with empty fields. It is REFUSED for any checkout containing a physical line, so it cannot become a way to buy a chair with no address, and the refusal is the server\'s own check against the resolved cart rather than a client assertion.',
    citation:
      "CHECKOUT_DESTINATION_TYPES `digital_delivery`; services/checkout/destination.ts `DigitalFulfilment`; services/checkout.service.ts `refuseDigitalDestinationForPhysicalLines`",
    decision: 'ADR 0010 D8',
  },
  order_address_snapshot: {
    mechanism:
      "The five required address columns on `orders` became nullable and a CHECK took their place: a `digital` order must have them ALL NULL and every other order must have them ALL NOT NULL. That is stronger than the NOT NULL it replaces, because NOT NULL permitted a fabricated street and the CHECK forbids one — #1015 boundary 16's 'no fake shipping records' is now a constraint rather than a convention.",
    citation: "orders_shipping_address_digital_check; db/schema/orders.ts",
    decision: 'ADR 0010 D8',
  },
  fulfilment_completion_signal: {
    mechanism:
      "A ninth order status, `digitally_delivered`, and a fourth fulfilment method, `digital`. The method joins SHIPPING_METHODS rather than making `orders.shipping_method` nullable, following `pickup` — which has been a non-shipping member of that tuple since #93 and makes the tuple a FULFILMENT vocabulary under a legacy name.",
    citation: "ORDER_STATUSES `digitally_delivered`; SHIPPING_METHODS `digital`",
    decision: 'ADR 0010 D9',
  },
  entitlement_delivery: {
    mechanism:
      'The whole of #1015 Workstream 2: an `asset_rights` row is the durable thing a buyer holds, created idempotently from the paid order state, and a download is authorized against it and served through a short-lived grant that is never logged. No permanent URL exists anywhere in the domain.',
    citation: "db/schema/digitalRights.ts `assetRights`; services/digital/right.service.ts",
    decision: 'ADR 0010 D5',
  },
  tax_place_of_supply: {
    mechanism:
      "A place of supply per LINE rather than per order: a physical line is still matched on the shipping country, region and postal code, and a digital line is matched on the consumer's country alone. The two rules are selected by the line, so a mixed order taxes each half correctly and neither borrows the other's evidence.",
    citation:
      "DigitalPlaceOfSupply; services/pricing.service.ts `rateMatchesPlaceOfSupply`; orders.digital_supply_country",
    decision: 'ADR 0010 D10',
  },
  condition_semantics: {
    mechanism:
      "A digital line carries NO condition, and a CHECK says so: `order_items.condition_key` must be NULL when the line names an asset version. ITEM_CONDITION_KEYS is untouched — adding a `not_applicable` member would have given every PHYSICAL listing a way to decline to describe itself, which is exactly the erosion #90 was built against.",
    citation: "order_items_digital_no_condition_check; db/schema/orders.ts",
    decision: 'ADR 0010 D11',
  },
  withdrawal_and_guarantee_terms: {
    mechanism:
      "A closed DIGITAL_WITHDRAWAL_BASES vocabulary plus a consent timestamp on the order, paired by a CHECK: a `waived_on_immediate_supply` order cannot exist without the instant the buyer acknowledged the waiver. The goods conformity guarantee is replaced by conformity with the DESCRIBED deliverable, which is answerable only because measured facts and seller claims are separate tables.",
    citation:
      "DIGITAL_WITHDRAWAL_BASES; DIGITAL_CONFORMITY_BASIS; orders_digital_withdrawal_consent_check",
    decision: 'ADR 0010 D11',
  },
};
