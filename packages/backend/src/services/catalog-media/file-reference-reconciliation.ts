/**
 * The nightly reconciliation (Oxy ADR 0043 D6): for each entity type, send Oxy
 * the WHOLE inventory of `(fileId, entityId)` pairs Mercaria's rows hold. Oxy
 * adds the references it is missing and removes the ones created before the run
 * began that the inventory does not list.
 *
 * It is the safety net under the reference outbox — a crash between the Oxy
 * call and the ledger write, a row written before migration `0172` existed, an
 * order snapshot (registered only here) — and it is HOW EXISTING DATA ENTERS the
 * model: the first run of each type registers every file Mercaria already used.
 *
 * `OXY_FILE_RECONCILIATION_DRY_RUN` (default ON) commits every run as a dry run:
 * Oxy reports what it WOULD add and remove and changes nothing, so the first
 * numbers of each type are read before they act. Oxy's file sweep must not be
 * switched to `enforce` before a real (non-dry) run of every type has happened,
 * or every application file Mercaria uses but never referenced is trashed 24
 * hours later.
 *
 * After a real run the ledger (`oxy_file_references`) is rewritten to the
 * inventory, so the outbox's next removal of a pre-existing file knows to send
 * it. A pair Oxy refused is recorded as registered here (the commit reports
 * counts, not pairs); the next entity write re-asks and records the refusal.
 */

import { randomUUID } from 'node:crypto';
import type { OxyFileReferenceEntityType } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  claimFileReferenceReconciliation,
  completeFileReferenceReconciliation,
  ensureFileReferenceReconciliations,
  failFileReferenceReconciliation,
  renewFileReferenceReconciliation,
} from '../../db/oxyFiles/reconciliationRepository.js';
import {
  findFileReferenceLedger,
  findFileReferenceLedgerEntityPage,
  forgetFileReferences,
  recordFileReferences,
} from '../../db/oxyFiles/referenceLedgerRepository.js';
import {
  fileReferenceDefinition,
  fileReferenceDefinitions,
  readEntityHoldings,
  streamEntityInventory,
} from './file-reference-registry.js';
import { reconcileOxyFileReferences } from './oxy-files.js';

/**
 * The types a reconciliation covers: every one with holding rows to read — its
 * `sources`, or a dedicated `inventory` for a protected column.
 */
export function reconciledEntityTypes(): OxyFileReferenceEntityType[] {
  return fileReferenceDefinitions()
    .filter((definition) => definition.sources.length > 0 || definition.inventory !== undefined)
    .map((definition) => definition.entityType);
}

export interface ReconciliationOutcome {
  readonly entityType: OxyFileReferenceEntityType;
  readonly dryRun: boolean;
  readonly inventory: number;
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly refused: number;
}

