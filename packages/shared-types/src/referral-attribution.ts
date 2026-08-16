/**
 * The referral ATTRIBUTION EDGE (#143) — the vocabulary of link resolution,
 * traffic classification, the web/native carrier and the binding moment.
 *
 * `referral.ts` (#142) holds the domain's stored shapes: programs, partners,
 * codes, links, touches, attributions, conversions. This file holds only what
 * the EDGE adds — the closed sets that decide what a redirect may do, what a
 * classifier may read, what a carrier may hold, and what may never become a
 * referral identity.
 *
 * The organising rule, from ADR 0005 A1: **codes, links and click evidence are
 * attribution evidence, never credentials.** Nothing named here authenticates,
 * authorizes or redeems anything, and the prohibition lists below are VALUES a
 * gate scans for rather than sentences in a review comment.
 */

/**
 * What `GET /r/:token` did, as an operator reads it back.
 *
 * A closed set because "the link did not work" has several very different
 * causes and a partner-support question deserves the right one. It is NEVER
 * disclosed to the caller: the public answers are a redirect or a 404, so a
 * stranger cannot tell an unknown token from a paused program (ADR 0005 D18's
 * prospective gating must not double as an oracle over which programs exist).
 */
export type ReferralRedirectDisposition =
  /** Signature good, row live, program live, traffic organic — click claimed. */
  | 'redirected_and_recorded'
  /** Redirected, but the traffic was classified non-organic: no click, no touch. */
  | 'redirected_unattributed'
  /** Redirected with no state issued because consent was withheld. */
  | 'redirected_without_state'
  /** The operator lever for this program's redirect is off. */
  | 'refused_redirect_disabled'
  /** Signature, row lifecycle, click ceiling or program gate refused it. */
  | 'refused_link_unusable';

/** Every disposition, for exhaustiveness checks and the operator projection. */
export const REFERRAL_REDIRECT_DISPOSITIONS: readonly ReferralRedirectDisposition[] = [
  'redirected_and_recorded',
  'redirected_unattributed',
  'redirected_without_state',
  'refused_redirect_disabled',
  'refused_link_unusable',
];

/**
 * At which product moment a code was typed (ADR 0005 D4's two code kinds).
 *
 * There is no `at_registration` member and none may be added without the
 * moment existing: Mercaria's registration is Oxy's, and a code entered into a
 * screen this repository does not own is a touch nothing here observed.
 */
export type ReferralCodeEntryMoment = 'in_app' | 'at_checkout';

/** Both entry moments. */
export const REFERRAL_CODE_ENTRY_MOMENTS: readonly ReferralCodeEntryMoment[] = [
  'in_app',
  'at_checkout',
];

/**
 * How a bind attempt resolved, from the CLIENT's point of view.
 *
 * `pending` is the load-bearing member and is not a failure: an anonymous
 * visitor has no subject to attribute, so ADR 0003 T10 forbids minting one
 * merely to have somewhere to write. The state is held in the carrier and
 * binds at the first moment there IS a subject.
 */
export type ReferralBindingState =
  /** A touch was recorded and an attribution now stands for this subject. */
  | 'attributed'
  /** A touch was recorded; the attribution resolver declined to make it the winner. */
  | 'recorded_not_attributed'
  /** Held in the carrier, waiting for a subject. Nothing was written. */
  | 'pending'
  /** Nothing to bind — no carrier, no code. */
  | 'none';

/** Every binding state. */
export const REFERRAL_BINDING_STATES: readonly ReferralBindingState[] = [
  'attributed',
  'recorded_not_attributed',
  'pending',
  'none',
];

/**
 * Why a bind produced no attribution, in the bounded vocabulary a client may
 * be told.
 *
 * Deliberately COARSE. It names no partner, no program, no code owner and no
 * other subject — requirement 6 of the issue's code rules ("Do not reveal
 * private partner status through errors") plus link rule 7 ("Do not expose
 * internal partner or program ids unnecessarily"). An operator reads the real
 * reason from `referral_events`, which is where the detail belongs.
 */
export type ReferralBindingRefusalReason =
  /** The instrument is expired, revoked, paused, retired or over its ceiling. */
  | 'instrument_unusable'
  /** The program has no live version, or its attribution lever is off. */
  | 'program_unavailable'
  /** The request had no subject to attribute — anonymous. */
  | 'no_subject'
  /** The carrier was absent, unreadable, or past its own deadline. */
  | 'state_unusable'
  /** The traffic was classified non-organic. */
  | 'traffic_not_organic'
  /** The caller may not bind this merchant candidate. */
  | 'merchant_not_bindable';

