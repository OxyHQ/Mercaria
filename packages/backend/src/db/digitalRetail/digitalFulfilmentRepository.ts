/**
 * The only writer of `digital_fulfilments`, `digital_fulfilment_artifacts`,
 * `digital_fulfilment_reveals` and `digital_fulfilment_incidents` (#1016,
 * ADR 0011 D10–D12).
 *
 * ## Nothing here deletes anything
 *
 * Three of the four tables refuse DELETE by trigger and two refuse UPDATE as
 * well. A refund moves a status; a replacement supersedes an artifact and keeps
 * it. This is the evidence a chargeback over a used key is answered from, and an
 * edit path would destroy the only account of what happened.
 *
 * ## The plaintext never passes through this module
 *
 * Every function here takes a SEALED artifact — ciphertext, key reference,
 * algorithm, digest and hint, produced by `services/digital-retail/secrets.ts`.
 * Reading one back is an explicit, greppable act: the three sealed columns are in
 * `PROTECTED_COLUMNS`, so the ordinary `select()` this file issues cannot ship
 * them at all, and the one function that needs the ciphertext names it.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { publicColumns } from '@oxy.so/db/assert';
import type {
  DigitalArtifactRedemptionState,
  DigitalArtifactSource,
  DigitalFulfilmentCapability,
  DigitalFulfilmentIncidentKind,
  DigitalFulfilmentIncidentState,
  DigitalRetailProductClass,
  DigitalRevealActorKind,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import {
  digitalFulfilmentArtifacts,
  digitalFulfilmentIncidents,
  digitalFulfilmentReveals,
  digitalFulfilments,
} from '../schema/digitalRetail.js';

export type DigitalFulfilmentRow = InferSelectModel<typeof digitalFulfilments>;
export type DigitalFulfilmentIncidentRow = InferSelectModel<typeof digitalFulfilmentIncidents>;

/**
 * An artifact as everything but the sealing path sees it.
 *
 * `publicColumns` withholds `sealedSecret`, `keyReference` and `plaintextSha256`
 * at runtime AND at the type level, so this row type has no property to hold a
 * secret and a serializer reaching for one fails `tsc`.
 */
export type DigitalArtifactPublicRow = Awaited<ReturnType<typeof findActiveArtifact>>;

const artifactPublicColumns = () =>
  publicColumns(digitalFulfilmentArtifacts, PROTECTED_COLUMNS);

export interface CreateFulfilmentInput {
  readonly purchaseOrderId: string;
  readonly orderId: string;
  readonly orderItemId: string;
  readonly buyerKey: string;
  readonly capability: DigitalFulfilmentCapability;
  readonly productClass: DigitalRetailProductClass;
  readonly canonicalVariantId: string | null;
  readonly displayTitle: string;
  readonly platform: string;
  readonly activationEcosystem: string;
  readonly edition: string;
  readonly now: Date;
}

/** What `createFulfilment` did, so a replay does not deliver twice. */
export interface CreateFulfilmentResult {
  readonly fulfilment: DigitalFulfilmentRow;
  readonly created: boolean;
}

/**
 * Create the buyer's durable record, converging on a replay.
 *
 * ONE statement plus a read-back, the `grantRight` shape: `UNIQUE(order_item_id)`
 * and `UNIQUE(purchase_order_id)` both encode "this buyer already has this", and
 * an untargeted `DO NOTHING` covers both. A "check then insert" has a window
 * between the two statements and a redelivered provider callback is exactly a
 * second caller inside it.
 */
