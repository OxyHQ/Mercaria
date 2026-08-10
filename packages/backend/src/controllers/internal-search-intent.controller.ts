/**
 * `/internal/search-intent/*` — the operator surface (#95).
 *
 * On the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58/#60/
 * #62/#68/#70/#78 use, and deliberately NOT a seventh list: reading how a query
 * was interpreted is the same power over the same graph as reading what a query
 * returns (#70's operator surface), and the enablement it publishes is a
 * catalogue-quality decision rather than a financial or a compliance one.
 *
 * ## The route set is CLOSED, and the omissions are the design
 *
 * There is no "interpret this query as X", no "pin this attribute for that
 * phrase", no "add a synonym" and no "set the parser's weights". Every one of
 * them would be an interpretation rule living outside the versioned
 * deterministic rules and the benchmarked model — which is exactly what
 * `SHOPPING_INTENT_PARSER_VERSION` being a code constant exists to prevent. An
 * operator who needs a different reading ships a rule.
 *
 * What IS here: the counters, the fallback rate, one turn's trace, the
 * benchmark, and the enablement acceptance 7 requires. Four reads and two
 * writes, and both writes are the same act in two steps — measure, then enable
 * against what was measured.
 */

import type { Request, Response } from 'express';
import { INTENT_BENCHMARK_FLOOR_MEASURES } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import {
  findBenchmarkRun,
  insertBenchmarkRun,
  listBenchmarkRuns,
  listEnablements,
  upsertEnablement,
} from '../db/searchIntent/benchmarkRepository.js';
import { findTurn, readFallbackRate } from '../db/searchIntent/searchIntentRepository.js';
import { INTENT_BENCHMARK_DATASET, coveredCaseKinds } from '../services/search-intent/benchmark/dataset.js';
import { runIntentBenchmark } from '../services/search-intent/benchmark/runner.js';
import { readSearchIntentCounters } from '../services/search-intent/metrics.js';
import { shoppingIntentParserId } from '../services/search-intent/parser.port.js';
import {
  SHOPPING_INTENT_PARSER_VERSION,
  SHOPPING_INTENT_PROMPT_VERSION,
} from '@mercaria/shared-types';
import { catalogOperatorId } from '../middleware/catalog-operator-authz.js';
import type {
  IntentBenchmarkRunBody,
  IntentEnablementBody,
} from '../middleware/search-intent-schemas.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/** How far back the fallback rate is computed. A day, so a burst is visible. */
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * `GET /internal/search-intent/metrics`.
 *
 * TWO numbers for one question, deliberately: the process-local counters say
 * what is happening on THIS task right now, and the durable rate says what has
 * happened across the deployment. During an incident the first is available
 * when the second's table is the thing misbehaving.
 */
export async function intentMetricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const since = new Date(Date.now() - FALLBACK_WINDOW_MS);
    const durable = await readFallbackRate(since, getDb());
    sendSuccess(res, {
      task: readSearchIntentCounters(),
      window: {
        since: since.toISOString(),
        ...durable,
        // The RATE is computed here rather than stored, so a window change never
        // needs a migration — and division by a zero denominator answers zero
        // rather than `NaN`, which a dashboard renders as a blank cell nobody
        // can tell from a missing metric.
        fallbackRate: durable.total === 0 ? 0 : durable.deterministicCount / durable.total,
      },
      parser: {
        provider: shoppingIntentParserId(),
        parserVersion: SHOPPING_INTENT_PARSER_VERSION,
        promptVersion: SHOPPING_INTENT_PROMPT_VERSION,
      },
      dataset: {
        version: INTENT_BENCHMARK_DATASET.version,
        digest: INTENT_BENCHMARK_DATASET.digest,
        caseCount: INTENT_BENCHMARK_DATASET.caseCount,
        coveredCaseKinds: coveredCaseKinds(),
      },
    });
  } catch (error) {
    respondWithError(res, error, '[internal-search-intent] metrics failed');
  }
}

/**
 * `GET /internal/search-intent/turns/:turnId`.
 *
 * Opens from a TURN id and nothing else. There is no lookup by shopper, by
 * session owner or by query text — "show me everything this person searched
 * for" is not a question this surface can be asked, which is
 * `/internal/analytics`'s posture applied to the same kind of data. The row
 * itself carries only the REDACTED query, so even the answer to the question it
 * DOES accept holds no raw text.
 */
export async function intentTurnTraceHandler(req: Request, res: Response): Promise<void> {
  try {
    // `req.params` values are typed `string | string[]` by this Express
    // version's declarations; a route with one `:turnId` segment can only ever
    // produce a string, and the check is what makes that a fact `tsc` can see
    // rather than an assertion.
    const raw = req.params.turnId;
    const turnId = typeof raw === 'string' ? raw : '';
    const turn = await findTurn(turnId, getDb());
    if (turn === undefined) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No such interpretation.', 404);
      return;
    }
    sendSuccess(res, turn);
  } catch (error) {
    respondWithError(res, error, '[internal-search-intent] turn trace failed');
  }
}

/**
 * `POST /internal/search-intent/benchmark-runs` — measure, and RECORD.
 *
 * The run measures whatever interpreter this deployment actually has: with no
 * parser registered it measures the deterministic one, which is the honest
 * baseline and the thing a fresh deployment should enable against. There is
 * deliberately no parameter selecting an interpreter — a run that measured
 * something other than what production uses is a threshold that describes
 * nothing.
 */
