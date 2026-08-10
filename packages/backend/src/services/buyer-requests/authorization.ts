/**
 * Who may file, withdraw or write to a buyer request — #110 authorization.
 *
 * ## The whole point: a read-only credential cannot reach a mutation, and that
 * is a SHAPE rather than a check
 *
 * #110 authorization rule 1 asks that "read-only portal scope is insufficient
 * for a mutation". The weak form of that is a scope check at the top of every
 * mutating service, which works until somebody adds the eighth one and forgets.
 * The strong form is what this module does: every mutating function in the
 * domain takes a {@link BuyerRequestActor}, and a `BuyerRequestActor` can only
 * be obtained from {@link authorizeBuyerRequest}, because the type carries a
 * module-private `unique symbol` that no other file can supply. There is no
 * object literal, no cast short of `as any` (which this repository forbids and
 * a lint rule refuses) and no partial that satisfies it.
 *
 * So the question "did this path check the scope?" is not answered by reading
 * the path. It is answered by the path existing at all.
 *
 * ## It COMPOSES #106 rather than re-deciding
 *
 * The order half of every decision is `authorizeOrderAccess`, called on a
 * subject built here from the credential. That is the issue's "every guest
 * post-purchase request must use the shared order-access service from #106",
 * and it is what makes rules 4 and 5 free: the grant's `checkout_group_id` is
 * compared to the ORDER's, so a credential for one group cannot reach an order
 * in another, and a request names ONE order so a sibling is never carried along.
 *
 * ## What this module cannot be given
 *
 * No email, no phone, no order number, no cart token, no Stripe identity, no IP
 * address. {@link BuyerRequestCredential} has no member any of them could
 * arrive in, which is authorization rule 6 held by the parameter list — the
 * `authorizeOrderAccess` device one layer up. `buyer-request-isolation.test.ts`
 * asserts it against `BUYER_REQUEST_FORBIDDEN_IDENTIFIERS`.
 */

import type {
  BuyerRequestActorKind,
  GuestOrderScope,
} from '@mercaria/shared-types';
import type { GuestOrderAccessGrantRow } from '../../db/guestPortal/grantRepository.js';
import { grantHasScope } from '../guest-portal/scopes.js';
import { stepUpSatisfied } from '../guest-portal/grant.service.js';
import { toOrderPortalGrant } from '../guest-portal/portal.service.js';
import {
  ORDER_ACCESS_DENIAL_REASONS,
  authorizeOrderAccess,
  resolveGuestPortalSubject,
  type OrderAccessDecision,
  type OrderAccessDenialReason,
  type OrderAccessFacts,
  type OrderAccessSubject,
} from '../orders/order-access.service.js';

/**
 * The brand. Module-private, so nothing outside this file can construct a
 * {@link BuyerRequestActor} — see the module docblock.
 *
 * A `unique symbol` rather than a string field, because a string field is
 * something a hand-written object can also have.
 */
const AUTHORIZED = Symbol('mercaria.buyerRequestAuthorization');

/**
 * What a buyer is trying to do, and what each one costs.
 *
 * A TABLE rather than a switch, the `claim-methods.ts` device from #83: the
 * services read properties off it and never ask "is this action a
 * cancellation", so adding an action means adding a row and deciding both
 * columns rather than finding every branch.
 */
