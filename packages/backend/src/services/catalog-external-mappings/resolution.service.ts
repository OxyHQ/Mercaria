/**
 * Resolving one external token to one Mercaria concept (#367 Workstream 11).
 *
 * This is the read every ingestion adapter, feed importer and operator tool
 * asks. It is deliberately small, and almost all of it is refusals.
 *
 * ## What it will not do
 *
 * - **It never reads `confidence`.** There is no confidence at which a mapping
 *   applies without approval, so the column has no place in the read path and
 *   `external-mapping-isolation.test.ts` asserts this module does not mention
 *   it. #58's failure mode is the reason: a false merge looks exactly like a
 *   correct one and is discovered by a customer, and a numeric threshold is how
 *   one gets in.
 * - **It never falls back.** No nearest match, no parent category, no
 *   case-insensitive-and-then-fuzzy second attempt, no "the source's other feed
 *   used this". Seven unresolved reasons, all of which BLOCK.
 * - **It never picks between candidates.** A token with two live targets is
 *   `fanned_out` — which two named operators authorised — and a caller that
 *   handles a single target fails `tsc` on it rather than taking the first.
 *
 * ## The one thing it DOES write
 *
 * `resolveExternalToken` records the question it was asked, when the caller
 * supplies a subject. That is what makes the impact preview honest: "what would
 * this mapping change" is not answerable from the mappings alone, and the
 * alternative — reading another domain's `jsonb` payloads — would couple this
 * layer to a shape #62 owns. The write is an upsert on a natural key, so a
 * re-delivery converges instead of multiplying the figures, and it is
 * best-effort by SIGNATURE nowhere: a caller that passes no subject writes
 * nothing at all, which is the operator-probe case.
 */

import type {
  CatalogExternalMappingDimension,
  CatalogExternalResolution,
  CatalogExternalResolvedTarget,
  CatalogExternalSubjectKind,
  CatalogExternalTarget,
  CatalogExternalTransformRefusal,
  CatalogExternalUnresolvedReason,
} from '@mercaria/shared-types';
import {
  controlledValueIsResolvable,
  findActiveAttributeVersion,
} from '../../db/catalogExternalMappings/conceptReadRepository.js';
import {
  findLegacyAttributeMapping,
  readLiveMappings,
  readMappingHistory,
  recordExternalTokenObservation,
  type ExternalMappingRow,
} from '../../db/catalogExternalMappings/externalMappingRepository.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { resolveUnit, unitFamilyOf } from '../canonical/units.js';
import { conceptExists } from './concept-registry.port.js';
import { columnsToTarget } from './target.js';
import { applyExternalTransform } from './transform-rules.js';

/** What the caller is asking about. */
export interface ResolveExternalTokenInput {
  readonly catalogSourceId: string;
  readonly dimension: CatalogExternalMappingDimension;
  /** The source's own token, verbatim. Normalization is Postgres's, on both sides. */
  readonly externalKey: string;
  /**
   * The source's raw VALUE, when the caller has one and wants it transformed.
   *
   * Distinct from the key: for an `attribute` mapping the key is the field name
   * (`memory_size`) and the value is what the source put in it (`16 GB`).
   */
  readonly rawValue?: string;
  /** The instant to resolve at. A mapping's validity window is read against it. */
  readonly at: Date;
  /**
   * The subject that carried the token. Supplying it records an observation,
   * which is what the impact preview counts over. Omitting it resolves and
   * records nothing — the operator-probe case.
   */
  readonly subject?: {
    readonly kind: CatalogExternalSubjectKind;
    readonly key: string;
  };
}

/** A target this deployment can actually reach, or the reason it cannot. */
type TargetVerdict =
  | { readonly verdict: 'resolvable' }
  | { readonly verdict: 'unresolvable'; readonly reason: CatalogExternalUnresolvedReason };

/**
 * Whether the Mercaria concept a mapping names exists right now.
 *
 * Derived at READ time rather than stored on the mapping — the
 * `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict rule,
 * and for the same reason: the inputs live on tables in three domains this one
 * does not own, so a deprecated attribute version stops resolving in the
 * statement that deprecates it, with no sweep in between.
 */
