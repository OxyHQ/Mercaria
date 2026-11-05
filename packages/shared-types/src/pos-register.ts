/**
 * Named POS registers — the paid `expanded_pos_registers` tool (#89).
 *
 * Every location has ONE implicit default register, which is not a row: it is
 * what every device at the location rings sales up on, unnamed and with no
 * device limit, exactly as POS worked before registers existed, and a free
 * store keeps it unchanged. A plan that includes the tool lets the store add
 * NAMED registers to a location, each counted against the plan's allowance, so
 * a till's sales carry their own identity and their own daily summary.
 *
 * What a store keeps when its plan ends: every register and every sale
 * attributed to one, readable. What stops: creating registers, and new sales
 * being attributed to one — they fall back to the default register.
 */

import type { Money } from './money';

/** Longest register name the API accepts, after trimming. */
export const POS_REGISTER_NAME_MAX_LENGTH = 60;

/** One named register at one location. */
export interface PosRegister {
  id: string;
  storeId: string;
  locationId: string;
  name: string;
  /**
   * Set once the register was removed while it still had sales. A removed
   * register with no sales is deleted outright; one with sales is kept, so its
   * history keeps its name, and no new sale can be attributed to it.
   */
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** `GET /admin/stores/:storeId/pos-registers`. */
export interface PosRegisterList {
  registers: PosRegister[];
  /**
   * Whether a sale rung up on a named register is attributed to it NOW — true
   * while the store's plan includes the tool. False, every sale is recorded on
   * the location's default register, so a POS hides its register picker.
   */
  attributionActive: boolean;
}

/** `POST /admin/stores/:storeId/pos-registers`. */
export interface CreatePosRegisterInput {
  locationId: string;
  name: string;
}

/** `PATCH /admin/stores/:storeId/pos-registers/:id` — a rename. */
export interface UpdatePosRegisterInput {
  name: string;
}

/** `DELETE /admin/stores/:storeId/pos-registers/:id`. */
export interface PosRegisterRemoval {
  id: string;
  /** `deleted` when it had no sales; `archived` when its sales keep it. */
  outcome: 'deleted' | 'archived';
}

/**
 * One register's sales on one day in one currency.
 *
 * `registerId` is `null` for the location's DEFAULT register. A sale counts
 * once its payment was taken at the register, whatever happened to it later
 * (a refund is a separate record), and lands on the UTC day it was paid.
 */
export interface PosRegisterSalesRow {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** `null` only for a sale whose draft named no location. */
  locationId: string | null;
  registerId: string | null;
  salesCount: number;
  /** Sum of the sales' grand totals, in the currency they were taken in. */
  grossSales: Money;
}

/** `GET /admin/stores/:storeId/pos-registers/summary`. */
export interface PosRegisterSalesSummary {
  /** The window actually read (ISO instants), after clamping. */
  from: string;
  to: string;
  /** Newest day first, then location, then register (default first). */
  rows: PosRegisterSalesRow[];
}