export const BUYER_REQUEST_ACTIONS = {
  'cancellation:submit': { scope: 'cancellations:request', requiresStepUp: true },
  'cancellation:withdraw': { scope: 'cancellations:request', requiresStepUp: false },
  'return:submit': { scope: 'returns:request', requiresStepUp: true },
  'return:withdraw': { scope: 'returns:request', requiresStepUp: false },
  'support:write': { scope: 'support:write', requiresStepUp: false },
  'request:read': { scope: 'orders:read', requiresStepUp: false },
  /**
   * #127's four retail actions, on this table rather than on a second one.
   *
   * A `mercaria_retail` order is one MERCARIA sold, so #110's decision path —
   * which runs on `requireStorePermission` against the order's store — cannot
   * reach it; but the BUYER half is identical, because after the credential is
   * resolved there is nothing retail-shaped about asking for a remedy. Reusing
   * this table is what makes that literal: one unforgeable actor, one scope
   * check, one step-up rule and one composition of #106's order access, whatever
   * the order's commercial role turns out to be.
   *
   * Two scopes rather than one, mapped per REQUEST KIND by
   * `retailRequestAction` in `services/retail-service-requests/request-kinds.ts`:
   * a portal credential granted `cancellations:request` can ask Mercaria to stop
   * a purchase and cannot open a warranty claim with it, and the reverse. A
   * single `retail:request` scope would collapse two different grants into one.
   */
  'retail_cancellation:submit': { scope: 'cancellations:request', requiresStepUp: true },
  'retail_cancellation:withdraw': { scope: 'cancellations:request', requiresStepUp: false },
  'retail_remedy:submit': { scope: 'returns:request', requiresStepUp: true },
  'retail_remedy:withdraw': { scope: 'returns:request', requiresStepUp: false },
} as const satisfies Record<string, { scope: GuestOrderScope; requiresStepUp: boolean }>;

/** One of {@link BUYER_REQUEST_ACTIONS}. */
export type BuyerRequestAction = keyof typeof BUYER_REQUEST_ACTIONS;

/**
 * Why the two SUBMIT actions require a fresh inbox proof and the others do not.
 *
 * #110 authorization rule 3 says higher-risk actions CAN require one, and the
 * line drawn here is whether the action moves MONEY OR GOODS. Filing a
 * cancellation or a return does — a seller will act on it, stock will move and
 * a refund may follow — while withdrawing your own request and writing a
 * sentence into a support thread do not.
 *
 * The attack this closes is vandalism rather than theft: a refund always returns
 * to the original payment instrument (#110 refund rule 9), so somebody holding a
 * stolen 30-day portal credential gains no money by cancelling. They can still
 * destroy a purchase, and a purchase is the thing the person actually wanted.
 *
 * Requiring it on WITHDRAW would be worse than useless: it would put an email
 * round trip between a buyer and the undo of their own mistake, and the undo is
 * the safe direction.
 */
export const STEP_UP_REQUIRED_ACTIONS: readonly BuyerRequestAction[] = [
  'cancellation:submit',
  'return:submit',
  'retail_cancellation:submit',
  'retail_remedy:submit',
];

/**
 * The credential a buyer presented. Exactly one kind, and no common id field —
 * `CommerceActor`'s rule, three domains down.
 *
 * A `guest_portal` credential is the whole ROW rather than #106's projection,
 * because the scope set and the inbox-proof instant live on it and passing them
 * beside the grant would be two sources for one fact that a caller could pair up
 * wrongly. The projection is derived here, once, by #108's own
 * `toOrderPortalGrant`.
 */
export type BuyerRequestCredential =
  | { readonly kind: 'oxy_account'; readonly oxyUserId: string }
  | { readonly kind: 'guest_portal'; readonly grant: GuestOrderAccessGrantRow };

/**
 * An authorized buyer actor. UNFORGEABLE outside this module.
 *
 * Carries what the audit trail needs and nothing a service could act on: there
 * is no store id, no permission set and no order id, so holding one is not a
 * licence to touch a different order — every service re-states the order it was
 * authorized for by taking it as its own parameter.
 */
export interface BuyerRequestActor {
  readonly [AUTHORIZED]: true;
  readonly kind: BuyerRequestActorKind;
  readonly oxyUserId?: string;
  /** The portal grant that authorized it — the access-session audit. */
  readonly grantId?: string;
  /** Which action this actor was authorized FOR. */
  readonly action: BuyerRequestAction;
}

/**
 * Why a buyer request was refused.
 *
 * The order-access reasons pass through unchanged — those are #106's vocabulary
 * and re-spelling them here would be a second, drifting copy — plus the two
 * this layer adds.
 */
export type BuyerRequestDenialReason =
  | OrderAccessDenialReason
  /** The credential is live and does not carry this action's scope (rule 1/2). */
  | 'scope_not_granted'
  /** The inbox proof is stale and this action needs a fresh one (rule 3). */
  | 'step_up_required';

