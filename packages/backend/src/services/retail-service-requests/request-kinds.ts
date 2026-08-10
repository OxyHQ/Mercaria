/**
 * What each of #127's twelve request kinds costs and produces — the TABLE the
 * rest of the domain reads instead of asking "is this a cancellation".
 *
 * `RETAIL_SERVICE_REQUEST_POLICIES` in `@mercaria/shared-types` is the data; this
 * module is the two derivations the backend needs from it, and nothing else. A
 * third derivation belongs here too rather than inline at a call site — the
 * point of the table is that adding a thirteenth kind means adding a row and
 * deciding every column, and that only holds while every consumer reads columns.
 */

import type {
  RetailServiceRequestKind,
  RetailServiceRequestPolicy,
} from '@mercaria/shared-types';
import { RETAIL_SERVICE_REQUEST_POLICIES } from '@mercaria/shared-types';
import type { BuyerRequestAction } from '../buyer-requests/authorization.js';

/** One kind's contract. */
export function retailRequestPolicy(kind: RetailServiceRequestKind): RetailServiceRequestPolicy {
  return RETAIL_SERVICE_REQUEST_POLICIES[kind];
}

/**
 * Which #110 portal action a buyer needs to file or withdraw this kind.
 *
 * The two cancellations sit behind `cancellations:request` and everything else a
 * buyer may file sits behind `returns:request`. A credential holding one cannot
 * exercise the other, which is the whole reason the mapping is a function rather
 * than one blanket scope: a portal grant is minted per what somebody asked for,
 * and #108's scope set is how that intent survives to the mutation.
 *
 * A kind a buyer may NOT file has no action at all — the return type says so,
 * and `submitRetailServiceRequest` refuses before any lookup. Answering with a
 * plausible action and refusing later would make "not customer submittable" a
 * check somebody can forget rather than a value that does not exist.
 */
export function retailRequestAction(
  kind: RetailServiceRequestKind,
  intent: 'submit' | 'withdraw',
): BuyerRequestAction | null {
  if (!RETAIL_SERVICE_REQUEST_POLICIES[kind].customerSubmittable) return null;
  const cancellation =
    kind === 'pre_acceptance_cancellation' || kind === 'pre_dispatch_cancellation';
  if (cancellation) {
    return intent === 'submit' ? 'retail_cancellation:submit' : 'retail_cancellation:withdraw';
  }
  return intent === 'submit' ? 'retail_remedy:submit' : 'retail_remedy:withdraw';
}
