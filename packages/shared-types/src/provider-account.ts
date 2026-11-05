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
 * So `ready` is not a field, it is `onboardingState === 'ready'`.
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
