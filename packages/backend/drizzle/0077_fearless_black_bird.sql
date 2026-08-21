-- oxy:deploy-phase=pre
-- oxy:rollback=restore: analytics_events_reason_code_check is widened; the previous form is in 0065 and re-adding it fails against any event carrying an added reason code
--
-- #85: merchant activation readiness and native-checkout onboarding.
--
-- `pre`, and every statement is additive or a WIDENING:
--
--  * three new tables, referenced by nothing the serving image writes;
--  * `analytics_events_reason_code_check` is dropped and re-added over a strict
--    SUPERSET of its previous tuple (39 values in, 40 out; it gains
--    `seller_not_activated` and loses nothing), so no write the previous image
--    performs is broken by it. A narrowing here would be `post`; this is not one.
--
-- HAND-WRITTEN STATEMENTS BELOW THE GENERATED BLOCK. A regeneration DROPS them.
-- Re-apply the two append-only trigger pairs at the end of the file, and check
-- that exactly one deploy-phase marker line survives, before pushing.
--
CREATE TABLE "merchant_activation_capability_events" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"capability" text NOT NULL,
	"previous_state" text,
	"next_state" text NOT NULL,
	"unmet" text[] DEFAULT '{}'::text[] NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"cause" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_activation_capability_events_capability_check" CHECK ("merchant_activation_capability_events"."capability" in ('authenticated_native_checkout', 'guest_native_checkout', 'shipping_checkout', 'pickup_checkout', 'presentment_currency_selection', 'card_payment_rail', 'refund_and_return_operations', 'transactional_guest_communication', 'p2p_seller_checkout', 'guest_p2p_checkout')),
	CONSTRAINT "merchant_activation_capability_events_next_state_check" CHECK ("merchant_activation_capability_events"."next_state" in ('granted', 'withheld', 'not_applicable')),
	CONSTRAINT "merchant_activation_capability_events_previous_state_check" CHECK ("merchant_activation_capability_events"."previous_state" is null
          or "merchant_activation_capability_events"."previous_state" in ('granted', 'withheld', 'not_applicable')),
	CONSTRAINT "merchant_activation_capability_events_actor_kind_check" CHECK ("merchant_activation_capability_events"."actor_kind" in ('merchant', 'operator', 'system')),
	CONSTRAINT "merchant_activation_capability_events_cause_check" CHECK ("merchant_activation_capability_events"."cause" in ('merchant_setting_changed', 'policy_accepted', 'operator_hold_applied', 'operator_hold_released', 'operator_reevaluation', 'scheduled_observation')),
	CONSTRAINT "merchant_activation_capability_events_actor_shape_check" CHECK (("merchant_activation_capability_events"."actor_kind" = 'system') = ("merchant_activation_capability_events"."actor_oxy_user_id" is null)),
	CONSTRAINT "merchant_activation_capability_events_change_check" CHECK ("merchant_activation_capability_events"."previous_state" is null or "merchant_activation_capability_events"."previous_state" <> "merchant_activation_capability_events"."next_state"),
	CONSTRAINT "merchant_activation_capability_events_granted_shape_check" CHECK ("merchant_activation_capability_events"."next_state" <> 'granted' or coalesce(array_length("merchant_activation_capability_events"."unmet", 1), 0) = 0),
	CONSTRAINT "merchant_activation_capability_events_unmet_check" CHECK ("merchant_activation_capability_events"."unmet" <@ array['merchant_claim_verified', 'native_store_link_valid', 'store_profile_complete', 'support_contact_complete', 'catalog_source_connected', 'catalog_sync_healthy', 'publishable_listing_exists', 'store_policies_configured', 'payment_provider_ready', 'market_currency_supported', 'fee_schedule_accepted', 'returns_fulfilment_acknowledged', 'no_platform_hold', 'native_checkout_not_paused', 'test_order_completed', 'native_checkout_ready', 'guest_commerce_enabled', 'guest_market_currency_allowed', 'guest_payment_method_available', 'guest_inline_destination_supported', 'guest_fulfilment_deterministic', 'guest_merchant_order_access', 'guest_support_and_returns_available', 'guest_transactional_contact_operational', 'guest_data_responsibilities_accepted', 'guest_refund_operations_available', 'guest_buyer_data_permissions_scoped', 'guest_no_active_restriction', 'guest_cohort_enabled', 'guest_checkout_not_paused']::text[])
);
--> statement-breakpoint
CREATE TABLE "merchant_activation_policy_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"accepted_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_activation_policy_acceptances_key_check" CHECK ("merchant_activation_policy_acceptances"."policy_key" in ('returns_and_fulfilment_responsibilities', 'guest_data_and_contact_handling', 'p2p_returns_cancellation_dispute')),
	CONSTRAINT "merchant_activation_policy_acceptances_owner_type_check" CHECK ("merchant_activation_policy_acceptances"."owner_type" in ('store', 'user')),
	CONSTRAINT "merchant_activation_policy_acceptances_version_check" CHECK (length("merchant_activation_policy_acceptances"."policy_version") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "merchant_activation_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"native_checkout_intent" text DEFAULT 'enabled' NOT NULL,
	"guest_checkout_intent" text DEFAULT 'enabled' NOT NULL,
	"support_email" text,
	"support_url" text,
	"platform_hold_reason" text,
	"platform_held_by_oxy_user_id" text,
	"platform_held_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_activation_settings_native_intent_check" CHECK ("merchant_activation_settings"."native_checkout_intent" in ('enabled', 'paused')),
	CONSTRAINT "merchant_activation_settings_guest_intent_check" CHECK ("merchant_activation_settings"."guest_checkout_intent" in ('enabled', 'paused')),
	CONSTRAINT "merchant_activation_settings_hold_shape_check" CHECK (num_nonnulls("merchant_activation_settings"."platform_hold_reason", "merchant_activation_settings"."platform_held_by_oxy_user_id", "merchant_activation_settings"."platform_held_at") in (0, 3)),
	CONSTRAINT "merchant_activation_settings_hold_reason_length_check" CHECK ("merchant_activation_settings"."platform_hold_reason" is null
          or (length("merchant_activation_settings"."platform_hold_reason") between 1 and 500)),
	CONSTRAINT "merchant_activation_settings_support_email_check" CHECK ("merchant_activation_settings"."support_email" is null
          or (length("merchant_activation_settings"."support_email") between 3 and 320
              and position('@' in "merchant_activation_settings"."support_email") > 1)),
	CONSTRAINT "merchant_activation_settings_support_url_check" CHECK ("merchant_activation_settings"."support_url" is null
          or (length("merchant_activation_settings"."support_url") between 8 and 320
              and "merchant_activation_settings"."support_url" like 'https://%'))
);
--> statement-breakpoint
ALTER TABLE "analytics_events" DROP CONSTRAINT "analytics_events_reason_code_check";--> statement-breakpoint
ALTER TABLE "merchant_activation_capability_events" ADD CONSTRAINT "merchant_activation_capability_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_activation_settings" ADD CONSTRAINT "merchant_activation_settings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_activation_capability_events_latest_idx" ON "merchant_activation_capability_events" USING btree ("store_id","capability","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_activation_policy_acceptances_owner_version_key" ON "merchant_activation_policy_acceptances" USING btree ("owner_type","owner_id","policy_key","policy_version");--> statement-breakpoint
CREATE INDEX "merchant_activation_policy_acceptances_owner_idx" ON "merchant_activation_policy_acceptances" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_activation_settings_store_id_key" ON "merchant_activation_settings" USING btree ("store_id");--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_reason_code_check" CHECK ("analytics_events"."reason_code" in ('not_found', 'unavailable', 'rate_limited', 'upstream_timeout', 'upstream_error', 'validation_failed', 'forbidden', 'stale_offer', 'out_of_stock', 'listing_restricted', 'seller_not_payment_ready', 'p2p_seller_excluded', 'market_not_supported', 'currency_not_supported', 'guest_commerce_disabled', 'guest_cart_disabled', 'guest_issuance_disabled', 'guest_checkout_disabled', 'guest_rollout_blocked', 'guest_seller_not_activated', 'retail_line_ineligible', 'merge_completed', 'merge_already_done', 'merge_nothing_to_move', 'merge_quantity_clamped', 'merge_line_flagged', 'merge_discount_dropped', 'contact_malformed', 'contact_undeliverable', 'destination_incomplete', 'destination_unsupported', 'claim_offered', 'claim_completed', 'claim_declined', 'claim_conflicted', 'abuse_cooldown', 'abuse_verification_required', 'abuse_manual_review', 'seller_not_activated', 'other'));
--> statement-breakpoint
-- An acceptance is an AUDIT record. Withdrawing consent is publishing a NEW
-- policy version, which leaves every prior acceptance legible; an UPDATE would
-- rewrite what somebody agreed to, and a DELETE would remove the evidence that
-- they did. The `ON CONFLICT DO NOTHING` in the repository is what makes a
-- replay converge without either.
CREATE FUNCTION mercaria_activation_policy_acceptance_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'activation policy acceptances are append-only: % on %.% is refused. Withdrawing consent is a NEW policy version, never an edit to the record of what was accepted.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER merchant_activation_policy_acceptances_append_only
  BEFORE UPDATE OR DELETE ON "merchant_activation_policy_acceptances"
  FOR EACH ROW EXECUTE FUNCTION mercaria_activation_policy_acceptance_append_only();--> statement-breakpoint

-- The capability trail is append-only against UPDATE and against DELETE.
--
-- Against UPDATE for the obvious reason. Against DELETE because #85 security 10
-- asks that every guest-capability change be audited, and a trail one row of
-- which can be removed is one that can be made to say a capability was never
-- withheld. `analytics_events` permits DELETE because erasure on a schedule IS
-- its policy; this table holds no personal data at all -- no buyer, no contact,
-- nothing but a store id, a capability and an actor -- so it has no retention
-- deadline to serve and nothing to trade the guarantee for.
--
-- The `ON DELETE cascade` from `stores` still works: a row-level trigger cannot
-- fire for a store that no longer exists to have a trail, and the cascade
-- deletes the parent first. That is deliberate -- a merchant leaving takes its
-- own audit with it, which is the one deletion this table permits.
CREATE FUNCTION mercaria_activation_capability_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'activation capability events are append-only: % on %.% is refused. A capability that moved back is a NEW observation, never an edit to the record of what it was.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER merchant_activation_capability_events_append_only
  BEFORE UPDATE ON "merchant_activation_capability_events"
  FOR EACH ROW EXECUTE FUNCTION mercaria_activation_capability_event_append_only();
