-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- #126 — supplier-fulfilled Mercaria-retail fulfilment. ADDITIVE, entirely.
--
-- Four new tables plus ONE nullable, defaulted column on `supplier_agreements`
-- (`moovo_label_dispatch_permitted`, default FALSE), which is what makes Mode A
-- opt-in per agreement version and leaves every existing agreement behaving
-- exactly as before. Nothing is dropped, narrowed or renamed, so the serving
-- image keeps working against this schema unchanged.
--
-- The hand-written statements at the END of this file are the four triggers
-- drizzle-kit cannot model. A REGENERATION DROPS THEM: re-apply them there and
-- verify by grepping this file for each function/trigger pair and for exactly
-- one deploy-phase marker on the first line.
--

CREATE TABLE "retail_delivery_promises" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"fulfilment_intent_id" text,
	"promise_kind" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"outcome" text NOT NULL,
	"basis" text,
	"earliest_at" timestamp with time zone,
	"latest_at" timestamp with time zone,
	"failure_reason" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_delivery_promises_kind_check" CHECK ("retail_delivery_promises"."promise_kind" in ('accepted_at_checkout', 'supplier_handling', 'supplier_dispatch', 'logistics_estimate')),
	CONSTRAINT "retail_delivery_promises_source_check" CHECK ("retail_delivery_promises"."source" in ('mercaria_checkout', 'supplier_adapter', 'moovo_logistics', 'operator')),
	CONSTRAINT "retail_delivery_promises_outcome_check" CHECK ("retail_delivery_promises"."outcome" in ('observed', 'unknown', 'refresh_failed')),
	CONSTRAINT "retail_delivery_promises_basis_check" CHECK ("retail_delivery_promises"."basis" in ('guaranteed', 'advisory')),
	CONSTRAINT "retail_delivery_promises_observed_shape_check" CHECK (("retail_delivery_promises"."outcome" = 'observed') = ("retail_delivery_promises"."basis" is not null)
          and ("retail_delivery_promises"."outcome" = 'observed')
              = ("retail_delivery_promises"."earliest_at" is not null or "retail_delivery_promises"."latest_at" is not null)),
	CONSTRAINT "retail_delivery_promises_window_order_check" CHECK ("retail_delivery_promises"."earliest_at" is null or "retail_delivery_promises"."latest_at" is null or "retail_delivery_promises"."latest_at" >= "retail_delivery_promises"."earliest_at"),
	CONSTRAINT "retail_delivery_promises_failure_shape_check" CHECK (("retail_delivery_promises"."outcome" = 'refresh_failed') = ("retail_delivery_promises"."failure_reason" is not null)),
	CONSTRAINT "retail_delivery_promises_accepted_shape_check" CHECK ("retail_delivery_promises"."promise_kind" <> 'accepted_at_checkout'
          or ("retail_delivery_promises"."source" = 'mercaria_checkout'
              and "retail_delivery_promises"."outcome" = 'observed'
              and "retail_delivery_promises"."fulfilment_intent_id" is null))
);
--> statement-breakpoint
CREATE TABLE "retail_fulfilment_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"procurement_intent_id" text NOT NULL,
	"intent_kind" text DEFAULT 'original' NOT NULL,
	"supersedes_intent_id" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"status_reason" text,
	"permitted_fulfilment_mode" text NOT NULL,
	"fulfilment_mode" text,
	"moovo_source_reference" text GENERATED ALWAYS AS ('mercaria:retail-fulfilment:' || "id") STORED NOT NULL,
	"moovo_transport_request_id" text,
	"moovo_transport_registered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_fulfilment_intents_kind_check" CHECK ("retail_fulfilment_intents"."intent_kind" in ('original', 'replacement')),
	CONSTRAINT "retail_fulfilment_intents_status_check" CHECK ("retail_fulfilment_intents"."status" in ('planned', 'active', 'superseded', 'cancelled', 'closed')),
	CONSTRAINT "retail_fulfilment_intents_permitted_mode_check" CHECK ("retail_fulfilment_intents"."permitted_fulfilment_mode" in ('moovo_controlled', 'supplier_controlled', 'either')),
	CONSTRAINT "retail_fulfilment_intents_mode_check" CHECK ("retail_fulfilment_intents"."fulfilment_mode" in ('moovo_controlled', 'supplier_controlled')),
	CONSTRAINT "retail_fulfilment_intents_mode_permitted_check" CHECK ("retail_fulfilment_intents"."fulfilment_mode" is null
          or "retail_fulfilment_intents"."permitted_fulfilment_mode" = 'either'
          or "retail_fulfilment_intents"."fulfilment_mode" = "retail_fulfilment_intents"."permitted_fulfilment_mode"),
	CONSTRAINT "retail_fulfilment_intents_replacement_shape_check" CHECK (("retail_fulfilment_intents"."intent_kind" = 'replacement') = ("retail_fulfilment_intents"."supersedes_intent_id" is not null)),
	CONSTRAINT "retail_fulfilment_intents_self_supersede_check" CHECK ("retail_fulfilment_intents"."supersedes_intent_id" is null or "retail_fulfilment_intents"."supersedes_intent_id" <> "retail_fulfilment_intents"."id"),
	CONSTRAINT "retail_fulfilment_intents_moovo_shape_check" CHECK (("retail_fulfilment_intents"."moovo_transport_request_id" is not null) = ("retail_fulfilment_intents"."moovo_transport_registered_at" is not null)
          and ("retail_fulfilment_intents"."moovo_transport_request_id" is null or "retail_fulfilment_intents"."fulfilment_mode" is not null))
);
--> statement-breakpoint
CREATE TABLE "retail_fulfilment_line_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"fulfilment_intent_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_fulfilment_line_allocations_quantity_check" CHECK ("retail_fulfilment_line_allocations"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "retail_order_role_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"seller_of_record" text DEFAULT 'mercaria' NOT NULL,
	"seller_legal_entity_name" text NOT NULL,
	"seller_legal_entity_country" text NOT NULL,
	"supplier_fulfilment_disclosure_key" text NOT NULL,
	"supplier_fulfilment_disclosure_version" integer NOT NULL,
	"customer_terms_version" text NOT NULL,
	"cancellation_window_hours" integer NOT NULL,
	"withdrawal_window_days" integer NOT NULL,
	"return_window_days" integer NOT NULL,
	"warranty_months" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_order_role_snapshots_seller_check" CHECK ("retail_order_role_snapshots"."seller_of_record" in ('mercaria')),
	CONSTRAINT "retail_order_role_snapshots_country_check" CHECK ("retail_order_role_snapshots"."seller_legal_entity_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "retail_order_role_snapshots_entity_check" CHECK (length(btrim("retail_order_role_snapshots"."seller_legal_entity_name")) > 0),
	CONSTRAINT "retail_order_role_snapshots_disclosure_check" CHECK (length(btrim("retail_order_role_snapshots"."supplier_fulfilment_disclosure_key")) > 0
          and "retail_order_role_snapshots"."supplier_fulfilment_disclosure_version" >= 1),
	CONSTRAINT "retail_order_role_snapshots_terms_check" CHECK (length(btrim("retail_order_role_snapshots"."customer_terms_version")) > 0),
	CONSTRAINT "retail_order_role_snapshots_windows_check" CHECK ("retail_order_role_snapshots"."cancellation_window_hours" >= 1
          and "retail_order_role_snapshots"."withdrawal_window_days" >= 1
          and "retail_order_role_snapshots"."return_window_days" >= 1
          and "retail_order_role_snapshots"."warranty_months" >= 1)
);
--> statement-breakpoint
ALTER TABLE "supplier_agreements" ADD COLUMN "moovo_label_dispatch_permitted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "retail_delivery_promises" ADD CONSTRAINT "retail_delivery_promises_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_delivery_promises" ADD CONSTRAINT "retail_delivery_promises_fulfilment_intent_id_retail_fulfilment_intents_id_fk" FOREIGN KEY ("fulfilment_intent_id") REFERENCES "public"."retail_fulfilment_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_fulfilment_intents" ADD CONSTRAINT "retail_fulfilment_intents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_fulfilment_intents" ADD CONSTRAINT "retail_fulfilment_intents_procurement_intent_id_retail_procurement_intents_id_fk" FOREIGN KEY ("procurement_intent_id") REFERENCES "public"."retail_procurement_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_fulfilment_intents" ADD CONSTRAINT "retail_fulfilment_intents_supersedes_intent_id_retail_fulfilment_intents_id_fk" FOREIGN KEY ("supersedes_intent_id") REFERENCES "public"."retail_fulfilment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_fulfilment_line_allocations" ADD CONSTRAINT "retail_fulfilment_line_allocations_fulfilment_intent_id_retail_fulfilment_intents_id_fk" FOREIGN KEY ("fulfilment_intent_id") REFERENCES "public"."retail_fulfilment_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_fulfilment_line_allocations" ADD CONSTRAINT "retail_fulfilment_line_allocations_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_order_role_snapshots" ADD CONSTRAINT "retail_order_role_snapshots_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_delivery_promises_accepted_key" ON "retail_delivery_promises" USING btree ("order_id") WHERE "retail_delivery_promises"."promise_kind" = 'accepted_at_checkout';--> statement-breakpoint
CREATE INDEX "retail_delivery_promises_intent_observed_idx" ON "retail_delivery_promises" USING btree ("fulfilment_intent_id","promise_kind","observed_at");--> statement-breakpoint
CREATE INDEX "retail_delivery_promises_order_observed_idx" ON "retail_delivery_promises" USING btree ("order_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_fulfilment_intents_procurement_original_key" ON "retail_fulfilment_intents" USING btree ("procurement_intent_id") WHERE "retail_fulfilment_intents"."intent_kind" = 'original';--> statement-breakpoint
CREATE UNIQUE INDEX "retail_fulfilment_intents_source_reference_key" ON "retail_fulfilment_intents" USING btree ("moovo_source_reference");--> statement-breakpoint
CREATE INDEX "retail_fulfilment_intents_order_idx" ON "retail_fulfilment_intents" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "retail_fulfilment_intents_awaiting_transport_idx" ON "retail_fulfilment_intents" USING btree ("created_at") WHERE "retail_fulfilment_intents"."moovo_transport_request_id" is null and "retail_fulfilment_intents"."status" in ('planned', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX "retail_fulfilment_line_allocations_intent_item_key" ON "retail_fulfilment_line_allocations" USING btree ("fulfilment_intent_id","order_item_id");--> statement-breakpoint
CREATE INDEX "retail_fulfilment_line_allocations_item_idx" ON "retail_fulfilment_line_allocations" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_order_role_snapshots_order_key" ON "retail_order_role_snapshots" USING btree ("order_id");
--
-- 1. `retail_order_role_snapshots` is IMMUTABLE.
--
-- UPDATE is refused always. DELETE is refused only while the order still
-- exists, which is #90's condition-revision device: the `ON DELETE cascade` the
-- foreign key declares still works, and an operator cannot remove one snapshot
-- to hide what a buyer was sold under. A plain "immutable once set" rule would
-- still admit a later backfill rewriting a window to whatever the current terms
-- say, which is exactly the silent rewrite the snapshot exists to prevent.
--
CREATE OR REPLACE FUNCTION mercaria_retail_role_snapshot_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'retail_order_role_snapshots is immutable: it records who sold one order and under which '
      'consumer terms, and a buyer asking in two years must be answered from what was true then. '
      'Terms changes are a new customer-terms version applied to new orders.';
  END IF;
  IF EXISTS (SELECT 1 FROM orders WHERE id = OLD.order_id) THEN
    RAISE EXCEPTION
      'retail_order_role_snapshots row % cannot be deleted while order % exists.',
      OLD.id, OLD.order_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER retail_order_role_snapshots_immutable
BEFORE UPDATE OR DELETE ON retail_order_role_snapshots
FOR EACH ROW EXECUTE FUNCTION mercaria_retail_role_snapshot_immutable();--> statement-breakpoint

--
-- 2. `retail_delivery_promises` is APPEND-ONLY.
--
-- #126 rule 9: never silently rewrite past promises. The trail is the whole
-- mechanism by which "accepted" and "current" stay two separately reportable
-- values, and a row that can be edited afterwards makes the accepted promise
-- whatever the last update said. Same DELETE exception, same reason.
--
CREATE OR REPLACE FUNCTION mercaria_retail_delivery_promise_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'retail_delivery_promises is append-only: a promise or an estimate is what somebody said '
      'at a stated time, and one that can be edited is not evidence of what a buyer accepted. '
      'Record a new observation instead.';
  END IF;
  IF EXISTS (SELECT 1 FROM orders WHERE id = OLD.order_id) THEN
    RAISE EXCEPTION
      'retail_delivery_promises row % cannot be deleted while order % exists.',
      OLD.id, OLD.order_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER retail_delivery_promises_append_only
BEFORE UPDATE OR DELETE ON retail_delivery_promises
FOR EACH ROW EXECUTE FUNCTION mercaria_retail_delivery_promise_append_only();--> statement-breakpoint

--
-- 3. A fulfilment intent's CONTRACTUAL half is frozen.
--
-- Which order, which procurement intent, which kind, what it supersedes and
-- what the agreement PERMITTED are all facts about the purchase, established
-- when the buyer paid. Re-pointing any of them reinterprets every allocation,
-- promise and (later) Moovo event that names this row, with nothing in the data
-- saying a reinterpretation happened — the `awin_advertisers` identity freeze,
-- for the same reason.
--
-- `moovo_source_reference` is deliberately NOT compared here: it is a STORED
-- GENERATED column, so `NEW.<col>` is NULL inside a BEFORE trigger and the
-- comparison would raise on every update. It cannot drift anyway — it is a
-- function of `id`, which this trigger does not permit changing either.
--
CREATE OR REPLACE FUNCTION mercaria_retail_fulfilment_intent_frozen()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.procurement_intent_id IS DISTINCT FROM OLD.procurement_intent_id
     OR NEW.intent_kind IS DISTINCT FROM OLD.intent_kind
     OR NEW.supersedes_intent_id IS DISTINCT FROM OLD.supersedes_intent_id
     OR NEW.permitted_fulfilment_mode IS DISTINCT FROM OLD.permitted_fulfilment_mode THEN
    RAISE EXCEPTION
      'retail_fulfilment_intents identity and permitted mode are frozen: they are facts about '
      'the purchase, and re-pointing one reinterprets every allocation, promise and logistics '
      'event that names this row.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER retail_fulfilment_intents_frozen
BEFORE UPDATE ON retail_fulfilment_intents
FOR EACH ROW EXECUTE FUNCTION mercaria_retail_fulfilment_intent_frozen();--> statement-breakpoint

--
-- 4. The chosen mode and the Moovo transport are WRITE-ONCE.
--
-- NULL to a value exactly once, and never value to value — the
-- `orders.claimed_by_oxy_user_id` device (#106). Both matter for the same
-- reason and it is not tidiness: every event already projected under the first
-- mode or against the first transport is reinterpreted by the second, and the
-- reinterpretation is invisible. Clearing back to NULL is refused too, because
-- a cleared transport id would let a second booking be made for a movement that
-- is already under way.
--
-- The repository states the same rule as a CAS predicate. Both exist because
-- the statement-level guard protects the service path and this one protects
-- every other writer — a migration, a sibling service, `psql`.
--
CREATE OR REPLACE FUNCTION mercaria_retail_fulfilment_write_once()
RETURNS trigger AS $$
BEGIN
  IF OLD.fulfilment_mode IS NOT NULL AND NEW.fulfilment_mode IS DISTINCT FROM OLD.fulfilment_mode THEN
    RAISE EXCEPTION
      'retail_fulfilment_intents.fulfilment_mode is write-once (currently %): who books the '
      'transport decides how every event about it is read, so changing it reinterprets the '
      'ones already projected.', OLD.fulfilment_mode;
  END IF;
  IF OLD.moovo_transport_request_id IS NOT NULL
     AND NEW.moovo_transport_request_id IS DISTINCT FROM OLD.moovo_transport_request_id THEN
    RAISE EXCEPTION
      'retail_fulfilment_intents.moovo_transport_request_id is write-once: clearing or '
      'repointing it would permit a second booking for a movement already under way.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER retail_fulfilment_intents_write_once
BEFORE UPDATE ON retail_fulfilment_intents
FOR EACH ROW EXECUTE FUNCTION mercaria_retail_fulfilment_write_once();
