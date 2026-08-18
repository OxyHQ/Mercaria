/**
 * The Awin retailer-network source's vocabulary — issue #66, source selection
 * bound by #64 (`docs/catalog-sources/2026-08-09-launch-sources.md`).
 *
 * Awin is a NETWORK: one publisher credential in front of thirty thousand
 * advertisers, each of which publishes its own product feed and each of which
 * has its own commercial relationship with Mercaria. #62 already owns a source's
 * configuration, rights, health and lifecycle, and #63 already owns turning a
 * file of somebody else's rows into a `NormalizedSourceRecord`. What this file
 * adds is the vocabulary for the four things neither of them can express,
 * because neither of them knows what a network is.
 *
 * ## The four distinctions this file exists to hold
 *
 * 1. **What Awin SAYS about a programme and what Mercaria DECIDED about it are
 *    different fields.** {@link AwinMembershipStatus} is the network's own
 *    answer and Mercaria never writes an opinion into it;
 *    {@link AwinActivation} is Mercaria's. Collapsing them makes "Awin
 *    suspended us" indistinguishable from "we paused them", which are opposite
 *    next actions.
 * 2. **Commission eligibility is DERIVED, never stored.** There is no
 *    `commissionable` member anywhere below, because it would be a second
 *    representation of a membership status, a rights verdict and a tracking
 *    verdict that all already exist — and it would be wrong for exactly as long
 *    as nobody swept it. {@link AWIN_COMMISSIONABLE_MEMBERSHIPS} is the one
 *    input the derivation reads from this file.
 * 3. **A tracking link is admitted by a CLOSED HOST SET, not sanitised.**
 *    {@link AWIN_TRACKING_HOSTS} is a code constant rather than a column, so a
 *    compromised feed, a mis-mapped column and an operator's typo all fail the
 *    same way: {@link AwinTrackingVerdict} names WHICH, and only `approved` may
 *    carry a URL. This is the whole of "without turning Mercaria into an open
 *    redirect" (issue adapter rule 6).
 * 4. **A feed can never assert a brand relationship.**
 *    {@link AWIN_FORBIDDEN_ADVERTISER_CLAIMS} names the five claims a feed's
 *    contents may never establish, and it is DISJOINT from every fact this
 *    domain can record — the `RetailForbiddenComponentKind` device (#120),
 *    pointed at issue adapter rule 7. #55 owns those claims, with evidence,
 *    four eyes and a validity window.
 *
 * Every tuple below is a closed value set the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — `db/schema/CONVENTIONS.md`).
 * Adding a value is a code change plus an additive migration in the same PR.
 */

/**
 * What Awin says about one publisher↔advertiser relationship.
 *
 * The feed list reports it per feed. `not_joined` is the pre-join preview case
 * — Awin exposes feeds for advertisers who permit it — and is what makes an
 * advertiser evaluable (identifier coverage, duplicate rate, deep-link shape)
 * BEFORE an application is sent. It is a real state and not an absence, so an
 * advertiser nobody has applied to and an advertiser whose application is
 * pending stay distinguishable.
 */
export type AwinMembershipStatus =
  | 'not_joined'
  | 'pending'
  | 'joined'
  | 'declined'
  | 'suspended'
  | 'left';

export const AWIN_MEMBERSHIP_STATUSES: readonly AwinMembershipStatus[] = [
  'not_joined',
  'pending',
  'joined',
  'declined',
  'suspended',
  'left',
];

/**
 * The ONLY membership under which a deep link earns commission.
 *
 * One member, and the reason it is a tuple rather than a comparison is #62's
 * `CATALOG_SOURCE_RETIRING_OUTCOMES` reasoning: the schema's CHECK and the
 * routing derivation read the same list, so a widening is one edit and cannot
 * leave the two disagreeing. Attribution belongs to the link, and a programme
 * Mercaria has not joined attributes to nobody — so routing a buyer through a
 * tracked URL for one is a redirect that earns nothing and tells the network
 * Mercaria is promoting an advertiser it has no agreement with.
 */
export const AWIN_COMMISSIONABLE_MEMBERSHIPS: readonly AwinMembershipStatus[] = ['joined'];

/**
 * The memberships under which the relationship is OVER.
 *
 * Read by the discovery reconciliation, which moves such an advertiser to
 * `closed` and its #62 source to `revoked`. `pending` is deliberately not here:
 * an application nobody has answered is not a refusal.
 */
