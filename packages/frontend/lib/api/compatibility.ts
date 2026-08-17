import type {
  ApiResponse,
  CompatibilitySubject,
  PartFitmentsView,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * The PUBLIC compatibility read (#367 step 8, ADR 0007 D8).
 *
 * `GET /compatibility/fitments` answers "which vehicles is this part stated to
 * fit", and the answer INCLUDES the ones it is stated NOT to fit. There is no
 * parameter that removes them, deliberately: a read narrowed to `applies` returns
 * a confident yes for every vehicle somebody explicitly excluded, which is the
 * highest-cost wrong answer in this epic. So the caller receives exclusions and
 * MUST render them as exclusions — see `lib/catalog/compatibility.ts`.
 *
 * ## Why the relation lookup is not here
 *
 * `GET /compatibility/relations` exists and serves both directions, and this app
 * calls neither. `CompatibilityRelationView.target` is a bare id union — a family
 * id, a product id, a variant id, or a typed key — with no display name anywhere
 * on it, because a typed target's localized name belongs to the localization
 * family (ADR 0007 D4) and the public read performs no resolution. So a relation
 * fetched here would have nothing renderable in it, and "compatible with 4 things"
 * is a sentence that helps nobody. The resolution is what is owed, not the fetch.
 *
 * ## And the vehicle picker is not here either
 *
 * `GET /compatibility/fitments/verdict` answers "does this fit MY car" and the
 * four `/compatibility/vehicles/...` rungs are the picker that lets somebody name
 * one. Both are served; neither is called yet. That is an interaction — cascading
 * selection, a remembered vehicle, an answer that changes as the shopper narrows
 * it — rather than a read, and it is named as a seam rather than half-built.
 */

/** The vehicles one part is stated to fit, exclusions included. */
export async function fetchPartFitments(
  subject: CompatibilitySubject,
): Promise<PartFitmentsView> {
  const params =
    subject.kind === 'canonical_variant'
      ? { subjectVariantId: subject.variantId }
      : { subjectProductId: subject.productId };
  const { data } = await apiClient.get<ApiResponse<PartFitmentsView>>(
    '/compatibility/fitments',
    { params },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load fitment');
  }
  return data.data;
}
