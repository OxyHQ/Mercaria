/**
 * The PRINTFUL CATALOGUE source adapter (#125 "Catalog and procurement
 * ingestion"), on #62's framework and adding no schema to it.
 *
 * ## Why a supplier catalogue can never publish a public offer here
 *
 * #125 rule 7 is "never publish wholesale cost", and this adapter satisfies it
 * with a mechanism #62 already has rather than a check somebody has to remember.
 * A Printful `catalog_sources` row is bound to NO MERCHANT, and #62's rule is
 * that a source with no merchant binding produces no offers at all — so the
 * pipeline stores observations, matches them through #58 and creates ZERO
 * `offers` rows. A wholesale cost therefore has nowhere public to land, whatever
 * a rights policy says and whoever writes the next projection.
 *
 * What DOES consume these observations is `procurement-projection.service.ts`,
 * which upserts PRIVATE `procurement_offers` (#118). That is the separation
 * #125 rule 2 asks for: a supplier's raw records are `source_records` under a
 * source whose kind, rights policy, freshness policy and kill switch are its
 * own, and they can never be read as an affiliate network's — those are bound
 * to a merchant and do produce public offers.
 *
 * ## What it can enumerate, and what that entitles it to
 *
 * `full_snapshot` is declared and it is honest: Printful's catalogue is bounded
 * and `GET /v2/catalog-products` pages it with a total, so "I have seen all of
 * it" is establishable — which is what authorises retirement. `complete` is set
 * only when the last page was reached AND nothing was truncated; every failure
 * mode lands on `false`, because reporting a complete enumeration of half a
 * catalogue retires the other half.
 *
 * `targeted` is declared because the pilot's SKU set is small and re-reading a
 * named list of variants is far cheaper than a sweep. `incremental` is NOT
 * declared: Printful publishes no changed-since filter that I could verify, and
 * an adapter that claims one would silently return everything and call it a
 * delta. `query_driven` is not declared either — there is no search to drive.
 *
 * ## It is PURE, and that is enforced
 *
 * `ingestion-isolation.test.ts` scans this directory and fails the build if
 * anything in it reaches a repository, a database handle, the canonical write
 * services, the offer domain or the matcher. The transport arrives as a
 * {@link PrintfulTransport}; there is no other way in or out.
 */

import type {
  CatalogRefreshMode,
  CurrencyCode,
  NormalizedSourceOption,
  NormalizedSourceRecord,
  OfferAvailability,
} from '@mercaria/shared-types';
import { CURRENCY_PRECISION } from '@mercaria/shared-types';
import type { PrintfulRequest, PrintfulTransport } from '../../printful/transport-contract.js';
import { PrintfulTransportError } from '../../printful/transport-contract.js';
import type {
  AdapterFetchPage,
  AdapterFetchRequest,
  AdapterRecord,
  CatalogSourceAdapter,
} from '../adapter.js';
import { CatalogSourceFetchError } from '../adapter.js';

/** The `catalog_source_configs.provider` slug this adapter serves. */
export const PRINTFUL_CATALOG_PROVIDER = 'printful';

/**
 * The currency Printful's catalogue is read in.
 *
 * A code constant rather than a per-source setting, because #122's own rule
 * applies here too: this domain does no FX, so a catalogue price is recorded in
 * the currency it was published in and a mismatch is a REFUSAL rather than a
 * conversion. EUR is the pilot's single market and currency
 * (`docs/suppliers/printful.md` §4).
 */
const PRINTFUL_CATALOG_CURRENCY: CurrencyCode = 'EUR';

/**
 * How many catalogue variants one framework page may carry.
 *
 * Printful's product list pages by `limit`/`offset`, and this adapter emits one
 * record per VARIANT — which is the grain a procurement offer is keyed on, and
 * the grain a supplier SKU means. One product expands to many variants, so the
 * framework's page size bounds PRODUCTS read and this bounds the records they
 * may expand into, which keeps a page's size bounded whatever a product's
 * variant count turns out to be.
 */
const MAX_RECORDS_PER_PAGE = 500;

