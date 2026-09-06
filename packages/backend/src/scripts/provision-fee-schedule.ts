/**
 * Publish `FEE_SCHEDULE_CATALOG` into `fee_schedules`, as DRAFTS.
 *
 * This is what replaced `POST /internal/payments/fee-schedules`. That route was
 * gated on `PAYMENT_OPERATOR_OXY_USER_IDS`, an allow-list of Oxy user ids in an
 * env var, so Mercaria could not charge a commission until a named person with a
 * credential existed. Oxy is deliberately not built to have administrators, and
 * the rate is a policy rather than an act of one — so it is defined in the
 * repository, reviewed as a pull request, and applied by a deployment.
 *
 * `drafted_by_authority` is therefore `deployment` and `drafted_by_ref` is the
 * commit that introduced the version. "Who decided this" resolves to a reviewed
 * change. When fee policy moves to a CrowdSource jury, the authority becomes
 * `crowdsource_decision` and the reference its decision id; the column already
 * accepts both, so that is a change of author and not of schema.
 *
 * ## It DRAFTS. It never activates, and that is not an omission
 *
 * A draft charges nobody — `order-fees.service.ts` selects only active
 * schedules. Activation is the dangerous half: the moment a schedule is
 * applicable, `merchant-activation/checkout-gate.ts` refuses
 * `seller_not_activated` for every store with no acceptance row for that exact
 * version, which takes those stores' checkout offline. A script that could do
 * that as a side effect of a deploy would be a routine change that can stop the
 * marketplace, so activation is a separate, deliberate act and stays one.
 *
 * The order is therefore: run this, let every live store accept from
 * `dashboard/app/(app)/settings/fees.tsx`, and only then activate. Inverting the
 * last two is what takes the marketplace down.
 *
 * ## Idempotence is structural, not a flag
 *
 * The only statement this script can issue against `fee_schedules` is an INSERT,
 * and it issues one only for a `(scheduleKey, version)` that
 * `findFeeScheduleVersion` reports absent. There is no UPDATE and no DELETE
 * anywhere in it. So a second run writes nothing, a re-run after a partial
 * failure completes from where it stopped, and — the property that matters — a
 * published version whose terms a merchant has ACCEPTED can never be rewritten
 * by editing the catalogue. Changing a rate means a new `version`, which is what
 * `fee_schedules_key_version_key` and the immutability trigger already enforce
 * at the server; this script simply never asks.
 *
 * That is also why it needs no dry-run mode: the destructive version of this
 * script does not exist.
 */

import { execFileSync } from 'node:child_process';
import { FEE_SCHEDULE_CATALOG, type FeeScheduleDefinition } from '../services/fees/catalog.js';
import {
  findFeeScheduleVersion,
  insertFeeSchedule,
  type FeeScheduleRow,
} from '../db/fees/feeScheduleRepository.js';
import { closePostgres, connectPostgres, getDb } from '../db/postgres.js';
import { log } from '../lib/logger.js';

/**
 * The commit this deployment is built from — the `deployment` authority's
 * reference.
 *
 * Read from `GIT_COMMIT_SHA` when the image carries it, and from `git` only as a
 * local fallback. It REFUSES rather than inventing one: a fee schedule whose
 * author is `deployment` + `"unknown"` records nothing, and a record that cannot
 * say who decided a commission is the exact gap this whole change closes.
 */
function deploymentRef(): string {
  const fromEnv = process.env.GIT_COMMIT_SHA?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'Cannot determine the commit this deployment is built from. Set GIT_COMMIT_SHA, or run ' +
        'this inside a git checkout. A fee schedule must record which reviewed change authored ' +
        'it, and refusing is better than writing an author nobody can resolve.',
    );
  }
}

/** What one run did, per definition. */
interface ProvisionOutcome {
  definition: FeeScheduleDefinition;
  /** The row as it now stands — inserted by this run, or already present. */
  row: FeeScheduleRow;
  inserted: boolean;
}

async function provision(): Promise<ProvisionOutcome[]> {
  const db = getDb();
  const ref = deploymentRef();
  const outcomes: ProvisionOutcome[] = [];

  for (const definition of FEE_SCHEDULE_CATALOG) {
    const existing = await findFeeScheduleVersion(db, {
      scheduleKey: definition.scheduleKey,
      version: definition.version,
    });
    if (existing) {
      // Deliberately NOT compared against the catalogue and NOT repaired. An
      // existing version may already carry acceptances, and rewriting terms a
      // merchant agreed to is the one thing this script must never do. A
      // catalogue that has drifted from a published version is a new version.
      outcomes.push({ definition, row: existing, inserted: false });
      continue;
    }
    const row = await insertFeeSchedule(db, {
      scheduleKey: definition.scheduleKey,
      version: definition.version,
      name: definition.name,
      merchantSummary: definition.merchantSummary,
      effectiveStart: definition.effectiveStart,
      ...(definition.eligibleSellerType
        ? { eligibleSellerType: definition.eligibleSellerType }
        : {}),
      ...(definition.eligibleCurrency ? { eligibleCurrency: definition.eligibleCurrency } : {}),
      percentageBps: definition.percentageBps,
      ...(definition.fixedFee ? { fixedFee: definition.fixedFee } : {}),
      ...(definition.taxTreatment ? { taxTreatment: definition.taxTreatment } : {}),
      termsVersion: definition.termsVersion,
      draftedBy: { authority: 'deployment', ref },
    });
    outcomes.push({ definition, row, inserted: true });
  }
  return outcomes;
}

async function main(): Promise<void> {
  await connectPostgres();
  const outcomes = await provision();
  const inserted = outcomes.filter((outcome) => outcome.inserted);

  for (const outcome of outcomes) {
    log.general.info(
      {
        scheduleKey: outcome.definition.scheduleKey,
        version: outcome.definition.version,
        status: outcome.row.status,
        id: outcome.row.id,
      },
      outcome.inserted
        ? '[Fees] drafted a fee schedule version from the catalogue'
        : '[Fees] the catalogue version already exists; left untouched',
    );
  }

  // Said out loud on every run, including the no-op one, because the gap between
  // "the rate is published" and "the rate is charged" is where somebody
  // otherwise assumes the job is done.
  log.general.warn(
    { drafted: inserted.length, total: outcomes.length },
    '[Fees] every version above is a DRAFT and charges nobody. Each live store must accept it ' +
      'before it is activated — activating first refuses checkout for every store that has not.',
  );
}

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
