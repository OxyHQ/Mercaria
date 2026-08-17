/**
 * Seeding and updating a versioned vertical catalog package
 * (#367 Workstream 12).
 *
 * `scripts/seed-verticals/` already ships three reference packages (footwear,
 * smartphone, brake pad), already writes every entity through the real domain
 * services, is already insert-only, and already reports
 * `create`/`present`/`divergent` per step. What it did NOT have was a caller:
 * its only entry point was a CLI with `import.meta.main`, so applying a package
 * to a real deployment meant somebody with shell access on a task.
 *
 * This module is that caller and nothing else. It adds no writer, no second
 * package format, and no "force" mode.
 *
 * ## The safety is `apply: false` being the default and a real read
 *
 * `applyVerticalPackage(pkg, { apply: false })` still READS the database and
 * reports what it would do against THIS deployment — not against the fixture.
 * That is what makes the plan worth showing, and it is why the operator route
 * has a separate plan verb rather than a boolean nobody reads.
 *
 * A `divergent` step is REPORTED and never corrected. `seed-verticals` made
 * that ruling for the reason a restore makes it: a package that overwrote a
 * divergent row would silently undo whatever an operator changed since the
 * package was last applied.
 *
 * ## The census is the vacuity floor, and it is the reason to run one
 *
 * `censusVerticalPackage` derives the expected entity counts FROM the package
 * data and compares them against what is actually in the namespace, answering
 * `matched | vacuous | mismatched | unmeasurable`. `vacuous` is the member that
 * matters: a package application that wrote nothing reports a tidy list of
 * `present` steps and no errors, and only a census that knows what SHOULD be
 * there can tell that apart from a clean re-run.
 *
 * ## Versioning is the NAMESPACE, and that is the package format's decision
 *
 * `VerticalPackage` carries no version field and no digest; what it has is a
 * namespace, and `seed-verticals` records that "the honest reset is a new
 * namespace". This module surfaces the namespace rather than inventing a
 * version number the package format cannot back up — a version an operator
 * could set but nothing could verify is worse than no version at all.
 */

import type { CatalogGovernanceRestoreStep } from '@mercaria/shared-types';
import { notFound } from '../../lib/errors/error-codes.js';
import { getDb, type Database, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  applyVerticalPackage,
  namespaceFor,
  type SeedReport,
} from '../../scripts/seed-verticals/apply.js';
import { censusVerticalPackage, formatCensus } from '../../scripts/seed-verticals/census.js';
import { VERTICAL_PACKAGES, verticalPackageByName } from '../../scripts/seed-verticals/index.js';
import { recordAuditEvent } from '../../db/catalogGovernance/auditRepository.js';
import type { CatalogGovernanceActor } from './actor.js';
import { requireGovernanceRole } from './role.service.js';

/** What a package application produced. */
export interface VerticalPackageResult {
  readonly packageName: string;
  readonly namespace: string;
  readonly applied: boolean;
  readonly steps: readonly CatalogGovernanceRestoreStep[];
  readonly created: number;
  readonly present: number;
  readonly divergent: number;
  /** The census verdict, in the seed's own words. Absent on a plan. */
  readonly census?: string;
}

/** The packages this deployment ships, for the operator surface's picker. */
export function listVerticalPackages(): readonly { name: string; title: string; proves: string }[] {
  return VERTICAL_PACKAGES.map((pkg) => ({
    name: pkg.name,
    title: pkg.title,
    proves: pkg.proves,
  }));
}

/** Translate the seed's own step vocabulary into the governance one. */
function toSteps(report: SeedReport): readonly CatalogGovernanceRestoreStep[] {
  return report.steps.map((step) => ({
    entity: step.entity,
    identity: step.identity,
    outcome: step.outcome,
    detail: step.detail,
  }));
}

/**
 * Plan or apply a vertical package.
 *
 * The census runs only on an APPLY, and deliberately: on a plan there is
 * nothing yet to count, so a census would report `vacuous` for a package that
 * is about to be written correctly — which is the one reading that would make
 * an operator not press the button.
 */
export async function runVerticalPackage(
  db: Database,
  actor: CatalogGovernanceActor,
  input: {
    readonly packageName: string;
    readonly namespace?: string;
    readonly apply: boolean;
    readonly reason: string;
  },
): Promise<VerticalPackageResult> {
  // A plan is a read and needs `view`; applying one writes real categories,
  // attributes, product types and canonical products, so it needs `publish`.
  requireGovernanceRole(actor, input.apply ? 'publish' : 'view');

  const pkg = verticalPackageByName(input.packageName);
  if (!pkg) {
    throw notFound(
      `No vertical package named ${input.packageName}. This deployment ships ${VERTICAL_PACKAGES.map((entry) => entry.name).join(', ')}.`,
    );
  }

  const { report } = await applyVerticalPackage(
    pkg,
    { apply: input.apply, namespace: input.namespace, actorOxyUserId: actor.oxyUserId },
    db,
  );

  const result: VerticalPackageResult = {
    packageName: report.packageName,
    // `SeedReport.namespace` is a `VerticalNamespace` pair; the snake form is
    // the one every seeded key is prefixed with, so it is the one an operator
    // needs in order to run a census or find the rows afterwards.
    namespace: report.namespace.snake,
    applied: report.applied,
    steps: toSteps(report),
    created: report.created,
    present: report.present,
    divergent: report.divergent,
    census: input.apply
      ? formatCensus(await censusVerticalPackage(db, pkg, report.namespace))
      : undefined,
  };

  if (input.apply) {
    await db.transaction(async (tx) => {
      await recordAuditEvent(tx, {
        domain: 'taxonomy',
        action: 'vertical_package_apply',
        subjectKind: 'vertical_package',
        subjectId: `${report.packageName}:${report.namespace.snake}`,
        actorKind: 'operator',
        actorOxyUserId: actor.oxyUserId,
        reason: input.reason,
        source: 'vertical_package',
        changeRequestId: null,
        before: null,
        after: {
          created: result.created,
          present: result.present,
          divergent: result.divergent,
          census: result.census,
        },
        at: new Date(),
      });
    });
  }

  return result;
}

/**
 * Run the census on its own, without applying anything.
 *
 * The read an operator wants AFTER a package application, and the one thing in
 * this domain that can say a previous application landed nothing.
 */
export async function readVerticalPackageCensus(
  packageName: string,
  namespace: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string> {
  const pkg = verticalPackageByName(packageName);
  if (!pkg) throw notFound(`No vertical package named ${packageName}.`);
  return formatCensus(await censusVerticalPackage(db, pkg, namespaceFor(namespace)));
}