/** Reconcile one entity type end to end. */
export async function reconcileEntityType(
  entityType: OxyFileReferenceEntityType,
  options: { dryRun: boolean; onProgress?: () => Promise<void> },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReconciliationOutcome> {
  const definition = fileReferenceDefinition(entityType);
  if (definition.sources.length === 0 && definition.inventory === undefined)
    throw new Error(`${entityType} has no inventory to reconcile.`);
  let inventory = 0;
  async function* counted() {
    for await (const item of streamEntityInventory(definition, db)) {
      inventory += 1;
      if (inventory % 10_000 === 0) await options.onProgress?.();
      yield item;
    }
  }
  const result = await reconcileOxyFileReferences(entityType, counted(), {
    dryRun: options.dryRun,
  });
  // A type with no holding sources is never converged through the ledger (its
  // writer registers it directly), so there is no ledger to rewrite.
  if (!options.dryRun && definition.sources.length > 0)
    await rewriteLedgerToInventory(entityType, db, options.onProgress);
  return {
    entityType,
    dryRun: options.dryRun,
    inventory,
    added: result.added,
    removed: result.removed,
    unchanged: result.unchanged,
    refused: result.refused,
  };
}

/**
 * Make `oxy_file_references` say what Oxy now holds for the type: every pair the
 * rows hold is registered, every ledger pair they do not hold is forgotten.
 * Two keyset passes, never the whole type in memory.
 */
async function rewriteLedgerToInventory(
  entityType: OxyFileReferenceEntityType,
  db: DatabaseOrTransaction,
  onProgress?: () => Promise<void>,
): Promise<void> {
  const definition = fileReferenceDefinition(entityType);
  let page: { entityId: string; fileId: string; state: 'registered' }[] = [];
  for await (const item of streamEntityInventory(definition, db)) {
    page.push({ ...item, state: 'registered' });
    if (page.length === 500) {
      await recordFileReferences(entityType, page, db);
      page = [];
      await onProgress?.();
    }
  }
  if (page.length > 0) await recordFileReferences(entityType, page, db);

  let after: string | undefined;
  for (;;) {
    const entityIds = await findFileReferenceLedgerEntityPage(entityType, after, 500, db);
    if (entityIds.length === 0) break;
    after = entityIds[entityIds.length - 1];
    const holdings = await readEntityHoldings(definition, entityIds, db);
    const stale = (await findFileReferenceLedger(entityType, entityIds, db)).filter(
      (entry) => !holdings.get(entry.entityId)?.has(entry.fileId),
    );
    if (stale.length > 0) await forgetFileReferences(entityType, stale, db);
    if (entityIds.length < 500) break;
  }
}

const LEASE_MS = 2 * 60 * 60_000;
const RETRY_MS = 30 * 60_000;
const leaseOwner = `oxy-file-reconciliation:${randomUUID()}`;

/** Run at most ONE due type. Returns what it did, or `undefined` when nothing was due. */
export async function runDueFileReferenceReconciliation(
  options: { now?: () => Date; owner?: string } = {},
): Promise<ReconciliationOutcome | undefined> {
  const now = options.now ?? (() => new Date());
  const owner = options.owner ?? leaseOwner;
  const types = reconciledEntityTypes();
  await ensureFileReferenceReconciliations(types, now());
  const claimed = await claimFileReferenceReconciliation({
    entityTypes: types,
    leaseOwner: owner,
    leaseMs: LEASE_MS,
    now: now(),
  });
  if (!claimed) return undefined;
  const dryRun = config.oxyFiles.reconciliationDryRun;
  try {
    const outcome = await reconcileEntityType(claimed.entityType, {
      dryRun,
      onProgress: async () => {
        await renewFileReferenceReconciliation({
          id: claimed.id,
          leaseOwner: owner,
          now: now(),
          leaseMs: LEASE_MS,
        });
      },
    });
    await completeFileReferenceReconciliation({
      id: claimed.id,
      leaseOwner: owner,
      now: now(),
      nextRunAt: new Date(
        now().getTime() + config.oxyFiles.reconciliationIntervalHours * 3_600_000,
      ),
      dryRun,
      added: outcome.added,
      removed: outcome.removed,
      unchanged: outcome.unchanged,
      refused: outcome.refused,
      inventory: outcome.inventory,
    });
    log.general.info(outcome, '[OxyFiles] reference reconciliation completed');
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reconciliation failed.';
    await failFileReferenceReconciliation({
      id: claimed.id,
      leaseOwner: owner,
      now: now(),
      nextRunAt: new Date(now().getTime() + RETRY_MS),
      error: message,
    });
    log.general.warn(
      { entityType: claimed.entityType, err: message },
      '[OxyFiles] reference reconciliation failed; retried in 30 minutes',
    );
    return undefined;
  }
}

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Begin looking for due runs, on EVERY task: the lease makes one task run a
 * type. Gated by `OXY_FILE_RECONCILIATION_ENABLED`. Idempotent.
 */
export function startFileReferenceReconciliation(): void {
  if (timer !== undefined) return;
  if (!config.oxyFiles.reconciliationEnabled) {
    log.general.info('[OxyFiles] reference reconciliation disabled');
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runDueFileReferenceReconciliation()
      .catch((error: unknown) =>
        log.general.error({ err: error }, '[OxyFiles] reconciliation tick failed'),
      )
      .finally(() => {
        running = false;
      });
  }, config.oxyFiles.reconciliationPollIntervalMs);
  timer.unref?.();
  log.general.info(
    { dryRun: config.oxyFiles.reconciliationDryRun },
    '[OxyFiles] reference reconciliation started',
  );
}

export function stopFileReferenceReconciliation(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
