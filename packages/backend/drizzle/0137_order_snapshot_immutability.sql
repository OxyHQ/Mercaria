-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Epic #367 line 75 — "Keep historical order/payment/refund snapshots
-- immutable", the ORDER half. #868 (`0135`) closed the payment and refund half
-- and recorded the order side as GAPs in `src/db/commerceHistoryDispositions.ts`;
-- this closes them. Seven triggers, no new function, and no table, column,
-- constraint or index is added, dropped, renamed or narrowed. No existing row
-- is written.
--
-- ## What was MEASURED before any of this was written
--
-- Against a real migrated server, by attempting each UPDATE and reading the
-- SQLSTATE numerically (never a condition name), with a negative control that
-- an unknown column answers 42703 and positive controls that #90's condition
-- freeze answers 23514 and #106's buyer-origin freeze answers P0001:
--
--   order_items.title / variant_title / unit_price / line_total / quantity
--     / listing_id                                                  ACCEPTED
--   order_item_option_values.value                                  ACCEPTED
--   order_status_history.status / at / by_oxy_user_id / note        ACCEPTED
--   order_applied_discounts.amount_amount / title                   ACCEPTED
--   order_tax_lines.amount_amount / rate_bps                        ACCEPTED
--   orders.order_number / checkout_group_id / shipping_address_*
--     / totals_*                                                    ACCEPTED
--   retail_procurement_intents.buyer_locked_total_amount
--     / supplier_cost_amount / order_id / agreement_id              ACCEPTED
--
-- Three columns REFUSED, and all three did so from a CHECK constraint rather
-- than from any freeze — which is not immutability, and the difference is the
-- whole reason this file exists. `orders.commercial_role` refused a move to
-- `informational` (23514, `orders_commercial_role_seller_check`) and then
-- ACCEPTED a move to `mercaria_retail` made together with the matching
-- `seller_type` move. `order_status_history.actor_kind` refused
-- `system`->`oxy` and ACCEPTED `oxy`->`operator`. A CHECK that refuses ONE
-- value-change is a constraint on VALUES; it says nothing about rewriting.
--
-- ## Why the two shapes, and why NOT a whole-row freeze on `orders`/`order_items`
--
-- Four tables have no UPDATE writer anywhere — production, test or script — and
-- every column on them is a fact about the transaction as it stood, so they take
-- the whole-row refusal.
--
-- `orders` and `order_items` genuinely move and take a COLUMN list. On `orders`
-- the lifecycle status, the payment linkage, the tracking number, the moderation
-- hold, the claim pair and the connector-sync columns are all written by
-- `db/orders/orderRepository.ts` today. `orders.created_at` is deliberately left
-- open too: it is the RESERVATION CLOCK, and
-- `services/__tests__/checkout.stripe.realdb.test.ts` moves it to travel past
-- the reservation TTL, which no other mechanism can express.
-- `order_items.position` is left open because `db/__tests__/condition.realdb.test.ts`
-- asserts an ordinary UPDATE still succeeds there — a deliberate vacuity guard
-- proving #90's condition trigger is column-scoped rather than a whole-row
-- refusal, and a guard that is right to keep.
--
-- ## Why NOTHING here refuses a DELETE
--
-- Measured, not conceded, and the measurement is the same one `0046` recorded
-- for `retail_procurement_intent_lines`: "refusing DELETE here would break a
-- cascade the foreign keys already declare rather than protect anything."
-- All six tables cascade from `orders` (or, for `order_item_option_values`,
-- from `order_items`). Eighteen realdb teardowns delete orders, and
-- `src/scripts/seed.ts` deletes the whole table in `clearMarketplace()`; a
-- cascaded DELETE issues a real row DELETE on the child and fires its triggers,
-- so a DELETE refusal on ANY of the six breaks every one of those — including
-- on the four tables nothing deletes directly. #90's condition photos set the
-- precedent: permit the DELETE so the cascade the foreign key already declares
-- still works.
--
-- ## Why `pre`
--
-- A `post` statement is one that breaks a write the PREVIOUS image performs.
-- None of these does: every column frozen below is written by no code path at
-- all, or (for `orders.customer_id`, `orders.idempotency_key` and
-- `retail_procurement_intents.purchase_order_id`) is NULL until stamped once,
-- which the write-once guard admits. The serving image and the arriving image
-- perform the same writes.
--
-- ## Why WRITE-ONCE
--
-- `mercaria_commerce_snapshot_columns_immutable` guards
-- `OLD IS NOT NULL AND NEW IS DISTINCT FROM OLD`, so a NULL -> value stamp is
-- permitted and rewriting a recorded fact is not. On a NOT NULL column it
-- degenerates to a plain freeze, which is the intended reading for most of the
-- lists below.
--
-- ## HAND-WRITTEN, ENTIRELY
--
-- drizzle-kit models no trigger and no function, so `db:generate` will emit NONE
-- of this and a regeneration DESTROYS the file. It was created with
-- `drizzle-kit generate --custom`, which writes `meta/_journal.json` correctly;
-- never hand-edit the journal or rename the file. Both functions used below
-- already exist — they were created by `0135` and are deliberately REUSED
-- rather than redefined, so there is one body per behaviour and no second
-- spelling to drift.
--
-- Verify after any edit:
--   grep -c '^-- oxy:handwritten-begin=' drizzle/0137_order_snapshot_immutability.sql   # 2
--   grep -c '^-- oxy:handwritten-end='   drizzle/0137_order_snapshot_immutability.sql   # 2

