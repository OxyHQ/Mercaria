import type { ProductVariantDTO } from "@mercaria/shared-types";

/** A deep link may deliberately name a sold-out variant. Never replace it with
 * another purchasable configuration; fall back only for an unknown/missing id. */
export function resolveListingVariant(
  variants: readonly ProductVariantDTO[],
  requestedId?: string,
): ProductVariantDTO | undefined {
  return (
    variants.find((variant) => variant.id === requestedId) ??
    variants.find((variant) => variant.inStock) ??
    variants[0]
  );
}

/** Choose an existing configuration, preserving the other choices wherever
 * possible. Sparse option matrices must not strand the buyer on an invented
 * combination. Stock breaks ties, but never overrides an exact combination. */
export function chooseListingVariant(
  variants: readonly ProductVariantDTO[],
  current: ProductVariantDTO | undefined,
  optionName: string,
  value: string,
): ProductVariantDTO | undefined {
  const candidates = variants.filter((variant) =>
    variant.optionValues.some(
      (option) => option.name === optionName && option.value === value,
    ),
  );
  const score = (variant: ProductVariantDTO) =>
    variant.optionValues.reduce(
      (matches, option) =>
        matches +
        Number(
          option.name !== optionName &&
            current?.optionValues.some(
              (selected) =>
                selected.name === option.name &&
                selected.value === option.value,
            ),
        ),
      0,
    );
  return candidates.sort(
    (a, b) => score(b) - score(a) || Number(b.inStock) - Number(a.inStock),
  )[0];
}
