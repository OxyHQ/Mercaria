import type { Href } from 'expo-router';

/**
 * Every digital-commerce navigation target, as the OBJECT form (#1015
 * Workstream 5).
 *
 * ## Why not a template literal, in one sentence each
 *
 * `typedRoutes` checks a template-literal target only when NO dynamic route sits
 * above the mistyped segment (#456, measured). `/3d/[slug]` IS a dynamic route,
 * so `` router.push(`/3d/printble`) `` would be absorbed by it, type-check,
 * ship, and land a shopper on an asset page looking up an asset called
 * "printble". The object form's `pathname` is checked against a union of plain
 * string literals and fails with TS2820 plus a "Did you mean"; it is also the
 * shape `validate:route-targets` and `route-reachability.test.ts` read as an
 * edge. One decision, three properties — so every function here returns an
 * object and none composes a path by concatenation.
 *
 * `lib/catalog/routes.ts` is the same module for the catalogue's own targets and
 * records the same reasoning. This one is separate rather than an addition to it
 * because these are #1015's routes and that file is #367's: a digital surface
 * gaining or losing an address should not touch the catalogue's map.
 *
 * ## `/3d/printable` and `/3d/game-assets` are STATIC siblings of a dynamic route
 *
 * expo-router resolves a static segment before a dynamic one, so those two
 * addresses reach their own screens and never `[slug]`. That is worth stating
 * because it is also the hazard above: the resolution order makes the dynamic
 * route a silent catch-all for every typo in that position, which is exactly why
 * nothing here spells one with an interpolation.
 */

/** A digital browse surface's address — one literal per surface, no composition. */
export type DigitalBrowseRoute = '/3d' | '/3d/printable' | '/3d/game-assets';

/** The 3D landing surface and its two refinements. */
export function digitalBrowseHref(route: DigitalBrowseRoute): Href {
  return { pathname: route };
}

/**
 * One digital work's page, addressed by its id OR its current slug.
 *
 * Same contract as `/categories/:handle` (#75): an id is always a legal
 * spelling and a slug is the pretty one, so a link survives a rename. ADR 0007
 * D1 — a label is presentation and never identity — is why there is no
 * parameter here a localized NAME could be passed as.
 */
export function digitalAssetHref(handle: string): Href {
  return { pathname: '/3d/[slug]', params: { slug: handle } };
}

/** A creator's public page (#1015 W5). */
export function digitalCreatorHref(slug: string): Href {
  return { pathname: '/creators/[slug]', params: { slug } };
}

/** The buyer's own library of digital rights (#1015 W9). */
export function digitalLibraryHref(): Href {
  return { pathname: '/library' };
}
