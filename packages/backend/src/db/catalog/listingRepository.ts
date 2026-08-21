/**
 * `listings` and its child tables — `listing_images`, `listing_options`, the
 * `listing_collections` membership read, and the browse/search queries.
 *
 * One Mongoose document became four tables, so this module is where "a listing"
 * is reassembled. Two shapes leave it, and the split is deliberate:
 *
 *  - {@link ListingRecord} — the base row, nothing joined. This is what search,
 *    browse and collection paging return, because those read hundreds of rows
 *    and none of them need an image.
 *  - {@link ListingChildren} — images, options and collection ids for a BATCH of
 *    listings, loaded in three queries no matter how many listings there are.
 *    Hydration asks for this once per page.
 *
 * Nothing above this layer writes a child table directly: an image list or an
 * option list is replaced WHOLESALE through {@link replaceListingImages} /
 * {@link replaceListingOptions}, which is what the Mongoose sub-document
 * assignment did, and doing it any other way leaves the old rows behind.
 *
 * ## The ORDER BY is written out rather than built with `desc()`
 *
 * `listings_status_published_at_id_idx` was emitted by drizzle-kit as
 * `("status", "published_at" DESC NULLS LAST, "id" DESC NULLS LAST)`, but
 * drizzle's `desc(column)` renders a bare `desc` — and a bare `DESC` in
 * Postgres means NULLS **FIRST**. The two do not match, so a feed ordered with
 * `desc()` cannot use that index for its ordering AND puts unpublished rows at
 * the head of "newest first". `NEWEST_FIRST` states `desc nulls last`
 * explicitly, which matches the index and matches Mongo (a descending Mongo
 * sort puts missing values last).
 *
 * ## `published_at` means the FIRST activation, and this module is its only author
 *
 * Exactly three statements in this repository can write `listings.status` —
 * {@link insertListing}, {@link updateListingColumns} and
 * {@link setListingStatusIfIn} — and all three derive `published_at` from the
 * status they are writing, so no caller states it and no caller can forget it.
 * `listing-publication-chokepoint.test.ts` fails the build if a fourth appears
 * outside this file.
 *
 * The rule, in full: a create whose resulting status is not `active` leaves the
 * column NULL; the FIRST transition to `active` stamps it; nothing ever restamps
 * it and nothing ever clears it. So `published_at` answers "when did this first
 * go on sale", `created_at` answers "when was the row written", and neither is a
 * second representation of the other (#261).
 *
 * Two details are load-bearing. The stamp is a SQL `coalesce` rather than a
 * read-then-write, so two concurrent activations cannot both decide the column is
 * empty and the earlier instant wins. And the instant is bound as an ISO string
 * with an explicit `::timestamptz` cast, because interpolating a value into a raw
 * `sql` template binds it WITHOUT the column's mapper and a `mode: 'date'`
 * timestamptz then reaches postgres.js as a JavaScript `Date`, which throws
 * `ERR_INVALID_ARG_TYPE` (the same trap `searchListingsKeyset` documents on the
 * read side).
 *
 * Rows written before #261 keep their create-time stamp, deliberately: nothing in
 * the schema tells a draft that was never published from one that WAS active and
 * was returned to `draft` (which is exactly what moderation's `request_changes`
 * does), so nulling them would erase a real past publication instant with no way
 * back. A historic draft may therefore carry a stamp; a new one may not.
 *
 * ## `archived_by` / `archived_from_status` are derived the same way (#390)
 *
 * The SAME three statements are the only ones that can write those two columns,
 * and they derive both from the status they are writing — the cause from the
 * caller, the previous status from the row's own pre-update `status` in the same
 * SQL. `ListingColumnPatch` and `NewListing` SUBTRACT them, so there is no
 * argument through which a caller could state either directly.
 *
 * That is what makes the fact trustworthy rather than merely present. Anything
 * else — a service writing the pair beside a status, a helper reading the
 * listing first — reintroduces the two failure modes this exists to remove: a
 * writer that forgets, leaving a stale record the next reader believes, and a
 * read-then-write whose "previous" status was true a moment ago.
 */

import {
  and,
  arrayContains,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { qualified } from '@oxyhq/db';
import {
  LISTING_BASE_TEXT_SEARCH_CONFIGURATION,
  MERCARIA_BASE_LOCALE,
  asSupportedLocale,
  conditionKeysInGroup,
  textSearchConfigurationForLocale,
} from '@mercaria/shared-types';
import type {
  ConditionGroup,
  CurrencyCode,
  ItemConditionKey,
  ListingArchiveCause,
  ListingOwnerType,
  ListingQuery,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { listingImages, listingOptions, listings, productVariants } from '../schema/catalog.js';
import { listingLocalizations } from '../schema/catalogLocalization.js';
import { connections } from '../schema/connectors.js';
import { listingCollections } from '../schema/merchandising.js';

/** One row of `listings` — no children joined. */
export type ListingRecord = InferSelectModel<typeof listings>;

/** One row of `listing_images`. */
export type ListingImageRecord = InferSelectModel<typeof listingImages>;

/** One row of `listing_options`. */
export type ListingOptionRecord = InferSelectModel<typeof listingOptions>;

/** The child rows of a BATCH of listings, keyed by listing id. */
export interface ListingChildren {
  readonly images: Map<string, ListingImageRecord[]>;
  readonly options: Map<string, ListingOptionRecord[]>;
  readonly collectionIds: Map<string, string[]>;
}

/** An image as a caller supplies it — the shape `imageFileIds` expands into. */
export interface ListingImageInput {
  fileId: string;
  alt?: string;
  position: number;
}

/** A selectable option as a caller supplies it. */
export interface ListingOptionInput {
  name: string;
  values: string[];
  position: number;
}

/**
 * The newest-first feed order. See the module header — `desc nulls last` is the
 * index's ordering and `desc()` is not.
 */
const NEWEST_FIRST: SQL[] = [
  sql`${listings.publishedAt} desc nulls last`,
  sql`${listings.id} desc nulls last`,
];

/** Group rows by a listing id, preserving the order the query returned them in. */
function groupByListing<T extends { listingId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.listingId);
    if (bucket) bucket.push(row);
    else grouped.set(row.listingId, [row]);
  }
  return grouped;
}

