/**
 * Request helpers.
 *
 * Express types a route param as `string | string[]` (a segment name can repeat
 * in a path). Our routes never repeat a param, so at runtime each is a single
 * string — `routeParam` reads it as such, taking the first element on the
 * defensive off-chance it arrives as an array.
 */

import type { Request } from 'express';

/** Read a single-valued route param as a string (first element if an array). */
export function routeParam(req: Request, name: string): string {
  const raw = req.params[name];
  return Array.isArray(raw) ? raw[0] : raw;
}
