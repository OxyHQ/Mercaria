/**
 * Publish `FEE_SCHEDULE_CATALOG` into `fee_schedules`: preview, draft, activate.
 *
 *   bun packages/backend/dist/scripts/provision-fee-schedule.js --ref=<commit> [--apply | --activate]
 *
 * `.github/workflows/publish-fee-schedules.yml` runs it as a one-shot on the
 * LIVE task definition (it needs the production database, which only the VPC
 * reaches), passing the commit the live image was built from as `--ref`.
 * Runbook: `docs/runbooks/marketplace-card-rail-live.md` §5.
 *
 * This is what replaced `POST /internal/payments/fee-schedules`. That route was
 * gated on the payment operator desk (then an allow-list of Oxy user ids in an
 * env var), so Mercaria could not charge a commission until a named person with a
 * credential existed. Oxy is deliberately not built to have administrators, and
 * the rate is a policy rather than an act of one — so it is defined in the
 * repository, reviewed as a pull request, and applied by a deployment.
 *
 * `drafted_by_*` and `approved_by_*` are therefore `deployment` plus the commit
 * that carries the version. "Who decided this" resolves to a reviewed change.
 * When fee policy moves to a CrowdSource jury, the authority becomes
 * `crowdsource_decision` and the reference its decision id; the columns already
 * accept both, so that is a change of author and not of schema.
 *
 * ## Three modes, and only the third one charges anybody
 *
 * - **preview** (the default) reads: every published version, and what `--apply`
 *   would draft. It writes nothing.
 * - **`--apply`** DRAFTS each catalogue version that is not yet published. A
 *   draft charges nobody — `order-fees.service.ts` selects only active schedules.
 * - **`--activate`** activates each catalogue version that is still a draft. It is
 *   the dangerous half: the moment a schedule is applicable,
 *   `merchant-activation/checkout-gate.ts` refuses `seller_not_activated` for every
 *   seller with no acceptance of that exact version. So it first lists the
 *   payment-READY sellers the schedule reaches that have not accepted it, and
 *   REFUSES if there is any — activating would take their checkout offline. A
 *   seller still onboarding cannot take a card payment yet, so it is not taken
 *   offline: it meets the terms on its fees screen before its first sale.
 *
 * Activation is a separate dispatch, never a side effect of a deploy or of
 * drafting: a routine change must not be able to stop the marketplace.
 *
 * ## Idempotence is structural, not a flag
 *
 * The only statement `--apply` issues against `fee_schedules` is an INSERT, and
 * only for a `(scheduleKey, version)` that `findFeeScheduleVersion` reports
 * absent. `--activate` issues only the repository's draft-to-active CAS. There is
 * no UPDATE of an economic column and no DELETE anywhere in it. So a second run
 * writes nothing, a re-run after a partial failure completes from where it
 * stopped, and — the property that matters — a published version whose terms a
 * merchant has ACCEPTED can never be rewritten by editing the catalogue.
 * Changing a rate means a new `version`, which is what
 * `fee_schedules_key_version_key` and the immutability trigger already enforce at
 * the server; this script simply never asks.
 */

import { execFileSync } from 'node:child_process';
import type { OrderSellerType, ProviderAccountOwnerType } from '@mercaria/shared-types';
import { FEE_SCHEDULE_CATALOG, type FeeScheduleDefinition } from '../services/fees/catalog.js';
import {
  activateFeeSchedule,
  findFeeScheduleVersion,
  insertFeeSchedule,
  listFeeSchedules,
  listReadySellersWithoutAcceptance,
  type FeeScheduleRow,
} from '../db/fees/feeScheduleRepository.js';
import { closePostgres, connectPostgres, getDb } from '../db/postgres.js';
import { log } from '../lib/logger.js';

type Mode = 'preview' | 'apply' | 'activate';

/** A full commit id, the only reference a `deployment` authority may carry. */
const COMMIT = /^[0-9a-f]{40}$/;

function parseArgs(argv: readonly string[]): { mode: Mode; ref: string } {
  let mode: Mode = 'preview';
  let ref: string | undefined;
  for (const arg of argv) {
    if (arg === '--preview') mode = 'preview';
    else if (arg === '--apply') mode = 'apply';
    else if (arg === '--activate') mode = 'activate';
    else if (arg.startsWith('--ref=')) ref = arg.slice('--ref='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { mode, ref: ref ?? deploymentRef() };
}

/**
 * The commit this run's catalogue comes from — the `deployment` authority's
 * reference.
 *
 * `--ref` when the workflow passes it (the live image carries no git checkout),
 * else `GIT_COMMIT_SHA`, else `git` as a local fallback. It REFUSES rather than
 * inventing one: a fee schedule whose author is `deployment` + `"unknown"`
 * records nothing, and a record that cannot say who decided a commission is the
 * exact gap this whole change closes.
 */
function deploymentRef(): string {
  const fromEnv = process.env.GIT_COMMIT_SHA?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'Cannot determine the commit this catalogue comes from. Pass --ref=<commit>, set ' +
        'GIT_COMMIT_SHA, or run this inside a git checkout. A fee schedule must record which ' +
        'reviewed change authored it, and refusing is better than writing an author nobody ' +
        'can resolve.',
    );
  }
}

/** The seller kinds a schedule's scope reaches — the owners its activation can refuse. */
function sellersReached(scope: OrderSellerType | null): ProviderAccountOwnerType[] {
  if (scope === null) return ['store', 'user'];
  // Mercaria itself (`platform`) accepts no terms and is never refused.
  return scope === 'platform' ? [] : [scope];
}

