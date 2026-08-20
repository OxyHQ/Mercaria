-- oxy:deploy-phase=pre
--
-- The `entity_suppressed` merge conflict (#694 part two).
--
-- ADDITIVE, despite the three DROP CONSTRAINT lines. Each is drizzle-kit's
-- rendering of a CHECK CHANGE, and every one of them WIDENS: the kind and
-- resolution tuples gain a member, and the pair-shape CASE gains a branch. The
-- previously serving image writes only the old values, which the new CHECKs
-- still admit, so no write it performs is broken by this. The drops are
-- momentary and inside the same transaction as their re-adds. (The precedent is
-- the one AGENTS.md states for adding a CurrencyCode: a closed-value-set CHECK
-- widening is a `pre` migration, and it renders exactly this way.)
--
-- What it adds:
--   * `suppression_id`, nullable, FK -> catalog_entity_suppressions ON DELETE
--     restrict. A FORWARD reference in the drizzle schema, which is the shape
--     drizzle-kit has silently dropped before, so the ADD CONSTRAINT ... FOREIGN
--     KEY line below is the verification rather than the declaration.
--   * `..._suppression_shape_check`, a biconditional: the reference is present
--     on exactly this kind. A null-clause repeated through eleven branches of
--     the two shape CHECKs would have to be remembered once per branch and
--     fails silently in the permissive direction.
--   * `..._suppression_resolution_kind_check`, tying `suppression_cleared` to
--     this kind alone -- the `drop_component` device, one domain over.
--
-- Regenerated as 0120 after another lane took 0119: the colliding `.sql` and
-- snapshot were DELETED and `_journal.json` restored to main's before
-- re-running `db:generate`, never hand-renamed. This header is the hand-written
-- part a regeneration drops, re-applied.
--
ALTER TABLE "catalog_merge_conflicts" DROP CONSTRAINT "catalog_merge_conflicts_kind_check";--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" DROP CONSTRAINT "catalog_merge_conflicts_resolution_check";--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" DROP CONSTRAINT "catalog_merge_conflicts_pair_shape_check";--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD COLUMN "suppression_id" text;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_suppression_id_catalog_entity_suppressions_id_fk" FOREIGN KEY ("suppression_id") REFERENCES "public"."catalog_entity_suppressions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_suppression_shape_check" CHECK (("catalog_merge_conflicts"."kind" = 'entity_suppressed') = ("catalog_merge_conflicts"."suppression_id" is not null));--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_suppression_resolution_kind_check" CHECK ("catalog_merge_conflicts"."resolution" is distinct from 'suppression_cleared'
          or "catalog_merge_conflicts"."kind" = 'entity_suppressed');--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_kind_check" CHECK ("catalog_merge_conflicts"."kind" in ('identifier', 'variant_signature', 'default_variant', 'relationship_endpoint', 'active_offer', 'verified_claim', 'compatibility_endpoint_collapse', 'redirect_endpoint_collapse', 'bundle_self_containment', 'entity_suppressed'));--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_resolution_check" CHECK ("catalog_merge_conflicts"."resolution" in ('keep_winner', 'keep_loser', 'merge_pair', 'close_relation', 'retain_history', 'drop_component', 'suppression_cleared'));--> statement-breakpoint
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
            when 'entity_suppressed' then
              "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_variant_id" is null and "catalog_merge_conflicts"."winner_variant_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            else false
          end);