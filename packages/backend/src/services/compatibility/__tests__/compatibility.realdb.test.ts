/**
 * The compatibility domain's CHECKs, generated columns, partial uniques and
 * triggers, against a REAL PostgreSQL server (#367 step 8, ADR 0007 D8).
 *
 * None of what this file asserts exists without one. A mocked insert accepts any
 * statement, including the ones the server refuses outright — so the four-valued
 * applicability, the scope ladder's row shape, the `cardinality` spelling that
 * makes the partial-condition CHECK real, the ancestry trigger and the two
 * generated keys would all be comments rather than constraints.
 *
 * ## The two it exists for
 *
 * - **`cardinality`, never `array_length`.** On an empty array `array_length`
 *   is NULL and a CHECK rejects only FALSE, so `array_length(col,1) >= 1`
 *   ADMITS `{}` — the exact row it exists to refuse. This schema has hit that
 *   twice (#68), and the first assertion below is the arithmetic itself, so the
 *   proof does not depend on somebody re-reading the constraint.
 * - **Two implications, because the states partition THREE ways.** `unresolved`
 *   must point at nothing, `selected`/`corroborating`/`conflicting` at exactly
 *   one row, and `rejected`/`superseded` at either — a claim rejected before
 *   anybody attached it never had a target. A biconditional can express two
 *   groups, so the tempting single constraint
 *   `(state = 'unresolved') = (num_nonnulls(...) = 0)` refuses exactly the
 *   rejection an operator makes on an unparseable claim. Both halves are driven
 *   below, and the mutation was measured: substituting that one constraint turns
 *   the rejection case red.
 *
 * ## A refusal is asserted with its SQLSTATE
 *
 * `expectRefusal` asserts the error class, not merely that something threw. A
 * statement failing because a column name was mistyped throws too, and a test
 * that only asserts "it threw" passes against exactly that — reporting a
 * constraint as enforced when the statement never reached it.
 *
 * ## Scoping
 *
 * The test database is SHARED across parallel files, so every fixture id
 * carries this run's suffix and the teardown deletes by those ids only, children
 * first — every foreign key here is RESTRICT, deliberately, so a wrong order
 * fails loudly rather than orphaning. `compatibility_claims` refuses DELETE by
 * trigger, so its teardown takes `withTriggerToggleLock` and its window names
 * exactly ONE table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { withTriggerToggleLock } from '../../../db/__tests__/trigger-toggle-lock.js';
import {
  canonicalProductFamilies,
  canonicalProducts,
  canonicalVariants,
} from '../../../db/schema/canonicalCatalog.js';
import {
  automotiveFitments,
  compatibilityClaims,
  genericCompatibilityRelations,
  vehicleConfigurations,
  vehicleGenerations,
  vehicleMakes,
  vehicleModels,
} from '../../../db/schema/compatibility.js';
import { relationKeyOf } from '../../../db/compatibility/compatibilityRelationRepository.js';
import { fitmentKeyOf } from '../../../db/compatibility/automotiveFitmentRepository.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const PAD = `p-pad-${RUN}`;
const PHONE = `p-phone-${RUN}`;
const CASE = `p-case-${RUN}`;
const V_PAD = `v-pad-${RUN}`;
const V_PHONE = `v-phone-${RUN}`;
const FAMILY = `f-${RUN}`;
const MK_VW = `mk-vw-${RUN}`;
const MK_FORD = `mk-ford-${RUN}`;
const MD_GOLF = `md-golf-${RUN}`;
const MD_FOCUS = `md-focus-${RUN}`;
const GN_MK7 = `gn-mk7-${RUN}`;
const CF_GTI = `cf-gti-${RUN}`;

const relationIds: string[] = [];
const fitmentIds: string[] = [];
const claimIds: string[] = [];

/** SQLSTATEs a real constraint refusal carries. Anything else is a broken test. */
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const RESTRICT_VIOLATION = '23001';

/**
 * Assert a statement is refused, and refused FOR THE RIGHT REASON.
 *
 * A drizzle error's SQLSTATE lives on `cause`, never on `error.code` — the
 * house finding, and the reason this helper exists rather than a bare
 * `rejects.toThrow()`.
 */
