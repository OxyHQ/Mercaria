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
 * ## Empty again, and how it was USED twice
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
 * `merchant_domains` column) and left this list. It happened a second time with
 * #118's `procurement_offers` canonical mapping, which waited on #56's product
 * tables and was forced into real references the moment they landed. An empty
 * deferred list is the correct end state, not an unstarted one.
 *
 * The payment domain's order and refund correlations are the entries most worth
 * reading before adding another PERMANENT one: they are permanently
 * unconstrained, and the block comment beside them says why — a reason that is
 * a property of a payment system, not of any store it happens to run on.
 */

import type { DeferredForeignKey } from '@oxyhq/db/assert';

/**
 * Relations decided but not yet expressible — each one owes a `.references()`.
 *
 * Empty again, and for the SECOND time by the mechanism working rather than by
 * nobody having used it. #118 ledgered `procurement_offers.canonical_product_id`
 * and `.canonical_variant_id` here, and #55 ledgered
 * `commerce_relationships.product_family_id`, all three while #56's
 * `canonical_products`, `canonical_variants` and `canonical_product_families`
 * were being built in parallel; the moment those tables entered the barrel the
 * gate refused every deferral, and all three became the real RESTRICT
 * references they carry today (ADR 0002 D20: canonical rows are never
 * hard-deleted, so neither an offer's mapping nor an evidence-backed claim's
 * endpoint may be orphaned silently). The PO LINE copies of the offer's two
 * columns stay permanently unconstrained below — they are snapshots, a
 * different decision about a different row.
 */
export const DEFERRED_FOREIGN_KEYS: readonly DeferredForeignKey[] = [];

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
/**
 * A curation row naming an entity whose TABLE is chosen by a sibling `*_type`
 * column (#59). ADR 0002 D16 states this reason for `catalog_revisions.entity_id`
 * and every other column carrying it shares both halves: the column spans entity
 * types, and it must survive the tombstone the very act it records creates.
 */
const CURATION_ENTITY =
  'A curated entity id whose table is selected by a sibling `*_type` column (ADR 0002 D16). ' +
  'It spans entity types and must stay readable after the merge it records tombstones its ' +
  'subject; the alternative is one nullable foreign key per entity kind on a row that names ' +
  'exactly one of them.';

const SUPPLIER_PLATFORM =
  "A supplier platform's own id — a foreign system's key space, stored for correlation " +
  'and deliberately never a Mercaria primary key.';

/**
 * An APPEND-ONLY audit row naming something whose disappearance must not erase
 * the history of what happened to it (#104).
 *
 * `cart_merges` is the case: the guest session it names is hard-deleted by the
 * retention sweep 7 days after the very revocation the merge performed (ADR
 * 0003 D11), and the cart it names is a live row a cascade could take with it.
 * A foreign key here would make the audit trail a function of whether its
 * subjects still exist, which is exactly backwards — the same reasoning that
 * keeps `order_status_history.actor_guest_session_id` correlation text (D16).
 */
