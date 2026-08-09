/**
 * Stage 8 — the two-way consistency sweep (#60 job behaviour 6, acceptance 6).
 *
 * ## Both directions, because they fail differently
 *
 * FORWARD (`native_listing_links` → `offers`): an active listing whose variant
 * is attached and has no active native offer is a listing that has been made
 * comparable and does not appear in any comparison. Nothing is wrong with the
 * data — the convergence request was lost, or the dispatcher is off — and the
 * symptom is silence.
 *
 * REVERSE (`offers` → `native_listing_links` → `listings`): an active native
 * offer whose listing is no longer active, or whose attachment is gone, or which
 * names a different canonical variant than the attachment does, is an offer
 * appearing in a comparison it should not be in. That is acceptance 6 stated
 * exactly ("no active native offer without a valid active native source"), and
 * it is the direction that shows a shopper a wrong price.
 *
 * A ONE-directional check would pass on a catalogue where every offer was wrong,
 * as long as every attachment also had one.
 *
 * ## The sweep repairs NOTHING, and that is a decision
 *
 * Every kind here has an existing idempotent remedy a person can drive — the
 * `native_offers` stage re-enqueues a convergence, `provisional_products`
 * re-attaches — so a sweep that also repaired would be a second writer racing
 * the first. And the reverse-direction kinds may legitimately mean a JURY
 * restricted the listing: `convergeNativeOffersForListing` retires those offers,
 * and a sweep that "fixed" the gap by re-materializing them would relist
 * something moderation removed. A finding goes to a person.
 *
 * ## One stage, THREE passes, one cursor
 *
 * The cursor encodes which pass it is in: `null` starts the forward pass,
 * `f:<id>` continues it, `r:` starts the reverse pass, `r:<id>` continues it,
 * `x:` starts the retirement pass, and `null` returned means the whole sweep
 * finished. One run row rather than three keeps "was the catalogue consistent" a
 * single question with a single answer, which is what an operator asks.
 *
 * The third pass exists because the first two scan only what is CURRENT, and a
 * finding's subject can stop being current: the ordinary remedy for
 * `offer_without_active_link` is a convergence that RETIRES the offer, after
 * which no pass scoped to active offers will ever look at it again and its
 * finding stays open forever. `orphanedNativeOffers` is the number a rollout
 * watches, so a finding that cannot be resolved by the fix is a metric that
 * cries wolf until somebody disables it. The retirement pass is bounded by the
 * number of OPEN findings rather than by the offer table, which is why it does
 * not reintroduce a scan over every offer that ever existed.
 */

import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { CatalogConsistencyFindingKind } from '@mercaria/shared-types';
import { getDb } from '../../../db/postgres.js';
import { listings } from '../../../db/schema/catalog.js';
import { nativeListingLinks, offers } from '../../../db/schema/offers.js';
import {
  openConsistencyFinding,
  resolveConsistencyFindings,
} from '../../../db/backfill/consistencyFindingRepository.js';
import { catalogConsistencyFindings } from '../../../db/schema/backfill.js';
import { addCounters, EMPTY_COUNTERS } from '../../../db/backfill/backfillRunRepository.js';
import {
  examineSubject,
  nextKeysetCursor,
  type StageContext,
  type StagePageResult,
  type SubjectVerdict,
} from '../stage-context.js';

/** The kinds the FORWARD pass is entitled to open and to resolve. */
const FORWARD_KINDS: readonly CatalogConsistencyFindingKind[] = ['attached_variant_without_offer'];

/** The kinds the REVERSE pass is entitled to open and to resolve. */
const REVERSE_KINDS: readonly CatalogConsistencyFindingKind[] = [
  'offer_without_active_listing',
  'offer_without_active_link',
  'offer_canonical_variant_mismatch',
];

const REVERSE_PREFIX = 'r:';
const FORWARD_PREFIX = 'f:';
const RETIRED_PREFIX = 'x:';

type ConsistencyPass = 'forward' | 'reverse' | 'retired';

