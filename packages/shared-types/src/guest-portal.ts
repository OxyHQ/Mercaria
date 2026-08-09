/**
 * The guest order portal — scoped grants, magic-link exchange, transactional
 * messages (ADR 0003 D5/D9/D11/D17, #108).
 *
 * #103 gave a signed-out buyer a CART credential; #105–#107 let them place and
 * pay for an order with it. This module is what lets them come back to that
 * order afterwards, from a device that holds no cart credential at all, without
 * ever making "an order number plus an email address" into a password.
 *
 * ## The one security property everything here exists to hold
 *
 * **A credential authorizes exactly ONE checkout group.** Not an email's
 * orders, not an inbox, not a person — one `checkout_group_id`, named on the
 * grant row. Two people who share an inbox and bought separately hold two
 * unrelated credentials; a leaked link exposes the group it was sent about and
 * nothing else (ADR 0003 T7/T11). Every type below carries the group or is
 * reached through something that does, and there is deliberately no shape in
 * this file that could describe "every order for this address".
 *
 * ## Nothing here can hold a token
 *
 * The plaintext `mgx_`/`mgp_` credentials exist in exactly two carriages — a
 * `Set-Cookie` header or the `X-Mercaria-Portal-Token` response header — and in
 * the fragment of a link Mercaria sends to a stored address. No DTO in this
 * module has a field one could arrive in, which is what makes "never a response
 * body, never a log, never an analytics event" a property of the types rather
 * than a rule somebody has to remember.
 */

/**
 * What a portal credential is allowed to DO, beyond naming its checkout group.
 *
 * #108 asks for explicit scopes "instead of one all-powerful guest session",
 * and the reason is that the alternative reads identically in every log: a
 * session that may cancel an order and a session that may watch it are the same
 * row, so the blast radius of a leaked link is decided by whichever endpoint an
 * attacker finds first rather than by what Mercaria intended to hand out.
 *
 * The set is CLOSED and rendered into a database CHECK
 * (`guest_order_access_grants_scopes_check`), so a scope nobody defined cannot
 * be stored — by a service bug, a replay or `psql`.
 */
export const GUEST_ORDER_SCOPES = [
  /** Full order detail for the group: lines, totals, addresses, status trail. */
  'orders:read',
  /** Order number, coarse status and seller — the bounded confirmation view. */
  'tracking:read',
  /** Buyer-facing receipts and invoices, where the deployment produces them. */
  'documents:read',
  /** Ask to cancel an order of the group (#110). */
  'cancellations:request',
  /** Open a return request against an order of the group (#110). */
  'returns:request',
  /** Write into a support thread attached to the group (#110). */
  'support:write',
  /** Move the group into an Oxy account (#109, ADR 0003 D14). */
  'claim:write',
  /** Ask to change the contact this checkout was placed with. NOT GRANTABLE. */
  'contact_change:request',
] as const;

/** One of {@link GUEST_ORDER_SCOPES}. */
export type GuestOrderScope = (typeof GUEST_ORDER_SCOPES)[number];

/**
 * The only scopes a grant with NO proven inbox may carry (ADR 0003 D17).
 *
 * A `post_checkout` grant is minted to the device that just paid, and the proof
 * behind it is possession of a cart credential — a DEVICE, not a person. It may
 * therefore watch the group's progress and nothing else: every retrospective
 * read of stored detail and every mutation of a placed order sits behind proof
 * that the actor controls the contact inbox the order names.
 *
 * This is CHECK-enforced (`guest_order_access_grants_unverified_scope_check`),
 * not a service branch, because the failure it prevents — an unverified
 * credential quietly acquiring `orders:read` — looks exactly like a working
 * feature from the outside.
 */
export const UNVERIFIED_GRANTABLE_SCOPES: readonly GuestOrderScope[] = ['tracking:read'];

/**
 * Scopes that are DEFINED and that no code path may hand out.
 *
 * `contact_change:request` is #108's "only if product policy permits and after
 * step-up verification", answered honestly: changing the address a placed order
 * was made with is a mutation of an immutable commercial record, it needs a
 * re-verification of the NEW inbox that no flow exists to perform, and #110
 * owns the surface. The value stays in the tuple — the CHECK, the projection
 * and the authorization switch all exist for it — and
 * `resolveGrantScopes` refuses to offer it.
 *
 * This is the `role_email` decision from merchant claiming (#83), one domain
 * over: a member of a closed set that the registry declines to issue is a
 * documented gap; deleting the member would make the gap invisible and turn
 * enabling it into a schema change.
 */