const AUDIT_CORRELATION =
  'An append-only audit row naming a record it must outlive. Its subject is purged on ' +
  'retention or deletable by cascade, and the history of what happened must survive it.';

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
 * An entity a TELEMETRY row observed (#77).
 *
 * The direction of the argument is the opposite of every other reason above,
 * which is why it needs its own: the others say "the target may vanish and this
 * record must survive it". This one also says "this record must never be able
 * to stop the target vanishing". Telemetry that could block a listing delete —
 * or whose own retention sweep could cascade INTO the catalogue — would have
 * made analytics a constraint on commerce, which is the same boundary
 * `services/analytics/sink.ts` enforces at runtime.
 */
const ANALYTICS_CORRELATION =
  'An entity a telemetry row observed. Analytics is swept on its own retention clock and ' +
  'must neither block a commerce delete nor cascade into one.';

/**
 * `*_id` columns that will NEVER carry a constraint, named `table.column` by
 * their SQL names (never the TypeScript property — an `endsWith('_id')` test
 * against `sellerId` matches nothing and passes vacuously).
 */
export const ID_COLUMNS_WITHOUT_FOREIGN_KEY: readonly { column: string; reason: string }[] = [
  // ── Oxy account ids ───────────────────────────────────────────────────────
  { column: 'abuse_reports.reporter_oxy_user_id', reason: OXY_ACCOUNT },
  // #66's three operator stamps. Oxy ids like every other row in this block,
  // and two of them sit on APPEND-ONLY tables whose whole purpose is to answer
  // "who decided this" — an actor column that could be erased with the account
  // answers it with a NULL.
  { column: 'awin_accounts.state_changed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'awin_advertisers.activation_changed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'awin_link_samples.taken_by_oxy_user_id', reason: OXY_ACCOUNT },
  // #66's activation evidence pointer. The natural constraint is CIRCULAR —
  // `awin_link_samples.advertiser_row_id` references `awin_advertisers` back —
  // which Postgres permits, broken by write order. It was written as a real
  // `references((): AnyPgColumn => …)` and `drizzle-kit generate` SILENTLY
  // DROPPED it: absent from the emitted SQL and absent from the snapshot, so
  // the declaration type-checked, enforced nothing, and left a later
  // generation free to emit it out of nowhere. A constraint that exists in the
  // editor and not in the database is worse than one that exists in neither.
  // `awin_advertisers_activation_sample_check` is what enforces the citation.
  {
    column: 'awin_advertisers.activating_sample_id',
    reason:
      'A circular reference drizzle-kit silently omits from both the migration and the ' +
      'snapshot. The CHECK enforces that an active advertiser cites a sample.',
  },
  { column: 'addresses.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'cart_merges.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'carts.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'customers.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'draft_orders.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'fee_schedule_acceptances.accepted_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'fee_schedules.approved_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'fee_schedules.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'favorites.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'feedback.oxy_user_id', reason: OXY_ACCOUNT },
  // The #104/#109 conversion audit stamp. An Oxy id like every other row in
  // this block — and doubly unconstrained on purpose: the session row is
  // purged on retention (ADR 0003 D11) while the Oxy account lives on, and the
  // Oxy account can be deleted while the audit stamp must survive as inert
  // correlation text (D15, diagram 11).
  { column: 'guest_sessions.converted_to_oxy_user_id', reason: OXY_ACCOUNT },
  // #108's suppression lift and operator audit. Oxy ids like every other row in
  // this block; both must survive the account being deleted, because an audit
  // whose actor column could be erased answers "who did this" with a NULL.
  { column: 'guest_contact_suppressions.lifted_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'guest_portal_operator_actions.actor_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'listings.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'notifications.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'order_status_history.by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'orders.buyer_oxy_user_id', reason: OXY_ACCOUNT },
  // #109's claim stamp. An Oxy id like every other row in this block, and
  // doubly unconstrained for the reason `guest_sessions.converted_to_oxy_user_id`
  // is: the Oxy account can be deleted while the claim must survive as inert
  // correlation text on an immutable commercial record (ADR 0003 D15,
  // diagram 11).
  { column: 'orders.claimed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'orders.seller_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'payments.buyer_oxy_user_id', reason: OXY_ACCOUNT },
  // #80's canonical product save. An Oxy id like every other row in this block;
  // it is also the WHOLE of what this domain stores about a person, which is
  // what makes #80 privacy rule 5 ("delete or anonymize") resolve to a single
  // scoped DELETE rather than an anonymization pass over copied profile fields.
  { column: 'product_saves.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'push_tokens.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'refunds.processed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'refunds.seller_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'reviews.author_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'reviews.seller_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'review_eligibilities.oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'review_eligibilities.seller_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'review_aggregates.seller_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'review_target_migrations.actor_oxy_user_id', reason: OXY_ACCOUNT },
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
  // #66: Awin's own publisher, advertiser and feed ids. A foreign system's key
  // space in the fullest sense — Mercaria neither mints nor validates them, and
  // an advertiser id is stable only for as long as Awin says it is.
  { column: 'awin_accounts.publisher_id', reason: EXTERNAL_PLATFORM },
  { column: 'awin_advertisers.advertiser_id', reason: EXTERNAL_PLATFORM },
  { column: 'awin_feeds.feed_id', reason: EXTERNAL_PLATFORM },
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

  // ── Append-only audit correlations ────────────────────────────────────────
  { column: 'cart_merges.guest_session_id', reason: AUDIT_CORRELATION },
  { column: 'cart_merges.target_cart_id', reason: AUDIT_CORRELATION },
  // ADR 0003 D16's guest actor in the lifecycle trail — the case the
  // AUDIT_CORRELATION reason above was written for. The trail must outlive the
  // credential it names without extending its life, which a cascade (erase the
  // audit) and a restrict (block the purge) each break in opposite directions.
  { column: 'order_status_history.actor_guest_session_id', reason: AUDIT_CORRELATION },
  {
    column: 'guest_checkouts.guest_session_id',
    reason:
      'The session that placed a guest checkout. A real foreign key here would be exactly ' +
      'backwards: the session is HARD-DELETED by the retention sweep 7 days after it expires ' +
      '(ADR 0003 D11) while the checkout is retained with its orders for the statutory ' +
      'commercial window, so a cascade would erase a commercial record and a restrict would ' +
      'block the purge the retention policy requires. Surviving the credential is the whole ' +
      'reason this table exists (D4) — the paid path correlates through checkout_group_id and ' +
      'never reads guest_sessions at all (ADR 0006 G9).',
  },
  {
    column: 'guest_checkouts.checkout_group_id',
    reason:
      'The same grouping token orders, payments and purchase orders carry; there is no ' +
      'checkout_groups table to reference. Its uniqueness here is what makes one contact ' +
      'identity per group structural (ADR 0003 D4).',
  },
  {
    column: 'guest_order_access_grants.checkout_group_id',
    reason:
      'The SCOPE of a portal credential, and the same grouping token as above — there is no ' +
      'checkout_groups table to reference (#108). The referential guarantee this domain ' +
      'actually needs is on guest_checkout_id, which IS a real foreign key: a grant always ' +
      'has a contact record, and the group it names is that record’s own unique key.',
  },
  {
    column: 'guest_portal_messages.checkout_group_id',
    reason:
      'The group a transactional message is about; the same token, the same absent table. ' +
      'The message’s referential anchor is guest_checkout_id, a real foreign key.',
  },
  {
    column: 'guest_portal_messages.order_id',
    reason:
      'Which sibling seller order a message is about, NULL for group-level messages (#108). ' +
      'Correlation rather than a constraint: the message is an audit of what Mercaria said, ' +
      'and it must survive whatever happens to the order afterwards — a cascade would erase ' +
      'the record that a cancellation notice was sent.',
  },
  {
    column: 'guest_portal_operator_actions.checkout_group_id',
    reason:
      'The group an operator acted on (#108 recovery rule 8). Append-only audit correlation ' +
      'in the payment_repairs shape: the record of what staff did on a buyer’s behalf must ' +
      'outlive every row it refers to, so no referential action may reach it.',
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
    column: 'fee_schedule_acceptances.owner_id',
    reason:
      'Polymorphic by owner_type — a store id or an Oxy account id, exactly as ' +
      'provider_accounts.owner_id is, and one of those two key spaces is not in this ' +
      'database at all.',
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

  // ── Canonical commerce graph (#55, ADR 0002 D17) ──────────────────────────
  //
  // Every ENTITY endpoint on `commerce_relationships` is a real `.references()`,
  // `product_family_id` included since #56 landed the families table. What
  // remains here is the actor trail — the people a verdict names — which is
  // Oxy's key space in every row.
  { column: 'commerce_relationships.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'commerce_relationships.verified_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'commerce_relationships.revoked_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'relationship_evidence.collected_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'relationship_evidence.revoked_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'relationship_evidence.oxy_file_id', reason: OXY_FILE },
  { column: 'relationship_reviews.actor_oxy_user_id', reason: OXY_ACCOUNT },

  // ── Canonical commerce graph (#56, ADR 0002 D13–D16) ─────────────────────
  //
  // Every OTHER id-shaped column in `canonicalCatalog.ts` is a real foreign
  // key, the polymorphic grains included: `canonical_images`,
  // `canonical_attribute_values` and `canonical_field_provenance` each carry
  // nullable entity references plus a CHECK that exactly one is set, because
  // every endpoint's key space lives in THIS database (ADR 0002 D17's
  // reasoning). What is left is Oxy's key space and Oxy's alone.
  { column: 'canonical_images.file_id', reason: OXY_FILE },
  { column: 'canonical_product_family_aliases.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'canonical_product_family_source_links.decided_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'canonical_product_family_redirects.actor_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'canonical_product_aliases.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'canonical_product_source_links.decided_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'canonical_product_redirects.actor_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'canonical_variant_aliases.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'canonical_variant_source_links.decided_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'canonical_field_provenance.decided_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'product_identifiers.assigned_by_oxy_user_id', reason: OXY_ACCOUNT },
  // ── Merchant claiming (#83) ───────────────────────────────────────────────
  //
  // `merchant_claims.merchant_id`, `.native_store_id` and `.conflicting_claim_id`
  // are all REAL references and are deliberately absent from this list. What is
  // here is the two kinds this schema can never constrain: an Oxy account, and
  // a polymorphic scope reference that names one of three different tables.
  { column: 'merchant_claims.claimant_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'merchant_claims.reviewed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'merchant_claims.revoked_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'merchant_claim_evidence.oxy_file_id', reason: OXY_FILE },
  { column: 'merchant_claim_evidence.collected_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'merchant_claim_events.actor_oxy_user_id', reason: OXY_ACCOUNT },

  // ── Review scopes (#76) ───────────────────────────────────────────────────
  //
  // Every review, eligibility and aggregate target is a REAL reference
  // (`canonical_products`, `merchants`, `order_items`, `listings`, `stores`) and
  // is deliberately absent from this list. What is here is the Oxy ids above
  // plus these two, and neither is a deferral:
  {
    column: 'review_eligibilities.claim_id',
    reason:
      'The #109 guest-order claim that moved a purchase into an Oxy account. Recorded as a ' +
      'SEAM: `guest_order_claims` does not exist yet, and until it does the only writer of ' +
      'this column refuses to run, so no row can carry a value. When #109 lands, this entry ' +
      'moves to DEFERRED_FOREIGN_KEYS and then to a real .references() — it is here rather ' +
      'than there because the deferred gate fires on a table NAME appearing in the schema and ' +
      'nothing has been designed for it to fire on yet.',
  },
  {
    column: 'review_target_migrations.from_target_ref',
    reason:
      'The target a review pointed at BEFORE a scope decision. It spans six target key ' +
      'spaces and must survive a canonical tombstone, so it can name no one table — the ' +
      'catalog_revisions.entity_id reasoning, in an append-only audit row.',
  },
  {
    column: 'review_target_migrations.to_target_ref',
    reason:
      'The target a review points at AFTER a scope decision — the same six key spaces, the ' +
      'same append-only audit row, the same reason.',
  },

  // ── Procurement (#118): supplier-platform ids, correlations and snapshots ─
  //
  // `suppliers.organization_id` is NOT here: it became a real `.references()`
  // when #53's `organizations` landed. Neither is the offer-side canonical
  // mapping: it became one when #56's tables landed, the same way.
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

  // ── Retail pricing (#120, ADR 0004 D3) ────────────────────────────────────
  //
  // The supplier, account, agreement and policy VERSION a quote was composed
  // under are all real RESTRICT foreign keys and are deliberately NOT here —
  // an unattributable cost quote is not evidence. What is here is the same
  // three classes procurement already ledgers: catalogue snapshots whose
  // targets legitimately move on, a grouping token with no parent entity, and
  // a commerce correlation the financial record must outlive.
  // #123's retail checkout. Three classes and no fourth: two Oxy operator ids,
  // one grouping token, and the catalogue snapshots a frozen intent line
  // carries. Everything a purchase order is COMPOSED from — the supplier, the
  // account, the agreement, the binding, the acceptance and the quote — is a
  // real RESTRICT foreign key and is deliberately absent from this list: an
  // intent whose supply side cannot be reached is not a promise anybody can
  // audit.
  { column: 'retail_offer_bindings.bound_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_offer_bindings.retired_by_oxy_user_id', reason: OXY_ACCOUNT },
  {
    column: 'retail_procurement_intents.checkout_group_id',
    reason:
      'The same grouping token orders, payments and purchase orders carry; there is no ' +
      'checkout_groups entity to point at. It is restated here so a procurement trace can ' +
      'open from a group without joining orders.',
  },
  { column: 'retail_procurement_intent_lines.canonical_product_id', reason: COMMERCE_SNAPSHOT },
  { column: 'retail_procurement_intent_lines.canonical_variant_id', reason: COMMERCE_SNAPSHOT },
  { column: 'retail_cost_quotes.procurement_offer_id', reason: COMMERCE_SNAPSHOT },
  { column: 'retail_cost_quotes.canonical_product_id', reason: COMMERCE_SNAPSHOT },
  { column: 'retail_cost_quotes.canonical_variant_id', reason: COMMERCE_SNAPSHOT },
  {
    column: 'retail_cost_quote_acceptances.checkout_group_id',
    reason:
      'The same grouping token orders, payments and purchase orders carry; there is no ' +
      'checkout_groups entity to point at.',
  },
  {
    column: 'retail_cost_quote_acceptances.order_id',
    reason:
      'The checkout lock is taken BEFORE the retail order row exists (ADR 0004 D4 step 1 ' +
      'freezes the snapshot, then creates the order), and the accepted amount must stay ' +
      'readable whether or not that order is reachable — the PAYMENT_CORRELATION rule, ' +
      'one domain over.',
  },
  { column: 'retail_cost_quote_acceptances.accepted_by_oxy_user_id', reason: OXY_ACCOUNT },
  {
    column: 'retail_cost_quote_acceptances.accepted_guest_session_id',
    reason:
      'An opaque #103 guest-session ref. The session row is PURGED on its own retention ' +
      'clock (ADR 0003 D11) while this financial record is retained, so a constraint would ' +
      'either block the purge or destroy the acceptance — correlation text, deliberately.',
  },
  { column: 'retail_pricing_policies.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_pricing_policies.approved_by_oxy_user_id', reason: OXY_ACCOUNT },

  // ── Retail eligibility (#121, ADR 0004 D2.8–D2.10) ────────────────────────
  //
  // The policy VERSION a decision was made under is a real, NOT NULL COMPOSITE
  // foreign key and is deliberately not here: an uncited decision would not be
  // reproducible, which is the whole of acceptance 7. What IS here is the same
  // three classes the two domains above already ledger — Oxy account ids, an
  // Oxy media file id, and snapshots whose targets legitimately move on.
  { column: 'retail_eligibility_policies.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_eligibility_policies.approved_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_category_rules.recorded_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_market_capabilities.recorded_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_resale_evidence.oxy_file_id', reason: OXY_FILE },
  { column: 'retail_resale_evidence.recorded_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_resale_evidence.verified_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_resale_evidence.revoked_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_compliance_evidence.oxy_file_id', reason: OXY_FILE },
  { column: 'retail_compliance_evidence.recorded_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_compliance_evidence.verified_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_compliance_evidence.revoked_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_suppressions.raised_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_suppressions.lifted_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_eligibility_exceptions.requested_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_eligibility_exceptions.approved_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_eligibility_exceptions.second_approved_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_eligibility_exceptions.rejected_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_eligibility_exceptions.revoked_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'retail_eligibility_decisions.procurement_offer_id', reason: COMMERCE_SNAPSHOT },
  { column: 'retail_eligibility_decisions.canonical_variant_id', reason: COMMERCE_SNAPSHOT },
  { column: 'retail_eligibility_audits.subject_id', reason: AUDIT_CORRELATION },
  { column: 'retail_eligibility_audits.actor_oxy_user_id', reason: OXY_ACCOUNT },

  // ── Supplier preflight (#122, ADR 0004 D4 step 1 / D5 / D9.3) ─────────────
  //
  // The supplier, account and sourcing policy VERSION an answer was taken from
  // are real RESTRICT foreign keys and are deliberately not here — an
  // unattributable supplier answer is not evidence, the `retail_cost_quotes`
  // reasoning one domain over. What is here is the same four classes the three
  // domains above already ledger: catalogue snapshots whose targets legitimately
  // move on, grouping tokens with no parent entity, commerce correlations the
  // evidence must outlive, and a supplier platform's own key space.
  { column: 'supplier_quotes.procurement_offer_id', reason: COMMERCE_SNAPSHOT },
  { column: 'supplier_quotes.canonical_product_id', reason: COMMERCE_SNAPSHOT },
  { column: 'supplier_quotes.canonical_variant_id', reason: COMMERCE_SNAPSHOT },
  {
    column: 'supplier_quotes.checkout_group_id',
    reason:
      'The same grouping token orders, payments, purchase orders and cost-quote ' +
      'acceptances carry; there is no checkout_groups entity to point at.',
  },
  {
    column: 'supplier_quotes.consumed_by_checkout_group_id',
    reason:
      'The checkout that actually spent this quote — the same grouping token as the ' +
      'column above, recorded separately because "which checkout asked" and "which ' +
      'checkout consumed" are different facts and collapsing them would let a quote ' +
      'attach to a second checkout (#122 concurrency 3).',
  },
  { column: 'supplier_quotes.order_id', reason: PROCUREMENT_CORRELATION },
  { column: 'supplier_reservations.procurement_offer_id', reason: COMMERCE_SNAPSHOT },
  { column: 'supplier_reservations.provider_reservation_id', reason: SUPPLIER_PLATFORM },
  {
    column: 'supplier_reservations.consumed_by_checkout_group_id',
    reason:
      'The same grouping token as supplier_quotes.consumed_by_checkout_group_id; there ' +
      'is no checkout_groups entity to point at.',
  },
  { column: 'supplier_reservations.consumed_order_id', reason: PROCUREMENT_CORRELATION },
  { column: 'supplier_sourcing_attempts.procurement_offer_id', reason: COMMERCE_SNAPSHOT },
  {
    column: 'supplier_sourcing_attempts.checkout_group_id',
    reason:
      'The same grouping token orders, payments and purchase orders carry; there is no ' +
      'checkout_groups entity to point at.',
  },
  { column: 'supplier_sourcing_policies.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'supplier_sourcing_policies.approved_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'supplier_preflight_suppressions.raised_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'supplier_preflight_suppressions.lifted_by_oxy_user_id', reason: OXY_ACCOUNT },

  // ── The supplier ORDER orchestration (#124) ───────────────────────────────
  // Every entry below is a SUPPLIER PLATFORM's own key or an Oxy account id.
  // There is deliberately not one deferred relation among them: this domain
  // hangs entirely off tables that already exist, and the only ids it stores
  // that are not Mercaria's are ids Mercaria could never constrain.
  { column: 'supplier_order_attempts.provider_object_id', reason: SUPPLIER_PLATFORM },
  { column: 'supplier_provider_events.provider_event_id', reason: SUPPLIER_PLATFORM },
  { column: 'supplier_provider_events.provider_order_id', reason: SUPPLIER_PLATFORM },
  { column: 'purchase_order_documents.provider_document_id', reason: SUPPLIER_PLATFORM },
  {
    column: 'purchase_order_documents.related_provider_document_id',
    reason:
      "The invoice a credit note reverses, by the SUPPLIER's own document id — their key " +
      'space, and deliberately not a foreign key onto this same table: a credit note can ' +
      'legitimately name an invoice Mercaria never retrieved.',
  },
  { column: 'procurement_exceptions.resolved_by_oxy_user_id', reason: OXY_ACCOUNT },

  // ── Referral domain (#142, ADR 0005) ──────────────────────────────────────
  { column: 'referral_programs.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'referral_programs.approved_by_oxy_user_id', reason: OXY_ACCOUNT },
  {
    column: 'referral_programs.program_id',
    reason:
      'The stable program identity shared by that program’s version rows. It names a set ' +
      'of rows in this same table, not a row in another one — the checkout_group_id shape; ' +
      'there is no programs parent entity and inventing one would add a table nothing reads.',
  },
  {
    column: 'referral_partners.owner_id',
    reason:
      'Polymorphic by owner_type — a store id or an Oxy account id, exactly as ' +
      'provider_accounts.owner_id is, and one of those two key spaces is not in this ' +
      'database at all (ADR 0005 D2 mirrors the provider_accounts owner shape deliberately).',
  },
  { column: 'referral_touches.oxy_user_id', reason: OXY_ACCOUNT },
  {
    column: 'referral_attributions.program_id',
    reason:
      'The same stable program identity referral_programs.program_id carries, denormalized ' +
      'onto the attribution because it is half of the winner-cardinality unique index — the ' +
      'exact version row is referenced separately through program_version_id, which IS ' +
      'constrained.',
  },
  {
    column: 'referral_attributions.winning_touch_id',
    reason:
      'Correlation into the separately-retained touch evidence store. Touch rows are swept ' +
      'on their own retention (issue #142, migration/scale 6; ADR 0005 D6), so a constraint ' +
      'here would either block the sweep or delete earned attributions with their evidence — ' +
      'the attribution snapshots the facts it was decided on into its own columns instead.',
  },
  {
    column: 'referral_events.subject_id',
    reason: 'Polymorphic by subject_type, exactly as moderation_enforcements.subject_id is.',
  },
  {
    column: 'referral_conversions.source_event_id',
    reason:
      'The durable event WITHIN a source aggregate a conversion was derived from — the ' +
      'aggregate’s own event key space, the payment_provider_events.provider_event_id shape. ' +
      'Half of the one-source-one-conversion unique key and the input to the idempotency key.',
  },

  // ── Offers (#57, ADR 0002 D18) ────────────────────────────────────────────
  {
    column: 'offers.external_offer_id',
    reason:
      'The SOURCE platform’s own id for this offer — a foreign system’s key space, and a ' +
      'component of the idempotent source mapping (issue #57 index 1). It is deliberately ' +
      'NOT a reference to source_records.external_id: that names one OBSERVATION, while this ' +
      'names the thing observed across observations, which is what an upsert has to key on ' +
      'before it has minted a record for the new one.',
  },
  {
    column: 'native_listing_links.decided_by_oxy_user_id',
    reason: OXY_ACCOUNT,
  },
  {
    column: 'native_listing_links.revoked_by_oxy_user_id',
    reason: OXY_ACCOUNT,
  },

  // The attribute registry (#94).
  { column: 'attribute_definitions.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'attribute_definitions.published_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'attribute_source_mappings.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'attribute_value_reviews.resolved_by_oxy_user_id', reason: OXY_ACCOUNT },
  {
    column: 'attribute_value_reviews.entity_id',
    reason:
      'Polymorphic by entity_kind — a canonical product or a canonical variant, the ' +
      'merchant_claim_scopes.scope_ref shape. One column cannot reference two tables, and ' +
      'the alternative (two nullable columns plus a CHECK) buys a constraint on rows whose ' +
      'targets are never hard-deleted: a merged canonical entity keeps its row as a ' +
      'tombstone (ADR 0002 D12), so the reference always resolves.',
  },
  {
    column: 'attribute_value_reviews.resolved_value_id',
    reason:
      'The canonical_attribute_values row an operator chose, recorded as the DECISION they ' +
      'made rather than as a live pointer. A cascade from the value would erase the record ' +
      'of what was decided when the losing value was later corrected away, and a RESTRICT ' +
      'would block a legitimate correction on a closed review — the ' +
      'referral_attributions.winning_touch_id reasoning.',
  },
  {
    column: 'attribute_reindex_requests.entity_id',
    reason:
      'Polymorphic by entity_kind, exactly as attribute_value_reviews.entity_id is. The row ' +
      'is also a JOB rather than a relationship: it must survive whatever happens to the ' +
      'entity between enqueue and drain, because "this id no longer exists" is a valid and ' +
      'useful thing for a re-index consumer to be told.',
  },
  // ── Merchant → native store linkage (#84, ADR 0002 D4) ────────────────────
  //
  // Every ENTITY reference in this domain is a real `.references()`: the
  // merchant, the authorizing claim, both store sides, the `native_store_links`
  // rows a request produces and supersedes, the canonical variant an overlap is
  // about, and both offers it names. What remains is the actor trail — three
  // Oxy account ids and the opaque worker identity that holds an application
  // lease, which belongs to no table at all.
  { column: 'store_linkage_requests.claimant_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'store_linkage_requests.decided_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'store_linkage_profile_adoptions.actor_oxy_user_id', reason: OXY_ACCOUNT },
  // ── Deterministic matching (#58, ADR 0002 D14/D19) ────────────────────────
  { column: 'match_policy_versions.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'match_benchmark_runs.started_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'match_category_gates.enabled_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'match_category_gates.disabled_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'match_decisions.reviewed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'match_blocked_pairs.blocked_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'match_blocked_pairs.cleared_by_oxy_user_id', reason: OXY_ACCOUNT },

  // ── The condition domain (#90) ────────────────────────────────────────────
  // `listing_condition_photos.file_id` is the ONE of these that is load-bearing
  // rather than ordinary: it carries no foreign key for the usual Oxy-media
  // reason, and `mercaria_reject_canonical_condition_photo` nonetheless refuses
  // any value `canonical_images` already claims. A trigger rather than a
  // constraint because the rule is "this id must NOT appear over there", which
  // no foreign key can express.
  { column: 'listing_condition_photos.file_id', reason: OXY_FILE },
  { column: 'listing_condition_photos.uploaded_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'listing_condition_revisions.actor_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'condition_mapping_rulesets.published_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'condition_category_policies.created_by_oxy_user_id', reason: OXY_ACCOUNT },

  // ── Discovery analytics (#77) ─────────────────────────────────────────────
  //
  // EVERY id column in this domain is unconstrained, and that is one decision
  // rather than fifteen omissions. Telemetry must never be able to block a
  // commerce delete, and the sweep must never be able to cascade into one:
  // these rows are swept on their own retention clock, and every entity they
  // name outlives them. A foreign key would invert both properties — a listing
  // that could not be removed because an impression referenced it, or an
  // analytics retention sweep whose cascade reached the catalogue.
  //
  // The three identity-shaped ones carry an additional, different reason and
  // are spelled out individually below, because "no FK" is the least
  // interesting thing about them.
  {
    column: 'analytics_events.oxy_user_id',
    reason: OXY_ACCOUNT,
  },
  {
    column: 'analytics_events.pseudonymous_session_id',
    reason:
      'NOT an id at all in the sense this ledger means: it is a one-way sha-256 of a session ' +
      'handle under a rotating server salt, and the row it "names" is deliberately ' +
      'unrecoverable — the salt is DELETED 45 days in (db/expiryTargets.ts), after which ' +
      'nobody including Mercaria can map it back to anything. A foreign key would require ' +
      'exactly the reversible mapping the derivation exists to destroy.',
  },
  {
    column: 'analytics_events.query_event_id',
    reason:
      'The correlation handle joining a click, an impression or an add-to-cart back to the ' +
      'search that produced it. It names an `analytics_search_queries` row, which is swept on ' +
      'a DIFFERENT retention clock (a query record outlives the discovery events derived from ' +
      'it), so a constraint would make one sweep’s success depend on the other’s order.',
  },
  {
    column: 'analytics_events.checkout_group_id',
    reason:
      'The RESTRICTED commerce correlation (#77 envelope field 5), admitted by CHECK on only ' +
      'the event types at or after checkout begins. Unconstrained for the reason every ' +
      'payment↔commerce link in this schema is: the checkout group is a grouping TOKEN, not a ' +
      'row, and analytics is retained far more briefly than the orders it correlates to.',
  },
  { column: 'analytics_events.order_id', reason: ANALYTICS_CORRELATION },
  { column: 'analytics_events.listing_id', reason: ANALYTICS_CORRELATION },
  { column: 'analytics_events.product_variant_id', reason: ANALYTICS_CORRELATION },
  { column: 'analytics_events.canonical_product_id', reason: ANALYTICS_CORRELATION },
  { column: 'analytics_events.canonical_variant_id', reason: ANALYTICS_CORRELATION },
  { column: 'analytics_events.offer_id', reason: ANALYTICS_CORRELATION },
  { column: 'analytics_events.merchant_id', reason: ANALYTICS_CORRELATION },
  { column: 'analytics_events.storefront_id', reason: ANALYTICS_CORRELATION },
  {
    column: 'analytics_events.category_id',
    reason:
      'A category slug or id exactly as the surface addressed it — which is the point: the ' +
      'analytics record must say what the shopper actually used, including a slug that has ' +
      'since been retired, and a foreign key would forbid recording it.',
  },
  { column: 'analytics_events.store_id', reason: ANALYTICS_CORRELATION },
  {
    column: 'analytics_search_queries.query_event_id',
    reason:
      'The other end of the correlation above. Unique here (one record per search) and ' +
      'unconstrained for the same independent-retention reason.',
  },
  { column: 'analytics_search_queries.category_id', reason: ANALYTICS_CORRELATION },
  { column: 'analytics_rollups.store_id', reason: ANALYTICS_CORRELATION },
  { column: 'analytics_rollups.merchant_id', reason: ANALYTICS_CORRELATION },

  // ── The native-catalogue backfill (#60, ADR 0002 D23) ──────────────────────
  //
  // Three columns, one reason with two independent halves, and both halves are
  // the reason `catalog_revisions.entity_id` carries no key either (D20).
  //
  // (a) They SPAN key spaces. One `subject_key`/`subject_kind` pair addresses a
  //     store, a listing, a native variant, a canonical product, a native offer
  //     — or a `vendor_value`, which is a normalized brand-candidate STRING and
  //     not a row anywhere at all. No single foreign key can be written.
  // (b) Migration evidence must OUTLIVE its subject. Issue #60 job behaviour 7
  //     is explicit that a rollback disables reads and offer publication without
  //     deleting evidence, and a CASCADE from `listings` would delete the audit
  //     of what the migration did to a listing at the moment somebody deleted
  //     the listing — which is exactly when the audit matters.
  //
  // Note the CANONICAL columns on the same table are NOT here: they name rows in
  // this database that D20 says are never hard-deleted, so they carry real
  // `.references()` with RESTRICT, the audit-row rule.
  { column: 'catalog_backfill_runs.requested_by_oxy_user_id', reason: OXY_ACCOUNT },
  {
    column: 'catalog_backfill_records.subject_key',
    reason:
      'Spans stores, listings, native variants, canonical products, native offers and vendor ' +
      'STRINGS, so no single foreign key exists to write — and migration evidence has to ' +
      'survive the deletion of the row it describes (#60 job behaviour 7). The ' +
      '`catalog_revisions.entity_id` decision, for both of its reasons at once.',
  },
  {
    column: 'catalog_consistency_findings.subject_key',
    reason:
      'The same spanning key space as `catalog_backfill_records.subject_key`, plus the reason a ' +
      'finding exists at all: it records that a subject and its offer DISAGREE, which includes ' +
      'the case where one of the two is already gone.',
  },
  // ── Catalog curation (#59, ADR 0002 D12/D16) ──────────────────────────────
  //
  // Six columns, ONE reason, and the ADR states it for the first of them:
  // `catalog_revisions.entity_id` "deliberately has no FK (it spans entity
  // types and must survive tombstones)". The other five share both halves of
  // that reason exactly — each names a row in one of seven to thirteen tables
  // chosen by a sibling `*_type` column, and each must stay readable after the
  // very merge it records has stamped its subject a tombstone.
  //
  // What the absence gives up is bounded and closed elsewhere: ADR 0002 D20
  // makes every canonical entity RESTRICT-protected from hard deletion by its
  // own children, so a curation row naming an entity that VANISHED is not a
  // state this database can reach — the entity would still be there, merged.
  { column: 'catalog_revisions.entity_id', reason: CURATION_ENTITY },
  { column: 'catalog_review_items.subject_id', reason: CURATION_ENTITY },
  { column: 'catalog_review_items.counterpart_id', reason: CURATION_ENTITY },
  { column: 'catalog_merge_jobs.loser_id', reason: CURATION_ENTITY },
  { column: 'catalog_merge_jobs.winner_id', reason: CURATION_ENTITY },
  { column: 'catalog_split_jobs.source_entity_id', reason: CURATION_ENTITY },
  { column: 'catalog_split_jobs.target_entity_id', reason: CURATION_ENTITY },
  { column: 'catalog_entity_suppressions.entity_id', reason: CURATION_ENTITY },
  { column: 'catalog_revisions.actor_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_review_items.assigned_to_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_review_items.resolved_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_merge_jobs.requested_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_merge_jobs.approved_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_merge_conflicts.resolved_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_split_jobs.requested_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_split_jobs.approved_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_entity_suppressions.suppressed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_entity_suppressions.lifted_by_oxy_user_id', reason: OXY_ACCOUNT },

  // ── The external ingestion framework (#62) ────────────────────────────────
  //
  // Three Oxy accounts and two FOREIGN key spaces. The Oxy ones are the usual
  // reason; the two `external_id` columns are the interesting pair, because they
  // are the identity of an object in somebody ELSE's system, which is the one
  // thing a Mercaria foreign key can never point at.
  { column: 'catalog_source_configs.status_changed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_source_policies.reviewed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_source_runs.requested_by_oxy_user_id', reason: OXY_ACCOUNT },
  {
    column: 'catalog_source_objects.external_id',
    reason:
      "A source's OWN id for an object it publishes — a foreign system's primary key, in a key " +
      'space Mercaria neither defines nor controls. `(source_id, external_type, external_id)` is ' +
      'the identity this domain converges on (#62 concurrency 1), and the only Mercaria row it ' +
      'could reference is the one it identifies.',
  },
  {
    column: 'catalog_source_rejections.external_id',
    reason:
      'The same foreign key space as `catalog_source_objects.external_id`, plus the reason a ' +
      'rejection is recorded at all: the record was REFUSED, so there is no object row for it to ' +
      'reference — and for `missing_external_id` the column is legitimately NULL, because the ' +
      'record had none.',
  },

  // ── #68, offer freshness and catalogue health ─────────────────────────────
  //
  // Three Oxy accounts and nothing else. Every other id in the domain is a real
  // foreign key — a freshness policy names its source, a refresh task names its
  // source and (optionally) its offer, a quarantine names its run.
  { column: 'catalog_source_freshness_policies.reviewed_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'offer_refresh_tasks.requested_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'catalog_source_run_quarantines.resolved_by_oxy_user_id', reason: OXY_ACCOUNT },

  // ── The universal product-feed importer (#63) ─────────────────────────────
  //
  // Five Oxy accounts and one FOREIGN key space — the same split #62 has, and
  // for the same reasons.
  { column: 'feed_configurations.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'feed_configuration_versions.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'feed_configuration_versions.activated_by_oxy_user_id', reason: OXY_ACCOUNT },
  { column: 'feed_uploads.uploaded_by_oxy_user_id', reason: OXY_ACCOUNT },
  {
    column: 'feed_import_reports.requested_by_oxy_user_id',
    reason:
      OXY_ACCOUNT +
      ' A scheduled import additionally records the literal `system:feed-import`, because no ' +
      'Oxy account asked for it and attributing one would be a false audit trail.',
  },
  {
    column: 'feed_import_report_entries.external_id',
    reason:
      'The same foreign key space as `catalog_source_objects.external_id`, and one step further ' +
      'from a Mercaria row: the record was REFUSED before it ever became an observation, so ' +
      'there is nothing to reference. It is NULL whenever the refusal happened before the ' +
      'external id could be derived, which is the `missing_required_field` case on a key column.',
  },

  // ── The eBay Browse catalog source (#65) ─────────────────────────────────
  {
    column: 'marketplace_seller_identities.external_seller_id',
    reason:
      "A MARKETPLACE's own id for one selling account — `seller.username` on eBay. It is the " +
      'foreign half of the identity this table exists to hold, and the Mercaria half is the ' +
      '`merchant_id` beside it, which DOES carry a real foreign key. Pointing this column at ' +
      'anything in Mercaria would make it a second spelling of that one.',
  },
  {
    column: 'ebay_discovery_queries.marketplace_id',
    reason:
      "eBay's own marketplace identifier (`EBAY_ES`), not a Mercaria row. It is CHECK-constrained " +
      'against `EBAY_MARKETPLACE_IDS`, which is the closed tuple every member of costs a rights ' +
      'review — a table of marketplaces would be a second, editable answer to what that tuple ' +
      'already states.',
  },
  { column: 'ebay_discovery_queries.created_by_oxy_user_id', reason: OXY_ACCOUNT },
  {
    column: 'ebay_reconciliation_samples.external_id',
    reason:
      'The same foreign key space as `catalog_source_objects.external_id`, plus the reason a ' +
      'reconciliation sample exists at all: a `vanished` finding is precisely the case where the ' +
      'item is gone from the provider, and a `retired` object may later be swept — so a foreign ' +
      'key would make the evidence deletable by the thing it is evidence about.',
  },
];
