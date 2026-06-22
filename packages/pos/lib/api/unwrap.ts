import type { ApiResponse } from "@mercaria/shared-types";

/**
 * Unwrap the canonical `ApiResponse<T>` envelope, throwing on a failure body.
 *
 * Single-resource admin endpoints respond with `{ success, data }`; this asserts
 * success and returns the `data` payload (or throws with the server message so
 * the query/mutation surfaces a real error instead of `undefined`).
 */
export function unwrap<T>(body: ApiResponse<T>): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.message ?? body.error ?? "Request failed");
  }
  return body.data;
}
