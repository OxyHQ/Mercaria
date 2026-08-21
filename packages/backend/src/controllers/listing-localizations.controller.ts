/**
 * A seller's own listing translations — the shared half of a two-mount surface
 * (#814).
 *
 * #809 landed `listing_localizations` with two production READS and no writer,
 * so epic #367's "native listing localization **owned by each store/listing**"
 * had a column called `seller_authored` and no way for a seller to author one.
 * This is the authoring path.
 *
 * ## One factory, two mounts, and NO third answer to "who owns this listing"
 *
 * The `referral-partner` shape (`routes/referral-partner.ts` and
 * `routes/admin/referral-partner.ts`), for its reason. Mercaria already has two
 * doors onto one listing and each already knows how to answer ownership:
 * `/seller/listings/:id` compares `listings.oxy_user_id` against the verified
 * caller, and `/admin/stores/:storeId/products/:id` lets `loadStore` plus
 * `requireStorePermission` answer it and then compares `listings.store_id`.
 * Those two answers arrive here as a RESOLVER, so this module contains no
 * ownership logic at all and cannot become a third answer that disagrees with
 * either.
 *
 * The resolver returns the loaded listing, so it has already thrown 404 (no such
 * listing) or 403 (somebody else's) before any localization row is touched.
 *
 * ## What a seller may say, and what they structurally cannot
 *
 * The body is `{title, description?}` and nothing else.
 * `SELLER_LOCALIZATION_STATUS` and `SELLER_LOCALIZATION_PROVENANCE` are applied
 * HERE, from constants, and the settling account is the verified caller — so a
 * request cannot claim its own translation was reviewed by an operator, cannot
 * mint a `mercaria`-provenance row, and cannot name somebody else as having
 * settled it. The schema being `.strict()` is what turns all three from checks
 * into 400s on an undeclared key.
 *
 * ## Two things this module deliberately does NOT do
 *
 * It does not re-implement the machine-write guard or the family's CHECKs —
 * ADR 0007 D4 puts those in the database precisely so a service is not one
 * forgotten call site from degrading a human's work — and it does not mark
 * anything stale, which the source-semantics triggers do in the statement that
 * changes the source. `listingLocalizationRepository`'s header says the same,
 * one layer down.
 */

