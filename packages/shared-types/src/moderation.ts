/**
 * Moderation DTOs — abuse reports, and what Mercaria does about a decision.
 *
 * ## Why this is not called `report`
 *
 * `report.ts` in this package is already taken, and it is a completely different
 * noun: a store's SALES ANALYTICS (`ReportSummary`, `SalesReportPoint`,
 * `TopProduct`), served under `/admin/stores/:storeId/reports/*`. Nothing here has
 * anything to do with it. An abuse report is a user telling us something in the
 * marketplace is wrong, so every type below says `AbuseReport` and the whole
 * module is `moderation` — the one place the two words could be confused is a
 * file name, and this comment is what stops the next person conflating them.
 *
 * ## What Mercaria owns, and what it does not
 *
 * CrowdSource owns cases, juries and decisions; Oxy Trust owns reputation.
 * Mercaria reports, and enforces its OWN catalogue. It never computes reputation,
 * never suspends an Oxy account, and never decides a case. The types here are the
 * two ends of that: what a reporter claimed, and what this deployment did.
 */

/**
 * A noun the API accepts a report about.
 *
 * This is the API CONTRACT — deliberately WIDER than the set Mercaria can send
 * for community review. Whether a report actually leaves this deployment is
 * decided by the subject-provider registry, not by this union, and the two are
 * different questions with different authorities:
 *
 *   * This union answers "is this a thing in Mercaria at all?" A type outside it
 *     is a client bug and gets a 400.
 *   * The registry answers "can we describe this well enough for a jury?" A type
 *     with no provider is still accepted, still stored, and simply never
 *     delivered.
 *
 * Gating the route on the registry instead would mean that adopting CrowdSource
 * breaks every report surface not yet wired to it. Incremental adoption — one
 * subject type at a time — is the property that makes this integration reusable,
 * so a reportable type is allowed to have no route out yet.
 */
export type AbuseReportedType = 'listing' | 'review' | 'seller' | 'store';

export const ABUSE_REPORTED_TYPES: readonly AbuseReportedType[] = [
  'listing',
  'review',
  'seller',
  'store',
];

/**
 * What a reporter says is wrong, in Mercaria's own words.
 *
 * These are the marketplace-shaped choices a buyer is offered in the UI. They are
 * NOT the CrowdSource taxonomy — `reportTaxonomy.ts` maps them onto the baseline
 * `commerce.*` / `deception.*` codes a jury reasons about. Keeping Mercaria's
 * vocabulary separate from the universal one is what lets the storefront ask a
 * question a shopper understands ("this is a fake") while the case carries the
 * code the policy is versioned against (`commerce.counterfeit`).
 */
export type AbuseReportCategory =
  | 'counterfeit'
  | 'prohibited_item'
  | 'misleading_listing'
  | 'unsafe_product'
  | 'stolen_goods'
  | 'scam'
  | 'offensive_content'
  | 'spam'
  | 'other';

export const ABUSE_REPORT_CATEGORIES: readonly AbuseReportCategory[] = [
  'counterfeit',
  'prohibited_item',
  'misleading_listing',
  'unsafe_product',
  'stolen_goods',
  'scam',
  'offensive_content',
  'spam',
  'other',
];

/**
 * Where a report is in ITS OWN life, which is not where the case is.
 *
 * `received` is the honest terminal state for a report Mercaria cannot send: it
 * was stored, it is a real record, and nothing further will happen to it. That is
 * deliberately distinguishable from `queued` (delivery is owed) and from
 * `delivery_failed` (delivery was owed and is not happening), because months
 * later "there was never a route out for this noun" and "the route broke" need
 * different answers and neither can be re-derived from a missing outbox row.
 */
export type AbuseReportLocalStatus =
  | 'received'
  | 'queued'
  | 'delivered'
  | 'delivery_failed'
  | 'decided';

/**
 * What Mercaria can actually DO about a decision.
 *
 * Every entry is a lever this codebase really pulls. Nothing here is aspirational:
 * an action recorded as applied must correspond to a state change someone can go
 * and look at, or the audit trail is worse than having none.
 *
 * - `restrict` — the listing leaves publication (`status: 'restricted'`) or the
 *   review is hidden. Every catalogue read filters `status: 'active'`, and the
 *   cart marks a non-active line stale while checkout refuses stale lines, so
 *   this delists AND makes the item unsellable in one field.
 * - `request_changes` — the listing goes back to `draft` and the seller is told.
 *   The COMMERCE-SPECIFIC middle ground: it takes the listing down without
 *   accusing the seller of anything final, and they can fix it and republish
 *   themselves. No social app has this lever, which is why the baseline taxonomy
 *   carries the recommendation and no other Oxy app maps it to an effect.
 * - `freeze_transaction` — money and goods already in flight stop moving: the
 *   order is held and `order.service.transition` refuses to advance it. Distinct
 *   from `restrict`, which only stops NEW sales.
 * - `restore` — undo whichever of the above was applied.
 * - `manual_review` — recorded, never executed. A recommendation Mercaria
 *   declines must not look like one it never received.
 * - `none` — a decision that warranted no action, written down as a decision.
 */
export type ModerationEnforcementAction =
  | 'restrict'
  | 'request_changes'
  | 'freeze_transaction'
  | 'restore'
  | 'manual_review'
  | 'none';

export const MODERATION_ENFORCEMENT_ACTIONS: readonly ModerationEnforcementAction[] = [
  'restrict',
  'request_changes',
  'freeze_transaction',
  'restore',
  'manual_review',
  'none',
];

/**
 * How much of a plan is allowed to actually happen.
 *
 * `observe` computes and RECORDS the identical plan and changes nothing, so the
 * audit trail proves what production would have done. `manual` additionally
 * applies only the give-something-back half (`restore`), which can only ever
 * return a seller's listing to them. `automatic` applies everything.
 *
 * The default is `observe`, and it stays there until a real decision has been
 * watched arriving end to end.
 */
export type ModerationEnforcementMode = 'observe' | 'manual' | 'automatic';

/** A report as the API returns it. */
export interface AbuseReport {
  id: string;
  reportedType: AbuseReportedType;
  reportedId: string;
  reporterOxyUserId: string;
  categories: AbuseReportCategory[];
  details?: string;
  localStatus: AbuseReportLocalStatus;
  /** Why this report is going nowhere, when it is. Operator-readable. */
  localStatusReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** The payload `POST /reports` accepts. */
export interface CreateAbuseReportInput {
  reportedType: AbuseReportedType;
  reportedId: string;
  categories: AbuseReportCategory[];
  details?: string;
}
