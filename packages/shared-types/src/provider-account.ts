/**
 * Provider-account DTOs — a seller's standing with a payment rail.
 *
 * A store or a P2P seller has at most one account per rail, and this file
 * declares what Mercaria is willing to say about it. Like `./payment`, nothing
 * here names a provider's own vocabulary: Stripe's `acct_…`, its
 * `requirements.disabled_reason` strings and its capability map all stay behind
 * the adapter, which maps them onto the closed sets below.
 *
 * ## Readiness is a DERIVED verdict with exactly one representation
 *
 * ADR 0001 D9 defines payment readiness as a conjunction — payouts enabled, the
 * transfers capability active, nothing due or past due, and the account not
 * disabled. That conjunction is evaluated once, when provider state is
 * synchronised, and stored as {@link ProviderOnboardingState}. There is
 * deliberately no second `ready` boolean beside it: two representations of one
 * fact can disagree, and the one thing a checkout gate may not do is let a
 * seller through because the flag and the state had drifted.
 *
 * So `ready` is not a field, it is `onboardingState === 'ready'`, and
 * {@link ProviderAccountStatus.paymentReady} is that comparison rendered for a
 * client rather than a stored column.
 *
 * ## What is deliberately NOT here
 *
 * No identity or verification data of any kind. ADR 0001 D2 sets
 * `controller.requirement_collection = stripe`, so the provider collects and
 * holds KYC and Mercaria stores only how MANY requirements are outstanding and
 * when they are due. A field name like `individual.verification.document` is not
 * a value, but it still describes a specific person's missing paperwork, and the
 * seller resolves it in the provider's own hosted flow where it belongs.
 */

import type { PaymentProviderId } from './payment';

/**
 * Who a provider account belongs to — a business store or a P2P seller.
 *
 * The same two kinds `OrderSellerType` and `LedgerOwnerType` distinguish, and a
 * third tuple rather than an import of either, for the reason the ledger's own
 * docblock gives: each domain names its owner in its own vocabulary so a row can
 * be read without a translation table. A `LEDGER_OWNER_TYPES` constraining a
 * table that books no entries would be the coupling, not the saving.
 */
export type ProviderAccountOwnerType = 'store' | 'user';

/** {@link ProviderAccountOwnerType} as the tuple the column types and CHECKs read. */
export const PROVIDER_ACCOUNT_OWNER_TYPES: readonly ProviderAccountOwnerType[] = ['store', 'user'];

/**
 * How far a seller has got with a payment rail, and whether they may sell.
 *
 * Six states, ordered from "nothing exists" to "this will not recover on its
 * own". Only `ready` permits a native checkout (ADR 0001 D4/D9); every other
 * value refuses that seller's group and is shown to the seller with the action
 * that changes it.
 *
 *  - `not_connected` — no account with this provider. The seller has never
 *    started, and this is also what a store with an external connector and no
 *    interest in native payments stays at forever. Catalogue visibility is NOT
 *    gated on any of this (D9).
 *  - `action_required` — an account exists and the provider is waiting on the
 *    seller. Requirements are outstanding, or the transfers capability has not
 *    become active yet. The seller resumes the hosted flow.
 *  - `under_review` — the provider has what it asked for and is deciding.
 *    Nothing for the seller to do, which is exactly why it is a state of its
 *    own rather than more `action_required`: telling someone to act when there
 *    is no action is how a support ticket is opened.
 *  - `ready` — the D9 conjunction holds. Native checkout is permitted.
 *  - `restricted` — the account was working and has stopped. Requirements went
 *    past due, or the provider paused payouts. Recoverable BY THE SELLER, which
 *    is what separates it from `disabled`.
 *  - `disabled` — the provider rejected the account, or the platform's
 *    authorisation was revoked. Not recoverable by resuming onboarding.
 *
 * `restricted` and `disabled` are distinct for the same reason `restrict` and
 * `freeze_transaction` are distinct in moderation: collapsing a recoverable
 * state into a terminal one tells a seller their business is over when it is
 * not, and collapsing the terminal one into the recoverable one sends them
 * round a hosted flow that cannot help them.
 */
