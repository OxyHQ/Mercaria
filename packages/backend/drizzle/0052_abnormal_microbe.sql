-- oxy:deploy-phase=pre
--
-- #74 — the ranking policy register. ONE table, additive, and safe against the
-- image that is still serving: nothing reads or writes this table until the
-- image that ships it, and a deployment with no rows in it ranks under
-- `BUILTIN_RANKING_POLICY` exactly as before.
--
-- ON A REGENERATION: the hand-written block at the END of this file is dropped
-- by drizzle-kit. Re-apply `mercaria_ranking_policy_version_immutable` and its
-- trigger after the index statements. A regeneration that keeps the CHECKs and
-- loses the trigger applies perfectly cleanly and freezes nothing — every
-- weight of a version that has already served traffic becomes editable, and
-- every impression logged under that version starts naming weights it was not
-- produced by.

CREATE TABLE "ranking_policy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_key" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"description" text NOT NULL,
	"weight_item_price" double precision NOT NULL,
	"weight_delivery_cost" double precision NOT NULL,
	"weight_tax_inclusion" double precision NOT NULL,
	"weight_delivery_speed" double precision NOT NULL,
	"weight_condition" double precision NOT NULL,
	"weight_merchant_rating" double precision NOT NULL,
	"weight_return_policy" double precision NOT NULL,
	"weight_availability_confidence" double precision NOT NULL,
	"weight_observation_freshness" double precision NOT NULL,
	"weight_verified_relationship" double precision NOT NULL,
	"weight_pickup_proximity" double precision NOT NULL,
	"min_review_count" integer DEFAULT 3 NOT NULL,
	"dominance_window" integer DEFAULT 5 NOT NULL,
	"dominance_share" double precision DEFAULT 0.6 NOT NULL,
	"canary_share_bps" integer DEFAULT 0 NOT NULL,
	"objective_metric_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"guardrail_metric_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "ranking_policy_versions_status_check" CHECK ("ranking_policy_versions"."status" in ('draft', 'canary', 'active', 'superseded', 'archived')),
	CONSTRAINT "ranking_policy_versions_version_check" CHECK (btrim("ranking_policy_versions"."version") <> ''),
	CONSTRAINT "ranking_policy_versions_description_check" CHECK (btrim("ranking_policy_versions"."description") <> ''),
	CONSTRAINT "ranking_policy_versions_actor_check" CHECK (btrim("ranking_policy_versions"."created_by_oxy_user_id") <> ''),
	CONSTRAINT "ranking_policy_versions_weights_check" CHECK ("ranking_policy_versions"."weight_item_price" >= 0 and "ranking_policy_versions"."weight_delivery_cost" >= 0
          and "ranking_policy_versions"."weight_tax_inclusion" >= 0 and "ranking_policy_versions"."weight_delivery_speed" >= 0
          and "ranking_policy_versions"."weight_condition" >= 0 and "ranking_policy_versions"."weight_merchant_rating" >= 0
          and "ranking_policy_versions"."weight_return_policy" >= 0 and "ranking_policy_versions"."weight_availability_confidence" >= 0
          and "ranking_policy_versions"."weight_observation_freshness" >= 0 and "ranking_policy_versions"."weight_verified_relationship" >= 0
          and "ranking_policy_versions"."weight_pickup_proximity" >= 0),
	CONSTRAINT "ranking_policy_versions_weight_sum_check" CHECK ("ranking_policy_versions"."weight_item_price" + "ranking_policy_versions"."weight_delivery_cost" + "ranking_policy_versions"."weight_tax_inclusion"
          + "ranking_policy_versions"."weight_delivery_speed" + "ranking_policy_versions"."weight_condition" + "ranking_policy_versions"."weight_merchant_rating"
          + "ranking_policy_versions"."weight_return_policy" + "ranking_policy_versions"."weight_availability_confidence"
          + "ranking_policy_versions"."weight_observation_freshness" + "ranking_policy_versions"."weight_verified_relationship"
          + "ranking_policy_versions"."weight_pickup_proximity" > 0),
	CONSTRAINT "ranking_policy_versions_min_review_count_check" CHECK ("ranking_policy_versions"."min_review_count" >= 0),
	CONSTRAINT "ranking_policy_versions_dominance_check" CHECK ("ranking_policy_versions"."dominance_window" between 1 and 100
          and "ranking_policy_versions"."dominance_share" > 0 and "ranking_policy_versions"."dominance_share" <= 1),
	CONSTRAINT "ranking_policy_versions_canary_share_check" CHECK ("ranking_policy_versions"."canary_share_bps" between 0 and 10000
          and ("ranking_policy_versions"."status" = 'canary') = ("ranking_policy_versions"."canary_share_bps" > 0)),
	CONSTRAINT "ranking_policy_versions_activation_audit_check" CHECK ("ranking_policy_versions"."status" in ('draft', 'archived')
          or ("ranking_policy_versions"."approved_by_oxy_user_id" is not null and "ranking_policy_versions"."activated_at" is not null)),
	CONSTRAINT "ranking_policy_versions_superseded_check" CHECK ("ranking_policy_versions"."status" <> 'superseded' or "ranking_policy_versions"."superseded_at" is not null),
	CONSTRAINT "ranking_policy_versions_archived_check" CHECK (("ranking_policy_versions"."status" = 'archived') = ("ranking_policy_versions"."archived_at" is not null)),
	CONSTRAINT "ranking_policy_versions_objective_metrics_check" CHECK ("ranking_policy_versions"."objective_metric_keys" <@ array['search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage']::text[]),
	CONSTRAINT "ranking_policy_versions_guardrail_metrics_check" CHECK ("ranking_policy_versions"."guardrail_metric_keys" <@ array['search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage']::text[]),
	CONSTRAINT "ranking_policy_versions_evaluation_plan_check" CHECK (cardinality("ranking_policy_versions"."objective_metric_keys") >= 1 and cardinality("ranking_policy_versions"."guardrail_metric_keys") >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_policy_versions_key_version_key" ON "ranking_policy_versions" USING btree ("policy_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_policy_versions_one_active_per_key" ON "ranking_policy_versions" USING btree ("policy_key") WHERE "ranking_policy_versions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_policy_versions_one_canary_per_key" ON "ranking_policy_versions" USING btree ("policy_key") WHERE "ranking_policy_versions"."status" = 'canary';--> statement-breakpoint
CREATE INDEX "ranking_policy_versions_key_created_at_idx" ON "ranking_policy_versions" USING btree ("policy_key","created_at" DESC NULLS LAST);

--> statement-breakpoint
-- ── Immutable once it has served traffic ────────────────────────────────────
--
-- A `draft` is fully editable; from `canary` onward every column that decides an
-- ORDER is frozen, and publishing a new version is the only way to change one.
-- That is what makes "the same eligible input produces the same order for one
-- policy version" (#74 acceptance 1) a property of the data rather than a
-- promise about who edits what.
--
-- The columns NOT listed below may still move, and each is deliberate:
--   * `status`, `approved_by_oxy_user_id`, `activated_at`, `superseded_at`,
--     `archived_at`, `updated_at` — the lifecycle itself.
--   * `canary_share_bps` — a RAMP is a rollout control, not a policy term. The
--     share decides WHICH comparison subjects are routed to the version and
--     never what order any of them gets, and because the bucket is a hash of the
--     subject compared against the share, raising it only ADDS subjects. Freezing
--     it would make every ramp step a new version, and a version per ramp step
--     makes the impression log unreadable.
--
-- `description` IS frozen, though it is not economic: it is what an operator
-- reads when deciding whether to roll back, and editing it after the fact
-- rewrites the record of why the version was published.
CREATE OR REPLACE FUNCTION mercaria_ranking_policy_version_immutable()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.policy_key IS DISTINCT FROM OLD.policy_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id
     OR NEW.weight_item_price IS DISTINCT FROM OLD.weight_item_price
     OR NEW.weight_delivery_cost IS DISTINCT FROM OLD.weight_delivery_cost
     OR NEW.weight_tax_inclusion IS DISTINCT FROM OLD.weight_tax_inclusion
     OR NEW.weight_delivery_speed IS DISTINCT FROM OLD.weight_delivery_speed
     OR NEW.weight_condition IS DISTINCT FROM OLD.weight_condition
     OR NEW.weight_merchant_rating IS DISTINCT FROM OLD.weight_merchant_rating
     OR NEW.weight_return_policy IS DISTINCT FROM OLD.weight_return_policy
     OR NEW.weight_availability_confidence IS DISTINCT FROM OLD.weight_availability_confidence
     OR NEW.weight_observation_freshness IS DISTINCT FROM OLD.weight_observation_freshness
     OR NEW.weight_verified_relationship IS DISTINCT FROM OLD.weight_verified_relationship
     OR NEW.weight_pickup_proximity IS DISTINCT FROM OLD.weight_pickup_proximity
     OR NEW.min_review_count IS DISTINCT FROM OLD.min_review_count
     OR NEW.dominance_window IS DISTINCT FROM OLD.dominance_window
     OR NEW.dominance_share IS DISTINCT FROM OLD.dominance_share
     OR NEW.objective_metric_keys IS DISTINCT FROM OLD.objective_metric_keys
     OR NEW.guardrail_metric_keys IS DISTINCT FROM OLD.guardrail_metric_keys
  THEN
    RAISE EXCEPTION
      'ranking_policy_versions % (%, v%) is % and has served traffic; publish a new version instead of editing this one',
      OLD.id, OLD.policy_key, OLD.version, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ranking_policy_versions_immutable_once_serving ON "ranking_policy_versions";--> statement-breakpoint
CREATE TRIGGER ranking_policy_versions_immutable_once_serving
BEFORE UPDATE ON "ranking_policy_versions"
FOR EACH ROW EXECUTE FUNCTION mercaria_ranking_policy_version_immutable();
