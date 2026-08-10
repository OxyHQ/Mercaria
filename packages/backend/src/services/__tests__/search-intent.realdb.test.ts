/**
 * Natural-language shopping intent, against a REAL PostgreSQL database (#95).
 *
 * The properties pinned here are exactly the ones a mocked drizzle call cannot
 * see — a mocked `insert` accepts any statement, including one the server
 * rejects outright:
 *
 *  - the session's OWNER check, which is what stops an Oxy id on a guest row;
 *  - the turn's fallback BICONDITIONAL, which is what makes the fallback rate
 *    computable at all;
 *  - the enablement's COMPOSITE foreign key onto the run's `(id,
 *    dataset_digest)` — acceptance 7 as a constraint rather than a process;
 *  - the two PARTIAL uniques on `search_intent_enablements`, which exist
 *    because Postgres treats NULLs as DISTINCT and a plain unique would admit
 *    any number of language-wide rows;
 *  - and the whole planner end to end with NO model provider registered, which
 *    is the claim the entire issue rests on: the deterministic path is the
 *    floor, not a degraded mode.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every id and language this file writes carries a
 * per-run suffix, every assertion is scoped to rows this file created, and
 * teardown deletes exactly what it made. Global counts are never asserted.
 */

/**
 * FIRST, and its position is load-bearing: it sets `NL_INTENT_ENABLED` before
 * any later import initialises the frozen `config`. Without it every case below
 * would stop at the FIRST enablement gate and report `parser_disabled`, hiding
 * the fail-closed provider default this file exists to prove.
 */
import './fixtures/enable-nl-intent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import {
  searchIntentBenchmarkRuns,
  searchIntentEnablements,
  searchIntentSessions,
  searchIntentTurns,
} from '../../db/schema/searchIntent.js';
import {
  createSearchIntentSession,
  findOwnedSession,
  recordClarificationRound,
  recordSearchIntentTurn,
  readFallbackRate,
} from '../../db/searchIntent/searchIntentRepository.js';
import {
  insertBenchmarkRun,
  readEnablements,
  upsertEnablement,
} from '../../db/searchIntent/benchmarkRepository.js';
import { planShoppingIntent } from '../search-intent/plan.service.js';
import { hasShoppingIntentParser } from '../search-intent/parser.port.js';
import { INTENT_BENCHMARK_DATASET } from '../search-intent/benchmark/dataset.js';

let db: Database;

/** Everything this file created, so teardown removes exactly that. */
const createdSessions: string[] = [];
const createdTurns: string[] = [];
const createdRuns: string[] = [];
const createdEnablements: string[] = [];

/** A per-run suffix, so two workers never collide on a language or an actor. */
const suffix = uuidv7().replace(/-/gu, '').slice(0, 8);
const oxyUserId = `oxy_${suffix}`;
const futureExpiry = () => new Date(Date.now() + 60 * 60 * 1_000);

/**
 * A three-letter language nobody else uses.
 *
 * `search_intent_enablements` is keyed on (category, language) with a
 * LANGUAGE-WIDE row per language, so a file using a real language code would
 * collide with any sibling doing the same. Three lowercase letters satisfy the
 * CHECK and cannot be a real ISO 639-1 pair.
 */
const language = `z${suffix
  .slice(0, 2)
  .split('')
  .map((character) => String.fromCharCode(97 + (Number.parseInt(character, 16) % 20)))
  .join('')}`;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  if (createdEnablements.length > 0) {
    await db
      .delete(searchIntentEnablements)
      .where(inArray(searchIntentEnablements.id, createdEnablements));
  }
  if (createdTurns.length > 0) {
    await db.delete(searchIntentTurns).where(inArray(searchIntentTurns.id, createdTurns));
  }
  if (createdSessions.length > 0) {
    await db.delete(searchIntentSessions).where(inArray(searchIntentSessions.id, createdSessions));
  }
  if (createdRuns.length > 0) {
    await db
      .delete(searchIntentBenchmarkRuns)
      .where(inArray(searchIntentBenchmarkRuns.id, createdRuns));
  }
  await closePostgres();
});

