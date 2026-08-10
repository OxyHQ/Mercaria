import type {
  ApiResponse,
  BasketChannelPolicy,
  BasketObjective,
  BasketPlan,
  BasketRequestLine,
  BasketRevalidation,
  BasketInputSnapshot,
  BasketSolution,
  ComparisonRecordRef,
  ComparisonResult,
  ConditionGroup,
  CurrencyCode,
  ProductConstraint,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * The grounded comparison and basket API client (#96).
 *
 * All three calls are POSTs, because a comparison carries a constraint SET and a
 * basket carries a line list — structured values a query string can only encode
 * by inventing a second grammar for the one #94 already defines. They are still
 * reads: nothing here writes a row, and the domain owns no table.
 *
 * ## Nothing is cached across a navigation, deliberately
 *
 * A basket plan is a statement about a moment, and #96 UX rule 9 forbids
 * presenting a stale plan as current. So the hooks around this client keep a
 * short stale time and the plan is REVALIDATED before the shopper acts on it —
 * the snapshot goes back to the server and the answer says what moved.
 */

export interface CompareProductsInput {
  subjects: readonly { handle: string; canonicalVariantId?: string }[];
  currency?: CurrencyCode;
  market?: string;
  conditionGroups?: readonly ConditionGroup[];
  /** Scopes #94's validation, so an off-category requirement is refused. */
  categoryId?: string;
  constraints?: readonly ProductConstraint[];
}

/** Compare two to eight canonical products. */
export async function compareProducts(input: CompareProductsInput): Promise<ComparisonResult> {
  const { data } = await apiClient.post<ApiResponse<ComparisonResult>>('/comparison', input);
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to compare products');
  }
  return data.data;
}

export interface SolveBasketInput {
  lines?: readonly BasketRequestLine[];
  /** Solve the caller's own #81 watchlist. Needs a signed-in account. */
  watchlistId?: string;
  currency?: CurrencyCode;
  market?: string;
  channelPolicy?: BasketChannelPolicy;
  /** The DEFAULT every line without its own accepts. #95 produces exactly one. */
  conditionGroups?: readonly ConditionGroup[];
  objectives?: readonly BasketObjective[];
  maxMerchants?: number;
  excludedMerchantIds?: readonly string[];
  /** #93's seam: a bare request, with no coordinates and no radius. */
  pickup?: true;
}

/** Solve a basket over current eligible offers. */
export async function solveBasket(input: SolveBasketInput): Promise<BasketSolution> {
  const { data } = await apiClient.post<ApiResponse<BasketSolution>>('/comparison/basket', input);
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to solve basket');
  }
  return data.data;
}

/**
 * Re-check a plan before navigating out or adding to the cart.
 *
 * The client hands back the snapshot, the plan and the record table it was
 * given. Nothing is looked up from a store because nothing was stored — a plan
 * served from a table would be the stale plan UX rule 9 forbids.
 */
export async function revalidateBasketPlan(input: {
  snapshot: BasketInputSnapshot;
  plan: BasketPlan;
  records: readonly ComparisonRecordRef[];
}): Promise<BasketRevalidation> {
  const { data } = await apiClient.post<ApiResponse<BasketRevalidation>>(
    '/comparison/basket/revalidate',
    input,
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to revalidate the plan');
  }
  return data.data;
}