async function expectRefusal(
  label: string,
  run: () => Promise<unknown>,
  sqlState: string,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `${label}: was NOT refused`).toBeDefined();
  const cause = (caught as { cause?: { code?: string } }).cause;
  const code = cause?.code ?? (caught as { code?: string }).code;
  expect(code, `${label}: refused with SQLSTATE ${String(code)}, expected ${sqlState}`).toBe(
    sqlState,
  );
}

beforeAll(async () => {
  db = await connectPostgres();

  await db.insert(canonicalProductFamilies).values({
    id: FAMILY,
    slug: `fam-${RUN}`,
    name: 'Family',
    normalizedName: `fam ${RUN}`,
  });
  await db.insert(canonicalProducts).values([
    { id: PAD, slug: `pad-${RUN}`, name: 'Brake pad', normalizedName: `pad ${RUN}` },
    { id: PHONE, slug: `phone-${RUN}`, name: 'Phone', normalizedName: `phone ${RUN}` },
    { id: CASE, slug: `case-${RUN}`, name: 'Case', normalizedName: `case ${RUN}` },
  ]);
  await db.insert(canonicalVariants).values([
    { id: V_PAD, productId: PAD, signature: 'a'.repeat(64) },
    { id: V_PHONE, productId: PHONE, signature: 'b'.repeat(64) },
  ]);

  await db.insert(vehicleMakes).values([
    { id: MK_VW, key: `volkswagen_${RUN.replace(/-/g, '')}`, name: 'Volkswagen' },
    { id: MK_FORD, key: `ford_${RUN.replace(/-/g, '')}`, name: 'Ford' },
  ]);
  await db.insert(vehicleModels).values([
    { id: MD_GOLF, makeId: MK_VW, key: 'golf', name: 'Golf' },
    { id: MD_FOCUS, makeId: MK_FORD, key: 'focus', name: 'Focus' },
  ]);
  await db.insert(vehicleGenerations).values({
    id: GN_MK7,
    modelId: MD_GOLF,
    key: 'mk7',
    name: 'Mk7',
    producedFromYear: 2012,
    producedToYear: 2019,
  });
  await db.insert(vehicleConfigurations).values({
    id: CF_GTI,
    generationId: GN_MK7,
    key: 'gti',
    name: 'GTI',
    yearFrom: 2013,
    yearTo: 2019,
    fuelType: 'petrol',
    drivetrain: 'fwd',
    bodyStyle: 'hatchback',
  });
}, 120_000);

