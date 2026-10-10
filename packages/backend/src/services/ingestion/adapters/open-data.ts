/**
 * The OPEN-DATA adapter — any keyless provider descriptor, as a
 * `CatalogSourceAdapter`.
 *
 * `services/open-data/` holds the descriptors: one module per provider that
 * says how to ask for a page and how to read it. This file supplies everything
 * that would otherwise be repeated per provider — the cursor codec, the
 * `AdapterRecord` envelope, the shared `observedAt`, and the translation of a
 * provider's own refusals into #62's closed failure vocabulary — so adding the
 * next provider is a descriptor and its test, and nothing here.
 *
 * ## It reaches no database
 *
 * `ingestion-isolation.test.ts` scans this directory, and the descriptors it
 * runs are scanned by `open-data-isolation.test.ts` under the same rules. The
 * only thing it is handed beside the descriptor is the transport.
 */

import {
  CatalogSourceFetchError,
  type AdapterFetchPage,
  type AdapterFetchRequest,
  type AdapterRecord,
  type CatalogSourceAdapter,
} from '../adapter.js';
import type { OpenDataHttp } from '../../open-data/http.js';
import {
  OpenDataConfigurationError,
  OpenDataSchemaError,
  type OpenDataCursor,
  type OpenDataDemand,
  type OpenDataProvider,
} from '../../open-data/provider.js';

/** What the composition root hands every open-data adapter. */
export interface OpenDataAdapterDependencies {
  readonly http: OpenDataHttp;
  /** The catalogue's demand for one source, or absent where none is wired. */
  readonly demandFor?: (sourceId: string) => OpenDataDemand;
  /** Injected for tests; the dispatcher's own clock otherwise. */
  readonly clock?: () => Date;
}

export function createOpenDataAdapter(
  provider: OpenDataProvider,
  dependencies: OpenDataAdapterDependencies,
): CatalogSourceAdapter {
  const clock = dependencies.clock ?? (() => new Date());

  return {
    provider: provider.slug,
    kind: provider.kind,
    // An API or a dump offered for reuse is not extraction. A provider that
    // reads a site (a Shopify store's catalogue) says so, and #62 then needs
    // the extraction right before it runs.
    extraction: provider.extraction === true,
    refreshModes: provider.refreshModes,

    async fetchPage(request: AdapterFetchRequest): Promise<AdapterFetchPage> {
      if (provider.accountRefRequired && (request.sourceAccountRef ?? '').trim() === '') {
        throw new CatalogSourceFetchError(
          'auth_failure',
          `A ${provider.name} source must name ${provider.accountRefMeaning ?? 'a sub-feed'} in its account ref.`,
          { retryable: false },
        );
      }

      const now = clock();
      const startedAt = Date.now();
      let page;
      try {
        page = await provider.fetchPage({
          cursor: decodeCursor(request.cursor),
          pageSize: request.pageSize,
          accountRef: request.sourceAccountRef?.trim() || null,
          territories: request.territories,
          mode: request.mode,
          since: request.since,
          externalIds: request.externalIds,
          http: dependencies.http,
          demand: dependencies.demandFor?.(request.sourceId) ?? null,
          now,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (error: unknown) {
        throw classify(provider, error);
      }

      const records: AdapterRecord[] = page.items.map((item) => ({
        externalType: item.externalType,
        externalId: item.externalId,
        // ONE instant for the page, taken before the provider was called —
        // #62's "set by the adapter so a batch shares one instant".
        observedAt: now,
        ...(item.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: item.sourceUpdatedAt }),
        raw: item.raw,
        normalized: item.normalized,
      }));

      return {
        records,
        ...(page.removed === undefined || page.removed.length === 0
          ? {}
          : {
              removals: page.removed.map((removal) => ({
                externalType: removal.externalType,
                externalId: removal.externalId,
                observedAt: now,
              })),
            }),
        nextCursor: page.next === null ? null : encodeCursor(page.next),
        // A pass is complete only on its LAST page: a provider that reported
        // completeness with a further page queued would retire everything
        // that page was about to deliver.
        complete: page.complete && page.next === null,
        fetchDurationMs: Date.now() - startedAt,
        rateLimitHits: page.rateLimitHits ?? 0,
      };
    },
  };
}

/** A provider's refusal in #62's vocabulary. Unknown failures are outages. */
function classify(provider: OpenDataProvider, error: unknown): unknown {
  if (error instanceof CatalogSourceFetchError) return error;
  if (error instanceof OpenDataConfigurationError) {
    // Not retryable: the same configuration fails the same way every time.
    return new CatalogSourceFetchError('auth_failure', `${provider.name}: ${error.message}`, {
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof OpenDataSchemaError) {
    return new CatalogSourceFetchError('schema_drift', `${provider.name}: ${error.message}`, {
      retryable: false,
      cause: error,
    });
  }
  return error;
}

function encodeCursor(cursor: OpenDataCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Read a cursor back, or treat it as absent.
 *
 * A cursor that will not decode RESTARTS the pass rather than failing it: the
 * value came from this adapter through the framework, so a corrupted one is a
 * bug and re-reading from the start is the recoverable answer — every write
 * downstream converges on a content hash, so records already seen land as
 * `unchanged`.
 */
function decodeCursor(raw: string | null): OpenDataCursor | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return null;
    }
    return parsed as OpenDataCursor;
  } catch {
    return null;
  }
}
