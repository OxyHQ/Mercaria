/**
 * Coordinates, cells, distances and the coarsening that separates the two.
 *
 * Everything in this module is PURE and takes no database handle, because every
 * one of these decisions has to hold identically in three places that cannot
 * share a query: the nearby read (which sorts in SQL), the P2P discovery read
 * (which sorts over cells), and the log/metric path (which must never see a
 * precise coordinate at all).
 *
 * ## Two distance regimes, deliberately not unified
 *
 * A STORE location has a real geocode, so its distance is computed by PostGIS
 * against the shopper's own point and is accurate to metres before it is
 * coarsened. A P2P listing has only a CELL, so its distance is a cell-centre to
 * cell-centre estimate accurate to roughly the cell size. Rendering both through
 * one function would make the second look like the first; they meet only at
 * {@link distanceBandFor}, which is honest about both because a band is already
 * coarser than either error.
 *
 * ## Why the shopper's own coordinate never leaves a request
 *
 * #93 privacy rules 5, 6 and 10. It is used to compute distances and is then
 * gone: what a log line, a metric or an operator trace may hold is
 * {@link toLocalArea}'s cell, which is the SAME mechanism a P2P seller's
 * published area uses. That is not a coincidence — a buyer's position and a
 * seller's position deserve the same treatment, and reusing one function means
 * a future change to the cell size cannot apply to one and miss the other.
 *
 * ## Trilateration is the reason the metre figure is rounded OUTWARD
 *
 * Published shop fronts are public points. Three exact distances from an unknown
 * position to three known points solve for that position. {@link coarsenMetres}
 * is what stops a nearby response being that system of equations, and it rounds
 * UP rather than to nearest so the number is never an understatement of how far
 * somebody has to travel.
 */

import { P2P_LOCAL_CELL_PRECISION_DEGREES, type P2pLocalArea, type PickupDistanceBand } from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/** Mean Earth radius, metres — the sphere the haversine below is taken on. */
const EARTH_RADIUS_METRES = 6_371_008.8;

/** A precise position, as it exists inside ONE request and nowhere else. */
export interface Coordinate {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * Validate a coordinate a client or a merchant supplied.
 *
 * The null-island refusal is the clause worth reading. `(0, 0)` is a real point
 * in the Gulf of Guinea and is what every failed import, every uninitialised
 * float and every "the form submitted before the map loaded" produces — so a
 * plain range check admits the single most common bad value there is, and sorts
 * it first for everybody in West Africa. The same refusal is a CHECK on
 * `location_publications`; this one exists so the API answers 400 with a
 * sentence rather than letting Postgres phrase it as a constraint name.
 */
export function assertUsableCoordinate(latitude: number, longitude: number): Coordinate {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw validationError('A location needs a finite latitude and longitude.');
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw validationError('Latitude must be between -90 and 90, and longitude between -180 and 180.');
  }
  if (latitude === 0 && longitude === 0) {
    throw validationError(
      'That point is in the middle of the Atlantic. Drop a pin on the map instead of entering zeroes.',
    );
  }
  return { latitude, longitude };
}

/**
 * Reduce a precise position to the cell it falls in.
 *
 * `Math.floor` rather than `Math.round`, so a cell is the half-open square
 * `[index × p, (index + 1) × p)` and every position belongs to exactly one. A
 * rounded index would put positions on a boundary into whichever cell the
 * floating-point comparison happened to favour, and two sellers on the same
 * street would land in different cells depending on the sign of their latitude.
 */
export function toLocalArea(
  coordinate: Coordinate,
  precisionDegrees: number = P2P_LOCAL_CELL_PRECISION_DEGREES,
): P2pLocalArea {
  return {
    latIndex: Math.floor(coordinate.latitude / precisionDegrees),
    lonIndex: Math.floor(coordinate.longitude / precisionDegrees),
    precisionDegrees,
  };
}

/**
 * The centre of a cell — the ONLY position a cell can be turned back into.
 *
 * This is the whole of what a P2P area discloses, and it is why the schema
 * stores indices: there is no more precise value to recover, from any row, by
 * anybody.
 */
export function localAreaCentre(area: P2pLocalArea): Coordinate {
  return {
    latitude: (area.latIndex + 0.5) * area.precisionDegrees,
    longitude: (area.lonIndex + 0.5) * area.precisionDegrees,
  };
}

/**
 * Great-circle distance in metres.
 *
 * Used for the P2P cell-to-cell estimate and for the tests that pin the SQL
 * distance; the store nearby read computes its distance in PostGIS instead,
 * against the spheroid, because that is what the GiST index can order by. The
 * two agree to well under a metre at any distance a shopper cares about, and
 * both are coarsened before anybody sees them.
 */
export function haversineMetres(from: Coordinate, to: Coordinate): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The band boundaries, in metres, in the order {@link PickupDistanceBand} declares. */
const BAND_CEILINGS: readonly (readonly [PickupDistanceBand, number])[] = [
  ['under_1km', 1_000],
  ['under_5km', 5_000],
  ['under_10km', 10_000],
  ['under_25km', 25_000],
  ['under_50km', 50_000],
];

/** Which coarse band a distance falls in. */
export function distanceBandFor(metres: number): PickupDistanceBand {
  for (const [band, ceiling] of BAND_CEILINGS) {
    if (metres < ceiling) return band;
  }
  return 'beyond_50km';
}

/**
 * Round a distance OUTWARD to a coarse step — 100 m below 10 km, 1 km above.
 *
 * Two steps rather than one because a single step cannot serve both ends: 1 km
 * granularity makes every shop in a city centre read "1 km", and 100 m
 * granularity at 40 km is a precision nobody asked for and a trilateration
 * constraint anybody could use.
 */
export function coarsenMetres(metres: number): number {
  const step = metres < 10_000 ? 100 : 1_000;
  return Math.ceil(metres / step) * step;
}

/**
 * The radius a nearby query runs over, clamped to something a database can
 * serve and a shopper can act on.
 *
 * A bound rather than an option, because an unbounded radius turns "near me"
 * into "every location in the world sorted by distance" — which is a full scan
 * of the publication table dressed up as a proximity query, and an answer whose
 * tail is useless to whoever asked.
 */
export const MIN_NEARBY_RADIUS_METRES = 500;
/** See {@link MIN_NEARBY_RADIUS_METRES}. */
export const MAX_NEARBY_RADIUS_METRES = 100_000;
/** What a client that names no radius gets. */
export const DEFAULT_NEARBY_RADIUS_METRES = 25_000;

/** Clamp a requested radius into the servable range. */
export function clampNearbyRadius(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_NEARBY_RADIUS_METRES;
  return Math.min(MAX_NEARBY_RADIUS_METRES, Math.max(MIN_NEARBY_RADIUS_METRES, Math.round(requested)));
}
