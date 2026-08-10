/**
 * The robust statistics every #82 signal is built on — PURE, and deliberately
 * small enough to read in one sitting.
 *
 * Issue statistical policy 3 and 5 are the two rules that live here, and both
 * are places where the obvious implementation is wrong in a way nobody notices:
 *
 * - **Deduplication** — a syndicator republishing one retailer's offer under two
 *   catalogue sources produces two `offers` rows, and a naive count reports a
 *   market of two. The unit that matters is the SELLER, not the row.
 * - **Outliers** — "drop the top and bottom 5%" deletes real data and hides the
 *   very observation an operator needs to see. A median-and-MAD rule EXCLUDES an
 *   observation from a claim while naming it, which is the difference between a
 *   documented robust method and deleting inconvenient data.
 *
 * ## Every published figure names an observation
 *
 * Nothing here interpolates. The median of an even-sized sample is the LOWER of
 * the two middle values and a quantile is taken at NEAREST RANK, so every figure
 * a signal publishes is a price somebody actually charged — traceable to one
 * immutable `offer_price_snapshots` row. An interpolated median is a number no
 * seller ever asked for, and a chart that cites it can cite nothing.
 *
 * The cost is stated rather than hidden: on an even-sized sample the median sits
 * one position low, so a two-seller comparison would report the cheaper one. The
 * `PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR` is what stops that mattering.
 */

/** One value in a sample, and the identity that makes it traceable. */
export interface PriceSampleEntry {
  /** The `offer_price_snapshots` row, or the offer id for a live-offer sample. */
  readonly id: string;
  /** The offer this value came from. */
  readonly offerId: string;
  /**
   * Who is SELLING, for deduplication.
   *
   * See {@link sellerDedupKey} — never a source id, because the source is
   * precisely the thing that differs between two copies of one merchant's offer.
   */
  readonly sellerKey: string;
  /** Minor units in the subject's display currency. */
  readonly amount: number;
  readonly observedAt: Date;
}

/**
 * The identity two syndicated copies of one offer SHARE (issue statistical
 * policy 3).
 *
 * A canonical merchant id where there is one; a native listing id otherwise,
 * because a native offer is one Mercaria seller's own and cannot be syndicated.
 * `undefined` where NEITHER is known — and the caller must EXCLUDE such an
 * offer rather than give it a key of its own, because a per-offer fallback
 * inflates the distinct-seller count in exactly the direction that makes a weak
 * sample look strong.
 *
 * #62's rule makes the absent case rare rather than theoretical: a source with
 * no merchant binding produces no offers at all, so an external offer always
 * names a merchant. What reaches the fallback is a native offer with no listing,
 * which is a broken row and should not be quietly counted as a market
 * participant.
 */
export function sellerDedupKey(offer: {
  readonly merchantId?: string;
  readonly listingId?: string;
}): string | undefined {
  if (offer.merchantId !== undefined && offer.merchantId !== '') return `merchant:${offer.merchantId}`;
  if (offer.listingId !== undefined && offer.listingId !== '') return `listing:${offer.listingId}`;
  return undefined;
}

/** What deduplication kept, and how much it folded away. */
export interface DeduplicatedSample {
  readonly entries: readonly PriceSampleEntry[];
  readonly deduplicated: number;
  readonly distinctSellers: number;
  readonly distinctOffers: number;
}

/**
 * Keep ONE entry per seller — the cheapest, and deterministically so.
 *
 * The cheapest rather than the newest, because the question every signal asks is
 * "what could a buyer pay", and a seller publishing the same item through two
 * networks at two prices is offering the lower one. Ties break by `observedAt`
 * and then by id, never by array order: a uuid v7 is not monotonic within a
 * millisecond, so an id-only tiebreak would make two runs over one dataset
 * disagree (#78's own finding, one domain over).
 *
 * `distinctOffers` counts the offers BEFORE the fold, which is what makes the
 * policy's two floors independent: a market of three merchants reached through
 * nine feeds clears the offer floor honestly and the seller floor honestly, and
 * neither number can be inflated by the other.
 */
export function deduplicateBySeller(
  entries: readonly PriceSampleEntry[],
): DeduplicatedSample {
  const bySeller = new Map<string, PriceSampleEntry>();
  const offerIds = new Set<string>();

  for (const entry of entries) {
    offerIds.add(entry.offerId);
    const incumbent = bySeller.get(entry.sellerKey);
    if (incumbent === undefined) {
      bySeller.set(entry.sellerKey, entry);
      continue;
    }
    bySeller.set(entry.sellerKey, cheaperOf(incumbent, entry));
  }

  const kept = [...bySeller.values()].sort(byAmountThenTimeThenId);
  return {
    entries: kept,
    deduplicated: entries.length - kept.length,
    distinctSellers: bySeller.size,
    distinctOffers: offerIds.size,
  };
}

