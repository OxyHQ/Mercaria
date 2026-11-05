/**
 * Named POS registers — the paid `expanded_pos_registers` tool (#89).
 *
 * ## The free baseline is the default register, and nothing here touches it
 *
 * Every location has one implicit default register that every device rings up
 * on — any number of devices, unnamed — which is exactly how the POS worked
 * before this tool existed. A sale with no register, or with one this module
 * declines to honour, is recorded there. So a free store's POS, and every POS
 * build that predates registers, behaves exactly as it did.
 *
 * ## What the plan buys, and what each action costs
 *
 * - CREATE a named register: consumes ONE of the plan's `total` allowance, in
 *   the same transaction as the row (`consumeCapabilityOrThrow`). At the ceiling
 *   the store still uses every register it has; only adding more is refused.
 * - REMOVE one: gives the allowance back in the same transaction
 *   (`releaseCapability`) — deleted if it never took a sale, archived if it did,
 *   so its history keeps its name.
 * - RENAME and LIST: free. Reading and tidying what a store already has is
 *   never gated.
 * - A SALE names a register: honoured only while the store holds the tool
 *   (`holdsCapability`, which stays true at the ceiling). Otherwise — and for an
 *   unknown, archived or other-location register — the sale is recorded on the
 *   default register. A plan decision never refuses a sale.
 *
 * When a plan ends nothing is deleted: registers and their attributed sales stay
 * readable (the summary is not gated), and new sales fall back to the default.
 */

import type {
  CreatePosRegisterInput,
  PosRegister,
  PosRegisterList,
  PosRegisterRemoval,
  PosRegisterSalesSummary,
} from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxy.so/db';
import { getDb } from '../db/postgres.js';
import {
  findPosRegister,
  findPosRegisters,
  insertPosRegister,
  removePosRegister as removePosRegisterRow,
  renamePosRegister as renamePosRegisterRow,
  summarizePosRegisterSales,
  type PosRegisterRecord,
} from '../db/pos/posRegisterRepository.js';
import { findLocation } from '../db/stores/locationRepository.js';
import { conflict, notFound } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import {
  consumeCapabilityOrThrow,
  holdsCapability,
  releaseCapability,
} from './entitlements/enforce.js';

/** The capability this module sells. */
export const POS_REGISTERS_CAPABILITY = 'expanded_pos_registers' as const;

/** Default summary window when `from`/`to` are omitted. */
const DEFAULT_SUMMARY_DAYS = 30;
/** Widest window the summary reads in one request. */
const MAX_SUMMARY_DAYS = 92;
const MS_PER_DAY = 86_400_000;

