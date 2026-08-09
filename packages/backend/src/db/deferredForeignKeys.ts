/**
 * Id-Column Classification Ledgers
 *
 * A schema built table by table lets an id-shaped column arrive with no foreign
 * key and nobody having decided that on purpose. Left unchecked, "no
 * constraint" and "nobody has looked at this yet" are indistinguishable — so
 * every `*_id` column in Mercaria's schema must be accounted for by exactly one
 * of four things: a real `.references()`, a primary key, an entry in
 * {@link DEFERRED_FOREIGN_KEYS}, or an entry in
 * {@link ID_COLUMNS_WITHOUT_FOREIGN_KEY}. Anything else fails the gate in
 * `__tests__/schema-conventions.test.ts` as `unclassified_id_column`.
 *
 * ## The fact that shapes both lists: there is no `users` table
 *
 * Oxy owns identity. Mercaria reaches it over HTTP, so every buyer id, seller
 * id, store-member id and `oxy_user_id` in this schema is a FOREIGN SERVICE's
 * primary key and can carry no foreign key. That is not a gap to close later: a
 * shadow `users` table would be a cache that can disagree with Oxy, and
 * validating on write would put an HTTP round trip in front of every insert.
 * Those columns belong in {@link ID_COLUMNS_WITHOUT_FOREIGN_KEY} permanently,
 * each with its reason.
 *
 * The same is true of ids belonging to other services Mercaria integrates with
 * — a CrowdSource `decision_id`, an Oxy `file_id` on a listing image, an Oxy
 * Pay reference on an order.
 *
 * ## Deferred versus permanent — the distinction that makes the gate work
 *
 * {@link DEFERRED_FOREIGN_KEYS} is for a relation that IS decided but not yet
 * expressible, because the parent table has not landed. The gate fails the
 * moment a table with that name appears in the schema: the entry must then
 * become a real `.references()` and be deleted from the list. That is what
 * stops "we'll add the constraint when the other table exists" from becoming a
 * permanent condition nobody revisits.
 *
 * ## Empty again, and how it was USED once
 *
 * Fase 1 wrote 49 tables in one pass and the payment domain added eight more, so
 * for a long time no relation was ever left waiting on a parent that did not
 * exist. The canonical commerce graph (ADR 0002) gave the deferred list its
 * first real workout: #53 and #54 were built on PARALLEL branches, and #54's
 * merchant/storefront tables reference `source_records` — a table #53 owns —
 * so on #54's branch those five relations were ledgered here as DEFERRED
 * (decided, RESTRICT per D19/D25(d), not yet expressible). At integration,
 * with `source_records` in the barrel, the gate did exactly what it exists to
 * do: it refused the deferral, and every entry became a real `.references()`
 * (via `canonicalSupport.ts`'s `aliasColumns()`/`sourceLinkColumns()` and the
 * `merchant_domains` column) and left this list. An empty deferred list is the
 * correct end state, not an unstarted one.
 *
 * The payment domain's order and refund correlations are the entries most worth
 * reading before adding another PERMANENT one: they are permanently
 * unconstrained, and the block comment beside them says why — a reason that is
 * a property of a payment system, not of any store it happens to run on.
 */

import type { DeferredForeignKey } from '@oxyhq/db/assert';
import { procurementOffers } from './schema/procurement';

/**
 * Relations decided but not yet expressible — each one owes a `.references()`.
 *
 * The two entries are #118's canonical-variant mapping, waiting on #56's
 * `canonical_products` / `canonical_variants`. The moment those tables land,
 * this gate fails and the entries must become real foreign keys — which is the
 * ledger working as designed, not a breakage. `restrict` per ADR 0002 D20:
 * canonical rows are never hard-deleted, and an offer's mapping must not be
 * able to vanish out from under it. (The PO LINE copies of these columns stay
 * permanently unconstrained below — they are snapshots.)
 */
export const DEFERRED_FOREIGN_KEYS: readonly DeferredForeignKey[] = [
  {
    table: procurementOffers,
    column: procurementOffers.canonicalProductId,
    parentTable: 'canonical_products',
    parentColumn: 'id',
    onDelete: 'restrict',
    reason:
      'An offer maps to canonical identity (#56, unbuilt); canonical rows are never ' +
      'hard-deleted, so the mapping may not be orphaned silently.',
  },
  {
    table: procurementOffers,
    column: procurementOffers.canonicalVariantId,
    parentTable: 'canonical_variants',
    parentColumn: 'id',
    onDelete: 'restrict',
    reason:
      'The exact-variant half of the mapping above — same target domain, same rule.',
  },
];

