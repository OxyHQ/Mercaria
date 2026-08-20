/**
 * The native attribute-claim backlog, and the one act that drains it (#576).
 *
 * ## What was missing, and why a count was not enough
 *
 * `GET /queues` already reported `unresolved_variant_axis_claim` as an integer,
 * `native_variant_attribute_claims_queue_idx` already made reading that backlog
 * cheap, and `settleVariantAttributeClaim` / `settleListingAttributeClaim` were
 * already written, careful, and refused by a freeze trigger for anybody going
 * around them. Between the number and the functions there was **nothing**:
 * neither had a production caller anywhere in the repository.
 *
 * So an attribute republication reopened claims into a queue with no drain, and
 * the failure read as health — the desk said a number, an operator pressed
 * nothing, and the number stayed. It is `readCompatibilityClaimQueue`'s missing
 * middle, one queue over, and the governance prose made it worse by describing
 * the path as "the operator path #367 step 4 built".
 *
 * ## The trap this service is shaped around
 *
 * **A settlement must never contradict a typed value that is already published.**
 * `native_variant_axis_assignments.normalized_value` is NOT NULL and its scope
 * trigger refuses an assignment citing a claim that did not resolve — so an
 * assignment always cites a `resolved` claim at the moment it is written. But the
 * trigger lives on the ASSIGNMENT table and fires on ITS writes, and re-settling
 * the CLAIM is an update to a different table. Migration `0104` recorded exactly
 * this as its remaining gap and noted it was unreachable "precisely because
 * `settleVariantAttributeClaim` has no caller".
 *
 * Giving it a caller is what makes it reachable, so closing it belongs here:
 *
 * 1. **The database refuses it.** The clause added to
 *    `mercaria_native_variant_claim_frozen` raises when a claim leaves
 *    `resolved` while an assignment cites it — covering `psql` and any future
 *    caller, not just this one.
 * 2. **This service refuses it FIRST**, so an operator gets a sentence naming the
 *    citing assignments rather than a constraint violation. That is a message,
 *    not a guarantee; the guarantee is (1).
 *
 * The two are deliberately not one. A service check alone would leave the
 * invariant resting on this function remembering, which is the shape #576 exists
 * to complain about.
 *
 * ## Why this REFUSES rather than cascading
 *
 * A variant's assignment set is atomic: `replaceVariantAxisAssignments` replaces
 * the WHOLE set because the variant's identity is a signature computed over all
 * of it, and a deferred constraint refuses a partial write. **There is no
 * delete-one-assignment operation in this schema**, so "settle the claim and drop
 * the assignment it contradicts" is not an act that can be composed here.
 *
 * That is not a dead end (the #663 failure): re-running the variant's axis sync
 * recomputes the set from the claims as they now stand, which is the operator's
 * real next action and is named in the refusal.
 */