export type ProviderOnboardingState =
  | 'not_connected'
  | 'action_required'
  | 'under_review'
  | 'ready'
  | 'restricted'
  | 'disabled';

/** {@link ProviderOnboardingState} as the tuple the column types and CHECKs read. */
export const PROVIDER_ONBOARDING_STATES: readonly ProviderOnboardingState[] = [
  'not_connected',
  'action_required',
  'under_review',
  'ready',
  'restricted',
  'disabled',
];

/**
 * The state of ONE capability Mercaria asked a provider for.
 *
 * Under ADR 0001 D3 there is exactly one — `transfers` — and `active` is half
 * the readiness conjunction. `pending` and `inactive` are not interchangeable:
 * the first is the provider working, the second is the provider declining, and
 * they map to `under_review` and `action_required` respectively.
 *
 * The absence of a value is a third thing again — the capability was never
 * requested — which is why the column and the DTO field are both optional
 * rather than defaulting to `inactive`.
 */
export type ProviderCapabilityStatus = 'active' | 'inactive' | 'pending';

/** {@link ProviderCapabilityStatus} as the tuple the column types and CHECKs read. */
export const PROVIDER_CAPABILITY_STATUSES: readonly ProviderCapabilityStatus[] = [
  'active',
  'inactive',
  'pending',
];

/**
 * How much the provider is still waiting for — COUNTS, never the list.
 *
 * Four numbers and a deadline is everything a seller-facing surface can
 * honestly use: it can say "three things are outstanding, by the 14th" and send
 * them to the hosted flow that knows which three. Carrying the provider's own
 * requirement identifiers would put a description of one person's missing
 * paperwork in Mercaria's database for no behaviour that needs it.
 *
 * These are four real columns rather than a summary object precisely so the
 * distinction is structural: an integer cannot hold `individual.id_number`.
 */
export interface ProviderAccountRequirements {
  /** Outstanding now. Non-zero means the seller has something to do. */
  currentlyDue: number;
  /** Outstanding eventually — collected up front so payouts are never paused. */
  eventuallyDue: number;
  /** Overdue. Non-zero is what turns a working account `restricted`. */
  pastDue: number;
  /** Submitted and being checked by the provider — nothing for the seller to do. */
  pendingVerification: number;
  /** ISO-8601 instant by which `currentlyDue` must be satisfied, when the provider gives one. */
  currentDeadline?: string;
}

/**
 * When and how often the provider pays the seller's balance out to their bank.
 *
 * Display metadata only (issue #46, dashboard 4). Mercaria neither sets nor
 * enforces it — with `stripe_dashboard.type = express` the seller owns their own
 * payout settings — so it is shown when the provider supplies it and omitted
 * entirely when it does not.
 */
export interface ProviderPayoutSchedule {
  /** `manual`, `daily`, `weekly` or `monthly`, verbatim from the provider. */
  interval: string;
  /** Days the provider holds funds before a payout, when it reports one. */
  delayDays?: number;
}

/**
 * Everything Mercaria will tell a seller about their own provider account.
 *
 * This is the WHOLE of the read surface — the routes project exactly this and
 * nothing wider. Three things are absent on purpose and must stay absent:
 *
 *  - the provider's account id. The seller can see it in the provider's own
 *    dashboard; nothing in Mercaria's UI acts on it, and a field that exists is
 *    a field a future request body will eventually be allowed to set, which is
 *    the account-takeover shape issue #46 (security 3) names.
 *  - the provider's raw account payload, in whole or in part.
 *  - any credential, in any form.
 */
