/**
 * Why an ordering that cannot be shown total from the schema alone is allowed to
 * stay that way.
 *
 * The gate is `catalog-read-ordering.test.ts`; this is the hand-maintained half
 * it checks the measurement against. An ordering that is neither total by
 * COVERAGE nor named here FAILS THE BUILD — `~/Oxy/AGENTS.md`: a gate that skips
 * what a hand-maintained map omits is not a gate. `ROUTE_DISPOSITIONS`
 * (`__tests__/route-reachability/dispositions.ts`) and `merge-plan.ts`'s
 * `untouched` WITH A REASON are the worked precedents: a decision is accepted,
 * silence is not.
 *
 * ## There is exactly ONE kind here, and that is deliberate
 *
 * `ROUTE_DISPOSITIONS` needs two kinds because "unreachable by design" and "a
 * real gap nobody has decided about" are different states with different owners.
 * An ordering has no such second state. Either the statement itself pins the
 * remaining columns of a unique — in which case it IS total over the rows it can
 * return, and the gate simply cannot see the pin — or the ordering can tie, and
 * the answer is a tie-break, not an excuse. There is no "we know this can tie
 * and we accept it": that is the defect the gate exists to find.
 *
 * So the one kind is `pinned_by_equality`, and it carries the columns that do
 * the pinning as DATA rather than as prose. A reader can then check the claim
 * against the statement's own `WHERE` without taking anybody's word for it, and
 * an entry whose named columns stop being pinned is a visible edit.
 *
 * ## Why not simply add the columns to the ORDER BY
 *
 * Because for a column pinned to a single value by equality it is noise: it can
 * only ever compare equal, so it changes no order and states nothing a reader
 * needs. Where the pinned column varies across the result set — a read spanning
 * several parents, say — the honest fix IS to put it in the ordering, and that
 * is what `listNavigationNodes` and `listNavigationSavedQueryAttributes` do.
 * Those two are not in this list precisely because that fix was available.
 */

/** An ordering that is total over its result set for a reason the schema cannot show. */
export interface OrderingDisposition {
  readonly kind: 'pinned_by_equality';
  /**
   * The unique whose remaining columns the statement pins, by NAME, so a reader
   * can find it in the schema rather than reconstructing which one is meant.
   */
  readonly completedUnique: string;
  /**
   * The columns pinned to a single value by this statement's own `WHERE`.
   *
   * Data rather than prose so the claim is checkable: read the statement, and
   * every column named here must appear in an `eq(...)` in its conditions.
   */
  readonly pinnedByEquality: readonly string[];
  /** Why that pin holds, and what would break it. */
  readonly reason: string;
}

/** The key the gate reports a site under: `<repo-relative file>#<function>`. */
export function orderingDispositionKey(relativeFile: string, enclosing: string): string {
  return `${relativeFile}#${enclosing}`;
}

export const ORDERING_DISPOSITIONS: Readonly<Record<string, OrderingDisposition>> = {
  'db/navigation/navigationRepository.ts#findLiveNavigationTrees': {
    kind: 'pinned_by_equality',
    completedUnique: 'navigation_trees_key_version_key (key, market, locale, version)',
    pinnedByEquality: ['market', 'locale'],
    reason:
      'The ordering is `(surface, key, version)`. The unique it needs is ' +
      '`(key, market, locale, version)`, and the two columns missing from the ordering — ' +
      '`market` and `locale` — are pinned to a single value each by this statement’s own ' +
      'first two conditions, `eq(navigationTrees.market, params.market)` and ' +
      '`eq(navigationTrees.locale, params.locale)`. Every row this read can return therefore ' +
      'agrees on both, so `(key, version)` alone separates them and the order is total over ' +
      'the result set. Adding `market` and `locale` to the ORDER BY would be noise: they are ' +
      'constant, so they can only ever compare equal. ' +
      'What would break it is widening this read to span markets or locales — a `market IN ' +
      '(...)`, or dropping the locale condition for a fallback — at which point two trees ' +
      'could share `(surface, key, version)` and the fix is to lead the ordering with the ' +
      'columns that stopped being pinned, exactly as `listNavigationNodes` leads with ' +
      '`treeId`. Note `version` is in the ordering because it is NOT pinned: nothing in the ' +
      'schema stops two published versions of one tree being live at once, and the payload ' +
      'this composes is hashed into an ETag, so a tie there would flip the validator.',
  },
};