/** Read a property off an unknown JSON body without asserting its shape. */
function field(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

function text(source: unknown, key: string): string | null {
  const value = field(source, key);
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function list(source: unknown, key: string): readonly unknown[] {
  const value = field(source, key);
  return Array.isArray(value) ? value : [];
}

/** Printful answers v1 as `{ code, result }` and v2 as the object itself. */
function unwrapBody(body: unknown): unknown {
  const result = field(body, 'result');
  return result === undefined ? body : result;
}

/** A decimal money string in STRING arithmetic — never `Number(x) * 100`. */
function minorUnits(value: unknown, currency: CurrencyCode): number | null {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const precision = CURRENCY_PRECISION[currency];
  if (precision === undefined) return null;
  const [integer, fraction = ''] = raw.split('.');
  const padded = `${fraction}${'0'.repeat(precision + 1)}`;
  const scaled = Number(`${integer}${padded.slice(0, precision)}`);
  if (!Number.isSafeInteger(scaled)) return null;
  const rounded = Number(padded.slice(precision, precision + 1)) >= 5 ? scaled + 1 : scaled;
  return Number.isSafeInteger(rounded) ? rounded : null;
}

/**
 * The cursor, which is an OFFSET into the product list.
 *
 * Opaque to the framework, which only stores and returns it. Parsed defensively
 * because a cursor round-trips through a database column: anything that is not a
 * non-negative integer restarts the enumeration rather than throwing, which is
 * safe — a restarted snapshot is slow and correct, where a thrown cursor would
 * strand the source.
 */
function readOffset(cursor: string | null): number {
  if (cursor === null) return 0;
  return /^\d+$/.test(cursor) ? Number(cursor) : 0;
}

/** Classify a transport failure in #62's own narrow vocabulary. */
function classify(error: unknown, operation: string): never {
  if (error instanceof PrintfulTransportError) {
    throw new CatalogSourceFetchError('source_outage', `printful ${operation}: ${error.message}`, {
      retryable: true,
      cause: error,
    });
  }
  throw error;
}

/** One call, with Printful's status vocabulary mapped to #62's failure kinds. */
async function fetchJson(
  transport: PrintfulTransport,
  request: PrintfulRequest,
  operation: string,
): Promise<unknown> {
  const response = await transport.call(request).catch((error: unknown) => classify(error, operation));
  if (response.status === 401 || response.status === 403) {
    // NOT retryable: a wrong credential fails identically on every attempt, and
    // retrying it burns the source's rate budget answering the same 401.
    throw new CatalogSourceFetchError('auth_failure', `printful ${operation} rejected the credential`);
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers['retry-after'] ?? '');
    throw new CatalogSourceFetchError('rate_limit', `printful ${operation} was rate limited`, {
      retryable: true,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1_000 } : {}),
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new CatalogSourceFetchError(
      'source_outage',
      `printful ${operation} answered ${String(response.status)}`,
      { retryable: response.status >= 500 },
    );
  }
  if (!response.parsed) {
    // A 2xx nobody can read is a SCHEMA problem, not an outage — and #62's
    // `schema_drift` is deliberately not retryable, because the next attempt
    // gets the same unreadable bytes.
    throw new CatalogSourceFetchError(
      'schema_drift',
      `printful ${operation} answered with an unreadable body`,
    );
  }
  return unwrapBody(response.body);
}

/**
 * One catalogue variant, in the framework's own vocabulary.
 *
 * `identifiers` is deliberately EMPTY. Print-on-demand goods carry no retail
 * GTIN (#119 §3 row 3), and #64 §6's rule — never fabricate an absent
 * identifier — is what stops the obvious mistake of putting the Printful
 * variant id in a `mpn` slot, where #58's identifier stage would treat it as a
 * manufacturer part number and match it against somebody else's catalogue.
 * The variant id is the source's own `externalId`, which is exactly where a
 * source-scoped identity belongs.
 */
function toRecord(
  product: unknown,
  variant: unknown,
  price: unknown,
  observedAt: Date,
): AdapterRecord | null {
  const variantId = text(variant, 'id');
  if (variantId === null) return null;

  const options: NormalizedSourceOption[] = [];
  const colour = text(variant, 'color');
  const size = text(variant, 'size');
  if (colour !== null) options.push({ name: 'Color', value: colour });
  if (size !== null) options.push({ name: 'Size', value: size });

  const amount = price === null ? null : minorUnits(price, PRINTFUL_CATALOG_CURRENCY);
  const availability: OfferAvailability = readAvailability(variant);

  const normalized: NormalizedSourceRecord = {
    title: text(variant, 'name') ?? text(product, 'name') ?? `Printful variant ${variantId}`,
    // A HINT that resolves nothing (#62). Printful's `brand` is the blank's
    // manufacturer, and #55's `SUFFICIENT_EVIDENCE_KINDS` excludes everything a
    // feed can supply — so this can never become a brand relationship.
    ...(text(product, 'brand') !== null ? { brandHint: text(product, 'brand') as string } : {}),
    ...(text(product, 'model') !== null ? { model: text(product, 'model') as string } : {}),
    ...(text(product, 'description') !== null
      ? { description: text(product, 'description') as string }
      : {}),
    identifiers: [],
    // The supplier's own SKU, source-scoped and never compared across sources.
    merchantSku: variantId,
    options,
    ...(amount === null ? {} : { price: { amount, currency: PRINTFUL_CATALOG_CURRENCY } }),
    availability,
    media: [text(variant, 'image') ?? text(product, 'image') ?? ''].filter(
      (entry): entry is string => entry !== '',
    ),
  };

  return {
    externalType: 'product',
    externalId: variantId,
    observedAt,
    raw: { product, variant, price },
    normalized,
  };
}

/**
 * Printful's availability wording, read conservatively.
 *
 * Anything this adapter does not recognise is `unknown` rather than `in_stock`.
 * That is #62's own posture and it matters more here than for a marketplace
 * feed: this observation feeds a PROCUREMENT offer, and a wrong `in_stock`
 * would put an item Mercaria cannot buy in front of a buyer. It is also not
 * checkout authority in either direction — #122's live preflight is, and a
 * catalogue's opinion can never be mistaken for it, because the two are
 * separate vocabularies by construction.
 */
function readAvailability(variant: unknown): OfferAvailability {
  const raw = (text(variant, 'availability_status') ?? text(variant, 'availability') ?? '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (raw === 'active' || raw === 'in_stock' || raw === 'stocked_on_demand') return 'in_stock';
  if (raw === 'out_of_stock' || raw === 'stocked_out') return 'out_of_stock';
  if (raw === 'discontinued' || raw === 'removed') return 'unavailable';
  return 'unknown';
}

/** Build the catalogue adapter over one transport. */
export function createPrintfulCatalogAdapter(transport: PrintfulTransport): CatalogSourceAdapter {
  const refreshModes: readonly CatalogRefreshMode[] = ['full_snapshot', 'targeted'];

  return {
    provider: PRINTFUL_CATALOG_PROVIDER,
    // A supplier API. NOT `affiliate_network`, which is the whole point of
    // #125 rule 2: an affiliate source is bound to a merchant and publishes
    // offers, and this one is bound to none and publishes nothing.
    kind: 'marketplace_api',
    extraction: false,
    refreshModes,

    async fetchPage(request: AdapterFetchRequest): Promise<AdapterFetchPage> {
      const startedAt = Date.now();
      const observedAt = new Date();
      const context = {
        credential: null,
        storeId: request.sourceAccountRef,
        timeoutMs: 20_000,
      } as const;

      if (request.mode === 'targeted') {
        // Re-read a NAMED list. No completeness is claimed and none could be:
        // reading five variants says nothing about the rest of the catalogue,
        // which is exactly why `complete` is false on this path.
        const records: AdapterRecord[] = [];
        for (const externalId of request.externalIds) {
          const variant = await fetchJson(
            transport,
            { ...context, method: 'GET', path: `/v2/catalog-variants/${encodeURIComponent(externalId)}` },
            'catalog variant read',
          );
          const record = toRecord(
            field(variant, 'catalog_product') ?? {},
            variant,
            await readPrice(transport, context, externalId),
            observedAt,
          );
          if (record !== null) records.push(record);
        }
        return {
          records,
          nextCursor: null,
          complete: false,
          fetchDurationMs: Date.now() - startedAt,
        };
      }

      const offset = readOffset(request.cursor);
      const body = await fetchJson(
        transport,
        {
          ...context,
          method: 'GET',
          path: '/v2/catalog-products',
          query: { limit: request.pageSize, offset },
        },
        'catalog product list',
      );
      const products = Array.isArray(body) ? body : list(body, 'data');

      const records: AdapterRecord[] = [];
      let truncated = false;
      for (const product of products) {
        const productId = text(product, 'id');
        if (productId === null) continue;
        const variantsBody = await fetchJson(
          transport,
          {
            ...context,
            method: 'GET',
            path: `/v2/catalog-products/${encodeURIComponent(productId)}/catalog-variants`,
          },
          'catalog variant list',
        );
        for (const variant of Array.isArray(variantsBody) ? variantsBody : list(variantsBody, 'data')) {
          if (records.length >= MAX_RECORDS_PER_PAGE) {
            // The page is FULL, so this sweep has not read everything it was
            // asked for. `truncated` is what turns that into `complete: false`
            // — a bound reached is not an enumeration finished.
            truncated = true;
            break;
          }
          const variantId = text(variant, 'id');
          const record = toRecord(
            product,
            variant,
            variantId === null ? null : await readPrice(transport, context, variantId),
            observedAt,
          );
          if (record !== null) records.push(record);
        }
        if (truncated) break;
      }

      // The last page is the one that came back short. `complete` requires BOTH
      // that and an untruncated read — either alone would claim a complete
      // enumeration this pass did not perform.
      const lastPage = products.length < request.pageSize;
      return {
        records,
        nextCursor: lastPage && !truncated ? null : String(offset + products.length),
        complete: lastPage && !truncated,
        fetchDurationMs: Date.now() - startedAt,
      };
    },
  };
}

/**
 * One variant's published price, or `null`.
 *
 * `null` rather than a throw when the price is in another currency or absent:
 * an observation with no price is a legitimate record (the framework stores it
 * and the procurement projection refuses to build an offer from it), whereas a
 * throw would abort the page and lose every record beside it.
 */
async function readPrice(
  transport: PrintfulTransport,
  context: { credential: null; storeId: string | null; timeoutMs: number },
  variantId: string,
): Promise<unknown> {
  const body = await fetchJson(
    transport,
    {
      ...context,
      method: 'GET',
      path: `/v2/catalog-variants/${encodeURIComponent(variantId)}/prices`,
    },
    'catalog variant prices',
  );
  const currency = text(body, 'currency');
  if (currency !== null && currency.toUpperCase() !== PRINTFUL_CATALOG_CURRENCY) return null;
  return field(field(body, 'product'), 'price') ?? field(body, 'price') ?? null;
}
