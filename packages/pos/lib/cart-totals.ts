import type { Money, CurrencyCode } from "@mercaria/shared-types";
import type { RegisterCartLine } from "./stores/register-cart";

/** Canonical settlement currency used when the cart is empty. */
const DEFAULT_CURRENCY: CurrencyCode = "FAIR";

/**
 * Compute the register cart subtotal by summing integer minor units across every
 * line (`unitPrice.amount * quantity`). All amounts are integers (FAIR minor
 * units), so this never introduces float drift. The result's currency is taken
 * from the first line (POS sales are single-currency), defaulting to FAIR for an
 * empty cart.
 *
 * IMPORTANT: this is a DISPLAY-ONLY estimate. The authoritative totals
 * (discounts, tax, grand total) come from the draft order recomputed on the
 * server through the pricing engine.
 */
export function computeCartSubtotal(lines: RegisterCartLine[]): Money {
  const currency = lines[0]?.unitPrice.currency ?? DEFAULT_CURRENCY;
  const amount = lines.reduce(
    (sum, line) => sum + line.unitPrice.amount * line.quantity,
    0,
  );
  return { amount, currency };
}
