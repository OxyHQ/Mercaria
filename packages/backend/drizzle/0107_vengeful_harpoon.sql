-- oxy:deploy-phase=pre
--
-- #572. A catalog authoring draft can state what the GOODS are like.
--
-- ## The defect these two columns close
--
-- The draft could not express a condition at all: there was no column, no
-- `AuthoringStepKind` member, and `condition`/`item_condition` are (correctly)
-- refused as product-type attributes by #94's reserved-key CHECK, because a
-- condition is a fact about ONE seller's copy rather than about the product. So
-- every authoring publication fell through to `createStoreProductWithin`'s
-- `resolveConditionInput(input) ?? { key: 'new', assertion: 'seller_declared' }`
-- and every authored listing was recorded as factory-new, DECLARED IN THE
-- SELLER'S NAME. Right for merchant stock; a false statement about the goods on
-- the `p2p` flow.
--
-- ## Nullable, and deliberately with NO column default
--
-- A `DEFAULT 'new'` would move the bug rather than fix it: with one, "the author
-- said new" and "nobody answered" become the same row, and the publication rule
-- `condition_missing` would have nothing left to detect. NULL means UNSTATED,
-- which is the fact validation reads.
--
-- ## Why `pre`, checked statement by statement rather than assumed
--
-- Every statement here is additive and every constraint is satisfied by the row
-- shape the PREVIOUS image writes, which leaves both columns NULL:
--
--   * the two `checkOneOf` constraints — `null in (...)` is NULL, and a CHECK
--     admits NULL;
--   * the pair biconditional — `(null is null) = (null is null)` is true;
--   * the unrefined constraint — its first disjunct is `assertion is null`.
--
-- So the serving image can keep writing drafts while this is in force, which is
-- exactly what `pre` means. Nothing here narrows an existing column and the
-- whole file contains no `DROP CONSTRAINT`.
--
-- ## Why the p2p requirement is NOT a constraint in this file
--
-- `flow` is on this table, so `flow <> 'p2p' or item_condition_key is not null`
-- is expressible — and it would refuse a p2p draft at CREATION, before the
-- author has reached a question nobody has asked them yet. A draft is working
-- state and must be creatable empty. The requirement is therefore a PUBLICATION
-- rule (`condition_missing` in `services/catalog-authoring/validation.ts`),
-- which is where `title_missing` and `description_missing` already live.
--
-- ## What a regeneration must preserve
--
-- Nothing hand-written: every statement below was emitted by `db:generate` from
-- `db/schema/catalogAuthoring.ts`, and all four CHECK bodies are RENDERED from
-- `ITEM_CONDITION_KEYS`, `CONDITION_ASSERTIONS`, `UNREFINED_CONDITION_KEYS` and
-- `UNREFINED_CONDITION_ASSERTIONS` in `@mercaria/shared-types` rather than
-- hand-copied. The file carries no hand-written-block anchors, because it
-- contains no statement drizzle-kit cannot model — quoting that token even in
-- prose would leave the marker gate looking at an unpaired one.
ALTER TABLE "catalog_authoring_drafts" ADD COLUMN "item_condition_key" text;--> statement-breakpoint
ALTER TABLE "catalog_authoring_drafts" ADD COLUMN "item_condition_assertion" text;--> statement-breakpoint
ALTER TABLE "catalog_authoring_drafts" ADD CONSTRAINT "catalog_authoring_drafts_item_condition_key_check" CHECK ("catalog_authoring_drafts"."item_condition_key" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts'));--> statement-breakpoint
ALTER TABLE "catalog_authoring_drafts" ADD CONSTRAINT "catalog_authoring_drafts_item_condition_assertion_check" CHECK ("catalog_authoring_drafts"."item_condition_assertion" in ('seller_declared', 'source_declared', 'operator_corrected', 'migrated_binary', 'legacy_client_binary'));--> statement-breakpoint
ALTER TABLE "catalog_authoring_drafts" ADD CONSTRAINT "catalog_authoring_drafts_item_condition_pair_check" CHECK (("catalog_authoring_drafts"."item_condition_key" is null) = ("catalog_authoring_drafts"."item_condition_assertion" is null));--> statement-breakpoint
ALTER TABLE "catalog_authoring_drafts" ADD CONSTRAINT "catalog_authoring_drafts_unrefined_condition_check" CHECK ("catalog_authoring_drafts"."item_condition_assertion" is null
          or "catalog_authoring_drafts"."item_condition_assertion" not in ('migrated_binary', 'legacy_client_binary')
          or "catalog_authoring_drafts"."item_condition_key" in ('new', 'used_good'));