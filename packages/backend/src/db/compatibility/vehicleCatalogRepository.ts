/**
 * The vehicle reference tree — makes, models, generations and configurations
 * (#367 step 8, ADR 0007 D8).
 *
 * Four tables, one ladder, and every read here is a level of the vehicle picker
 * a shopper walks down. Nothing in this file joins to a listing, a variant or an
 * offer: a vehicle record is reference data, and the only thing that connects it
 * to something for sale is an `automotive_fitments` row.
 *
 * ## Every upsert keys on the stable machine KEY, never on the name
 *
 * That is ADR 0007 D1 as an actual write path. A feed that renames `Golf GTI` to
 * `Golf GTI Performance` must update one row, not mint a second — and a feed
 * that changes a KEY has, by definition, named a different concept, which is why
 * the key is frozen by trigger after insert and a correction is a merge rather
 * than a rename.
 */

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  vehicleConfigurations,
  vehicleGenerations,
  vehicleMakes,
  vehicleModels,
} from '../schema/compatibility.js';

export type VehicleMakeRow = typeof vehicleMakes.$inferSelect;
export type VehicleModelRow = typeof vehicleModels.$inferSelect;
export type VehicleGenerationRow = typeof vehicleGenerations.$inferSelect;
export type VehicleConfigurationRow = typeof vehicleConfigurations.$inferSelect;

export type InsertVehicleMake = typeof vehicleMakes.$inferInsert;
export type InsertVehicleModel = typeof vehicleModels.$inferInsert;
export type InsertVehicleGeneration = typeof vehicleGenerations.$inferInsert;
export type InsertVehicleConfiguration = typeof vehicleConfigurations.$inferInsert;

/**
 * Ensure a make exists under its key.
 *
 * `DO UPDATE` on the display fields only. The key and the id are what everything
 * else cites and neither may move through this path; `status` is a decision an
 * operator makes and a feed does not get to reverse a retirement by mentioning
 * the make again.
 */
