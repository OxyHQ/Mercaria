/**
 * Measuring one advertiser's data as its feed streams past (#66 quality
 * controls 1 and 2).
 *
 * PURE, and it observes rather than decides: nothing here refuses a record,
 * repairs one or changes what is stored. The counts become an append-only
 * `awin_advertiser_quality` row whose CHECK forces `scanned = mapped +
 * rejected` — #60's vacuity floor, so a pass that swallowed rows cannot write
 * the snapshot at all.
 *
 * ## Why identifier coverage has to be MEASURED rather than assumed
 *
 * Awin ships only the columns an advertiser MAPPED (#64 §6, Awin rule 2), so
 * "does this retailer publish EANs" is a per-advertiser fact that changes when
 * they edit their own feed configuration. An adapter that assumed coverage
 * would route every unbranded, unidentified row to #58's review queue and read
 * as a matching problem rather than as a data one.
 *
 * ## A contradiction is COUNTED, never resolved
 *
 * `in_stock = 1` beside `stock_quantity = 0` is one row saying two things.
 * Picking a winner publishes a number Mercaria invented on a page that says the
 * retailer said it, so the row is refused for that field by #63's engine and the
 * disagreement is counted here — which is what makes "this advertiser's stock
 * feed is broken" a figure somebody can act on rather than a support ticket.
 *
 * ## The swapped-URL-columns detector lives here, and not at the record's exit
 *
 * `assessAwinDestination` (#589) is called from this pass rather than from the
 * adapter's `page`, for the reason everything else in this file is: this is the
 * only place with somewhere durable to put an answer. `page` hands records to
 * the framework and holds no measurement, so a verdict computed there would have
 * to be carried, stored or recomputed. The two URLs are the same two either way
 * — and here they are the MAPPED columns rather than what leaves the adapter,
 * which is what the detector needs.
 */

import type { AwinQualityCounts } from '@mercaria/shared-types';
import type { FeedRawRecord } from '../feed-import/parse/index.js';
import type { MappedFeedRecord } from '../feed-import/mapping.js';
import { assessAwinDestination, type AwinTrackingAssessment } from './tracking.js';

/**
 * The running measurement.
 *
 * Mutable by design and by ONE writer: it is accumulated inside `buildFeedStage`'s
 * single pass, where a fresh immutable object per record would allocate once per
 * row of a million-row feed for no property anybody reads.
 */
export interface AwinQualityMeter {
  counts: {
    -readonly [K in keyof AwinQualityCounts]: AwinQualityCounts[K];
  };
  /**
   * External ids and GTINs already seen, for the duplicate rate.
   *
   * A `Set` of ids is the one unbounded structure in this pass, and the bound
   * is the feed's own record cap (`FEED_IMPORT_MAX_RECORDS`, a REFUSAL rather
   * than a truncation), so it cannot grow past a feed Mercaria already agreed
   * to read. Counting duplicates without remembering what was seen is not
   * possible, and a probabilistic structure would report a duplicate rate that
   * is itself approximate — which is exactly the number an operator would then
   * argue about.
   */
  readonly seenExternalIds: Set<string>;
  readonly seenGtins: Set<string>;
}

export function createAwinQualityMeter(): AwinQualityMeter {
  return {
    counts: {
      scanned: 0,
      mapped: 0,
      rejected: 0,
      withGtin: 0,
      withMpn: 0,
      withBrand: 0,
      withImage: 0,
      withPrice: 0,
      duplicateExternalIds: 0,
      duplicateGtins: 0,
      rejectedCurrency: 0,
      rejectedPrice: 0,
      contradictoryAvailability: 0,
      trackingApproved: 0,
      trackingRejected: 0,
      destinationTrackingHost: 0,
      destinationTrackedOnly: 0,
    },
    seenExternalIds: new Set<string>(),
    seenGtins: new Set<string>(),
  };
}

/** The identifier schemes that count as a GTIN for coverage. */
const GTIN_SCHEMES = new Set(['gtin', 'ean', 'upc', 'isbn']);

/** #63's money-reader failures, scoped to the roles that carry money. */
const MONEY_FAULT_CODES: ReadonlySet<string> = new Set([
  'unparseable_number',
  'negative_amount',
  'amount_out_of_range',
  'missing_currency',
]);

const MONEY_ROLES: ReadonlySet<string> = new Set([
  'price',
  'sale_price',
  'delivery_cost',
]);

/**
 * Observe one mapped record.
 *
 * The tracking assessment is passed IN rather than computed here, because the
 * same assessment decides the offer's routing one module over and two readers of
 * one policy can disagree — the `seller-net-shares.ts` rule, applied to a link.
 */
