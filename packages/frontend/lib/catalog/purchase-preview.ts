/** Consumer subscriptions are not admitted commerce (commerce-type.ts).
 * This explicit development-only switch exercises the presentation with sample
 * allocations. A URL parameter can never enable it in a production build. */
const PURCHASE_PREVIEWS = ["subscription", "required", "prepaid", "introductory", "unavailable"] as const;
export type PurchasePreview = typeof PURCHASE_PREVIEWS[number];

export function resolvePurchasePreview(value: unknown, development: boolean): PurchasePreview | undefined {
  return development && typeof value === "string" && PURCHASE_PREVIEWS.some(item => item === value)
    ? value as PurchasePreview : undefined;
}