/** One listing, or `null`. */
export async function findListingById(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord | null> {
  const [row] = await db.select().from(listings).where(eq(listings.id, listingId)).limit(1);
  return row ?? null;
}

/** Whether a listing exists. The cheap presence check, with no row materialized. */
export async function listingExists(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Several listings by id, in the ORDER THE CALLER ASKED FOR.
 *
 * The order is restored in memory rather than in SQL, because the caller's order
 * is not a property of the data: the favorites list wants recency of SAVING, and
 * a `where id in (…)` returns whatever the planner finds first. Ids naming a
 * listing that no longer exists are dropped, which is the behaviour the
 * favorites path already relied on.
 */
export async function findListingsByIds(
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord[]> {
  if (listingIds.length === 0) return [];

  const rows = await db.select().from(listings).where(inArray(listings.id, [...listingIds]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return listingIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * Images, options and collection memberships for a batch of listings.
 *
 * Three queries for the whole page — the N+1 this replaces would have been three
 * per listing. Each is ordered by `position` so the caller never re-sorts, and
 * `listing_collections.position` is NULL for a rules-derived membership, which
 * sorts last under Postgres's default `NULLS LAST` on an ascending order.
 */
export async function findListingChildren(
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingChildren> {
  if (listingIds.length === 0) {
    return { images: new Map(), options: new Map(), collectionIds: new Map() };
  }
  const ids = [...listingIds];

  const [imageRows, optionRows, membershipRows] = await Promise.all([
    db
      .select()
      .from(listingImages)
      .where(inArray(listingImages.listingId, ids))
      .orderBy(asc(listingImages.position)),
    db
      .select()
      .from(listingOptions)
      .where(inArray(listingOptions.listingId, ids))
      .orderBy(asc(listingOptions.position)),
    db
      .select({
        listingId: listingCollections.listingId,
        collectionId: listingCollections.collectionId,
      })
      .from(listingCollections)
      .where(inArray(listingCollections.listingId, ids))
      .orderBy(asc(listingCollections.position)),
  ]);

  const collectionIds = new Map<string, string[]>();
  for (const row of membershipRows) {
    const bucket = collectionIds.get(row.listingId);
    if (bucket) bucket.push(row.collectionId);
    else collectionIds.set(row.listingId, [row.collectionId]);
  }

  return {
    images: groupByListing(imageRows),
    options: groupByListing(optionRows),
    collectionIds,
  };
}

/**
 * Replace a listing's whole image list, KEEPING the row id of any photograph
 * that is still in it.
 *
 * ## Why this converges instead of deleting and re-inserting
 *
 * It used to be `delete` + `insert`, which was harmless while nothing referenced
 * `listing_images.id`. #850 made the id meaningful: `product_variant_images`
 * names a gallery row to say "this photograph shows the blue one", and both its
 * foreign keys CASCADE. A wholesale replace therefore minted new ids for
 * photographs that had not changed and silently took every variant's selection
 * with the old ones.
 *
 * That is not a rare edit. `channel-ingest.service` sets `imageFileIds` on every
 * sync that carries images, so a connected Shopify or WooCommerce shop would
 * have wiped its own variant galleries on a schedule, with nothing failing and
 * nothing logged. Introducing the reference is what obliges this writer to keep
 * the id stable, so the two halves land together.
 *
 * A photograph is matched by `file_id` and each existing row is consumed once,
 * so a gallery legitimately holding one file twice keeps both rows. Anything the
 * new list does not account for is deleted, which is what still makes this a
 * REPLACE rather than a merge: removing a photograph removes it, and its variant
 * selections go with it, exactly as the cascade intends.
 */
export async function replaceListingImages(
  listingId: string,
  images: readonly ListingImageInput[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (images.length === 0) {
    await db.delete(listingImages).where(eq(listingImages.listingId, listingId));
    return;
  }

  const existing = await db
    .select()
    .from(listingImages)
    .where(eq(listingImages.listingId, listingId))
    .orderBy(asc(listingImages.position), asc(listingImages.id));

  // One QUEUE per file id, not one row: a gallery may hold the same file twice,
  // and a plain map would hand both incoming copies the same existing row and
  // then delete the other.
  const available = new Map<string, ListingImageRecord[]>();
  for (const row of existing) {
    const bucket = available.get(row.fileId);
    if (bucket) bucket.push(row);
    else available.set(row.fileId, [row]);
  }

  const survivors: { row: ListingImageRecord; image: ListingImageInput }[] = [];
  const additions: ListingImageInput[] = [];
  for (const image of images) {
    const row = available.get(image.fileId)?.shift();
    if (row) survivors.push({ row, image });
    else additions.push(image);
  }

  const keptIds = survivors.map((s) => s.row.id);
  await db
    .delete(listingImages)
    .where(
      keptIds.length === 0
        ? eq(listingImages.listingId, listingId)
        : and(eq(listingImages.listingId, listingId), notInArray(listingImages.id, keptIds)),
    );

  // Only the rows whose rendered fields actually moved. A reorder that changed
  // nothing should not bump `updated_at` on the whole gallery.
  for (const { row, image } of survivors) {
    const alt = image.alt ?? null;
    if (row.position === image.position && row.alt === alt) continue;
    await db
      .update(listingImages)
      .set({ position: image.position, alt })
      .where(eq(listingImages.id, row.id));
  }

  if (additions.length > 0) {
    await db.insert(listingImages).values(
      additions.map((image) => ({
        listingId,
        fileId: image.fileId,
        alt: image.alt ?? null,
        position: image.position,
      })),
    );
  }
}

/** Replace a listing's whole option list. */
export async function replaceListingOptions(
  listingId: string,
  options: readonly ListingOptionInput[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(listingOptions).where(eq(listingOptions.listingId, listingId));
  if (options.length === 0) return;
  await db.insert(listingOptions).values(
    options.map((option) => ({
      listingId,
      name: option.name,
      values: [...option.values],
      position: option.position,
    })),
  );
}

/**
 * The four connector-provenance columns, carried as ONE value.
 *
 * They are a SET rather than four independent fields because a listing carrying
 * some of them is exactly as unfindable as one carrying none while LOOKING
 * synced: `findListingBySourceExternalId` matches on `(storeId,
 * sourceConnectionId, sourceExternalId)`, so a row missing either is invisible
 * to every later sync and still occupies its handle. Requiring all four KEYS
 * makes a half-set unrepresentable at the call site rather than something a
 * reviewer has to notice.
 */
export type ListingSourceProvenance = Pick<
  ListingRecord,
  'sourceConnectionId' | 'sourceProvider' | 'sourceExternalId' | 'sourceExternalUpdatedAt'
>;

/**
 * The columns a caller supplies when creating a listing.
 *
 * `publishedAt` is OPTIONAL and derived from `status` when omitted — see the
 * module header. A caller that states one wins, which is what lets a fixture
 * write a specific instant or reproduce a pre-#261 row.
 */
export type NewListing = Omit<
  ListingRecord,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'geo'
  | 'searchVector'
  | 'publishedAt'
  | 'archivedBy'
  | 'archivedFromStatus'
> &
  Partial<Pick<ListingRecord, 'id' | 'publishedAt'>>;

/**
 * A patch of a listing's own columns.
 *
 * The two archive-provenance columns are SUBTRACTED, so they are unwritable by
 * a caller and can only come from {@link archiveProvenance} beside the status
 * that produced them. A patch able to carry them is a patch able to say a
 * connector archived a listing a merchant deleted, which is the whole fact.
 */
export type ListingColumnPatch = Omit<
  Partial<ListingRecord>,
  'archivedBy' | 'archivedFromStatus'
>;

/**
 * `published_at` for a NEW listing: the create instant when it lands `active`,
 * NULL otherwise. See the module header for why the column means this.
 */
function publishedAtForCreate(status: ListingRecord['status']): Date | null {
  return status === 'active' ? new Date() : null;
}

/**
 * `published_at` under a status WRITE: stamp the first activation, never restamp.
 *
 * `undefined` for any other status, which leaves the column untouched — a
 * restriction, a return to `draft` and an archive all preserve the instant the
 * listing first went on sale. See the module header for the `coalesce` and the
 * explicit cast.
 */
function firstActivationPublishedAt(next: ListingRecord['status']): SQL | undefined {
  if (next !== 'active') return undefined;
  return sql`coalesce(${listings.publishedAt}, ${new Date().toISOString()}::timestamptz)`;
}

/**
 * `archived_by` / `archived_from_status` under a status WRITE — the #390 status
 * provenance, derived here so no caller states the previous status.
 *
 * Three properties are load-bearing and all three come from deriving it rather
 * than passing it:
 *
 *  - **The previous status is read in the SAME statement**, as
 *    `nullif(listings.status, 'archived')` — the pre-update value, the way
 *    `firstActivationPublishedAt`'s `coalesce` reads the pre-update
 *    `published_at`. A read-then-write would let a concurrent transition slip
 *    between the two and record a status the listing no longer held.
 *  - **A write that is not a TRANSITION records no previous status.** A listing
 *    already `archived` written `archived` again — an idempotent merchant PATCH
 *    — replaced nothing, so `nullif` stores NULL and a restore refuses it
 *    instead of putting the listing back into `archived`.
 *  - **Any other status CLEARS both.** The record describes the archive the
 *    listing is CURRENTLY in; leaving it behind on a listing that has since
 *    been republished is the stale read a later archiver would be measured
 *    against.
 *
 * A cause is REQUIRED to archive, and the refusal is a throw rather than a
 * NULL: NULL is how a pre-#390 row says "nobody knows", and a new writer
 * quietly minting more of those would make the unknowable set grow instead of
 * being fixed and frozen at the migration.
 */
function archiveProvenance(
  next: ListingRecord['status'],
  cause: ListingArchiveCause | undefined,
): { archivedBy: ListingArchiveCause | null; archivedFromStatus: SQL | null } {
  if (next !== 'archived') {
    return { archivedBy: null, archivedFromStatus: null };
  }
  if (cause === undefined) {
    throw new Error(
      'Archiving a listing requires a ListingArchiveCause: without one nothing can ' +
        'later tell a merchant archive from a connector one, which is issue #390.',
    );
  }
  return { archivedBy: cause, archivedFromStatus: sql`nullif(${listings.status}, 'archived')` };
}

/**
 * Create a listing with its images and options, atomically.
 *
 * One transaction because a listing whose images landed and whose options did
 * not is a product page that renders wrong, with nothing to indicate why.
 */
export async function insertListing(
  values: NewListing,
  images: readonly ListingImageInput[],
  options: readonly ListingOptionInput[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord> {
  const row = {
    ...values,
    publishedAt:
      values.publishedAt === undefined ? publishedAtForCreate(values.status) : values.publishedAt,
    // A create is not a TRANSITION into `archived` — there is no previous status
    // it replaced — so it records no provenance, and `NewListing` subtracts both
    // columns so a caller cannot invent one. No caller creates an archived
    // listing today (`createStoreProduct`'s status set excludes it, and #379
    // `skipped` an unpublished product it had never imported rather than
    // creating one archived); if one ever does, the row reads as UNKNOWN and is
    // never republished, which is the safe direction.
    archivedBy: null,
    archivedFromStatus: null,
  };
  const run = async (tx: DatabaseOrTransaction): Promise<ListingRecord> => {
    const [inserted] = await tx.insert(listings).values(row).returning();
    await replaceListingImages(inserted.id, images, tx);
    await replaceListingOptions(inserted.id, options, tx);
    return inserted;
  };
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * Patch a listing's own columns. Returns `null` when there is no such listing.
 *
 * A patch that moves the status to `active` stamps `published_at` if it is still
 * NULL — see the module header. An explicit `publishedAt` in the patch wins, so a
 * caller can still write one deliberately.
 *
 * A patch that moves the status ALSO writes the #390 archive provenance, and a
 * patch that writes `archived` without an `archiveCause` throws. A patch that
 * touches no status leaves both columns exactly as they are: this is the
 * function every connector re-sync calls to refresh `sourceExternalUpdatedAt`,
 * and clearing an archived listing's provenance on every pass would erase the
 * fact one page before the pass that needs it.
 */
export async function updateListingColumns(
  listingId: string,
  patch: ListingColumnPatch,
  db: DatabaseOrTransaction = getDb(),
  archiveCause?: ListingArchiveCause,
): Promise<ListingRecord | null> {
  const stamp =
    patch.status !== undefined && patch.publishedAt === undefined
      ? firstActivationPublishedAt(patch.status)
      : undefined;
  const provenance =
    patch.status !== undefined ? archiveProvenance(patch.status, archiveCause) : {};
  const [row] = await db
    .update(listings)
    .set({
      ...patch,
      ...(stamp ? { publishedAt: stamp } : {}),
      ...provenance,
      updatedAt: new Date(),
    })
    .where(eq(listings.id, listingId))
    .returning();
  return row ?? null;
}

/** What one `releasePinnedFields` statement found and what it left behind. */
export interface PinReleaseOutcome {
  /** The stored set before the removal, in stored order. */
  before: string[];
  /** The stored set after it, in stored order. */
  after: string[];
  /**
   * The keys this statement actually removed — `before` minus `after`,
   * deduplicated, in stored order.
   *
   * Empty for a converging repeat, which is what makes the audit trail record
   * decisions rather than requests.
   */
  released: string[];
}

/**
 * Stop holding some of a listing's `overridden_fields` keys (#427).
 *
 * Returns `null` when there is no such listing.
 *
 * ## One statement, because a read-then-write here loses a concurrent release
 *
 * The removal is computed inside the UPDATE from the row the UPDATE itself
 * locks, so two dashboards releasing two DIFFERENT fields at the same moment
 * end with both removed. Reading the array into the process, filtering it there
 * and writing the result back would give the loser a `before` it fetched
 * outside the lock and put the winner's key straight back — a lost update whose
 * only symptom is a pin that reappeared, which is indistinguishable from the
 * merchant having re-edited the field. In READ COMMITTED the `for update` in
 * the CTE walks the update chain, so both the locked row and the UPDATE's own
 * re-fetch see the same committed version.
 *
 * `array_remove` would be enough for a single key; `unnest … with ordinality`
 * is what lets one statement remove a SET while keeping the stored order of
 * everything it did not touch. Order carries no meaning to the connector merge
 * — `partitionPinnedFields` re-sorts for display — but rewriting it would make
 * a diff of this column say something that did not happen.
 *
 * SUBTRACTIVE and nothing else: there is no branch here that can add a key, so
 * no call can make a fourth key pinnable however `fields` is spelled.
 */
export async function releasePinnedFields(
  listingId: string,
  fields: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<PinReleaseOutcome | null> {
  const requested = [...new Set(fields)];
  /**
   * `array[$1, $2, …]::text[]`, one bound parameter per key.
   *
   * NOT `${requested}`: drizzle's `sql` template SPREADS a JS array into
   * separate placeholders, so a one-key release bound the bare string
   * `'description'` to a `text[]` parameter and Postgres answered `22P02
   * malformed array literal` — and a two-key release would have produced a
   * different, equally wrong statement. Written out, every key is still a bound
   * parameter and nothing is interpolated as text.
   *
   * An empty list renders `array[]::text[]`, and `x <> all('{}')` is TRUE for
   * every row — so a request naming nothing removes nothing, which is the same
   * answer as a request naming only keys that are not held.
   */
  const requestedArray = sql`array[${sql.join(
    requested.map((field) => sql`${field}`),
    sql`, `,
  )}]::text[]`;
  const rows = await db.execute<{ before: string[]; after: string[] }>(sql`
    with locked as (
      select ${listings.id} as id, ${listings.overriddenFields} as before
      from ${listings}
      where ${listings.id} = ${listingId}
      for update
    )
    update ${listings}
    set overridden_fields = coalesce(
          (
            select array_agg(held.field order by held.ord)
            from unnest(locked.before) with ordinality as held(field, ord)
            where held.field <> all(${requestedArray})
          ),
          '{}'::text[]
        ),
        updated_at = now()
    from locked
    where ${listings.id} = locked.id
    returning locked.before as before, ${listings.overriddenFields} as after
  `);
  const row = rows[0];
  if (!row) {
    return null;
  }
  const after = new Set(row.after);
  return {
    before: row.before,
    after: row.after,
    released: [...new Set(row.before)].filter((key) => !after.has(key)),
  };
}

/**
 * Recompute a listing's denormalized facets from its variants.
 *
 * The Mongo version read every variant row into the process and reduced it in
 * JavaScript. Here the reduction is an AGGREGATE — the rows never leave the
 * database — and the result is written back in a second statement.
 *
 * Two statements rather than one `UPDATE … FROM (…)` deliberately: the update
 * has to write NULLs into the price range when a listing has no variants at all,
 * and an aggregate over an empty set returns one row of NULLs from a plain
 * `select` but NO row from a `FROM` clause, which would silently skip the update
 * and leave the previous price range on a listing that no longer has one. The
 * race profile is identical to the Mongo version this replaces.
 *
 * Two details of the aggregate are load-bearing:
 *
 *  - **`has_inventory` is true for an UNTRACKED variant regardless of stock**,
 *    matching `!v.inventory.tracked || v.inventory.available > 0`. Dropping the
 *    first half silently unlists every made-to-order product.
 *  - **The price range takes its currency from the LOWEST-priced variant.** The
 *    Mongo version read `variants[0].price.currency` and assumed one currency
 *    per listing; this is the same answer for that case and a defined one for a
 *    listing whose variants disagree.
 */
export async function recomputeListingFacets(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const [facets] = await db
    .select({
      variantCount: sql<number>`count(*)::int`,
      minAmount: sql<number | null>`min(${productVariants.priceAmount})`,
      maxAmount: sql<number | null>`max(${productVariants.priceAmount})`,
      // Typed as `CurrencyCode` rather than `string`: the column it is read from
      // carries a CHECK against `ALL_CURRENCY_CODES`, so the aggregate cannot
      // return anything else, and the write below targets a narrowed column.
      currency: sql<CurrencyCode | null>`(array_agg(
        ${productVariants.priceCurrency} order by ${productVariants.priceAmount} asc nulls last
      ))[1]`,
      hasInventory: sql<boolean | null>`bool_or(
        not ${productVariants.inventoryTracked} or ${productVariants.inventoryAvailable} > 0
      )`,
    })
    .from(productVariants)
    .where(eq(productVariants.listingId, listingId));

  // A currency without an amount would violate the `listings_price_range_*`
  // pairing in spirit and render as a price of nothing; both halves move together.
  const hasRange = facets?.minAmount !== null && facets?.currency !== null;

  await db
    .update(listings)
    .set({
      variantCount: facets?.variantCount ?? 0,
      priceRangeMinAmount: hasRange ? facets.minAmount : null,
      priceRangeMaxAmount: hasRange ? facets.maxAmount : null,
      priceRangeMinCurrency: hasRange ? facets.currency : null,
      priceRangeMaxCurrency: hasRange ? facets.currency : null,
      hasInventory: facets?.hasInventory ?? false,
      updatedAt: new Date(),
    })
    .where(eq(listings.id, listingId));
}

/**
 * Move a listing's `favorite_count` by `delta`, clamped at zero.
 *
 * The clamp is `greatest(0, …)` in SQL rather than a guarded `where count > 0`,
 * which is what Mongo used: the guard makes the whole update a no-op when the
 * count is already 0, so a legitimate INCREMENT arriving at the same moment is
 * lost. Clamping applies the delta and refuses only to go negative.
 */
export async function adjustFavoriteCount(
  listingId: string,
  delta: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(listings)
    .set({
      favoriteCount: sql`greatest(0, ${listings.favoriteCount} + ${delta})`,
      updatedAt: new Date(),
    })
    .where(eq(listings.id, listingId));
}

/** Move a listing's rating aggregate — the review service's write-back. */
export async function setListingRating(
  listingId: string,
  rating: number,
  reviewCount: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(listings)
    .set({ rating, reviewCount, updatedAt: new Date() })
    .where(eq(listings.id, listingId));
}

/** Store-owned, ACTIVE listing ids of a store — the set collection rules reconcile over. */
export async function findActiveStoreListingIds(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.storeId, storeId),
        eq(listings.ownerType, 'store'),
        eq(listings.status, 'active'),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Whether the given ids are all ACTIVE store-owned listings of `storeId`.
 *
 * Returns the ids that are NOT, which is what the caller reports back — a
 * collection cannot hold another store's product, and `listing_collections` has
 * a real foreign key now, so an unchecked id is a 23503 rather than the silent
 * no-match Mongo produced.
 */
export async function findUnknownStoreListingIds(
  storeId: string,
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  if (listingIds.length === 0) return [];
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        inArray(listings.id, [...listingIds]),
        eq(listings.ownerType, 'store'),
        eq(listings.storeId, storeId),
      ),
    );
  const known = new Set(rows.map((row) => row.id));
  return listingIds.filter((id) => !known.has(id));
}

/**
 * A page of a store's ACTIVE listings, newest first — the public store page.
 *
 * Returns the total alongside the page because the caller renders a pager;
 * `count(*) over ()` would compute it in the same scan, but it is a second
 * query here so the page can use the keyset index unencumbered.
 */
export async function findActiveStoreListingsPage(
  storeId: string,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: ListingRecord[]; total: number }> {
  const where = and(
    eq(listings.storeId, storeId),
    eq(listings.ownerType, 'store'),
    eq(listings.status, 'active'),
  );

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(listings)
      .where(where)
      .orderBy(...NEWEST_FIRST)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(listings).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}

/**
 * A page of one seller's listings in ANY status, newest first — the seller's own
 * "my listings" screen, which must show drafts and archived items too.
 */
export async function findListingsPageForSeller(
  oxyUserId: string,
  status: ListingRecord['status'] | undefined,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: ListingRecord[]; total: number }> {
  const where = and(
    eq(listings.ownerType, 'user'),
    eq(listings.oxyUserId, oxyUserId),
    ...(status ? [eq(listings.status, status)] : []),
  );

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(listings)
      .where(where)
      .orderBy(sql`${listings.createdAt} desc`, sql`${listings.id} desc`)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(listings).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}

/**
 * The predicate for a P2P seller's PUBLIC inventory (#92).
 *
 * Three conjuncts and every one of them is load-bearing:
 *
 *  - `owner_type = 'user'` is #92 acceptance 4 and listing rule 8 — a seller
 *    page must never show a store's stock as a person's own inventory merely
 *    because that person operates the store. It is not redundant beside the
 *    `oxy_user_id` match: `listings_owner_exclusivity_check` guarantees a
 *    store-owned row has a NULL `oxy_user_id` TODAY, so stating only the id
 *    would be relying on a schema invariant a future widening could relax, in
 *    the one query where relaxing it discloses a shop's stock as somebody's
 *    second-hand goods. Stating both makes it independent of that.
 *  - `oxy_user_id` is the seller.
 *  - `status = 'active'` is listing rule 5: sold, archived, restricted and
 *    draft listings are not public. `restricted` is the one that matters most —
 *    it is what a CrowdSource takedown writes, and a seller page reading any
 *    other status would keep a delisted item visible on the one page most
 *    likely to be linked from a report.
 *
 * Written ONCE and shared by the page, the count and the "seller since" read,
 * so the three cannot disagree about what "public" means.
 */
function activeSellerListingsWhere(oxyUserId: string): SQL {
  const predicate = and(
    eq(listings.ownerType, 'user'),
    eq(listings.oxyUserId, oxyUserId),
    eq(listings.status, 'active'),
  );
  // Three non-undefined predicates always produce one, so this never throws —
  // it exists so a future edit that drops a conjunct fails loudly instead of
  // silently widening the predicate to the whole table.
  if (!predicate) throw new Error('activeSellerListingsWhere produced no predicate');
  return predicate;
}

/**
 * One KEYSET page of a seller's public listings, newest first.
 *
 * Keyset and not offset (#92 listing rule 6): a seller publishes and archives
 * while somebody is paging, and an offset silently skips or repeats rows
 * exactly when they do. `after` is the last row of the previous page, and the
 * ordering is the SAME `published_at desc nulls last, id desc nulls last` every
 * other feed here uses (see the module header for why `desc()` is not that).
 *
 * `listings_owner_user_status_published_at_id_idx` already serves the whole
 * thing — predicate, order and cursor — so this adds no index and no migration.
 *
 * Fetching `limit + 1` is the caller's job: the extra row answers "is there
 * more" without a second count query, and its existence IS the cursor.
 */
export async function findActiveSellerListingsKeyset(
  oxyUserId: string,
  limit: number,
  after: { publishedAt: Date | null; id: string } | undefined,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord[]> {
  const predicates: SQL[] = [activeSellerListingsWhere(oxyUserId)];

  if (after) {
    // NULL `published_at` sorts LAST, so a cursor on a NULL row has only the id
    // left to discriminate by, and a cursor on a dated row also admits every
    // NULL row behind it. Both branches are written out because that is what
    // keeps the comparison agreeing with the index's `nulls last`: a plain
    // `(published_at, id) < (?, ?)` row comparison does not, since SQL row
    // comparison with a NULL member yields NULL rather than true.
    predicates.push(
      after.publishedAt === null
        ? sql`${listings.publishedAt} is null and ${listings.id} < ${after.id}`
        : sql`(${listings.publishedAt} < ${after.publishedAt.toISOString()}
               or (${listings.publishedAt} = ${after.publishedAt.toISOString()} and ${listings.id} < ${after.id})
               or ${listings.publishedAt} is null)`,
    );
  }

  return db
    .select()
    .from(listings)
    .where(and(...predicates))
    .orderBy(...NEWEST_FIRST)
    .limit(limit);
}

/** How many listings a seller currently has on public display. */
export async function countActiveSellerListings(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(listings)
    .where(activeSellerListingsWhere(oxyUserId));
  return row?.count ?? 0;
}

/**
 * When a seller first PUBLISHED anything, or `null` if they never have.
 *
 * Across every status, not just the active ones: "seller since" is a fact about
 * when this person started selling, and a seller whose first three items all
 * sold has not become newer. `null` is a real answer and the caller renders
 * nothing rather than a substitute date — a lazily-created `seller_profiles`
 * row dates the moment somebody opened a screen, which is a fact about their
 * browsing and not about their selling.
 *
 * This is the ONE read that spans non-active listings and still reads
 * `published_at`, so #261 sharpened it: a seller holding nothing but drafts now
 * answers `null` where the old create-time stamp answered with the date they
 * first opened the composer. That is the column's meaning arriving here rather
 * than a regression — they have not started selling — and `null` was already the
 * documented answer the projection omits.
 */
export async function findSellerFirstPublishedAt(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Date | null> {
  const [row] = await db
    .select({ firstPublishedAt: sql<Date | null>`min(${listings.publishedAt})` })
    .from(listings)
    .where(and(eq(listings.ownerType, 'user'), eq(listings.oxyUserId, oxyUserId)));
  return row?.firstPublishedAt ?? null;
}

/**
 * A page of a store's listings in ANY status — the dashboard product list.
 *
 * Separate from {@link findActiveStoreListingsPage} because the storefront must
 * never see a draft and the dashboard must always see one; folding them into a
 * single function with an optional status is how a public read eventually ships
 * with the filter omitted.
 */
export async function findStoreListingsPageForAdmin(
  storeId: string,
  filters: { status?: ListingRecord['status']; search?: string },
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: ListingRecord[]; total: number }> {
  const where = and(
    eq(listings.ownerType, 'store'),
    eq(listings.storeId, storeId),
    ...(filters.status ? [eq(listings.status, filters.status)] : []),
    ...(filters.search && filters.search.trim().length > 0
      ? [textMatch(filters.search.trim())]
      : []),
  );

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(listings)
      .where(where)
      .orderBy(sql`${listings.createdAt} desc`, sql`${listings.id} desc`)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(listings).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}

/**
 * The BASE-locale half of the full-text predicate, against `listings`' own
 * GENERATED `search_vector`.
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery`: it is the only built-in
 * parser that never raises on user input (a lone `"` or `|` is a syntax error to
 * `to_tsquery`), and it gives buyers the quoting and `-exclusion` they already
 * expect from a search box. `plainto_tsquery` is also safe but ANDs every word
 * with no way to phrase-match, which the Mongo `$text` index did support.
 *
 * The configuration is `LISTING_BASE_TEXT_SEARCH_CONFIGURATION` and it MUST
 * equal the one `listings.search_vector` is generated with. That is not a
 * source-to-source claim: `listing-localization.realdb.test.ts` reads the
 * deployed column's expression out of `pg_get_expr` and asserts the
 * configuration inside it is this constant, because a `tsvector` and a `tsquery`
 * built under different configurations match arbitrarily — sometimes, for some
 * words — and the symptom is a result set with holes in it that nobody can see.
 */
function baseTextMatch(text: string): SQL {
  const configuration = sql.raw(`'${LISTING_BASE_TEXT_SEARCH_CONFIGURATION}'`);
  return sql`${listings.searchVector} @@ websearch_to_tsquery(${configuration}, ${text})`;
}

/**
 * The full-text predicate — the base vector, UNIONED with the requested locale's
 * own localized vector when there is one (#367 Workstream 5).
 *
 * ## Why a union and not a replacement
 *
 * A French shopper searching `bicyclette` has to find a listing whose French
 * title says so; a French shopper searching a model number, a brand or an
 * English word the seller left untranslated still has to find it too. Only the
 * base vector holds `tags`, and only the base vector exists for the very large
 * majority of listings, which have no translation at all. Replacing the base
 * half would therefore turn on a feature by withdrawing the catalogue.
 *
 * With no locale — every call before this change, plus the dashboard's product
 * list, which has no locale to pass — the function returns `base` from the early
 * exit below, so the SQL is what it always was: no subquery, no join, the same
 * plan. That much is a property of the call graph. What the realdb suite adds is
 * the OBSERVABLE half: a base-locale term still finds its listing with and
 * without a locale, and writing a translation moves nothing on `listings`.
 *
 * ## Why the EXACT locale, and never a neighbouring market's
 *
 * `listing.title` is `seller_authored`, so `fallbackPolicyForFieldClass` gives
 * it `exact_locale_then_base`: an `es-mx` shopper is shown their own `es-mx` row
 * or the seller's base text, and never the `es` row a DIFFERENT seller wrote for
 * a different market (ADR 0007 D4). Search has to find what the shopper will
 * then SEE — matching a row the page will not render sends them to a listing
 * that does not contain the word they typed. So the predicate is `locale = $x`
 * and there is deliberately no widening to the language.
 *
 * `MERCARIA_BASE_LOCALE` short-circuits to the base half alone, because
 * `<table>_locale_not_base_check` makes a base-locale localization row
 * unrepresentable — the subquery could only ever match nothing.
 *
 * ## The configuration is BOUND, not interpolated, and comes from the one map
 *
 * `textSearchConfigurationForLocale` is the same map the generated column's
 * `CASE` is rendered from, so the vector and the query are analysed identically
 * by construction. It is passed as a bound parameter cast to `regconfig` rather
 * than inlined: `to_tsvector(regconfig, text)` is IMMUTABLE and the cast is
 * merely STABLE, which a generated column may not use and a QUERY may, so the
 * safe spelling is available here and nothing user-influenced reaches the SQL
 * text. The bound form is still INDEXABLE — measured on PostgreSQL 17, a Bitmap
 * Index Scan over a GIN index on the same shape of column — and
 * `listing-localization.realdb.test.ts` asserts the plan names
 * `listing_localizations_search_vector_idx`, with a drop-the-index mutation
 * proving the assertion can fail. It runs under `enable_seqscan = off`, so what
 * it proves is that the index CAN serve this predicate, not that the planner
 * would prefer it at production scale — that is #61's harness.
 */
function textMatch(text: string, locale?: string): SQL {
  const base = baseTextMatch(text);
  const supported = locale === undefined ? undefined : asSupportedLocale(locale);
  if (supported === undefined || supported === MERCARIA_BASE_LOCALE) return base;

  const configuration = textSearchConfigurationForLocale(supported);
  return sql`(${base} or exists (
    select 1
      from ${listingLocalizations}
     where ${listingLocalizations.listingId} = ${listings.id}
       and ${listingLocalizations.locale} = ${supported}
       and ${listingLocalizations.searchVector} @@ websearch_to_tsquery(${configuration}::regconfig, ${text})
  ))`;
}

/** Everything a browse/search request can narrow by. */
export interface ListingSearchFilters {
  ownerType?: ListingOwnerType;
  storeId?: string;
  categorySlug?: string;
  /**
   * Taxonomy keys and whole segments, UNIONED into one membership test (#90
   * acceptance 2).
   *
   * The v1 `condition=used` spelling is expanded to its groups by
   * `search.service` before it reaches here, so this layer has one vocabulary
   * and the compatibility contract lives in exactly one place.
   */
  conditionKeys?: readonly ItemConditionKey[];
  conditionGroups?: readonly ConditionGroup[];
  vendor?: string;
  productType?: string;
  collectionId?: string;
  inStock?: boolean;
  minPrice?: number;
  maxPrice?: number;
  text?: string;
  /**
   * The locale to ALSO search in, beside the seller's base text (#367
   * Workstream 5).
   *
   * Narrows the free-text predicate's second half and nothing else — it is not a
   * filter, so a listing with no translation in this locale is not excluded, and
   * a locale Mercaria does not support simply leaves the base half alone. It has
   * no effect without `text`.
   */
  locale?: string;
  near?: { lng: number; lat: number; radiusM: number };
}

/**
 * Translate the filters into predicates over `listings`.
 *
 * **Text and geo are now COMBINABLE.** Mongo could not run `$text` and `$near`
 * in one query, so `search.service` silently dropped the free-text term whenever
 * a `near` filter was present — a buyer searching "bike" within 5 km got every
 * listing within 5 km. A GIN `tsvector` match and a GiST `ST_DWithin` are
 * ordinary predicates here and simply AND together.
 *
 * `ST_DWithin` rather than ordering by distance: the Mongo `$near` both filtered
 * by `$maxDistance` and sorted by distance. The sort is dropped on purpose —
 * `sort` is an explicit request parameter, and a `near` filter silently
 * overriding it is the same class of surprise as geo silently overriding text.
 */
function buildSearchWhere(filters: ListingSearchFilters): SQL | undefined {
  const predicates: SQL[] = [eq(listings.status, 'active')];

  if (filters.ownerType) predicates.push(eq(listings.ownerType, filters.ownerType));
  if (filters.storeId) predicates.push(eq(listings.storeId, filters.storeId));
  const conditionKeys = new Set<ItemConditionKey>(filters.conditionKeys ?? []);
  for (const group of filters.conditionGroups ?? []) {
    for (const key of conditionKeysInGroup(group)) conditionKeys.add(key);
  }
  // ONE `IN` list, never two ANDed predicates: a facet UI sending a segment and
  // a key inside another segment means "either", and two `IN`s would answer the
  // empty set for exactly those requests.
  if (conditionKeys.size > 0) predicates.push(inArray(listings.condition, [...conditionKeys]));
  if (filters.vendor) predicates.push(eq(listings.vendor, filters.vendor));
  if (filters.productType) predicates.push(eq(listings.productType, filters.productType));
  if (filters.inStock) predicates.push(eq(listings.hasInventory, true));

  if (filters.categorySlug) {
    // Array CONTAINMENT so the GIN index on `category_slugs` serves it; `= any`
    // would work and could not use that index. `arrayContains` rather than a
    // hand-written `@> ${[value]}`: postgres.js EXPANDS a JavaScript array into
    // one bind parameter per element, so the hand-written form binds a bare
    // scalar against a `text[]` and fails at execution.
    predicates.push(arrayContains(listings.categorySlugs, [filters.categorySlug]));
  }

  if (filters.collectionId) {
    // UNCORRELATED on purpose: the sub-select names only `listing_collections`
    // columns, so there is no outer reference to qualify and no bare-column trap
    // to fall into. The `listing_collections_collection_id_position_idx` index
    // serves it directly.
    predicates.push(
      sql`${listings.id} in (
        select ${listingCollections.listingId}
        from ${listingCollections}
        where ${listingCollections.collectionId} = ${filters.collectionId}
      )`,
    );
  }

  if (typeof filters.minPrice === 'number') {
    predicates.push(gte(listings.priceRangeMinAmount, filters.minPrice));
  }
  if (typeof filters.maxPrice === 'number') {
    predicates.push(lte(listings.priceRangeMinAmount, filters.maxPrice));
  }

  if (filters.text && filters.text.trim().length > 0) {
    predicates.push(textMatch(filters.text.trim(), filters.locale));
  }

  if (filters.near) {
    predicates.push(
      sql`${listings.geo} is not null and st_dwithin(
        ${listings.geo},
        st_makepoint(${filters.near.lng}, ${filters.near.lat})::geography,
        ${filters.near.radiusM}
      )`,
    );
  }

  return and(...predicates);
}

/**
 * The ORDER BY for a browse sort.
 *
 * **A listing with no price range now sorts LAST in both price directions.**
 * Mongo's ascending sort put missing values FIRST, so `price_asc` led with every
 * listing that had no price at all; `price_desc` put them last. One consistent
 * rule replaces the two, and `asc nulls last` is Postgres's own default, which is
 * what `listings_status_price_published_at_idx` was built with.
 */
function buildSearchOrder(sort: ListingQuery['sort']): SQL[] {
  switch (sort) {
    case 'price_asc':
      return [
        sql`${listings.priceRangeMinAmount} asc nulls last`,
        sql`${listings.id} desc nulls last`,
      ];
    case 'price_desc':
      return [
        sql`${listings.priceRangeMinAmount} desc nulls last`,
        sql`${listings.id} desc nulls last`,
      ];
    default:
      return NEWEST_FIRST;
  }
}

/** Offset-paginated browse: one page plus the total for the pager. */
export async function searchListingsPage(
  filters: ListingSearchFilters,
  sort: ListingQuery['sort'],
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: ListingRecord[]; total: number }> {
  const where = buildSearchWhere(filters);

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(listings)
      .where(where)
      .orderBy(...buildSearchOrder(sort))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(listings).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}

/** The boundary a keyset page resumes from. */
export interface ListingCursor {
  /** NULL for a listing that was never published — those sort after every other. */
  publishedAt: Date | null;
  id: string;
}

/**
 * Keyset-paginated browse over `(published_at desc nulls last, id desc)`.
 *
 * The boundary has THREE branches, not two, because the sort key is nullable:
 * a NULL `published_at` sorts after every non-null one, so from a non-null
 * cursor every NULL row is still ahead. Collapsing that into
 * `published_at < $1 or (published_at = $1 and id < $2)` silently drops every
 * unpublished row from the tail of the feed — both comparisons are NULL, which
 * is not TRUE.
 *
 * Reads `limit + 1` rows to answer `hasMore` without a second count.
 */
export async function searchListingsKeyset(
  filters: ListingSearchFilters,
  cursor: ListingCursor | null,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: ListingRecord[]; hasMore: boolean }> {
  const predicates: SQL[] = [];
  const base = buildSearchWhere(filters);
  if (base) predicates.push(base);

  if (cursor) {
    // `lt`/`eq` and NOT a hand-written `sql\`${col} < ${date}\``: interpolating a
    // value into a raw `sql` template binds it WITHOUT the column's mapper, so a
    // `mode: 'date'` timestamptz arrives at postgres.js as a JavaScript `Date`
    // and the driver throws `ERR_INVALID_ARG_TYPE`. That is the write-side face
    // of the mapper-bypass trap `CONVENTIONS.md` describes for `db.execute`.
    const boundary =
      cursor.publishedAt === null
        ? and(isNull(listings.publishedAt), lt(listings.id, cursor.id))
        : or(
            isNull(listings.publishedAt),
            lt(listings.publishedAt, cursor.publishedAt),
            and(eq(listings.publishedAt, cursor.publishedAt), lt(listings.id, cursor.id)),
          );
    if (boundary) predicates.push(boundary);
  }

  const rows = await db
    .select()
    .from(listings)
    .where(and(...predicates))
    .orderBy(...NEWEST_FIRST)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

/**
 * Move a listing's status, but only from one of `allowedCurrent`, and only if it
 * would actually CHANGE.
 *
 * The whole moderation enforcement path depends on this being one conditional
 * statement: `restrict` must refuse a listing someone else already restricted,
 * and a correction's `restore` must refuse a listing that is no longer under
 * enforcement. A read-then-write would let two deliveries of the same decision
 * both believe they were the one that acted.
 *
 * `status <> next` reproduces Mongo's `modifiedCount === 1` exactly — a
 * `$set` to the value a document already holds matches but modifies nothing, and
 * the caller's "the listing was neither restricted nor awaiting changes" branch
 * is written against that distinction.
 *
 * A move to `active` stamps `published_at` if it is still NULL, which is what
 * makes a moderation `restore` targeting `active` — the enforcement recorded no
 * previous status, so the listing may never have been published — the first
 * activation it actually is. See the module header.
 *
 * A move to `archived` records the #390 provenance and REQUIRES an
 * `archiveCause`; every other move clears it. The `status <> next` clause means
 * an already-archived listing is refused before anything is written, so a
 * re-delivered delete webhook cannot overwrite the record of the archive it is
 * a duplicate of.
 *
 * @returns `true` when this call made the change, `false` when the guard refused.
 */
/**
 * Move a listing's product-type pin, if it is still on the version the caller
 * previewed (#587, #367 box 12).
 *
 * A CAS and not a patch, for `setListingStatusIfIn`'s reason one column over:
 * the preview an operator read is a measurement at a moment, and a concurrent
 * publication can move the incumbent between the preview and the apply. Stating
 * the version the caller BELIEVED the listing was on turns that race into a
 * `null` the service can answer with "re-read the preview", where a
 * read-then-write would move a listing onto a version nobody looked at.
 * `repinDraftIfVersion` is the same device one entity over.
 *
 * `ListingColumnPatch` does not subtract this column, so `updateListingColumns`
 * could write it — and deliberately never does. A patch keyed on the id alone
 * cannot express the guard, and this is the ONE statement in this repository
 * that moves the pin after the row is created, which is what makes
 * `catalog-write.service.repinListingProductTypeVersion` the single service-level
 * entry point rather than one of several.
 *
 * The database permits the transition on purpose:
 * `mercaria_listing_product_type_pin_not_cleared` allows `NULL → value` and
 * `value → value` and refuses only `value → NULL`. It validates NOTHING else —
 * not key continuity, not version direction, not lifecycle — so every semantic
 * guard lives in `catalog-authoring/listing-upgrade.service.ts`.
 *
 * @returns the updated row, or `null` when the listing had already moved.
 */
export async function repinListingProductTypeIfPinned(
  listingId: string,
  expectedDefinitionId: string,
  targetDefinitionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord | null> {
  const [row] = await db
    .update(listings)
    .set({ productTypeDefinitionId: targetDefinitionId, updatedAt: new Date() })
    .where(
      and(
        eq(listings.id, listingId),
        eq(listings.productTypeDefinitionId, expectedDefinitionId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function setListingStatusIfIn(
  listingId: string,
  next: ListingRecord['status'],
  allowedCurrent: readonly ListingRecord['status'][],
  archiveCause?: ListingArchiveCause,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const stamp = firstActivationPublishedAt(next);
  const rows = await db
    .update(listings)
    .set({
      status: next,
      ...(stamp ? { publishedAt: stamp } : {}),
      ...archiveProvenance(next, archiveCause),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(listings.id, listingId),
        inArray(listings.status, [...allowedCurrent]),
        sql`${listings.status} <> ${next}`,
      ),
    )
    .returning({ id: listings.id });
  return rows.length > 0;
}

/**
 * One listing of a store, resolved by the connector provenance key.
 *
 * The `listings_store_id_source_key_idx` partial index serves this exactly: it is
 * `(store_id, source_connection_id, source_external_id) WHERE source_external_id
 * IS NOT NULL`, which is the set of imported listings and nothing else.
 */
export async function findListingBySourceExternalId(
  storeId: string,
  connectionId: string,
  externalId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord | null> {
  const [row] = await db
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.storeId, storeId),
        eq(listings.sourceConnectionId, connectionId),
        eq(listings.sourceExternalId, externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Who already holds `handle` in this store — the refusal a collision on
 * `listings_store_id_handle_key` needs in order to name what it found (#292).
 *
 * The provenance is JOINED rather than fetched separately because it is the whole
 * point of the read: an incumbent with a `source_connection_id` was imported and
 * the merchant's remedy is on that channel, while one without was created by hand
 * in Mercaria — which is the case with no provenance for any later sync to
 * converge onto, so its collision is permanent. Two statements would make a
 * partly-answered refusal ("something holds it, we could not say what") a
 * reachable state on the one path that exists to say what.
 *
 * A LEFT join, not an inner one: the merchant-created case has no `connections`
 * row to match, and it is both the commonest of the three routes and the one
 * least likely to be reproduced by whoever reads the message, so an inner join
 * would drop exactly the half that most needs explaining.
 *
 * `shop_domain` is the merchant's OWN shop as they typed it into that channel, and
 * `listings_store_id_handle_key` is per STORE — so both sides of every collision
 * this can report belong to the caller's own store, and there is no shape here
 * that could name another tenant's connection.
 */
export async function findListingHandleOwner(
  storeId: string,
  handle: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{
  listingId: string;
  status: ListingRecord['status'];
  sourceConnectionId: string | null;
  sourceProvider: string | null;
  sourceExternalId: string | null;
  sourceShopDomain: string | null;
} | null> {
  const [row] = await db
    .select({
      listingId: listings.id,
      status: listings.status,
      sourceConnectionId: listings.sourceConnectionId,
      sourceProvider: listings.sourceProvider,
      sourceExternalId: listings.sourceExternalId,
      sourceShopDomain: connections.shopDomain,
    })
    .from(listings)
    .leftJoin(connections, eq(connections.id, listings.sourceConnectionId))
    .where(and(eq(listings.storeId, storeId), eq(listings.handle, handle)))
    .limit(1);
  return row ?? null;
}

/**
 * Every listing a connection sourced into a store — the reconcile working set.
 *
 * ONE indexed query against the partial `listings_store_id_source_key_idx`, which
 * covers exactly the imported listings. The alternative — reading the store's
 * whole catalogue and filtering in the process — is the shape that turns a
 * reconcile of twelve synced products into a scan of twelve thousand.
 */
export async function findListingsBySourceConnection(
  storeId: string,
  connectionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord[]> {
  return db
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.storeId, storeId),
        eq(listings.sourceConnectionId, connectionId),
        // NOT redundant. `listings_store_id_source_key_idx` is PARTIAL —
        // `WHERE source_external_id IS NOT NULL` — and Postgres uses a partial
        // index only when the query's predicate IMPLIES the index's. Without this
        // clause the planner falls back to a `store_id`-prefix index and filters,
        // which is the whole-catalogue scan this function exists to avoid. It
        // excludes no row a caller wants: a listing sourced from a connection
        // always has an external id.
        isNotNull(listings.sourceExternalId),
      ),
    );
}

/** One listing's stored browse path, beside the category it was derived from. */
export interface ListingCategoryPathRow {
  readonly id: string;
  readonly categoryId: string | null;
  readonly categorySlugs: readonly string[];
}

/**
 * A keyset page of the listings filed under any of these categories, with just
 * their stored browse path.
 *
 * Three columns and nothing else, because the caller re-derives one denormalized
 * projection and has no business seeing the rest of a listing — and because this
 * page is read for every governed taxonomy change, so its width is paid on each
 * one.
 *
 * Keyset on `id` rather than an offset: the pass it feeds runs inside the
 * transaction that just moved the taxonomy, so it must be resumable across calls
 * without re-reading what it has already written, and an offset drifts as rows are
 * updated. An empty `categoryIds` returns nothing rather than everything —
 * `inArray` with an empty list is a predicate that matches no row, which is the
 * correct reading of "repair the listings under these zero categories" and the
 * dangerous one to get backwards.
 */
export async function findListingCategoryPathsPage(
  categoryIds: readonly string[],
  input: { readonly afterListingId: string | null; readonly limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingCategoryPathRow[]> {
  if (categoryIds.length === 0) return [];
  const predicates: SQL[] = [inArray(listings.categoryId, [...categoryIds])];
  if (input.afterListingId !== null) {
    predicates.push(sql`${listings.id} > ${input.afterListingId}`);
  }
  const rows = await db
    .select({
      id: listings.id,
      categoryId: listings.categoryId,
      categorySlugs: listings.categorySlugs,
    })
    .from(listings)
    .where(and(...predicates))
    .orderBy(asc(listings.id))
    .limit(input.limit);
  return rows.map((row) => ({
    id: row.id,
    categoryId: row.categoryId,
    categorySlugs: row.categorySlugs ?? [],
  }));
}

/** Every listing id of a store, whatever its status — the store-wide review roll-up. */
export async function findListingIdsByStore(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(eq(listings.storeId, storeId));
  return rows.map((row) => row.id);
}

/** The newest ACTIVE listings across the whole marketplace — the feed's shelf. */
export async function findNewestActiveListings(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord[]> {
  return db
    .select()
    .from(listings)
    .where(eq(listings.status, 'active'))
    .orderBy(...NEWEST_FIRST)
    .limit(limit);
}

/**
 * The newest ACTIVE listings that have a variant carrying a `compare_at_price` —
 * the feed's "On sale" shelf.
 *
 * ONE query. The Mongo path read every active listing with a non-zero price,
 * then read every variant of those listings that had a `compareAtPrice`, then
 * intersected the two sets IN THE PROCESS and sliced the shelf out — so rendering
 * eight cards read the entire active catalogue twice.
 */
export async function findOnSaleListings(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord[]> {
  return db
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.status, 'active'),
        variantExistsPredicate(sql`${productVariants.compareAtPriceAmount} is not null`),
      ),
    )
    .orderBy(...NEWEST_FIRST)
    .limit(limit);
}

/** Every ACTIVE listing of a batch of stores, newest first — the merchant shelf. */
export async function findActiveListingsForStores(
  storeIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingRecord[]> {
  if (storeIds.length === 0) return [];
  return db
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.ownerType, 'store'),
        inArray(listings.storeId, [...storeIds]),
        eq(listings.status, 'active'),
      ),
    )
    .orderBy(...NEWEST_FIRST);
}

/**
 * Listing ids of a store that satisfy an automated collection's rule predicate.
 *
 * The predicate is built by `collectionRules.ts` and is always scoped here to
 * the store's own ACTIVE store-owned listings, so a rule can never reach another
 * merchant's catalogue however it was written.
 */
export async function findStoreListingIdsMatching(
  storeId: string,
  predicate: SQL,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.ownerType, 'store'),
        eq(listings.storeId, storeId),
        eq(listings.status, 'active'),
        predicate,
      ),
    );
  return rows.map((row) => row.id);
}

/** Whether ONE listing satisfies a rule predicate — the per-product recompute. */
export async function listingMatchesRules(
  listingId: string,
  storeId: string,
  predicate: SQL,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.id, listingId),
        eq(listings.ownerType, 'store'),
        eq(listings.storeId, storeId),
        eq(listings.status, 'active'),
        predicate,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether the listing has ANY variant matching a variant-level predicate.
 *
 * `compare_at_price` lives on `product_variants` and is not denormalized onto
 * the listing, so a collection rule on it is an EXISTS over the child table.
 * Every reference to the OUTER table inside it goes through `qualified()`: a
 * drizzle column interpolated into `sql` renders BARE when its table is not in
 * that sub-statement's own FROM, so `where ${productVariants.listingId} =
 * ${listings.id}` becomes `where "listing_id" = "id"` — both resolving against
 * `product_variants`, comparing two of ITS columns, matching nothing, with no
 * error at all.
 */
export function variantExistsPredicate(variantPredicate: SQL): SQL {
  return sql`exists (
    select 1 from ${productVariants}
    where ${qualified(productVariants.listingId)} = ${qualified(listings.id)}
      and ${variantPredicate}
  )`;
}
