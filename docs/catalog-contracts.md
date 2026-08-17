# The catalog contracts: `AuthoringSchema`, the shared DTOs, and how to call them

> #367 Workstream 19. What `@mercaria/shared-types` publishes for the catalog
> epic, what an API call looks like when it names things by stable id, and the
> four shapes that keep coming back and are wrong every time. Binding:
> [ADR 0007](adr/0007-universal-catalog-taxonomy-and-authoring.md) D1, D5, D10.

## `AuthoringSchema` — one server-owned contract

`packages/shared-types/src/authoring-schema.ts:351`. The dashboard renders a
product form by walking this object. It holds no category-specific knowledge of
its own, which is the point: adding a product type is a data change, not a
frontend release.

```ts
interface AuthoringSchema {
  contractVersion: number;              // AUTHORING_SCHEMA_CONTRACT_VERSION
  productType: AuthoringProductTypeRef; // definitionId + key + VERSION + lifecycle
  categoryId: string;
  flow: ProductTypeAuthoringFlow;       // merchant | p2p | operator | connector | verified_brand
  market: string;
  locale: AuthoringLocaleContext;
  permissions: AuthoringPermissionContext;
  steps: readonly AuthoringStep[];      // ordered, each with `available`
  groups: readonly AuthoringGroup[];
  fields: readonly AuthoringField[];    // RULES only — no label lives here
  text: AuthoringSchemaText;            // LABELS only, keyed by stable field id
  etag: string;
}
```

**The rule/text split is the load-bearing part** (`AuthoringField:309` versus
`AuthoringSchemaText:220`). A field carries `attributeDefinitionId`,
`attributeVersion`, `scope`, `requirement`, `valuePolicy`, `variantCapable`,
`visibilityRule` and `validation` — and no string a human reads. The labels live
in `text`, keyed by the field's stable id. A client that read a label as a rule
would have no way to localize without changing behaviour, and that failure is
silent: the form still renders, in the wrong language, with the wrong fields
required.

Three more properties worth knowing before you consume it:

- **`etag` is the one cache validator** and is a deterministic hash over every
  semantic dimension plus the composed body, so two ECS tasks composing the same
  schema produce the same string. There is deliberately no `updatedAt` to compare
  instead — a timestamp is a fact about a row, and this is a composition over
  eleven of them.
- **`productType` is pinned to a version**, and `product_type_definitions` is
  `(key, version)` unique with one row per version, so an id *is* a version pin.
- **`steps[].available` says whether this deployment can complete the step at
  all.** A step that cannot be completed is reported false rather than omitted,
  because a missing step and an impossible one need different UI.

**Validation carries codes, never messages.** `AuthoringValidationFinding`
(`authoring-schema.ts:657`) has a `code` (one of 32,
`AUTHORING_VALIDATION_CODES:554`) and a `path`, and **no `message` property at
all** — stronger than ADR D10's wording, and it means there is no message text on
the wire for a client to match on. The dashboard maps codes to i18n keys in a
total `Record<AuthoringValidationCode, string>`
(`packages/dashboard/lib/authoring/findings.ts:157`), so a new code fails `tsc`
rather than rendering blank. Gated by
`services/catalog-authoring/__tests__/authoring-validation.test.ts:201`
("no finding carries a message property at all") and `:585`, which has a vacuity
floor so a suite that produced nothing cannot pass it.

## The fourteen modules the epic added

Every closed value set the catalog serves is a tuple in `@mercaria/shared-types`,
and every corresponding Postgres column is `text` + a CHECK rendered from that
same tuple. Adding a member is a code change **plus** `bun run db:generate` plus
an additive migration in the same PR — skip the migration and the first write of
the new value fails its CHECK in production with a green build.

| Module | What it publishes |
|---|---|
| `authoring-schema.ts` | `AuthoringSchema`, `AuthoringDraft`, the 32 validation codes, the upgrade preview |
| `taxonomy.ts` | `CategoryLifecycle`, alias kinds, redirect subjects and reasons, `CATEGORY_KEY_PATTERN`, `TaxonomyCategory` |
| `product-type.ts` | lifecycles, field scopes, requirements, flows, value policies, the visibility-rule AST and its bounds, the forbidden variant-axis keys |
| `catalog-localization.ts` | `SUPPORTED_LOCALES`, statuses, provenances, field classes, the fallback steps, `LocalizedResolution` |
| `catalog-proposal.ts` | the eight proposal types, the mintable/link-only split, states, the eleven review actions, duplicate detectors |
| `catalog-governance.ts` | domains, subject kinds, actions, roles, change states, impact coverage, snapshot scopes |
| `catalog-external-mapping.ts` | mapping dimensions, states, provenances, the permitted transforms and the forbidden ones |
| `compatibility.ts` | relation kinds, directions, applicabilities, verification states and methods, fitment positions and qualifiers, the vehicle vocabularies |
| `navigation.ts` | surfaces, tree lifecycles, the seven node target kinds and the forbidden ones, withhold reasons |
| `facets.ts` | facet origins, levels, value shapes, label sources, suppression reasons, the ordering inputs and the forbidden ones |
| `variant-axis.ts` | claim kinds and provenances, the claim resolutions, the axis refusals, the typed variant signature |
| `catalog-backfill.ts` | legacy subject kinds, classifiers, mapping classes and reasons, the writers and the forbidden signals |
| `catalog-metrics.ts` | the metric definitions, windows, kinds, unmeasured reasons, integrity checks, latency budgets |
| `connector-pins.ts` | `PINNABLE_CONNECTOR_FIELDS` and the unpinned keys |

