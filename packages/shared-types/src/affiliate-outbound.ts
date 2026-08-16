/**
 * Affiliate outbound redirects, click records and commission reconciliation
 * (#67, part of #37).
 *
 * Three things live here and they are deliberately three vocabularies rather
 * than one: where Mercaria may SEND somebody, what it RECORDS about having sent
 * them, and what a network later REPORTS about money. Collapsing any two is how
 * this domain goes wrong — a click read as a conversion invents revenue, and a
 * destination read off a request invents an open redirect.
 *
 * ## The failure mode that shapes all of it
 *
 * **An open redirect wearing a marketplace's name.** `/out/:token` exists to
 * send a buyer to somebody else's site, so every mechanism here is built so
 * that the set of places it can send them is not a function of anything a
 * caller supplies. The token carries an OFFER id and has no member a URL could
 * arrive in ({@link AffiliateOutboundTokenClaims}); the destination is read off
 * the stored offer; and the host is admitted by exact comparison against a
 * closed code constant plus an operator-approved, per-source allow-list. Each
 * of those is a shape rather than a check.
 *
 * The second failure mode is quieter and costs money the other way: **a
 * commission Mercaria booked that the network never paid.** Hence
 * {@link AffiliateTransactionState} is the NETWORK's word, revisions are
 * append-only, and nothing is posted to the ledger until the network says
 * `approved`.
 */

import type { CurrencyCode } from './money';

/* -------------------------------------------------------------------------- */
/*  The outbound redirect                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The opaque token's payload, and the whole of it.
 *
 * **There is no destination member, and that is requirement 1.** A token
 * "cannot encode or accept an arbitrary destination URL" is not a validation
 * somebody performs — it is the absence of a field. The signature stops a
 * stranger minting a token naming a guessed offer id, so nothing unsigned ever
 * reaches the database; it is not what stops an open redirect, because the
 * payload could not express one in the first place.
 *
 * The `nonce` is not a lifetime and not a session: it makes two tokens for one
 * offer differ, so a token is not a guessable function of an offer id.
 */
export interface AffiliateOutboundTokenClaims {
  readonly offerId: string;
}

/** The prefix every outbound token carries, so a credential's kind is readable. */
export const AFFILIATE_OUTBOUND_TOKEN_PREFIX = 'mox_';

/**
 * How a destination host earned admission.
 *
 * `network_redirector` is one of the affiliate network's OWN redirectors, named
 * in a code constant for the reason #66 gives about `AWIN_TRACKING_HOSTS`: a
 * configurable set would make "which hosts may Mercaria redirect to" answerable
 * differently per deployment and per row, which is the shape an open redirect
 * eventually takes.
 *
 * `merchant_site` is a host an operator approved for one catalog source. It is
 * a row rather than a constant because which shop a source sells is a fact
 * about that commercial relationship, not about the code.
 */
export type OutboundDestinationKind = 'network_redirector' | 'merchant_site';

/** {@link OutboundDestinationKind} as the tuple the columns and CHECKs read. */
export const OUTBOUND_DESTINATION_KINDS: readonly OutboundDestinationKind[] = [
  'network_redirector',
  'merchant_site',
];

/**
 * The affiliate networks Mercaria can RECONCILE against.
 *
 * Narrower than `offers.affiliate_network`, which is free text carrying
 * whatever a source declared. A network is on this list when Mercaria has a
 * report reader for it, so a `affiliate_transactions` row can never name a
 * network nothing could have produced it.
 */
export type AffiliateNetworkId = 'awin' | 'ebay';

/** {@link AffiliateNetworkId} as the tuple the columns and CHECKs read. */
export const AFFILIATE_NETWORK_IDS: readonly AffiliateNetworkId[] = ['awin', 'ebay'];

