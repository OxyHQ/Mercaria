/**
 * The legacy variant-axis backfill, driven through its REAL entrypoint (#367).
 *
 * ## The gap this closes
 *
 * `collidesWithSiblingOption` — two of ONE listing's option names folding to a
 * single attribute key — is exercised eleven times in
 * `variant-axis-legacy-resolution.test.ts`, all of it against the PURE function.
 * Nothing asserted that the backfill PASSES it: `collidingOptionKeys` and
 * `backfillOneListing` had no test caller at all, so
 * `collidesWithSiblingOption: key !== null && collisions.has(key)` could become
 * `false` and eleven tests would stay green.
 *
 * That matters more than it looks, because the unique index does NOT catch it.
 * `insertListingVariantAxis` writes `.onConflictDoNothing` on
 * `(listing_id, attribute_key)`, so the second of two colliding names is
 * absorbed as "already declared" and the axis silently belongs to whichever
 * option came first. This flag is the only thing standing in front of that coin
 * toss.
 *
 * ## Why the ENTRYPOINT and not the unit
 *
 * A per-listing test over an exported `backfillOneListing` proves the function
 * and says nothing about whether the pager still calls it — a mechanism can be
 * green and inert, and the cheapest green for a future refactor is a pager that
 * stops calling the function whose tests still pass. So this drives
 * `runVariantAxisBackfill`, which is what `scripts/backfill-variant-axes.ts`
 * calls, and asserts a counter that is only ever incremented INSIDE the
 * per-listing body. No production export was added for the test.
 *
 * ## Why a dry run is safe in a SHARED database
 *
 * `dry_run` is the identical body in a per-listing transaction that is rolled
 * back — not a second `predict` branch — so a pass over every listing with
 * legacy options writes nothing anywhere. What it cannot be is EXACT: the report
 * aggregates the whole page, so every cross-listing assertion here is a LOWER
 * BOUND, and the exact assertions are scoped to this file's own listing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listingOptions,
  listings,
  productVariantOptionValues,
  productVariants,
} from '../../../db/schema/catalog.js';
import { nativeListingVariantAxes } from '../../../db/schema/variantAxes.js';
import { runVariantAxisBackfill } from '../backfill.service.js';

let db: Database;

const RUN = uuidv7().slice(-12).replace(/\W/gu, '');

/**
 * Two option names that fold to ONE key.
 *
 * `legacyOptionNameToKey` trims, lowercases and folds spaces and hyphens to `_`,
 * so these are the same key by three different routes at once. The key is
 * per-run because `(listing_id, attribute_key)` is the unique the collision
 * would otherwise be absorbed by.
 */
const FOLDED_KEY = `axis_collision_${RUN}`.toLowerCase();
const FIRST_NAME = `Axis Collision ${RUN}`;
const SECOND_NAME = `axis-collision-${RUN}`;

const createdListingIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  // The options, variants, option values and any axis row all cascade from
  // `listings`, so the listing is the only thing to delete.
  if (createdListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, createdListingIds));
  }
  await closePostgres();
});

/** A P2P listing carrying two legacy options whose names fold together. */
async function makeCollidingListing(): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: `axis-backfill-seller-${RUN}`,
      storeId: null,
      title: `Axis backfill ${RUN}`,
      description: 'A fixture listing with two colliding legacy option names.',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
      categorySlugs: [],
      tags: [],
    })
    .returning({ id: listings.id });
  createdListingIds.push(listing.id);

  await db.insert(listingOptions).values([
    { listingId: listing.id, name: FIRST_NAME, values: ['Rojo'], position: 0 },
    { listingId: listing.id, name: SECOND_NAME, values: ['Azul'], position: 1 },
  ]);

  const [variant] = await db
    .insert(productVariants)
    .values({ listingId: listing.id, title: 'Rojo' })
    .returning({ id: productVariants.id });
  await db
    .insert(productVariantOptionValues)
    .values({ variantId: variant.id, name: FIRST_NAME, value: 'Rojo', position: 0 });

  return listing.id;
}

