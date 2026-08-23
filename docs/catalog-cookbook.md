# The catalog cookbook

> #367 Workstream 19. How to add a category, a product type version, an
> attribute and a controlled value; how sizes, units and colours are modelled;
> and the commands that check your work. Binding:
> [ADR 0007](adr/0007-universal-catalog-taxonomy-and-authoring.md). Vocabulary:
> [catalog-glossary.md](catalog-glossary.md). Ownership and the migration slot:
> [catalog-table-ownership.md](catalog-table-ownership.md).
>
> Every procedure here is the one the code supports today. Where the obvious
> route does not exist, this says so rather than describing the one somebody
> meant to build.

## Before anything else: the four things a catalog change is

1. **A data change**, applied by a script or an operator surface — never a
   migration. A catalogue seeded by a migration is a policy nobody signed: it
   applies to every deployment with no author, no date and no way to decline.
2. **Versioned where it carries meaning.** A product type and an attribute are
   `(key, version)`, immutable once published. You do not edit a published
   version; you publish a new one.
3. **Named by a stable machine key**, lowercase, in a documented namespace, and
   frozen by trigger after insert. A concept whose key was wrong is deprecated
   and superseded, never renamed.
4. **Localized separately.** The base-locale name is a column on the row; every
   other locale is a row in the localization family, with its own status and
   provenance.

## Add a category

**There is no "create a category" endpoint, and that is deliberate.** The
governance action vocabulary (`CATALOG_GOVERNANCE_ACTIONS`,
`shared-types/src/catalog-governance.ts:131`) has `taxonomy_rename`,
`_move`, `_merge`, `_redirect`, `_publish`, `_deprecate`, `_suppress` and
`_restore` — every lifecycle verb and no create. Two paths mint a category row,
and `db/taxonomy/taxonomyRepository.ts` is the sole writer behind both
(`db/__tests__/taxonomy-write-chokepoint.test.ts:136` fails the build on a
third).

### For production: `provision-taxonomy.ts`

The tree lives in one constant, `packages/backend/src/scripts/taxonomy.ts`,
imported by both the provisioning script and the dev seed — two lists of one
taxonomy disagree the first time somebody edits whichever file they opened.

```bash
DATABASE_URL=… bun --cwd packages/backend src/scripts/provision-taxonomy.ts
```

It is idempotent by construction, not by care: the only statement it can issue
against `categories` is an INSERT, and only for a key the repository reports
absent. There is no UPDATE and no DELETE in it, so a second run writes nothing
and a re-run after a partial failure completes the tree from where it stopped.
It is **not** `seed.ts` — that one opens with `clearMarketplace`, which deletes
every order, listing, store and category in the database it is pointed at.

### For a vertical package: declare it and apply

A reference vertical declares its categories beside its attributes and product
type, and one apply lands the lot. `POST
/internal/catalog-governance/vertical-packages/:packageName` drives exactly this
script and nothing else.

### Then

- **Assign the machine key at insert.** `CATEGORY_KEY_PATTERN`
  (`shared-types/src/taxonomy.ts`) is the shape; `mercaria_category_key_frozen`
  (`drizzle/0088_redundant_korvac.sql:248`) makes it permanent.
- **Decide `selectable`.** A structural node — a root, a grouping level — is not
  a valid product assignment. The refusal is the write chokepoint plus the
  trigger `mercaria_category_assignment_selectable`
  (`drizzle/0088_redundant_korvac.sql:461`, `:465`), which is a trigger and not a
  CHECK because a CHECK cannot read another row.
- **Add localizations** (below). The base-locale name is `categories.name`;
  everything else is a `category_localizations` row.
- **Add a localized slug per locale you serve.** `category_localized_slugs`,
  `(locale, slug)` unique over retired rows too. A slug CHANGE is a new row plus
  a `category_redirects` entry, never an UPDATE — `category_redirects` is
  append-only by trigger and corrections chain.