export const AWIN_TERMINATED_MEMBERSHIPS: readonly AwinMembershipStatus[] = [
  'declined',
  'suspended',
  'left',
];

/**
 * What MERCARIA decided about one advertiser.
 *
 * The path is `candidate` → `sampling` → `active`, and the middle state is not
 * ceremony: issue quality control 4 asks that destination URLs and tracking
 * behaviour be sampled BEFORE an advertiser is activated, and a lifecycle with
 * no sampling state would make that a checklist item somebody remembers rather
 * than a transition somebody cannot skip.
 *
 * `paused` is the per-advertiser kill switch (quality control 5) and is
 * reversible. `closed` is the end of the commercial relationship — the
 * advertiser left, was declined or suspended, or the publisher account was
 * deauthorized — and reaching it retires offers while preserving every
 * observation, run, rights version and quality snapshot.
 */
export type AwinActivation = 'candidate' | 'sampling' | 'active' | 'paused' | 'closed';

export const AWIN_ACTIVATIONS: readonly AwinActivation[] = [
  'candidate',
  'sampling',
  'active',
  'paused',
  'closed',
];

/** The activations under which this advertiser's feed may be fetched at all. */
export const AWIN_FETCHING_ACTIVATIONS: readonly AwinActivation[] = ['sampling', 'active'];

/**
 * The state of one publisher ACCOUNT — the network-level fact.
 *
 * Separate from every advertiser's own health, which is issue acceptance 5:
 * "source and advertiser health are observable separately". With one Mercaria
 * source per advertiser, an advertiser's health is its own
 * `catalog_source_configs.health_state`; this is the only place the NETWORK has
 * one.
 *
 * `deauthorized` is the state that costs money if it is handled wrongly. A
 * revoked key makes every feed unreadable, which looks exactly like a network
 * whose catalogue shrank to nothing — so it stops refresh and retires NOTHING,
 * which is #62's `paused` semantics raised to the account.
 */
export type AwinAccountState = 'active' | 'paused' | 'deauthorized';

export const AWIN_ACCOUNT_STATES: readonly AwinAccountState[] = [
  'active',
  'paused',
  'deauthorized',
];

/**
 * Why an account stopped being usable.
 *
 * `credential_rejected` and `account_closed` are told apart because they lead
 * to different people: the first is a key to rotate and the second is a
 * relationship to re-establish. `operator` covers a deliberate pause.
 */
export type AwinAccountStateReason =
  | 'operator'
  | 'credential_rejected'
  | 'account_closed'
  | 'network_unreachable';

export const AWIN_ACCOUNT_STATE_REASONS: readonly AwinAccountStateReason[] = [
  'operator',
  'credential_rejected',
  'account_closed',
  'network_unreachable',
];

/**
 * The network's OWN redirector hosts, and the whole of what a tracking link may
 * point at.
 *
 * `awin1.com` is Awin's click redirector (`/cread.php`, `/pclick.php`);
 * `zenaps.com` is the Awin-operated platform ShareASale's advertisers migrated
 * onto and which still emits deep links. Both appear with and without the `www`
 * label, and both spellings are listed rather than derived, because a
 * "strip an optional `www.`" rule is one more thing between a stranger's string
 * and a redirect.
 *
 * **Membership is compared label-wise against the whole host**, never with
 * `includes` or `endsWith` on a bare suffix: `awin1.com.evil.example` ends with
 * nothing in this list under an exact comparison and matches a careless one.
 *
 * A code CONSTANT and not a column, deliberately. A configurable set would make
 * "which hosts may Mercaria redirect to" answerable differently per deployment
 * and per row, which is the shape an open redirect eventually takes.
 *
 * ## The swap detector's false-positive analysis depends on WHAT these four are
 *
 * `assessAwinDestination` (#589) reads a tracking host in the DESTINATION column
 * as evidence that the feed's two URL columns were mapped to each other's roles.
 * That inference is only sound because these four are **Awin's own redirect
 * infrastructure** — not a CDN, not a hosting provider and not a URL shortener.
 * No retailer's storefront is served from any of them, so a destination landing
 * here cannot be an advertiser whose own site happens to sit behind one.
 *
 * If this set ever became configurable, or grew a generic shortener, that
 * inference stops holding and the conjunction stops being sufficient — which is
 * a second, independent reason to keep it exactly four code constants.
 */