/** Which pass a cursor is in, and where in it. */
function readCursor(cursor: string | null): { pass: ConsistencyPass; after: string | null } {
  if (cursor === null) return { pass: 'forward', after: null };
  for (const [prefix, pass] of [
    [REVERSE_PREFIX, 'reverse'],
    [RETIRED_PREFIX, 'retired'],
  ] as const) {
    if (cursor.startsWith(prefix)) {
      const after = cursor.slice(prefix.length);
      return { pass, after: after === '' ? null : after };
    }
  }
  const after = cursor.startsWith(FORWARD_PREFIX) ? cursor.slice(FORWARD_PREFIX.length) : cursor;
  return { pass: 'forward', after: after === '' ? null : after };
}

export async function runConsistencyPage(context: StageContext): Promise<StagePageResult> {
  const { pass, after } = readCursor(context.cursor);
  switch (pass) {
    case 'forward':
      return await runForwardPage(context, after);
    case 'reverse':
      return await runReversePage(context, after);
    case 'retired':
      return await runRetiredPage(context, after);
  }
}

/**
 * FORWARD: every ACTIVE attachment, checked for the native offer it implies.
 *
 * A listing that is not `active` implies NO offer — the converger retires them,
 * and that is correct behaviour rather than a gap — so those subjects are
 * `consistent` and any open forward finding about them is resolved. That is the
 * one place this pass could have produced a flood of false findings: a catalogue
 * with a thousand archived listings would have a thousand attachments and no
 * offers, all of them correct.
 */
async function runForwardPage(
  context: StageContext,
  after: string | null,
): Promise<StagePageResult> {
  const db = getDb();
  const rows = await db
    .select({
      id: nativeListingLinks.id,
      productVariantId: nativeListingLinks.productVariantId,
      listingId: nativeListingLinks.listingId,
      canonicalVariantId: nativeListingLinks.canonicalVariantId,
      listingStatus: listings.status,
    })
    .from(nativeListingLinks)
    .innerJoin(listings, eq(listings.id, nativeListingLinks.listingId))
    .where(
      after === null
        ? eq(nativeListingLinks.status, 'active')
        : and(eq(nativeListingLinks.status, 'active'), gt(nativeListingLinks.id, after)),
    )
    .orderBy(asc(nativeListingLinks.id))
    .limit(context.limit);

  let counters = EMPTY_COUNTERS;
  for (const link of rows) {
    counters = addCounters(
      counters,
      await examineSubject(
        context,
        { kind: 'product_variant', productVariantId: link.productVariantId },
        async (): Promise<SubjectVerdict> => {
          const subjectKey = `product_variant:${link.productVariantId}`;

          if (link.listingStatus !== 'active') {
            await resolveConsistencyFindings(
              { subjectKey, kinds: FORWARD_KINDS, now: context.now },
              db,
            );
            return {
              reasonCode: 'consistent',
              detail: `listing ${link.listingId} is '${link.listingStatus}'; no offer expected`,
            };
          }

          const existing = await db
            .select({ id: offers.id, canonicalVariantId: offers.canonicalVariantId })
            .from(offers)
            .where(
              and(
                eq(offers.productVariantId, link.productVariantId),
                eq(offers.kind, 'native'),
                eq(offers.status, 'active'),
              ),
            )
            .limit(1);

          const offer = existing[0];
          if (offer === undefined) {
            await openConsistencyFinding(
              {
                kind: 'attached_variant_without_offer',
                subjectKind: 'product_variant',
                subjectKey,
                detail: `listing ${link.listingId} is active and attached to canonical variant ${link.canonicalVariantId}, with no active native offer`,
                runId: context.runId,
                now: context.now,
              },
              db,
            );
            return {
              reasonCode: 'offer_missing_for_attachment',
              detail: `listing ${link.listingId}`,
            };
          }

          await resolveConsistencyFindings(
            { subjectKey, kinds: FORWARD_KINDS, now: context.now },
            db,
          );
          return { reasonCode: 'consistent', detail: `offer ${offer.id}` };
        },
      ),
    );
  }

  const next = nextKeysetCursor(rows, context.limit);
  // A finished forward pass hands over to the reverse one rather than ending the
  // run: `null` here would report the sweep complete having checked one
  // direction, which is the failure this stage exists to make impossible.
  return {
    counters,
    nextCursor: next === null ? REVERSE_PREFIX : `${FORWARD_PREFIX}${next}`,
  };
}

