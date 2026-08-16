/**
 * `automotive_fitments` — the reads that answer "does this part fit my car"
 * and "which cars does this part fit" (#367 step 8, ADR 0007 D8).
 *
 * ## The ONE read that matters, and why it is a disjunction rather than a join
 *
 * {@link listFitmentsForVehicle} takes a vehicle ANCESTRY — make, model,
 * generation, configuration — and returns every fitment attached at ANY of those
 * four levels, in one statement over four partial indexes. The alternative, four
 * queries or a recursive walk up the tree, would make the exclusion mechanism
 * depend on the caller remembering to ask about the broader scopes too, and a
 * caller who forgets gets a plausible answer with the exclusions missing. Here
 * the disjunction is inside the repository and there is no way to ask a narrower
 * question.
 *
 * The ordering is by SPECIFICITY descending, so a caller reading the first row
 * of a group has the narrowest statement — but the verdict is not that first
 * row. `resolveFitment` in `@mercaria/shared-types` is the authority, because
 * two sources can contradict each other at one scope and "whichever sorted
 * first" is not an answer.
 *
 * There is no writer for a variant option in this file. See the module header of
 * `db/schema/compatibility.ts` for why that is the point.
 */

import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  CompatibilityApplicability,
  CompatibilitySubject,
  CompatibilityVerificationState,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { automotiveFitments } from '../schema/compatibility.js';

export type AutomotiveFitmentRow = typeof automotiveFitments.$inferSelect;
export type InsertAutomotiveFitment = typeof automotiveFitments.$inferInsert;

/** The four levels of one vehicle, as the reverse read consumes them. */
export interface VehicleAncestryIds {
  readonly makeId: string;
  readonly modelId?: string | null;
  readonly generationId?: string | null;
  readonly configurationId?: string | null;
}

export interface FitmentLookupFilter {
  /**
   * Narrow to ONE part.
   *
   * Not optional in practice for the "does this fit my car" read, and the reason
   * is a number: a popular vehicle carries tens of thousands of fitments across
   * every part anybody sells for it, so filtering the subject in JavaScript
   * after the fact would pull all of them per page view. Filtering it in SQL
   * lets the planner use `automotive_fitments_subject_product_idx` instead and
   * intersect.
   */
  readonly subject?: CompatibilitySubject;
  readonly verifications?: readonly CompatibilityVerificationState[];
  readonly applicabilities?: readonly CompatibilityApplicability[];
  /**
   * A model year. A fitment with NULL bounds is OPEN in that direction — both
   * NULL branches are written out, because SQL comparison against NULL is NULL
   * and a `between` would drop every open-ended fitment silently.
   */
  readonly year?: number;
  readonly limit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (limit < 1) return 1;
  return limit > MAX_LIMIT ? MAX_LIMIT : limit;
}

/**
 * Shared narrowing.
 *
 * **`applicabilities` defaults to EVERY value, deliberately**, and a caller
 * filtering it to `['applies']` is asking a different question from "does this
 * fit". An exclusion is a `does_not_apply` row, so a read that drops them
 * returns a confident yes for a vehicle somebody explicitly excluded — the one
 * failure this whole domain is shaped around. `resolveFitment` needs the full
 * set; only a merchandising list that has already resolved should narrow.
 */
function openFitmentFilter(filter: FitmentLookupFilter) {
  const clauses = [isNull(automotiveFitments.validTo)];
  if (filter.subject !== undefined) {
    clauses.push(subjectFilter(filter.subject));
  }
  if (filter.verifications !== undefined && filter.verifications.length > 0) {
    clauses.push(inArray(automotiveFitments.verification, [...filter.verifications]));
  }
  if (filter.applicabilities !== undefined && filter.applicabilities.length > 0) {
    clauses.push(inArray(automotiveFitments.applicability, [...filter.applicabilities]));
  }
  if (filter.year !== undefined) {
    clauses.push(or(isNull(automotiveFitments.yearFrom), lte(automotiveFitments.yearFrom, filter.year)));
    clauses.push(or(isNull(automotiveFitments.yearTo), gte(automotiveFitments.yearTo, filter.year)));
  }
  return and(...clauses);
}

/**
 * Every fitment covering one vehicle, at every scope, narrowest first.
 *
 * The make is mandatory and the three narrower levels are optional, so asking
 * about a vehicle the shopper has only partly specified ("a Golf, year
 * unknown") returns the make- and model-level statements and no more — which is
 * honest: nothing at the generation level covers a generation nobody named.
 */