export const UNGRANTABLE_GUEST_ORDER_SCOPES: readonly GuestOrderScope[] = [
  'contact_change:request',
];

/**
 * What SHAPE of credential a grant row is — ADR 0003 D5's `purpose`.
 *
 * `exchange` is the single-use, 15-minute `mgx_` token that travels in the
 * fragment of an emailed link. `portal` is the durable `mgp_` credential the
 * exchange mints, which lives in an `HttpOnly` cookie or secure storage.
 *
 * ONE table holds both, per ADR 0003 D5, because they are the same five facts
 * — a hashed secret, a checkout group, an expiry, a revocation and an inbox
 * proof — differing only in lifetime and carriage. A second table would be a
 * second place to get a liveness rule wrong.
 */
export const GUEST_ORDER_GRANT_PURPOSES = ['exchange', 'portal'] as const;

/** One of {@link GUEST_ORDER_GRANT_PURPOSES}. */
export type GuestOrderGrantPurpose = (typeof GUEST_ORDER_GRANT_PURPOSES)[number];

/**
 * HOW a credential was obtained — ADR 0003 D5's `created_via`.
 *
 * `post_checkout`: the device that placed the group asked for it, presenting
 * the guest session that placed it. Proof of a device.
 * `magic_link`: a link delivered to the contact address the order names was
 * consumed. Proof of an inbox.
 *
 * The pair is what makes email-verification rules 2 and 3 structural rather
 * than procedural: a `post_checkout` row can never carry a verification instant
 * (`guest_order_access_grants_verification_origin_check`), so paying — with a
 * card, a wallet or Stripe Link — cannot verify a Mercaria contact address, in
 * any code path, ever.
 */
export const GUEST_ORDER_GRANT_ORIGINS = ['post_checkout', 'magic_link'] as const;

/** One of {@link GUEST_ORDER_GRANT_ORIGINS}. */
export type GuestOrderGrantOrigin = (typeof GUEST_ORDER_GRANT_ORIGINS)[number];

/**
 * WHY an exchange token was minted — #108's `GuestOrderAccessGrant.purpose`.
 *
 * The issue and ADR 0003 D5 both use the word "purpose" for different facts:
 * the ADR means the credential's SHAPE (exchange vs portal) and the issue means
 * the reason a link was sent. Both are real and neither derives the other, so
 * they are two columns and only one of them keeps the contested name —
 * {@link GUEST_ORDER_GRANT_PURPOSES} is the ADR's, and this is the issue's
 * under a name that says which question it answers.
 *
 * Carried only by `exchange` rows: a portal credential's reason for existing is
 * its origin above, and copying the reason forward would be a second, staler
 * account of the same event.
 */
export const GUEST_ORDER_EXCHANGE_REASONS = [
  /** The link inside the order-confirmation message. */
  'initial_confirmation',
  /** A link requested from the recovery form by someone with no live session. */
  'recovery',
  /** A step-up link requested from a live portal session before a mutation. */
  'sensitive_action',
] as const;

/** One of {@link GUEST_ORDER_EXCHANGE_REASONS}. */
export type GuestOrderExchangeReason = (typeof GUEST_ORDER_EXCHANGE_REASONS)[number];

/**
 * The SAFE projection of a live portal credential — what the portal answers
 * about the session presenting it.
 *
 * Names every field (the `provider_accounts` status-projection rule). There is
 * no token, no token hash, no email, no contact, and no identifier belonging to
 * any other checkout group. `id` is the grant row id: an audit handle that
 * authorizes nothing, which is why the operator trace and the analytics seam
 * may both name it while the credential itself has no representation anywhere.
 */
