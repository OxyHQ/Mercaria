/**
 * The PUBLIC compatibility read surface, against a real Postgres server (#367
 * step 8, ADR 0007 D8).
 *
 * ## Why this file exists beside `compatibility.realdb.test.ts`
 *
 * That file proves the SCHEMA refuses what it must — the CHECKs, the generated
 * keys, the ancestry trigger, the partial uniques. This one proves the READ
 * publishes what it must and withholds what it must, which is a different
 * property and the one a shopper meets. The three things it is really about:
 *
 * 1. **The publication policy's ASYMMETRY, `disputed` included.** A claim that a
 *    part FITS publishes only at `verified`, so a `candidate` or a `disputed` one
 *    is withheld; a claim that it does NOT fit publishes from `verified`,
 *    `candidate` AND `disputed`, because it is a caution and suppressing it sells
 *    the part in the meantime. Two files used to describe `disputed` as publishing
 *    nothing either way while the tuple published a disputed negative, and nothing
 *    tested the sentence — so it is pinned in both directions here.
 * 2. **`truncated` is measured on what the QUERY examined, not on what survived
 *    the policy.** The natural implementation filters and then compares the length
 *    against the limit, which reports NOT truncated exactly when the discarded row
 *    was one the policy withheld — a page claiming to be complete because part of
 *    it was suppressed. There is a case below that fails on that spelling.
 * 3. **A vehicle named at ANY rung resolves.** `answerFitment` used to widen only
 *    from a configuration, so a make-only question — most of the picker's states —
 *    left the verdict's vehicle records empty, and the projection then dropped
 *    every statement it was built from. The verdict said `determined` and the
 *    evidence list was empty, with nothing anywhere reporting it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { COMPATIBILITY_FORBIDDEN_VIEW_FIELDS } from '@mercaria/shared-types';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import {
  automotiveFitments,
  genericCompatibilityRelations,
  vehicleConfigurations,
  vehicleGenerations,
  vehicleMakes,
  vehicleModels,
} from '../../../db/schema/compatibility.js';
import { readCompatibilityRelationPage } from '../compatibility.service.js';
import { answerFitment, listPublishedVehiclesForPart } from '../fitment.service.js';
import {
  projectCompatibilityRelations,
  projectFitmentVerdict,
  projectPartFitments,
} from '../projection.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const KEY = RUN.replace(/-/g, '');

const PAD = `pr-pad-${RUN}`;
const PHONE = `pr-phone-${RUN}`;
const CASE = `pr-case-${RUN}`;
const V_PAD = `pr-vpad-${RUN}`;
const MK = `pr-mk-${RUN}`;
const MD = `pr-md-${RUN}`;
const GN = `pr-gn-${RUN}`;
const CF = `pr-cf-${RUN}`;

const relationIds: string[] = [];
const fitmentIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();

  await db.insert(canonicalProducts).values([
    { id: PAD, slug: `pr-pad-${RUN}`, name: 'Brake pad', normalizedName: `pr pad ${RUN}` },
    { id: PHONE, slug: `pr-phone-${RUN}`, name: 'Phone', normalizedName: `pr phone ${RUN}` },
    { id: CASE, slug: `pr-case-${RUN}`, name: 'Case', normalizedName: `pr case ${RUN}` },
  ]);
  await db.insert(canonicalVariants).values({
    id: V_PAD,
    productId: PAD,
    signature: 'c'.repeat(64),
  });

  await db.insert(vehicleMakes).values({ id: MK, key: `seat_${KEY}`, name: 'SEAT' });
  await db.insert(vehicleModels).values({ id: MD, makeId: MK, key: 'leon', name: 'León' });
  await db.insert(vehicleGenerations).values({
    id: GN,
    modelId: MD,
    key: 'mk3',
    name: 'Mk3',
    producedFromYear: 2012,
    producedToYear: 2020,
  });
  await db.insert(vehicleConfigurations).values({
    id: CF,
    generationId: GN,
    key: 'cupra',
    name: 'Cupra 290',
    yearFrom: 2015,
    yearTo: 2020,
  });
}, 120_000);

afterAll(async () => {
  if (fitmentIds.length > 0) {
    await db.delete(automotiveFitments).where(inArray(automotiveFitments.id, fitmentIds));
  }
  if (relationIds.length > 0) {
    await db
      .delete(genericCompatibilityRelations)
      .where(inArray(genericCompatibilityRelations.id, relationIds));
  }
  await db.delete(vehicleConfigurations).where(eq(vehicleConfigurations.id, CF));
  await db.delete(vehicleGenerations).where(eq(vehicleGenerations.id, GN));
  await db.delete(vehicleModels).where(eq(vehicleModels.id, MD));
  await db.delete(vehicleMakes).where(eq(vehicleMakes.id, MK));
  // Through the helper, never a bare delete: a sibling file's matcher run can
  // record a `match_decisions` row citing these products, and both citing columns
  // are `ON DELETE restrict`.
  await deleteTestCanonicalRows(db, { variantIds: [V_PAD] });
  await deleteTestCanonicalRows(db, { productIds: [PAD, PHONE, CASE] });
  await closePostgres();
});

async function insertRelation(
  values: typeof genericCompatibilityRelations.$inferInsert,
): Promise<void> {
  relationIds.push(values.id ?? '');
  await db.insert(genericCompatibilityRelations).values(values);
}

/**
 * What a `verified` manufacturer fitment must carry, per two real CHECKs.
 *
 * `automotive_fitments_verified_state_check` wants the method, the instant and the
 * operator; `automotive_fitments_manufacturer_evidence_check` wants the
 * publication URL and a content digest of it. Written once because the two rows
 * below differ only in their applicability, and repeating six columns twice is how
 * one of them quietly stops being verified.
 */
