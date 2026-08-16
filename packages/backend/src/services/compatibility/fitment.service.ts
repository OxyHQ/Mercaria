/**
 * Does this part fit this car? — the read #367 step 8 exists to answer
 * (ADR 0007 D8).
 *
 * ## The whole domain in four lines
 *
 * Resolve the shopper's vehicle to its ancestry, ask for every fitment attached
 * at any level of it, hand the set to `resolveFitment` in
 * `@mercaria/shared-types`, and project the verdict. The verdict logic lives in
 * shared-types rather than here because the storefront and the dashboard both
 * have to reach the same answer from the same rows, and a second implementation
 * on either side would be the false-agreement failure this repository has hit
 * before — two spellings of one rule, disagreeing only on the cases that matter.
 *
 * ## Nothing in this file writes anything
 *
 * Not a listing, not a variant, and above all not a variant option. The
 * canonical part stays ONE variant however many vehicles it fits; that is D8's
 * acceptance scenario, and it is true here because this module imports two read
 * repositories and no write path at all.
 */

import {
  resolveFitment,
  type CompatibilityApplicability,
  type CompatibilitySubject,
  type CompatibilityVerificationState,
  type FitmentStatement,
  type FitmentVerdict,
} from '@mercaria/shared-types';
import {
  listFitmentsForSubject,
  listFitmentsForVehicle,
  type AutomotiveFitmentRow,
  type VehicleAncestryIds,
} from '../../db/compatibility/automotiveFitmentRepository.js';
import { findVehicleAncestry } from '../../db/compatibility/vehicleCatalogRepository.js';

/**
 * The verification states a PUBLIC answer may rest on.
 *
 * `candidate` is excluded from a positive answer and included in a negative one,
 * and the asymmetry is deliberate rather than an oversight: an unreviewed claim
 * that a part FITS is a guess a shopper would spend money on, while an
 * unreviewed claim that it does NOT is a reason to check, and suppressing it
 * would sell the part anyway. `disputed` publishes nothing either way — two
 * sourced parties contradict each other and picking a side is what `disputed`
 * exists to avoid.
 */
const POSITIVE_VERIFICATIONS: readonly CompatibilityVerificationState[] = ['verified'];
const NEGATIVE_VERIFICATIONS: readonly CompatibilityVerificationState[] = [
  'verified',
  'candidate',
  'disputed',
];

/** What the caller asked about. */
export interface FitmentQuery {
  readonly subject: CompatibilitySubject;
  /** A configuration id resolves the whole ancestry; the looser forms are used as given. */
  readonly vehicle: VehicleAncestryIds;
  readonly year?: number;
}

/** The answer, plus the rows it was derived from. */
export interface FitmentAnswer {
  readonly verdict: FitmentVerdict;
  /** Every fitment that contributed, narrowest scope first. */
  readonly statements: readonly AutomotiveFitmentRow[];
}

/**
 * Which statements a public verdict may read.
 *
 * A `does_not_apply` row is admitted from a wider set of verification states
 * than an `applies` row — see {@link POSITIVE_VERIFICATIONS}. Written as an
 * explicit filter rather than pushed into the query, because the query's job is
 * to find every row covering the vehicle and this is a POLICY about which of
 * them may speak. Two different concerns in two places, and the SQL stays the
 * one the indexes were built for.
 */
function admissibleForPublicVerdict(row: AutomotiveFitmentRow): boolean {
  if (row.applicability === 'does_not_apply') {
    return NEGATIVE_VERIFICATIONS.includes(row.verification);
  }
  if (row.applicability === 'unknown') return false;
  return POSITIVE_VERIFICATIONS.includes(row.verification);
}

/**
 * Answer "does this fit", for one part and one vehicle.
 *
 * An empty admissible set is `unknown`, never `does_not_apply`. Mercaria knowing
 * nothing about a vehicle is not a statement about the part, and rendering it as
 * one tells a shopper their car is excluded on the strength of a gap in a feed.
 */
export async function answerFitment(query: FitmentQuery): Promise<FitmentAnswer> {
  const vehicle = await resolveVehicleAncestry(query.vehicle);
  const rows = await listFitmentsForVehicle(vehicle, {
    subject: query.subject,
    year: query.year,
    // Every applicability, deliberately: an exclusion is a `does_not_apply` row
    // and a read that dropped them would answer a confident yes for a vehicle
    // somebody explicitly excluded.
  });
  const admissible = rows.filter(admissibleForPublicVerdict);
  const statements: FitmentStatement[] = admissible.map((row) => ({
    scope: row.scope,
    applicability: row.applicability,
  }));
  return { verdict: resolveFitment(statements), statements: admissible };
}

/**
 * Every vehicle a part is stated to fit — the forward read, for a part's own
 * "fits these vehicles" list.
 *
 * Returns the rows rather than a verdict, because a list has no single verdict:
 * the caller renders each entry with its own applicability, and an exclusion in
 * the list is information a shopper wants to see rather than a row to hide.
 */
export async function listVehiclesForPart(
  subject: CompatibilitySubject,
  applicabilities?: readonly CompatibilityApplicability[],
): Promise<AutomotiveFitmentRow[]> {
  return listFitmentsForSubject(subject, { applicabilities });
}

/**
 * Fill in the ancestry a caller did not supply.
 *
 * A configuration id determines its generation, model and make, and reading them
 * here rather than trusting the caller's copies is what stops a client asking
 * about a configuration under one generation while claiming another — which
 * would collect the wrong generation's exclusions and answer confidently.
 * A caller who supplies no configuration gets exactly what they gave.
 */
async function resolveVehicleAncestry(vehicle: VehicleAncestryIds): Promise<VehicleAncestryIds> {
  if (vehicle.configurationId === undefined || vehicle.configurationId === null) {
    return vehicle;
  }
  const ancestry = await findVehicleAncestry(vehicle.configurationId);
  if (ancestry === null) return vehicle;
  return {
    makeId: ancestry.make.id,
    modelId: ancestry.model.id,
    generationId: ancestry.generation.id,
    configurationId: ancestry.configuration.id,
  };
}
