-- oxy:deploy-phase=pre
--
-- #405: `catalog_merge_conflicts` gains `collapsing_relation_id` and the
-- `compatibility_endpoint_collapse` kind / `close_relation` resolution.
--
-- TWO HAND-WRITTEN CORRECTIONS TO THE GENERATED OUTPUT. A regeneration drops
-- both and re-emits the broken form, so re-apply them:
--
--  1. ORDER. drizzle-kit emitted the `conflict_key` re-creation BEFORE
--     `ADD COLUMN "collapsing_relation_id"`, and the new generated expression
--     reads that column -- so the file as generated fails at apply time with
--     `column "collapsing_relation_id" does not exist`. The ADD COLUMN and its
--     foreign key are moved to the top.
--  2. THE INDEX. Dropping a column drops every index over it, so
--     `catalog_merge_conflicts_identity_key` (job_id, kind, conflict_key) --
--     the convergence unique that stops a re-planned job recording a conflict
--     twice -- goes with `conflict_key`, and drizzle-kit does NOT recreate it
--     while the snapshot goes on listing it, so nothing downstream would ever
--     notice. Measured: `drop column conflict_key` in a rolled-back transaction
--     takes that index from 1 to 0. The `CREATE UNIQUE INDEX` below restores it
--     verbatim from 0033.
--
-- The column is dropped and re-added rather than altered in place because
-- `ALTER COLUMN ... SET EXPRESSION` is PostgreSQL 17 and this migration must
-- apply on whatever the shared instance runs. It enters `conflict_key` because
-- two collapses under ONE job would otherwise share an identical key, and
-- `insertConflict`'s `ON CONFLICT DO NOTHING` would swallow the second.
--
-- `pre` because nothing here breaks a write the serving image performs: it
-- never writes `conflict_key` (generated) or the new column, the three CHECKs
-- are re-added WIDER, and `insertConflict` issues a bare `ON CONFLICT DO
-- NOTHING`, which needs no index to succeed.
ALTER TABLE "catalog_merge_conflicts" ADD COLUMN "collapsing_relation_id" text;
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_collapsing_relation_id_generic_compatibility_relations_id_fk" FOREIGN KEY ("collapsing_relation_id") REFERENCES "public"."generic_compatibility_relations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" DROP CONSTRAINT "catalog_merge_conflicts_kind_check";
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" DROP CONSTRAINT "catalog_merge_conflicts_resolution_check";
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" DROP CONSTRAINT "catalog_merge_conflicts_pair_shape_check";
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" drop column "conflict_key";
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD COLUMN "conflict_key" text GENERATED ALWAYS AS (coalesce("loser_identifier_id", '') || '|' || coalesce("winner_identifier_id", '') || '|' ||
            coalesce("loser_variant_id", '') || '|' || coalesce("winner_variant_id", '') || '|' ||
            coalesce("loser_relationship_id", '') || '|' || coalesce("winner_relationship_id", '') || '|' ||
            coalesce("loser_offer_id", '') || '|' || coalesce("winner_offer_id", '') || '|' ||
            coalesce("loser_claim_id", '') || '|' || coalesce("winner_claim_id", '') || '|' ||
            coalesce("collapsing_relation_id", '')) STORED NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_merge_conflicts_identity_key" ON "catalog_merge_conflicts" USING btree ("job_id","kind","conflict_key");
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_collapse_shape_check" CHECK (("catalog_merge_conflicts"."collapsing_relation_id" is not null)
          = ("catalog_merge_conflicts"."kind" in ('compatibility_endpoint_collapse')));
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_close_relation_kind_check" CHECK ("catalog_merge_conflicts"."resolution" is distinct from 'close_relation'
          or "catalog_merge_conflicts"."kind" in ('compatibility_endpoint_collapse'));
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_collapse_resolution_check" CHECK ("catalog_merge_conflicts"."kind" not in ('compatibility_endpoint_collapse')
          or "catalog_merge_conflicts"."resolution" is null
          or "catalog_merge_conflicts"."resolution" = 'close_relation');
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_kind_check" CHECK ("catalog_merge_conflicts"."kind" in ('identifier', 'variant_signature', 'default_variant', 'relationship_endpoint', 'active_offer', 'verified_claim', 'compatibility_endpoint_collapse'));
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_resolution_check" CHECK ("catalog_merge_conflicts"."resolution" in ('keep_winner', 'keep_loser', 'merge_pair', 'close_relation'));
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_pair_shape_check" CHECK (case "catalog_merge_conflicts"."kind"
            when 'identifier' then
              "catalog_merge_conflicts"."loser_identifier_id" is not null and "catalog_merge_conflicts"."winner_identifier_id" is not null
              and "catalog_merge_conflicts"."loser_variant_id" is null and "catalog_merge_conflicts"."winner_variant_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            when 'variant_signature' then
              "catalog_merge_conflicts"."loser_variant_id" is not null and "catalog_merge_conflicts"."winner_variant_id" is not null
              and "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            when 'default_variant' then
              "catalog_merge_conflicts"."loser_variant_id" is not null and "catalog_merge_conflicts"."winner_variant_id" is not null
              and "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            when 'relationship_endpoint' then
              "catalog_merge_conflicts"."loser_relationship_id" is not null and "catalog_merge_conflicts"."winner_relationship_id" is not null
              and "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_variant_id" is null and "catalog_merge_conflicts"."winner_variant_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            when 'active_offer' then
              "catalog_merge_conflicts"."loser_offer_id" is not null and "catalog_merge_conflicts"."winner_offer_id" is not null
              and "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_variant_id" is null and "catalog_merge_conflicts"."winner_variant_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            when 'verified_claim' then
              "catalog_merge_conflicts"."loser_claim_id" is not null and "catalog_merge_conflicts"."winner_claim_id" is not null
              and "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_variant_id" is null and "catalog_merge_conflicts"."winner_variant_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
            when 'compatibility_endpoint_collapse' then
              "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_variant_id" is null and "catalog_merge_conflicts"."winner_variant_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            else false
          end);