describe('the backfill refuses two option names that fold to one key', () => {
  it('reports both as ambiguous, declares no axis, and reaches the per-listing body', async () => {
    const listingId = await makeCollidingListing();

    // `listingLimit` well above the default 100 so this file's listing is inside
    // the first page whatever the parallel files have created. `dry_run` rolls
    // every per-listing transaction back, so this writes nothing for anybody.
    const report = await runVariantAxisBackfill(db, { mode: 'dry_run', listingLimit: 5_000 });

    // ── The ENTRYPOINT assertion ────────────────────────────────────────────
    //
    // `scanned.listings` is incremented by the PAGER; `scanned.listingOptions`
    // only ever inside the per-listing body. So this is the assertion that dies
    // if the pager stops calling `backfillOneListing` — which a test over an
    // exported unit could not see.
    expect(
      report.scanned.listings,
      'the pager scanned no listing at all, so nothing below measures anything',
    ).toBeGreaterThanOrEqual(1);
    expect(
      report.scanned.listingOptions,
      'the pager scanned listings but no OPTION was counted — the per-listing body was not reached',
    ).toBeGreaterThanOrEqual(2);

    // ── The call-site assertion ─────────────────────────────────────────────
    //
    // A LOWER BOUND, because the report aggregates the whole page: this file
    // contributes exactly two ambiguous refusals, and a sibling would have to
    // build the same pathological fixture to contribute any. With the flag
    // forced `false` these two land in `unmapped` instead — `ambiguous` is
    // checked BEFORE the definition lookup, so no active attribute definition is
    // needed to tell the two apart, and that is precisely what makes this the
    // assertion the one-token change kills.
    expect(
      report.unresolved.byAttributeRefusal.ambiguous,
      'no option was refused as ambiguous; the backfill is not passing collidesWithSiblingOption',
    ).toBeGreaterThanOrEqual(2);

    // ── And the EXACT one, scoped to this file's own listing ────────────────
    //
    // The lower bounds above cannot say whose options they counted. This can:
    // nothing may have declared an axis for the folded key, on this listing, by
    // either name.
    const axes = await db
      .select({ id: nativeListingVariantAxes.id })
      .from(nativeListingVariantAxes)
      .where(
        and(
          eq(nativeListingVariantAxes.listingId, listingId),
          eq(nativeListingVariantAxes.attributeKey, FOLDED_KEY),
        ),
      );
    expect(
      axes,
      'an axis was declared for the folded key — the collision resolved to whichever option came first',
    ).toEqual([]);
  });

  it('names the per-listing body in the entrypoint, as a deterministic backstop', () => {
    // The behavioural assertion above is the real one — verified by mutation:
    // setting `collidesWithSiblingOption: false` in the backfill leaves all 22
    // cases of `variant-axis-legacy-resolution.test.ts` GREEN and turns exactly
    // the case above red, naming the cause. This second one is here because it
    // cannot be affected by what a parallel file happens to have in the shared
    // database. It reads the entrypoint's OWN body — the slice from its
    // signature to the end of the file — comment-stripped, so a docblock
    // mentioning the function does not satisfy it.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'backfill.service.ts'),
      'utf8',
    );
    const at = source.indexOf('export async function runVariantAxisBackfill');
    expect(at, 'the entrypoint was renamed or removed').toBeGreaterThan(0);
    const body = source
      .slice(at)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // The positive control: a slice that shrank to nothing would satisfy any
    // absence and would satisfy this presence check by accident of nothing.
    expect(body.length, 'the entrypoint slice is too short to be its real body').toBeGreaterThan(
      400,
    );
    expect(
      /backfillOneListing\s*\(/u.test(body),
      'runVariantAxisBackfill no longer calls backfillOneListing; the per-listing body is inert',
    ).toBe(true);
  });
});