/**
 * REVERSE: every ACTIVE native offer, checked against its native source.
 *
 * Three distinct kinds rather than one "invalid offer", because the remedies
 * differ: a non-active listing is usually a convergence that has not run yet (or
 * a moderation restriction, where the answer is to do nothing), a missing link
 * is an attachment that was revoked, and a mismatch is an attachment that MOVED
 * — the only one of the three that can put a seller's price on the wrong product
 * page.
 */
async function runReversePage(
  context: StageContext,
  after: string | null,
): Promise<StagePageResult> {
  const db = getDb();
  const activeNative = and(eq(offers.kind, 'native'), eq(offers.status, 'active'));
  const rows = await db
    .select({
      id: offers.id,
      productVariantId: offers.productVariantId,
      listingId: offers.listingId,
      canonicalVariantId: offers.canonicalVariantId,
    })
    .from(offers)
    .where(after === null ? activeNative : and(activeNative, gt(offers.id, after)))
    .orderBy(asc(offers.id))
    .limit(context.limit);

  let counters = EMPTY_COUNTERS;
  for (const offer of rows) {
    counters = addCounters(
      counters,
      await examineSubject(context, { kind: 'native_offer', offerId: offer.id }, () =>
        checkOffer(context, offer),
      ),
    );
  }

  const next = nextKeysetCursor(rows, context.limit);
  // A finished reverse pass hands over to the retirement pass rather than ending
  // the run — see the module docblock on why the sweep is three passes.
  return {
    counters,
    nextCursor: next === null ? RETIRED_PREFIX : `${REVERSE_PREFIX}${next}`,
  };
}

/**
 * RETIREMENT: every OPEN reverse-direction finding whose offer is no longer an
 * active native offer.
 *
 * Acceptance 6 is a statement about ACTIVE offers, so an offer that has been
 * retired satisfies it by construction — and the ordinary remedy for two of the
 * three reverse kinds is exactly a convergence that retires it. Without this
 * pass those findings would stay open forever and `orphanedNativeOffers` would
 * report a problem that had been fixed.
 *
 * Bounded by the number of OPEN findings, keyset on the finding's own id, and it
 * writes the same `consistent` record the other two passes write for a subject
 * in agreement — so a re-run counts it once and the counters still add up.
 */
async function runRetiredPage(
  context: StageContext,
  after: string | null,
): Promise<StagePageResult> {
  const db = getDb();
  const open = and(
    isNull(catalogConsistencyFindings.resolvedAt),
    inArray(catalogConsistencyFindings.kind, [...REVERSE_KINDS]),
  );
  const rows = await db
    .select({
      id: catalogConsistencyFindings.id,
      subjectKey: catalogConsistencyFindings.subjectKey,
    })
    .from(catalogConsistencyFindings)
    .where(after === null ? open : and(open, gt(catalogConsistencyFindings.id, after)))
    .orderBy(asc(catalogConsistencyFindings.id))
    .limit(context.limit);

  let counters = EMPTY_COUNTERS;
  for (const finding of rows) {
    const offerId = finding.subjectKey.startsWith('native_offer:')
      ? finding.subjectKey.slice('native_offer:'.length)
      : '';
    if (offerId === '') continue;

    const stillActive = await db
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.id, offerId), eq(offers.kind, 'native'), eq(offers.status, 'active')))
      .limit(1);
    // Still active means the reverse pass owns it and has already had its say
    // this run; touching it here would double-count the subject.
    if (stillActive.length > 0) continue;

    counters = addCounters(
      counters,
      await examineSubject(context, { kind: 'native_offer', offerId }, async () => {
        await resolveConsistencyFindings(
          { subjectKey: finding.subjectKey, kinds: REVERSE_KINDS, now: context.now },
          db,
        );
        return {
          reasonCode: 'consistent',
          detail: 'the offer is no longer active; acceptance 6 concerns active offers only',
        };
      }),
    );
  }

  const next = nextKeysetCursor(rows, context.limit);
  return { counters, nextCursor: next === null ? null : `${RETIRED_PREFIX}${next}` };
}

