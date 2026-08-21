/**
 * The two fitment boundaries a year and a nameplate cannot decide — overlapping
 * generations and ambiguous engine codes (#820, epic #367's "Automotive
 * fitment" box, ADR 0007 D1/D8).
 *
 * `compatibility.realdb.test.ts` proves the SCHEMA refuses what it must and
 * `compatibility-public-read.realdb.test.ts` proves the publication policy
 * publishes and withholds what it must. Neither builds a vehicle tree in which
 * the two facts that actually put a part on the wrong car are present, so
 * neither can fail when they stop being distinguished:
 *
 * 1. **Two generations whose production windows OVERLAP.** A model year alone
 *    cannot select a generation — that is the sentence D8 gives for why a year
 *    is a configuration property and never a variant option — and the only way
 *    to prove the read agrees is to ask it about a year that is inside BOTH and
 *    check that each generation answers for itself.
 *
 *    Two halves of this were ALREADY covered on `main` and this file does not
 *    claim them: `verticals-brake-pad.realdb.test.ts` derives the overlap
 *    arithmetically from the stored production windows and drives
 *    `listVehicleConfigurations` at a year inside both, and
 *    `verticals-package-controls.test.ts` asserts the seed package holds at
 *    least two overlapping pairs across at least two models. What no file
 *    reached is the FITMENT VERDICT across that boundary. Measured at
 *    `9c5268d7`: exactly ONE `answerFitment` call in the whole repository
 *    passed a `year` at all — `compatibility-public-read.realdb.test.ts:410`,
 *    `year: 2017`, naming one generation — so no case anywhere asked the
 *    resolver a question a year could answer wrongly.
 * 2. **Two configurations of one generation sharing a name and a trim and
 *    differing only in `engineCode`.** `engineCode` appeared ZERO times in any
 *    `*.test.ts` in the repository before this file, while being a real column
 *    written by `db/compatibility/vehicleCatalogRepository.ts` and by three
 *    `scripts/seed-verticals/` modules. No fixture anywhere held two
 *    configurations of ONE generation under one nameplate — the seed's repeated
 *    names (`320i`, `GTI`, `2.0 TDI`) each sit in different generations, which
 *    the generation id already separates. This is a FALSE MERGE hazard of the
 *    kind #58 is shaped around: collapsing the pair looks exactly like a correct
 *    match, every page still renders, and it is discovered by a customer who
 *    bought the wrong brake pad.
 *
 * ## What was measured, and what it says about the code
 *
 * Both cases are GREEN against the resolver as it stands. That is the finding
 * rather than a disappointment: the tests were missing and the behaviour was
 * already right, because `listFitmentsForVehicle` pairs every SCOPE with its own
 * id and `upsertVehicleConfiguration` keys on the stable machine KEY rather than
 * on the name. Neither property had a case that could fail, and each is one edit
 * from being lost — so each is mutation-tested rather than asserted to be
 * careful. The four code mutations, the two fixture self-tests and their exit
 * codes are recorded in PR #842.
 *
 * The fixtures are ADVERSE and say so: the overlap is re-derived arithmetically
 * from the stored production windows, and the ambiguous pair is asserted to
 * agree on every discriminating column the picker could have used instead. A
 * later reader who "tidies" the fixture by giving the two configurations
 * different names turns the control red rather than quietly leaving two cases
 * that measure nothing.
 *
 * ## Scoping
 *
 * The test database is SHARED across parallel files, so every fixture id carries
 * this run's suffix and the teardown deletes by those ids only, children first —
 * every foreign key in this domain is RESTRICT, deliberately, so a wrong order
 * fails loudly rather than orphaning. The canonical rows go through
 * `deleteTestCanonicalRows` and never a bare delete: the matcher's retrieval is
 * a global trigram scan, so a sibling file can record a `match_decisions` row
 * citing these products and both citing columns are `ON DELETE restrict`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import {
  automotiveFitments,
  vehicleConfigurations,
  vehicleGenerations,
  vehicleMakes,
  vehicleModels,
} from '../../../db/schema/compatibility.js';
import {
  listVehicleConfigurations,
  upsertVehicleConfiguration,
  type VehicleConfigurationRow,
} from '../../../db/compatibility/vehicleCatalogRepository.js';
import { answerFitment, listPublishedVehiclesForPart } from '../fitment.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const KEY = RUN.replace(/-/g, '');

const PAD = `fb-pad-${RUN}`;
const V_PAD = `fb-vpad-${RUN}`;
const MK = `fb-mk-${RUN}`;
const MD = `fb-md-${RUN}`;
/** The two generations whose production windows overlap. */
const GN_EARLY = `fb-gn-early-${RUN}`;
const GN_LATE = `fb-gn-late-${RUN}`;
/** One configuration per generation, sharing a nameplate ACROSS the boundary. */
const CF_EARLY = `fb-cf-early-${RUN}`;
const CF_LATE = `fb-cf-late-${RUN}`;
/** The ambiguous pair: one generation, one nameplate, two engines. */
const CF_ENGINE_A = `fb-cf-eng-a-${RUN}`;
const CF_ENGINE_B = `fb-cf-eng-b-${RUN}`;