export const AWIN_TRACKING_HOSTS: readonly string[] = [
  'awin1.com',
  'www.awin1.com',
  'zenaps.com',
  'www.zenaps.com',
];

/**
 * What happened when one row's `aw_deep_link` was examined.
 *
 * Only `approved` may sit beside a stored affiliate URL, and every other member
 * names a DIFFERENT thing to fix — which is why this is a union and not a
 * boolean. `rejected_host` is somebody's feed pointing somewhere it should not;
 * `rights_withheld` is Mercaria's own policy; `not_commissionable` is the
 * programme's state. A single "invalid" would send all three to the same
 * fruitless investigation.
 */
export type AwinTrackingVerdict =
  | 'approved'
  | 'absent'
  | 'rejected_scheme'
  | 'rejected_host'
  | 'rejected_shape'
  | 'rights_withheld'
  | 'not_commissionable';

export const AWIN_TRACKING_VERDICTS: readonly AwinTrackingVerdict[] = [
  'approved',
  'absent',
  'rejected_scheme',
  'rejected_host',
  'rejected_shape',
  'rights_withheld',
  'not_commissionable',
];

/** The one verdict under which a tracked destination may be published. */
export const AWIN_APPROVED_TRACKING_VERDICT: AwinTrackingVerdict = 'approved';

/**
 * What a pre-activation sample found (issue quality control 4).
 *
 * A closed set, so "the sample failed" is always accompanied by which of six
 * things failed. `destination_is_tracking_host` is the subtle one: a deep link
 * and a destination that disagree about which retailer this is means the feed's
 * two URL columns were mapped to each other's roles, which produces a catalogue
 * that works perfectly until somebody audits where the money went.
 *
 * ## It is named for the OBSERVATION, not the inferred cause
 *
 * `columns_swapped` would assert an intent Mercaria cannot observe — an
 * advertiser could publish a retailer URL as the deep link and a tracked URL as
 * the destination deliberately. That is operationally the same problem, and the
 * finding still should not claim to know why: an operator pausing a live
 * programme is acting on a NAME, so the name has to be the fact that was
 * measured. `assessAwinDestination` states the same rule from the other side.
 *
 * It did not REPURPOSE the member it replaces, and that is the point of it
 * being a new name. `destination_host_mismatch` meant "the destination
 * disagrees with the advertiser's DECLARED host"; #589 deleted
 * `awin_advertisers.declared_host` — a column with no writer, no obtainable
 * value and no non-circular way to derive one — so that comparison has no
 * expectation left to make. Reusing its name for the new fact would make every
 * historical `awin_link_samples` row assert something nobody recorded, which is
 * why it went with the column instead.
 */
export type AwinSampleFinding =
  | 'tracking_missing'
  | 'tracking_host_not_approved'
  | 'destination_insecure_scheme'
  | 'destination_unresolvable'
  | 'destination_is_tracking_host'
  | 'destination_missing';

export const AWIN_SAMPLE_FINDINGS: readonly AwinSampleFinding[] = [
  'tracking_missing',
  'tracking_host_not_approved',
  'destination_insecure_scheme',
  'destination_unresolvable',
  'destination_is_tracking_host',
  'destination_missing',
];

/** How one sample ended. `pending` exists because a sample is taken over time. */
export type AwinSampleVerdict = 'pending' | 'passed' | 'failed';

export const AWIN_SAMPLE_VERDICTS: readonly AwinSampleVerdict[] = ['pending', 'passed', 'failed'];

/** The one verdict that permits an advertiser to leave `sampling` for `active`. */
export const AWIN_ACTIVATING_SAMPLE_VERDICT: AwinSampleVerdict = 'passed';

/**
 * The claims an advertiser's FEED may never establish (issue adapter rule 7).
 *
 * DISJOINT from everything this domain can record, gated by a test — the
 * `RETAIL_FORBIDDEN_COMPONENT_KINDS` device. An Awin advertiser publishing a
 * brand's products is a retailer that stocks them, and reading it as anything
 * more is a badge nobody verified on a page a buyer trusts.
 *
 * These are #55's kinds, and #55's `SUFFICIENT_EVIDENCE_KINDS` already excludes
 * every evidence kind a feed could supply. Naming them here as VALUES is what
 * makes the prohibition checkable from this side too, rather than depending on
 * a reader of this domain knowing what is in that one.
 */
