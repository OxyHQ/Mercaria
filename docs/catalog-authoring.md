# Catalog authoring (#367 step 5, ADR 0007 D10)

The server-owned surface a person authors a product against, and the reason no
React component ever again holds category-specific truth.

```
category + product type (exact version) + attribute definitions (exact versions)
        + controlled value policies + store/seller permissions
        + flow + locale + market
        = AuthoringSchema
```

| Piece | Path |
| --- | --- |
| The DTO | `packages/shared-types/src/authoring-schema.ts` |
| Tables | `packages/backend/src/db/schema/catalogAuthoring.ts` (4) |
| Repositories | `packages/backend/src/db/catalogAuthoring/` (4) |
| Services | `packages/backend/src/services/catalog-authoring/` (6) |
| Routes | `routes/catalog-authoring.ts`, `routes/product-drafts.ts` |
| Controller | `controllers/catalog-authoring.controller.ts` |
| Request schemas | `middleware/catalog-authoring-schemas.ts` |
| Migration | `drizzle/0098_young_lorna_dane.sql` (`pre`) — four tables, three trigger functions, four triggers, and the `native_listing_links_method_check` widening |

Adding a product type is a data change. That is the acceptance criterion the
whole design is arranged around, and every rule below is what it costs.

## The surface

```
GET    /catalog-authoring/categories
GET    /catalog-authoring/product-types?categoryId=
GET    /catalog-authoring/schemas/:productTypeKey?categoryId=&market=[&version=&flow=&locale=]
GET    /catalog-authoring/canonical-search?q=[&kind=&canonicalProductId=]

GET    /stores/:storeId/product-drafts
POST   /stores/:storeId/product-drafts
GET    /stores/:storeId/product-drafts/:draftId
PATCH  /stores/:storeId/product-drafts/:draftId
DELETE /stores/:storeId/product-drafts/:draftId?version=
POST   /stores/:storeId/product-drafts/:draftId/validate
GET    /stores/:storeId/product-drafts/:draftId/upgrade      -- the PREVIEW
POST   /stores/:storeId/product-drafts/:draftId/upgrade      -- APPLY it
POST   /stores/:storeId/product-drafts/:draftId/publish
```

Everything under `/stores/:storeId/product-drafts` runs
`authenticateToken → validateId('storeId') → loadStore →
requireStorePermission('products:write')`. That permission is reused rather than
invented: `store_members_permissions_check` renders `STORE_PERMISSIONS`, so an
unlisted string is a refusal at the row, and a merchant authoring a product is
doing exactly what `products:write` names. `products:read` is not used even for
the reads, because a draft is unpublished work rather than catalogue, and the
set of people who may see one is the set who may write one.

The whole surface is behind `CATALOG_AUTHORING_ENABLED` (ADR 0007 D12, default
false). It gates the MOUNT and never a row.

### The mount order matters

`app.ts` mounts `/stores/:storeId/product-drafts` **before** `/stores`.
`storesRouter` is the public store page and its
`router.use(makeRateLimiter('stores'), optionalAuth)` matches every path under
the prefix, so mounting after would run a full Oxy verification on every draft
request and then run `authenticateToken`'s again.

## What is composed, and what is only referenced

`AuthoringField` carries stable ids and keys, scope, type, requirement,
validation, grouping, order and value policy. `AuthoringSchemaText` carries the
labels, help, placeholders and examples, keyed by the stable id of the thing
they describe. **They are two properties of the response and no rule-bearing
type has a `label` property at all** — a client that read a label as a rule could
not localize without changing behaviour, and `if (field.label === 'Colour')`
works in one locale and silently stops working in the next.

Price, stock, availability, condition and fulfilment are **steps**, never
product-type fields. `AuthoringStepKind` is the closed list, and
`AUTHORING_FORBIDDEN_FIELD_KEYS` restates #94's reserved-key CHECK at the layer
where a client would otherwise learn to write `fields.price`.

`AuthoringFieldValidation` is a PROJECTION of one exact `attribute_definitions`
version. It is restated in the response because a form has to validate before it
submits — and it cannot drift, because nothing writes it: changing an attribute's
meaning means publishing a new registry version, which a pinned draft does not
adopt.

## The cache, and why it is a KEY rather than an eviction

ADR 0007 D10 asks for caches keyed by every semantic dimension and invalidated
through transactional events rather than process-local assumptions.