/**
 * Whether a network can carry a Mercaria click reference out and back again.
 *
 * **Both members are `not_supported`, and that is a measured fact rather than
 * an omission.** #65 forbids composing or mutating an EPN link and #66 forbids
 * composing an Awin one — attribution belongs to the link's own parameters, and
 * Mercaria hands the provider's URL over verbatim. So there is no per-click
 * parameter Mercaria could add, and therefore no reference for the network to
 * echo back. Every reported transaction is consequently
 * {@link AffiliateMatchState} `unmatched`, under the reason
 * `network_supplies_no_reference`.
 *
 * Naming it as a VALUE is what makes the consequence legible. The alternative —
 * an absent column and a paragraph — reads as an oversight, and the day a
 * network's contract does support a publisher reference, the change is this
 * record plus the adapter that sends it, with nothing in the matching path to
 * rewrite.
 */
export type AffiliateClickReferenceSupport = 'not_supported' | 'publisher_supplied';

/**
 * Per network, whether Mercaria can supply a click reference. See the type.
 *
 * A `Record` rather than a tuple so adding a network fails to compile until
 * somebody states which it is.
 */
export const AFFILIATE_CLICK_REFERENCE_SUPPORT: Readonly<
  Record<AffiliateNetworkId, AffiliateClickReferenceSupport>
> = {
  // eBay's affiliate URL is minted by eBay under the campaign id Mercaria sends
  // in an INGESTION header, not per click. #65's `EBAY_FORBIDDEN_LINK_OPERATIONS`
  // makes appending one to the destination unrepresentable.
  ebay: 'not_supported',
  // Awin's `aw_deep_link` carries the network's own parameters. #66 admits the
  // host and stores the URL unmodified; nothing may append a `clickref`.
  awin: 'not_supported',
};

/**
 * Every reason a redirect can refuse, including the five #68's gate produces.
 *
 * ONE tuple rather than two, because it is what the click row's CHECK reads and
 * a click is written on the refusing path too — a refusal that stored no row
 * would make "how often does this source refuse" unanswerable, which is exactly
 * the question an operator asks when a merchant reports a dead button.
 *
 * The first five are `OutboundRefusalReason` from
 * `services/offer-freshness/outbound-gate.ts`. They are repeated here rather
 * than imported because a shared-types tuple cannot depend on the backend, and
 * `outbound-refusal-reasons.test.ts` asserts this tuple is a SUPERSET of that
 * one — so a reason added there fails the build here rather than being written
 * into a column no CHECK admits.
 */
export type OutboundRedirectRefusalReason =
  // ── #68's gate ────────────────────────────────────────────────────────────
  | 'offer_not_found'
  | 'offer_retired'
  | 'offer_not_current'
  | 'no_destination'
  | 'outbound_not_permitted'
  // ── This domain's admission ───────────────────────────────────────────────
  /** The token did not verify, or names an offer that is not addressable. */
  | 'token_invalid'
  /** The stored URL did not parse as a URL at all. */
  | 'destination_unparseable'
  /** Anything but `https:`. A downgrade is not a destination. */
  | 'destination_scheme_not_https'
  /** `user:pass@host` — a credential in a URL Mercaria is about to publish. */
  | 'destination_credentials_present'
  /** The host is on no allow-list for this offer's source. */
  | 'destination_host_not_allowlisted'
  /** The destination points back at Mercaria — requirement 10's loop. */
  | 'destination_is_mercaria'
  /** A native offer. Requirement 6, and unreachable — see the note below. */
  | 'native_offer';

/** {@link OutboundRedirectRefusalReason} as the tuple the columns and CHECKs read. */
export const OUTBOUND_REDIRECT_REFUSAL_REASONS: readonly OutboundRedirectRefusalReason[] = [
  'offer_not_found',
  'offer_retired',
  'offer_not_current',
  'no_destination',
  'outbound_not_permitted',
  'token_invalid',
  'destination_unparseable',
  'destination_scheme_not_https',
  'destination_credentials_present',
  'destination_host_not_allowlisted',
  'destination_is_mercaria',
  'native_offer',
];

