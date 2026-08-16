/**
 * Request schemas for the navigation surface (#367 step 7, ADR 0007 D3).
 *
 * Every one is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types`, so an undeclared field is REFUSED rather than
 * stripped — a stripped field is a request somebody believes was applied.
 *
 * ## What the shapes deliberately cannot carry
 *
 * There is no `label`, `name`, `title` or `description` on a NODE. A node's
 * presentation lives in its localizations and nowhere else (ADR 0007 D1/D4), so
 * an authoring client cannot put an untranslated string on the node itself and
 * have it rendered to every locale.
 *
 * There is no `weight`, `score`, `boost`, `rank`, `sort` or `policyVersion`
 * anywhere. Ordering is `position` — an explicit editorial sequence — and how
 * RESULTS are ordered is #74's, behind its versioned policy. A menu that could
 * carry a sort would be a ranking control reachable by anybody who can edit a
 * menu.
 *
 * There is no category NAME, slug, parent or lifecycle field. Navigation points
 * at a category by id and may not write one (ADR 0007 D3), and a request shape
 * that could carry a category's name is the first half of a service that
 * updates it.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  CONDITION_GROUPS,
  NAVIGATION_LOCALIZATION_PROVENANCES,
  NAVIGATION_LOCALIZATION_STATUSES,
  NAVIGATION_NODE_VISIBILITIES,
  NAVIGATION_SURFACES,
  OFFER_AVAILABILITY_STATES,
  OFFER_KINDS,
  type ConditionGroup,
  type CurrencyCode,
  type NavigationLocalizationProvenance,
  type NavigationLocalizationStatus,
  type NavigationNodeVisibility,
  type NavigationSurface,
  type OfferAvailability,
  type OfferKind,
} from '@mercaria/shared-types';

/** A shared-types list as the non-empty tuple `z.enum` requires. */
function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('An empty enum accepts nothing and types every value never');
  }
  return [first, ...rest];
}

/**
 * A BCP-47 tag, in the same shape the column CHECK enforces.
 *
 * Lower-cased here rather than refused, because a client sending `es-ES` is
 * unambiguous and refusing it teaches nobody anything; the CHECK is what makes
 * the STORED form canonical, and this is what makes a READ find it.
 */
const locale = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
  .transform((value) => value.toLowerCase());

/** ISO 3166-1 alpha-2, upper-cased for the same reason. */
const market = z
  .string()
  .trim()
  .length(2)
  .regex(/^[A-Za-z]{2}$/)
  .transform((value) => value.toUpperCase());

/** A stable machine key (ADR 0007 D1): lowercase, dotted, never a label. */
const machineKey = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9]+([._-][a-z0-9]+)*$/,
    'a stable machine key is lowercase and dotted (ADR 0007 D1); a label is not a key',
  );

const entityId = z.string().trim().min(1).max(64);

/** `GET /navigation` — the public read. */
export const navigationQuerySchema = z
  .object({
    market,
    locale,
    surface: z.enum(tuple(NAVIGATION_SURFACES as readonly NavigationSurface[])).optional(),
  })
  .strict();

/** `GET /navigation/preview/:treeId` — the operator preview. */
export const navigationPreviewQuerySchema = z.object({ locale: locale.optional() }).strict();

/**
 * What a node points at — the seven, as a discriminated union.
 *
 * `z.discriminatedUnion` rather than seven optional fields with a refinement:
 * the union cannot express a body naming two targets at all, where a refinement
 * would be a rule somebody could relax without noticing what it held.
 */
const navigationTargetInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('category'), categoryId: entityId }).strict(),
  z.object({ kind: z.literal('saved_query'), savedQueryId: entityId }).strict(),
  z.object({ kind: z.literal('product_type'), productTypeKey: machineKey }).strict(),
  z.object({ kind: z.literal('brand'), brandId: entityId }).strict(),
  z.object({ kind: z.literal('product_family'), productFamilyId: entityId }).strict(),
  z.object({ kind: z.literal('collection'), collectionId: entityId }).strict(),
  z
    .object({
      kind: z.literal('campaign'),
      /**
       * HTTPS only, and parsed rather than pattern-matched.
       *
       * `URL` is what tells `https://evil.example@mercaria.co` from
       * `https://mercaria.co`; a prefix or suffix test on the raw string does
       * not, and that is the shape an open redirect takes. The column CHECK
       * repeats the protocol test against every other writer.
       */
      url: z
        .string()
        .trim()
        .max(2048)
        .refine((value) => {
          try {
            return new URL(value).protocol === 'https:';
          } catch {
            return false;
          }
        }, 'a campaign destination must be an absolute https URL'),
    })
    .strict(),
]);

