/**
 * The discovery-sweep operator controller (`/internal/discovery/*`).
 *
 * `analytics-operator.controller.ts`'s `runRollupNowHandler`, one domain over:
 * one endpoint, forcing a recomputation nothing else can trigger between
 * ticks. THIN by the same argument that controller states for its own
 * surface — every other change this domain could want is the sweep
 * recomputing on its own, so an endpoint that forced a repair would add a way
 * to change a NUMBER without adding a way to change a FACT.
 */

import type { Request, Response } from 'express';
import { runDiscoverySweepOnce } from '../services/discovery/sweep.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/**
 * POST /internal/discovery/sweep
 *
 * Forces the next sweep tick now rather than waiting for the timer.
 * `runDiscoverySweepOnce` returns `undefined` when another task already holds
 * the lease — a NORMAL outcome, not an error, so the response says which of
 * the two happened rather than reporting a run that did not occur.
 */
export async function runDiscoverySweepNowHandler(_req: Request, res: Response): Promise<void> {
  try {
    const outcome = await runDiscoverySweepOnce();
    sendSuccess(res, outcome ? { ran: true, rowsWritten: outcome.rowsWritten } : { ran: false });
  } catch (err: unknown) {
    log.general.error({ err }, '[Discovery] manual sweep failed');
    respondWithError(res, err, 'Failed to run the discovery sweep');
  }
}
