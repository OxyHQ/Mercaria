/**
 * `automation_rules`, `automation_rule_listing_states`, `automation_rule_runs` —
 * the only module that reads or writes them (#89, `automation_rules`).
 *
 * ## Every claim is ONE statement, and its empty result IS the answer
 *
 * The evaluator runs on every API task at once. Opening a stock episode is an
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` on `(rule_id, listing_id)`,
 * closing one is a `DELETE … RETURNING`, and a run is an insert on
 * `(rule_id, subject_id, occurrence)` with the same device — so two tasks that
 * evaluate the same rule at the same moment produce one claim and one empty
 * set, never two actions (`docs/house-invariants.md`, idempotency).
 *
 * ## Every read is scoped to the rule's own store
 *
 * The candidate queries take the RULE, not a store id the caller chose, and
 * filter on `rule.storeId` in SQL. A rule can therefore never be handed another
 * store's listing or order, whatever its scope says.
 */

import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { qualified } from '@oxy.so/db';
import type { AutomationRuleRunOutcome, AutomationRuleRunStep } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  automationRuleListingStates,
  automationRuleRuns,
  automationRules,
} from '../schema/automationRules.js';
import { listings, productVariants } from '../schema/catalog.js';
import { orderItems, orders } from '../schema/orders.js';

export type AutomationRuleRow = typeof automationRules.$inferSelect;
export type NewAutomationRuleRow = typeof automationRules.$inferInsert;
export type AutomationRuleRunRow = typeof automationRuleRuns.$inferSelect;
export type AutomationRuleListingStateRow = typeof automationRuleListingStates.$inferSelect;

/** The columns an edit may change. The trigger, the action and the store never move. */
export type AutomationRulePatch = Partial<
  Pick<
    NewAutomationRuleRow,
    | 'name'
    | 'enabled'
    | 'stockThreshold'
    | 'tag'
    | 'minOrderTotalAmount'
    | 'minOrderTotalCurrency'
    | 'republishWhenRestocked'
    | 'armedAt'
  >
>;

// ── Rules ──────────────────────────────────────────────────────────────────

export async function insertAutomationRule(
  db: DatabaseOrTransaction,
  values: NewAutomationRuleRow,
): Promise<AutomationRuleRow> {
  const [row] = await db.insert(automationRules).values(values).returning();
  if (!row) throw new Error('automation rule insert returned no row');
  return row;
}

/** One rule of one store, or `undefined` — a rule of another store is not found. */
export async function findAutomationRule(
  storeId: string,
  ruleId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AutomationRuleRow | undefined> {
  const [row] = await db
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.storeId, storeId), eq(automationRules.id, ruleId)))
    .limit(1);
  return row;
}

/** Every rule of one store, oldest first (a store holds at most its plan's few hundred). */
export async function listAutomationRules(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AutomationRuleRow[]> {
  return db
    .select()
    .from(automationRules)
    .where(eq(automationRules.storeId, storeId))
    .orderBy(asc(automationRules.createdAt), asc(automationRules.id));
}

export async function updateAutomationRule(
  db: DatabaseOrTransaction,
  storeId: string,
  ruleId: string,
  patch: AutomationRulePatch,
): Promise<AutomationRuleRow | undefined> {
  const [row] = await db
    .update(automationRules)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(automationRules.storeId, storeId), eq(automationRules.id, ruleId)))
    .returning();
  return row;
}

/**
 * Delete one rule of one store. The `RETURNING` row is the proof a rule was
 * actually deleted — the caller releases the plan slot only then, so a repeated
 * or concurrent delete cannot give the slot back twice.
 */
export async function deleteAutomationRule(
  db: DatabaseOrTransaction,
  storeId: string,
  ruleId: string,
): Promise<AutomationRuleRow | undefined> {
  const [row] = await db
    .delete(automationRules)
    .where(and(eq(automationRules.storeId, storeId), eq(automationRules.id, ruleId)))
    .returning();
  return row;
}

/**
 * A page of ENABLED rules across every store, in id order after `afterId` — the
 * evaluator's keyset walk. It reads no plan state: whether the store still holds
 * the capability is asked per store by the caller, through the entitlement API.
 */
export async function listEnabledAutomationRulesPage(input: {
  afterId: string | null;
  limit: number;
  storeIds?: readonly string[];
}): Promise<AutomationRuleRow[]> {
  const conditions = [eq(automationRules.enabled, true)];
  if (input.afterId !== null) conditions.push(gt(automationRules.id, input.afterId));
  if (input.storeIds) conditions.push(inArray(automationRules.storeId, [...input.storeIds]));
  return getDb()
    .select()
    .from(automationRules)
    .where(and(...conditions))
    .orderBy(asc(automationRules.id))
    .limit(input.limit);
}

// ── Runs ───────────────────────────────────────────────────────────────────

/**
 * Record one run, or claim nothing when this occurrence already has one.
 *
 * @returns the run, or `undefined` when `(rule, subject, occurrence)` was
 *   already recorded — the "somebody else did it" answer, not an error.
 */
