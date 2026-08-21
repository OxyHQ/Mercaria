# Postgres schema conventions — Mercaria

Binding for every table in this schema. Decision + reason, nothing else. Two
prime directives: **no relational link may be lost**, and **no Mongo baggage
travels**. Where they conflict, STOP and escalate rather than resolving it
silently.

> This document was written during the Mongo→Postgres port and is still binding,
> but read it as a LEDGER: the phases it plans (Fase 1–4), the Mongoose models it
> maps and the backfill it instructs have all completed and been deleted, and the
> `mercaria-production` Mongo database was dropped on 2026-08-08. Nothing here can
> be re-run. What survives is the DECISION and its reason for each table — which
> is what makes a column whose shape looks arbitrary answerable at all.

Several of these are enforced by tests, not by discipline — see the bottom.

The mechanics behind most of this ship in **`@oxyhq/db`** (column builders, the
casing authority, the migration ledger and deploy phases, the throwaway-database
harness, the convention gates). Read it before hand-rolling any of them; a
Mercaria-local copy of something that package already owns is a second thing to
keep in lockstep.

---

## The fact that shapes everything: there is no `users` table

Oxy owns identity. Mercaria reaches it over HTTP, so **every buyer id, seller
id, store-member id and `oxy_user_id` is a FOREIGN SERVICE's primary key** and
can carry no foreign key. That is not a gap to close later: a shadow `users`
table would be a cache that can disagree with Oxy, and validating on write would
put an HTTP round trip in front of every insert.

The same holds for every id belonging to another service Mercaria integrates
with — a CrowdSource `decision_id`, an Oxy `file_id` on a listing image, an Oxy
Pay reference on an order.

`deferredForeignKeys.ts` carries the two ledgers that classify them, and
`__tests__/schema-conventions.test.ts` fails on an id-shaped column that appears
in neither ledger nor a real `.references()`. Between them, every `*_id` column
in the schema is classified — which is what lets a NEW one nobody decided about
fail the build instead of quietly meaning nothing.

## Naming

**Tables: explicit snake_case, plural.** `inventory_levels`, not Mongoose's
derived `inventorylevels`. The derived name is a `pluralize()` artifact, not a
design, and nothing reads a collection name — call sites are being rewritten,
not shimmed. The Fase 4 backfill therefore needs an explicit collection → table
map; write it out, one entry per table.

**Columns: camelCase in TypeScript, snake_case in SQL**, derived by drizzle. Do
not pass an explicit column name unless the SQL name genuinely differs from the
property.

**`DATABASE_CASING` from `@oxyhq/db` is the naming authority.** It is read by
`createDatabase()` in `db/postgres.ts` (what queries reference) and by
`drizzle.config.ts` (what the DDL creates). One setting, not two copies.

> **Trap:** `column.name` on a drizzle column is the TypeScript **property** name
> (`sellerId`), never the SQL name (`seller_id`) — casing is applied when SQL is
> built. Using it in hand-written SQL throws `column "sellerId" does not exist`;
> using it in a catalogue query or an `endsWith('_id')` filter silently matches
> nothing and the check passes vacuously. Always `sqlColumnName(column)` from
> `@oxyhq/db`, or interpolate the Column itself into `sql` and let drizzle
> render it.

> **Trap, second guise — the one that costs data, not a crash (#313):** a drizzle
> column interpolated into `sql` renders **bare** when the template sits in a
> SELECTION position of a SINGLE-TABLE statement. In a correlated subquery there,
> `sql`(select count(*) from order_items oi where oi.order_id = ${orders.id})``
> renders `oi.order_id = "id"` — the bare name resolves against the SUBQUERY's
> own table, the predicate compares two of ITS columns to each other, and the
> query returns 0/`[]` **with no error at all**. Measured against a real server:
> an independent raw-SQL control confirmed four rows existed, the query returned
> 0 for every row, and `qualified()` returned 4. Qualify every correlated
> reference with `qualified(column)` from `@oxyhq/db`, and treat "a correlated
> subquery returned nothing" as a bug in the SQL until proven otherwise.
>
> **The mechanism is narrower and nastier than "the table is not in the `FROM`",
> which is what this note said until #313 measured it.** `PgDialect.buildSelection`
> rewrites every `PgColumn` chunk to a bare `sql.identifier` when `isSingleTable`
> is true, and nothing else in the dialect touches a user-supplied template. Two
> consequences, both counter-intuitive, and the old wording got both backwards:
>
> - **A JOIN hides it.** With a join `isSingleTable` is false, no rewrite
>   happens, and the identical template renders `"orders"."id"` and is correct.
>   The bug is a property of the template PLUS the query it lands in, so adding
>   or removing an unrelated join silently changes the answer. "The table is in
>   the `FROM`" is therefore no reassurance — in the failing case it always is.
> - **A `WHERE` clause is never rewritten**, because `buildSelection` is not
>   involved. There are 37 correlated column references in `.where()` in this
>   repository and every one is fine. The affected positions are exactly
>   `.select({...})` / `.selectDistinct` / `.selectDistinctOn` fields and
>   `.returning({...})` (insert always; update unless it has a `from`).
>
> `db/__tests__/sql-column-binding.test.ts` is the gate: an AST census over
> `src/` that fails the build on a selection-position template interpolating a
> real drizzle column into a nested `select … from`. It carries a positive
> control per import style, negative controls for the safe shapes, and floors
> proving each half of the conjunction is detectable on real code. It also pins
> the drizzle BEHAVIOUR, so if a future version qualifies these chunks the gate
> announces that it can be retired rather than going on guarding nothing.
>
> Related: `${col} <> all(${jsArray})` binds a TUPLE, not an array, and Postgres
> raises `op ANY/ALL (array) requires array on right side`. Use `inArray` /
> `notInArray`.

> **Third trap, on the read side:** `db.execute` bypasses drizzle's column
> mappers. A `timestamptz` comes back as a raw STRING and `res.json` ships it as
> happily as a `Date`, changing the wire format with nothing to notice. The
> write direction is friendlier — it throws `ERR_INVALID_ARG_TYPE` — which is
> exactly why the read direction is the dangerous one.

**Reserved words are fine.** A column named `order` stays `order`; drizzle
quotes every identifier it emits. Hand-written SQL must quote it too.

## Primary keys

`text`, holding the 24-char ObjectId hex verbatim for pre-cutover rows and a
**uuid v7** for new ones — `generatedId()` from `@oxyhq/db`. This is not a
convenience, it is what makes the backfill possible at all:

- Every cross-collection reference in Mercaria's Mongo model is already a
  `String` id (`AGENTS.md` states this as a rule). A remapped id would mean
  rewriting every one of them in the same pass that copies the rows, with no way
  to verify the result short of re-deriving the whole graph.
- Ids have LEFT this system. CrowdSource holds a `Listing._id` as
  `subject.externalId` and an `AbuseReport._id` as `externalReportId`; a
  `ModerationEnforcement` row is keyed on `decisionId + revision + action`. A
  remapped id makes an accepted appeal unable to find the listing it restores.
- Order numbers, receipts and POS draft-order references are printed and
  emailed. They outlive the database.

**v7 is generated in the application** (`$defaultFn`), not by a database
`DEFAULT`: Postgres 17 has no native `uuidv7()`. The time component makes ids
k-sortable, so the primary-key btree stays append-mostly instead of scattering
inserts across the keyspace the way a v4 does.

Rows inserted by raw SQL get no id — intended: the backfill supplies `_id`
verbatim, which is how every foreign key survives by construction.

**A table whose id is supplied by its caller says so by having no default.**
`moderation_outbox` is the existing example — its id is deterministic so a retry
re-derives the same row, and that determinism IS the idempotency.

## Money — `DualMoney` is FOUR real columns per amount

This is the Mercaria-specific rule with the most call sites, and the one most
likely to be got wrong by someone porting a Mongoose sub-document mechanically.

Mercaria is multi-currency (presentment + shop, Shopify-Markets style). Every
TRANSACTED amount on an order or refund is a `DualMoney { shop, presentment }`,
and each half is a `Money { amount, currency }`. In Mongo that is one nested
object. In Postgres it is **four columns, flat, on the owning table**:

```
unit_price_shop_amount          bigint   not null   -- minor units
unit_price_shop_currency        text     not null   -- CHECK: ALL_CURRENCY_CODES
unit_price_presentment_amount   bigint   not null
unit_price_presentment_currency text     not null   -- CHECK: ALL_CURRENCY_CODES
```

Built by `money()` / `dualMoney()` in `schema/columns.ts` — never hand-written,
so the four-column expansion is stated once. Not `jsonb`, and not a
`money_amounts` child table. The reasons are specific:

- **Reports `$match` on the currency.** `report.service`, `order.storeStats` and
  `customer.stats.totalSpent` all sum the SHOP side filtered to the store's
  `defaultCurrency`, precisely so currencies are never mixed. That filter has to
  be an indexable predicate on a real column; inside `jsonb` it is a functional
  index nobody will remember to create, and in a child table it is a join on
  every aggregate.
- **The amount is an INTEGER in minor units.** Never `numeric`, never a float —
  `CURRENCY_PRECISION` in `@mercaria/shared-types` is what turns it into a
  displayable value, and the pricing engine's half-even reconciliation depends
  on exact integer arithmetic.
- **`bigint`, and `integer` is CATASTROPHICALLY wrong here.** FAIR carries EIGHT
  decimals (`CURRENCY_PRECISION.FAIR === 8`), so 1 ⊜ is 100_000_000 minor units
  and a signed `integer` tops out at **21.47 ⊜**. Not a large order — a
  mid-priced item overflows it, silently, at the first real FAIR price. `integer`
  would have been right for a cents-only catalogue and is wrong for this one.
  Drizzle's `bigint({ mode: 'number' })` maps it to the `number` that
  `Money.amount` is already declared as, so no DTO or arithmetic site changes;
  `mode: 'bigint'` would change the wire type and every one of them. That mode
  re-imposes JavaScript's own 2^53 ceiling (about 90.07 million ⊜) — which is
  NOT a ceiling this column introduces, it is exactly the one
  `Money.amount: number` has today. That ceiling is now DECLARED and ENFORCED in
  shared-types (`MAX_MONEY_MINOR_UNITS` / `assertSafeMoneyAmount`), asserted at
  every construction boundary rather than left as an open question. If a real
  amount ever approaches it, the column and the DTO move to `bigint` together.
  The same reasoning governs every non-`Money` column that can hold minor units:
  `discounts.value` (basis points for a percentage, but MINOR UNITS for
  `fixed_amount`) and `discounts.minimum_requirement_value` (a subtotal or a
  quantity) are both `bigint` for it.
- **A `Money` that is NOT part of a `DualMoney` stays two columns**
  (`*_amount` + `*_currency`) by the same argument. Catalog prices are single,
  native-currency `Money` — the catalog stores the seller's own currency and
  does not convert.
- **Both halves of a `DualMoney` are NOT NULL together.** An order line with a
  shop amount and no presentment amount is not a partially-filled row, it is a
  row that cannot be rendered to the buyer who paid it.

The order also snapshots `fx_rate` (shop→presentment) for reproducibility — five
columns, since a snapshot names its `provider` as well as from/to/rate/asOf, and
a stored rate nobody can attribute to a source is not reproducible. It is a
single value, not a `DualMoney`. The `settlement_*` columns beside it are
RETIRED and unwritten; see the comment on them in `orders.ts`.

Discount and tax BREAKDOWN lines (`applied_discounts`, `tax_lines`) stay
SINGLE-currency shop amounts — they are the merchant accounting and refund
basis, and giving them a presentment side would invite someone to refund against
it.

## Closed value sets — `text` + CHECK, derived from the shared-types tuple

**`text` + a CHECK constraint. Never a pg `enum` type.**

> **`text({ enum })` EMITS NO DDL.** It is a TypeScript narrowing and nothing
> else — drizzle-kit generates a plain `text` column for it. A closed value set
> written with `text({ enum })` and no `checkOneOf(...)` beside it therefore
> looks constrained in the editor and accepts anything in the database, which is
> the worst combination available. Every one of them needs its CHECK stated
> explicitly in the table's config array, rendered from the SAME tuple that types
> the column. `constrains every currency column with a CHECK` in
> `db/__tests__/schema-conventions.test.ts` enforces this for the currency
> columns (~50 of them, the largest family); the rest is review.

- `text({ enum: [...] })` gives drizzle the same literal-union TypeScript type an
  enum would, so the enum type buys nothing at compile time.
- Adding a value to a pg enum is easy; **removing or renaming one is not
  possible**. A CHECK is ordinary `DROP CONSTRAINT` / `ADD CONSTRAINT`.

**Derive both the column type and the CHECK from the SAME tuple, and import that
tuple from `@mercaria/shared-types` wherever one exists** — `ALL_CURRENCY_CODES`
is the canonical case, with `ListingCondition` and the order/enforcement modes
beside it. Render the CHECK with `inList()` / `textArrayLiteral()` from
`@oxyhq/db` so the constraint text is generated from the tuple rather than
retyped.

**This is what "adding a currency code propagates" now means, and it CHANGES.**
Under Mongo, adding a code to `ALL_CURRENCY_CODES` propagated at runtime,
because `MoneySchema`'s enum read the tuple and Mongoose validated against it on
the next write. Under Postgres the constraint is DDL that has already been
applied: adding a code to the tuple changes the TypeScript union immediately and
changes nothing in the database at all, so the first write of the new code fails
its CHECK. **Adding a currency code is therefore a code change plus
`bun run db:generate` plus a migration** — additive, so `-- oxy:deploy-phase=pre`
— and the shared-types change and the migration must land in the same PR or the
build is green and production rejects the write.

**Mongoose enums were never enforced on an update.** `Model.updateOne` runs no
validators, so the live collections may contain values the schema forbids.
Porting a narrow enum verbatim starts rejecting real rows. Every CHECK here must
be the union of the Mongoose enum, the `@mercaria/shared-types` union, and every
literal written anywhere in the code — and a production `distinct()` audit is
still REQUIRED before the backfill, because only the data can confirm it.
`Listing.status` is the one to check first: `restricted` is written by
moderation enforcement, and a CHECK missing it silently disarms every takedown.

For an ARRAY column the constraint is on the ELEMENTS, which a scalar enum
cannot express: `<@ array[...]`. A CHECK may not contain a subquery, so "every
element is in range" is written as array CONTAINMENT, never `unnest`.

## Timestamps

Always `timestamptz`, always `mode: 'date'` — `timestamptz()` from `@oxyhq/db`.
`timestamp` without a time zone reinterprets the value in the session's
`TimeZone` on every read, silently changing what a Mongo `Date` meant.

| Mongoose | Postgres |
|---|---|
| `timestamps: true` | `created_at` + `updated_at`, both `NOT NULL DEFAULT now()` |
| `timestamps: { createdAt: true, updatedAt: false }` | `created_at` only — the ABSENCE of `updated_at` is the append-only contract |
| `timestamps: false` + own `createdAt: { default: Date.now }` | `created_at`, identical to the row above |

**`updated_at` is maintained by the application** (`$onUpdate`), matching
Mongoose. Deliberately not a trigger: a trigger is invisible in the schema file,
and it would fire during the backfill and overwrite the historical value the
migration exists to preserve.

`createdAt()`/`updatedAt()` default to `date_trunc('milliseconds', now())`, not
plain `now()`. `timestamptz` carries microseconds and a JS `Date` carries
milliseconds, so a plain `now()` does not survive the round trip — and every
keyset cursor built from that read then compares against a value SMALLER than
the row it came from, which makes an ASC page never advance and a DESC page skip
rows silently. Mercaria's catalogue, order-history and review feeds are all
keyset-paginated. Do not "fix" this per cursor.

### `listings.published_at` is the FIRST activation, not the row's birthday (#261)

NULL until the listing is `active`, stamped by the first transition to it, never
restamped and never cleared. `created_at` already holds "when was the row
written", and two representations of one fact can disagree — which is what the
column was until #261, because every create stamped it including one the caller
immediately made `draft`.

`db/catalog/listingRepository.ts` is its only author: the three statements that
can write `listings.status` — `insertListing`, `updateListingColumns`,
`setListingStatusIfIn` — each derive it, so no service states it and none can
forget. `listing-publication-chokepoint.test.ts` fails the build if a FOURTH
writer of that table appears in production source, because a
`.set({ status: 'active' })` elsewhere would leave a listing on sale with no
publication instant, silently: every catalogue read filters `status`, so it would
surface only as a listing missing from the tail of a newest-first feed. The stamp
is a SQL `coalesce`, not a read-then-write, so two concurrent activations cannot
each decide the column is empty.

**No backfill, deliberately, and the reason is not cost.** Nothing in the schema
tells a draft that was never published from one that WAS active and was returned
to `draft` — which is exactly what moderation's `request_changes` does — so
nulling today's drafts would erase real publication instants, unrecoverably. A
row written before #261 may therefore be a draft carrying a stamp; a new one may
not.

**The ordering change was accepted.** `published_at` is the sort key of every
newest-first feed and of six indexes, so a listing created as a draft and
published later now takes its feed position from the publish moment. Every read
that orders by it filters `status = 'active'` (browse, search, the store page,
the seller's public page, the shelves), so a NULL row is not in those sets at
all; the two management screens that DO show drafts order by `created_at`
(`findListingsPageForSeller`, `findStoreListingsPageForAdmin`) and are untouched.
The one read that spans every status is `findSellerFirstPublishedAt` — "seller
since" — which now answers `null` for a seller who has only ever held drafts,
and whose docblock already states that `null` is a real answer the caller renders
nothing for.

## Foreign keys

Every relation gets a real constraint with an **explicitly decided `ON DELETE`**.
`ON UPDATE` is never declared: ids are immutable.

The rule for choosing: read the existing Mongo delete path first and state the
choice against it. A commerce record that a buyer or a tax authority can be
asked about does not CASCADE — an order line whose listing was deleted must
survive with its price snapshot intact, because the order is the record of what
was actually sold. Cascades belong to rows that exist only to point at a parent
and are meaningless without it (an inventory level for a deleted variant, a
collection membership).

**`ON DELETE SET NULL` needs care where NULL already means something.** Check it
for every relation: if `parent_id IS NULL` already reads as "unfiled" or "not a
variant" anywhere, `SET NULL` promotes an orphan into that category rather than
marking it orphaned.

## Unique constraints

Mongo unique index → `UNIQUE`. Mongo `sparse` / `partialFilterExpression` → a
Postgres partial unique index (`uniqueIndex().where(...)`).

Postgres treats NULLs as DISTINCT by default, so a plain `UNIQUE` on a nullable
column is already correct — but the partial form is worth keeping where Mongo
used one, because it also keeps the index the size of the real set and states
the intent at the constraint.

> **Carry the Mongo lesson across, do not re-learn it.** `sparse: true` on a
> unique index does NOT exclude a stored `null` — `sparse` omits a document when
> the field is ABSENT, so `$set: { field: null }` (the natural way to clear an
> optional field) indexes it and the second such row fails with `E11000`. The
> Mongo fix was `partialFilterExpression: { field: { $type: '…' } }`. The
> Postgres analogue is a partial unique index with an explicit
> `where(isNotNull(col))` where the semantics demand it — and the same discipline
> applies to whoever writes the clearing code: **a sparse-unique column must be
> written NULL, never `''`.** An empty string is a VALUE, so it collides for
> real, converting a non-problem into a live bug.

Invariants Mongo could not state at all become constraints here — the
idempotency key on `moderation_enforcement` (`decision_id + revision + action`)
is already exactly this shape and must arrive as a real `UNIQUE`, because it is
the ONLY thing standing between an enforcement retry and a double takedown.
`revision` stays in the key: a correction's `restore` is a *different* action
from the removal it supersedes, and dropping it means an accepted appeal can
never relist the item.

### And a ported unique can be WRONG — `product_variants.sku`/`.barcode` (#296)

The mapping above is mechanical in one direction only. A Mongo sparse-unique
carried across faithfully still has to be asked whether the property it asserts
is TRUE of the domain, and for these two it was not. Both were dropped by
migration `0073` (`post`) and NEITHER is replaced at any scope.

- **`barcode`** is one seller's OBSERVATION of a trade-item identifier on one
  listing. Two merchants selling one trade item share a GTIN *by definition* —
  which is the premise `offers`, the canonical graph and every price comparison
  rest on — so a table-wide unique made the second merchant to list a product
  unable to list it at all. Identity for a GTIN belongs to `product_identifiers`,
  whose `product_identifiers_canonical_active_key` is the real collision gate and
  answers a second claimant with `disputed` plus a review item rather than a raw
  23505.
- **`sku`** is a merchant's own code and is unique at no grain Mercaria can
  enforce without refusing real data: Shopify enforces no SKU uniqueness at all
  (one product legitimately carries two variants sharing a SKU), WooCommerce
  enforces it site-wide, and a connector imports both. Deliberately NOT narrowed
  to `(listing_id, sku)` either — that is exactly the shape Shopify permits. This
  is `product_identifiers`' own ruling about MPN, one table over: **a database
  constraint that has to be wrong sometimes is worse than one that does not
  exist.**

What the SKU index was actually doing was standing in for an AMBIGUITY CHECK,
and an index can only refuse the write — it can never say what it found. The
check now lives in the two places that can: `matchIncomingVariant` (the connector
pull rail) and `resolveInventoryVariant` (the push rail) each refuse to pick
between several candidates and name them. The rule to carry forward is the
question, not the outcome: **before porting a unique, ask what a legitimate
second row looks like.** If one exists, the constraint is a check in the wrong
layer.

`nullIfEmpty` on both columns survives the drop and its reason changed rather
than disappearing — see `insertVariants`.

**And the deploy phase is `post`, which the breaks-a-write test gets wrong.**
That test — "does any statement here break a write the previously serving image
performs" — answers NO for a dropped unique, because a drop widens what is
permitted. It is not sufficient, and the reason generalises beyond this issue:
**an index has two consumers, and the second one is a READER that omits a check
because the index exists.** `resolveInventoryVariant` took the single row
`findVariantByListingAndSku` returned and never asked whether there was more than
one; that was safe only while the index guaranteed it. Applied `pre`, the drop
lands while the OLD image is still serving, so it accepts a duplicate-SKU pair
and then writes an absolute stock set to an arbitrary one of them — silently, and
the bad row and the bad quantity both outlive the deploy. `post` puts the new
image's refusal in front of the drop and costs only the rollout's worth of
today's behaviour. `migrate.ts`'s own definition says the same thing in one line
("anything that takes something away … applied early it is an outage on the image
still serving"); when the two authorities disagree, compare the FAILURES rather
than the diffs.

## Arrays and objects

- A scalar array (tags, search terms) → a native `type[]`, with a GIN index
  where Mongo's multikey index served an `$in`. A child table for a set never
  queried by element is over-normalization.
- An array of IDS or entities → a real junction table. Never a `jsonb` id array:
  it cannot be joined, constrained, or usefully indexed. `Listing.collectionIds`
  is the case to get right — it is materialized from `Collection` rules and then
  queried BY element on every collection page.
- A `Mixed`/`Map`/nested object with a known shape → real columns or a child
  table. Listing images (`{fileId, alt, position}`) and product variants are both
  of this kind: variants carry their own price, SKU and inventory and are joined
  from three directions, so they are a table.
- `default: undefined` on an array means "absent", which is a nullable column
  with NO default — not `'{}'`, which is a different value.

**`jsonb` is for genuinely shape-less data only.** The moderation payloads are
the clearest legitimate case: a published CrowdSource decision is deliberately
LOOSE, and projecting it into columns would silently drop whatever a newer
CrowdSource version added. A price, an address or a set of order totals is not
shape-less and does not qualify.

## Mongoose behaviour that has no schema counterpart

`trim: true`, `lowercase: true` and setter-style defaults are Mongoose
APPLICATION behaviour. Postgres has no equivalent, and dropping them silently
changes what gets stored. **Re-apply each at the call site during the port.**
They are deliberately NOT encoded as CHECK constraints: a CHECK would reject
existing production rows during the backfill and convert a silent normalization
into a 500.

The one to audit hardest is anything a UNIQUE constraint depends on — a store
handle or a connector provenance key that Mongoose lowercased on write is unique
case-insensitively today and will not be once the normalization is gone. Either
the call site normalizes, or the index is on `lower(col)`. Decide per column; do
not assume. (`sku` was the first example this paragraph used, and it stopped
being one when #296 dropped its unique — the audit is only owed where a
constraint reads the normalized value.)

`select: false` likewise does not survive — see the next section.

## Protected columns — the `select: false` replacement

`db.select().from(table)` returns EVERY column. The first naive port of a query
is the first time a customer's contact details on a POS walk-in, or a payment
reference snapshotted on an order, can leave the process in a response nobody
audited.

`db/protectedColumns.ts` holds the registry; `publicColumns(table, REGISTRY)`
from `@oxyhq/db/assert` is the sanctioned read. The exclusion is at the TYPE
level — the row type has no such property, so a serializer that reads one fails
`tsc` rather than shipping it — **provided the registry is declared `as const`
and never re-annotated with `ProtectedColumnRegistry`.** Annotating it widens the
literal types away and the compile-time half silently disappears (fail-closed,
but gone).

Opting in is explicit and greppable: a path that legitimately needs a protected
column names it. There is deliberately no helper for that — it must read
differently from an ordinary select.

## Generated columns

Where Mongoose derived a value in a hook, the derivation belongs in the schema —
not because it is tidier, but because a hook is bypassable and a
`GENERATED ALWAYS ... STORED` column is not. No write path (route, service,
backfill, `psql`) can produce a row whose derived value disagrees with its
source: an attempt fails with SQLSTATE `428C9`.

**The trap: the expression must be IMMUTABLE, and the obvious spellings are
not.** Check `pg_proc.provolatile`, do not assume:

| Want | Rejected | Use |
|---|---|---|
| a `tsvector` from text | `to_tsvector(x)` — STABLE, reads `default_text_search_config` | `to_tsvector('english', x)` with a LITERAL config |
| a `tsvector` from `text[]` | `array_to_string(a, ' ')` — STABLE; `a::text` — refused outright | `to_tsvector('english', mercaria_immutable_array_to_string(a, ' '))` |
| a point | — | `ST_MakePoint(lon, lat)::geography`, both IMMUTABLE in PostGIS 3.5 |

**The IMMUTABLE escape hatch is a narrowed wrapper FUNCTION, not a different
builtin.** `array_to_tsvector(a)` is immutable and was the first answer for
`text[]`; it is also wrong, because it stores every element as a lexeme VERBATIM
— no stemming, no case folding — so a listing tagged `Handmade` was not findable
by "handmade" and `Bikes` not by "bikes", a real narrowing against Mongo's
`$text`, which stemmed array elements. `array_to_string(anyarray, text)` is
STABLE only because `anyarray` admits types whose text conversion is not
immutable; narrowed to `text[]` the conversion genuinely is, so
`mercaria_immutable_array_to_string(text[], text)`
(`drizzle/0003_tag_search_stemming.sql`) declares it honestly rather than by
assertion. Reach for the same shape before accepting a builtin that type-checks
and analyzes differently.

> **A generated-column rewrite silently DROPS the column's indexes, and
> `drizzle-kit generate` will not tell you.** Changing a stored generated
> expression means `DROP COLUMN` + `ADD COLUMN`, and the drop takes every index
> on that column with it — but the index's own definition is textually
> unchanged, so the diff emits nothing and the snapshot still records an index
> the database no longer has. Every `@@` query keeps passing, on a sequential
> scan. Re-create the index by hand in the same migration, and assert it exists
> against a real database (`keeps the search-vector GIN index that the column
> rewrite dropped` in `catalog.realdb.test.ts`).

**Do NOT generate a money total.** It is tempting for `line_total` and it is
wrong: the pricing engine's half-even reconciliation distributes rounding across
lines so the parts sum to the stored grand total exactly, which a per-row
expression cannot reproduce. The stored total is the record of what was charged.

## Text search

A Mongo text index becomes a `tsvector` GENERATED column plus a GIN index —
never `LIKE '%…%'`, which is not a port of a text index but a table scan wearing
one's clothes. Use `tsvector` from `@oxyhq/db` and the two-argument
`to_tsvector('<config>', …)` with a literal configuration.

Note that catalogue search changes SHAPE where Mongo indexed a multikey field on
the parent document: searching listing text that lives on variants now joins
back to `listings`.

**A vector's configuration and its query side's configuration are ONE decision,
and a disagreement between them is UNRELIABLE rather than merely lossy.** Two
stemmers sometimes agree on a word and sometimes do not, so a mismatch punches
arbitrary holes in a result set rather than uniformly breaking it — measured on
PostgreSQL 17 over ten configurations and three inflected word pairs, 22 of 30
same-configuration pairings match and 96 of 270 cross-configuration ones do. That
is what makes it dangerous: `to_tsvector('french', 'une bicyclette') @@
websearch_to_tsquery('english', 'bicyclettes')` is FALSE, silently and
indistinguishably from a term nobody sells, while neighbouring queries keep
working. So the pair must be derived from one place. Two exist:

- **`'simple'`** for every canonical entity NAME (`canonical_products`,
  `canonical_product_families`, `brands`, `merchants`, `organizations`,
  `storefronts`), queried by `db/search/searchCandidateRepository.ts` — ADR 0002
  D21, language-agnostic on purpose.
- **The locale's own configuration** for `listing_localizations.search_vector`,
  a `CASE` over the row's `locale` rendered from
  `localesByTextSearchConfiguration()` in `@mercaria/shared-types` — the SAME map
  `listingRepository.textMatch` resolves through. `listings.search_vector` stays
  `'english'` and its query side reads
  `LISTING_BASE_TEXT_SEARCH_CONFIGURATION`. A language PostgreSQL ships no
  configuration for gets `'simple'` and never `'english'`. Full reference:
  `docs/catalog-search-configurations.md`.

A `CASE` whose every arm names a LITERAL configuration is IMMUTABLE and is
accepted in a generated column; a `text::regconfig` cast is STABLE and is not —
though it is fine, and is the safe spelling, in a QUERY.

## PostGIS

`db/migrate.ts` declares `postgis` as a required extension, so it is created
before any migration runs, in every environment. That is a precondition of the
MIGRATOR, not a numbered migration, so the ordering cannot be got wrong by
renumbering, squashing or regenerating the sequence.

**A geography point is `GENERATED ALWAYS AS (ST_MakePoint(longitude, latitude)::geography) STORED`,
never written.** That shape is the decision, not the type. A hand-written geo
column and the two coordinate columns are two representations of one fact, so
they can disagree — and a coordinate-ordering mistake is the most likely thing
to get wrong here, because it does not look wrong: a lat/lon swap yields a
plausible point in the wrong hemisphere. Generating the point makes divergence
unrepresentable and states the `(longitude, latitude)` order in ONE place. NAMED
coordinate columns are the other half of the same fix.

**Any spatial test must verify ORDERING against an independently checkable
real-world distance.** A test asserting only "a row came back" passes against
the exact bug.

drizzle-kit cannot emit the `(Point,4326)` typmod (its `parseType` quotes any
type name outside a hardcoded list, and `geography` is not on it as of
drizzle-kit 0.31.10), so the column is declared bare — hence `geography` from
`@oxyhq/db`. The typmod would only constrain WRITES, and a generated column has
none; that the stored value really is a Point at SRID 4326 is asserted against
real rows instead.

**`CREATE EXTENSION postgis` needs a privileged role on a NEW database.** It is
not a trusted extension, so owning the database is not enough — the RDS master
user installs it once per database, before any migration runs. `IF NOT EXISTS`
(which the migrator uses) short-circuits BEFORE the privilege check, so it is a
no-op for the application role afterwards and a hard failure on an unprepared
database. It looks like a fallback and is not one.

## Indexes

Port the indexes that earn their keep, drop the ones that do not, add the ones
Mongo needed and lacked.

- **Dropped as redundant:** a standalone `{storeId: 1}` alongside a compound
  unique that already leads with it — a btree serves any leading prefix.
- **Multikey → GIN**, not btree, for `text[]` columns. A btree cannot serve
  `<@` / `&&`.
- **Sparse → partial.** A partial index is the size of the real set.
- **Every keyset-paginated feed needs its ORDER BY as an index**, in that exact
  column order and direction.

Do not add an index speculatively.

## Migrations

`bun run db:generate` writes the SQL; **`bun run db:migrate
--target-database=<name>` is the only thing that applies it**, in dev, in CI, in
the test harness and in production. Never `drizzle-kit migrate` — it is a
devDependency and cannot reach the production image.

**Every generated `.sql` file must carry exactly one deploy-phase marker on its
own line**, added by hand after `db:generate`:

```
-- oxy:deploy-phase=pre     additive; correct against the image still serving AND the one arriving
-- oxy:deploy-phase=post    drops/renames/narrows; only safe once the new image is live
```

There is no default and an unmarked migration is a hard failure before any DDL
runs. This is not bureaucracy: drizzle selects columns by NAME, so a `post`
change applied early 500s every read the previous image performs, and a `pre`
change applied late 500s every read the NEW image performs. The marker is how
the two halves of one PR get sequenced without a human performing two dispatches
in the right order while a deploy races them.

`--target-database` is required on every run, including a dry run. Pointed at
the wrong database a migrator does not fail — it finds an empty ledger, applies
the whole journal, prints `Applied N` and exits 0, leaving the real database
untouched while the operator reads a success line.

### A `DROP … CASCADE` nobody has checked is how a dependent object disappears

**INBOUND references are what `CASCADE` acts on. The table's OWN outbound
foreign keys are irrelevant to it and survive with their targets — reporting
those instead is the check that looks done and measures nothing.**

That sentence first, because the wrong query is the easier one to write: the
outbound keys are declared right there on the table you are looking at, and the
inbound ones are scattered across every other table in the schema. A reader who
takes the snippet below and not the rule above will check the wrong direction
and find nothing, which is indistinguishable from checking the right direction
and finding nothing.

`drizzle-kit generate` writes `DROP TABLE "x" CASCADE;` for every removed table.
It writes `CASCADE` **unconditionally** — it is not a claim that nothing depends
on the table, and it will silently take a foreign key, a view or a constraint
with it. A `DROP` is `post` by definition, so it always runs against a database
that already has whatever grew on that table since it landed.

**Before landing any generated `DROP`, read the PREVIOUS snapshot for INBOUND
references and state in the migration header what you found:**

```py
[(t, fk['name']) for t, tbl in snapshot['tables'].items()
                 for fk in (tbl.get('foreignKeys') or {}).values()
                 if fk.get('tableTo') == '<the table being dropped>']
```

### Verifying a DROP needs a positive control, like every other census

`select count(*) from information_schema.tables where table_name = '<dropped>'`
returning `0` is the answer you want and also the answer you get from a typo, a
wrong database, a connection to an empty schema, or a migration chain that never
ran. **Query the tables that must SURVIVE in the same breath:**

```
positive control — must exist:  categories, category_aliases, category_redirects
the dropped one — must be 0:    <the table being dropped>
```

The first line is what makes the second mean anything. This is the house
anti-vacuity rule (`SCHEMA_TABLE_COUNT`, the backfill counter CHECKs, every
scanned gate's floor) applied to a one-off manual verification, which is exactly
where it is easiest to skip and hardest to notice having skipped.

### Preserve before you delete: the two-copies rule and D11 rule 3 interact

Two rules that are each correct combine into a way to lose every hand-written
statement you have, and you only reach it by having followed both.

- **The two-copies rule** says a `<domain>.pending.sql` staging file is deleted
  once the migration carries its statements — a second copy that nothing applies
  is one somebody edits to no effect.
- **ADR 0007 D11 rule 3** says that when your migration index collides on a
  rebase you *delete your `.sql` and your `meta/<idx>_snapshot.json`*, restore
  the journal, and regenerate.

Follow them in that order and the delete removes the **only** copy of your
triggers, functions and backfills. Regeneration does not bring them back: it
emits a file without them, which applies cleanly, passes the marker gate (there
is nothing unmarked to find) and **enforces nothing**. That is the "three
branches lost their triggers" failure arriving through a door the protocol
itself opens, and it is invisible until something the trigger was supposed to
refuse gets written.

**The order that is safe:**

```
preserve the marked blocks  ->  delete your .sql + snapshot  ->  restore the
journal verbatim  ->  build:shared-types  ->  db:generate  ->  re-paste  ->
re-read the regenerated file
```

Slice the blocks out with a **column-0 anchor** on `-- oxy:handwritten-begin=`,
never a substring search: a staging header that explains the convention mentions
both markers in prose, and an unanchored slice drags the header in — carrying a
second `-- oxy:deploy-phase=` with it, which fails the marker gate loudly, and a
prose copy of the separator token, which does not.

Measured on #367 step 8: `#423` took `0092` while that branch's CI was green on
it, the regeneration went to `0093`, and the staging file had already been
deleted one commit earlier under the two-copies rule.

---

## The model → table ledger

Every one of the 31 Mongoose models the pre-cutover backend carried, mapped.
This was also the explicit collection → table map the Fase 4 backfill ran from
(Mongoose's derived collection name is the lowercased plural, e.g.
`inventorylevels`). Neither those models nor that backfill exist any more; the
ledger stays because it is the only record of where each table's data came from,
and a column whose shape looks arbitrary is usually answered here.

| Mongoose model | Table(s) |
|---|---|
| `Store` | `stores` + `store_members` |
| `Location` | `locations` |
| `TaxRate` | `tax_rates` |
| `Customer` | `customers` |
| `Connection` | `connections` |
| `SyncRun` | `sync_runs` |
| `ChannelApiKey` | `channel_api_keys` |
| `Category` | `categories` |
| `Listing` | `listings` + `listing_images` + `listing_options` + `listing_external_refs` (and `listing_collections`, below) |
| `ProductVariant` | `product_variants` + `product_variant_option_values` |
| `InventoryLevel` | `inventory_levels` |
| `Collection` | `collections` + `collection_rules` (and `listing_collections`) |
| `Discount` | `discounts` + `discount_codes` |
| `Order` | `orders` + `order_items` + `order_item_option_values` + `order_status_history` + `order_applied_discounts` + `order_tax_lines` |
| `Refund` | `refunds` + `refund_line_items` |
| `DraftOrder` | `draft_orders` + `draft_order_line_items` + `draft_order_line_item_option_values` + `draft_order_applied_discounts` + `draft_order_tax_lines` |
| `Cart` | `carts` + `cart_items` |
| `Address` | `addresses` |
| `Favorite` | `favorites` |
| `Review` | `reviews` (moved to `schema/reviews.ts` by #76) |
| `SellerProfile` | `seller_profiles` |
| `UserPreference` | `user_preferences` |
| `Feedback` | `feedback` |
| `Notification` | `notifications` |
| `PushToken` | `push_tokens` |
| `WebPushSubscription` | `web_push_subscriptions` |
| `AbuseReport` | `abuse_reports` |
| `ModerationOutbox` | `moderation_outboxes` |
| `ModerationEvent` | `moderation_events` |
| `ModerationEnforcement` | `moderation_enforcements` |
| `Counter` | **EXCLUDED** — replaced by two SEQUENCEs, below |

**One Mongo field maps to a table shared by TWO models.**
`listing_collections` carries `Collection.productIds` (the hand-picked, ORDERED
input of a manual collection) and `Listing.collectionIds` (the MATERIALIZED
membership of both kinds) as one relation with a `position`. For a manual
collection those two are the same set by construction — `materialize` computes
`shouldHave` as literally `[...collection.productIds]` — so keeping both would
store one fact twice. `position` is NULL when the membership was derived from
rules.

> **Backfill precondition:** a `productIds` entry naming a listing that no longer
> exists is silently ignored by `materialize` today and is a foreign-key
> violation here. Those entries must be DROPPED during the copy, not inserted.

### The payment domain has NO source model

Nine tables were born in Postgres and appear in no row above, because there is
nothing in `src/models/` for them to be a port OF: `payments`,
`payment_attempts`, `payment_provider_events`, `transfers`, `payouts`,
`payment_outboxes`, `provider_accounts`, `ledger_transactions`, `ledger_entries`.

### The fee domain (#88) is Postgres-born too

Four more tables with no source model: `fee_schedules` (versioned commercial
policy — immutable once active, enforced by the
`fee_schedules_immutable_once_active` trigger and the one-active-per-key
partial unique index), `fee_schedule_acceptances` (the merchant-consent audit
trail, append-only), and `order_fee_snapshots` + `order_fee_snapshot_lines`
(one immutable fee record per checkout order, append-only, written ONLY inside
`orderRepository.insertOrder`'s transaction so an order and its fee record
cannot commit apart). Three decisions worth naming here because they look like
rule deviations and are not:

- **`schedule_key`/`schedule_version` on acceptances and snapshots carry NO
  foreign key.** They are SNAPSHOT names, like an order line's frozen title —
  the record must state what was agreed/charged even read apart from the
  schedule row, and the immutability trigger protects the target anyway. They
  are names, not `*_id` columns, so the classification gate is not being dodged.
- **A `not_applicable` snapshot stores a NULL fee, never a zero** — the CHECK
  `order_fee_snapshots_fee_presence_check` ties all six value fields to the
  result BOTH ways ("all or none" AND "none exactly when not applicable"),
  because a single biconditional lets a partially-filled row through on both
  sides. `mercaria_retail` can therefore never read as a zero-rate schedule.
- **The min/max fee bounds are bare `bigint` minor-unit columns**, not `money()`
  pairs: their currency IS `eligible_currency` (CHECK-enforced), and a second
  currency column would be a second representation of that fact.

What they replaced was not a model but four fields — `Order.payment.{status,
provider, reference, paidAt}` — plus the retired `settlement_*` columns. That
subdocument had to be a state machine, an audit trail, an idempotency key and a
provider reference at once, so it could be none of them well.

**The Fase 4 backfill therefore has nothing to copy into them**, and must not
invent anything: an `Order` marked paid under the old model carries no evidence
of a payment that Mercaria can honestly write a ledger entry from. Production has
never held a paid order, which is what makes that a non-problem rather than a
migration.

### The canonical commerce graph has NO source model either (#53, ADR 0002)

Eight more Postgres-born tables, bound by ADR 0002 (`docs/adr/0002-canonical-
commerce-graph.md`) rather than by any Mongoose model: `catalog_sources`,
`source_records`, `organizations`, `brands`, `organization_aliases`,
`brand_aliases`, `organization_source_links`, `brand_source_links`. The
decisions that make their shapes answerable:

- **Closed sets from shared-types tuples**, as everywhere else:
  `CANONICAL_ENTITY_STATUSES`, `CANONICAL_ALIAS_KINDS`, `CATALOG_SOURCE_KINDS`,
  `SOURCE_RECORD_EXTERNAL_TYPES`, `SOURCE_LINK_METHODS`, `SOURCE_LINK_STATUSES`
  — each rendered into its CHECK by `checkOneOf`.
- **Shared column shapes are stated once** in `canonicalSupport.ts`
  (`canonicalLifecycleColumns()`, `aliasColumns()`, `sourceLinkColumns()`), the
  `money()`/`dualMoney()` precedent. #54/#56 build their alias and source-link
  tables from the SAME helpers; per-entity tables (never one polymorphic one)
  so every child row keeps a real foreign key (ADR 0002 D16).
- **`normalized_alias` is GENERATED** — `lower(btrim(alias))`, both IMMUTABLE —
  so an alias and its lookup key cannot disagree. Deliberately shallow: the
  deep normalization (accents, punctuation, legal suffixes) is application
  vocabulary in `services/canonical/normalization.ts`, because a generated-
  column rewrite silently drops the column's indexes (see Generated columns
  above) and normalization rules evolve. The two PRIMITIVES that fold composes
  — `foldAccents` and `wordTokens` — moved to `@mercaria/shared-types`
  (`text-fold.ts`) in #838, because a fold in that package needed them and the
  dependency runs one way; they are the repository's only definition of "what is
  an accent" and "what is part of a word", and a second copy is what #830 was.
- **`search_vector` uses the `'simple'` config**, not `'english'` — proper
  nouns must not be stemmed ("Nike" is not a verb). Listing prose keeps its
  `'english'` vector; the two configurations coexist on purpose (ADR 0002 D21).
- **`pg_trgm` is a REQUIRED extension of the migrator** (beside `postgis` in
  `migrate.ts`), never a numbered migration — the alias/name trigram GIN
  indexes (`gin_trgm_ops`) depend on it. Unlike PostGIS it is TRUSTED, so the
  application role creates it itself; no privileged provisioning step.
- **Tombstones, not deletes**: a merged row keeps its slug (plain unique, no
  partial — "never reused" is structural) and carries `merged_into_id` to the
  FINAL winner, with a CHECK pair making a tombstone-without-target and a
  self-redirect unrepresentable. Chains are flattened on write.
- **Idempotency is natural uniques, not deterministic uuids** (ADR 0002 D22):
  `catalog_sources.name`, the `source_records`
  `(source_id, external_type, external_id, content_hash)` identity (plus a
  shape CHECK that the hash IS a sha-256), the per-entity
  `(entity_id, normalized_alias)` alias unique, and the source-link partial
  unique `WHERE status = 'active'`. Every writer converges with
  `ON CONFLICT DO NOTHING` in the moderation-event pattern.
- **`source_records` is append-only** (`created_at`, no `updated_at` — the
  `order_status_history` contract): changed content is a NEW row and the row
  sequence is the observation history.
- **Domains are two different claims**: `organizations.verified_domains` is
  evidence-backed and written by exactly one service function;
  `brands.observed_domains` is accumulated observation and never ownership
  proof. Both are `text[]` + GIN because they are scalar sets queried by
  element, not entities.

### The merchant/storefront layer of the same graph (#54, ADR 0002)

Eight more Postgres-born tables, in `merchants.ts`: `merchants`,
`merchant_aliases`, `merchant_domains`, `merchant_source_links`, `storefronts`,
`storefront_aliases`, `storefront_source_links`, `native_store_links`. They
inherit everything the #53 section above states — the shared-types tuples, the
`canonicalSupport.ts` helpers (all three, spread rather than re-derived), the
generated `normalized_alias`, the `'simple'` search vector, the `pg_trgm`
dependency, tombstone-not-delete with the merged-consistency CHECK pair, and
natural-unique idempotency. What is #54's own:

- **The graph attaches to native tables, never absorbs them.** The ONLY
  foreign keys into pre-existing tables are `native_store_links.store_id` and
  `.merchant_id`, both RESTRICT (ADR 0002 D4/D25(d)): nothing deletes a
  `stores` row today, and if a path ever does, an active canonical link must
  confront it, not silently orphan. Paired partial uniques hold ≤1 ACTIVE link
  per store AND per merchant; the row itself is the audit record, so
  verification method/actor/time are NOT NULL and a `revoked` row must carry
  its actor and time by CHECK. The method set has NO name-match member.
- **`merchant_domains` is the domain-collision gate**: many merchants may
  OBSERVE one domain; the partial unique `(domain) WHERE status='verified'`
  admits exactly one VERIFIED holder. The `col = lower(btrim(col))` CHECK on
  `merchant_domains.domain` / `storefronts.domain` makes normalization
  structural, so a case-variant spelling cannot dodge the unique.
- **`merchants.claim_state` is one stored verdict** (the `onboarding_state`
  precedent, ADR 0002 D9), moved only by #40/#83. Native-checkout eligibility
  is DERIVED at read time (claimed AND actively linked) and stored nowhere.
- **No `organization_id` on merchants**: *organization operates merchant* is
  an evidence-gated `commerce_relationships` row (#55, ADR 0002 D17), and a
  column here would be a second representation of that fact.
- **Zero new `jsonb`.** Nothing in this layer earned a register row.
- **The parallel-development note:** on #54's branch the five
  `source_record_id` columns were carried as DEFERRED foreign keys
  (`db/deferredForeignKeys.ts`); at integration, with `source_records` merged,
  the gate forced every one into the real RESTRICT `.references()` it carries
  now. That is the mechanism working as designed, recorded here so the next
  parallel schema batch reuses it instead of inventing one.

### The relationship layer of the same graph (#55, ADR 0002 D10/D11/D17)

Three more Postgres-born tables, in `relationships.ts`: `commerce_relationships`,
`relationship_evidence`, `relationship_reviews`. A relationship is a typed,
scoped, temporal, evidence-gated CLAIM between two canonical entities — never a
boolean on an entity and never derivable from a name, a logo or a domain. The
decisions that make their shapes answerable:

- **Closed sets from shared-types tuples**, as everywhere else:
  `RELATIONSHIP_KINDS`, `RELATIONSHIP_VERIFICATION_STATES`,
  `RELATIONSHIP_ASSERTED_BY_KINDS`, `RELATIONSHIP_VERIFICATION_METHODS`,
  `RELATIONSHIP_EVIDENCE_KINDS`, `RELATIONSHIP_EVIDENCE_STATUSES`,
  `RELATIONSHIP_REVIEW_ACTIONS` — each rendered into its CHECK by `checkOneOf`.
  `verification_method` has NO `name_match` member, the
  `NATIVE_STORE_LINK_METHODS` device: "verified because the name matched" has no
  value to be stored as.
- **Endpoints are FIVE nullable FK columns plus a per-kind CHECK**, not four
  (ADR D17) and not a polymorphic `{type, id}` quad. Four cover one column per
  entity kind; the fifth, `related_brand_id`, is the OBJECT side of
  `brand_succeeds_brand` — the issue's ninth relationship type, whose two ends
  are both brands. A polymorphic quad would give up every foreign key in the
  table to solve a problem exactly one kind has. The CHECK's `else false` branch
  is load-bearing: an unrecognised kind is unrepresentable even with the kind
  CHECK removed, so widening the tuple without widening the CHECK fails the
  first write instead of admitting an endpoint-less row.
- **`product_family_id` was the batch's second DEFERRED foreign key**, waiting on
  #56's `canonical_product_families` (RESTRICT per D20). #56 landed that table in
  the same batch, the gate refused the deferral, and it is a real
  `.references()` today — the mechanism #54's section records, used a second time
  exactly as designed.
- **Three of the issue's nine relationship types are deliberately NOT kinds.**
  *merchant operates storefront* is `storefronts.merchant_id`, *brand contains
  product family* and *brand markets product* resolve through
  `canonical_product_families.brand_id` (D17: containment is a foreign key,
  assertable and temporal facts are rows). `STRUCTURAL_GRAPH_FACTS` in
  shared-types names each one and where it lives, and
  `services/commerce-graph/__tests__/relationship-kinds.test.ts` fails the build
  if a kind ever duplicates one.
- **`status` is ONE stored verdict and `confidence` is NOT a weaker form of it.**
  The six states are the ISSUE's vocabulary, a superset of ADR D17's four:
  `candidate` IS the ADR's `asserted` under the issue's name (nothing had been
  written to this table, so the rename cost nothing), and `pending_review` and
  `expired` are added — `pending_review` because a self-claim asking for a
  decision is a different fact from one sitting unasked, `expired` because the
  operator workflow has an explicit expire action. `expired`/`revoked` both
  CHECK-require `valid_to`, and the public resolver requires the temporal window
  as well as the status, so a lapsed claim produces no badge whether or not a
  sweep has run. `confidence` is CHECK-restricted to rows an ingestion source
  asserted, so a hand-verified row carries none at all.
- **`endpoint_key` is GENERATED, and a plain multi-column unique would NOT
  work.** Postgres treats NULLs as DISTINCT, so a unique over the five nullable
  endpoint columns admits two rows with identical non-null endpoints and NULL
  elsewhere — the exact duplicate it exists to refuse. The generated
  `coalesce(...) || '|' || …` key (both functions IMMUTABLE) collapses them into
  one text value, and the partial unique `(kind, endpoint_key) WHERE valid_to IS
  NULL` uses it. `storefront_id` is part of the key because "official channel via
  this storefront" and "official channel across every channel" are different
  claims; `territories` is NOT, because markets are an ARRAY on one row (which is
  what makes overlap detection unnecessary for identical endpoints).
- **Two scope columns are shape-CHECKed rather than containment-CHECKed**, which
  deviates from D17's wording with a stated reason: `territories` scopes the same
  markets `storefronts.country` does one table over, and that column is
  `~ '^[A-Z]{2}$'`. Two different validations of one vocabulary inside one graph
  is the disagreement these conventions exist to prevent. Element-wise shape on a
  `text[]` cannot use `unnest` (a CHECK admits no subquery), so both go through
  `mercaria_immutable_array_to_string` — migration 0006's narrowed IMMUTABLE
  wrapper, reused here for its second purpose. `'{}'` means WORLDWIDE / every
  language: a relationship is a positive fact scoped down, the OPPOSITE of
  `supplier_agreements`' empty scope, which is a grant and means none.
- **`relationship_evidence` is typed rows, never a jsonb blob** (D17). A
  `brand_statement` CHECK-requires BOTH its URL and its content digest, so the
  claim survives the page changing; `domain_control` CHECK-requires
  `subject_domain` and every other kind CHECK-forbids it, which is what keeps
  "control of that hostname" from reading as proof of anything else; every kind
  but `operator_attestation` must carry a locator. Revoking or expiring evidence
  moves `status` and never deletes — the relationship it backed is untouched, and
  the resulting gap surfaces as a `verified_without_active_evidence` conflict.
- **`relationship_reviews` is append-only by TRIGGER and is also the four-eyes
  MECHANISM.** `mercaria_relationship_review_append_only` refuses UPDATE and
  DELETE (the `order_fee_snapshots` precedent), and the partial unique
  `(relationship_id, review_round, actor_oxy_user_id) WHERE action = 'approve'`
  is what makes a second endorsement by one operator impossible rather than
  merely refused. `review_round` on the parent advances with every decision, so
  an approval given for one version cannot be reused for the next — without
  which "request more evidence, then approve alone" would defeat the rule.
- **Both child tables are RESTRICT, not CASCADE**, though both are children
  (D20): audit rows must be able to BLOCK a delete, not vanish with the row they
  justify. Nothing in this layer is hard-deleted by a production flow —
  expiry and revocation stamp `valid_to`, and a correction opens a NEW row linked
  back through the `superseded_by_id` self-FK.
- **Zero new `jsonb`.** Nothing in this layer earned a register row: every
  evidence field a reviewer or a re-check needs is a real column.
### The canonical PRODUCT layer of the same graph (#56, ADR 0002)

Nineteen more Postgres-born tables, in `canonicalCatalog.ts`:
`attribute_definitions`, `attribute_definition_categories`,
`canonical_product_families`, `canonical_product_family_aliases`,
`canonical_product_family_source_links`, `canonical_product_family_redirects`,
`canonical_products`, `canonical_product_aliases`,
`canonical_product_source_links`, `canonical_product_redirects`,
`canonical_variants`, `canonical_variant_aliases`,
`canonical_variant_source_links`, `canonical_variant_attributes`,
`canonical_images`, `canonical_attribute_values`, `canonical_field_provenance`,
`bundle_components`, `product_identifiers`. They inherit everything the #53 and
#54 sections state — the shared-types tuples, the `canonicalSupport.ts` helpers,
the generated `normalized_alias`, the `'simple'` search vector, the `pg_trgm`
dependency, tombstone-not-delete with the merged-consistency CHECK pair, and
natural-unique idempotency. What is #56's own:

- **`status` is the ONE deliberate divergence from the shared lifecycle helper.**
  `catalogLifecycleColumns()` spreads `canonicalLifecycleColumns()` and then
  replaces its `status` column with one typed from `CANONICAL_CATALOG_STATUSES`
  (`draft | active | discontinued | merged | suppressed`). Two of those are facts
  about a PRODUCT that an organization does not have — `draft` for an unreviewed
  provisional row, `discontinued` for a maker that stopped making it — and the
  set deliberately DROPS `inactive`, because "not sold any more" already has a
  precise source-observable name and a second vaguer value beside it is a fact
  two writers can record two ways. The override is spelled out, not hidden, and
  the CHECK is rendered from the same tuple that types the column.
- **The variant SIGNATURE is what makes one iPhone one product.**
  `canonical_variants.signature` is a sha-256 of the variant's option
  assignments, sorted by attribute key with each value normalized (a quantity
  normalizes to its base-unit magnitude, so "256 GB" and "0.256 TB" collapse);
  `position` is display order and deliberately not an input.
  `UNIQUE(product_id, signature)` is what makes that determinism load-bearing
  rather than decorative — the second write of one configuration is refused by
  the database, whichever order a source listed the options in. It is a plain
  column maintained by `canonical-variant.service`, NOT generated: a generated
  expression cannot read another table, and a shape CHECK
  (`^[0-9a-f]{64}$`) stops a hand-written row occupying the key space.
- **The product declares its axes; the variants must match them exactly.**
  `canonical_products.variant_defining_attribute_keys` is the explicit marking
  #56 attribute rule 5 asks for, held at the product because that is where the
  fact lives (an iPhone's axes are storage and colour). Without it a variant
  missing an axis would hash to a signature meaning something different from
  what it says. The `text[]` is the `pinned_fields` precedent: a scalar set of
  stable KEYS, not of ids.
- **Identifiers: three uniqueness decisions, each for a different reason.**
  `(canonical_scheme, canonical_value) WHERE status='active'` is the collision
  gate — one active owner per GTIN, so a newcomer is written `disputed` and never
  steals it. The paired per-entity active uniques stop duplicate ACTIVE
  assignments of one identifier to one entity. MPN and `brand_model` get **no**
  uniqueness at all, because MPNs collide across brands legitimately and a
  constraint that has to be wrong sometimes is worse than none (ADR 0002 D14);
  brand scope is enforced in the service, which refuses a brand-scoped scheme on
  an entity resolving to no brand.
- **Identifier values are immutable by TRIGGER**
  (`product_identifiers_values_immutable`, migration 0017 — the
  `purchase_order_lines` precedent): `raw_value` is the only record of what a
  source actually said and `canonical_value` sits inside the collision gate, so
  an in-place edit would destroy review evidence and silently move ownership of a
  GTIN. The trigger permits exactly two updates, both deliberate: a STATUS
  transition (how a correction is recorded) and an OWNER change (what a merge
  does).
- **Provenance is NOT NULL where it is the point.** `canonical_images` and
  `canonical_attribute_values` both carry `source_record_id NOT NULL`, which is
  what makes "every selected field and image is traceable to provenance" (#56
  acceptance 4) structural rather than a habit — operator entry is a
  `catalog_sources` row too (D19), so there is no "no source" case to carve out.
  There is deliberately NO per-image rights column: rights are the SOURCE's
  (`may_display`, `attribution_required`), and a copy here could disagree with
  the registry that owns them.
- **`canonical_field_provenance` is #53's provenance layer at FIELD grain, not a
  second one** — a real `source_records` foreign key, the same
  `SOURCE_LINK_METHODS` tuple, and the same `confidence` semantics (NULL means
  deterministic/human and outranks every number). It is the one table here that
  writes `ON CONFLICT DO UPDATE`: a field's provenance is a statement about the
  value stored right now, not an accumulating history, and the history lives in
  the append-only `source_records` rows.
- **`canonical_attribute_values` keeps disagreements as facts.** One row per
  (entity, key, observation), plus a `selected` flag with a partial unique so at
  most one value per attribute is shown. When two equally-strong sources
  disagree, NEITHER is selected and both are marked `conflicting` — the
  structural form of "unknown or conflicting values remain source facts and are
  not guessed", reinforced by a CHECK that only a `normalized` row may carry a
  normalized value at all.
- **Redirect HISTORY is its own append-only table**, per entity type
  (`canonical_product_redirects`, `canonical_product_family_redirects`).
  `merged_into_id` answers where a row points NOW and cannot answer where it
  pointed before, because D16's chain flattening overwrites it; each hop is
  appended instead, converging on `UNIQUE(from_id, to_id)` so a re-run grows no
  rows. Variants deliberately have no redirect table: the issue asks for history
  on family and product, and the variant tombstone IS the redirect every offer
  reference resolves through.
- **The polymorphic-grain tables use nullable FKs plus a CHECK**, never a
  `{kind, id}` pair — `canonical_images`, `canonical_attribute_values`,
  `canonical_field_provenance` and `product_identifiers` all address their entity
  that way, because every endpoint's key space is in THIS database and real
  foreign keys are available (the `commerce_relationships` reasoning, D17). That
  is why none of them needs a `deferredForeignKeys.ts` entry.
- **Zero new `jsonb`.** Identifiers, dimensions, attribute values, images and
  provenance are all real columns or child tables, so this layer adds no row to
  the register below.
- **The parallel-development note, second instance:** #118's
  `procurement_offers.canonical_product_id` / `.canonical_variant_id` were
  carried as DEFERRED foreign keys while this domain was built; at integration
  the gate refused the deferral and both became real RESTRICT references. Same
  mechanism #54's section records, now used twice.
### The OFFER layer of the same graph (#57, ADR 0002 D6/D8/D18)

Three more Postgres-born tables, in `offers.ts`: `offers`, `native_listing_links`,
`offer_outboxes`. An offer is one seller/channel offering one exact canonical
variant under specific commercial terms at a point in time — the row every
comparison surface reads, whether the seller is a Mercaria listing or a crawled
retailer. It inherits the closed-set-from-a-shared-types-tuple rule and the
natural-unique idempotency the four sections above state. What is #57's own:

- **The per-kind CHECK is where "an external offer cannot enter the cart"
  lives.** `offers_kind_shape_check` forces `product_variant_id` NULL on every
  kind but `native`, and cart and checkout operate on `product_variants` and
  nothing else — so the issue's external rule 1 is a SHAPE rather than a rule
  somebody enforces: there is no id a cart line could hold. Its `else false`
  branch is load-bearing for the reason `commerce_relationships`' is: an
  unrecognised kind is unrepresentable even with the kind CHECK dropped, so
  widening the tuple without widening the CHECK fails the first write.
- **There is NO stored checkout-eligibility verdict, and that is the deliberate
  divergence from the `onboarding_state` one-verdict rule.** Payment readiness
  is one stored verdict because its inputs are all on the row being verdicted;
  offer buyability is a conjunction over the LIVE `listings.status`, the LIVE
  `product_variants` stock and `provider_accounts.onboarding_state` — three
  tables this domain does not own. A stored copy is wrong for exactly as long as
  it takes a converger to notice, and that window is when a restricted listing
  must not be purchasable. `deriveNativeCheckoutEligibility` is the one
  derivation, following `merchants`' native-checkout rule and
  `procurement-eligibility.ts` (which took the same step for the same reason).
  A realdb case pins it: a listing is restricted, the offer row is left ACTIVE
  and stale, and the read still refuses.
- **Two GENERATED keys, because a plain multi-column unique would NOT work.**
  Postgres treats NULLs as distinct and both uniqueness rules span columns that
  are legitimately NULL (a feed with no account concept, an offer on no
  particular storefront), so `source_key` and `commercial_key` collapse their
  columns with `coalesce` — the `commerce_relationships.endpoint_key` device.
  ADR 0002 D18 suggests paired partial indexes for the second one; the generated
  key is the same constraint with one index instead of two and is noted here as
  an implementation choice, not a semantic change.
- **The idempotent source key is NOT a second representation of
  `source_record_id`.** That column names ONE observation; `provider` +
  `source_account_ref` + `external_offer_id` name the thing observed ACROSS
  observations, which is what an upsert must key on before it has minted a
  record for the new one. The `order_fee_snapshots.schedule_key` reasoning, one
  domain over.
- **Unknown is stored as ABSENCE and never as zero.** The delivery cost is a
  nullable money pair with a paired CHECK, `available_quantity` is a nullable
  integer, and `pickup_state` is a three-member set rather than a nullable
  boolean — so "the source said nothing", "the source said no" and "the source
  said free" are three storable facts. A free-over threshold with no cost is
  CHECK-refused, because it states what you would stop paying without ever
  saying what you pay.
- **Retirement is a status transition and nothing in the domain issues a
  DELETE.** The row, its `source_record_id` and the append-only `source_records`
  chain behind it are the historical reference #57 acceptance 5 protects. There
  is deliberately **no price-history table**: ADR 0002 D18 assigns price HISTORY
  to #78 and this table to current state, and the observed history already
  exists — `source_records` mints a NEW row whenever content changes, so the
  sequence of records IS the price history and expiry touches none of it.
- **The currency columns carry a SHAPE check, not the tuple CHECK** — ADR 0002
  D18's documented exception, the third member of the class
  `connections.shop_currency` and `storefronts.currency` define. This is why
  `money()`/`optionalMoney()` are NOT used here: those helpers type the column
  from the presentment tuple by construction. The DTO follows: `OfferMoney`
  rather than `Money`, so the type does not assert what the column does not.
- **No canonical PRODUCT id, no native STORE id, no `catalog_sources` id.** Each
  would be a second representation of a fact one join away — the product through
  `canonical_variants.product_id` (a semi-join, and a variant merge cannot put it
  out of step), the store through `listings.store_id`, the adapter through
  `source_records.source_id`. `listing_id` IS denormalized beside
  `product_variant_id`, the `inventory_levels.listing_id` precedent, because
  "every offer of this listing" is the query the converger, the moderation path
  and the operator trace all run.
- **`offer_outboxes` is ONE ROW PER LISTING, which makes it a convergence queue
  rather than a delivery queue.** The moderation and payment outboxes are one row
  per EVENT with a deterministic id, because each delivers a distinct thing
  exactly once; this one delivers a FIXED POINT, so five writes in a second owe
  one convergence. That inverts two of their rules deliberately: the enqueue is
  `ON CONFLICT DO UPDATE` (a `DO NOTHING` would drop the four requests that
  arrived while one was pending, including the one that mattered), and there is
  no `expires_at` and therefore no `db/expiryTargets.ts` entry — the table is one
  row per listing and CASCADEs with it, so it cannot grow unboundedly, and a
  retention sweep here would delete pending convergence work on a clock.
- **The `requested_revision`/`claimed_revision` pair closes the mid-run race.** A
  claim copies the first into the second and completion compares them, so a
  request that lands during a convergence leaves the row `pending` instead of
  being swallowed by the completion that follows it. The enqueue must NOT write a
  flat `'pending'` over a `processing` row — that releases a live lease from
  outside the worker, and the completion then fails its owner check and discards
  its own outcome. Measured: the realdb case fails on the flat form.
- **`native_listing_links.method` has NO `name_match` member**, the
  `native_store_links` / `commerce_relationships` device: "attached because the
  titles looked alike" has no value to be stored as, so a matcher must record
  `matcher` with a rule id and a confidence #59 can review. `confidence` is
  CHECK-restricted to `matcher` rows for the same reason it is restricted to
  ingestion rows on a relationship.
- **`offers.stale_at` is ONE deadline.** The issue asks for an expiry timestamp
  and ADR 0002 D18 asks for `stale_at`; they are the same fact and a second
  column would need a rule for which one wins. It is a VALIDITY deadline, not a
  retention one, so this domain registers NOTHING in `db/expiryTargets.ts` — the
  retail-pricing rule. The lapse sweep excludes NATIVE offers, because their
  deadline measures how long ago the converger ran and sweeping it would delist a
  healthy catalogue whenever the dispatcher stopped.
- **The two browse indexes order `last_seen_at` ASCENDING, and that is the fix
  rather than the bug.** The obvious spelling is `.desc()`, matching the
  browse's own ORDER BY — and drizzle renders it `DESC NULLS LAST`, while a plain
  `ORDER BY last_seen_at DESC` means `DESC NULLS FIRST`. The two do not match, so
  Postgres cannot use the index for the sort and falls back to a bitmap scan plus
  a top-N sort over every one of that seller's offers. Measured on a seeded
  million rows with one seller holding 25,000: **103.7 ms** with `.desc()` and a
  plain `ORDER BY … DESC`, **0.113 ms** once the reader spells `DESC NULLS LAST`,
  and **0.071 ms** with the ASCENDING index and the plain, natural ORDER BY,
  which Postgres serves with a BACKWARD scan (a backward scan of
  `ASC NULLS LAST` is exactly `DESC NULLS FIRST`). The ascending index is the one
  that does not depend on every future reader remembering a NULLS clause. This
  generalizes beyond the offer domain: **a DESC index only serves a DESC sort
  when the NULLS ordering matches too, and on a NOT NULL column the ascending
  index is strictly more robust.** The existing feeds that use `.desc()` order
  nullable columns (`listings.published_at`) and are a different case; check the
  plan before copying either shape.
- **Zero new `jsonb`.** Every shape in this domain is Mercaria's own and closed,
  so none of them earns an entry in the register below.
### The versioned attribute registry (#94)

Six more Postgres-born tables, in `attributeRegistry.ts`: `attribute_definitions`
(MOVED here from `canonicalCatalog.ts` and reshaped), `attribute_labels`,
`attribute_definition_categories` (moved), `attribute_enum_values`,
`attribute_value_aliases`, `attribute_source_mappings`,
`attribute_value_reviews`, `attribute_reindex_requests` — plus the #94 columns
on `canonical_attribute_values` and `canonical_variant_attributes`. Full
behaviour: **`docs/attributes.md`**. The decisions that make a column whose
shape looks arbitrary answerable:

- **A definition is a VERSION, and its meaning is frozen once published.**
  `(key, version)` is the identity; a partial unique
  (`attribute_definitions_one_active_per_key`) keeps exactly ONE version
  `active`; and `attribute_definitions_immutable_once_published` (migration
  `0024`, the `fee_schedules_immutable_once_active` mechanism) refuses every
  semantic edit and every DELETE from the moment a version leaves `draft`. A
  stored value cites the version it was normalized under, so changing what an
  attribute means can never silently reinterpret facts recorded under the old
  meaning — it publishes a new version and enqueues a re-normalization.
  `label` and `description` are deliberately NOT frozen: "stored keys remain
  stable when labels change" is only worth anything if a label can be corrected.
  A second trigger freezes the enum VOCABULARY of a published version for the
  same reason — an alias table that could change afterwards would let `USB C`
  resolve to a different canonical value than it did when a value was stored.
- **`attribute_definitions_reserved_key_check` refuses an OFFER fact.** A
  definition keyed `price`, `availability`, `condition`, `shipping_cost` (twenty
  names, `RESERVED_OFFER_FACT_KEYS` in shared-types) cannot exist, which is what
  makes "price, shipping and availability use current eligible offers rather
  than static product attributes" (#94 hard-constraint rule 6) structural. Those
  facts are answered through `services/attributes/offer-facts.port.ts`, the seam
  #57 fills. `msrp` is deliberately NOT reserved — a manufacturer's suggested
  price is a fact about the product, and a `money`-typed attribute is its home.
- **Every declaration pairing is a BICONDITIONAL, not a one-way requirement.** A
  `measurement` or `structured` attribute has a unit family and nothing else may
  carry one; a unit family travels with its base unit; `rating_scale_max` is
  present exactly for the `rating` family (4.5 out of 5 is not 4.5 out of 10); a
  `money` attribute names exactly one currency (the `fee_schedules` rule — an
  amount whose currency lives in a label is a generic decimal wearing a
  currency's clothes); `structured` is the only type that may declare component
  axes and it must. A half-declared definition produces a value nobody can
  interpret, so each direction is refused.
- **Only an `objective` attribute may be `hard_constraint_capable`, and it must
  be `filterable`.** An opinion must not be able to EXCLUDE a product, and a
  requirement nobody can see as a filter is a rule they cannot check.
- **`include_descendants` is per SCOPE row, not per definition.** That IS the
  inheritance rule: "screen size, everywhere under Electronics" and "shoe width,
  in Shoes and not in Shoe care" are both correct, and one global policy would
  have to be wrong for one of them. NO scope rows means UNSCOPED — the opposite
  reading from a procurement agreement's empty scope, because a scope NARROWS
  something otherwise general.
- **`canonical_attribute_values.value_slot` is GENERATED, and a plain
  multi-column unique would NOT work.** Postgres treats NULLs as distinct, so a
  unique over a nullable `component_axis` admits two axis-less rows for one key
  and one source record — the exact duplicate it exists to refuse. The generated
  `coalesce(component_axis,'') || '#' || position` (both IMMUTABLE) collapses
  them, the `commerce_relationships.endpoint_key` device. The convergence and
  selection uniques are taken over it, which is why one dimensions observation
  legitimately writes three rows and a set attribute can show three ports while
  a single-valued one still shows exactly one value.
- **`selection_state` replaced #56's `selected` boolean, and `conflicting` moved
  off the normalization state.** Disagreement is a property of the SELECTION
  between two well-parsed facts, not of either one's parse; conflating them made
  "we could not read it" and "two sources disagree" indistinguishable in the one
  place an operator needs them apart. A conflicting row therefore KEEPS its
  normalized columns — an operator resolving it must be able to see what they
  are choosing between.
- **`normalization_state` has five refusals and only `normalized` may carry a
  value**, enforced by one CHECK covering every typed column at once (so
  widening the value types cannot leave one outside it). The five are
  distinguishable on purpose because they call for different work: `unparsed`
  (not a value of the type), `unknown_unit` (a taxonomy gap), `out_of_range` (a
  definitional impossibility), `implausible` (a source SCALE error — the right
  number in the wrong scale, which a per-source mapping can fix), and
  `marketing_claim`.
- **`attribute_source_mappings.assumed_unit` is the ONLY place a unit may come
  from when a source writes a bare number.** Not the attribute's base unit, not
  a sibling value, not the magnitude's size — a human-recorded fact about the
  FEED, which is what "never infer a unit from a number when the source is
  genuinely ambiguous" requires mechanically.
- **`verification_state` is not `confidence`.** `corroborated` means two
  INDEPENDENT source records normalized to the same value — a fact about the
  world; `confidence` is one source's estimate of itself. Neither is derivable
  from the other, which is why both exist.
- **The review queue's `(entity_kind, entity_id, attribute_key) WHERE
  state='open'` partial unique** is what makes "one open review per entity and
  attribute" true against two ingestion workers a millisecond apart, rather than
  against a read-then-write they would both walk past. `priority` is FROZEN at
  open time: "high-impact" is a judgement about the catalogue as it was, and
  re-deriving it later would silently reorder a queue somebody is working
  through.
- **`attribute_reindex_requests` is the moderation-outbox shape with a
  DETERMINISTIC id** (`<entityKind>:<entityId>:<attributeKey>:<reason>`), so a
  repeat converges with `ON CONFLICT DO NOTHING` — no tuple version, no
  timestamp. It is written now and DRAINED by whoever owns the search index
  (#61): gate the loop, never the record. One row per ENTITY rather than one
  naming the definition, because expanding "everything with key X changed"
  inside a lease is unbounded work.
- **There is NO coverage table.** Completeness by category, source and field is
  a QUERY (`services/attributes/coverage.service.ts`); a stored number would be
  a second representation of a fact the values already carry, stale the moment
  an observation lands. Recorded as a decision in the schema file so the absence
  does not read as an oversight.
- **`attribute_value_reviews.entity_id` and `attribute_reindex_requests.entity_id`
  carry no foreign key** — polymorphic by `entity_kind`, the
  `merchant_claim_scopes.scope_ref` reasoning, and a reindex request is a JOB
  that must survive whatever happens to its entity between enqueue and drain.
  `resolved_value_id` likewise: it records the DECISION an operator made, and a
  cascade would erase that record when the losing value was later corrected
  away.
- **Zero new `jsonb`.** Enum values, aliases, localized labels, category scopes
  and validation rules are all real columns or child tables, so this layer adds
  no row to the register below.
- **The migration is a PAIR, and the split is the deploy-phase rule working.**
  `0024` (`pre`) is additive plus two CHECK WIDENINGS and three index
  replacements, all correct against the image still serving and the one
  arriving; `0025` (`post`) carries the value-type clean cut
  (`quantity`→`measurement`, `number`→`integer`/`decimal`, `text`→`string`), the
  `conflicting`→refusal-state change, and the three column drops. Each statement
  in `0025` breaks a write the previous image performs, which is exactly what
  `post` means. Both files state their own reasoning at the top.

### The MATCHING layer of the same graph (#58, ADR 0002 D14/D19)

Nine more Postgres-born tables, in `matching.ts`: `match_policy_versions`,
`match_benchmark_runs`, `match_benchmark_categories`, `match_category_gates`,
`match_decisions`, `match_decision_candidates`, `match_blocked_pairs`,
`match_queue`, `match_sweep_cursors`. Deciding which canonical product a source
record or a native listing IS. It inherits the closed-set-from-a-shared-types-tuple
rule and the natural-unique idempotency the sections above state. What is #58's
own — and every one of these is here because the WRONG answer, a false merge,
looks exactly like the right one and is discovered by a customer:

- **The blocker array is ONE CHECK standing in for four product rules.**
  `match_decisions_blockers_auto_check` refuses `outcome = 'automatic_match'`
  with a non-empty `blockers`, and `MATCH_BLOCKERS` carries every reason a merge
  is forbidden — a conflicting identifier, a brand disagreement, a bundle
  mistaken for its component, a missing axis, an operator's rejected pair, a
  closed category gate. So "conflicting valid identifiers never auto-merge"
  (#58 acceptance 2) is a CHECK rather than four branches somebody has to keep
  writing, and adding a rule is adding a blocker. Two companion CHECKs close the
  ways around it: `match_decisions_conflicting_identifier_check` refuses a
  recorded conflicting identifier WITHOUT the blocker (otherwise the audit array
  could say "conflicting" while the outcome said "merged"), and
  `match_decisions_blockers_explained_check` (`blockers <@ reason_codes`) makes
  every refusal name itself in the operator-facing explanation. The containment
  is free at the type level too: `MatchBlocker` is a member of
  `MatchReasonCode`, so a blocker that is not a reason code fails to compile.
- **The subject is TWO nullable foreign keys plus a CHECK, and a THIRD column
  that is not a denormalization of either.** `source_record_id` and
  `product_variant_id` are the `product_identifiers` grain device (both key
  spaces are in this database, so real FKs are available). `evaluation_key` is
  GENERATED from `coalesce`, because Postgres treats NULLs as distinct and the
  idempotency unique spans two legitimately-NULL columns — the
  `offers.source_key` reasoning. `subject_key` is a PLAIN column, and it is the
  STABLE identity: for an observation, `(source_id, external_type, external_id)`,
  one join away. It exists because `source_records` is append-only and mints a
  NEW row per content change (D19), so a blocked pair keyed on the observation
  would evaporate on the next crawl and the matcher would re-propose the same
  wrong merge — the exact failure acceptance 4 forbids. It is not generated
  because a generated expression cannot read another table.
- **`matched_canonical_product_id` beside `matched_canonical_variant_id` is not
  the denormalization it looks like.** Rule 1 makes product identity a SEPARATE
  stage from variant identity, so "the product resolved and the variant did not"
  is a real and ordinary state — a listing that never said which colour it was.
  One column could not record it. `match_decisions_grain_order_check` states the
  dependency in the direction rule 1 asserts, and permits the converse.
- **Confidence is NULL on a deterministic stage, and CHECK-enforced to be.**
  `match_decisions_confidence_stage_check` refuses a number on
  `existing_source_link`, `global_identifier`, `brand_scoped_identifier` and
  `no_candidate`. This is the `source_links`/`native_listing_links` semantics
  unchanged — NULL means certainty by construction and OUTRANKS every number —
  and the CHECK is what stops two representations of certainty coexisting, which
  would make a reviewer's `confidence < 0.9` filter silently skip one whole class
  of decision.
- **A category gate cites its measurement by a NOT NULL COMPOSITE foreign key.**
  `match_category_gates.(benchmark_category_id, policy_version_id)` references
  `match_benchmark_categories.(id, policy_version_id)`, so a gate with no
  benchmark is unrepresentable AND a gate citing a run measured under a different
  policy is refused by Postgres rather than by a comparison in a service. That is
  acceptance 5 made structural. The two referenced identity keys are table
  CONSTRAINTS rather than unique INDEXES on purpose: a composite FK needs its
  referenced columns unique when the constraint is added, and drizzle-kit emits
  table constraints with the CREATE TABLE while it emits indexes afterwards — a
  unique index satisfies Postgres and loses the race in the generated migration.
  What the SERVICE still enforces, because a CHECK may not contain a subquery, is
  the cross-table comparison: did the cited slice's precision clear the policy's
  bar, on enough samples. Both halves are pinned by realdb cases.
- **Every benchmark RATE is `GENERATED ALWAYS ... STORED`.** Precision, recall,
  automatic-match coverage and manual-review rate are functions of the confusion
  matrix beside them, so a precision nobody measured is not a value these tables
  can hold — an INSERT supplying one fails with SQLSTATE `428C9`. `NULLIF` on
  each denominator yields NULL rather than zero, because "nothing was predicted
  positive" and "precision is zero" are different facts and a launch gate must
  not confuse them. Division is IMMUTABLE, so it is legal in a stored generated
  column — unlike the `to_tsvector`/`unaccent` traps above. Two partition CHECKs
  refuse a slice whose outcome counts or confusion cells do not sum to its total:
  a run that lost cases would report a precision over a set nobody can reconstruct.
- **A policy version is immutable once active, and a benchmark run is
  append-only — both by TRIGGER.** `match_policy_versions_immutable` permits only
  the lifecycle transition; `mercaria_match_benchmark_append_only` permits
  exactly one UPDATE, stamping a run finished with nothing else moving. These are
  triggers rather than CHECKs because they constrain a row against its own
  HISTORY, which is what "immutable" means — the `retail_pricing_policies` and
  `fee_schedule_versions` precedent. A policy somebody edited after the fact would
  silently re-interpret every benchmark that cited it, and an editable
  measurement is not one a gate can rest on.
- **The seven feature columns are REAL columns, not a jsonb summary.** The
  `provider_accounts` requirements-count reasoning: a `double precision` column
  cannot hold a sentence, and "which candidates did brand disagreement rule out"
  needs an indexable predicate. **A NULL feature is UNKNOWN and never a zero** —
  the confidence arithmetic leaves an unknown out of the DENOMINATOR, so a
  missing brand lowers the score by widening the uncertainty rather than by
  asserting a disagreement nobody observed (#58 rule 5). Reading it as zero makes
  every unbranded P2P listing unmatchable; reading it as the mean of the others
  lets one strong feature and six unknowns score like seven.
- **`match_queue` is ONE ROW PER SUBJECT, which makes it a convergence queue.**
  The `offer_outboxes` port, inheriting both of its inversions of the moderation
  outbox: the enqueue is `ON CONFLICT DO UPDATE` (a `DO NOTHING` would drop the
  requests that arrived while one was pending), and there is no `expires_at` and
  therefore no `db/expiryTargets.ts` entry — one row per subject, CASCADEing with
  the native variant, so it cannot grow unboundedly, and a retention sweep would
  delete pending matching work on a clock. The `requested_revision`/
  `claimed_revision` pair closes the mid-run race, and the enqueue must NOT write
  a flat `'pending'` over a `processing` row — that releases a live lease from
  outside the worker. Pinned by a realdb case, as in the offer domain.
- **`match_blocked_pairs` records the policy it was judged under and is NOT
  scoped by it.** A block that expired on the next policy version would silently
  re-propose every rejected pair on a tuning change; the column is the audit
  trail, and clearing is a deliberate, attributable act
  (`match_blocked_pairs_cleared_state_check`). `target_key` is the third
  GENERATED `coalesce` key in the graph, for the third time for the same reason.
- **`match_sweep_cursors` is `reconciliation_cursors`, ported** — the same lease
  pair CHECK (`num_nonnulls(...) in (0, 2)`, so half a lease is unrepresentable),
  the same caller-supplied primary key with no default, and the same rule that a
  cursor is made durable BEFORE the lease is given up.
- **Zero new `jsonb`.** Feature values, reason codes, blockers, identifiers and
  the confusion matrix are all real columns or `text[]` with element CHECKs
  rendered from the shared-types tuples, so this layer adds no row to the
  register below.

### Merchant claiming (#83) has no source model either

Five more Postgres-born tables, in `merchantClaims.ts`: `merchant_claims`,
`merchant_claim_scopes`, `merchant_claim_challenges`,
`merchant_claim_evidence`, `merchant_claim_events`. They sit ON TOP of #54's
merchant layer and add nothing to it — `merchants.claim_state` stays ADR 0002
D9's one stored verdict, and this domain is the only thing that moves it. What
is #83's own, stated so a column whose shape looks arbitrary is answerable:

- **`(merchant_id) WHERE state = 'verified'` is the whole of acceptance 4.** A
  partial unique index, so two conflicting claimants cannot BOTH become the
  sole verified operator — refused by the database rather than by a
  read-then-write two racers would walk past. The service converts the refusal
  into a DISPUTE instead of replacing the incumbent (scope rule 6). Several
  verified OPERATORS per merchant still arrive, through the native store's own
  membership after linkage (#84) — a `store_members` fact, never a second
  verified claim. A second partial unique,
  `(merchant_id, claimant_oxy_user_id) WHERE state IN (…active…)`, keeps one
  live attempt per person; its predicate is rendered from
  `MERCHANT_CLAIM_ACTIVE_STATES` so it cannot drift from the tuple the service
  reads.
- **"Single-use challenge" is `(claim_id) WHERE closed_at IS NULL` plus a CAS on
  `closed_at`.** At most one challenge is ever open for a claim; issuing a new
  one closes the old one in the same transaction; consuming is a conditional
  UPDATE whose predicate optionally includes the expiry, so "an expired
  challenge verifies nothing" is a property of the statement rather than of a
  check somebody ran first.
- **There is NO `challenge_id` on the claim** (issue model field 5 asks for
  one). The partial unique above already defines "this claim's current
  challenge" exactly, and a pointer beside it would be a second representation —
  the `provider_accounts` no-`ready`-boolean rule. For the same reason the
  challenge carries neither the METHOD nor the SUBJECT: both belong to the
  claim, and a copy is how re-issuing a challenge would become a way to change
  what a claim is about. The per-domain issuance budget therefore JOINS
  challenges to their claim rather than reading a copy.
- **`assurance` is not a column.** How much a method's proof is worth is a
  property of the METHOD (`services/merchant-claims/claim-methods.ts`), derived
  at read time. A `low` method can never reach `verified` without a reviewer,
  which is where "a matching email domain alone cannot complete a claim"
  (acceptance 2) is enforced.
- **Two CHECKs encode facts a reviewer would otherwise have to remember:**
  `merchant_claims_document_subject_check` says exactly one method is
  subjectless (`(method = 'business_document') = (subject_kind IS NULL)`), so a
  future subjectless method needs a migration — the visible decision; and
  `merchant_claims_rejected_state_check` makes an anonymous rejection
  unrepresentable, because an automatic refusal is an EXPIRY and the two must
  not be confusable in the record.
- **`merchant_claim_scopes.scope_ref` carries no foreign key**, deliberately:
  one polymorphic column cannot reference three tables, and the alternative
  (three nullable columns plus a CHECK) buys a constraint on rows whose targets
  are never hard-deleted anyway. `requested`/`verified`/`out_of_scope` are three
  states of ONE row, so a storefront a proof missed is visible rather than
  silently absent.
- **Both audit tables are append-only by shape** — `merchant_claim_events` and
  `merchant_claim_evidence` carry their own timestamp and no `updated_at`, the
  `order_status_history` contract. `evidence_accessed` is in the action tuple
  because #83 requires every reviewer ACCESS to be audited, not only every
  decision.
- **Expiry is enforced where it is OBSERVED**, not by a sweep: a past
  `expires_at` is turned into `expired` by a CAS on the read path (the
  `guest_sessions` idle-expiry rule), and the transition clears the deadline so
  a second read cannot write a second audit row. Nothing here is registered in
  `expiryTargets.ts` — a claim record is evidence about a decision and is never
  deleted.
- **Zero new `jsonb`.** Every shape in this domain is Mercaria's own and closed.

### Merchant → native store linkage (#84) has no source model either

Four more Postgres-born tables, in `storeLinkage.ts`: `store_linkage_requests`,
`store_linkage_candidates`, `store_linkage_profile_adoptions`,
`store_linkage_offer_overlaps`. They sit ON TOP of #54's `native_store_links`
and #83's claims, and they add **no second mapping**: which merchant a store
resolves to stays exactly one question with exactly one answer, in
`native_store_links` (ADR 0002 D4). These four are the WORKFLOW that produces
one of those rows, reverses one, or corrects one. What is #84's own:

- **`store_linkage_requests_open_key` is the whole of acceptance 4** — replaying
  store creation or linkage creates no duplicate store, merchant mapping or
  follow target. A partial unique on the GENERATED `request_key` over the LIVE
  states (`draft`, `awaiting_review`, `applying`, `applied`), whose predicate is
  rendered from `STORE_LINKAGE_LIVE_STATES` so it cannot drift from the tuple
  the service reads — the `merchant_claims_merchant_claimant_active_key` device.
  A replayed `create_store` converges on the row that already exists, and
  therefore on the store it already made.
- **The generated key is `commerce_relationships.endpoint_key`, applied to a
  different problem.** `requested_store_id` is legitimately NULL on every
  `create_store` request, and Postgres treats NULLs as DISTINCT — so a plain
  multi-column unique over `(claim_id, mode, requested_store_id)` admits exactly
  the duplicate it exists to refuse. `coalesce(…) || '|' || …` collapses them
  into one text value and the partial unique is taken on that.
- **The key spans FOUR columns, and `supersedes_link_id` is the non-obvious
  one.** Without it, a store could be corrected only ONCE per claim: an
  `applied` request still holds its key, so a second correction would silently
  converge on the first. Keyed on the LINK a request ends, each correction is
  its own request while a replay of one still converges. `supersedes_link_id`
  is CHECK-required exactly on `correct_link` and `unlink` — a biconditional, so
  a correction with nothing to correct is as unrepresentable as a creation
  claiming to supersede something.
- **`mercaria_store_linkage_request_guard` exists because a generated unique key
  whose inputs can be edited is not a unique key.** No CHECK can express it: a
  CHECK evaluates one row and cannot compare it to its own previous version. The
  trigger freezes the four key columns and makes `resolved_store_id` write-once
  (the `retail_cost_quote_acceptances.order_id` contract, enforced by a CAS in
  the repository AND a trigger behind it, for the caller who never comes through
  the repository).
- **"Exactly one follow target" has no index, and needs none.** A
  `mercaria.store` target's identity is `https://mercaria.co/stores/<storeId>`
  (frontend `lib/follow-graph.ts`), keyed on the store's IMMUTABLE id, and
  `ensureFollowTarget` is idempotent on that URI — so one target is the SAME
  fact as one store whose id never moves, which the open key plus the write-once
  `resolved_store_id` already guarantee. The backend creates no target and
  constructs no URI; `store-linkage-isolation.test.ts` fails the build if that
  changes.
- **The impact preview is SIX integer columns, never a jsonb summary.** The
  `provider_accounts` requirements decision, and a security property rather than
  tidiness: an integer column cannot hold a customer name, a listing title or an
  order number, so an impact preview can never become a way to read a store's
  book through the operator surface.
- **"No name-only automatic linkage" is structural in four independent places**,
  and the schema is the second: no name, similarity, score, confidence,
  threshold or distance column exists in any of the four tables, so a matcher
  acting on a resemblance has nowhere to record its answer. (The other three:
  `STORE_LINKAGE_CANDIDATE_SOURCES` has no `name_match` member — the
  `NATIVE_STORE_LINK_METHODS` device; every request schema is `.strict()` and
  carries ids only; `linkage-candidates.ts` takes no name as a parameter.) Note
  `store_linkage_profile_adoptions.field` legitimately carries the VALUE
  `'name'` — the store's display name is one of the two adoptable fields — and a
  value is not a column, which is why the gate checks column names and values
  with two different patterns rather than one loosened one.
- **`store_linkage_profile_adoptions` is append-only by TRIGGER** (the
  `ledger_entries` / `order_fee_snapshots` / `relationship_reviews` precedent)
  and carries its own `at` with no `updated_at`. `previous_value` is provenance,
  and provenance that can be rewritten is not provenance. The two closed sets
  beside it — two adoptable FIELDS (`name`, `description`) and one adoptable
  SOURCE (`canonical_merchant`) — are what make "do not copy unverified external
  profile fields into merchant-managed fields silently" unrepresentable rather
  than merely refused; the handle is not a member, which is how `/m/<handle>`
  stays stable.
- **`store_linkage_offer_overlaps` is a FINDING and never a removal.** Both
  offer references are RESTRICT and nothing in the domain issues an offer DELETE:
  an external offer survives a merchant going native, with its `source_records`
  chain intact. The row records which representation a DETERMINISTIC rule
  preferred and which rule fired — the `payment_discrepancies` shape, with no
  destructive effect of its own.
- **The request row IS the job.** Lease columns and an ordered `step` cursor on
  the record itself, the payment/moderation outbox contract, so an application
  that dies half way is resumable rather than ambiguous. There is deliberately
  no background dispatcher: every mode is driven by a person, and a loop
  retrying identity changes on a clock is not something anybody asked for.
- **Zero new `jsonb`.** Every shape in this domain is Mercaria's own and closed.
### Review scopes (#76) — `reviews` moved, and gained four siblings

`reviews` was born in `buyers.ts` (from the `Review` Mongoose model, above) and
lives in `schema/reviews.ts` since #76, beside four Postgres-born tables:
`review_dimensions`, `review_eligibilities`, `review_aggregates` +
`review_dimension_aggregates`, and `review_target_migrations`.

**The table moved; the ID did not.** CrowdSource holds review ids as
`subject.externalId` and a `moderation_enforcements` row is keyed on the
decision plus that id, so a NEW table would have orphaned every open case — the
"ids have LEFT this system" rule at the top of this document, applied to a
domain rewrite rather than to a backfill. Widening the existing row is the only
shape that keeps moderation working through the change. The file move itself is
forced by the barrel's dependency order: a scoped review references
`canonical_products` and `merchants`, both exported after `buyers`.

The decisions that make a column whose shape looks arbitrary answerable:

- **`scope` and `target_type` are two columns and NOT two representations of
  one fact.** `target_type` says which COLUMN holds the thing being rated;
  `scope` says which QUESTION the rating answers. They genuinely differ, and the
  difference is the whole issue: `target_type = 'listing'` cannot say whether a
  review is about the product or about the condition of one used copy.
  `reviews_scope_target_type_check` ties them, rendered from the same
  `REVIEW_SCOPE_TARGET_TYPE` map every consumer reads, so they cannot disagree.
  A NULL `scope` means exactly one thing: the classification job has not decided
  (or has decided it cannot), and `reviews_classification_consistency_check`
  ties that to `classification_state` both ways.
- **`target_key` is GENERATED, and a plain multi-column unique would NOT work**
  — the `commerce_relationships.endpoint_key` device, for the same reason:
  Postgres treats NULLs as DISTINCT, so a unique over six nullable target
  columns admits exactly the duplicate it exists to refuse. The partial unique
  `(author_oxy_user_id, scope, target_key) WHERE scope IS NOT NULL` is what
  "one review per author per scoped target" means. The pre-#76
  `reviews_author_oxy_user_id_listing_id_key` is kept verbatim: classifying a
  listing review to `p2p_listing` does not move `listing_id`, so both indexes
  cover the row and agree.
- **There is deliberately NO `consumed_by_review_id` on `review_eligibilities`.**
  `reviews.eligibility_id` already names the pair and its partial unique already
  makes it at most one; a pointer back would be a second representation of one
  fact (the `provider_accounts` no-`ready`-boolean rule). The eligibility keeps
  its own `state` + `consumed_at`, which are facts about the GRANT rather than
  about the review.
- **There is deliberately NO `published_at` column.** #76's model asks for a
  publication timestamp, and in Mercaria that is `created_at`: a review has no
  draft state, so it becomes visible the moment it is written. A second column
  holding the same instant is what this document refuses everywhere else, so the
  DTO derives it. `edited_at` DOES earn a column — it is not derivable from
  anything, and `updated_at` moves on a moderation status change too, so an
  edited review and a hidden one would otherwise be indistinguishable.
- **The eligibility carries TWO order-line references and they are different
  roles.** `order_item_id` is the EVIDENCE (set on every row, whatever the
  scope); `target_order_item_id` is the TARGET of a `native_transaction`
  eligibility. They coincide for that one scope; collapsing them would make a
  product eligibility read as a transaction one.
- **`UNIQUE(order_item_id, oxy_user_id, scope)` is #76 verification rule 11 as
  DDL** — at most one eligibility per (line, author, scope), whatever a claim
  retry or a migration replay performs. Not partial: all three columns are NOT
  NULL, so a plain unique is exact.
- **`review_eligibilities.claim_id` has no foreign key and is not a deferral.**
  `guest_order_claims` (#109) does not exist, so the deferred-FK gate has no
  table name to fire on; the biconditional
  `review_eligibilities_claim_check` is what makes the seam structural — a
  `claimed_guest_purchase` row without a claim id is unrepresentable, and the
  only function that could write one refuses to run.
- **`review_aggregates` is the authority; the entity `rating`/`rating_count`
  columns are PROJECTIONS.** `canonical_products.rating` (#56 product rule 11),
  `merchants.rating` (#54), `listings.rating` and `seller_profiles.rating` are
  written by `review-aggregate.service` alone, in the same call, from the same
  derived figures. A projection with ONE writer cannot disagree with its source;
  a second WRITER could — which is why the legacy `recomputeAggregate` path and
  the scoped rebuild are careful to cover disjoint review sets
  (`findPublishedReviewTargets` excludes every scoped row).
  What forced a table rather than more columns: the verified/unverified split,
  the per-dimension averages, the target TYPE stated explicitly, the rebuild
  bookkeeping — and `native_transaction`, whose target is an order line and has
  no rating column at all.
- **No `total_count` column, deliberately.** `rating`/`review_count` cover
  VERIFIED published reviews; `unverified_rating`/`unverified_count` sit beside
  them and are never summed in. A combined total is exactly what "labelled and
  weighted separately" forbids, and a serializer that cannot find one cannot
  ship one.
- **No `brand_id`, `organization_id` or `product_family_id` anywhere in the five
  tables.** The brand rating #76 forbids has no row shape — an absence, not a
  rule. `REVIEW_FORBIDDEN_SCOPES` names the prohibition as a value, disjoint
  from `REVIEW_SCOPES`, and `review-scope-isolation.test.ts` scans every column
  of all five tables plus every module of the domain.
- **No email, phone, contact, token, card, wallet or payment column either**,
  scanned by the same gate against the real drizzle column sets — because a
  column is what a serializer can ship, and a comment mentioning "email" is not.
- **`review_target_migrations` is APPEND-ONLY by trigger**
  (`mercaria_review_target_migration_append_only`, the `order_fee_snapshots`
  posture). `reviews.scope` answers where a review points NOW and cannot answer
  where it pointed before, because a rehome overwrites it — the
  `canonical_product_redirects` limitation, answered the same way. Its
  `from_target_ref`/`to_target_ref` carry no foreign key: they span six target
  key spaces and must survive a canonical tombstone
  (the `catalog_revisions.entity_id` reasoning). The unique
  `(review_id, action, coalesce(to_target_ref, ''))` converges a replay, and the
  `coalesce` is what makes that true for a REFUSAL, which names no destination.
- **Zero new `jsonb`.** Every shape in this domain is Mercaria's own and closed.
- **A behaviour change the test suite had to absorb**, listed here beside the
  others at the bottom of this document: `review_eligibilities.order_id` /
  `.order_item_id` and every canonical target reference are RESTRICT, because
  the eligibility IS the purchase evidence a verified review points at and a
  product's rating must be able to BLOCK its disappearance. Nothing in
  production deletes an order or a canonical product; a TEST that does now has
  to clear the evidence first (`draft-order-complete.realdb.test.ts`,
  `canonical-catalog.realdb.test.ts`).

### Catalogue curation has no source model either (#59, ADR 0002 D12/D16)

Eight more Postgres-born tables, in `curation.ts`: `catalog_merge_jobs`,
`catalog_merge_conflicts`, `catalog_merge_job_phases`, `catalog_split_jobs`,
`catalog_split_assignments`, `catalog_review_items`,
`catalog_entity_suppressions`, `catalog_revisions`. The operator's half of the
canonical graph. It inherits the closed-set-from-a-shared-types-tuple rule, the
lease shape and the natural-unique idempotency the sections above state. What is
#59's own — and each is here because a merge is the ONE operation in this graph
that ends an identity, and its damage is invisible until a seller finds it:

- **The rehoming plan is checked against the SCHEMA, not read out of the code.**
  `services/curation/merge-plan.ts` declares every column referencing each of
  the seven mergeable entities and what a merge does with it;
  `merge-plan-census.test.ts` walks the drizzle table objects for every foreign
  key targeting one and asserts the plan covers EXACTLY that set. A new table
  referencing `canonical_products` fails the build until somebody decides what a
  merge does with it. This is the gate that makes "everything is rehomed" a
  checkable claim rather than a promise: finding fewer referencing tables looks
  identical to there BEING fewer, and the miss is silent. `untouched` WITH A
  REASON is a decision the census accepts; silence is not.
- **`catalog_revisions` is append-only against UPDATE *and* DELETE**, which
  inverts `analytics_events` deliberately: analytics permits DELETE because
  erasure on schedule is its policy, while a revision that could be deleted
  would let the record of a merge disappear along with the reason somebody
  performed it. `before`/`after` are ADR 0002 D16's named `jsonb` exception —
  a revision must capture whatever the entity looked like INCLUDING columns a
  later schema removed. `compensates_revision_id` runs BACKWARDS in time (the
  `product_identifiers.supersedes_identifier_id` direction), so the pointer
  always resolves, and `(action = 'compensate') = (compensates_revision_id is
  not null)` is a biconditional CHECK.
- **The job and its PHASE RECORDS are two tables because neither is derivable
  from the other.** The job carries the lease and the phase it is ON;
  `catalog_merge_job_phases` carries what is DONE. `UNIQUE(job_id, phase)` plus
  an append-only trigger is what makes a resume trustworthy — a phase already
  stamped is skipped, one claimed but never stamped is re-run.
- **Four eyes is TWO CHECKs and neither is sufficient alone.**
  `approved_by <> requested_by` refuses one person with two sessions;
  `phase in ('plan','awaiting_resolution') or approved_by is not null` refuses
  an unapproved large job ADVANCING. `requires_second_approval` and the impact
  are SNAPSHOTTED at planning time: a threshold change must not retroactively
  unapprove a job somebody already ran. The impact TOTAL is CHECKed to equal the
  sum of its components, so a small number cannot be written beside ten large
  ones to dodge the threshold.
- **A merge conflict names its colliding pair through EIGHT nullable foreign
  keys plus a per-kind CHECK**, not two opaque refs: the six kinds span exactly
  five tables and every conflict names two rows in the SAME one, so real
  references are available and RESTRICT lets a conflict row BLOCK a delete. The
  generated `conflict_key` collapses them for the convergence unique — the
  `endpoint_key` device, for the fifth time in this graph.
- **A `BEFORE UPDATE` trigger must not compare a STORED GENERATED column.**
  `mercaria_catalog_merge_conflict_immutable` originally compared
  `NEW.conflict_key` with `OLD.conflict_key` and raised on EVERY update,
  including the ordinary one recording an operator's resolution: a generated
  column is computed AFTER every BEFORE trigger, so `NEW.conflict_key` is NULL
  there while `OLD` holds a value. It compares the eight endpoint columns
  instead. Caught by the realdb suite; a mocked repository accepts it happily.
- **`catalog_split_assignments` is frozen once its job leaves `plan`**, by the
  domain's ONE cross-table trigger. The set an operator approved with an impact
  estimate beside it is the set that executes (#59 split invariant 1), and a
  service rule would be walked past by a `psql` INSERT. `item_ref` carries no
  foreign key — the target table is a TWO-key dispatch,
  `(job.entity_type, item_type)`, over twelve tables — and the cost is stated:
  a missing row is recorded with `skipped_reason` and `verify` reconciles
  assigned against applied.
- **A pair-shaped review item cannot be stored with one side**, and the two
  DUPLICATE kinds store their pair in id order (`subject_id < counterpart_id`),
  so (A,B) and (B,A) are one item. `identifier_conflict` is excluded from the
  ordering rule because there the direction MEANS something — the subject is the
  disputed newcomer and the counterpart is the incumbent active owner.
- **Six curation id columns carry no foreign key, permanently**, all under ADR
  0002 D16's own reason for `catalog_revisions.entity_id`: each names a row in
  one of seven to thirteen tables chosen by a sibling `*_type` column, and each
  must stay readable after the very merge it records tombstones its subject.
- **One new `jsonb` PAIR** (`catalog_revisions.before`/`after`, above) and
  nothing else: impact counts, reason codes, conflict kinds and phase progress
  are all real columns, because an operator filters and compares on them.
- **#72 WIDENED two of this table's closed sets and added no column**
  (migration `0055`, `pre`): `detector` gains `public_correction` and
  `reason_codes` gains `public_correction_submitted`, so a reader disputing a
  published fact from a brand or family page lands in the SAME queue a detector
  raises rather than in a second one. `public_correction` is its own member
  rather than `operator` because the two lead a reviewer to opposite conclusions
  — an `operator` item is somebody inside Mercaria referring work they already
  looked at. **No `reported_by` column was added, deliberately**: a submitter
  recorded beside their dispute is a submitter who can accrue standing, and #72
  identity rule 1 is that nobody accrues any. The consequence is stated in
  `docs/catalog-pages.md` rather than hidden — `dedupe_key` is grained per
  SUBJECT and the conflict branch REPLACES `reason_codes`, so two readers
  disputing two fields of one brand converge on one item and only the first
  field reaches `note`. Per-field reason codes would be worse than none: they
  would drop whichever field arrived first while looking precise.

### The brand and product-family PAGES add no table at all (#72)

`services/catalog-pages/` reads eleven tables across five domains and owns none
of them, which is why it has no section of its own here. The decision worth
recording is the one it did NOT make: no projection, no materialized view and no
denormalized read model, because #61 measured that alternative at one million
offers, adopted none, and had already indexed this exact read
(`canonical_products_brand_page_idx` on `(brand_id, name, id) WHERE status <>
'merged'`). Its keyset readers keep that index's exact shape — `(name, id)`
ascending, tombstones excluded — rather than inventing an ordering it cannot
serve. Full reasoning: `docs/catalog-pages.md`.

### The guest domain has NO source model either

`guest_sessions` (`schema/guests.ts`, `drizzle/0013_guest_sessions.sql`) and
`cart_merges` (same file, `drizzle/0017_guest_cart_ownership.sql`) were born in
Postgres for ADR 0003 (#103, #104) — there was never a Mongoose model behind
either and the backfill had nothing to copy into them. Their decisions, so a
column whose shape looks arbitrary is answerable here:

- **`token_hash` stores the hex SHA-256 of the bearer token, never the
  plaintext, and there is deliberately NO pepper/HMAC key.** The preimage is 32
  CSPRNG bytes (`mgs_` + base64url), so a leaked hash is neither invertible nor
  dictionary-attackable — and a pepper would make every stored hash
  unverifiable the day it rotated. This is the OPPOSITE decision from the
  guest-checkout email hash (ADR 0003 D12), which is keyed precisely because an
  email has dictionary-scale entropy. Do not "harmonize" the two.
- **Status (`active | converted | expired | revoked`) is DERIVED from the
  timestamp set, never a column** — the `provider_accounts` no-`ready`-boolean
  rule. `guestSessionStatus` in `services/guest-session.service.ts` is the one
  derivation.
- **Only the ABSOLUTE expiry is a column.** Idle expiry (30 days from
  `last_seen_at`) is enforced by the resolver, so the two cannot disagree.
- **Purge is TWO expiry-sweep targets over one table** (`db/expiryTargets.ts`):
  7 days past `expires_at` and 7 days past `revoked_at` — the registry cannot
  express OR, and each column carries its own leading btree index for the gate.
  Hard DELETE: audit continuity lives in OTHER tables' correlation text
  (`order_status_history.actor_guest_session_id`, D16), never in kept sessions.
- **`converted_at` + `converted_to_oxy_user_id` were a SEAM for #104/#109** and
  #104 filled the first half in: `services/cart-merge.service.ts` is now the
  only writer of the pair, through `convertGuestSession`, which sets both plus
  `revoked_at` in ONE statement — the CHECKs (pair travels together, converted ⇒
  revoked) are unsatisfiable any other way. The Oxy id carries no FK (Oxy owns
  identity) and is in the `ID_COLUMNS_WITHOUT_FOREIGN_KEY` ledger.
- **No email, address, payment method, device fingerprint, or locale/currency
  preference columns** — contact belongs to `guest_checkouts` (#105+), and a
  guest's presentment currency rides the request (ADR 0003 D8).

`cart_merges` (#104) records one guest→Oxy cart merge, and its four decisions:

- **`UNIQUE(guest_session_id)` IS the idempotency mechanism.** #104 asks for "a
  durable merge operation id OR unique source-session constraint"; this is the
  second and the stronger, because it needs no client cooperation. A merge is a
  fact about a SESSION — one guest session merges exactly once, ever — so the
  constraint states the invariant instead of trusting a header a retrying
  native client might regenerate.
- **Counts and bounded reason codes only.** Six integer counters and a
  `text[]` CHECKed against `CART_MERGE_REASON_CODES`; no listing id, variant
  id, title, price or discount code. An operator reading the table cannot learn
  what anyone is buying, because there is no column for it.
- **APPEND-ONLY by trigger** (`mercaria_cart_merge_append_only`, the
  `mercaria_ledger_append_only` posture). Counters are written ONCE, inside the
  merge transaction, computed from what that transaction actually did — so a
  crashed merge leaves no half-counted row to correct, and any aggregate is a
  QUERY over these rows. That is what makes the counters repairable: recompute
  from the events, never patch a stored total. A test that needs to clean up
  cannot: the trigger refuses DELETE and TRUNCATE is table-level, so
  `cart-merge.realdb.test.ts` scopes by a per-run id set instead — the
  `ledger.realdb.test.ts` rule.
- **Three id columns, no foreign keys, three reasons.** `oxy_user_id` is a
  foreign service's key. `guest_session_id` is correlation: the session is
  hard-deleted by the retention sweep 7 days after the very revocation the
  merge performs, and the audit must outlive it. `target_cart_id` likewise —
  this row records an EVENT, and a cascade from `carts` would let a cart's
  disappearance erase the history of what was merged into it. All three are in
  `ID_COLUMNS_WITHOUT_FOREIGN_KEY` under `AUDIT_CORRELATION` / `OXY_ACCOUNT`.

`carts` gained its guest owner in the same change (ADR 0003 D8) — `oxy_user_id`
became nullable, `guest_session_id` arrived as a real FK with `ON DELETE
CASCADE`, `carts_owner_exclusivity_check` enforces exactly one, and both
uniques became partial. The reasoning is in the table's own docblock; two
things are worth repeating here because they are easy to get wrong from the
outside:

- **`ON CONFLICT` must repeat a partial index's predicate** or Postgres refuses
  to infer it (`there is no unique or exclusion constraint matching the ON
  CONFLICT specification`) — which turns `ensureCart`'s ordinary double-tap
  handling back into a 500. `ownerConflictTarget` carries the `where`.
- **The CHECK was added VALIDATED, not `NOT VALID`.** The ADR stages the
  `orders` identity CHECK as `NOT VALID` because legacy `ext:` rows genuinely
  violate its final shape; `carts` has no such rows, so validation is immediate
  and the "backfill existing carts to authenticated ownership" requirement is
  met by rewriting ZERO rows.

### `guest_checkouts` and the buyer origin on `orders` (#105)

`guest_checkouts` (`schema/guests.ts`, `drizzle/0023_ambitious_proemial_gods.sql`) is
the third Postgres-born guest table, and the two `orders` columns beside it are
the minimum of ADR 0003 D6 that a guest order needs in order to exist at all.
The decisions:

- **ONE contact identity per checkout GROUP, held by
  `guest_checkouts_checkout_group_id_key`** — never one per order. Sibling
  orders from a multi-seller cart share it; each ORDER keeps its own immutable
  FULFILMENT snapshot (`shipping_address_*`, `shipping_method`), because
  destinations can legitimately differ per seller and a contact cannot. Two
  copies of one fact can disagree, and the place that must not happen is the
  address a receipt is sent to.
- **Three forms of one email, three columns, three jobs (ADR 0003 D12).**
  `email_ciphertext` is AES-256-GCM under `GUEST_PII_ENCRYPTION_KEY`, key-id
  prefixed (`v1:…`) so a rotation is re-encryption at read rather than a flag
  day; `email_hash` is HMAC-SHA-256 under the SEPARATE `GUEST_EMAIL_HASH_KEY`;
  `email_redacted` is the only form a support surface renders. **Two keys, on
  purpose:** the lookup path must be able to hash without ever being able to
  decrypt. The keyed hash here is the OPPOSITE decision from
  `guest_sessions.token_hash` above, for the opposite entropy reason — do not
  "harmonize" them.
- **The ciphertext is a single self-describing column, not the three-column
  `{ciphertext, iv, tag}` shape `connections` uses.** That shape is right where
  the parts are read independently; here the whole value is written once and
  read once, and one column is what makes D15's anonymization a single
  `SET … = NULL` and lets the immutability trigger say "the contact may only
  change to NULL" as a condition on one value rather than a consistency rule
  across three.
- **`guest_checkouts_anonymization_check` states the erasure transition WHOLE.**
  Without it, `anonymized_at` would be a timestamp somebody could set while the
  ciphertext stayed readable — a deletion record that did not delete. The email
  and phone pair CHECKs are `in (0, 2)` rather than `= 2` for the same reason:
  both halves exist together or neither does, and anonymization clears both.
- **`marketing_opt_in` is a column of its own, defaulting to false.** Permission
  to send a receipt comes from the purchase; permission to market comes from a
  box the buyer ticked. One field for both would make every transactional send
  look like consent to market, and the audit question "did they agree" would
  have no answer.
- **`contact_verification_stage` records whether the inbox was proven BEFORE or
  AFTER the payment** and is deliberately not an enforcement point: ADR 0003
  D17 puts payment on the pre-verification side of the line, because an email
  typo is answered by the confirmation not arriving, not by refusing a card the
  buyer already authorised. #108 owns the transition.
- **`guest_session_id` carries no foreign key and `checkout_group_id` cannot.**
  The session is HARD-DELETED by the retention sweep while this row is retained
  with its orders, so a cascade would erase a commercial record and a restrict
  would block the purge — surviving the credential is the whole reason the table
  exists. The group is a shared token with no `checkout_groups` table. Both are
  in `ID_COLUMNS_WITHOUT_FOREIGN_KEY`.
- **`orders.buyer_guest_checkout_id` IS a real foreign key**, `ON DELETE
  restrict` — and the contrast with every other id column on `orders` is the
  rule, not an inconsistency: `guest_checkouts` is a Mercaria table, so Mercaria
  can enforce the reference; an Oxy id cannot have one because Oxy owns
  identity.
- **`orders.buyer_oxy_user_id` became NULLABLE and `orders_buyer_identity_check`
  is what makes that safe.** Three disjoint shapes, one constraint, because the
  illegal combinations are the dangerous ones: a guest order carrying an Oxy id
  is invariant I1 broken at the storage layer. `'external'` leaves the column
  unconstrained so connector rows keep their `ext:` provenance until ADR 0003 M9
  retires it. **#106 WIDENS this constraint** when it adds
  `claimed_by_oxy_user_id`/`claimed_at`; it must not add a second one.
- **Two hand-written triggers ship in the same migration as the DDL** —
  `guest_checkouts_immutable` and `orders_buyer_origin_immutable` (the
  `mercaria_fee_schedule_immutable` posture). A CHECK sees one row and cannot
  express "this may not change"; a window in which the table exists and the
  trigger does not is a window in which a placed group's contact can be
  re-pointed at another inbox. Every comparison is `IS DISTINCT FROM`, never
  `<>`: with a NULL on either side `<>` is NULL, which is not TRUE, which would
  let exactly the transitions being guarded slip past.
- **The identity CHECK was added VALIDATED.** ADR 0003 stages it `NOT VALID`,
  expecting `ext:` rows to violate the final shape — they do not violate the
  form landed here: every pre-existing row is `buyer_origin = 'oxy'` (the fast
  default) with a non-null buyer and a null guest checkout, which satisfies the
  first disjunct. M4's backfill then MOVES connector rows to `'external'`, keyed
  on `source_connection_id IS NOT NULL` and not on the `ext:` prefix, which is a
  string convention nothing enforces.
- **`email_ciphertext`, `email_hash` and `phone_ciphertext` are in
  `PROTECTED_COLUMNS`; the two redacted columns are not.** The hash is
  registered even though it is irreversible, because it is an exact-match
  ORACLE: anyone holding it can confirm whether a guessed address placed an
  order, which is the correlation ADR 0003 I11 forbids seller and partner
  surfaces. The redacted forms exist precisely to be read.
- **Nothing here is registered in `expiryTargets.ts`.** A checkout contact lives
  as long as its orders (ADR 0003 D11); erasure is D15's anonymization, which is
  a verified request rather than a sweep.

#### The claim pair and the audit actor (#106)

`0030` finished what #105 started, and every decision below is about a WIDENING
rather than a new table — there is no #106 table, which is itself the point.

- **`claimed_by_oxy_user_id` / `claimed_at` are a SECOND owner, and the widened
  `orders_buyer_identity_check` states all three facts at once**: only a
  `'guest'` order may carry them, the pair travels together
  (`num_nonnulls(…) in (0, 2)`, the `guest_sessions.converted_*` mechanism), and
  `buyer_oxy_user_id` stays NULL in that disjunct whether or not a claim
  exists — so a claim can never be written into the ORIGIN column (I1 + I7 at
  the storage layer). It is a WIDENING of the one constraint, not a second one:
  there stays exactly one place that says what a buyer identity is.
- **The identity CHECK was added VALIDATED again.** ADR 0003 M1 stages it
  `NOT VALID`; it is unnecessary for the same reason #105 recorded — the
  widening only constrains the two NEW columns, which the serving image leaves
  NULL, so no existing row violates it.
- **`mercaria_order_buyer_origin_immutable` was `CREATE OR REPLACE`d, not
  joined by a second trigger.** `0023`'s own comment says #106 extends it: ONE
  place says what a buyer identity may become, and replacing keeps the existing
  trigger bound so there is no unguarded window. The three original rules are
  repeated VERBATIM in the new body, because a replacement is a whole body and a
  rule dropped there is a rule silently retired —
  `order-buyer-claim.realdb.test.ts` re-asserts all three for exactly that
  reason. The added rule is the claim pair's: NULL→value and value→NULL
  permitted, **value→value REFUSED** (D14: a mis-claim is corrected by unclaim +
  re-claim, two audited steps).
- **`orders_claimed_by_created_at_idx` is PARTIAL**, and it is the second half of
  ADR 0003 D7's buyer predicate (`buyer_oxy_user_id = $1 OR
  claimed_by_oxy_user_id = $1`, two indexed scans). A full index would be almost
  entirely NULLs; until any claim exists the plan degenerates to exactly the
  pre-#106 one.
- **`order_status_history` gained `actor_kind` + `actor_guest_session_id`, and
  `order_status_history_actor_check` ties the id columns to the KIND.** Before
  this, "a guest cancelled" and "the sweep cancelled" were the same row: both
  NULL. The CHECK is what makes I1 reach an audit row — a service bug that put a
  session id in `by_oxy_user_id` is refused by the database. `actor_kind`
  defaults to `'system'` for the fast-default reason `buyer_origin` does, and
  the backfill then corrects the rows that named an Oxy actor; every writer
  states it explicitly.
- **`actor_guest_session_id` is in `PROTECTED_COLUMNS` and `actor_kind` is
  NOT.** The trail is attached to every order and serialized whole, so this is
  the `customers.email` situation exactly — the most likely accidental
  disclosure is the one nobody writes code to cause, and a session row id shared
  across a guest's orders is the correlation key I11 forbids seller surfaces.
  The kind says a guest acted without saying which, and the trail is useless
  without it. The column carries no foreign key for
  `guest_checkouts.guest_session_id`'s reason (`AUDIT_CORRELATION`): the session
  is hard-deleted while the trail is retained.
- **`guest_checkouts.contact_verified_at` is a BICONDITIONAL CHECK against the
  stage** — present exactly when the stage is not `pending`. Both halves are
  real failures: a verified stage with no instant cannot answer "when", and an
  instant on a `pending` row claims a proof that never occurred.
  `contact_policy_version` is NOT NULL with a default so the migration fills
  existing rows without a rewrite; it exists because normalization, redaction
  and retention are POLICY (D12/D15) and a stored contact must say which version
  produced its forms — the versioned-attribute-definition reasoning applied to a
  person's details.
- **No `status`, `paid_at`, `claimed_at` or `closed_at` column on
  `guest_checkouts`, and that is a decision, not an omission.** #106's
  GuestCheckout model asks for a lifecycle and a claim state; both are DERIVED
  from the group's ORDERS (`deriveGuestCheckoutLifecycle`,
  `deriveGuestCheckoutClaim`), because ADR 0003 D6 puts the claim columns on
  `orders` and two representations of one fact can disagree — the place that
  must not happen is a portal telling a buyer their order is unpaid while the
  ledger says otherwise. `partial` is a real derived value so a split claim is
  VISIBLE, and it is what the operator consistency probe counts.
- **The two `0030` backfills are hand-written and their POSITION is
  load-bearing**: `order_status_history_actor_check` refuses `'system'` on a row
  carrying `by_oxy_user_id`, which is every historical row with a real actor, so
  the backfill must precede the CHECK. The connector backfill keys on
  `source_connection_id IS NOT NULL`, never on the `ext:` prefix — a string
  convention nothing enforces, which would both over- and under-match.
  drizzle-kit cannot model an UPDATE or a trigger body, so a regeneration drops
  both; see `AGENTS.md` §"Rebasing a migration behind another branch's".

### The guest order portal (#108) has no source model either

Five more tables born in Postgres, in `schema/guestPortal.ts`:
`guest_order_access_grants`, `guest_portal_messages`,
`guest_contact_suppressions`, `guest_recovery_attempts` and
`guest_portal_operator_actions`. They sit ON TOP of `guest_checkouts` (#105) and
add nothing to it — the contact stays one row per checkout group, and this
domain reads it without ever copying an address out. Full behavioural reference:
`docs/guest-portal.md`.

- **ONE table for both credentials** (ADR 0003 D5): the 15-minute single-use
  `mgx_` exchange token and the 30-day `mgp_` portal credential are the same
  five facts — a hashed secret, a checkout group, an expiry, a revocation and an
  inbox proof — differing only in lifetime and carriage. A second table would be
  a second place to get a liveness rule wrong, and liveness is the whole of the
  authorization.
- **`checkout_group_id` is THE SCOPE and carries no foreign key** (there is no
  `checkout_groups` table — `db/deferredForeignKeys.ts`). The referential
  guarantee the domain actually needs is `guest_checkout_id`, which IS a real
  FK, `ON DELETE RESTRICT`: both tables are Mercaria's, and the constraint makes
  "a grant always has a contact to send to" structural. `RESTRICT` rather than
  `CASCADE` because `guest_checkouts` is retained as long as its orders and is
  never deleted — erasure NULLs its contact columns (D15) and leaves the row, so
  a cascade would fire only in a state that must never occur, and firing would
  destroy the access audit.
- **`email_verified_at` is ONE column and the boolean is DERIVED.** ADR 0003 D5
  names `email_verified boolean NOT NULL`; storing the instant instead is the
  correction #106 already made to `guest_checkouts.contact_verified_at`, for the
  reason `guest_sessions` has no status column — and the instant is what a
  step-up freshness check needs anyway, so the boolean would have had to sit
  beside it rather than replace it.
- **Two CHECKs carry the verification model.**
  `guest_order_access_grants_verification_origin_check` refuses a verification
  instant on a `post_checkout` row, so paying — by card, by wallet, through
  Stripe Link — cannot mark a contact proven in any code path (#108
  email-verification rules 2 and 3).
  `guest_order_access_grants_unverified_scope_check` holds an unproven PORTAL
  credential to `UNVERIFIED_GRANTABLE_SCOPES`, so possession of the paying
  device can never buy a retrospective read. It EXEMPTS `exchange` rows
  deliberately: their scopes are a PROMISE of what the credential they mint will
  carry, and an exchange token reads nothing — the only statement that accepts
  one CONSUMES it. Caught by `guest-portal.realdb.test.ts` on its first run.
- **`cardinality(scopes) >= 1`, never `array_length(scopes, 1) >= 1`.** On an
  EMPTY array `array_length` returns NULL, `NULL >= 1` is NULL, and a CHECK
  treats NULL as SATISFIED — so the obvious spelling admits exactly the row it
  was written to refuse, silently. Also caught by the realdb suite, which is the
  second thing it found and the reason a constraint without a real server behind
  it is a comment.
- **`purge_at` is the `notifications` resolution reused.** ADR 0003 D11 gives
  exchange rows 24 h past expiry and portal rows 90 days, and
  `ExpirySweepTarget` is `{table, column, retentionSeconds}` with no filter — so
  one registry entry cannot express two retentions over one table. The condition
  becomes a COLUMN, stamped by the writer that knows the purpose, registered with
  `retentionSeconds: 0`. Stamped at insert and never advanced (the
  `moderation_outboxes` decision), so a revocation cannot pull the deadline in;
  `…_purge_after_expiry_check` refuses a row that could be swept while live.
- **`token_hash`, `email_hash` and `subject_hash` are all in
  `db/protectedColumns.ts`.** An irreversible digest handed to a client is an
  OFFLINE ORACLE with no rate limit and no log line — `channel_api_keys.hash`'s
  reasoning. The resolver legitimately needs `token_hash` (it re-makes the
  accept decision with `verifySecret`), so `grantRepository` NAMES every column
  in one `GRANT_COLUMNS` list; `listGrantsForGroup` deliberately does not use it,
  because an operator trace has no business holding the digest.
- **`guest_recovery_attempts` is a WINDOW, not an event log.** One row per
  (axis, subject, window start), incremented in place by
  `ON CONFLICT DO UPDATE SET attempts = attempts + 1 RETURNING` — one statement,
  so a burst cannot have every racer read the same value and all pass a ceiling
  they collectively exceeded. An event log would be a per-inbox activity trail
  retained for the length of the window, which is precisely the correlation this
  domain refuses everywhere else. The AXIS is in the digest's preimage, so a
  value from one axis cannot be tested against another's rows.
- **`guest_contact_suppressions` has a PARTIAL unique on `email_hash WHERE
  lifted_at IS NULL`**, so two workers reacting to one bounce converge rather
  than racing (the `retail_suppressions` device), and a lifted row frees the
  slot so an address can be suppressed again later. Nothing expires: a hard
  bounce does not heal on a schedule and a person who complained did not consent
  again by waiting. A lift is attributable, dated and explained or a CHECK
  refuses it.
- **`guest_portal_operator_actions` is the `payment_repairs` shape** —
  append-only, one row per ATTEMPT, a mandatory actor and reason, and a
  biconditional CHECK on the refusal code. A refused attempt is the row worth
  having: an audit that only recorded successes answers "did anyone try" with
  silence.
- **What is deliberately ABSENT from every table here**: an email in any form on
  a grant, a message or an operator action; a postal address; an IP address
  (`guest_recovery_attempts` holds a coarse network PREFIX, hashed, and is the
  only table that touches one); a user agent, screen metric or any other device
  characteristic — #108 recovery rule 2 asks for rate limiting "without
  fingerprinting" and the absence is the enforcement. Nothing here can hold a
  plaintext token.

### The procurement domain has NO source model either (#118)

Eleven more tables born in Postgres, in `schema/procurement.ts`: `suppliers`,
`supplier_contacts`, `supplier_events`, `supplier_accounts`,
`supplier_agreements`, `supplier_agreement_evidence`, `procurement_offers`,
`purchase_orders`, `purchase_order_lines`, `purchase_order_transitions`,
`purchase_order_shipments`. The private supply side of Mercaria retail (ADR
0004): nothing here is a merchant, a brand or a payment counterparty, and the
domain never imports the payment domain (pinned by
`services/procurement/__tests__/role-separation.test.ts`).

The decisions that are THIS domain's, stated so a column that looks arbitrary
is answerable:

- **One purchase order, one currency, structurally.** `purchase_orders` carries
  ONE `currency` column and five bare `bigint` amount columns
  (`items/shipping/tax/duty/total`), so a second currency per PO is
  unrepresentable — the no-`direction`-column reasoning. There is deliberately
  NO CHECK that the amounts sum: the total is the SUPPLIER's own arithmetic
  from their quote, rounding included, and #128 reconciles it against their
  invoice; a constraint would reject the record of what the supplier actually
  said. The lines carry amounts with NO currency column of their own — the
  parent's one currency denominates them.
- **No third sequence.** The commerce gate pins exactly two
  (`order_number_seq`, `rma_number_seq`); a purchase order's external reference
  is its own id (ADR 0004 D6.6), so no `po_number` exists to mint.
- **Immutability is triggers, not review** (`0014`, the ledger-trigger
  precedent): `purchase_order_lines` refuse UPDATE and DELETE from birth (the
  line set IS the quote snapshot); `purchase_orders` identity columns
  (supplier, account, agreement, order, idempotency key, checkout group) never
  change — which is how a supplier MERGE is structurally unable to rewrite a
  historical PO — and the money, fx and destination columns freeze the moment
  the row leaves `draft`, which is what "source refresh cannot silently change
  a submitted order's cost snapshot" means mechanically.
- **`credential_reference` is a secret-store PATH, never a secret.** A CHECK
  pins the path shape (leading `/`, path charset, ≤512), so a pasted API key
  fails the WRITE; the column is also in `PROTECTED_COLUMNS`, so only the
  explicit opt-in (`readCredentialReference`) can read it back. ADR 0004 D6.5
  names the store: SSM under `/oxy/mercaria/suppliers/*`.
- **`supplier_accounts.provider` is an OPEN, shape-checked set** — unlike
  `PAYMENT_PROVIDER_IDS`. Supplier platforms arrive per supplier (#125), and
  gating the durable RECORD of an account on Mercaria having shipped its
  adapter would invert "gate the loop, never the record". The CHECK pins a
  machine-slug shape; the #124 adapter registry closes the set operationally.
- **The organization linkage is a real RESTRICT foreign key**
  (`suppliers.organization_id` → `organizations.id`): #53 landed first, so the
  parallel-development deferral resolved into the constraint at integration —
  the same mechanism #54's section records. The offer-side canonical mapping
  (`procurement_offers.canonical_product_id` / `canonical_variant_id`) still
  waits on #56 and sits in `DEFERRED_FOREIGN_KEYS`, where the gate will force
  it into a real `.references()` the moment those tables land. On
  `purchase_order_lines` the same columns are SNAPSHOTS and permanently
  unconstrained (the `order_items.listing_id` rule).
- **An agreement's empty scope array means NONE** — deliberately the OPPOSITE
  of ADR 0002's `commerce_relationships.territories` (`'{}'` = worldwide). A
  relationship is a positive fact scoped down; an agreement is a GRANT, and a
  grant that names no destination grants none. Fail closed
  (`services/procurement/agreement-scope.ts`).
- **A supplier merge repoints accounts and offers ONLY.** Agreements stay on
  the tombstone (a signed contract names the record that signed it, and
  `UNIQUE(supplier_id, version)` would collide the version sequences);
  `findActiveAgreementsForSupplier` resolves them forward through
  `merged_into_id`. Purchase orders are never repointed — the trigger refuses.
- **Eligibility is DERIVED, never stored** (#118 offer item 15). No `eligible`
  column exists anywhere;
  `services/procurement/procurement-eligibility.ts` recomputes the verdict
  from supplier + account + agreement + freshness facts each time — the
  `onboarding_state` one-verdict rule, taken one step further because the
  facts live on four tables.
- **The PO destination reuses `addressColumns`, and the SHAPE is the
  redaction**: recipient, address, carrier phone — no email column, no buyer
  identity, no order-history reference exists to leak (ADR 0004 D2.7/D10).
- **Append-only tables say so by their columns**: `supplier_events`,
  `purchase_order_transitions` (both `at`, no `updated_at`) and
  `supplier_agreement_evidence` (no `updated_at`) follow the
  `order_status_history` contract.
- **Zero `jsonb`.** Every shape in this domain is Mercaria's own and closed;
  supplier payloads are redacted to normalized reason codes plus a bounded
  `supplier_note` at the call site, never stored wholesale.

### The retail pricing domain has NO source model either (#120, ADR 0004 D3)

Four more tables born in Postgres, in `schema/retailPricing.ts`:
`retail_pricing_policies`, `retail_cost_quotes`,
`retail_cost_quote_components`, `retail_cost_quote_acceptances`. How Mercaria
prices the goods it sells ITSELF — cost recovery with zero markup and zero
intended item profit. Full behaviour: `docs/retail-pricing.md`.

The decisions that are THIS domain's, stated so a column that looks arbitrary
is answerable:

- **Markup is UNREPRESENTABLE, not defaulted to zero.** There is no
  `markup_bps`, no `margin_target_bps`, no `min_profit_amount` and no padding
  column anywhere in the four tables, and none may be added.
  `retail_pricing_policies.absorption_cap_bps` is the domain's ONLY
  basis-point column and it bounds what Mercaria ABSORBS before cancelling and
  refunding (ADR 0004 D3) — it can only ever cost Mercaria money. A test scans
  every column of all four tables against a forbidden-name shape, with a
  vacuity floor and a mutation self-test.
- **The customer total IS the sum of the component rows**, and that is the one
  invariant a CHECK cannot see (it is cross-row, and the components arrive
  after the parent). `insertRetailCostQuote` is the SINGLE writer of both
  tables, writes them in one transaction, and refuses a mismatch before issuing
  SQL — the `ledgerRepository` shape. A deferred constraint was rejected: it
  would fire long after the caller who could explain it has gone.
- **Two `Money` pairs per component, plus a five-column FX snapshot.** The
  source pair is the SUPPLIER's own currency (nothing converts a source price
  on write); the presentment pair is the converted figure. The snapshot is
  present EXACTLY when the two currencies differ — a biconditional CHECK, so
  neither a missing snapshot nor a spurious one is storable — and `fx_basis`
  records whether it was Mercaria's quoted rate or the provider's final one,
  because those can differ and the difference is variance, never profit.
- **`completeness` DETERMINES `presentation`, by CHECK, both ways**, and
  `block_reasons` is non-empty exactly when the quote is not `complete`. A
  blocked quote therefore cannot be stored claiming an exact cost-only price,
  and a complete one cannot be stored with an unexplained block. Expiry is
  deliberately NOT a `completeness` value: it is derived from `expires_at`
  against the clock (`deriveOfferFreshness`'s rule, applied to money), because
  a stored expiry state beside the deadline is two representations of one fact.
- **The promotion rule is three CHECKs, not a convention.**
  `buyer_payable = customer_total − coalesce(subsidy, 0)`;
  `0 ≤ subsidy ≤ customer_total`; every component amount `>= 0`. Together they
  make a supplier-funded promotion (a negative supplier cost) and a promotion
  that raises the price to fund itself later both unrepresentable.
  `RetailSubsidySource` has ONE member — Mercaria's own marketing budget.
- **Immutability is triggers, not review** (the ledger/fee precedent, `0017`):
  a policy version freezes every economic column once it leaves `draft`;
  quotes and their components refuse UPDATE and DELETE from birth (the charged
  amount is a pure function of the frozen quote). Acceptances refuse both too,
  with ONE narrow, one-way exception — `order_id` moving from NULL to a value,
  exactly once, with every other column unchanged. The checkout lock is taken
  BEFORE the retail order row exists (ADR 0004 D4 step 1), so that single write
  is what "freeze the accepted quote onto the order" needs; a realdb test pins
  that a second attach, a changed amount and a DELETE are all refused.
- **`UNIQUE(checkout_group_id, quote_id)` is the checkout lock's idempotency.**
  A retry converges on the existing row (the moderation-event claim shape), so
  the locked total is READ rather than re-priced. A revised total is a NEW
  quote plus a NEW acceptance naming the one it supersedes — the only
  representable way a charged amount changes.
- **The acceptance actor is an Oxy id XOR a guest-session ref**, exactly one
  present by CHECK — the `referral_touches` shape. Neither carries a foreign
  key: Oxy owns identity, and the guest session is purged on its own retention
  clock while this financial record is retained.
- **Supplier identity is a foreign key; catalogue identity is a snapshot.**
  `supplier_id` / `supplier_account_id` / `agreement_id` / `policy_id` are real
  RESTRICT foreign keys (those rows have lifecycle states rather than deletes,
  and an unattributable cost quote is not evidence). `procurement_offer_id` and
  the two `canonical_*` columns are SNAPSHOT provenance with no foreign key —
  the `purchase_order_lines` rule, since offers refresh in place and canonical
  entities merge. The policy is named TWICE on purpose: by id, and as
  `policy_key` + `policy_version` snapshot names, the `order_fee_snapshots`
  rule.
- **`expires_at` here is a VALIDITY deadline, not a retention one**, so this
  domain registers NOTHING in `db/expiryTargets.ts`. These rows are the
  financial evidence #128 reconciles against and are retained like `payments`.
  (`procurement_offers.expires_at` is unregistered for the same reason.)
- **No `orders` widening.** `commercial_role` / `seller_type = 'platform'` land
  with the code that writes them (#123) — the reasoning the procurement section
  above records. The acceptance's plain `order_id` correlation is the seam.
- **No stored variance table.** Classifying a final-versus-locked difference is
  pure (`services/retail-pricing/retail-variance.ts`); BOOKING it is #128's
  ledger work, and a second durable record of one fact is what the ledger rules
  forbid.
- **Zero `jsonb`.** Every shape in this domain is Mercaria's own and closed, so
  none of them earns an entry in the register below.

### The retail eligibility domain has NO source model either (#121, ADR 0004 D2.8–D2.10)

Nine more tables born in Postgres, in `schema/retailEligibility.ts`:
`retail_eligibility_policies`, `retail_category_rules`,
`retail_market_capabilities`, `retail_resale_evidence`,
`retail_compliance_evidence`, `retail_suppressions`,
`retail_eligibility_exceptions`, `retail_eligibility_decisions`,
`retail_eligibility_audits`. Whether Mercaria MAY sell a given product, through
a given supplier, into a given market. Full behaviour:
`docs/retail-eligibility.md`.

The decisions that are THIS domain's, stated so a column that looks arbitrary
is answerable:

- **There is no `eligible` column anywhere, and none may be added.** The verdict
  is a conjunction over eleven tables in three domains — supplier, agreement and
  offer (#118), canonical product, variant and identifier (#56), and this
  domain's own rows — so a stored one would be two representations of one fact
  and the place they must not disagree is a checkout gate. This is the
  `deriveNativeCheckoutEligibility` (#57) divergence from the `onboarding_state`
  one-verdict rule, and it is what makes an expiry and a recall bite with NO
  sweep having run (#121 acceptance 2 and 5).
- **`expired` is not a storable evidence state.** Both evidence tables carry the
  five REVIEWER states (`unknown | pending | verified | revoked | rejected`) and
  a nullable `expires_at`; the sixth state #121 names is derived against the
  clock in `services/retail-eligibility/evidence-state.ts`. A stored expiry
  beside the deadline would be two representations of one fact — the
  `retail_cost_quotes` rule, one domain over.
- **An empty scope array means opposite things on a POLICY and on EVIDENCE, and
  this is the first file where both appear.** A policy PERMITS what it names and
  nothing else (`permitted_destination_countries = '{}'` permits none) — the
  `supplier_agreements` grant semantics, so a freshly drafted version permits
  nothing at all. A piece of evidence is a positive fact being scoped DOWN, so an
  unscoped grant covers whatever its agreement covers — the
  `commerce_relationships.territories` semantics. Both are documented at their
  own tables.
- **A decision cites its policy version by a NOT NULL COMPOSITE foreign key.**
  `retail_eligibility_decisions.(policy_id, policy_key, policy_version)`
  references `retail_eligibility_policies.(id, policy_key, version)` — the
  `match_category_gates` device (#58), applied to reproducibility (acceptance 7).
  A decision that cannot name its version is unrepresentable, and one whose
  snapshot disagrees with its policy row is refused by Postgres. The identity
  key it cites through is a table CONSTRAINT rather than a unique INDEX, for the
  reason `match_benchmark_runs` records.
- **`retail_eligibility_decisions` is a RECORDING, never an authority.** Nothing
  reads a row to decide anything; the rows serve the operator trace, the
  re-evaluation sweep, the eligible-catalogue measurement and the blocked-checkout
  alert. The `payment_discrepancies` relationship to a payment.
  `services/retail-eligibility/eligibility.ts` imports no repository at all, and
  `retail-eligibility-isolation.test.ts` fails the build if that changes.
- **Immutability is triggers, not review** (`0030`, the ledger/fee/retail-pricing
  precedent): a policy version freezes every SCOPE column once it leaves `draft`
  (the status transitions stay legal, or a version could never be superseded);
  decisions and audits refuse UPDATE and DELETE outright.
- **A recall can never be `advisory`** — a CHECK refuses exactly the combination
  that would turn "recorded a recall" into "changed nothing". An `advisory`
  safety notice records without blocking, deliberately: a notice that is not a
  stop-sale must not silently delist a catalogue.
- **A suppression's scope is a polymorphic `(scope, scope_ref)` pair PLUS a real
  foreign key where one exists.** Eight scopes over five key spaces, three of
  which (`market`, `category`, `supplier_sku`) have no table to reference at all
  — so the pair is the general form and the five Mercaria-owned scopes
  additionally carry their own constrained column, held in agreement with
  `scope_ref` by CHECK. `ONE live row per (scope, scope_ref, kind)` is a partial
  unique, so two operators reacting to one authority notice converge.
- **`retail_eligibility_exceptions.waived_reasons` is containment-CHECKed against
  `RETAIL_WAIVABLE_REASONS`**, which is disjoint from `RETAIL_UNWAIVABLE_REASONS`
  by a test. No recall, suppression, prohibited category, ambiguous match,
  missing or expired evidence, unresolved tax treatment or unavailable refund
  rail can be waived by anybody — the `RETAIL_FORBIDDEN_COMPONENT_KINDS` device
  (#120), applied to overrides. Four eyes is the row's shape: two approvers who
  differ from each other AND from the requester, by CHECK.
- **An order-value ceiling forces a SINGLE permitted currency.** This domain does
  no FX (a test asserts it), so a ceiling in a currency the order is not
  denominated in is a cap that does not exist — the CHECK makes that
  configuration unstorable rather than leaving the derivation to fail open.
- **A price cannot be claimed FINAL while duty, import or VAT is open**, by
  CHECK. "No additional fees" is exactly the sentence that would be false.
- **No product-traceability table.** Country of origin, manufacturer identity,
  the responsible economic operator and batch capability are #56/#94 facts; a
  copy here would be a second answer to a question the canonical graph owns. The
  domain REQUIRES them on a policy version and READS them through
  `services/retail-eligibility/traceability.port.ts`, whose default reports NO
  DATA — which blocks, the `offer-facts.port.ts` (#94) rule.
- **No `orders` widening.** `commercial_role` / `seller_type = 'platform'` land
  with the code that writes them (#123) — the reasoning `procurement.ts` and
  `retailPricing.ts` both record.
- **Zero `jsonb`.** Every shape in this domain is Mercaria's own and closed.

### The supplier preflight domain has NO source model either (#122, ADR 0004 D4 step 1 / D5 / D9.3)

Eight more tables born in Postgres, in `schema/supplierPreflight.ts`:
`supplier_sourcing_policies`, `supplier_quotes`,
`supplier_quote_shipping_options`, `supplier_reservations`,
`supplier_sourcing_attempts`, `supplier_call_leases`,
`supplier_preflight_health`, `supplier_preflight_suppressions`. What a supplier
ANSWERED to one exact question immediately before Mercaria charges anybody.
Full behaviour: `docs/supplier-preflight.md`.

The decisions that are THIS domain's, stated so a column that looks arbitrary
is answerable:

- **A reservation is a ROW, and the row cannot exist without the supplier's own
  commitment.** There is no `reserved` boolean, no `reservation_state` and no
  reservation column of any kind on `supplier_quotes`.
  `supplier_reservations.provider_reservation_id` and `provider_expires_at` are
  NOT NULL and `supplier_reservations_capability_declared_check` requires
  `inventory_reservation` in `declared_capabilities` — so "the orchestration
  must not emulate a reservation" is not a rule a service obeys; there is no row
  shape in which it could be broken, whoever the writer is.
- **`SupplierAvailabilityState` is a DIFFERENT vocabulary from #118's
  `ProcurementAvailability`, deliberately.** That field records what a catalogue
  FEED last said about an offer; this one records what the supplier answered
  about this exact request. A shared union would let a feed's `in_stock` be read
  as checkout authority, which is the one thing #122 acceptance 1 exists to
  prevent.
- **A quote stores NO address, not even encrypted.** `destination_country` and
  `destination_region` are the coarse pair; there is no postal-code, city,
  recipient, line, phone or email column, so the redaction is the SHAPE — the
  `purchase_orders` device taken one step further, because a parcel needs a
  street and a QUOTE does not. `request_fingerprint` (an HMAC under
  `SUPPLIER_PREFLIGHT_FINGERPRINT_KEY`) is what ties a quote to the destination
  it was taken for: an auditor recomputes it from a destination they already
  hold. It is PROTECTED for `guest_checkouts.email_hash`'s reason — irreversible
  and still an exact-match ORACLE.
- **Completeness is THREE CHECKs, not a convention.** `status = 'complete'`
  requires an orderable availability (rendered from
  `SUPPLIER_COMPLETE_AVAILABILITY_STATES`), a confirmed identity, a known unit
  cost, a known shipping cost on a known basis and no destination restriction;
  `block_reasons` is non-empty EXACTLY when the status is not `complete`; and
  `exception_kind` is present EXACTLY when it is `invalid`. So a blocked quote
  cannot be stored claiming completeness, a complete one cannot be stored with
  an unexplained block, and an ambiguous provider answer cannot be filed as a
  mere `partial`. The `retail_cost_quotes` device, one domain over.
- **There is no `usage_state` column.** `consumed_at`, `released_at`,
  `superseded_by_quote_id` and `expires_at` state it completely, so a stored
  verdict beside them would be two representations of one fact whose
  disagreement lands in a checkout gate. `deriveSupplierQuoteUsage` is the one
  derivation — the `retail_cost_quotes` expiry rule.
- **There is no `score` column on a sourcing attempt.** A stored score is a
  number nobody can reproduce; the attempt records the deterministic RANK the
  policy version produced plus a closed-set reason, which is what makes a
  selection re-readable rather than re-derivable (#122 acceptance 7).
- **The cross-row shipping invariant is the WRITER's**, like
  `insertRetailCostQuote`'s sum: `selected_shipping_service_code` must name an
  option the quote actually recorded and `shipping_cost` must be that option's
  cost, which no CHECK can see. `insertSupplierQuote` is the single writer of
  both tables, in one transaction, and refuses before issuing SQL.
- **`supplier_call_leases` is ONE table doing two exact jobs.** A slot is a row,
  so concurrency is exact (a row lock); each slot carries its own equal share of
  the account's per-minute allowance, so rate is exact too (the same lock). The
  trade is stated in the table's docblock: uneven arrivals can UNDER-admit,
  which errs toward not exceeding the provider's published limit. The
  alternative — one shared counter plus separate lease rows — needs two tables
  to be exact in either dimension.
- **`supplier_preflight_health.attempts = successes + failures` is a CHECK**,
  equality and never `<=`, with `timeouts` and `rate_limited` bounded BY
  `failures` rather than added to the total twice. A health verdict computed
  from a lossy window is exactly the report that says everything is fine — the
  `catalog_backfill_runs` vacuity floor (#60), applied to a provider.
- **An automatic suppression can only ever be a HEALTH one.** A CHECK restricts
  `origin = 'automatic_health'` to `kind = 'health_degraded'`, a NULL raiser, a
  cited policy version and a mandatory expiry; every other kind requires an
  operator id. So the loop that watches health cannot file a `kill_switch`, and
  an automatic stop lapses on its own even if the loop never runs again — the
  OPPOSITE posture from `retail_suppressions`, and right here because the thing
  suppressed is a transient capability rather than a judgement about a product.
  The scope→columns mapping is a `case` CHECK over all four combinations, so a
  `market` stop cannot secretly name an account.
- **Immutability is triggers, not review** (the ledger / fee / retail-pricing
  precedent): a policy version freezes once it leaves `draft`; a quote's
  identity, request and ANSWER columns freeze from birth while each usage
  timestamp moves NULL → a value exactly once (which is what makes "a quote
  consumed by one checkout cannot attach to another" true of `psql` too); a
  reservation's provider facts and declared capabilities never change and its
  retry counter never decreases; shipping options and sourcing attempts refuse
  UPDATE and DELETE outright.
- **No foreign key to `procurement_offers` or the canonical graph.** Offers
  refresh in place and canonical entities merge; a quote is evidence of what was
  true at one instant and must survive both verbatim — the
  `purchase_order_lines` rule. Supplier, account and sourcing policy ARE real
  RESTRICT foreign keys: an unattributable supplier answer is not evidence.
- **No `orders` widening.** `commercial_role` / `seller_type = 'platform'` land
  with the code that writes them (#123) — the reasoning `procurement.ts`,
  `retailPricing.ts` and `retailEligibility.ts` all record.
- **`expires_at` here is a VALIDITY deadline, not a retention one**, so this
  domain registers NOTHING in `db/expiryTargets.ts` — these rows are the
  evidence a charge was made against, retained like `payments`.
- **Zero `jsonb`.** Every shape in this domain is Mercaria's own and closed;
  a provider's answer is normalized to allow-listed, closed-set columns at the
  adapter boundary and its raw form lives behind `source_record_ref`.

### The referral domain (#142, ADR 0005) has no source model either

Nine tables born in Postgres (`drizzle/0015_referral_domain.sql`, phase `pre`):
`referral_programs`, `referral_partners`, `referral_codes`, `referral_links`,
`referral_touches`, `referral_attributions`, `referral_subject_redirects`,
`referral_conversions`, `referral_events`. The decisions that are load-bearing,
so a column whose shape looks arbitrary is answerable:

- **A program row is one immutable VERSION.** `program_id` is a stable grouping
  token (the `checkout_group_id` shape — no `programs` parent entity),
  `UNIQUE(program_id, version)`, and a partial unique on `(program_id) WHERE
  status = 'active'` keeps exactly ONE version live. Editing is a CAS on
  `status = 'draft'`; publishing ENDS the prior active version in the same
  transaction. Policy columns (`commission_rule_ref`, `cap_policy_ref`,
  `payout_policy_ref`, readiness summaries on partners) are SEAMS naming
  records #144/#146 own — plain references, never foreign keys to tables that
  do not exist.
- **The partner owner is the `provider_accounts` polymorphic pair** (`user` |
  `store` + one id column), `UNIQUE(owner_type, owner_id)` — one partner per
  owner, ever (ADR 0005 D2), for the same reasons recorded on that table.
- **Codes are stored NORMALIZED lower-case** (CHECK
  `^[a-z0-9][a-z0-9-]{2,31}$`) with the unique index on the EXPRESSION
  `lower(code)`, so case-insensitive global uniqueness holds even against a
  writer that skips normalization. A retired code keeps its row and reservation
  forever; a vanity rename is a NEW row pointing at its canonical ancestor
  (`alias_of_code_id`), never a rewrite.
- **Destinations are a closed type + an opaque ref** — no URL column exists
  anywhere in the domain, which is what makes an open redirect unrepresentable.
  The one type→route mapping is `services/referrals/destinations.ts`.
- **`referral_touches` is append-only (no `updated_at`), swept on its own
  `expires_at`** (registered in `db/expiryTargets.ts`), and NOTHING takes a
  foreign key into it: an attribution SNAPSHOTS its winning evidence and
  carries `winning_touch_id` unconstrained, so raw touch volume is retainable
  separately from durable records (ADR 0005 D6). The only actor identities
  representable are an opaque guest-session ref (#103's key space — no import,
  no FK) and an Oxy user id, held mutually exclusive by CHECK; contact and
  payment data have no columns to arrive in.
- **Winner cardinality is the partial unique index**
  `(program_id, subject_kind, subject_ref) WHERE state = 'active'` — one active
  attribution per program and subject (ADR 0005 D4), enforced against
  concurrent resolvers by the database, not the service.
- **Supersession/correction pointers run BACKWARDS in time.** The successor row
  names its predecessor (`supersedes_attribution_id`, a real self-FK), never
  the reverse: the predecessor already exists and never changes, so the FK
  always resolves, while a forward pointer would require editing a resolved row
  to know its future — measured as an unresolvable-FK failure before the
  direction was flipped.
- **`referral_conversions` carries TWO unique indexes over one fact** — the
  deterministic idempotency key (`refconv:<kind>:<eventId>`) and
  `(source_kind, source_event_id)`. Its insert's `ON CONFLICT DO NOTHING` is
  deliberately ARBITER-LESS: Postgres checks the two indexes in no
  deterministic order, and a `DO NOTHING` targeting only one let a legitimate
  concurrent replay RAISE on the other, intermittently. No amount columns: what
  a conversion is worth is #144/#145's territory.
- **`referral_events` is the append-only audit trail** (closed action tuple,
  mandatory actor + reason — the `payment_repairs` discipline), and
  `referral_subject_redirects` records identity merges as `from → to` redirects
  (`UNIQUE(subject_kind, from_ref)`) so history keeps its references and reads
  resolve through the redirect.
- **`referral_events.reward_refusal_reason` is a COLUMN because a COUNTER reads
  it** (#431). `reason` is prose for a person; #148's `repeated_cap_attempt`
  counted accrual refusals by matching the `<code>: ` prefix of that prose, so
  the sentence's shape decided a fraud signal and any change to it made the
  count read zero — a clean partner rather than an unmeasured one, because
  `capRefusalCount` is always supplied. THREE CHECKs: `…_reward_refusal_reason_check`
  (the `REFERRAL_REWARD_REFUSAL_REASONS` tuple, null-tolerant as every
  `checkOneOf` on a nullable column is), `…_reward_refusal_scope_check` (a code
  only on `action = 'reward_accrual_refused'`) and `…_reward_refusal_present_check`
  (every such row NAMES its code). The last two are ONE biconditional written as
  two named constraints because they landed in different deploy phases — the
  scope half is satisfied by the previous image, which writes NULL, and the
  presence half is exactly what it violates. Plus a PARTIAL index on
  `(reward_refusal_reason, created_at) WHERE reward_refusal_reason is not null`,
  which is the read the counter issues and the thing a prose match could not be.
- **Zero `jsonb` columns.** Every shape in this domain is Mercaria's own and
  closed, so none of them earns an entry in the register below.

### Referral reward rules (#144, ADR 0005 D9–D19)

Four more tables born in Postgres, in `schema/referralRewards.ts`
(`drizzle/0060_colorful_speed_demon.sql`, phase `pre`):
`referral_reward_rules`, `referral_campaign_budgets`, `referral_rewards`,
`referral_reward_adjustments`. Full reference: `docs/referral-rewards.md`. The
decisions that are load-bearing:

- **The funding-source CHECK is the funding boundary.**
  `referral_reward_rules.funding_source_id` and
  `referral_rewards.funding_source_id` both CHECK against
  `REFERRAL_FUNDING_SOURCE_IDS` (four members), which is DISJOINT from
  `REFERRAL_FORBIDDEN_FUNDING_KINDS` (twelve) by a test. Adding a member is a
  code change plus a `pre` migration, the standing closed-value-set rule — and
  here it is also the one place a retail margin could ever become fundable.
- **A rule row is one immutable VERSION.** `rule_id` is a stable grouping token
  (the `referral_programs.program_id` shape — no parent entity),
  `UNIQUE(rule_id, version)`, plus a partial unique on `(rule_id) WHERE status =
  'active'`. `referral_reward_rules_immutable_once_active` refuses every column
  change on a non-draft row and refuses DELETE — the `fee_schedules` trigger,
  reused because it is the same decision.
- **`reward_currency` is nullable and two CHECKs keep it honest**: present
  exactly when `currency_mode = 'fixed_currency'`, and REQUIRED the moment any
  amount-valued term exists (fixed amount, minimum, any cap). An amount with no
  currency cannot be compared against a base whose currency varies. The domain
  performs no FX at all, so a mismatch is a refusal rather than a conversion.
- **ONE currency column on a reward, not two.** The reward and its funding are
  always denominated the same, because nothing converts; two columns forced
  equal by a CHECK would be two representations of one fact.
  `gross_amount_minor <= funding_amount_minor` is what makes "never pay more
  than the eligible funding" a property of the ROW.
- **`UNIQUE(conversion_id)` is the accrual's idempotency**, with `ON CONFLICT DO
  NOTHING` plus a re-read. One unique index over the fact, so unlike
  `referral_conversions` the arbiter is NAMED.
- **`referral_rewards` refuses DELETE and refuses a net that GROWS**
  (`mercaria_referral_reward_frozen`), and freezes its identity, its rule pin
  and its funding snapshot. Only the state machine and the net moving DOWN are
  writable. `state` carries ADR 0005's whole machine; #144 writes `held` and
  `voided`, and #145/#148 are the writers of the other three.
- **`referral_reward_adjustments` is append-only by trigger** against UPDATE and
  DELETE both, keyed on the deterministic
  `refrewrev:<rewardId>:<cause>:<sourceRef>`. `delta_amount_minor <= 0`; the
  recovery state is a biconditional pair of CHECKs over `(delta, liability)`, so
  `partner_liability` and a zero delta are mutually exclusive.
- **A budget's identity is frozen and its allocation only GROWS**
  (`mercaria_referral_campaign_budget_guard`). Cutting a campaign is
  `status = 'closed'`, which is prospective; a shrink would be retroactive and
  could strand claims already made. `claimed_minor` moves both ways — a reversal
  releases what it took back — and `claimed_minor <= budget_minor` is the CHECK
  the conditional claim relies on.
- **Zero `jsonb` columns**, for the same reason the #142 tables have none.

### The discovery-analytics domain has no source model either (#77)

Eight more tables born in Postgres, in `schema/analytics.ts`:
`analytics_events`, `analytics_search_queries`, `analytics_query_aggregates`,
`analytics_rollups`, `analytics_experiments`,
`analytics_experiment_exposures`, `analytics_pseudonym_salts`,
`analytics_rollup_cursors`. Full behaviour: **`docs/analytics.md`**. The
decisions that are THIS domain's, stated so a column that looks arbitrary is
answerable:

- **Every event property is a typed COLUMN and there is no `jsonb` anywhere.**
  The `payments.payload_summary` register entry is the closest precedent and
  the reasoning here is the OPPOSITE way round: a provider payload arrives
  shaped by somebody else and has to be reduced, while an analytics property is
  composed by Mercaria's own code — so an open bag is not a defence against a
  third party, it is the one mechanism by which a postal address, an order note
  or a page payload reaches production. The absent columns ARE the enforcement
  of #77's identity rules (no `email`, no `email_hash`, no `phone`, no
  `card_fingerprint`, no `provider_customer_id`, no `wallet_identity`, no
  `ip_address`, no `user_agent`, no `device_fingerprint`, no `token`).
  **The GATE is an allow-list, not a deny-list** —
  `services/analytics/__tests__/analytics-column-allowlist.ts` enumerates every
  column of all eight tables WITH A REASON and `contract-gates.test.ts` compares
  it against the drizzle schema both ways, so a NEW COLUMN FAILS THE BUILD until
  somebody decides it is allowed. A deny-list of forbidden name SEGMENTS sits
  beside it as a second layer (it catches a plausible name appended to the
  allow-list, which an allow-list cannot), matched against `sqlColumnName` and
  never `column.name`.
- **Two identity columns, mutually exclusive by CHECK, and NEITHER is a
  person.** `oxy_user_id` is present only for an `oxy` actor whose consent
  permits it (a second CHECK ties it to `consent_state <> 'denied'`).
  `pseudonymous_session_id` is a truncated sha-256 of a session handle under a
  ROTATING salt and is CHECK-forbidden on an `oxy` actor. This is the
  `guest_sessions.token_hash` decision taken one step further: that hash is
  unkeyed because its preimage carries 256 bits of entropy, and this one is
  SALTED because its preimage is a row id an attacker may hold — and the salt
  is then DELETED (45 days, `db/expiryTargets.ts`), which is what makes two
  epochs unlinkable rather than merely inconvenient to link.
- **`checkout_group_id`/`order_id` carry a per-event-type CHECK**, rendered
  from `ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES`, so a `product_page_view`
  carrying a checkout group is refused by the database. `buyer_origin` carries
  the same shape against a narrower tuple. Both are #77 envelope fields whose
  wording ("only for documented commerce metrics AFTER checkout begins") is a
  restriction, and a restriction stated only in a service is a convention.
- **`analytics_events` is APPEND-ONLY by trigger, and DELETE is deliberately
  permitted.** The append-only half is #77 identity rule 5 (a completed claim
  cannot retroactively absorb unrelated guest activity) surviving whoever adds
  an `update` to the repository. The delete half is the deliberate exception:
  erasure on schedule is the policy, and a trigger that refused it would make
  the retention sweep fail silently forever. This inverts the
  `mercaria_ledger_append_only` posture, which refuses both — because a ledger
  entry is a permanent financial record and an analytics event is not.
- **The rollup dimensions are NOT NULL with NO DEFAULT, and `''` means "not
  sliced by this".** A nullable dimension would break the bucket unique
  outright (Postgres treats NULLs as distinct — the
  `commerce_relationships.endpoint_key` problem) and a `DEFAULT ''` is the
  convention violation this document refuses. With neither, every writer states
  which bucket it means.
- **Numerator and denominator are stored SEPARATELY and the ratio never is.**
  Two rollup rows can be added and two ratios cannot; `denominator = 0` is a
  real storable state that reads as `null` rather than as zero, because
  rendering 0% for "nobody searched" is the commonest way a dashboard lies.
- **`analytics_rollups.metric_key` CHECKs against `ANALYTICS_METRIC_KEYS`**, so
  a number whose definition is unstated cannot be STORED — the storage half of
  #77 acceptance 6, whose read half is the surface 404ing an unknown key.
- **`analytics_search_queries` has NO actor column of any kind**, which is
  privacy rule 3 ("keep normalized query tokens separate from user identity")
  as a fact rather than as a rule about when to populate one. It carries TWO
  deadlines — `text_expires_at` nulls the redacted text in place while the row
  survives, and `expires_at` removes the row — with a CHECK ordering them, or
  the nulling sweep would have a window in which it can never run. The nulling
  cannot be an `expiryTargets.ts` entry: that registry DELETES rows.
- **`analytics_experiments` is one immutable VERSION per row** (the
  `fee_schedules` precedent, trigger and one-active partial unique included).
  What is worth reading twice is the `assignment_salt` freeze: editing it on a
  running experiment silently re-buckets every unit mid-flight, so the same
  person is control on Monday and treatment on Tuesday and nothing in the data
  says so — an edit that looks entirely innocent ("we widened the rollout") and
  destroys the result.
- **`coalesce(array_length(…), 0)` in the experiment shape CHECK is
  load-bearing, not defensive spelling.** `array_length` returns NULL for an
  EMPTY array and a CHECK evaluating to NULL is SATISFIED, so the naive form
  admits the empty guardrail list it was written to refuse while rejecting only
  the near-misses. Measured, not assumed: the realdb case fails on the naive
  form.
- **Every id column is unconstrained, as ONE decision rather than fifteen
  omissions** (`ANALYTICS_CORRELATION` in `deferredForeignKeys.ts`). Telemetry
  must never block a commerce delete, and its retention sweep must never
  cascade into one — the argument runs in the opposite direction from every
  other no-FK reason in that ledger, which is why it has its own.
  `pseudonymous_session_id` is ledgered separately: a foreign key there would
  require exactly the reversible mapping the derivation exists to destroy.
- **`analytics_pseudonym_salts.salt` is in `PROTECTED_COLUMNS`.** It looks like
  a housekeeping column and is the most consequential secret in the registry:
  possession of the current epoch's salt turns every pseudonym of that epoch
  back into the session handle it came from.
- **Zero `jsonb`.** Every shape in this domain is Mercaria's own and closed, so
  none of them earns an entry in the register below.

### The condition taxonomy (#90) has no source model either

Six new tables — `listing_condition_details`, `listing_condition_photos`,
`listing_condition_revisions`, `condition_mapping_rulesets`,
`condition_source_mappings`, `condition_category_policies` — plus four columns on
`listings`, five on `offers` and three on `order_items`. Full reference:
`docs/condition.md`.

**The condition KEY is a column on `listings` and `offers`, not a table.** It is
a property of the thing being sold and a join to read it would be a join on
every catalogue page. What earned tables is everything that makes the key
TRUSTWORTHY.

- **The value set is one tuple, read twice.** `ITEM_CONDITION_KEYS` types both
  columns AND renders both CHECKs — the `ALL_CURRENCY_CODES` convention. Nine
  keys; `OFFER_CONDITION_KEYS` is those plus `unknown`, which exists only on the
  offer side because a seller always knows what they are selling and most feeds
  publish nothing.
- **`listings_unrefined_condition_check` is the most load-bearing constraint in
  the domain.** `condition_assertion IN ('migrated_binary','legacy_client_binary')
  ⇒ condition IN ('new','used_good')`, both tuples imported from shared-types.
  That is #90 migration rule 2 as DDL: the legacy `used` can never become
  `used_like_new`, whether the writer is the migration, a v1 mobile client, a
  service bug or a `psql` session.
- **Five `offers_condition_*_shape_check` constraints** hold #90 evidence rule 6.
  Only `declared` and `mapped` may sit beside a key other than `unknown`, and
  `mapped` requires a confidence at or above
  `CONDITION_MAPPING_CONFIDENCE_FLOOR` — rendered into the CHECK from the SAME
  constant the mapping service reads, via
  `CONDITION_MAPPING_CONFIDENCE_FLOOR_SQL`, so the two cannot disagree about
  where the line is. There is no combination expressing "we think it is
  refurbished but are not sure".
- **`order_items`' three condition columns refuse UPDATE outright** —
  `mercaria_order_item_condition_immutable`, not an "immutable once set" rule.
  The weaker version would still admit a backfill writing NULL → a value, which
  is precisely what #90 migration rule 3 forbids. `condition_group` is
  deliberately NOT a column: the KEY is the stored fact and the bucketing is a
  presentation decision that should improve for old orders too.
- **`listing_condition_photos` has NO column that could hold a catalogue image
  reference, and a TRIGGER refuses a `file_id` `canonical_images` already
  claims.** The vocabulary stops the obvious mistake; the trigger stops the real
  one, which is a seller attaching the manufacturer's product shot — an ordinary
  Oxy media id no service check can recognise. `canonical_images_file_id_idx`
  (partial, `WHERE file_id IS NOT NULL`) exists for that trigger and for nothing
  else.
- **`listing_condition_details` carries `UNIQUE(id, listing_id)` as a
  CONSTRAINT, not an index**, and the distinction is not cosmetic: drizzle-kit
  emits constraints inside `CREATE TABLE` and indexes AFTER every
  `ADD CONSTRAINT ... FOREIGN KEY`, so the composite foreign key on
  `listing_condition_photos` would be created before its target key existed.
  Measured — that is how the migration failed the first time. The composite key
  is what makes "a photo may only evidence a defect on ITS OWN listing" a
  relational fact rather than a trigger doing a foreign key's job.
- **`listing_condition_revisions` is append-only with a PRECISE delete
  exception.** UPDATE is refused; DELETE is refused only while the listing still
  EXISTS. The foreign key already says `cascade`, so an unconditional refusal
  would make a listing undeletable and an unconditional permission would let an
  operator remove one correction to hide it. During a cascade the parent is
  already gone from the statement's snapshot, so the `EXISTS` is false.
- **A published mapping ruleset is frozen by trigger, rules included.** Freezing
  the version while leaving its RULES editable would defeat versioning entirely.
  One active version per provider is a partial unique, so two concurrent
  publishes cannot both win.
- **`condition_category_policies` names what is FORBIDDEN.** Absence means
  allowed — the taxonomy is universal and a restriction is a statement about a
  specific category, so an empty table means "nobody has restricted this", not
  "refuse the catalogue".
- **Two migrations, and the split is the deploy-phase rule working**: `0030`
  (`pre`, additive — both CHECKs widened to a superset including the legacy
  `'used'`, every row backfilled, four trigger pairs, one `migration` revision
  per listing) and `0031` (`post`, the clean cut — both CHECKs narrowed, both
  transitional defaults dropped). Each `post` statement breaks a write the
  previous image performs. `0030`'s hand-written statements live in two blocks
  with named anchors; its header states where each must go on a regeneration and
  why the ordering is load-bearing.
- **Zero `jsonb`.** Every shape here is Mercaria's own and closed.

### Counters became sequences (`drizzle/0001_counter_sequences.sql`)

`order_number_seq` and `rma_number_seq` replace the `Counter` collection's
`findByIdAndUpdate($inc)`. `nextval` gives the same never-twice guarantee with
no contended row and no transaction-scoped lock.

**Only two, because only two have consumers.** `nextDraftOrderNumber` — the
`MRC-DRAFT-` generator — has ZERO call sites in `src/`, so its sequence is
deliberately not created and the dead function goes with the model in Fase 3.

> **Fase 4 owes both a `setval`.** A fresh sequence starts at 1, which re-mints
> order numbers already on printed receipts — and `orders.order_number` is
> UNIQUE, so the second collision is a failed checkout in production. Read the
> values from the `counters` documents, NOT from `max(order_number)`: a
> gap-carrying counter is ahead of the highest number actually used.

### The catalogue backfill has no source model either (#60, ADR 0002 D23/D24)

Three more tables born in Postgres, in `schema/backfill.ts`:
`catalog_backfill_runs`, `catalog_backfill_records`,
`catalog_consistency_findings`. Full behaviour: **`docs/backfill.md`**. The
decisions that are THIS domain's:

- **A run's counters must ADD UP to what it scanned.**
  `catalog_backfill_runs_counters_total_check` is
  `scanned = unchanged + matched + created + enqueued + review_required +
  unmatched + skipped + failed`, an EQUALITY and not a `<=`. That is the anti-
  vacuity floor as a constraint: a page that swallowed a record cannot write a
  row, and `<=` would admit the run that scanned a million rows and classified
  none of them — which is the exact shape of a broken traversal reporting
  success. `mercaria_backfill_run_counters_monotonic` backs it up by refusing an
  UPDATE that lowers a counter, because a pass is many pages that ADD to one row
  and no legitimate write ever lowers one.
- **A reason and an outcome can never disagree.**
  `catalog_backfill_records_reason_outcome_check` is rendered from the ONE
  `CATALOG_BACKFILL_REASON_OUTCOMES` map in shared-types (the
  `REVIEW_SCOPE_TARGET_TYPE` device, #76), `else false` and all, so an
  unrecognised reason is unrepresentable even with the reason CHECK removed.
  `record_error` beside `unchanged` would make a page that swallowed an
  exception report as a clean one.
- **`mode` is inside the record's identity key.**
  `UNIQUE(mapping_version, mode, stage, subject_key)`: a re-run converges, a NEW
  mapping version writes a new row beside the old one so two rule sets are
  comparable, and a DRY RUN can never overwrite the apply it was meant to
  predict — which is the only thing the two reports exist for.
  `mercaria_backfill_record_identity_immutable` refuses an UPDATE that moves any
  of those columns; `run_id` is deliberately NOT among them, because it names the
  run that LAST examined the subject and moves with every re-run.
- **`subject_key` carries NO foreign key**, and for BOTH of
  `catalog_revisions.entity_id`'s reasons at once (D20): it spans stores,
  listings, native variants, canonical products, native offers and vendor
  STRINGS — one of which is not a row anywhere — and migration evidence has to
  survive the deletion of the row it describes. The CANONICAL columns on the same
  table are different and carry real `.references()` with RESTRICT, the audit-row
  rule: they name rows this database never hard-deletes, and evidence must be
  able to block a delete rather than vanish with it.
- **At most ONE open consistency finding per (kind, subject)** — a partial unique
  `WHERE resolved_at IS NULL`, the `commerce_relationships.endpoint_key` device
  applied to a sweep that runs hourly and must converge rather than accumulate.
  A finding RESOLVES by being re-examined and found consistent, never by being
  deleted; `first_seen_at` is written only by the INSERT branch, so "since when"
  survives every later pass.
- **ONE resumable run per (stage, mode, mapping version, cohort)** — a partial
  unique on the unfinished statuses. A completed run is history and the next pass
  is a NEW row; without it two operators opening the same stage would each get a
  cursor and each enqueue the whole catalogue.
- **No `expiryTargets.ts` entry, for any of the three.** #60 job behaviour 7 is
  explicit that rollback must not delete migration evidence, and a retention
  sweep is precisely a thing that deletes evidence on a clock. The tables are
  bounded by the catalogue (one row per subject per mapping version per mode),
  not by traffic.
- **Zero `jsonb`.** Reason codes are a closed `text` vocabulary with a CHECK,
  counters are integers, and `detail` is bounded free text nothing queries — the
  `match_decisions` reasoning, one domain over.
- **No canonical id column on `listings` or `product_variants`.** #60's migration
  step 1 offers "nullable canonical references on native records OR an equivalent
  mapping collection selected in #52", and ADR 0002 D6 selected
  `native_listing_links`. Both would be two representations of one attachment,
  and they would disagree the first time a link was superseded.

Two value sets were WIDENED by this issue's migration, both additively and both
in `pre` (a strictly larger CHECK cannot fail a write the previous image makes):
`native_listing_links.method` gains `backfill` — an attachment whose canonical
side the migration MINTED from the native side, which #59 has to be able to tell
apart from a connector declaring its own product identity — and
`attribute_reindex_requests.reason` gains `backfill`, so #61's drain can tell a
migration wave from ordinary editorial churn.

## Canonical product saves (#80)

Three tables — `product_saves`, `product_save_sources`, `product_save_aggregates`
— plus one column on the pre-existing `favorites`. Full behaviour:
`docs/product-saves.md`.

**`favorites` is not replaced and not forked.** It stays what it always was: one
Oxy account's interest in one exact native LISTING, which is right for a
handmade piece, an unmatched P2P item and a used copy whose seller photographs
are the reason. What #80 adds is the save of a canonical PRODUCT, and the two
are different tables because they are different facts — a listing save cannot
survive its listing and a product save must survive every offer of it.

**`favorites.save_intent`** (`listing_save | listing_pin`) answers "did the buyer
ASSERT that they meant this exact listing". Defaulted, so every pre-#80 row and
every v1-client write is classified honestly rather than being guessed at; the
migration reads `listing_save` and skips `listing_pin`.

**`product_saves_oxy_user_id_canonical_product_id_key` is the whole of #80
acceptance 1 and model rule 9.** Two favorited listings of one phone produce ONE
save because the second insert has nowhere to go, and every write is
`ON CONFLICT DO NOTHING` — so a repeated tap, a network retry and a migration
replay all converge without any of them reading first.

**Preferences are a canonical VARIANT, a condition GROUP and a MERCHANT.** The
group and not one of #90's nine keys, for #90's own stated reason: pinning
`refurbished_seller` would silently exclude `refurbished_manufacturer` from a
buyer who meant both.

**`reference_price_*` is three columns moving together** (`num_nonnulls(…) in
(0, 3)`), and it carries NO currency CHECK — it is the OFFER's own currency, the
`offers.price_currency` exception ADR 0002 D18 documents. Absent means no offer
existed when the save was made, which is `unknown as absence, never zero`.

**`visibility` is CHECKed against a ONE-member tuple.** #80 privacy rule 6
excludes a public saved-list profile from the issue, and a `isPublic: false`
default would be enforced by whoever remembered it. Widening the tuple plus
shipping a migration is what introducing one would have to look like — the
`RetailSubsidySource` device.

**`product_saves_ambiguity_check` ties `resolution_state` to
`ambiguous_split_job_id` BOTH ways.** An ambiguous save must name the split that
made it so (which is what makes the two candidates recoverable without a second
table), and a resolved one must not carry a stale job id a later reader would
resurface as an unanswered question.

**`product_save_sources` treats its two parents differently, and that is the
design.** The FAVORITE cascades — removing the listing save takes the record of
it. The SAVE is `ON DELETE SET NULL`, so un-saving the product leaves the record
standing and the migration then refuses to re-read that favorite under the same
mapping version. Cascading there would make a replay RESURRECT a save somebody
deliberately removed, which is worse than the duplicate #80 forbids: a duplicate
is visible and a resurrection looks like the buyer's own doing.

Its append-only trigger therefore has TWO exceptions rather than one. DELETE is
refused while the favorite still exists (the `listing_condition_revisions`
shape); UPDATE is refused except for `save_id` moving to NULL with every other
column unchanged, which is the only shape the referential action produces.
`product_saves.migration_version` has its own freeze trigger for the adjacent
reason: it answers "how many of these saves did buyers actually make", and a
column an UPDATE could move is not an answer to that question.

**`product_save_aggregates` is the `review_aggregates` posture with one
divergence.** The aggregate is the authority, everything derives from
`product_saves` and nothing increments — but there is deliberately NO
`canonical_products.save_count` projection beside it. Reviews have their entity
`rating` columns only because those predated the aggregate; a second writer of
one number is exactly the disagreement these tables exist to prevent, and
nothing here forces the mistake.

The aggregate has NO actor column at all. #80 privacy rule 1 ("the count never
exposes who saved it") is held by that absence and by a gate that asserts it,
not by a projection somebody has to keep honest.

**`product_saves.oxy_user_id` is the WHOLE of what this domain stores about a
person**, which is why #80 privacy rule 5 ("delete or anonymize according to
ecosystem policy") resolves to a single scoped DELETE: there is no name, handle,
email, avatar or contact detail left over to anonymize, and no second table to
sweep. Ledgered in `deferredForeignKeys.ts` as an Oxy account id like every
other.

**Migration `0036` (`pre`) also WIDENS three phase CHECKs**, additively:
`CATALOG_MERGE_PHASES` and `CATALOG_SPLIT_PHASES` both gain `saves`. The merge
phase moves the three columns `merge-plan.ts` declares; the split phase marks
every save of the divided product for its owner to resolve, because no rule can
say which half a person meant (#80 migration rule 8, #59 split invariant 3). A
strictly larger CHECK cannot fail a write the previous image makes, which is
what makes the widening `pre`.

### The external ingestion framework has no source model either (#62, ADR 0002 D19/D22)

Five tables, and the same question as every domain since the port: what does a
row have to make UNREPRESENTABLE rather than merely unlikely.

- **`catalog_source_configs` is a 1:1 EXTENSION of `catalog_sources`, not a
  fork.** `UNIQUE(source_id)` is what makes that literal: there is still one
  source identity and one id, and this row is its ingestion half — the
  `provider_accounts` relationship to a seller. The registry serves `operator`
  and `backfill` sources too, and those have no cadence, no credential, no rate
  limit and no health; twelve always-null columns on them would make the
  registry describe ingestion rather than provenance. It also keeps the module
  graph acyclic: `merchants.ts` already imports `provenance.ts` for its source
  links, so a `merchant_id` on `catalog_sources` would close a cycle between two
  table modules drizzle-kit evaluates eagerly.
- **The nine rights are a VERSION, frozen once active** (a trigger plus a
  one-active-per-source partial unique — the `fee_schedules` mechanism).
  Withdrawing one is a NEW version, so the old survives with its reviewer, its
  date and its terms URL intact. There is no UPDATE that could delete that
  history and no DELETE anywhere in the domain.
- **`catalog_sources`' three coarse rights columns become a PROJECTION** for a
  source that has a config — the `review_aggregates` → entity `rating`
  relationship (#76) — and `mercaria_catalog_source_rights_agree` is a
  DEFERRABLE constraint trigger on all three tables that refuses any COMMIT in
  which they disagree with `resolveSourceRights`. Deferred is the load-bearing
  word: a rights change touches three tables and no statement order makes every
  intermediate state consistent, so a check at COMMIT has no opinion about the
  order and can be strict about the outcome. A registry row with no config is
  returned early from and left entirely alone.
- **`catalog_source_objects` is the CURRENT fact, and it is not a second
  observation store.** `source_records` is append-only per content hash and
  answers "what was seen, and when"; a convergence key and a monotonicity guard
  need a row that answers "what is true now". `UNIQUE(source_id, external_type,
  external_id)` is the identity the issue names, and
  `mercaria_catalog_source_object_monotonic` refuses an UPDATE moving
  `current_observed_at` or `current_source_updated_at` backwards. The upsert
  carries the same predicate, so the ordinary path converges silently and the
  trigger makes the rule true of every other path.
- **No canonical product or variant COLUMN on the object.** The canonical
  attachment is a `canonical_*_source_links` row (D19) and the verdict is a
  `match_decisions` row; `last_match_decision_id` is a POINTER to the second.
  A copy of either would be a second representation a #59 merge or a
  re-evaluation could put out of step — and it would enrol this table in the
  merge census for two entities it has no opinion about.
- **`catalog_source_runs` counters split into a PARTITION and a set of
  TALLIES.** `fetched = stored + unchanged + rejected + quarantined` is
  equality, #60's vacuity floor ported: every fetched record gets exactly one
  intake outcome, so a page that swallowed one cannot write a run row at all.
  The downstream counters are `<=` bounds, because one record legitimately
  produces both an offer and a review decision. Writing them as one partition
  would have been a prettier CHECK and a false one.
- **`catalog_source_runs_retirement_check` is the one that costs money.** A
  non-zero `offers_retired` requires `enumeration_complete` AND an outcome in
  `CATALOG_SOURCE_RETIRING_OUTCOMES`, rendered from the same tuple the service
  reads. "Do not mass-expire healthy offers because one refresh failed" is
  therefore held against a replay and a hand-written `UPDATE`, not only against
  the sweep.
- **`catalog_source_runs_started_shape_check` is deliberately NOT a
  biconditional.** A run released for retry returns to `pending` with its
  `started_at` and its cursor intact — the whole point of releasing rather than
  failing it — and a biconditional would refuse exactly that write. Measured:
  the adapter contract suite's rate-limit case fails on the biconditional form.
- **`credential_ref` is a LOCATOR and is not a protected column.** Its CHECK
  admits `connection:`, `env:` and `ssm:` with a bounded locator, so a pasted
  bearer token is refused at the row. It stays out of `protectedColumns.ts`
  because a locator is not a credential and protecting it would force explicit
  column lists through `provenanceRepository`'s whole-row reads for no secrecy
  gained; what keeps it out of every response is that the operator projection
  NAMES its fields, gated statically.
- **`catalog_source_rejections` is the only table here with a retention
  deadline**, and the only one bounded by TRAFFIC rather than by the catalogue.
  Every other table is one row per source or one per external object and must
  never be swept — they are the audit history a rights suspension must not
  delete. A table with two retention rules has one of them wrong, which is why
  the residual is its own table rather than more columns on the object.
- **Four nullable columns joined `source_records`** — `source_updated_at`,
  `raw_payload_digest`, `normalization_version` and `policy_version` — and they
  ride the SAME insert as the observation rather than a follow-up update: the
  table is append-only, and on the `DO NOTHING` branch a second statement would
  stamp THIS delivery's versions onto the row an earlier one created, quietly
  claiming a fact was read under rules it was not. `policy_version` is the
  version NUMBER and not a row id, because a foreign key would close a module
  cycle; `(source_id, policy_version)` resolves it exactly against the policy
  table's own unique.

### The supplier order orchestration has no source model either (#124, ADR 0004 D4 steps 4–5 / D6.6 / D10)

Seven tables, all born in Postgres, all hanging off #118's `purchase_orders`.
`procurement_outboxes`, `supplier_order_attempts`, `supplier_provider_events`,
`purchase_order_line_outcomes`, `purchase_order_tracking_events`,
`purchase_order_documents` and `procurement_exceptions`. Plus three nullable
columns on `purchase_orders` (`provider_state`, `provider_state_observed_at`,
`state_mapping_version`) with one shape CHECK holding them together.

Full reference: `docs/purchase-orders.md`. The schema decisions worth reading
here:

- **The attempt log is append-only from BELOW, with a PRECISE update
  exception.** `supplier_order_attempts` necessarily exists before its outcome
  does — it is committed `in_flight` BEFORE the provider is called, which is
  what makes a crash mid-request leave durable evidence — so the trigger refuses
  DELETE always and refuses UPDATE once the row has left `in_flight`. "One write
  to terminate it, then frozen" is what append-only means for a row of this
  shape, and the alternative (an insert-only table plus a second row per
  outcome) would make "was this attempt ever resolved" a join rather than a
  column.
- **`ambiguous` is unreachable without an after-write failure**, by CHECK
  (`supplier_order_attempts_ambiguity_shape_check`). The entire convergence path
  rests on that outcome meaning "the request may have been applied"; leaving it
  a value a service could choose would make the guarantee a property of whoever
  wrote the call site.
- **`request_hash` is a sha-256 of the canonical REQUEST, and it is
  PROTECTED.** The request contains the buyer's street address, so the digest is
  an exact-match oracle over it — `guest_checkouts.email_hash`'s situation, one
  domain over, and the reason it is registered in `db/protectedColumns.ts`
  beside the ciphertext it summarises. Storing the request itself would put the
  address in a second table beside `purchase_orders`' one snapshot, which is
  what the destination's redaction-by-shape exists to avoid.
- **`supplier_provider_events` has TWO dedupe indexes, not one constraint.** A
  webhook dedupes on the provider's own event id; a POLL has none — it is a
  snapshot Mercaria asked for — so its identity is a content digest. Two partial
  uniques, because `NULLS NOT DISTINCT` (which `payment_provider_events`
  correctly uses for its optional account scope) makes NULLs COLLIDE and would
  collapse every polled event for an account into a single row. A CHECK ties the
  delivery kind to the identity: a webhook must carry an event id and a poll
  must not.
- **`verification` has no `unverified` value.** An unverified callback has no
  row shape, so it cannot be stored now and applied later by a sweep that never
  re-checked. That is #124 polling-and-webhooks item 8 made structural rather
  than enforced at one call site.
- **`observed_at` is the PROVIDER's clock and is the ordering key**, with
  `purchase_orders.provider_state_observed_at` as the monotonic high-water mark
  — the `mercaria_catalog_source_object_monotonic` device (#62). Two deliveries
  racing produce two RECEIPT times whose order says nothing about the world.
- **`supplier_accounts` gained an identity trigger** (`provider`, `environment`,
  `provider_account_id` frozen). Purchase orders, quotes and events all NAME an
  account rather than snapshotting its environment — which is right, because a
  snapshot is a second representation of one fact — and freezing the account's
  identity is what makes that safe. Without it, flipping `environment` from
  `test` to `live` would silently reinterpret every historical row pointing at
  it, which is #124 security item 8 ("keep test and production accounts
  impossible to mix").
- **`procurement_exceptions` has TWO partial uniques**, one keyed on the
  purchase order and one on the account, because an account-scoped condition (a
  rejected credential, an exhausted quota, a lagging stream) has no order to key
  on and opening one case per affected order would fill the queue with copies of
  a single problem. Both carry `WHERE resolved_at IS NULL`, which is what makes
  a resolved case re-raisable when the condition genuinely recurs. `detail` is
  TEXT and there is deliberately no `jsonb` bag: an exception's context is
  composed by Mercaria's own code, which is the shape `analytics_events` refuses
  an open bag for.
- **Line outcomes and carrier scans are append-only outright.** They are what a
  party OUTSIDE Mercaria said happened, and a correction is a new observation
  with a later `observed_at` — which is what makes the trail readable as a
  history rather than as a current opinion. `purchase_order_documents` is the
  one exception and UPDATES on a re-read, because a supplier legitimately
  restates an invoice's total before it is final and #128 reconciles against the
  newest statement.
- **No address, recipient, phone, email or document URL column exists anywhere
  in this domain.** The destination lives once, on `purchase_orders` (#118). A
  tracking event carries a country and a region and nothing finer, because a
  carrier's final scan is at the delivery address. A supplier portal's document
  link is routinely a signed URL — a credential wearing a location — so
  `purchase_order_documents` carries the provider's own document reference and
  no link.
- **Two of the seven are swept and five are NOT.** `procurement_outboxes` (14
  days) and `supplier_provider_events` (90) are bounded by TRAFFIC, exactly like
  their payment counterparts. The five evidence tables are bounded by the number
  of purchase orders and are what a chargeback months later is reconciled
  against, so they carry no deadline at all.

## Offer freshness and catalogue health (#68)

Five tables — `catalog_source_freshness_policies`, `offer_refresh_tasks`,
`catalog_source_refresh_leases`, `catalog_source_distributions`,
`catalog_source_run_quarantines` — plus four columns on tables #57 and #62 own.
Full behaviour: `docs/offer-freshness.md`.

**There is no deployment-scoped row anywhere in this domain, and no nullable
`source_id` that could mean "all sources".** Every duration lives on a row keyed
to ONE source. That is the schema half of "no global TTL"; the code half is that
`services/offer-freshness/policy.ts` imports no configuration, and a scanned
gate fails the build if it starts to.

`catalog_source_freshness_policies` is the `fee_schedules` mechanism, third
outing: a version frozen once active (a trigger), one active per source (a
partial unique), a mandatory reviewer on an active row, and supersede-then-insert
rather than an UPDATE. It is a separate table from `catalog_source_configs`
because the config is operational state a dispatcher rewrites every fifteen
minutes, while two of the three things these numbers encode are CONTRACTUAL — a
negotiated cache term and a retention obligation — and "what were the terms in
March" must stay answerable.

`offer_refresh_tasks` is a CONVERGENCE queue (`offer_outboxes`' shape, not the
moderation outbox's), and two devices carry its correctness:

- `priority_rank` is a STORED GENERATED `case` over `priority_class`, rendered
  from the same tuple the scheduler reads. The queue's ordering key is therefore
  a function of the row rather than a number a service computed. The `else`
  branch ranks an unrecognised class LAST, so a widening that forgot the
  expression starves the new class instead of pre-empting every real one.
- `subject_key` carries a SENTINEL (`*`) for a whole-source task rather than
  NULL, because Postgres treats NULLs as DISTINCT and the convergence unique is
  what makes five requests owe one refresh. The `offers.source_key` device.

`catalog_source_refresh_leases` is `supplier_call_leases` (#122) verbatim,
pointed at an inbound source: a slot is a ROW so concurrency is a row lock, and
the per-minute allowance rides that same row so the rate bound is serialized by
it. It does NOT replace #62's source lease, which is about ownership.

`catalog_source_distributions` is ONE current row per source and not a history:
the question is "does what arrived just now look like what this feed normally
looks like", which needs the baseline and not a time series of them. Its run
pointer is `ON DELETE SET NULL` — the baseline is a fact about the SOURCE and the
run is provenance for it, so CASCADE would delete a live baseline and RESTRICT
would make a run undeletable, which is a blocked teardown wearing a guarantee's
name (`product_save_sources.save_id`'s reasoning).

`catalog_source_run_quarantines` records the statistic, the baseline it was
compared against and how it ended. `catalog_source_run_quarantines_actor_shape_check`
makes the actor MANDATORY on a `released` row and FORBIDDEN on a `corrected`
one — an operator taking responsibility and a feed coming back into range are
different facts, and a note somebody wrote is not a way to tell them apart.

### Two `array_length` traps, both silent in the PERMISSIVE direction

`array_length` of an EMPTY array is NULL, and a CHECK rejects only FALSE — so
`array_length(col, 1) >= 1` ADMITS the empty array it was written to refuse.
Measured twice here: a targeted run with no ids and a refresh task with no
reasons both committed. Both constraints now read
`coalesce(array_length(col, 1), 0) >= 1`. Any future array-non-emptiness CHECK
in this schema must do the same.

### The columns added to tables this issue does not own

- **`offers.declared_unavailable_at`** — when the SOURCE said the object is
  gone. Stored rather than derived because it is a fact somebody told us, not a
  deadline against a clock. A native offer cannot carry one (a CHECK), and the
  `source_unavailable` retirement reason cannot be written without one (another
  CHECK), so the difference between "the source said so" and "we inferred it
  from a snapshot" is a fact about the row.
- **`catalog_source_objects.retirement_kind`** — on what EVIDENCE it was
  retired, biconditional with `retired_at`. `post`, because the image before #68
  wrote the first half and not the second; `0043` backfills the existing rows to
  `snapshot_omission`, which is the only path that retired anything before.
- **`catalog_source_runs.refresh_mode` and `target_external_ids`** — which
  refresh this pass is, and which objects a targeted one names.
  `catalog_source_runs_complete_mode_check` is the third leg beside the
  adapter's `complete` flag and the run's outcome: an incremental pass cannot
  claim a complete enumeration. `refresh_mode` is added NULLABLE in `pre`,
  backfilled, and made NOT NULL in `post` — adding it NOT NULL with no default
  would break every run the serving image opens.
- **`catalog_source_runs.offers_removed`** — a SEPARATE counter from
  `offers_retired`, which `catalog_source_runs_retirement_check` reserves for
  retirements inferred from a complete enumeration's silence. One column for
  both would either refuse a legitimate deletion notice from an incremental feed
  or make the CHECK meaningless.

### `offers_active_source_key` was NARROWED to `offers_source_identity_key`

`status = 'active'` LEFT the predicate. With it, a retired offer whose source
published the object again did not conflict, so the upsert inserted a SECOND row
for one external object and split its observed history across two ids. The
identity now holds for the offer's whole life and a return is a revival.

`superseded` is excluded from the new predicate, which is what lets `0044`
collapse any pre-existing duplicate without deleting a row or blanking its
provenance: the older copies are retired with the reason #57 already defines as
"a newer offer took this one's active source mapping".
## The universal feed importer (#63)

Seven tables — `feed_configurations`, `feed_configuration_versions`,
`feed_field_mappings`, `feed_value_mappings`, `feed_uploads`,
`feed_import_reports`, `feed_import_report_entries` — and no change to any
existing one. Full reference: `docs/feed-importer.md`.

**A 1:1 extension of the #62 source, one layer further down.**
`feed_configurations.source_id` is `UNIQUE`, so there is still exactly one source
identity. Ownership and object identity are properties of the FEED, and
`catalog_source_configs` describes an ingesting source of any kind — an API, a
crawl, a marketplace — so twelve always-null columns on it to serve the
file-shaped minority is the argument that table itself makes against living on
`catalog_sources`.

**`identity_key_fields` is FROZEN by a trigger**
(`mercaria_feed_configuration_identity_frozen`), and it is the most consequential
constraint in the domain. The external id every `catalog_source_objects` row is
keyed on is derived from these columns of the merchant's own file. Change the
list and every object gets a new id: the old ones stop being mentioned by a
completed enumeration and are RETIRED, the new ones arrive as first-time
observations, and the whole thing looks exactly like a seller who replaced their
catalogue overnight — with no error anywhere. Re-keying a feed is a NEW
configuration. There is deliberately no `external_id` mapping ROLE either: a role
and a frozen key would be two answers to one question.

**A mapping row has no fourth column.** `feed_field_mappings` carries
`source_field`, `constant_value` (exactly one, by `num_nonnulls`) and a
`transform` from a closed tuple. There is nowhere to put an expression, a
template or a pattern, so "the importer executes nothing a feed supplies" (#63
security 4) is the shape of the row rather than a validator somebody could
relax. A fallback CHAIN is excluded for the same reason — "column A, else B,
else the constant" is a conditional language.

**A version is frozen once it leaves `draft`** and ONE is active per
configuration — the `catalog_source_policies` / `fee_schedules` mechanism, and
the same reason: every stored observation cites the version it was read under, so
a version whose meaning could change would silently reinterpret facts already in
the catalogue. The trigger deliberately EXCLUDES the lifecycle columns
(`status`, `activated_at`, `activated_by_oxy_user_id`, `validated_report_id`,
`superseded_at`), or activation would be impossible.

**Activation cites its evidence by FOREIGN KEY.**
`feed_configuration_versions_activation_check` requires `validated_report_id` on
an active version, which is strictly more than a `validated` boolean: the report,
its counts and its failures are still there to read months later. A CHECK cannot
reach across tables, so "the report must be a `validation`" is a service refusal
beside it, naming the rule.

**The two foreign keys between versions and reports are a CYCLE, deliberately.**
A version cites its validating report and a report names its version; each
direction is load-bearing. Nothing in production deletes either, so the cycle
costs nothing there — a test teardown has to break it by hand, and
`feed-import-writes.realdb.test.ts` documents the only order that works.

**`feed_import_reports_intake_total_check` is `scanned = valid + invalid`**,
equality and never `<=` — #60's vacuity floor, ported for its reason: a pass that
swallowed a row must not be able to write a report at all, so "zero invalid"
stops being indistinguishable from "the loop never ran". `changed`, `unchanged`,
`matched`, `created` and `review` are TALLIES bounded by `valid`, because a
record can be changed AND match; writing them as one partition would have been a
prettier constraint and a false one.

**A report ENTRY carries no VALUES.** A field NAME, a record INDEX, an issue code
and the record's external id — which is `describeRejection`'s rule (#62) applied
to a file a merchant downloads. `observed_token` is the ONE exception and is
doubly bounded by `feed_import_report_entries_token_shape_check`: restricted to
`FEED_TOKEN_BEARING_ISSUE_CODES` (the three whose values come from a closed
external vocabulary) AND to `FEED_ISSUE_TOKEN_MAX_LENGTH` characters of
`[A-Za-z0-9 _./-]`. Rendered from the same constants the composer reads, so the
constraint and the service cannot drift. Entries are append-only against UPDATE
and deliberately deletable — retention sweeps them, and a trigger refusing DELETE
would make retention fail silently (the `analytics_events` posture).

**`feed_uploads.filename` is a LABEL, not a location.** A positive character
class, no `..`, no leading dot, bounded — written that way rather than as a list
of forbidden sequences, because a denylist over path syntax is what every
traversal bug has walked around. The stored artefact is never named after it:
`storage_key` is CSPRNG and shape-CHECKed. Only a plain file and a single-member
gzip are accepted (`FEED_COMPRESSIONS`), so an accepted artefact has no entry
paths at all.

**Two PROTECTED columns**, both on `feed_configuration_versions`:
`auth_ciphertext` (an AES-256-GCM envelope, the `connections` situation) and
`feed_url`. The second surprises people and is the reason the entry exists — the
affiliate networks that matter carry the key IN the URL, so a feed URL in this
domain is a credential wearing a hostname.

**No cadence, no freshness TTL, no data-use policy and no content hash.** All
four already exist on the #62 source or on `source_records`, and a second copy
would be two answers to one question with the loser being whichever the
dispatcher does not read. Stated here because their ABSENCE is the decision.

**Three retention targets**, all in `expiryTargets.ts`: uploads at 7 days (the
bytes live on one task's disk and do not survive a deployment), reports at 90
days (an active version cites one), entries at 30 days — deliberately SHORTER
than the report that counts them, because the counts are what is read months
later and the per-record detail is what a merchant downloads this week. Entries
are the only table here bounded by TRAFFIC rather than by the catalogue.

## The Awin retailer-network source (#66)

`awin_accounts`, `awin_advertisers`, `awin_feeds`, `awin_advertiser_quality`,
`awin_link_samples`, `awin_network_leases`. Full reference:
`docs/catalog-sources/awin.md`; source selection is #64's decision document,
which is binding.

**One Awin advertiser is one `catalog_sources` row.** Not one source called
"Awin", and every other decision here follows from that. It makes four otherwise
hard properties free: a malformed advertiser feed fails ITS run and marks ITS
source (there is no shared enumeration for it to make incomplete); each retailer
is a distinct merchant AND storefront, because the binding is
`catalog_source_configs.merchant_id`/`storefront_id` per source; the
per-advertiser kill switch, rights withdrawal, freshness TTL, cadence and
territory scoping are all things #62 and #68 already do PER SOURCE; and
advertiser health and NETWORK health become separately observable, which they
could not be if "Awin" were one source. The cost is stated rather than hidden —
fifty advertisers is fifty registry rows and fifty rights policies to review —
and it is the correct amount of work, because each of those IS a separate
commercial relationship with separate terms.

**`awin_network_leases` is #68's `catalog_source_refresh_leases` keyed on the
ACCOUNT, and the duplication is the point.** #68's lease is keyed on
`source_id`; with one source per advertiser it bounds each advertiser separately
and the network not at all — fifty advertisers with an allowance of twenty each
is a thousand calls a minute at one host under one key, which is how a publisher
account gets suspended. Both are claimed on a feed download and they answer
different questions: #68's is "how hard may Mercaria knock on THIS advertiser's
feed", this one is "how hard may Mercaria knock on AWIN". The slot/row/counter
mechanics are #122's `supplier_call_leases` unchanged, including the
UNDER-admitting trade and the `rate_limited` versus `all_slots_busy`
discriminator.

**Two lifecycles, two columns, two writers.** `membership_status` is what AWIN
says and only the discovery path writes it; `activation` is what MERCARIA
decided and only the operator path writes it. Collapsing them makes "Awin
suspended us" indistinguishable from "we paused them", which are opposite next
actions. There is deliberately no function that moves both.

**`awin_advertisers_activation_sample_check` is issue quality control 4 as a
constraint.** An advertiser cannot be `active` without naming the
`awin_link_samples` row that authorised it, and there is no "activate anyway"
column: a waiver would be a second, quieter way to reach the one state that puts
a tracked link in front of a buyer. `awin_advertisers_activation_attribution_check`
adds that any activation past `candidate` names WHO and WHEN.

**`awin_advertisers.activating_sample_id` carries NO foreign key, and that is a
MEASURED drizzle-kit limitation rather than a preference.** The natural
constraint is circular (`awin_link_samples.advertiser_row_id` references the
advertiser back), which Postgres permits, broken by write order. It was written
as `text().references((): AnyPgColumn => awinLinkSamples.id)` and `drizzle-kit
generate` SILENTLY DROPPED it — absent from the emitted SQL AND absent from the
snapshot, so the declaration type-checked, enforced nothing, and left a later
generation free to emit it out of nowhere. A constraint that exists in the editor
and not in the database is worse than one that exists in neither, so the column
is plain and registered in `ID_COLUMNS_WITHOUT_FOREIGN_KEY` with that reason.
The CHECK above plus `awin_link_samples` being append-only are what make the
citation real. **Any future circular FK in this schema must be verified against
the generated SQL, not against the declaration.**

**`awin_advertiser_quality_totals_check` is `scanned = mapped + rejected`**,
equality and never `<=` — #60's vacuity floor, so a pass that swallowed rows
cannot write the snapshot at all. Its companion
`awin_advertiser_quality_coverage_check` bounds every completeness count by
`mapped`: `with_gtin > mapped` is arithmetically impossible, and its appearance
would mean a counter was incremented somewhere the record was not, which is
exactly the shape a partially-refactored measurement takes.

**`destination_tracking_host` has a companion column and it is not decoration**
(#589). The first counts rows whose DESTINATION was one of `AWIN_TRACKING_HOSTS`
while the deep link was not — the feed's two URL columns mapped to each other's
roles. `destination_tracked_only` counts rows where BOTH were, which is a
tracked-only feed and not a fault. It exists because a zero in the first column
reads identically on a clean feed and on one where the conjunction could never
have fired, and "what would this report if the thing it measures were absent"
must have a different answer from what it reports now. They are disjoint verdicts
over MAPPED records, so `coverage_check` bounds their SUM by `mapped` exactly as
it does the tracking pair.

**`swap_example_destination_host` / `swap_example_deep_link_host` are stored
because the OFFER cannot supply them, and they are HOSTS because this schema
stores no URL.** The obvious objection is that both values are already on every
offer the pass wrote — and on exactly the flagged rows they are not: the
deep-link column holds a RETAILER url, `assessAwinTrackingLink` refuses it and
`withAssessedAwinTracking` withholds it, so
`offers.affiliate_tracking_template` is NULL and only the tracked destination
survives. Storing hosts rather than URLs is what lets the domain's no-URL wall
(`awin-isolation.test.ts`, guarding a feed URL whose PATH carries the API key)
stay unexempted: a host has no path and no query, and a host is exactly what the
detector compared. `awin_advertiser_quality_swap_example_check` makes the pair
BOUNDED by the same handle length every provider-supplied host here carries,
PAIRED (a deep-link host with no destination describes nothing) and EARNED (no
example on a snapshot whose swap counter is zero, so a row cannot carry evidence
for a finding it did not make).

**There is no `awin_advertisers.declared_host` and no expectation column of any
kind.** It was deleted with `awin_advertisers_declared_host_shape_check` and
`AWIN_DECLARED_HOST_PATTERN` (#589) after having no production writer for its
whole life: no Awin surface Mercaria can reach publishes an advertiser's host,
and deriving one from the feed's own destinations is circular. What replaced it
reads the feed alone. The loss is real and recorded rather than glossed — a
cross-retailer mismatch with no tracking-host signature is now undetectable — and
if it is judged worth catching it returns as a column, a writer and a caller in
ONE change.

**Two APPEND-ONLY tables, by trigger, against UPDATE and DELETE alike.** A
quality history whose rows can be edited answers "was this feed always like
this" with whatever somebody most recently believed, and the question is usually
asked during an argument about whether a regression is new. A sample AUTHORISES
an activation, so one that can be edited afterwards is not evidence — and the
edit would be invisible beside an advertiser that has been live for a month.

**`awin_link_samples_verdict_shape_check` reads
`coalesce(array_length(col, 1), 0)`**, never `array_length(col, 1) >= 1`: on an
EMPTY array `array_length` is NULL and a CHECK reads NULL as SATISFIED, so the
obvious spelling admits exactly the row it exists to refuse. #68 measured this
twice; every array-non-emptiness CHECK in this schema reads the coalesced form.

**No feed URL column exists, anywhere in the domain.** Awin puts the
product-data API key in the PATH
(`productdata.awin.com/datafeed/list/apikey/<KEY>`), so a feed URL here is a
credential wearing a hostname — #63's rule, inherited rather than re-decided.
What is stored is a LOCATOR, shape-CHECKed to the same
`^(connection|env|ssm):…$` pattern `catalog_source_configs.credential_ref` uses
so a pasted key is refused by the database; the URL is composed at fetch time
and never persisted, projected or logged.

**`awin_feeds.currency` carries no `CurrencyCode` CHECK**, and is the third
documented exception beside `connections.shop_currency` and
`provider_accounts.default_currency`. It is `offers.price_currency`'s own
exception (ADR 0002 D18) one layer up: an external platform trades in whatever
it trades in, and refusing a feed because its currency is outside Mercaria's
presentment set would decline a whole retailer's inventory over a display
concern — where a row whose currency Mercaria cannot READ is already refused per
record by #63's money reader, with the code named.

**`awin_advertisers`' network identity is FROZEN by trigger** (`account_id`,
`advertiser_id`) — #124's `supplier_accounts` decision, for its reason: every
feed, quality snapshot, sample and `catalog_sources` row NAMES this advertiser
rather than snapshotting which one it was, so re-pointing it silently
reinterprets every historical row. `catalog_source_id` is deliberately NOT
frozen: binding a source is a later operator act and the unique index already
stops one source serving two advertisers.

**There is no per-feed identity-column set, and no transactions table.**
`AWIN_IDENTITY_COLUMNS` is a code constant naming ONE column (`aw_product_id`) —
#63's frozen `identity_key_fields` taken one step further, because a column here
would be a configuration surface for the one decision that re-mints and retires
an entire catalogue when it moves. And #67 owns commission reconciliation: a
transaction row Mercaria cannot attribute to a click it recorded is a number
with nothing to compare it against, so the seam fails closed by ABSENCE, which
is the strongest form.

## Buyer post-purchase requests (#110)

Eight tables: `cancellation_requests` + `cancellation_request_lines`,
`return_requests` + `return_request_lines` + `return_request_evidence`,
`support_threads` + `support_messages`, and the shared `buyer_request_events`.
No source model — Postgres-born, like everything since the port. Full behaviour:
`docs/buyer-requests.md`.

### The property the schema exists to hold

**Nothing here can change an order.** There is no status column, no payment
column, no money column and no inventory column in any of the eight. A request
records what somebody ASKED FOR and what somebody DECIDED; the order moves
through `order.service.transition` and the money through
`refund.service.process`. The only trace of either that lands here is
`refund_id` — a POINTER to a row those services wrote, never a copy of what it
says. So acceptance 2 survives a service bug, a replay and `psql`, and a realdb
case walks `information_schema` to prove no such column exists.

### `guest_checkout_id` is NOT a column, and #110 asks for one

Cancellation field 2 says "order id and guest checkout id". `orders` already
carries `buyer_guest_checkout_id` (#105), so storing it again would be two
representations of one fact — and the place it would bite is a request whose
contact was erased under ADR 0003 D15 while a stale copy still pointed at it.
The join answers the question; the duplicate could only ever disagree.

### Two actor triples, both mirroring `order_status_history`

A requester and a decider, each a KIND plus at most one identifier, with a CHECK
refusing every other combination — ADR 0003 D16's shape, so a guest session id
has no Oxy-shaped column to arrive in and "a guest acted" is recordable without
saying which guest. The DECIDER additionally may not be `guest` or `system`:
deciding is an authorized act by a named person, refused at the row rather than
in a service branch.

`requested_by_grant_id` is the "access-session audit" of field 6 and is
`ON DELETE SET NULL`, because #108's retention sweep purges grant rows at 90 days
and a `RESTRICT` would deadlock that sweep against every request ever filed.

### The state CHECKs are BICONDITIONALS

`(state in decided-states) = (decided_at is not null)`,
`(state = 'rejected') = (decision_note is not null)`,
`(state = 'completed') = (completed_at is not null)`,
`(state in ('received','refund_pending','completed')) = (received_at is not null)`.

Stated both ways rather than as implications, because each one-directional half
admits a row that reads as a lie: a `withdrawn` request claiming a seller
rejected it, a decision note on an acceptance, a completed request with no
instant. `num_nonnulls(kind, actor, at) in (0, 3)` carries the decision triple —
the `guest_contact_suppressions_lift_check` shape.

`completion_failure` is restricted to the states from which work is still OWED,
so a terminal request cannot carry one — recording a failure on a completed
request would say the money both did and did not move.

### Two partial uniques per request table, and neither covers the other

`…_open_order_key` is `UNIQUE(order_id)` partial on the OPEN states, rendered
from the same `OPEN_*_REQUEST_STATES` tuple the service reads — two racers
converge on one row. `…_idempotency_key_key` is partial on `is not null` — one
client's retry converges AFTER the first was decided, which the open-state index
cannot do because the order is free again by then.

Keyed on the ORDER and never on the checkout group. That is authorization rule 5
and acceptance 3 in one index: a request against one sibling neither blocks nor
reaches another.

### Append-only, and the foreign keys agree with the triggers

`buyer_request_events` and `support_messages` refuse UPDATE *and* DELETE by
trigger, and both name their parents `RESTRICT` rather than `CASCADE` — a
cascade would be a way to delete rows by deleting a parent, and the trigger
would then either break the delete or be walked around by it. `RESTRICT` makes
the declaration and the trigger say the same thing.

`return_request_evidence` refuses UPDATE only: its foreign key IS `CASCADE`
because evidence is part of the request's own body rather than an audit of it,
and what must not happen is a file id being SWAPPED after a seller decided on
it.

A request LINE's `variant_id` and `requested_quantity` are frozen by trigger;
`approved_quantity` is the one column a decision writes and the only quantity
the refund reads, so letting the first two move would let a decision rewrite
what the buyer asked for and then refund against it.

### `buyer_request_events` uses two nullable columns and a CHECK

`cancellation_request_id` XOR `return_request_id`, `num_nonnulls(...) = 1` — the
`orders.store_id` XOR `seller_oxy_user_id` house rule rather than a
`subject_type` plus a `subject_id`. A real foreign key on each half is what stops
an event naming a request that does not exist, which is precisely the row a
reconstructed timeline would be missing.

### `support_threads` narrows rather than alternates

`order_id` is always present and `return_request_id` narrows it. A return-scoped
thread is still about the order the return is against, so making them
alternatives would have meant a polymorphic subject and a seller who cannot find
the conversation from the order they are fulfilling.

Both uniques are PARTIAL — `UNIQUE(order_id) WHERE return_request_id IS NULL`
and `UNIQUE(return_request_id) WHERE return_request_id IS NOT NULL` — because
Postgres treats NULLs as distinct and a plain two-column unique would let a
buyer open unlimited order-level threads. The `commerce_relationships`
endpoint-key trap, one domain over.

### Protected columns

`support_messages.author_oxy_user_id` / `author_grant_id`,
`buyer_request_events.actor_oxy_user_id` / `actor_grant_id`, and
`cancellation_requests` / `return_requests` `requested_by_grant_id` /
`requested_by_oxy_user_id`.

One repository serves BOTH sides of a support thread, so without the filter the
seller's view would carry the buyer's account id and the buyer's would carry the
seller's staff account. A grant id authorizes nothing — #108 establishes that,
which is exactly why it is protected HERE and not there: it is stable across
every message one credential writes, so a merchant holding it could group a
buyer's conversations by device. The actor KINDS are deliberately NOT protected:
`buyer` and `guest` say somebody acted without saying who.

### The one migration

`0049`, `pre`. Eight tables plus one WIDENING of
`guest_portal_messages_kind_check` for #110's seven message kinds — a
drop-and-re-add whose new tuple is a strict superset, so every write the serving
image performs still passes. Five hand-written triggers sit below the generated
block with the regeneration check in the file header.

## Register: every `jsonb` column, and why it earned it

`jsonb` is for genuinely shape-less data only. Eight columns qualify in 129 tables;
anything else with a known shape is real columns or a child table.

| Column | Why it is genuinely open-shaped |
|---|---|
| `moderation_outboxes.payload` | For `decision.apply` this holds the entire verified CrowdSource `WebhookEventEnvelope` as delivered. A published decision is deliberately LOOSE, and projecting it into columns would silently drop whatever a newer CrowdSource version added — the one thing a moderation payload must never do. |
| `notifications.data` | Each of the twenty notification types carries its own payload, composed at the call site and read back only by the client that renders it. No column set fits all twenty, and projecting today's would drop tomorrow's. |
| `notifications.delivery_status` | `Record<channel, 'pending' \| 'sent' \| 'failed'>`, keyed by whichever channels this notification was dispatched to. **Trap:** its `failed` value is NOT a `Notification.status` value, so flattening this map into the status column is an immediate CHECK violation. |
| `payment_provider_events.object_ids` | The provider object ids an event refers to (`{"paymentIntent": "pi_…"}`), keyed by the PROVIDER's own names. The key set is theirs, differs per rail, and grows with their API. |
| `payment_provider_events.payload_summary` | A provider's payload is not Mercaria's schema and a newer API version adds fields. It is stored REDACTED — an allow-list of ids, amounts, statuses and timestamps — so this is open-shaped data that has already been reduced, never the wholesale payload. |
| `payment_outboxes.payload` | The domain event's own ids, whose key set differs per event type. Deliberately MINIMAL — ids, not snapshots — so the outbox cannot become a second, drifting source of truth. |
| `connections.sync_settings_collection_mapping` | A `Map` whose KEYS are the external platform's own collection ids — an open set Mercaria does not define and cannot enumerate, so there is no column set to project into and no join to express. |
| `source_records.payload` | One observed external object, verbatim under the source's `may_store` right (ADR 0002 D19). Source-shaped BY DEFINITION — projecting it into columns would drop whatever the source adds next, and the payload's whole job is to preserve what was actually said for later review and re-matching. Its content hash is a sibling REAL column, so the convergence unique never depends on jsonb equality. |
| `catalog_revisions.before` / `.after` | ADR 0002 D16 names this pair by name. A revision must capture whatever the entity looked like INCLUDING columns a later schema removed, so projecting it into typed columns would make the audit trail lossy at exactly the moment somebody needs to read an old revision. Every other fact on that row — action, actor, reason, job, policy version — is a real column, because a reviewer filters on it. |

Deliberately NOT jsonb, though a mechanical port would have made them so:
`ModerationEnforcement.previousState` (three known keys → three CHECKed columns),
every embedded address (→ `addressColumns`), every `Money`/`DualMoney`, the
credential envelopes on `connections`, `Feedback.metadata` (its TypeScript index
signature is not backed by the Mongoose schema, which declares three strict
paths), and every `{name, value}` option-value list (→ child tables).

## Register: the documented exceptions

Six places deviate from a rule stated above. Each is here so removing the
deviation is a visible decision rather than a silent one.

| Deviation | Where | Why |
|---|---|---|
| A SINGULAR table name | `feedback` | "Feedback" is a mass noun; `feedbacks` is not a word, and Mongoose's derived collection name being exactly that is a `pluralize()` artifact, not a naming decision to inherit. |
| A currency column with NO currency CHECK | `connections.shop_currency` | It is the EXTERNAL platform's currency, declared with no enum in Mongoose deliberately: a Shopify or WooCommerce shop may report a code Mercaria does not list, and rejecting the connection over it would break the import rather than the price. Named in the gate's `EXEMPT` set. |
| A currency column with NO currency CHECK | `provider_accounts.default_currency` | The same shape as the row above, one system further out: it is the payment RAIL's currency for that seller's account. Several EEA settlement currencies (RON, CZK, HUF, BGN) are outside `ALL_CURRENCY_CODES`, which is Mercaria's PRESENTMENT set, so a CHECK here would fail the SYNC of a real seller's account rather than reject a price. Nothing prices against it; it is shown to the seller. Named in the gate's `EXEMPT` set. |
| A currency column with a SHAPE check, not the tuple CHECK | `storefronts.currency` | The third member of the class the two rows above define: a currency chosen by a system that is not Mercaria — the external channel's OWN currency as its platform reports it, possibly a code outside `ALL_CURRENCY_CODES`, and nothing prices against it. Unlike the two above it DOES carry a CHECK (`~ '^[A-Z]{3,4}$'`), which keeps garbage out and satisfies the currency gate structurally, so it needs no `EXEMPT` entry; ADR 0002 D18 binds `offers.price_currency` (#57) to this same shape. |
| A polymorphic owner instead of the mutually-exclusive PAIR `orders` uses | `provider_accounts.owner_type` + `owner_id` | `orders` splits its seller into two nullable id columns and a CHECK because it joins to `stores` for real and wants that foreign key. This table cannot: half its owners are Oxy accounts, whose key space is not in this database, so the pair would exist only to be CHECKed. It follows `ledger_entries`, which already carries this exact pair for these exact two kinds — and one column makes "two owners at once" unrepresentable rather than merely rejected, which is what lets the load-bearing constraint here be a single `UNIQUE(provider, owner_type, owner_id)`. That index is the only thing stopping a seller attaching a second connected account, or somebody else's. |
| A money column as `bigint({ mode: 'bigint' })` | `ledger_entries.amount_minor` | Every other money column is `mode: 'number'`, to map onto the `number` that `Money.amount` already is. A ledger entry is not a `Money`: it never ships to a client, it is never rendered, and it is summed across arbitrarily many rows by the one part of the system whose job is to be exactly right. `mode: 'bigint'` keeps the zero-sum check exact past 2^53 and makes it `=== 0n` on values that cannot have silently lost a minor unit. The bound that applies is the column's own int8 range, asserted by `assertSafeLedgerAmount` at every posting builder. |
| A type ASSERTION in schema code | `money`/`dualMoney`/`addressColumns` in `columns.ts` | TypeScript cannot infer a computed template-literal key through a generic. Without the stated return type the spread contributes NOTHING to the table's type while still creating the columns at runtime — a silent DDL/type divergence. Measured, not assumed: the un-annotated form produced a table with only its `id`. The residual risk (a typo INSIDE the helper) is pinned by `emits the exact column names …`. |

## Register: what was dropped, and what it cost

"No Mongo baggage travels" is only credible if the dropped things are listed.

| Dropped | Evidence it is dead |
|---|---|
| `Notification.triggerId` | Declared `ref: 'Trigger'`; there is no `Trigger` model in this repo. No caller passes it, no read path returns it — it appears in three lines of `lib/notification-service.ts` and nowhere else in `src/`. |
| `ModerationEvent.completedAt` | Never written and never read anywhere. The store is claim-then-DELETE, never claim-then-mark-complete, exactly as the model's own header says. |
| `ProductVariant.inventory.levels` | The embedded multi-location seam, superseded by the `inventory_levels` collection before it was ever written to. |
| `ModerationEvent`'s `created_at`/`updated_at` | The source schema has `timestamps` off. `claimed_at` is the only date it has ever had; adding two more that can disagree with it is the redundancy this port removes. |
| `order_status_history`'s `created_at`/`updated_at` | Same shape: the sub-document had only `at`, and the ABSENCE of `updated_at` is the append-only contract. |

## Behaviour changes the service layer had to absorb

The schema was not behaviour-neutral, and the places it was not are all cases
where the pre-cutover store left a dangling reference no constraint could catch.
Listed so a 23503 is recognised rather than rediscovered.

- **`location.service.deleteLocation` will start seeing SQLSTATE 23503.**
  `draft_orders.location_id` and `connections.sync_settings_target_location_id`
  are `ON DELETE RESTRICT`, because NULL already means "the store's default
  location" — so `SET NULL` would silently REROUTE an open draft's reservation or
  a live sync rather than fail. Before the constraints existed the delete
  succeeded and left a dangling id.
- **`inventory_levels` CASCADE from both parents.** Neither
  `catalog-write.removeVariant` nor `deleteLocation` cleaned up level rows, so
  both leaked orphans that kept counting stock at a place that no longer existed.
  The FK removes the orphan; it does NOT update the denormalized rollup, so
  `deleteLocation` must recompute the affected variants' totals.
- **`cart_items` CASCADE from `product_variants`.** A cart holding a deleted
  variant used to fail at checkout, far from the cause, to a buyer who did
  nothing wrong. The line now disappears with the variant.
- **New constraints Mongo could not state**, each of which a half-finished
  service path could previously violate: at most one default `location` per
  store; at most one default `address` per user; one `store_members` row per
  (store, user); one `cart_items` line per (cart, variant); a `completed`
  `draft_order` has a converted order and a non-completed one does not; a
  `discounts` window that ends before it starts is refused.

---

## What is enforced by a test

Not by discipline — these fail the build. The table records what is wired TODAY;
add a row when a gate lands, and do not list one that does not run yet.

| Convention | Test | Needs a live Postgres |
|---|---|---|
| The schema barrel exports exactly the number of tables the gates are calibrated for — the anti-vacuity floor for everything below | `src/db/__tests__/schema-conventions.test.ts` | no |
| Every id-shaped column is classified: a real `.references()`, a primary key, a deferred entry, or a permanent no-FK entry with its reason; ledger entries naming columns that no longer exist are stale | `src/db/__tests__/schema-conventions.test.ts` (`findIdColumnViolations`) | no |
| No implicit whole-row read of a table with protected columns — a bare `.select()` or the relational `db.query.<table>` API | `src/db/__tests__/schema-conventions.test.ts` (`findImplicitWholeRowReads`) | no |
| Every `PROTECTED_COLUMNS` entry names a real table (by its SQL name) and a real column (by its TypeScript property) — the two conventions differ and mixing them up silently protects NOTHING | `src/db/__tests__/schema-conventions.test.ts` | no |
| `money`/`dualMoney`/`addressColumns` emit exactly the column names they claim, in TypeScript AND in SQL — the one place in the schema where key names are not compiler-checked | `src/db/__tests__/schema-conventions.test.ts` | no |
| Every currency column carries a CHECK, since `text({ enum })` emits no DDL | `src/db/__tests__/schema-conventions.test.ts` | no |
| snake_case tables and columns; every table has a PK; every timestamp is `timestamptz`; no `''` default; no `_id`/`__v` left over from Mongoose | `src/db/__tests__/schema.realdb.test.ts` | yes |
| Every expiry-swept column has a supporting leading btree index — nothing else notices a later migration dropping one | `src/db/__tests__/schema.realdb.test.ts` | yes |
| A ledger transaction balances to zero per currency, and its rows refuse UPDATE and DELETE | `src/db/payments/__tests__/ledger.realdb.test.ts` | yes |
| A published fee schedule version refuses every economic edit and any DELETE; at most one active version per key; snapshots and acceptances refuse UPDATE and DELETE; the snapshot CHECKs refuse a `mercaria_retail` fee, a schedule-less `calculated` row and a fee above its basis | `src/db/fees/__tests__/fee-schedules.realdb.test.ts` | yes |
| No feed/search/catalogue-read module can reference the fee domain (organic-ranking isolation, #88 trust rule 1) | `src/services/fees/__tests__/fee-ranking-isolation.test.ts` | no |
| A brand rating is unrepresentable (#76): the forbidden and real scope tuples are disjoint, no review table carries a brand-shaped column, and no review-domain module can reach the brand layer | `src/services/reviews/__tests__/review-scope-isolation.test.ts` | no |
| No review table has a column that could hold buyer contact, payment or credential data (#76 model rule 12), scanned against the real drizzle column sets | `src/services/reviews/__tests__/review-scope-isolation.test.ts` | no |
| No forbidden signal (email match, Stripe Customer/Link/wallet/card fingerprint, affiliate click, conversion report, portal/checkout token, guest-session possession) can be an evidence type, and the review domain cannot import the payment or referral domains | `src/services/reviews/__tests__/review-scope-isolation.test.ts` | no |
| A fulfilment dimension is unrepresentable on a product review and a product-quality dimension on a service one; condition feedback belongs to the used listing alone (#76 acceptance 1 and 2) | `src/services/reviews/__tests__/review-scope-isolation.test.ts`, `src/services/reviews/__tests__/review-scope.test.ts` | no |
| Every forbidden evidence source is refused BY NAME, an unclaimed guest order grants nothing through any exported path, and the #109 seam refuses a well-formed claim | `src/services/reviews/__tests__/review-eligibility.test.ts` | no |
| The classification job never promotes a legacy listing review to `product`, leaves an unlinked store review where it is with the missing fact recorded, and appends its decision in the same transaction | `src/services/reviews/__tests__/review-migration.test.ts` | no |
| A scope and its target cannot disagree; one review per author per scoped target on the GENERATED key; an eligibility is granted once and spent once under concurrency; a claimed-guest eligibility needs its claim id; a hidden review leaves the aggregate; drift is detected and corrected; the migration log refuses UPDATE and DELETE | `src/db/__tests__/review-scopes.realdb.test.ts` | yes |
| An unrefined assertion (a migration, a v1 client) can never carry `used_like_new` or any refurbished/open-box key; a source label cannot sit beside a seller-declared condition; the two conservative keys ARE admitted, so the CHECK is restrictive rather than universal (#90 migration rule 2) | `src/db/__tests__/condition.realdb.test.ts` | yes |
| A condition photo whose `file_id` belongs to a `canonical_images` row is refused on INSERT and on UPDATE, while the seller's own file is accepted; one evidence row per (listing, file) (#90 acceptance 4) | `src/db/__tests__/condition.realdb.test.ts` | yes |
| An order line's condition snapshot refuses every UPDATE including a NULL → value backfill, while an ordinary column patch still succeeds; half a snapshot is refused (#90 acceptance 3, migration rule 3) | `src/db/__tests__/condition.realdb.test.ts` | yes |
| A `review_pending` or sub-floor `mapped` offer cannot carry a taxonomy key, an `unmapped` one cannot claim a condition, a `declared` one cannot carry a source label — and all three legitimate shapes ARE admitted (#90 acceptance 5) | `src/db/__tests__/condition.realdb.test.ts` | yes |
| A published mapping ruleset and its rules refuse every edit and delete; one ACTIVE version per provider under two publishes; the `active` → `superseded` move is still permitted (#90 migration rule 5) | `src/db/__tests__/condition.realdb.test.ts` | yes |
| Condition revisions refuse UPDATE and refuse DELETE while the listing lives, PERMIT the listing's own cascade, refuse a migration row naming a person and a seller row naming nobody, and refuse a revision in which nothing changed (#90 evidence rule 8) | `src/db/__tests__/condition.realdb.test.ts` | yes |
| A condition photo cannot evidence a defect on ANOTHER listing (composite foreign key); a disclosure that says nothing and a severity on a kind that has none are both refused | `src/db/__tests__/condition.realdb.test.ts` | yes |
| The seller-owned and forbidden photo provenances are disjoint; no condition table can hold a canonical-image reference or a #94-delegated fact; no ranking surface can reach the condition domain and no condition module can reach the fee, referral or payment domains; exactly one module compares against the confidence floor and it does so BY NAME (#90) | `src/services/condition/__tests__/condition-isolation.test.ts` | no |
| Both condition spellings together are a 400; a v1 `used` resolves to the conservative generic key and carries no acknowledgement; every non-`new` key projects back out as `used`; the evidence policy requires photographs for every key but `new` and names the refurbisher for exactly the two refurbished keys; a pre-#90 order line answers `recorded: false` with no key to misread | `src/services/condition/__tests__/condition-taxonomy.test.ts` | no |
| Verification cannot become a PAID boost (#55 product behaviour 5): a relationship carries no commercial column, the relationship domain imports no fee/payment/referral module, and exactly ONE ranking module — `services/ranking/facts.ts`, #74's own seam — may read the relationship domain, through the public finder only | `src/services/commerce-graph/__tests__/relationship-ranking-isolation.test.ts` | no |
| Every relationship kind constrains its subject and object entity kinds; all NINE of #55's relationship types are answered, and never one of them twice (six kinds + three structural foreign keys) | `src/services/commerce-graph/__tests__/relationship-kinds.test.ts` | no |
| An ingestion source cannot verify; a merchant self-claim is not self-verifying; domain control is insufficient for a brand badge and sufficient for the fact it proves; four eyes covers exactly the badge kinds; no ending is reversible | `src/services/commerce-graph/__tests__/relationship-authority.test.ts` | no |
| Every conflict kind fires on its shape and NOT on its near miss (disjoint markets, succession chains, another relationship's revoked evidence, a future-dated claim) | `src/services/commerce-graph/__tests__/relationship-conflicts.test.ts` | no |
| The per-kind endpoint CHECK accepts each kind's own pair and refuses every wrong one; a duplicate open claim is refused by the index AND by the service; ≤1 verified brand owner while two candidates coexist; a badge needs two DISTINCT operators; a market-scoped claim answers ES and not DE; a claim that expired yesterday produces no badge while still marked verified; revocation keeps the row, its verification facts, its evidence and its reviews; review rows refuse UPDATE and DELETE; the public projection carries exactly fourteen safe fields | `src/db/__tests__/relationships.realdb.test.ts` | yes |
| The order status CAS refuses a stale `expected`, so two concurrent transitions produce exactly ONE winner and one history event | `src/db/__tests__/commerce.realdb.test.ts` | yes |
| A discount's total-usage ceiling holds under two CONCURRENT redemptions at `totalMax - 1` | `src/db/__tests__/commerce.realdb.test.ts` | yes |
| A replayed checkout's duplicate is refused by `orders_idempotency_key_key` and the survivor is findable by that key | `src/db/__tests__/commerce.realdb.test.ts` | yes |
| Two concurrent FIRST paid orders settle a customer on ONE row with `orderCount = 2` | `src/db/__tests__/commerce.realdb.test.ts` | yes |
| The refunded-quantity and RESTOCKED-quantity aggregates answer their two different questions | `src/db/__tests__/commerce.realdb.test.ts` | yes |
| The sales report buckets across a month boundary and sums only the store's shop currency | `src/db/__tests__/commerce.realdb.test.ts` | yes |
| Both sequences format (`MRC-%06d` / `RMA-%06d`) and ascend independently, and no third one exists | `src/db/__tests__/commerce.realdb.test.ts`, `src/services/__tests__/draft-order-complete.realdb.test.ts` | yes |
| The generated `search_vector` stems and case-folds TAGS, and keeps its GIN index across the column rewrite | `src/db/__tests__/catalog.realdb.test.ts` | yes |
| Two STORES, two listings of one store, and two variants of ONE listing may each carry the same SKU and the same barcode — read BACK off the stored rows, so a writer that quietly nulled both could not pass — and neither dropped index is in `pg_indexes`, with a surviving sibling as the positive control (#296) | `src/db/__tests__/catalog.realdb.test.ts` | yes |
| EXACTLY ONE purchase order survives two concurrent claims on one idempotency key, with one line set and one birth event | `src/db/procurement/__tests__/procurement.realdb.test.ts` | yes |
| The procurement triggers hold: PO lines refuse UPDATE/DELETE, identity columns are immutable, money/destination freeze after `draft` — and both triggers EXIST in the catalogue (vacuity guard) | `src/db/procurement/__tests__/procurement.realdb.test.ts` | yes |
| A pasted secret fails `credential_reference`'s path CHECK; one platform account maps to one Mercaria row; `(supplier, version)` is unique; an incomplete approval is refused by CHECK | `src/db/procurement/__tests__/procurement.realdb.test.ts` | yes |
| The payment and procurement domains import NOTHING from each other, and each keeps its own order-linkage seam | `src/services/procurement/__tests__/role-separation.test.ts` | no |
| ONE active referral attribution per (program, subject) under two CONCURRENT inserts; the code namespace refuses every case-variant of a taken spelling (the CHECK included); a replayed/concurrent conversion source event converges on one row; correction and supersession are append-only rows naming their predecessor; merge redirects preserve historical references; retirement and suspension block NEW attribution while historical conversions keep transitioning | `src/services/__tests__/referral-writes.realdb.test.ts` | yes |
| Raw referral touches are swept on their own retention, separately from the attributions derived from them | `src/db/__tests__/expirySweeper.realdb.test.ts` | yes |
| The per-partner and per-campaign reward caps hold under two CONCURRENT accruals of DIFFERENT conversions, six iterations per run, with the loser recording `cap_reached` — a SUM-then-INSERT is not a bound at READ COMMITTED, so both take a transaction-scoped advisory lock in one fixed order | `src/services/__tests__/referral-rewards.realdb.test.ts` | yes |
| The fifteen #144 cases: a reward is a share of REALIZED ledger commission and never of gross spend; the funding-source CHECK refuses `mercaria_retail` margin and cost variance on a rule AND on a reward; an activated rule version cannot be edited or deleted; a duplicate or CONCURRENT conversion produces one reward whose amount does not move when the base does; a partial refund appends a negative adjustment and a full one voids; a PAID reward is never un-paid and becomes a partner liability; a budget claim is atomic and a budget cannot shrink; a retail bounty leaves the order and its #88 fee snapshot byte-identical INCLUDING `xmin` | `src/services/__tests__/referral-rewards.realdb.test.ts` | yes |
| Referral funding cannot reach the fee, pricing, retail, procurement, ranking, search, discount, checkout or FX domains, and the ONE ledger importer is the named read-only seam | `src/services/referrals/rewards/__tests__/reward-funding-isolation.test.ts` | no |
| The allowed and forbidden referral funding unions are disjoint; no reward column is named for a forbidden source; the `.strict()` rule schema refuses every forbidden-shaped field and the refusal names the prohibition | `src/services/referrals/rewards/__tests__/forbidden-funding.test.ts` | no |
| One product carries four canonical variants across two axes; two feeds listing the same options in a different ORDER and a different UNIT converge on ONE variant; a product with no axes gets exactly one default variant | `src/db/__tests__/canonical-catalog.realdb.test.ts` | yes |
| A colliding GTIN is stored `disputed` and the existing owner does NOT move; the partial unique refuses a second active owner even from a writer that skips the service; a wrong check digit stores nothing; a correction APPENDS and the wrong value survives; the immutability trigger refuses a value edit while permitting a status and an owner change | `src/db/__tests__/canonical-catalog.realdb.test.ts` | yes |
| A source title never becomes the canonical name (it becomes an alias plus a conflict); an MPN on a brandless entity is refused; a scheme at the wrong grain is refused | `src/db/__tests__/canonical-catalog.realdb.test.ts` | yes |
| Every applied field gets a `canonical_field_provenance` row in the observation's own transaction; an image with no observation is unwritable; a re-delivered observation writes nothing new | `src/db/__tests__/canonical-catalog.realdb.test.ts` | yes |
| A product merge tombstones the loser, records the merge AND the flatten hop, keeps resolution one hop, and leaves a `procurement_offers` reference to a merged variant still resolvable | `src/db/__tests__/canonical-catalog.realdb.test.ts` | yes |
| `UNIQUE(product_id, signature)`, the one-default-variant partial unique, the one-value-per-axis unique, the signature shape CHECK, the half-filled canonical-pair CHECK, the "not normalized ⇒ no magnitude" CHECK and the two-selected-values unique all fire | `src/db/__tests__/canonical-catalog.realdb.test.ts` | yes |
| GTIN/UPC/EAN/GTIN-14 and ISBN-10/13 check digits accept a valid value and refuse one wrong by ONE digit; a UPC and the EAN padding to it collapse to one canonical value; unit conversion round-trips every unit in the table; an ambiguous unit spelling (`MW` vs `mW`) resolves to nothing rather than to the wrong one | `src/services/canonical/__tests__/{identifiers,units,variant-signature}.test.ts` | no |
| `/internal/canonical-catalog/*` is operator-gated, unmounted on an empty allow-list, closed to the payments allow-list — and its source-fact endpoints REFUSE a canonical field (`name`, `slug`, `status`, `pinnedFields`) while accepting the same request without it | `src/routes/__tests__/internal-canonical-catalog.test.ts` | no |
| A published attribute definition version refuses every semantic edit and any DELETE, while a label correction and a draft edit both succeed; a second ACTIVE version is refused by the index even from a writer that skipped the service; the enum vocabulary of a published version is frozen | `src/db/__tests__/attribute-registry.realdb.test.ts` | yes |
| Category scope INHERITS to descendants only where the scope row says so, and an UNSCOPED definition applies everywhere | `src/db/__tests__/attribute-registry.realdb.test.ts` | yes |
| One structured observation writes three axis-named rows and a repeat writes nothing; a second SELECTED value in one slot is refused; a selected value that is not normalized is refused | `src/db/__tests__/attribute-registry.realdb.test.ts` | yes |
| Two disagreeing sources select NEITHER, keep BOTH parses, open exactly ONE review however many disagree, and enqueue a reindex; a stronger source replaces a weaker selection; two agreeing independent sources become `corroborated` | `src/db/__tests__/attribute-registry.realdb.test.ts` | yes |
| The definition CHECKs refuse a reserved OFFER key, a half-declared measurement/money/rating/structured attribute, a subjective or unfilterable hard constraint, and a publication with no audit | `src/db/__tests__/attribute-registry.realdb.test.ts` | yes |
| The reindex log converges on its deterministic id and refuses a half-claimed lease | `src/db/__tests__/attribute-registry.realdb.test.ts` | yes |
| Nothing in the attribute domain MUTATES a constraint's strength, the evaluator takes no strength parameter, and its verdict reads the hard outcomes only (#94 hard-constraint rule 4) | `src/services/attributes/__tests__/hard-constraint-isolation.test.ts` | no |
| The evaluator reaches no attribute or offer STORAGE, every commerce facet is answered from the offer port, and the default port reports no data rather than plausible numbers (#94 hard-constraint rule 6) | `src/services/attributes/__tests__/hard-constraint-isolation.test.ts` | no |
| The whole benchmark dataset normalizes to its stated outcome — mixed units, enum aliases, ranges, scale errors, uninferred units, cross-family refusals, marketing claims, typed refusals and the dimensionless families | `src/services/attributes/__tests__/normalization.test.ts` | no |
| Two equivalent measurements in different units compare equal at the declared precision, keep their source unit, and are NOT collapsed when the sources genuinely measured differently (#94 acceptance 1) | `src/services/attributes/__tests__/normalization.test.ts` | no |
| A hard constraint excludes, a preference never does, missing data is `unknown` under a NAMED policy and is never reported satisfied, and a variant-scoped fact cannot satisfy another variant's constraint (#94 acceptance 4) | `src/services/attributes/__tests__/constraint-evaluation.test.ts` | no |
| Every operator in the #94 list, including inclusive/exclusive range ends, negative set membership over a multi-valued attribute, range facts read through the satisfying bound, and structured axes | `src/services/attributes/__tests__/constraint-evaluation.test.ts` | no |
| A constraint set is refused before search for an unknown attribute, one outside the category, an unsupported operator, a cross-dimension unit, a mismatched currency, an inadmissible enum value, an inverted range or a missing axis — and reports EVERY issue, not the first | `src/services/attributes/__tests__/constraint-validation.test.ts` | no |
| `/internal/catalog-attributes/*` is operator-gated, unmounted on an empty allow-list, closed to the payments allow-list; the observation endpoint refuses a canonical value; the PUBLIC surface stays mounted without operators and has no wire representation of a hard text requirement | `src/routes/__tests__/internal-catalog-attributes.test.ts` | no |
| At most ONE verified merchant claim per merchant, refused by the index rather than by a read-then-write; a contest DISPUTES instead of replacing the incumbent; a challenge is single-use and an expired one consumes nothing; one claim's token verifies no other claim; revocation returns the merchant to `unclaimed` while every public field survives; the state CHECKs refuse an undated verification, an unattributable revocation, an anonymous rejection and an empty dispute | `src/db/__tests__/merchant-claims.realdb.test.ts` | yes |
| No merchant-claim module can reach the relationship/brand layer or grant operational access — claiming "Apple Store" creates no Apple relationship (#83 acceptance 6) | `src/services/merchant-claims/__tests__/relationship-isolation.test.ts` | no |
| Every verification method's assurance and auto-verify verdict, including that no `low` method may auto-verify (#83 acceptance 2) | `src/services/merchant-claims/__tests__/claim-methods.test.ts` | no |
| Domain control covers subdomains and NOT lookalikes; a platform proof covers that shop and not the merchant's other channels; a proof never reaches another merchant's storefront | `src/services/merchant-claims/__tests__/claim-scope.test.ts` | no |
| A site verification refuses loopback, private, link-local and cloud-metadata targets, against the REAL SSRF guard | `src/services/merchant-claims/__tests__/site-verification.test.ts` | no |
| The labelled matching benchmark covers all eight case kinds over ≥4 categories and ≥4 sources, meets the policy's precision floor with ZERO false merges, and is not achieving that by reviewing everything (recall and coverage floors) | `src/services/matching/__tests__/benchmark.test.ts` | no |
| The whole matching dataset produces byte-identical decisions with a semantic scorer registered and with none, and the scorer is never called (#58 acceptance 6) | `src/services/matching/__tests__/pipeline.test.ts` | no |
| Every relation marker fires on its shape and NOT on its near miss (`backpack` is not a pack, `showcase` is not a case), in English and Spanish | `src/services/matching/__tests__/relation-detection.test.ts` | no |
| An unknown feature is left out of the confidence DENOMINATOR — asserted against both wrong answers (unknown-as-zero and unknown-as-mean), not just the right one | `src/services/matching/__tests__/policy.test.ts` | no |
| No feed/search/catalogue-read module can reference the matching domain and no matching module can reference a fee, payment or referral one; the matcher writes no `offers` row and imports no canonical WRITE service; exactly ONE module writes `native_listing_links`; no operator schema accepts an outcome, confidence or blocker | `src/services/matching/__tests__/matching-isolation.test.ts` | no |
| An `automatic_match` with any blocker, a conflicting identifier with no blocker, a blocker absent from the explanation, a variant match with no resolved product, and a number on a deterministic stage are all refused BY THE DATABASE | `src/services/matching/__tests__/matching-writes.realdb.test.ts` | yes |
| A category gate cannot be opened below the policy's precision or sample floor, and the DATABASE refuses one citing a benchmark measured under a different policy; every benchmark rate is derived and a supplied one is refused | `src/services/matching/__tests__/matching-writes.realdb.test.ts` | yes |
| An active policy version and a recorded benchmark refuse every edit and delete — and all three triggers EXIST in the catalogue (vacuity guard) | `src/services/matching/__tests__/matching-writes.realdb.test.ts` | yes |
| The match queue coalesces repeats into one row, a mid-run enqueue leaves the row pending after completion without releasing the live lease, `SKIP LOCKED` really skips, and a completion from a non-owner writes nothing | `src/services/matching/__tests__/matching-writes.realdb.test.ts` | yes |
| #57's seam is closed end to end: an unmatched variant materializes NO offer, a barcode match writes a `barcode_gtin` link with NULL confidence and the offer appears; a heuristic match waits for its category gate and attaches with a `matcher` link and a confidence once it opens; re-running is a genuine no-op | `src/services/matching/__tests__/matching-writes.realdb.test.ts` | yes |
| No column in any analytics table can hold contact, payment, network or device identity; there is no `jsonb` property bag; every metric names its numerator, denominator, window, source and freshness; no money metric is sourced from telemetry; no experiment treatment kind could mean "hide Continue as guest", "auto-create an account", "preselect marketing consent" or "sell organic rank"; nothing in `src/` emits a deferred (#107–#110) event type | `src/services/analytics/__tests__/contract-gates.test.ts` | no |
| Analytics loss NEVER blocks commerce: the writer throws on every call and the enqueue, the flush, the emitter and the search instrumentation all return normally, with the drop counters asserted so a silently-inert sink cannot pass for the wrong reason (#77 acceptance 7) | `src/services/analytics/__tests__/sink-never-blocks-commerce.test.ts` | no |
| Query redaction destroys emails, phones, cards, IBANs, secrets, guest tokens, addresses and credentialled URLs — and leaves ordinary product queries intact, including `iphone 15 128 256 gb`, which a phone rule with optional separators eats (#77 acceptance 4) | `src/services/analytics/__tests__/redact-query.test.ts` | no |
| Each of #77's ten identity and correlation rules, one test each: the two identity fields are exclusive, the pseudonym is salted and unlinkable across epochs, the event repository has no update path, buyer origin has no `claimed` value, no event type asserts a payment, and no client-emittable type can | `src/services/analytics/__tests__/identity-rules.test.ts` | no |
| Organic ranking cannot read analytics (a discovery module may import the emitter seam and nothing else) and analytics cannot read commercial standing (no measurement module references the fee or referral domain); the ONE payment import is the named verified-conversion seam, and it reads COUNTS rather than money | `src/services/analytics/__tests__/analytics-ranking-isolation.test.ts` | no |
| The analytics identity CHECKs refuse both-identities, a cross-kind identity, an epoch-less pseudonym and a consent-denied account id while ACCEPTING each legitimate shape; the commerce correlation and buyer origin are refused on a pre-checkout event; events refuse UPDATE and permit DELETE; the query floor suppresses a rare query and serves a popular one; rollup and aggregate upserts CONVERGE rather than doubling; the rollup lease admits one claimant and refuses a stale owner's write; one CURRENT salt epoch survives a rotation; an active experiment freezes its salt and allocation while a draft does not | `src/db/analytics/__tests__/analytics.realdb.test.ts` | yes |
| `/internal/analytics/*` is operator-gated on its OWN fourth allow-list, unmounted on an empty one (404, not 401), closed to the payments allow-list — and `POST /analytics/events` refuses every server-owned event type while accepting the good entries beside them (#77 acceptance 3) | `src/routes/__tests__/internal-analytics.test.ts` | no |
| Acceptance 8's whole list — territory, brand exclusion, document expiry, recall, tax unknown, restricted category — plus the affiliate-only case; `ineligible` beats `unknown` beats `eligible`; every reason has a verdict AND an action; a waiver removes only what it names and never a recall | `src/services/retail-eligibility/__tests__/eligibility.test.ts` | no |
| Every forbidden evidence kind is detected by the shape somebody actually types (free text included), and every ALLOWED resale and compliance kind survives — the vacuity floor a refuse-everything detector would fail | `src/services/retail-eligibility/__tests__/forbidden-evidence.test.ts` | no |
| The retail eligibility domain cannot reach the fee domain, ranking cannot reach IT, the derivation reads no stored verdict and no repository at all, no module converts a currency or names a forbidden rail, and no body accepts an override-shaped field — each detector mutation-tested against a positive AND a near miss | `src/services/retail-eligibility/__tests__/retail-eligibility-isolation.test.ts` | no |
| The emergency path END TO END and in BOTH directions: an eligible combination, ONE insert, the next derivation refuses, the lift restores it — with the refusal recorded and the content hash stable across two identical answers (#121 acceptance 5) | `src/services/retail-eligibility/__tests__/emergency-path.realdb.test.ts` | yes |
| An ACTIVE eligibility policy refuses every scope edit and any DELETE while a draft accepts both; one active version per key even from a writer that skips the service; a decision citing another version is refused by the composite foreign key; decisions and audits refuse UPDATE and DELETE; a recall cannot be advisory; two operators converge on ONE live suppression; the evidence CHECKs refuse a reviewerless verification, an unexplained rejection and an unattributable revocation; an unwaivable reason cannot be stored and the requester cannot approve their own waiver | `src/db/retailEligibility/__tests__/retail-eligibility.realdb.test.ts` | yes |
| `/internal/retail-eligibility/*` is operator-gated on its OWN fifth allow-list, unmounted on an empty one (404, not 401), closed to BOTH the payments and the catalog allow-lists — and every client-bypass attempt is refused: an override-shaped field, an unwaivable reason, an advisory recall, a policy requiring affiliate evidence (answered by NAME), and a mutating body with no reason | `src/routes/__tests__/internal-retail-eligibility.test.ts` | no |

### The three concurrency shapes a mocked test cannot see

Everything above the line is checked by reading code. These three are not, and
each one has a translation that type-checks, reads correctly and is WRONG — so
each is pinned by two genuinely concurrent calls against a real server, and each
was mutation-tested by reverting to the wrong form and watching the gate fail.

- **A conditional write must stay ONE statement.** Mongo's
  `findOneAndUpdate({_id, status: current}, …)` evaluated its guard and its
  mutation together. `UPDATE … WHERE id = $1 AND status = $2 RETURNING` has the
  same property: the row is locked for the statement, so the loser's predicate is
  re-checked against the winner's write. A read-then-write is a different
  function with the same signature and a lost-update bug.
- **A guard that reads OTHER rows cannot live in the same `UPDATE`.** A subquery
  in an `UPDATE … WHERE` is evaluated against the statement's own snapshot, and
  READ COMMITTED explicitly does not re-read other rows during an EvalPlanQual
  recheck — so the tempting one-statement port of Mongo's `$expr` ceiling lets
  BOTH concurrent redemptions through. Serialize on the parent
  (`SELECT … FOR UPDATE`), then count in a SEPARATE statement, which takes a
  fresh snapshot after the wait. `redeemDiscountCode` is the worked example.
- **An `ON CONFLICT … DO UPDATE` increment must reference the EXISTING row**, not
  `excluded`. `excluded` is the row this statement proposed, so two concurrent
  first orders would each set the count to their own proposed `1`.

### A `Date` is not a safe parameter against an EXPRESSION

`gte(column, date)` is fine — drizzle knows the column's type and encodes it. A
comparison against an expression (`coalesce(paid_at, created_at)`) has no column
to take a type from, and postgres.js is handed a raw `Date` it refuses with
`ERR_INVALID_ARG_TYPE`: a hard failure at query time on a report that type-checks
perfectly. Bind `date.toISOString()` with an explicit `::timestamptz` cast. Found
by `commerce.realdb.test.ts`; the mocked report tests could not have seen it.

> **`findSchemaInvariantViolations` is asserted as a SUBSET of a shrinking
> allow-list, not against `[]`.** Two columns violate the "no `''` default" rule
> and predate the gate: `stores.description` and `listings.description`. A
> `drop_empty_string_defaults` migration on another in-flight branch removes
> both, so the gate has to pass on either side of that merge, in either order —
> which is why the assertion is "no violation outside
> `KNOWN_EMPTY_STRING_DEFAULTS`", plus "the list may only shrink", rather than an
> exact set. An exact set passes today and fails the moment the sibling lands, in
> a file unrelated to either change. Verified in all three states against a real
> database: two known violations pass, zero pass, and a newly injected one fails.
> When the list is empty it can be deleted outright.

**The schema was also verified by hand against a real PostGIS 17-3.5 database
when it landed.** Those assertions belong in the same file and are not all
mechanised yet. What was checked, and what each check is actually worth:

- both id shapes are accepted as primary keys (a 24-hex ObjectId and a uuid v7);
- a bad currency code is rejected by its CHECK;
- a `bigint` money amount of 2_500_000_000 (25 ⊜ — past the `integer` ceiling)
  round-trips as a JavaScript `number`, which is the claim the money-column
  decision rests on and the one thing about it that could not be settled by
  reading drizzle's source;
- the `tsvector` generated column indexes title, description AND tags, checked
  with three queries rather than one — a term only in the description, a term
  only in the TAGS (which reach the vector through
  `mercaria_immutable_array_to_string`, a separate code path), and a term in
  NEITHER row, which must match
  nothing. A single positive query cannot tell a working index from one that
  matches everything, and the first draft of this check did exactly that;
- the `geography` generated column populates from `longitude`/`latitude` and
  orders by TRUE distance — Barcelona → Madrid measured 507 km and → Paris
  830 km, against real-world 505 km and 830 km, with Madrid first. The
  independently checkable figures are the point: a test asserting only "a row
  came back" passes against a latitude/longitude swap. `ST_GeometryType` and
  `ST_SRID` are asserted too, since the typmod cannot be declared;
- a partial unique index permits many NULL handles and rejects a duplicate
  value — measured on `listings_store_id_handle_key` since #296 dropped the SKU
  one this used to read, and #296's own case asserts the two dropped indexes are
  ABSENT from `pg_indexes` with a still-present sibling as the positive control;
- `UNIQUE(decision_id, revision, action)` rejects a replay AND permits a later
  revision's `restore`, which is the half that matters — a key without
  `revision` would pass the first assertion and fail the second;
- the owner-exclusivity CHECK rejects a store listing carrying an `oxyUserId`;
- both sequences allocate distinct ascending numbers.

Anything in this document that a gate does NOT enforce is enforced by review.
The money-column shape, the `ON DELETE` reasoning, the enum-widening audit and
the re-applied Mongoose normalizations are all in that category — they are the
ones to read this file for before opening a PR, not after.

## Mercaria-retail native checkout (#123)

`retail_offer_bindings`, `retail_procurement_intents`,
`retail_procurement_intent_lines`, `retail_cost_variance_records`, plus
`orders.commercial_role` and the `platform` seller type. Binding decisions:
ADR 0004 D1/D4/D5/D8.

- **`orders.commercial_role`** is NOT NULL with a `connected_marketplace`
  default. The default exists so the migration could fill an existing table
  without a rewrite; `NewOrder` makes the field REQUIRED so no writer leans on
  it, exactly as `buyerOrigin` does and for the same reason.
- **`orders_commercial_role_seller_check`** is the biconditional
  `(seller_type = 'platform') = (commercial_role = 'mercaria_retail')`, as ONE
  CHECK rather than two implications. Both directions fail differently and both
  are money: a `platform` order marked marketplace books its whole gross as
  commission on a zero-markup sale; a retail order naming a seller credits that
  seller a payable the settlement step transfers to them.
- **`orders_seller_exclusivity_check` gained a third disjunct** — `platform`
  with BOTH owner columns NULL. That absence is the mechanism behind "no
  connected-seller transfer exists for a retail order": there is no owner id to
  look a `provider_accounts` row up with.
- **`retail_offer_bindings` is the ONE thing that makes a catalogue variant a
  retail line.** The cart holds a `product_variants` row and nothing else
  (#57's wall, unchanged), so retail-ness is a fact ABOUT a variant stored
  beside it. `UNIQUE(product_variant_id) WHERE retired_at IS NULL`: two live
  bindings would make "which supplier does this line come from" a question with
  two answers. Retirement keeps the row — a placed order's intent names it.
- **`retail_procurement_intents` is `UNIQUE(order_id, supplier_id)`** — ADR
  0004 D5's "one PurchaseOrder per supplier", one table earlier, and the same
  pair `po:<orderId>:<supplierId>` and the outbox row id derive from.
  `failure_kind` appears EXACTLY on a `failed` intent and `purchase_order_id`
  EXACTLY on a `purchase_order_created` one, both by CHECK: a status and its
  pointer are two spellings of one fact.
- **`retail_procurement_intent_lines` is a child TABLE, not a `jsonb` column.**
  The `jsonb` register admits a column only when nothing queries into it, and
  everything queries into these — a variance comparison sums their accepted
  totals, an operator trace lists them beside the purchase-order lines they
  became, and #128 reconciles a supplier invoice line against one.
  `UNIQUE(acceptance_id)`: a #120 acceptance locks ONE quote for ONE group, so
  two lines citing it would count one locked amount twice.
- **`retail_cost_variance_records` has no account column, no ledger pointer and
  no threshold verdict**, and that absence IS the #123/#128 split. Its
  `..._delta_check` states the subtraction and BOTH halves of the
  direction/sign biconditional in one CHECK, so `customer_owed` with a negative
  delta — a surcharge wearing a refund's name — has no row shape.
  `UNIQUE(intent_id, source)`, keyed on the intent rather than the order plus a
  nullable purchase order, because a NULLABLE column in a unique key admits the
  duplicate it exists to prevent.
- **Two hand-written triggers** (re-apply on any regeneration):
  `mercaria_retail_variance_append_only` refuses UPDATE *and* DELETE;
  `mercaria_retail_intent_lines_append_only` refuses UPDATE only — DELETE is
  permitted there because `intent_id` cascades from the order, and refusing it
  would break a cascade the foreign keys already declare rather than protect
  anything.
- **The fee domain's seller scope narrowed.** `fee_schedules.eligible_seller_type`
  and `order_fee_snapshots.scope_seller_type` render their CHECKs from
  `CONNECTED_MARKETPLACE_SELLER_TYPES` rather than the full tuple, so a schedule
  scoped to `platform` — selectable by nothing, but readable as a policy
  somebody set — has no row shape.
## The eBay Browse source (#65)

Three tables in `ebay.ts` — `ebay_call_budgets`, `ebay_discovery_queries`,
`ebay_reconciliation_samples` — plus `marketplace_seller_identities` and
`catalog_source_configs.seller_identity` in `ingestion.ts`, and a widening of
`condition_mapping_rulesets.provider`. Full behaviour:
`docs/catalog-sources/ebay-browse.md`.

**#62 forbids an adapter forking the framework's schema, and #65 does not.** Not
one column here describes an observation, an offer, a match or a rights policy,
and no pipeline stage reads any of it. What these tables carry is the three
things eBay's own contract demands that no provider-neutral framework could have
anticipated.

- **A QUOTA is a property of the application, not of a source.** eBay meters
  5,000 calls/day against the KEYSET while Mercaria configures one
  `catalog_sources` row per marketplace — five at the launch set. So
  `ebay_call_budgets` is keyed `(application_key, budget_date)`, where
  `application_key` is a sha-256 of the credential LOCATOR (never of a
  credential: `catalog_source_configs.credential_ref` is CHECK-shaped so it
  cannot be a secret). The digest is there because it is fixed-width and because
  two sources naming one keyset must collapse by construction rather than by
  string equality on a value somebody might write two ways. A budget keyed on
  the source would let the fleet draw 25,000 calls against a 5,000-call
  agreement.
- **The bound is stated twice and neither is a second source of truth.** The
  reservation is a conditional `UPDATE` (`calls_used + $n <= daily_limit`), which
  is what makes it exact across every ECS task; `ebay_call_budgets_within_limit_check`
  states the same rule at the row so a replay or a repair typed during an
  incident cannot exceed it. The CHECK cannot grant and the predicate cannot
  exceed it.
- **`daily_limit` is stored PER DAY** rather than read from configuration at
  report time, because eBay's application growth check really does raise it: a
  run refused against 5,000 stays refused against 5,000 in the evidence after the
  limit becomes 25,000, which is what makes "we were throttled on the 9th"
  answerable a month later. `calls_refused` sits beside `calls_used` for the
  vacuity reason `catalog_backfill_runs` states: the used count alone cannot tell
  a quiet day from a day spent refusing everything.
- **`ebay_discovery_queries` IS the catalogue.** eBay grants search-driven
  discovery and publishes no export, so an eBay marketplace inside Mercaria is
  exactly the union of these rows. A table rather than an environment variable
  because it is the ROLLOUT COHORT (#65 acceptance 7): an operator widens it one
  row at a time with the evidence of what each sweep returned beside it.
  `max_offset` is CHECK-bounded below `EBAY_SEARCH_MAX_OFFSET` — a depth past
  eBay's refusal point is a query that can only ever fail — and the constant is
  rendered with `sql.raw`, because an interpolated one writes a `$1` placeholder
  into the migration and DDL cannot carry a parameter.
- **The sweep order is a `position` COLUMN, not `created_at`.** A pass resumes
  by index, so the order must mean the same thing on the retry as on the
  attempt; two rows sharing a millisecond order arbitrarily under a uuid v7
  primary key.
- **`ebay_reconciliation_samples` records and repairs nothing** (the
  `payment_discrepancies` posture). Both money pairs carry the
  `offers.price_currency` SHAPE-check exemption and a paired-null CHECK, and
  `provider_affiliate_url_present` is nullable on purpose: NULL means attribution
  was never requested, `false` means it was and eBay answered without one — the
  only signal EPN approval has lapsed, because an unattributed link fails
  nowhere else.
- **`marketplace_seller_identities` is keyed `(provider, external_seller_id)`,
  not on the source.** An eBay username is one account across every marketplace
  it sells on, so scoping to a source would split one seller into five merchants
  the moment DE and FR come up beside ES — and a merge is #59's most expensive
  operation. It is NOT a copy of `merchant_source_links`: that answers "which
  observation attached this merchant", one row per source record, and this
  answers "which merchant IS this account", once per account. Neither is
  derivable from the other. `merchant_id` is a real RESTRICT foreign key;
  `external_seller_id` carries none and is registered in
  `ID_COLUMNS_WITHOUT_FOREIGN_KEY` with its reason.
- **`catalog_source_configs.seller_identity` defaults to `source_bound`**, so
  every source that predates #65 keeps #62's behaviour exactly, and a
  `per_record` source must additionally name BOTH a merchant and a storefront (a
  CHECK): those are the marketplace OPERATOR and its CHANNEL, and
  `storefronts.merchant_id` is what an offer's own merchant is compared AGAINST
  to derive marketplace-ness (ADR 0002 D8). Both NULL would leave every eBay
  offer indistinguishable from a retailer's own.
- **`condition_mapping_rulesets.provider` was WIDENED, not forked** — from
  `CONNECTOR_PROVIDER_IDS` to `CONDITION_MAPPING_PROVIDER_IDS`, a strict
  superset. Every existing ruleset, rule and offer keeps its provider and the
  rendered CHECK only ever admits more. A second ruleset table for catalog
  sources would have been the fork: two places deciding what "Seller
  refurbished" means, with one confidence floor between them.
- **No token, no item payload, no merchant/offer/canonical id.** An eBay access
  token is minted per process and held in memory (`services/ebay/token.ts`); eBay
  content is stored exactly once, in `source_records.payload`, under #62's
  allow-list and its `may_store` right — a second copy here would be a second
  retention clock for data whose deletion obligation is contractual.

## Supplier-fulfilled retail fulfilment (#126)

`retail_order_role_snapshots`, `retail_fulfilment_intents`,
`retail_fulfilment_line_allocations`, `retail_delivery_promises`, plus ONE
nullable defaulted column on `supplier_agreements`. Full reference:
`docs/retail-fulfilment.md`.

**Six of #126's ten snapshot facts are NOT columns here**, and the omission is
the decision: the product, variant, quantity and accepted price are
`order_items`; tax and shipping are `orders.totals`; the agreement, offer and
cost-quote citations are `retail_procurement_intents` and its append-only lines;
the purchase-order reference is that table's own pointer. Copying one would be a
second immutable record of one fact, and the copy nobody reconciles is the one a
customer finds on a receipt.

**No carrier, package, label, scan, weight, dimension, manifest or poll-cursor
column exists in any of the four tables, and none may be added.** #126 acceptance
2 forbids Mercaria containing a carrier system, and
`services/__tests__/retail-logistics-isolation.test.ts` WALKS these tables (not a
grep of the source) and fails the build on one. Two nullable Moovo columns are
permitted and are the whole of the seam: `moovo_transport_request_id` and
`moovo_transport_registered_at`. Shipment counts, package contents, event ids,
checkpoints and projection freshness belong to #157's aggregate and #158's inbox;
a column here that nothing could populate would be a second source of truth for a
fact Mercaria does not hold.

**`retail_fulfilment_intents` carries TWO mode columns and that is deliberate.**
`permitted_fulfilment_mode` is a CONTRACTUAL fact frozen at purchase;
`fulfilment_mode` is OPERATIONAL and unknowable until a supplier has accepted.
One column would either freeze a mode nobody could yet know or leave the
contractual grant rewritable after the sale. Two make
`retail_fulfilment_intents_mode_permitted_check` a real INTRA-ROW CHECK — the only
kind Postgres can enforce — and `mercaria_retail_fulfilment_write_once` makes the
operational one NULL→value exactly once (the `orders.claimed_by_oxy_user_id`
device, #106).

**`moovo_source_reference` is a STORED GENERATED column over `id`**
(`'mercaria:retail-fulfilment:' || "id"`), rendered with `sql.raw` for the prefix
so the constant does not become a `$1` placeholder in the migration. Deterministic
because a booking's idempotency and an inbound event's convergence both key on it;
a value minted per attempt would differ between two racers and defeat the property
it exists for. **The freeze trigger must NOT compare it** — it is STORED GENERATED,
so `NEW.<col>` is NULL inside a `BEFORE` trigger and the comparison raises on
every update.

**The over-allocation invariant is CROSS-ROW and therefore not a CHECK.** The sum
of ORIGINAL allocations against one order item, over intents that are neither
cancelled nor superseded, may never exceed that item's quantity.
`insertRetailFulfilmentIntents` is the single writer, locks the `order_items` rows
`FOR UPDATE` first, and accumulates the batch's own requests so two intents in one
call cannot each pass an independently-correct check. A REPLACEMENT is excluded in
BOTH directions — from the committed sum and from the incoming request — because
it re-ships units already allocated.

**`retail_delivery_promises_observed_shape_check` is TWO biconditionals, not one
over their conjunction**, and the difference was a real bug the real-server suite
caught. `(outcome = 'observed') = (basis is not null AND a window is present)` is
SATISFIED by `outcome = 'unknown'` with a window and no basis — both sides
evaluate false — so the obvious spelling admits exactly the row #126 rule 10
exists to forbid. Any future "present exactly when" CHECK over more than one
column in this schema must be written the same way.

**`supplier_agreements.moovo_label_dispatch_permitted`** is a separate grant from
`dropship_rights_granted`, defaulting FALSE. Dropship rights say the supplier may
ship to Mercaria's customer under Mercaria's name; this says a third party may
execute against Mercaria's own carrier account. A supplier can hold the first and
refuse the second, so deriving one from the other puts Mercaria's logistics
documents into a warehouse that never agreed to handle them.

Four hand-written triggers in `0049`: the role snapshot is IMMUTABLE (UPDATE
refused always, DELETE refused only while the order exists — #90's
condition-revision device, so the declared cascade still works), the promise trail
is APPEND-ONLY on the same terms, the intent's contractual half is FROZEN, and the
chosen mode and Moovo transport are WRITE-ONCE.

## The bounded retail pilot (#125)

`retail_pilot_cohorts`, `retail_pilot_skus`, `retail_pilot_stop_thresholds`,
`retail_pilot_stops`, `supplier_funding_observations`. Full reference:
`docs/retail-pilot.md`; the provider document is `docs/suppliers/printful.md`.

- **A cohort is a VERSION, frozen once active** — the `fee_schedules`
  mechanism (a partial unique on `(cohort_key) WHERE status = 'active'` plus a
  `BEFORE UPDATE` trigger). Every column but the lifecycle three (`status`,
  `superseded_at`, `updated_at`) is refused on a published row, so a widening
  is a NEW version with its own author, date and rationale. That is #125
  acceptance 8's "expansion requires a measured review" as a schema property
  rather than a habit.
- **These bounds are ROWS and not environment variables**, which is a
  deliberate divergence from every other rollout lever in this codebase
  (`RETAIL_BLOCKED_MARKETS`, `GUEST_CHECKOUT_BLOCKED_SUPPLIERS`, …). The
  difference is that those are INCIDENT levers — flipping one at 3am must be
  adding a value — while these are a published policy somebody signed and
  orders were placed under. `published_by_oxy_user_id` is NOT NULL on an active
  row, and an environment variable has no author, no date and no history.
- **`retail_pilot_skus` and `retail_pilot_stop_thresholds` may not GROW on a
  published cohort** (a shared trigger reading the parent's status), and DELETE
  is deliberately still permitted: removing a SKU NARROWS the pilot, which is
  always safe and is what an operator does when a product-safety flag lands.
  Adding one is the change nobody writes a review for, which is exactly why it
  is the one refused.
- **`cardinality`, never `array_length`, on the permitted-shipping-service
  check.** On `{}` the latter is NULL and a CHECK reads NULL as SATISFIED, so
  the obvious spelling admits exactly the empty list it exists to refuse. The
  constraint is scoped to `status <> 'active'` so a draft may legitimately be
  incomplete.
- **The audience percentage is a BICONDITIONAL** — present exactly when
  `audience = 'percentage'`. A percentage with no number admits nobody or
  everybody depending on who reads it; a number beside another audience is a
  bound nothing applies.
- **`funding_alert >= funding_floor` is a CHECK.** An alert below the floor
  fires after checkout has already stopped, which is a notification about an
  outage rather than a warning before one.
- **`retail_pilot_stops` is append-only against DELETE and permits exactly ONE
  update: the lift.** A pilot that stopped and was restarted is the most
  important row in its own history. `origin` and `raised_by_oxy_user_id` are a
  biconditional (an `automatic` stop names nobody, an `operator` one must),
  because attributing a threshold evaluation to a person makes the trail say
  something false and leaving an operator's decision unattributed makes it say
  nothing. The lift columns are `num_nonnulls(...) in (0, 3)` — attributable,
  dated and explained, or none of them.
- **One LIVE stop per (cohort, metric, scope, scope_ref)**, a partial unique on
  `WHERE lifted_at IS NULL` — the `retail_suppressions` device. Two evaluations
  of one breach converge on one row and page once. `scope_ref` is a plain text
  handle rather than a polymorphic foreign-key set, because the four scopes name
  four different kinds of thing; `(scope = 'pilot') = (scope_ref = '')` is a
  CHECK so a pilot-wide stop cannot also claim a subject.
- **`supplier_funding_observations` is append-only against UPDATE *and*
  DELETE**, and there is deliberately no mutable balance column on
  `supplier_accounts`. A single figure is one stale write away from admitting a
  checkout against money that is not there; a correction is a NEW observation,
  the ledger's posture. `recorded_by_oxy_user_id` is NOT NULL exactly for
  `operator_entry` — a figure a person typed and a figure an API returned are
  different kinds of evidence and must not be told apart by guessing.
- **No payment credential column exists in any of the five tables**, and none
  may be added. A top-up is a treasury act in the provider's own dashboard under
  ADR 0004 D6.5 dual control; what Mercaria records is the RESULT. The defence
  is absence, the analytics domain's, rather than redaction.
- **Placement in the barrel:** after `retailCheckout` and before `ingestion`. A
  cohort names a supplier and an account, a SKU entry names a procurement offer,
  and the domain reaches back into nothing else — a stop pauses ENTRY and never
  fulfilment, so there is no purchase order, order or payment reference here to
  make a forward one.
## Claiming a guest checkout (#109)

Three tables — `guest_order_claims`, `guest_order_claim_revocations`,
`guest_order_claim_outbox` — in `schema/guestClaims.ts`. Full behaviour:
`docs/guest-claims.md`; binding decisions ADR 0003 D14.

- **The claim row does NOT duplicate the ownership fact.** That lives on
  `orders.claimed_by_oxy_user_id` / `claimed_at` (#106), and this table adds
  only what those columns cannot carry: a stable id to cite, WHICH credential
  proved possession, which policy version required which proofs, how many
  siblings the claim covered, and the contests and corrections that are not
  ownership at all. Both are written under one lock in one transaction, and
  `readClaimConsistency` counts the drift a future write path could introduce —
  the two invariants no CHECK can express, because each compares a claim row
  against orders in another table.
- **`guest_order_claims_active_group_key` IS acceptance 8.**
  `UNIQUE(checkout_group_id) WHERE state = 'completed'` — two accounts racing
  for one group produce one winner and one refusal FROM THE DATABASE, so
  "concurrent and conflicting claims cannot silently transfer ownership" does
  not depend on a service comparison running in the right order. The
  `merchant_claims` device (#83), and a `revoked` row does not occupy the index,
  which is what lets a corrected group be claimed again.
- **`source_grant_id` carries NO foreign key, and both actions would break it.**
  Grants are hard-DELETED at their own `purge_at` (ADR 0003 D11), so `RESTRICT`
  would block the retention sweep forever and `CASCADE` would erase the claim's
  own proof the day the credential aged out. The claim outlives the credential,
  exactly as `guest_checkouts` outlives the session that placed it. Registered
  in `deferredForeignKeys.ts` with that reason.
- **`guest_checkout_id` IS a real foreign key, `RESTRICT`** — the
  `guest_portal_messages` decision. A claim of a group with no contact record is
  unrepresentable rather than refused at execution time, and `RESTRICT` rather
  than `CASCADE` because D15 ANONYMIZES a contact rather than deleting it: a
  cascade would make an erasure request quietly delete the audit of who took
  ownership of a purchase.
- **The state shape is ONE disjunction, not three implications.** A set of
  implications admits a row satisfying none of them — a `completed` row carrying
  a revocation reason would pass "revoked ⇒ reason" vacuously. `revoked` keeps
  `completed_at`: the claim DID happen, and a correction that erased when it
  happened would be the "delete history" #109 revocation rule 4 forbids.
- **`pending` and `rejected` are ABSENT from the state tuple, for two different
  reasons.** `pending` is unrepresentable because the claim is one transaction —
  there is no instant at which a claim exists and is not complete, so the value
  would be a state nothing could advance. `rejected` names a refusal this table
  never sees: every refusal the domain can produce happens BEFORE both proofs
  are in hand, and a refusal recorded before them would be a row an anonymous
  caller could create. The one refusal that arrives WITH both proofs is a
  contest, and that is `conflicted`.
- **Four eyes is two CHECKs plus a SNAPSHOT.**
  `approved_by <> requested_by` makes self-approval unrepresentable whatever the
  service does, the execute shape refuses an unapproved execution while
  `four_eyes_required` is true, and that flag is snapshotted at request time
  (the `catalog_merge_jobs` device, #59) so flipping the deployment lever can
  neither retroactively unapprove an executed correction nor silently approve a
  pending one. `UNIQUE(claim_id) WHERE state='pending_approval'` makes two
  operators reaching the same conclusion converge on one record.
- **The outbox is the moderation outbox, ported unchanged where it matters** —
  a DETERMINISTIC caller-supplied text primary key (`guest-claim:<type>:<claimId>`),
  `ON CONFLICT DO NOTHING`, two partial indexes for the two claim branches, and
  a length-CHECKed `last_error`. It carries no contact, no credential and no
  order detail: it names a claim and a kind of work, and every handler reads what
  it needs from the tables that own it.
- **ONE expiry target, and the two omissions are the point.** Only
  `guest_order_claim_outbox` is swept (14 days, the traffic-bounded row). A
  claim records who owns a purchase and a revocation records an operator
  correcting that; a retention shorter than the orders would answer the only
  question either exists for with silence — the reasoning that keeps
  `guest_portal_operator_actions` unswept.
## The ranking policy register (#74)

ONE table in `ranking.ts` — `ranking_policy_versions` — and it references
NOTHING: not an offer, not a merchant, not a source. That independence IS the
domain's shape. A policy version says how to ORDER offers and never which ones
exist, so nothing it holds can outlive or constrain a catalogue row, and a
rollback is a status change rather than a data migration. Full behaviour:
`docs/offer-ranking.md`.

- **The weights are COLUMNS, one per allowed signal, and that is the
  prohibition.** `match_policy_versions` is the precedent — a closed set of
  features, one column each — and here it does a second job.
  `OFFER_FORBIDDEN_RANKING_SIGNALS` names eleven things that may never influence
  organic rank, and the strongest possible statement of that is not a CHECK: it
  is that **no column exists to hold one**. There is no
  `weight_affiliate_commission`, no `weight_plan`, no `weight_fair`, no
  `weight_native`. A `jsonb` weight bag would have undone all of it in one line,
  which is why there is not one — `analytics_events`' reasoning, applied to a
  policy. A gate asserts the weight-column count EQUALS the allowed-signal count,
  so a forbidden weight cannot be added and an allowed signal cannot be silently
  left unweighted.
- **Immutable once it has SERVED TRAFFIC, not once it is published.** The
  `mercaria_ranking_policy_version_immutable` trigger returns early only while
  the row is `draft`; from `canary` onward every column that decides an order is
  frozen. That is what makes "the same eligible input produces the same order for
  one policy version" a property of the data.
- **`canary_share_bps` is the ONE column a serving version may still move**, and
  it is named in the trigger rather than left out of it. A ramp is a rollout
  control and not a policy term: the share decides WHICH comparison subjects are
  routed to the version and never what order any of them gets, and because the
  bucket is a hash of the subject compared against the share, raising it only
  ADDS subjects. Freezing it would make every ramp step a new version, and a
  version per ramp step makes the impression log unreadable. `description` is
  frozen despite not being economic — it is what an operator reads when deciding
  whether to roll back.
- **TWO partial uniques, because a rollout has exactly two arms.**
  `one_active_per_key` and `one_canary_per_key`. Activation must therefore
  SUPERSEDE, which is why `activateRankingPolicyVersion` runs the supersede FIRST
  inside one transaction — reversing the order makes every activation fail
  against the index rather than being a style preference.
- **`cardinality(...) >= 1`, never `array_length(...) >= 1`, on both metric
  lists.** `array_length` of an empty array is NULL and a CHECK rejects only
  FALSE, so the obvious spelling ADMITS exactly the row the constraint exists to
  refuse. Measured against a real server here, as it was twice in #68. Both
  columns are `NOT NULL DEFAULT '{}'`, so the predicate is never NULL for a
  different reason.
- **The metric keys are CHECK-contained against `ANALYTICS_METRIC_KEYS`** — the
  same tuple `analytics_rollups.metric_key` reads — so a policy cannot be
  evaluated against a number nobody has defined. Naming a metric is ALL this
  domain does with one: it reads no measurement, which
  `analytics-ranking-isolation.test.ts` enforces in both directions.
- **`(status = 'canary') = (canary_share_bps > 0)` is a biconditional**, not two
  one-way implications: a non-canary carrying a share would be a second answer to
  "who is on the new policy", and a canary routing nothing is not a canary.
- **No impression table, no evaluation table, no ranked-result cache.** An
  impression is an `analytics_events` row carrying `ranking_policy_version`
  (#77's seam, closed by this issue); a comparison between two versions is
  computed live from ONE eligible set, which is what makes "canaried, compared
  and rolled back without re-ingesting offers" true by construction; and a ranked
  page is a projection #61 measured the alternative for and adopted no
  materialized view.
## Price signals (#82)

`price_signal_policy_versions`, `price_signal_runs`, `price_signal_evaluations`,
`price_signal_feedback`. What a CLAIM about a price means, the sweep that
measures how often one can be made, what it found, and the corrections merchants
file against it. Full reference: `docs/price-signals.md`.

- **NOT ONE column is added to a table this domain does not own**, and that is the
  finding rather than an omission. A signal is DERIVED at read time from #78's
  immutable observations and #74's eligible offers — the
  `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict rule,
  with more force than anywhere it has applied before: the inputs sit on five
  tables in four domains, so a cached "good price" survives the moderation
  restriction, the rights withdrawal and the retirement that should have withdrawn
  it. `price_signal_evaluations` is a RECORDING (the `payment_discrepancies` and
  `retail_eligibility_decisions` relationship) and a scanned gate fails the build
  if a read path selects from it.
- **The money columns carry NO currency of their own**, which is a stated
  divergence from the `money()` four-column shape this document otherwise
  requires. Every figure on an evaluation is expressed in that row's
  `display_currency`, which is part of the SUBJECT's identity; a per-figure
  currency column would be a second representation of one fact, and the failure it
  enables is precisely this domain's own — a row whose headline amount and whose
  subject disagree about what currency the number is in. The divergence is narrow:
  it applies only where a row already carries the currency as part of its
  identity.
- **`min_distinct_sellers` is CHECK-floored at
  `PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR`, rendered with `sql.raw`.** The floor
  is not about disclosure — every offer read here is one `/offer-comparison`
  already publishes — it is about the word MARKET meaning something: a median over
  two sellers is one rival's price wearing a statistical name. `sql.raw` because
  interpolating the constant normally writes the literal bound-parameter
  placeholder `$1` into the generated migration, which generates cleanly and fails
  at APPLY time.
- **`good_price_below_median_bps >= typical_band_bps` is a CHECK.** Overlapping
  thresholds make one price satisfy both verdicts, and which one a shopper sees
  would be decided by the ORDER of the comparisons in the code rather than by the
  row.
- **`cardinality(guardrail_metric_keys) >= 1`, never `array_length(...) >= 1`.**
  `array_length('{}', 1)` is NULL, a CHECK rejects only FALSE, and the obvious
  spelling ADMITS exactly the empty evaluation plan it exists to refuse. Measured
  four times in this schema before this table was written; the realdb suite pins
  it with an empty-array fixture, which is the only fixture that can tell the two
  spellings apart.
- **Two shape CHECKs are written as SEPARATE implications, never as one over
  their conjunction** — the #126 finding. `price_signal_evaluations_value_shape_check`
  says both "only a measured row may carry a figure" AND "a measured row must
  carry one"; the conjunction form is SATISFIED by a row where both halves are
  false, admitting exactly the shape it exists to forbid.
  `price_signal_feedback_resolution_shape_check` is two biconditionals for the
  same reason.
- **A confidence belongs to a LABEL** (`(confidence is not null) = (label is not
  null)`). The two are one fact in two columns — issue item 8's "backed by a
  documented policy AND confidence" — and a confidence beside no label is a
  strength rating for a claim nobody made.
- **The run counters SUM by EQUALITY, never `<=`**, on both axes
  (`catalog_backfill_runs`' device): a page that swallowed a subject cannot write
  a row at all, and a sweep that measured nothing produces the output of a clean
  one without it. The metrics surface reports `signalsFromRecords` counted off the
  evidence beside the run's own counter, with `countsAgree`.
- **An evaluation cites its policy version by a NOT NULL COMPOSITE foreign key**
  onto the run (the `match_category_gates` device), so a row naming a different
  policy from the run that produced it is UNREPRESENTABLE rather than merely
  wrong. The composite target is a `unique()` CONSTRAINT and not a
  `uniqueIndex()`: drizzle-kit emits every `ADD CONSTRAINT … FOREIGN KEY` before
  every `CREATE UNIQUE INDEX`, so a foreign key targeting an index fails at apply
  time with `42830`.
- **Both `subject_key` columns are GENERATED**, the #78 `series_key` reason:
  Postgres treats NULLs as distinct and `canonical_product_id`,
  `canonical_variant_id` and `market` are each legitimately NULL, so a plain
  multi-column unique would let a resumed run write a subject twice and let a
  merchant file the same open report twice.
- **`price_signal_feedback`'s open partial unique is predicated on `resolved_at
  IS NULL`, not on `status = 'open'`.** They are the same set by the resolution
  CHECK, and a NULL predicate is the one a partial index expresses without a
  second copy of the status vocabulary.
- **The policy trigger freezes every column that decides what a claim MEANS once
  the row leaves `draft`, and freezes NONE of the lifecycle.** Freezing `status`,
  `activated_at`, `superseded_at`, `archived_at` or `approved_by_oxy_user_id`
  would make activation and rollback impossible; the realdb suite asserts both
  halves, because a trigger refusing everything would pass a test that only
  checked the refusal.
- **The evaluation trigger refuses UPDATE and PERMITS DELETE**, inverting the
  ledger's posture and matching `analytics_events` and #78's snapshots. A
  measurement that can be rewritten measures nothing; retention on a schedule is
  an operator decision, and a trigger refusing DELETE would make it fail silently.
- **Every reference to a mergeable entity is `retained_by_tombstone`** in
  `merge-plan.ts`. An evaluation records what the prices of THAT identity looked
  like at a point in time and a correction report is a complaint about a claim
  published concerning it; repointing either would attribute one product's
  measurements — or one merchant's complaint — to another, and the next sweep
  produces fresh rows for the merged catalogue under the winner anyway.
- **`price_signal_runs.cursor_canonical_product_id` carries NO foreign key** and
  is ledgered in `ID_COLUMNS_WITHOUT_FOREIGN_KEY` as a keyset CURSOR: a foreign
  key would make a resumable run un-resumable the moment its cursor product was
  merged away, because the cursor would be RESTRICTed or nulled and either outcome
  silently restarts the sweep from the beginning.

## Price history (#78)

`offer_price_snapshots`, `offer_price_series`, `offer_price_points`,
`offer_price_write_metrics`. ADR 0002 D18 assigned a price-history TABLE to #78
and left #57 holding current state; these are that table, plus the derived
answer a chart reads and the counters that make the derivation's health
observable. Full reference: `docs/price-history.md`.

- **`offer_price_snapshots` carries NO canonical, merchant or storefront id**,
  and that omission is what makes issue operations 4 — "preserve history through
  offer, product and merchant merge workflows" — hold with no write and no
  census entry. The offer names all four; #59's `offers` phase repoints the
  offer; one rebuild picks up the loser's whole history under the winner. It is
  #57's own reasoning for refusing a canonical product id on `offers` (a
  denormalized copy is a second representation a merge can put out of step with
  the first) with one addition: here the copy would be UNFIXABLE, because the
  row is immutable.
- **`item_price_amount` is NOT NULL, which is snapshot policy 5 as a shape.** "A
  source outage does not create a false unavailable or zero-price point" is
  strongest as a table in which a priceless observation has no row: there is
  nothing for a chart to read as zero and nothing for a later `coalesce` to turn
  into one. The writer skips such an offer and COUNTS the refusal.
- **`item_price_currency` carries #57's OPEN shape check and
  `offer_price_points.native_currency` carries the presentment tuple's.** An
  observation records what a platform SAID, so narrowing it there would refuse
  the observation rather than the comparison; only a convertible currency can
  become a POINT, so a value outside the tuple there would mean raw minor units
  had been compared across currencies (currency rule 6).
- **`cardinality(change_reasons) >= 1`, never `array_length(...) >= 1`.**
  `array_length` of an empty array is NULL, a CHECK rejects only FALSE, and the
  obvious spelling ADMITS exactly the row it exists to refuse. Measured twice in
  #68 and once in #108 before this file was written; the realdb suite pins it
  with an empty-array fixture, which is the only fixture that can tell the two
  spellings apart.
- **`offer_price_points`' five FX columns are present EXACTLY when a conversion
  happened**, and `fx_from` must equal the point's own `native_currency` — one
  biconditional CHECK. A converted amount whose rate is unidentifiable is
  precisely what currency rule 4 forbids; an unconverted amount carrying a rate
  claims a conversion that did not happen. `fx_to` cannot be checked here (it is
  a column of `offer_price_series`), so the derivation asserts it and a realdb
  case pins it — what the constraint holds is the half a service bug plausibly
  gets wrong.
- **`snapshot_id` is NOT NULL and CASCADEs**, which is the one place this domain
  accepts data loss and the reason acceptance 6 is true at every instant rather
  than true until a sweep runs. A source whose agreement requires deletion takes
  its chart with it; the alternative — a nullable reference — leaves a point
  asserting a price with nothing behind it.
- **The immutability trigger refuses UPDATE and PERMITS DELETE**, inverting the
  ledger's posture and matching `analytics_events`. Erasure on a schedule is the
  policy here: `retention_expires_at` is stamped at write time from the SOURCE's
  own `catalog_source_policies.cache_ttl_seconds`, and a trigger refusing DELETE
  would make the shared expiry sweep fail silently on every row it was
  contractually obliged to remove. NULL — no source-imposed deadline — is the
  ordinary case and the sweep never touches it (`notifications.dismissed_at`'s
  shape).
- **`supersedes_snapshot_id` is a self-reference with NO `onDelete` action**, so
  a retention sweep that removed a corrected observation while its correction
  survived is REFUSED rather than leaving a correction pointing at nothing.
- **No condition GROUP column on a snapshot.** It is
  `CONDITION_KEY_GROUP[condition_key]`, total by construction; storing it would
  be a second representation one derivation away. `offer_price_points.segment`
  IS stored, because a point is ABOUT one segment — which is what makes
  acceptance 2 impossible to get wrong by forgetting a filter.
- **`offer_price_series` is two nullable scope columns plus a `case … else
  false` CHECK**, the `carts` owner device: a polymorphic `scope_id` would carry
  no foreign key and could name a deleted entity forever. Its `series_key` is
  GENERATED, because Postgres treats NULLs as distinct and both
  `canonical_product_id` and `market` are legitimately NULL.
- **The series ROW is the job** (`payment_provider_events`' rule), with
  `offer_outboxes`' `DO UPDATE` enqueue rather than the moderation outbox's `DO
  NOTHING`: a series is a request for a FIXED POINT, so five observations in a
  second owe one rebuild. The conflict branch must NOT write a flat `'pending'`
  over a `processing` row — measured in #57, it releases a live lease from
  outside the worker.
- **`covered_from`/`covered_through` are what make a GAP distinguishable from an
  UNBUILT range.** Without them "no point in this bucket" means both "nobody was
  offering this" and "the rebuild has not reached here", and only one of those is
  a fact about prices.
- **`offer_price_write_metrics` is the one place in the domain that
  INCREMENTS**, because a deduplicated observation leaves no row: counting rows
  answers "how much did we keep" and never "how much did we suppress". Keyed per
  DAY and per SOURCE — the second is the load-bearing half, because one global
  row per day is a hot row every ingestion write in the fleet would contend on.
  Its `metric_key` is GENERATED for the NULLs-are-distinct reason, since
  `source_id` is legitimately NULL for a native offer.

## Price alerts (#79)

Five tables: `price_alerts`, `price_alert_evaluations`, `price_alert_triggers`,
`price_alert_trigger_quotes`, `price_alert_notifications`. Full reference:
`docs/price-alerts.md`.

- **`price_alert_triggers_identity_key` is
  `(alert_id, offer_id, observed_price_version, alert_policy_version)`** — the
  four facts `priceAlertTriggerKey` names, and NO clock. The observed-price
  version is `offer_price_snapshots.id` (#78), so "the same price, re-read" is
  recognisable; a timestamp instead would make every sweep a new identity, which
  is the duplicate-notification bug the whole domain is shaped around.
  `observed_price_version` is NOT NULL for a Postgres-specific reason: a NULL in
  a unique index is DISTINCT from every other NULL, so a nullable column there
  would let every evaluation insert another row.
- **There is deliberately no unique on `(oxy_user_id, canonical_product_id)`.**
  A buyer legitimately holds "under 500 new" and "under 300 used" on one phone —
  #80's saved PRODUCT is one interest per buyer and is unique for that reason,
  while an alert is a CONDITION. The consequence is stated in `merge-plan.ts`:
  nothing is unique here, so every rehome is an unconditional `repoint` with no
  absence guard to get wrong.
- **`price_alerts_subject_idx` is COMPOSITE with the state and PARTIAL on
  `enabled`.** The evaluator must read by product; a bare index on
  `canonical_product_id` would make "who is watching this" a cheap question, and
  issue abuse rule 6 says no merchant-facing surface may answer it.
- **A repeat policy carries EXACTLY the input it needs**, both directions, two
  CHECKs. Without the "required" half an alert could claim `reset_threshold`
  with nothing to re-arm against — `once` under another name; without the
  "forbidden" half a threshold could sit on an `always` alert and read, to
  whoever looked next, as a rule being applied.
  `price_alerts_reset_above_target_check` is the third: a threshold at or below
  the target can never be crossed by a price that was under the target.
- **`(a is null) >= (b is not null)` is NOT an implication, and it cost a real
  bug here.** `price_alerts_last_triggered_shape_check` was first written that
  way to mean "an amount implies an instant"; it evaluates to the OPPOSITE
  implication and rejected every trigger the domain wrote. `tsc` and every
  mocked insert accepted it and the real-server suite caught it on its first
  run. Any future one-way implication in this schema is written
  `A is null or B is not null`.
- **There is no `armed` boolean.** Whether a `reset_threshold` alert may fire
  again is `rearmed_at > last_triggered_at`, two timestamps that each record a
  real event. A boolean beside them is a second representation of one fact.
- **Quiet hours are three columns or none** (a CHECK): a window with no zone is
  a window in the SERVER's time, which is not a fact about the buyer's night.
- **An ambiguous alert names its split job AND is `paused`** — two CHECKs, not
  one. The pause is the buyer-visible half and the resolution state is the
  reason; what the second refuses is an ambiguity that leaves the alert live,
  which would keep notifying about a product the buyer may not have meant. #80's
  saved product needs no such pause: a save on the wrong side shows the wrong
  page, an alert on the wrong side goes and tells somebody.
- **`price_alert_evaluations` is ONE row per canonical PRODUCT**, unique, with
  `offer_outboxes`' revision pair and its `DO UPDATE` enqueue — a convergence
  queue, so forty offer writes on a popular product owe one evaluation (issue
  abuse rule 2). Its `last_evaluated_alerts` / `last_qualified_alerts` are the
  VACUITY floor (`catalog_backfill_runs`' device): a subject with forty alerts
  reporting zero evaluated is a broken read, and a table of triggers can only
  ever show the runs that produced one. A CHECK holds `qualified <= evaluated`.
- **`price_alert_trigger_quotes` is a CHILD table and not ten columns**, because
  a `known_total` legitimately converts two components from two source
  currencies. "A quote exists exactly when a conversion happened" is CROSS-ROW
  and no CHECK can see it, so `insertPriceAlertTrigger` is the SINGLE writer and
  refuses a mismatch before issuing SQL — `insertRetailCostQuote`'s device.
  `price_alert_trigger_quotes_distinct_check` refuses `from = to`: a row saying
  nothing happened is not evidence.
- **`price_alert_triggers_basis_shape_check` refuses a delivery cost on an
  `item_price` trigger.** Not tidiness: a delivery figure beside an item-price
  comparison is exactly what somebody later reads as "the total was this", which
  is the unknown-shipping confusion acceptance 2 exists to keep apart.
  `price_alert_triggers_satisfies_target_check` refuses a trigger whose amount
  does not satisfy the target it names.
- **`price_alert_notifications.id` is DETERMINISTIC and has no default** —
  `sha256(trigger_id + ':' + channel)`, the `moderation_outboxes` decision, so a
  repeat converges on the same row rather than queueing a second message about
  one piece of news.
- **`suppressed` is a terminal STATE with a coded reason**, never a delete and
  never a skip: issue operations 3 asks for stale-link suppression to be
  monitored and a table of messages that were sent cannot answer it. Two paired
  CHECKs hold the shape — a `delivered` row has an instant and nothing else
  does, a `suppressed` row has a reason and nothing else does.
- **`notification_id` is `SET NULL` and not CASCADE.** The ninety-day retention
  sweep reaps a dismissed `notifications` row; the delivery RECORD outlives it,
  and losing the delivery history to a retention rule about a feed entry would
  make issue notification 6's outcomes unanswerable for old alerts. It is also
  the ONLY way `openedAt` is answered — `notifications.read_at` is the one place
  "they read it" is stored, so `PriceAlertNotificationState` has no `opened`
  member.
- **`price_alerts.rehomed_from_canonical_product_id` carries NO foreign key**,
  unlike every other canonical reference in the table, and is registered in
  `ID_COLUMNS_WITHOUT_FOREIGN_KEY`: it is a historical statement about where the
  alert used to point, and a constraint on it would tie a buyer's own record to
  the continued existence of a tombstone somebody may later prune.
- **No contact column of any kind exists** — not an address, not a hash, not a
  push token. The transactional channel is Oxy's own notification service, which
  already holds the registrations; a copy here would be a second retention
  obligation with no owner and would put a buyer's inbox one join from a
  catalogue table. `oxy_user_id` is the whole of what this domain stores about a
  person, which is why erasure is one scoped DELETE and everything CASCADEs from
  the alert.

## Zero-profit cost reconciliation (#128)

Ten tables — `retail_reconciliation_policies`,
`retail_reconciliation_tolerances`, `retail_reconciliations`,
`retail_reconciliation_components`, `retail_reconciliation_evidence`,
`retail_reconciliation_exceptions`, `retail_customer_adjustments`,
`retail_supplier_credits`, `retail_ledger_recognitions` and
`retail_reconciliation_operator_actions` — plus five CHECK widenings on tables
other domains own. Full reference: `docs/retail-reconciliation.md`.

- **The tolerance CHECK is a rendered `CASE`, and `else -1` is load-bearing.**
  `retail_reconciliation_tolerances_bound_check` bounds the tolerance per
  currency from `RETAIL_RECONCILIATION_MAX_TOLERANCE_MINOR`, because one integer
  means five hundredths of a euro and five hundred-millionths of a FAIR. A CASE
  with no matching branch yields NULL, a comparison against NULL is NULL, and a
  CHECK rejects only FALSE — so the obvious spelling would SATISFY the constraint
  for exactly the currency it failed to cover. Any future rendered `CASE` in this
  schema needs the same `else`.
- **`retail_reconciliations_outcome_shape_check` is a biconditional**, so an
  incomplete reconciliation has NO verdict. That is #128 acceptance 7 as a row
  shape: the fabricated zero it prevents produces the whole customer amount as a
  surplus.
- **`retail_reconciliations_variance_check` writes every branch as
  `(outcome = 'x') = (<condition>)`, in full parentheses.** The shorter
  `outcome <> 'x' or <cond>` constrains ONE direction, so a row could carry
  `mercaria_absorbed` with a positive variance as long as it also failed to be
  `customer_adjustment_required`. And SQL binds `AND` tighter than `OR`, so a
  chain of those without parentheses does not mean what it reads as.
- **Amounts are non-negative MAGNITUDES; the COMPONENT carries the sign**
  (`RETAIL_COMPONENT_ROLES`). A signed column would let one writer record a
  supplier credit as a negative cost and another as a positive recovery, and both
  would balance while meaning opposite things.
- **`retail_ledger_recognitions` is the claim every posting takes**, keyed
  `(kind, claim_key)` where the key names the durable thing the posting is ABOUT
  — a purchase order, a revision, an adjustment — and never a run id or a
  timestamp, both of which would make every claim unique and defeat the index
  silently.
- **`retail_supplier_credits` is strictly append-only because recording and
  booking are ONE transaction**: the row is inserted with its
  `ledger_transaction_id` already set, so there is no later UPDATE for the trigger
  to refuse. The alternative — a nullable pointer filled in afterwards — would
  have needed the `retail_cost_quote_acceptances.order_id` one-way exception.
- **`retail_customer_adjustments.superseded_by_id` carries NO foreign key.** It
  is a SELF-reference, which `drizzle-kit generate` silently drops from both the
  migration and the snapshot (measured on #66's
  `awin_advertisers.activating_sample_id`), so it is a plain column registered in
  `ID_COLUMNS_WITHOUT_FOREIGN_KEY` and the one-way CAS in `supersedeAdjustment`
  is what enforces the chain.
- **`retail_reconciliation_operator_actions.order_id` carries no foreign key
  either**, and that one is deliberate rather than forced: an audit trail a
  cascade could delete is not one, and an attempt against an order that turns out
  not to exist is exactly the attempt a review most wants to see.
- **There is no `finalised_at` column.** ADR 0004 D8.6's finality is the latest of
  three LIVE conditions bounded at 180 days from delivery, derived at projection
  time — the `deriveNativeCheckoutEligibility` divergence, and the place two
  representations must not disagree is the decision to stop owing a buyer money.
- **`LEDGER_OWNER_TYPES` gained `supplier`** for `supplier_prepaid`. A supplier
  is Mercaria's B2B counterparty with no storefront, no connected account and no
  order here, so filing its deposit under `store` or `user` would put a wholesale
  balance into the key space every payable query reads.
## Private watchlists (#81)

Four tables, no source model: `watchlists`, `watchlist_items`,
`watchlist_snapshots`, `watchlist_snapshot_items`. A GROUPING with a purpose,
plus the bounded, reproducible record of what that group cost at the moments it
was evaluated. Behaviour: **`docs/watchlists.md`**.

- **`watchlists.version` is the optimistic-concurrency token and the LIST is the
  unit.** Every mutation of the list OR of one of its items is a
  compare-and-swap on it, in one statement, with `oxy_user_id` in the SAME
  predicate — "is this mine" and "is my copy current" are one question at the
  database, so there is no window between finding a list and checking it. A
  per-item token would let a reorder computed against one membership be applied
  to another, which is the case a token exists to catch.
- **`display_currency` is NOT NULL and `market` is nullable.** A basket total
  has to name a currency, so a list without one could not be evaluated at all; a
  market is a NARROWING, and its absence is what #74's comparison already does
  with no market. `market` is CHECKed `~ '^[A-Z]{2}$'` rather than length-checked
  — the comparison upper-cases what it is given, so a lower-case value stored
  here would narrow nothing while looking like a restriction that was applied.
- **`UNIQUE(watchlist_id, canonical_product_id)`** is what makes an add
  idempotent under a double tap AND what a product merge converges on
  (`repoint_if_absent` guarded on `watchlist_id`, #80's device). A list holding
  both sides of a merge keeps the loser-side row on the tombstone, and the
  evaluation derives `product_merged_into_existing_item` for it — so the basket
  counts the product once rather than twice.
- **`position` is deliberately NOT unique.** Ordering is `(position, added_at,
  id)`, a TOTAL order, so ties break deterministically. A unique would turn every
  reorder into a two-phase renumber or a DEFERRABLE constraint that leaves the
  list unreadable to a concurrent transaction mid-reorder.
- **`watchlist_items.note` is in `PROTECTED_COLUMNS`** — the `customers.email`
  situation exactly: the evaluation reads items WHOLE and writes snapshot rows
  from what it read, so a `select()` plus a spread is all it would take for a
  person's free text to reach a durable table. The owner's own read names every
  column explicitly (`OWNER_ITEM_COLUMNS`), which is what the registry's opt-in
  is for and what makes that one read visibly different from every other.
- **`watchlist_snapshots_item_counts_check` is a VACUITY FLOOR** —
  `item_count = priced + unresolved`, equality and never `<=`, #60's
  `catalog_backfill_runs_counters_total_check` for its reason. The cross-row half
  (do those counters describe the lines being inserted) is the repository's, the
  `insertRetailCostQuote` device.
- **`cardinality(material_changes) >= 1`, NEVER `array_length`.** On an empty
  array `array_length` is NULL and a CHECK reads NULL as SATISFIED, so the
  obvious spelling admits exactly the row it refuses. Measured in #68 and #108;
  this is the third table to state it and the realdb suite pins it.
- **`watchlist_snapshots_total_shape_check` ties completeness to the total**:
  `completeness <> 'unknown'` exactly when both `total_amount` and `basis` are
  present, #120's completeness ⇔ presentation constraint.
- **`content_digest` is NOT unique**, deliberately. A total that returns to a
  previous value weeks later is a new observation and must be storable; the
  dedupe compares against the LATEST snapshot only, under a `FOR UPDATE` lock on
  the list row.
- **The line shape is THREE CHECKs, and the third was found by the realdb
  suite.** A `priced` biconditional and an `unresolved` biconditional both
  evaluate false for an unresolved line carrying a price, so the obvious pair
  ADMITS the row #81 item rule 7 exists to forbid.
  `watchlist_snapshot_items_unresolved_empty_check` enumerates the fifteen
  columns such a line must not carry, with `num_nonnulls`, so a column added
  later has to be added there too.
- **The FX quote is a `case` biconditional**, #78's
  `offer_price_points_fx_shape_check`: five columns present exactly when a
  conversion happened, `fx_from` equal to the line's own native currency and
  `fx_to` to the display currency. A same-currency line carries NO quote, which
  is correct — `fx.convert` returns the input object byte-identical on an equal
  pair.
- **`selected_offer_id` and `selected_canonical_variant_id` carry NO foreign
  key** (`ID_COLUMNS_WITHOUT_FOREIGN_KEY`). `offers` CASCADEs from `listings`
  (#57 chose that so a seller deleting a listing is never blocked), so an FK
  would DELETE the history #81 correction rule 5 exists to keep — silently, and
  exactly when the offer that made a price interesting went away.
- **`watchlist_item_id` is `ON DELETE SET NULL` and `canonical_product_id` is
  RESTRICT.** Removing an entry must not erase what it once cost; a line must
  still say WHAT was priced afterwards.
- **A snapshot is APPEND-ONLY against UPDATE and DELETE is PERMITTED** — the
  `analytics_events` / `offer_price_snapshots` posture, inverting the ledger's.
  Erasure on a schedule IS the retention policy, so a trigger refusing DELETE
  would make the shared expiry sweep fail silently on every row it was meant to
  remove. The LINE trigger permits exactly one update — `watchlist_item_id`
  going NULL — which is the referential action the schema itself declares.
- **No demand aggregate, no share token, no follower column, and only
  `watchlists` carries an account id.** Each absence is the enforcement of a #81
  privacy rule, and `watchlist-isolation.test.ts` scans for all of them.

## Natural-language shopping intent (#95)

`db/schema/searchIntent.ts` — four tables, and the interesting decisions are
about what they deliberately do NOT hold.

- **No raw query text exists anywhere in this domain, and there is no column one
  could occupy.** `search_intent_turns.redacted_query` holds what #77's
  `redactSearchQuery` produced and nothing else. That resolves a genuine tension
  rather than sidestepping one: #95 clarification rule 3 asks that the ORIGINAL
  query be preserved and safety rule 7 asks that #77's redaction and retention
  policy apply, and the two pull in opposite directions. Rule 7 wins, and rule 3
  is satisfied on the CLIENT side, which is where the original already lives —
  the shopper typed it, the share-safe URL carries it, and a clarification
  answer re-submits it. The cost is stated rather than hidden: a shopper who
  loses their tab loses the query, and an operator tracing an interpretation
  sees the redacted form.
- **`search_intent_sessions` follows `carts`' owner shape exactly**: an Oxy id
  carries no foreign key (Oxy owns identity) while a guest session id MUST, `ON
  DELETE CASCADE`, so purging a guest credential purges the clarification state
  derived from it with no sweep involved. The `anonymous` branch has NEITHER and
  is a real state rather than a gap — most shopping traffic carries no
  credential, and refusing to clarify for those shoppers would make the feature
  reachable only after somebody had put something in a cart. Such a session is
  addressed by its id alone; what that id grants is almost nothing, because the
  surface never reads a session back to a client.
- **The owner CHECK is a biconditional per kind**, not merely a mutual
  exclusion. An Oxy id on an `anonymous` row would make the ownership predicate
  answer about the wrong subject, so each kind requires its own column present
  AND the other two absent.
- **`search_intent_turns` carries the fallback BICONDITIONAL as a CHECK**:
  `(mode = 'deterministic') = (fallback_reason is not null)`. A model turn
  carrying a reason inflates the fallback rate and a deterministic turn carrying
  none leaves a fallback nobody can attribute — the row exists to make that rate
  computable, so both shapes are unrepresentable rather than discouraged.
- **`query_event_id` is #77's own correlation handle and is NOT a foreign key.**
  It is what makes "compare parsed and fallback search quality" (#95 acceptance
  8) answerable without adding a single column to the analytics domain, and the
  two halves are swept on their own retention clocks — a foreign key would make
  #77's erasure either delete this row or block itself.
- **Neither table has an append-only trigger, and that inverts
  `analytics_events`' posture deliberately.** The rows are written once and never
  updated by any code path, so a trigger would guard against a writer that does
  not exist — and the DELETE the retention sweep performs would then need an
  exception, which is exactly the shape that makes a retention failure silent.
  Both are registered in `db/expiryTargets.ts`, and for the turn the sweep IS
  the erasure.
- **`search_intent_enablements` cites its measurement by a NOT NULL COMPOSITE
  foreign key** onto `search_intent_benchmark_runs (id, dataset_digest)` — the
  `match_category_gates` device, and #95 acceptance 7 as a constraint rather
  than a process. `restrict` rather than `cascade`: deleting a run an enablement
  rests on would leave the parser enabled with its justification gone. The
  target is a `unique()` CONSTRAINT and never a `uniqueIndex()`, because
  drizzle-kit emits every FK before every `CREATE UNIQUE INDEX`.
- **TWO partial uniques on the enablement, not one plain unique**, because
  Postgres treats NULLs as DISTINCT: a `unique(category_id, language)` would
  admit any number of language-wide rows for one language and the service would
  read whichever it found first. A NULL `category_id` IS the language-wide row,
  and the gate requires BOTH it and the category row.
- **Every benchmark measure is a COLUMN**, the `ranking_policy_versions`
  decision: a jsonb bag would let a run report whatever its author found
  flattering, and a number whose definition is unstated cannot be stored.
  Adding a measure needs a column and a migration, which is the right amount of
  friction for changing what "the parser is good enough" means.
- **`search_intent_benchmark_runs.category_id` and the enablement's carry no
  foreign key** (registered in `deferredForeignKeys.ts`): a recorded
  measurement must not be deletable by a catalogue change, and `restrict` would
  make a category undeletable because somebody once benchmarked it.

## Retail service requests (#127)

`retail_service_requests`, `retail_service_request_lines`,
`retail_service_request_evidence`, `retail_service_request_events`,
`retail_service_policy_exceptions`, `retail_return_cases`,
`retail_return_case_lines`, `retail_return_line_dispositions`,
`retail_warranty_cases`, `supplier_return_authorizations`,
`supplier_recoveries`, `retail_dispute_coordinations`. Full reference:
`docs/retail-service-requests.md`.

- **The wall down the middle is ONE column.** The CUSTOMER half carries no
  supplier amount, no supplier state and no purchase-order reference; the
  SUPPLIER half carries no customer amount and no refund pointer.
  `supplier_recoveries.service_request_id` is the only join and it points from
  the supplier side to the customer side, never back — ADR 0004 D8.5 as a shape,
  gated by `retail-service-isolation.test.ts` and mutation-tested.
- **TWO deadline columns, never one.** `statutory_deadline_at` and
  `commercial_deadline_at`, with the effective one derived as the LATER of them.
  A single column cannot express "a supplier's narrower policy may not reduce a
  statutory right": by the time the two are one number the narrower one has
  already won and nothing records that it did. `supplier_response_due_at` is a
  THIRD clock that bounds nothing on the customer side and drives no transition
  (#127 policy rule 9).
- **No ledger account and no ledger pointer anywhere.** ADR 0004 D7 assigns the
  five retail accounts and four transaction kinds to #128 *together with the code
  that writes them*, so this domain classifies and #128 books —
  `retail_cost_variance_records`' division (#123), for the same reason.
- **`cardinality`, never `array_length`,** on
  `retail_service_policy_exceptions.excluded_kinds`. `array_length(col, 1)` is
  NULL on `{}` and a CHECK reads NULL as SATISFIED, so the obvious spelling
  admits exactly the row it refuses — an exception that excludes nothing while
  claiming to. Pinned by a real-server case.
- **A policy exception's SOURCE is a disjoint union.**
  `RETAIL_POLICY_EXCEPTION_SOURCES` (statutory instrument, Mercaria policy) and
  `RETAIL_FORBIDDEN_POLICY_EXCEPTION_SOURCES` (six a supplier could supply) share
  no member, so a supply agreement's narrower returns policy has no value it
  could be recorded under. Four eyes is `reviewed_by <> requested_by` at the row;
  immutability once published is a trigger; one LIVE exception per (market,
  category) is a partial unique.
- **Quantities SUM; they are never counters.**
  `retail_return_line_dispositions` is append-only against UPDATE *and* DELETE,
  and the cross-row cap lives in the repository with the case line locked
  `FOR UPDATE`. A mutable `received_quantity` is how two concurrent scans both
  read three and both write six. Only `shipped` consumes a unit's returnability
  (`RETAIL_RETURN_CONSUMING_DISPOSITIONS`) — capping `received` would refuse a
  supplier reporting receipt of units a buyer over-declared, which is a real
  event. There is NO amount column: `credited` is recorded here so an operator
  sees both sides, and the money is on `supplier_recoveries`.
- **A GUEST can never be the decider.** The actor CHECK alone would accept one,
  so `retail_service_requests_decider_authority_check` names the three kinds that
  may. Mercaria decides a retail remedy (#127 responsibility rule 2).
- **An outcome moves NULL → value exactly once.** The trigger permits the
  decision and REFUSES value → value, the `orders.claimed_by_oxy_user_id` device
  (#106): a service bug cannot silently re-decide a remedy the buyer was already
  told about, and re-deciding is a NEW request.
- **A release of a refund suspension is all-or-none.**
  `retail_dispute_coordinations_release_shape_check` demands a reason, an actor
  AND an instant together. The word in #127 rule 10 is *unnoticed* — a deliberate
  double payment is sometimes right, and an unnoticed one never is.
- **`supplier_recoveries.service_request_id` is `ON DELETE SET NULL`** while
  every other reference in the domain is RESTRICT or CASCADE. A recovery outlives
  the customer matter it arose from: a credit note can arrive after a request is
  closed, and losing the recovery would lose money Mercaria is owed.
- **The evidence `file_id` is an OXY id and is CHECK-refused as a URL.** Never a
  `mercaria.co` one — a reviewer's browser fetching such a URL would tell this
  host when its content is being looked at (`abuse_reports`' posture, #110's
  before it). The service refuses one too; both are needed, because the service
  protects the ordinary path and the CHECK protects a backfill, a replay and
  `psql`.
## Merchant demand analytics and the acquisition pipeline (#86)

Seven tables: `merchant_demand_snapshots` + `merchant_demand_metrics` +
`merchant_demand_products` (the reproducible reporting record) and
`merchant_acquisition_candidates` + `merchant_acquisition_contact_sources` +
`merchant_acquisition_outreach` + `merchant_acquisition_audits` (the internal
workflow). Domain reference: `docs/merchant-demand.md`.

### There is no `value` column and there is no `total` column

A count, an amount and a rate are three shapes and each gets its own columns on
`merchant_demand_metrics`, with CHECKs rendered from
`MERCHANT_DEMAND_MONEY_METRIC_KEYS` and `MERCHANT_DEMAND_RATE_METRIC_KEYS`
deciding which may be present for which key. A single numeric `value` with a
unit beside it is how a currency ends up added to a click count, and #86's
"keep affiliate commission, external order value, native GMV and inferred demand
as separately labelled metrics" is the instruction not to build that. `kind` is
STORED rather than looked up, for `analytics_rollups.source`'s reason: "which of
these numbers is money somebody else reported" has to be answerable by a query.

An unmeasurable metric is STORED with `unavailable_reason` and no value.
Omitting the row would make "we did not measure it" and "this version has no
such metric" the same absence.

### `aggregate_basis` is what stops a partial total wearing a full name

A product-composed figure and the product breakdown beside it are ONE partition:
the disclosed rows plus at most one residual over the withheld ones. When too
few products are withheld for the residual to hide them
(`MERCHANT_DEMAND_RESIDUAL_MIN_CONTRIBUTORS`, 2) it is folded away and the
figure covers the disclosed rows only — a different number, so it carries a
different basis. The column is NULL for every metric with no breakdown to be
differenced against, and a CHECK refuses it beside a suppressed or unavailable
row: a basis describes a figure, and those have none.

### The dimension columns are `''`, never NULL

`market`, `channel`, `storefront_id` and `source_id` are NOT NULL with NO
DEFAULT — the `analytics_rollups` rule. A NULLable dimension breaks the bucket
unique outright (Postgres treats NULLs as distinct) and a `DEFAULT ''` is the
convention violation this file refuses; with neither, every writer states which
bucket it means. `storefront_id` and `source_id` therefore carry no foreign key
and are ledgered in `ID_COLUMNS_WITHOUT_FOREIGN_KEY`: the empty string is not a
storefront, and a snapshot outlives the channels and sources it describes.

### `superseded_by_id` carries no foreign key, and the write order is why

The partial unique permits ONE live snapshot per `(merchant, market, window)`,
so the outgoing snapshot must be stamped superseded BEFORE its replacement is
inserted; and `superseded_at`/`superseded_by_id` travel together by CHECK, so
the successor must be NAMED one statement before it exists. A real foreign key
would refuse exactly that statement. The id is minted with `uuidv7()` in
`insertMerchantDemandSnapshot`, the only writer.

### The coverage counters are an EQUALITY check

`products_offered = product_rows_disclosed + product_rows_suppressed`, not
`<=` — #60's `catalog_backfill_runs` vacuity floor applied to a report. A build
that lost a product row between counting and writing cannot store the row at
all, so "I found fewer" and "there were fewer" stop looking identical.

### DELETE is permitted; UPDATE is not

`mercaria_merchant_demand_snapshot_immutable` permits only
`superseded_at`/`superseded_by_id` moving NULL → a value once; the two child
tables refuse UPDATE outright. All three PERMIT DELETE, inverting the ledger and
matching `analytics_events` and `offer_price_snapshots`: erasure on a schedule is
the policy, `expires_at` is registered in `db/expiryTargets.ts`, the children
CASCADE, and a trigger refusing DELETE would make the sweep fail silently.

`merchant_acquisition_outreach` and `merchant_acquisition_audits` refuse BOTH
and carry no `expires_at` at all — a retention clock on the record of what
people decided destroys the evidence it exists to keep.

### No column in the domain can hold a contact

There is no `email`, `phone`, `contact_name` or `contact_value` column in any of
the seven tables, and a test walks the real drizzle tables to keep it that way.
`merchant_acquisition_contact_sources` stores WHERE a public business contact is
published — kind, https URL, a locator note, who recorded it — which is the
strongest reading of #86 privacy 7: a prohibition on where a value came FROM is
a rule, and nowhere for a value to LAND is a fact. `locator_note` is
shape-CHECKed against an at-sign and a five-digit run, because it is the one
place a note could quietly become the value it points at.

### A regex repetition count above 255 fails at INSERT time

`source_url ~ '^https://[^[:space:]]{3,500}$'` generates cleanly, applies
cleanly, and then refuses EVERY row with `invalid repetition count(s)` — the
CHECK's regex is compiled when a row is checked, not when the constraint is
added. PostgreSQL caps a repetition count at 255. Any length bound above it in
this schema is a `length()` call, never a `{m,n}`.

### The claim verdict is not duplicated here

`merchant_acquisition_candidates` has no claim column, no `claimed_at` and no
`is_claimed`. `merchants.claim_state` is ADR 0002 D9's one stored verdict and
#83 is its only writer; the conversion funnel is derived on read from it, from
`native_store_links`, from `provider_accounts.onboarding_state` and from the
presence of an active native offer. A copy here would be the one that goes stale
the moment a claim is revoked, on an operator's screen.

## The "Sell yours" seller draft (#91)

`seller_listing_drafts`, `seller_draft_condition_details`, `seller_draft_images`
and `seller_draft_match_assertions` — one in-flight flow that becomes exactly one
P2P listing. Reference: `docs/sell-yours.md`.

- **There is no canonical TEXT on any of these tables.** No prefilled title,
  brand, model or attribute is stored: the draft holds what the SELLER typed and
  a read joins the canonical row for the rest. A stored copy would be a second
  representation of a fact the graph already owns, and a merge, a rename or a
  correction would leave a half-finished listing describing a product under its
  old name — which the seller would then publish.
- **Four columns point at `canonical_products` / `canonical_variants` and each
  has a merge disposition.** The DRAFT is `repoint`ed (after a merge that IS the
  same product, and a draft left on a tombstone publishes an attachment to a dead
  identity); the ASSERTIONS are `retained_by_tombstone`, because an assertion
  records what a person declared THEN and could not be repointed anyway — the
  table refuses UPDATE.
- **`published_listing_id` moves NULL → value exactly once**, held by a trigger
  permitting NULL→value and value→NULL and refusing value→value. #106's
  buyer-origin trigger, for its reason: the refusal is what makes "repeated
  submits create one listing" impossible for a service bug to get wrong. The
  `published` CHECK is stated on `published_at`, NOT on the id — the id may
  legitimately become NULL again when a seller deletes the listing, and a
  biconditional on it would turn that deletion into a constraint violation.
- **`seller_draft_match_assertions` is append-only with #90's PRECISE delete
  exception**: UPDATE always refused, DELETE refused only while the parent draft
  still exists. An unconditional delete refusal makes the `ON DELETE cascade` on
  `draft_id` fail, so a draft carrying any assertion becomes undeletable and an
  erasure request against it fails at the database. The first version of the
  trigger had exactly that bug and the realdb suite caught it in the TEARDOWN.
- **`cardinality(blockers) >= 1`, never `array_length`.** A `gate_refused` row
  that named no blocker explains nothing, and `array_length` of an empty array is
  NULL, which a CHECK reads as SATISFIED — the obvious spelling admits exactly
  the row it exists to refuse. Measured twice before in this schema (#68, #108).
- **A match state and its ids cannot disagree.** `unmatched` and
  `seller_rejected` carry NO product — a rejection that kept the id it rejected
  would read, to every consumer, exactly like a proposal — and everything else
  carries at least a product, because #58 resolves product identity before
  variant identity and "matched the model, not the configuration" is real.
- **Coordinates are stored ALREADY COARSENED**, rounded at the write boundary by
  `coarsenSellerCoordinate`. Rounding at read time would leave the precise
  position in the table, in backups and in every operator query — a privacy
  property that depends on each reader remembering is not one.
- **`included_accessories` is a `text[]`; what is MISSING is not here.** A
  missing part is #90's `missing_accessory` condition detail, which carries a
  mandatory note and counts toward the disclosure gate. Two vocabularies for one
  fact would let a seller list a missing remote as an "included accessory" and
  satisfy nothing.
- **`seller_draft_images` carries #90's seller-owned provenance vocabulary and a
  trigger the vocabulary cannot replace.** `mercaria_seller_draft_reject_borrowed_photo`
  refuses a `file_id` any `canonical_images` row claims (the catalogue's own
  picture) or any OTHER account's `listing_images` row shows (the merchant-photo
  case). The seller's own listings are deliberately allowed — relisting is
  republishing your own photograph. `listing_images_file_id_idx` is what keeps
  the second lookup off a sequential scan, and it is declared in the drizzle
  schema rather than hand-written so a regeneration cannot drop it.
- **No column could hold identity evidence**, and that is the whole of #91
  seller-owned field 10 here: `SELLER_PROOF_FIELD_KINDS` is defined and the API
  refuses each kind BY NAME, because a protected store with no reviewer carries
  every risk of holding a serial number and none of the benefit.
## Guest-commerce governance (#111)

Nine tables (`db/schema/guestGovernance.ts`) for retention, privacy requests,
abuse controls, security counters and the staged rollout. Full reference:
`docs/guest-governance.md`.

**The shape of the domain is easiest to see through what is ABSENT from all
nine.** There is no email column, no phone, no address, no token, no device
identifier, no user agent and no IP address anywhere in it. The three places a
person's own value would otherwise have to appear are a keyed digest under this
domain's own key, a Mercaria-minted row id, or a COARSE network range.

- **`guest_abuse_counters` and `guest_security_signal_counters` are COUNTS per
  window, never a row per attempt.** A privacy decision before an efficiency
  one: a row per token-verification failure is both a log of activity nobody
  consented to and an amplification primitive whose volume an attacker chooses.
  `guest_recovery_attempts` (#108) generalised. `guest_security_signal_counters`
  additionally has NO subject column at all and must never acquire one — the
  other counters are keyed on a subject because they exist to LIMIT it, and
  these exist to say something is happening more than usual.
- **`subject_hash` is in `PROTECTED_COLUMNS` for TWO reasons**, and the second
  is the sharper one. A keyed digest is an exact-match oracle (the
  `guest_checkouts.email_hash` reasoning); it is ALSO the only cross-row join
  key this domain has, so a trace returning it would let a reader ask "what else
  did this subject do". The SCOPE is in the digest's preimage precisely so two
  scopes' digests of one subject are different values.
- **`guest_retention_policy_versions` is the POLICY; `db/expiryTargets.ts` is
  the MECHANISM.** They answer different questions and neither can answer the
  other's — the registry says which column the sweep reads, this says which data
  class a retention belongs to, whether a hold pauses it, and WHEN a change to
  either took effect and who published it. Frozen by trigger once published, one
  ACTIVE row per (key, class) by partial unique: the `fee_schedules` device.
- **Its mechanism CHECK is an IMPLICATION, not a biconditional**, and the
  correction is worth reading because the biconditional is the tempting
  spelling. It refuses a `none` mechanism carrying a TTL (a class claiming never
  to be deleted with a clock beside it). It PERMITS a sweep with no fixed
  offset, which is legitimate and common — three of the thirteen classes have
  one, because the deadline is stamped on the row (`retentionSeconds: 0`) or the
  row leaves by CASCADE. The biconditional made all three unrepresentable and
  the schedule's first test run exposed it.
- **`guest_retention_runs_counters_total_check` is `examined = minimized +
  deleted + skipped_held + failed`**, an EQUALITY and never `<=` — #60's vacuity
  floor. A pass that swallowed a row cannot write a row. A companion CHECK
  refuses a DRY RUN reporting a delete, which is what keeps the two modes
  distinguishable. Its cursor column is named `cursor` and not `cursor_id`, the
  `catalog_backfill_runs` name: it is a position, not a reference.
- **`guest_legal_holds` is scoped to a class AND a group**, NOT NULL on both.
  "Only the relevant deletion" means a dispute over one order cannot freeze
  every abandoned cart, so a hold with no class is unrepresentable rather than
  refused. One LIVE hold per (group, class) by partial unique; a lifted row does
  not occupy it, so a reopened dispute is expressible.
- **`guest_data_requests` carries no exported VALUE.** A stored export is a
  second copy of everything the request concerned, in a table whose retention is
  longer than the data it duplicates. Its `retained_classes` and
  `retained_reasons` are positionally aligned and their equal cardinality is a
  CHECK using `cardinality`, never `array_length` — on an empty array the latter
  is NULL and a CHECK reads NULL as SATISFIED.
- **`guest_launch_gate_signoffs` and `guest_rollout_stage_advances` are
  APPEND-ONLY against UPDATE *and* DELETE** by trigger — the
  `buyer_request_events` posture. A sign-off somebody edited is not a sign-off.
  A WITHDRAWAL is a later row saying `no`. There is deliberately NO
  `current_stage` column anywhere: the stage is the latest PERMITTED advance,
  derived, because a stored pointer beside an append-only history is two
  representations of one fact and the one that would be wrong is the one an
  operator reads during an incident.
- **Every "present exactly when" CHECK here is written as TWO implications**,
  never one over their conjunction — the #126
  `retail_delivery_promises_observed_shape_check` finding, applied before it
  could cost anything.
- **No table references another domain.** Every id is a shared checkout-group
  token, an Oxy account id, or a grant id whose foreign key would break in both
  directions (grants are hard-DELETED at their own `purge_at`, so RESTRICT would
  block the retention sweep forever and CASCADE would erase the audit of an
  erasure the day the credential aged out). All registered in
  `db/deferredForeignKeys.ts`.
## Merchant plans, entitlements and subscription billing (#89)

Ten more Postgres-born tables with no source model: `merchant_plans`,
`merchant_plan_prices`, `merchant_plan_acceptances`, `entitlement_definitions`,
`plan_entitlements`, `billing_customers`, `merchant_subscriptions`,
`merchant_subscription_events`, `entitlement_grants` and
`entitlement_usage_counters`. Full reference: `docs/merchant-plans.md`.

The domain references only `stores` (whose merchant the plan is a relationship
with) and `ledger_transactions` (whose balanced posting a settled invoice names).
It references `payments` NOT AT ALL, and that omission is the schema decision
worth reading first.

- **`billing_customers` has no relation to `provider_accounts`, and must never
  grow one.** A Connect account is a seller Mercaria PAYS; a billing customer is
  a merchant Mercaria CHARGES. Two objects, two provider key spaces, opposite
  directions of money — and #89 acceptance 2 asks that they cannot be confused or
  cross-linked. Two tables with no key between them is how, and a test walks the
  real drizzle columns of both billing tables asserting no name could hold a
  connected-account id.
- **Versioning is the `fee_schedules` mechanism reused, plus ONE index it has no
  counterpart for.** `merchant_plans_one_active_per_key` is the familiar half;
  `merchant_plans_one_active_free_plan` is a partial unique on `tier` where
  `tier = 'free' AND status = 'active'`, so at most one active free version
  exists in the whole database. A store with no subscription resolves against
  "the active free plan", and with two of them that phrase names nothing. It is
  GLOBAL, which makes it a shared resource between parallel realdb tests the way
  `match_policy_versions_active_key` is — the suite retires its free plan rather
  than scoping the index.
- **`limit_kind` is DENORMALIZED onto `plan_entitlements` and
  `entitlement_grants`, tied by a COMPOSITE foreign key** to
  `UNIQUE(capability_key, limit_kind)` on the definition — the
  `match_category_gates` device. Without the copy, "a `flag` carries no number"
  is a cross-table condition no CHECK can express; with it the rule is intra-row
  and real, and the copy is provably the definition's own. The definition's
  contract columns are frozen by trigger, so the target never moves under it.
  The CHECK is ONE-DIRECTIONAL (`limit_kind <> 'flag' OR limit_value IS NULL`)
  because NULL must stay legal on a quantified kind: it means UNLIMITED, and a
  biconditional would make that unrepresentable.
- **`entitlement_definitions.capability_key` is CHECKed against
  `MERCHANT_ENTITLEMENT_CAPABILITIES`, which is DISJOINT from
  `MERCHANT_UNGATEABLE_CAPABILITIES`.** So `order_management`,
  `refund_issuance`, `financial_record_access` and `data_export` have no row
  shape anywhere in the schema — the guarantee that they cannot become paid-only
  is the absence of a value, not a rule in a service.
- **`merchant_subscriptions` requires the provider trio NOT NULL**, so a row
  exists only for a real billing relationship. A partnership with no charge is an
  `entitlement_grants` row, and a free store simply has no subscription — which
  is what makes `subscription is null` mean "free", unambiguously, everywhere.
  One row per store, REUSED across cancellations, because "what happened to this
  merchant's billing" should be one chain to read.
- **`merchant_subscriptions_grace_deadline_check` is `status <> 'past_due' OR
  grace_expires_at IS NOT NULL`.** A past-due subscription with no deadline
  either never expires or expires immediately depending on which reader you ask —
  the exact shape of a control that cannot be told from its own absence.
- **The acceptance triple on the subscription is NOT NULL**, and
  `merchant_plan_acceptances` exists as a TABLE rather than only those three
  columns because of ORDER: a merchant agrees BEFORE the hosted checkout, and the
  subscription row cannot exist until the rail has created one. The alternatives
  were putting an Oxy account id into provider metadata, or letting a
  subscription exist with no recorded consent.
- **`merchant_subscription_events.provider_event_id` carries a PARTIAL unique**,
  and it is a SECOND idempotency layer rather than a duplicate of
  `payment_provider_events`': that one dedupes RECEIPT (a redelivery), this one
  dedupes APPLICATION (an operator replaying an already-processed event). The
  `ON CONFLICT` must repeat the index predicate — Postgres cannot infer a partial
  index as an arbiter from the column alone.
- **The audit table is append-only by trigger, which forces the invoice booking's
  ORDER**: the row cannot be written and then stamped with the ledger transaction
  it booked, so the posting comes FIRST and a claim that finds the event already
  applied THROWS, rolling the posting back inside the same transaction.
- **`entitlement_usage_counters` stores no LIMIT.** It lives on the immutable
  plan version or on the grant; a copy here would be a second representation of
  one fact and would be the stale one every time a merchant changed plan. `used`
  is `bigint({ mode: 'number' })` for the money-column reason — an API-call
  counter over years outgrows a signed `integer`, and the failure would be a wrap
  rather than a refusal.
- **`period_key` is the literal `total` for a `total` limit and a period-derived
  string for a `per_period` one**, so both kinds share one table and one unique
  index without a nullable column that would make two rows for one period
  possible (Postgres treats NULLs as distinct).
## Channel onboarding and the channel audit trail (#87)

`db/schema/channels.ts` — `channel_onboarding_sessions` and
`channel_audit_events`, plus four nullable columns on `connections`. Full
reference: `docs/channels.md`.

- **There is NO credential column on a session, and none may be added.** Wizard
  step 4 ("collect credentials only through the secure provider-specific flow")
  is that absence rather than a rule somebody follows, and it matters more here
  than almost anywhere: an abandoned session outlives its flow BY DESIGN, so a
  consumer secret parked on one would sit unencrypted for as long as the merchant
  never came back. The credential flows write to `connections` (AES-GCM, both
  envelopes, `num_nonnulls(...) in (0,3)`) or mint a channel key; a session
  records only WHICH connection resulted. Held by two gates in
  `channel-isolation.test.ts` — a SCAN of the domain for the credential
  vocabulary, and a WALK of the real table for a credential-shaped column, which
  catch different mistakes.
- **`channel_onboarding_sessions_live_key` is PARTIAL on `state =
  'in_progress'`**, which is #87 acceptance 2 ("previewing or retrying a
  connection creates no duplicate channel") held at the FIRST step rather than
  defended at the last. Partial rather than plain so finished sessions accumulate
  as history — a plain unique would make a merchant who disconnected unable to
  ever reconnect through the wizard. Every `ON CONFLICT` on it must REPEAT the
  predicate or Postgres refuses to infer the arbiter (the `ensureCart` lesson,
  #104).
- **The preview counters partition `scanned`, by equality and never `<=`**
  (`..._preview_total_check`) — `catalog_backfill_runs`' vacuity floor applied to
  a wizard, because a record the preview read and dropped on the floor would
  otherwise be invisible, and a preview that silently loses records is the one
  that says "nothing to review" about a feed full of problems. Its sibling
  `..._preview_complete_check` makes the seven columns all-or-none: five counters
  with a missing `scanned` reads as a preview that examined nothing, which is
  also what a broken mapping produces.
- **`activation_blockers` is stored and NOTHING decides from it.** It exists so a
  resumed wizard shows what it showed; `deriveActivationBlockers` re-derives
  against the LIVE connection on every read and every activation attempt. A
  session previewed last week whose connection has since errored must not be
  activatable because a column still says it was fine.
- **`channel_audit_events.changed_fields` carries field NAMES and never values**
  — #63's error-report rule applied to an audit trail, for a sharper reason: the
  values a channel change carries include a consumer secret and an API key pair,
  so a trail recording before-and-after would be a plaintext credential store
  nobody classified as one. `recordChannelAuditEvent` has no parameter a value
  could go in.
- **Append-only by trigger, with a PRECISE delete exception.** UPDATE always
  raises; DELETE raises only while the STORE still exists — #90's
  `listing_condition_revisions` device, and the exception is exactly as wide as
  the `ON DELETE CASCADE` above it. A blanket refusal reads as the stricter
  choice and is the wrong one: it makes a store with any channel history
  undeletable forever, because the cascade the foreign key declares can never
  run. `channels.realdb.test.ts` found that on its FIRST run, in every other
  case's `afterEach`.
- **`connections` gains TWO pause instants, not one tri-state.**
  `fetch_paused_at` and `publication_paused_at` are different facts with opposite
  remedies (stop reading from a rate-limiting host; stop publishing wrong prices
  while still observing), and one column could not express both at once without a
  fourth value meaning what two flags mean. INSTANTS rather than booleans because
  "since when" is the first thing anybody asks about a paused channel.
- **`disconnect_policy` and `disconnected_at` are written together or not at
  all** (`connections_disconnect_record_check`, `num_nonnulls(...) in (0, 2)`) —
  half of that fact reads as the whole one. The policy is RECORDED rather than
  derived because it is a DECISION a person made, and the listings it applied to
  are indistinguishable afterwards from listings nobody touched.
- **`channel_onboarding_sessions.merchant_id` / `.storefront_id` are `repoint` in
  `merge-plan.ts`, both of them.** The census fired on this table the moment it
  landed, which is what it is for. They move together — the pair names ONE
  binding, and repointing one without the other would leave a session claiming a
  storefront that belongs to a different merchant.

## Durable connector webhook registration (#218)

ONE table, `connection_webhook_failures`, and it is the shape rule §"Arrays and
objects" reaches by elimination rather than a choice between equals.

- **A child table, because the fact is a repeated `{topic, reason, status}`
  RECORD.** Three parallel `text[]`/`integer[]` columns on `connections` are
  three representations of one fact that can disagree in LENGTH, which is exactly
  why `product_variant_option_values` is a table. A `jsonb` bag fails the
  register's only test: the shape is known, Mercaria's own code composes it, and
  `reason` is a CLOSED value set a `jsonb` value could carry no CHECK for.
- **`UNIQUE(connection_id, topic)` makes the write a REPLACEMENT rather than a
  history.** Every registration deletes this connection's rows and inserts the
  current refusals, in the SAME transaction that writes `connections.webhook_ids`
  and the webhook secret — the three describe one attempt and can never describe
  different ones. That transaction is #218 itself: the ids and the secret used to
  be written by a statement a refused topic threw before reaching, so a partial
  registration persisted NEITHER, leaving live subscriptions Mercaria held no id
  for and (on WooCommerce, whose secret is fixed at creation) signed with a
  secret it had never stored.
- **`http_status` is NULLABLE and the null case is load-bearing.** A
  `transport_error` never reached the platform, so there is no status to record
  and a zero would be a status nobody answered. The `ConnectionWebhookFailure`
  DTO omits the property rather than sending `0`, the same distinction
  `deriveOfferDelivery`'s unknown branch makes about an absent delivery cost.
- **A disconnect DELETES these rows** rather than keeping them. "These events
  will not arrive" is a fact about live subscriptions, and a disconnected
  connection has none — `status = 'disconnected'` already says nothing arrives,
  and leaving the rows would report a narrower problem that is no longer the one.

## Per-record connector sync failures (#303)

`sync_run_record_failures`, in `schema/connectors.ts` beside `sync_runs`. WHICH
record a connector run refused, and why — durably, one row per record.

- **Why a table rather than more of `sync_runs.error`.**
  `catalog_source_rejections` (#62) is the precedent and the argument is the same
  one domain over: a `failed` counter says a run dropped eleven products; only
  these rows say all eleven broke the same rule, which is what tells a systemic
  refusal from a bad afternoon. #294's summary on `sync_runs.error` is elided at
  three reasons with three ids each, so a run of `0/0/0/100` names nine products
  and loses ninety-one. That column is deliberately NOT widened further: it is
  ONE column for a whole run, and a run that is `completed` with one failure has
  no honest place to put a growing list. The summary stays, composed from the
  same input by the same classifier inside the same transaction, so the two
  cannot disagree.
- **`subject_type` is STORED and is not derivable from `sync_runs.kind`.** That
  column reads `inventory_sync` for BOTH the pull (`syncInventory`, whose unit is
  a platform inventory ITEM id) and the push (`ingestInventory`, whose unit is
  the PRODUCT external id it resolves a listing by). One kind, two subjects — so
  a derivation would be silently wrong on exactly one of them, and would tell a
  merchant to search their product list for an inventory-item id.
- **`ordinal` exists because BOTH halves of the obvious ordering key are
  degenerate here.** Every row of a run is written by ONE multi-row insert, so
  they share `created_at` to the millisecond, and `@oxyhq/db`'s uuid v7 primary
  key is not monotonic within a millisecond. Ordering on `(created_at, id)`
  returns a run's refusals SHUFFLED — measured on this table's own first suite
  run, where the write cap's "first 200 we met" came back starting at record 79
  and a two-row case came back inverted. It is also a PAGING bug, not only a
  cosmetic one: two reads of one page disagree.
  `sync_run_record_failures_run_ordinal_key` is UNIQUE so two rows cannot claim
  one position, which in turn forces the writer to REPLACE a run's rows rather
  than append — `finishSyncRun` overwrites `error` outright on a re-close
  (explicitly to NULL when nothing was refused), and without the delete a second
  close throws 23505 instead of converging.
- **`external_id` is NULLABLE and the NULL is the point.** A platform that
  published no id for a record still refused one, and dropping the row would take
  the reason with it — `catalog_source_rejections.external_id` is nullable for
  the same reason. The writer maps `''` and whitespace to NULL, so "absent" has
  ONE spelling; `sync_run_record_failures_external_id_shape_check` refuses the
  empty string a second writer or `psql` would leave.
- **`detail` is NOT NULL** because its composer never returns an empty string. A
  blank detail beside a reason code reads as "no reason was recorded", which an
  ABSENT ROW already means, so the two would be indistinguishable. Its ceiling
  must be at least `MERCHANT_FACING_MESSAGE_MAX_LENGTH` — an IMPLICATION, not an
  equality, since shortening the composed message is harmless while a column
  narrower than the composer would refuse a legitimate detail, and a run that
  refused a product would then fail to record that it had.
- **ONE parent, deliberately.** The precedent carries `source_id` beside `run_id`
  because its diagnosis read is per-SOURCE across runs. The question here is
  per-RUN, the merchant's own handle is the CONNECTION, and `sync_runs` already
  carries it on an index that serves exactly that lookup — so a second connection
  column would be a second representation of one fact with nothing asking for it.
- **The one table in `connectors.ts` with a retention deadline**, and it is the
  only one bounded by TRAFFIC rather than by a merchant's channels: a platform
  publishing a field Mercaria refuses writes one row per product per run,
  forever. `connections` and `sync_runs` are the activity log the dashboard reads
  and must NEVER be swept. Expiring a page costs the DETAIL and never the SIGNAL
  — the tally and the summary live on the run row, which nothing here sweeps.
  `sync_run_record_failures_expiry_idx` is required by
  `findUnsupportedExpiryColumns` and matters here more than anywhere in the file.

## Location publication and collection (#93)

Eight tables — `location_publications` and its three children
(`location_opening_hours`, `location_closures`, `location_publication_events`),
`order_pickups`, `pickup_collection_credentials`, `pickup_collection_events`
and `listing_local_discovery`. Full reference: `docs/pickup.md`.

- **A separate publication row rather than columns on `locations`, and the
  address fields are ALL nullable.** `locations` holds the address a pallet is
  delivered to and the name a warehouse manager gave a building; a publication
  holds what a merchant is willing to have a stranger read, and "the city and
  nothing else" is a complete, common answer. Widening `locations` would have
  made the two the same nine columns, so the first naive
  `select().from(locations)` on a public route would disclose a stockroom's
  street and the phone of whoever signs for deliveries. It also makes the
  default right: a store with no publication row is not discoverable, which is
  the state every existing store is in.
- **No `discoverable` and no `pickup_eligible` column.** The inputs sit on
  `location_publications`, `locations`, `stores`, `listings`, `inventory_levels`
  and `provider_accounts` — six tables in four domains — so the verdict is
  DERIVED at read time (#57's `deriveNativeCheckoutEligibility` divergence).
  That is what makes a moderation restriction stop a collection in the statement
  that applies it.
- **`geo_point` is GENERATED from `latitude`/`longitude`**, so nothing can write
  a point that disagrees with the numbers a merchant can see and correct.
  `ST_SetSRID` and the geometry→geography cast are both IMMUTABLE, which a
  STORED generated column requires; drizzle-kit cannot emit the `(Point,4326)`
  typmod, so the schema test asserts the stored value's type and SRID against
  REAL ROWS instead.
- **The coordinate CHECK refuses the NULL ISLAND, and that is the clause worth
  reading.** `(0, 0)` is a real point in the Gulf of Guinea and is what every
  failed import writes, so a range check alone admits the single commonest bad
  value there is and sorts it first for everybody in West Africa. Greenwich and
  Quito are still accepted — the refusal is the PAIR — and the realdb suite
  carries that fixture, because a CHECK that refused either half alone would be
  refusing a merchant.
- **`stock_confirmation_interval_seconds` is NOT NULL with NO DEFAULT.** A
  default would be the deployment-wide freshness TTL #68 forbids, arriving
  through the back door: every merchant who never touched the field would
  silently share one number. Requiring it puts the claim at the grain that
  actually varies — a till writes through in seconds and a nightly connector run
  does not.
- **`location_opening_hours` is a row per INTERVAL, not per weekday.** A shop
  that closes for lunch has two intervals on a Tuesday and an `opens`/`closes`
  pair per day cannot say so. Minutes from LOCAL midnight against the
  publication's own `timezone`: a `time` column carries no zone and a
  `timestamptz` carries a date, and what a shop publishes is neither.
- **`location_closures` uses `date`, not `timestamptz`.** A closure is expressed
  in the shop's own calendar ("we are shut on the 6th"); storing an instant would
  make the meaning depend on which zone read it back.
- **A merchant PAUSE and an operator RESTRICTION are different column pairs.**
  One is a shop closing its collection desk for an afternoon, the other is
  Mercaria withdrawing a place — and a merchant must not be able to lift the
  second by un-pausing the first. Each carries its reason by CHECK, because a
  paused location with no stated reason is the state nobody can act on.
- **`order_pickups` holds the snapshot AND the state in one table, and only the
  snapshot is frozen.** Splitting them would mean a two-table join on the
  hottest read in the domain (a counter scanning today's collections) and a
  snapshot with no state is not a thing anything reads. The trigger freezes the
  fourteen copied columns and leaves `state` and its four instants free, because
  moving those is the whole point.
- **The address on `order_pickups` is copied from the PUBLICATION, never from
  `locations`.** A buyer's order therefore cannot carry a street the merchant
  chose to withhold, and #105's "nothing fabricates a street for a collection"
  survives — `destination.ts` still produces no address at all.
- **`order_pickups.location_id` and `.publication_id` are RESTRICT.** A merchant
  deleting a location out from under a live collection would leave an order
  pointing at nowhere and a person standing outside a door — the `connections`
  precedent, where a live pointer blocks the delete rather than cascading
  through it.
- **The state/instant CHECKs are biconditional in one direction and one-way in
  the other.** `collected` ⇔ `collected_at` and `pickup_cancelled` ⇔
  (`cancelled_at` ∧ `cancel_reason`); but `ready_at` only implies
  `ready_for_pickup`, NOT the reverse — a collected order was ready first, so the
  instant SURVIVES the transition, and `markCollected` coalesces one in for a
  shop that hands over without pressing "ready".
- **`pickup_collection_credentials` holds a rotation COUNTER and no credential.**
  The code is `HMAC(PICKUP_COLLECTION_CODE_KEY, order_id || ':' || version)`, so
  an authorized surface can re-derive it for the buyer as often as they ask, a
  counter verifies by re-deriving and comparing in constant time, a rotation is
  `version + 1`, and a database dump contains nothing that opens anything.
  #122's `request_fingerprint` is the same device; this goes one step further by
  keeping no digest either, because nothing ever looks an order up BY code. The
  realdb suite asserts the absence against `information_schema`, not against the
  file.
- **`(version > 1) = (rotated_at is not null)` is a CHECK**, because "when did
  the code the customer is holding stop working" is the only question a failed
  collection asks.
- **`location_publication_events` and `pickup_collection_events` are APPEND-ONLY
  against UPDATE *and* DELETE.** The half that matters is the REFUSAL record: a
  person turned away at a counter is what a support call is about, and a trail
  that kept only successes could not answer it.
  `pickup_collection_events_override_reason_check` makes the audited fallback's
  reason mandatory at the row, since a second caller added later would forget it.
- **`pickup_collection_events.store_id` is denormalized**, so a store's own trail
  is one indexed predicate and a query for it cannot widen to a sibling's orders
  by forgetting a join condition (#93 merchant rule 5).
- **`location_publication_events.kind` has NO CHECK, deliberately.** The trail is
  a RECORDING and a newly editable field should not need a migration before it
  can be audited; the value space is small and greppable and nothing branches on
  it. Contrast `pickup_collection_events.kind`, which IS closed — a desk action
  is a capability, and one nobody implemented must not be recordable.
- **`listing_local_discovery` stores CELL INDICES and has no coordinate column.**
  A precise position is not something the row withholds — it is something the row
  cannot hold, so #93 P2P rule 5 is true of every serializer anybody writes,
  including ones nobody has written, and true of a `psql` session. The range
  CHECK is written against the row's OWN `cell_precision_degrees`, so it stays
  true if the precision ever changes.
- **`enabled` is a column and the row is the opt-in.** A seller who turns local
  discovery off keeps their area, so "off" and "never asked" stay
  distinguishable — and turning it back on is one switch rather than re-entering
  a place.
- **`location_publications.storefront_id` is a column and the MERCHANT is not.**
  #84's `native_store_links` already answers "which merchant operates this
  store", with an active-per-store partial unique behind it, and a second copy on
  every publication is a second answer a revoked link would leave stale. A
  storefront is not derivable that way — a merchant may operate several — so it
  is stored, nullable, and its merge disposition is `repoint` in
  `merge-plan.ts`.
- **Three Oxy id columns and no buyer column anywhere.** The whole of what these
  eight tables store about a person is `location_publications.restricted_by`,
  `location_publication_events.actor` and `pickup_collection_events.actor` —
  every one a member of STAFF or an operator. Who bought a collection order is
  the order's own fact, under #106's scoping.
---

## Merchant activation (#85)

`merchant_activation_settings`, `merchant_activation_policy_acceptances` and
`merchant_activation_capability_events`. What is NOT here is the point: there is
no readiness column and no activation verdict anywhere in the file.

- **The verdict is DERIVED and never stored** — the `deriveNativeCheckoutEligibility`
  (#57) divergence, taken for the reason `deriveChannelReadiness` (#87) took it.
  Its inputs sit on eleven tables in eight domains, and a stored verdict would be
  a twelfth representation that goes stale the instant Stripe restricts a seller.
  What these three tables hold is what somebody DECIDED, plus what the derivation
  was OBSERVED to say.
- **The only foreign key the domain owns is `stores`.** A column on `connections`,
  `provider_accounts` or `fee_schedules` would be a second answer to a question
  those tables already answer.
- **Two intent columns rather than one tri-state**, because #85 readiness-change
  rule 9 is "disabling guest checkout does not disable authenticated checkout
  unless its own requirements also fail" — one column could not express "guest
  paused, native running" without a value meaning the same as two flags.
- **The hold is `num_nonnulls(reason, actor, instant) in (0, 3)`**, not three
  pairwise implications: the pairwise spelling is SATISFIED by two of three being
  present, which is exactly the row that leaves a store held with nobody named.
  It is unreachable from the merchant surface structurally —
  `updateMerchantCheckoutIntents` has no hold parameter to pass — and a scanned
  gate asserts the merchant request schema and patch type carry no hold field.
- **The support contact lives here rather than on `stores`** because clearing it
  WITHDRAWS a capability, and `stores` has twenty unrelated writers and no
  trigger. Every write that reaches these columns goes through the one repository
  that also records a capability observation. It is deliberately NOT in
  `PROTECTED_COLUMNS`: this is the contact a merchant PUBLISHES, the opposite of
  `guest_checkouts.email_ciphertext`, and treating it as a secret would make it
  unrenderable on the one page it exists to appear on.
- **A settings row is created by a WRITE and never by a read.** An absent row is
  the defaults (`enabled`, `enabled`, no hold, no contact), which is exactly what
  "this merchant has decided nothing" means — and a checkout reads this, so a
  read that minted a row would write on a path that must not write (#104's T10).
- **`merchant_activation_policy_acceptances` is `fee_schedule_acceptances` one
  domain over**, including its POLYMORPHIC owner and for its reason: half the
  owners are Oxy accounts whose key space is not in this database. That is what
  lets an individual seller accept #112's P2P policy without a store and without
  `store:manage`. Append-only against UPDATE **and** DELETE by trigger —
  withdrawing consent is publishing a NEW policy version, which leaves every
  prior acceptance legible.
- **The policy VERSION is a code constant** (`MERCHANT_ACTIVATION_POLICIES`), the
  #126 consumer-rights-terms decision: a version pointer is only as durable as
  the code that can still resolve it, and a table would let somebody publish a
  responsibilities version no shipped terms document contains — which would then
  be snapshotted onto acceptance rows as what those sellers agreed to.
- **ONE capability table, not a current-state row beside a history one.** "What is
  it now" is the LATEST row, read with `distinct on` over
  `merchant_activation_capability_events_latest_idx`. A second table holding the
  current value would be derivable from this one and could therefore disagree
  with it. The index tie-breaks on `id desc` because one observation writes
  several rows in one statement and `@oxyhq/db`'s uuid v7 is not monotonic within
  a millisecond.
- **It is a RECORDING and never an authority.** Nothing that decides anything
  reads it — a cached `granted` survives exactly the restriction that should have
  withdrawn it (`price_signal_evaluations`' rule) — and a scanned gate fails the
  build if a derivation, a gate or a projection starts selecting from it.
- **Four CHECKs carry the trail's honesty**: `previous <> next` (a transition that
  changed nothing is not one), the actor BICONDITIONAL (`system` names nobody and
  everything else must, so a sweep's finding can never be attributed to whoever
  triggered it), `granted` implies an empty `unmet`, and `unmet` is containment-
  CHECKed against `MERCHANT_ACTIVATION_REQUIREMENT_KEYS` — a `text[]` with an
  element CHECK rather than jsonb, so an operator note, a buyer's email or a
  moderation finding has no shape to arrive in.
- **The trail is append-only against UPDATE and PERMITS DELETE**, which inverts
  `analytics_events`' reasoning rather than copying it. `analytics_events` permits
  DELETE because erasure on a schedule IS its policy; this table holds no personal
  data at all — a store id, a capability and an actor — so it has no retention
  deadline to serve and nothing to trade the guarantee for. What the DELETE
  permission is for is the `ON DELETE cascade` from `stores`: a merchant leaving
  takes its own audit with it.
- **Serialization is the settings row's lock, not a lease table.** Two observers
  reading the same previous state would both write a transition; the writer takes
  `FOR UPDATE` on a row that must exist for any observation to be recorded.
## Saved shopping agents (#97)

Eight tables: `shopping_agents`, `shopping_agent_lines`,
`shopping_agent_triggers`, `shopping_agent_evaluations`,
`shopping_agent_findings`, `shopping_agent_finding_lines`,
`shopping_agent_notifications`, `shopping_agent_audits`.

- **The ABSENCE is the enforcement.** No column in any of the eight names an
  order, a cart, a checkout object, a payment method, a card, a merchant
  message or a merchant's terms, and `shopping-agent-isolation.test.ts` walks
  the real drizzle tables and fails the build if one appears. That is #97
  acceptance 9 ("no code path from an agent to autonomous checkout or payment")
  as a fact about the schema. `shopping_agents.terms_version` is MERCARIA's own
  agent terms and is the one deliberate near-miss — accepting a MERCHANT's
  terms is a forbidden action, which is why the gate's pattern names
  `merchant_terms` rather than `terms`.
- **Two jsonb columns, and the register entry is the argument for each.**
  `shopping_agents.constraint_set` is #94's own bounded (32 constraints, two
  levels), closed-vocabulary document, re-validated against the LIVE registry
  on every evaluation — so a definition retired since the agent was saved
  refuses the evaluation rather than being read under new meaning. Flattening
  it into columns would be a second, weaker copy of #94's language.
  `shopping_agent_findings.record_refs` is #96's per-finding citation table,
  and it is stored because a generated summary may cite only the refs THAT
  finding minted. Everything else — the selected plan, the constraint outcomes,
  the versions — is a real column or the `shopping_agent_finding_lines` child
  table.
- **`cardinality(col) >= 1`, never `array_length(col, 1) >= 1`.** Measured on
  this schema: with the latter, an empty `trigger_sources` array is ADMITTED,
  because `array_length` is NULL on `{}` and a CHECK rejects only FALSE. Both
  non-emptiness CHECKs here read `cardinality`.
- **`ranking_policy_version` is NOT NULL with NO default.** An empty string is
  a real state ("no comparison ran") and a NULL is not; a DEFAULT would make a
  writer that FORGOT the version indistinguishable from one that had none to
  give, which is the column a finding's reproducibility rests on. Migration
  `0005` dropped every empty-string default in this schema and
  `schema.realdb.test.ts` refuses a new one — it caught this.
- **Three append-only triggers, and DELETE is deliberately PERMITTED** on all
  three tables (`analytics_events` and `offer_price_snapshots`' posture):
  erasing one account's agents is a scoped DELETE that cascades, and a trigger
  refusing it would make the erasure fail silently. The ONE update a finding
  admits is `lifecycle` moving off `current`, checked by comparing the whole
  tuple with the lifecycle normalised — one comparison, so a column added later
  is covered without anybody extending a list.
- **`mercaria_shopping_agent_notification_requires_qualified` is a TRIGGER
  because the invariant is CROSS-ROW** and a CHECK may not contain a subquery.
  It fires on INSERT only: a notification's own lifecycle legitimately updates,
  and the fact it reads — the finding's `outcome` — is immutable by the trigger
  above.
- **Nothing is keyed on `canonical_product_id` alone.** The fan-out index is
  `(canonical_product_id, agent_id)` on `shopping_agent_lines`, composite for
  #79's reason: no route, repository function or operator handle asks who is
  watching a product.

## The referral earnings ledger (#145)

Five tables in `schema/referralEarnings.ts` — `referral_payout_batches`,
`referral_payout_batch_items`, `referral_ledger_postings`,
`referral_reward_transitions`, `referral_earning_discrepancies` — plus two
accounts, one owner type and four transaction kinds on the EXISTING ledger, and
one column on `referral_program_controls`. Full reference:
`docs/referral-earnings.md`; binding decisions are ADR 0005 "Ledger
representability", D12–D15, D18 and R1–R8.

**There is no balance table and none may be added.** #145 acceptance 1 is that
reward balances are fully derivable from immutable entries, and
`ledger_entries` is where those entries are. A running total would be a second
representation of a fact the book already carries, and the two would disagree
exactly when a payout was being built over one of them.

- **Referral money books in the SAME ledger.** `referral_expense` (debit-normal)
  and `referral_payable` (credit-normal, per partner) join `LEDGER_ACCOUNTS`; a
  parallel referral ledger would split `provider_clearing` across two books the
  moment a payout moved platform money. `referral_payable` may go NEGATIVE and
  nothing forbids it — that is ADR 0005 R7's post-payout clawback, and a
  constraint refusing it would refuse exactly the state the ADR requires.
- **`referral_partner` is a FOURTH `LedgerOwnerType`**, for the reason `supplier`
  was a third: a `referral_partners` row is already identified by a `store` or
  `user` owner pair, so reusing one would file a partner's referral earnings
  under the same key a seller's sales payable uses.
- **The account boundary is an exact PARTITION.** `REFERRAL_LEDGER_ACCOUNTS` (3)
  and `REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS` (12) are disjoint and their union is
  exactly `LEDGER_ACCOUNTS`, asserted — so a sixteenth account fails the build
  until somebody decides which side it is on. `commission_revenue` is on the
  forbidden side: a reward is FUNDED from realized commission and never REDUCES
  it, or ADR 0001 D3's one figure stops meaning what it means.
- **The idempotency key is derived from the SUBJECT, never a clock.**
  `refledg:<kind>:<subjectId>` on the posting, `refrewst:<reward>:<cause>:<source>`
  on the transition, `refpay:<batchId>` on the batch (which is what a rail sees,
  byte-identical across retries), `refdisc:<kind>:<subject>:<currency>` on a
  finding. Every insert is `ON CONFLICT DO NOTHING` and the empty `RETURNING`
  set IS the "already done" answer.
- **A posting names exactly the subjects its kind is ABOUT**, by CHECK: an
  accrual a reward, a reversal a reward AND an adjustment, a payout a batch, a
  recovery none of them. `amount_minor` is a positive MAGNITUDE and the kind
  carries the direction — the signed movement lives in `ledger_entries`, and
  copying it here would be a second representation that could disagree.
- **A transition's `from_state <> to_state` is a CHECK**, which is why there is
  no `accrual` cause: a reward is BORN `held`, and the birth of a row is not a
  transition. Its own record is the posting and the `reward_accrued` event.
- **Two partial uniques carry the payout properties.**
  `referral_payout_batches_open_key` on `(partner_id, currency) WHERE status in
  (draft, approved, processing, failed)` is one live batch per partner per
  currency; `referral_payout_batch_items_live_reward_key` on `(reward_id) WHERE
  released_at IS NULL` is one live claim per reward, ever, which makes a
  duplicate payout unrepresentable rather than unlikely.
- **`failed` keeps its claims and only `cancelled` releases them.** Releasing on
  failure would let a retry and the next batch both carry one reward.
- **Four eyes is `approved_by <> created_by`**, and the construction loop opens a
  batch as the literal `system` — so it is automatically satisfied for a
  loop-built batch and a real second pair of eyes for a hand-built one, with no
  branch to get wrong. `created_by_oxy_user_id` is therefore in
  `ID_COLUMNS_WITHOUT_FOREIGN_KEY` with that reason written out.
- **Four triggers, and the third has ONE precise exception.**
  `referral_ledger_postings` and `referral_reward_transitions` are append-only
  outright; `referral_payout_batch_items` is frozen except `released_at` moving
  NULL → a value exactly once (not "immutable once set", which would still admit
  a write taking it back to NULL — and that write is how one reward ends up live
  in two batches); `referral_payout_batches` freezes its identity, its amounts
  and its five stamps while the status machine moves.
- **#145 WIDENED `mercaria_referral_reward_frozen` by `CREATE OR REPLACE`**
  (#106's device) so `hold_until_at` may move FORWARD and nothing may pull it
  back. ADR 0005 D12's freeze stops the hold clock, and the backwards direction
  is the one that would vest a reward early.
- **The discrepancy upsert carries `setWhere: status <> 'resolved'`.** Without
  it a sweep re-observing a finding an operator has answered REOPENS it — the
  failure `payment_discrepancies` hit in this repository's own shared test
  database, presenting in a sibling file and naming nothing about its cause.
- **No protected column, and that is a fact about the shape.** The only
  identities representable here are a `referral_partners.id`, an Oxy OPERATOR id
  and a rail's own opaque reference; there is no contact, no beneficiary detail,
  no tax identifier and no buyer-shaped column in any of the five tables.
- **No retention deadline and no `EXPIRY_TARGETS` entry.** Every row here is a
  permanent financial record: what Mercaria owed, what it paid and why it
  changed. #145 acceptance 6 — a feature rollback cannot erase an already-earned
  or already-paid record — is the same statement from the other side.

## Referral integrity (#148)

`db/schema/referralIntegrity.ts` — five tables: `referral_conduct_policies`,
`referral_risk_signals`, `referral_enforcement_actions`,
`referral_enforcement_appeals`, `referral_disclosure_requirements`. Every one
references `referral_partners` and nothing else outside its own domain —
deliberately, because an enforcement record that could reference an ORDER would
be one that could name a buyer.

### The forfeiture CHECK is ADR 0005 D17 as a row shape

```
referral_enforcement_actions_forfeiture_basis_check:
  action not in (<REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS>)
  or basis in (<REFERRAL_BASES_PERMITTING_FORFEITURE>)
```

Both tuples are DERIVED in `@mercaria/shared-types` — the first by filtering an
exhaustive `Record` of financial effects, the second by SUBTRACTING the one
basis (`risk_signal`) that may not forfeit. So an action that becomes able to
destroy money does so in a place `tsc` guards and a migration records, and
*"signals freeze, only first-party identity evidence voids"* has no row shape to
violate. Its companion,
`referral_enforcement_actions_signal_evidence_check`, requires
`cardinality(evidence_signal_ids) >= 1` on a `risk_signal` basis — without it
the basis is a word rather than a claim.

### `cardinality`, never `array_length`

`referral_conduct_policies_conduct_nonempty_check` uses `cardinality`. On an
empty array `array_length(col, 1)` is NULL, a CHECK rejects only FALSE, and the
obvious spelling therefore ADMITS the empty prohibition set it exists to refuse
— a policy version prohibiting nothing that a partner would accept and no
enforcement action could cite. **Measured here for the fourth time in this
schema** and mutation-tested inside a rolled-back transaction.

### Two biconditionals, never one over their conjunction

`…_publication_check` on both versioned tables, and
`referral_enforcement_appeals_decision_shape_check`. The single form is
SATISFIED when both halves are false, so it admits a `draft` carrying a
publisher and an `accepted` appeal with no decider and no date — exactly the
rows the constraint exists to refuse. The #126 `retail_delivery_promises` rule,
hit again.

### `IS DISTINCT FROM`, never `<>`, in the independence CHECK

`referral_enforcement_appeals_independence_check` compares the decider against
BOTH the imposer and the appellant. With `<>`, a NULL decider yields NULL and a
CHECK reads NULL as SATISFIED — so both halves would be VACUOUS on every OPEN
appeal, which is every row before a decision. `imposed_by_oxy_user_id` is
SNAPSHOTTED onto the appeal because a CHECK may not contain a subquery; the
snapshot is safe because the action's decision columns are frozen by trigger.

### `num_nonnulls(...) in (0, 3)` for the lift columns

`referral_enforcement_actions_lift_shape_check`. Three pairwise biconditionals
would need three constraints to say what one says, and a missing third reads as
clean.

### Five triggers, and the DELETE posture differs on purpose

| Trigger | UPDATE | DELETE |
|---|---|---|
| `…_risk_signals_append_only` | refused | **PERMITTED** |
| `…_enforcement_actions_freeze` | decision columns frozen; lift and appeal state may move, once | refused |
| `…_enforcement_appeals_append_only` | submission frozen; decision columns move once | refused |
| `…_conduct_policies_immutable` | frozen once it leaves `draft`; `active → superseded` permitted | drafts only |
| `…_disclosure_requirements_immutable` | the same | drafts only |

The risk signal's permitted DELETE is the `analytics_events` posture inverting
the ledger's: erasure on a schedule IS the retention policy
(`REFERRAL_RETENTION_POLICY.risk_signal`, 400 days, swept off `expires_at`), and
a trigger refusing it would make the shared sweep fail SILENTLY on every row it
was contractually obliged to remove. Everything else here is a DECISION, and a
decision somebody can delete is not an audit trail.

### Three partial uniques

- `referral_enforcement_actions_live_key` on `(scope, subject_id, action)
  WHERE lifted_at IS NULL` — two operators converge on one row, and a LIFTED
  action is re-imposable, which a plain unique would forbid forever.
- `referral_enforcement_appeals_open_key` on `(action_id) WHERE state = 'open'`
  — a second concurrent appeal against one decision is two reviewers reaching
  two answers about one row.
- `…_active_key` on both versioned tables — the `fee_schedules` device.

### `evidence_signal_ids` is a `text[]` and NOT a join table

The ids are evidence SNAPSHOTTED at the moment of the decision. A join table
would let the signals' own 400-day retention change what an action appears to
have been based on; a dangling id after 400 days is CORRECT, because the
action's REASON survives its working papers — the same division
`REFERRAL_RETENTION_POLICY` draws between `review_evidence` and the enforcement
record itself.

### What no column here can hold

No email, hash, phone, address, card fingerprint, provider customer, wallet, IP,
user agent, device fingerprint or cookie. `evidence_ref` addresses a Mercaria
ROW, `imposed_by_oxy_user_id` is an operator, and `subject_id` is polymorphic
over five referral tables. Following an action to its evidence and out the other
side never reaches a buyer. Both polymorphic ids are registered in
`ID_COLUMNS_WITHOUT_FOREIGN_KEY` with the `referral_events.subject_id`
reasoning, and `referral_risk_signals.subject_id` additionally because the
retention clocks differ in the direction a foreign key cannot express.

## Affiliate outbound redirects and commission (#67)

`affiliateOutbound.ts` — six tables, one migration (`0080`, `pre`). #57 stores an
offer's destination and #62 decides whether it may be linked to at all; this is
what happens when somebody presses the button, and what a network says about it
weeks later.

- **`affiliate_outbound_hosts` is the only table here that DECIDES anything**,
  and it is the destination allow-list — issue requirement 2, "resolve only an
  allowlisted source, storefront and destination". A host, approved by an
  operator, scoped to ONE catalog source, revocable, attributable. It is a TABLE
  rather than a config value because which shops a source sells changes without
  a deploy; the affiliate networks' OWN redirectors are the opposite case and
  are a CODE constant, for #66's reason — a configurable set would make "which
  hosts may Mercaria redirect to" answerable per deployment, which is the shape
  an open redirect eventually takes. An EMPTY table permits the network
  redirectors and nothing else, which is the correct starting state.
- **`host` is a bare lower-case hostname and a CHECK says so**: no scheme, no
  path, no port, no userinfo, no wildcard. A stored `*.example.com` would make
  the admission code INTERPRET the row, and an allow-list that needs
  interpreting is one whose meaning can drift from what the operator who typed
  it believed. Comparison at redirect time is EXACT against a parsed
  `URL.hostname` — never `endsWith`, under which an approved `example.com` also
  admits the PREPENDED `notexample.com`. That is the shape that does the work,
  and it was proved by mutation: `example.com.evil.test` is refused by
  `endsWith` anyway, so a test carrying only the appended example stays green
  against the very mutation it is meant to catch.
- **The literal dot in `affiliate_outbound_hosts_shape_check` is `[.]`, never
  `\.`** — a tagged template literal has its escapes COOKED before drizzle sees
  the string, so `\.` loses its backslash and becomes `.`, which matches any
  character and ADMITS `localhost`. Measured on a live server, and invisible to
  `tsc`, to drizzle-kit and to the migration, all of which handle a wrong regex
  perfectly happily. Any future regex CHECK in this schema must use a character
  class for the same reason.
- **The click row has NO foreign key at all**, and every id on it is a recorded
  VALUE. The `watchlist_snapshot_items.selected_offer_id` ruling applied to a
  whole row, for two reasons rather than one: `offers` CASCADEs from `listings`,
  so a real key would let a seller's deletion destroy commercial history a
  network reports against weeks later; and #59's merge repoints live references,
  which would attribute a past click to whichever product won a merge that
  happened afterwards.
- **There is no actor column anywhere in the six tables** — no Oxy id, no guest
  session, no pseudonymous id, no IP, no user agent. #67's click requirement 5
  offers a signed-in id "when permitted and needed" or a pseudonymous session
  id; the answer taken is NEITHER, because every metric the issue names is a
  COUNT or a SUM over offers, merchants, sources and markets, so a per-person
  handle on a commercial record retained for accounting buys nothing and is a
  correlation key. `consent_mode` is still recorded: the lawful basis for the
  measurement is a fact about the request even when the measurement names
  nobody. The two operator stamps on the allow-list are the deliberate
  exception, and a gate walks the real tables to keep it at two.
- **Two biconditionals, never one over their conjunction.**
  `affiliate_outbound_clicks_outcome_shape_check` ties `disposition` to
  `refusal_reason` AND to `destination_host` separately, because the single
  predicate is SATISFIED by a row that is neither — both sides evaluate false —
  which admits exactly the row it exists to refuse. Measured twice already in
  this schema (#108's portal grants, #126's delivery promises); written the long
  way here from the start.
- **`affiliate_report_runs` carries the vacuity floor as a CHECK**, scoped to a
  COMPLETED run: `seen` must EQUAL the five outcome counters summed (#60's
  device). A `running` row's counters are still moving and a `failed` one
  legitimately read part of a page, so only a run claiming it finished must
  account for everything it saw.
- **Dedup is `UNIQUE(network, network_transaction_id)`** and the upsert is
  `ON CONFLICT … DO UPDATE … RETURNING`. A re-poll of an overlapping window is
  the NORMAL case — windows are chunked to 31 days and re-polled to catch
  corrections — so "already seen" is an answer the index gives, never an error a
  catch interprets. `network_transaction_id` is a FOREIGN service's key and is
  registered in `ID_COLUMNS_WITHOUT_FOREIGN_KEY` beside every other one.
- **`affiliate_transactions_matched_click_key` is the OTHER half of that dedup,
  and it guards a hazard nothing can reach yet.** One click, one transaction:
  the network key stops one TRANSACTION being counted twice, and this stops one
  CLICK being credited twice, which is what a matcher would make possible.
  Nothing can violate it today — `AFFILIATE_CLICK_REFERENCE_SUPPORT` marks both
  networks `not_supported`, so `matchReportedTransaction` returns `unmatched` at
  its first branch and every row's `matched_click_id` is NULL — and that is the
  point: the constraint lands BEFORE the code that could breach it, rather than
  after somebody finds two commissions on one click in a statement. PARTIAL on
  `is not null`, stated rather than left to Postgres's NULLs-are-distinct rule,
  which this schema has been bitten by before. It is NOT a foreign key, for the
  retention reason `ID_COLUMNS_WITHOUT_FOREIGN_KEY` records. A violation is a
  raised `23505` that rolls the apply transaction back and books nothing; it is
  deliberately not caught, because there is no basis on which code could pick
  which of two transactions keeps the click.
- **Observations and postings are append-only against UPDATE *and* DELETE;
  clicks refuse UPDATE and PERMIT DELETE.** The inversion is deliberate.
  Acceptance 4 ("reversed commissions update reporting without deleting
  history") IS that pair of refusals on the money side, and a posting that could
  be deleted would let somebody unwind money outside the ledger's own reversing-
  transaction rule. A click is telemetry whose retention IS erasure on a
  schedule (`analytics_events`' posture), so a trigger refusing DELETE would
  make the shared expiry sweep fail SILENTLY on every row it is obliged to
  remove.
- **`affiliate_commission_postings` is a TABLE, not a column pair**, because one
  transaction produces several balanced movements over its life — an accrual, a
  reversal, a settlement. `UNIQUE(transaction_id, kind, revision)` claimed with
  `ON CONFLICT DO NOTHING RETURNING` in the SAME transaction as the ledger write
  is the idempotency; `revision` is in the key because a network may approve,
  reverse and approve again, and the second accrual is a DIFFERENT posting that
  would otherwise be swallowed as a duplicate.
- **Two ledger accounts and three transaction kinds were ADDED**, widening two
  CHECKs. `affiliate_commission_revenue` is #89 acceptance 6's third figure
  (subscription, marketplace fee and affiliate commission report separately) and
  `affiliate_receivable` is its debit-normal counterpart — the money a network
  has agreed it owes and not yet paid, which exists because commission is earned
  and settled weeks apart.

## The bounded referral pilots (#149)

`referralPilot.ts` — `referral_pilot_cohorts`, `referral_pilot_partners`,
`referral_pilot_stop_thresholds`, `referral_pilot_stops`. Full behaviour:
`docs/referral-pilots.md`. Binding architecture: ADR 0005, "Rollout and
rollback" phase 2.

**Bounds are rows, not environment variables** (#125's precedent verbatim): a
bound has to be attributable (`published_by_oxy_user_id` NOT NULL on a published
row, by CHECK), has to survive a deploy (frozen once active, by trigger), and a
partner allow-list is a table rather than a comma-separated variable.

- **`referral_pilot_cohorts_active_program_key` is keyed on `program_id`, not on
  `cohort_key`.** A pilot bounds ONE programme, so the admission gate looks a
  cohort up by a fact the touch already carries — and a single global active row
  would make this table a shared slot between parallel realdb files, which is
  `match_policy_versions_active_key`'s hazard. `cohort_key` keeps only the
  version chain's identity, `UNIQUE(cohort_key, version)`.
- **No `reward_rule_version_id`.** #149 item 7's "one immutable commission rule"
  is satisfied by the programme version's own `commission_rule_ref`, which ADR
  0005 D19 pins per ATTRIBUTION. A second pointer would be a second answer to
  which rule governs, on exactly the rows a partner was paid under.
- **`markets` is checked with `coalesce(cardinality(...), 0) >= 1`, never
  `array_length`** (NULL on `{}`, and a CHECK reads NULL as satisfied). The
  alpha-2 shape is `array_to_string(markets, ',') ~ '^[A-Z]{2}(,[A-Z]{2})*$'`
  and NOT `not exists (select … from unnest(…))`: a subquery in a CHECK is
  refused by Postgres outright, and the obvious spelling fails at APPLY rather
  than at review.
- **The expansion review is four columns, all or none**
  (`num_nonnulls(...) in (0, 4)`), plus `(version = 1) = (supersedes_cohort_id
  is null)` so the chain is total, plus `status <> 'closed' or reviewed_at is
  not null`. The trigger permits the review to be written after publication —
  freezing it would make #149's dated decision unrecordable on the version it is
  about — and refuses a SECOND write of the same four.
- **`referral_pilot_partners` and `referral_pilot_stop_thresholds` are frozen by
  ONE trigger on INSERT OR UPDATE**, keyed on the parent's status. DELETE is
  permitted: removing NARROWS, and expansion is what #149 forbids.
- **`referral_pilot_stops`** carries the `retail_pilot_stops` shape exactly:
  one live stop per (cohort, metric, scope, scope_ref) by partial unique, the
  origin/raiser biconditional, `num_nonnulls(lift…) in (0, 3)`, and
  `(scope = 'pilot') = (scope_ref = '')`. Append-only against DELETE, with a
  lift as its one permitted update and a lifted row frozen outright.
- **`partner_id` is a REAL foreign key with `restrict`**, unlike the Oxy account
  ids beside it: a partner named by a live pilot must not be deleted underneath
  it, and unlike an Oxy id this one is Mercaria's own primary key. The five
  `*_oxy_user_id` columns are registered in `deferredForeignKeys.ts`, as is
  `program_id` (the stable identity, which `referral_programs` does not key on
  alone).

## The universal taxonomy (#367 step 1)

`catalog.ts`'s `categories`, WIDENED — plus `taxonomy.ts`
(`category_aliases`, `category_redirects`, `category_external_mappings`).
Binding architecture: ADR 0007 D1/D2/D11/D13.

**There is ONE category table and there will not be a second** (D2). A parallel
`taxonomy_categories` would give every listing, collection rule, search filter
and connector mapping two possible answers to "what is this", which is the
failure the epic is written against. `categories` gained seven columns instead.

- **Identity is `id` and `key`, and a `name` or a `slug` is presentation** (D1).
  `key` is a lowercase dotted machine key, unique, and FROZEN after insert by
  `mercaria_category_key_frozen` — a renamed key is indistinguishable from a
  different concept to every seed, fixture, external mapping and export that
  cited it, so a category whose key was wrong is deprecated and superseded. Its
  format CHECK carries **no backslash** (`[.]`, never `\.`): a backslash inside a
  drizzle `sql` template is eaten by the JS parser and would reach Postgres as a
  bare `.`, matching any character.
- **The backfill derives `key` from the row's own slug PATH by plain
  concatenation**, and `src/scripts/taxonomy.ts` carries the same 36 keys as
  literals. A derivation with no transformation in it is the only one that gives
  a restored production database and a freshly seeded developer one the same key
  for the same shelf. It is DATA in the seed, never computed there — a script
  that composed the key from the slug would make editing a slug edit an identity.
- **`lifecycle` is the authority and `is_active` is its derived v1 read** (D13).
  `CATEGORY_ACTIVE_LIFECYCLES` states the derivation once and
  `db/taxonomy/taxonomyRepository.ts` applies it. There is deliberately no
  cross-column CHECK yet: it would break a write the serving image performs, so
  it is a `post`-phase statement named in `0087`'s header. Until then
  `taxonomy-write-chokepoint.test.ts` is what holds it — one writer.
- **`suppressed` and `selectable = false` are not two spellings of one fact.**
  Suppression decides whether shoppers SEE a node; selectability decides whether
  a product may be FILED under it. The connector holding pen is `suppressed` and
  selectable; a structural grouping root is `published` and not selectable.
  Collapsing them makes one of the two unrepresentable.
- **`ancestor_ids` is the ancestry and `ancestor_slugs` is its v1 spelling**
  (D2/D13), both root-first, both written from the parent's own arrays by the one
  repository so they cannot disagree. A materialized path with a GIN index, not a
  closure table — the shape was already here, the tree is shallow, and every hot
  read is descendants-of or breadcrumb-of. **The choice is provisional on #61's
  benchmark**, and ADR 0007 D2 says the ADR is amended before an alternative is
  adopted, never after.
- **What ONE ROW says about itself is a CHECK; what the TREE says is a trigger.**
  Self-parenting and merging into oneself are `categories_parent_not_self_check`
  and `categories_merged_into_not_self_check`; cycles of length two and up, and
  merging into a DESCENDANT, are `mercaria_category_hierarchy_guard`. The trigger
  RETURNS on the two same-row cases rather than reporting them — pre-empting a
  CHECK leaves it unreachable, and a constraint nothing can ever violate is
  indistinguishable from one that does not work. Measured: it did, and the realdb
  case for self-parenting failed on the trigger's message instead.
- **A merge states its successor and a successor states its merge** — a
  biconditional CHECK, so "merged into nothing" and "a successor on a published
  row" both have no row shape.
- **`mercaria_category_assignment_selectable` is a TRIGGER, and ADR 0007 D2 calls
  it a CHECK.** A CHECK may not read another row and `categories.selectable` is
  another row; the ADR reaches the same resolution one paragraph later for
  cycles. It covers `listings` and `canonical_products` and deliberately NOT
  `canonical_product_families` — a family is itself a grouping, which is the
  legitimate case `selectable = false` describes.
- **`category_redirects` is append-only against UPDATE *and* DELETE**, unlike the
  tables `expiryTargets.ts` sweeps: nothing expires a redirect, and a URL that
  resolved last year should resolve today. A redirect pointing at the wrong
  category is corrected by a redirect FROM that wrong target onward, which the
  resolver follows — so a correction is a new row and the mistake stays visible.
  `mercaria_category_redirect_cycle_guard` refuses a CYCLE absolutely, and its
  8-hop bound is a separate and weaker thing — it sees only the chain AHEAD of a
  new redirect's target, so tail-extension builds a chain past it. Bounding the
  real depth means a BACKWARD walk, which is a fan-in and therefore a tree
  traversal per insert; that cost is not paid and the resolver answers
  `chain_exhausted`, carrying no category.
- **THREE biconditional CHECKs on the redirect subject, not one over their
  conjunction.** The single spelling is SATISFIED by a `category_id` row carrying
  a locale and no slug, because both sides evaluate false — the exact row the
  discriminant exists to forbid. `category_external_mappings` carries the same
  pair for its reviewer and its review instant.
- **Both redirect subjects are PARTIAL uniques.** Postgres treats NULLs as
  distinct, so a plain unique over the nullable subject columns admits any number
  of rows.
- **A category alias is never globally unique.** `(category_id, locale,
  normalized_alias)`, so one normalized alias may name several categories —
  "phone" legitimately points at more than one shelf, and a constraint refusing
  the second one would make the taxonomy unable to record something true. The
  ambiguity is the reader's; `findCategoriesByAlias` returns a list. There is no
  `is_primary`/`preferred` column, so an alias cannot claim to be the name.
- **`category_external_mappings` carries two uniques answering two questions**:
  `(source_id, external_key, version)` makes "versioned" real, and the partial
  `(source_id, external_key) WHERE valid_to IS NULL` makes "one current answer"
  real. `confidence` is NULL for a mapping that was STATED rather than inferred —
  imputing 1.0 would make an operator's mapping indistinguishable from a matcher
  that was very sure.
- **Zero new `jsonb`.** Every shape in this domain is Mercaria's own and closed,
  so none of them earns an entry in the register above. ADR 0007 D14 permits
  exactly three uses and none of them is here.
## Navigation trees (#367 step 7)

`navigation.ts` — five tables, ADR 0007 D3. The hand-written triggers live in
migration `0090_sad_black_panther.sql`, in nine
`-- oxy:handwritten-begin=mercaria_navigation_*` marker pairs; re-apply them
after EVERY regeneration. (They staged in a `navigation.pending.sql` while
ADR 0007 D11 serialized the slot; that file went with the migration that carried
them.)

- **The domain writes to five tables and reads four more.** `categories`,
  `collections`, `brands` and `canonical_product_families` are READ for two
  things each — the identity a node points at, and whether it may be shown — and
  written by nothing here. That is D3's "nothing in navigation may write to
  `categories`", and it is held by narrow selects plus
  `services/__tests__/navigation-isolation.test.ts`, which scans the domain,
  both route files, the controller and the schemas.
- **A node that means two things has no row shape.**
  `navigation_nodes_target_shape_check` is SEVEN biconditionals — one per
  `target_kind`, each `(kind = 'x') = (pointer is not null)` — ANDed, plus
  `num_nonnulls(<all seven>) = 1`. The single-expression spelling ("the selected
  pointer is set and exactly one is non-null") ADMITS a row whose kind is
  `brand` and whose only pointer is a `collection_id`; the
  `retail_delivery_promises_observed_shape_check` finding, met again. The count
  term is what fails if an eighth pointer column is added without extending the
  biconditionals.
- **`product_type_key` is a stable KEY and carries no foreign key.**
  `product_type_definitions` is merge-order step 3 and does not exist yet, and an
  unconstrained `product_type_id` uuid would look like a foreign key to every
  reader while enforcing nothing. A key is also the right pointer (D1): a node
  means "the smartphone product type", not "version 4 of it". Adding the FK later
  is additive and needs no data change.
- **Sibling ordering is TWO partial unique indexes, not one.** Postgres treats
  NULLs as distinct, so `unique(tree_id, parent_id, position)` alone lets two
  ROOT nodes share position 0. `…_child_position_key WHERE parent_id is not
  null` plus `…_root_position_key WHERE parent_id is null`; the read tie-breaks
  on `key` as well.
- **There is no stored `depth`.** The cycle trigger walks the parent chain
  anyway and counts hops in the same pass; a stored depth would be a second
  representation of that chain, stale the moment a subtree moves. The bound is
  `NAVIGATION_MAX_DEPTH`, and because a hand-written trigger cannot read a
  TypeScript constant, the isolation test BUILDS its assertion from the constant
  and greps the pending SQL for it.
- **The live-window exclusion is a trigger, not a unique index.** "At most one
  live tree per `(market, locale, surface)`" cannot be a partial unique, because
  scheduling requires the successor to EXIST, published, while the incumbent is
  still live. What must not overlap is the WINDOW. The trigger is a refusal and
  not a mutual exclusion, so the publish path takes `FOR UPDATE` on that
  surface's published rows first.
- **`lifecycle` has three members and no `scheduled`.** Live is
  `published` ∧ inside `[effective_from, effective_to)`; a fourth state would be
  a second answer to a question the window already answers, and the two would
  disagree the first time a job ran late.
  `(lifecycle = 'draft') = (published_at is null)` is a CHECK, which is what
  makes "a draft is never publicly readable" a property of the row rather than of
  whoever wrote the query.
- **A published tree is frozen, and so is everything hanging off it** — three
  triggers. The exceptions are exactly two and both are decisions taken after
  publication: `effective_to` (scheduling an end) and a node's `visibility` (an
  incident lever that required republishing a whole menu is one nobody can pull
  at 3am). A typo fix is therefore a new version, which is the
  preview-then-publish discipline rather than an oversight.
- **`mercaria_navigation_published_nodes_frozen` and `…_labels_frozen` are TWO
  functions, not one body reading `TG_TABLE_NAME`.** plpgsql resolves a record's
  fields when it prepares the expression containing them, so a single function
  mentioning both `NEW.tree_id` and `NEW.node_id` raises "record NEW has no
  field" on whichever table it is attached to — at RUNTIME, on the first write,
  not at creation. Any future trigger shared across two tables in this schema has
  the same constraint.
- **`navigation_node_localizations` is ADR 0007 D4's per-entity shape** (locale,
  status, provenance, source_locale, source_revision, reviewed_by, reviewed_at,
  `UNIQUE(node_id, locale)`), and the node row carries NO label column at all —
  which is what makes "stable ids and keys PLUS localized presentation, never
  presentation alone" a property of the schema. Its status and provenance tuples
  are navigation-local COPIES of D4's vocabulary and are deleted when the
  localization family (merge-order step 2) lands; two lists describing one
  vocabulary can disagree, and the direction they disagree in is always the
  permissive one.
- **Every locale column carries a BCP-47 SHAPE check written with character
  classes and no backslash** — the `attribute_labels` predicate verbatim. A regex
  written in a JS template literal loses its escapes on the way into the
  generated SQL, and the damage is silent: a `\.` that became `.` produces a
  CHECK that admits what it was written to refuse. It becomes a `checkOneOf`
  against the supported-locale tuple when that tuple exists.
- **`navigation_nodes.campaign_url` is `like 'https://%'`, not a regex**, for the
  same reason: a URL pattern is exactly where a lost backslash does its damage,
  and `like` needs none. The request schema parses it with `URL` as well, which
  is what tells `https://evil.example@mercaria.co` from `https://mercaria.co`.
- **A saved query's filters are real columns, never JSONB** (D14 permits a
  source-shaped payload, an immutable schema snapshot and a bounded rule AST; a
  filter set is none of the three), with `navigation_saved_query_attribute_filters`
  as a child table because an array of `(attribute, values)` pairs is a JSONB bag
  by another name. Its `values` uses `cardinality(...) >= 1`, NEVER
  `array_length` (NULL on `{}`, and a CHECK reads NULL as satisfied, so the
  obvious spelling admits exactly the empty array it refuses).
- **A price bound is one currency for both ends** — amount-and-currency present
  together per end, the two currencies forced equal, and the range the right way
  round. `optionalMoney` gives each bound its OWN currency column, so a reader
  that treats `price_min_currency` as "the" currency silently drops a max-only
  filter; the projection reads `min ?? max`.
- **There is no sort, intent, weight, boost, rank or policy column anywhere in
  the domain.** Ordering within a menu is `position`, an editorial sequence
  somebody typed; how RESULTS are ordered is #74's, behind its versioned policy.
  `NAVIGATION_FORBIDDEN_TARGET_KINDS` names `sponsored_placement`,
  `paid_ranking_slot` and `category_write` as VALUES, disjoint from the permitted
  seven by a test.
- **`navigation_trees.published_by_oxy_user_id` and
  `navigation_node_localizations.reviewed_by_oxy_user_id`** are registered in
  `deferredForeignKeys.ts` as `OXY_ACCOUNT`: Oxy owns identity, and both sit on
  rows whose purpose is to answer "who decided this", which an erasable actor
  column would answer with a NULL.
## External taxonomy, attribute and value mappings (#367 Workstream 11)

`catalog_external_mappings` + `catalog_external_mapping_reviews` +
`catalog_external_token_observations` + `catalog_external_mapping_runs` +
`catalog_external_mapping_run_items` (5 tables). Full reference:
**`docs/catalog-external-mappings.md`**; binding decisions are ADR 0007 D1
(identity is an id and a stable machine key, never a name), D13 and D14.

- **ONE table for FIVE dimensions** — product type, attribute, controlled value,
  unit, size system — discriminated by
  `catalog_external_mappings_target_shape_check` (the `navigation_nodes` device,
  D3). Five tables would be five copies of the versioning, confidence, review,
  validity, fan-out and reprocessing machinery, and the copy that drifted would
  be the one nobody read. The CHECK's **`else false` branch is load-bearing**: a
  sixth dimension added to the shared-types tuple with no branch here fails every
  write loudly rather than admitting a row with no target.
- **CATEGORY is deliberately NOT one of them.** ADR 0007 D2 assigns
  `category_external_mappings` to the taxonomy module and that table exists. A
  `category` member here would be a second table answering one question, so the
  isolation gate fails the build on the tuple member OR on any column matching
  `/category/i`. Consolidating the two is an ADR amendment plus a move migration
  in ONE pull request, never an amendment now and a migration later.
- **Every target is a stable machine KEY and carries NO foreign key, by DESIGN
  rather than by timing.** `product_type_definitions` and `attribute_definitions`
  have no unique constraint on `key` alone and will not get one, because the
  one-live-version index is PARTIAL (`WHERE lifecycle = 'published'` /
  `= 'active'`) — Postgres refuses a foreign key onto a partial unique index, and
  the house rule additionally forbids one onto a `uniqueIndex()`. Each row is ONE
  version, so an id-valued target would bind a reviewed decision to a version
  that will be deprecated. What makes a key target safe is that `key` is frozen
  from INSERT by a trigger on both registries, and resolution reads the single
  live version through the registry's own reader — never an `ORDER BY … LIMIT 1`,
  which is a query with a bug in it the moment two rows exist.
- **Which version a mapping was REVIEWED against is a separate provenance
  column** (`reviewed_product_type_definition_id`), CHECK-confined to
  `product_type` rows, frozen by the immutability trigger, and **never applied**.
  It names a row by its opaque primary key, so unlike the key columns it CAN
  carry a foreign key: it is the sole `DEFERRED_FOREIGN_KEYS` entry, and that
  gate fails the build the moment `product_type_definitions` lands. Stating in
  the schema, the DTO and the doc that it is never the resolution target is what
  keeps the key and the id from becoming two answers to one question.
- **A silent one-to-many is refused by an INDEX.**
  `catalog_external_mappings_live_primary_key` is a partial unique over
  `(source, dimension, normalized key)` `WHERE state = 'approved' AND valid_to IS
  NULL AND fan_out_approved_at IS NULL`, so a second live target needs a recorded
  fan-out approval — priced at a second operator by
  `..._fan_out_four_eyes_check`. **That CHECK must keep its
  `approved_by_oxy_user_id is not null` conjunct**: `x <> NULL` is NULL and a
  CHECK rejects only FALSE, so the obvious spelling admits a fan-out on a mapping
  nobody approved. Same family as `array_length` on an empty array; this schema
  has now been bitten by that shape twice.
- **`external_key_normalized` is a STORED GENERATED column** on all three
  token-bearing tables (the `attribute_value_aliases.normalized_alias` device).
  Two consequences. (1) A `BEFORE UPDATE` trigger must compare `external_key`,
  never the generated column — it is computed AFTER the trigger, so `NEW.<col>`
  is NULL and the comparison raises on every update. (2) **There is no TypeScript
  normalizer, deliberately**: `lower(btrim(x))` and `x.trim().toLowerCase()` are
  NOT the same function (`btrim` strips ASCII spaces only; `lower` follows the
  database collation), so every lookup compares the indexed column against
  `lower(btrim($1))` and Postgres is the single authority on both sides. Getting
  this wrong is a lookup miss nobody can reproduce.
- **Resolution state is TWO biconditionals, never one over their conjunction.**
  `catalog_external_token_observations` states `resolved` and `unresolved`
  separately: the single spelling is SATISFIED by an `unresolved` row carrying a
  mapping id, because both sides evaluate false. #126 and #81 each hit it.
- **A run's counters SUM to `scanned` by EQUALITY** (#60's vacuity floor), and
  `catalog_external_mapping_run_items` carries the evidence beside the tally so
  the two can be compared — a counter that only agrees with itself measures
  nothing. `UNIQUE(run_id, subject_key)` with `ON CONFLICT DO NOTHING` is what
  makes a run idempotent AND resumable at once; `DO UPDATE` would let a resumed
  page double its own counters.
- **`cardinality()`, never `array_length()`**, on every array CHECK here.
- **No `jsonb` column**, so ADR 0007 D14's permitted-JSONB register is unchanged.
- **Every foreign key is `restrict`** except `run_items → runs` (`cascade`: an
  item is meaningless without its run, and a run is never deleted). The domain
  issues no DELETE and three triggers refuse one.
- **`supersedes_mapping_id` is a SELF reference**, which drizzle-kit emits
  correctly. The one it silently drops from both the migration and the snapshot
  is a CIRCULAR reference between two tables — measured on #66.
- **The hand-written trigger SQL is wrapped in NAMED marker blocks** — FIVE for
  seven triggers, because `mercaria_catalog_external_no_delete` is one function
  mounted on three tables and a marker name may not repeat in a file. Separators
  are `--> statement-breakpoint` on each complete statement's terminating `;`,
  which for a function is the `$$;` closing the body. **A separator inside a
  `$$ … $$` body halves the function** — that is the failure mode that matters.
  An un-separated paste applies fine (`sql.raw` reaches postgres.js as a
  parameterless `unsafe`, which uses the simple protocol and accepts multiple
  commands), so the separators are robustness rather than correctness.
- **EVERY trigger whose body enumerates columns needs a DECLARED PARTITION, and
  both here have one.** A hand-maintained column list beside a real table has
  nothing measuring the two against each other, so the trigger enforces whatever
  somebody last remembered to type and looks identical either way. The census
  declares each column frozen by the trigger or mutable WITH A REASON and
  asserts the union is exactly the table's column set — so a column added later
  fails the build until somebody decides which it is, and a declaration naming a
  column that no longer exists fails as a stale entry.

  Found by mutation-testing: deleting a target column from
  `mercaria_catalog_external_mapping_freeze` changed nothing. The census then
  immediately caught two columns — `evidence_source_record_id` and
  `proposed_by_oxy_user_id` — editable after approval, which would have let the
  record of a decision be repointed away from what was decided on. Audit columns
  are where this bites: the target columns get attention because they are what
  the feature is about.

  `mercaria_catalog_external_review_subject_frozen` has the same shape and the
  same census. Any third such trigger in this schema should get one before it
  ships, not after.

## Typed variant axes and retained claims (#367 step 4)

`db/schema/variantAxes.ts` — five tables implementing ADR 0007 **D6** and **D7**.
Full reference: `docs/variant-axes.md`. Nothing here replaces `listing_options`
or `product_variant_option_values`: D13 retains both, and no module in the domain
can write either (a scanned gate over the whole directory).

### The signature is its own table because a ZERO-axis variant has no other row

`native_variant_signatures` could have been a column on the assignments, and a
variant with no axes would then have no identity at all — which is the commonest
row in this catalogue (a listing with one default variant) and one of the three
cases ADR 0007 D6 names. `UNIQUE(listing_id, signature)` is the collision gate,
so two variants that vary along nothing are refused as the one variant they are.

### `listing_id` on the signature is a DENORMALIZATION with a trigger, and why

An index needs the column, and the correct shape — a composite foreign key onto a
`unique(id, listing_id)` on `product_variants`, the `product_type_field_groups`
device — needs a target that does not exist. Adding it means editing `catalog.ts`,
which #367 step 4 may not, so `mercaria_native_variant_signature_scope()` refuses
any row whose `listing_id` disagrees with the variant's own. Adding that composite
unique is the change that retires the trigger.

### The citation columns repeat the foreign key on purpose

`attribute_key` and `attribute_definition_version` on both the axis and the
assignment are the `product_type_fields` guarded denormalization, for the same
reason: the forbidden-axis prohibition has to be a CHECK, a CHECK admits no
subquery, and a rule that lives only in a service is one forgotten call site from
being no rule at all. `mercaria_native_variant_axis_citation()` and
`mercaria_native_variant_axis_assignment_scope()` refuse any row whose citation
disagrees, so divergence is unrepresentable rather than unlikely.

`native_listing_variant_axes_forbidden_key_check` is rendered from
`PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS` — the SAME tuple
`product_type_fields_variant_axis_check` reads. Two tables, one list; #94 widening
the reserved offer facts widens both.

### `product_type_definition_id` is NULLABLE, and that is a decision

ADR 0007 D6 speaks of "any listing migrated to a product type", and the obvious
reading makes it NOT NULL. `listings` carries no `product_type_definition_id`
today — D13 assigns that widening to the authoring workstream (D10, merge-order
step 5) — so a NOT NULL citation would make the legacy backfill unable to type a
single axis. A backfill that resolves nothing is not a safer backfill.

The permission is checked at TWO grains and only one needs a product type:
`attribute_definitions.variant_defining` (the registry's answer, checked on every
row) and `product_type_fields.variant_capable` + `scope = 'variant'` (the product
type's narrower answer, checked when a version is cited).

### `mercaria_native_variant_signature_agrees` is DEFERRABLE, mounted on two tables

The `mercaria_catalog_source_rights_agree` device. A signature is a claim about a
SET of rows in another table, so no row trigger can see whether the set is what
was hashed, and writing a variant's axes touches two tables with one always
first. Mounted on BOTH and on all three operations, because the failure is
one-sided by nature: an assignment written without the digest being recomputed
leaves two distinct variants colliding, and a signature removed while its
assignments remain leaves a variant with axes and no identity.

The existence guard inside it is load-bearing: deleting a variant cascades both
tables, and without it the commit would fire for every deleted assignment and
find no signature. It checks the COUNT and not the VALUES — re-hashing in plpgsql
would need a digest function this schema does not otherwise require — and
`variant-axes.realdb.test.ts` covers the content half.

### Every claim resolution rule is a BICONDITIONAL, and the refusal pairs are TWO

A one-way `resolved ⇒ value present` still admits a BLOCKED claim carrying a
normalized value, which is "we could not tell, so we stored our best guess" — the
false merge ADR 0007 D6 names #58's shape for. And
`(a = 'blocked') = (b is not null)` conjoined with
`(a = 'refused') = (c is not null)` is **not** one CHECK over their conjunction:
the collapsed form is satisfied by a row where every side is false, which admits
precisely the row the rule exists to refuse. Measured twice already in this
schema (`retail_delivery_promises_observed_shape_check`,
`watchlist_snapshot_items`), both times by a real server.

### The claim delete exception is PRECISE, the #90 device

`mercaria_native_claim_no_delete` refuses a DELETE **only while the subject row
exists**. A blanket `BEFORE DELETE` refusal fires during the cascade from
`listings` and `product_variants` too, so deleting a listing would become
impossible; an unconditional permission would let an operator remove the
assertion their own resolution disagreed with. Same shape as
`mercaria_condition_revisions_append_only`.

### The legacy pointer carries NO foreign key, and the reason is the WRITE path

`db/catalog/listingRepository.replaceListingOptions` and
`variantRepository`'s equivalent DELETE-then-INSERT a listing's whole option list
on every update, so a legacy row's id is not stable across a merchant editing
their listing. A `restrict` edge onto it would refuse every listing update and a
`cascade` would delete the preserved claim — which is the one thing "preserved
verbatim" must not permit. The claims converge on the CONTENT instead
(`<table>_identity_key`, over two GENERATED key columns), which survives the
churn. `native_variant_axis_assignments.source_claim_id` is in
`ID_COLUMNS_WITHOUT_FOREIGN_KEY` for a related reason recorded there.

### These five tables need no `merge-plan.ts` entry, and a test says why

`services/curation/merge-plan.ts`'s census walks foreign keys targeting a
MERGEABLE entity. Every target here is a native listing, a native variant, an
attribute definition, an enum value, a connection or a product type version —
none of which a merge can act on. `variant-axis-schema.test.ts` asserts the exact
target set, so a foreign key added later that DOES reach a mergeable entity fails
this domain's own build before it reaches the census.
## Releasing a connector field pin (#427)

`listing_pin_releases`, in `schema/connectorPins.ts` — one table, exported after
`catalog` because `listings` is its parent. `listings.overridden_fields` stays
exactly what it was: a bare `text[]` an ordinary merchant edit appends to and
the connector merge reads.

- **The RELEASE is written down and the PIN is not, and that asymmetry is the
  whole reason the table exists.** A pin records itself — the key's presence in
  the column IS the evidence a merchant took that field over, and it survives
  for as long as the fact does. A release REMOVES the key, so it destroys the
  only trace the pin ever existed. What the merchant sees next is the platform
  overwriting a title somebody wrote by hand, with nothing anywhere connecting
  that to a person pressing a control weeks earlier — the listing reads exactly
  like one that was never pinned. `staff` holds `products:write`, so "who let
  the platform take my description back" has to be answerable and is inferable
  from nothing else in the schema.
- **One row per key ACTUALLY removed, never one per request.** The release is
  idempotent — a key that is no longer held is removed from nothing — and
  recording the attempt would make a retry, a double tap and two dashboards
  converging on one state read as three separate decisions. The writer takes the
  difference the UPDATE itself returned, so a converging repeat writes nothing.
  This is the opposite posture from `payment_repairs`, which audits every
  ATTEMPT including refusals, and the difference is what each is FOR: an
  operator repair is a discretionary act whose refusals are themselves
  interesting, while this is a record of state that changed.
- **`field` is plain `text` with a non-empty CHECK and NO membership CHECK
  against `PINNABLE_CONNECTOR_FIELDS`.** The column it releases from can hold a
  key no merchant edit writes, and a release that could not reach one would
  leave it stuck permanently (#420's `unnamed` count is what makes those
  visible). A membership CHECK here would make exactly the unreachable case
  unrecordable too — the audit trail refusing the one release that most needs
  explaining.
- **`released_by_oxy_user_id` carries no foreign key** (Oxy owns identity) and
  is ledgered in `ID_COLUMNS_WITHOUT_FOREIGN_KEY`. It must survive the Oxy
  account being deleted: an actor column that could become NULL answers the
  question this table exists for with nothing.
- **Append-only by trigger, with the `listing_condition_revisions` DELETE
  exception.** UPDATE is refused outright; DELETE is refused only while the
  listing still exists, so the `ON DELETE cascade` the foreign key declares
  keeps working and an operator still cannot remove one row to hide one release.
- **The removal itself is ONE statement in `listingRepository.ts`** — a `with
  locked as (… for update)` CTE feeding an `UPDATE`, so two concurrent releases
  of different keys both survive. A read-then-write gives the loser a `before`
  fetched outside the lock and restores the winner's key, and the only symptom
  is a pin that reappeared, which is indistinguishable from the merchant having
  re-edited the field. It is also the schema's first `update ${listings}` inside
  a `sql` template, which `listing-publication-chokepoint.test.ts` was blind to
  until #427 added that branch to its detector.

## Catalog proposals and operator review (#367 step 6)

ADR 0007 **D9**. Four tables — `catalog_proposals`,
`catalog_proposal_duplicate_candidates`, `catalog_proposal_references`,
`catalog_review_events` — plus five triggers. Full reference:
`docs/catalog-proposals.md`.

### There is no `key` column and no `slug` column, on any table here

ADR 0007 D1 makes the machine key identity, frozen after insert and cited by
every seed, fixture, external mapping and export. A submitter who could propose
one would be proposing identity. The operator mints it at approval time, in the
request body, so a merchant's spelling has no column it could arrive in — which
is stronger than any check that would have to refuse it. The label is stored in
three forms instead: `proposed_label` verbatim, `normalized_label` (convergence)
and `search_label` (retrieval).

`normalized_label` and `search_label` are two columns and not one because they
disagree on a legal suffix. `Acme Ltd` normalizes to `acme` — right for "is this
the same request" — and searches as `acme ltd`, because a trigram index built
over the folded space cannot find `Acme Ltd` for somebody typing it. Both are
PLAIN columns written by the service, the `organizations.normalized_name`
decision: the folding is application vocabulary that may deepen, and a generated
column's rewrite silently drops indexes.

### `convergence_key` is GENERATED, and injective WITHOUT escaping

`type : attribute : category : product type : normalized label`, STORED, with a
partial unique over `CATALOG_PROPOSAL_OPEN_STATES` (rendered from that tuple, so
the index predicate and the service's idea of "open" cannot drift). Two merchants
asking for the same colour converge on ONE proposal and the second becomes a
REFERENCE.

The join needs no escaping because **only the LAST component is free text**:
every other is a closed-tuple member or a uuid, none of which can contain the
`:` separator. #63's `identity_key_fields` had to escape its parts precisely
because they were all free text. Stating the difference is what stops somebody
"simplifying" this into the ambiguous shape.

`mercaria_catalog_proposal_freeze` therefore names the FIVE RAW COMPONENTS and
never `new.convergence_key`: a stored generated column is computed AFTER a
`BEFORE UPDATE` trigger, so `NEW.<col>` is NULL there and the comparison raises on
every update. Third time in this schema (#59, Workstream 11, here).

### The resolution biconditional is the row-level half of D9's rule

`catalog_proposals_resolution_check` ties `resolved_entity_id`'s presence to
membership of `CATALOG_PROPOSAL_RESOLVED_STATES`, rendered from that tuple. A
`submitted` row naming a catalogue entity has no shape, so nothing that joins
through the column can pick up an undecided request whatever a service does.

`catalog_proposals_decider_distinct_check` is the one worth reading beside it:
nobody approves their own request. It exists for the merchant who is also on the
operator allow-list, and it costs a real operator nothing, because creating
catalogue data directly is what the owning surface is for.

### `resolved_entity_id` carries NO foreign key, and it is TWO reasons at once

Polymorphic over eight entity kinds, so one column cannot reference eight tables
and the `merchant_claim_scopes.scope_ref` ruling applies. AND four of the eight
are MERGEABLE entities, where a `restrict` key would let an answered proposal
block a catalogue merge while every other `ON DELETE` would erase or silently
empty the record of what an operator decided. A resolved id that has since been
merged resolves through the tombstone's own `merged_into_id`, the
`catalog_authoring_drafts` selection ruling — **which is also why this domain
needs no `services/curation/merge-plan.ts` entry.**

### The vacuity floor is a CHECK

`duplicate_scan_candidates <= duplicate_scan_population`, and
`catalog_proposals_scan_dated_check` refuses a population with no instant. The
population is the size of the set the detector actually READ, returned by the
detector rather than supplied to it — so a scan that examined nothing and a scan
that examined nine hundred labels and liked none are different rows, where an
empty candidate list alone cannot tell them apart. Both counters are frozen by
the request freeze: an editable population would make the one number that says
whether detection looked at anything editable after the fact.

### `catalog_review_events.proposal_id` is `restrict`, NOT `cascade`

Because `mercaria_catalog_review_event_append_only` refuses DELETE. A cascade
beside a no-delete trigger is a way to remove the audit trail by removing its
parent, and the two would disagree with the trigger winning in the confusing
direction — the delete of the PROPOSAL fails, naming a table the operator did not
touch. The declaration agreeing with the trigger is what makes the refusal
legible. The `buyer_request_events` rule.

The same reasoning inverts one table over: `catalog_proposal_duplicate_candidates`
refuses UPDATE and PERMITS DELETE (the `analytics_events` posture), because those
rows cascade from their proposal and are a retention sweep's natural target, and
a trigger refusing that would make the sweep fail SILENTLY.

### `catalog_proposal_references` needs TWO partial uniques and a paired CHECK

Postgres treats NULLs as DISTINCT, so a single unique over
`(proposal_id, draft_value_id, listing_claim_id)` would admit any number of rows
for either kind — each carries exactly one NULL. The kind discriminant is TWO
biconditionals and never one over their conjunction: the single spelling is
satisfied by a row carrying NEITHER pointer, because both sides evaluate false,
which is exactly the reference that names nothing. Fourth time in this schema
(`category_redirects`, `retail_delivery_promises`, `catalog_authoring_drafts`,
here).

`catalog_proposal_references_draft_pair_check` demands the DRAFT beside the
value, because the backfill bumps the draft's optimistic-concurrency token after
rewriting one of its answers and a value id alone cannot say which draft that is.

### The teardown order this domain forces, measured

`redirected_to_proposal_id` is a `restrict` SELF-FK, so a fixture teardown must
delete the REDIRECTED row before its successor. Clearing the pointer instead does
not work, and the failure is the schema behaving correctly: moving the row out of
`redirected` is refused by `mercaria_catalog_proposal_state`, and leaving the
state while nulling the pointer is refused by
`catalog_proposals_redirect_check`. Measured on
`catalog-proposals.realdb.test.ts`' first run.

`catalog_review_events` refusing DELETE means the same teardown disables that ONE
trigger on that ONE table inside a transaction — the narrowest window the
shared-database rules permit.

## Catalog administration and governance (#367 Workstream 12)

Five tables that hold DECISIONS about the catalogue and no catalogue fact:
`catalog_governance_change_requests`, `catalog_governance_impact_counts`,
`catalog_governance_audit_events`, `catalog_governance_role_grants` and
`catalog_governance_definition_snapshots`. Full reference:
`docs/catalog-governance.md`.

### The vacuity floor is a ROW COUNT, and that is why there is a child table

`catalog_governance_impact_counts` is one row per inbound reference the plan
declares — `listings.category_id`, `canonical_products.category_id` and the
other thirty-one — each carrying its own count, **including zero**.

A column per relation, or a single `impact_total`, could not do this job.
Twenty relations counted all zero is a legitimate answer meaning the change is
free; zero relations counted means nobody looked; and `0 = 0 + 0 + 0` satisfies
a sum check for both. Only the ROW COUNT distinguishes them, which is why
`impact_relations_counted >= impact_relations_declared` is a CHECK and the
equality against the child rows is asserted in `insertChangeRequest` — the
single writer — since a CHECK may not contain a subquery.

### `impact_coverage` needs TWO CHECKs, not one over their conjunction

`catalog_governance_change_requests_impact_measured_check` and
`..._impact_unmeasured_check` are separate implications on purpose. Written as
one CHECK over the conjunction of both shapes, a row that is NEITHER satisfies
it because both sides evaluate false — admitting exactly the row the constraint
exists to refuse. The #68 finding
(`retail_delivery_promises_observed_shape_check`), hit again here; any future
multi-column "present exactly when" CHECK in this schema must be written the
same way.

### `requires_second_approval` is snapshotted, and the state CHECK is what makes it real

The `catalog_merge_jobs` decision for its reason: the threshold and
`CATALOG_FOUR_EYES_REQUIRED` both move, and a request whose approval requirement
changed after somebody approved it would either strand a legitimate change or
let an unapproved one through.

`..._second_approval_check` refuses a request that needs two people leaving
`planned` without an approver, and `..._approver_distinct_check` refuses the
requester approving their own. Both are the layer under a service refusal that
says the same thing in words — so a service bug that skipped the gate is refused
by the database.

### Both subject pointers carry NO foreign key, and it is two decisions at once

One column cannot reference nine subject kinds. And an audit row must OUTLIVE
what it describes: a `restrict` key would let a decided change request block a
catalogue merge, while every other `ON DELETE` would erase or silently empty the
record of what an operator decided. The `catalog_proposals.resolved_entity_id`
ruling. Both are ledgered in `deferredForeignKeys.ts`.

The foreign keys onto `catalog_governance_change_requests` ARE real and are
`restrict`, agreeing with the append-only triggers on both children — a cascade
beside a no-delete trigger is a way to remove the evidence by removing its
parent (`catalog_review_events`' rule).

### Three jsonb columns, and each is an immutable snapshot

`change_requests.parameters` (frozen the moment the row leaves `planned`),
`audit_events.before`/`after`, and `definition_snapshots.document`. None is
queried by any predicate and none is joined on; everything queryable — domain,
action, subject, state, both actors, every count — is a real column beside them.

`parameters` earns it as the genuinely sparse case: seventeen actions take
genuinely different parameters, and `apply.ts` reads each by name. The audit
pair earns it because reconstructing a definition's prior shape is the one thing
a governance audit exists for and the shape differs per subject kind.
`document` is the "immutable schema snapshot" case verbatim.

### The snapshot's counts are the export's own positive control

`entity_count` equals the sum of its five parts (a CHECK), and
`..._vacuity_check` refuses `entity_count = 0` outright. An empty export
digests cleanly, restores cleanly and reports "nothing to do" — the one failure
mode a restore cannot recover from. #60's `catalog_backfill_runs` device.

### `catalog_governance_role_grants` narrows the allow-list and can never extend it

`CATALOG_OPERATOR_OXY_USER_IDS` decides who reaches the surface at all, so no
row here can ADMIT anybody — which is what keeps it from being a seventh
allow-list. The partial unique is `(subject, role) WHERE revoked_at is null`, so
a re-grant after a revocation is permitted and the history of who held what
survives. A grant is revoked, never deleted; the trigger refuses DELETE and
freezes everything except the revocation pair, once.
