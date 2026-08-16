# Navigation trees and the merchandising split (#367 step 7)

What a shopper walks — a header menu, the homepage's sections, a category rail,
a campaign strip — modelled as versioned, scheduled, publishable **navigation
trees** whose nodes point at exactly one catalogue concept each.

Binding decision: **ADR 0007 D3**, constrained by D1 (identity), D2 (taxonomy),
D4 (localization), D12 (rollout) and D13 (retained/extended/retired).

The two sentences the whole domain exists to make true:

- **Navigation is not taxonomy.** Nothing here may write to `categories`. A menu
  is an arrangement of the catalogue, never a second authority over what the
  catalogue *means*.
- **Navigation is not merchandising either.** `collections`, `collection_rules`
  and `listing_collections` stay exactly as they are. A node may *point* at a
  collection; pointing gives it no category semantics, and a collection
  membership never becomes a product fact.

---

## The tables

Five, all in `packages/backend/src/db/schema/navigation.ts`.

| Table | What one row is |
| --- | --- |
| `navigation_trees` | One arrangement of the catalogue for one `(market, locale, surface)`, as one version. |
| `navigation_nodes` | One entry of a tree, pointing at exactly one thing. |
| `navigation_node_localizations` | ADR 0007 D4's localization record for one node in one locale. |
| `navigation_saved_queries` | A named, reusable, curated search a node can point at. |
| `navigation_saved_query_attribute_filters` | One #94 attribute constraint of such a query. |

### `navigation_trees`: `(key, version)`, and a window

The `fee_schedules` / `attribute_definitions` / policy-version mechanism this
repository already uses everywhere. A tree is created as a **draft** — a real row
with real nodes an operator can read whole before anybody else can — and
publishing it is a transition rather than a sequence of edits to something
shoppers are currently looking at. A mutable tree would be a menu that is briefly
half-changed for everybody, with nothing to roll back *to*.

`effective_from` / `effective_to` are the schedule; `lifecycle = 'published'` is
the intent. A tree is **live** when both hold at the current instant. There is
deliberately **no `scheduled` lifecycle** — it would be a second answer to a
question the window already answers, and the two would disagree the first time a
job was late.

"At most one live tree per `(market, locale, surface)`" is therefore an **overlap
refusal**, not a uniqueness one: the successor has to be allowed to exist,
published and scheduled, while the incumbent is still live. A partial unique
index cannot say that, so it is the
`mercaria_navigation_tree_window_exclusion` trigger — plus a `FOR UPDATE` lock
taken by the publish path, because the trigger is a refusal and not a mutual
exclusion (under READ COMMITTED two concurrent publishes would each see the other
as it was before and both pass).

### `navigation_nodes`: a node that means two things has no row shape

`target_kind` plus seven pointer columns — a category, a saved query, a product
type, a brand, a family, a collection, or an external campaign destination — and
`navigation_nodes_target_shape_check` is **seven biconditionals plus an exact
`num_nonnulls` count**.

