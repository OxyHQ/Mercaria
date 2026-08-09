/**
 * Request schemas for `/internal/awin/*` (#66).
 *
 * Every one is `.strict()`, so an undeclared field is REFUSED rather than
 * stripped — the house rule, and it matters twice here. A body able to carry a
 * tracking URL is where one would eventually be trusted, and a body able to
 * carry a SECRET is where a product-data key would eventually be pasted: this
 * surface accepts a LOCATOR (`env:NAME`), shape-checked to the same pattern the
 * column's CHECK enforces, so a pasted key fails validation before it reaches a
 * row and before it reaches a log.
 */

import { z } from 'zod';
import {
  AWIN_ACCOUNT_STATE_REASONS,
  AWIN_ACCOUNT_STATES,
  AWIN_ACTIVATIONS,
  AWIN_SAMPLE_FINDINGS,
  AWIN_SAMPLE_VERDICTS,
} from '@mercaria/shared-types';

/**
 * A credential LOCATOR, never a credential.
 *
 * The same pattern `awin_accounts_feed_credential_shape_check` enforces, so the
 * refusal happens at the edge with a message a person can act on rather than as
 * a 23514 from inside a transaction. A pasted Awin key contains characters this
 * refuses and is longer than it permits.
 */
const credentialLocator = z
  .string()
  .regex(
    /^(connection|env|ssm):[A-Za-z0-9_./-]{1,120}$/u,
    'A credential reference names WHERE the secret lives (`env:NAME`, `ssm:/path`), never the ' +
      'secret itself.',
  );

export const registerAwinAccountSchema = z
  .object({
    publisherId: z.string().regex(/^[0-9]{1,20}$/u),
    label: z.string().trim().min(1).max(200),
    feedCredentialRef: credentialLocator.optional(),
    publisherApiCredentialRef: credentialLocator.optional(),
    maxConcurrency: z.number().int().min(1).max(32).optional(),
    maxCallsPerMinute: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export const changeAwinAccountStateSchema = z
  .object({
    state: z.enum(AWIN_ACCOUNT_STATES as [string, ...string[]]),
    reason: z.enum(AWIN_ACCOUNT_STATE_REASONS as [string, ...string[]]),
    // MANDATORY, like every status change on `/internal/ingestion`: an
    // unattributed pause is one nobody can ask about later.
    note: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const changeAwinActivationSchema = z
  .object({
    activation: z.enum(AWIN_ACTIVATIONS as [string, ...string[]]),
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const registerAwinSourceSchema = z
  .object({
    merchantId: z.string().min(1),
    storefrontId: z.string().min(1).optional(),
    territories: z.array(z.string().regex(/^[A-Za-z]{2}$/u)).max(64).optional(),
    freshnessTtlSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).optional(),
    pageSize: z.number().int().min(1).max(5_000).optional(),
  })
  .strict();

export const recordAwinSampleSchema = z
  .object({
    feedRowId: z.string().min(1),
    verdict: z.enum(AWIN_SAMPLE_VERDICTS as [string, ...string[]]),
    sampled: z.number().int().min(1).max(10_000),
    passedRows: z.number().int().min(0).max(10_000),
    findings: z.array(z.enum(AWIN_SAMPLE_FINDINGS as [string, ...string[]])).max(16).optional(),
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
