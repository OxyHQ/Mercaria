import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AttributeDefinition, PublicAttributeValue } from '@mercaria/shared-types';
import {
  fetchAttributeDefinitionsForCategory,
  fetchAttributeValues,
} from '@/lib/api/catalog-attributes';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useCatalogContext } from './context';
import { composeSpecificationTable, type SpecificationTable } from './specifications';

/**
 * The registry reads a product page needs, and the table composed from them.
 *
 * Three independent queries rather than one composite: the definitions are keyed
 * on the CATEGORY and are shared by every product in it, while the values are
 * keyed on the entity. One combined key would refetch the whole category's
 * schema on every product a shopper opened.
 *
 * `/catalog-attributes` is mounted unconditionally, so this is the part of
 * workstream 9 that works with every #367 lever off.
 */

/** Definitions change when an operator publishes a version. Half an hour. */
const DEFINITION_STALE_TIME = 1000 * 60 * 30;
/** A product's selected values change when the catalogue converges. Five minutes. */
const VALUE_STALE_TIME = 1000 * 60 * 5;

export function useAttributeDefinitions(
  categoryId: string | undefined,
): ReturnType<typeof useQuery<readonly AttributeDefinition[]>> {
  return useQuery<readonly AttributeDefinition[]>({
    queryKey: queryKeys.catalog.attributeDefinitions(categoryId ?? ''),
    enabled: categoryId !== undefined && categoryId.length > 0,
    staleTime: DEFINITION_STALE_TIME,
    retry: 1,
    queryFn: () => fetchAttributeDefinitionsForCategory(categoryId ?? ''),
  });
}

export function useAttributeValues(
  entityKind: 'product' | 'variant',
  entityId: string | undefined,
): ReturnType<typeof useQuery<readonly PublicAttributeValue[]>> {
  return useQuery<readonly PublicAttributeValue[]>({
    queryKey: queryKeys.catalog.attributeValues(entityKind, entityId ?? ''),
    enabled: entityId !== undefined && entityId.length > 0,
    staleTime: VALUE_STALE_TIME,
    retry: 1,
    queryFn: () => fetchAttributeValues(entityKind, entityId ?? ''),
  });
}

export interface UseSpecificationTableInput {
  readonly categoryId: string | undefined;
  readonly canonicalProductId: string | undefined;
  /** The configuration a shopper has selected, when they have selected one. */
  readonly canonicalVariantId: string | undefined;
}

export interface SpecificationTableState {
  readonly table: SpecificationTable;
  readonly isLoading: boolean;
  /** The definitions did not answer, so every label is the value projection's. */
  readonly definitionsUnavailable: boolean;
}

/**
 * Compose a product's specification table.
 *
 * The definitions failing is NOT the same as there being none, and the state
 * says which: with them absent every label falls back to the value projection's
 * own — which the server already falls back to the stable KEY on — so a surface
 * can decline to present machine keys as words a shopper should read.
 */
export function useSpecificationTable(
  input: UseSpecificationTableInput,
): SpecificationTableState {
  const context = useCatalogContext();
  const definitions = useAttributeDefinitions(input.categoryId);
  const productValues = useAttributeValues('product', input.canonicalProductId);
  const variantValues = useAttributeValues('variant', input.canonicalVariantId);

  const table = useMemo(
    () =>
      composeSpecificationTable({
        locale: context.locale,
        definitions: definitions.data ?? [],
        productValues: productValues.data ?? [],
        variantValues: variantValues.data ?? [],
      }),
    [context.locale, definitions.data, productValues.data, variantValues.data],
  );

  return {
    table,
    isLoading: productValues.isLoading || variantValues.isLoading,
    definitionsUnavailable: definitions.isError || definitions.data === undefined,
  };
}