/**
 * What happened to one request for `/out/:token`.
 *
 * A STRING discriminant, not a boolean: the backend compiles `strict: false`,
 * so `if (!result.redirected)` does not narrow a boolean-literal union and the
 * caller is left holding both branches (#68's finding, hit again here).
 */
export type OutboundRedirectDisposition = 'redirected' | 'refused';

/** {@link OutboundRedirectDisposition} as the tuple the columns and CHECKs read. */
export const OUTBOUND_REDIRECT_DISPOSITIONS: readonly OutboundRedirectDisposition[] = [
  'redirected',
  'refused',
];

/**
 * The facts a click record may hold — an ALLOW-LIST, walked at runtime.
 *
 * #77's posture, and the reasoning is the same one `services/payments/redact.ts`
 * gives: the absent columns are the enforcement. What makes it worth naming
 * positively is that this row is written on a path that has a whole HTTP
 * request in scope, so every identifying thing a request carries is one
 * `req.` away.
 */
export const AFFILIATE_CLICK_RECORDED_FACTS = [
  'click_id',
  'offer_id',
  'canonical_variant_id',
  'merchant_id',
  'storefront_id',
  'catalog_source_id',
  'affiliate_network',
  'affiliate_program_ref',
  'affiliate_publisher_ref',
  'destination_host',
  'destination_kind',
  'market',
  'client_surface',
  'traffic_class',
  'traffic_signal',
  'consent_mode',
  'disposition',
  'refusal_reason',
  'occurred_at',
] as const;

/** One of {@link AFFILIATE_CLICK_RECORDED_FACTS}. */
export type AffiliateClickRecordedFact = (typeof AFFILIATE_CLICK_RECORDED_FACTS)[number];

/**
 * What a click record may NEVER hold, named as values.
 *
 * DISJOINT from {@link AFFILIATE_CLICK_RECORDED_FACTS} by a test, and scanned
 * for as column names by `outbound-isolation.test.ts`. The
 * `RETAIL_FORBIDDEN_COMPONENT_KINDS` device: the absence already makes each one
 * unwritable, and naming them is what lets a refusal say WHICH prohibition was
 * reached and what makes a later widening fail a disjointness test rather than
 * pass silently.
 *
 * `ip_address` and `user_agent` are the two worth reading. Both are in scope on
 * the redirect path and both are what a classifier is tempted to persist "for
 * debugging"; #143's traffic classifier is deliberately built so its verdict
 * carries a bounded `signal` enum instead of the header that produced it, and
 * this list is that decision made structural one domain over.
 */
export const AFFILIATE_FORBIDDEN_CLICK_FACTS = [
  'ip_address',
  'user_agent',
  'device_fingerprint',
  'cookie_id',
  'referer_url',
  'screen_metrics',
  'accept_language',
  'email',
  'email_hash',
  'phone',
  'postal_address',
  'card_fingerprint',
  'payment_method',
  'provider_customer_id',
  'wallet_address',
  'browsing_history',
] as const;

/** One of {@link AFFILIATE_FORBIDDEN_CLICK_FACTS}. */
export type AffiliateForbiddenClickFact = (typeof AFFILIATE_FORBIDDEN_CLICK_FACTS)[number];

/**
 * The surface a click came from, as the CLIENT declared it.
 *
 * Deliberately the same four words #143 uses (`ReferralClientSurface`) rather
 * than a fifth vocabulary for the same fact. It is self-declared and
 * unverified, which is why it is a coarse enum and never a device string.
 */
export type OutboundClientSurface = 'web' | 'ios' | 'android' | 'other';

/** {@link OutboundClientSurface} as the tuple the columns and CHECKs read. */
export const OUTBOUND_CLIENT_SURFACES: readonly OutboundClientSurface[] = [
  'web',
  'ios',
  'android',
  'other',
];

