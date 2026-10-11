import type { VariantOptionValue } from '@mercaria/shared-types';

/** Exact named values, independent of display order. No case folding or title matching. */
export function sameVariantCombination(
  a: readonly VariantOptionValue[],
  b: readonly VariantOptionValue[],
): boolean {
  return (
    a.length === b.length &&
    a.every((option) =>
      b.some((other) => other.name === option.name && other.value === option.value),
    )
  );
}