/** The total order every selection in this domain uses. */
function byAmountThenTimeThenId(left: PriceSampleEntry, right: PriceSampleEntry): number {
  if (left.amount !== right.amount) return left.amount - right.amount;
  const byTime = left.observedAt.getTime() - right.observedAt.getTime();
  if (byTime !== 0) return byTime;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function cheaperOf(left: PriceSampleEntry, right: PriceSampleEntry): PriceSampleEntry {
  return byAmountThenTimeThenId(left, right) <= 0 ? left : right;
}

/**
 * The LOWER median of a sorted sample, as an index.
 *
 * An index rather than a value, so every caller can name the observation behind
 * the figure it publishes. Returns `undefined` for an empty sample rather than
 * throwing: an empty sample is an ordinary state here, answered as `unmeasured`
 * one layer up, and a throw would turn a data condition into an incident.
 */
export function lowerMedianIndex(sorted: readonly PriceSampleEntry[]): number | undefined {
  if (sorted.length === 0) return undefined;
  return Math.floor((sorted.length - 1) / 2);
}

/**
 * The NEAREST-RANK quantile index, `0 < q < 1`.
 *
 * `ceil(q × n) − 1`, the standard nearest-rank definition, clamped into range.
 * No interpolation, for the module docblock's reason.
 */
export function nearestRankIndex(length: number, q: number): number | undefined {
  if (length === 0) return undefined;
  const rank = Math.ceil(q * length);
  return Math.min(Math.max(rank, 1), length) - 1;
}

/** What the robust filter kept and what it set aside. */
export interface OutlierPartition {
  readonly kept: readonly PriceSampleEntry[];
  readonly excluded: readonly PriceSampleEntry[];
}

/**
 * Partition a sample by the Iglewicz–Hoaglin modified z-score AND a relative
 * floor (issue statistical policy 5 and 6).
 *
 * `z = 0.6745 × (x − median) / MAD`, excluded when `|z| > threshold` **and**
 * `|x − median| / median > minDeviationBps`. A named, citable method with a
 * conventional constant, conjoined with a scale-aware floor.
 *
 * ## The conjunction, and why neither half works alone
 *
 * The z-score alone deletes every real discount on a TIGHT market. Measured
 * here: twelve retailers within 2% of each other give a MAD of ten minor units,
 * and a genuine half-price sale scores a modified z of 33 — so "recent low", the
 * signal that exists to report a sale, would report everything except the sale.
 *
 * The relative floor alone deletes a legitimate low on a VOLATILE market, where a
 * 90% spread between sellers is ordinary and says nothing about any one of them.
 *
 * Together they mean "far from the rest of this sample AND far enough that it
 * cannot be a promotion", which is issue statistical policy 6's distinction
 * between a sale price and a scale error. #78 reached the same place from the
 * other side with `PRICE_SCALE_SHIFT_FACTOR`: a catalogue-wide half-price sale
 * moves a price by two and a minor/major units error moves it by a hundred.
 *
 * ## The MAD-of-zero rule, which is the whole edge case
 *
 * When MAD is 0 — more than half the sample carries one identical value — every
 * other value has an infinite modified z-score, and the naive implementation
 * excludes EVERY price that is not the mode. That is not outlier handling, it is
 * deleting the variation the signal exists to measure, and it fires exactly where
 * a catalogue is healthiest: a dozen retailers all at the recommended price and
 * two below it.
 *
 * So: **when MAD is 0, nothing is an outlier.** Stated here rather than left to a
 * `Number.isFinite` check somewhere downstream, because the downstream version
 * would silently produce an empty sample and read as insufficient data.
 *
 * A sample of fewer than three entries is likewise returned whole: a median and a
 * deviation over two points describe the two points and nothing else.
 */
export function partitionOutliers(
  sorted: readonly PriceSampleEntry[],
  modifiedZThreshold: number,
  minDeviationBps: number,
): OutlierPartition {
  if (sorted.length < 3) return { kept: sorted, excluded: [] };

  const medianIndex = lowerMedianIndex(sorted);
  if (medianIndex === undefined) return { kept: sorted, excluded: [] };
  const median = sorted[medianIndex]?.amount;
  if (median === undefined) return { kept: sorted, excluded: [] };

  const deviations = sorted.map((entry) => Math.abs(entry.amount - median)).sort((a, b) => a - b);
  const madIndex = Math.floor((deviations.length - 1) / 2);
  const mad = deviations[madIndex];
  if (mad === undefined || mad === 0) return { kept: sorted, excluded: [] };

  const kept: PriceSampleEntry[] = [];
  const excluded: PriceSampleEntry[] = [];
  for (const entry of sorted) {
    const score = Math.abs((0.6745 * (entry.amount - median)) / mad);
    // A zero median cannot produce a ratio. It is unreachable through the write
    // path (`offer_price_snapshots.item_price_amount >= 0` plus every writer
    // refusing a priceless offer), and answering "not deviant enough" here is the
    // safe direction: it keeps an observation rather than deleting one.
    const deviationBps = median === 0 ? 0 : (Math.abs(entry.amount - median) / median) * 10_000;
    if (score > modifiedZThreshold && deviationBps > minDeviationBps) excluded.push(entry);
    else kept.push(entry);
  }
  return { kept, excluded };
}

/**
 * How many whole days a sample spans.
 *
 * FLOOR, so a sample gathered over 6 days and 23 hours reports 6 and fails a
 * 7-day floor. Rounding up would let a policy's minimum time coverage be cleared
 * by a sample that never reached it, which is the only direction that matters.
 */
export function coverageDays(sorted: readonly PriceSampleEntry[]): number {
  if (sorted.length === 0) return 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of sorted) {
    const at = entry.observedAt.getTime();
    if (at < earliest) earliest = at;
    if (at > latest) latest = at;
  }
  return Math.floor((latest - earliest) / (24 * 60 * 60 * 1_000));
}
