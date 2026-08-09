/**
 * The guest order portal's API calls (#108).
 *
 * Every request here goes through `apiClient`, which carries the portal
 * credential in a cookie (web, `withCredentials`) or the
 * `X-Mercaria-Portal-Token` header (native). Nothing in this module reads,
 * writes or returns a token: the exchange hands one to the interceptor via a
 * RESPONSE HEADER and the caller never sees it.
 */

import type {
  ApiResponse,
  GuestOrderPortalView,
  GuestOrderStatusView,
  GuestPortalSessionState,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Unwrap the API envelope, or throw the message a person should see.
 *
 * `apiClient.get<ApiResponse<T>>` types `data` as optional because a failure
 * envelope carries none — the `lib/api/checkout.ts` shape, in one helper here
 * because six calls would otherwise repeat the same three lines.
 */
function unwrap<T>(body: ApiResponse<T>, fallback: string): T {
  if (!body.success || !body.data) {
    throw new Error(body.error ?? body.message ?? fallback);
  }
  return body.data;
}

/**
 * Exchange a magic-link token for a portal session.
 *
 * The token goes in the BODY and never in a query string: a query string
 * reaches access logs, proxy logs and `Referer` headers, which is the whole
 * reason the server puts it in the URL fragment in the first place.
 */
export async function exchangePortalToken(token: string): Promise<GuestPortalSessionState> {
  const { data } = await apiClient.post<ApiResponse<GuestPortalSessionState>>(
    '/guest/orders/exchange',
    { token },
  );
  return unwrap(data, 'Access link is not valid');
}

/**
 * Mint the bounded confirmation session for the device that just paid.
 *
 * Authorized by the GUEST CART credential the interceptor already carries — the
 * only call in this module that is — and it produces a different, narrower
 * credential scoped to the one group that session placed.
 */
export async function createPortalConfirmation(
  checkoutGroupId: string,
): Promise<GuestPortalSessionState> {
  const { data } = await apiClient.post<ApiResponse<GuestPortalSessionState>>(
    '/guest/orders/confirmation',
    { checkoutGroupId },
  );
  return unwrap(data, 'Could not open this order');
}

/** What the presented credential is and what it may do. */
export async function getPortalSession(): Promise<GuestPortalSessionState> {
  const { data } = await apiClient.get<ApiResponse<GuestPortalSessionState>>(
    '/guest/orders/session',
  );
  return unwrap(data, 'Portal access is not valid');
}

/** The full portal view. Needs `orders:read`, which needs a proven inbox. */
export async function getPortalView(checkoutGroupId: string): Promise<GuestOrderPortalView> {
  const { data } = await apiClient.get<ApiResponse<GuestOrderPortalView>>(
    `/guest/orders/${checkoutGroupId}`,
  );
  return unwrap(data, 'Could not read this order');
}

/** The bounded confirmation view a `tracking:read` session may see. */
export async function getPortalStatus(checkoutGroupId: string): Promise<GuestOrderStatusView> {
  const { data } = await apiClient.get<ApiResponse<GuestOrderStatusView>>(
    `/guest/orders/${checkoutGroupId}/status`,
  );
  return unwrap(data, 'Could not read this order');
}

/**
 * Ask for an access link. ALWAYS resolves with the same message — see the
 * server's own reasoning; there is nothing here to branch on and deliberately
 * no boolean to return.
 */
export async function requestPortalRecovery(input: {
  email: string;
  orderNumber?: string;
}): Promise<string> {
  const { data } = await apiClient.post<ApiResponse<{ message: string }>>(
    '/guest/orders/recover',
    input,
  );
  return unwrap(data, 'Could not send an access link').message;
}

/** Sign this credential out. Always succeeds. */
export async function signOutOfPortal(): Promise<void> {
  await apiClient.delete('/guest/orders/session');
}