/** Every refusal reason. */
export const REFERRAL_BINDING_REFUSAL_REASONS: readonly ReferralBindingRefusalReason[] = [
  'instrument_unusable',
  'program_unavailable',
  'no_subject',
  'state_unusable',
  'traffic_not_organic',
  'merchant_not_bindable',
];

/**
 * What a client may learn about its own referral state.
 *
 * The allow-list is the whole type — the `provider_accounts` (#46) and
 * `SellerProfile` (#92) device. There is NO partner id, NO partner name, NO
 * program id, NO code, NO campaign key and NO attribution id, because a buyer
 * being able to read who is paid for them is a disclosure nobody asked for and
 * a partner being able to read it off a victim's browser is worse.
 *
 * `publicTermsSummary` is the program's own buyer-facing sentence
 * (`referral_programs.public_terms_summary`), which exists precisely to be
 * rendered verbatim, and `disclosureRequired` is the link's own flag — the two
 * facts a disclosure banner needs and nothing else.
 */
export interface ReferralStateView {
  state: ReferralBindingState;
  /** Present only when the state is `attributed` or `recorded_not_attributed`. */
  publicTermsSummary?: string;
  /** Whether the surface must render a paid-referral disclosure. */
  disclosureRequired: boolean;
}

/** The answer to a bind or code-entry attempt. */
export interface ReferralBindingResult {
  state: ReferralBindingState;
  /** Present exactly when nothing was attributed. */
  reason?: ReferralBindingRefusalReason;
  disclosureRequired: boolean;
  /** Present only when a program's terms are now in force for this subject. */
  publicTermsSummary?: string;
}

/**
 * What a request declares about consent to persist referral state.
 *
 * Mercaria operates NO consent framework — there is no CMP, no stored consent
 * record and no jurisdiction table anywhere in this repository. So this is a
 * DECLARATION the client makes, recorded verbatim on the touch
 * (`referral_touches.consent_mode`, #142) and acted on in exactly one way:
 * `denied` means no web carrier is written. It is not evidence that consent was
 * collected, and nothing here may present it as such.
 *
 * Spelled as its own type rather than reusing `ReferralConsentMode` from
 * `referral.ts`: that one is the STORED column's vocabulary, and the two happen
 * to agree today.
 */
export type ReferralConsentDeclaration = 'granted' | 'denied' | 'unknown';

/** Every consent declaration a client may make. */
export const REFERRAL_CONSENT_DECLARATIONS: readonly ReferralConsentDeclaration[] = [
  'granted',
  'denied',
  'unknown',
];

/**
 * Signals that may NEVER decide, carry or recover a referral identity
 * (ADR 0005 A2, and issue #143's guest rules 7 and 10).
 *
 * Disjoint from every identity vocabulary this domain has — `ReferralActorKind`
 * (`guest_session | oxy_user`) and `ReferralSubjectKind` (`oxy_user |
 * guest_checkout | merchant`) — and a test asserts the disjointness, so a
 * plausible future addition to either fails the build rather than passing
 * review.
 *
 * The list is a VALUE and not a comment because that is the only form a scanned
 * gate can measure: `referral-attribution-isolation.test.ts` reads it and fails
 * the build if any module in the edge names one.
 */
export type ReferralForbiddenIdentitySignal =
  | 'email_address'
  | 'email_hash'
  | 'phone_number'
  | 'postal_address'
  | 'card_fingerprint'
  | 'payment_method_id'
  | 'stripe_customer_id'
  | 'stripe_link_identity'
  | 'ip_address'
  | 'user_agent_fingerprint'
  | 'device_fingerprint'
  | 'advertising_identifier'
  | 'tls_fingerprint'
  | 'canvas_fingerprint';

/** All fourteen prohibited identity signals. */
export const REFERRAL_FORBIDDEN_IDENTITY_SIGNALS: readonly ReferralForbiddenIdentitySignal[] = [
  'email_address',
  'email_hash',
  'phone_number',
  'postal_address',
  'card_fingerprint',
  'payment_method_id',
  'stripe_customer_id',
  'stripe_link_identity',
  'ip_address',
  'user_agent_fingerprint',
  'device_fingerprint',
  'advertising_identifier',
  'tls_fingerprint',
  'canvas_fingerprint',
];

