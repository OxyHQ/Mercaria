/** Exact non-negative PostgreSQL integer quantity. Never truncate or coerce invalid input to zero. */
export function parseInventoryQuantity(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const quantity = Number(text);
  return Number.isSafeInteger(quantity) && quantity <= 2_147_483_647 ? quantity : null;
}
