import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  BasketRevalidation,
  BasketSolution,
  ComparisonResult,
} from '@mercaria/shared-types';
import {
  compareProducts,
  revalidateBasketPlan,
  solveBasket,
  type CompareProductsInput,
  type SolveBasketInput,
} from '../api/comparison';
import { queryKeys } from './query-keys';

/**
 * The grounded comparison (#96) and the basket beside it.
 *
 * ## A short stale time, and a REVALIDATION before acting
 *
 * Offers move. A comparison older than a minute is a comparison of a moment
 * that has passed, and #96 UX rule 9 asks for a recalculation rather than a
 * stale plan presented as current. So the window is short, and the plan is
 * checked again through {@link useRevalidateBasketPlan} at the moment a shopper
 * adds to the cart or opens a retailer — which is the only instant at which
 * "still true" is the question being asked.
 *
 * ## Revalidation is a MUTATION, not a query
 *
 * It is a point-in-time check whose answer must never be served from a cache:
 * a cached "you may proceed" is exactly the stale plan the whole mechanism
 * exists to prevent.
 */

/** One minute. See the header. */
const COMPARISON_STALE_TIME = 1000 * 60;

/**
 * Compare two or more canonical products.
 *
 * Disabled below two subjects rather than answering an error: a comparison
 * screen renders with one product selected while the shopper picks the second,
 * and firing a request that can only 400 would put an error banner over a
 * perfectly normal state.
 */
export function useProductComparison(
  input: CompareProductsInput | undefined,
): ReturnType<typeof useQuery<ComparisonResult>> {
  const enabled = input !== undefined && input.subjects.length >= 2;
  return useQuery<ComparisonResult>({
    // Named fields rather than the object, so a field added to the request
    // without being added here fails `tsc` instead of quietly sharing a cache
    // entry with the request that lacks it.
    queryKey: queryKeys.comparison.compare({
      subjects: input?.subjects
        .map((subject) => `${subject.handle}:${subject.canonicalVariantId ?? ''}`)
        .join(','),
      currency: input?.currency,
      market: input?.market,
      conditions: input?.conditionGroups?.join(','),
      categoryId: input?.categoryId,
      constraints: input?.constraints?.map((constraint) => constraint.id).join(','),
    }),
    queryFn: () => compareProducts(input as CompareProductsInput),
    enabled,
    staleTime: COMPARISON_STALE_TIME,
    retry: false,
  });
}

/**
 * Solve a basket.
 *
 * A QUERY rather than a mutation because it changes nothing and a shopper
 * editing an objective expects the previous answer to stay on screen while the
 * next one loads. `retry: false` for the product-page reason: a 400 naming an
 * unsolvable request does not become solvable on a second attempt.
 */
export function useBasketSolution(
  input: SolveBasketInput | undefined,
): ReturnType<typeof useQuery<BasketSolution>> {
  const enabled =
    input !== undefined &&
    ((input.lines !== undefined && input.lines.length > 0) || input.watchlistId !== undefined);
  return useQuery<BasketSolution>({
    queryKey: queryKeys.comparison.basket({
      lines: input?.lines
        ?.map((line) => `${line.canonicalProductId}:${String(line.quantity)}`)
        .join(','),
      watchlistId: input?.watchlistId,
      currency: input?.currency,
      market: input?.market,
      channelPolicy: input?.channelPolicy,
      conditions: input?.conditionGroups?.join(','),
      objectives: input?.objectives?.join(','),
      maxMerchants: input?.maxMerchants,
      excluded: input?.excludedMerchantIds?.join(','),
      pickup: input?.pickup === undefined ? undefined : 'requested',
    }),
    queryFn: () => solveBasket(input as SolveBasketInput),
    enabled,
    staleTime: COMPARISON_STALE_TIME,
    retry: false,
  });
}

/**
 * Re-check a plan immediately before acting on it (#96 solver design rule 7).
 *
 * A mutation, and never cached. The caller awaits it and proceeds only when
 * `mayProceed` is true — a price that moved DOWN blocks too, because the plan's
 * totals no longer describe what the shopper would pay and a cheaper basket is
 * still a different basket.
 */
export function useRevalidateBasketPlan(): ReturnType<
  typeof useMutation<BasketRevalidation, Error, Parameters<typeof revalidateBasketPlan>[0]>
> {
  return useMutation<BasketRevalidation, Error, Parameters<typeof revalidateBasketPlan>[0]>({
    mutationFn: revalidateBasketPlan,
    retry: false,
  });
}