Seven separate biconditionals rather than one condition over their conjunction,
because the obvious single-expression spelling ("the selected pointer is set and
exactly one is non-null") *admits* a row whose kind is `brand` and whose only
pointer is a `collection_id`. That is the finding
`retail_delivery_promises_observed_shape_check` records, met again here. The
count term is not redundant with them: it is what fails on the first real insert
if an eighth pointer column is ever added without extending the biconditionals.

The one pointer that is **not** a foreign key is `product_type_key`.
`product_type_definitions` is merge-order step 3 and does not exist on this
branch's base, and an unconstrained uuid column would have looked like a foreign
key while enforcing nothing. A key is the correct pointer regardless (ADR 0007
D1): a node means "the smartphone product type", not "version 4 of it". Adding
the foreign key later is additive and needs no data change.

**Ordering is deterministic at the row.** `position` is unique among siblings,
and the uniqueness is **two partial indexes** rather than one — Postgres treats
NULLs as distinct, so a single `unique(tree_id, parent_id, position)` would let
two *root* nodes share position 0 and leave their order to whatever the planner
returned that day. The read tie-breaks on `key` as well, so a total order exists
whatever is stored.

There is **no stored `depth` column**: the walk that refuses a cycle counts the
hops in the same pass, and a stored depth would be a second representation of the
parent chain that goes stale the moment a subtree moves.

### `navigation_node_localizations`: the node carries no label at all

Per-entity, never one polymorphic table (D4): `entity_id` could carry no foreign
key there, so every orphan would be invisible and every read would need a
discriminator the planner cannot use.

The node row carrying **no** presentation column is what makes "return stable ids
and keys *plus* localized presentation, never presentation alone" a property of
the schema rather than of whoever writes the serializer. Presentation is a join,
and a node with no localization anywhere in the fallback chain is **withheld**
from the public read rather than rendered as its key.

A tree names the locale it is published *for*; a node's label rows are how that
locale is answered, with D4's fallback (exact → language → base) when it has not
been translated yet. Adding a locale is a new tree for that `(market, locale)`,
not a new column.

### `navigation_saved_queries`: every filter is a real column

The columns mirror #70's `SearchFilters`, so a node's destination is a search this
deployment can actually run. ADR 0007 D14 permits JSONB for a source-shaped
payload, an immutable schema snapshot and a bounded rule AST; a filter set is
none of the three, so it gets columns and one child table.

There is deliberately **no sort, intent, weight or policy column**. A saved query
says *what* to search; #74 says how to order what comes back, behind its
versioned policy. A curated search carrying its own ordering would be a second
ranking authority reachable from a menu.

Attribute filters cite #94's stable attribute **key** and pin no version: a saved
query means "colour", not "version 3 of colour", and pinning would silently stop
matching the day the registry published a new version.

---

## The triggers

A CHECK cannot read another row, so six things are triggers. Their bodies live in
migration `0090_sad_black_panther.sql`, each inside its own
`-- oxy:handwritten-begin=mercaria_navigation_*` marker pair, so a regeneration
that drops one fails `migration-handwritten-markers.test.ts` rather than silently
enforcing nothing. Re-apply them after **every** regeneration — regeneration
drops every hand-written trigger and function.

They staged in a `packages/backend/src/db/schema/navigation.pending.sql` while
ADR 0007 D11 handed the migration slot out one branch at a time; that file was
deleted with the migration that carried its statements, because a second copy
nothing applies is one somebody edits to no effect.

| Trigger | Refuses |
| --- | --- |
| `mercaria_navigation_freeze_tree_identity` | Changing a tree's `key`, market, locale, surface or version (D1). |
| `mercaria_navigation_freeze_saved_query_key` | Changing a saved query's `key` (D1). |
| `mercaria_navigation_published_tree_immutable` | Editing, un-publishing or deleting a published tree; only `effective_to` and the move to `archived` stay open. |
| `mercaria_navigation_tree_window_exclusion` | Publishing over another published tree's window on the same `(market, locale, surface)`. |
| `mercaria_navigation_published_nodes_frozen` | Any change to a published tree's nodes — except a node's `visibility`. |
| `mercaria_navigation_published_labels_frozen` | Any change to a published tree's labels. |
| `mercaria_navigation_node_acyclic` | A cycle, a cross-tree parent, and a chain deeper than `NAVIGATION_MAX_DEPTH`. |
| `mercaria_navigation_localization_review_protected` | Machine translation overwriting `reviewed` or `approved` copy (D4). |

Each is wrapped in a `-- oxy:handwritten-begin=<name>` / `-- oxy:handwritten-end=<name>`
pair — nine blocks, unique names, one per function and the trigger(s) that use
it. `migration-handwritten-markers.test.ts` fails the build on an unwrapped
`CREATE FUNCTION`, `CREATE TRIGGER` or `CREATE CONSTRAINT TRIGGER` in a
migration, and `navigation-isolation.test.ts` checks the pairing and the
coverage of the pending file itself on every run, so the paste source cannot rot
while it waits for a slot.

The `--> statement-breakpoint` separators inside the blocks are there so a
failure names one statement rather than a block of nine, and so the paste does
not depend on postgres.js's simple-protocol fallback — which is what makes an
un-separated multi-statement chunk apply cleanly today, measured, and which a
`prepare: true` or a different driver would remove. Where a separator goes
matters more than that it exists: after a statement's terminating `;`, never
inside a `$$ … $$` body, because the split happens before anything is parsed and
cuts the function in two.

Three of these are worth reading twice.

**The depth bound is checked in both directions.** Re-parenting a node deeper
moves its whole subtree with it, so the ancestors above the moved node and the
height below it are added together. Checking only the ancestors admits a
five-deep subtree grafted onto a five-deep branch.

**`visibility` is the one column of a published node that may still change**, and
that is deliberate: an incident lever that requires republishing a whole menu is
one nobody can pull at 3am. Everything else about a published node — its target,
key, position and schedule — is a new version.

**The label freeze means a typo fix is a new version.** That is the
preview-then-publish discipline working, and it is stated rather than hidden: the
alternative is a published menu whose text can change under the preview somebody
approved.

`NAVIGATION_MAX_DEPTH` is a TypeScript constant and a hand-written trigger cannot
read one. `navigation-isolation.test.ts` builds its assertion *from* the constant
and greps the pending SQL for it, so the two agree because a test says so rather
than because somebody remembered.

---

## The read

`GET /navigation?market=ES&locale=es-ES[&surface=header_menu]`

Anonymous, rate-limited on the `'listings'` budget the catalogue reads share, and
composed server-side from four statements plus at most one per target kind
present. A menu is the first request of every session; the shape that matters is
the one that does not grow a round trip per entry.

**A draft can never reach it.** `findLiveNavigationTrees` filters on the published
lifecycle *and* the window, and the two together are what "live" means — so
"unpublished navigation is not publicly readable" is a property of the query
rather than of a caller who remembered a filter.

**An empty answer is a real answer.** A market nobody has configured gets
`{trees: []}`, not a 404: a storefront that cannot render a menu renders no menu,
and 404ing would make an unconfigured market look like a broken deployment.

### Withholding

Four things withhold a node, and a withheld node takes its subtree with it (under
`parent_withheld`) — leaving the children in would re-root a submenu at the top
level, where it means something nobody authored.

| Reason | What happened |
| --- | --- |
| `node_hidden` | The author hid it. |
| `outside_visibility_window` | Its schedule has not started, or has ended. |
| `target_missing` | The row it points at is gone. |
| `target_not_publicly_visible` | An inactive category, an unpublished collection, a merged brand or family. |
| `no_label_in_fallback_chain` | Nothing in exact → language → base gives it a label. |
| `parent_withheld` | An ancestor was withheld. |

`target_not_publicly_visible` is what makes D3's collection rule hold in the read
as well as in the schema: **linking a collection from a live menu cannot publish
it.**

The public body carries `withheldNodeCount` — a **count, never the list**. Which
entries are missing and why is an operator's question, answered by the preview,
which is gated; a public payload naming them would publish to everybody that a
particular collection is unpublished.

### ETag

`ETag` plus `Cache-Control: private, no-cache`, and `If-None-Match` gets a 304.
The validator is a **deterministic hash of the composed payload with recursively
sorted object keys** (ADR 0007 D10's device). Hashing `JSON.stringify` directly
would be deterministic only for as long as every object literal kept its property
order — a refactor that moved one field would re-download every menu on the
planet, silently.

Nothing time-varying enters the hash: the payload carries the tree's own schedule
and no clock reading, which is what lets two requests a second apart share a
validator. `no-cache` rather than a `max-age`, because a shared TTL would keep a
withdrawn campaign on somebody's screen for its length, and withholding it is the
projection's whole job.

---

## The operator surface

`/internal/navigation/*`, seven routes on the SAME
`CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#55/#56/#57/#58/#60/#62/#68/#70/#78
use — deliberately not an eighth list: deciding what the front page points at is
the same power over the same graph as reshaping the catalogue it points into.
Registered only when that list is **non-empty**, so an empty list is a 404 and
never a 401.

```
GET    /internal/navigation/preview/:treeId       what publishing would produce, and what it withholds
POST   /internal/navigation/trees                 the next DRAFT version of a tree key
PUT    /internal/navigation/trees/:treeId/nodes   the whole node set, replaced in one transaction
POST   /internal/navigation/trees/:treeId/publish over a window, optionally superseding what is live
POST   /internal/navigation/trees/:treeId/archive stop it being live; it stays readable
DELETE /internal/navigation/trees/:treeId         a draft nobody published, and only that
POST   /internal/navigation/saved-queries         a curated search a node can point at
```

**Mounted while `CATALOG_TAXONOMY_V2_ENABLED` is off**, the `/internal/backfill`
and `/internal/seo` arrangement, and the reason is specific rather than a
convention: the evidence has to be readable during the incident that turned the
public surface off, and the one moment somebody most needs to preview a
navigation tree is right after switching it off. A separate router from the
public read for exactly that reason — the two are gated by different things.

**The route set is closed.** No "activate this category", no "publish this
collection", no "reorder the taxonomy", no "set this node's rank": every one is a
second authority over somebody else's rules.

**The node set is replaced, never patched.** The alternative — a dozen
create/move/retarget endpoints — makes every intermediate state a real state
somebody can leave a tree in, and the states that matter are the ones where an
ordering is duplicated or a subtree is orphaned. The set an operator previewed is
the set that publishes (the `catalog_split_jobs` assignment-list device).

**The preview runs the public projection.** A preview that ran different code
would be a preview of something else. What it adds is the reasons.

**Two refusals gate a publication**, both vacuity floors in the
`assertCohortIsNotEmpty` sense: a tree with no nodes cannot be published (the
surface would render nothing while every status field said it was live), and a
tree cannot be published while any node lacks a label in its own locale's
fallback chain (a menu entry with no words on it). Neither failure announces
itself anywhere except on a shopper's screen.

**There is deliberately no route that writes a category, a collection, a brand or
a family**, and none may be added.

---

## The gates

`packages/backend/src/services/__tests__/navigation-isolation.test.ts`, with a
vacuity floor, comment stripping and a mutation self-test per detector. It scans
`services/navigation/`, `db/navigation/`, **both** route files, the controller
and the schemas — the operator route file most of all, because that is exactly
where a "publish this category" endpoint would be added.

1. **No module writes a category, collection, brand, family or listing.**
   Deliberately not a *mention* of those tables: this domain reads all four on
   every request, and a detector that fired on a read is one whoever hit it next
   would disable.
2. **No module reaches #74's ranking domain**, and none names a weight, boost or
   sponsored slot. `position` is fine — it is an editorial sequence somebody
   typed.
3. **A node row carries no presentation column at all**, walked from the real
   drizzle table with a positive control.
4. **No navigation table restates a category or a collection** — no slug, name,
   ancestry, selectability or membership column.
5. **`NAVIGATION_FORBIDDEN_TARGET_KINDS` is disjoint from the permitted seven**,
   so a refusal names the exact prohibition (`sponsored_placement`,
   `category_write`, …) instead of answering "unrecognized value".
6. **The trigger's depth bound is the number the constant is.**

Measured: mutating `projection.ts` to contain `db.insert(categories)` and a
`rankingWeight` turns walls 1 and 2b red by name, and reverting turns them green.

---

## Rollout

One lever, `CATALOG_TAXONOMY_V2_ENABLED` (ADR 0007 D12), default **false** —
which is today's behaviour: the storefront keeps its own constants and the public
read does not exist. It gates the **public mount**, never a stored row and never
the operator surface: every tree, node and label stays readable with it off, and
so does `/internal/navigation`, because the evidence has to survive the incident
that turned it off.

Turning it on serves whatever is published. It publishes nothing by itself, and
turning it back off withdraws the read while leaving every row, every draft and
the whole authoring surface exactly where they were.

---

## Seams, each named rather than stubbed

- **Merge-order step 1 (taxonomy), LANDED (#401).** The category read filters on
  **`lifecycle = 'published' AND is_active`** — the conjunction rather than
  either alone, because `categories_is_active_derived_check` is deferred to a
  `post` migration and the serving image still writes `is_active` directly, so
  the two can disagree today and a public menu should withhold when either says
  withdrawn. `selectable` is not part of it: that governs product ASSIGNMENT, and
  a grouping root is the commonest menu node there is.
- **Merge-order step 3 (product types), LANDED (#408).** A node targets one by
  its stable key; see above for why that cannot be a foreign key.
- **Merge-order step 2 (the localization family).**
  `NAVIGATION_LOCALIZATION_STATUSES` and `NAVIGATION_LOCALIZATION_PROVENANCES`
  are this domain's copies of D4's vocabulary, and `NAVIGATION_BASE_LOCALE` is
  one constant in one file. When `category_localizations` and its siblings land,
  all three are **deleted** and the shared ones imported — two lists describing
  one vocabulary can disagree, and the direction they disagree in is always the
  permissive one. The locale column CHECK is a BCP-47 *shape* test until that
  branch supplies the supported-locale tuple D4 asks for.
- **Merge-order step 3 (product types).** `product_type_key` gains a foreign key
  and the projection gains the lookup the other five targets have; until then a
  product-type key nobody published is a dead link this projection cannot see.
- **The storefront rewire.** D3 retires the hard-coded category constants and
  pills in favour of reads of this configuration. Not in this PR — no
  `packages/frontend` file is touched — and it lands only after parity, which is
  D13's own condition.
- **#74 ranking** never reads this domain and this domain never reads it, in both
  directions, by the scanned gate.
- **A category-write path** does not exist here and cannot be added without
  failing the build.
