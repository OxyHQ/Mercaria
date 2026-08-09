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

> **Trap, second guise — the one that costs data, not a crash:** a drizzle column
> interpolated into `sql` renders **bare** when its table is not in that
> statement's `FROM`. In a correlated subquery,
> `where ${orderItems.orderId} = ${orders.id}` renders
> `where "order_id" = "id"` — both names then resolve against the SUBQUERY's own
> table, the predicate compares two of its columns to each other, and the query
> returns `[]` **with no error at all**. This shipped in a sibling Oxy port:
> follow counts read zero on every public profile until a test caught it.
> Mercaria's per-store aggregates, review counts and inventory rollups are full
> of the same shape. Qualify every correlated reference with `qualified(column)`
> from `@oxyhq/db`, and treat "a correlated subquery returned nothing" as a bug
> in the SQL until proven otherwise.
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

The one to audit hardest is anything a UNIQUE constraint depends on — a SKU or a
store handle that Mongoose lowercased on write is unique case-insensitively
today and will not be once the normalization is gone. Either the call site
normalizes, or the index is on `lower(col)`. Decide per column; do not assume.

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
  above) and normalization rules evolve.
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
- **Zero `jsonb` columns.** Every shape in this domain is Mercaria's own and
  closed, so none of them earns an entry in the register below.

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
  `ip_address`, no `user_agent`, no `device_fingerprint`, no `token`), and a
  scan with a vacuity floor and a mutation self-test fails the build on one.
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
| Verification cannot become a PAID boost (#55 product behaviour 5): a relationship carries no commercial column, the relationship domain imports no fee/payment/referral module, and no ranking module reads the relationship domain today | `src/services/commerce-graph/__tests__/relationship-ranking-isolation.test.ts` | no |
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
| EXACTLY ONE purchase order survives two concurrent claims on one idempotency key, with one line set and one birth event | `src/db/procurement/__tests__/procurement.realdb.test.ts` | yes |
| The procurement triggers hold: PO lines refuse UPDATE/DELETE, identity columns are immutable, money/destination freeze after `draft` — and both triggers EXIST in the catalogue (vacuity guard) | `src/db/procurement/__tests__/procurement.realdb.test.ts` | yes |
| A pasted secret fails `credential_reference`'s path CHECK; one platform account maps to one Mercaria row; `(supplier, version)` is unique; an incomplete approval is refused by CHECK | `src/db/procurement/__tests__/procurement.realdb.test.ts` | yes |
| The payment and procurement domains import NOTHING from each other, and each keeps its own order-linkage seam | `src/services/procurement/__tests__/role-separation.test.ts` | no |
| ONE active referral attribution per (program, subject) under two CONCURRENT inserts; the code namespace refuses every case-variant of a taken spelling (the CHECK included); a replayed/concurrent conversion source event converges on one row; correction and supersession are append-only rows naming their predecessor; merge redirects preserve historical references; retirement and suspension block NEW attribution while historical conversions keep transitioning | `src/services/__tests__/referral-writes.realdb.test.ts` | yes |
| Raw referral touches are swept on their own retention, separately from the attributions derived from them | `src/db/__tests__/expirySweeper.realdb.test.ts` | yes |
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
- a partial unique index permits four NULL SKUs and rejects a duplicate value;
- `UNIQUE(decision_id, revision, action)` rejects a replay AND permits a later
  revision's `restore`, which is the half that matters — a key without
  `revision` would pass the first assertion and fail the second;
- the owner-exclusivity CHECK rejects a store listing carrying an `oxyUserId`;
- both sequences allocate distinct ascending numbers.

Anything in this document that a gate does NOT enforce is enforced by review.
The money-column shape, the `ON DELETE` reasoning, the enum-widening audit and
the re-applied Mongoose normalizations are all in that category — they are the
ones to read this file for before opening a PR, not after.