**A prohibition is a vocabulary, not a comment.** Ten of those modules publish a
`*_FORBIDDEN_*` tuple that is DISJOINT from the allowed one, so the forbidden
thing has no row shape and no wire representation:
`NAVIGATION_FORBIDDEN_TARGET_KINDS`, `FACET_FORBIDDEN_ORDERING_INPUTS`,
`PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS`,
`COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS`,
`COMPATIBILITY_FORBIDDEN_VARIANT_AXIS_FACTS`,
`CATALOG_EXTERNAL_FORBIDDEN_TRANSFORMS`,
`CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS`,
`CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES`,
`LEGACY_CATALOG_FORBIDDEN_SIGNALS`, `NATIVE_CLAIM_FORBIDDEN_TARGETS`. Each is
paired with a scanned isolation test asserting the two sets are disjoint, so a
"plausible future addition" fails the build rather than quietly joining the
allowed set.

## API examples: name things by id, never by label

Every example below is the real shape. What they have in common is that no
request carries a word a human would translate.

### Browse a category and its children

```http
GET /categories?parentId=cat_01J9…&locale=es-ES
```

The response carries `id`, `key`, `parentId`, `ancestorIds` and — separately —
the localized `name` with its `effectiveLocale` and `status`.
`LocalizedResolution` (`catalog-localization.ts:582`) has a `resolved` branch
carrying all three non-optionally and an `unavailable` branch carrying none of
them, so a caller cannot render text the resolver declined to give.

**Never** `GET /categories?slug=zapatillas`. A slug is a per-locale presentation
record (`category_localized_slugs`), so that request has a different answer in
every market and none at all in a locale nobody translated. Resolve a URL through
the slug table and its redirects, then carry the id.

### Compose an authoring schema

```http
GET /catalog-authoring/schemas/smartphone?version=3&categoryId=cat_01J9…&flow=merchant&locale=es-ES&market=ES
If-None-Match: "sha256:…"
```

`smartphone` is the product type's stable machine **key**, not its name — the
name is `Smartphone` in English and `Teléfono inteligente` in Spanish and neither
identifies anything. Omitting `version` gives the currently published version;
naming it pins the composition.

### Save a draft value

```jsonc
PATCH /stores/{storeId}/product-drafts/{draftId}
{
  "values": [
    {
      "fieldId": "ptf_01J9…",              // the AuthoringField's stable id
      "attributeDefinitionId": "attr_01J9…",
      "attributeDefinitionVersion": 4,      // the exact version, NOT NULL
      "enumValueId": "aev_01J9…"            // a controlled value by id
    }
  ]
}
```

Not `{"attribute": "color", "value": "Negro"}`. `Negro` is a label; the fact is
the enum value `color.black`, whose Spanish label happens to be `Negro` and whose
aliases include `negro`, `onyx` and `midnight`
(`scripts/seed-verticals/footwear.ts:398`). A write keyed on the label matches
one of those spellings and silently fails on the other four.

The version is not decoration: `mercaria_catalog_authoring_value_citation`
(`drizzle/0098_young_lorna_dane.sql:231`, trigger `:274`) refuses a value whose
`(attribute_key, version)` disagrees with the definition it references, and
refuses one whose `field_id` cites a different definition.

### Filter

```http
POST /facets
{ "scope": { "categoryId": "cat_01J9…" },
  "selection": [ { "attributeDefinitionId": "attr_01J9…", "enumValueIds": ["aev_01J9…"] } ] }
```

Not `?color=black&size=42`. Beyond the identity argument there is a correctness
one: the facet rail correlates every variant requirement to ONE variant row
(`db/facets/facetRepository.ts:362`), which is what stops a product matching
because one variant is red and a different one is size 42.

## Do not do this

### 1. Do not hard-code a category form in React

The dashboard has no `if (category === 'shoes')` and must not grow one. Two
scanned gates enforce it and both run in CI:

