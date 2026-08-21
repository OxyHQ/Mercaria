-- oxy:deploy-phase=pre
-- oxy:rollback=restore: catalog_merge_conflicts.conflict_key is dropped and re-generated again, and five CHECKs including catalog_merge_conflicts_collapse_resolution_check are widened. The column is GENERATED so re-adding it rebuilds it; the previous CHECK forms are in 0114
--
-- #405, third table: `bundle_self_containment` and its `drop_component`
-- resolution, plus the NATURAL key naming the colliding component row.
--
-- The pair rather than a `bundle_components.id` foreign key, deliberately: this
-- conflict is resolved only AFTER the operator has removed that row through the
-- catalogue, so a `restrict` reference would block the very act the resolution
-- requires, and a `set null` one would leave the conflict naming nothing.
--
-- THE SAME TWO HAND-WRITTEN CORRECTIONS 0113 and 0114 carry, for the same
-- reasons, and a regeneration drops both again:
--
--  1. ORDER. drizzle-kit re-creates `conflict_key` BEFORE adding the two columns
--     its new expression reads, so the file as generated fails at apply time.
--     Both ADD COLUMNs and their foreign keys are moved to the top.
--  2. THE INDEX. Dropping `conflict_key` drops
--     `catalog_merge_conflicts_identity_key` with it; drizzle-kit does not
--     recreate it and the snapshot goes on listing it, so nothing downstream
--     would notice. Restored from 0033.
--
-- Generated as 0116 rather than renumbered from an earlier index: two lanes hit
-- the same number three times this morning, so this was REMOVED from the branch
-- and regenerated against a tip already carrying 0115. Renaming a migration
-- keeps a snapshot that diffs against the wrong parent.
--
-- `pre`: the serving image writes neither new column nor the generated one, and
-- every CHECK is re-added WIDER.
ALTER TABLE "catalog_merge_conflicts" ADD COLUMN "collapsing_bundle_variant_id" text;
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD COLUMN "collapsing_component_variant_id" text;
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_collapsing_bundle_variant_id_canonical_variants_id_fk" FOREIGN KEY ("collapsing_bundle_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_collapsing_component_variant_id_canonical_variants_id_fk" FOREIGN KEY ("collapsing_component_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;
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
            coalesce("collapsing_family_redirect_id", '') || '|' ||
            coalesce("collapsing_bundle_variant_id", '') || '|' ||
            coalesce("collapsing_component_variant_id", '')) STORED NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_merge_conflicts_identity_key" ON "catalog_merge_conflicts" USING btree ("job_id","kind","conflict_key");
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_bundle_distinct_check" CHECK ("catalog_merge_conflicts"."collapsing_bundle_variant_id" is null
          or "catalog_merge_conflicts"."collapsing_component_variant_id" is null
          or "catalog_merge_conflicts"."collapsing_bundle_variant_id" <> "catalog_merge_conflicts"."collapsing_component_variant_id");
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_drop_component_kind_check" CHECK ("catalog_merge_conflicts"."resolution" is distinct from 'drop_component'
          or "catalog_merge_conflicts"."kind" in ('bundle_self_containment'));
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_kind_check" CHECK ("catalog_merge_conflicts"."kind" in ('identifier', 'variant_signature', 'default_variant', 'relationship_endpoint', 'active_offer', 'verified_claim', 'compatibility_endpoint_collapse', 'redirect_endpoint_collapse', 'bundle_self_containment'));
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_resolution_check" CHECK ("catalog_merge_conflicts"."resolution" in ('keep_winner', 'keep_loser', 'merge_pair', 'close_relation', 'retain_history', 'drop_component'));
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
            when 'bundle_self_containment' then
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
              and "catalog_merge_conflicts"."collapsing_bundle_variant_id" is null
              and "catalog_merge_conflicts"."collapsing_component_variant_id" is null
            when 'bundle_self_containment' then
              "catalog_merge_conflicts"."collapsing_bundle_variant_id" is not null
              and "catalog_merge_conflicts"."collapsing_component_variant_id" is not null
              and "catalog_merge_conflicts"."collapsing_relation_id" is null
              and "catalog_merge_conflicts"."collapsing_product_redirect_id" is null
              and "catalog_merge_conflicts"."collapsing_family_redirect_id" is null
            else
              "catalog_merge_conflicts"."collapsing_relation_id" is null
              and "catalog_merge_conflicts"."collapsing_product_redirect_id" is null
              and "catalog_merge_conflicts"."collapsing_family_redirect_id" is null
              and "catalog_merge_conflicts"."collapsing_bundle_variant_id" is null
              and "catalog_merge_conflicts"."collapsing_component_variant_id" is null
          end);
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_collapse_resolution_check" CHECK ("catalog_merge_conflicts"."kind" not in ('compatibility_endpoint_collapse', 'redirect_endpoint_collapse', 'bundle_self_containment')
          or "catalog_merge_conflicts"."resolution" is null
          or "catalog_merge_conflicts"."resolution" in ('close_relation', 'retain_history', 'drop_component'));