export async function createFulfilment(
  input: CreateFulfilmentInput,
  tx?: DatabaseOrTransaction,
): Promise<CreateFulfilmentResult> {
  const db = tx ?? getDb();
  const [inserted] = await db
    .insert(digitalFulfilments)
    .values({
      purchaseOrderId: input.purchaseOrderId,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      buyerKey: input.buyerKey,
      capability: input.capability,
      productClass: input.productClass,
      canonicalVariantId: input.canonicalVariantId,
      displayTitle: input.displayTitle,
      platform: input.platform,
      activationEcosystem: input.activationEcosystem,
      edition: input.edition,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { fulfilment: inserted, created: true };

  const existing = await findFulfilmentByOrderItem(input.orderItemId, db);
  if (!existing) {
    throw new Error(
      `digital fulfilment for order item ${input.orderItemId} conflicted but could not be read back`,
    );
  }
  return { fulfilment: existing, created: false };
}

/** One fulfilment by the order line it belongs to. */
export async function findFulfilmentByOrderItem(
  orderItemId: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalFulfilmentRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(digitalFulfilments)
    .where(eq(digitalFulfilments.orderItemId, orderItemId))
    .limit(1);
  return row ?? null;
}

/** One fulfilment by id. */
export async function findFulfilment(
  id: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalFulfilmentRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(digitalFulfilments)
    .where(eq(digitalFulfilments.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Everything one buyer owns, newest first — the library's own read.
 *
 * Keyed on `buyer_key`, which is the same spelling `asset_rights` uses, so the
 * library projection asks both sources the same question with one key.
 */
export async function findFulfilmentsForBuyer(
  buyerKey: string,
  limit: number,
  tx?: DatabaseOrTransaction,
): Promise<DigitalFulfilmentRow[]> {
  const db = tx ?? getDb();
  return db
    .select()
    .from(digitalFulfilments)
    .where(eq(digitalFulfilments.buyerKey, buyerKey))
    .orderBy(desc(digitalFulfilments.createdAt))
    .limit(limit);
}

/** A sealed artifact, as the sealing path hands it over. No plaintext anywhere. */
export interface SealedArtifactInput {
  readonly fulfilmentId: string;
  readonly capability: DigitalFulfilmentCapability;
  readonly source: DigitalArtifactSource;
  /** Ciphertext. NULL for a capability that hands over no secret. */
  readonly sealedSecret: string | null;
  readonly keyReference: string | null;
  readonly sealAlgorithm: string | null;
  readonly plaintextSha256: string | null;
  readonly maskedHint: string | null;
  readonly instructions: string | null;
  readonly providerArtifactId: string | null;
  readonly replacesArtifactId: string | null;
  readonly incidentId: string | null;
  readonly operatorOxyUserId: string | null;
  readonly expiresAt: Date | null;
  readonly now: Date;
}

/**
 * Store a sealed artifact and mark the fulfilment delivered, together.
 *
 * One transaction, because an artifact whose fulfilment still says `pending` is a
 * key nobody can reach and a `delivered` fulfilment with no artifact is a
 * promise. The partial unique on `(fulfilment_id) WHERE state = 'active'` is what
 * makes a second concurrent delivery fail rather than produce two live keys.
 */
export async function storeArtifact(
  input: SealedArtifactInput,
  tx?: DatabaseOrTransaction,
): Promise<string> {
  const run = async (db: DatabaseOrTransaction): Promise<string> => {
    const [artifact] = await db
      .insert(digitalFulfilmentArtifacts)
      .values({
        fulfilmentId: input.fulfilmentId,
        capability: input.capability,
        source: input.source,
        sealedSecret: input.sealedSecret,
        keyReference: input.keyReference,
        sealAlgorithm: input.sealAlgorithm,
        plaintextSha256: input.plaintextSha256,
        maskedHint: input.maskedHint,
        instructions: input.instructions,
        providerArtifactId: input.providerArtifactId,
        replacesArtifactId: input.replacesArtifactId,
        incidentId: input.incidentId,
        operatorOxyUserId: input.operatorOxyUserId,
        expiresAt: input.expiresAt,
      })
      .returning({ id: digitalFulfilmentArtifacts.id });
    if (!artifact) throw new Error(`artifact for fulfilment ${input.fulfilmentId} was not stored`);

    await db
      .update(digitalFulfilments)
      .set({ status: 'delivered', deliveredAt: input.now, updatedAt: input.now })
      .where(
        and(eq(digitalFulfilments.id, input.fulfilmentId), eq(digitalFulfilments.status, 'pending')),
      );
    return artifact.id;
  };
  const db = tx ?? getDb();
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * Supersede the active artifact with a replacement, in one transaction.
 *
 * The old row moves to `replaced` FIRST, because the partial unique refuses two
 * active artifacts for one fulfilment — which is exactly the property that makes
 * "both the original and the replacement work" unrepresentable. Nothing is
 * deleted: the superseded row stays as the evidence of what the buyer was first
 * given.
 */
export async function replaceArtifact(
  input: SealedArtifactInput & { readonly supersedesArtifactId: string },
  tx?: DatabaseOrTransaction,
): Promise<string> {
  const run = async (db: DatabaseOrTransaction): Promise<string> => {
    await db
      .update(digitalFulfilmentArtifacts)
      .set({ state: 'replaced', updatedAt: input.now })
      .where(
        and(
          eq(digitalFulfilmentArtifacts.id, input.supersedesArtifactId),
          eq(digitalFulfilmentArtifacts.state, 'active'),
        ),
      );
    return storeArtifact({ ...input, replacesArtifactId: input.supersedesArtifactId }, db);
  };
  const db = tx ?? getDb();
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** The active artifact of a fulfilment, WITHOUT its sealed half. */
export async function findActiveArtifact(fulfilmentId: string, tx?: DatabaseOrTransaction) {
  const db = tx ?? getDb();
  const [row] = await db
    .select(artifactPublicColumns())
    .from(digitalFulfilmentArtifacts)
    .where(
      and(
        eq(digitalFulfilmentArtifacts.fulfilmentId, fulfilmentId),
        eq(digitalFulfilmentArtifacts.state, 'active'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every artifact of a fulfilment, oldest first, WITHOUT their sealed halves. */
export async function findArtifacts(fulfilmentId: string, tx?: DatabaseOrTransaction) {
  const db = tx ?? getDb();
  return db
    .select(artifactPublicColumns())
    .from(digitalFulfilmentArtifacts)
    .where(eq(digitalFulfilmentArtifacts.fulfilmentId, fulfilmentId))
    .orderBy(asc(digitalFulfilmentArtifacts.createdAt));
}

/** The sealed half of one artifact — ciphertext and the key that sealed it. */
export interface SealedArtifactMaterial {
  readonly id: string;
  readonly fulfilmentId: string;
  readonly capability: DigitalFulfilmentCapability;
  readonly state: string;
  readonly sealedSecret: string | null;
  readonly keyReference: string | null;
  readonly sealAlgorithm: string | null;
}

/**
 * Read an artifact's SEALED half, by explicit column list.
 *
 * This is the one function in the repository that names a protected column, and
 * naming them is the point: it reads differently from an ordinary select and
 * stays greppable. Its ONE caller is the reveal path, which has already
 * authorized the buyer.
 */
export async function readSealedArtifact(
  artifactId: string,
  tx?: DatabaseOrTransaction,
): Promise<SealedArtifactMaterial | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select({
      id: digitalFulfilmentArtifacts.id,
      fulfilmentId: digitalFulfilmentArtifacts.fulfilmentId,
      capability: digitalFulfilmentArtifacts.capability,
      state: digitalFulfilmentArtifacts.state,
      sealedSecret: digitalFulfilmentArtifacts.sealedSecret,
      keyReference: digitalFulfilmentArtifacts.keyReference,
      sealAlgorithm: digitalFulfilmentArtifacts.sealAlgorithm,
    })
    .from(digitalFulfilmentArtifacts)
    .where(eq(digitalFulfilmentArtifacts.id, artifactId))
    .limit(1);
  return row ?? null;
}

export interface RecordRevealInput {
  readonly fulfilmentId: string;
  readonly artifactId: string;
  readonly actorKind: DigitalRevealActorKind;
  readonly buyerKey: string | null;
  readonly operatorOxyUserId: string | null;
  readonly reason: string | null;
  readonly now: Date;
}

/**
 * Append a reveal and advance the fulfilment's counters, together.
 *
 * `revealCount` is incremented IN SQL (`+ 1`) rather than read and written, so
 * two concurrent reveals cannot both write the same value —
 * `derivationIndex`'s rule, one repository over. `firstRevealedAt` is set with
 * `coalesce`, so it records the FIRST reveal forever and a later one cannot move
 * it: the CHECK pairs a non-zero count with a non-null timestamp, and a reveal
 * that rewrote it would quietly relabel when the buyer first saw their key.
 */
export async function recordReveal(
  input: RecordRevealInput,
  tx?: DatabaseOrTransaction,
): Promise<void> {
  const run = async (db: DatabaseOrTransaction): Promise<void> => {
    await db.insert(digitalFulfilmentReveals).values({
      fulfilmentId: input.fulfilmentId,
      artifactId: input.artifactId,
      actorKind: input.actorKind,
      buyerKey: input.buyerKey,
      operatorOxyUserId: input.operatorOxyUserId,
      reason: input.reason,
      revealedAt: input.now,
    });
    await db
      .update(digitalFulfilments)
      .set({
        revealCount: sql`${digitalFulfilments.revealCount} + 1`,
        // `${input.now.toISOString()}::timestamptz`, never a bare `Date`.
        // A comparison or a coalesce against an EXPRESSION has no column for
        // postgres.js to take a type from, and it refuses a raw `Date` with
        // `ERR_INVALID_ARG_TYPE` at query time — a hard failure on a statement
        // that type-checks perfectly (`CONVENTIONS.md`, and measured here).
        firstRevealedAt: sql`coalesce(${digitalFulfilments.firstRevealedAt}, ${input.now.toISOString()}::timestamptz)`,
        updatedAt: input.now,
      })
      .where(eq(digitalFulfilments.id, input.fulfilmentId));
  };
  const db = tx ?? getDb();
  if ('transaction' in db) {
    await db.transaction(run);
    return;
  }
  await run(db);
}

/** Record what provider truth says about redemption. Nothing else may write it. */
export async function recordRedemptionState(
  artifactId: string,
  state: DigitalArtifactRedemptionState,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<void> {
  const db = tx ?? getDb();
  await db
    .update(digitalFulfilmentArtifacts)
    .set({ redemptionState: state, redemptionCheckedAt: now, updatedAt: now })
    .where(eq(digitalFulfilmentArtifacts.id, artifactId));
}

/** Mark a fulfilment refunded. The artifact is NOT deleted (ADR 0011 D11). */
export async function markFulfilmentRefunded(
  fulfilmentId: string,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<DigitalFulfilmentRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .update(digitalFulfilments)
    .set({ status: 'refunded', refundedAt: now, updatedAt: now })
    .where(eq(digitalFulfilments.id, fulfilmentId))
    .returning();
  return row ?? null;
}

export interface OpenIncidentInput {
  readonly fulfilmentId: string;
  readonly artifactId: string | null;
  readonly kind: DigitalFulfilmentIncidentKind;
  readonly reportNote: string | null;
  readonly buyerKey: string | null;
  readonly operatorOxyUserId: string | null;
  readonly now: Date;
}

/**
 * Open a support incident.
 *
 * The CHECK on the table requires an operator id for the operator-raised kinds,
 * so `openIncident` cannot be used by a sweeper to file a `provider_incident`
 * without naming who decided. A machine can never file — #1015's provenance rule,
 * restated for a domain where what is being manufactured is money's worth of key.
 */
export async function openIncident(
  input: OpenIncidentInput,
  tx?: DatabaseOrTransaction,
): Promise<DigitalFulfilmentIncidentRow> {
  const db = tx ?? getDb();
  const [row] = await db
    .insert(digitalFulfilmentIncidents)
    .values({
      fulfilmentId: input.fulfilmentId,
      artifactId: input.artifactId,
      kind: input.kind,
      reportNote: input.reportNote,
      buyerKey: input.buyerKey,
      operatorOxyUserId: input.operatorOxyUserId,
      reportedAt: input.now,
    })
    .returning();
  if (!row) throw new Error(`incident for fulfilment ${input.fulfilmentId} was not opened`);
  return row;
}

/** Move an incident's state. Terminal states carry their resolution time by CHECK. */
export async function resolveIncident(
  incidentId: string,
  state: DigitalFulfilmentIncidentState,
  now: Date,
  detail: { readonly resolutionNote?: string; readonly replacementArtifactId?: string } = {},
  tx?: DatabaseOrTransaction,
): Promise<DigitalFulfilmentIncidentRow | null> {
  const db = tx ?? getDb();
  const open = state === 'open' || state === 'supplier_escalated';
  const [row] = await db
    .update(digitalFulfilmentIncidents)
    .set({
      state,
      resolvedAt: open ? null : now,
      resolutionNote: detail.resolutionNote ?? null,
      replacementArtifactId: detail.replacementArtifactId ?? null,
      updatedAt: now,
    })
    .where(eq(digitalFulfilmentIncidents.id, incidentId))
    .returning();
  return row ?? null;
}

/** Every incident raised over one fulfilment, newest first. */
export async function findIncidents(
  fulfilmentId: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalFulfilmentIncidentRow[]> {
  const db = tx ?? getDb();
  return db
    .select()
    .from(digitalFulfilmentIncidents)
    .where(eq(digitalFulfilmentIncidents.fulfilmentId, fulfilmentId))
    .orderBy(desc(digitalFulfilmentIncidents.reportedAt));
}
