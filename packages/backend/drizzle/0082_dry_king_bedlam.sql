-- oxy:deploy-phase=pre
--
-- Affiliate outbound redirects, click records and commission reconciliation
-- (#67, part of #37).
--
-- Additive throughout: six new tables, plus TWO CHECK WIDENINGS.
-- `affiliate_receivable` and `affiliate_commission_revenue` join
-- `LEDGER_ACCOUNTS` (15 -> 17), and three `affiliate_commission_*` kinds join
-- `LEDGER_TRANSACTION_KINDS` (17 -> 20), so `ledger_entries.account` and
-- `ledger_transactions.kind` each get their CHECK dropped and re-added over a
-- strict SUPERSET. Verified element by element against the tuples on
-- origin/main rather than by eye -- #145 widened both of these on the same
-- rebase, so an eyeballed diff here would have silently dropped its four
-- referral kinds and its two referral accounts.
--
-- ## Why `pre`
--
-- The real question, not its paraphrase: does any statement here break a write
-- the CURRENTLY SERVING image performs? It does not. Every table created here
-- is one that image has never heard of, so there is no write to break. The two
-- re-added CHECKs admit every value the old ones did and five more, so every
-- row the serving image can write still satisfies them -- and that image cannot
-- write any of the five new values, because none is in the tuples it was
-- compiled against. The drop-and-re-add is invisible to it in both directions.
--
-- ## The host predicate uses `[.]`, and that is load-bearing
--
-- `affiliate_outbound_hosts_shape_check` reads `([.][a-z0-9]...)`, never
-- `(\.[a-z0-9]...)`. The schema declares it inside a tagged TEMPLATE LITERAL,
-- where JavaScript cooks escapes before drizzle sees the string -- so the
-- backslash spelling loses its backslash and reaches Postgres as `.`, which
-- matches ANY character and ADMITS `localhost`, the single-label internal name
-- the dot-separated-tail rule exists to forbid. That shipped once and was
-- caught only by a real-server test asserting a REFUSAL; `tsc`, drizzle-kit and
-- the migrator all accept the broken form happily. If this file is ever
-- regenerated, confirm the emitted predicate still reads `([.]`.
--
-- ## The hand-written half, and where it goes on a regeneration
--
-- drizzle-kit models no trigger, so the block at the FOOT of this file is
-- re-applied by hand after any regeneration. Three trigger pairs:
--
--  1. `affiliate_transaction_observations` and `affiliate_commission_postings`
--     refuse UPDATE **and** DELETE. Acceptance 4 -- "reversed commissions update
--     reporting without deleting history" -- IS that pair of refusals. A
--     posting that could be deleted would let somebody unwind money outside the
--     ledger's own reversing-transaction rule.
--  2. `affiliate_outbound_clicks` refuses UPDATE and PERMITS DELETE, inverting
--     that posture deliberately and matching `analytics_events`: erasure on a
--     schedule IS the retention policy here, and a trigger refusing DELETE
--     would make the shared expiry sweep fail SILENTLY on every row it is
--     contractually obliged to remove.
--
-- Each is statement-level, because none of them reads the row: they raise
-- unconditionally, so a thousand-row UPDATE is refused once rather than a
-- thousand times.
--
-- ## Re-applying this header
--
-- Prepend it as a WHOLE literal. Do NOT reconstruct it by searching the
-- generated file for the first statement: an earlier attempt searched for the
-- two words that open a table definition, matched this very paragraph instead,
-- truncated the header mid-sentence, and thereby commented out the first
-- statement's opening line -- which failed at APPLY time with a syntax error
-- naming a column. #145 hit the identical trap with its trigger banner.

CREATE TABLE "affiliate_commission_postings" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"ledger_transaction_id" text NOT NULL,
	"kind" text NOT NULL,
	"revision" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "affiliate_commission_postings_kind_check" CHECK ("affiliate_commission_postings"."kind" in ('accrual', 'reversal', 'settlement')),
	CONSTRAINT "affiliate_commission_postings_currency_check" CHECK ("affiliate_commission_postings"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "affiliate_commission_postings_revision_check" CHECK ("affiliate_commission_postings"."revision" >= 1),
	CONSTRAINT "affiliate_commission_postings_amount_check" CHECK ("affiliate_commission_postings"."amount_minor" <> 0)
);
--> statement-breakpoint
CREATE TABLE "affiliate_outbound_clicks" (
	"id" text PRIMARY KEY NOT NULL,
	"offer_id" text NOT NULL,
	"canonical_variant_id" text,
	"merchant_id" text,
	"storefront_id" text,
	"catalog_source_id" text,
	"affiliate_network" text,
	"affiliate_program_ref" text,
	"affiliate_publisher_ref" text,
	"destination_host" text,
	"destination_kind" text,
	"market" text,
	"client_surface" text NOT NULL,
	"traffic_class" text NOT NULL,
	"traffic_signal" text NOT NULL,
	"consent_mode" text NOT NULL,
	"disposition" text NOT NULL,
	"refusal_reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "affiliate_outbound_clicks_surface_check" CHECK ("affiliate_outbound_clicks"."client_surface" in ('web', 'ios', 'android', 'other')),
	CONSTRAINT "affiliate_outbound_clicks_traffic_check" CHECK ("affiliate_outbound_clicks"."traffic_class" in ('organic', 'bot', 'preview', 'internal')),
	CONSTRAINT "affiliate_outbound_clicks_consent_check" CHECK ("affiliate_outbound_clicks"."consent_mode" in ('granted', 'denied', 'unknown')),
	CONSTRAINT "affiliate_outbound_clicks_disposition_check" CHECK ("affiliate_outbound_clicks"."disposition" in ('redirected', 'refused')),
	CONSTRAINT "affiliate_outbound_clicks_refusal_check" CHECK ("affiliate_outbound_clicks"."refusal_reason" in ('offer_not_found', 'offer_retired', 'offer_not_current', 'no_destination', 'outbound_not_permitted', 'token_invalid', 'destination_unparseable', 'destination_scheme_not_https', 'destination_credentials_present', 'destination_host_not_allowlisted', 'destination_is_mercaria', 'native_offer')),
	CONSTRAINT "affiliate_outbound_clicks_destination_kind_check" CHECK ("affiliate_outbound_clicks"."destination_kind" in ('network_redirector', 'merchant_site')),
	CONSTRAINT "affiliate_outbound_clicks_outcome_shape_check" CHECK (("affiliate_outbound_clicks"."disposition" = 'redirected') = ("affiliate_outbound_clicks"."refusal_reason" is null)
        and ("affiliate_outbound_clicks"."disposition" = 'redirected') = ("affiliate_outbound_clicks"."destination_host" is not null)
        and ("affiliate_outbound_clicks"."disposition" = 'redirected') = ("affiliate_outbound_clicks"."destination_kind" is not null)),
	CONSTRAINT "affiliate_outbound_clicks_signal_check" CHECK (length("affiliate_outbound_clicks"."traffic_signal") > 0),
	CONSTRAINT "affiliate_outbound_clicks_market_check" CHECK ("affiliate_outbound_clicks"."market" is null or "affiliate_outbound_clicks"."market" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "affiliate_outbound_hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"catalog_source_id" text NOT NULL,
	"host" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"approved_by_oxy_user_id" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_oxy_user_id" text,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "affiliate_outbound_hosts_kind_check" CHECK ("affiliate_outbound_hosts"."kind" in ('network_redirector', 'merchant_site')),
	CONSTRAINT "affiliate_outbound_hosts_shape_check" CHECK ("affiliate_outbound_hosts"."host" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
        and length("affiliate_outbound_hosts"."host") <= 253),
	CONSTRAINT "affiliate_outbound_hosts_reason_check" CHECK (length("affiliate_outbound_hosts"."reason") > 0),
	CONSTRAINT "affiliate_outbound_hosts_revocation_check" CHECK (("affiliate_outbound_hosts"."revoked_at" is null) = ("affiliate_outbound_hosts"."revoked_by_oxy_user_id" is null)
        and ("affiliate_outbound_hosts"."revoked_at" is null) = ("affiliate_outbound_hosts"."revoked_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "affiliate_report_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"network" text NOT NULL,
	"account_ref" text NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"failure_reason" text,
	"transactions_seen" integer DEFAULT 0 NOT NULL,
	"transactions_created" integer DEFAULT 0 NOT NULL,
	"transactions_state_changed" integer DEFAULT 0 NOT NULL,
	"transactions_amount_changed" integer DEFAULT 0 NOT NULL,
	"transactions_restated" integer DEFAULT 0 NOT NULL,
	"transactions_unchanged" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "affiliate_report_runs_network_check" CHECK ("affiliate_report_runs"."network" in ('awin', 'ebay')),
	CONSTRAINT "affiliate_report_runs_state_check" CHECK ("affiliate_report_runs"."state" in ('running', 'completed', 'failed')),
	CONSTRAINT "affiliate_report_runs_failure_check" CHECK ("affiliate_report_runs"."failure_reason" in ('credential_unavailable', 'auth_failure', 'rate_limited', 'upstream_unavailable', 'response_unreadable', 'budget_exhausted', 'network_not_configured')),
	CONSTRAINT "affiliate_report_runs_counters_total_check" CHECK ("affiliate_report_runs"."state" <> 'completed' or "affiliate_report_runs"."transactions_seen" =
        "affiliate_report_runs"."transactions_created" + "affiliate_report_runs"."transactions_state_changed" + "affiliate_report_runs"."transactions_amount_changed"
        + "affiliate_report_runs"."transactions_restated" + "affiliate_report_runs"."transactions_unchanged"),
	CONSTRAINT "affiliate_report_runs_failure_shape_check" CHECK (("affiliate_report_runs"."state" = 'failed') = ("affiliate_report_runs"."failure_reason" is not null)),
	CONSTRAINT "affiliate_report_runs_completion_shape_check" CHECK (("affiliate_report_runs"."state" = 'running') = ("affiliate_report_runs"."completed_at" is null)),
	CONSTRAINT "affiliate_report_runs_window_check" CHECK ("affiliate_report_runs"."window_from" <= "affiliate_report_runs"."window_to")
);
--> statement-breakpoint
CREATE TABLE "affiliate_transaction_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"report_run_id" text NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"order_value_amount" bigint,
	"order_value_currency" text,
	"commission_amount" bigint NOT NULL,
	"commission_currency" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"network_processed_at" timestamp with time zone,
	"content_digest" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "affiliate_tx_observations_kind_check" CHECK ("affiliate_transaction_observations"."kind" in ('first_observation', 'state_change', 'amount_change', 'restated', 'unchanged')),
	CONSTRAINT "affiliate_tx_observations_state_check" CHECK ("affiliate_transaction_observations"."state" in ('pending', 'approved', 'declined', 'reversed', 'paid')),
	CONSTRAINT "affiliate_tx_observations_order_value_currency_check" CHECK ("affiliate_transaction_observations"."order_value_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "affiliate_tx_observations_commission_currency_check" CHECK ("affiliate_transaction_observations"."commission_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "affiliate_tx_observations_order_value_shape_check" CHECK (("affiliate_transaction_observations"."order_value_amount" is null) = ("affiliate_transaction_observations"."order_value_currency" is null)),
	CONSTRAINT "affiliate_tx_observations_revision_check" CHECK ("affiliate_transaction_observations"."revision" >= 1),
	CONSTRAINT "affiliate_tx_observations_digest_check" CHECK (length("affiliate_transaction_observations"."content_digest") = 64)
);
--> statement-breakpoint
CREATE TABLE "affiliate_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"network" text NOT NULL,
	"network_transaction_id" text NOT NULL,
	"advertiser_ref" text,
	"publisher_ref" text,
	"state" text NOT NULL,
	"order_value_amount" bigint,
	"order_value_currency" text,
	"commission_amount" bigint NOT NULL,
	"commission_currency" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"network_processed_at" timestamp with time zone,
	"network_click_ref" text,
	"matched_click_id" text,
	"match_state" text NOT NULL,
	"unmatched_reason" text,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_digest" text NOT NULL,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "affiliate_transactions_network_check" CHECK ("affiliate_transactions"."network" in ('awin', 'ebay')),
	CONSTRAINT "affiliate_transactions_state_check" CHECK ("affiliate_transactions"."state" in ('pending', 'approved', 'declined', 'reversed', 'paid')),
	CONSTRAINT "affiliate_transactions_match_check" CHECK ("affiliate_transactions"."match_state" in ('matched', 'unmatched')),
	CONSTRAINT "affiliate_transactions_unmatched_reason_check" CHECK ("affiliate_transactions"."unmatched_reason" in ('network_supplies_no_reference', 'no_reference_reported', 'reference_not_recognized', 'reference_network_mismatch')),
	CONSTRAINT "affiliate_transactions_order_value_currency_check" CHECK ("affiliate_transactions"."order_value_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "affiliate_transactions_commission_currency_check" CHECK ("affiliate_transactions"."commission_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "affiliate_transactions_match_shape_check" CHECK (("affiliate_transactions"."match_state" = 'matched') = ("affiliate_transactions"."matched_click_id" is not null)
        and ("affiliate_transactions"."match_state" = 'unmatched') = ("affiliate_transactions"."unmatched_reason" is not null)),
	CONSTRAINT "affiliate_transactions_order_value_shape_check" CHECK (("affiliate_transactions"."order_value_amount" is null) = ("affiliate_transactions"."order_value_currency" is null)),
	CONSTRAINT "affiliate_transactions_digest_check" CHECK (length("affiliate_transactions"."content_digest") = 64),
	CONSTRAINT "affiliate_transactions_observation_order_check" CHECK ("affiliate_transactions"."first_observed_at" <= "affiliate_transactions"."last_observed_at"),
	CONSTRAINT "affiliate_transactions_observation_count_check" CHECK ("affiliate_transactions"."observation_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_account_check";--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "affiliate_commission_postings" ADD CONSTRAINT "affiliate_commission_postings_transaction_id_affiliate_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."affiliate_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commission_postings" ADD CONSTRAINT "affiliate_commission_postings_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_outbound_hosts" ADD CONSTRAINT "affiliate_outbound_hosts_catalog_source_id_catalog_sources_id_fk" FOREIGN KEY ("catalog_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_transaction_observations" ADD CONSTRAINT "affiliate_transaction_observations_transaction_id_affiliate_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."affiliate_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_transaction_observations" ADD CONSTRAINT "affiliate_transaction_observations_report_run_id_affiliate_report_runs_id_fk" FOREIGN KEY ("report_run_id") REFERENCES "public"."affiliate_report_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_commission_postings_key" ON "affiliate_commission_postings" USING btree ("transaction_id","kind","revision");--> statement-breakpoint
CREATE INDEX "affiliate_commission_postings_ledger_idx" ON "affiliate_commission_postings" USING btree ("ledger_transaction_id");--> statement-breakpoint
CREATE INDEX "affiliate_outbound_clicks_source_time_idx" ON "affiliate_outbound_clicks" USING btree ("catalog_source_id","occurred_at");--> statement-breakpoint
CREATE INDEX "affiliate_outbound_clicks_offer_time_idx" ON "affiliate_outbound_clicks" USING btree ("offer_id","occurred_at");--> statement-breakpoint
CREATE INDEX "affiliate_outbound_clicks_retention_idx" ON "affiliate_outbound_clicks" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_outbound_hosts_live_key" ON "affiliate_outbound_hosts" USING btree ("catalog_source_id","host") WHERE "affiliate_outbound_hosts"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "affiliate_outbound_hosts_source_idx" ON "affiliate_outbound_hosts" USING btree ("catalog_source_id");--> statement-breakpoint
CREATE INDEX "affiliate_report_runs_network_time_idx" ON "affiliate_report_runs" USING btree ("network","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_tx_observations_revision_key" ON "affiliate_transaction_observations" USING btree ("transaction_id","revision");--> statement-breakpoint
CREATE INDEX "affiliate_tx_observations_run_idx" ON "affiliate_transaction_observations" USING btree ("report_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_transactions_network_key" ON "affiliate_transactions" USING btree ("network","network_transaction_id");--> statement-breakpoint
CREATE INDEX "affiliate_transactions_network_event_idx" ON "affiliate_transactions" USING btree ("network","event_at");--> statement-breakpoint
CREATE INDEX "affiliate_transactions_state_idx" ON "affiliate_transactions" USING btree ("network","state");--> statement-breakpoint
CREATE INDEX "affiliate_transactions_click_idx" ON "affiliate_transactions" USING btree ("matched_click_id");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_check" CHECK ("ledger_entries"."account" in ('provider_clearing', 'merchant_payable', 'commission_revenue', 'processor_expense', 'refunds', 'disputes', 'reserves', 'retail_cost_recovery', 'supplier_prepaid', 'platform_funds', 'procurement_expense', 'customer_adjustment', 'subscription_revenue', 'referral_expense', 'referral_payable', 'affiliate_receivable', 'affiliate_commission_revenue'));--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('charge_succeeded', 'transfer_created', 'refund', 'transfer_reversal', 'dispute_created', 'dispute_won', 'dispute_lost', 'subscription_invoice_paid', 'adjustment', 'prefund_top_up', 'procurement_settled', 'retail_variance', 'supplier_credit', 'referral_reward_accrued', 'referral_reward_reversed', 'referral_payout', 'referral_recovery', 'affiliate_commission_accrued', 'affiliate_commission_reversed', 'affiliate_commission_settled'));

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Hand-written: the three immutability triggers. See the header.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mercaria_affiliate_observations_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'affiliate_transaction_observations is append-only: it records what a network said at one '
    'instant. A network changing its mind is a NEW observation citing the next revision, never '
    'an edit to the row that recorded what it said before -- that row is what a publisher '
    'statement is reconciled against.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER affiliate_transaction_observations_append_only
BEFORE UPDATE OR DELETE ON affiliate_transaction_observations
FOR EACH STATEMENT EXECUTE FUNCTION mercaria_affiliate_observations_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_affiliate_postings_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'affiliate_commission_postings is append-only: it names the balanced ledger transaction a '
    'commission produced. A correction is a REVERSING ledger transaction and a new posting row, '
    'never an edit or a delete here -- the ledger refuses both on its own tables for the same '
    'reason, and this keeps the two sides of the link consistent about it.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER affiliate_commission_postings_append_only
BEFORE UPDATE OR DELETE ON affiliate_commission_postings
FOR EACH STATEMENT EXECUTE FUNCTION mercaria_affiliate_postings_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_affiliate_clicks_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'affiliate_outbound_clicks is immutable: a click records one request that already happened. '
    'DELETE is deliberately permitted so the shared expiry sweep can enforce retention; UPDATE '
    'is not, because nothing about a past redirect can change.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER affiliate_outbound_clicks_immutable
BEFORE UPDATE ON affiliate_outbound_clicks
FOR EACH STATEMENT EXECUTE FUNCTION mercaria_affiliate_clicks_immutable();
