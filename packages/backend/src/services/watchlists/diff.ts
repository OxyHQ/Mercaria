/**
 * Which items drove a change between two recorded evaluations (#81 basket
 * rule 4). PURE.
 *
 * ## The diff REFUSES more often than it explains, and that is the design
 *
 * A movement is attributable to items only when everything else about the two
 * evaluations is the same. Three axes can make it incomparable and each one is
 * refused BY NAME:
 *
 *  - a different display currency — the amounts are not in the same units;
 *  - a different basis — one total counts delivery and the other does not, so
 *    their difference is not a price movement at all;
 *  - a different #74 policy version — a policy can select a different offer at
 *    unchanged prices, so a total that moved across one moved because Mercaria
 *    changed its mind about which offer to show, and blaming the item for that
 *    is the one thing "explain which items drove a change" must not do.
 *
 * Refusing is cheap and being wrong is not: a client shown "this item went up
 * €40" acts on it, and the seller of that item did nothing.
 *
 * ## It is DERIVED and never stored
 *
 * Both snapshots are already append-only and complete, so an explanation stored
 * beside them is a second representation of a fact the rows carry — one that can
 * disagree the first time somebody improves the derivation. `analytics_rollups`
 * stores numbers because recomputing them is expensive; this is one pass over
 * two bounded lists.
 */

import type {
  CurrencyCode,
  WatchlistBasketBasis,
  WatchlistSnapshotDiff,
  WatchlistSnapshotItemDelta,
} from '@mercaria/shared-types';

/** One side of a diff: a snapshot header plus its lines. */
export interface DiffSide {
  readonly snapshotId: string;
  readonly displayCurrency: CurrencyCode;
  readonly basis: WatchlistBasketBasis | null;
  readonly totalAmount: number | null;
  readonly rankingPolicyVersions: readonly string[];
  readonly lines: readonly DiffLine[];
}

/** One line of either side. */
export interface DiffLine {
  readonly watchlistItemId: string | null;
  readonly canonicalProductId: string;
  readonly state: string;
  readonly quantity: number;
  readonly selectedOfferId: string | null;
  readonly unitItemPriceAmount: number | null;
  readonly lineItemPriceAmount: number | null;
}

/** Which item deltas, largest absolute movement first. */
function byMagnitude(
  left: WatchlistSnapshotItemDelta,
  right: WatchlistSnapshotItemDelta,
): number {
  return Math.abs(right.deltaMinor ?? 0) - Math.abs(left.deltaMinor ?? 0);
}

/**
 * Compare two recorded evaluations of one list.
 *
 * `baseline` is the OLDER side. The deltas are computed on the LINE total, not
 * the unit price, because that is what moved the basket — a buyer who doubled a
 * quantity moved their total by a unit price they never saw change, and the
 * unit prices travel beside the delta so both readings are available.
 */
export function diffWatchlistSnapshots(
  baseline: DiffSide,
  current: DiffSide,
): WatchlistSnapshotDiff {
  if (baseline.displayCurrency !== current.displayCurrency) {
    return { comparable: false, reason: 'currency_changed' };
  }
  if (baseline.basis !== current.basis || current.basis === null) {
    return { comparable: false, reason: 'basis_changed' };
  }
  const baselineVersions = [...baseline.rankingPolicyVersions].sort().join(',');
  const currentVersions = [...current.rankingPolicyVersions].sort().join(',');
  if (baselineVersions !== currentVersions) {
    return { comparable: false, reason: 'policy_version_changed' };
  }

  const before = new Map<string, DiffLine>();
  for (const line of baseline.lines) {
    if (line.watchlistItemId !== null) before.set(line.watchlistItemId, line);
  }
  const items: WatchlistSnapshotItemDelta[] = [];

  for (const line of current.lines) {
    const itemId = line.watchlistItemId;
    if (itemId === null) continue;
    const previous = before.get(itemId);

    if (previous === undefined) {
      items.push({
        itemId,
        canonicalProductId: line.canonicalProductId,
        kind: 'added',
        ...(line.lineItemPriceAmount === null ? {} : { deltaMinor: line.lineItemPriceAmount }),
        ...(line.unitItemPriceAmount === null
          ? {}
          : { currentUnitPriceMinor: line.unitItemPriceAmount }),
      });
      continue;
    }
    before.delete(itemId);

    if (previous.state !== line.state) {
      items.push({
        itemId,
        canonicalProductId: line.canonicalProductId,
        kind: line.state === 'priced' ? 'became_priced' : 'became_unresolved',
        ...(previous.unitItemPriceAmount === null
          ? {}
          : { previousUnitPriceMinor: previous.unitItemPriceAmount }),
        ...(line.unitItemPriceAmount === null
          ? {}
          : { currentUnitPriceMinor: line.unitItemPriceAmount }),
      });
      continue;
    }
    if (line.state !== 'priced') continue;

    const delta = (line.lineItemPriceAmount ?? 0) - (previous.lineItemPriceAmount ?? 0);
    const quantityChanged = previous.quantity !== line.quantity;
    const priceMoved = previous.unitItemPriceAmount !== line.unitItemPriceAmount;
    const offerChanged = previous.selectedOfferId !== line.selectedOfferId;

    // A quantity change is reported as one even when the price also moved: the
    // buyer changed the quantity, and attributing their own edit to the market
    // would be the same misattribution the policy refusal above exists for.
    if (!quantityChanged && !priceMoved && !offerChanged) continue;
    items.push({
      itemId,
      canonicalProductId: line.canonicalProductId,
      kind: quantityChanged ? 'quantity_changed' : priceMoved ? 'price_moved' : 'offer_changed',
      deltaMinor: delta,
      ...(previous.unitItemPriceAmount === null
        ? {}
        : { previousUnitPriceMinor: previous.unitItemPriceAmount }),
      ...(line.unitItemPriceAmount === null
        ? {}
        : { currentUnitPriceMinor: line.unitItemPriceAmount }),
    });
  }

  for (const [itemId, previous] of before) {
    items.push({
      itemId,
      canonicalProductId: previous.canonicalProductId,
      kind: 'removed',
      ...(previous.lineItemPriceAmount === null
        ? {}
        : { deltaMinor: -previous.lineItemPriceAmount }),
      ...(previous.unitItemPriceAmount === null
        ? {}
        : { previousUnitPriceMinor: previous.unitItemPriceAmount }),
    });
  }

  return {
    comparable: true,
    baselineSnapshotId: baseline.snapshotId,
    currentSnapshotId: current.snapshotId,
    basis: current.basis,
    currency: current.displayCurrency,
    ...(baseline.totalAmount === null || current.totalAmount === null
      ? {}
      : { totalDeltaMinor: current.totalAmount - baseline.totalAmount }),
    items: items.sort(byMagnitude),
  };
}