The key is `AuthoringSchemaKey` — product type version, category, flow, locale,
market, permission fingerprint — **plus the revisions of every mutable subject
the composition read**, from `catalog_authoring_schema_invalidations`. A writer
bumps a subject's revision in its own transaction; a composition reads the
revisions it depends on and puts them IN the key.

This is a stated divergence from an outbox with a dispatcher, and the reason is
the delivery WINDOW: between the write and the dispatch, every task still serves
the old entry and nothing anywhere says so. A revision in the key has no window —
an entry composed under revision 4 is unreachable the instant the revision is 5,
in every ECS task, because no lookup can name it. The cost is one small indexed
read per composition, paid against a composition that already issues five.

Four subjects, and only four, because everything else is frozen by somebody
else's trigger: a published `product_type_definitions` version and an active
`attribute_definitions` version are both immutable. What can still move is the
controlled-value set, the localizations, the category, and — for a draft or
in-review product type, which is **never memoized at all** — the version itself.

`bumpAuthoringSchemaInvalidation(tx, subject)` is the seam other domains call
inside their own transaction. Today the authoring domain is its only caller, and
that is stated rather than hidden: an un-bumped subject cannot produce a stale
answer, only a slower one, because the memo holds exactly what is frozen.

### The ETag

`authoringEtag(key, body)` hashes a canonical serialization — object keys sorted
recursively, `undefined` dropped — of the body TOGETHER with the key. Hashing
`JSON.stringify(body)` would be deterministic only while every object literal
kept its property order, and a refactor moving one field would re-download every
form for every merchant with no test able to tell that from a real change.

Including the dimensions is not redundant: two different requested locales that
both fall back to `en` produce identical bodies and must stay distinguishable,
because the next translation to land changes one and not the other.

**Nothing time-varying may enter the hashed value.** There is no clock reading in
the composition and none may be added.

## Drafts

`catalog_authoring_drafts` pins the category, the exact product-type version, the
locale and the market; every answer additionally pins the exact attribute
definition version it was given under. The attribute pin is on the VALUE and not
on the draft, because a schema cites twenty attribute versions and an upgrade
preview has to say which individual answers move.

- **Autosave is a patch of what was SENT.** A field not named is untouched; a
  field named with an empty list is CLEARED. A wizard saving one section must not
  clear the four the author has not opened.
- **Optimistic concurrency is on the DRAFT.** `version` is a compare-and-swap
  carrying the store, the id and `status = 'open'` in the same predicate; the
  empty result set IS the refusal, answered 409 naming the version to re-read. A
  per-answer token would let a variant matrix computed against one set of axes be
  applied to another.
- **Values are stored TYPED** — five value columns, a `kind` discriminant, and
  `num_nonnulls(...) = 1` beside five per-kind biconditionals. The count refuses
  a row populating two; the biconditionals refuse one populating the wrong one.
  Either alone admits a row the other catches.
- **The variant matrix is replaced whole**, never patched. Reconciling a partial
  update against `axis_signature` would need a rule for a row whose axes moved
  onto another row's, and there is no such rule that is not arbitrary.
- **The axis signature is order-independent** (ADR 0007 D6): the normalized set of
  `(attributeDefinitionId, normalizedValue)` pairs, sorted and hashed, unique per
  draft by a partial index. Two variants entered in different orders collide by
  construction.

### Moving forward: the draft upgrade, and the LISTING twin (#587)

ADR 0007 D10 says a newer schema version produces a PREVIEW, never a silent
rewrite. Two pairs implement it, and they are deliberately the same shape:

| Record | Preview | Apply |
|---|---|---|
| An open draft | `previewDraftUpgrade` | `applyDraftUpgrade` |
| A published listing | `previewListingProductTypeUpgrade` | `applyListingProductTypeUpgrade` |

Both are `GET` and `POST` on one path — two verbs are what make "look" and "do"
different requests, and one endpoint returning a preview AND applying it makes
the rewrite reachable by a client that only meant to look. Both are store-scoped
behind `products:write`.

**The field comparison is ONE function.** `version-upgrade.ts`'s
`compareProductTypeVersionFields` is pure, takes the two versions' fields for one
flow plus the keys the record has answered, and both callers use it. It was
written once inside `previewDraftUpgrade`; copying it for the listing would have
been two statements of one rule, and the direction they drift in is the
flattering one, because a preview that under-reports reads as a safe upgrade.

