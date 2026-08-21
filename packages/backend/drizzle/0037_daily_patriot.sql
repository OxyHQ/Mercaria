-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- #61 — the three indexes the canonical-graph benchmark justified, and nothing
-- else. Each one's measurement lives beside its definition in
-- `src/db/schema/`; the full report is `docs/performance/`.
--
-- Additive, so `pre`: every statement here is a CREATE INDEX the serving image
-- neither needs nor is broken by. There is no `post` half — #61 adopted no
-- drop, no column change and no projection.
--
-- NOTE for a regeneration: `offers_variant_price_sort_idx` indexes an
-- EXPRESSION whose constant comes from `MAX_MONEY_MINOR_UNITS` through
-- `sql.raw`. If it ever renders as a bound-parameter placeholder here, the
-- migration will generate cleanly and fail at apply time — DDL cannot carry one.
--
-- AND: run `bun run build:shared-types` BEFORE regenerating. drizzle-kit renders
-- every closed-value-set CHECK from the BUILT `@mercaria/shared-types`, so a
-- stale `dist/` makes it emit statements REVERTING whatever widening a sibling
-- branch just landed. Measured on this file's own rebase behind #107: the first
-- regeneration silently dropped `guest_portal_initialization` and two analytics
-- reason codes out of their CHECKs, in a migration whose diff looked plausible.

CREATE INDEX "canonical_products_normalized_name_gist_trgm_idx" ON "canonical_products" USING gist ("normalized_name" gist_trgm_ops);--> statement-breakpoint
CREATE INDEX "canonical_products_brand_page_idx" ON "canonical_products" USING btree ("brand_id","name","id") WHERE "canonical_products"."status" <> 'merged';--> statement-breakpoint
CREATE INDEX "offers_variant_price_sort_idx" ON "offers" USING btree ("canonical_variant_id",coalesce("price_amount", 9007199254740991::bigint),"id") WHERE "offers"."status" = 'active';