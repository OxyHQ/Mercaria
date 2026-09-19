/**
 * The FACTS digital analytics is computed from — an allow-list of typed fields,
 * never a property bag (#1015 W6, W13).
 *
 * ## Why there is no property bag, restated because it is the rule here too
 *
 * `docs/analytics.md` states the whole design of the sibling domain in one
 * sentence: *"an allow-list of typed columns, never a free property bag"*, and its
 * reasoning applies verbatim and for a stronger reason. A provider's webhook
 * payload arrives shaped by somebody else and has to be reduced; an analytics
 * property is composed by our own code, *"so an open bag is not a defence against
 * a third party, it is an invitation to whoever is in a hurry"*.
 *
 * In this domain the thing in a hurry would carry is a buyer. A digital sale knows
 * the buyer's `buyer_key`, the order, the grant and the supply country, and a
 * `Record<string, unknown>` on any of the types below is one line from a creator
 * dashboard that lists who bought what from where. So every type here is closed,
 * and the gate beside it (`__tests__/analytics-boundaries.test.ts`) fails the build
 * on an index signature, on `unknown`, and on a field whose name is in the
 * forbidden family.
 *
 * ## What is structurally absent
 *
 * **No IP, raw, hashed or geo-derived.** `~/AGENTS.md`'s no-IP invariant, which
 * `asset_download_events` already honours by carrying no such column — and which
 * ADR 0010 D10 extends into the tax path through
 * `FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS`. Nothing here takes an IP, a device
 * fingerprint, a user agent, a browser locale, a timezone offset or a coordinate,
 * and {@link DIGITAL_ANALYTICS_FORBIDDEN_FIELD_SEGMENTS} is that list as a gate
 * rather than as a promise.
 *
 * **No buyer identity at all.** Not an `oxyUserId`, not a `buyerKey`, not a guest
 * session, not an order id, not a pseudonym. The sibling domain needs a
 * pseudonymous session to measure a funnel across page views; this one measures
 * sales and downloads, which are server-side facts about an ASSET, so the identity
 * column that domain had to design carefully is one this domain does not need at
 * all. The cheapest privacy property is the field you never added.
 *
 * **No conversion between currencies.** Every money field is minor units in ONE
 * currency and every aggregate is keyed by it. `AGENTS.md`: the catalog stores
 * native currency and converts nothing, and `paid` converts nothing — a single
 * cross-currency GMV figure would be a conversion performed by a dashboard at an
 * unnamed rate, which is the thing `DualMoney` and `FxRateSnapshot` exist to make
 * impossible.
 *
 * ## Where the facts come from
 *
 * A fact is a ROW already in the database, projected. Nothing here is a new event
 * type, a new column or a new table:
 *
 * | fact | source |
 * |---|---|
 * | {@link DigitalSaleFact} | `order_items.digital_*` + `orders` + `ledger_transactions` |
 * | {@link DigitalDownloadFact} | `asset_download_events` |
 * | {@link DigitalRightFact} | `asset_rights` |
 * | {@link AssetProcessingFact} | `asset_file_inspections` |
 * | {@link DigitalAssetPublicationFact} | `digital_assets` + `asset_versions` |
 * | {@link DigitalViewFact} | `analytics_events` `product_page_view`, joined through `asset_variant_bindings` |
 *
 * The projection itself — the SQL — is deliberately NOT in this directory. See the
 * note on the read seam at the bottom of this file.
 */

import type {
  AssetDownloadEventKind,
  AssetDownloadRefusalReason,
  AssetInspectionVerdict,
  AssetRightStatus,
  CurrencyCode,
  DigitalLicenceUpdatePolicy,
  DigitalVertical,
} from '@mercaria/shared-types';

/* -------------------------------------------------------------------------- */
/* The forbidden family, as a gate rather than a promise                       */
/* -------------------------------------------------------------------------- */

/**
 * Field-name segments that may never appear on any type in this directory.
 *
 * Matched by underscore- and camel-case SEGMENT rather than by substring, which is
 * the correction `docs/analytics.md` records for the sibling gate: *"`latency_ms`
 * is not a latitude and `oxy_user_id` survives a prohibition on `user_agent`"*.
 *
 * The list is longer than the no-IP invariant strictly requires, because the
 * invariant's purpose is that a download cannot be tied to a person or a place
 * more precisely than the aggregate permits — and an email, a postal address or a
 * card fingerprint reaches that end by a different road.
 */
