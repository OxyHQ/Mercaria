/**
 * Claiming a guest checkout group into an Oxy account (#109), client side.
 *
 * Both calls go through `apiClient`, which carries BOTH credentials the claim
 * needs: the Oxy bearer (its auth interceptor) and the portal credential (an
 * `HttpOnly` cookie on web, the `X-Mercaria-Portal-Token` header on native).
 * Neither is read, written or returned here — the two-sided proof is assembled
 * by the transport, which is why no function below takes a token, an email or
 * an account id.
 */

import type { ApiResponse, GuestClaimPreview, GuestClaimResult } from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Unwrap the API envelope, or throw the message a person should see.
 *
 * The `guest-portal.ts` helper, repeated rather than imported: these are two
 * modules that happen to share three lines, and a shared unwrapper between them
 * would be the one-use helper the house rules exclude.
 */
function unwrap<T>(body: ApiResponse<T>, fallback: string): T {
  if (!body.success || !body.data) {
    throw new Error(body.error ?? body.message ?? fallback);
  }
  return body.data;
}

/**
 * What the claim REVIEW screen shows before anybody confirms.
 *
 * A GET, and it completes nothing: the confirmation is the POST below, and
 * there is no response from this call that could attach an order to an account.
 * That is #109 UX rule 10 ("never auto-submit the claim immediately after
 * sign-in") held by the API rather than by the screen's discipline.
 */
export async function getClaimPreview(checkoutGroupId: string): Promise<GuestClaimPreview> {
  const { data } = await apiClient.get<ApiResponse<GuestClaimPreview>>(
    `/guest/orders/${checkoutGroupId}/claim`,
  );
  return unwrap(data, 'Could not read this order');
}

/**
 * Attach the group's orders to the signed-in Oxy account.
 *
 * The body is EMPTY, deliberately: everything the server needs is on the
 * request already, and a body able to carry an account id is where one would
 * eventually be trusted.
 */
export async function claimGuestOrders(checkoutGroupId: string): Promise<GuestClaimResult> {
  const { data } = await apiClient.post<ApiResponse<GuestClaimResult>>(
    `/guest/orders/${checkoutGroupId}/claim`,
    {},
  );
  return unwrap(data, 'Could not save these orders to your account');
}
