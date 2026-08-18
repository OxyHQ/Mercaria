/**
 * Request schemas for the public taxonomy surface (#367 Workstream 1).
 *
 * Every object is `.strict()`, so an undeclared key is REFUSED rather than
 * stripped — `middleware/catalog-authoring-schemas.ts`'s posture and its reason:
 * silently dropping a key a client thought it sent is how a caller's intent
 * disappears with every surface reporting success.
 *
 * ## What no schema here can carry
 *
 * A `lifecycle` parameter. The lifecycles a read admits are decided in
 * `services/taxonomy/read.service.ts` from `TAXONOMY_BROWSABLE_LIFECYCLES` and
 * `TAXONOMY_ADDRESSABLE_LIFECYCLES`, and there is no query key that could widen
 * them — so `?lifecycle=draft` is a 400 about an unrecognized parameter rather
 * than a way for an anonymous caller to read an unannounced vertical's structure.
 * That is the same exposure `schema-version-lifecycle-exposure.realdb.test.ts`
 * closed on `?version=`, refused here by the absence of a field.
 *
 * A `market`. The taxonomy is not market-scoped — `category_localizations` is
 * keyed on `(category_id, locale)` and carries no market column — so accepting
 * one would be a parameter that changes nothing while telling a client it does.
 * `/catalog-authoring/schemas` requires a market because a SCHEMA is composed for
 * one; a category tree is not.
 *
 * A `name`, a `label` or a `slug` where an id or a key belongs (ADR 0007 D1
 * rule 3). The two identity routes take `:categoryId` and `:key`, and `q` is a
 * SEARCH string that resolves to candidates rather than to an identity.
 */

import { z } from 'zod';

/**
 * A BCP 47 tag, lower-cased HERE rather than refused.
 *
 * The stored form is folded, so this is what makes a read find it. Refusing
 * `es-MX` instead would answer a legitimate Spanish request with a 400 over a
 * case convention the tag itself declares insignificant. Identical to the
 * authoring surface's spelling, deliberately: two surfaces disagreeing about what
 * a locale looks like is how one of them starts answering in English.
 */
const locale = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u, 'a locale is a BCP-47 tag')
  .transform((value) => value.toLowerCase());

/** A stable machine key. The SAME pattern `categories_key_format_check` renders. */
export const categoryKeyParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[a-z0-9][a-z0-9_-]*([.][a-z0-9][a-z0-9_-]*)*$/u,
    'a category is named by its stable machine key (ADR 0007 D1); a label is not a key',
  );

/**
 * A keyset cursor, as bytes.
 *
 * Validated for SHAPE only. Whether it decodes is
 * `decodeCategoryCursor`'s answer, because a cursor that parses into the wrong
 * thing has to be refused rather than ignored — starting from the beginning would
 * answer page four with page one and read as a client bug.
 */
const cursor = z.string().trim().min(1).max(512);

/** The two dimensions every taxonomy read is keyed by, plus the page bound. */
const pagedRead = {
  locale: locale.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: cursor.optional(),
};

/** `GET /taxonomy/categories/roots` */
export const taxonomyRootsQuerySchema = z.object(pagedRead).strict();

/** `GET /taxonomy/categories/:categoryId/children` */
export const taxonomyChildrenQuerySchema = z.object(pagedRead).strict();

/** `GET /taxonomy/categories/:categoryId/descendants` */
export const taxonomyDescendantsQuerySchema = z.object(pagedRead).strict();

/** `GET /taxonomy/categories/:categoryId` and `.../by-key/:key` */
export const taxonomyCategoryQuerySchema = z.object({ locale: locale.optional() }).strict();

/** `GET /taxonomy/categories/:categoryId/ancestors` and `.../breadcrumb` */
export const taxonomyTrailQuerySchema = z.object({ locale: locale.optional() }).strict();

/** `GET /taxonomy/categories/:categoryId/eligibility` */
export const taxonomyEligibilityQuerySchema = z.object({ locale: locale.optional() }).strict();

/**
 * `GET /taxonomy/categories/search`
 *
 * `q` has a floor of two characters, the authoring canonical search's rule and
 * its reason: a one-character query matches a large fraction of any taxonomy and
 * returns whatever sorted first, which is both a wasteful scan and a candidate
 * list a reader would be wrong to trust.
 */
export const taxonomySearchQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(120),
    locale: locale.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