/**
 * The verdict. A STRING discriminant, not `authorized: true | false`.
 *
 * This backend compiles with `strict: false`, and without `strictNullChecks`
 * TypeScript does not narrow a union on a boolean-literal discriminant — so the
 * obvious spelling leaves every caller holding the whole union and unable to
 * read `.reason`. #68 measured it and `AGENTS.md` records it.
 */
export type BuyerRequestAuthorization =
  | { readonly outcome: 'authorized'; readonly actor: BuyerRequestActor }
  | { readonly outcome: 'refused'; readonly reason: BuyerRequestDenialReason };

/**
 * The denial reasons that are about the ORDER rather than about the credential.
 *
 * Answered 404 by every route, because "this order exists but is not yours" is a
 * fact about somebody else's purchase. The two this module adds are answered
 * 403: the caller demonstrably holds the order, and telling them their session
 * lacks a scope discloses nothing they did not already know.
 */
export function denialIsAboutTheOrder(reason: BuyerRequestDenialReason): boolean {
  return reason !== 'scope_not_granted' && reason !== 'step_up_required';
}

/**
 * The denial reason off a refusing `OrderAccessDecision`.
 *
 * #106's union discriminates on a BOOLEAN, which this file cannot narrow under
 * `strict: false` — so the reason is recovered by membership in #106's own
 * tuple rather than by an assertion. A verdict whose reason is somehow not in
 * it becomes `credential_not_order_scoped`, which is the refusing direction.
 */
function orderAccessDenialOf(decision: OrderAccessDecision): OrderAccessDenialReason {
  const reason = (decision as { reason: string }).reason;
  return (ORDER_ACCESS_DENIAL_REASONS as readonly string[]).includes(reason)
    ? (reason as OrderAccessDenialReason)
    : 'credential_not_order_scoped';
}

/** The `OrderAccessSubject` a credential becomes. ONE translation. */
function subjectFor(credential: BuyerRequestCredential): OrderAccessSubject {
  if (credential.kind === 'oxy_account') {
    return { kind: 'oxy_account', oxyUserId: credential.oxyUserId };
  }
  // `resolveGuestPortalSubject` returns `null` only for an absent grant, and a
  // credential of this kind always has one — so the fallback is unreachable and
  // written as a throw rather than as a silent alternative subject.
  const subject = resolveGuestPortalSubject(toOrderPortalGrant(credential.grant));
  if (subject === null) {
    throw new Error('A guest_portal credential produced no order-access subject');
  }
  return subject;
}

/**
 * May this credential perform this action on this order?
 *
 * Total, pure and side-effect free — no database, no configuration, and the only
 * clock is the one passed in. That is what makes the matrix a table a test can
 * drive rather than a behaviour assembled from six routes, and it is the same
 * property `authorizeOrderAccess` has for the same reason.
 *
 * The ORDER half runs first. A credential that cannot see the order at all is
 * refused for that reason and never learns whether it had the scope, which is
 * what keeps a scope refusal from becoming an oracle over orders belonging to
 * somebody else.
 */
export function authorizeBuyerRequest(input: {
  credential: BuyerRequestCredential;
  order: OrderAccessFacts;
  action: BuyerRequestAction;
  now: Date;
}): BuyerRequestAuthorization {
  const decision = authorizeOrderAccess(subjectFor(input.credential), input.order, input.now);
  // `authorizeOrderAccess` is #106's and DOES use a boolean discriminant, which
  // this file cannot narrow — so the reason is read from the refusing branch by
  // asking for it explicitly rather than by relying on the compiler.
  if (!decision.allowed) {
    return { outcome: 'refused', reason: orderAccessDenialOf(decision) };
  }

  const policy = BUYER_REQUEST_ACTIONS[input.action];

  if (input.credential.kind === 'oxy_account') {
    // An Oxy account proves itself on every request with a bearer token, so
    // there is no scope set to consult and no staleness to measure: the
    // credential IS fresh by construction. Rule 7 — "a claimed checkout may use
    // authenticated Oxy authorization" — is this branch, and the original guest
    // audit is preserved because nothing here rewrites a request somebody else
    // filed.
    return {
      outcome: 'authorized',
      actor: {
        [AUTHORIZED]: true,
        kind: 'oxy',
        oxyUserId: input.credential.oxyUserId,
        action: input.action,
      },
    };
  }

  const { grant } = input.credential;
  if (!grantHasScope(grant.scopes, policy.scope)) {
    return { outcome: 'refused', reason: 'scope_not_granted' };
  }
  if (policy.requiresStepUp && !stepUpSatisfied(grant, input.now)) {
    return { outcome: 'refused', reason: 'step_up_required' };
  }
  return {
    outcome: 'authorized',
    actor: { [AUTHORIZED]: true, kind: 'guest', grantId: grant.id, action: input.action },
  };
}

