# The universal taxonomy (#367 step 1)

Category identity, lifecycle, aliases and redirects. Binding architecture:
[ADR 0007](adr/0007-universal-catalog-taxonomy-and-authoring.md) D1, D2, D11,
D13. Schema decisions are
`packages/backend/src/db/schema/CONVENTIONS.md` §"The universal taxonomy".

This is step 1 of the epic's merge order — everything after it (localization,
product types, typed variant axes, authoring, navigation) depends on the
identity established here and on nothing else in the epic.

## Where the code is

| | |
|---|---|
| `categories` (extended in place) | `packages/backend/src/db/schema/catalog.ts` |
| `category_aliases`, `category_redirects`, `category_external_mappings` | `packages/backend/src/db/schema/taxonomy.ts` |
| The single write chokepoint | `packages/backend/src/db/taxonomy/taxonomyRepository.ts` |
| The v1 reads, retained | `packages/backend/src/db/catalog/categoryRepository.ts` |
| Vocabularies and DTOs | `packages/shared-types/src/taxonomy.ts` |
| Migration, with five hand-written triggers | `packages/backend/drizzle/0087_productive_namorita.sql` |
| Real-server proof | `packages/backend/src/db/__tests__/taxonomy.realdb.test.ts` |
| The chokepoint gate | `packages/backend/src/db/__tests__/taxonomy-write-chokepoint.test.ts` |

## There is one category table

ADR 0007 D2: a parallel `taxonomy_categories` would mean every listing,
collection rule, search filter and connector mapping in the repository has two
possible answers to "what is this". `categories` gained seven columns instead,
and `ancestor_slugs` and `is_active` are retained as v1 read contracts (D13)
rather than dropped — five services filter on them today.

## Identity is `id` and `key`

`key` is a stable lowercase dotted machine key — `electronics.phones.smartphones`
— unique, and **frozen after insert** by `mercaria_category_key_frozen`. It
exists so a seed, a fixture, an external mapping and an operator's tooling can
name a concept without embedding a uuid, and so a human-readable identity
survives a database restore.

A name and a slug are presentation. A category whose key was wrong is
**deprecated and superseded, never renamed**: a renamed key is
indistinguishable from a different concept to everything that cited it.

Pre-#367 rows got their key from their own slug PATH by plain concatenation
(`men` + `.` + `mens-pants`), and `packages/backend/src/scripts/taxonomy.ts`
carries the same thirty-six keys as literals. A derivation with no
transformation in it is the only one that gives a restored production database
and a freshly seeded developer one the same key for the same shelf. In the seed
they are **data, never computed** — a script that composed the key from the slug
would make editing a slug edit an identity.

## Lifecycle, selectability, and the two facts people collapse

`lifecycle` is `draft | published | deprecated | merged | suppressed` and is the
authority; `is_active` is `lifecycle = 'published'`, derived by the repository
from `CATEGORY_ACTIVE_LIFECYCLES`.

**`suppressed` and `selectable = false` are not two spellings of one fact.**

| | `lifecycle` | `selectable` |
|---|---|---|
| The connector's import holding pen | `suppressed` — no shopper browses into it | `true` — a product is filed there |
| A structural grouping root | `published` — shoppers see it | `false` — no product may be filed under it |

Suppression decides whether shoppers **see** a node; selectability decides
whether a product may be **filed under** it. Collapsing them makes one of the
two unrepresentable.

## What a CHECK holds and what a trigger holds

A CHECK may not read another row, so the split is not a preference:

- **Same-row facts are CHECKs** — self-parenting, merging into oneself, the
  merge biconditional (`merged_into_category_id` set exactly when
  `lifecycle = 'merged'`), the key's format, the effective window.
- **Tree facts are `mercaria_category_hierarchy_guard`** — cycles of length two
  and up, and merging into a descendant.

The trigger deliberately **returns** on the two same-row cases rather than
reporting them. Pre-empting a CHECK leaves it unreachable, and a constraint
nothing can ever violate is indistinguishable from one that does not work. This
was measured: the first version did pre-empt them, and the real-server case for
self-parenting failed on the trigger's message instead of the CHECK's.

`mercaria_category_assignment_selectable` refuses a product under a
non-selectable node on `listings` and `canonical_products`. ADR 0007 D2 calls
this "a CHECK on the assignment"; `categories.selectable` is another row, so it
is a trigger — the resolution the ADR itself reaches one paragraph later for
cycles. `canonical_product_families` is deliberately not covered: a family is
itself a grouping, which is the legitimate case `selectable = false` describes.