import type {
  NativeAttributeClaimGrain,
  NativeAttributeClaimQueueView,
  NativeAttributeClaimRefusalCount,
  NativeAttributeClaimReviewView,
  NativeClaimResolution,
  VariantAxisAttributeRefusal,
  VariantAxisValueRefusal,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/index.js';
import type { Database, DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countCitingAxisAssignments,
  countQueuedClaims,
  findListingAttributeClaimById,
  findVariantAttributeClaimById,
  listQueuedVariantAttributeClaims,
  settleListingAttributeClaim,
  settleVariantAttributeClaim,
  type NativeListingAttributeClaimRow,
  type NativeVariantAttributeClaimRow,
} from '../../db/variantAxes/attributeClaimRepository.js';
import { recordAuditEvent } from '../../db/catalogGovernance/auditRepository.js';
import { requireGovernanceRole, roleForAction } from './role.service.js';
import type { CatalogGovernanceActor } from './actor.js';

/** The largest page the queue will serve, and the default. */
export const ATTRIBUTE_CLAIM_QUEUE_MAX_LIMIT = 200;
export const ATTRIBUTE_CLAIM_QUEUE_DEFAULT_LIMIT = 50;

export interface AttributeClaimQueueQuery {
  readonly limit?: number;
}

/**
 * Read the variant-grain backlog.
 *
 * `view` and not `review`: seeing what is outstanding is the least privileged
 * thing on this surface, and an operator who may decide nothing still needs the
 * backlog in order to report it. Same rung as
 * {@link readCompatibilityClaimQueue}.
 *
 * The listing grain has no queue read here on purpose — `countQueuedClaims`
 * counts variant claims, so a listing-grain page would be a backlog figure no
 * desk reports and no index covers. A listing claim is settled by id, which is
 * what {@link settleAttributeClaim} takes.
 */
export async function readAttributeClaimQueue(
  db: Database,
  actor: CatalogGovernanceActor,
  query: AttributeClaimQueueQuery,
): Promise<NativeAttributeClaimQueueView> {
  requireGovernanceRole(actor, 'view');

  const requested = query.limit ?? ATTRIBUTE_CLAIM_QUEUE_DEFAULT_LIMIT;
  const examinedLimit = Math.min(Math.max(requested, 1), ATTRIBUTE_CLAIM_QUEUE_MAX_LIMIT);

  // One MORE than the page, so truncation is measured on what the query
  // EXAMINED rather than on what survived it — a full page and a page that
  // happened to end at the limit are otherwise the same answer.
  const rows = await listQueuedVariantAttributeClaims(db, examinedLimit + 1);
  const truncated = rows.length > examinedLimit;
  const page = truncated ? rows.slice(0, examinedLimit) : rows;

  const citations = await countCitingAxisAssignments(
    db,
    page.map((row) => row.id),
  );

  // The WHOLE backlog, not the page's, and through the SAME function `GET
  // /queues` reads — so the two screens cannot tell an operator the backlog is
  // two different sizes.
  const counts = await countQueuedClaims(db);

  return {
    claims: page.map((row) => projectVariantClaim(row, citations.get(row.id) ?? 0)),
    queued: counts.queued,
    neverAttempted: counts.neverAttempted,
    byAttributeRefusal: toRefusalCounts(counts.byAttributeRefusal),
    byValueRefusal: toRefusalCounts(counts.byValueRefusal),
    examinedLimit,
    truncated,
  };
}

/**
 * A refusal breakdown as a list, EVERY bucket present.
 *
 * `countQueuedClaims` already guarantees each vocabulary member is a key whether
 * or not a row is in it; this preserves that into the DTO rather than filtering
 * the zeroes out. A cause with nothing in it and a cause the query forgot to ask
 * about must not look the same on the desk.
 */
function toRefusalCounts(
  counts: Record<VariantAxisAttributeRefusal, number> | Record<VariantAxisValueRefusal, number>,
): readonly NativeAttributeClaimRefusalCount[] {
  return Object.entries(counts).map(([refusal, total]) => ({ refusal, count: total }));
}

/**
 * One claim, as an operator sees it.
 *
 * Names every field explicitly rather than spreading the row — the
 * `provider_accounts` device. A spread would put every future column of the
 * claim table into an operator response by default, and the point of a
 * projection is that adding one is a disclosure decision somebody makes.
 */
function projectVariantClaim(
  row: NativeVariantAttributeClaimRow,
  citingAssignmentCount: number,
): NativeAttributeClaimReviewView {
  return {
    id: row.id,
    grain: 'variant',
    variantId: row.variantId,
    listingId: null,
    rawName: row.rawName,
    rawValue: row.rawValue,
    // The variant grain has no `kind` column — see the DTO's own note.
    kind: null,
    provenance: row.provenance,
    attributeResolution: row.attributeResolution,
    attributeRefusal: row.attributeRefusal,
    valueResolution: row.valueResolution,
    valueRefusal: row.valueRefusal,
    attributeDefinitionId: row.attributeDefinitionId,
    attributeDefinitionVersion: row.attributeDefinitionVersion,
    enumValueId: row.enumValueId,
    normalizedValue: row.normalizedValue,
    assertedAt: row.assertedAt.toISOString(),
    resolvedByOxyUserId: row.resolvedByOxyUserId,
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
    citingAssignmentCount,
  };
}

/** The listing twin. Always 0 citing assignments — see the DTO's own note. */
function projectListingClaim(row: NativeListingAttributeClaimRow): NativeAttributeClaimReviewView {
  return {
    id: row.id,
    grain: 'listing',
    variantId: null,
    listingId: row.listingId,
    rawName: row.rawName,
    rawValue: row.rawValue,
    kind: row.kind,
    provenance: row.provenance,
    attributeResolution: row.attributeResolution,
    attributeRefusal: row.attributeRefusal,
    valueResolution: row.valueResolution,
    valueRefusal: row.valueRefusal,
    attributeDefinitionId: row.attributeDefinitionId,
    attributeDefinitionVersion: row.attributeDefinitionVersion,
    enumValueId: row.enumValueId,
    normalizedValue: row.normalizedValue,
    assertedAt: row.assertedAt.toISOString(),
    resolvedByOxyUserId: row.resolvedByOxyUserId,
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
    citingAssignmentCount: 0,
  };
}

/**
 * Everything an operator must state to settle one claim.
 *
 * ## Every half is REQUIRED, and that is the trap this shape closes
 *
 * `resolutionValues` in the repository defaults EVERY field it is not given —
 * `attributeResolution ?? 'unresolved'`, `valueResolution ?? 'unresolved'`,
 * `normalizedValue ?? null`. So `settleVariantAttributeClaim(db, id, {})` is not
 * a no-op: it blanks a fully resolved claim back to unresolved with a NULL
 * value, silently. A partial input type would make that the DEFAULT behaviour of
 * a forgotten field on an operator surface.
 *
 * Both resolutions are therefore non-optional here, and the HTTP schema is
 * `.strict()` over the same shape. The settlement an operator sends is the whole
 * settlement, and there is no field whose omission means "leave it alone".
 *
 * `reason` is mandatory because the audit row is the only place the decision is
 * explained, and the raw assertion is absent because it is not a parameter of
 * the repository functions either — a settlement cannot rewrite what somebody
 * said, and that is held by the freeze trigger rather than by this type.
 */
export interface SettleAttributeClaimInput {
  readonly claimId: string;
  readonly grain: NativeAttributeClaimGrain;
  readonly attributeResolution: NativeClaimResolution;
  readonly attributeRefusal?: VariantAxisAttributeRefusal | null;
  readonly valueResolution: NativeClaimResolution;
  readonly valueRefusal?: VariantAxisValueRefusal | null;
  readonly attributeDefinitionId?: string | null;
  readonly attributeDefinitionVersion?: number | null;
  readonly enumValueId?: string | null;
  readonly normalizedValue?: string | null;
  readonly reason: string;
}

/**
 * Settle one claim, in ONE transaction with its audit.
 *
 * `resolvedByOxyUserId` and `resolvedAt` are set from the ACTOR and the clock
 * and are not inputs: who settled a claim and when is a fact about this request,
 * and accepting either from the caller would let an operator file their decision
 * under somebody else's name.
 */
export async function settleAttributeClaim(
  db: Database,
  actor: CatalogGovernanceActor,
  input: SettleAttributeClaimInput,
): Promise<NativeAttributeClaimReviewView> {
  requireGovernanceRole(actor, roleForAction('attribute_claim_settle'));
  assertSettlementShape(input);

  const at = new Date();

  return db.transaction(async (tx) => {
    const before =
      input.grain === 'variant'
        ? await findVariantAttributeClaimById(tx, input.claimId)
        : await findListingAttributeClaimById(tx, input.claimId);
    if (before === null) throw notFound('Attribute claim not found.');

    if (input.grain === 'variant') {
      await assertNoCitedAssignmentContradiction(tx, before, input);
    }

    const resolution = {
      attributeResolution: input.attributeResolution,
      attributeRefusal: input.attributeRefusal ?? null,
      valueResolution: input.valueResolution,
      valueRefusal: input.valueRefusal ?? null,
      attributeDefinitionId: input.attributeDefinitionId ?? null,
      attributeDefinitionVersion: input.attributeDefinitionVersion ?? null,
      enumValueId: input.enumValueId ?? null,
      normalizedValue: input.normalizedValue ?? null,
      resolvedByOxyUserId: actor.oxyUserId,
      resolvedAt: at,
    };

    const settled =
      input.grain === 'variant'
        ? await settleVariantAttributeClaim(tx, input.claimId, resolution)
        : await settleListingAttributeClaim(tx, input.claimId, resolution);
    if (settled === null) throw notFound('Attribute claim not found.');

    await recordAuditEvent(tx, {
      domain: 'attribute',
      action: 'attribute_claim_settle',
      subjectKind: 'native_attribute_claim',
      subjectId: input.claimId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason: input.reason,
      source: 'operator_console',
      changeRequestId: null,
      // Both halves of BOTH states, because "what did this settlement change"
      // is the question the trail is read with, and a claim can move one half
      // and leave the other exactly where it was.
      before: {
        grain: input.grain,
        attributeResolution: before.attributeResolution,
        valueResolution: before.valueResolution,
        attributeDefinitionId: before.attributeDefinitionId,
        attributeDefinitionVersion: before.attributeDefinitionVersion,
        normalizedValue: before.normalizedValue,
      },
      after: {
        grain: input.grain,
        attributeResolution: settled.attributeResolution,
        valueResolution: settled.valueResolution,
        attributeDefinitionId: settled.attributeDefinitionId,
        attributeDefinitionVersion: settled.attributeDefinitionVersion,
        normalizedValue: settled.normalizedValue,
      },
      at,
    });

    return input.grain === 'variant'
      ? projectVariantClaim(settled as NativeVariantAttributeClaimRow, 0)
      : projectListingClaim(settled as NativeListingAttributeClaimRow);
  });
}

/**
 * Refuse a settlement whose halves do not hang together.
 *
 * Five biconditional CHECKs on each claim table refuse the same rows, and this
 * is not redundant for the reason `assertScopeNamesItsVehicle` states one domain
 * over: **the CHECK's message names a constraint, and an operator needs to be
 * told which half of their settlement is wrong.** The database stays the
 * authority; this exists so a mistake is a 400 naming a field rather than a
 * `23514` an operator has to decode.
 *
 * The two that are genuinely surprising, and the reason this function exists at
 * all rather than being left to the schema:
 *
 * - **`refused` ⇔ the refusal is exactly `operator_refused`.** It is a
 *   biconditional in BOTH directions, so `operator_refused` cannot appear beside
 *   any other resolution either. The refusal is therefore not a choice an
 *   operator makes when refusing — it is DETERMINED — and pairing `refused` with
 *   `unmapped` looks entirely reasonable and is refused by the row.
 * - **`blocked` needs a refusal, and it must NOT be `operator_refused`** — that
 *   value means a person decided, which is what `refused` records.
 *
 * `resolved` needs its evidence on the matching half: a definition id for the
 * attribute, a normalized value for the value. `unresolved` carries no refusal,
 * because nothing has refused it yet.
 */
function assertSettlementShape(input: SettleAttributeClaimInput): void {
  assertHalf(
    'attribute',
    input.attributeResolution,
    input.attributeRefusal ?? null,
    input.attributeDefinitionId ?? null,
    'attributeDefinitionId',
  );
  assertHalf(
    'value',
    input.valueResolution,
    input.valueRefusal ?? null,
    input.normalizedValue ?? null,
    'normalizedValue',
  );
}

function assertHalf(
  half: 'attribute' | 'value',
  resolution: NativeClaimResolution,
  refusal: string | null,
  evidence: string | null,
  evidenceField: string,
): void {
  const refusalField = `${half}Refusal`;
  if (resolution === 'refused' && refusal !== 'operator_refused') {
    throw validationError(
      `A ${half} settlement of \`refused\` records that a person decided, so ${refusalField} must be ` +
        `\`operator_refused\` (got ${refusal === null ? 'nothing' : `\`${refusal}\``}).`,
    );
  }
  if (resolution !== 'refused' && refusal === 'operator_refused') {
    throw validationError(
      `${refusalField} \`operator_refused\` means a person refused the claim, so the ${half} ` +
        `resolution must be \`refused\` (got \`${resolution}\`).`,
    );
  }
  if (resolution === 'blocked' && refusal === null) {
    throw validationError(
      `A ${half} settlement of \`blocked\` must say why: ${refusalField} is required.`,
    );
  }
  if (resolution === 'unresolved' && refusal !== null) {
    throw validationError(
      `An \`unresolved\` ${half} half has not been refused, so ${refusalField} must be absent.`,
    );
  }
  if (resolution === 'resolved' && evidence === null) {
    throw validationError(
      `A ${half} settlement of \`resolved\` must carry what it resolved to: ${evidenceField} is required.`,
    );
  }
  if (resolution !== 'resolved' && evidence !== null) {
    throw validationError(
      `Only a \`resolved\` ${half} half may carry ${evidenceField} (got \`${resolution}\`).`,
    );
  }
}