export async function upsertVehicleMake(
  values: InsertVehicleMake,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleMakeRow> {
  const [row] = await db
    .insert(vehicleMakes)
    .values(values)
    .onConflictDoUpdate({
      target: vehicleMakes.key,
      set: { name: values.name, countryCode: values.countryCode ?? null },
    })
    .returning();
  if (row === undefined) {
    throw new Error('upsertVehicleMake returned no row');
  }
  return row;
}

export async function upsertVehicleModel(
  values: InsertVehicleModel,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleModelRow> {
  const [row] = await db
    .insert(vehicleModels)
    .values(values)
    .onConflictDoUpdate({
      target: [vehicleModels.makeId, vehicleModels.key],
      set: { name: values.name },
    })
    .returning();
  if (row === undefined) {
    throw new Error('upsertVehicleModel returned no row');
  }
  return row;
}

export async function upsertVehicleGeneration(
  values: InsertVehicleGeneration,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleGenerationRow> {
  const [row] = await db
    .insert(vehicleGenerations)
    .values(values)
    .onConflictDoUpdate({
      target: [vehicleGenerations.modelId, vehicleGenerations.key],
      set: {
        name: values.name,
        chassisCode: values.chassisCode ?? null,
        producedFromYear: values.producedFromYear ?? null,
        producedToYear: values.producedToYear ?? null,
      },
    })
    .returning();
  if (row === undefined) {
    throw new Error('upsertVehicleGeneration returned no row');
  }
  return row;
}

export async function upsertVehicleConfiguration(
  values: InsertVehicleConfiguration,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleConfigurationRow> {
  const [row] = await db
    .insert(vehicleConfigurations)
    .values(values)
    .onConflictDoUpdate({
      target: [vehicleConfigurations.generationId, vehicleConfigurations.key],
      set: {
        name: values.name,
        yearFrom: values.yearFrom ?? null,
        yearTo: values.yearTo ?? null,
        engineCode: values.engineCode ?? null,
        engineDisplacementCc: values.engineDisplacementCc ?? null,
        powerKw: values.powerKw ?? null,
        fuelType: values.fuelType ?? null,
        drivetrain: values.drivetrain ?? null,
        transmission: values.transmission ?? null,
        bodyStyle: values.bodyStyle ?? null,
        doors: values.doors ?? null,
        trim: values.trim ?? null,
        market: values.market ?? null,
      },
    })
    .returning();
  if (row === undefined) {
    throw new Error('upsertVehicleConfiguration returned no row');
  }
  return row;
}

/** Every active make, in display order. The picker's first level. */
export async function listVehicleMakes(
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleMakeRow[]> {
  return db
    .select()
    .from(vehicleMakes)
    .where(eq(vehicleMakes.status, 'active'))
    .orderBy(asc(vehicleMakes.name), asc(vehicleMakes.id));
}

export async function listVehicleModels(
  makeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleModelRow[]> {
  return db
    .select()
    .from(vehicleModels)
    .where(and(eq(vehicleModels.makeId, makeId), eq(vehicleModels.status, 'active')))
    .orderBy(asc(vehicleModels.name), asc(vehicleModels.id));
}

export async function listVehicleGenerations(
  modelId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleGenerationRow[]> {
  return db
    .select()
    .from(vehicleGenerations)
    .where(and(eq(vehicleGenerations.modelId, modelId), eq(vehicleGenerations.status, 'active')))
    .orderBy(asc(vehicleGenerations.producedFromYear), asc(vehicleGenerations.id));
}

/**
 * The configurations of one generation, optionally narrowed to a model year.
 *
 * The year predicate is written out in both NULL directions rather than as a
 * `between`, because a NULL bound means OPEN and SQL comparison against NULL is
 * NULL — which a `where` reads as false and would drop every configuration whose
 * end year nobody has published. That is most of the ones still in production.
 */
export async function listVehicleConfigurations(
  generationId: string,
  year: number | null = null,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleConfigurationRow[]> {
  const clauses = [
    eq(vehicleConfigurations.generationId, generationId),
    eq(vehicleConfigurations.status, 'active'),
  ];
  if (year !== null) {
    clauses.push(
      or(isNull(vehicleConfigurations.yearFrom), sql`${vehicleConfigurations.yearFrom} <= ${year}`),
    );
    clauses.push(
      or(isNull(vehicleConfigurations.yearTo), sql`${vehicleConfigurations.yearTo} >= ${year}`),
    );
  }
  return db
    .select()
    .from(vehicleConfigurations)
    .where(and(...clauses))
    .orderBy(asc(vehicleConfigurations.yearFrom), asc(vehicleConfigurations.name), asc(vehicleConfigurations.id));
}

/**
 * The ancestry of one configuration, in one statement.
 *
 * Three inner joins rather than three round trips, and it returns `null` for a
 * configuration whose ancestors are not all present — which cannot happen while
 * the foreign keys stand, and returning `null` rather than throwing means a
 * caller handling a deleted vehicle does not have to catch.
 */
export interface VehicleAncestry {
  readonly make: VehicleMakeRow;
  readonly model: VehicleModelRow;
  readonly generation: VehicleGenerationRow;
  readonly configuration: VehicleConfigurationRow;
}

export async function findVehicleAncestry(
  configurationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<VehicleAncestry | null> {
  const [row] = await db
    .select({
      make: vehicleMakes,
      model: vehicleModels,
      generation: vehicleGenerations,
      configuration: vehicleConfigurations,
    })
    .from(vehicleConfigurations)
    .innerJoin(vehicleGenerations, eq(vehicleGenerations.id, vehicleConfigurations.generationId))
    .innerJoin(vehicleModels, eq(vehicleModels.id, vehicleGenerations.modelId))
    .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicleModels.makeId))
    .where(eq(vehicleConfigurations.id, configurationId))
    .limit(1);
  return row ?? null;
}

/** As much of one vehicle as a caller named, with the levels above it filled in. */
export interface PartialVehicleAncestry {
  readonly make: VehicleMakeRow | null;
  readonly model: VehicleModelRow | null;
  readonly generation: VehicleGenerationRow | null;
  readonly configuration: VehicleConfigurationRow | null;
}

/**
 * Resolve a vehicle from the NARROWEST id a caller named, upwards.
 *
 * A shopper part way down the picker has a make, or a make and a model, and no
 * configuration — so {@link findVehicleAncestry}, which starts at a
 * configuration, answers `null` for most of the picker's states. This widens
 * from whichever level was named and reads the levels above it rather than
 * trusting the caller's copies of them, which is what stops a request naming a
 * generation under somebody else's model from collecting that model's
 * statements: the fitment read pairs each SCOPE with its id, so a wrong
 * `modelId` beside a right `generationId` gathers model-scoped fitments for a
 * model this generation does not belong to and answers confidently.
 *
 * The narrower levels stay `null`. A caller who named a model gets a model and a
 * make and no generation, because nothing was said about one — and filling one in
 * would be choosing a generation on their behalf.
 */
export async function findPartialVehicleAncestry(
  ids: {
    readonly makeId?: string | null;
    readonly modelId?: string | null;
    readonly generationId?: string | null;
    readonly configurationId?: string | null;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<PartialVehicleAncestry> {
  const empty: PartialVehicleAncestry = {
    make: null,
    model: null,
    generation: null,
    configuration: null,
  };

  if (ids.configurationId !== undefined && ids.configurationId !== null) {
    const ancestry = await findVehicleAncestry(ids.configurationId, db);
    return ancestry === null ? empty : ancestry;
  }

  if (ids.generationId !== undefined && ids.generationId !== null) {
    const [row] = await db
      .select({ make: vehicleMakes, model: vehicleModels, generation: vehicleGenerations })
      .from(vehicleGenerations)
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicleGenerations.modelId))
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicleModels.makeId))
      .where(eq(vehicleGenerations.id, ids.generationId))
      .limit(1);
    return row === undefined ? empty : { ...row, configuration: null };
  }

  if (ids.modelId !== undefined && ids.modelId !== null) {
    const [row] = await db
      .select({ make: vehicleMakes, model: vehicleModels })
      .from(vehicleModels)
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicleModels.makeId))
      .where(eq(vehicleModels.id, ids.modelId))
      .limit(1);
    return row === undefined ? empty : { ...row, generation: null, configuration: null };
  }

  if (ids.makeId !== undefined && ids.makeId !== null) {
    const [row] = await db
      .select()
      .from(vehicleMakes)
      .where(eq(vehicleMakes.id, ids.makeId))
      .limit(1);
    return row === undefined ? empty : { ...empty, make: row };
  }

  return empty;
}
