import type {
  ApiResponse,
  AttributeDefinition,
  PublicAttributeValue,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * The PUBLIC attribute registry read (#94 API rules 1 and 5).
 *
 * These two calls are what makes a product page's specification table
 * schema-driven rather than a list somebody typed:
 *
 * - **the definitions** say which attributes a CATEGORY has, what each one
 *   means, its value type, its unit family and base unit, whether it is
 *   comparable, and its localized labels — the same registry the authoring
 *   wizard composes its form from (#367 workstream 9: "render localized labels
 *   and formatted values from the same definitions used by authoring");
 * - **the values** say which of them this product actually has, already
 *   rendered by the server in its display form.
 *
 * Both are anonymous and unflagged — `/catalog-attributes` is mounted
 * unconditionally — which is why the specification table is the one part of
 * this workstream that works on a deployment with every #367 lever off.
 *
 * ## Provenance is not here, and that is the surface's decision
 *
 * `PublicAttributeValue` carries no source record, confidence, method or
 * normalization rule version. A merchant CLAIM and a canonical fact are
 * therefore not distinguishable from this endpoint, which is why
 * `lib/catalog/specifications.ts` reports the distinction it CAN make —
 * `verificationState` — and states the rest as a seam rather than guessing.
 */

/** Every attribute definition scoped to one category, with its localized labels. */
export async function fetchAttributeDefinitionsForCategory(
  categoryId: string,
): Promise<readonly AttributeDefinition[]> {
  const { data } = await apiClient.get<ApiResponse<{ definitions: AttributeDefinition[] }>>(
    '/catalog-attributes/definitions',
    { params: { categoryId } },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load attribute definitions');
  }
  return data.data.definitions;
}

/** The SELECTED values of one canonical product or one canonical variant. */
export async function fetchAttributeValues(
  entityKind: 'product' | 'variant',
  entityId: string,
): Promise<readonly PublicAttributeValue[]> {
  const { data } = await apiClient.get<
    ApiResponse<{ entityKind: string; entityId: string; values: PublicAttributeValue[] }>
  >(
    `/catalog-attributes/values/${encodeURIComponent(entityKind)}/${encodeURIComponent(entityId)}`,
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load attribute values');
  }
  return data.data.values;
}