export function observeAwinRecord(
  meter: AwinQualityMeter,
  input: {
    raw: FeedRawRecord;
    mapped: MappedFeedRecord;
    tracking: AwinTrackingAssessment;
  },
): void {
  meter.counts.scanned += 1;

  for (const issue of input.mapped.issues) {
    // The two are counted separately because they are two different
    // conversations: a currency Mercaria does not list is a `CURRENCY_PRECISION`
    // question for this repository, and an unreadable amount is a question for
    // the advertiser. `MONEY_FAULT_CODES` is scoped to the money ROLES, because
    // `unparseable_number` is also what an unreadable `stock_quantity` raises
    // and counting that as a price fault would send somebody to the wrong
    // column.
    if (issue.code === 'unsupported_currency') meter.counts.rejectedCurrency += 1;
    else if (
      MONEY_FAULT_CODES.has(issue.code) &&
      issue.role !== undefined &&
      MONEY_ROLES.has(issue.role)
    ) {
      meter.counts.rejectedPrice += 1;
    }
  }

  if (readsContradictoryAvailability(input.raw)) meter.counts.contradictoryAvailability += 1;

  if (input.mapped.normalized === null || input.mapped.externalId === null) {
    meter.counts.rejected += 1;
    return;
  }
  meter.counts.mapped += 1;

  if (meter.seenExternalIds.has(input.mapped.externalId)) {
    meter.counts.duplicateExternalIds += 1;
  } else {
    meter.seenExternalIds.add(input.mapped.externalId);
  }

  const normalized = input.mapped.normalized;
  let gtin: string | null = null;
  let hasMpn = false;
  for (const identifier of normalized.identifiers) {
    if (GTIN_SCHEMES.has(identifier.scheme)) gtin = gtin ?? identifier.value;
    if (identifier.scheme === 'mpn') hasMpn = true;
  }
  if (gtin !== null) {
    meter.counts.withGtin += 1;
    if (meter.seenGtins.has(gtin)) {
      meter.counts.duplicateGtins += 1;
    } else {
      meter.seenGtins.add(gtin);
    }
  }
  if (hasMpn) meter.counts.withMpn += 1;
  if (normalized.brandHint !== undefined) meter.counts.withBrand += 1;
  if (normalized.media.length > 0) meter.counts.withImage += 1;
  if (normalized.price !== undefined) meter.counts.withPrice += 1;

  // The swapped-URL-columns detector (#589), over the WHOLE feed rather than
  // over a sample. It reads the mapped columns rather than what leaves the
  // adapter, which matters: `withAssessedAwinTracking` DELETES `affiliateUrl`
  // when the link is not approved, and a deep link that was rejected is still
  // evidence about which column is which. Both outcomes are counted, because a
  // zero swap count means nothing without knowing whether the conjunction's
  // second arm could ever have been false on this feed.
  const destination = assessAwinDestination({
    destination: normalized.sourceUrl,
    deepLink: normalized.affiliateUrl,
  });
  if (destination === 'tracking_host') meter.counts.destinationTrackingHost += 1;
  else if (destination === 'tracked_only') meter.counts.destinationTrackedOnly += 1;

  if (input.tracking.verdict === 'approved') {
    meter.counts.trackingApproved += 1;
  } else if (input.tracking.verdict !== 'absent') {
    // `absent` is not a REJECTION. An advertiser that publishes no deep link at
    // all has a feed Mercaria will route untracked, which is a legitimate state
    // (#62's `outbound_link` right, unchanged); counting it beside a link that
    // pointed at the wrong host would make the metric that detects the second
    // one useless on every feed that has the first.
    meter.counts.trackingRejected += 1;
  }
}

/**
 * Does this row say two different things about whether it can be bought?
 *
 * The two Awin columns that can disagree, read from the RAW record because the
 * mapping deliberately carries only one of them: `is_for_sale` is not mapped at
 * all (see `AWIN_COLUMN_ROLES`), precisely so one row cannot give #62's
 * normalizer two answers to one question.
 *
 * `stock_quantity` of zero beside `in_stock = 1` is the contradiction; the
 * REVERSE is not. A retailer that reports `in_stock = 0` with stock on the
 * shelf is withholding a sale, which is their decision and is not a data fault
 * — the same asymmetry #122 records for a `maxOrderableQuantity` of zero.
 */
function readsContradictoryAvailability(record: FeedRawRecord): boolean {
  const inStock = readColumn(record, 'in_stock');
  const forSale = readColumn(record, 'is_for_sale');
  const quantity = readColumn(record, 'stock_quantity');

  const claimsAvailable = inStock === '1' || inStock === 'true' || inStock === 'yes';
  if (claimsAvailable && quantity !== null && /^0+$/u.test(quantity)) return true;
  if (inStock === null || forSale === null) return false;

  const saleable = forSale === '1' || forSale === 'true' || forSale === 'yes';
  return claimsAvailable !== saleable;
}

function readColumn(record: FeedRawRecord, name: string): string | null {
  const value = record.fields.get(name);
  if (value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** The measurement, as the append-only row stores it. */
export function readAwinQualityCounts(meter: AwinQualityMeter): AwinQualityCounts {
  return { ...meter.counts };
}