export const AWIN_FORBIDDEN_ADVERTISER_CLAIMS: readonly string[] = [
  'official_store',
  'authorized_reseller',
  'brand_owner',
  'manufacturer',
  'exclusive_distributor',
];

/**
 * The Awin feed columns Mercaria requests and reads — an ALLOW-LIST.
 *
 * `services/payments/redact.ts`'s precedent, applied to a column set rather than
 * a payload: Mercaria asks for these and maps these, so an advertiser that maps
 * a column Mercaria did not ask for changes nothing about what is read.
 *
 * **Awin ships only the columns an advertiser MAPPED**, which is why identifier
 * coverage is a per-advertiser measurement and never an assumption (#64 §6,
 * Awin rule 2: "the adapter must record per-feed column presence and never
 * fabricate absent identifiers"). Every name here is one Awin publishes; the
 * mapping is built from the intersection of this tuple and the feed's own
 * header row.
 */
export const AWIN_FEED_COLUMNS = [
  'aw_deep_link',
  'merchant_deep_link',
  'aw_product_id',
  'merchant_product_id',
  'merchant_id',
  'merchant_name',
  'product_name',
  'description',
  'brand_name',
  'model_number',
  'ean',
  'upc',
  'isbn',
  'mpn',
  'product_type',
  'merchant_category',
  'category_name',
  'search_price',
  'store_price',
  'rrp_price',
  'currency',
  'in_stock',
  'stock_quantity',
  'is_for_sale',
  'condition',
  'merchant_image_url',
  'aw_image_url',
  'alternate_image',
  'delivery_cost',
  'delivery_time',
  'warranty',
  'language',
  'last_updated',
  'colour',
  'size',
  'material',
] as const;

export type AwinFeedColumn = (typeof AWIN_FEED_COLUMNS)[number];

/**
 * The column that IDENTIFIES one object in an Awin feed.
 *
 * ONE column, and a code CONSTANT rather than a per-advertiser choice — which
 * is #63's frozen `identity_key_fields` rule inherited rather than re-decided.
 * Changing it re-mints every object in every Awin feed at once: the old ids stop
 * being mentioned by a completed enumeration and are RETIRED, the new ones
 * arrive as first-time observations, and the whole thing looks exactly like
 * every retailer replacing their catalogue overnight, with no error anywhere.
 * No configuration surface should be able to do that by accident, so there is
 * no configuration surface for it.
 *
 * `aw_product_id` is Awin's own id for the row, and it is available by
 * CONSTRUCTION: Mercaria asks for a fixed column set on every download, so the
 * response carries it whatever the advertiser mapped. `merchant_product_id` —
 * the advertiser's SKU — is carried as `sku` instead, where #58 can read it as
 * an identifier without it becoming Mercaria's idea of which row this is.
 *
 * **Requires account approval:** whether `aw_product_id` is stable across
 * Awin's own feed REGENERATIONS is not verifiable from the public
 * documentation. If it turns out not to be, the correct response is #63's — a
 * NEW source, which is honest about re-minting — and never a quiet re-key.
 */
export const AWIN_IDENTITY_COLUMNS: readonly AwinFeedColumn[] = ['aw_product_id'];

/**
 * The version of the Awin column→role mapping this deployment ships.
 *
 * A code CONSTANT and not a table — `CATALOG_BACKFILL_MAPPING_VERSION`'s
 * reasoning: the mapping is a PROCEDURE, and a table would let somebody publish
 * a version whose rules nobody shipped. It is stamped on every import, which is
 * what makes a re-import sweep expressible when the number moves.
 */
export const AWIN_MAPPING_VERSION = 1;

/**
 * Awin's published Publisher API allowance: 20 calls a minute per user.
 *
 * <https://help.awin.com/apidocs>. It is a NETWORK bound, which is why the
 * lease that enforces it is keyed on the publisher ACCOUNT and not on a source:
 * with one Mercaria source per advertiser, a per-source budget bounds each
 * advertiser separately and the network not at all.
 */
export const AWIN_PUBLISHER_API_CALLS_PER_MINUTE = 20;