export async function insertAutomationRuleRun(
  db: DatabaseOrTransaction,
  values: {
    ruleId: string;
    storeId: string;
    subjectKind: 'listing' | 'order';
    subjectId: string;
    occurrence: string;
    step: AutomationRuleRunStep;
    outcome: AutomationRuleRunOutcome;
    detail: string | null;
  },
): Promise<AutomationRuleRunRow | undefined> {
  const [row] = await db
    .insert(automationRuleRuns)
    .values({ ...values, detail: values.detail === null ? null : values.detail.slice(0, 500) })
    .onConflictDoNothing({
      target: [
        automationRuleRuns.ruleId,
        automationRuleRuns.subjectId,
        automationRuleRuns.occurrence,
      ],
    })
    .returning();
  return row;
}

/**
 * Settle a run claimed earlier in the SAME transaction with how it ended. The
 * claim and its outcome commit together, so outside the transaction a run is
 * only ever seen with its final outcome.
 */
export async function settleAutomationRuleRun(
  db: DatabaseOrTransaction,
  runId: string,
  result: { outcome: AutomationRuleRunOutcome; detail: string | null },
): Promise<void> {
  await db
    .update(automationRuleRuns)
    .set({ outcome: result.outcome, detail: result.detail?.slice(0, 500) ?? null })
    .where(eq(automationRuleRuns.id, runId));
}

/** A store's run history, newest first, optionally for one rule, before a cursor. */
export async function listAutomationRuleRuns(input: {
  storeId: string;
  ruleId?: string;
  before?: Date;
  limit: number;
}): Promise<AutomationRuleRunRow[]> {
  const conditions = [eq(automationRuleRuns.storeId, input.storeId)];
  if (input.ruleId) conditions.push(eq(automationRuleRuns.ruleId, input.ruleId));
  if (input.before) conditions.push(lt(automationRuleRuns.createdAt, input.before));
  return getDb()
    .select()
    .from(automationRuleRuns)
    .where(and(...conditions))
    .orderBy(desc(automationRuleRuns.createdAt), desc(automationRuleRuns.id))
    .limit(input.limit);
}

// ── Stock episodes ───────────────────────────────────────────────────────────

/** A listing's tracked stock as a stock rule sees it. */
export interface ListingStockCandidate {
  listingId: string;
  title: string;
  available: number;
}

/**
 * `true` when every variant of the listing is tracked — an untracked variant is
 * always available, so a listing holding one is never "out of stock".
 */
function allVariantsTracked() {
  return sql`exists (select 1 from ${productVariants} pv where pv.listing_id = ${qualified(listings.id)})
    and not exists (
      select 1 from ${productVariants} pv
      where pv.listing_id = ${qualified(listings.id)} and not pv.inventory_tracked
    )`;
}

/** The listing's summed rolled-up `inventory_available` over its variants. */
function listingAvailable() {
  return sql<number>`(
    select coalesce(sum(pv.inventory_available), 0)::int from ${productVariants} pv
    where pv.listing_id = ${qualified(listings.id)}
  )`;
}

/** Case-insensitive "the listing carries this tag". */
function listingHasTag(tag: string) {
  return sql`exists (
    select 1 from unnest(${qualified(listings.tags)}) as lt(tag) where lower(lt.tag) = lower(${tag})
  )`;
}

/**
 * Active store listings of the rule's store, in its tag scope, whose tracked
 * stock is at or below the threshold and that have NO open episode for this
 * rule. Only `active` listings open an episode: a draft is not on sale, and a
 * `restricted` one is a jury's, never a rule's.
 */
export async function findListingsEnteringStockEpisode(
  rule: Pick<AutomationRuleRow, 'id' | 'storeId' | 'stockThreshold' | 'tag'>,
  limit: number,
): Promise<ListingStockCandidate[]> {
  const threshold = rule.stockThreshold ?? 0;
  const available = listingAvailable();
  const conditions = [
    eq(listings.storeId, rule.storeId),
    eq(listings.ownerType, 'store'),
    eq(listings.status, 'active'),
    allVariantsTracked(),
    sql`${available} <= ${threshold}`,
    sql`not exists (
      select 1 from ${automationRuleListingStates} s
      where s.rule_id = ${rule.id} and s.listing_id = ${qualified(listings.id)}
    )`,
  ];
  if (rule.tag) conditions.push(listingHasTag(rule.tag));
  return getDb()
    .select({ listingId: listings.id, title: listings.title, available })
    .from(listings)
    .where(and(...conditions))
    .orderBy(asc(listings.id))
    .limit(limit);
}

/** An open episode whose listing is back above the rule's threshold. */
export interface RecoveredStockEpisode {
  stateId: string;
  listingId: string;
  pausedByRule: boolean;
}

/**
 * This rule's open episodes whose listing has RECOVERED: its tracked stock is
 * above the threshold again, or it now holds an untracked variant (always
 * available). The listing's status is not read here — whether a republish may
 * touch it is decided when the episode is closed, from a fresh read.
 */