export interface ProviderAccountStatus {
  /** Which rail this standing is with. */
  provider: PaymentProviderId;
  /** Whether the owner is a store or a P2P seller. */
  ownerType: ProviderAccountOwnerType;
  /** The store id or Oxy user id this account belongs to. */
  ownerId: string;
  /** The single stored verdict; everything else on this DTO explains it. */
  onboardingState: ProviderOnboardingState;
  /** `onboardingState === 'ready'`, rendered. Never a stored column — see the file docblock. */
  paymentReady: boolean;
  /**
   * Whether the connected account may itself charge cards.
   *
   * Recorded because the provider reports it, and deliberately NOT part of the
   * readiness conjunction: under separate charges and transfers (ADR 0001 D3)
   * the connected account never charges anything, so a seller whose account
   * cannot charge is not thereby unable to sell.
   */
  chargesEnabled: boolean;
  /** Whether the provider will pay this account out. Half of the D9 conjunction. */
  payoutsEnabled: boolean;
  /** The transfers capability, absent when it was never requested. */
  transfersCapability?: ProviderCapabilityStatus;
  /**
   * ISO-3166-1 alpha-2, as the account was created. Immutable at the provider.
   *
   * Absent while `not_connected`, and absent rather than defaulted: Mercaria
   * stores no country for a store or a seller profile, so before an account
   * exists there is no answer — and inventing one would be shown to a seller as
   * the country their money is about to be settled in.
   */
  country?: string;
  /** The account's own settlement currency, as the provider reports it. */
  payoutCurrency?: string;
  /** Payout timing, when the provider supplies it. */
  payoutSchedule?: ProviderPayoutSchedule;
  /** Counts and the deadline — never the requirement list. */
  requirements: ProviderAccountRequirements;
  /**
   * Why the provider will not pay this account out, in its own machine-readable
   * codes, filtered to those safe to show the account's owner.
   *
   * Codes, not prose: a rendered explanation is the client's to write, and a
   * provider's own message is written for a different audience and can quote
   * back whatever it was given.
   */
  disabledReasonCodes: readonly string[];
  /** ISO-8601 instant of the last successful provider read. */
  lastSyncedAt?: string;
  /** ISO-8601 instant the account first became `ready`. */
  activatedAt?: string;
  /** ISO-8601 instant the platform's authorisation was revoked. */
  revokedAt?: string;
}

/**
 * The whole of the seller-facing payments settings surface.
 *
 * `account` alone would leave the client unable to tell "you have not connected
 * yet" from "this deployment cannot connect anyone", which are the same DTO and
 * opposite affordances — the first is a button, the second is an explanation.
 * Rather than answer that by putting a deployment fact on the ACCOUNT (where it
 * is not a property of anything), the route wraps it.
 */
export interface SellerPaymentSettings {
  /** This seller's standing, or the `not_connected` shape when there is none. */
  account: ProviderAccountStatus;
  /**
   * Whether hosted onboarding can be started or resumed here at all.
   *
   * False on a deployment with the rail switched off or half-configured. The
   * client disables its connect action; it does not hide the section, because a
   * seller asking "where do I get paid" deserves to be told rather than to find
   * nothing.
   */
  onboardingAvailable: boolean;
  /**
   * ISO-3166-1 alpha-2 codes onboarding accepts here (ADR 0001 D8).
   *
   * Sent so the client can offer the choice instead of discovering the refusal:
   * Mercaria stores no country for a store or a seller profile, so the country
   * an account is created in comes from the seller, once, and is immutable at
   * the provider afterwards.
   */
  supportedCountries: readonly string[];
}

/** What a client gets back after asking for a hosted-onboarding link. */
export interface ProviderOnboardingLink {
  /**
   * The provider-hosted URL to open, IN THE SYSTEM BROWSER.
   *
   * Single-use and short-lived (ADR 0001 D2), which is why it is minted per
   * request and never stored: a link in a database is a link that has expired by
   * the time anyone reads it, and one in an email is a link that left the app.
   */
  url: string;
  /** ISO-8601 instant after which the provider will refuse it. */
  expiresAt: string;
}
