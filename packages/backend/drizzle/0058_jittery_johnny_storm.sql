-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Natural-language shopping intent (#95): four new tables and nothing else.
--
-- Purely ADDITIVE — four `CREATE TABLE`s, three foreign keys and ten indexes.
-- No column is dropped, narrowed or renamed and no existing CHECK is touched,
-- so the image serving before this migration keeps working unchanged: it simply
-- never writes to any of them. `pre` is therefore the whole of it, and there is
-- no `post` companion to land.
--
-- The one statement worth reading twice is the composite foreign key
-- `search_intent_enablements_benchmark_fk`, which targets
-- `search_intent_benchmark_runs (id, dataset_digest)`. That target is a
-- `unique()` CONSTRAINT rather than a unique INDEX, deliberately: drizzle-kit
-- emits every `ADD CONSTRAINT … FOREIGN KEY` before every
-- `CREATE UNIQUE INDEX`, so a foreign key onto an index would run before its
-- target existed and fail at APPLY time with `42830` — invisible to `tsc` and
-- to generation, and visible only against a real server.
--
-- No hand-written statement lives below: this domain has no trigger and no
-- backfill, so a regeneration loses nothing. A future one must still re-add
-- this header, which `grep -c '^-- oxy:deploy-phase' ` on the regenerated file
-- is what confirms.

CREATE TABLE "search_intent_benchmark_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_version" text NOT NULL,
	"dataset_digest" text NOT NULL,
	"case_count" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"parser_version" text NOT NULL,
	"language" text NOT NULL,
	"category_id" text,
	"schema_validity" double precision NOT NULL,
	"category_accuracy" double precision NOT NULL,
	"hard_constraint_recall" double precision NOT NULL,
	"false_hard_constraint_rate" double precision NOT NULL,
	"clarification_precision" double precision NOT NULL,
	"latency_p_95_ms" integer NOT NULL,
	"cost_units" double precision NOT NULL,
	"fallback_rate" double precision NOT NULL,
	"sample_size" integer NOT NULL,
	"ran_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "search_intent_benchmark_runs_id_dataset_key" UNIQUE("id","dataset_digest"),
	CONSTRAINT "search_intent_benchmark_runs_language_check" CHECK ("search_intent_benchmark_runs"."language" ~ '^[a-z]{2,3}$'),
	CONSTRAINT "search_intent_benchmark_runs_digest_check" CHECK ("search_intent_benchmark_runs"."dataset_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "search_intent_benchmark_runs_rates_check" CHECK ("search_intent_benchmark_runs"."schema_validity" between 0 and 1
          and "search_intent_benchmark_runs"."category_accuracy" between 0 and 1
          and "search_intent_benchmark_runs"."hard_constraint_recall" between 0 and 1
          and "search_intent_benchmark_runs"."false_hard_constraint_rate" between 0 and 1
          and "search_intent_benchmark_runs"."clarification_precision" between 0 and 1
          and "search_intent_benchmark_runs"."fallback_rate" between 0 and 1),
	CONSTRAINT "search_intent_benchmark_runs_counts_check" CHECK ("search_intent_benchmark_runs"."case_count" > 0 and "search_intent_benchmark_runs"."sample_size" > 0 and "search_intent_benchmark_runs"."latency_p_95_ms" >= 0
          and "search_intent_benchmark_runs"."cost_units" >= 0),
	CONSTRAINT "search_intent_benchmark_runs_actor_check" CHECK (btrim("search_intent_benchmark_runs"."ran_by_oxy_user_id") <> '')
);
--> statement-breakpoint
CREATE TABLE "search_intent_enablements" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text,
	"language" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"benchmark_run_id" text NOT NULL,
	"dataset_digest" text NOT NULL,
	"enabled_by_oxy_user_id" text NOT NULL,
	"enabled_at" timestamp with time zone NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "search_intent_enablements_language_check" CHECK ("search_intent_enablements"."language" ~ '^[a-z]{2,3}$'),
	CONSTRAINT "search_intent_enablements_actor_check" CHECK (btrim("search_intent_enablements"."enabled_by_oxy_user_id") <> ''),
	CONSTRAINT "search_intent_enablements_note_check" CHECK (btrim("search_intent_enablements"."note") <> ''),
	CONSTRAINT "search_intent_enablements_digest_check" CHECK ("search_intent_enablements"."dataset_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "search_intent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_kind" text NOT NULL,
	"oxy_user_id" text,
	"guest_session_id" text,
	"locale" text NOT NULL,
	"market" text,
	"asked_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"open_clarification_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "search_intent_sessions_actor_kind_check" CHECK ("search_intent_sessions"."actor_kind" in ('oxy', 'guest', 'anonymous')),
	CONSTRAINT "search_intent_sessions_owner_check" CHECK (num_nonnulls("search_intent_sessions"."oxy_user_id", "search_intent_sessions"."guest_session_id") <= 1
          and ("search_intent_sessions"."oxy_user_id" is null or "search_intent_sessions"."actor_kind" = 'oxy')
          and ("search_intent_sessions"."guest_session_id" is null or "search_intent_sessions"."actor_kind" = 'guest')
          and ("search_intent_sessions"."actor_kind" <> 'oxy' or "search_intent_sessions"."oxy_user_id" is not null)
          and ("search_intent_sessions"."actor_kind" <> 'guest' or "search_intent_sessions"."guest_session_id" is not null)
          and ("search_intent_sessions"."actor_kind" <> 'anonymous'
               or num_nonnulls("search_intent_sessions"."oxy_user_id", "search_intent_sessions"."guest_session_id") = 0)),
	CONSTRAINT "search_intent_sessions_asked_kinds_check" CHECK ("search_intent_sessions"."asked_kinds" <@ array['category', 'budget_basis', 'missing_unit', 'attribute_disambiguation', 'requirement_strength', 'entity_disambiguation', 'condition']::text[]),
	CONSTRAINT "search_intent_sessions_rounds_check" CHECK ("search_intent_sessions"."rounds" >= 0),
	CONSTRAINT "search_intent_sessions_locale_check" CHECK ("search_intent_sessions"."locale" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
	CONSTRAINT "search_intent_sessions_market_check" CHECK ("search_intent_sessions"."market" is null or "search_intent_sessions"."market" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "search_intent_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"query_event_id" text,
	"mode" text NOT NULL,
	"fallback_reason" text,
	"provider" text NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"parser_version" text NOT NULL,
	"redacted_query" text NOT NULL,
	"locale" text NOT NULL,
	"language" text NOT NULL,
	"category_id" text,
	"hard_constraint_count" integer DEFAULT 0 NOT NULL,
	"preference_count" integer DEFAULT 0 NOT NULL,
	"unresolved_count" integer DEFAULT 0 NOT NULL,
	"clarification_count" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "search_intent_turns_mode_check" CHECK ("search_intent_turns"."mode" in ('model', 'deterministic')),
	CONSTRAINT "search_intent_turns_fallback_reason_check" CHECK ("search_intent_turns"."fallback_reason" in ('parser_disabled', 'provider_unconfigured', 'cohort_blocked', 'not_enabled_for_category_language', 'provider_timeout', 'provider_refused', 'provider_error', 'invalid_model_output', 'unsafe_model_output', 'model_output_unresolvable', 'constraint_validation_failed', 'parse_rate_limited')),
	CONSTRAINT "search_intent_turns_fallback_shape_check" CHECK (("search_intent_turns"."mode" = 'deterministic') = ("search_intent_turns"."fallback_reason" is not null)),
	CONSTRAINT "search_intent_turns_counts_check" CHECK ("search_intent_turns"."hard_constraint_count" >= 0 and "search_intent_turns"."preference_count" >= 0
          and "search_intent_turns"."unresolved_count" >= 0 and "search_intent_turns"."clarification_count" >= 0
          and "search_intent_turns"."latency_ms" >= 0),
	CONSTRAINT "search_intent_turns_language_check" CHECK ("search_intent_turns"."language" ~ '^[a-z]{2,3}$')
);
--> statement-breakpoint
ALTER TABLE "search_intent_enablements" ADD CONSTRAINT "search_intent_enablements_benchmark_fk" FOREIGN KEY ("benchmark_run_id","dataset_digest") REFERENCES "public"."search_intent_benchmark_runs"("id","dataset_digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_intent_sessions" ADD CONSTRAINT "search_intent_sessions_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_intent_turns" ADD CONSTRAINT "search_intent_turns_session_id_search_intent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."search_intent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_intent_benchmark_runs_language_created_at_idx" ON "search_intent_benchmark_runs" USING btree ("language","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "search_intent_enablements_category_language_key" ON "search_intent_enablements" USING btree ("category_id","language") WHERE "search_intent_enablements"."category_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "search_intent_enablements_language_key" ON "search_intent_enablements" USING btree ("language") WHERE "search_intent_enablements"."category_id" is null;--> statement-breakpoint
CREATE INDEX "search_intent_enablements_run_idx" ON "search_intent_enablements" USING btree ("benchmark_run_id");--> statement-breakpoint
CREATE INDEX "search_intent_sessions_oxy_user_id_idx" ON "search_intent_sessions" USING btree ("oxy_user_id","created_at" DESC NULLS LAST) WHERE "search_intent_sessions"."oxy_user_id" is not null;--> statement-breakpoint
CREATE INDEX "search_intent_sessions_guest_session_id_idx" ON "search_intent_sessions" USING btree ("guest_session_id") WHERE "search_intent_sessions"."guest_session_id" is not null;--> statement-breakpoint
CREATE INDEX "search_intent_sessions_expires_at_idx" ON "search_intent_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "search_intent_turns_mode_created_at_idx" ON "search_intent_turns" USING btree ("mode","created_at");--> statement-breakpoint
CREATE INDEX "search_intent_turns_session_id_idx" ON "search_intent_turns" USING btree ("session_id","created_at") WHERE "search_intent_turns"."session_id" is not null;--> statement-breakpoint
CREATE INDEX "search_intent_turns_query_event_id_idx" ON "search_intent_turns" USING btree ("query_event_id") WHERE "search_intent_turns"."query_event_id" is not null;--> statement-breakpoint
CREATE INDEX "search_intent_turns_expires_at_idx" ON "search_intent_turns" USING btree ("expires_at");