/** Serialize a register row to the `PosRegister` DTO. */
export function toPosRegisterDTO(row: PosRegisterRecord): PosRegister {
  return {
    id: row.id,
    storeId: row.storeId,
    locationId: row.locationId,
    name: row.name,
    ...(row.archivedAt ? { archivedAt: row.archivedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const DUPLICATE_NAME = 'A register with that name already exists at this location.';

/** Whether a sale rung up on a named register is attributed to it now. */
export async function registerAttributionActive(storeId: string): Promise<boolean> {
  return holdsCapability({ storeId, capability: POS_REGISTERS_CAPABILITY });
}

/** The store's registers (live only unless `includeArchived`) and whether sales honour them. */
export async function listPosRegisters(
  storeId: string,
  filter: { locationId?: string; includeArchived?: boolean },
): Promise<PosRegisterList> {
  const [rows, attributionActive] = await Promise.all([
    findPosRegisters(storeId, filter),
    registerAttributionActive(storeId),
  ]);
  return { registers: rows.map(toPosRegisterDTO), attributionActive };
}

/** Add a named register to one of the store's locations, taking one of the allowance. */
export async function createPosRegister(
  storeId: string,
  actorOxyUserId: string,
  input: CreatePosRegisterInput,
): Promise<PosRegister> {
  const location = await findLocation(storeId, input.locationId);
  if (!location) throw notFound('Location not found');

  try {
    const row = await getDb().transaction(async (tx) => {
      await consumeCapabilityOrThrow(tx, { storeId, capability: POS_REGISTERS_CAPABILITY });
      return insertPosRegister(tx, {
        storeId,
        locationId: location.id,
        name: input.name,
        createdByOxyUserId: actorOxyUserId,
      });
    });
    return toPosRegisterDTO(row);
  } catch (error) {
    // The transaction rolled back, allowance included.
    if (isUniqueViolation(error, 'pos_registers_live_name_key')) throw conflict(DUPLICATE_NAME);
    throw error;
  }
}

/** Rename a live register. Free: it changes nothing the plan counts. */
export async function renamePosRegister(
  storeId: string,
  registerId: string,
  name: string,
): Promise<PosRegister> {
  try {
    const row = await renamePosRegisterRow(storeId, registerId, name);
    if (!row) throw notFound('Register not found');
    return toPosRegisterDTO(row);
  } catch (error) {
    if (isUniqueViolation(error, 'pos_registers_live_name_key')) throw conflict(DUPLICATE_NAME);
    throw error;
  }
}

/** Remove a live register and give its allowance back, in one transaction. */
export async function removePosRegister(
  storeId: string,
  registerId: string,
): Promise<PosRegisterRemoval> {
  const outcome = await getDb().transaction(async (tx) => {
    const removed = await removePosRegisterRow(tx, { storeId, registerId });
    if (removed) await releaseCapability(tx, { storeId, capability: POS_REGISTERS_CAPABILITY });
    return removed;
  });
  if (!outcome) throw notFound('Register not found');
  return { id: registerId, outcome };
}

/**
 * The register a POS sale is attributed to, or `undefined` for the location's
 * default register. Never throws a refusal: a sale is never refused for a plan
 * reason or for a stale register a device still remembers.
 */
export async function registerForSale(input: {
  storeId: string;
  locationId: string | undefined;
  registerId: string | undefined;
}): Promise<string | undefined> {
  const { storeId, locationId, registerId } = input;
  if (!registerId || !locationId) return undefined;

  const register = await findPosRegister(storeId, registerId);
  const usable =
    register !== null && register.archivedAt === null && register.locationId === locationId;
  if (!usable) {
    log.general.info(
      { storeId, registerId, locationId },
      'POS sale named a register that is not live at its location; recorded on the default register',
    );
    return undefined;
  }
  if (!(await registerAttributionActive(storeId))) return undefined;
  return register.id;
}

/** Validate + clamp the summary window: default the last 30 days, at most 92. */
function resolveSummaryWindow(from?: string, to?: string): { from: Date; to: Date } {
  const parsedTo = to ? Date.parse(to) : Number.NaN;
  const parsedFrom = from ? Date.parse(from) : Number.NaN;
  let toDate = Number.isFinite(parsedTo) ? new Date(parsedTo) : new Date();
  let fromDate = Number.isFinite(parsedFrom)
    ? new Date(parsedFrom)
    : new Date(toDate.getTime() - DEFAULT_SUMMARY_DAYS * MS_PER_DAY);
  if (fromDate.getTime() > toDate.getTime()) [fromDate, toDate] = [toDate, fromDate];
  const floor = toDate.getTime() - MAX_SUMMARY_DAYS * MS_PER_DAY;
  if (fromDate.getTime() < floor) fromDate = new Date(floor);
  return { from: fromDate, to: toDate };
}

/**
 * Daily POS sales per register — the default register included — for the
 * store, optionally one location. Not gated: it reads sales the store already
 * made, which stay readable whatever plan it is on.
 */
export async function getPosRegisterSalesSummary(
  storeId: string,
  params: { from?: string; to?: string; locationId?: string },
): Promise<PosRegisterSalesSummary> {
  const window = resolveSummaryWindow(params.from, params.to);
  const rows = await summarizePosRegisterSales(storeId, {
    ...window,
    ...(params.locationId ? { locationId: params.locationId } : {}),
  });
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    rows: rows.map((row) => ({
      day: row.day,
      locationId: row.locationId,
      registerId: row.registerId,
      salesCount: row.salesCount,
      grossSales: { amount: row.grossSales, currency: row.currency },
    })),
  };
}
