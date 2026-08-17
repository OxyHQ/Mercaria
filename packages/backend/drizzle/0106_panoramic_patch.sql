-- oxy:deploy-phase=post
--
-- #477. Both constraints reached production with a BARE `.` where a literal dot
-- was meant, so each admits exactly what it exists to refuse: a POSIX `.`
-- matches any character, making `foo bar` and `foo/bar` legal product-type keys
-- and `axcom` a legal advertiser host. Cause in both cases is that the pattern
-- was an inline drizzle template literal, whose COOKED strings drop `\.` to `.`
-- before drizzle sees it. Both now render through `sql.raw`.
--
-- `post`, not `pre`, because both statements NARROW what the column accepts.
-- Applied `pre` the tightened CHECK is in force while the PREVIOUS image is
-- still serving, so any write that image is prepared to make and the new
-- constraint refuses becomes a 500 on the running deployment. `post` puts the
-- new image in front of the narrowing and costs only the rollout's worth of
-- today's behaviour. This is also `migrate.ts`'s own one-line definition —
-- anything that takes something away — and a DROP CONSTRAINT takes it away.
--
-- Safe to apply: no stored row can violate either narrowing. The reasoning and
-- its census are in the PR and pinned by tests, not asserted here —
-- `product_type_definitions` has exactly one production writer
-- (`scripts/seed-verticals/apply.ts`, whose keys are `namespaceFor` output
-- prefixed onto a checked-in package key, both `[a-z][a-z0-9_]*`), and
-- `awin_advertisers.declared_host` is written only from an Awin feed-list host.
--
-- There are NO hand-written statements below, so a regeneration of this file is
-- safe. The patterns live in `PRODUCT_TYPE_KEY_PATTERN` and
-- `AWIN_DECLARED_HOST_PATTERN`; regenerating re-renders them from there.
ALTER TABLE "awin_advertisers" DROP CONSTRAINT "awin_advertisers_declared_host_shape_check";--> statement-breakpoint
ALTER TABLE "product_type_definitions" DROP CONSTRAINT "product_type_definitions_key_shape_check";--> statement-breakpoint
ALTER TABLE "awin_advertisers" ADD CONSTRAINT "awin_advertisers_declared_host_shape_check" CHECK ("awin_advertisers"."declared_host" is null
          or "awin_advertisers"."declared_host" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');--> statement-breakpoint
ALTER TABLE "product_type_definitions" ADD CONSTRAINT "product_type_definitions_key_shape_check" CHECK ("product_type_definitions"."key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$');