/** Oxy owns identity; there is no `users` table and there must never be one. */
const OXY_ACCOUNT = 'An Oxy account id. Oxy owns identity over HTTP; there is no users table.';

/** An Oxy media file id, resolved through the SDK's canonical media chokepoint. */
const OXY_FILE = 'An Oxy media file id. Oxy owns the file; Mercaria stores only the id.';

/**
 * An id in an EXTERNAL commerce platform's own key space (Shopify, WooCommerce,
 * …). Mercaria neither mints nor validates it.
 */
const EXTERNAL_PLATFORM = "An external commerce platform's own id — a foreign system's key space.";

/**
 * A commerce SNAPSHOT's provenance. The row already carries the frozen title,
 * price and quantity that make it readable without the target, and the target
 * can legitimately be deleted (`removeVariant`, `deleteDiscount`) — so
 * constraining it would either block that deletion or destroy the historical
 * record that must outlive it. Decided in `CONVENTIONS.md` under Foreign keys.
 */
const COMMERCE_SNAPSHOT =
  'Snapshot provenance on an immutable commerce record — the target may be deleted ' +
  'and the row must survive it with its frozen values intact.';

/**
 * A payment or ledger row naming a commerce record it does not compose with.
 * See the block comment above these entries for the full reasoning.
 */
const PAYMENT_CORRELATION =
  'A financial record correlating to a commerce record it does not compose with. A ' +
  'payment must be writable whether or not its join partner is reachable — money that ' +
  'moved is a fact Mercaria owes an answer about regardless.';

/**
 * An id a payment rail minted. Stored for reconciliation, indexed, and NEVER a
 * Mercaria primary key (#45 invariant 4) — their key space changes between test
 * and live mode and two providers may mint the same string.
 */
const PROVIDER_OBJECT =
  "A payment provider's own object id. Their key space, stored for reconciliation and " +
  'deliberately never a Mercaria primary key.';

/**
 * An id in a SUPPLIER platform's own key space (#118). The same invariant as
 * {@link PROVIDER_OBJECT}, one system family over: their key spaces differ per
 * environment, and Mercaria neither mints nor validates them.
 */
const SUPPLIER_PLATFORM =
  "A supplier platform's own id — a foreign system's key space, stored for correlation " +
  'and deliberately never a Mercaria primary key.';

/**
 * A procurement record naming a commerce record it does not compose with — the
 * {@link PAYMENT_CORRELATION} rule, applied to the B2B side: a purchase order
 * is the durable record of money Mercaria owes a supplier, and it must be
 * writable and readable whether or not the customer order row is reachable.
 */
const PROCUREMENT_CORRELATION =
  'A B2B procurement record correlating to a commerce record it does not compose with. ' +
  'A purchase order must stay writable and readable independently of its customer order.';

/**
 * `*_id` columns that will NEVER carry a constraint, named `table.column` by
 * their SQL names (never the TypeScript property — an `endsWith('_id')` test
 * against `sellerId` matches nothing and passes vacuously).
 */