export interface GuestPortalSessionState {
  /** The `guest_order_access_grants` row id. An audit handle, never a credential. */
  id: string;
  /** The ONE checkout group this session authorizes, and nothing outside it. */
  checkoutGroupId: string;
  /** Exactly what this session may do; see {@link GUEST_ORDER_SCOPES}. */
  scopes: GuestOrderScope[];
  /** Whether a consumed magic link proved control of the contact inbox. */
  emailVerified: boolean;
  /** ISO instant the inbox was proven; `null` for a `post_checkout` session. */
  verifiedAt: string | null;
  /**
   * Whether the inbox proof is FRESH enough for a sensitive mutation.
   *
   * Derived against the clock rather than stored, for the reason
   * `guest_sessions` has no status column: a stored freshness flag beside a
   * timestamp is a second account of one fact, and the place it must not go
   * stale is a gate deciding whether an order may be cancelled.
   */
  stepUpSatisfied: boolean;
  /** How the credential was obtained. */
  createdVia: GuestOrderGrantOrigin;
  /** ISO instant the session expires. */
  expiresAt: string;
  /** ISO instant the session was created. */
  createdAt: string;
}

/**
 * The BOUNDED confirmation view — what a `tracking:read` session may see.
 *
 * #108 initial-confirmation rule 3 asks that the device that just paid can show
 * a confirmation page before any email is delivered, and D17 puts that device
 * on the pre-verification side of the line. So this projection is a different
 * TYPE from {@link GuestOrderPortalView} rather than a filtered one — the
 * `MerchantOrder` device from #106: a serializer that reaches for a total, an
 * address, an item title or a contact on this shape fails `tsc`.
 *
 * What it deliberately omits, and why each: money (the amount is on the
 * payment sheet the buyer just saw and is a retrospective read here), the
 * shipping snapshot (a street address is the highest-value field on the
 * record), item titles (what somebody bought is the disclosure a shared device
 * makes), and the contact in every form.
 */
export interface GuestOrderStatusView {
  /** The scope. Every entry below shares it. */
  checkoutGroupId: string;
  /** Where the group stands as a whole. */
  lifecycle: GuestCheckoutLifecycleRef;
  /** One entry per sibling seller order, oldest first. */
  orders: GuestOrderStatusEntry[];
}

/**
 * `GuestCheckoutLifecycle` from `order-buyer.ts`, referenced structurally.
 *
 * Spelled as a local alias rather than imported, so this module has no import
 * edge into the order DTOs — the portal's scope vocabulary is consumed by the
 * database schema, and a schema file pulling in the whole order graph to render
 * one CHECK is how a barrel cycle starts.
 */
export type GuestCheckoutLifecycleRef =
  | 'pending_payment'
  | 'paid'
  | 'cancelled'
  | 'refunded'
  | 'mixed';

/** One sibling order, at the resolution an unverified session may read. */
export interface GuestOrderStatusEntry {
  /** The order row id — needed to address a later verified read. */
  id: string;
  /** The printed, sequential, PUBLIC order number (ADR 0003 T6). */
  orderNumber: string;
  /** The order's coarse lifecycle status. */
  status: string;
  /** The seller's public display name. Never a payout account or a contact. */
  sellerLabel: string;
  /** How many lines the order has. A count, never a title. */
  itemCount: number;
  /** ISO instant the order was placed. */
  placedAt: string;
}

/**
 * Every transactional message the portal domain can compose.
 *
 * Fourteen kinds for #108's twelve numbered notifications, because three of the
 * numbered items name two distinct events ("payment pending OR failed",
 * "shipped AND tracking update", "refund pending AND completed") and one event
 * the issue names elsewhere — the security notice for an access change — has no
 * number of its own. Splitting them is what lets a message be idempotent: two
 * events sharing one kind would collide on the deterministic id and the second
 * would silently never send.
 *
 * NOT every kind has a live trigger today. `GUEST_PORTAL_MESSAGE_TRIGGERS`
 * (backend) names the enqueuer for each, or the issue that owes it, and a test
 * fails the build if a kind is neither triggered nor listed as deferred — the
 * `deferred: #NN` device from the Stripe event ingress.
 */
export const GUEST_PORTAL_MESSAGE_KINDS = [
  'order_confirmation',
  'payment_pending',
  'payment_failed',
  'payment_delayed_success',
  'order_processing',
  'order_shipped',
  'tracking_updated',
  'order_ready_for_pickup',
  'order_delivered',
  'order_cancelled',
  'refund_pending',
  'refund_completed',
  'return_request_updated',
  'claim_completed',
  'access_link_recovery',
  'access_link_step_up',
  'access_security_notice',
] as const;

