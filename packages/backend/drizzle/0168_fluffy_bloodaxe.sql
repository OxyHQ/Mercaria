-- oxy:deploy-phase=pre
CREATE TABLE "catalog_safety_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" bigint GENERATED ALWAYS AS IDENTITY (sequence name "catalog_safety_reviews_revision_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9007199254740991 START WITH 1 CACHE 1),
	"listing_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"decision" text NOT NULL,
	"reviewer_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_safety_reviews_decision_check" CHECK ("catalog_safety_reviews"."decision" in ('allow', 'withhold')),
	CONSTRAINT "catalog_safety_reviews_digest_check" CHECK ("catalog_safety_reviews"."content_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "supervised_checkout_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_oxy_user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"selection_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supervised_checkout_requests_key_check" CHECK (length("supervised_checkout_requests"."idempotency_key") between 1 and 128),
	CONSTRAINT "supervised_checkout_requests_fingerprints_check" CHECK ("supervised_checkout_requests"."request_fingerprint" ~ '^[a-f0-9]{64}$' and "supervised_checkout_requests"."selection_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "supervised_purchase_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"merchant_account_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supervised_purchase_lines_digest_check" CHECK ("supervised_purchase_lines"."content_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "supervised_purchase_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"approval_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"request_fingerprint" text NOT NULL,
	"cart_fingerprint" text NOT NULL,
	"payment_fingerprint" text NOT NULL,
	"payment_started_at" timestamp with time zone,
	"cancellation_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supervised_purchase_operations_fingerprints_check" CHECK ("supervised_purchase_operations"."request_fingerprint" ~ '^[a-f0-9]{64}$' and "supervised_purchase_operations"."cart_fingerprint" ~ '^[a-f0-9]{64}$' and "supervised_purchase_operations"."payment_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "payment_outboxes" DROP CONSTRAINT "payment_outboxes_event_type_check";--> statement-breakpoint
ALTER TABLE "catalog_safety_reviews" ADD CONSTRAINT "catalog_safety_reviews_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervised_purchase_lines" ADD CONSTRAINT "supervised_purchase_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervised_purchase_lines" ADD CONSTRAINT "supervised_purchase_lines_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."supervised_purchase_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervised_purchase_operations" ADD CONSTRAINT "supervised_purchase_operations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_safety_reviews_revision_key" ON "catalog_safety_reviews" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "catalog_safety_reviews_listing_revision_idx" ON "catalog_safety_reviews" USING btree ("listing_id","revision" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "supervised_checkout_requests_buyer_key" ON "supervised_checkout_requests" USING btree ("buyer_oxy_user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "supervised_purchase_lines_order_item_key" ON "supervised_purchase_lines" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "supervised_purchase_lines_operation_idx" ON "supervised_purchase_lines" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supervised_purchase_operations_payment_key" ON "supervised_purchase_operations" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supervised_purchase_operations_approval_key" ON "supervised_purchase_operations" USING btree ("approval_id");--> statement-breakpoint
ALTER TABLE "payment_outboxes" ADD CONSTRAINT "payment_outboxes_event_type_check" CHECK ("payment_outboxes"."event_type" in ('payment_succeeded', 'supervised_purchase_cancelled', 'payment_failed', 'payment_succeeded_after_release', 'transfer_withheld', 'payment_refunded', 'payment_disputed', 'transfer_changed', 'payout_changed', 'provider_account_changed', 'refund_failed', 'reversal_failed', 'refund_unmatched', 'guest_portal_initialization', 'procurement_requested', 'retail_procurement_failed'));
--> statement-breakpoint
CREATE FUNCTION mercaria_catalog_safety_review_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'catalog safety reviews are append-only' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_safety_reviews_immutable BEFORE UPDATE OR DELETE ON catalog_safety_reviews
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_safety_review_immutable();

--> statement-breakpoint
CREATE TRIGGER supervised_purchase_lines_immutable BEFORE UPDATE OR DELETE ON supervised_purchase_lines
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_safety_review_immutable();
--> statement-breakpoint
CREATE FUNCTION mercaria_supervised_purchase_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase approval operations are retained' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW.payment_id, NEW.expires_at, NEW.request_fingerprint, NEW.cart_fingerprint, NEW.payment_fingerprint, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.payment_id, OLD.expires_at, OLD.request_fingerprint, OLD.cart_fingerprint, OLD.payment_fingerprint, OLD.created_at)
     OR (OLD.approval_id IS NOT NULL AND NEW.approval_id IS DISTINCT FROM OLD.approval_id)
     OR (OLD.payment_started_at IS NOT NULL AND NEW.payment_started_at IS DISTINCT FROM OLD.payment_started_at)
     OR (OLD.cancellation_confirmed_at IS NOT NULL AND NEW.cancellation_confirmed_at IS DISTINCT FROM OLD.cancellation_confirmed_at) THEN
    RAISE EXCEPTION 'purchase approval effects and recorded events are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER supervised_purchase_operations_guard BEFORE UPDATE OR DELETE ON supervised_purchase_operations
FOR EACH ROW EXECUTE FUNCTION mercaria_supervised_purchase_operation_guard();

--> statement-breakpoint
CREATE TRIGGER supervised_checkout_requests_immutable BEFORE UPDATE OR DELETE ON supervised_checkout_requests
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_safety_review_immutable();
