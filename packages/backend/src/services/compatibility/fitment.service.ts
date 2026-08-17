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
  listFitmentsWithVehiclesForSubject,
  type AutomotiveFitmentRow,
  type AutomotiveFitmentWithVehicles,
  type VehicleAncestryIds,
} from '../../db/compatibility/automotiveFitmentRepository.js';
import {
  findPartialVehicleAncestry,
  type PartialVehicleAncestry,
} from '../../db/compatibility/vehicleCatalogRepository.js';

/**
 * The verification states a PUBLIC answer may rest on.
 *
 * `candidate` is excluded from a positive answer and included in a negative one,
 * and the asymmetry is deliberate rather than an oversight: an unreviewed claim
 * that a part FITS is a guess a shopper would spend money on, while an
 * unreviewed claim that it does NOT is a reason to check, and suppressing it
 * would sell the part anyway.
 *
 * **`disputed` obeys the same asymmetry.** A disputed POSITIVE publishes nothing
 * — picking one of two contradicting sources is picking the side that makes a
 * sale — and a disputed NEGATIVE is published as a caution. This docblock used to
 * say it published nothing either way, which the tuple below never did; the
 * tuple is right, and `compatibility-public-read.realdb.test.ts` pins it.
 */
const POSITIVE_VERIFICATIONS: readonly CompatibilityVerificationState[] = ['verified'];
const NEGATIVE_VERIFICATIONS: readonly CompatibilityVerificationState[] = [
  'verified',
  'candidate',
  'disputed',
];

/**
 * The vehicle a caller ASKS about — every rung optional.
 *
 * Deliberately not `VehicleAncestryIds`, whose `makeId` is REQUIRED and correctly
 * so: that type is what the fitment READ is driven by, and the read always adds a
 * make-scope clause. What a caller holds is different — somebody who followed a
 * deep link to one configuration has a configuration id and nothing else, and the
 * resolver derives the make from it. Requiring a `makeId` there would demand a
 * value the resolver then IGNORES, which is a signature that lies about what it
 * reads.
 */
export interface VehicleQueryIds {
  readonly makeId?: string | null;
  readonly modelId?: string | null;
  readonly generationId?: string | null;
  readonly configurationId?: string | null;
}

/** What the caller asked about. */
export interface FitmentQuery {
  readonly subject: CompatibilitySubject;
  /** Any rung. The narrowest id given determines every level above it. */
  readonly vehicle: VehicleQueryIds;
  readonly year?: number;
}

/** The answer, plus the rows it was derived from. */
export interface FitmentAnswer {
  readonly verdict: FitmentVerdict;
  /** Every fitment that contributed, narrowest scope first. */
  readonly statements: readonly AutomotiveFitmentRow[];
  /**
   * The vehicle the answer is ABOUT, as the server resolved it — the full four
   * rows when a configuration was named, and only what the caller gave otherwise.
   *
   * Returned rather than left to the caller's own copies for the same reason
   * {@link resolveVehicleAncestry} re-reads them: a client asking about a
   * configuration while naming another generation is answered about the real one,
   * and a page that rendered its own idea of the car beside this verdict would
   * show a fit for a vehicle the verdict was not about. `null` where the caller
   * supplied no id at that level, which is honest — nothing was resolved there.
   */
  readonly vehicle: ResolvedFitmentVehicle;
}

/**
 * The vehicle records a verdict was reached against.
 *
 * The repository's own shape rather than a second declaration of it: two
 * spellings of "as much of a vehicle as we resolved" would drift the first time
 * the ladder grew a rung.
 */