async function verifyTarget(
  target: CatalogExternalTarget,
  db?: DatabaseOrTransaction,
): Promise<TargetVerdict> {
  switch (target.dimension) {
    case 'attribute': {
      const active = await findActiveAttributeVersion(target.attributeKey, db);
      return active === null
        ? { verdict: 'unresolvable', reason: 'target_unresolvable' }
        : { verdict: 'resolvable' };
    }
    case 'controlled_value': {
      const present = await controlledValueIsResolvable(
        target.attributeKey,
        target.controlledValue,
        db,
      );
      return present ? { verdict: 'resolvable' } : { verdict: 'unresolvable', reason: 'target_unresolvable' };
    }
    case 'unit': {
      // The canonical unit table is a code registry, so this needs no database
      // and no port: `services/canonical/units.ts` either knows the code within
      // the declared family or it does not.
      const canonical = resolveUnit(target.unitCode);
      if (canonical === null) return { verdict: 'unresolvable', reason: 'target_unresolvable' };
      return unitFamilyOf(canonical) === target.unitFamily
        ? { verdict: 'resolvable' }
        : { verdict: 'unresolvable', reason: 'target_unresolvable' };
    }
    case 'product_type':
    case 'size_system': {
      const key =
        target.dimension === 'product_type' ? target.productTypeKey : target.sizeSystemKey;
      // No version is passed: a mapping targets the KEY and resolution reads the
      // single live version. Which version it was REVIEWED against is a
      // provenance column on the row and is never applied.
      const existence = await conceptExists(target.dimension, key);
      // `unavailable` is not `absent`. "Mercaria does not have this size system"
      // and "Mercaria cannot answer questions about size systems" lead an
      // operator to opposite next actions, and only one is worth a review row.
      if (existence.state === 'present') return { verdict: 'resolvable' };
      return {
        verdict: 'unresolvable',
        reason: existence.state === 'unavailable' ? 'registry_unavailable' : 'target_unresolvable',
      };
    }
  }
}

/** Apply the mapping's cited transform to the caller's raw value, when there is one. */
function transformValue(
  row: ExternalMappingRow,
  rawValue: string | undefined,
): { readonly value?: string; readonly refusal?: CatalogExternalTransformRefusal } {
  if (rawValue === undefined) return {};
  const outcome = applyExternalTransform(row.transformRule, row.transformRuleVersion, rawValue);
  return outcome.outcome === 'normalized' ? { value: outcome.value } : { refusal: outcome.reason };
}

/**
 * Tell `unmapped` apart from `mapping_not_approved` and `mapping_expired`.
 *
 * Three different next actions: open a review, finish reviewing the proposal
 * that already exists, or publish a new version. Collapsing them would send an
 * operator to open a second review for a token that already has one open, which
 * the partial unique would then refuse — and the refusal would look like a bug.
 */
async function classifyAbsence(
  input: ResolveExternalTokenInput,
  db?: DatabaseOrTransaction,
): Promise<CatalogExternalUnresolvedReason> {
  const history = await readMappingHistory(
    input.catalogSourceId,
    input.dimension,
    input.externalKey,
    db,
  );
  if (history.length === 0) return 'unmapped';
  if (history.some((row) => row.state === 'approved')) return 'mapping_expired';
  if (history.some((row) => row.state === 'proposed' || row.state === 'in_review')) {
    return 'mapping_not_approved';
  }
  // Every decision about this token was a rejection or a supersession with no
  // successor. That is not "nobody has looked": it is "somebody looked and the
  // answer is no", which is the state a re-proposal has to argue against.
  return 'mapping_not_approved';
}

/**
 * #94's `attribute_source_mappings`, consulted only when nothing governed
 * answers and only for the `attribute` dimension.
 *
 * A deployment that configured that table before this layer existed must not
 * have its fields silently un-mapped by adopting this one. The result is marked
 * `legacy_registry` so no caller can mistake it for a reviewed decision, and the
 * reconciliation report counts exactly this population as the migration backlog.
 */
async function resolveFromLegacyRegistry(
  input: ResolveExternalTokenInput,
  db?: DatabaseOrTransaction,
): Promise<CatalogExternalResolvedTarget | null> {
  if (input.dimension !== 'attribute') return null;
  const legacy = await findLegacyAttributeMapping(input.catalogSourceId, input.externalKey, db);
  if (legacy === null) return null;
  const active = await findActiveAttributeVersion(legacy.attributeKey, db);
  if (active === null) return null;
  return {
    mappingId: `legacy:${input.catalogSourceId}:${legacy.sourceField}`,
    target: { dimension: 'attribute', attributeKey: legacy.attributeKey },
    origin: 'legacy_registry',
    // A legacy row carries no transform reference at all, so the honest reading
    // is that the source's value passes through untouched. `assumed_unit` is
    // #94's own mechanism and stays #94's — reinterpreting it as a transform
    // here would be this domain inventing a rule nobody reviewed.
    transformRule: 'identity',
    transformRuleVersion: 1,
    ...(input.rawValue === undefined ? {} : { normalizedValue: input.rawValue }),
  };
}

