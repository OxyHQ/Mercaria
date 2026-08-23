/**
 * The minted size-system keys are STORABLE, and the real resolver gives three
 * different answers about them (#367 Workstream 11).
 *
 * ## Why this needs a real server rather than a regex
 *
 * `catalog_external_mappings.target_size_system_key` carries
 * `catalog_external_mappings_size_system_key_shape_check`, rendered from
 * `DOTTED_KEY_SHAPE`. This issue mints a key NAMESPACE that every future
 * `size_system` mapping cites forever, so "can such a key be written down" is
 * the single most load-bearing thing about it — and a copy of the pattern
 * asserted in TypeScript would be a test of the copy. A mocked insert accepts
 * any statement, including the ones the server refuses outright.
 *
 * The paired control is the second case: a key the CHECK must REFUSE, asserted
 * by SQLSTATE and by constraint name. Without it, "every key inserted" is also
 * what a dropped constraint reports.
 *
 * ## Why the resolver is driven here rather than mocked
 *
 * The claim this issue makes is about `verifyTarget`'s `size_system` branch —
 * that `present` resolves, `absent` becomes a blocking `target_unresolvable`
 * and no registry at all stays `registry_unavailable`. Those three answers come
 * out of the resolver, not out of the registry, and they are what an operator
 * reads. One fixture, three registrations, three distinguishable outcomes: if
 * the registry answered `present` unconditionally the second would resolve, and
 * if registration were a no-op the first would report `registry_unavailable`.
 *
 * ## Nothing here commits
 *
 * Every case runs inside a transaction that is rolled back, so this file adds
 * no teardown to a SHARED test database and takes no trigger-toggle window —
 * `catalog_external_mappings` refuses DELETE by trigger, and a row that never
 * commits never has to be removed. The rollback is not assumed: the first case
 * re-reads its own source row afterwards and asserts it is gone.
 *
 * `resolveExternalToken` is called with NO subject, so it records no
 * observation; the write path is `recordExternalTokenObservation`'s and belongs
 * to the domain that owns it.
 */

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { catalogSources } from '../../../db/schema/provenance.js';
import { catalogExternalMappings } from '../../../db/schema/catalogExternalMappings.js';
import { clearCatalogConceptRegistries } from '../../catalog-external-mappings/concept-registry.port.js';
import { resolveExternalToken } from '../../catalog-external-mappings/resolution.service.js';
import { registerSizeSystemConceptRegistry } from '../size-system-registry.js';
import { sizeSystemKeys } from '../size-systems.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

/**
 * The validity anchor, safely in the PAST (#253).
 *
 * A fixture pinned to a future date passes today, keeps passing, and breaks CI
 * for whoever pushes on the day it arrives — in a file they did not touch. The
 * resolution instant is DERIVED as an offset rather than written as a second
 * literal that could drift outside the window.
 */
const VALID_FROM = new Date('2020-01-01T00:00:00Z');
const RESOLVE_AT = new Date(VALID_FROM.getTime() + 86_400_000);

const CHECK_VIOLATION = '23514';

/** Signals "roll this back" without being confusable with a real failure. */
class RollbackProbe extends Error {}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Run against a real server and throw the work away.
 *
 * The captured value comes back out of the closure rather than out of the
 * transaction's return, because a rolled-back transaction has no return — and
 * an assertion made INSIDE one is swallowed by the rejection that rolls it
 * back, which is how a rollback wrapper turns a failing test green.
 */
async function probe<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  let captured: T | undefined;
  let failure: unknown;
  await db
    .transaction(async (tx) => {
      captured = await run(tx);
      throw new RollbackProbe('probe complete');
    })
    .catch((error: unknown) => {
      if (!(error instanceof RollbackProbe)) failure = error;
    });
  if (failure !== undefined) throw failure;
  return captured as T;
}

/** The SQLSTATE and constraint a refusal carries. Both, or "it threw" is the claim. */
function refusalOf(error: unknown): { code?: string; constraint?: string } {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return {
    code: cause?.code ?? (error as { code?: string }).code,
    constraint:
      cause?.constraint_name ?? (error as { constraint_name?: string }).constraint_name,
  };
}

/** A source row every case hangs its mapping off. */
async function insertSource(tx: Tx, id: string): Promise<void> {
  await tx.insert(catalogSources).values({
    id,
    kind: 'operator',
    name: `size-system registry realdb ${RUN}`,
    mayDisplay: true,
    mayStore: true,
    attributionRequired: false,
  });
}

/** An APPROVED, live `size_system` mapping from `externalKey` to `sizeSystemKey`. */
async function insertLiveMapping(
  tx: Tx,
  sourceId: string,
  externalKey: string,
  sizeSystemKeyValue: string,
): Promise<string> {
  const id = `m-${uuidv7().slice(-10)}-${RUN}`;
  await tx.insert(catalogExternalMappings).values({
    id,
    catalogSourceId: sourceId,
    dimension: 'size_system',
    externalKey,
    targetSizeSystemKey: sizeSystemKeyValue,
    transformRule: 'identity',
    transformRuleVersion: 1,
    version: 1,
    state: 'approved',
    provenance: 'operator',
    confidence: 1,
    validFrom: VALID_FROM,
    approvedByOxyUserId: `op-${RUN}`,
    approvedAt: VALID_FROM,
  });
  return id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  clearCatalogConceptRegistries();
});

afterEach(() => {
  clearCatalogConceptRegistries();
});

