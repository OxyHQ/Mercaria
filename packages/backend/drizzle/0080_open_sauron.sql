-- oxy:deploy-phase=pre
-- oxy:rollback=restore: merchant_activation_capability_events_unmet_check is widened; the previous form is in the #85 migration and re-adding it fails against any event citing an added unmet reason
--
-- Merchant activation: the fulfilment-mode requirement registry (#85, #93).
--
-- ONE statement pair, and it is a WIDENING.
-- `merchant_activation_capability_events.unmet` is CHECKed element-wise against
-- `MERCHANT_ACTIVATION_REQUIREMENT_KEYS`, and that tuple gains
-- `shipping_fulfilment_available` and `pickup_fulfilment_available` — 30 values
-- in, 32 out, losing none. drizzle-kit renders a widening as DROP + ADD; it is
-- still a widening.
--
-- ## Why `pre`
--
-- Ask what write the PREVIOUS image performs that this statement breaks: none.
-- The serving image cannot emit either new key — it has no derivation that
-- produces one — so the wider CHECK constrains nothing it does. The NEW image
-- does emit them, in the audit row written whenever `shipping_checkout` or
-- `pickup_checkout` changes state, so the constraint has to be wide BEFORE the
-- rollout rather than after it. A narrowing of this tuple would be `post`; this
-- is the opposite.
--
-- NOTHING is hand-written below. A regeneration reproduces this file exactly,
-- and this header is the only thing it would drop.

ALTER TABLE "merchant_activation_capability_events" DROP CONSTRAINT "merchant_activation_capability_events_unmet_check";--> statement-breakpoint
ALTER TABLE "merchant_activation_capability_events" ADD CONSTRAINT "merchant_activation_capability_events_unmet_check" CHECK ("merchant_activation_capability_events"."unmet" <@ array['merchant_claim_verified', 'native_store_link_valid', 'store_profile_complete', 'support_contact_complete', 'catalog_source_connected', 'catalog_sync_healthy', 'publishable_listing_exists', 'store_policies_configured', 'payment_provider_ready', 'market_currency_supported', 'fee_schedule_accepted', 'returns_fulfilment_acknowledged', 'no_platform_hold', 'native_checkout_not_paused', 'test_order_completed', 'native_checkout_ready', 'guest_commerce_enabled', 'guest_market_currency_allowed', 'guest_payment_method_available', 'guest_inline_destination_supported', 'guest_fulfilment_deterministic', 'guest_merchant_order_access', 'guest_support_and_returns_available', 'guest_transactional_contact_operational', 'guest_data_responsibilities_accepted', 'guest_refund_operations_available', 'guest_buyer_data_permissions_scoped', 'guest_no_active_restriction', 'guest_cohort_enabled', 'guest_checkout_not_paused', 'shipping_fulfilment_available', 'pickup_fulfilment_available']::text[]);
