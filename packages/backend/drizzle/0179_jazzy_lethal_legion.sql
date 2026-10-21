-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Every foreign key that points INTO a table the expiry sweep deletes from
-- (`db/expiryTargets.ts`) gets an index on its referencing column.
--
-- Deleting a row makes Postgres check each foreign key that references it, once
-- per deleted row, with `... where <fk column> = $1`. With no index on that
-- column the check is a sequential scan of the referencing table. On
-- 2026-10-21 `offer_price_snapshots`' self-reference (`supersedes_snapshot_id`)
-- had none, so every 1,000-row sweep batch scanned the table ~1,000 times:
-- 28.8M buffer hits per statement, ~605k sequential scans and 215 billion
-- tuples read since the database's last restart, and the heaviest statement
-- Mercaria put on the shared database (0.16 average active sessions, all CPU).
-- The other sixteen are the same defect on tables that are empty today; they
-- would have grown into it.
--
-- Additive (`pre`): the serving image ignores them. A plain CREATE INDEX holds
-- a SHARE lock on its table for the build. Every table here is empty in
-- production except `offer_price_snapshots` (~361k rows, ~233 MB), whose index
-- is partial on a column that is NULL in every row, so the build is one scan.
CREATE INDEX "buyer_request_events_actor_grant_id_idx" ON "buyer_request_events" USING btree ("actor_grant_id") WHERE "buyer_request_events"."actor_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "cancellation_requests_requested_by_grant_id_idx" ON "cancellation_requests" USING btree ("requested_by_grant_id") WHERE "cancellation_requests"."requested_by_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "return_requests_requested_by_grant_id_idx" ON "return_requests" USING btree ("requested_by_grant_id") WHERE "return_requests"."requested_by_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "support_messages_author_grant_id_idx" ON "support_messages" USING btree ("author_grant_id") WHERE "support_messages"."author_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "watchlist_snapshots_previous_snapshot_id_idx" ON "watchlist_snapshots" USING btree ("previous_snapshot_id") WHERE "watchlist_snapshots"."previous_snapshot_id" is not null;--> statement-breakpoint
CREATE INDEX "procurement_exceptions_provider_event_id_idx" ON "procurement_exceptions" USING btree ("provider_event_id") WHERE "procurement_exceptions"."provider_event_id" is not null;--> statement-breakpoint
CREATE INDEX "purchase_order_tracking_events_provider_event_id_idx" ON "purchase_order_tracking_events" USING btree ("provider_event_id") WHERE "purchase_order_tracking_events"."provider_event_id" is not null;--> statement-breakpoint
CREATE INDEX "offer_price_snapshots_supersedes_idx" ON "offer_price_snapshots" USING btree ("supersedes_snapshot_id") WHERE "offer_price_snapshots"."supersedes_snapshot_id" is not null;--> statement-breakpoint
CREATE INDEX "feed_configuration_versions_upload_id_idx" ON "feed_configuration_versions" USING btree ("upload_id") WHERE "feed_configuration_versions"."upload_id" is not null;--> statement-breakpoint
CREATE INDEX "feed_configuration_versions_validated_report_id_idx" ON "feed_configuration_versions" USING btree ("validated_report_id") WHERE "feed_configuration_versions"."validated_report_id" is not null;--> statement-breakpoint
CREATE INDEX "retail_return_line_dispositions_actor_grant_id_idx" ON "retail_return_line_dispositions" USING btree ("actor_grant_id") WHERE "retail_return_line_dispositions"."actor_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "retail_service_request_events_actor_grant_id_idx" ON "retail_service_request_events" USING btree ("actor_grant_id") WHERE "retail_service_request_events"."actor_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "retail_service_requests_requester_grant_id_idx" ON "retail_service_requests" USING btree ("requester_grant_id") WHERE "retail_service_requests"."requester_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "price_alert_notifications_notification_id_idx" ON "price_alert_notifications" USING btree ("notification_id") WHERE "price_alert_notifications"."notification_id" is not null;--> statement-breakpoint
CREATE INDEX "price_alert_triggers_observed_price_version_idx" ON "price_alert_triggers" USING btree ("observed_price_version");--> statement-breakpoint
CREATE INDEX "merchant_acquisition_candidates_snapshot_id_idx" ON "merchant_acquisition_candidates" USING btree ("snapshot_id") WHERE "merchant_acquisition_candidates"."snapshot_id" is not null;--> statement-breakpoint
CREATE INDEX "shopping_agent_notifications_notification_id_idx" ON "shopping_agent_notifications" USING btree ("notification_id") WHERE "shopping_agent_notifications"."notification_id" is not null;