/** One label of one node (ADR 0007 D4). */
const navigationLocalizationSchema = z
  .object({
    locale,
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(400).optional(),
    accessibilityLabel: z.string().trim().max(200).optional(),
    status: z.enum(tuple(NAVIGATION_LOCALIZATION_STATUSES as readonly NavigationLocalizationStatus[])),
    provenance: z.enum(
      tuple(NAVIGATION_LOCALIZATION_PROVENANCES as readonly NavigationLocalizationProvenance[]),
    ),
    sourceLocale: locale.optional(),
    reviewedByOxyUserId: entityId.optional(),
    reviewedAt: z.coerce.date().optional(),
  })
  .strict();

/** One node of a replacement node set. */
const navigationNodeSchema = z
  .object({
    key: machineKey,
    parentKey: machineKey.optional(),
    position: z.number().int().min(0).max(10_000),
    target: navigationTargetInputSchema,
    visibility: z
      .enum(tuple(NAVIGATION_NODE_VISIBILITIES as readonly NavigationNodeVisibility[]))
      .optional(),
    visibleFrom: z.coerce.date().optional(),
    visibleTo: z.coerce.date().optional(),
    localizations: z.array(navigationLocalizationSchema).max(40),
  })
  .strict();

/** `POST /navigation/trees` — create a draft version. */
export const createNavigationTreeBodySchema = z
  .object({
    key: machineKey,
    market,
    locale,
    surface: z.enum(tuple(NAVIGATION_SURFACES as readonly NavigationSurface[])),
    internalLabel: z.string().trim().min(1).max(160),
    supersedesTreeId: entityId.optional(),
  })
  .strict();

/**
 * `PUT /navigation/trees/:treeId/nodes` — the WHOLE node set.
 *
 * A replacement rather than a patch: the set an operator previewed is the set
 * that publishes, and every partial-edit endpoint is another state a tree can be
 * left in between two requests.
 */
export const replaceNavigationNodesBodySchema = z
  .object({ nodes: z.array(navigationNodeSchema).max(500) })
  .strict();

/** `POST /navigation/trees/:treeId/publish`. */
export const publishNavigationTreeBodySchema = z
  .object({
    effectiveFrom: z.coerce.date().optional(),
    effectiveTo: z.coerce.date().optional(),
    supersedeLive: z.boolean().optional(),
  })
  .strict();

/** `POST /navigation/saved-queries`. */
export const createNavigationSavedQueryBodySchema = z
  .object({
    key: machineKey,
    internalLabel: z.string().trim().min(1).max(160),
    queryText: z.string().trim().min(1).max(200).optional(),
    categoryId: entityId.optional(),
    brandIds: z.array(entityId).max(50).optional(),
    merchantIds: z.array(entityId).max(50).optional(),
    conditionGroups: z
      .array(z.enum(tuple(CONDITION_GROUPS as readonly ConditionGroup[])))
      .max(10)
      .optional(),
    availability: z
      .array(z.enum(tuple(OFFER_AVAILABILITY_STATES as readonly OfferAvailability[])))
      .max(10)
      .optional(),
    offerKinds: z
      .array(z.enum(tuple(OFFER_KINDS as readonly OfferKind[])))
      .max(10)
      .optional(),
    officialChannelOnly: z.boolean().optional(),
    market: market.optional(),
    priceCurrency: z.enum(tuple(ALL_CURRENCY_CODES as readonly CurrencyCode[])).optional(),
    priceMinAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    priceMaxAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    attributes: z
      .array(
        z
          .object({
            attributeKey: machineKey,
            values: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()
  // A bound without its currency is a bound nobody can apply, and the row CHECK
  // refuses it — refusing it here names the missing field instead of reporting a
  // constraint violation.
  .refine(
    (body) =>
      (body.priceMinAmount === undefined && body.priceMaxAmount === undefined) ||
      body.priceCurrency !== undefined,
    { message: 'priceCurrency is required when a price bound is given' },
  );