/**
 * The longest window `GET /publishers/{id}/transactions` accepts: 31 days.
 *
 * <https://help.awin.com/apidocs/returns-a-list-of-transactions-for-a-given-publisher>.
 * #67 owns commission reconciliation and #66 calls that endpoint from nowhere;
 * what #66 supplies is this number and the chunker that reads it, because
 * getting the chunking wrong silently drops a day of commission at every
 * boundary and the error is invisible in the result.
 */
export const AWIN_PUBLISHER_API_MAX_WINDOW_DAYS = 31;

/** One closed window a transactions query may cover. Both ends inclusive. */
export interface AwinTransactionWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * One row of Awin's feed list, in Mercaria's own words.
 *
 * The list is the network's inventory of what this publisher may download, and
 * every field here is one Awin publishes. `lastImported` is the one that decides
 * the refresh schedule: a feed whose value has not moved past what Mercaria last
 * consumed is not downloaded at all.
 *
 * It carries NO download URL, and that is deliberate. The URL embeds the
 * product-data API key in its path, so it is a credential wearing a hostname
 * (#63's rule, inherited rather than re-decided) — it is composed at fetch time
 * from the locator and never stored on a row, projected into a response or
 * written to a log.
 */
export interface AwinFeedListing {
  readonly advertiserId: string;
  readonly advertiserName: string;
  readonly feedId: string;
  readonly feedName: string;
  readonly membershipStatus: AwinMembershipStatus;
  readonly primaryRegion: string | null;
  readonly language: string | null;
  readonly currency: string | null;
  readonly vertical: string | null;
  readonly productCount: number | null;
  /** ISO-8601, or `null` when Awin published nothing parseable. */
  readonly lastImported: string | null;
}

/**
 * What one import measured about one advertiser's data (issue quality
 * control 1).
 *
 * Counts, not opinions, and `scanned = mapped + rejected` is a CHECK on the row
 * — #60's vacuity floor, so a pass that swallowed records cannot write the
 * snapshot at all. "Zero rejected over zero scanned" and "zero rejected over
 * fifty thousand scanned" are the two readings a bare rejection count cannot
 * tell apart.
 */
export interface AwinQualityCounts {
  readonly scanned: number;
  readonly mapped: number;
  readonly rejected: number;
  readonly withGtin: number;
  readonly withMpn: number;
  readonly withBrand: number;
  readonly withImage: number;
  readonly withPrice: number;
  readonly duplicateExternalIds: number;
  readonly duplicateGtins: number;
  readonly rejectedCurrency: number;
  readonly rejectedPrice: number;
  readonly contradictoryAvailability: number;
  readonly trackingApproved: number;
  readonly trackingRejected: number;

  /**
   * Rows whose DESTINATION column carried a tracking host while the deep-link
   * column did not — `assessAwinDestination`'s `tracking_host` verdict (#589).
   *
   * The observation `destination_is_tracking_host` names, counted over the whole
   * feed rather than over a sample. Non-zero means the two URL columns disagree
   * about which is which, and the money routes through a link nobody validated
   * as the destination.
   */
  readonly destinationTrackingHost: number;

  /**
   * Rows where BOTH columns carried a tracking host — a tracked-only feed.
   *
   * This is the counter's POSITIVE CONTROL and it is not decoration. Without it
   * `destinationTrackingHost: 0` reads identically on a feed whose destinations
   * are all retailer hosts and on one where every destination is tracked and the
   * conjunction therefore never fired. "What would this report if the thing it
   * measures were absent?" has to have a different answer from what it reports
   * now, and this column is what supplies it, per advertiser.
   */
  readonly destinationTrackedOnly: number;
}

/**
 * There is deliberately NO `AwinOfferRouting` type here.
 *
 * The obvious shape — an `affiliate | external | informational` verdict derived
 * from a membership status, a rights verdict and a tracking verdict — would be
 * a SECOND derivation of something #62 already derives (`offerKindFor`, from
 * the rights and the source kind), and two representations of one fact can
 * disagree. What #66 owns is the narrower question #62 cannot see: may Mercaria
 * hand the network's tracking URL over at all? `assessAwinTrackingLink` answers
 * it, `withAssessedAwinTracking` applies the answer by WITHHOLDING the URL, and
 * #62's own `affiliate_params`-absent branch then produces exactly the right
 * offer with no new mechanism.
 */

