/**
 * What an operator can see, and the three things a CHECK cannot say.
 *
 * ## Detection and repair are separate acts
 *
 * The `payment_discrepancies` posture, applied to places. Every probe below
 * REPORTS and none of them fixes: a location published with no GoWay place, a
 * collection pointing at a publication somebody has since withdrawn — each has
 * a remedy that is a MERCHANT's decision (link the place, republish or
 * refund), and a sweep that guessed would be a sweep that moved somebody's
 * shop.
 *
 * Duplicate places are not a probe here any more: two records of one shop are
 * GoWay's to find and merge (ADR 0013), and a location that followed a merge
 * says so in its own trail.
 *
 * The one write this surface has is the operator RESTRICTION, which is
 * deliberately not a repair either: it withdraws a place from discovery and
 * says who did it and why.
 *
 * ## Every count is bounded and every list is capped
 *
 * A probe that returned every row would be a full scan of the publication table
 * behind an HTTP request. The counts are exact and the samples are capped, so a
 * dashboard shows "31 locations have no position, here are 20 of them" rather
 * than timing out on the deployment where it matters most.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres.js';

/** One probe's answer: an exact count, plus a bounded sample to act on. */
export interface PickupConsistencyProbe {
  readonly count: number;
  readonly sample: readonly { publicationId: string; storeId: string; detail: string }[];
}

/** The three probes, run together for one dashboard read. */
export interface PickupConsistencyReport {
  /**
   * Published, and naming no GoWay place — so it appears in no nearby result
   * at all. A location in this state looks live in the merchant dashboard and
   * is invisible to every shopper, which is the failure mode with the longest
   * feedback loop in the domain.
   *
   * `changePublicationState` refuses to publish without a verified place, and
   * `0161` withdrew every publication that had none, so a row here is one the
   * database was edited into. The rule's GoWay half — does the place still
   * name the location back — is derived on every read and is not a probe:
   * it would cost a GoWay read per published location.
   */
  readonly publishedWithoutPlace: PickupConsistencyProbe;
  /**
   * Offering collection, published, and holding stock nobody can be shown:
   * every listing at the location is inactive or archived.
   *
   * The "inventory level → native offer → public location projection" chain
   * #93 operations rule 7 asks for, walked in the direction that finds the
   * silent case: a merchant whose whole catalogue was restricted still sees a
   * live-looking collection point.
   */
  readonly publishedWithNoLiveListing: PickupConsistencyProbe;
  /**
   * An OPEN collection whose location has since been withdrawn, paused or
   * restricted.
   *
   * A buyer holds an order telling them to collect from a place that is no
   * longer offering collection. Nothing repairs it because the two remedies —
   * hand it over anyway, or cancel and refund — are a merchant's call and one
   * of them moves money.
   */
  readonly openCollectionsAtClosedLocations: PickupConsistencyProbe;
}

/** How many rows each probe returns beside its count. */
const SAMPLE_LIMIT = 20;

/** Run every probe. Read-only — see the module docblock. */
export async function readPickupConsistency(): Promise<PickupConsistencyReport> {
  const db = getDb();

  // `detail` is the OPERATIONAL location name: an operator's trace, never a
  // shopper surface, and the place's own name is GoWay's to read.
  const [withoutPlace, noLiveListing, openAtClosed] = await Promise.all([
    probe(
      db,
      sql`
        select p.id as publication_id, p.store_id as store_id, loc.name as detail
        from location_publications p
        join locations loc on loc.id = p.location_id
        where p.publication_state = 'published' and loc.go_way_place_id is null
      `,
    ),
    probe(
      db,
      sql`
        select p.id as publication_id, p.store_id as store_id, loc.name as detail
        from location_publications p
        join locations loc on loc.id = p.location_id
        where p.publication_state = 'published'
          and p.pickup_offered
          and not exists (
            select 1
            from inventory_levels il
            join listings l on l.id = il.listing_id
            where il.location_id = p.location_id
              and il.available > 0
              and l.status = 'active'
          )
      `,
    ),
    probe(
      db,
      sql`
        select p.id as publication_id, p.store_id as store_id,
               op.order_id || ' @ ' || op.display_name as detail
        from order_pickups op
        join location_publications p on p.id = op.publication_id
        where op.state in ('awaiting_preparation', 'ready_for_pickup')
          and (p.publication_state <> 'published'
               or p.pickup_paused_at is not null
               or p.restricted_at is not null
               or not p.pickup_offered)
      `,
    ),
  ]);

  return {
    publishedWithoutPlace: withoutPlace,
    publishedWithNoLiveListing: noLiveListing,
    openCollectionsAtClosedLocations: openAtClosed,
  };
}

/**
 * Count a probe exactly and sample it cheaply, in ONE statement.
 *
 * `count(*) over ()` rather than a second query: two statements would count a
 * different set from the one they sampled whenever a merchant published
 * something between them, and a dashboard that says "3 problems" above a list
 * of 4 is a dashboard nobody trusts again.
 */
async function probe(
  db: ReturnType<typeof getDb>,
  selection: ReturnType<typeof sql>,
): Promise<PickupConsistencyProbe> {
  const rows = await db.execute(sql`
    select publication_id, store_id, detail, count(*) over ()::int as total
    from (${selection}) as findings
    order by publication_id
    limit ${SAMPLE_LIMIT}
  `);

  return {
    count: rows.length === 0 ? 0 : Number(rows[0].total),
    sample: rows.map((row) => ({
      publicationId: String(row.publication_id),
      storeId: String(row.store_id),
      detail: String(row.detail),
    })),
  };
}
