import { useMutation, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import type { ApiResponse, Order } from "@mercaria/shared-types";
import {
  createDraftOrder,
  addDraftLine,
  applyDraftDiscounts,
  completeDraftOrder,
  cancelDraftOrder,
} from "../api/draft-orders";
import { queryKeys } from "../queryKeys";
import type { RegisterCartLine } from "../stores/register-cart";

/** Input the charge orchestration needs to take a sale. */
export interface ChargeSaleInput {
  /** The register/location the sale commits stock at. */
  locationId: string;
  /** Attached customer id, or null for a walk-in. */
  customerId: string | null;
  /** Discount code to apply, or null for none. */
  discountCode: string | null;
  /** The register cart lines to ring up. */
  lines: RegisterCartLine[];
}

/**
 * Extract a human-readable server message from an axios error's
 * `ApiResponse` body, falling back to the error message. Lets the UI surface a
 * real out-of-stock / pricing error instead of a generic failure.
 */
function extractServerMessage(error: unknown): string {
  if (axios.isAxiosError<ApiResponse<unknown>>(error)) {
    const body = error.response?.data;
    if (body?.message) return body.message;
    if (body?.error) return body.error;
  }
  if (error instanceof Error) return error.message;
  return "Charge failed";
}

/**
 * The POS charge orchestration. Takes the register cart and runs the full
 * draft-order sale sequence on the server:
 *   1. open a draft order (with the register location + optional customer),
 *   2. add every cart line,
 *   3. apply the discount code (when present),
 *   4. complete the draft → returns the PAID `Order`.
 *
 * If any step AFTER the draft is created fails, the open draft is cancelled
 * (best-effort cleanup — a failed cleanup is logged in dev but never masks the
 * original error) and the original error is re-thrown with the server message so
 * the UI can surface out-of-stock / pricing failures.
 */
export function useChargeSale(storeId: string) {
  const queryClient = useQueryClient();

  return useMutation<Order, Error, ChargeSaleInput>({
    mutationFn: async ({ locationId, customerId, discountCode, lines }) => {
      const draft = await createDraftOrder(storeId, {
        locationId,
        ...(customerId ? { customerId } : {}),
      });

      try {
        for (const line of lines) {
          await addDraftLine(storeId, draft.id, {
            listingId: line.listingId,
            variantId: line.variantId,
            quantity: line.quantity,
          });
        }

        if (discountCode) {
          await applyDraftDiscounts(storeId, draft.id, [discountCode]);
        }

        return await completeDraftOrder(storeId, draft.id);
      } catch (error) {
        await cancelDraftOrder(storeId, draft.id).catch((cleanupErr: unknown) => {
          if (__DEV__) {
            console.warn("useChargeSale: failed to cancel draft after error", cleanupErr);
          }
        });
        throw new Error(extractServerMessage(error));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stores", storeId, "orders"] });
    },
  });
}
