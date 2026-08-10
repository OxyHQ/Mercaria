/**
 * How a plan is transacted (#96 solver design rule 8, UX rules 5–7).
 *
 * PURE, and the shape is the guarantee: {@link BasketPlanActions} has ONE
 * optional native cart action and a LIST of external merchant actions, and no
 * member that could mean "check this whole thing out". A mixed plan therefore
 * cannot be rendered as one transaction, because there is no field a client
 * could read to do it.
 *
 * That absence is the answer to two separate requirements at once. Solver
 * design rule 8 asks for separate actions rather than one false checkout; UX
 * rule 7 says Mercaria must not imply it guarantees an external merchant's
 * final total. A single "buy this basket" button would violate both, and the
 * only durable way to prevent one is for the server never to describe the plan
 * in terms that admit it.
 *
 * ## The external side hands over a HOST and never a URL
 *
 * #71 made the same decision on the product page and stated why: a raw link
 * asserts at RENDER time what only a click can establish, and #68's
 * `assertOfferOutboundEligible` exists for exactly that moment. Composing a
 * tracked destination is #37's, is not built, and would be an open-redirect
 * surface if it were improvised here. So a client shows the shopper which
 * retailer they are about to visit and asks Mercaria for the destination when
 * they say yes — which is also what makes "confirm external destinations
 * individually" (UX rule 6) the natural implementation rather than an extra
 * screen.
 */

import type {
  BasketPlan,
  BasketPlanActions,
  BasketPlanLine,
} from '@mercaria/shared-types';
import type { BasketCandidate } from './candidates.js';

/**
 * Split one plan into its transactions.
 *
 * @param candidatesByOfferRef Every candidate the plan drew on, so the native
 *   variant id and the destination host are read from the offer that was
 *   actually chosen rather than looked up again — a second read is a second
 *   answer to "which variant is this line".
 */
export function composePlanActions(
  plan: BasketPlan,
  candidatesByOfferRef: ReadonlyMap<string, BasketCandidate>,
): BasketPlanActions {
  const nativeLines: { lineId: string; productVariantId: string; quantity: number }[] = [];
  for (const line of plan.lines) {
    if (line.channel !== 'native_checkout') continue;
    const candidate = candidatesByOfferRef.get(line.offerRef);
    // A native line whose candidate carries no variant id cannot become a cart
    // line. It is DROPPED from the action rather than guessed at: an "add to
    // cart" that silently adds three of four items is worse than one that adds
    // three and says so, and the plan's own line list is what says so.
    if (candidate?.productVariantId === undefined) continue;
    nativeLines.push({
      lineId: line.lineId,
      productVariantId: candidate.productVariantId,
      quantity: line.quantity,
    });
  }

  const externalByMerchant = new Map<string, BasketPlanLine[]>();
  for (const line of plan.lines) {
    if (line.channel !== 'external_merchant') continue;
    const candidate = candidatesByOfferRef.get(line.offerRef);
    const key = candidate?.merchantKey ?? line.offerRef;
    const bucket = externalByMerchant.get(key);
    if (bucket === undefined) externalByMerchant.set(key, [line]);
    else bucket.push(line);
  }

  const externalMerchants = [...externalByMerchant.keys()]
    .sort()
    .map((key) => {
      const lines = externalByMerchant.get(key) ?? [];
      const first = candidatesByOfferRef.get(lines[0].offerRef);
      return {
        ...(first?.merchantRef === undefined ? {} : { merchantRef: first.merchantRef }),
        merchantLabel: first?.merchantLabel ?? key,
        lineIds: lines.map((line) => line.lineId).sort(),
        ...(first?.destinationHost === undefined
          ? {}
          : { destinationHost: first.destinationHost }),
        offerRefs: lines.map((line) => line.offerRef).sort(),
      };
    });

  return {
    ...(nativeLines.length === 0
      ? {}
      : {
          nativeCart: {
            lines: nativeLines.sort((left, right) => left.lineId.localeCompare(right.lineId)),
          },
        }),
    externalMerchants,
  };
}
