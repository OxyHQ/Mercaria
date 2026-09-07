-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "discovery_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"category_id" text NOT NULL,
	"window" text NOT NULL,
	"units_sold" integer DEFAULT 0 NOT NULL,
	"order_count" integer DEFAULT 0 NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "discovery_signals_subject_type_check" CHECK ("discovery_signals"."subject_type" in ('listing', 'store')),
	CONSTRAINT "discovery_signals_window_check" CHECK ("discovery_signals"."window" in ('30d')),
	CONSTRAINT "discovery_signals_counts_check" CHECK ("discovery_signals"."units_sold" >= 0 and "discovery_signals"."order_count" >= 0 and "discovery_signals"."view_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "discovery_sweep_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "discovery_sweep_cursors_lease_check" CHECK (num_nonnulls("discovery_sweep_cursors"."lease_owner", "discovery_sweep_cursors"."lease_expires_at") in (0, 2))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_signals_subject_scope_key" ON "discovery_signals" USING btree ("subject_type","subject_id","category_id","window");--> statement-breakpoint
CREATE INDEX "discovery_signals_units_sold_idx" ON "discovery_signals" USING btree ("category_id","window","units_sold");--> statement-breakpoint
CREATE INDEX "discovery_signals_view_count_idx" ON "discovery_signals" USING btree ("category_id","window","view_count");