/** One of {@link GUEST_PORTAL_MESSAGE_KINDS}. */
export type GuestPortalMessageKind = (typeof GUEST_PORTAL_MESSAGE_KINDS)[number];

/**
 * The kinds whose body carries a single-use magic link.
 *
 * Every other kind links to the portal's ENTRY page with no credential in the
 * URL at all — the recipient exchanges or recovers from there. That is #108
 * privacy rule 10 ("all critical information accessible in the portal, not only
 * email") meeting T4 (a token in a URL is a token in a proxy log): a shipping
 * notice does not need to hand out access, so it does not.
 */
export const GUEST_PORTAL_LINK_BEARING_MESSAGE_KINDS: readonly GuestPortalMessageKind[] = [
  'order_confirmation',
  'access_link_recovery',
  'access_link_step_up',
];

/**
 * Where a queued message stands.
 *
 * `suppressed` is a TERMINAL state distinct from `failed`, because they demand
 * opposite operator responses: a failed message should be retried, and a
 * suppressed one must not be — the address bounced hard or its owner complained,
 * and retrying is how a sender's domain reputation dies.
 */
export const GUEST_PORTAL_MESSAGE_STATES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'dead_letter',
  'suppressed',
] as const;

/** One of {@link GUEST_PORTAL_MESSAGE_STATES}. */
export type GuestPortalMessageState = (typeof GUEST_PORTAL_MESSAGE_STATES)[number];

/**
 * Why a delivery attempt did not deliver. BOUNDED, never free text.
 *
 * A provider's own error string is somebody else's vocabulary and routinely
 * contains the recipient address — which is exactly the value this domain
 * spends three columns keeping out of reach. A closed set is what lets the
 * operator surface report a failure without quoting one.
 */
export const GUEST_PORTAL_DELIVERY_FAILURES = [
  /**
   * No transport is registered on this deployment — the #108 seam, fail-closed.
   *
   * PERMANENT, and that is the deliberate reading: a seam does not close on its
   * own, so retrying every five seconds forever would fill an operator's view
   * with a fact about the deployment rather than about any message. The row
   * survives with `transport_unconfigured` named on it, and one explicit
   * operator re-send is what sends it once a transport exists.
   */
  'transport_unconfigured',
  /** The contact was erased under ADR 0003 D15; there is no address to send to. */
  'contact_anonymized',
  /** The address is suppressed (hard bounce, complaint, or an operator). */
  'contact_suppressed',
  /** The transport refused this message permanently — do not retry. */
  'transport_rejected',
  /** The transport was unreachable or errored — retryable. */
  'transport_unavailable',
  /** The stored ciphertext could not be decrypted under the configured key. */
  'contact_unreadable',
] as const;

/** One of {@link GUEST_PORTAL_DELIVERY_FAILURES}. */
export type GuestPortalDeliveryFailure = (typeof GUEST_PORTAL_DELIVERY_FAILURES)[number];

/**
 * The failures that are PERMANENT — a retry cannot change the answer.
 *
 * Derived by naming them rather than by subtraction, because the consequence of
 * getting it wrong is asymmetric: treating a permanent failure as retryable
 * burns a sender reputation slowly and invisibly, while treating a transient
 * one as permanent loses a single message loudly.
 */
export const GUEST_PORTAL_PERMANENT_FAILURES: readonly GuestPortalDeliveryFailure[] = [
  'transport_unconfigured',
  'contact_anonymized',
  'contact_suppressed',
  'transport_rejected',
  'contact_unreadable',
];

/**
 * Why an address stopped receiving Mercaria's transactional mail.
 *
 * Suppression is keyed on the email HASH and never on the address (D12): the
 * table can answer "may I send to this inbox" without being able to say which
 * inbox it is, so a leak of the suppression list discloses no addresses.
 */
export const GUEST_CONTACT_SUPPRESSION_REASONS = [
  'hard_bounce',
  'complaint',
  'permanent_failure',
  'operator',
] as const;

/** One of {@link GUEST_CONTACT_SUPPRESSION_REASONS}. */
export type GuestContactSuppressionReason = (typeof GUEST_CONTACT_SUPPRESSION_REASONS)[number];