afterAll(async () => {
  if (claimIds.length > 0) {
    // The claims trigger refuses DELETE, so the window is required — and it
    // names exactly ONE table, per the trigger-toggle rule.
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table compatibility_claims disable trigger mercaria_compatibility_claims_raw_freeze`,
      );
      await tx.delete(compatibilityClaims).where(inArray(compatibilityClaims.id, claimIds));
      await tx.execute(
        sql`alter table compatibility_claims enable trigger mercaria_compatibility_claims_raw_freeze`,
      );
    });
  }
  if (fitmentIds.length > 0) {
    await db.delete(automotiveFitments).where(inArray(automotiveFitments.id, fitmentIds));
  }
  if (relationIds.length > 0) {
    await db
      .delete(genericCompatibilityRelations)
      .where(inArray(genericCompatibilityRelations.id, relationIds));
  }
  await db.delete(vehicleConfigurations).where(eq(vehicleConfigurations.id, CF_GTI));
  await db.delete(vehicleGenerations).where(eq(vehicleGenerations.id, GN_MK7));
  await db.delete(vehicleModels).where(inArray(vehicleModels.id, [MD_GOLF, MD_FOCUS]));
  await db.delete(vehicleMakes).where(inArray(vehicleMakes.id, [MK_VW, MK_FORD]));
  await db.delete(canonicalVariants).where(inArray(canonicalVariants.id, [V_PAD, V_PHONE]));
  await db.delete(canonicalProducts).where(inArray(canonicalProducts.id, [PAD, PHONE, CASE]));
  await db.delete(canonicalProductFamilies).where(eq(canonicalProductFamilies.id, FAMILY));

  await closePostgres();
});

/** Insert a relation and remember it for teardown. */
async function insertRelation(
  values: typeof genericCompatibilityRelations.$inferInsert,
): Promise<void> {
  relationIds.push(values.id ?? '');
  await db.insert(genericCompatibilityRelations).values(values);
}

async function insertFitment(values: typeof automotiveFitments.$inferInsert): Promise<void> {
  fitmentIds.push(values.id ?? '');
  await db.insert(automotiveFitments).values(values);
}

async function insertClaim(values: typeof compatibilityClaims.$inferInsert): Promise<void> {
  claimIds.push(values.id ?? '');
  await db.insert(compatibilityClaims).values(values);
}

describe('unknown is not false', () => {
  it('stores `unknown` and `does_not_apply` as different rows', async () => {
    await insertRelation({
      id: `r-unknown-${RUN}`,
      kind: 'accessory_for',
      targetKind: 'canonical_product',
      subjectProductId: CASE,
      targetProductId: PHONE,
      applicability: 'unknown',
      assertedByKind: 'operator',
    });
    await insertRelation({
      id: `r-no-${RUN}`,
      kind: 'accessory_for',
      targetKind: 'canonical_variant',
      subjectProductId: CASE,
      targetVariantId: V_PHONE,
      applicability: 'does_not_apply',
      assertedByKind: 'operator',
    });
    const rows = await db
      .select({ id: genericCompatibilityRelations.id, a: genericCompatibilityRelations.applicability })
      .from(genericCompatibilityRelations)
      .where(inArray(genericCompatibilityRelations.id, [`r-unknown-${RUN}`, `r-no-${RUN}`]));
    expect(rows.map((row) => row.a).sort()).toEqual(['does_not_apply', 'unknown']);
  });
});

describe('cardinality, never array_length', () => {
  it('proves the obvious spelling would ADMIT the row it refuses', async () => {
    // The arithmetic itself, so the proof does not depend on re-reading the
    // constraint: on `{}`, `array_length(col,1) >= 1` is NULL and a CHECK reads
    // NULL as SATISFIED.
    const [row] = await db.execute<{ wrong: boolean | null; right: boolean }>(
      sql`select (array_length('{}'::text[], 1) >= 1) as wrong, (cardinality('{}'::text[]) >= 1) as right`,
    );
    expect(row?.wrong).toBeNull();
    expect(row?.right).toBe(false);
  });

  it('refuses `partially_applies` with no condition and no note', async () => {
    await expectRefusal(
      'partially_applies with an empty condition set',
      () =>
        insertRelation({
          id: `r-badpartial-${RUN}`,
          kind: 'accessory_for',
          targetKind: 'canonical_product',
          subjectProductId: CASE,
          targetProductId: PAD,
          applicability: 'partially_applies',
          assertedByKind: 'operator',
        }),
      CHECK_VIOLATION,
    );
  });

  it('admits `partially_applies` with a condition kind', async () => {
    await insertRelation({
      id: `r-partial-${RUN}`,
      kind: 'accessory_for',
      targetKind: 'canonical_product',
      subjectProductId: CASE,
      targetProductId: PAD,
      applicability: 'partially_applies',
      conditionKinds: ['requires_adapter'],
      assertedByKind: 'operator',
    });
  });
});

describe('the target shape, per kind', () => {
  it('refuses a typed target with no key', async () => {
    await expectRefusal(
      'typed target with no key',
      () =>
        insertRelation({
          id: `r-t1-${RUN}`,
          kind: 'works_with',
          targetKind: 'typed',
          subjectProductId: CASE,
          targetType: 'connector_standard',
          applicability: 'applies',
          assertedByKind: 'operator',
        }),
      CHECK_VIOLATION,
    );
  });

  it('refuses a canonical target that ALSO carries a typed key', async () => {
    await expectRefusal(
      'two targets at once',
      () =>
        insertRelation({
          id: `r-t2-${RUN}`,
          kind: 'works_with',
          targetKind: 'canonical_product',
          subjectProductId: CASE,
          targetProductId: PHONE,
          targetType: 'connector_standard',
          targetKey: 'connector.usb_c',
          applicability: 'applies',
          assertedByKind: 'operator',
        }),
      CHECK_VIOLATION,
    );
  });

  it('admits a typed target with a namespaced key, and refuses a LABEL', async () => {
    await insertRelation({
      id: `r-typed-${RUN}`,
      kind: 'works_with',
      targetKind: 'typed',
      subjectProductId: CASE,
      targetType: 'connector_standard',
      targetKey: 'connector.usb_c',
      applicability: 'applies',
      assertedByKind: 'operator',
    });
    await expectRefusal(
      'a typed key that is a label',
      () =>
        insertRelation({
          id: `r-label-${RUN}`,
          kind: 'works_with',
          targetKind: 'typed',
          subjectProductId: PAD,
          targetType: 'connector_standard',
          targetKey: 'USB-C (male)',
          applicability: 'applies',
          assertedByKind: 'operator',
        }),
      CHECK_VIOLATION,
    );
    await expectRefusal(
      'a typed key with no namespace segment',
      () =>
        insertRelation({
          id: `r-flat-${RUN}`,
          kind: 'works_with',
          targetKind: 'typed',
          subjectProductId: PAD,
          targetType: 'connector_standard',
          targetKey: 'usbc',
          applicability: 'applies',
          assertedByKind: 'operator',
        }),
      CHECK_VIOLATION,
    );
  });

  it('requires exactly one subject', async () => {
    await expectRefusal(
      'no subject',
      () =>
        insertRelation({
          id: `r-s0-${RUN}`,
          kind: 'accessory_for',
          targetKind: 'canonical_product',
          targetProductId: PHONE,
          applicability: 'applies',
          assertedByKind: 'operator',
        }),
      CHECK_VIOLATION,
    );
    await expectRefusal(
      'two subjects',
      () =>
        insertRelation({
          id: `r-s2-${RUN}`,
          kind: 'accessory_for',
          targetKind: 'canonical_product',
          subjectProductId: CASE,
          subjectVariantId: V_PAD,
          targetProductId: PHONE,
          applicability: 'applies',
          assertedByKind: 'operator',
        }),
      CHECK_VIOLATION,
    );
  });
});

describe('the generated keys are what the repositories render', () => {
  it('relation_key matches relationKeyOf, byte for byte', async () => {
    const values = {
      id: `r-typed-${RUN}`,
      kind: 'works_with' as const,
      targetKind: 'typed' as const,
      subjectProductId: CASE,
      targetType: 'connector_standard' as const,
      targetKey: 'connector.usb_c',
      applicability: 'applies' as const,
      assertedByKind: 'operator' as const,
    };
    const [row] = await db
      .select({ key: genericCompatibilityRelations.relationKey })
      .from(genericCompatibilityRelations)
      .where(eq(genericCompatibilityRelations.id, `r-typed-${RUN}`));
    // A second spelling of a generated expression is a thing that can disagree,
    // and `openCompatibilityRelation` reads a conflicting row back with it.
    expect(row?.key).toBe(relationKeyOf(values));
    expect(row?.key).toBe(`${CASE}|||||connector_standard|connector.usb_c`);
  });
});

describe('at most one OPEN relation per (kind, endpoints)', () => {
  it('refuses a duplicate, admits another kind, and frees the slot on close', async () => {
    await expectRefusal(
      'a second open relation on the same endpoints and kind',
      () =>
        insertRelation({
          id: `r-dup-${RUN}`,
          kind: 'accessory_for',
          targetKind: 'canonical_product',
          subjectProductId: CASE,
          targetProductId: PHONE,
          applicability: 'applies',
          assertedByKind: 'operator',
        }),
      UNIQUE_VIOLATION,
    );
    await insertRelation({
      id: `r-otherkind-${RUN}`,
      kind: 'requires',
      targetKind: 'canonical_product',
      subjectProductId: CASE,
      targetProductId: PHONE,
      applicability: 'applies',
      assertedByKind: 'operator',
    });
    await db
      .update(genericCompatibilityRelations)
      .set({ validTo: new Date() })
      .where(eq(genericCompatibilityRelations.id, `r-unknown-${RUN}`));
    await insertRelation({
      id: `r-reopened-${RUN}`,
      kind: 'accessory_for',
      targetKind: 'canonical_product',
      subjectProductId: CASE,
      targetProductId: PHONE,
      applicability: 'applies',
      assertedByKind: 'operator',
    });
  });
});

describe('confidence is a machine number and a verdict is auditable', () => {
  it('refuses a confidence on an operator verdict', async () => {
    await expectRefusal(
      'operator confidence',
      () =>
        insertRelation({
          id: `r-conf-${RUN}`,
          kind: 'accessory_for',
          targetKind: 'canonical_family',
          subjectProductId: CASE,
          targetFamilyId: FAMILY,
          applicability: 'applies',
          assertedByKind: 'operator',
          confidence: 0.9,
        }),
      CHECK_VIOLATION,
    );
  });

  it('refuses a catalog_source with no source id', async () => {
    await expectRefusal(
      'sourceless catalog_source',
      () =>
        insertRelation({
          id: `r-nosrc-${RUN}`,
          kind: 'accessory_for',
          targetKind: 'canonical_family',
          subjectVariantId: V_PAD,
          targetFamilyId: FAMILY,
          applicability: 'applies',
          assertedByKind: 'catalog_source',
        }),
      CHECK_VIOLATION,
    );
  });

  it('refuses `verified` with no method', async () => {
    await expectRefusal(
      'verified with no method',
      () =>
        insertRelation({
          id: `r-v-${RUN}`,
          kind: 'accessory_for',
          targetKind: 'canonical_product',
          subjectVariantId: V_PAD,
          targetProductId: PHONE,
          applicability: 'applies',
          assertedByKind: 'operator',
          verification: 'verified',
        }),
      CHECK_VIOLATION,
    );
  });

  it('refuses a market that is not an alpha-2 code, and admits worldwide', async () => {
    await expectRefusal(
      'markets carrying `Spain`',
      () =>
        insertRelation({
          id: `r-m-${RUN}`,
          kind: 'accessory_for',
          targetKind: 'canonical_product',
          subjectVariantId: V_PAD,
          targetProductId: PHONE,
          applicability: 'applies',
          assertedByKind: 'operator',
          markets: ['Spain'],
        }),
      CHECK_VIOLATION,
    );
    await insertRelation({
      id: `r-ww-${RUN}`,
      kind: 'accessory_for',
      targetKind: 'canonical_product',
      subjectVariantId: V_PAD,
      targetProductId: PHONE,
      applicability: 'applies',
      assertedByKind: 'operator',
    });
  });

  it('refuses a product compatible with itself', async () => {
    await expectRefusal(
      'self compatibility',
      () =>
        insertRelation({
          id: `r-self-${RUN}`,
          kind: 'works_with',
          targetKind: 'canonical_product',
          subjectProductId: PAD,
          targetProductId: PAD,
          applicability: 'applies',
          assertedByKind: 'operator',
        }),
      CHECK_VIOLATION,
    );
  });
});

describe('the fitment scope ladder, and the exclusion mechanism', () => {
  it('holds each scope to its own row shape', async () => {
    await insertFitment({
      id: `f-make-${RUN}`,
      subjectProductId: PAD,
      scope: 'vehicle_make',
      vehicleMakeId: MK_VW,
      applicability: 'applies',
      position: 'front',
      assertedByKind: 'operator',
    });
    await expectRefusal(
      'a make-scoped fitment naming a model',
      () =>
        insertFitment({
          id: `f-bad1-${RUN}`,
          subjectProductId: PAD,
          scope: 'vehicle_make',
          vehicleMakeId: MK_VW,
          vehicleModelId: MD_GOLF,
          applicability: 'applies',
          position: 'rear',
          assertedByKind: 'operator',
        }),
      CHECK_VIOLATION,
    );
    // The ancestry TRIGGER fires before the CHECK, so this refusal carries the
    // trigger's own SQLSTATE. Both would refuse it; the assertion names which.
    await expectRefusal(
      'a generation-scoped fitment with no model',
      () =>
        insertFitment({
          id: `f-bad2-${RUN}`,
          subjectProductId: PAD,
          scope: 'vehicle_generation',
          vehicleMakeId: MK_VW,
          vehicleGenerationId: GN_MK7,
          applicability: 'applies',
          position: 'rear',
          assertedByKind: 'operator',
        }),
      RESTRICT_VIOLATION,
    );
  });

  it('records a broad fit and a narrow exclusion as ordinary rows', async () => {
    await insertFitment({
      id: `f-gen-${RUN}`,
      subjectProductId: PAD,
      scope: 'vehicle_generation',
      vehicleMakeId: MK_VW,
      vehicleModelId: MD_GOLF,
      vehicleGenerationId: GN_MK7,
      applicability: 'applies',
      position: 'front',
      assertedByKind: 'operator',
    });
    await insertFitment({
      id: `f-excl-${RUN}`,
      subjectProductId: PAD,
      scope: 'vehicle_configuration',
      vehicleMakeId: MK_VW,
      vehicleModelId: MD_GOLF,
      vehicleGenerationId: GN_MK7,
      vehicleConfigurationId: CF_GTI,
      applicability: 'does_not_apply',
      position: 'front',
      assertedByKind: 'operator',
    });
    // There is no `is_exclusion` column and no exclusions table — the exclusion
    // is this row, and `resolveFitment`'s specificity rule is what makes it win.
    const rows = await db
      .select({ a: automotiveFitments.applicability, s: automotiveFitments.scope })
      .from(automotiveFitments)
      .where(inArray(automotiveFitments.id, [`f-gen-${RUN}`, `f-excl-${RUN}`]));
    expect(rows.length).toBe(2);
  });
});

describe('the ancestry trigger — the denormalized make cannot disagree', () => {
  it('refuses a Ford make on a Golf model', async () => {
    await expectRefusal(
      'cross-make fitment',
      () =>
        insertFitment({
          id: `f-cross-${RUN}`,
          subjectProductId: PAD,
          scope: 'vehicle_model',
          vehicleMakeId: MK_FORD,
          vehicleModelId: MD_GOLF,
          applicability: 'applies',
          position: 'rear',
          assertedByKind: 'operator',
        }),
      RESTRICT_VIOLATION,
    );
  });

  it('refuses a configuration under the wrong generation', async () => {
    await expectRefusal(
      'cross-generation fitment',
      () =>
        insertFitment({
          id: `f-cross2-${RUN}`,
          subjectProductId: PAD,
          scope: 'vehicle_configuration',
          vehicleMakeId: MK_FORD,
          vehicleModelId: MD_FOCUS,
          vehicleGenerationId: GN_MK7,
          vehicleConfigurationId: CF_GTI,
          applicability: 'applies',
          position: 'rear',
          assertedByKind: 'operator',
        }),
      RESTRICT_VIOLATION,
    );
  });
});

describe('fitment_key: position is IN it, qualifiers are not', () => {
  it('admits a second position and refuses a qualifier-only duplicate', async () => {
    await insertFitment({
      id: `f-genrear-${RUN}`,
      subjectProductId: PAD,
      scope: 'vehicle_generation',
      vehicleMakeId: MK_VW,
      vehicleModelId: MD_GOLF,
      vehicleGenerationId: GN_MK7,
      applicability: 'applies',
      position: 'rear',
      assertedByKind: 'operator',
    });
    await expectRefusal(
      'a duplicate differing only by a qualifier',
      () =>
        insertFitment({
          id: `f-gendup-${RUN}`,
          subjectProductId: PAD,
          scope: 'vehicle_generation',
          vehicleMakeId: MK_VW,
          vehicleModelId: MD_GOLF,
          vehicleGenerationId: GN_MK7,
          applicability: 'applies',
          position: 'front',
          qualifiers: ['heavy_duty'],
          assertedByKind: 'operator',
        }),
      UNIQUE_VIOLATION,
    );
  });

  it('fitment_key matches fitmentKeyOf, byte for byte', async () => {
    const values = {
      subjectProductId: PAD,
      scope: 'vehicle_generation' as const,
      vehicleMakeId: MK_VW,
      vehicleModelId: MD_GOLF,
      vehicleGenerationId: GN_MK7,
      applicability: 'applies' as const,
      position: 'front' as const,
      assertedByKind: 'operator' as const,
    };
    const [row] = await db
      .select({ key: automotiveFitments.fitmentKey })
      .from(automotiveFitments)
      .where(eq(automotiveFitments.id, `f-gen-${RUN}`));
    expect(row?.key).toBe(fitmentKeyOf(values));
    expect(row?.key).toBe(`${PAD}||${MK_VW}|${MD_GOLF}|${GN_MK7}||front`);
  });

  it('requires the digest beside a manufacturer publication', async () => {
    await expectRefusal(
      'manufacturer_publication with no digest',
      () =>
        insertFitment({
          id: `f-mfr-${RUN}`,
          subjectProductId: CASE,
          scope: 'vehicle_make',
          vehicleMakeId: MK_VW,
          applicability: 'applies',
          position: 'not_applicable',
          assertedByKind: 'manufacturer',
          verification: 'verified',
          verificationMethod: 'manufacturer_publication',
          verifiedAt: new Date(),
          verifiedByOxyUserId: `oxy-${RUN}`,
          manufacturerPublicationUrl: 'https://example.invalid/f',
        }),
      CHECK_VIOLATION,
    );
    await insertFitment({
      id: `f-mfr2-${RUN}`,
      subjectProductId: CASE,
      scope: 'vehicle_make',
      vehicleMakeId: MK_VW,
      applicability: 'applies',
      position: 'not_applicable',
      assertedByKind: 'manufacturer',
      verification: 'verified',
      verificationMethod: 'manufacturer_publication',
      verifiedAt: new Date(),
      verifiedByOxyUserId: `oxy-${RUN}`,
      manufacturerPublicationUrl: 'https://example.invalid/f',
      contentSha256: 'a'.repeat(64),
    });
  });
});

describe('a vehicle key is frozen (ADR 0007 D1 rule 2)', () => {
  it('refuses a rename and admits a name change', async () => {
    await expectRefusal(
      'renaming a make key',
      () => db.update(vehicleMakes).set({ key: 'vw' }).where(eq(vehicleMakes.id, MK_VW)),
      RESTRICT_VIOLATION,
    );
    await expectRefusal(
      'renaming a configuration key',
      () =>
        db
          .update(vehicleConfigurations)
          .set({ key: 'gti2' })
          .where(eq(vehicleConfigurations.id, CF_GTI)),
      RESTRICT_VIOLATION,
    );
    // The NAME is presentation and moves freely — that is the whole distinction
    // the freeze exists to make.
    await db.update(vehicleMakes).set({ name: 'Volkswagen AG' }).where(eq(vehicleMakes.id, MK_VW));
  });

  it('refuses a key that is a LABEL, and a year outside the vehicle range', async () => {
    await expectRefusal(
      'a make key that is a label',
      () => db.insert(vehicleMakes).values({ id: `mk-x-${RUN}`, key: 'Volkswagen', name: 'VW' }),
      CHECK_VIOLATION,
    );
    await expectRefusal(
      'a generation produced in 1200',
      () =>
        db.insert(vehicleGenerations).values({
          id: `gn-x-${RUN}`,
          modelId: MD_GOLF,
          key: 'x',
          name: 'X',
          producedFromYear: 1200,
        }),
      CHECK_VIOLATION,
    );
  });
});

describe('claims: the source keeps its own words (ADR 0007 D7)', () => {
  it('stores an UNRESOLVED claim pointing at nothing', async () => {
    await insertClaim({
      id: `c-unres-${RUN}`,
      rawTargetText: 'Golf Mk7 2.0 TDI 2013-2016',
      state: 'unresolved',
      unresolvedReason: 'unparsed_target',
      assertedByKind: 'merchant',
      observedAt: new Date(),
    });
  });

  it('refuses an unresolved claim that points somewhere', async () => {
    await expectRefusal(
      'unresolved claim with a relation',
      () =>
        insertClaim({
          id: `c-bad1-${RUN}`,
          rawTargetText: 'x',
          state: 'unresolved',
          unresolvedReason: 'unparsed_target',
          relationId: `r-typed-${RUN}`,
          assertedByKind: 'merchant',
          observedAt: new Date(),
        }),
      CHECK_VIOLATION,
    );
  });

  /**
   * THE case the two-implication spelling exists for.
   *
   * `(state = 'selected') = (relation_id is not null or fitment_id is not null)`
   * is satisfied when BOTH sides are false — so the obvious biconditional over
   * the conjunction admits exactly this row. Two separate implications refuse it.
   */
  it('refuses a SELECTED claim that points at nothing', async () => {
    await expectRefusal(
      'selected claim with no target',
      () =>
        insertClaim({
          id: `c-bad2-${RUN}`,
          rawTargetText: 'x',
          state: 'selected',
          assertedByKind: 'merchant',
          observedAt: new Date(),
        }),
      CHECK_VIOLATION,
    );
  });

  it('refuses a resolved claim still carrying an unresolved reason', async () => {
    await expectRefusal(
      'resolved claim with a reason',
      () =>
        insertClaim({
          id: `c-bad3-${RUN}`,
          rawTargetText: 'x',
          state: 'selected',
          unresolvedReason: 'unparsed_target',
          relationId: `r-typed-${RUN}`,
          assertedByKind: 'merchant',
          observedAt: new Date(),
        }),
      CHECK_VIOLATION,
    );
  });

  it('refuses a claim pointing at both a relation and a fitment', async () => {
    await expectRefusal(
      'two targets',
      () =>
        insertClaim({
          id: `c-bad4-${RUN}`,
          rawTargetText: 'x',
          state: 'selected',
          relationId: `r-typed-${RUN}`,
          fitmentId: `f-gen-${RUN}`,
          assertedByKind: 'merchant',
          observedAt: new Date(),
        }),
      CHECK_VIOLATION,
    );
  });

  it('holds at most ONE selected claim per relation, and admits corroboration', async () => {
    await insertClaim({
      id: `c-sel-${RUN}`,
      rawTargetText: 'USB-C',
      state: 'selected',
      relationId: `r-typed-${RUN}`,
      assertedByKind: 'merchant',
      observedAt: new Date(),
    });
    await expectRefusal(
      'a second selected claim',
      () =>
        insertClaim({
          id: `c-sel2-${RUN}`,
          rawTargetText: 'usb c',
          state: 'selected',
          relationId: `r-typed-${RUN}`,
          assertedByKind: 'merchant',
          observedAt: new Date(),
        }),
      UNIQUE_VIOLATION,
    );
    await insertClaim({
      id: `c-corr-${RUN}`,
      rawTargetText: 'usb c',
      state: 'corroborating',
      relationId: `r-typed-${RUN}`,
      assertedByKind: 'merchant',
      observedAt: new Date(),
    });
  });

  it('freezes what the source said and permits what Mercaria decided', async () => {
    await expectRefusal(
      'rewriting the raw target text',
      () =>
        db
          .update(compatibilityClaims)
          .set({ rawTargetText: 'something else' })
          .where(eq(compatibilityClaims.id, `c-unres-${RUN}`)),
      RESTRICT_VIOLATION,
    );
    await expectRefusal(
      'deleting a claim',
      () => db.delete(compatibilityClaims).where(eq(compatibilityClaims.id, `c-unres-${RUN}`)),
      RESTRICT_VIOLATION,
    );
    // The resolution and the review move freely — which is what makes the freeze
    // a freeze on EVIDENCE rather than on the row.
    await db
      .update(compatibilityClaims)
      .set({
        state: 'rejected',
        unresolvedReason: null,
        reviewedByOxyUserId: `oxy-${RUN}`,
        reviewedAt: new Date(),
      })
      .where(eq(compatibilityClaims.id, `c-unres-${RUN}`));
  });

  it('refuses a rejection with no actor', async () => {
    await expectRefusal(
      'unattributed rejection',
      () =>
        insertClaim({
          id: `c-rej-${RUN}`,
          rawTargetText: 'x',
          state: 'rejected',
          assertedByKind: 'merchant',
          observedAt: new Date(),
        }),
      CHECK_VIOLATION,
    );
  });
});

describe('RESTRICT: a canonical product cannot vanish under a fitment', () => {
  it('refuses the delete rather than orphaning the claim', async () => {
    await expectRefusal(
      'deleting a cited canonical product',
      () => db.delete(canonicalProducts).where(eq(canonicalProducts.id, PAD)),
      '23503',
    );
  });
});