-- oxy:handwritten-begin=order_history_append_only
-- The four order-child tables nothing updates anywhere.
--
-- `mercaria_commerce_snapshot_append_only()` is `0135`'s, reused: it names the
-- table in its message and raises with ERRCODE `check_violation` (23514), which
-- is the class `isCheckViolation` in the test helpers already recognises.

-- `schema/orders.ts` calls this "the append-only lifecycle trail" and rested
-- that on the ABSENCE of an `updated_at` column -- which stops an ORM idiom and
-- nothing else. Measured before this trigger: the status, the instant, the
-- acting account and the note were all rewritable, so an audit row could be
-- reattributed to a different person.
CREATE TRIGGER order_status_history_append_only
  BEFORE UPDATE ON "order_status_history"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_append_only();--> statement-breakpoint

-- The {name, value} pairs printed on the receipt.
CREATE TRIGGER order_item_option_values_append_only
  BEFORE UPDATE ON "order_item_option_values"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_append_only();--> statement-breakpoint

-- "persisted so a refund can be computed against exactly what was charged"
-- (`schema/orders.ts`) -- which is only true if the allocation cannot move
-- after the charge.
CREATE TRIGGER order_applied_discounts_append_only
  BEFORE UPDATE ON "order_applied_discounts"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_append_only();--> statement-breakpoint

-- One applied rate's contribution to a placed order's tax, which a tax
-- authority can ask about years later.
CREATE TRIGGER order_tax_lines_append_only
  BEFORE UPDATE ON "order_tax_lines"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_append_only();--> statement-breakpoint
-- oxy:handwritten-end=order_history_append_only

