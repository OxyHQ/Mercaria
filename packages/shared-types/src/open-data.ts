/**
 * Keyless open-data providers — the shared vocabulary (`services/open-data/`).
 *
 * The backend registers one `CatalogSourceAdapter` per provider DESCRIPTOR,
 * and every descriptor states the licence its data arrives under from this
 * closed set. The licence is a property of the PROVIDER, not of a source an
 * operator configures: Open Prices is ODbL whichever chain a source selects,
 * and letting a configuration restate it would let a typo relicense a dataset.
 */

/**
 * The licences open-data providers publish under.
 *
 * - `odbl_1_0` — Open Database License. Attribution, and SHARE-ALIKE for a
 *   publicly used derivative database (Open Food Facts, Open Prices, OSM).
 * - `cc0_1_0` — public-domain dedication (Wikidata, MusicBrainz core).
 * - `cc_by_4_0` / `cc_by_sa_4_0` — Creative Commons; images on the Open Facts
 *   family are CC-BY-SA, which is why a media fact carries its own licence.
 * - `es_public_sector_reuse` — Spain's general reuse terms for public-sector
 *   information (Ley 37/2007): cite the source and the update date, do not
 *   distort, do not imply endorsement. Commercial use is allowed.
 * - `provider_terms` — no open licence; the provider's own terms of use govern
 *   (CheapShark, GOG's catalogue, Scryfall). Display with attribution and a
 *   link back; never resell the dataset.
 */
export type OpenDataLicence =
  | 'odbl_1_0'
  | 'cc0_1_0'
  | 'cc_by_4_0'
  | 'cc_by_sa_4_0'
  | 'es_public_sector_reuse'
  | 'provider_terms';

export const OPEN_DATA_LICENCES: readonly OpenDataLicence[] = [
  'odbl_1_0',
  'cc0_1_0',
  'cc_by_4_0',
  'cc_by_sa_4_0',
  'es_public_sector_reuse',
  'provider_terms',
];

/** Licences whose terms require a derivative database to be shared alike. */
export const SHARE_ALIKE_OPEN_DATA_LICENCES: readonly OpenDataLicence[] = ['odbl_1_0', 'cc_by_sa_4_0'];

/** What a provider DOES for the comparator, for an operator choosing sources. */
export type OpenDataProviderRole = 'prices' | 'catalogue' | 'catalogue_and_prices';

export const OPEN_DATA_PROVIDER_ROLES: readonly OpenDataProviderRole[] = [
  'prices',
  'catalogue',
  'catalogue_and_prices',
];

/**
 * One provider as an operator or the public data-sources page sees it.
 *
 * Read from the backend's descriptor registry, never stored: a provider's name,
 * licence and attribution are code, reviewed in the PR that adds it.
 */
export interface OpenDataProviderSummary {
  /** The `catalog_source_configs.provider` slug. */
  readonly slug: string;
  readonly name: string;
  readonly homepage: string;
  readonly role: OpenDataProviderRole;
  readonly licence: OpenDataLicence;
  /** The exact credit line a surface showing this provider's data renders. */
  readonly attribution: string;
  /**
   * What a source's `sourceAccountRef` selects at this provider, in words —
   * "the retail chain", "the store id" — or `null` when the provider is one
   * feed and the ref is unused.
   */
  readonly accountRefMeaning: string | null;
  /** Whether this deployment registered it (listed AND a user agent is set). */
  readonly registered: boolean;
}