**The listing half existed nowhere before #587.**
`listings.product_type_definition_id` had only INSERT writers, so a listing
published under v1 stayed there forever and `catalog-governance/impact-plan.ts`
recorded that as `rewire_path_missing`. Migration 0109's trigger permits
`value → value` "precisely so #367 box 12's published-listing migration has
somewhere to land" — the database was ready and nothing called it. The
disposition is now `rewired_by_domain` naming the pair, and
`impact-plan-census.test.ts` pins the EXACT `rewire_path_missing` set so closing
a gap is as visible as opening one.

**The apply writes ONE COLUMN.** Every `native_listing_attribute_claims` and
`native_variant_attribute_claims` row keeps the attribute version it was settled
under; every `native_listing_variant_axes` row keeps the product-type version
that authorised it. A field the target no longer declares becomes a
`field_removed` line and `losesAnswers: true`, and nothing deletes the answer —
`applyDraftUpgrade`'s ruling verbatim, because deleting one is the silent
rewrite D10 forbids wearing a tidy-up's clothes.
`listing-upgrade.realdb.test.ts` measures that as a READ-BACK rather than as an
absence, and mutation-tests it.

**Two blockers, both mechanical.** `variant_axis_not_authorised` is
`mercaria_native_variant_axis_citation`'s own predicate applied at the listing
grain: a target that declares no `variant_capable`, `variant`-scope field for a
declared axis is a version the database would refuse an axis row under, so
moving the LISTING onto it reaches that state through the one door the trigger
does not watch. It refuses rather than repairing because the axis cannot follow
— `mercaria_native_variant_axis_frozen` makes its citation immutable and
re-declaring cascades every assignment away, so the alternatives are refuse or
destroy. `listing_not_editable` covers `restricted`, `archived` and `sold`; the
status list is stated positively, so a sixth status nobody classified is refused
rather than admitted.

**Deferred, with its cost measured.** A BULK operator path over every listing
pinned to a version is a governance ACTION, and one needs a
`CATALOG_GOVERNANCE_ACTIONS` member — CHECK-rendered onto both
`catalog_governance_change_requests.action` and
`catalog_governance_audit_events.action` — and therefore a `pre` migration in the
same PR, exactly the `CurrencyCode` rule. It is also a policy nobody has decided:
the draft upgrade is store-scoped, and "a merchant may re-pin their own draft but
not their own listing" is not an asymmetry to introduce as a side effect of where
an endpoint lives. The trigger clause that would state the axis rule at the row
is separately owed, and named in `db/schema/variantAxes.ts` and
`docs/variant-axes.md`.

### Expiry

`expires_at` is NOT NULL exactly while a draft can still be abandoned and NULL
once it is published — a biconditional CHECK. The expiry sweep's predicate is
`expires_at <= now()` and nothing else, so that CHECK is what makes the selection
equal to "the abandoned ones" and never the audit record of a listing that
exists. The `notifications.dismissed_at` device: a condition the sweep cannot
express, turned into a column it can.

## Validation

Stable machine codes and stable paths, and **no message property exists on a
finding**. The sentence is composed at the HTTP boundary; a client never matches
on text.

`error` blocks publication and `warning` does not, which is what makes
`recommended` a real requirement level: a recommended field left empty is
reported, visibly, in the same list, and still publishes.

Paths are one spelling: `fields.<attributeKey>`,
`fields.<attributeKey>[<ordinal>]`, `variants[<position>].price`,
`variants[<position>].fields.<attributeKey>`, `listing.title`,
`classification.categoryId`.

Two answers worth knowing:

- **An unresolved condition hides a field rather than demanding it.**
  `effectiveFieldRequirement` is called, not re-implemented: treating `unknown`
  as visible deadlocks a form, because the author is told a field is required
  while the field whose answer would decide that is not shown yet.
- **`implausible` is a WARNING and out-of-range is an ERROR.** #94's scale-error
  detector says "this is probably a decimal-point mistake", which is a different
  claim from "outside the permitted range". A 40-inch phone screen is almost
  certainly wrong and just possibly a prototype.

## Publication

ONE transaction: the listing, its variants, their stock, the declared canonical
links, the offer-convergence outbox row and the draft's own stamp. A failed
sub-write rolls the whole publish back.