describe('the clarification session', () => {
  it('is found by its OWNER and by nobody else', async () => {
    const session = await createSearchIntentSession(
      { owner: { kind: 'oxy', oxyUserId }, locale: 'es-ES', expiresAt: futureExpiry() },
      db,
    );
    createdSessions.push(session.id);

    const mine = await findOwnedSession(session.id, { kind: 'oxy', oxyUserId }, new Date(), db);
    expect(mine?.id).toBe(session.id);

    // The same id, a different owner. Ownership is a PREDICATE rather than a
    // check the caller remembers, so a foreign session is NOT FOUND rather than
    // found-and-refused.
    const theirs = await findOwnedSession(
      session.id,
      { kind: 'oxy', oxyUserId: `${oxyUserId}_other` },
      new Date(),
      db,
    );
    expect(theirs).toBeUndefined();

    // …and an anonymous caller cannot reach an owned session either, because
    // the anonymous predicate requires BOTH owner columns to be null.
    const anonymous = await findOwnedSession(session.id, { kind: 'anonymous' }, new Date(), db);
    expect(anonymous).toBeUndefined();
  });

  it('is not found once it has expired', async () => {
    const session = await createSearchIntentSession(
      {
        owner: { kind: 'oxy', oxyUserId },
        locale: 'en-GB',
        expiresAt: new Date(Date.now() - 1_000),
      },
      db,
    );
    createdSessions.push(session.id);
    expect(
      await findOwnedSession(session.id, { kind: 'oxy', oxyUserId }, new Date(), db),
    ).toBeUndefined();
  });

  it('refuses an owner that disagrees with the actor kind', async () => {
    // The CHECK, not the repository: an Oxy id on an `anonymous` row would make
    // the ownership predicate answer about the wrong subject.
    await expect(
      db.insert(searchIntentSessions).values({
        actorKind: 'anonymous',
        oxyUserId,
        locale: 'en-GB',
        expiresAt: futureExpiry(),
      }),
    ).rejects.toThrow();
  });

  it('refuses a clarification kind outside the vocabulary', async () => {
    const session = await createSearchIntentSession(
      { owner: { kind: 'anonymous' }, locale: 'en-GB', expiresAt: futureExpiry() },
      db,
    );
    createdSessions.push(session.id);
    await expect(
      db
        .update(searchIntentSessions)
        .set({ askedKinds: ['not_a_real_kind'] })
        .where(eq(searchIntentSessions.id, session.id)),
    ).rejects.toThrow();
  });

  it('UNIONS asked kinds in SQL, so two concurrent rounds cannot lose one', async () => {
    const session = await createSearchIntentSession(
      { owner: { kind: 'anonymous' }, locale: 'en-GB', expiresAt: futureExpiry() },
      db,
    );
    createdSessions.push(session.id);

    // Concurrently, so a read-merge-write would have one overwrite the other's
    // kind — and that kind would then be askable again, which is the repetition
    // the bound exists to prevent.
    await Promise.all([
      recordClarificationRound(session.id, ['budget_basis'], 'clar-budget_basis', db),
      recordClarificationRound(session.id, ['category'], 'clar-category', db),
    ]);

    const [after] = await db
      .select()
      .from(searchIntentSessions)
      .where(eq(searchIntentSessions.id, session.id));
    expect([...(after?.askedKinds ?? [])].sort()).toEqual(['budget_basis', 'category']);
    expect(after?.rounds).toBe(2);
  });
});

