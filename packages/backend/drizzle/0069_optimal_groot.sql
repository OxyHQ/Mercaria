-- oxy:deploy-phase=pre
--
-- Durable, idempotent connector webhook registration (#218).
--
-- Purely ADDITIVE: one table, its foreign key and one unique index. Nothing is
-- dropped, narrowed or renamed, so the serving image keeps working unchanged —
-- it simply never writes here.
--
-- `connection_webhook_failures` records the topics a platform REFUSED at the
-- last registration attempt, one row per topic, replaced wholesale in the same
-- transaction that writes `connections.webhook_ids` and the webhook secret. The
-- three describe one attempt and can never describe different ones.
--
-- `UNIQUE(connection_id, topic)` is what makes that replacement converge rather
-- than accumulate: a topic is refused or it is not, and one row is the whole of
-- that fact. `http_status` is NULLABLE because a `transport_error` never reached
-- the platform, so there is no status to record and a zero would be one nobody
-- answered.
--
-- The `reason` CHECK is rendered from `CONNECTOR_WEBHOOK_FAILURE_REASONS` in
-- `@mercaria/shared-types` — adding a member is a code change PLUS a `pre`
-- migration in the same PR, per `db/schema/CONVENTIONS.md`.

CREATE TABLE "connection_webhook_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"topic" text NOT NULL,
	"reason" text NOT NULL,
	"http_status" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "connection_webhook_failures_reason_check" CHECK ("connection_webhook_failures"."reason" in ('permission_denied', 'rate_limited', 'topic_not_supported', 'platform_error', 'unexpected_response', 'transport_error'))
);
--> statement-breakpoint
ALTER TABLE "connection_webhook_failures" ADD CONSTRAINT "connection_webhook_failures_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_webhook_failures_connection_id_topic_key" ON "connection_webhook_failures" USING btree ("connection_id","topic");