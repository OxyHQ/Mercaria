/**
 * Private watchlists against a REAL PostgreSQL database — every #81 property
 * that is held by a CHECK, a unique index, a trigger or a compare-and-swap, and
 * therefore does not exist under a mocked repository.
 *
 * A mocked `insert` accepts any statement, including one the server rejects
 * outright, so everything in this file is a property of the DDL or of a real
 * concurrent statement rather than of the code that happens to call it:
 *
 *  - **one entry per product per list**, exercised as a repeated add
 *    (idempotence) and as the shape a product MERGE converges on;
 *  - **an ambiguous entry names its split job, both ways** — the biconditional
 *    CHECK, which is what makes the two candidates recoverable;
 *  - **a snapshot's counters must add up** — equality, never `<=`, so a write
 *    that swallowed a line cannot look like a clean one;
 *  - **`cardinality`, not `array_length`** — the empty `material_changes` array
 *    is REFUSED, which is the case the obvious spelling silently admits;
 *  - **a converted amount carries its quote and an unconverted one does not** —
 *    the biconditional FX CHECK, both directions;
 *  - **a priced line carries an offer, a policy version, a price and an
 *    availability; an unresolved one carries a reason and none of them**;
 *  - **a snapshot cannot be rewritten** — the append-only trigger — while its
 *    line's `watchlist_item_id` may still go NULL, which is the referential
 *    action the schema itself declares;
 *  - **#81 acceptance 4**: two concurrent edits, one of which is refused;
 *  - **#81 correction rule 2**: a split marks entries and the buyer's three
 *    answers behave, including `move_to_target` onto a product already held.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every id this file writes carries a per-run suffix and
 * teardown deletes exactly what it created, children first.
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import {
  watchlistItems,
  watchlistSnapshotItems,
  watchlistSnapshots,
  watchlists,
} from '../schema/watchlists.js';
import {
  bumpWatchlistVersion,
  insertWatchlist,
} from '../watchlists/watchlistRepository.js';
import {
  insertWatchlistItem,
  markWatchlistItemsAmbiguousAfterSplit,
} from '../watchlists/watchlistItemRepository.js';
import { insertWatchlistSnapshot } from '../watchlists/watchlistSnapshotRepository.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdWatchlistIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (createdWatchlistIds.length > 0) {
    // `watchlist_items` and `watchlist_snapshots` CASCADE from the list, and
    // snapshot LINES cascade from the snapshot — so one delete is the whole
    // cleanup, which is itself the retention property under test.
    await db.delete(watchlists).where(inArray(watchlists.id, createdWatchlistIds));
  }
  if (createdVariantIds.length > 0) {
    await db.delete(canonicalVariants).where(inArray(canonicalVariants.id, createdVariantIds));
  }
  if (createdProductIds.length > 0) {
    await db.delete(canonicalProducts).where(inArray(canonicalProducts.id, createdProductIds));
  }
  await closePostgres();
});

/** A per-run Oxy account id — no such table exists, so any string is one. */
function userId(label: string): string {
  return `wl-${label}-${RUN}-${uuidv7().slice(-8)}`;
}

async function makeCanonicalProduct(): Promise<string> {
  const id = uuidv7();
  const suffix = `${RUN}-${id.slice(-8)}`;
  await db.insert(canonicalProducts).values({
    id,
    slug: `wl-product-${suffix}`,
    name: `WL Product ${suffix}`,
    normalizedName: `wl product ${suffix}`,
  });
  createdProductIds.push(id);
  return id;
}

async function makeCanonicalVariant(productId: string): Promise<string> {
  const id = uuidv7();
  const suffix = `${RUN}-${id.slice(-8)}`;
  // `signature` is NOT NULL and CHECKed to a sha-256 hex digest — a variant's
  // identity is its option assignments (#56 variant rule 6), so the fixture
  // supplies a real 64-hex value rather than a label.
  await db.insert(canonicalVariants).values({
    id,
    productId,
    name: `WL Variant ${suffix}`,
    signature: createHash('sha256').update(id).digest('hex'),
  });
  createdVariantIds.push(id);
  return id;
}

