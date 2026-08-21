-- oxy:deploy-phase=pre
-- oxy:rollback=restore: catalog_merge_conflicts.conflict_key is dropped and re-generated over a wider key, and five CHECKs including catalog_merge_conflicts_collapse_shape_check are widened. The column is GENERATED so re-adding it rebuilds it; the previous CHECK forms are in 0113
--
-- #405, second table pair: `redirect_endpoint_collapse` and its `retain_history`
-- resolution, plus the two columns naming the colliding redirect hop.
--
-- THE SAME TWO HAND-WRITTEN CORRECTIONS 0113 CARRIES, for the same reasons, and
-- a regeneration drops both again:
--
--  1. ORDER. drizzle-kit re-creates `conflict_key` BEFORE adding the two columns
--     its new expression reads, so the file as generated fails at apply time
--     with `column "collapsing_product_redirect_id" does not exist`. Both ADD
--     COLUMNs and their foreign keys are moved to the top.
--  2. THE INDEX. Dropping `conflict_key` drops
--     `catalog_merge_conflicts_identity_key` with it; drizzle-kit does not
--     recreate it and the snapshot goes on listing it, so nothing downstream
--     would notice. Restored verbatim from 0033.
--
-- Both new columns enter `conflict_key` because a merge can collapse a redirect
-- at both grains under one job, and two conflicts sharing a key would be
-- swallowed by `insertConflict`'s `ON CONFLICT DO NOTHING`.
--
-- `pre`: the serving image writes neither new column nor the generated one, and
-- every CHECK is re-added WIDER.
ALTER TABLE "catalog_merge_conflicts" ADD COLUMN "collapsing_product_redirect_id" text;
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD COLUMN "collapsing_family_redirect_id" text;
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_collapsing_product_redirect_id_canonical_product_redirects_id_fk" FOREIGN KEY ("collapsing_product_redirect_id") REFERENCES "public"."canonical_product_redirects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_collapsing_family_redirect_id_canonical_product_family_redirects_id_fk" FOREIGN KEY ("collapsing_family_redirect_id") REFERENCES "public"."canonical_product_family_redirects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" DROP CONSTRAINT "catalog_merge_conflicts_kind_check";
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" DROP CONSTRAINT "catalog_merge_conflicts_resolution_check";
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" DROP CONSTRAINT "catalog_merge_conflicts_pair_shape_check";
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" DROP CONSTRAINT "catalog_merge_conflicts_collapse_shape_check";
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" DROP CONSTRAINT "catalog_merge_conflicts_collapse_resolution_check";
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" drop column "conflict_key";
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD COLUMN "conflict_key" text GENERATED ALWAYS AS (coalesce("loser_identifier_id", '') || '|' || coalesce("winner_identifier_id", '') || '|' ||
            coalesce("loser_variant_id", '') || '|' || coalesce("winner_variant_id", '') || '|' ||
            coalesce("loser_relationship_id", '') || '|' || coalesce("winner_relationship_id", '') || '|' ||
            coalesce("loser_offer_id", '') || '|' || coalesce("winner_offer_id", '') || '|' ||
            coalesce("loser_claim_id", '') || '|' || coalesce("winner_claim_id", '') || '|' ||
            coalesce("collapsing_relation_id", '') || '|' ||
            coalesce("collapsing_product_redirect_id", '') || '|' ||
            coalesce("collapsing_family_redirect_id", '')) STORED NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_merge_conflicts_identity_key" ON "catalog_merge_conflicts" USING btree ("job_id","kind","conflict_key");
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_retain_history_kind_check" CHECK ("catalog_merge_conflicts"."resolution" is distinct from 'retain_history'
          or "catalog_merge_conflicts"."kind" in ('redirect_endpoint_collapse'));
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_kind_check" CHECK ("catalog_merge_conflicts"."kind" in ('identifier', 'variant_signature', 'default_variant', 'relationship_endpoint', 'active_offer', 'verified_claim', 'compatibility_endpoint_collapse', 'redirect_endpoint_collapse'));
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_resolution_check" CHECK ("catalog_merge_conflicts"."resolution" in ('keep_winner', 'keep_loser', 'merge_pair', 'close_relation', 'retain_history'));
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
            when 'redirect_endpoint_collapse' then
              "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_variant_id" is null and "catalog_merge_conflicts"."winner_variant_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            else false
          end);
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_collapse_shape_check" CHECK (case "catalog_merge_conflicts"."kind"
            when 'compatibility_endpoint_collapse' then
              "catalog_merge_conflicts"."collapsing_relation_id" is not null
              and "catalog_merge_conflicts"."collapsing_product_redirect_id" is null
              and "catalog_merge_conflicts"."collapsing_family_redirect_id" is null
            when 'redirect_endpoint_collapse' then
              "catalog_merge_conflicts"."collapsing_relation_id" is null
              and num_nonnulls("catalog_merge_conflicts"."collapsing_product_redirect_id", "catalog_merge_conflicts"."collapsing_family_redirect_id") = 1
            else
              "catalog_merge_conflicts"."collapsing_relation_id" is null
              and "catalog_merge_conflicts"."collapsing_product_redirect_id" is null
              and "catalog_merge_conflicts"."collapsing_family_redirect_id" is null
          end);
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_collapse_resolution_check" CHECK ("catalog_merge_conflicts"."kind" not in ('compatibility_endpoint_collapse', 'redirect_endpoint_collapse')
          or "catalog_merge_conflicts"."resolution" is null
          or "catalog_merge_conflicts"."resolution" in ('close_relation', 'retain_history'));
