/**
 * The public projections — every field named explicitly (#367 step 8).
 *
 * The `provider_accounts` #46 precedent: a projection that spreads a row hands a
 * shopper every column somebody adds next, and the columns most likely to be
 * added to these tables are provenance ones. So the mapping is written out, and
 * `compatibility-isolation.test.ts` walks a REAL emitted view asserting no field
 * of `COMPATIBILITY_FORBIDDEN_VIEW_FIELDS` appears on it — the two-gate rule
 * (#92): a static scan proves the module does not declare them and a runtime
 * walk proves the serializer does not add them.
 *
 * `confidence` is on that forbidden list, and it is the one worth reading. It is
 * a machine's estimate of ITSELF, and publishing it beside a verification state
 * invites the number being read as a strength of verification — which is what
 * `commerce_relationships_confidence_machine_check` exists to prevent one domain
 * over, and which no CHECK can prevent in a DTO.
 */

import type {
  AutomotiveFitmentView,
  CompatibilityConditionKind,
  CompatibilityRelationView,
  CompatibilitySubject,
  CompatibilityTarget,
  FitmentQualifier,
  VehicleReferenceView,
} from '@mercaria/shared-types';
import type { CompatibilityRelationRow } from '../../db/compatibility/compatibilityRelationRepository.js';
import type { AutomotiveFitmentRow } from '../../db/compatibility/automotiveFitmentRepository.js';
import type {
  VehicleConfigurationRow,
  VehicleGenerationRow,
  VehicleMakeRow,
  VehicleModelRow,
} from '../../db/compatibility/vehicleCatalogRepository.js';

/**
 * The subject, as a union.
 *
 * `subject_check` makes exactly one of the two columns non-null, and this throws
 * rather than defaulting when neither is — a projection that quietly invented a
 * product id would put one part's fitments on another part's page, which is the
 * silent wrong answer this domain is written against. The CHECK means it cannot
 * happen; the throw means that if it does, it is loud.
 */
function projectSubject(row: {
  readonly subjectProductId: string | null;
  readonly subjectVariantId: string | null;
}): CompatibilitySubject {
  if (row.subjectVariantId !== null) {
    return { kind: 'canonical_variant', variantId: row.subjectVariantId };
  }
  if (row.subjectProductId !== null) {
    return { kind: 'canonical_product', productId: row.subjectProductId };
  }
  throw new Error(
    'a compatibility row has no subject; `..._subject_check` should make this unreachable',
  );
}

/** The target, as a union, switched on the STORED discriminant rather than on which column is set. */
function projectTarget(row: CompatibilityRelationRow): CompatibilityTarget {
  switch (row.targetKind) {
    case 'canonical_family':
      if (row.targetFamilyId === null) break;
      return { kind: 'canonical_family', familyId: row.targetFamilyId };
    case 'canonical_product':
      if (row.targetProductId === null) break;
      return { kind: 'canonical_product', productId: row.targetProductId };
    case 'canonical_variant':
      if (row.targetVariantId === null) break;
      return { kind: 'canonical_variant', variantId: row.targetVariantId };
    case 'typed':
      if (row.targetType === null || row.targetKey === null) break;
      return { kind: 'typed', target: { type: row.targetType, key: row.targetKey } };
  }
  throw new Error(
    `a compatibility relation declares target_kind=${row.targetKind} and carries no matching endpoint; ` +
      '`generic_compatibility_relations_target_check` should make this unreachable',
  );
}

/** One relation, as a shopper's surface renders it. */
export function projectCompatibilityRelation(
  row: CompatibilityRelationRow,
): CompatibilityRelationView {
  return {
    id: row.id,
    kind: row.kind,
    direction: row.direction,
    subject: projectSubject(row),
    target: projectTarget(row),
    applicability: row.applicability,
    verification: row.verification,
    verificationMethod: row.verificationMethod,
    conditionKinds: row.conditionKinds as readonly CompatibilityConditionKind[],
    conditionNote: row.conditionNote,
    markets: row.markets,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo === null ? null : row.validTo.toISOString(),
  };
}

/** A vehicle record, reduced to identity plus its base name. No labels (D1/D4). */
export function projectVehicleReference(
  row: VehicleMakeRow | VehicleModelRow | VehicleGenerationRow | VehicleConfigurationRow,
): VehicleReferenceView {
  return { id: row.id, key: row.key, name: row.name };
}

/** The vehicle records a fitment names, as the caller has already loaded them. */
export interface FitmentVehicleContext {
  readonly make: VehicleMakeRow;
  readonly model?: VehicleModelRow | null;
  readonly generation?: VehicleGenerationRow | null;
  readonly configuration?: VehicleConfigurationRow | null;
}

/**
 * One fitment, as a shopper's surface renders it.
 *
 * The vehicle records are passed IN rather than looked up here, so a page
 * rendering four hundred fitments loads the vehicle tree once — the N+1 this
 * projection would otherwise be. The caller batches; the projection maps.
 */
export function projectAutomotiveFitment(
  row: AutomotiveFitmentRow,
  vehicles: FitmentVehicleContext,
): AutomotiveFitmentView {
  return {
    id: row.id,
    subject: projectSubject(row),
    scope: row.scope,
    make: projectVehicleReference(vehicles.make),
    model: vehicles.model === undefined || vehicles.model === null
      ? null
      : projectVehicleReference(vehicles.model),
    generation: vehicles.generation === undefined || vehicles.generation === null
      ? null
      : projectVehicleReference(vehicles.generation),
    configuration: vehicles.configuration === undefined || vehicles.configuration === null
      ? null
      : projectVehicleReference(vehicles.configuration),
    applicability: row.applicability,
    position: row.position,
    qualifiers: row.qualifiers as readonly FitmentQualifier[],
    conditionKinds: row.conditionKinds as readonly CompatibilityConditionKind[],
    conditionNote: row.conditionNote,
    yearFrom: row.yearFrom,
    yearTo: row.yearTo,
    verification: row.verification,
    verificationMethod: row.verificationMethod,
  };
}