The listing is created by `createStoreProductWithin` — `createStoreProduct`'s own
body, with the transaction owned by the caller. **There is deliberately no second
listing-creation path**: a fourth writer of `listings` would have to re-derive
`published_at`, the condition columns, the facet defaults and the
handle-collision message, which is the divergence
`listing-publication-chokepoint.test.ts` exists to refuse. The three idempotent
recomputes run after the commit, through `finishStoreProductCreation`, because
`recomputeCollectionMembership` opens its own connection and calling it inside
would have the transaction wait on a writer waiting on it.

### `merchant_declared`

A directly selected canonical entity is linked and **never re-matched** (D10).
`NativeListingLinkMethod` gains `merchant_declared`, distinct from P2P
`seller_declared` and from `matcher`: a P2P seller declaring "this is the phone in
my hallway" and a merchant declaring "this is the model my catalogue sells" carry
different authority, are corrected by different people, and arrive through
surfaces with different gates. Collapsing them would make #59's review tooling
unable to ask who decided.

Confidence is NULL, as `native_listing_links_confidence_check` requires of every
non-`matcher` method. The matcher still runs for every variant the author did NOT
resolve, because `syncListingFacets` requests it after the commit and
`native_listing_links_active_variant_key` means an automatic attachment can never
displace a declared one.