const VERIFIED_BY_PUBLICATION = {
  verification: 'verified',
  verificationMethod: 'manufacturer_publication',
  verifiedAt: new Date('2026-01-02T00:00:00.000Z'),
  verifiedByOxyUserId: `oxy-${RUN}`,
  assertedByKind: 'manufacturer',
  manufacturerPublicationUrl: 'https://example.invalid/fitment-guide',
  contentSha256: 'd'.repeat(64),
} as const;

async function insertFitment(values: typeof automotiveFitments.$inferInsert): Promise<void> {
  fitmentIds.push(values.id ?? '');
  await db.insert(automotiveFitments).values(values);
}

/** Every key of a nested projection, so a forbidden field cannot hide one level down. */
function everyKey(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) everyKey(entry, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      everyKey(child, found);
    }
  }
  return found;
}

describe('the publication policy, read back through the real predicate', () => {
  beforeAll(async () => {
    // A `case fits phone` claim nobody reviewed. Positive + `candidate` ⇒ withheld.
    await insertRelation({
      id: `pr-r-cand-${RUN}`,
      kind: 'accessory_for',
      direction: 'subject_to_target',
      subjectProductId: CASE,
      targetKind: 'canonical_product',
      targetProductId: PHONE,
      applicability: 'applies',
      verification: 'candidate',
      assertedByKind: 'matcher',
      confidence: 0.97,
    });
    // The same shape, verified. Positive + `verified` ⇒ published.
    await insertRelation({
      id: `pr-r-ok-${RUN}`,
      kind: 'accessory_for',
      direction: 'subject_to_target',
      subjectProductId: PAD,
      targetKind: 'canonical_product',
      targetProductId: PHONE,
      applicability: 'applies',
      verification: 'verified',
      // `generic_compatibility_relations_verified_state_check` requires the method,
      // the instant AND the operator together: a `verified` row with nobody behind
      // it is exactly the unattributable claim the state exists to rule out.
      verificationMethod: 'manufacturer_publication',
      verifiedAt: new Date('2026-01-02T00:00:00.000Z'),
      verifiedByOxyUserId: `oxy-${RUN}`,
      assertedByKind: 'manufacturer',
    });
    // A NEGATIVE claim nobody reviewed. Published, deliberately.
    await insertRelation({
      id: `pr-r-neg-${RUN}`,
      kind: 'accessory_for',
      direction: 'subject_to_target',
      subjectProductId: CASE,
      targetKind: 'canonical_variant',
      targetVariantId: V_PAD,
      applicability: 'does_not_apply',
      verification: 'candidate',
      assertedByKind: 'matcher',
      confidence: 0.4,
    });
    // Two sourced parties contradicting each other. Neither direction publishes.
    await insertRelation({
      id: `pr-r-disp-${RUN}`,
      kind: 'accessory_for',
      direction: 'subject_to_target',
      subjectProductId: PHONE,
      targetKind: 'canonical_product',
      targetProductId: CASE,
      applicability: 'does_not_apply',
      verification: 'disputed',
      assertedByKind: 'merchant',
    });
  });

  it('withholds an unreviewed POSITIVE and publishes an unreviewed NEGATIVE', async () => {
    const forward = await readCompatibilityRelationPage(
      { lookup: 'subject', subject: { kind: 'canonical_product', productId: CASE } },
      { limit: 50 },
    );
    const ids = forward.relations.map((row) => row.id);
    expect(ids, 'an unreviewed claim that a part FITS must not be published').not.toContain(
      `pr-r-cand-${RUN}`,
    );
    expect(ids, 'an unreviewed claim that a part does NOT fit is the cheap thing to say').toContain(
      `pr-r-neg-${RUN}`,
    );
    // The positive control: the read found rows at all, so the assertion above is
    // not passing because the query matched nothing.
    expect(forward.relations.length).toBeGreaterThan(0);
  });

  it('publishes a disputed NEGATIVE as a caution, in both directions', async () => {
    const forward = await readCompatibilityRelationPage(
      { lookup: 'subject', subject: { kind: 'canonical_product', productId: PHONE } },
      { limit: 50 },
    );
    expect(forward.relations.map((row) => row.id)).toContain(`pr-r-disp-${RUN}`);
    const reverse = await readCompatibilityRelationPage(
      { lookup: 'target', target: { kind: 'canonical_product', productId: CASE } },
      { limit: 50 },
    );
    expect(reverse.relations.map((row) => row.id)).toContain(`pr-r-disp-${RUN}`);
  });

  it('withholds a disputed POSITIVE — picking a side there is picking the sale', async () => {
    // The other half of the same rule, and the one that must never publish: two
    // sourced parties disagree about whether this fits, so rendering either is
    // choosing the reading somebody spends money on.
    await insertRelation({
      id: `pr-r-disp-pos-${RUN}`,
      kind: 'accessory_for',
      direction: 'subject_to_target',
      subjectProductId: PHONE,
      targetKind: 'canonical_variant',
      targetVariantId: V_PAD,
      applicability: 'applies',
      verification: 'disputed',
      assertedByKind: 'merchant',
    });
    const forward = await readCompatibilityRelationPage(
      { lookup: 'subject', subject: { kind: 'canonical_product', productId: PHONE } },
      { limit: 50 },
    );
    expect(forward.relations.map((row) => row.id)).not.toContain(`pr-r-disp-pos-${RUN}`);
    // The positive control: this same read DOES publish the disputed negative
    // above, so the assertion is about the applicability and not about the read
    // having returned nothing.
    expect(forward.relations.map((row) => row.id)).toContain(`pr-r-disp-${RUN}`);
  });

  it('answers the REVERSE lookup from the same rows — "what fits this phone"', async () => {
    const reverse = await readCompatibilityRelationPage(
      { lookup: 'target', target: { kind: 'canonical_product', productId: PHONE } },
      { limit: 50 },
    );
    expect(reverse.relations.map((row) => row.id)).toEqual([`pr-r-ok-${RUN}`]);
    // And the direction travels to the DTO, so an empty forward page and an empty
    // reverse page cannot render under each other's heading.
    expect(projectCompatibilityRelations('target', reverse.relations, 50, false).lookup).toBe(
      'target',
    );
  });

  /**
   * The one that fails on the natural spelling.
   *
   * `CASE` has three relations, one of which the policy withholds. Read with a
   * limit of 2 the query examines 3 (the `limit + 1` probe), so the bound WAS
   * reached — but only one row survives the filter. An implementation that
   * compared the surviving length against the limit reports `truncated: false`
   * here, which is a page claiming to be complete because part of it was
   * suppressed.
   */
  it('measures truncation on what the query examined, not on what survived', async () => {
    const page = await readCompatibilityRelationPage(
      { lookup: 'subject', subject: { kind: 'canonical_product', productId: CASE } },
      { limit: 1 },
    );
    expect(page.examinedLimit).toBe(1);
    expect(page.truncated, 'the bound was reached; the page is not complete').toBe(true);
    expect(page.relations.length).toBeLessThanOrEqual(1);
  });

  it('emits no forbidden provenance field, at any depth of the envelope', async () => {
    const page = await readCompatibilityRelationPage(
      { lookup: 'subject', subject: { kind: 'canonical_product', productId: CASE } },
      { limit: 50 },
    );
    const view = projectCompatibilityRelations('subject', page.relations, 50, page.truncated);
    const keys = everyKey(view);
    // The positive control FIRST: a walk over an empty envelope would pass every
    // assertion below, and the rows are what make it a real walk.
    expect(view.relations.length).toBeGreaterThan(0);
    expect(keys.size).toBeGreaterThanOrEqual(15);
    for (const field of COMPATIBILITY_FORBIDDEN_VIEW_FIELDS) {
      expect([...keys], `the relations envelope carries \`${field}\``).not.toContain(field);
    }
  });
});