/**
 * Refuse a settlement that would contradict a published typed value.
 *
 * ## The condition is the TRANSITION, not the state
 *
 * `old.value_resolution = 'resolved' AND new <> 'resolved'`, never plain
 * `new <> 'resolved'`. Migration `0104` COUNTED the assignments that already
 * cite a non-resolved claim, deliberately repaired none, and left them in place
 * — so a guard on the state alone would freeze every one of those rows into
 * "resolve it or never touch it again", refusing any update that does not move
 * the claim to `resolved`. That includes settling it to `refused`, which is a
 * legitimate decision about a claim whose assignment is already wrong.
 *
 * Enumerated over all sixteen (old, new) pairs on a cited claim, the two forms
 * disagree on NINE — every pair where both are non-resolved. The tempting
 * summary is wrong and worth stating: the naive form does NOT refuse the repair
 * to `resolved`, because it tests `new` alone and that pair passes under both.
 *
 * So: a resolved+cited claim cannot be un-resolved, and a pre-existing violator
 * stays fully updatable.
 *
 * The database says the same thing and is the authority — this exists so the
 * answer is a sentence naming the citing assignments and the way out, rather
 * than a `raise_exception` an operator has to decode.
 */
async function assertNoCitedAssignmentContradiction(
  tx: DatabaseOrTransaction,
  before: NativeVariantAttributeClaimRow | NativeListingAttributeClaimRow,
  input: SettleAttributeClaimInput,
): Promise<void> {
  if (before.valueResolution !== 'resolved') return;
  if (input.valueResolution === 'resolved') return;

  const citations = await countCitingAxisAssignments(tx, [input.claimId]);
  const citing = citations.get(input.claimId) ?? 0;
  if (citing === 0) return;

  throw conflict(
    `Claim ${input.claimId} is cited by ${String(citing)} typed axis assignment(s), which would be ` +
      `left carrying a value this settlement contradicts. Re-run the variant's axis sync to ` +
      `recompute its assignment set first; a variant's assignments are replaced as a whole, so ` +
      `there is no way to withdraw a single one.`,
  );
}
