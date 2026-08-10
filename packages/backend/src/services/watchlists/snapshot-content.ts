/**
 * What makes one recorded evaluation DIFFERENT from the one before it (#81
 * snapshot rules 4 and 6, and the deduplication policy).
 *
 * PURE. Two functions and one shape:
 *
 *  - {@link watchlistContentDigest} answers "is this the same evaluation" in one
 *    comparable value, so an unchanged basket writes no row;
 *  - {@link deriveMaterialChanges} answers "then what changed", as a set of
 *    named kinds rather than a sentence.
 *
 * ## Why the digest covers the LINES and not only the total
 *
 * Two items moving by equal and opposite amounts leave the total exactly where
 * it was. A digest over the total alone would call that "unchanged" and record
 * nothing — and the history a buyer opens next month would show one flat line
 * through the week both their prices moved. The digest is over the whole
 * evaluation for the same reason the snapshot stores the whole evaluation: the
 * question a list answers is per item, and the total is a summary of it.
 *
 * ## Why the kinds are a SET
 *
 * A change is rarely one thing — adding an item usually moves the total and can
 * change the basis in the same breath — and a single "primary reason" would be a
 * precedence rule somebody has to remember, applied to a fact that has no
 * precedence. `watchlist_snapshots_material_changes_check` requires at least one
 * (`cardinality(...) >= 1`, never `array_length`, which is NULL on an empty
 * array and would admit exactly the row it refuses), and
 * {@link deriveMaterialChanges} can only return an empty set for two identical
 * evaluations — which are deduplicated and never stored.
 */

import { createHash } from 'node:crypto';
import {
  hasKnownBasketTotal,
  type WatchlistBasket,
  type WatchlistSnapshotChangeKind,
} from '@mercaria/shared-types';

/** The prior snapshot, reduced to what a comparison needs. */
export interface PriorSnapshotSummary {
  readonly displayCurrency: string;
  readonly market: string | null;
  readonly basis: string | null;
  readonly completeness: string;
  readonly totalAmount: number | null;
  readonly rankingPolicyVersions: readonly string[];
  readonly lines: readonly PriorSnapshotLineSummary[];
}

/** One prior line, reduced the same way. */
export interface PriorSnapshotLineSummary {
  readonly watchlistItemId: string | null;
  readonly state: string;
  readonly quantity: number;
  readonly selectedOfferId: string | null;
  readonly unitItemPriceAmount: number | null;
}

/**
 * A stable, comparable summary of one evaluation.
 *
 * The serialization is EXPLICIT and ordered rather than `JSON.stringify` over a
 * whole DTO: a digest that changed when an unrelated field was added to the
 * response would deduplicate nothing on the deploy that added it, and every
 * buyer's history would grow a spurious row on the same day. Only the facts a
 * basket IS are in it.
 */
export function watchlistContentDigest(basket: WatchlistBasket): string {
  const header = [
    basket.listVersion,
    basket.displayCurrency,
    basket.market ?? '',
    hasKnownBasketTotal(basket.total) ? basket.total.basis : '',
    hasKnownBasketTotal(basket.total) ? basket.total.completeness : 'unknown',
    hasKnownBasketTotal(basket.total) ? basket.total.amount.amount : '',
    [...basket.rankingPolicyVersions].sort().join(','),
  ].join('|');

  const lines = basket.lines.map((line) => {
    if (line.evaluation.state === 'unresolved') {
      return [line.item.id, line.item.quantity, 'unresolved', line.evaluation.reason].join(':');
    }
    const selection = line.evaluation.selection;
    return [
      line.item.id,
      line.item.quantity,
      'priced',
      selection.offerId,
      selection.unitItemPrice.amount,
      selection.delivery.known ? selection.delivery.unit.amount : 'unknown',
    ].join(':');
  });

  return createHash('sha256').update(`${header}\n${lines.join('\n')}`).digest('hex');
}

/**
 * Which named changes this evaluation carries against its predecessor.
 *
 * Every kind is computed independently and all that apply are returned. The one
 * worth reading is `policy_version_changed`: a different #74 policy can select a
 * different offer at unchanged prices, so a total that moved across one is NOT
 * attributable to the items — the diff refuses to attribute it, and this is
 * where that refusal's evidence is recorded.
 */
export function deriveMaterialChanges(
  basket: WatchlistBasket,
  prior: PriorSnapshotSummary | undefined,
): WatchlistSnapshotChangeKind[] {
  if (prior === undefined) return ['first_snapshot'];

  const kinds = new Set<WatchlistSnapshotChangeKind>();

  if (prior.displayCurrency !== basket.displayCurrency) kinds.add('currency_changed');

  const priorVersions = [...prior.rankingPolicyVersions].sort().join(',');
  const currentVersions = [...basket.rankingPolicyVersions].sort().join(',');
  if (priorVersions !== currentVersions) kinds.add('policy_version_changed');

  const currentBasis = hasKnownBasketTotal(basket.total) ? basket.total.basis : null;
  if (prior.basis !== currentBasis) kinds.add('basis_changed');

  const currentCompleteness = hasKnownBasketTotal(basket.total)
    ? basket.total.completeness
    : 'unknown';
  if (prior.completeness !== currentCompleteness) kinds.add('completeness_changed');

  const currentTotal = hasKnownBasketTotal(basket.total) ? basket.total.amount.amount : null;
  if (prior.totalAmount !== null && currentTotal !== null && prior.totalAmount !== currentTotal) {
    kinds.add(currentTotal < prior.totalAmount ? 'total_decreased' : 'total_increased');
  }

  const priorByItem = new Map<string, PriorSnapshotLineSummary>();
  for (const line of prior.lines) {
    if (line.watchlistItemId !== null) priorByItem.set(line.watchlistItemId, line);
  }
  const currentIds = new Set(basket.lines.map((line) => line.item.id));

  // Membership covers both directions AND a quantity change: a list holding the
  // same products in different amounts is a different basket, and a buyer who
  // doubled a quantity is owed a history that says so rather than a total that
  // moved for no stated reason.
  if (priorByItem.size !== currentIds.size) kinds.add('membership_changed');
  for (const id of currentIds) if (!priorByItem.has(id)) kinds.add('membership_changed');
  for (const id of priorByItem.keys()) if (!currentIds.has(id)) kinds.add('membership_changed');

  for (const line of basket.lines) {
    const before = priorByItem.get(line.item.id);
    if (before === undefined) continue;
    if (before.quantity !== line.item.quantity) kinds.add('membership_changed');

    const state = line.evaluation.state;
    if (before.state !== state) {
      kinds.add('availability_changed');
      continue;
    }
    if (state !== 'priced') continue;

    const selection = line.evaluation.selection;
    if (before.selectedOfferId !== selection.offerId) kinds.add('selection_changed');
    if (
      before.unitItemPriceAmount !== null &&
      before.unitItemPriceAmount !== selection.unitItemPrice.amount
    ) {
      kinds.add('item_price_moved');
    }
  }

  return [...kinds];
}