/**
 * The link semantics a public web page must render on an outbound control
 * (requirement 8).
 *
 * A CONSTANT rather than something each surface composes, because "is this link
 * disclosed as paid" is one answer and three clients would eventually give
 * three. `sponsored` is the relationship; `nofollow` is belt-and-braces for
 * crawlers that predate it; `noopener` is unrelated to disclosure and is here
 * because a target that can reach `window.opener` is a tabnabbing surface on
 * every link this domain emits.
 */
export const OUTBOUND_LINK_REL = 'sponsored nofollow noopener';

/* -------------------------------------------------------------------------- */
/*  Network reports: conversions and commission                                */
/* -------------------------------------------------------------------------- */

/**
 * The lifecycle of one network-reported transaction — the NETWORK's word, never
 * Mercaria's opinion.
 *
 * The issue names exactly these five. `pending` and `approved` are different
 * facts about money and only the second may reach the ledger: a pending
 * commission is a claim the network may still decline, and booking one would be
 * the invented sale trust principle 4 forbids.
 */
export type AffiliateTransactionState =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'reversed'
  | 'paid';

/** {@link AffiliateTransactionState} as the tuple the columns and CHECKs read. */
export const AFFILIATE_TRANSACTION_STATES: readonly AffiliateTransactionState[] = [
  'pending',
  'approved',
  'declined',
  'reversed',
  'paid',
];

/**
 * The states in which Mercaria has EARNED the commission and may book it.
 *
 * Stated positively and kept beside the lifecycle, because what it defends is
 * an omission: `pending` is not in it and cannot be added without this line
 * changing in the same diff as whatever made it necessary. The
 * `RETAIL_REVENUE_SIDE_ACCOUNTS` device.
 *
 * `paid` is included because a network may report a transaction as `paid`
 * having never shown it as `approved` — the accrual and the settlement are then
 * two postings from one observation, not a reason to skip the accrual.
 */
export const AFFILIATE_EARNED_STATES: readonly AffiliateTransactionState[] = ['approved', 'paid'];

/**
 * Whether a reported transaction could be tied to a Mercaria click.
 *
 * TWO members. There is no `probable`, no `inferred` and no confidence score,
 * because conversion requirement 6 says an attribution without a Mercaria click
 * id is "marked as unmatched rather than guessed" — and a third member is
 * precisely where a guess would live.
 */
export type AffiliateMatchState = 'matched' | 'unmatched';

/** {@link AffiliateMatchState} as the tuple the columns and CHECKs read. */
export const AFFILIATE_MATCH_STATES: readonly AffiliateMatchState[] = ['matched', 'unmatched'];

/**
 * WHY a transaction is unmatched. An operator needs the difference.
 *
 * `network_supplies_no_reference` is the one every transaction gets today, and
 * it is a fact about the adapter contract rather than about the transaction —
 * see {@link AFFILIATE_CLICK_REFERENCE_SUPPORT}. Reporting it as
 * `no_reference_reported` would read as the network having dropped something it
 * was sent.
 */
export type AffiliateUnmatchedReason =
  | 'network_supplies_no_reference'
  | 'no_reference_reported'
  | 'reference_not_recognized'
  | 'reference_network_mismatch';

/** {@link AffiliateUnmatchedReason} as the tuple the columns and CHECKs read. */
export const AFFILIATE_UNMATCHED_REASONS: readonly AffiliateUnmatchedReason[] = [
  'network_supplies_no_reference',
  'no_reference_reported',
  'reference_not_recognized',
  'reference_network_mismatch',
];

/**
 * What one observation changed about a transaction (the append-only trail).
 *
 * `restated` is separate from `amount_change` on purpose: a network re-reporting
 * the same state with a different commission is a correction, and it is the one
 * an operator wants to see listed. `unchanged` exists so a re-poll that
 * confirmed a row is countable — the vacuity floor on a reconciliation run
 * depends on every seen transaction landing in exactly one bucket.
 */
export type AffiliateObservationKind =
  | 'first_observation'
  | 'state_change'
  | 'amount_change'
  | 'restated'
  | 'unchanged';

