/**
 * Inventory DTOs for the Mercaria store-admin multi-location surface.
 *
 * A store variant stocks at N locations; `InventoryLevelDTO` is the per-location
 * view of a single variant's available stock, joined with its location name. The
 * internal `committed` count (units reserved by pending orders) is NEVER exposed
 * on the wire — only `available` is surfaced.
 */

/** A single variant's available stock at one location. */
export interface InventoryLevelDTO {
  /** Location this stock lives at. */
  locationId: string;
  /** Display name of the location (joined from `Location`). */
  locationName: string;
  /** Units free to reserve at this location. */
  available: number;
}