interface NativeOfferRow {
  readonly id: string;
  readonly productVariantId: string | null;
  readonly listingId: string | null;
  readonly canonicalVariantId: string;
}

async function checkOffer(
  context: StageContext,
  offer: NativeOfferRow,
): Promise<SubjectVerdict> {
  const db = getDb();
  const subjectKey = `native_offer:${offer.id}`;

  /**
   * A native offer without its native columns is unrepresentable —
   * `offers_kind_shape_check` requires both — so reaching this branch means the
   * CHECK was removed or bypassed. Reporting it as a link gap is the closest
   * honest answer and it is loud in the detail.
   */
  if (offer.productVariantId === null || offer.listingId === null) {
    await openConsistencyFinding(
      {
        kind: 'offer_without_active_link',
        subjectKind: 'native_offer',
        subjectKey,
        detail: 'native offer carries no product variant or listing id',
        runId: context.runId,
        now: context.now,
      },
      db,
    );
    return { reasonCode: 'offer_link_missing', detail: 'native columns are null' };
  }

  const listingRows = await db
    .select({ status: listings.status })
    .from(listings)
    .where(eq(listings.id, offer.listingId))
    .limit(1);
  const listingStatus = listingRows[0]?.status;

  if (listingStatus !== 'active') {
    await openConsistencyFinding(
      {
        kind: 'offer_without_active_listing',
        subjectKind: 'native_offer',
        subjectKey,
        detail: `listing ${offer.listingId} is '${listingStatus ?? 'missing'}' while its native offer is active`,
        runId: context.runId,
        now: context.now,
      },
      db,
    );
    return {
      reasonCode: 'offer_listing_not_active',
      detail: `listing status '${listingStatus ?? 'missing'}'`,
    };
  }

  const linkRows = await db
    .select({ canonicalVariantId: nativeListingLinks.canonicalVariantId })
    .from(nativeListingLinks)
    .where(
      and(
        eq(nativeListingLinks.productVariantId, offer.productVariantId),
        eq(nativeListingLinks.status, 'active'),
      ),
    )
    .limit(1);
  const link = linkRows[0];

  if (link === undefined) {
    await openConsistencyFinding(
      {
        kind: 'offer_without_active_link',
        subjectKind: 'native_offer',
        subjectKey,
        detail: `variant ${offer.productVariantId} has no active attachment while its native offer is active`,
        runId: context.runId,
        now: context.now,
      },
      db,
    );
    return { reasonCode: 'offer_link_missing', detail: `variant ${offer.productVariantId}` };
  }

  if (link.canonicalVariantId !== offer.canonicalVariantId) {
    await openConsistencyFinding(
      {
        kind: 'offer_canonical_variant_mismatch',
        subjectKind: 'native_offer',
        subjectKey,
        detail: `offer names canonical variant ${offer.canonicalVariantId}; the active attachment names ${link.canonicalVariantId}`,
        runId: context.runId,
        now: context.now,
      },
      db,
    );
    return {
      reasonCode: 'offer_variant_mismatch',
      detail: `attachment names ${link.canonicalVariantId}`,
    };
  }

  await resolveConsistencyFindings({ subjectKey, kinds: REVERSE_KINDS, now: context.now }, db);
  return { reasonCode: 'consistent', detail: `attachment agrees on ${link.canonicalVariantId}` };
}