/** {@link AffiliateObservationKind} as the tuple the columns and CHECKs read. */
export const AFFILIATE_OBSERVATION_KINDS: readonly AffiliateObservationKind[] = [
  'first_observation',
  'state_change',
  'amount_change',
  'restated',
  'unchanged',
];

/**
 * What a ledger posting for an affiliate transaction is FOR.
 *
 * Three kinds and no more. A correction is a `reversal` — a NEW balanced,
 * reversing transaction — because the ledger rules forbid a helper that derives
 * a correction from what is stored rather than from what an operator or a
 * network decided.
 */
export type AffiliateCommissionPostingKind = 'accrual' | 'reversal' | 'settlement';

/** {@link AffiliateCommissionPostingKind} as the tuple the columns and CHECKs read. */
export const AFFILIATE_COMMISSION_POSTING_KINDS: readonly AffiliateCommissionPostingKind[] = [
  'accrual',
  'reversal',
  'settlement',
];

/** How one poll of a network's report ended. */
export type AffiliateReportRunState = 'running' | 'completed' | 'failed';

/** {@link AffiliateReportRunState} as the tuple the columns and CHECKs read. */
export const AFFILIATE_REPORT_RUN_STATES: readonly AffiliateReportRunState[] = [
  'running',
  'completed',
  'failed',
];

/**
 * Why a poll failed, in the network's own terms, bounded.
 *
 * The taxonomy #65 arrived at, narrowed: the difference an operator acts on is
 * "our credential is wrong" against "we were throttled" against "they were
 * down", and a free-text message would make that ungreppable.
 */
export type AffiliateReportFailureReason =
  | 'credential_unavailable'
  | 'auth_failure'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'response_unreadable'
  | 'budget_exhausted'
  | 'network_not_configured';

/** {@link AffiliateReportFailureReason} as the tuple the columns and CHECKs read. */
export const AFFILIATE_REPORT_FAILURE_REASONS: readonly AffiliateReportFailureReason[] = [
  'credential_unavailable',
  'auth_failure',
  'rate_limited',
  'upstream_unavailable',
  'response_unreadable',
  'budget_exhausted',
  'network_not_configured',
];

/* -------------------------------------------------------------------------- */
/*  Read models                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the product page needs in order to render an outbound control.
 *
 * The HOST and not the URL — trust principle 1 ("the external action says which
 * merchant will receive the user") is satisfied by a hostname, and a full URL on
 * a public page would hand a crawler the tracked destination without the click
 * record that makes it attributable.
 */
export interface OutboundDisclosure {
  readonly destinationHost: string;
  readonly redirectPath: string;
  readonly rel: string;
}

/** One network's totals for a period. Absolute amounts, never a ratio. */
export interface AffiliateCommissionTotals {
  readonly currency: CurrencyCode;
  readonly pendingMinor: number;
  readonly approvedMinor: number;
  readonly declinedMinor: number;
  readonly reversedMinor: number;
  readonly paidMinor: number;
}

/**
 * The aggregate report (#67 "Reporting").
 *
 * `humanClicks` and `reportedConversions` sit on one object and are DELIBERATELY
 * never divided: #37 acceptance 3 and the #77 seam both forbid a
 * click-to-conversion rate, because a network report is revisable for weeks and
 * a click is not, so the ratio moves without either input being wrong. There is
 * no `conversionRate` field for the same reason there is no destination field on
 * the token.
 */
export interface AffiliateOutboundReport {
  readonly network: AffiliateNetworkId;
  readonly from: string;
  readonly to: string;
  readonly humanClicks: number;
  readonly nonHumanClicks: number;
  readonly refusedClicks: number;
  readonly reportedConversions: number;
  readonly unmatchedConversions: number;
  readonly reversedConversions: number;
  readonly totals: readonly AffiliateCommissionTotals[];
  /** When the newest observation in this window was taken. */
  readonly lastObservedAt: string | null;
  /** Seconds between the newest reported event and its observation — report lag. */
  readonly reportLagSeconds: number | null;
}