describe('a vehicle named at any rung resolves, and the statements survive it', () => {
  beforeAll(async () => {
    // Make-scoped: the pad fits every SEAT.
    await insertFitment({
      id: `pr-f-make-${RUN}`,
      subjectVariantId: V_PAD,
      scope: 'vehicle_make',
      vehicleMakeId: MK,
      applicability: 'applies',
      position: 'front',
      ...VERIFIED_BY_PUBLICATION,
      observedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // …except the Cupra, which takes a different caliper. The narrower scope wins.
    await insertFitment({
      id: `pr-f-conf-${RUN}`,
      subjectVariantId: V_PAD,
      scope: 'vehicle_configuration',
      vehicleMakeId: MK,
      vehicleModelId: MD,
      vehicleGenerationId: GN,
      vehicleConfigurationId: CF,
      applicability: 'does_not_apply',
      position: 'front',
      ...VERIFIED_BY_PUBLICATION,
      observedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('answers a MAKE-only question with the make row and its statements', async () => {
    const answer = await answerFitment({
      subject: { kind: 'canonical_variant', variantId: V_PAD },
      vehicle: { makeId: MK },
    });
    expect(answer.verdict).toEqual({
      outcome: 'determined',
      applicability: 'applies',
      decidedAtScope: 'vehicle_make',
    });
    // The regression this file names in its header: the make row must be RESOLVED,
    // because the projection needs it to name the vehicle and drops any statement
    // it cannot name.
    expect(answer.vehicle.make?.name).toBe('SEAT');
    expect(answer.vehicle.model, 'nothing was said about a model').toBeNull();

    const view = projectFitmentVerdict(
      { kind: 'canonical_variant', variantId: V_PAD },
      answer,
      null,
    );
    expect(view.statements.length, 'a make-only verdict must still cite its evidence').toBe(1);
    expect(view.statements[0]?.make).toEqual({ id: MK, key: `seat_${KEY}`, name: 'SEAT' });
    expect(view.vehicle.make?.name).toBe('SEAT');
    expect(view.year).toBeNull();
  });

  it('widens a MODEL to its make, and still refuses to invent a generation', async () => {
    const answer = await answerFitment({
      subject: { kind: 'canonical_variant', variantId: V_PAD },
      vehicle: { makeId: MK, modelId: MD },
    });
    expect(answer.vehicle.make?.id).toBe(MK);
    expect(answer.vehicle.model?.name).toBe('León');
    expect(answer.vehicle.generation, 'nobody named a generation').toBeNull();
    expect(answer.vehicle.configuration).toBeNull();
  });

  it('lets the narrowest scope decide — the exclusion mechanism, end to end', async () => {
    const answer = await answerFitment({
      subject: { kind: 'canonical_variant', variantId: V_PAD },
      vehicle: { configurationId: CF },
      year: 2017,
    });
    expect(answer.verdict).toEqual({
      outcome: 'determined',
      applicability: 'does_not_apply',
      decidedAtScope: 'vehicle_configuration',
    });
    // Both statements contributed to the read; the narrower one decided.
    expect(answer.statements.length).toBe(2);
    expect(answer.vehicle.configuration?.name).toBe('Cupra 290');
  });

  it('re-reads the ancestry rather than trusting a caller who named the wrong model', async () => {
    // A configuration under this generation, with somebody ELSE's model claimed
    // beside it. The resolver overrides the claim, so the answer is about the real
    // car — where trusting the caller would gather a foreign model's exclusions.
    const answer = await answerFitment({
      subject: { kind: 'canonical_variant', variantId: V_PAD },
      vehicle: { makeId: MK, modelId: `pr-not-a-model-${RUN}`, configurationId: CF },
    });
    expect(answer.vehicle.model?.id).toBe(MD);
    expect(answer.verdict).toEqual({
      outcome: 'determined',
      applicability: 'does_not_apply',
      decidedAtScope: 'vehicle_configuration',
    });
  });

  it('answers `unknown` for a car this catalogue does not have', async () => {
    const answer = await answerFitment({
      subject: { kind: 'canonical_variant', variantId: V_PAD },
      vehicle: { makeId: `pr-no-such-make-${RUN}` },
    });
    // Not `does_not_apply`: Mercaria knowing nothing about a vehicle is not a
    // statement about the part.
    expect(answer.verdict).toEqual({ outcome: 'unknown' });
    expect(answer.statements).toEqual([]);
    expect(answer.vehicle.make).toBeNull();
  });
});

describe('the part’s own vehicle list', () => {
  it('carries the vehicle NAMES and keeps the exclusion in the list', async () => {
    const page = await listPublishedVehiclesForPart(
      { kind: 'canonical_variant', variantId: V_PAD },
      50,
    );
    const view = projectPartFitments(
      { kind: 'canonical_variant', variantId: V_PAD },
      page.fitments,
      page.examinedLimit,
      page.truncated,
    );
    expect(view.fitments.length).toBe(2);
    // The names come from the joined vehicle rows, not from a second lookup.
    expect(view.fitments.every((row) => row.make.name === 'SEAT')).toBe(true);
    const applicabilities = view.fitments.map((row) => row.applicability).sort();
    expect(applicabilities, 'an exclusion is information, not a row to hide').toEqual([
      'applies',
      'does_not_apply',
    ]);
    // The configuration-scoped row names its whole ancestry; the make-scoped one
    // names only the make, because that is what the row says.
    const scoped = view.fitments.find((row) => row.scope === 'vehicle_configuration');
    expect(scoped?.configuration?.name).toBe('Cupra 290');
    const broad = view.fitments.find((row) => row.scope === 'vehicle_make');
    expect(broad?.model, 'a make-scoped fitment names no model').toBeNull();
    expect(view.truncated).toBe(false);
  });

  it('reports truncation from the query bound, and emits no forbidden field', async () => {
    const page = await listPublishedVehiclesForPart(
      { kind: 'canonical_variant', variantId: V_PAD },
      1,
    );
    expect(page.truncated).toBe(true);
    const view = projectPartFitments(
      { kind: 'canonical_variant', variantId: V_PAD },
      page.fitments,
      page.examinedLimit,
      page.truncated,
    );
    const keys = everyKey(view);
    expect(view.fitments.length).toBeGreaterThan(0);
    expect(keys.size).toBeGreaterThanOrEqual(15);
    for (const field of COMPATIBILITY_FORBIDDEN_VIEW_FIELDS) {
      expect([...keys], `the fitments envelope carries \`${field}\``).not.toContain(field);
    }
  });
});
