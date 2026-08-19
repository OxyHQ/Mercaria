-- oxy:deploy-phase=pre
--
-- The translation desk's indexes (#367 merge-order step 10).
--
-- Purely additive: four `CREATE INDEX`, no drop, no rename, no narrowing. The
-- previously serving image performs no write these break.
--
-- ## Why now, and not when the tables were created
--
-- `db/schema/catalogLocalization.ts` recorded the absence as a decision rather
-- than an oversight: a `(locale, status)` index is the obvious one for "every
-- category still owing a Spanish name", nothing read that question, and indexes
-- over tables each carrying roughly (entities x locales) rows are a real write
-- cost paid on every translation save. #61's findings are the cited precedent
-- for banking an index decision until its reader arrives — one that arrives
-- later is this migration, one that never arrives is permanent.
--
-- The reader arrived: `db/catalogLocalization/completenessRepository.ts` joins
-- each of the four localization tables on `locale` for every locale in scope.
-- The existing `<table>_locale_key` uniques cannot serve that predicate — their
-- leading column is the ENTITY id, not the locale.
--
-- `product_type_field_localizations` (#633) is included for the same reason and
-- is the one where it matters most: it is keyed per FIELD rather than per
-- entity, so it is the largest of the four by construction.
--
-- ## No CONCURRENTLY, and that is the house decision rather than an omission
--
-- `CREATE INDEX CONCURRENTLY` may not run inside a transaction block and
-- `db/migrate.ts` runs the chain in one, which `0070`'s header already works
-- through at length. These four take a SHARE lock on tables whose writers are
-- the translation surfaces only — no shopper read and no checkout path writes
-- them — so the blocking window is a translator's save, not a sale.
CREATE INDEX "attribute_value_localizations_locale_status_idx" ON "attribute_value_localizations" USING btree ("locale","status");--> statement-breakpoint
CREATE INDEX "category_localizations_locale_status_idx" ON "category_localizations" USING btree ("locale","status");--> statement-breakpoint
CREATE INDEX "product_type_field_localizations_locale_status_idx" ON "product_type_field_localizations" USING btree ("locale","status");--> statement-breakpoint
CREATE INDEX "product_type_localizations_locale_status_idx" ON "product_type_localizations" USING btree ("locale","status");