## Ancestry is a materialized path, provisionally

`ancestor_ids` (root-first, excluding the row) with a GIN index, and
`ancestor_slugs` as its v1 spelling beside it. Both are written by the one
repository from the parent's own arrays, so they cannot disagree; a move
rewrites the whole subtree in one statement, and a slug rename rebuilds the
subtree's slug path from the id path.

A materialized path rather than a closure table because the shape was already
here and already indexed, the tree is shallow and small, and every hot read is
descendants-of or breadcrumb-of. **ADR 0007 D2 makes the choice provisional on
#61's benchmark** and says the ADR is amended before an alternative is adopted,
never after.

## Redirects are append-only, and corrections chain

`category_redirects` maps an old id or an old localized slug to a live category.
`mercaria_category_redirects_append_only` refuses UPDATE and DELETE.

The consequence, stated rather than discovered: **a redirect pointing at the
wrong category can never be edited.** It is corrected by adding a redirect FROM
the wrong target onward — subject `S → W` plus `W → C` resolves `S` to `C` in
two hops — so a correction is a new row and the mistake stays visible.
`resolveCategoryRedirect` follows the chain and reports the FIRST hop's reason
(why *this* handle stopped resolving) plus the hop count.

`mercaria_category_redirect_cycle_guard` refuses a **cycle** absolutely —
closing a loop means the closing insert's own forward walk traverses the whole
loop and meets its subject. Its eight-hop bound is a separate and weaker thing,
and the difference matters: it sees only the chain AHEAD of the new redirect's
target, so tail-extension — which is exactly the correction pattern above, where
every new target is a fresh category — can build a chain past it, nine
individually legitimate inserts at a time.

Bounding the real depth would mean walking BACKWARD from the subject, and
backward is a fan-in: one category is the target of any number of redirects, so
it is a tree traversal on every insert rather than a linear walk. That cost is
not paid. `resolveCategoryRedirect` answers **`chain_exhausted`** instead, and
that answer carries **no category** — returning the one the walk stopped on
would report a still-redirected, possibly merged category in a response shaped
exactly like a resolution.

## Aliases name a category; they are never its name

`category_aliases` holds internal and search-time alternate names per locale.
There is no `is_primary`, `preferred` or `display` column and no boolean beside
`kind`, so an alias has no way to claim to be the name.

The unique is `(category_id, locale, normalized_alias)` and **not** `(locale,
normalized_alias)`: "phone" legitimately points at more than one shelf, and a
constraint refusing the second one would make the taxonomy unable to record
something true. `findCategoriesByAlias` returns a list; resolving the ambiguity
is the caller's.

## External mappings go to review, never to a guess

`category_external_mappings` is `(source_id, external_key) → category_id`,
versioned, with two uniques answering two questions: `(source_id, external_key,
version)` makes "versioned" real, and the partial `(source_id, external_key)
WHERE valid_to IS NULL` makes "one current answer" real. `review_state`'s
`unreviewed` is not a soft yes.

`confidence` is NULL for a mapping that was **stated** rather than inferred —
imputing 1.0 would make an operator's mapping indistinguishable from a matcher
that was very sure.

## The write chokepoint, and why it needs a gate

`db/taxonomy/taxonomyRepository.ts` is the only writer, and
`taxonomy-write-chokepoint.test.ts` fails the build on a second one. Three of
the domain's properties are **derivations with no database-side counterpart** —
`is_active` from `lifecycle`, and both ancestry arrays from the parent's — so a
second writer does not fail. It writes a row that looks entirely ordinary, and
the disagreement surfaces later as a category that is live and invisible, or a
subtree no descendants-of read returns.

Two named exceptions carry a disposition: `scripts/seed.ts` (whose only
statement against these tables is an unqualified DELETE) and
`services/graph-benchmark/dataset.ts` (the opt-in benchmark seed).

## What is deliberately not here

- **The `post` migration.** Retiring `ancestor_slugs`, and the cross-column
  CHECK `is_active = (lifecycle = 'published')`. Both break a write the
  previously serving image performs, so both are `post`-phase; the exact
  statement is written out in `0087`'s header.
- **Localization (step 2).** `locale` is a plain `text` column on
  `category_aliases` and on the redirect's slug subject. It is the seam the
  localization family attaches to; nothing here resolves a fallback.
- **`category_product_type_scopes`**, which ADR 0007 assigns to D5 (step 3).
- **Any HTTP surface.** This step is schema, repository and gates only.
