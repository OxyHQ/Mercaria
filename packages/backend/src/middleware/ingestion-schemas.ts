/**
 * Request schemas for `/internal/ingestion/*` (#62).
 *
 * Every one is `.strict()`. That is what stops an HTTP caller getting around a
 * service signature — the `tracePayment` reasoning (#50) — and here it has a
 * second job: the rights body enumerates the nine rights by name, so a caller
 * inventing a tenth is refused rather than having it silently ignored.
 */

import { z } from 'zod';
import {
  CATALOG_SOURCE_EXTRACTION_MODES,
  CATALOG_SOURCE_KINDS,
  CATALOG_SOURCE_STATUSES,
  SOURCE_RECORD_EXTERNAL_TYPES,
} from '@mercaria/shared-types';

/** A machine slug, matching `catalog_source_configs_provider_shape_check`. */
const providerSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u, 'Provider must be a lowercase machine slug');

/**
 * A credential LOCATOR, matching the column's own CHECK.
 *
 * Validated here as well as at the row so the refusal is a 400 naming the
 * expected shape rather than a 23514 — and, more usefully, so a pasted bearer
 * token never reaches a statement at all. The three schemes are the closed set;
 * anything else is a secret somebody is trying to store.
 */
const credentialRef = z
  .string()
  .regex(
    /^(connection|env|ssm):[A-Za-z0-9_./-]{1,120}$/u,
    'A credential reference names where a secret lives (connection:<id>, env:<NAME>, ssm:<path>) — never the secret itself',
  );

export const configureSourceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(CATALOG_SOURCE_KINDS as [string, ...string[]]),
    provider: providerSlug,
    sourceAccountRef: z.string().trim().min(1).max(200).optional(),
    merchantId: z.string().trim().min(1).optional(),
    storefrontId: z.string().trim().min(1).optional(),
    territories: z.array(z.string().regex(/^[A-Z]{2}$/u)).max(64).optional(),
    credentialRef: credentialRef.optional(),
    fetchCadenceSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).optional(),
    freshnessTtlSeconds: z.number().int().min(60).max(90 * 24 * 60 * 60).optional(),
    rateLimitPerMinute: z.number().int().min(1).max(100_000).optional(),
    rateLimitConcurrency: z.number().int().min(1).max(64).optional(),
    rateLimitMinIntervalMs: z.number().int().min(0).max(60_000).optional(),
    pageSize: z.number().int().min(1).max(1_000).optional(),
    rightsNote: z.string().trim().max(2_000).optional(),
  })
  .strict();

/**
 * A rights and terms version.
 *
 * The nine rights are REQUIRED booleans, not optional ones with defaults. A
 * reviewer publishing a policy states every right explicitly, because a default
 * is a right nobody decided — and the whole table exists to record decisions.
 */
export const publishPolicySchema = z
  .object({
    mayDisplay: z.boolean(),
    mayStore: z.boolean(),
    mayCache: z.boolean(),
    cacheTtlSeconds: z.number().int().min(0).max(365 * 24 * 60 * 60).optional(),
    mayDisplayPrice: z.boolean(),
    mayDisplayMedia: z.boolean(),
    mayLinkOut: z.boolean(),
    mayAppendAffiliateParams: z.boolean(),
    mayIndex: z.boolean(),
    mayRefreshAutomatically: z.boolean(),
    extractionMode: z.enum(CATALOG_SOURCE_EXTRACTION_MODES as [string, ...string[]]),
    extractionMaxRequestsPerDay: z.number().int().min(1).max(10_000_000).optional(),
    extractionUserAgent: z.string().trim().min(1).max(200).optional(),
    attributionRequired: z.boolean(),
    termsVersion: z.string().trim().max(200).optional(),
    termsUrl: z.string().url().max(2_048).optional(),
    reviewNote: z.string().trim().max(2_000).optional(),
  })
  .strict();

/** A lifecycle change. The reason is MANDATORY — `payment_repairs`' rule. */
export const changeSourceStatusSchema = z
  .object({
    status: z.enum(CATALOG_SOURCE_STATUSES as [string, ...string[]]),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

/** A manual run request. */
export const openRunSchema = z
  .object({
    /** Absent asks for a FULL enumeration — the only kind that may retire. */
    since: z.string().datetime().optional(),
  })
  .strict();

/** The trace's two handles, and no others. See `metrics.ts`. */
export const traceObjectSchema = z
  .object({
    externalType: z.enum(SOURCE_RECORD_EXTERNAL_TYPES as [string, ...string[]]),
    externalId: z.string().trim().min(1).max(400),
  })
  .strict();