/**
 * What does this source's token mean?
 *
 * Records the question when a subject is supplied, so the impact preview has
 * something exact to count. The write happens AFTER the answer is computed and
 * carries the answer, which is what makes a reprocessing run able to tell
 * `unchanged` from `retargeted` without re-deriving history.
 */
export async function resolveExternalToken(
  input: ResolveExternalTokenInput,
  db?: DatabaseOrTransaction,
): Promise<CatalogExternalResolution> {
  const resolution = await computeResolution(input, db);

  if (input.subject !== undefined) {
    const governed = governedMappingId(resolution);
    await recordExternalTokenObservation(
      {
        catalogSourceId: input.catalogSourceId,
        dimension: input.dimension,
        externalKey: input.externalKey,
        subjectKind: input.subject.kind,
        subjectKey: input.subject.key,
        ...(input.rawValue === undefined ? {} : { observedRawValue: input.rawValue }),
        resolvedMappingId: governed,
        resolutionOutcome: governed === null ? 'unresolved' : 'resolved',
        unresolvedReason: governed === null ? unresolvedReasonFor(resolution) : null,
        observedAt: input.at,
      },
      db,
    );
  }

  return resolution;
}

/**
 * The GOVERNED mapping id an observation records, or `null`.
 *
 * A `legacy_registry` answer records neither an id nor a `resolved` outcome, and
 * both halves are deliberate. Its id is synthetic — there is no row behind it,
 * so `resolved_mapping_id`'s foreign key would refuse it — and, more
 * importantly, counting a legacy answer as governed coverage would make the
 * migration backlog invisible in exactly the report that exists to size it.
 */
function governedMappingId(resolution: CatalogExternalResolution): string | null {
  if (resolution.outcome === 'unresolved') return null;
  const first =
    resolution.outcome === 'resolved' ? resolution.resolved : (resolution.resolved[0] ?? null);
  if (first === null || first.origin !== 'governed') return null;
  return first.mappingId;
}

/** The reason an observation records when no governed mapping answered. */
function unresolvedReasonFor(
  resolution: CatalogExternalResolution,
): CatalogExternalUnresolvedReason {
  return resolution.outcome === 'unresolved' ? resolution.reason : 'unmapped';
}

/** The answer, with no side effect. Exported for the preview, which must not write. */
export async function computeResolution(
  input: ResolveExternalTokenInput,
  db?: DatabaseOrTransaction,
): Promise<CatalogExternalResolution> {
  const live = await readLiveMappings(
    input.catalogSourceId,
    input.dimension,
    input.externalKey,
    input.at,
    db,
  );

  if (live.length === 0) {
    const legacy = await resolveFromLegacyRegistry(input, db);
    if (legacy !== null) return { outcome: 'resolved', resolved: legacy };
    return { outcome: 'unresolved', reason: await classifyAbsence(input, db) };
  }

  const resolved: CatalogExternalResolvedTarget[] = [];
  let firstRefusal: CatalogExternalUnresolvedReason | null = null;
  let transformRefusal: CatalogExternalTransformRefusal | null = null;

  for (const row of live) {
    const target = columnsToTarget(row.dimension, row);
    if (target === null) {
      firstRefusal = firstRefusal ?? 'target_unresolvable';
      continue;
    }
    const verdict = await verifyTarget(target, db);
    if (verdict.verdict === 'unresolvable') {
      firstRefusal = firstRefusal ?? verdict.reason;
      continue;
    }
    const transformed = transformValue(row, input.rawValue);
    if (transformed.refusal !== undefined) {
      firstRefusal = firstRefusal ?? 'transform_refused';
      transformRefusal = transformRefusal ?? transformed.refusal;
      continue;
    }
    resolved.push({
      mappingId: row.id,
      target,
      origin: 'governed',
      transformRule: row.transformRule,
      transformRuleVersion: row.transformRuleVersion,
      ...(transformed.value === undefined ? {} : { normalizedValue: transformed.value }),
    });
  }

  if (resolved.length === 0) {
    return {
      outcome: 'unresolved',
      reason: firstRefusal ?? 'target_unresolvable',
      ...(transformRefusal === null ? {} : { transformRefusal }),
    };
  }

  // Two or more surviving targets means the partial unique let them through,
  // which means at least one carries a fan-out approval and a second operator
  // signed it. A separate branch rather than an array on `resolved`, so a caller
  // written for the ordinary case cannot take the first and drop the rest.
  const single = resolved[0];
  if (resolved.length === 1 && single !== undefined) {
    return { outcome: 'resolved', resolved: single };
  }
  return { outcome: 'fanned_out', resolved };
}