export type ResolvedFitmentVehicle = PartialVehicleAncestry;

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
  const resolved = await resolveVehicleAncestry(query.vehicle);
  if (resolved.ids === null) {
    // The narrowest id the caller named does not resolve to a vehicle record, so
    // there is no read to issue: `automotive_fitments.vehicle_make_id` is NOT NULL
    // with a foreign key, and no fitment can reference a vehicle that is not there.
    //
    // The case worth naming is a REAL make beside a nonexistent configuration. The
    // resolver widens from the NARROWEST id, so the whole vehicle is unresolved and
    // the answer is `unknown` — rather than quietly answering the broader
    // make-level question, which could report `applies` for a car whose exact
    // variant the caller named and Mercaria does not have.
    return { verdict: { outcome: 'unknown' }, statements: [], vehicle: resolved.vehicle };
  }
  const rows = await listFitmentsForVehicle(resolved.ids, {
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
  return {
    verdict: resolveFitment(statements),
    statements: admissible,
    vehicle: resolved.vehicle,
  };
}

/**
 * The vehicles one part is stated to fit, with their vehicle records attached
 * and the publication policy applied — the PUBLIC form of
 * {@link listVehiclesForPart}.
 *
 * Two things it does that the plain read does not, and both are the difference
 * between an operator's list and a shopper's. It filters through
 * {@link admissibleForPublicVerdict}, so an unreviewed claim that a part fits is
 * not published while an unreviewed claim that it does not still is. And it
 * carries the vehicle rows, in one statement, because the alternative is a
 * lookup per fitment.
 *
 * `truncated` reports that the QUERY's bound was reached, which is not the same
 * as "there are more publishable fitments": the policy filter runs afterwards, so
 * a truncated page can return fewer rows than it examined. Reported that way
 * round because the honest thing a surface can say is "there are more than we are
 * showing", and the number that supports it is the one the query ran under.
 */
export async function listPublishedVehiclesForPart(
  subject: CompatibilitySubject,
  limit: number,
): Promise<{
  readonly fitments: readonly AutomotiveFitmentWithVehicles[];
  readonly examinedLimit: number;
  readonly truncated: boolean;
}> {
  // `limit + 1` so truncation is MEASURED rather than inferred from
  // `rows.length === limit`, which over-reports on every exact multiple — and
  // over-reporting here means telling a shopper their car might be on a list that
  // ends exactly where the page does.
  const rows = await listFitmentsWithVehiclesForSubject(subject, { limit: limit + 1 });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  return {
    fitments: page.filter((row) => admissibleForPublicVerdict(row.fitment)),
    examinedLimit: limit,
    truncated,
  };
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
 * Fill in the ancestry a caller did not supply, and re-read the part they did.
 *
 * The narrowest id given determines every level above it, and reading those
 * levels rather than trusting the caller's copies is what stops a client asking
 * about a configuration under one generation while claiming another — which
 * would collect the wrong generation's exclusions and answer confidently.
 *
 * It widens from ANY rung, not only from a configuration: most of the vehicle
 * picker's states are a make, or a make and a model, so a resolver that only
 * understood a configuration would leave the whole upper half of the picker
 * unresolved — and the verdict's own vehicle records with it. What it never does
 * is fill in a level NARROWER than the one named: choosing a generation for
 * somebody who only named a model is inventing the question.
 */
async function resolveVehicleAncestry(vehicle: VehicleQueryIds): Promise<{
  /** `null` when nothing resolved — there is no read to drive. */
  readonly ids: VehicleAncestryIds | null;
  readonly vehicle: ResolvedFitmentVehicle;
}> {
  const resolved = await findPartialVehicleAncestry(vehicle);
  if (resolved.make === null) {
    // The make is the one level the fitment read cannot do without, and passing the
    // caller's own unresolved ids through would drive a query on an id no row
    // carries — work that cannot match, in exchange for a signature that looks
    // total. `null` says there is nothing to ask.
    return { ids: null, vehicle: resolved };
  }
  return {
    ids: {
      makeId: resolved.make.id,
      // Each level is taken from what RESOLVED, never from what the caller sent,
      // so a generation named under somebody else's model cannot collect that
      // model's statements. The unresolved levels stay absent rather than falling
      // back to the caller's copies.
      modelId: resolved.model === null ? null : resolved.model.id,
      generationId: resolved.generation === null ? null : resolved.generation.id,
      configurationId: resolved.configuration === null ? null : resolved.configuration.id,
    },
    vehicle: resolved,
  };
}
