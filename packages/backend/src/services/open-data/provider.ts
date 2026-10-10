/**
 * THE OPEN-DATA PROVIDER CONTRACT — what one keyless provider is, as a value.
 *
 * Mercaria means to compare prices across as many providers as it can reach,
 * and every one of them would otherwise repeat the same five things around a
 * different response shape: a cursor codec, an error taxonomy, a User-Agent, a
 * rate budget and the `AdapterRecord` envelope. A provider here is only the
 * part that differs — how to ask for the next page and how to READ it — and
 * `services/ingestion/adapters/open-data.ts` turns any descriptor into a
 * `CatalogSourceAdapter` with the rest supplied once.
 *
 * ## A provider is PURE apart from the transport it is handed
 *
 * It receives an {@link OpenDataHttp} and returns records. It imports no
 * repository, no database handle and nothing from the commerce graph —
 * `open-data-isolation.test.ts` fails the build if one does, the same wall
 * `ingestion-isolation.test.ts` builds around `adapters/`. Everything a
 * provider can say reaches Mercaria as a `NormalizedSourceRecord`, which has
 * no canonical id, no merchant id and no offer id to put one in.
 *
 * ## Extract everything, structured
 *
 * The fifteen normalization groups are what the MATCHER and the OFFER read.
 * Everything else a provider publishes that describes the object — Nutri-Score,
 * allergens, a card's rarity, a game's developer — goes in `facts`, typed and
 * key-namespaced in the provider's own vocabulary (`NormalizedSourceFact`).
 * Mapping a fact to Mercaria's attribute registry is a later, reviewable step;
 * dropping it at the adapter is unrecoverable, because the raw payload is
 * digested and discarded.
 */

import type {
  CatalogRefreshMode,
  CatalogSourceKind,
  NormalizedSourceRecord,
  OpenDataLicence,
  OpenDataProviderRole,
  SourceRecordExternalType,
} from '@mercaria/shared-types';
import type { OpenDataHttp } from './http.js';

/** What a provider is asked for — the framework's request, narrowed. */
export interface OpenDataPageContext {
  /** The provider's own cursor from the previous page, or `null` to start. */
  readonly cursor: OpenDataCursor | null;
  /** How many records this page may carry. A provider MAY return fewer. */
  readonly pageSize: number;
  /** The sub-feed this source selects (a chain, a store id), or `null`. */
  readonly accountRef: string | null;
  /** ISO 3166-1 alpha-2 markets the source is configured for. Empty = all. */
  readonly territories: readonly string[];
  readonly mode: CatalogRefreshMode;
  /** The incremental watermark, or `null` for a whole pass. */
  readonly since: Date | null;
  /** The ids to re-read, for a `targeted` refresh only. */
  readonly externalIds: readonly string[];
  readonly http: OpenDataHttp;
  /**
   * What the catalogue is asking for, or `null` where this deployment wired no
   * demand. A catalogue provider reads it to fetch exactly the products other
   * sources priced and nothing identifies yet — see {@link OpenDataDemand}.
   */
  readonly demand: OpenDataDemand | null;
  /** One instant for the whole page, taken before the provider was called. */
  readonly now: Date;
  readonly signal?: AbortSignal;
}

/**
 * The catalogue's demand, scoped to the source asking.
 *
 * Without it a reference catalogue is read by country search, newest edit
 * first, and the products a price feed actually priced arrive by luck. With
 * it, the reference source fetches those GTINs first — Open Prices sees a
 * Mercadona price for a GTIN, Open Food Facts is asked for that GTIN, and
 * ADR 0014's seeding has a reference record to mint from.
 *
 * A FUNCTION rather than a list: the demand is a read of Postgres, which a
 * provider may not make, so the composition root supplies it.
 */
export interface OpenDataDemand {
  /** GTINs other sources observed unmatched and this source holds no object for, ascending after `after`. */
  gtins(after: string | null, limit: number): Promise<readonly string[]>;
}

/** A provider's cursor: any JSON object. The adapter encodes it opaquely. */
export type OpenDataCursor = Readonly<Record<string, string | number | boolean | null>>;

/** One record a provider read. */
export interface OpenDataItem {
  readonly externalType: SourceRecordExternalType;
  /** STABLE across deliveries — the provider's own id, never a position. */
  readonly externalId: string;
  readonly normalized: NormalizedSourceRecord;
  /** The provider's own last-modified for this object, when it publishes one. */
  readonly sourceUpdatedAt?: Date;
  /**
   * What the framework DIGESTS for traceability and then discards. The
   * provider's own record, or a stable digest of it for a dump row.
   */
  readonly raw: unknown;
}

/** One page, in provider terms. */
export interface OpenDataPage {
  readonly items: readonly OpenDataItem[];
  /** Ids the provider positively said are gone (a targeted 404). */
  readonly removed?: readonly { readonly externalType: SourceRecordExternalType; readonly externalId: string }[];
  /** `null` when there are no further pages. */
  readonly next: OpenDataCursor | null;
  /**
   * True ONLY on the last page of a pass that enumerated everything the
   * source selects. It authorises retiring what the pass did not see, so a
   * provider that cannot prove completeness — a sorted search that shifts
   * under it, a capped result window — never sets it.
   */
  readonly complete: boolean;
  /** How many times the provider answered with a rate limit during this page. */
  readonly rateLimitHits?: number;
}

/**
 * One keyless provider.
 *
 * Every field but `fetchPage` is a statement for a REVIEWER — what the data is,
 * whose it is and what the source ref means — and is surfaced verbatim on the
 * operator's provider list and the public data-sources page.
 */
export interface OpenDataProvider {
  /** The `catalog_source_configs.provider` slug. `snake_case`, stable forever. */
  readonly slug: string;
  readonly name: string;
  readonly homepage: string;
  readonly role: OpenDataProviderRole;
  /** `feed` for a downloaded dump, `marketplace_api` for a paged API. */
  readonly kind: CatalogSourceKind;
  readonly licence: OpenDataLicence;
  /** The exact credit line a surface showing this data renders. */
  readonly attribution: string;
  /** What `sourceAccountRef` selects, or `null` when the provider is one feed. */
  readonly accountRefMeaning: string | null;
  /** Whether a source of this provider MUST name a sub-feed. */
  readonly accountRefRequired: boolean;
  /**
   * True for a provider that READS A SITE rather than an API offered for reuse
   * (a Shopify store's `/products.json`). #62 then refuses it unless the
   * source's policy grants extraction, and the provider checks robots.txt.
   */
  readonly extraction?: boolean;
  /** The refresh modes this provider can honestly perform (#68 scheduler 1). */
  readonly refreshModes: readonly CatalogRefreshMode[];
  /**
   * The minimum gap between two requests to this provider's host, across every
   * source of it in this process. Read from the provider's own published limit.
   */
  readonly minRequestIntervalMs: number;
  fetchPage(context: OpenDataPageContext): Promise<OpenDataPage>;
}

/** Thrown by a provider when the source's configuration cannot be served. */
export class OpenDataConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenDataConfigurationError';
  }
}

/** Thrown by a provider when a response no longer has the shape it reads. */
export class OpenDataSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenDataSchemaError';
  }
}
