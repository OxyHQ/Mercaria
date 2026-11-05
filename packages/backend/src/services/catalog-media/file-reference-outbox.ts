/**
 * Drain `oxy_file_reference_outboxes`: bring each claimed entity's Oxy
 * references into agreement with the files its rows hold NOW (Oxy ADR 0043 D4).
 *
 * The convergence is a diff of two sets per entity:
 *
 * - **holds** — what the live rows hold (the registry's `readEntityHoldings`);
 * - **told** — what Oxy acknowledged (`oxy_file_references`).
 *
 * `holds − told` is added, `told − holds` removed, and the ledger records Oxy's
 * per-item answer. Running it twice changes nothing the second time, so a
 * reclaimed lease, a retried batch and a duplicate request are all harmless —
 * the at-least-once contract every outbox here has.
 *
 * It runs AFTER the write committed (the trigger's row commits with it), so a
 * failed Oxy call never blocks or rolls back a catalogue write, and never loses
 * a removal: the row stays until Oxy answered.
 */

import { randomUUID } from 'node:crypto';
import type { OxyFileReferenceEntityType } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  claimFileReferenceOutbox,
  completeFileReferenceOutbox,
  releaseFileReferenceOutbox,
  type OxyFileReferenceOutboxRow,
} from '../../db/oxyFiles/referenceOutboxRepository.js';
import {
  findFileReferenceLedger,
  forgetFileReferences,
  recordFileReferences,
} from '../../db/oxyFiles/referenceLedgerRepository.js';
import { fileReferenceDefinition, readEntityHoldings } from './file-reference-registry.js';
import { addOxyFileReferences, removeOxyFileReferences } from './oxy-files.js';

export interface FileReferenceDiff {
  readonly add: { entityId: string; fileId: string }[];
  readonly remove: { entityId: string; fileId: string }[];
  /** Ledger rows Oxy refused that the entity no longer holds: nothing to tell Oxy. */
  readonly forgetRefused: { entityId: string; fileId: string }[];
}

/** The pure half of the convergence, exported for its own tests. */
export function diffFileReferences(
  entityIds: readonly string[],
  holdings: ReadonlyMap<string, ReadonlySet<string>>,
  ledger: readonly { entityId: string; fileId: string; state: 'registered' | 'refused' }[],
): FileReferenceDiff {
  const told = new Map<string, Map<string, 'registered' | 'refused'>>();
  for (const entry of ledger) {
    const files = told.get(entry.entityId) ?? new Map<string, 'registered' | 'refused'>();
    files.set(entry.fileId, entry.state);
    told.set(entry.entityId, files);
  }
  const diff: FileReferenceDiff = { add: [], remove: [], forgetRefused: [] };
  for (const entityId of new Set(entityIds)) {
    const holds = holdings.get(entityId) ?? new Set<string>();
    const known = told.get(entityId) ?? new Map<string, 'registered' | 'refused'>();
    for (const fileId of holds) if (!known.has(fileId)) diff.add.push({ entityId, fileId });
    for (const [fileId, state] of known) {
      if (holds.has(fileId)) continue;
      (state === 'registered' ? diff.remove : diff.forgetRefused).push({ entityId, fileId });
    }
  }
  return diff;
}