describe('the recorded turn', () => {
  const recordTurn = async (
    mode: 'model' | 'deterministic',
    fallbackReason?: 'parser_disabled' | 'provider_timeout',
  ): Promise<void> => {
    await recordSearchIntentTurn(
      {
        mode,
        ...(fallbackReason === undefined ? {} : { fallbackReason }),
        provider: 'deterministic',
        promptVersion: 'sipr-1',
        schemaVersion: 'si-1',
        parserVersion: 'sip-1',
        redactedQuery: `laptop ${suffix}`,
        locale: 'en-GB',
        language,
        hardConstraintCount: 1,
        preferenceCount: 0,
        unresolvedCount: 0,
        clarificationCount: 0,
        latencyMs: 3,
        expiresAt: futureExpiry(),
      },
      db,
    );
  };

  it('refuses a deterministic turn with NO reason', async () => {
    // The biconditional's first half. A deterministic turn carrying no reason
    // leaves a fallback nobody can attribute.
    await expect(recordTurn('deterministic')).rejects.toThrow();
  });

  it('refuses a model turn WITH a reason', async () => {
    // …and its second. A model turn carrying a fallback reason inflates the
    // rate the row exists to compute.
    await expect(recordTurn('model', 'provider_timeout')).rejects.toThrow();
  });

  it('accepts both well-formed shapes and computes a rate over them', async () => {
    await recordTurn('deterministic', 'parser_disabled');
    await recordTurn('deterministic', 'provider_timeout');
    await recordTurn('model');
    const ids = await db
      .select({ id: searchIntentTurns.id })
      .from(searchIntentTurns)
      .where(eq(searchIntentTurns.language, language));
    createdTurns.push(...ids.map((row) => row.id));

    const report = await readFallbackRate(new Date(Date.now() - 60 * 60 * 1_000), db);
    // Scoped by comparing only the reasons this file wrote — a sibling worker
    // may be writing turns of its own, so a global total is never asserted.
    const byReason = new Map(report.reasons.map((entry) => [entry.reason, entry.count]));
    expect(byReason.get('parser_disabled') ?? 0).toBeGreaterThanOrEqual(1);
    expect(byReason.get('provider_timeout') ?? 0).toBeGreaterThanOrEqual(1);
    // The counts are COERCED from postgres.js's `bigint`-as-string. A count
    // returned as a string would make every arithmetic on it string
    // concatenation, which a single aggregation cannot catch.
    expect(typeof report.total).toBe('number');
    expect(report.total).toBeGreaterThanOrEqual(3);
  });
});

describe('the benchmark enablement', () => {
  const runInput = {
    datasetVersion: INTENT_BENCHMARK_DATASET.version,
    datasetDigest: INTENT_BENCHMARK_DATASET.digest,
    caseCount: 10,
    provider: 'deterministic',
    promptVersion: 'sipr-1',
    parserVersion: 'sip-1',
    language,
    schemaValidity: 1,
    categoryAccuracy: 1,
    hardConstraintRecall: 1,
    falseHardConstraintRate: 0,
    clarificationPrecision: 1,
    latencyP95Ms: 4,
    costUnits: 0,
    fallbackRate: 1,
    sampleSize: 10,
    ranByOxyUserId: oxyUserId,
  };

  it('refuses a rate outside [0, 1]', async () => {
    // A "recall" of 1.4 is a computation bug, and storing one would enable a
    // parser against a threshold it never met.
    await expect(
      insertBenchmarkRun({ ...runInput, hardConstraintRecall: 1.4 }, db),
    ).rejects.toThrow();
  });

  it('refuses an enablement citing a run that does not exist', async () => {
    // Acceptance 7 as a CONSTRAINT: there is no INSERT that could enable a pair
    // without naming a real measurement.
    await expect(
      upsertEnablement(
        {
          language,
          enabled: true,
          benchmarkRunId: `run_${suffix}_missing`,
          datasetDigest: INTENT_BENCHMARK_DATASET.digest,
          enabledByOxyUserId: oxyUserId,
          enabledAt: new Date(),
          note: 'should not be possible',
        },
        db,
      ),
    ).rejects.toThrow();
  });

  it('refuses an enablement whose digest disagrees with its run', async () => {
    const run = await insertBenchmarkRun(runInput, db);
    createdRuns.push(run.id);
    // The COMPOSITE key. A run measured against a dataset somebody has since
    // edited carries a different digest, and this is what makes the pair
    // unrepresentable rather than merely discouraged.
    await expect(
      upsertEnablement(
        {
          language,
          enabled: true,
          benchmarkRunId: run.id,
          datasetDigest: 'f'.repeat(64),
          enabledByOxyUserId: oxyUserId,
          enabledAt: new Date(),
          note: 'stale digest',
        },
        db,
      ),
    ).rejects.toThrow();
  });

  it('converges on ONE language-wide row rather than admitting several', async () => {
    // Postgres treats NULLs as DISTINCT, so a plain `unique(category_id,
    // language)` would admit any number of language-wide rows and the service
    // would read whichever it found first. Two partial uniques are what make
    // this an update.
    const run = await insertBenchmarkRun(runInput, db);
    createdRuns.push(run.id);
    const first = await upsertEnablement(
      {
        language,
        enabled: false,
        benchmarkRunId: run.id,
        datasetDigest: run.datasetDigest,
        enabledByOxyUserId: oxyUserId,
        enabledAt: new Date(),
        note: 'first',
      },
      db,
    );
    createdEnablements.push(first.id);
    const second = await upsertEnablement(
      {
        language,
        enabled: true,
        benchmarkRunId: run.id,
        datasetDigest: run.datasetDigest,
        enabledByOxyUserId: oxyUserId,
        enabledAt: new Date(),
        note: 'second',
      },
      db,
    );
    expect(second.id).toBe(first.id);
    expect(second.enabled).toBe(true);

    const rows = await db
      .select({ count: sql<string>`count(*)` })
      .from(searchIntentEnablements)
      .where(eq(searchIntentEnablements.language, language));
    expect(Number(rows[0]?.count ?? 0)).toBe(1);

    const read = await readEnablements(language, undefined, db);
    expect(read.languageRow?.enabled).toBe(true);
  });
});