export const ID_COLUMNS_WITHOUT_FOREIGN_KEY: readonly { column: string; reason: string }[] = [
  // ── Oxy account ids ───────────────────────────────────────────────────────
  { column: 'abuse_reports.reporter_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'addresses.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'carts.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'customers.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'draft_orders.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'favorites.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'feedback.oxy_user_id', reason: OXY_ACCOUNT },
  // The #104/#109 conversion audit stamp. An Oxy id like every other row in
  // this block — and doubly unconstrained on purpose: the session row is
  // purged on retention (ADR 0003 D11) while the Oxy account lives on, and the
  // Oxy account can be deleted while the audit stamp must survive as inert
  // correlation text (D15, diagram 11).
  { column: 'guest_sessions.converted_to_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'listings.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'notifications.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'order_status_history.by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'orders.buyer_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'orders.seller_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'payments.buyer_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'push_tokens.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'refunds.processed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'refunds.seller_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'reviews.author_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'reviews.seller_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'seller_profiles.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'store_members.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'user_preferences.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'web_push_subscriptions.oxy_user_id', reason: OXY_ACCOUNT },

  // ── Oxy media file ids ────────────────────────────────────────────────────
  { column: 'categories.image_file_id', reason: OXY_FILE },
  { column: 'collections.image_file_id', reason: OXY_FILE },
  { column: 'listing_images.file_id', reason: OXY_FILE },
  { column: 'stores.cover_file_id', reason: OXY_FILE },
  { column: 'stores.logo_file_id', reason: OXY_FILE },

  // ── External commerce-platform ids ────────────────────────────────────────
  { column: 'connections.external_shop_id', reason: EXTERNAL_PLATFORM },
  { column: 'listing_external_refs.external_id', reason: EXTERNAL_PLATFORM },
  { column: 'listings.source_external_id', reason: EXTERNAL_PLATFORM },
  { column: 'orders.source_external_id', reason: EXTERNAL_PLATFORM },
  { column: 'product_variants.source_external_inventory_item_id', reason: EXTERNAL_PLATFORM },
  { column: 'product_variants.source_external_variant_id', reason: EXTERNAL_PLATFORM },

  // ── CrowdSource ids ───────────────────────────────────────────────────────
  {
    column: 'abuse_reports.crowd_source_case_id',
    reason: "CrowdSource's case id. CrowdSource owns cases; Mercaria only records which one.",
  },
  {
    column: 'abuse_reports.crowd_source_report_id',
    reason: "CrowdSource's report id, assigned on delivery — their key space, not ours.",
  },
  {
    column: 'moderation_enforcements.case_id',
    reason: "CrowdSource's case id — forensic only, never joined.",
  },
  {
    column: 'moderation_enforcements.decision_id',
    reason:
      "CrowdSource's decision id. Part of this table's idempotency key, and the reason " +
      'ids are carried across the cutover verbatim rather than remapped.',
  },

  // ── Polymorphic subjects: the target table varies per row ─────────────────
  {
    column: 'abuse_reports.reported_id',
    reason:
      'Polymorphic by reported_type — addresses listings, reviews, seller_profiles or ' +
      'stores depending on the row, so no single foreign key can express it.',
  },
  {
    column: 'moderation_enforcements.subject_id',
    reason: 'Polymorphic by subject_type, exactly as abuse_reports.reported_id is.',
  },

  // ── Commerce snapshots: the target may be deleted, the record may not ─────
  { column: 'draft_order_applied_discounts.discount_id', reason: COMMERCE_SNAPSHOT },
  { column: 'draft_order_line_items.listing_id', reason: COMMERCE_SNAPSHOT },
  { column: 'draft_order_line_items.variant_id', reason: COMMERCE_SNAPSHOT },
  { column: 'order_applied_discounts.discount_id', reason: COMMERCE_SNAPSHOT },
  { column: 'order_items.listing_id', reason: COMMERCE_SNAPSHOT },
  { column: 'order_items.location_id', reason: COMMERCE_SNAPSHOT },
  { column: 'order_items.variant_id', reason: COMMERCE_SNAPSHOT },
  { column: 'refund_line_items.location_id', reason: COMMERCE_SNAPSHOT },
  { column: 'refund_line_items.variant_id', reason: COMMERCE_SNAPSHOT },

  // ── Payment-domain correlations ───────────────────────────────────────────
  //
  // A payment record CORRELATES to an order; it does not compose with it, even
  // though both tables now live in this same database and a foreign key would
  // resolve.
  //
  // That is why these stay deferred: a financial record must be insertable and
  // readable independently of the commerce record it names (#45 invariant 12).
  // Money that moved is a fact Mercaria owes an answer about whether or not the
  // order row is reachable, and "the payment could not be written because a join
  // partner was missing" is the one failure a payment system may not have. That
  // is the same reasoning `refunds.order_id` did NOT get — a refund is a
  // commerce decision and stays constrained — so this is a decision per
  // relation, not a blanket exemption for the domain. The question was put to
  // `payments`, `transfers`, `ledger_transactions` and `ledger_entries`
  // individually and each keeps the deferral on its own merits.
  { column: 'payments.order_id', reason: PAYMENT_CORRELATION },
  { column: 'transfers.order_id', reason: PAYMENT_CORRELATION },
  { column: 'ledger_transactions.order_id', reason: PAYMENT_CORRELATION },
  { column: 'ledger_entries.order_id', reason: PAYMENT_CORRELATION },
  {
    column: 'ledger_transactions.refund_id',
    reason:
      'The same correlation-not-composition rule as the order ids above, against a ' +
      'refund the ledger likewise names without composing with.',
  },
  {
    column: 'ledger_entries.owner_id',
    reason:
      'Polymorphic by owner_type — a store id or an Oxy account id, and one of those two ' +
      'key spaces is not in this database at all.',
  },
  {
    column: 'orders.payment_id',
    reason: PAYMENT_CORRELATION,
  },
  { column: 'disputes.order_id', reason: PAYMENT_CORRELATION },
  {
    column: 'refunds.payment_id',
    reason:
      'The mirror of `orders.payment_id`, and the same correlation-not-composition rule: a ' +
      'refund is a commerce decision that NAMES the payment its money goes back through. ' +
      'The refund is committed before the rail is called at all (ADR 0001 D7), so the ' +
      'pointer is written by a later step and must not be able to fail the commerce write.',
  },

  // ── Reconciliation correlations (#50) ─────────────────────────────────────
  //
  // The sharpest instance of the rule above, and the reason it is restated
  // rather than assumed: the whole point of `payment_missing_locally` is a
  // provider object with NO Mercaria payment behind it. A constraint on
  // `payment_discrepancies.payment_id` would be satisfiable only by the findings
  // least worth recording, and money the rail holds that Mercaria cannot explain
  // — the one a reconciliation job exists to surface — would be the row the
  // database refused to write.
  { column: 'payment_discrepancies.payment_id', reason: PAYMENT_CORRELATION },
  { column: 'payment_discrepancies.order_id', reason: PAYMENT_CORRELATION },
  { column: 'payment_repairs.payment_id', reason: PAYMENT_CORRELATION },
  { column: 'payment_repairs.order_id', reason: PAYMENT_CORRELATION },
  {
    column: 'payment_repairs.ledger_transaction_id',
    reason:
      'The correcting transaction a repair booked, named for the audit trail. Unconstrained ' +
      'so a repair record survives independently of the ledger it describes — the same rule ' +
      'every payment correlation follows, and the ledger is the one table nothing may delete ' +
      'from anyway.',
  },
  { column: 'payment_discrepancies.provider_object_id', reason: PROVIDER_OBJECT },
  { column: 'payment_repairs.actor_oxy_user_id', reason: OXY_ACCOUNT },
  {
    column: 'payment_discrepancies.checkout_group_id',
    reason:
      'The same grouping token `payments.checkout_group_id` carries; there is no ' +
      'checkout_groups entity to point at.',
  },

  // ── Provider key spaces: ids a payment rail mints, never Mercaria ─────────
  { column: 'payments.provider_object_id', reason: PROVIDER_OBJECT },
  { column: 'payment_attempts.provider_object_id', reason: PROVIDER_OBJECT },
  { column: 'transfers.provider_object_id', reason: PROVIDER_OBJECT },
  { column: 'payouts.provider_object_id', reason: PROVIDER_OBJECT },
  { column: 'refunds.provider_refund_id', reason: PROVIDER_OBJECT },
  { column: 'refunds.provider_reversal_id', reason: PROVIDER_OBJECT },
  { column: 'disputes.provider_dispute_id', reason: PROVIDER_OBJECT },
  { column: 'disputes.provider_reversal_id', reason: PROVIDER_OBJECT },
  {
    column: 'payment_provider_events.provider_account_id',
    reason:
      "A payment provider's connected-account id. Their key space; `provider_accounts` is " +
      'what maps one to a store or an Oxy user, and it keys rows by that same id.',
  },
  {
    column: 'provider_accounts.provider_account_id',
    reason:
      "A payment provider's connected-account id — the same key space as the column above, " +
      'here as the natural key a provider event resolves through. Unique per provider and ' +
      'deliberately never a Mercaria primary key.',
  },
  {
    column: 'provider_accounts.owner_id',
    reason:
      'Polymorphic by owner_type — a store id or an Oxy account id, exactly as ' +
      'ledger_entries.owner_id is, and one of those two key spaces is not in this database ' +
      'at all. The store half is unconstrained deliberately too: a provider account outlives ' +
      'the store record it names, because money can still be owed to it.',
  },
  {
    column: 'payment_provider_events.provider_event_id',
    reason:
      "A payment provider's own event id. Their key space, and half of this table's " +
      'dedupe key — the invariant that makes a redelivered webhook a no-op.',
  },

  // ── Identifiers with no parent table at all ───────────────────────────────
  {
    column: 'payments.checkout_group_id',
    reason:
      'The same grouping token orders carry, naming the set of sibling orders one ' +
      'payment funds. There is no checkout_groups entity to point at.',
  },
  {
    column: 'orders.checkout_group_id',
    reason:
      'A grouping token shared by the sibling orders one multi-seller cart split into. ' +
      'It names a set of rows in this same table, not a row in another one — there is ' +
      'no checkout_groups entity and inventing one would add a table nothing reads.',
  },
  {
    column: 'notifications.conversation_id',
    reason:
      'An opaque conversation reference from another Oxy service, carried through so a ' +
      'client can deep-link. Nothing in Mercaria resolves it.',
  },
  {
    column: 'push_tokens.device_id',
    reason:
      'A client-supplied device identifier, not an Oxy id and not unique across users — ' +
      'it disambiguates a user’s own devices and addresses no row anywhere.',
  },
  {
    column: 'stores.tax_settings_tax_registration_id',
    reason:
      'A government-issued VAT/tax registration NUMBER, not an entity id. It matches the ' +
      '`_id` suffix by coincidence and references nothing.',
  },

  // ── Canonical commerce graph (#53, ADR 0002 D20/D25) ──────────────────────
  {
    column: 'source_records.external_id',
    reason:
      "The SOURCE's own id for the observed external object (ADR 0002 D19) — a foreign " +
      "system's key space, stored verbatim and never minted or validated by Mercaria.",
  },
  { column: 'organizations.logo_file_id', reason: OXY_FILE },
  { column: 'brands.logo_file_id', reason: OXY_FILE },
  { column: 'organization_aliases.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'brand_aliases.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'organization_source_links.decided_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'brand_source_links.decided_by_oxy_user_id', reason: OXY_ACCOUNT },

  // ── Canonical commerce graph (#54, ADR 0002) ──────────────────────────────
  { column: 'merchants.claimed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'merchant_aliases.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'merchant_domains.verified_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'merchant_source_links.decided_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'storefront_aliases.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'storefront_source_links.decided_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'native_store_links.verified_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'native_store_links.revoked_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'storefronts.external_shop_id', reason: EXTERNAL_PLATFORM },

  // ── Procurement (#118): supplier-platform ids, correlations and snapshots ─
  //
  // `suppliers.organization_id` is NOT here: it became a real `.references()`
  // when #53's `organizations` landed. The offer-side canonical mapping is in
  // DEFERRED_FOREIGN_KEYS above, waiting on #56's tables.
  { column: 'supplier_accounts.provider_account_id', reason: SUPPLIER_PLATFORM },
  { column: 'procurement_offers.supplier_external_id', reason: SUPPLIER_PLATFORM },
  { column: 'purchase_orders.supplier_external_order_id', reason: SUPPLIER_PLATFORM },
  { column: 'purchase_orders.order_id', reason: PROCUREMENT_CORRELATION },
  {
    column: 'purchase_orders.checkout_group_id',
    reason:
      'The same grouping token orders and payments carry; there is no checkout_groups ' +
      'entity to point at.',
  },
  // The PO line snapshots: frozen at creation, immutable by trigger, and the
  // targets legitimately move on (offers refresh in place, canonical entities
  // merge) — the order_items.listing_id rule.
  { column: 'purchase_order_lines.canonical_product_id', reason: COMMERCE_SNAPSHOT },
  { column: 'purchase_order_lines.canonical_variant_id', reason: COMMERCE_SNAPSHOT },
  { column: 'purchase_order_lines.procurement_offer_id', reason: COMMERCE_SNAPSHOT },
  // Oxy-owned ids on procurement rows.
  { column: 'supplier_events.by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'supplier_agreements.reviewed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'supplier_agreements.approved_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'supplier_agreement_evidence.collected_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'supplier_agreement_evidence.oxy_file_id', reason: OXY_FILE },
  { column: 'purchase_order_transitions.by_oxy_user_id', reason: OXY_ACCOUNT },
];
