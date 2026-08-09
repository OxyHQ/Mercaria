/**
 * May this pass authorise retirement? (#63 processing 6 and 7, acceptance 6.)
 *
 * This is the most consequential function in the importer and it is four lines,
 * which is the point: #62 already owns the retirement rule
 * (`CATALOG_SOURCE_RETIRING_OUTCOMES` plus
 * `catalog_source_runs_retirement_check`, "only a COMPLETE enumeration may
 * retire anything"). #63 does not reimplement it, weaken it or add a second
 * one. What it does is decide whether the adapter is ALLOWED to report the
 * completed enumeration that rule reads.
 *
 * ## Three ways a pass can fail to be an enumeration, and all three are here
 *
 *  1. **A `delta` feed is NEVER an enumeration.** `FeedCompletionVerdict`'s
 *     `delta` branch has no `enumeratedFully` member at all, so "a delta feed
 *     must never expire omitted records" is a fact about the type. A reviewer
 *     looking for the `if` that enforces it will find there is none to get
 *     wrong, and a future edit that wanted to would have to widen the union
 *     first.
 *  2. **A conditional `304 Not Modified` is not an enumeration.** It is the
 *     trap conditional requests introduce: the host says "your copy is current",
 *     the pass sees zero records, and a complete enumeration of zero records
 *     retires everything the source has. The 304 path constructs a verdict with
 *     `enumeratedFully: false`.
 *  3. **A pass that stopped at a cap is not an enumeration.** A preview's
 *     sample limit, a record cap, a size cap — every one of them ends the read
 *     before the end of the feed, and `FeedStageManifest.enumeratedFully` is
 *     false for all of them. That is also why every cap in `bytes.ts` REFUSES
 *     rather than truncating: a truncation that reported completion would be
 *     this same failure wearing a success.
 */

import type { FeedCompletionVerdict, FeedDeliveryMode } from '@mercaria/shared-types';

/**
 * Build the verdict for one pass.
 *
 * The `deliveryMode` decides which branch exists; `enumeratedFully` is only
 * consulted on the snapshot side, and there is no parameter on the delta side
 * for it to be consulted through.
 */
export function feedCompletionVerdict(
  deliveryMode: FeedDeliveryMode,
  enumeratedFully: boolean,
): FeedCompletionVerdict {
  return deliveryMode === 'snapshot' ? { deliveryMode, enumeratedFully } : { deliveryMode };
}

/**
 * What `AdapterFetchPage.complete` should be — the ONE place the verdict is read.
 *
 * A `switch` on the discriminant rather than a property read, so the delta
 * branch's absence of `enumeratedFully` is enforced by the compiler at the one
 * site that could have ignored it.
 */
export function mayReportCompleteEnumeration(verdict: FeedCompletionVerdict): boolean {
  switch (verdict.deliveryMode) {
    case 'snapshot':
      return verdict.enumeratedFully;
    case 'delta':
      return false;
  }
}
