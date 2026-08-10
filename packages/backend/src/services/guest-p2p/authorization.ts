/**
 * Whether any bounded scope of guest P2P checkout is authorized — the ONE
 * function a go decision replaces (#112).
 *
 * ## The union has no `authorized` member, and that is the whole gate
 *
 * `GuestSellerActivation` (#107) and Printful's `LIVE_REFUSED_UNTIL_GATED`
 * (#125), applied to the decision #112 owns: there is no input, no environment
 * variable and no row that makes {@link readGuestP2PAuthorization} answer yes,
 * so a deployment cannot enable guest P2P checkout by configuration, by an
 * operator's mistake or by a service bug. The compiler holds it — a caller
 * cannot branch on a member that does not exist.
 *
 * ## Why there is no feature flag, when ADR 0003 D18 anticipated one
 *
 * D18 wrote "the gate is a config flag whose flip is a decision recorded on
 * #112, not a code change". #112 is that record and its outcome is **no-go**
 * (`docs/guest-p2p/2026-08-10-guest-p2p-checkout-decision.md`): none of D18's
 * three evidence conditions can be evaluated, because the authenticated P2P
 * cohort, the guest store cohort and the dispute history they compare are all
 * empty — `GUEST_COMMERCE_ENABLED` has never been true in production and no
 * Mercaria order has ever been placed by a guest.
 *
 * Shipping the flag anyway would ship a switch whose flip enables a scope
 * nobody approved, on evidence nobody has — which is exactly what #105 refused
 * when it declined to add one ("a dormant switch reads as a decision already
 * taken"). So the flag arrives WITH the approval it implements, in the same
 * change that adds the `authorized` member below, and it names the pilot's
 * bounded scope rather than being a global on/off. Until then the policy is
 * published, evaluable and explainable (`policy.ts`, `eligibility.ts`) and
 * authorizes nothing.
 *
 * ## What a go decision changes, exactly
 *
 * Three things and no others: a second member on {@link GuestP2PAuthorization}
 * carrying the approved scope; the body of {@link readGuestP2PAuthorization}
 * reading it; and the one branch in `gate.ts` that today refuses
 * unconditionally. `facts.ts` and `eligibility.ts` are already what decides
 * whether an authorized group may actually check out, and they already run —
 * on the operator trace — so the approval does not also have to bring an
 * unexercised evaluator with it.
 */

/** The dated record this domain is published under. */
export const GUEST_P2P_DECISION = {
  documentPath: 'docs/guest-p2p/2026-08-10-guest-p2p-checkout-decision.md',
  date: '2026-08-10',
  outcome: 'no_go',
} as const;

/**
 * The authorization state.
 *
 * ONE member today (the `RetailSubsidySource` shape): the state is nameable, a
 * reader can see what is missing, and there is no second value for a bug to
 * reach. A go or bounded-pilot decision adds the member; nothing else in this
 * file needs to change.
 */
export type GuestP2PAuthorization = {
  readonly state: 'not_authorized';
  /** The decision that withholds it, so a log line can cite the document. */
  readonly decision: typeof GUEST_P2P_DECISION;
};

/**
 * Read the authorization.
 *
 * Takes no argument, deliberately. A per-seller, per-market or per-cohort
 * parameter would make "is this authorized" a question with different answers,
 * and the first thing a caller would do with one is find the combination that
 * says yes. Scope belongs to the approved policy (`policy.ts`), which is
 * evaluated only once an approval exists.
 */
export function readGuestP2PAuthorization(): GuestP2PAuthorization {
  return { state: 'not_authorized', decision: GUEST_P2P_DECISION };
}