export async function runIntentBenchmarkHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as IntentBenchmarkRunBody;
  try {
    const report = await runIntentBenchmark(undefined, body.language);
    if (report.caseCount === 0) {
      // A run over zero cases would record eight perfect scores — `ratio`
      // answers 1 on an empty denominator — and enable a language nobody
      // measured. The vacuity floor #61 built, applied to a threshold.
      sendError(
        res,
        ErrorCodes.VALIDATION_ERROR,
        `The dataset has no cases for language '${body.language}', so a run would measure nothing.`,
        422,
      );
      return;
    }
    const measurement = (name: string): number =>
      report.measurements.find((entry) => entry.measure === name)?.value ?? 0;
    const sample = (name: string): number =>
      report.measurements.find((entry) => entry.measure === name)?.sampleSize ?? 0;

    const row = await insertBenchmarkRun(
      {
        datasetVersion: report.datasetVersion,
        datasetDigest: report.datasetDigest,
        caseCount: report.caseCount,
        provider: shoppingIntentParserId(),
        promptVersion: SHOPPING_INTENT_PROMPT_VERSION,
        parserVersion: SHOPPING_INTENT_PARSER_VERSION,
        language: body.language,
        ...(body.categoryId === undefined ? {} : { categoryId: body.categoryId }),
        schemaValidity: measurement('schema_validity'),
        categoryAccuracy: measurement('category_accuracy'),
        hardConstraintRecall: measurement('hard_constraint_recall'),
        falseHardConstraintRate: measurement('false_hard_constraint_rate'),
        clarificationPrecision: measurement('clarification_precision'),
        latencyP95Ms: Math.round(measurement('latency_p95_ms')),
        costUnits: measurement('cost_units'),
        fallbackRate: measurement('fallback_rate'),
        sampleSize: Math.max(1, sample('schema_validity')),
        ranByOxyUserId: catalogOperatorId(req),
      },
      getDb(),
    );
    sendSuccess(res, { run: row, outcomes: report.outcomes }, 201);
  } catch (error) {
    respondWithError(res, error, '[internal-search-intent] benchmark run failed');
  }
}

/** `GET /internal/search-intent/benchmark-runs`. */
export async function listIntentBenchmarkRunsHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, await listBenchmarkRuns(50, getDb()));
  } catch (error) {
    respondWithError(res, error, '[internal-search-intent] listing runs failed');
  }
}

/**
 * `POST /internal/search-intent/enablements` — acceptance 7.
 *
 * The enablement CITES a run, and three things are checked before it is
 * written, in this order:
 *
 * 1. The run exists.
 * 2. Its digest matches the LIVE dataset. A run measured against a dataset
 *    somebody has since edited describes nothing about the cases in the file
 *    today, and enabling against it is the exact shape of "thresholds recorded
 *    before enabling" being technically true and meaningless.
 * 3. Its language matches the enablement's. A run over Spanish says nothing
 *    about German, and the two are separate rows precisely so they cannot be
 *    confused.
 *
 * The THRESHOLDS themselves are the operator's judgement rather than a constant
 * here, and that is deliberate: #95 asks that thresholds be RECORDED before
 * enabling, not that Mercaria pick them — the right false-hard-constraint
 * ceiling for a launch category is a product decision. What the code enforces
 * is that the measurements exist, that they describe the current dataset, and
 * that the direction of each measure is stated as data
 * (`INTENT_BENCHMARK_FLOOR_MEASURES`), so a comparison cannot read a ceiling as
 * a floor and enable a parser precisely when it is inventing requirements.
 */
export async function publishIntentEnablementHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as IntentEnablementBody;
  try {
    const run = await findBenchmarkRun(body.benchmarkRunId, getDb());
    if (run === undefined) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No such benchmark run.', 404);
      return;
    }
    if (run.datasetDigest !== INTENT_BENCHMARK_DATASET.digest) {
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'That run measured a different version of the labelled dataset. Re-run the benchmark against the current cases.',
        409,
      );
      return;
    }
    if (run.language !== body.language) {
      sendError(
        res,
        ErrorCodes.CONFLICT,
        `That run measured '${run.language}', not '${body.language}'.`,
        409,
      );
      return;
    }
    const row = await upsertEnablement(
      {
        ...(body.categoryId === undefined ? {} : { categoryId: body.categoryId }),
        language: body.language,
        enabled: body.enabled,
        benchmarkRunId: run.id,
        datasetDigest: run.datasetDigest,
        enabledByOxyUserId: catalogOperatorId(req),
        enabledAt: new Date(),
        note: body.note,
      },
      getDb(),
    );
    sendSuccess(res, {
      enablement: row,
      // The measurements are echoed BESIDE the enablement, with the direction of
      // each stated, so the operator sees what they just enabled against rather
      // than having to fetch the run again to find out.
      measuredAgainst: {
        schemaValidity: run.schemaValidity,
        categoryAccuracy: run.categoryAccuracy,
        hardConstraintRecall: run.hardConstraintRecall,
        falseHardConstraintRate: run.falseHardConstraintRate,
        clarificationPrecision: run.clarificationPrecision,
        latencyP95Ms: run.latencyP95Ms,
        sampleSize: run.sampleSize,
        floorMeasures: INTENT_BENCHMARK_FLOOR_MEASURES,
      },
    }, 201);
  } catch (error) {
    respondWithError(res, error, '[internal-search-intent] enablement failed');
  }
}

/** `GET /internal/search-intent/enablements`. */
export async function listIntentEnablementsHandler(_req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await listEnablements(getDb()));
  } catch (error) {
    respondWithError(res, error, '[internal-search-intent] listing enablements failed');
  }
}