-- oxy:handwritten-begin=order_snapshot_columns_immutable
-- The two tables that legitimately move, frozen by COLUMN.
--
-- `mercaria_commerce_snapshot_columns_immutable(...)` is `0135`'s, reused. The
-- column list lives in the CREATE TRIGGER statement rather than in a function
-- body precisely so it can be read back out of `pg_trigger` and compared
-- against `commerceHistoryDispositions.ts`, which
-- `commerce-history-immutability.realdb.test.ts` does.
--
-- Neither list repeats a column an EXISTING bespoke trigger already governs.
-- That is not tidiness: `orders_buyer_origin_immutable` deliberately permits
-- `claimed_by_oxy_user_id` value -> NULL (an audited unclaim, #106/#109), and
-- the write-once guard here refuses every change once the column is non-NULL --
-- so naming it below would silently break the unclaim path.

-- What was sold, to whom, at what price, to which address, under which
-- commercial model. Left open, and each for a measured reason: `status`,
-- `payment_status`, `payment_paid_at`, `payment_id`, `payment_provider`,
-- `payment_reference`, `shipping_tracking_number`, `moderation_hold`,
-- `claimed_by_oxy_user_id`, `claimed_at`, the four `source_*` connector-sync
-- columns, `updated_at`, and `created_at` (the reservation clock).
--
-- `commercial_role` is the one to read. `schema/orders.ts` called it "immutable
-- in practice rather than by trigger" and argued that
-- `orders_commercial_role_seller_check` "would refuse the only value change
-- that could matter". Measured: a move to `mercaria_retail` made together with
-- the matching `seller_type` move is ACCEPTED, and that is precisely the change
-- that matters -- it reclassifies a marketplace sale as a Mercaria-retail one,
-- which is the input ADR 0004 D7's commission arithmetic reads on every
-- posting.
CREATE TRIGGER orders_snapshot_immutable
  BEFORE UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'order_number', 'checkout_group_id', 'idempotency_key',
    'seller_type', 'seller_oxy_user_id', 'store_id', 'customer_id',
    'commercial_role', 'source_channel',
    'shipping_address_label', 'shipping_address_recipient_name',
    'shipping_address_line1', 'shipping_address_line2', 'shipping_address_city',
    'shipping_address_region', 'shipping_address_postal_code',
    'shipping_address_country', 'shipping_address_phone',
    'shipping_method', 'shipping_label',
    'shipping_cost_shop_amount', 'shipping_cost_shop_currency',
    'shipping_cost_presentment_amount', 'shipping_cost_presentment_currency',
    'totals_subtotal_shop_amount', 'totals_subtotal_shop_currency',
    'totals_subtotal_presentment_amount', 'totals_subtotal_presentment_currency',
    'totals_discount_total_shop_amount', 'totals_discount_total_shop_currency',
    'totals_discount_total_presentment_amount', 'totals_discount_total_presentment_currency',
    'totals_shipping_shop_amount', 'totals_shipping_shop_currency',
    'totals_shipping_presentment_amount', 'totals_shipping_presentment_currency',
    'totals_tax_shop_amount', 'totals_tax_shop_currency',
    'totals_tax_presentment_amount', 'totals_tax_presentment_currency',
    'totals_grand_total_shop_amount', 'totals_grand_total_shop_currency',
    'totals_grand_total_presentment_amount', 'totals_grand_total_presentment_currency',
    'fx_rate_from', 'fx_rate_to', 'fx_rate_rate', 'fx_rate_as_of',
    'fx_rate_provider');--> statement-breakpoint

-- One purchased line as it stood at checkout. `position` and the two timestamps
-- are left open; the three condition columns are governed by
-- `order_items_condition_immutable` (#90) and are deliberately not repeated.
--
-- Trigger firing order among BEFORE UPDATE triggers on one table is
-- ALPHABETICAL by trigger name, so `order_items_condition_immutable` still
-- fires first and the condition suite keeps seeing its own message.
CREATE TRIGGER order_items_snapshot_immutable
  BEFORE UPDATE ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'order_id', 'listing_id', 'variant_id', 'title', 'variant_title',
    'image_url', 'quantity', 'location_id',
    'unit_price_shop_amount', 'unit_price_shop_currency',
    'unit_price_presentment_amount', 'unit_price_presentment_currency',
    'line_total_shop_amount', 'line_total_shop_currency',
    'line_total_presentment_amount', 'line_total_presentment_currency',
    'discount_total_shop_amount', 'discount_total_shop_currency',
    'discount_total_presentment_amount', 'discount_total_presentment_currency');--> statement-breakpoint

-- #123's "WHAT was promised, frozen at checkout", which `schema/retailCheckout.ts`
-- says twice and the database enforced nowhere: measured, `buyer_locked_total_amount`
-- -- the figure every variance comparison and every compensating refund is sized
-- from -- was freely rewritable, as were the supplier cost, the agreement and
-- the `order_id` itself.
--
-- `status`, `requested_at`, `failure_kind` and `failure_detail` stay open: the
-- intent is recorded, requested, then resolved. `purchase_order_id` is frozen
-- WRITE-ONCE, which admits the one CAS stamp
-- `attachRetailIntentPurchaseOrder` makes and refuses a re-point -- a second
-- purchase order for one intent being the duplicate-supplier-order failure the
-- whole domain is shaped around.
CREATE TRIGGER retail_procurement_intents_snapshot_immutable
  BEFORE UPDATE ON "retail_procurement_intents"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'order_id', 'checkout_group_id', 'supplier_id', 'supplier_account_id',
    'agreement_id', 'purchase_order_id',
    'supplier_cost_amount', 'supplier_cost_currency',
    'buyer_locked_total_amount', 'buyer_locked_total_currency');
-- oxy:handwritten-end=order_snapshot_columns_immutable