- `scripts/validate-authoring-schema-driven.mjs`, run as `validate:authoring-schema`
  (`.github/workflows/ci.yml:167`) — four walls over `packages/dashboard/`,
  vacuity floor 60 files; it currently scans 115.
- `scripts/validate-storefront-catalog-driven.mjs`, run as
  `validate:storefront-catalog` (`ci.yml:189`) — five walls over
  `packages/frontend/`, floor 120; it currently scans 196.

Both npm scripts run their own `test-validate-*.mjs` self-test in the same
command (`package.json:31`, `:36`), so a detector that stopped detecting fails
beside the scan rather than passing quietly.

Both state their own blind spots in the file: a vocabulary re-listed with **no
type annotation** is invisible to the re-listing wall, and a **cross-file**
constant is invisible to the binding-resolution wall.

**`packages/pos` and `packages/ui` are covered by neither gate.** `ui` has no
test runner at all (`package.json:15` is `echo "No tests specified"`), so a
hard-coded category list added there today fails nothing.

### 2. Do not make a display string an identity

Not as a foreign key — `db/__tests__/catalog-identity-isolation.test.ts` fails the
build on a key pointed at `name`, `slug`, `label`, `title` or `description`, over
791 foreign-key targets in 82 schema files.

Not as a request field either. `category: z.string()` and `productType:
z.string()` exist in exactly seven places, all of them pre-#367 v1 listing
contracts (`middleware/schemas.ts` ×6, `sell-yours-schemas.ts` ×1), and that set
is frozen: clause 3 of the same gate fails on an eighth. The epic's own nine
request-schema modules contribute zero.

And not as an option axis. `listing_options.name` and
`product_variant_option_values.name`/`.value` are retained as **legacy claims**
with their provenance (ADR D6) and are superseded, never normalized in place. An
ambiguous legacy value stays text and stays unresolved in a review queue —
`resolveLegacyOptionName` refuses `Tono` *and* refuses `Colour`
(`services/variant-axes/legacy-resolution.ts:160`; tests at
`variant-axis-legacy-resolution.test.ts:171` and `:184`), because a near-miss is
a miss and inventing a normalization is the false merge #58 is shaped around.

### 3. Do not mix domain boundaries

Price, stock, availability, condition and fulfilment do not belong on a canonical
product or variant, and are not modellable as product-type attributes.
`RESERVED_OFFER_FACT_KEYS` (`shared-types/src/attribute-registry.ts:371`) names
twenty keys — `price`, `availability`, `in_stock`, `condition`, `shipping_cost`
and sixteen more — rendered into `attribute_definitions_reserved_key_check`, so
they cannot be defined as attributes at all. `product-type-isolation.test.ts:150`
asserts the product-type schema module declares no listing, offer, inventory or
price column.

A walk of `db/schema/canonicalCatalog.ts` — 17 tables, 225 columns — finds zero
price, stock, availability, condition or fulfilment columns, and that is now a
property rather than a census:
`db/__tests__/canonical-commerce-column-isolation.test.ts` refuses fifteen
segment prohibitions across every canonical column. Adding `price_amount` or
`available_quantity` to `canonical_variants` fails the build naming both the
column and the prohibition.

Two exemptions, both the money slot of a `money`-typed attribute value
(`canonical_attribute_values.normalized_amount_minor` and `normalized_currency`).
They are safe because `attribute_definitions_reserved_key_check` is rendered from
`RESERVED_OFFER_FACT_KEYS`, so the attribute they belong to cannot be defined as
a price, an availability or a condition in the first place — and the gate asserts
that reason in its own terms, so narrowing the CHECK turns the exemption red
instead of leaving it quietly unsafe. `msrp` is deliberately not reserved: a
manufacturer's suggested price genuinely is a product fact, and a money-typed
attribute is its right home.

What the gate does **not** cover is stated in the file: a commerce fact under a
name no prohibition carries — `rrp`, `msrp_snapshot` — passes. That is the
direction a per-table allow-list would cover, and 225 entries across the
repository's oldest schema module is a merge conflict resolved by pasting.

Compatibility is not a variant axis either. One brake-pad SKU fits many vehicles
and stays one variant; a year range, a make or a model as an option value is the
epic's own worked counter-example.

### 4. Do not read `listings.product_type` as a product type

It is the free-text string a Shopify or WooCommerce import carried
(`db/schema/catalog.ts:368`). #367's product type is
`product_type_definitions`, and a listing carries no pin to it — the citation
lives on `native_listing_variant_axes.product_type_definition_id`, and that
column is **nullable and written only when the listing declares axes**
(`services/catalog-authoring/publish.service.ts:581`). So a published listing
with no variant axes carries no product-type version anywhere. Do not infer one.
