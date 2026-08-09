/**
 * Stage 5 — attached listings materialize their native offers (ADR 0002 D23
 * phase 2).
 *
 * The stage ENQUEUES; #57's converger materializes. That split is not
 * decoration: `convergeNativeOffersForListing` computes a FIXED POINT over the
 * listing, its variants and their attachments, so a request made here answers
 * every write that has landed since, and the offer rows a migration produces are
 * byte-identical to the ones an ordinary catalogue write produces. A backfill
 * that wrote `offers` rows itself would be a second materializer, and the first
 * time the two disagreed the symptom would be a price on a product page that no
 * seller ever set.
 *
 * ## An unattached listing is `unmatched`, not a failure
 *
 * A listing with no active attachment has nothing to be an offer ON — an offer
 * prices a CANONICAL variant, and a native variant nobody has matched has no
 * canonical variant. `no_active_attachment` / `unmatched` is the honest report,
 * and for the P2P half of the catalogue it is the expected steady state (D23
 * clause 7).
 *
 * ## Only ACTIVE listings are enqueued
 *
 * A draft, sold, archived or RESTRICTED listing's offers are retired by the
 * converger, and its own status write already enqueued that (the moderation
 * enforcement path is one of #57's three call sites). Enqueueing them here as
 * well would be work with no effect; more importantly, scanning them and
 * reporting them as `unmatched` would put every archived listing in the
 * migration's unmatched rate, which is the number a rollout reads to decide
 * whether matching is working.
 */

import { and, asc, eq, gt, type SQL } from 'drizzle-orm';
import { getDb } from '../../../db/postgres.js';
import { listings } from '../../../db/schema/catalog.js';
import { findActiveLinksForListing } from '../../../db/offers/nativeListingLinkRepository.js';
import { cohortListingPredicate } from '../cohort.js';
import {
  examineAll,
  nextKeysetCursor,
  type StageContext,
  type StagePageResult,
  type SubjectVerdict,
} from '../stage-context.js';

export async function runNativeOffersPage(context: StageContext): Promise<StagePageResult> {
  const db = getDb();
  const cohort = cohortListingPredicate(context.cohort);
  const active = eq(listings.status, 'active');
  const keyset: SQL | undefined =
    context.cursor === null ? undefined : gt(listings.id, context.cursor);

  const clauses = [active, cohort, keyset].filter((clause): clause is SQL => clause !== undefined);
  const predicate = clauses.length === 1 ? clauses[0] : and(...clauses);

  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(predicate)
    .orderBy(asc(listings.id))
    .limit(context.limit);

  const counters = await examineAll(
    context,
    rows,
    (row) => ({ kind: 'listing', listingId: row.id }),
    (row) => decideListing(context, row.id),
  );

  return { counters, nextCursor: nextKeysetCursor(rows, context.limit) };
}

async function decideListing(context: StageContext, listingId: string): Promise<SubjectVerdict> {
  const links = await findActiveLinksForListing(getDb(), listingId);
  if (links.length === 0) {
    return { reasonCode: 'no_active_attachment' };
  }
  await context.writer.requestOfferConvergence(listingId);
  return {
    reasonCode: 'offer_convergence_enqueued',
    detail: `${String(links.length)} attached variant(s)`,
  };
}