describe('the deterministic path is the FLOOR', () => {
  it('nothing in this repository registers a model parser', () => {
    // The claim the whole issue rests on, asserted rather than assumed: a
    // provider that had been wired in would make every case below measure a
    // model instead of the fallback.
    expect(hasShoppingIntentParser()).toBe(false);
  });

  it('plans a complete interpretation with no provider configured', async () => {
    const plan = await planShoppingIntent(
      {
        request: { query: 'used laptop under 900 EUR', locale: 'en-GB', market: 'ES' },
      },
      db,
    );
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;

    expect(plan.result.mode).toBe('deterministic');
    // Present EXACTLY when the mode is deterministic — the same biconditional
    // the row carries.
    expect(plan.result.fallbackReason).toBe('provider_unconfigured');
    expect(plan.result.provenance.provider).toBe('deterministic');

    // A real, runnable plan: the condition and the budget both reached #70's
    // filters, and every hard constraint has an enforcement site.
    expect(plan.result.filters.conditionGroups).toEqual(['used']);
    expect(plan.result.filters.price).toEqual({ currency: 'EUR', maxMinor: 90_000 });
    expect(plan.result.enforcement.length).toBeGreaterThan(0);
    expect(plan.result.enforcement.every((entry) => entry.site !== 'unenforceable')).toBe(true);

    // …and a paraphrase composed from the structure, in three voices.
    expect(plan.result.paraphrase.length).toBeGreaterThan(0);
    expect(plan.result.paraphrase.every((line) => line.origin !== 'model_inferred')).toBe(true);
  });

  it('sends a DELIVERED total to the evaluator rather than to the price filter', async () => {
    // The same query one phrase longer, and the opposite enforcement site.
    // #70's price filter compares the OFFER price, so answering "under 900
    // delivered" with it would answer a different question — and this is the
    // fixture that tells the two apart, which the case above cannot.
    const plan = await planShoppingIntent(
      { request: { query: 'used laptop under 900 EUR including shipping', locale: 'en-GB' } },
      db,
    );
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    expect(plan.result.interpretation.budget?.basis).toBe('known_total');
    expect(plan.result.filters.price).toBeUndefined();
    expect(
      plan.result.enforcement.find((entry) => entry.constraintId === 'budget')?.site,
    ).toBe('constraint_evaluation');
  });

  it('answers `parser_disabled` when the shopper asked for plain text search', async () => {
    // #95 client rule 5. It is a deterministic answer like any other and carries
    // a reason like any other — reusing the disabled one rather than growing a
    // member that would inflate the incident metric with a shopper's own
    // preference.
    const plan = await planShoppingIntent(
      { request: { query: 'used laptop', locale: 'en-GB', deterministicOnly: true } },
      db,
    );
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    expect(plan.result.fallbackReason).toBe('parser_disabled');
  });

  it('refuses an empty query rather than searching for nothing', async () => {
    const plan = await planShoppingIntent({ request: { query: '   ', locale: 'en-GB' } }, db);
    expect(plan).toEqual({ status: 'refused', code: 'empty_query', details: [] });
  });

  it('never weakens a filter the shopper selected', async () => {
    // #95 input 6 and acceptance 3 together: the interpretation understood
    // `used`, the shopper had selected `new`, and the SELECTED filter is what
    // survives — they can see it and undo it.
    const plan = await planShoppingIntent(
      {
        request: {
          query: 'segunda mano laptop',
          locale: 'en-GB',
          selectedFilters: { conditionGroups: ['new'] },
        },
      },
      db,
    );
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    expect(plan.result.filters.conditionGroups).toEqual(['new']);
  });
});