/* -------------------------------------------------------------------------- */
/*  The deciding side                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What a seller or an operator is doing to a request.
 *
 * A separate vocabulary from the buyer's, because the two are decided by
 * different gates: a buyer's action is decided HERE against a credential, and a
 * decider's is decided by `requireStorePermission` or the operator allow-list on
 * the router before the request ever reaches a service. One table would suggest
 * one gate.
 */
export const BUYER_REQUEST_DECISIONS = {
  'cancellation:decide': { permission: 'orders:fulfill' },
  'cancellation:complete': { permission: 'orders:fulfill' },
  'return:decide': { permission: 'refunds:write' },
  'return:instruct': { permission: 'orders:fulfill' },
  'return:receive': { permission: 'orders:fulfill' },
  'return:refund': { permission: 'refunds:write' },
  'support:reply': { permission: 'orders:read' },
} as const;

/** One of {@link BUYER_REQUEST_DECISIONS}. */
export type BuyerRequestDecisionAction = keyof typeof BUYER_REQUEST_DECISIONS;

/**
 * An authorized DECIDER. Unforgeable outside this module, like the buyer's.
 *
 * Minted only by {@link sellerDecisionActor} and {@link operatorDecisionActor},
 * each of which takes the id the ROUTER already verified — so the brand marks
 * "a gate ran", and the gate that ran is named at the call site rather than
 * re-implemented here. Deliberately no store id: a decider's scope is the ORDER
 * they were let through for, which every decide service takes separately and
 * re-checks against `authorizeOrderAccess`.
 */
export interface BuyerRequestDecider {
  readonly [AUTHORIZED]: true;
  readonly kind: 'oxy' | 'operator';
  readonly oxyUserId: string;
  readonly action: BuyerRequestDecisionAction;
}

/**
 * A store member or P2P seller who cleared `requireStorePermission`.
 *
 * Named for the permission it must have cleared, so a reviewer comparing the
 * router and the service sees the same word twice; the router is what enforces
 * it, because a permission matrix inside the request domain would be a second
 * copy of `middleware/store-authz.ts`.
 */
export function sellerDecisionActor(
  oxyUserId: string,
  action: BuyerRequestDecisionAction,
): BuyerRequestDecider {
  return { [AUTHORIZED]: true, kind: 'oxy', oxyUserId, action };
}

/** A Mercaria operator who cleared the guest-commerce allow-list. */
export function operatorDecisionActor(
  oxyUserId: string,
  action: BuyerRequestDecisionAction,
): BuyerRequestDecider {
  return { [AUTHORIZED]: true, kind: 'operator', oxyUserId, action };
}

/** The three audit columns an actor writes, in the shape the CHECKs accept. */
export function actorAuditColumns(actor: BuyerRequestActor | BuyerRequestDecider): {
  actorKind: BuyerRequestActorKind;
  actorOxyUserId?: string;
  actorGrantId?: string;
} {
  return {
    actorKind: actor.kind,
    ...(actor.oxyUserId === undefined ? {} : { actorOxyUserId: actor.oxyUserId }),
    ...('grantId' in actor && actor.grantId !== undefined ? { actorGrantId: actor.grantId } : {}),
  };
}