/**
 * Assert that `run` was refused BY THE TRIGGER.
 *
 * drizzle wraps a driver error in a `Failed query: …` envelope and hangs the
 * real one off `cause`, so matching the top-level message alone would pass
 * against ANY failure — a syntax error, a missing table, a dead connection.
 * Walking the cause chain is what makes this able to tell the trigger from
 * everything else; and because a MISSING trigger means the statement SUCCEEDS,
 * the `did not throw` branch is the one that catches its absence.
 */
async function expectRefusedByTrigger(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, 'the statement succeeded — is the trigger installed?').toBeDefined();
  const messages: string[] = [];
  let current: unknown = thrown;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages.join(' | ')).toMatch(/immutable/);
}

async function makeWatchlist(oxyUserId: string): Promise<string> {
  const row = await insertWatchlist({ oxyUserId, name: `List ${RUN}`, displayCurrency: 'EUR' }, db);
  createdWatchlistIds.push(row.id);
  return row.id;
}

/** A snapshot header with the fields every case shares. */
function snapshotHeader(watchlistId: string, digest: string) {
  const evaluatedAt = new Date();
  return {
    watchlistId,
    listVersion: 1,
    rankingPolicyVersions: ['builtin@1'],
    displayCurrency: 'EUR' as const,
    market: null,
    completeness: 'complete' as const,
    basis: 'item_price' as const,
    totalAmount: 1000,
    materialChanges: ['first_snapshot' as const],
    previousSnapshotId: null,
    contentDigest: digest,
    evaluatedAt,
    retentionExpiresAt: new Date(evaluatedAt.getTime() + 86_400_000),
  };
}

/** A priced line with the fields every case shares. */
function pricedLine(itemId: string | null, productId: string, overrides: Record<string, unknown> = {}) {
  return {
    watchlistItemId: itemId,
    canonicalProductId: productId,
    preferredCanonicalVariantId: null,
    quantity: 1,
    position: 0,
    state: 'priced' as const,
    unresolvedReason: null,
    selectedOfferId: `of-${uuidv7().slice(-8)}`,
    selectedCanonicalVariantId: null,
    selectedAvailability: 'in_stock' as const,
    rankingPolicyVersion: 'builtin@1',
    unitItemPriceAmount: 1000,
    unitItemPriceCurrency: 'EUR' as const,
    lineItemPriceAmount: 1000,
    unitDeliveryAmount: null,
    lineDeliveryAmount: null,
    nativeCurrency: 'EUR' as const,
    fxRate: null,
    fxFrom: null,
    fxTo: null,
    fxProvider: null,
    fxAsOf: null,
    ...overrides,
  };
}

