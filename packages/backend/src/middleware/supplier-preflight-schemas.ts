/**
 * Request schemas for the supplier-preflight operator surface (#122).
 *
 * `.strict()`, like every internal surface beside it, and here the strictness
 * carries a specific prohibition: the sourcing-policy body below enumerates the
 * COMPLETE set of levers a version has, and it has no field for an affiliate
 * commission, a referral payout, an organic ranking score or a paid placement.
 * `rankingCriteria` is bounded to `SUPPLIER_SOURCING_CRITERIA`, which is
 * disjoint from `SUPPLIER_FORBIDDEN_SOURCING_SIGNALS` by a test — so "selection
 * never reads a commission" (#122 selection 3) cannot be configured away.
 *
 * The controller runs `refuseForbiddenSourcingSignalBody` over the RAW body
 * BEFORE this schema, so an operator reaching for `affiliateCommissionWeight`
 * is told what it is and why it can never decide who fulfils an order — rather
 * than "unrecognized key", which reads as a typo. That is the
 * `refuseForbiddenResaleEvidenceBody` (#121) arrangement, and a test pins the
 * message so a remount after the schema fails loudly.
 */

import { z } from 'zod';
import {
  SUPPLIER_ADAPTER_CAPABILITIES,
  SUPPLIER_SOURCING_CRITERIA,
  SUPPLIER_SUPPRESSION_KINDS,
  SUPPLIER_SUPPRESSION_SCOPES,
  type SupplierAdapterCapability,
  type SupplierSourcingCriterion,
  type SupplierSuppressionKind,
  type SupplierSuppressionScope,
} from '@mercaria/shared-types';

const CRITERION_VALUES = SUPPLIER_SOURCING_CRITERIA as readonly [
  SupplierSourcingCriterion,
  ...SupplierSourcingCriterion[],
];
const CAPABILITY_VALUES = SUPPLIER_ADAPTER_CAPABILITIES as readonly [
  SupplierAdapterCapability,
  ...SupplierAdapterCapability[],
];
const SUPPRESSION_SCOPE_VALUES = SUPPLIER_SUPPRESSION_SCOPES as readonly [
  SupplierSuppressionScope,
  ...SupplierSuppressionScope[],
];
const SUPPRESSION_KIND_VALUES = SUPPLIER_SUPPRESSION_KINDS as readonly [
  SupplierSuppressionKind,
  ...SupplierSuppressionKind[],
];

/** A stated reason, bounded to the column's own CHECK. */
const reason = z.string().trim().min(1).max(2_000);

/**
 * Draft one sourcing policy version.
 *
 * Every bound here mirrors a CHECK on the table rather than replacing it: the
 * schema answers a caller with a readable 400 and the constraint is what makes
 * the rule true of the database. Where they could drift, the CHECK is the
 * authority — a schema is one write path and a table has as many as there are
 * connections.
 */
export const supplierSourcingPolicyCreateSchema = z
  .object({
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(2_000),
    effectiveStart: z.string().datetime(),
    effectiveEnd: z.string().datetime().nullable().optional(),
    // Ordered and non-empty, and it must rank on cost: a sourcing policy that
    // ignores what an order costs to fulfil prices nothing (a CHECK too).
    rankingCriteria: z
      .array(z.enum(CRITERION_VALUES))
      .min(1)
      .refine((criteria) => criteria.includes('total_landed_cost'), {
        message:
          'rankingCriteria must include `total_landed_cost`: a sourcing policy that does not ' +
          'rank on what an order costs to fulfil is not a cost-recovery policy.',
      })
      .refine((criteria) => new Set(criteria).size === criteria.length, {
        message: 'rankingCriteria must not repeat a criterion; the order is the whole policy.',
      }),
    requiredCapabilities: z.array(z.enum(CAPABILITY_VALUES)).default([]),
    maxSourcingAttempts: z.number().int().min(1).max(5),
    maxSupplierShareBps: z.number().int().min(1).max(10_000),
    quoteTtlSeconds: z.number().int().min(1),
    providerTimeoutMs: z.number().int().min(100).max(60_000),
    maxProviderConcurrency: z.number().int().min(1),
    maxProviderCallsPerMinute: z.number().int().min(1),
    healthWindowMinutes: z.number().int().min(1),
    healthMinimumSamples: z.number().int().min(1),
    healthMaxFailureBps: z.number().int().min(1).max(10_000),
    healthSuppressionMinutes: z.number().int().min(1),
  })
  .strict();

/** Activate or retire a version. The actor comes off the credential, never the body. */
export const supplierSourcingPolicyDecisionSchema = z.object({}).strict();

/**
 * Raise a kill switch.
 *
 * `origin` is deliberately ABSENT: an operator raising a stop from this surface
 * is an `operator` stop by construction, and letting a body claim
 * `automatic_health` would let a person file a stop that reads as the system's
 * and lapses on its own — which is exactly the attribution the CHECK on the
 * table exists to keep straight.
 */
export const supplierSuppressionSchema = z
  .object({
    scope: z.enum(SUPPRESSION_SCOPE_VALUES),
    supplierId: z.string().trim().min(1).nullable().optional(),
    supplierAccountId: z.string().trim().min(1).nullable().optional(),
    marketCountry: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'marketCountry must be an ISO-3166-1 alpha-2 code.')
      .nullable()
      .optional(),
    kind: z.enum(SUPPRESSION_KIND_VALUES),
    reason,
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict();

/** Lift a stop. The explanation is mandatory — a silent lift is not auditable. */
export const supplierSuppressionLiftSchema = z.object({ reason }).strict();

/** Run one sweep pass by hand — the operator's "do it now". */
export const supplierPreflightSweepSchema = z.object({}).strict();