/**
 * The overlap, written once as data so the fixture and the assertions cannot
 * drift apart, and re-derived from the STORED rows in the first case below.
 *
 * `EARLY` ran 2012–2019 and `LATE` from 2018, so 2018 and 2019 are years in
 * which a shopper's answer to "which one is mine" is the only thing that
 * separates two different cars with different brakes.
 */
const EARLY_FROM = 2012;
const EARLY_TO = 2019;
const LATE_FROM = 2018;
const LATE_TO = 2024;
/** A year inside BOTH production windows. Every overlap case is asked at this year. */
const OVERLAP_YEAR = 2018;

const configurationIds = [CF_EARLY, CF_LATE, CF_ENGINE_A, CF_ENGINE_B];
const fitmentIds: string[] = [];

/**
 * What a `verified` manufacturer fitment must carry, per two real CHECKs.
 *
 * `automotive_fitments_verified_state_check` wants the method, the instant and
 * the operator; `automotive_fitments_manufacturer_evidence_check` wants the
 * publication URL and a content digest of it. Written once because the rows
 * below differ only in their target, and repeating six columns is how one of
 * them quietly stops being verified — which would withhold it from the public
 * read and make a case pass for the wrong reason.
 */
const VERIFIED_BY_PUBLICATION = {
  verification: 'verified',
  verificationMethod: 'manufacturer_publication',
  verifiedAt: new Date('2026-02-03T00:00:00.000Z'),
  verifiedByOxyUserId: `oxy-${RUN}`,
  assertedByKind: 'manufacturer',
  manufacturerPublicationUrl: 'https://example.invalid/fitment-guide',
  contentSha256: 'e'.repeat(64),
} as const;

/** The part every case below asks about. */
const SUBJECT = { kind: 'canonical_variant', variantId: V_PAD } as const;

async function insertFitment(values: typeof automotiveFitments.$inferInsert): Promise<void> {
  fitmentIds.push(values.id ?? '');
  await db.insert(automotiveFitments).values(values);
}