- **Moving or merging is a governance change request**
  (`POST /internal/catalog-governance/changes`, then `/apply`), because it
  rewrites a subtree's `ancestor_ids` and needs an impact count and an audit row.
  Cycles, self-parenting and merging into a descendant are refused by trigger.

## Add or version a product type

**A product type version is created in exactly one place:**
`scripts/seed-verticals/apply.ts:536`, through `insertProductTypeDefinition`.
Over HTTP that is reachable only as `vertical_package_apply`. There is no
`POST /product-types` — `routes/product-types.ts` is a public read-only surface
with one GET.

So the procedure is:

1. **Write the package.** `packages/backend/src/scripts/seed-verticals/` — see
   `footwear.ts` for the smallest complete example: categories, attribute
   definitions with their enum values and localizations, field groups, the
   product type, then brands, products and variants.
2. **Bump `version` on the definition, never edit the published one.**
   `(key, version)` is unique and `product_type_definitions_one_published_per_key`
   is a partial unique on `lifecycle = 'published'`, so publishing a new version
   must deprecate its predecessor in the same transaction; the index refuses any
   ordering that would leave two current schemas for one key.
3. **Set the category scope.** `product_type_category_scopes` is a junction
   table, and **no rows means the version may be used nowhere.** That is the
   opposite reading from `attribute_definition_categories`, whose empty scope
   means "everywhere", and the asymmetry is deliberate: an attribute scope
   NARROWS something general, a product-type scope GRANTS a place, and a grant
   naming no destination grants none. A freshly drafted version permits nothing
   until somebody says where.
4. **Dry-run, then apply** (commands below).
5. **Publish** through a governance change request — action
   `product_type_publish`, handled at
   `services/catalog-governance/apply.ts:307`.

Once published, **two** triggers hold the immutability, not the one ADR D5
names: `mercaria_product_type_definition_immutable`
(`drizzle/0089_kind_blink.sql:155`, trigger `:193`) freezes `key`, `version`,
`pending_proposal_policy` and the audit column on the parent — `name`,
`description` and `lifecycle` stay editable by design — and
`mercaria_product_type_child_frozen` (`:211`, triggers `:234`, `:238`, `:242`)
freezes the fields, groups and category scopes, which are the actual schema.

**A field cites an attribute and restates nothing about it** — no type, no unit
family, no validation copied across. Duplicating those is how two descriptions of
one fact come to disagree.

## Add an attribute

`POST /internal/catalog-attributes/definitions` drafts one;
`POST /internal/catalog-attributes/definitions/:key/versions/:version/publish`
publishes it. Both are behind `CATALOG_OPERATOR_OXY_USER_IDS`. In a vertical
package the same two calls are `apply.ts:471`.

Decide four things at draft time, because after publication they are frozen:

- **`valueType`** — `enum`, `measurement`, `integer`, `decimal`, `string`,
  `boolean`, `money`, `structured`.
- **`unitFamily`, for a `measurement`** — one of sixteen
  (`shared-types/src/attribute-registry.ts:165`). Every family names ONE base
  unit and normalization stores the magnitude in that base, so "256 GB" and
  "0.256 TB" land on one number. **Conversion across families is refused, never
  approximated**, which is what makes `percentage`, `ratio` and `rating` three
  distinct dimensionless families: no constraint can compare an 85 %
  screen-to-body against a 4.5-star score even though both are bare numbers.
- **`variantDefining`** — may this attribute differentiate variants.
- **`hardConstraintCapable`** — may a filter treat it as a hard requirement.

**The key cannot be one of the twenty reserved offer facts.**
`RESERVED_OFFER_FACT_KEYS` (`attribute-registry.ts:371`) — `price`,
`availability`, `in_stock`, `stock`, `condition`, `shipping_cost`,
`delivery_days`, `seller`, `merchant` and eleven more — is rendered into
`attribute_definitions_reserved_key_check`. Those are properties of an OFFER and
are answered through the offer-facts port, so a hard commerce constraint excludes
rather than being satisfied from a stale feed.