export async function findRecoveredStockEpisodes(
  rule: Pick<AutomationRuleRow, 'id' | 'storeId' | 'stockThreshold'>,
  limit: number,
): Promise<RecoveredStockEpisode[]> {
  const threshold = rule.stockThreshold ?? 0;
  return getDb()
    .select({
      stateId: automationRuleListingStates.id,
      listingId: automationRuleListingStates.listingId,
      pausedByRule: automationRuleListingStates.pausedByRule,
    })
    .from(automationRuleListingStates)
    .innerJoin(listings, eq(listings.id, automationRuleListingStates.listingId))
    .where(
      and(
        eq(automationRuleListingStates.ruleId, rule.id),
        eq(listings.storeId, rule.storeId),
        sql`(not (${allVariantsTracked()}) or ${listingAvailable()} > ${threshold})`,
      ),
    )
    .orderBy(asc(automationRuleListingStates.id))
    .limit(limit);
}

/** Open an episode for (rule, listing); `undefined` when one is already open. */
export async function openStockEpisode(
  db: DatabaseOrTransaction,
  input: { ruleId: string; listingId: string },
): Promise<AutomationRuleListingStateRow | undefined> {
  const [row] = await db
    .insert(automationRuleListingStates)
    .values(input)
    .onConflictDoNothing({
      target: [automationRuleListingStates.ruleId, automationRuleListingStates.listingId],
    })
    .returning();
  return row;
}

/** Record that THIS rule moved the episode's listing to `draft`. */
export async function markStockEpisodePaused(
  db: DatabaseOrTransaction,
  stateId: string,
): Promise<void> {
  await db
    .update(automationRuleListingStates)
    .set({ pausedByRule: true })
    .where(eq(automationRuleListingStates.id, stateId));
}

/** Close an episode; `undefined` when another evaluator closed it first. */
export async function closeStockEpisode(
  db: DatabaseOrTransaction,
  stateId: string,
): Promise<AutomationRuleListingStateRow | undefined> {
  const [row] = await db
    .delete(automationRuleListingStates)
    .where(eq(automationRuleListingStates.id, stateId))
    .returning();
  return row;
}

/** Every open episode of one rule — read by tests and by nothing on a hot path. */
export async function listStockEpisodes(
  ruleId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AutomationRuleListingStateRow[]> {
  return db
    .select()
    .from(automationRuleListingStates)
    .where(eq(automationRuleListingStates.ruleId, ruleId));
}

// ── Paid orders ──────────────────────────────────────────────────────────────

/** How long before `paidSince` an order may have been placed and still be considered. */
const ORDER_CREATED_SLACK_MS = 30 * 24 * 60 * 60 * 1000;

/** A paid order an order rule has not answered yet. */
export interface PaidOrderCandidate {
  orderId: string;
  orderNumber: string;
}

/**
 * Orders of the rule's store PAID at or after `paidSince` that match the rule's
 * conditions and have no run for this rule yet.
 *
 * `paidSince` is the later of the rule's `armed_at` and the evaluator's lookback
 * floor, so neither enabling a rule nor a plan coming back reaches over orders
 * a merchant has already handled. The minimum total compares the SHOP-currency
 * grand total in the rule's own currency only: an order in another currency is
 * not converted (nothing in Mercaria converts at `paid`) and does not match.
 */
export async function findPaidOrdersForRule(
  rule: Pick<
    AutomationRuleRow,
    'id' | 'storeId' | 'tag' | 'minOrderTotalAmount' | 'minOrderTotalCurrency'
  >,
  input: { paidSince: Date; limit: number },
): Promise<PaidOrderCandidate[]> {
  const conditions = [
    eq(orders.storeId, rule.storeId),
    sql`${orders.paymentPaidAt} is not null`,
    sql`${orders.paymentPaidAt} >= ${input.paidSince}`,
    // A bound the store's `(store_id, status, created_at)` index can apply: an
    // order is paid within its reservation window of being placed, so thirty
    // days of slack loses nothing and keeps a large store's scan to a month.
    sql`${orders.createdAt} >= ${new Date(input.paidSince.getTime() - ORDER_CREATED_SLACK_MS)}`,
    sql`not exists (
      select 1 from ${automationRuleRuns} r
      where r.rule_id = ${rule.id} and r.subject_id = ${qualified(orders.id)} and r.occurrence = 'paid'
    )`,
  ];
  if (rule.minOrderTotalAmount !== null && rule.minOrderTotalCurrency !== null) {
    conditions.push(eq(orders.totalsGrandTotalShopCurrency, rule.minOrderTotalCurrency));
    conditions.push(sql`${orders.totalsGrandTotalShopAmount} >= ${rule.minOrderTotalAmount}`);
  }
  if (rule.tag) {
    conditions.push(sql`exists (
      select 1 from ${orderItems} oi
      join ${listings} l on l.id = oi.listing_id
      where oi.order_id = ${qualified(orders.id)}
        and exists (select 1 from unnest(l.tags) as lt(tag) where lower(lt.tag) = lower(${rule.tag}))
    )`);
  }
  return getDb()
    .select({ orderId: orders.id, orderNumber: orders.orderNumber })
    .from(orders)
    .where(and(...conditions))
    .orderBy(asc(orders.paymentPaidAt), asc(orders.id))
    .limit(input.limit);
}