beforeAll(async () => {
  db = await connectPostgres();

  await db.insert(canonicalProducts).values({
    id: PAD,
    slug: `fb-pad-${RUN}`,
    name: 'Front brake pad set',
    normalizedName: `fb pad ${RUN}`,
  });
  await db.insert(canonicalVariants).values({
    id: V_PAD,
    productId: PAD,
    signature: 'f'.repeat(64),
  });

  await db.insert(vehicleMakes).values({ id: MK, key: `volvo_${KEY}`, name: 'Volvo' });
  await db.insert(vehicleModels).values({ id: MD, makeId: MK, key: 'v60', name: 'V60' });
  await db.insert(vehicleGenerations).values([
    {
      id: GN_EARLY,
      modelId: MD,
      key: 'gen_one',
      name: 'Gen 1',
      chassisCode: 'P24',
      producedFromYear: EARLY_FROM,
      producedToYear: EARLY_TO,
    },
    {
      id: GN_LATE,
      modelId: MD,
      key: 'gen_two',
      name: 'Gen 2',
      chassisCode: 'P25',
      producedFromYear: LATE_FROM,
      producedToYear: LATE_TO,
    },
  ]);

  await db.insert(vehicleConfigurations).values([
    // The SAME nameplate on each side of the boundary — which is the ordinary
    // case, not a contrivance: a manufacturer keeps a trim name across a model
    // change, and the brakes underneath it do not.
    {
      id: CF_EARLY,
      generationId: GN_EARLY,
      key: 'gen_one_d4',
      name: 'D4',
      yearFrom: EARLY_FROM,
      yearTo: EARLY_TO,
      engineCode: 'D4204T14',
      engineDisplacementCc: 1969,
      fuelType: 'diesel',
      drivetrain: 'fwd',
      bodyStyle: 'estate',
      market: 'SE',
    },
    {
      id: CF_LATE,
      generationId: GN_LATE,
      key: 'gen_two_d4',
      name: 'D4',
      yearFrom: LATE_FROM,
      yearTo: LATE_TO,
      engineCode: 'D4204T23',
      engineDisplacementCc: 1969,
      fuelType: 'diesel',
      drivetrain: 'fwd',
      bodyStyle: 'estate',
      market: 'SE',
    },
    // The ambiguous pair. Every discriminating column below is EQUAL by design
    // and `engine_code` is the only thing that differs — asserted as such in the
    // control, so the case cannot be defused by renaming one of them.
    {
      id: CF_ENGINE_A,
      generationId: GN_LATE,
      key: 'gen_two_t5_b4204t11',
      name: 'T5',
      trim: 'Momentum',
      yearFrom: LATE_FROM,
      yearTo: LATE_TO,
      engineCode: 'B4204T11',
      engineDisplacementCc: 1969,
      powerKw: 187,
      fuelType: 'petrol',
      drivetrain: 'fwd',
      bodyStyle: 'estate',
      market: 'SE',
    },
    {
      id: CF_ENGINE_B,
      generationId: GN_LATE,
      key: 'gen_two_t5_b4204t23',
      name: 'T5',
      trim: 'Momentum',
      yearFrom: LATE_FROM,
      yearTo: LATE_TO,
      engineCode: 'B4204T23',
      engineDisplacementCc: 1969,
      powerKw: 187,
      fuelType: 'petrol',
      drivetrain: 'fwd',
      bodyStyle: 'estate',
      market: 'SE',
    },
  ]);

  // The part fits the EARLY generation, stated once at generation scope — the
  // broad claim the exclusion mechanism is built on, and the row whose reach
  // across the overlap is the whole first case.
  await insertFitment({
    id: `fb-f-early-gen-${RUN}`,
    subjectVariantId: V_PAD,
    scope: 'vehicle_generation',
    vehicleMakeId: MK,
    vehicleModelId: MD,
    vehicleGenerationId: GN_EARLY,
    applicability: 'applies',
    position: 'front',
    quantityPerVehicle: 2,
    ...VERIFIED_BY_PUBLICATION,
    observedAt: new Date('2026-02-01T00:00:00.000Z'),
  });
  // …and it fits exactly ONE of the two T5s, stated at configuration scope. The
  // other T5 has no statement about it at all, which is what makes its answer
  // `unknown` rather than a suppressed `applies`.
  await insertFitment({
    id: `fb-f-engine-a-${RUN}`,
    subjectVariantId: V_PAD,
    scope: 'vehicle_configuration',
    vehicleMakeId: MK,
    vehicleModelId: MD,
    vehicleGenerationId: GN_LATE,
    vehicleConfigurationId: CF_ENGINE_A,
    applicability: 'applies',
    position: 'front',
    quantityPerVehicle: 2,
    ...VERIFIED_BY_PUBLICATION,
    observedAt: new Date('2026-02-01T00:00:00.000Z'),
  });
}, 120_000);

afterAll(async () => {
  if (fitmentIds.length > 0) {
    await db.delete(automotiveFitments).where(inArray(automotiveFitments.id, fitmentIds));
  }
  // Children first: every foreign key here is RESTRICT, so a wrong order fails
  // loudly. The configuration list carries the two rows the upsert case may have
  // written as well as the four seeded above.
  await db
    .delete(vehicleConfigurations)
    .where(inArray(vehicleConfigurations.id, configurationIds));
  await db.delete(vehicleGenerations).where(inArray(vehicleGenerations.id, [GN_EARLY, GN_LATE]));
  await db.delete(vehicleModels).where(eq(vehicleModels.id, MD));
  await db.delete(vehicleMakes).where(eq(vehicleMakes.id, MK));
  await deleteTestCanonicalRows(db, { variantIds: [V_PAD] });
  await deleteTestCanonicalRows(db, { productIds: [PAD] });
  await closePostgres();
});