/** Converge ONE entity type's claimed entities. Throws when Oxy could not answer. */
export async function convergeEntityReferences(
  entityType: OxyFileReferenceEntityType,
  entityIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<{ added: number; removed: number; refused: number }> {
  const definition = fileReferenceDefinition(entityType);
  const holdings = await readEntityHoldings(definition, entityIds, db);
  const ledger = await findFileReferenceLedger(entityType, entityIds, db);
  const diff = diffFileReferences(entityIds, holdings, ledger);

  let refused = 0;
  if (diff.add.length > 0) {
    const results = await addOxyFileReferences(
      diff.add.map((pair) => ({ entityType, entityId: pair.entityId, fileId: pair.fileId })),
    );
    const entries = results.map((result) => ({
      entityId: result.entityId,
      fileId: result.fileId,
      state:
        result.result === 'created' || result.result === 'exists'
          ? ('registered' as const)
          : ('refused' as const),
    }));
    refused = entries.filter((entry) => entry.state === 'refused').length;
    await recordFileReferences(entityType, entries, db);
  }
  if (diff.remove.length > 0) {
    const results = await removeOxyFileReferences(
      diff.remove.map((pair) => ({ entityType, entityId: pair.entityId, fileId: pair.fileId })),
    );
    // `removed` and `not_found` both mean Oxy holds no such reference now.
    await forgetFileReferences(
      entityType,
      results.map((result) => ({ entityId: result.entityId, fileId: result.fileId })),
      db,
    );
  }
  if (diff.forgetRefused.length > 0) await forgetFileReferences(entityType, diff.forgetRefused, db);
  return { added: diff.add.length - refused, removed: diff.remove.length, refused };
}

/** Capped exponential backoff: 30s, 1m, 2m … at most an hour. */
export function fileReferenceBackoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

/** One drain: claim a batch, converge it per entity type, complete or release. */
export async function drainFileReferenceOutbox(options: {
  leaseOwner: string;
  batchSize: number;
  maxAttempts: number;
  now?: () => Date;
  only?: { entityType: OxyFileReferenceEntityType; entityIds: readonly string[] };
}): Promise<{ converged: number; failed: number }> {
  const now = options.now ?? (() => new Date());
  const claimed = await claimFileReferenceOutbox({
    leaseOwner: options.leaseOwner,
    batchSize: options.batchSize,
    now: now(),
    ...(options.only === undefined ? {} : { only: options.only }),
  });
  const byType = new Map<OxyFileReferenceEntityType, OxyFileReferenceOutboxRow[]>();
  for (const row of claimed) {
    const rows = byType.get(row.entityType) ?? [];
    rows.push(row);
    byType.set(row.entityType, rows);
  }
  let converged = 0;
  let failed = 0;
  for (const [entityType, rows] of byType) {
    try {
      await convergeEntityReferences(
        entityType,
        rows.map((row) => row.entityId),
      );
      for (const row of rows) {
        if (await completeFileReferenceOutbox(row.id, options.leaseOwner, now())) converged += 1;
      }
    } catch (error) {
      failed += rows.length;
      const message = error instanceof Error ? error.message : 'File reference convergence failed.';
      // A batch fails as a whole (one Oxy call per direction), so it is
      // released as a whole; each row backs off on its own attempt count.
      for (const row of rows) {
        await releaseFileReferenceOutbox({
          ids: [row.id],
          leaseOwner: options.leaseOwner,
          deadLettered: row.attempts >= options.maxAttempts,
          availableAt: new Date(now().getTime() + fileReferenceBackoffMs(row.attempts)),
          error: message,
          now: now(),
        });
      }
      log.general.warn(
        { entityType, entities: rows.length, err: message },
        '[OxyFiles] reference convergence failed; released with backoff',
      );
    }
  }
  return { converged, failed };
}

let timer: NodeJS.Timeout | undefined;
let running = false;
const leaseOwner = `oxy-file-references:${randomUUID()}`;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await drainFileReferenceOutbox({
      leaseOwner,
      batchSize: config.oxyFiles.referenceBatchSize,
      maxAttempts: config.oxyFiles.referenceMaxAttempts,
    });
    if (result.converged > 0 || result.failed > 0)
      log.general.debug(result, '[OxyFiles] reference outbox drained');
  } catch (error: unknown) {
    // The loop survives anything one drain throws.
    log.general.error({ err: error }, '[OxyFiles] reference outbox drain failed');
  } finally {
    running = false;
  }
}

/**
 * Begin draining, on EVERY task: claims are leases with an owner check. The
 * LOOP is gated by `OXY_FILE_REFERENCES_ENABLED`; the triggers enqueue whatever
 * it says, so turning it on drains the backlog. Idempotent.
 */
export function startFileReferenceDispatcher(): void {
  if (timer !== undefined) return;
  if (!config.oxyFiles.referencesEnabled) {
    log.general.info(
      '[OxyFiles] reference outbox disabled; changes are queued and will register once enabled',
    );
    return;
  }
  timer = setInterval(() => {
    void tick();
  }, config.oxyFiles.referencePollIntervalMs);
  timer.unref?.();
  log.general.info(
    {
      pollIntervalMs: config.oxyFiles.referencePollIntervalMs,
      batchSize: config.oxyFiles.referenceBatchSize,
    },
    '[OxyFiles] reference outbox dispatcher started',
  );
}

export function stopFileReferenceDispatcher(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