## Add a controlled value

A controlled value is an `attribute_enum_values` row: a stable lowercase `value`
key, a base-locale `label`, any number of `attribute_value_aliases` (the
spellings a source might use) and an `attribute_value_localizations` row per
locale.

```ts
// scripts/seed-verticals/footwear.ts:388
{ key: 'footwear_color', valueType: 'enum', variantDefining: true,
  enumValues: [
    { value: 'black', label: 'Black',
      aliases: ['jet black', 'midnight', 'onyx', 'negro', 'schwarz'],
      localizations: [{ locale: 'es', label: 'Negro' }, { locale: 'de', label: 'Schwarz' }] },
  ] }
```

**The vocabulary of a published version is frozen, and this is the sharp edge.**
`mercaria_attribute_enum_frozen` (`drizzle/0024_greedy_wendigo.sql:317`, mounted
on `attribute_enum_values` at `:339` and on `attribute_value_aliases` at `:343`)
refuses **INSERT, UPDATE and DELETE** whenever the parent definition's
`lifecycle_state` is anything but `draft` — because an alias table that could
change after publication would let `USB C` resolve to a different canonical value
than it did when a stored value was normalized. So adding a colour to a live
attribute is: **draft a new version of the attribute, carry the vocabulary
forward with the new value, publish it.**

> **Known defect, stated rather than worked around.** The proposal surface does
> not do that. `approveControlledValueProposal`
> (`services/catalog-proposals/review.service.ts:176`) calls
> `insertAttributeEnumValue` directly against the definition the proposal names,
> and the enum-freeze trigger refuses it with `restrict_violation` for any parent
> that is not `draft`. `scripts/seed-verticals/apply.ts:471` publishes every
> attribute it drafts, so in a seeded deployment every attribute a merchant can
> see is `active`. The one realdb case that mints a controlled value
> (`services/catalog-proposals/__tests__/catalog-proposals.realdb.test.ts:322`)
> uses a `draft` fixture — chosen for an unrelated teardown reason stated at
> `:104` — so the production state is untested. Until that is fixed, an approved
> controlled-value proposal is completed by publishing a new attribute version by
> hand.

## Sizes, units and colours

There is **no `size_systems` table, no `unit_definitions` table and no colour
table.** Verified by census: of 445 distinct table names across the whole schema,
zero contain `size`, `unit` or `colo` (positive control: twelve contain
`categor`). This is not an omission to fill in — it is how the three are
modelled.

### Units are a code-level family, normalized to a base

`UnitFamily` is sixteen members in `@mercaria/shared-types`, each naming one base
unit. A `measurement` attribute declares its family; magnitudes are stored in the
base and formatted at the boundary with `Intl`/CLDR. Canonical numeric storage is
independent of formatting, and `measurement_system` is one of the seven
independent request dimensions — it changes what a shopper reads, never what is
stored.

### A size system is an ATTRIBUTE, one per system

Footwear declares five: `shoe_size_eu`, `shoe_size_us_mens`,
`shoe_size_us_womens`, `shoe_size_uk` (all `valueType: 'enum'`) and
`shoe_size_cm` (`valueType: 'measurement'`, `unitFamily: 'length'`) —
`scripts/seed-verticals/footwear.ts:274`, `:299`, `:316`, `:332`, `:355`.

Two consequences, both worth saying out loud:

- **There is no conversion between size systems.** "EU 42 is UK 8" is not a fact
  this system holds anywhere. A product publishes the systems it actually prints
  on the box; a shopper filtering on `shoe_size_uk` sees the products that
  declared one.
- **Audience context is the CATEGORY SCOPE, not a column on the size.**
  `shoe_size_us_mens` is scoped to the men's category, so a women's listing's
  authoring schema and a women's facet list cannot offer that key at all — which
  is what stops `9` under one definition being read beside `9` under the other.

#### …and a SECOND, disjoint key namespace, for external mappings only