describe('overlapping generations — a model year cannot select a generation', () => {
  it('the fixture really overlaps, re-derived from the stored rows', async () => {
    // The control every case in this block rests on. Two generations that had
    // stopped overlapping would leave each of them asking an ordinary
    // single-generation question and passing for a reason that has nothing to do
    // with the boundary — and nothing in the output would say so, which is the
    // whole reason the overlap is re-derived here instead of restated from the
    // constants above.
    const rows = await db
      .select()
      .from(vehicleGenerations)
      .where(inArray(vehicleGenerations.id, [GN_EARLY, GN_LATE]));
    const early = rows.find((row) => row.id === GN_EARLY);
    const late = rows.find((row) => row.id === GN_LATE);
    expect(early, 'the early generation was not stored').toBeDefined();
    expect(late, 'the late generation was not stored').toBeDefined();
    if (early === undefined || late === undefined) return;
    // The arithmetic, not a restatement of the constants: the windows intersect,
    // and `OVERLAP_YEAR` is inside both.
    expect(late.producedFromYear ?? 0).toBeLessThanOrEqual(early.producedToYear ?? 0);
    expect(OVERLAP_YEAR).toBeGreaterThanOrEqual(early.producedFromYear ?? 0);
    expect(OVERLAP_YEAR).toBeLessThanOrEqual(early.producedToYear ?? 0);
    expect(OVERLAP_YEAR).toBeGreaterThanOrEqual(late.producedFromYear ?? 0);
    expect(OVERLAP_YEAR).toBeLessThanOrEqual(late.producedToYear ?? 0);
    // And they are two rows of ONE model, so the choice between them is the
    // shopper's and not a different car entirely.
    expect(early.modelId).toBe(MD);
    expect(late.modelId).toBe(MD);
  });

  it('answers `applies` inside the overlap for the generation the part is stated on', async () => {
    const answer = await answerFitment({
      subject: SUBJECT,
      vehicle: { configurationId: CF_EARLY },
      year: OVERLAP_YEAR,
    });
    expect(answer.verdict).toEqual({
      outcome: 'determined',
      applicability: 'applies',
      decidedAtScope: 'vehicle_generation',
    });
    expect(answer.vehicle.generation?.id).toBe(GN_EARLY);
  });

  it('answers `unknown` at the SAME year for the other side of the boundary', async () => {
    // The case the whole block exists for. 2018 is a year both generations were
    // built in, and the only thing separating the two answers is which generation
    // the configuration belongs to. A read that gathered generation-scoped rows by
    // year, by model, or by anything other than the generation id would report a
    // confident `applies` here — for a car with different brakes.
    const answer = await answerFitment({
      subject: SUBJECT,
      vehicle: { configurationId: CF_LATE },
      year: OVERLAP_YEAR,
    });
    expect(answer.verdict).toEqual({ outcome: 'unknown' });
    expect(answer.statements, 'nothing covers the late generation').toEqual([]);
    // Resolved, though — the vehicle is real and the catalogue has it. `unknown`
    // here is a statement about the PART, not about the car being missing, and
    // those two are the same verdict with different causes.
    expect(answer.vehicle.generation?.id).toBe(GN_LATE);
    expect(answer.vehicle.configuration?.name).toBe('D4');
  });

  it('separates the two when the caller names a GENERATION rather than a configuration', async () => {
    // The same boundary one rung up the picker, because most of the picker's
    // states are not a configuration and a read that discriminated only at the
    // narrowest rung would be wrong for all of them.
    const onEarly = await answerFitment({
      subject: SUBJECT,
      vehicle: { generationId: GN_EARLY },
      year: OVERLAP_YEAR,
    });
    expect(onEarly.verdict).toEqual({
      outcome: 'determined',
      applicability: 'applies',
      decidedAtScope: 'vehicle_generation',
    });
    const onLate = await answerFitment({
      subject: SUBJECT,
      vehicle: { generationId: GN_LATE },
      year: OVERLAP_YEAR,
    });
    expect(onLate.verdict).toEqual({ outcome: 'unknown' });
  });

  it('keeps the two nameplates apart in the picker, at a year that is in both', async () => {
    // "Which configurations does a part resolve to across the boundary" as the
    // shopper meets it: the same year narrows each generation to ITS OWN 'D4',
    // and neither list leaks the other's.
    const earlyRows = await listVehicleConfigurations(GN_EARLY, OVERLAP_YEAR);
    const lateRows = await listVehicleConfigurations(GN_LATE, OVERLAP_YEAR);
    const earlyIds = earlyRows.map((row) => row.id);
    const lateIds = lateRows.map((row) => row.id);
    expect(earlyIds).toEqual([CF_EARLY]);
    expect(lateIds).toContain(CF_LATE);
    expect(lateIds, 'the late generation must not carry the early one’s car').not.toContain(
      CF_EARLY,
    );
    // Both lists are non-empty at this year, which is what makes the exclusion
    // above a measurement rather than an empty read.
    expect(earlyRows.length).toBeGreaterThan(0);
    expect(lateRows.length).toBeGreaterThan(0);
    // The names really are identical across the boundary, so the id is doing the
    // work and not a spelling difference.
    expect(earlyRows[0]?.name).toBe('D4');
    expect(lateRows.find((row) => row.id === CF_LATE)?.name).toBe('D4');
  });

  it('names only the early generation in the part’s own vehicle list', async () => {
    const page = await listPublishedVehiclesForPart(SUBJECT, 50);
    const generationIds = page.fitments.map((row) => row.generation?.id ?? null);
    expect(generationIds).toContain(GN_EARLY);
    // The configuration-scoped T5 fitment names the LATE generation as its
    // ancestor, so the assertion cannot be "the late generation is absent" — it is
    // that no GENERATION-scoped statement claims it.
    const generationScoped = page.fitments.filter(
      (row) => row.fitment.scope === 'vehicle_generation',
    );
    expect(generationScoped.length).toBe(1);
    expect(generationScoped[0]?.generation?.id).toBe(GN_EARLY);
    expect(page.truncated).toBe(false);
  });
});

