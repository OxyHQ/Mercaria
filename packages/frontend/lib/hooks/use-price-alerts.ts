import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConditionGroup,
  CurrencyCode,
  PriceAlert,
  PriceAlertSplitResolution,
} from '@mercaria/shared-types';
import { useOxy } from '@oxyhq/services';
import {
  createPriceAlert,
  deletePriceAlert,
  fetchPriceAlerts,
  fetchPriceAlertSuggestion,
  resolvePriceAlertSplit,
  updatePriceAlert,
  type CreatePriceAlertRequest,
  type PriceAlertSuggestion,
  type UpdatePriceAlertRequest,
} from '../api/price-alerts';
import { queryKeys } from './query-keys';

/**
 * Price alerts (#79) — the buyer's own price conditions.
 *
 * ## Everything is gated on `canUsePrivateApi`, not on `isAuthenticated`
 *
 * The device-first cold boot can take seconds to restore a session and every
 * call here is user-delegated, so until it settles there is no session to make
 * the request under. Firing anyway would 401 — the gate the cart and saves hooks
 * already use.
 *
 * ## The suggestion is NOT gated, and that is deliberate
 *
 * "What is this worth today" is a question about the catalogue, and a signed-out
 * visitor looking at a product page is entitled to the answer. What they cannot
 * do is create an alert from it, which is what the create mutation's own gate
 * says. Reading it under an anonymous request also means the prefilled figure is
 * ready the moment somebody signs in rather than one round trip later.
 *
 * ## Invalidation reaches the LIST
 *
 * Creating, editing, pausing, deleting and resolving all change what the list
 * contains, and a per-alert patch would leave a page the client may not be
 * holding. One prefix key covers every read.
 */

/** Ten seconds — a personal surface that re-reads cheaply. */
const STALE_TIME = 1000 * 10;

/** A buyer's own alerts, optionally narrowed to one product. */
export function usePriceAlerts(canonicalProductId?: string) {
  const { canUsePrivateApi } = useOxy();

  return useQuery<PriceAlert[]>({
    queryKey: canonicalProductId
      ? queryKeys.priceAlerts.forProduct(canonicalProductId)
      : queryKeys.priceAlerts.all,
    enabled: canUsePrivateApi,
    staleTime: STALE_TIME,
    queryFn: () =>
      fetchPriceAlerts({ ...(canonicalProductId ? { canonicalProductId } : {}), limit: 100 }),
  });
}

/**
 * The current market for one product, in one currency (UX rules 2 and 3).
 *
 * Reads and creates NOTHING. The `suggestedTarget` it returns is the current
 * best and never a discount off it: predicting a price move is not a thing
 * Mercaria knows, and a prefilled figure a buyer did not choose is one they
 * would accept without reading.
 */
export function usePriceAlertSuggestion(input: {
  canonicalProductId: string;
  currency: CurrencyCode;
  market?: string;
  conditionGroups?: ConditionGroup[];
  enabled?: boolean;
}) {
  return useQuery<PriceAlertSuggestion>({
    queryKey: queryKeys.priceAlerts.suggestion(input.canonicalProductId, input.currency),
    enabled: input.enabled !== false && input.canonicalProductId.length > 0,
    staleTime: STALE_TIME,
    queryFn: () =>
      fetchPriceAlertSuggestion({
        canonicalProductId: input.canonicalProductId,
        currency: input.currency,
        ...(input.market ? { market: input.market } : {}),
        ...(input.conditionGroups ? { conditionGroups: input.conditionGroups } : {}),
      }),
  });
}

/** Invalidate every price-alert read — see the module docblock. */
function useInvalidateAlerts() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.priceAlerts.all });
  };
}

export function useCreatePriceAlert() {
  const invalidate = useInvalidateAlerts();
  return useMutation({
    mutationFn: (input: CreatePriceAlertRequest) => createPriceAlert(input),
    onSuccess: invalidate,
  });
}

/** Edit, PAUSE or resume — issue notification 8's one-tap pause and its undo. */
export function useUpdatePriceAlert() {
  const invalidate = useInvalidateAlerts();
  return useMutation({
    mutationFn: (input: { alertId: string; patch: UpdatePriceAlertRequest }) =>
      updatePriceAlert(input.alertId, input.patch),
    onSuccess: invalidate,
  });
}

export function useDeletePriceAlert() {
  const invalidate = useInvalidateAlerts();
  return useMutation({
    mutationFn: (alertId: string) => deletePriceAlert(alertId),
    onSuccess: invalidate,
  });
}

/** Answer a split ambiguity — which of the two products the alert meant. */
export function useResolvePriceAlertSplit() {
  const invalidate = useInvalidateAlerts();
  return useMutation({
    mutationFn: (input: { alertId: string; resolution: PriceAlertSplitResolution }) =>
      resolvePriceAlertSplit(input.alertId, input.resolution),
    onSuccess: invalidate,
  });
}