describe('the minted key namespace is storable', () => {
  it('writes every key the registry mints into the real column', async () => {
    const sourceId = `src-store-${RUN}`;
    const minted = sizeSystemKeys();
    // Population floor: an empty registry would make the walk below vacuous and
    // report a clean run over nothing.
    expect(minted.length).toBeGreaterThanOrEqual(5);

    const stored = await probe(async (tx) => {
      await insertSource(tx, sourceId);
      for (const [index, key] of minted.entries()) {
        await insertLiveMapping(tx, sourceId, `token-${index}-${RUN}`, key);
      }
      const rows = await tx
        .select({ key: catalogExternalMappings.targetSizeSystemKey })
        .from(catalogExternalMappings)
        .where(eq(catalogExternalMappings.catalogSourceId, sourceId));
      return rows.map((row) => row.key);
    });

    expect([...stored].sort()).toEqual([...minted].sort());

    // The rollback is PROVEN rather than assumed: if the transaction had
    // committed, this source would still be here and this file would be leaving
    // rows in a shared database for every other file to trip over.
    const survivors = await db
      .select({ id: catalogSources.id })
      .from(catalogSources)
      .where(eq(catalogSources.id, sourceId));
    expect(survivors).toEqual([]);
  });

  it('is that CHECK and not a dropped one — a mis-shaped key is refused', async () => {
    // The control. "Every minted key inserted" is also what a table with no
    // shape constraint reports, so the constraint is shown REFUSING something
    // first — by SQLSTATE and by name, because a row rejected for an unrelated
    // reason throws too.
    const sourceId = `src-refuse-${RUN}`;
    const real = sizeSystemKeys()[0] as string;

    const refusals = await probe(async (tx) => {
      await insertSource(tx, sourceId);
      const caught: Record<string, { code?: string; constraint?: string }> = {};
      for (const [label, key] of [
        ['uppercase', real.toUpperCase()],
        ['a leading dot', `.${real}`],
        ['a trailing dot', `${real}.`],
        ['a space', real.replace('.', ' ')],
        ['a hyphen', real.replace('.', '-')],
      ] as const) {
        // Each attempt takes its own SAVEPOINT: one failed statement aborts the
        // WHOLE transaction in PostgreSQL (25P02), so without a nested
        // transaction the second insert would fail for a reason that is not the
        // one under test.
        await tx
          .transaction(async (nested) => {
            await insertLiveMapping(nested, sourceId, `refuse-${label}-${RUN}`, key);
          })
          .catch((error: unknown) => {
            caught[label] = refusalOf(error);
          });
      }
      return caught;
    });

    expect(Object.keys(refusals).sort()).toEqual(
      ['a hyphen', 'a leading dot', 'a space', 'a trailing dot', 'uppercase'].sort(),
    );
    for (const [label, refusal] of Object.entries(refusals)) {
      expect(refusal.code, `${label}: SQLSTATE ${String(refusal.code)}`).toBe(CHECK_VIOLATION);
      expect(refusal.constraint, `${label}: refused by ${String(refusal.constraint)}`).toBe(
        'catalog_external_mappings_size_system_key_shape_check',
      );
    }
  });
});

describe('the real resolver gives three different answers about one mapping', () => {
  const sourceId = `src-resolve-${RUN}`;
  const externalToken = `EU Shoe Size ${RUN}`;

  /** Build the fixture, resolve through the REAL service, throw the rows away. */
  async function resolveAgainst(targetKey: string) {
    return probe(async (tx) => {
      await insertSource(tx, sourceId);
      await insertLiveMapping(tx, sourceId, externalToken, targetKey);
      return resolveExternalToken(
        {
          catalogSourceId: sourceId,
          dimension: 'size_system',
          externalKey: externalToken,
          at: RESOLVE_AT,
        },
        tx,
      );
    });
  }

  it('resolves a mapping onto a key the registry holds', async () => {
    registerSizeSystemConceptRegistry();
    const known = sizeSystemKeys()[0] as string;

    const resolution = await resolveAgainst(known);

    expect(resolution.outcome).toBe('resolved');
    if (resolution.outcome !== 'resolved') return;
    expect(resolution.resolved.target).toEqual({
      dimension: 'size_system',
      sizeSystemKey: known,
    });
    expect(resolution.resolved.origin).toBe('governed');
  });

  it('BLOCKS a well-formed key the registry does not hold, as target_unresolvable', async () => {
    registerSizeSystemConceptRegistry();
    // Storable, correctly shaped, and names a system Mercaria has not declared:
    // the case an operator must be told about. Answering `resolved` here is the
    // whole failure a registry-that-agrees would cause, and it is silent.
    const unknown = 'size.apparel.uk.womens.manufacturer_label';
    expect(sizeSystemKeys()).not.toContain(unknown);

    const resolution = await resolveAgainst(unknown);

    expect(resolution.outcome).toBe('unresolved');
    if (resolution.outcome !== 'unresolved') return;
    expect(resolution.reason).toBe('target_unresolvable');
  });

  it('BLOCKS with registry_unavailable when nothing is registered', async () => {
    // Deliberately NOT registering. This is the state the port shipped in, and
    // it is a different reason from the one above on purpose: "Mercaria does not
    // have this size system" and "Mercaria cannot answer questions about size
    // systems" lead an operator to opposite next actions.
    const known = sizeSystemKeys()[0] as string;

    const resolution = await resolveAgainst(known);

    expect(resolution.outcome).toBe('unresolved');
    if (resolution.outcome !== 'unresolved') return;
    expect(resolution.reason).toBe('registry_unavailable');
  });
});