import { Router, type Request, type Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import {
  MERCARIA_BASE_LOCALE,
  SELLER_LOCALIZATION_PROVENANCE,
  SELLER_LOCALIZATION_STATUS,
  type ListingLocalization,
  type SupportedLocale,
} from '@mercaria/shared-types';
import type { ListingRecord } from '../db/catalog/listingRepository.js';
import {
  deleteListingLocalization,
  findListingLocalization,
  findListingLocalizationCoverage,
  upsertListingLocalization,
  type ListingLocalizationRow,
} from '../db/catalogLocalization/listingLocalizationRepository.js';
import { foldLocale, isSupportedLocale } from '../services/catalog-localization/resolve.js';
import { validateBody } from '../middleware/validate.js';
import { upsertListingLocalizationSchema } from '../middleware/listing-localization-schemas.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, notFound, validationError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';

/**
 * How a mount answers "which listing is this request about, and may this caller
 * act on it".
 *
 * Returning the LISTING rather than an id is the load-bearing part: it makes
 * the ownership read a precondition of reaching any handler body, so there is
 * no shape in which a handler runs having skipped it.
 */
export type ListingLocalizationOwnerResolver = (req: Request) => Promise<ListingRecord>;

/**
 * The row as a client sees it, with every field named.
 *
 * `search_vector` is a generated `tsvector` and is the reason this is a
 * projection rather than a spread: it is large, it is meaningless outside
 * PostgreSQL, and `select()` returns it.
 */
function project(row: ListingLocalizationRow): ListingLocalization {
  return {
    listingId: row.listingId,
    locale: row.locale,
    status: row.status,
    provenance: row.provenance,
    title: row.title,
    description: row.description,
    sourceLocale: row.sourceLocale,
    settledByOxyUserId: row.reviewedByOxyUserId,
    settledAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The `:locale` path segment, narrowed to a locale Mercaria authors in.
 *
 * Folded first, because BCP 47 is case-insensitive and `es-MX` and `es-mx` are
 * ONE tag — two spellings in one column is a lookup that misses rather than an
 * error anybody sees.
 *
 * The STRICT reading, matching the desk's schemas rather than the public
 * taxonomy reads: a shopper's `?locale=` is a REQUEST that falls through a
 * chain, so an unauthored tag legitimately resolves to something else, while
 * this names the locale a seller is WRITING, and a typo's honest answer is 400
 * rather than a row nobody can ever read back.
 *
 * `validate.ts` exports no params validator and the one surface that wanted one
 * (`internal-catalog-localization`) recorded the same decision: the membership
 * test runs at the top of the handler, before any read, which is the property
 * that actually matters.
 */
function requireLocale(req: Request): SupportedLocale {
  const folded = foldLocale(routeParam(req, 'locale'));
  if (!isSupportedLocale(folded)) {
    throw validationError(`'${routeParam(req, 'locale')}' is not a locale Mercaria authors in.`);
  }
  if (folded === MERCARIA_BASE_LOCALE) {
    // `_locale_not_base_check` refuses the row anyway; this is the answer that
    // says WHY. A seller's base-locale words live on `listings.title` and
    // `listings.description`, and a second copy of them here is exactly the
    // duplicate ADR 0007 D4 makes unrepresentable.
    throw validationError(
      `'${MERCARIA_BASE_LOCALE}' is the locale this listing is written in. ` +
        'Edit the listing itself to change its own words.',
    );
  }
  return folded;
}

/**
 * Build the sub-router. Mounted twice; see the header.
 *
 * `mergeParams` so the parent's `:id` (and, on the store mount, `:storeId`) are
 * visible to the resolver.
 */
export function makeListingLocalizationRouter(
  resolveListing: ListingLocalizationOwnerResolver,
): Router {
  const router = Router({ mergeParams: true });

  /** GET / — every locale this listing has, so a seller can see their coverage. */
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const listing = await resolveListing(req);
      const rows = await findListingLocalizationCoverage(listing.id);
      sendSuccess(res, rows.map(project));
    } catch (err) {
      log.general.error({ err }, 'Failed to list listing localizations');
      respondWithError(res, err, 'Failed to list localizations');
    }
  });

  /** GET /:locale — one locale's row. */
  router.get('/:locale', async (req: Request, res: Response): Promise<void> => {
    try {
      const listing = await resolveListing(req);
      const locale = requireLocale(req);
      const row = await findListingLocalization(listing.id, locale);
      if (!row) {
        throw notFound('This listing has no translation in that locale.');
      }
      sendSuccess(res, project(row));
    } catch (err) {
      log.general.error({ err }, 'Failed to read listing localization');
      respondWithError(res, err, 'Failed to read localization');
    }
  });

  /**
   * PUT /:locale — write this listing's text in one locale.
   *
   * PUT rather than POST, and an upsert rather than a create: a translation is
   * a REVISION and the second write IS the correction, which is
   * `upsertCategoryLocalization`'s ruling one table over. It also makes the
   * surface idempotent, so a retrying client converges instead of colliding
   * with `listing_localizations_locale_key`.
   */
  router.put(
    '/:locale',
    validateBody(upsertListingLocalizationSchema),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const listing = await resolveListing(req);
        const locale = requireLocale(req);
        const body = req.body as { title: string; description?: string | null };
        const row = await upsertListingLocalization({
          listingId: listing.id,
          locale,
          // Both from constants, never from the body. See the header.
          status: SELLER_LOCALIZATION_STATUS,
          provenance: SELLER_LOCALIZATION_PROVENANCE,
          title: body.title,
          description: body.description ?? null,
          // The listing's own words are the source this was translated FROM.
          sourceLocale: MERCARIA_BASE_LOCALE,
          // "Settled text names who settled it" — `_reviewed_audit_check`. The
          // verified caller, and no field a request could influence.
          reviewedByOxyUserId: getRequiredOxyUserId(req),
          reviewedAt: new Date(),
        });
        sendSuccess(res, project(row));
      } catch (err) {
        log.general.error({ err }, 'Failed to write listing localization');
        respondWithError(res, err, 'Failed to write localization');
      }
    },
  );

  /**
   * DELETE /:locale — withdraw this listing's translation in one locale.
   *
   * A DELETE rather than a `deprecated` status write: `deprecated` is a
   * translation somebody withdrew and KEPT, with its author and review instant
   * still on the row, which is the desk's lifecycle word about Mercaria's own
   * copy. A seller removing their own words is a removal. The resolver still
   * falls back to the listing's own base text, so nothing renders a raw key.
   */
  router.delete('/:locale', async (req: Request, res: Response): Promise<void> => {
    try {
      const listing = await resolveListing(req);
      const locale = requireLocale(req);
      const removed = await deleteListingLocalization(listing.id, locale);
      if (!removed) {
        throw notFound('This listing has no translation in that locale.');
      }
      sendSuccess(res, { listingId: listing.id, locale });
    } catch (err) {
      log.general.error({ err }, 'Failed to delete listing localization');
      respondWithError(res, err, 'Failed to delete localization');
    }
  });

  return router;
}