/**
 * Inputs that may NEVER influence where `GET /r/:token` sends a browser.
 *
 * Issue acceptance 2: "The redirect cannot be used as an open redirect or
 * arbitrary campaign injector." The destination is composed from a configured,
 * allow-listed ORIGIN plus a relative path built by
 * `services/referrals/destinations.ts` from a closed template and a validated
 * opaque id. Nothing from the request reaches it — not a query parameter, not a
 * header, not a path segment beyond the token itself.
 *
 * Naming the prohibitions as values is what lets the gate measure them; the
 * mechanism is that no function on the redirect path ACCEPTS any of these, so
 * they are inexpressible rather than filtered.
 */
export type ReferralForbiddenRedirectInput =
  | 'request_query_parameter'
  | 'request_referer_header'
  | 'request_origin_header'
  | 'request_host_header'
  | 'request_forwarded_host_header'
  | 'client_supplied_destination_url'
  | 'client_supplied_campaign_key'
  | 'client_supplied_partner_id';

/** All eight prohibited redirect inputs. */
export const REFERRAL_FORBIDDEN_REDIRECT_INPUTS: readonly ReferralForbiddenRedirectInput[] = [
  'request_query_parameter',
  'request_referer_header',
  'request_origin_header',
  'request_host_header',
  'request_forwarded_host_header',
  'client_supplied_destination_url',
  'client_supplied_campaign_key',
  'client_supplied_partner_id',
];

/**
 * The deferred deep-link posture — a NAMED SEAM with one member.
 *
 * Issue #143's native rule 2 permits deferred deep linking "only through a
 * reviewed provider or first-party mechanism". Mercaria has neither: there is
 * no attribution SDK, no install-referrer reader, and — decisively — no
 * verified universal-link or App-Link association, because `packages/frontend`
 * declares no `associatedDomains`, no Android `intentFilters` and no Apple Team
 * ID, and none of those can be produced without a signed app-store build.
 *
 * A single-member union is how that is made unrepresentable rather than
 * unimplemented: there is no value meaning "supported", so no configuration,
 * operator action or service bug can turn a device fingerprint into a deferred
 * match. The mechanism arrives WITH the reviewed provider, in the change that
 * adds the second member — `GuestP2PAuthorization` (#112), which still has no
 * member meaning yes because the bounded-scope decision it waits on is still a
 * no-go.
 *
 * `GuestSellerActivation` (#107) was the same device and is the precedent for
 * how this ENDS rather than for how it holds: #85 supplied the capability and
 * the change that supplied it is the change that added `{state: 'activated'}`.
 * That is exactly the shape this seam should close in — a reviewed provider and
 * a second member landing together — and it is why the union is the mechanism
 * rather than a flag somebody could flip first.
 */
export type ReferralDeferredDeepLinkSupport = 'unsupported';

/** The one deferred deep-link state. */
export const REFERRAL_DEFERRED_DEEP_LINK_SUPPORT: readonly ReferralDeferredDeepLinkSupport[] = [
  'unsupported',
];

/**
 * The two operator levers on one program (issue #143 link rule 8).
 *
 * Independent on purpose: turning the redirect off stops NEW clicks resolving
 * while a code typed at checkout still attributes, and turning attribution off
 * stops NEW winners while every link keeps working and every touch keeps being
 * RECORDED. That second half is ADR 0005 D18's "gating loops and gates, never
 * records" and the house rule it restates: an effect that did not happen must
 * stay distinguishable from one that silently vanished.
 *
 * Absence of a controls row means BOTH ENABLED — a lever nobody has touched is
 * not a gate somebody has to discover, and the domain is already bounded by
 * `REFERRALS_ENABLED` plus each program's own status.
 */
export interface ReferralProgramControlsView {
  programId: string;
  redirectEnabled: boolean;
  attributionEnabled: boolean;
  /**
   * #145's THIRD lever: may a payout batch for this program be built and
   * settled? ADR 0005 D18's suspension, at the program grain — it withholds and
   * never voids, and every reward already earned keeps its state.
   */
  payoutEnabled: boolean;
  reason: string;
  updatedAt: string;
}