`catalog_external_mappings` records that a source's token means a size system,
and its `target_size_system_key` is a different column with a different CHECK —
so a size system also has a key in `services/canonical/size-systems.ts`:
`size.shoe_eu`, `size.shoe_us_mens`, `size.shoe_cm`.

Adding one is a code change and nothing else — no table, no migration:

1. Append an entry to `DECLARED_SIZE_SYSTEMS` in
   `services/canonical/size-systems.ts` with a short opaque key in the `size.`
   namespace and all four facets — `domain`, `region`, `audience`,
   `measurementBasis` — plus a `valueShape`.
2. That is the whole procedure. The build refuses two entries under one key, and
   `size-system-registry.test.ts` asserts every entry declares all four facets.

**Do not compose the key from the facets, and never parse one.** Two systems
agreeing on all four facets and differing only in key is the aliasing relation
`no_sourced_mapping` exists to express, and a derived key would make it
unrepresentable. **Correcting a facet is a NEW entry under a NEW key**, never an
edit: an entry is frozen the way its key is.

Add a system only when Mercaria's catalogue can actually express it. A key the
registry holds makes a mapping RESOLVE, so seeding a convention no listing can
carry points reviewed mappings at nothing. And do **not** relate these keys to
the attribute keys above: a gate scans both modules against the footwear seed's
own key list and fails the build on one.

### A colour is a controlled value, and its marketing name is a different field

`footwear_color` is an enum with aliases and per-locale labels; `footwear_colorway`
is `valueType: 'string'` and is deliberately unfiltered
(`footwear.ts:388`, `:438`). A filter over marketing strings is an unbounded
facet, which is the failure this pair exists to prevent. "Midnight Cobalt" is
recorded as the seller wrote it and resolves to `blue` for filtering, through the
alias — it is not thrown away and it is not made a facet.

## Validation commands

```bash
bun install
docker compose -f docker-compose.postgres.yml up -d          # Postgres on :5435

# Vertical packages: dry run is the DEFAULT and reads the database.
bun run seed:verticals
bun run seed:verticals -- --package=footwear
bun run seed:verticals -- --apply
bun run seed:verticals -- --apply --package=brake_pad --namespace=demo

# Taxonomy only, safe against production, idempotent.
DATABASE_URL=… bun --cwd packages/backend src/scripts/provision-taxonomy.ts

# The suites. realdb files need Postgres up.
bun run --cwd packages/backend test
bun run --cwd packages/backend typecheck

# The scanned gates CI runs (eleven `validate:*` steps in ci.yml).
bun run validate:authoring-schema      # no hard-coded category form in the dashboard
bun run validate:storefront-catalog    # no hard-coded category or facet list in the storefront
bun run validate:facet-label-copy      # facet labels come from the server, in all four packages
bun run validate:i18n-strings
```

`seed:verticals` exits `0` when every declared row is present and agrees, and `1`
when a step diverged **or the census found the wrong number of rows or found
none** — the vacuity floor is a separate verdict from the run's own counters, so
a pass that wrote nothing cannot report success.

Before `bun run --cwd packages/backend db:generate`, always
`bun run build:shared-types` — every closed-value-set CHECK is rendered from the
BUILT package, and a stale `dist/` silently narrows a sibling branch's tuple back
in a diff that looks entirely plausible.

## Where to read next

| Question | Doc |
|---|---|
| What each concept IS, and the ERDs | [catalog-glossary.md](catalog-glossary.md) |
| Who owns and may write each table; the migration slot | [catalog-table-ownership.md](catalog-table-ownership.md) |
| `AuthoringSchema`, the DTOs, API examples, anti-patterns | [catalog-contracts.md](catalog-contracts.md) |
| Localization statuses, fallback, the review workflow | [catalog-localization.md](catalog-localization.md) |
| The reference verticals and their measurement discipline | [verticals/](verticals/) |
| Rollout, rollback and the incident runbooks | [catalog-migration-operations.md](catalog-migration-operations.md) · [runbooks/](runbooks/) |