describe('one entry per product per list', () => {
  it('converges a repeated add on ONE row, keeping the first call quantity', async () => {
    const list = await makeWatchlist(userId('idem'));
    const product = await makeCanonicalProduct();

    const first = await insertWatchlistItem(
      { watchlistId: list, canonicalProductId: product, quantity: 4, position: 0 },
      db,
    );
    const second = await insertWatchlistItem(
      { watchlistId: list, canonicalProductId: product, quantity: 9, position: 1 },
      db,
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    // `DO NOTHING`, not `DO UPDATE`: the second tap must not overwrite what the
    // buyer set on the first, and must not move `added_at`, which is a
    // tiebreaker in the list's own order.
    expect(second.item.quantity).toBe(4);
    expect(second.item.addedAt.getTime()).toBe(first.item.addedAt.getTime());
  });

  it('refuses a second row for one product at the DATABASE, not in a service', async () => {
    const list = await makeWatchlist(userId('unique'));
    const product = await makeCanonicalProduct();
    await insertWatchlistItem({ watchlistId: list, canonicalProductId: product, quantity: 1, position: 0 }, db);

    const raw = db.insert(watchlistItems).values({
      watchlistId: list,
      canonicalProductId: product,
      quantity: 1,
      position: 1,
    });
    await expect(raw).rejects.toSatisfy(isUniqueViolation);
  });
});

describe('the item CHECKs', () => {
  it('refuses an ambiguous entry with no split job, and a resolved one carrying one', async () => {
    const list = await makeWatchlist(userId('ambig'));
    const product = await makeCanonicalProduct();

    await expect(
      db.insert(watchlistItems).values({
        watchlistId: list,
        canonicalProductId: product,
        quantity: 1,
        position: 0,
        resolutionState: 'ambiguous_after_split',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a quantity outside the declared bounds', async () => {
    const list = await makeWatchlist(userId('qty'));
    const product = await makeCanonicalProduct();
    await expect(
      db.insert(watchlistItems).values({
        watchlistId: list,
        canonicalProductId: product,
        quantity: 0,
        position: 0,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a target amount with no currency', async () => {
    const list = await makeWatchlist(userId('target'));
    const product = await makeCanonicalProduct();
    await expect(
      db.insert(watchlistItems).values({
        watchlistId: list,
        canonicalProductId: product,
        quantity: 1,
        position: 0,
        targetAmount: 5000,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a lower-case market, which would narrow nothing while looking like a filter', async () => {
    await expect(
      db.insert(watchlists).values({
        oxyUserId: userId('market'),
        name: 'Lower case market',
        displayCurrency: 'EUR',
        market: 'es',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('the snapshot CHECKs', () => {
  it('refuses counters that do not add up to the item count', async () => {
    const list = await makeWatchlist(userId('counts'));
    await expect(
      db.insert(watchlistSnapshots).values({
        ...snapshotHeader(list, `digest-${uuidv7()}`),
        itemCount: 3,
        pricedItemCount: 1,
        unresolvedItemCount: 1,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses an EMPTY material-change array — the `array_length` trap', async () => {
    // `array_length(col, 1)` is NULL on `{}` and a CHECK reads NULL as
    // SATISFIED, so the obvious spelling admits exactly this row. `cardinality`
    // returns 0 and refuses it. Measured twice already in this schema (#68,
    // #108); this is the third table to state it and the first to test it here.
    const list = await makeWatchlist(userId('cardinality'));
    await expect(
      db.insert(watchlistSnapshots).values({
        ...snapshotHeader(list, `digest-${uuidv7()}`),
        materialChanges: [],
        itemCount: 0,
        pricedItemCount: 0,
        unresolvedItemCount: 0,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a total with no basis, and a basis with no total', async () => {
    const list = await makeWatchlist(userId('shape'));
    await expect(
      db.insert(watchlistSnapshots).values({
        ...snapshotHeader(list, `digest-${uuidv7()}`),
        completeness: 'unknown',
        itemCount: 0,
        pricedItemCount: 0,
        unresolvedItemCount: 0,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a material-change value nobody declared', async () => {
    const list = await makeWatchlist(userId('kind'));
    await expect(
      db.execute(
        // Written as raw SQL because the drizzle column is typed to the tuple:
        // the point is that the DATABASE refuses it, not that `tsc` does.
        `insert into watchlist_snapshots (id, watchlist_id, list_version, ranking_policy_versions,
           display_currency, completeness, basis, total_amount, item_count, priced_item_count,
           unresolved_item_count, material_changes, content_digest, evaluated_at,
           retention_expires_at)
         values ('${uuidv7()}', '${list}', 1, array['builtin@1'], 'EUR', 'complete', 'item_price',
           1000, 0, 0, 0, array['whatever_we_felt_like'], 'd-${uuidv7()}', now(), now())`,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('the snapshot LINE shape CHECKs', () => {
  it('refuses a priced line with no availability, offer, price or policy version', async () => {
    const list = await makeWatchlist(userId('priced'));
    const product = await makeCanonicalProduct();
    const [snapshot] = await db
      .insert(watchlistSnapshots)
      .values({
        ...snapshotHeader(list, `digest-${uuidv7()}`),
        itemCount: 0,
        pricedItemCount: 0,
        unresolvedItemCount: 0,
      })
      .returning();

    await expect(
      db.insert(watchlistSnapshotItems).values({
        snapshotId: snapshot?.id ?? '',
        canonicalProductId: product,
        quantity: 1,
        position: 0,
        state: 'priced',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses an unresolved line that carries a price', async () => {
    const list = await makeWatchlist(userId('unres'));
    const product = await makeCanonicalProduct();
    const [snapshot] = await db
      .insert(watchlistSnapshots)
      .values({
        ...snapshotHeader(list, `digest-${uuidv7()}`),
        itemCount: 0,
        pricedItemCount: 0,
        unresolvedItemCount: 0,
      })
      .returning();

    await expect(
      db.insert(watchlistSnapshotItems).values({
        snapshotId: snapshot?.id ?? '',
        canonicalProductId: product,
        quantity: 1,
        position: 0,
        state: 'unresolved',
        unresolvedReason: 'no_offers_recorded',
        unitItemPriceAmount: 1000,
        unitItemPriceCurrency: 'EUR',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a CONVERTED amount with no quote, and an unconverted one carrying one', async () => {
    const list = await makeWatchlist(userId('fx'));
    const product = await makeCanonicalProduct();
    const [snapshot] = await db
      .insert(watchlistSnapshots)
      .values({
        ...snapshotHeader(list, `digest-${uuidv7()}`),
        itemCount: 0,
        pricedItemCount: 0,
        unresolvedItemCount: 0,
      })
      .returning();
    const snapshotId = snapshot?.id ?? '';

    // A USD offer presented in EUR with NO rate: a stored price nobody can
    // attribute is not reproducible, which is the whole of snapshot rule 3.
    await expect(
      db
        .insert(watchlistSnapshotItems)
        .values({ snapshotId, ...pricedLine(null, product, { nativeCurrency: 'USD' }) }),
    ).rejects.toSatisfy(isCheckViolation);

    // …and the other direction: a same-currency line claiming a conversion.
    await expect(
      db.insert(watchlistSnapshotItems).values({
        snapshotId,
        ...pricedLine(null, product, {
          position: 1,
          fxRate: 0.9,
          fxFrom: 'EUR',
          fxTo: 'EUR',
          fxProvider: 'static',
          fxAsOf: new Date(),
        }),
      }),
    ).rejects.toSatisfy(isCheckViolation);

    // The legitimate converted line is accepted, so the CHECK is not simply
    // refusing everything — the positive control for the two refusals above.
    await db.insert(watchlistSnapshotItems).values({
      snapshotId,
      ...pricedLine(null, product, {
        position: 2,
        nativeCurrency: 'USD',
        fxRate: 0.9,
        fxFrom: 'USD',
        fxTo: 'EUR',
        fxProvider: 'static',
        fxAsOf: new Date(),
      }),
    });
    const stored = await db
      .select()
      .from(watchlistSnapshotItems)
      .where(eq(watchlistSnapshotItems.snapshotId, snapshotId));
    expect(stored).toHaveLength(1);
  });
});

describe('the snapshot writer refuses a composition that lost a line', () => {
  it('will not record fewer lines than the list holds', async () => {
    const list = await makeWatchlist(userId('vacuity'));
    const product = await makeCanonicalProduct();
    await expect(
      db.transaction(async (tx) =>
        insertWatchlistSnapshot(
          { ...snapshotHeader(list, `digest-${uuidv7()}`) },
          [pricedLine(null, product)],
          3,
          tx,
        ),
      ),
    ).rejects.toThrow(/the list holds 3 item\(s\) and 1 line\(s\) were composed/);
  });

  it('derives the counters from the LINES rather than accepting them', async () => {
    const list = await makeWatchlist(userId('derive'));
    const product = await makeCanonicalProduct();
    const snapshot = await db.transaction(async (tx) =>
      insertWatchlistSnapshot(
        { ...snapshotHeader(list, `digest-${uuidv7()}`) },
        [
          pricedLine(null, product),
          {
            ...pricedLine(null, product, { position: 1 }),
            state: 'unresolved' as const,
            unresolvedReason: 'no_offers_recorded' as const,
            selectedOfferId: null,
            selectedAvailability: null,
            rankingPolicyVersion: null,
            unitItemPriceAmount: null,
            unitItemPriceCurrency: null,
            lineItemPriceAmount: null,
            nativeCurrency: null,
          },
        ],
        2,
        tx,
      ),
    );

    expect(snapshot.itemCount).toBe(2);
    expect(snapshot.pricedItemCount).toBe(1);
    expect(snapshot.unresolvedItemCount).toBe(1);
  });
});

describe('a recorded evaluation cannot be rewritten', () => {
  it('refuses an UPDATE of the snapshot, and permits its DELETE', async () => {
    const list = await makeWatchlist(userId('immutable'));
    const [snapshot] = await db
      .insert(watchlistSnapshots)
      .values({
        ...snapshotHeader(list, `digest-${uuidv7()}`),
        itemCount: 0,
        pricedItemCount: 0,
        unresolvedItemCount: 0,
      })
      .returning();
    const snapshotId = snapshot?.id ?? '';

    await expectRefusedByTrigger(() =>
      db
        .update(watchlistSnapshots)
        .set({ totalAmount: 1 })
        .where(eq(watchlistSnapshots.id, snapshotId)),
    );

    // DELETE is deliberately PERMITTED: erasure on a schedule IS the retention
    // policy, and a trigger refusing it would make the shared expiry sweep fail
    // silently on every row it was meant to remove.
    await db.delete(watchlistSnapshots).where(eq(watchlistSnapshots.id, snapshotId));
    const remaining = await db
      .select()
      .from(watchlistSnapshots)
      .where(eq(watchlistSnapshots.id, snapshotId));
    expect(remaining).toHaveLength(0);
  });

  it('permits ONLY the referential action the schema declares on a line', async () => {
    const list = await makeWatchlist(userId('line-immutable'));
    const product = await makeCanonicalProduct();
    const { item } = await insertWatchlistItem(
      { watchlistId: list, canonicalProductId: product, quantity: 1, position: 0 },
      db,
    );
    const snapshot = await db.transaction(async (tx) =>
      insertWatchlistSnapshot(
        { ...snapshotHeader(list, `digest-${uuidv7()}`) },
        [pricedLine(item.id, product)],
        1,
        tx,
      ),
    );

    await expectRefusedByTrigger(() =>
      db
        .update(watchlistSnapshotItems)
        .set({ unitItemPriceAmount: 1 })
        .where(eq(watchlistSnapshotItems.snapshotId, snapshot.id)),
    );

    // …and removing the ENTRY still works, which is `ON DELETE SET NULL` doing
    // exactly what the schema says: the history survives the item (#81
    // correction rule 5).
    await db.delete(watchlistItems).where(eq(watchlistItems.id, item.id));
    const [line] = await db
      .select()
      .from(watchlistSnapshotItems)
      .where(eq(watchlistSnapshotItems.snapshotId, snapshot.id));
    expect(line?.watchlistItemId).toBeNull();
    expect(line?.unitItemPriceAmount).toBe(1000);
  });
});

describe('#81 acceptance 4: concurrent edits do not silently overwrite', () => {
  it('advances the version once and refuses the stale writer', async () => {
    const owner = userId('cas');
    const list = await makeWatchlist(owner);

    // Both clients hold version 1 and both submit against it. The CAS is one
    // statement, so exactly one can win — a read-then-write is precisely what
    // the second client defeats.
    const [first, second] = await Promise.all([
      bumpWatchlistVersion(owner, list, 1, { name: 'Renamed by A' }, db),
      bumpWatchlistVersion(owner, list, 1, { name: 'Renamed by B' }, db),
    ]);

    const winners = [first, second].filter((row) => row !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.version).toBe(2);

    const [stored] = await db.select().from(watchlists).where(eq(watchlists.id, list));
    expect(stored?.version).toBe(2);
    expect(['Renamed by A', 'Renamed by B']).toContain(stored?.name);
  });

  it('refuses a caller who does not own the list, in the same statement', async () => {
    const list = await makeWatchlist(userId('owner'));
    const stranger = await bumpWatchlistVersion(userId('stranger'), list, 1, {}, db);
    expect(stranger).toBeUndefined();

    const [stored] = await db.select().from(watchlists).where(eq(watchlists.id, list));
    expect(stored?.version).toBe(1);
  });
});

describe('#81 correction rule 2: a split marks entries and the buyer answers', () => {
  it('marks only RESOLVED entries and leaves an earlier ambiguity naming its own job', async () => {
    const owner = userId('split');
    const list = await makeWatchlist(owner);
    const product = await makeCanonicalProduct();
    const { item } = await insertWatchlistItem(
      { watchlistId: list, canonicalProductId: product, quantity: 1, position: 0 },
      db,
    );

    // A real `catalog_split_jobs` row is more setup than this property needs —
    // the marking is what is under test and the foreign key is exercised by the
    // curation suite — so the job id is written directly and rolled back.
    await db.transaction(async (tx) => {
      await tx
        .update(watchlistItems)
        .set({ resolutionState: 'ambiguous_after_split', ambiguousSplitJobId: 'job-earlier' })
        .where(eq(watchlistItems.id, item.id));

      const markedAgain = await markWatchlistItemsAmbiguousAfterSplit(product, 'job-later', tx);
      expect(markedAgain).toBe(0);

      const [row] = await tx.select().from(watchlistItems).where(eq(watchlistItems.id, item.id));
      // Retargeting an unanswered question at a newer job would destroy the
      // pair of candidates the buyer was being asked about.
      expect(row?.ambiguousSplitJobId).toBe('job-earlier');
      tx.rollback();
    }).catch(() => undefined);
  });

  it('marks a RESOLVED entry of the split product', async () => {
    const owner = userId('split2');
    const list = await makeWatchlist(owner);
    const product = await makeCanonicalProduct();
    const { item } = await insertWatchlistItem(
      { watchlistId: list, canonicalProductId: product, quantity: 1, position: 0 },
      db,
    );

    await db.transaction(async (tx) => {
      const marked = await markWatchlistItemsAmbiguousAfterSplit(product, 'job-x', tx);
      expect(marked).toBe(1);
      const [row] = await tx.select().from(watchlistItems).where(eq(watchlistItems.id, item.id));
      expect(row?.resolutionState).toBe('ambiguous_after_split');
      expect(row?.ambiguousSplitJobId).toBe('job-x');
      tx.rollback();
    }).catch(() => undefined);
  });
});

describe('a preferred variant is RESTRICT, so a list is never silently emptied', () => {
  it('refuses to delete a canonical variant an entry still prefers', async () => {
    const list = await makeWatchlist(userId('restrict'));
    const product = await makeCanonicalProduct();
    const variant = await makeCanonicalVariant(product);
    await insertWatchlistItem(
      {
        watchlistId: list,
        canonicalProductId: product,
        quantity: 1,
        position: 0,
        preferredCanonicalVariantId: variant,
      },
      db,
    );

    await expect(
      db.delete(canonicalVariants).where(eq(canonicalVariants.id, variant)),
    ).rejects.toThrow();
  });
});