function describe(row: FeeScheduleRow): Record<string, unknown> {
  return {
    scheduleKey: row.scheduleKey,
    version: row.version,
    status: row.status,
    eligibleSellerType: row.eligibleSellerType ?? 'any',
    eligibleCurrency: row.eligibleCurrency ?? 'any',
    percentageBps: row.percentageBps,
    fixedFeeMinor: row.fixedFeeAmount,
    termsVersion: row.termsVersion,
  };
}

async function draft(definition: FeeScheduleDefinition, ref: string): Promise<FeeScheduleRow> {
  return await insertFeeSchedule(getDb(), {
    scheduleKey: definition.scheduleKey,
    version: definition.version,
    name: definition.name,
    merchantSummary: definition.merchantSummary,
    effectiveStart: definition.effectiveStart,
    ...(definition.eligibleSellerType ? { eligibleSellerType: definition.eligibleSellerType } : {}),
    ...(definition.eligibleCurrency ? { eligibleCurrency: definition.eligibleCurrency } : {}),
    percentageBps: definition.percentageBps,
    ...(definition.fixedFee ? { fixedFee: definition.fixedFee } : {}),
    ...(definition.taxTreatment ? { taxTreatment: definition.taxTreatment } : {}),
    termsVersion: definition.termsVersion,
    draftedBy: { authority: 'deployment', ref },
  });
}

/**
 * Run one mode over the catalogue. Exported for the real-database suite; the
 * module's own entry point is the guarded `main` below.
 *
 * @throws When `--activate` would take a payment-ready seller offline.
 */
export async function provisionFeeSchedules(input: {
  mode: Mode;
  ref: string;
  catalog?: readonly FeeScheduleDefinition[];
}): Promise<{ drafted: number; activated: number }> {
  if (!COMMIT.test(input.ref)) {
    throw new Error('--ref must be a full 40-character commit id.');
  }
  const db = getDb();
  const catalog = input.catalog ?? FEE_SCHEDULE_CATALOG;

  for (const row of await listFeeSchedules(db)) {
    log.general.info(describe(row), '[Fees] published version');
  }

  let drafted = 0;
  let activated = 0;
  for (const definition of catalog) {
    const existing = await findFeeScheduleVersion(db, {
      scheduleKey: definition.scheduleKey,
      version: definition.version,
    });

    if (input.mode === 'preview') {
      log.general.info(
        { scheduleKey: definition.scheduleKey, version: definition.version },
        existing
          ? `[Fees] catalogue version already published (${existing.status})`
          : '[Fees] catalogue version would be drafted by --apply',
      );
      continue;
    }

    if (input.mode === 'apply') {
      // Deliberately NOT compared against the catalogue and NOT repaired. An
      // existing version may already carry acceptances, and rewriting terms a
      // merchant agreed to is the one thing this script must never do. A
      // catalogue that has drifted from a published version is a new version.
      if (existing) {
        log.general.info(describe(existing), '[Fees] already published; left untouched');
        continue;
      }
      const row = await draft(definition, input.ref);
      drafted += 1;
      log.general.info(describe(row), '[Fees] drafted a fee schedule version');
      continue;
    }

    // --activate
    if (!existing) {
      throw new Error(
        `${definition.scheduleKey} v${String(definition.version)} is not published. Run --apply ` +
          'first; activation never drafts.',
      );
    }
    if (existing.status !== 'draft') {
      log.general.info(describe(existing), '[Fees] not a draft; nothing to activate');
      continue;
    }
    const unaccepted = await listReadySellersWithoutAcceptance(db, {
      scheduleKey: existing.scheduleKey,
      scheduleVersion: existing.version,
      ownerTypes: sellersReached(existing.eligibleSellerType),
    });
    if (unaccepted.length > 0) {
      throw new Error(
        `Refusing to activate ${existing.scheduleKey} v${String(existing.version)}: ` +
          `${String(unaccepted.length)} payment-ready seller(s) have not accepted it, and ` +
          'activation would refuse their checkout. Nothing was activated.',
      );
    }
    const row = await activateFeeSchedule(db, {
      id: existing.id,
      approvedBy: { authority: 'deployment', ref: input.ref },
    });
    if (!row) {
      log.general.info(describe(existing), '[Fees] lost the activation race; nothing to do');
      continue;
    }
    activated += 1;
    log.general.info(describe(row), '[Fees] activated a fee schedule version');
  }

  if (input.mode !== 'activate') {
    // Said out loud on every run, because the gap between "the rate is
    // published" and "the rate is charged" is where somebody otherwise assumes
    // the job is done.
    log.general.warn(
      { drafted },
      '[Fees] a draft charges nobody; --activate is the separate act that does.',
    );
  }
  return { drafted, activated };
}

async function main(): Promise<void> {
  const { mode, ref } = parseArgs(process.argv.slice(2));
  await connectPostgres();
  const outcome = await provisionFeeSchedules({ mode, ref });
  log.general.info({ mode, ...outcome }, '[Fees] done');
}

if (import.meta.main) {
  main()
    .then(async () => {
      await closePostgres();
      process.exit(0);
    })
    .catch(async (err) => {
      log.general.error({ err }, 'Fee schedule provisioning failed');
      try {
        await closePostgres();
      } catch (closeErr) {
        log.general.error(
          { err: closeErr },
          'Failed to close the Postgres pool after a provisioning error',
        );
      }
      process.exit(1);
    });
}
