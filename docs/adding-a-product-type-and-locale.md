# Adding a product type, and adding a locale

The two tasks #367's definition of done names: *"Documentation enables another
team to add a new product type and locale without modifying unrelated frontend
business logic."*

This is a **procedure**. The models behind it are documented elsewhere and are
cited rather than restated — [`product-types.md`](product-types.md),
[`catalog-localization.md`](catalog-localization.md),
[`verticals/README.md`](verticals/README.md) (running and verifying the three
existing packages) and [`catalog-rollout-cohorts.md`](catalog-rollout-cohorts.md).

## Why neither task touches frontend business logic

Not a promise — a property two CI gates hold.

`validate-storefront-catalog-driven.mjs` and
`validate-authoring-schema-driven.mjs` refuse a category-specific or
product-type-specific field list, filter list, spec list or controlled value
anywhere the apps COMPILE: `packages/frontend`, `packages/dashboard`,
`packages/pos` and `packages/ui/src`. The `ui` half matters — every app consumes
it from source, so a prefix-scoped gate had a documented workaround until #478
widened it.

So a product-type-specific branch is **unrepresentable** in the frontend. Adding
a product type cannot require editing one, because there is none to edit. If you
find yourself wanting to, the gate will refuse the diff and the want is the bug.

---

## Adding a product type

The three reference packages are the worked examples: `footwear.ts`,
`smartphone.ts` and `brake-pad.ts` in
`packages/backend/src/scripts/seed-verticals/`.

1. **Write the package.** One file in that directory, shaped by `types.ts`. It
   declares the product type, its fields, its attribute citations and its
   controlled values as DATA. Copy the closest of the three. The one measured
   difference worth steering by: `brake-pad.ts` is the fitment example — 46
   `fitment` references against 2 in each of the others — so start there if your
   type is compatibility-shaped. `footwear.ts` and `smartphone.ts` are not
   separated by anything a grep distinguishes; read both and pick.
2. **Register it** in `seed-verticals/index.ts`.
3. **Nothing else is code.** `apply.ts` already calls
   `insertProductTypeDefinition` and then `publishProductTypeVersion`; `census.ts`
   already verifies. Both are generic over the package list.
4. **Run it.** The invocation, the dry-run default and the `--apply` write are in
   [`verticals/README.md`](verticals/README.md) — read its "Running the seed" and
   "The measurement discipline" sections, which explain why the census counts
   Postgres rather than the run.
5. **Publish is a version, not an edit.** A published product-type version is
   immutable; changing one later means publishing a NEW version. See
   [`product-types.md`](product-types.md) §"Immutable once published".

**No frontend file changes**, and no migration — a product type is rows, not
schema.

---

## Adding a locale

Three edits, and the compiler forces the order.

1. **Add the tag to `SUPPORTED_LOCALES`** in
   `packages/shared-types/src/catalog-localization.ts`. Lowercase — BCP 47 tags
   are case-insensitive and two spellings of one tag is a lookup that misses
   rather than an error anybody sees.

2. **`tsc` will now fail, and that is the design.**
   `LOCALE_TEXT_SEARCH_CONFIGURATIONS` in
   `packages/shared-types/src/catalog-search-configuration.ts` is
   `Readonly<Record<SupportedLocale, PostgresTextSearchConfiguration>>` — TOTAL
   over the union — so a new locale has no analyser until you give it one. You
   cannot forget this decision; you can only make it.

3. **Ship a storefront bundle.** `packages/frontend/lib/i18n/locales/<tag>.json`
   plus its entry in `lib/i18n/index.ts`. `SUPPORTED_LOCALES` is derived from
   what that app can present — a catalog translation in a locale no client can
   render is a translation nobody reads.

### The step that decides whether you need a migration

**Which analyser you chose in step 2 decides it, and the two cases look
identical from TypeScript.**

`listing_localizations.search_vector` is a `GENERATED ALWAYS AS … STORED`
column whose `CASE` arms are rendered from `localesByTextSearchConfiguration()`.

- You mapped the locale to `UNANALYZED_TEXT_SEARCH_CONFIGURATION` (`simple`) —
  that function OMITS it, because `simple` is the `CASE`'s `ELSE`. The rendered
  expression does not change. **No migration.**
- You mapped it to a real analyser (`spanish`, `arabic`, …) — the expression
  gains or extends an arm. **Run `bun run build:shared-types` and then
  `bun run --cwd packages/backend db:generate`, and land the migration in the
  same PR.**

The generated expression is byte-stable because the function sorts. Do not
"tidy" that sorting away: an unstable expression makes `drizzle-kit generate`
emit a column rewrite on a run that changed nothing, and the rewrite silently
drops the column's GIN index.

### What you do NOT do

- **No frontend business logic.** A bundle is data.
- **No per-locale branch anywhere.** The fallback chain is documented in
  [`catalog-localization.md`](catalog-localization.md) §"The fallback chain";
  text never falls back across MARKETS and only one class falls back at all.
- **No backfill of existing rows.** A missing translation is a `missing` row
  with a NULL text, not an absent one, and the desk surfaces it.

---

## Verifying you are done

```
bun run build:shared-types
bun run --cwd packages/backend typecheck
bun run --cwd packages/backend test
bun run validate:storefront-catalog
bun run validate:authoring-schema
```

The last two are the ones that would catch a product-type-specific branch having
crept into an app. If they pass and you edited no file under `packages/frontend`,
`packages/dashboard` or `packages/pos`, the criterion this document exists for is
satisfied by construction rather than by inspection.