export const DIGITAL_ANALYTICS_FORBIDDEN_FIELD_SEGMENTS: readonly string[] = [
  // The no-IP invariant itself, and everything ADR 0010 D10 forbids as supply
  // evidence. `ip` covers `ipAddress`, `ipHash` and `ipCountry` alike: the
  // invariant forbids the DERIVED form as explicitly as the raw one.
  'ip',
  'geoip',
  'device',
  'fingerprint',
  'useragent',
  'agent',
  'timezone',
  'locale',
  // A place, more precisely than a country.
  'latitude',
  'longitude',
  'lat',
  'lon',
  'coordinates',
  'postal',
  'postcode',
  'address',
  'city',
  'region',
  // A person.
  'email',
  'phone',
  'name',
  'buyerkey',
  'buyer',
  'session',
  'pseudonym',
  'card',
  'customer',
  'wallet',
  'token',
  'hash',
];

/* -------------------------------------------------------------------------- */
/* The facts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether the thing was given away or sold.
 *
 * A two-member closed set rather than a price: #1015 W13 asks for *"free vs paid
 * views and downloads"* and that is the only distinction it asks for. Carrying the
 * price instead would put a per-asset price history in an analytics projection,
 * which the catalogue already owns and which would be a second answer to what
 * something costs.
 */
export type DigitalPriceClass = 'free' | 'paid';

/** One paid digital order line, after the money settled. */
export interface DigitalSaleFact {
  readonly assetId: string;
  readonly vertical: DigitalVertical;
  readonly packageId: string;
  /**
   * The licence version sold — an id, for a creator's own licence-name mix.
   *
   * An id and not a name: the name is the creator's mutable display copy on
   * `asset_licences`, and an aggregate keyed on it would silently split in two the
   * day they renamed it.
   */
  readonly licenceVersionId: string;
  /** The closed-set half of the option, which is what a platform mix is keyed on. */
  readonly updatePolicy: DigitalLicenceUpdatePolicy;
  readonly priceClass: DigitalPriceClass;
  /** The SHOP's currency. No presentment amount: a creator is paid in theirs. */
  readonly currency: CurrencyCode;
  /** Gross, minor units, shop currency. */
  readonly grossAmount: number;
  /**
   * Mercaria's commission as the LEDGER recorded it — the realized fee.
   *
   * From `ledger_transactions`, because `AGENTS.md` says the ledger is the only
   * record of Mercaria's commission and ADR 0001 D3 gave up the provider's
   * reporting of it. A fee recomputed here from a schedule would be a second
   * answer that disagrees with the books for exactly the orders where a schedule
   * changed mid-flight.
   */
  readonly realizedFeeAmount: number;
  /** What the creator is owed: gross less the realized fee, as the ledger has it. */
  readonly creatorEarningsAmount: number;
  /**
   * The consumer's country for this supply, or `null` when the line carried none.
   *
   * ISO-3166 alpha-2, exactly as `orders.digital_supply_country` holds it, and
   * **never derived from an IP address** — ADR 0010 D10's
   * `FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS` names `ip_geolocation` and
   * `ip_address` as things that may not establish it, so a value here that came
   * from one would be a tax record and a privacy breach at once.
   *
   * `null` is a real answer and is aggregated as such, not dropped: a digital line
   * with no place of supply is a checkout bug ADR 0010 D10 deliberately makes
   * visible, and a geographic summary that silently omitted it would hide the
   * thing the CHECK was written to expose.
   */
  readonly supplyCountry: string | null;
  /**
   * Whether this line was refunded — projected from `asset_rights.status`.
   *
   * The RIGHT is the authority, not the order line: ADR 0010 D6 makes a refund a
   * state transition on the right plus an append-only event, and *"only `status`
   * and the revocation basis move"*. A boolean recomputed from a payment would
   * disagree with the right for exactly the cases an operator repaired by hand.
   *
   * A boolean here and not a rate: a rate computed upstream of this contract would
   * arrive with its denominator already chosen, and the whole point of
   * `metrics.ts` is that a denominator is stated rather than assumed.
   */
  readonly refunded: boolean;
  /** Whether a chargeback was opened against it — `disputed_hold` on the right. */
  readonly disputed: boolean;
}