/**
 * The axes a recovery request is throttled on.
 *
 * #108 recovery rule 2 asks for limits "by normalized email hash, order
 * reference, IP range and abuse state without fingerprinting", and three of the
 * four cannot be a per-process Redis bucket: "how often has THIS INBOX been
 * asked for, across every ECS task and every source address" is a durable
 * question. A per-IP limiter answers a different one and would let an attacker
 * with a /64 walk around it (the merchant-claiming precedent, #83).
 *
 * `network` is the coarse address prefix and is deliberately the WEAKEST axis:
 * an IPv4 /24 and an IPv6 /64 are shared by whole offices and mobile carriers,
 * so it bounds a flood without being able to identify a device. Nothing here is
 * a fingerprint: no user agent, no screen metrics, no cookie beyond the
 * credential the request may not even carry.
 */
export const GUEST_RECOVERY_LIMIT_AXES = ['email_hash', 'order_reference', 'network'] as const;

/** One of {@link GUEST_RECOVERY_LIMIT_AXES}. */
export type GuestRecoveryLimitAxis = (typeof GUEST_RECOVERY_LIMIT_AXES)[number];

/**
 * What an operator may do on a guest's behalf, and NOTHING else.
 *
 * Two actions, both of which a buyer can already drive themselves — this
 * surface adds an audited trigger and no new capability, the `payment_repairs`
 * posture. There is deliberately no "read this address", no "send to a
 * different address", no "mark this contact verified" and no "grant access to
 * this group": ADR 0003 T15 permits a support agent to trigger a RE-SEND to the
 * stored contact and nothing more, and the request schema has no destination
 * field for one to arrive in.
 */
export const GUEST_PORTAL_OPERATOR_ACTIONS = ['resend_access_link', 'revoke_group_access'] as const;

/** One of {@link GUEST_PORTAL_OPERATOR_ACTIONS}. */
export type GuestPortalOperatorAction = (typeof GUEST_PORTAL_OPERATOR_ACTIONS)[number];

/** How an audited operator attempt ended. Refusals are recorded, not swallowed. */
export const GUEST_PORTAL_OPERATOR_OUTCOMES = ['performed', 'refused', 'failed'] as const;

/** One of {@link GUEST_PORTAL_OPERATOR_OUTCOMES}. */
export type GuestPortalOperatorOutcome = (typeof GUEST_PORTAL_OPERATOR_OUTCOMES)[number];

/** The always-identical answer to a recovery request (ADR 0003 T5). */
export interface GuestRecoveryAcknowledgement {
  /**
   * Byte-identical whether or not anything matched. A field saying "we found
   * it" would be the enumeration oracle the 202 exists to close, and so would a
   * different message, a different status code or a different latency — the
   * service does its work after answering for exactly that reason.
   */
  message: string;
}

/** The projection an operator trace returns for one grant. Carries no secret. */
export interface GuestPortalGrantTraceEntry {
  id: string;
  purpose: GuestOrderGrantPurpose;
  createdVia: GuestOrderGrantOrigin;
  exchangeReason: GuestOrderExchangeReason | null;
  scopes: GuestOrderScope[];
  emailVerified: boolean;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** The projection an operator trace returns for one queued message. */
export interface GuestPortalMessageTraceEntry {
  id: string;
  kind: GuestPortalMessageKind;
  state: GuestPortalMessageState;
  attempts: number;
  lastFailure: GuestPortalDeliveryFailure | null;
  createdAt: string;
  sentAt: string | null;
}

/**
 * Everything an operator may learn about one checkout group's portal access.
 *
 * Opens from a CHECKOUT GROUP and nothing else — no email, no hash, no order
 * number, no session id. "Show me everything this inbox has ever accessed" is
 * not a question this surface can be asked, which is the same shape as the
 * payment trace's five handles and the analytics trace's two.
 */
export interface GuestPortalTrace {
  checkoutGroupId: string;
  /** `j***@example.com`, or `deleted` after erasure. The only contact form here. */
  contactRedacted: string;
  /** Whether the contact inbox has been proven, and when. */
  contactVerifiedAt: string | null;
  /** Whether this address is currently suppressed, and why. */
  suppression: { suppressed: boolean; reason: GuestContactSuppressionReason | null };
  grants: GuestPortalGrantTraceEntry[];
  messages: GuestPortalMessageTraceEntry[];
}
