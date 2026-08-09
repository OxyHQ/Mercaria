/**
 * Request schemas for the commerce-graph surfaces (#54).
 *
 * Its own file, following `payments-schemas.ts`: the graph routes are a
 * self-contained surface and their validation reads better beside the ADR
 * decisions that shape it. Every body schema is `.strict()` — the payments
 * rule: no unexpected field can even reach a handler, which is what makes
 * "the request cannot carry X" checkable at the schema rather than a habit
 * at every handler.
 *
 * Value tuples come from `@mercaria/shared-types`, never retyped — a
 * hand-copied list here could accept a value the database CHECK then refuses.
 */

import { z } from 'zod';
import {
  NATIVE_STORE_LINK_METHODS,
  type NativeStoreLinkMethod,
} from '@mercaria/shared-types';

const LINK_METHOD_VALUES = NATIVE_STORE_LINK_METHODS as readonly [
  NativeStoreLinkMethod,
  ...NativeStoreLinkMethod[],
];

/** A plausible hostname; the service normalizes and re-validates. */
const domainSchema = z.string().trim().min(3).max(253);

/**
 * `GET /merchants/lookup` — exactly ONE criterion, refused otherwise: a
 * combined lookup would silently AND or OR them, and the two readings return
 * different merchants.
 */
export const merchantLookupQuerySchema = z
  .object({
    domain: domainSchema.optional(),
    alias: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((query) => [query.domain, query.alias].filter((v) => v !== undefined).length === 1, {
    message: 'Provide exactly one of: domain, alias',
  });

/**
 * `GET /storefronts/lookup` — by source identity (provider + externalShopId,
 * both or neither) or by domain, exactly one criterion.
 */
export const storefrontLookupQuerySchema = z
  .object({
    provider: z.string().trim().min(1).max(100).optional(),
    externalShopId: z.string().trim().min(1).max(200).optional(),
    domain: domainSchema.optional(),
  })
  .strict()
  .refine(
    (query) => (query.provider === undefined) === (query.externalShopId === undefined),
    { message: 'provider and externalShopId go together' },
  )
  .refine(
    (query) => (query.provider !== undefined) !== (query.domain !== undefined),
    { message: 'Provide exactly one of: provider+externalShopId, domain' },
  );

/**
 * `POST /internal/commerce-graph/native-store-links` — explicit ids, a method
 * from the closed set (which has NO name-match member, deliberately) and a
 * reason for the audit trail. `.strict()` is load-bearing: no field exists
 * through which a name similarity, a score or a bulk flag could ride in.
 */
export const nativeStoreLinkCreateSchema = z
  .object({
    merchantId: z.string().trim().min(1).max(64),
    storeId: z.string().trim().min(1).max(64),
    method: z.enum(LINK_METHOD_VALUES),
    note: z.string().trim().min(1).max(2_000).optional(),
    reason: z.string().trim().min(10).max(2_000),
  })
  .strict();

/** `POST /internal/commerce-graph/native-store-links/:id/revoke`. */
export const nativeStoreLinkRevokeSchema = z
  .object({
    reason: z.string().trim().min(10).max(2_000),
  })
  .strict();