`merchant_declared` becomes CONFIDENT in `CONFIDENT_LINK_METHODS` (#80), which is
derived by subtraction from the link-method tuple. That is the right answer — a
store member with `products:write` chose it from a search offering only `active`
canonical products — and it is not retroactive: no row carries the method until
this ships, so `PRODUCT_SAVE_MIGRATION_VERSION` is deliberately NOT bumped. The
`seller_declared` bump was needed because existing rows changed classification.

### The canonical selection carries no foreign key

`catalog_authoring_drafts.selected_canonical_product_id` and
`catalog_authoring_draft_variants.selected_canonical_variant_id` are plain
columns, ledgered in `ID_COLUMNS_WITHOUT_FOREIGN_KEY`. Every `ON DELETE` is
wrong: `restrict` lets one merchant's half-finished form block #59's merge job;
`cascade` deletes their work when the catalogue tidies up; `set null` silently
empties the one answer D10 says must never be overruled.

The publication resolves each through the tombstone's own `merged_into_id`
instead, so a merge that happened mid-draft lands on the WINNER with no rehoming
pass — **which is why this domain adds no `services/curation/merge-plan.ts`
entry, and the merge census has nothing to find.** A selection that resolves to
nothing REFUSES the publish rather than silently unlinking, because publishing
without the link hands the variant to the matcher, which is the overruling D10
forbids arrived at by omission.

### Idempotency

`Idempotency-Key` is read raw from the header, the way `checkout.controller.ts`
reads it. The order of checks matters:

1. A draft ALREADY published converges on its own listing, whatever key was sent.
   That is the case a retrying client hits, and a 409 would make the safe
   behaviour the one that breaks.
2. A key that already published a different draft converges on that one, held by
   the partial unique `catalog_authoring_drafts_idempotency_key` (scoped per
   STORE, so two merchants generating the same client-side key do not collide).
3. Otherwise the row is locked `FOR UPDATE` for the duration.

### The publication result (#577)

A publish answers with an `AuthoringPublicationResult` beside the listing id: the
`product_variants` row created for each draft variant PAIRED BY POSITION, the
canonical link where the author declared one, the typed identity and per-variant
counts, and what is still owed.

**It is derived from the LISTING, not accumulated as the transaction goes**, and
that is the whole design rather than an implementation detail. A convergence
created nothing this time — it is a retry whose first response was lost, which is
the case this endpoint exists to serve — so an accumulating result would answer
that retry with an empty body and make retrying, the safe client behaviour, the
one that loses information. `composePublicationResult` reads the published rows
back, `publishDraft` has exactly ONE call site for it, and
`published`/`converged` are ONE branch of `DraftPublication` carrying one shape.
A realdb case asserts the two are DEEP EQUAL apart from the outcome string; an
accumulating implementation passes every other assertion in that file and fails
that one.

**It reports no matching VERDICT and cannot.** `syncListingFacets` requests a
match for every variant AFTER the commit, so when the result is composed the
matcher has not run. `AuthoringVariantResolution` has no `matched` member: a
variant is `merchant_declared` (a person chose, and `MATCHER_MAY_DISPLACE`
protects it) or `queued_for_matching`. **The second is derived from the ABSENCE
of a declared link, never from a queue row** — a queue row exists only after
`syncListingFacets` runs and is gone once the matcher drains it, so reading one
would make the answer depend on when it was asked.

Ids appear where a caller can act on them and COUNTS where it can only check the
publication was whole: nothing addresses an axis-assignment row by id, and what a
caller needs from those rows is that the variant did not land half-written.

`review.queuedAttributeClaimCount` is reliably zero today — the authoring path
writes its claims already `resolved` — and is reported rather than assumed, so
the day a value stops resolving the author learns it from the publication instead
of from a queue nobody attributed. It is SCOPED to the listing through
`countQueuedClaims`'s own `{ listingIds }`; the realdb case seeds a queued claim
on a neighbouring listing to prove the scope, because without one the scoped and
unscoped counts both read zero and dropping the scope survived.

`review.openProposalIds` is non-empty only under a product type version whose
`pendingProposalPolicy` is `allow_local_claim` — `block_publication` refuses the
publish — and it is the one moment the author can be told that a value they
proposed is still somebody else's decision.

No DDL, and no new query: every read is an existing repository function.

### The legacy option pairs

ADR 0007 D6 replaces `listing_options.name` and
`product_variant_option_values.name`/`.value` with typed axis rows, and #367 step
4 owns that table. It is not on this branch's base, so a publication writes the
legacy pairs — which is what every cart line, checkout line and connector push
reads.

They are written from the SCHEMA: the option name is the attribute's base-locale
label, the value is the controlled value's own canonical string. And the
authoritative typed record is not lost — `catalog_authoring_draft_values` holds
every answer with its attribute definition id and version, so step 4's backfill
of an authoring-published listing reads a decided fact rather than re-normalizing
a label.

## Localization

`resolveLocalizedField` and `localeFallbackChain` are #367 step 2's and are
CALLED, never re-implemented. Three statements per composition, whatever the
field count.

**Attribute field labels are served in the base locale**, and that is a decision
recorded upstream rather than a shortcut here: `LOCALIZED_ENTITY_KINDS`'s own doc
comment states that `attribute_definition` is deliberately absent because
`attribute_labels` carries no `status` and no `provenance`, so a candidate built
from one of its rows would have to invent both — and `catalog-localization.test.ts`
asserts that tuple EXACTLY. The coverage counter reports them as unresolved, so
the response tells an operator the truth rather than a confident 100%. Closing it
is two entries in `CATALOG_LOCALIZED_FIELDS` plus the family columns on
`attribute_labels`, in the localization domain, and nothing here changes.

`placeholder` and `example` are modelled because D10 names them and are ABSENT
because no table in this repository carries one. An invented example is a claim
about a product nobody made.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `CATALOG_AUTHORING_ENABLED` | `false` | Mounts the surface. Never gates a row. |
| `CATALOG_AUTHORING_DRAFT_TTL_SECONDS` | 30 days | Stamped at creation, so a later change cannot retroactively shorten a form somebody is filling in. |
| `CATALOG_AUTHORING_DRAFT_PAGE_SIZE` | 50 | |
| `CATALOG_AUTHORING_CATEGORY_PAGE_SIZE` | 200 | |
| `CATALOG_AUTHORING_CANONICAL_SEARCH_LIMIT` | 20 | |

## What is enforced by a test

- `services/catalog-authoring/__tests__/catalog-authoring-isolation.test.ts` —
  five scanned walls (no payment/fee/ledger, no ranking, no referral, no matcher,
  no cross-domain WRITE), plus "no repository reads the flag". File-count and
  byte floors, a positive control, and a mutation self-test per detector with
  BOTH the path-qualified and the relative import spelling. **The relative
  spelling was added because the self-test went red on it** — the first draft
  matched only `services/payments/…` and was blind to `../payments/…`, which is
  the only spelling a sibling module would ever write.
- `services/catalog-authoring/__tests__/publication-result.realdb.test.ts` — the
  publication result is WHOLE (#577), against a real server. Three controls, and
  the file is written so none of them is the composer restated: every expectation
  is built by raw SQL rather than by the repositories the composer calls; the
  fixture's two variants must answer DIFFERENTLY (one declared, one queued), so a
  composer defaulting every variant to one resolution fails; and a convergence
  must be DEEP EQUAL to the publication, which is the assertion an accumulating
  implementation fails while passing all the others. Six mutations, all red:
  dropping the queued variants, accumulating instead of deriving, defaulting the
  resolution, reporting the listing total per variant, dropping the listing scope
  from the queued-claim count, and pairing by index instead of by position. **The
  scope mutation SURVIVED the first draft** — nothing in the database had a queued
  claim, so scoped and unscoped both read zero — and it took a seeded claim on a
  neighbouring listing to make that control exist.
- `services/catalog-authoring/__tests__/listing-upgrade.realdb.test.ts` — the
  listing twin of the draft upgrade, end to end against a real server: the pin
  moves, and every claim's settled attribute version and every axis's cited
  product-type version are read back BYTE-IDENTICAL afterwards (and the axes are
  asserted to still cite the OLD version positively, so the equality cannot pass
  by both sides having moved). The axis blocker fires with its own control — the
  same target version, a listing whose one axis it does still authorise, is
  offered the upgrade — and both halves are mutation-tested: disabling the
  blocker turns exactly the two blocked cases red, and making the apply delete
  the listing's claims turns exactly the read-back case red.
- `services/catalog-authoring/__tests__/schema-version-lifecycle-exposure.realdb.test.ts`
  — `?version=` may not serve an EDITABLE version.
  `RETRIEVABLE_AUTHORING_LIFECYCLES` is asserted to be exactly the complement of
  `PRODUCT_TYPE_EDITABLE_LIFECYCLES` over `PRODUCT_TYPE_LIFECYCLES`, so a fifth
  lifecycle fails the build until somebody decides which side it is on rather
  than landing on the permissive side in silence. Both directions run against
  real rows: an editable version is refused with the SAME code and the SAME
  sentence a nonexistent version gets — a refusal naming the lifecycle would
  enumerate the unlaunched verticals — and a `published` and a `deprecated`
  version still compose, without which the fix could be "refuse everything".
  Mutation-verified. It also pins the OTHER lifecycle filter on the same router:
  `listSelectableCategories`' `selectable` and `lifecycle = 'published'` clauses,
  which the function's own comment calls different facts and which nothing
  referenced before. TWO cases, because one is satisfied by either clause alone —
  the suppressed fixture is `selectable` on purpose and the grouping fixture is
  `published` on purpose — and each clause is mutation-tested independently, with
  the other case required to stay GREEN.
- `lib/__tests__/authored-text-sanitization.test.ts` — seller-authored free text
  is sanitized where it ENTERS, asserted by `.parse()`ing the real zod objects
  the routes mount rather than by calling the transform. "No tag survives" is
  `stripHtmlTags(out) === out`, the owner's own pattern applied twice, so this
  file holds no second copy of it. It pins the decode-BEFORE-strip order (the
  reverse can manufacture markup from `&lt;script&gt;`), that line breaks
  survive, and by contrast that `strip_html` keeps its own order.
- `services/catalog-authoring/__tests__/authoring-etag.test.ts` — determinism,
  each of the six dimensions varied INDIVIDUALLY, and the axis signature's
  order-independence.
- `services/catalog-authoring/__tests__/authoring-validation.test.ts` — the rule
  table, the error/warning split, and a vacuity floor on the code census.
- `db/__tests__/catalog-authoring-schema.test.ts` — the jsonb census (exactly
  one), the absence of any FK onto a mergeable entity with a vacuity floor, the
  id-column ledger coverage, the four partial uniques, and the expiry
  registration.
- `db/__tests__/catalog-authoring.realdb.test.ts` — the CHECKs and triggers
  against a real server. It keeps a readiness guard, read in a top-level await so
  `skipIf` sees it at collection rather than staying `false` forever: this file is
  the first thing that goes red on a database the migration has not reached, and
  a missing-relation error there is indistinguishable from a broken CHECK until
  somebody reads the stack.

## Deferred, each a named contract rather than a stub

- **#367 step 4** (typed variant axes and `native_*_attribute_claims`). The
  publication writes the legacy option pairs and the draft holds the typed
  record, so the backfill reads a decision rather than guessing.
- **#367 step 6** (ADR 0007 D9 proposals). `proposal_pending_blocks_publication`
  and `proposal_not_permitted` are DEFINED and produced by nothing: until
  `catalog_proposals` exists there is no row a draft value could cite, and a
  check for one would be a check that can never fire. `canProposeValues` is
  `false` in every branch, because reporting `true` would tell a client a control
  exists that no endpoint backs.
- **The dashboard wizard** (#367 step 10). Every endpoint it needs exists.
- **The publication realdb case** — one transaction end to end, and a forced
  failure inside it leaving nothing. It needs the store-product create path, so
  it belongs in a service-level realdb file rather than the schema-shaped one.
