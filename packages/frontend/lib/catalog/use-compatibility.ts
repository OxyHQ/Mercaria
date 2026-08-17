import { useQuery } from '@tanstack/react-query';
import type { AutomotiveFitmentView } from '@mercaria/shared-types';
import { fetchPartFitments } from '@/lib/api/compatibility';
import { queryKeys } from '@/lib/hooks/query-keys';
import {
  composeProductCompatibility,
  fitmentSubjects,
  type ProductCompatibility,
} from './compatibility';

/**
 * The fitment read a product page performs (#367 workstream 5).
 *
 * ## ONE query over both subjects, not one query each
 *
 * `fitmentSubjects` yields the product plus — sometimes — the one configuration in
 * view, so the number of reads is DERIVED and a hook cannot be called
 * conditionally. The two shapes that solve that are `useQueries` and one query
 * whose `queryFn` reads both; this is the second, because the composed answer IS
 * the unit worth caching (a product-level statement and a configuration-level one
 * belong in the same list) and because `useQuery` is the shape every other hook in
 * this app uses. The cost is stated: selecting a different configuration refetches
 * the product's own statements too.
 *
 * ## Half an hour, matching the attribute DEFINITIONS rather than the values
 *
 * A fitment is a manufacturer publication somebody reviewed, so it moves on the
 * timescale of a catalogue correction rather than of a shopper browsing. What
 * makes a stale one tolerable is that a withdrawal CLOSES the row rather than
 * editing it — the server filters `valid_to is null` — so a re-fetch shows the
 * statement gone rather than quietly changed.
 *
 * `retry: 1`, the house figure for a catalogue read: the panel renders nothing on
 * failure, which is what it also renders for the majority of products that have no
 * fitment at all, so this is not an answer worth a retry storm.
 */
const FITMENT_STALE_TIME = 1000 * 60 * 30;

export interface UseProductCompatibilityInput {
  readonly canonicalProductId: string | undefined;
  /** The configuration named by `?variant=`, when a shopper has chosen one. */
  readonly selectedVariantId: string | undefined;
  /** Every configuration this product has — the "only one" case needs the count. */
  readonly variantIds: readonly string[];
}

export interface ProductCompatibilityState {
  readonly compatibility: ProductCompatibility;
  readonly isLoading: boolean;
}

/** What one read of every subject produced, before it is partitioned. */
interface FitmentReadResult {
  readonly fitments: readonly AutomotiveFitmentView[];
  readonly truncated: boolean;
}

/**
 * Read and compose one product's fitment.
 *
 * **Truncation is ORed across the subjects.** If either page reached its bound the
 * combined list is a page, and reporting otherwise would tell a shopper the list
 * is complete because the other half of it happened to be short.
 *
 * A rejected subject read fails the WHOLE query rather than contributing an empty
 * list: half a fitment list is indistinguishable from a complete one, and the half
 * that goes missing is as likely to be the exclusions as the fits.
 */
export function useProductCompatibility(
  input: UseProductCompatibilityInput,
): ProductCompatibilityState {
  const subjects = fitmentSubjects({
    canonicalProductId: input.canonicalProductId,
    selectedVariantId: input.selectedVariantId,
    variantIds: input.variantIds,
  });

  const query = useQuery<FitmentReadResult>({
    queryKey: queryKeys.catalog.partFitments(
      subjects.map((subject) =>
        subject.kind === 'canonical_variant'
          ? `variant:${subject.variantId}`
          : `product:${subject.productId}`,
      ),
    ),
    enabled: subjects.length > 0,
    staleTime: FITMENT_STALE_TIME,
    retry: 1,
    queryFn: async (): Promise<FitmentReadResult> => {
      const pages = await Promise.all(subjects.map(fetchPartFitments));
      return {
        fitments: pages.flatMap((page) => page.fitments),
        truncated: pages.some((page) => page.truncated),
      };
    },
  });

  return {
    compatibility: composeProductCompatibility({
      fitments: query.data?.fitments ?? [],
      truncated: query.data?.truncated ?? false,
      readFailed: query.isError,
    }),
    isLoading: query.isLoading,
  };
}
