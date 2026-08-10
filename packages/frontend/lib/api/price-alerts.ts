import type {
  ApiResponse,
  ConditionGroup,
  CurrencyCode,
  Money,
  PriceAlert,
  PriceAlertComparisonBasis,
  PriceAlertRepeatPolicy,
  PriceAlertSellerScope,
  PriceAlertSplitResolution,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Price alerts API client (#79).
 *
 * ## The suggestion is a GET and creates NOTHING
 *
 * `fetchPriceAlertSuggestion` answers "what is this worth today" so a client can
 * PREFILL a target. #79 UX rule 2 asks for exactly that and no more — the buyer
 * still presses create — and the honest form of that promise is a read verb.
 *
 * ## Nothing here sends a currency the server did not offer
 *
 * A target names its own currency and the server compares against offers
 * converted into it; the client never converts anything itself. A figure this
 * app computed and sent as a target would be a second FX authority, and the one
 * that a buyer's alert was actually judged against would be the server's.
 */

/** Unwrap the Mercaria envelope, or throw with whatever the server said. */
function unwrap<T>(body: ApiResponse<T>, fallback: string): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.error ?? body.message ?? fallback);
  }
  return body.data;
}

export interface CreatePriceAlertRequest {
  canonicalProductId: string;
  canonicalVariantId?: string;
  target: Money;
  basis: PriceAlertComparisonBasis;
  conditionGroups?: ConditionGroup[];
  market?: string;
  sellerScope?: PriceAlertSellerScope;
  repeatPolicy?: PriceAlertRepeatPolicy;
  resetThreshold?: Money;
  cooldownSeconds?: number;
  quietHours?: { startMinute: number; endMinute: number; timeZone: string };
  locale?: string;
  emailOptIn?: boolean;
}

export async function createPriceAlert(input: CreatePriceAlertRequest): Promise<PriceAlert> {
  const { data } = await apiClient.post<ApiResponse<{ alert: PriceAlert }>>(
    '/price-alerts',
    input,
  );
  return unwrap(data, 'Failed to create that price alert').alert;
}

export async function fetchPriceAlerts(params: {
  canonicalProductId?: string;
  limit?: number;
}): Promise<PriceAlert[]> {
  const { data } = await apiClient.get<ApiResponse<{ alerts: PriceAlert[] }>>('/price-alerts', {
    params,
  });
  return unwrap(data, 'Failed to load your price alerts').alerts;
}

export interface UpdatePriceAlertRequest {
  target?: Money;
  basis?: PriceAlertComparisonBasis;
  conditionGroups?: ConditionGroup[];
  sellerScope?: PriceAlertSellerScope;
  repeatPolicy?: PriceAlertRepeatPolicy;
  resetThreshold?: Money | null;
  cooldownSeconds?: number | null;
  quietHours?: { startMinute: number; endMinute: number; timeZone: string } | null;
  emailOptIn?: boolean;
  /** The two a BUYER decides. `triggered` and `deleted` are the server's. */
  state?: 'enabled' | 'paused';
}

export async function updatePriceAlert(
  alertId: string,
  patch: UpdatePriceAlertRequest,
): Promise<PriceAlert> {
  const { data } = await apiClient.patch<ApiResponse<{ alert: PriceAlert }>>(
    `/price-alerts/${alertId}`,
    patch,
  );
  return unwrap(data, 'Failed to update that price alert').alert;
}

export async function deletePriceAlert(alertId: string): Promise<void> {
  const { data } = await apiClient.delete<ApiResponse<{ deleted: boolean }>>(
    `/price-alerts/${alertId}`,
  );
  unwrap(data, 'Failed to delete that price alert');
}

export async function resolvePriceAlertSplit(
  alertId: string,
  resolution: PriceAlertSplitResolution,
): Promise<PriceAlert> {
  const { data } = await apiClient.post<ApiResponse<{ alert: PriceAlert }>>(
    `/price-alerts/${alertId}/resolve-split`,
    { resolution },
  );
  return unwrap(data, 'Failed to resolve that price alert').alert;
}

/** What the market looks like right now, so a buyer can pick a target (UX 2, 3). */
export interface PriceAlertSuggestion {
  canonicalProductId: string;
  currency: CurrencyCode;
  bestItemPrice?: Money;
  bestKnownTotal?: Money;
  eligibleOfferCount: number;
  suggestedTarget?: Money;
}

export async function fetchPriceAlertSuggestion(params: {
  canonicalProductId: string;
  currency: CurrencyCode;
  market?: string;
  conditionGroups?: ConditionGroup[];
}): Promise<PriceAlertSuggestion> {
  const { data } = await apiClient.get<ApiResponse<{ suggestion: PriceAlertSuggestion }>>(
    '/price-alerts/suggestion',
    { params },
  );
  return unwrap(data, 'Failed to read the current price for that product').suggestion;
}