export async function listFitmentsForVehicle(
  vehicle: VehicleAncestryIds,
  filter: FitmentLookupFilter = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<AutomotiveFitmentRow[]> {
  /**
   * Each branch pairs the SCOPE with the id, and the pairing is load-bearing.
   *
   * `vehicle_model_id` is set on model-, generation- AND configuration-scoped
   * rows (the scope ladder's CHECK), so a bare `vehicle_model_id = $1` would
   * return every generation-specific fitment under that model to a shopper who
   * only told us the model — reporting a part that fits the 2019 cars as
   * fitting theirs. The scope equality is what keeps a broader question from
   * collecting narrower answers.
   */
  const scopeClauses = [
    and(
      eq(automotiveFitments.scope, 'vehicle_make'),
      eq(automotiveFitments.vehicleMakeId, vehicle.makeId),
    ),
  ];
  if (vehicle.modelId !== undefined && vehicle.modelId !== null) {
    scopeClauses.push(
      and(
        eq(automotiveFitments.scope, 'vehicle_model'),
        eq(automotiveFitments.vehicleModelId, vehicle.modelId),
      ),
    );
  }
  if (vehicle.generationId !== undefined && vehicle.generationId !== null) {
    scopeClauses.push(
      and(
        eq(automotiveFitments.scope, 'vehicle_generation'),
        eq(automotiveFitments.vehicleGenerationId, vehicle.generationId),
      ),
    );
  }
  if (vehicle.configurationId !== undefined && vehicle.configurationId !== null) {
    scopeClauses.push(
      and(
        eq(automotiveFitments.scope, 'vehicle_configuration'),
        eq(automotiveFitments.vehicleConfigurationId, vehicle.configurationId),
      ),
    );
  }
  return db
    .select()
    .from(automotiveFitments)
    .where(and(or(...scopeClauses), openFitmentFilter(filter)))
    // Narrowest scope first — `array_position` over the ladder rather than an
    // alphabetical sort on the scope column, which would order
    // `vehicle_configuration` BEFORE `vehicle_generation` by accident and read
    // as correct.
    .orderBy(
      desc(
        sql`array_position(array['vehicle_make','vehicle_model','vehicle_generation','vehicle_configuration'], ${automotiveFitments.scope})`,
      ),
      desc(automotiveFitments.createdAt),
      automotiveFitments.id,
    )
    .limit(boundedLimit(filter.limit));
}

/** The subject predicate. A `switch` over a union with no common id field. */
function subjectFilter(subject: CompatibilitySubject) {
  switch (subject.kind) {
    case 'canonical_product':
      return eq(automotiveFitments.subjectProductId, subject.productId);
    case 'canonical_variant':
      return eq(automotiveFitments.subjectVariantId, subject.variantId);
  }
}

/** "Which vehicles does this part fit?" — the forward read. */
export async function listFitmentsForSubject(
  subject: CompatibilitySubject,
  filter: FitmentLookupFilter = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<AutomotiveFitmentRow[]> {
  return db
    .select()
    .from(automotiveFitments)
    .where(and(subjectFilter(subject), openFitmentFilter(filter)))
    .orderBy(automotiveFitments.vehicleMakeId, automotiveFitments.vehicleModelId, automotiveFitments.id)
    .limit(boundedLimit(filter.limit));
}

export async function findFitmentById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AutomotiveFitmentRow | null> {
  const [row] = await db
    .select()
    .from(automotiveFitments)
    .where(eq(automotiveFitments.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * `fitment_key`, rendered exactly as the GENERATED column does.
 *
 * Pinned against a real stored value by `compatibility.realdb.test.ts`, for the
 * reason `relationKeyOf` states: a second spelling of a generated expression is
 * a thing that can disagree, and this one is used to read a conflicting row back.
 */
export function fitmentKeyOf(values: InsertAutomotiveFitment): string {
  return [
    values.subjectProductId ?? '',
    values.subjectVariantId ?? '',
    values.vehicleMakeId,
    values.vehicleModelId ?? '',
    values.vehicleGenerationId ?? '',
    values.vehicleConfigurationId ?? '',
    values.position ?? 'not_applicable',
  ].join('|');
}

/**
 * Open a fitment, converging on the one already open for that (subject, vehicle,
 * position).
 *
 * The `openCompatibilityRelation` shape and the same reasoning: a repeat is
 * ordinary (a re-crawl, a retry, two pages naming one pairing) and must write
 * nothing at all, and the empty `RETURNING` set IS the answer rather than a
 * condition to catch.
 */
export async function openAutomotiveFitment(
  values: InsertAutomotiveFitment,
  db: DatabaseOrTransaction = getDb(),
): Promise<AutomotiveFitmentRow> {
  const [inserted] = await db
    .insert(automotiveFitments)
    .values(values)
    .onConflictDoNothing({
      target: automotiveFitments.fitmentKey,
      where: isNull(automotiveFitments.validTo),
    })
    .returning();
  if (inserted !== undefined) return inserted;

  const [existing] = await db
    .select()
    .from(automotiveFitments)
    .where(
      and(
        eq(automotiveFitments.fitmentKey, fitmentKeyOf(values)),
        isNull(automotiveFitments.validTo),
      ),
    )
    .limit(1);
  if (existing === undefined) {
    throw new Error(
      'openAutomotiveFitment: the insert conflicted and the conflicting row could not be read. ' +
        'That is a real failure, not a duplicate, and must not be swallowed as one.',
    );
  }
  return existing;
}

/** Close a fitment. There is deliberately no delete — see the relation repository. */
export async function closeAutomotiveFitment(
  id: string,
  closedAt: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const closed = await db
    .update(automotiveFitments)
    .set({ validTo: closedAt })
    .where(and(eq(automotiveFitments.id, id), isNull(automotiveFitments.validTo)))
    .returning({ id: automotiveFitments.id });
  return closed.length === 1;
}
