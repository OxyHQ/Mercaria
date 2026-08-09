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
| `Review` | `reviews` |
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

### The guest domain has NO source model either

`guest_sessions` (`schema/guests.ts`, `drizzle/0013_guest_sessions.sql`) was
born in Postgres for ADR 0003 (#103) — there was never a Mongoose model behind
it and the backfill had nothing to copy into it. Its decisions, so a column
whose shape looks arbitrary is answerable here:

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
- **`converted_at` + `converted_to_oxy_user_id` are a SEAM for #104/#109**,
  written only by the merge/claim transaction; CHECKs force the pair to travel
  together and force converted ⇒ revoked. The Oxy id carries no FK (Oxy owns
  identity) and is in the `ID_COLUMNS_WITHOUT_FOREIGN_KEY` ledger.
- **No email, address, payment method, device fingerprint, or locale/currency
  preference columns** — contact belongs to `guest_checkouts` (#105+), and a
  guest's presentment currency rides the request (ADR 0003 D8).

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

## Register: every `jsonb` column, and why it earned it

`jsonb` is for genuinely shape-less data only. Eight columns qualify in 78 tables;
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
