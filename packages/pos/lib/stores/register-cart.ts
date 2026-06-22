import { create } from "zustand";
import type { Money } from "@mercaria/shared-types";

/**
 * A single line on the LOCAL register cart — the ephemeral cart the operator
 * builds before charging. This is NOT the buyer's storefront cart and is NOT
 * persisted: it is rebuilt from scratch for every sale and cleared after charge.
 * Each line is keyed by `variantId` (a variant appears at most once; quantity
 * carries the count). The line snapshots the catalog values needed for display
 * and to drive the draft-order build at charge time.
 */
export interface RegisterCartLine {
  /** The listing this line buys from. */
  listingId: string;
  /** The concrete variant (the line's identity key). */
  variantId: string;
  /** Listing title at the time the line was added. */
  title: string;
  /** Variant title at the time the line was added (e.g. `M / Black`). */
  variantTitle: string;
  /** Live variant price snapshotted onto the line. */
  unitPrice: Money;
  /** Quantity of this variant on the cart. */
  quantity: number;
  /** Units available for this variant (the quantity cap). */
  available: number;
  /** Variant option assignments, for display. */
  optionValues: { name: string; value: string }[];
}

interface RegisterCartState {
  /** The cart lines (ordered by insertion). */
  lines: RegisterCartLine[];
  /** Discount code attached to the sale, when one was entered. */
  discountCode: string | null;
  /** Attached store customer id, when one was selected (null = walk-in). */
  customerId: string | null;
  /**
   * Add a line. If the variant is already on the cart, increment its quantity
   * (capped at `available`); otherwise push a new line at quantity 1.
   */
  addLine: (line: Omit<RegisterCartLine, "quantity">) => void;
  /** Set a line's quantity (0 removes it; capped at `available`). */
  setQuantity: (variantId: string, quantity: number) => void;
  /** Remove a line entirely. */
  removeLine: (variantId: string) => void;
  /** Set (or clear) the attached discount code. */
  setDiscountCode: (code: string | null) => void;
  /** Set (or clear) the attached customer id. */
  setCustomerId: (id: string | null) => void;
  /** Empty the cart and clear its discount/customer attachments. */
  clear: () => void;
}

/** Smallest valid quantity for a line (anything ≤0 removes the line). */
const MIN_QUANTITY = 1;

export const useRegisterCart = create<RegisterCartState>()((set) => ({
  lines: [],
  discountCode: null,
  customerId: null,
  addLine: (line) =>
    set((state) => {
      const existing = state.lines.find((l) => l.variantId === line.variantId);
      if (existing) {
        return {
          lines: state.lines.map((l) =>
            l.variantId === line.variantId
              ? { ...l, quantity: Math.min(l.quantity + 1, l.available) }
              : l,
          ),
        };
      }
      return {
        lines: [...state.lines, { ...line, quantity: MIN_QUANTITY }],
      };
    }),
  setQuantity: (variantId, quantity) =>
    set((state) => {
      if (quantity <= 0) {
        return { lines: state.lines.filter((l) => l.variantId !== variantId) };
      }
      return {
        lines: state.lines.map((l) =>
          l.variantId === variantId
            ? { ...l, quantity: Math.min(quantity, l.available) }
            : l,
        ),
      };
    }),
  removeLine: (variantId) =>
    set((state) => ({
      lines: state.lines.filter((l) => l.variantId !== variantId),
    })),
  setDiscountCode: (code) => set({ discountCode: code }),
  setCustomerId: (id) => set({ customerId: id }),
  clear: () => set({ lines: [], discountCode: null, customerId: null }),
}));

/** Total units across every cart line (for the cart badge / count). */
export function useRegisterCartCount(): number {
  return useRegisterCart((state) =>
    state.lines.reduce((sum, line) => sum + line.quantity, 0),
  );
}