describe('ambiguous engine codes — one nameplate, two engines, two answers', () => {
  /** The seeded pair, read back so the assertions are about STORED rows. */
  async function readAmbiguousPair(): Promise<readonly VehicleConfigurationRow[]> {
    return db
      .select()
      .from(vehicleConfigurations)
      .where(inArray(vehicleConfigurations.id, [CF_ENGINE_A, CF_ENGINE_B]));
  }

  it('the pair is genuinely ambiguous — equal on every column but the engine code', async () => {
    // The adverse-fixture control. Without it, a later reader who gave one of the
    // two a different name or displacement would leave two cases that pass by
    // distinguishing the pair on something a real catalogue does not publish, and
    // nothing would say the false-merge case had stopped being one.
    const rows = await readAmbiguousPair();
    expect(rows.length).toBe(2);
    const [first, second] = rows;
    if (first === undefined || second === undefined) return;
    expect(first.generationId).toBe(second.generationId);
    expect(first.name).toBe(second.name);
    expect(first.trim).toBe(second.trim);
    expect(first.engineDisplacementCc).toBe(second.engineDisplacementCc);
    expect(first.powerKw).toBe(second.powerKw);
    expect(first.fuelType).toBe(second.fuelType);
    expect(first.drivetrain).toBe(second.drivetrain);
    expect(first.bodyStyle).toBe(second.bodyStyle);
    expect(first.market).toBe(second.market);
    expect(first.yearFrom).toBe(second.yearFrom);
    expect(first.yearTo).toBe(second.yearTo);
    // The one thing that differs, and it is not null on either side — an
    // unpublished engine code on one of them would make the pair
    // indistinguishable rather than ambiguous, which is a different case.
    expect(first.engineCode).not.toBe(second.engineCode);
    expect(first.engineCode).not.toBeNull();
    expect(second.engineCode).not.toBeNull();
  });

  it('does NOT collapse them — the fitted engine applies and the other is `unknown`', async () => {
    // The false merge, driven end to end. A resolver that answered from the
    // nameplate, the trim, the generation or the year would report `applies` for
    // both of these, every page would render, and the person who finds out is the
    // one who fitted the wrong pad.
    const fitted = await answerFitment({ subject: SUBJECT, vehicle: { configurationId: CF_ENGINE_A } });
    expect(fitted.verdict).toEqual({
      outcome: 'determined',
      applicability: 'applies',
      decidedAtScope: 'vehicle_configuration',
    });

    const other = await answerFitment({ subject: SUBJECT, vehicle: { configurationId: CF_ENGINE_B } });
    expect(other.verdict, 'the other engine has no statement and must not inherit one').toEqual({
      outcome: 'unknown',
    });
    expect(other.statements).toEqual([]);
    // Both answers are about a REAL car in the same generation, so the difference
    // is the engine and not a missing row.
    expect(fitted.vehicle.configuration?.engineCode).toBe('B4204T11');
    expect(other.vehicle.configuration?.engineCode).toBe('B4204T23');
    expect(fitted.vehicle.generation?.id).toBe(other.vehicle.generation?.id);
  });

  it('answers `unknown` for the unfitted engine even at a year the fitted one covers', async () => {
    // The year is the input most likely to be reached for as a discriminator, and
    // it discriminates nothing here: both cars were built every year of this
    // generation, so a year-driven read answers `applies` for both.
    const other = await answerFitment({
      subject: SUBJECT,
      vehicle: { configurationId: CF_ENGINE_B },
      year: LATE_FROM + 1,
    });
    expect(other.verdict).toEqual({ outcome: 'unknown' });
    const fitted = await answerFitment({
      subject: SUBJECT,
      vehicle: { configurationId: CF_ENGINE_A },
      year: LATE_FROM + 1,
    });
    expect(fitted.verdict).toEqual({
      outcome: 'determined',
      applicability: 'applies',
      decidedAtScope: 'vehicle_configuration',
    });
  });

  it('shows the shopper two rows, not one — the picker keeps both', async () => {
    const rows = await listVehicleConfigurations(GN_LATE);
    const ambiguous = rows.filter((row) => row.name === 'T5');
    expect(ambiguous.length, 'one nameplate, two buildable cars').toBe(2);
    expect(ambiguous.map((row) => row.id).sort()).toEqual([CF_ENGINE_A, CF_ENGINE_B].sort());
    // Distinct identities and distinct stable keys, which is the only thing a
    // client has to tell them apart — `projectVehicleReference` publishes
    // `{id, key, name}` and no engine code, so the NAME is ambiguous on the wire
    // by design (D1/D4 keep display out of this domain) and the key is not.
    expect(new Set(ambiguous.map((row) => row.key)).size).toBe(2);
    expect(new Set(ambiguous.map((row) => row.engineCode)).size).toBe(2);
  });

  it('keys identity on the machine KEY, so two engines under one name stay two rows', async () => {
    // The write-side half of the same property, and the place a false merge would
    // actually be created: `upsertVehicleConfiguration` conflicts on
    // `(generation_id, key)`. An importer that derived the key from the NAME would
    // make the second engine overwrite the first's `engine_code` in place — one
    // row, one engine, and a generation that quietly lost a car.
    const reUpserted = await upsertVehicleConfiguration({
      id: CF_ENGINE_B,
      generationId: GN_LATE,
      key: 'gen_two_t5_b4204t23',
      name: 'T5',
      trim: 'Momentum',
      yearFrom: LATE_FROM,
      yearTo: LATE_TO,
      engineCode: 'B4204T23',
      engineDisplacementCc: 1969,
      powerKw: 187,
      fuelType: 'petrol',
      drivetrain: 'fwd',
      bodyStyle: 'estate',
      market: 'SE',
    });
    // Converged on the row that was already there rather than minting a second.
    expect(reUpserted.id).toBe(CF_ENGINE_B);
    const rows = await readAmbiguousPair();
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.engineCode).sort()).toEqual(['B4204T11', 'B4204T23']);
    // And the sibling is untouched: a converging write on one engine must not move
    // the other's code, which is the observable shape of the merge this refuses.
    expect(rows.find((row) => row.id === CF_ENGINE_A)?.engineCode).toBe('B4204T11');
  });
});