/** One row of `asset_download_events`, projected. */
export interface DigitalDownloadFact {
  readonly assetId: string;
  readonly kind: AssetDownloadEventKind;
  /** Present exactly when `kind` is `refused`, as the CHECK already pairs them. */
  readonly refusalReason: AssetDownloadRefusalReason | null;
  readonly priceClass: DigitalPriceClass;
}

/** One row of `asset_rights`, projected — what buyers hold, by status. */
export interface DigitalRightFact {
  readonly assetId: string;
  readonly status: AssetRightStatus;
  readonly priceClass: DigitalPriceClass;
}

/** One inspection run, projected — #1015 W13's processing success and latency. */
export interface AssetProcessingFact {
  readonly assetId: string;
  readonly verdict: AssetInspectionVerdict;
  /**
   * How long the processor took, or `null` when it is not known.
   *
   * `null` is *not measured*, the distinction ADR 0010 D12 makes load-bearing for
   * every geometry column: a zero-millisecond inspection and an unmeasured one are
   * different facts, and a latency average that treated the second as the first
   * would report a pipeline as faster the more often its timing was lost.
   */
  readonly latencyMs: number | null;
}

/** One published asset, projected — #1015 W13's "published assets by type". */
export interface DigitalAssetPublicationFact {
  readonly assetId: string;
  readonly vertical: DigitalVertical;
  /** Whether anything the asset sells is free. */
  readonly priceClass: DigitalPriceClass;
}

/**
 * One product-page view of a digital listing.
 *
 * Produced by the EXISTING analytics domain — `product_page_view` in
 * `analytics_events` — joined through `asset_variant_bindings` to the asset. No new
 * event type is needed and none may be added: `ANALYTICS_EVENT_TYPES` is a closed
 * tuple in `@mercaria/shared-types` and the sibling domain's seam registry is what
 * decides when a type starts being emitted.
 *
 * The view fact carries the asset and the price class and NOTHING else — not the
 * pseudonymous session the source row has, not the market, not the surface. A
 * creator learning which sessions viewed their asset is one join from learning
 * which session bought it.
 */
export interface DigitalViewFact {
  readonly assetId: string;
  readonly priceClass: DigitalPriceClass;
}

/**
 * Everything a creator summary or a launch summary is computed from.
 *
 * One bag of ARRAYS, not a bag of properties: each member is a closed type above,
 * so adding a dimension is a field on a named interface that the gate inspects —
 * which is the friction `docs/analytics.md` calls *"the feature"* about its own
 * sixth measure.
 */
export interface DigitalAnalyticsFacts {
  readonly sales: readonly DigitalSaleFact[];
  readonly downloads: readonly DigitalDownloadFact[];
  readonly rights: readonly DigitalRightFact[];
  readonly processing: readonly AssetProcessingFact[];
  readonly publications: readonly DigitalAssetPublicationFact[];
  readonly views: readonly DigitalViewFact[];
}

/** An empty fact set, so a caller with nothing to report need not spell six keys. */
export const NO_DIGITAL_ANALYTICS_FACTS: DigitalAnalyticsFacts = Object.freeze({
  sales: [],
  downloads: [],
  rights: [],
  processing: [],
  publications: [],
  views: [],
});

/* -------------------------------------------------------------------------- */
/* The read seam                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How a caller obtains the facts, as a PORT.
 *
 * The SQL that projects these rows is not in this directory, and that is a
 * layering decision rather than an omission. `AGENTS.md`'s shape for this codebase
 * is that the repository layer is the only thing that reaches Postgres and the
 * service layer is where the rules live — `bindingRepository.ts`' docblock records
 * what happened when a digital service held its own query: *"the first draft put
 * the join in the service and turned six unit tests into 'PostgreSQL is not
 * connected'"*.
 *
 * So the computation is pure and takes facts; the projection belongs in
 * `db/digital/`, which this workstream does not own. The port is what the two sides
 * agree on, and the handoff names it.
 */
export interface DigitalAnalyticsFactReader {
  /**
   * The facts for ONE store over a window.
   *
   * `storeId` has no default and there is no unscoped variant, which is
   * `getMerchantAnalyticsSummary`' device: *"there is no way to call this for
   * 'every store'"*, because a creator-facing read that could omit its scope will
   * eventually be called without one.
   */
  forStore(input: {
    readonly storeId: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<DigitalAnalyticsFacts>;
  /** The facts for the whole deployment — the launch metrics' population. */
  forDeployment(input: { readonly from: Date; readonly to: Date }): Promise<DigitalAnalyticsFacts>;
}
