-- oxy:deploy-phase=pre
CREATE TABLE "referral_attributions" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"program_version_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_ref" text NOT NULL,
	"winning_touch_id" text,
	"winning_code_id" text NOT NULL,
	"evidence_touch_kind" text NOT NULL,
	"evidence_occurred_at" timestamp with time zone NOT NULL,
	"attribution_policy" text NOT NULL,
	"rule_version_ref" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"conflict_reason" text,
	"resolved_at" timestamp with time zone,
	"supersedes_attribution_id" text,
	"original_actor_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_attributions_subject_kind_check" CHECK ("referral_attributions"."subject_kind" in ('oxy_user', 'guest_checkout', 'merchant')),
	CONSTRAINT "referral_attributions_evidence_touch_kind_check" CHECK ("referral_attributions"."evidence_touch_kind" in ('link_click', 'code_entry_in_app', 'code_entry_at_checkout')),
	CONSTRAINT "referral_attributions_attribution_policy_check" CHECK ("referral_attributions"."attribution_policy" in ('last_touch')),
	CONSTRAINT "referral_attributions_state_check" CHECK ("referral_attributions"."state" in ('active', 'superseded', 'conflicted', 'invalidated', 'corrected')),
	CONSTRAINT "referral_attributions_conflict_reason_check" CHECK ("referral_attributions"."conflict_reason" in ('competing_touch', 'duplicate_subject', 'self_referral', 'partner_suspended', 'program_retired', 'operator_correction', 'operator_invalidation', 'other')),
	CONSTRAINT "referral_attributions_original_actor_kind_check" CHECK ("referral_attributions"."original_actor_kind" in ('guest_session', 'oxy_user')),
	CONSTRAINT "referral_attributions_identity_check" CHECK (length("referral_attributions"."program_id") > 0 and length("referral_attributions"."subject_ref") > 0
          and length("referral_attributions"."rule_version_ref") > 0),
	CONSTRAINT "referral_attributions_resolution_check" CHECK ((("referral_attributions"."state" = 'active') = ("referral_attributions"."conflict_reason" is null))
          and (("referral_attributions"."state" = 'active') = ("referral_attributions"."resolved_at" is null))),
	CONSTRAINT "referral_attributions_supersedes_check" CHECK ("referral_attributions"."supersedes_attribution_id" is null or "referral_attributions"."supersedes_attribution_id" <> "referral_attributions"."id"),
	CONSTRAINT "referral_attributions_expiry_check" CHECK ("referral_attributions"."expires_at" > "referral_attributions"."evidence_occurred_at")
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"program_version_id" text NOT NULL,
	"code" text NOT NULL,
	"alias_of_code_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"destination_type" text,
	"destination_ref" text,
	"campaign_ref" text,
	"content_key" text,
	"market" text,
	"locale" text,
	"activated_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"max_uses" integer,
	"disclosure_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_codes_status_check" CHECK ("referral_codes"."status" in ('active', 'paused', 'expired', 'revoked', 'retired')),
	CONSTRAINT "referral_codes_destination_type_check" CHECK ("referral_codes"."destination_type" in ('home', 'listing', 'collection', 'store')),
	CONSTRAINT "referral_codes_code_check" CHECK ("referral_codes"."code" ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
	CONSTRAINT "referral_codes_destination_check" CHECK (("referral_codes"."destination_type" is null and "referral_codes"."destination_ref" is null)
          or ("referral_codes"."destination_type" = 'home' and "referral_codes"."destination_ref" is null)
          or ("referral_codes"."destination_type" in ('listing', 'collection', 'store')
              and "referral_codes"."destination_ref" is not null and length("referral_codes"."destination_ref") > 0)),
	CONSTRAINT "referral_codes_market_check" CHECK ("referral_codes"."market" is null or ("referral_codes"."market" = upper("referral_codes"."market") and length("referral_codes"."market") = 2)),
	CONSTRAINT "referral_codes_max_uses_check" CHECK ("referral_codes"."max_uses" is null or "referral_codes"."max_uses" > 0),
	CONSTRAINT "referral_codes_status_times_check" CHECK (("referral_codes"."status" <> 'revoked' or "referral_codes"."revoked_at" is not null)
          and ("referral_codes"."status" <> 'retired' or "referral_codes"."retired_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "referral_conversions" (
	"id" text PRIMARY KEY NOT NULL,
	"attribution_id" text NOT NULL,
	"program_version_id" text NOT NULL,
	"conversion_type" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_event_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason_code" text,
	"revenue_base_ref" text,
	"corrected_by_conversion_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_conversions_conversion_type_check" CHECK ("referral_conversions"."conversion_type" in ('first_qualifying_paid_order', 'merchant_activation')),
	CONSTRAINT "referral_conversions_source_kind_check" CHECK ("referral_conversions"."source_kind" in ('order', 'merchant_activation', 'subscription', 'affiliate_commission')),
	CONSTRAINT "referral_conversions_state_check" CHECK ("referral_conversions"."state" in ('eligible', 'pending', 'rejected', 'reversed', 'corrected')),
	CONSTRAINT "referral_conversions_reason_code_check" CHECK ("referral_conversions"."reason_code" in ('zero_base', 'budget_exhausted', 'cap_reached', 'self_referral', 'seller_own_order', 'partner_suspended', 'program_retired', 'attribution_expired', 'refund_reversed', 'fraud_invalidated', 'other')),
	CONSTRAINT "referral_conversions_identity_check" CHECK (length("referral_conversions"."source_ref") > 0 and length("referral_conversions"."source_event_id") > 0
          and length("referral_conversions"."idempotency_key") > 0),
	CONSTRAINT "referral_conversions_reason_check" CHECK ("referral_conversions"."state" not in ('rejected', 'reversed', 'corrected') or "referral_conversions"."reason_code" is not null),
	CONSTRAINT "referral_conversions_verified_check" CHECK ("referral_conversions"."state" <> 'eligible' or "referral_conversions"."verified_at" is not null),
	CONSTRAINT "referral_conversions_corrected_check" CHECK (("referral_conversions"."state" = 'corrected') = ("referral_conversions"."corrected_by_conversion_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "referral_events" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_ref" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_events_subject_type_check" CHECK ("referral_events"."subject_type" in ('program', 'partner', 'code', 'link', 'attribution', 'conversion')),
	CONSTRAINT "referral_events_action_check" CHECK ("referral_events"."action" in ('program_drafted', 'program_published', 'program_paused', 'program_resumed', 'program_ended', 'program_retired', 'partner_applied', 'partner_invited', 'partner_approved', 'partner_suspended', 'partner_reinstated', 'partner_terminated', 'appeal_opened', 'appeal_resolved', 'code_issued', 'code_retired', 'link_issued', 'link_revoked', 'attribution_created', 'attribution_superseded', 'attribution_refused', 'attribution_invalidated', 'attribution_corrected', 'subject_merge_redirected', 'conversion_recorded', 'conversion_verified', 'conversion_rejected', 'conversion_reversed', 'conversion_corrected')),
	CONSTRAINT "referral_events_actor_kind_check" CHECK ("referral_events"."actor_kind" in ('partner', 'operator', 'system')),
	CONSTRAINT "referral_events_subject_id_check" CHECK (length("referral_events"."subject_id") > 0),
	CONSTRAINT "referral_events_reason_check" CHECK (length("referral_events"."reason") > 0 and length("referral_events"."reason") <= 2000),
	CONSTRAINT "referral_events_actor_check" CHECK ("referral_events"."actor_kind" = 'system' or "referral_events"."actor_ref" is not null)
);
--> statement-breakpoint
CREATE TABLE "referral_links" (
	"id" text PRIMARY KEY NOT NULL,
	"code_id" text NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"destination_type" text,
	"destination_ref" text,
	"campaign_ref" text,
	"content_key" text,
	"market" text,
	"locale" text,
	"activated_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"max_clicks" integer,
	"click_count" bigint DEFAULT 0 NOT NULL,
	"disclosure_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_links_status_check" CHECK ("referral_links"."status" in ('active', 'paused', 'expired', 'revoked', 'retired')),
	CONSTRAINT "referral_links_destination_type_check" CHECK ("referral_links"."destination_type" in ('home', 'listing', 'collection', 'store')),
	CONSTRAINT "referral_links_token_check" CHECK (length("referral_links"."token") > 0),
	CONSTRAINT "referral_links_destination_check" CHECK (("referral_links"."destination_type" is null and "referral_links"."destination_ref" is null)
          or ("referral_links"."destination_type" = 'home' and "referral_links"."destination_ref" is null)
          or ("referral_links"."destination_type" in ('listing', 'collection', 'store')
              and "referral_links"."destination_ref" is not null and length("referral_links"."destination_ref") > 0)),
	CONSTRAINT "referral_links_market_check" CHECK ("referral_links"."market" is null or ("referral_links"."market" = upper("referral_links"."market") and length("referral_links"."market") = 2)),
	CONSTRAINT "referral_links_click_limit_check" CHECK (("referral_links"."max_clicks" is null or "referral_links"."max_clicks" > 0) and "referral_links"."click_count" >= 0
          and ("referral_links"."max_clicks" is null or "referral_links"."click_count" <= "referral_links"."max_clicks")),
	CONSTRAINT "referral_links_status_times_check" CHECK ("referral_links"."status" <> 'revoked' or "referral_links"."revoked_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "referral_partners" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"display_name" text NOT NULL,
	"state" text DEFAULT 'applied' NOT NULL,
	"applied_at" timestamp with time zone,
	"invited_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"terms_version" text,
	"terms_accepted_at" timestamp with time zone,
	"promotion_methods" text[] DEFAULT '{}' NOT NULL,
	"payout_beneficiary_ref" text,
	"tax_readiness" text DEFAULT 'unknown' NOT NULL,
	"identity_readiness" text DEFAULT 'unknown' NOT NULL,
	"payout_readiness" text DEFAULT 'unknown' NOT NULL,
	"risk_state" text DEFAULT 'none' NOT NULL,
	"suspended_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	"appeal_state" text DEFAULT 'none' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_partners_owner_type_check" CHECK ("referral_partners"."owner_type" in ('user', 'store')),
	CONSTRAINT "referral_partners_state_check" CHECK ("referral_partners"."state" in ('applied', 'invited', 'approved', 'suspended', 'terminated')),
	CONSTRAINT "referral_partners_tax_readiness_check" CHECK ("referral_partners"."tax_readiness" in ('unknown', 'pending', 'ready', 'blocked')),
	CONSTRAINT "referral_partners_identity_readiness_check" CHECK ("referral_partners"."identity_readiness" in ('unknown', 'pending', 'ready', 'blocked')),
	CONSTRAINT "referral_partners_payout_readiness_check" CHECK ("referral_partners"."payout_readiness" in ('unknown', 'pending', 'ready', 'blocked')),
	CONSTRAINT "referral_partners_risk_state_check" CHECK ("referral_partners"."risk_state" in ('none', 'under_review', 'cleared', 'confirmed_fraud')),
	CONSTRAINT "referral_partners_appeal_state_check" CHECK ("referral_partners"."appeal_state" in ('none', 'open', 'accepted', 'rejected')),
	CONSTRAINT "referral_partners_promotion_methods_check" CHECK ("referral_partners"."promotion_methods" <@ array['website', 'blog', 'social_media', 'email', 'video', 'podcast', 'events', 'other']::text[]),
	CONSTRAINT "referral_partners_identity_check" CHECK (length("referral_partners"."owner_id") > 0 and length("referral_partners"."display_name") > 0),
	CONSTRAINT "referral_partners_terms_check" CHECK (("referral_partners"."terms_version" is null) = ("referral_partners"."terms_accepted_at" is null)),
	CONSTRAINT "referral_partners_state_times_check" CHECK (("referral_partners"."state" <> 'suspended' or "referral_partners"."suspended_at" is not null)
          and ("referral_partners"."state" <> 'terminated' or "referral_partners"."terminated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "referral_programs" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"public_terms_summary" text NOT NULL,
	"family" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"effective_start_at" timestamp with time zone,
	"effective_end_at" timestamp with time zone,
	"eligible_partner_types" text[] NOT NULL,
	"eligible_subject_kinds" text[] NOT NULL,
	"markets" text[] DEFAULT '{}' NOT NULL,
	"currencies" text[] DEFAULT '{}' NOT NULL,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"commercial_modes" text[] DEFAULT '{}' NOT NULL,
	"attribution_policy" text NOT NULL,
	"attribution_window_days" integer NOT NULL,
	"activation_window_days" integer,
	"qualifying_event_policy" text NOT NULL,
	"commission_rule_ref" text NOT NULL,
	"hold_days" integer NOT NULL,
	"cap_policy_ref" text,
	"payout_policy_ref" text NOT NULL,
	"terms_version" text NOT NULL,
	"disclosure_version" text NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"feature_flag_key" text,
	"cohort_keys" text[] DEFAULT '{}' NOT NULL,
	"published_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_programs_family_check" CHECK ("referral_programs"."family" in ('buyer_referral', 'merchant_referral')),
	CONSTRAINT "referral_programs_status_check" CHECK ("referral_programs"."status" in ('draft', 'scheduled', 'active', 'paused', 'ended', 'retired')),
	CONSTRAINT "referral_programs_attribution_policy_check" CHECK ("referral_programs"."attribution_policy" in ('last_touch')),
	CONSTRAINT "referral_programs_qualifying_event_policy_check" CHECK ("referral_programs"."qualifying_event_policy" in ('first_qualifying_paid_order', 'merchant_activation')),
	CONSTRAINT "referral_programs_eligible_partner_types_check" CHECK ("referral_programs"."eligible_partner_types" <@ array['user', 'store']::text[]),
	CONSTRAINT "referral_programs_eligible_subject_kinds_check" CHECK ("referral_programs"."eligible_subject_kinds" <@ array['oxy_user', 'guest_checkout', 'merchant']::text[]),
	CONSTRAINT "referral_programs_currencies_check" CHECK ("referral_programs"."currencies" <@ array['FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED']::text[]),
	CONSTRAINT "referral_programs_channels_check" CHECK ("referral_programs"."channels" <@ array['storefront', 'pos']::text[]),
	CONSTRAINT "referral_programs_commercial_modes_check" CHECK ("referral_programs"."commercial_modes" <@ array['marketplace', 'p2p', 'retail']::text[]),
	CONSTRAINT "referral_programs_eligibility_nonempty_check" CHECK (cardinality("referral_programs"."eligible_partner_types") > 0 and cardinality("referral_programs"."eligible_subject_kinds") > 0),
	CONSTRAINT "referral_programs_markets_check" CHECK (not ('' = any("referral_programs"."markets"))),
	CONSTRAINT "referral_programs_cohort_keys_check" CHECK (not ('' = any("referral_programs"."cohort_keys"))),
	CONSTRAINT "referral_programs_identity_check" CHECK (length("referral_programs"."program_id") > 0 and "referral_programs"."version" >= 1 and length("referral_programs"."name") > 0
          and length("referral_programs"."public_terms_summary") > 0 and length("referral_programs"."terms_version") > 0
          and length("referral_programs"."disclosure_version") > 0 and length("referral_programs"."commission_rule_ref") > 0
          and length("referral_programs"."payout_policy_ref") > 0 and length("referral_programs"."created_by_oxy_user_id") > 0),
	CONSTRAINT "referral_programs_windows_check" CHECK ("referral_programs"."attribution_window_days" > 0 and "referral_programs"."hold_days" >= 0
          and ("referral_programs"."activation_window_days" is null or "referral_programs"."activation_window_days" > 0)),
	CONSTRAINT "referral_programs_effective_window_check" CHECK ("referral_programs"."effective_end_at" is null or "referral_programs"."effective_start_at" is null
          or "referral_programs"."effective_end_at" > "referral_programs"."effective_start_at"),
	CONSTRAINT "referral_programs_published_check" CHECK ("referral_programs"."status" = 'draft'
          or ("referral_programs"."approved_by_oxy_user_id" is not null and "referral_programs"."published_at" is not null
              and "referral_programs"."effective_start_at" is not null)),
	CONSTRAINT "referral_programs_status_times_check" CHECK (("referral_programs"."status" <> 'paused' or "referral_programs"."paused_at" is not null)
          and ("referral_programs"."status" <> 'ended' or "referral_programs"."ended_at" is not null)
          and ("referral_programs"."status" <> 'retired' or "referral_programs"."retired_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "referral_subject_redirects" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"from_ref" text NOT NULL,
	"to_ref" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_ref" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_subject_redirects_subject_kind_check" CHECK ("referral_subject_redirects"."subject_kind" in ('oxy_user', 'guest_checkout', 'merchant')),
	CONSTRAINT "referral_subject_redirects_actor_kind_check" CHECK ("referral_subject_redirects"."actor_kind" in ('partner', 'operator', 'system')),
	CONSTRAINT "referral_subject_redirects_refs_check" CHECK (length("referral_subject_redirects"."from_ref") > 0 and length("referral_subject_redirects"."to_ref") > 0 and "referral_subject_redirects"."from_ref" <> "referral_subject_redirects"."to_ref"),
	CONSTRAINT "referral_subject_redirects_reason_check" CHECK (length("referral_subject_redirects"."reason") > 0 and length("referral_subject_redirects"."reason") <= 2000),
	CONSTRAINT "referral_subject_redirects_actor_check" CHECK ("referral_subject_redirects"."actor_kind" = 'system' or "referral_subject_redirects"."actor_ref" is not null)
);
--> statement-breakpoint
CREATE TABLE "referral_touches" (
	"id" text PRIMARY KEY NOT NULL,
	"program_version_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"code_id" text NOT NULL,
	"link_id" text,
	"touch_kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"client_surface" text NOT NULL,
	"destination_type" text,
	"destination_ref" text,
	"actor_kind" text NOT NULL,
	"guest_session_ref" text,
	"oxy_user_id" text,
	"merchant_candidate_ref" text,
	"traffic_class" text DEFAULT 'organic' NOT NULL,
	"consent_mode" text NOT NULL,
	"attribution_window_expires_at" timestamp with time zone NOT NULL,
	"campaign_ref" text,
	"content_key" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_touches_touch_kind_check" CHECK ("referral_touches"."touch_kind" in ('link_click', 'code_entry_in_app', 'code_entry_at_checkout')),
	CONSTRAINT "referral_touches_client_surface_check" CHECK ("referral_touches"."client_surface" in ('web', 'ios', 'android', 'pos', 'other')),
	CONSTRAINT "referral_touches_destination_type_check" CHECK ("referral_touches"."destination_type" in ('home', 'listing', 'collection', 'store')),
	CONSTRAINT "referral_touches_actor_kind_check" CHECK ("referral_touches"."actor_kind" in ('guest_session', 'oxy_user')),
	CONSTRAINT "referral_touches_traffic_class_check" CHECK ("referral_touches"."traffic_class" in ('organic', 'bot', 'preview', 'internal')),
	CONSTRAINT "referral_touches_consent_mode_check" CHECK ("referral_touches"."consent_mode" in ('granted', 'denied', 'unknown')),
	CONSTRAINT "referral_touches_actor_check" CHECK ((("referral_touches"."actor_kind" = 'guest_session') = ("referral_touches"."guest_session_ref" is not null))
          and (("referral_touches"."actor_kind" = 'oxy_user') = ("referral_touches"."oxy_user_id" is not null))),
	CONSTRAINT "referral_touches_actor_nonempty_check" CHECK (("referral_touches"."guest_session_ref" is null or length("referral_touches"."guest_session_ref") > 0)
          and ("referral_touches"."oxy_user_id" is null or length("referral_touches"."oxy_user_id") > 0)),
	CONSTRAINT "referral_touches_link_check" CHECK ("referral_touches"."touch_kind" <> 'link_click' or "referral_touches"."link_id" is not null),
	CONSTRAINT "referral_touches_expiry_order_check" CHECK ("referral_touches"."expires_at" >= "referral_touches"."attribution_window_expires_at"
          and "referral_touches"."attribution_window_expires_at" > "referral_touches"."occurred_at")
);
--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_program_version_id_referral_programs_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "public"."referral_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_winning_code_id_referral_codes_id_fk" FOREIGN KEY ("winning_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_supersedes_attribution_id_referral_attributions_id_fk" FOREIGN KEY ("supersedes_attribution_id") REFERENCES "public"."referral_attributions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_program_version_id_referral_programs_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "public"."referral_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_alias_of_code_id_referral_codes_id_fk" FOREIGN KEY ("alias_of_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_conversions" ADD CONSTRAINT "referral_conversions_attribution_id_referral_attributions_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "public"."referral_attributions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_conversions" ADD CONSTRAINT "referral_conversions_program_version_id_referral_programs_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "public"."referral_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_conversions" ADD CONSTRAINT "referral_conversions_corrected_by_conversion_id_referral_conversions_id_fk" FOREIGN KEY ("corrected_by_conversion_id") REFERENCES "public"."referral_conversions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_links" ADD CONSTRAINT "referral_links_code_id_referral_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."referral_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_touches" ADD CONSTRAINT "referral_touches_program_version_id_referral_programs_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "public"."referral_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_touches" ADD CONSTRAINT "referral_touches_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_touches" ADD CONSTRAINT "referral_touches_code_id_referral_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."referral_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_touches" ADD CONSTRAINT "referral_touches_link_id_referral_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."referral_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_attributions_active_winner_key" ON "referral_attributions" USING btree ("program_id","subject_kind","subject_ref") WHERE "referral_attributions"."state" = 'active';--> statement-breakpoint
CREATE INDEX "referral_attributions_partner_id_idx" ON "referral_attributions" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_attributions_subject_idx" ON "referral_attributions" USING btree ("subject_kind","subject_ref","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_attributions_expires_at_idx" ON "referral_attributions" USING btree ("expires_at") WHERE "referral_attributions"."state" = 'active';--> statement-breakpoint
CREATE INDEX "referral_attributions_program_version_id_idx" ON "referral_attributions" USING btree ("program_version_id");--> statement-breakpoint
CREATE INDEX "referral_attributions_supersedes_idx" ON "referral_attributions" USING btree ("supersedes_attribution_id") WHERE "referral_attributions"."supersedes_attribution_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "referral_codes_partner_id_idx" ON "referral_codes" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_codes_program_version_id_idx" ON "referral_codes" USING btree ("program_version_id");--> statement-breakpoint
CREATE INDEX "referral_codes_alias_of_code_id_idx" ON "referral_codes" USING btree ("alias_of_code_id") WHERE "referral_codes"."alias_of_code_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_conversions_idempotency_key_key" ON "referral_conversions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_conversions_source_event_key" ON "referral_conversions" USING btree ("source_kind","source_event_id");--> statement-breakpoint
CREATE INDEX "referral_conversions_attribution_id_idx" ON "referral_conversions" USING btree ("attribution_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_conversions_source_idx" ON "referral_conversions" USING btree ("source_kind","source_ref");--> statement-breakpoint
CREATE INDEX "referral_conversions_state_created_at_idx" ON "referral_conversions" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "referral_events_subject_idx" ON "referral_events" USING btree ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_links_token_key" ON "referral_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "referral_links_code_id_idx" ON "referral_links" USING btree ("code_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "referral_partners_owner_key" ON "referral_partners" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "referral_partners_state_idx" ON "referral_partners" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_programs_program_id_version_key" ON "referral_programs" USING btree ("program_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_programs_one_active_key" ON "referral_programs" USING btree ("program_id") WHERE "referral_programs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "referral_programs_status_start_idx" ON "referral_programs" USING btree ("status","effective_start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_subject_redirects_from_key" ON "referral_subject_redirects" USING btree ("subject_kind","from_ref");--> statement-breakpoint
CREATE INDEX "referral_subject_redirects_to_idx" ON "referral_subject_redirects" USING btree ("subject_kind","to_ref");--> statement-breakpoint
CREATE INDEX "referral_touches_code_id_occurred_at_idx" ON "referral_touches" USING btree ("code_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_touches_partner_id_occurred_at_idx" ON "referral_touches" USING btree ("partner_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_touches_guest_session_ref_idx" ON "referral_touches" USING btree ("guest_session_ref","occurred_at" DESC NULLS LAST) WHERE "referral_touches"."guest_session_ref" is not null;--> statement-breakpoint
CREATE INDEX "referral_touches_oxy_user_id_idx" ON "referral_touches" USING btree ("oxy_user_id","occurred_at" DESC NULLS LAST) WHERE "referral_touches"."oxy_user_id" is not null;--> statement-breakpoint
CREATE INDEX "referral_touches_window_expires_at_idx" ON "referral_touches" USING btree ("attribution_window_expires_at");--> statement-breakpoint
CREATE INDEX "referral_touches_expires_at_idx" ON "referral_touches" USING btree ("expires_at");