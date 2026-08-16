/**
 * The #431 backfill and the CHECK it has to run before, driven against a REAL
 * server — and driven from the MIGRATION FILES rather than from a second
 * spelling of what they say.
 *
 * ## What can go wrong here, and why it needs a server
 *
 * `0095` (`pre`) adds `referral_events.reward_refusal_reason` and fills it for
 * every historical `reward_accrual_refused` row by parsing the
 * `<code>: <detail>` prose the old writer produced. `0096` (`post`) repeats that
 * fill — catching the rows the previous image appended during the rollout
 * window — and then adds `referral_events_reward_refusal_present_check`, which
 * says every reward refusal NAMES its code.
 *
 * The failure mode is an ORDERING one, and only one direction of it is loud:
 * add the CHECK before the fill and `ALTER TABLE` raises on the first
 * historical row, which is a failed deploy somebody notices. Fill and forget
 * the CHECK and nothing says so — the column is simply NULL wherever nobody set
 * it, and `capRefusalCount` under-reads by exactly that many while still
 * reporting a number. That is #431's own defect returning through a different
 * door, which is why the NEGATIVE CONTROL below carries more weight than the
 * positive one: it proves the CHECK genuinely cannot be added over unfilled
 * rows, so the ordering is load-bearing rather than decorative.
 *
 * ## The statements come out of the files
 *
 * A test that retyped the `UPDATE` would measure the retyped one — the
 * "re-implements the code under test" defect — and it would go on passing after
 * somebody edited the shipped migration. So the statement is EXTRACTED from
 * `drizzle/0095_*.sql` and `drizzle/0096_*.sql`, with a floor on what the
 * extraction found: a short or mismatched read fails rather than going vacuous.
 *
 * ## Why a shadowing TEMP table and not `referral_events` itself
 *
 * The proof needs a table WITHOUT the presence CHECK, and dropping it from the
 * real one would take an ACCESS EXCLUSIVE lock on `referral_events` — twice,
 * with a validating `ADD CONSTRAINT` scan under it — in a database several
 * referral suites write to in parallel. That is the lock convoy this repository
 * has already measured once. PostgreSQL searches `pg_temp` before `public` for
 * an unqualified table name, so a temporary `referral_events` created inside
 * the transaction receives the migration's own unqualified `UPDATE "referral_events"`
 * while nothing shared is touched or locked. The shadow is asserted rather than
 * assumed, and its failure direction is loud: against the real table the legacy
 * inserts below are refused by the very CHECK under test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { REFERRAL_REWARD_REFUSAL_REASONS } from '@mercaria/shared-types';
import {
  closePostgres,
  connectPostgres,
  type Database,
  type DatabaseOrTransaction,
} from '../postgres.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(HERE, '..', '..', '..', 'drizzle');

/** The constraint `0096` adds, spelled exactly as the migration spells it. */
const PRESENT_CHECK_NAME = 'referral_events_reward_refusal_present_check';
const PRESENT_CHECK_BODY =
  "check (action <> 'reward_accrual_refused' or reward_refusal_reason is not null)";

let db: Database;

/** The migration whose name starts with this index, read whole. */
function migrationText(index: string): string {
  const name = readdirSync(DRIZZLE_DIR).find(
    (entry) => entry.startsWith(`${index}_`) && entry.endsWith('.sql'),
  );
  if (name === undefined) throw new Error(`no migration ${index}_*.sql`);
  return readFileSync(join(DRIZZLE_DIR, name), 'utf8');
}

/**
 * The one `UPDATE` statement in a migration.
 *
 * Anchored on `UPDATE "referral_events"` and terminated at the first semicolon,
 * because the file also carries the token the migrator splits on and a
 * line-based read would drag the header prose along with it.
 */
function backfillStatement(text: string): string {
  const match = /UPDATE "referral_events"[\s\S]*?;/.exec(text);
  if (match === null) throw new Error('no backfill UPDATE found');
  return match[0];
}

/** The columns the backfill and the CHECK actually read, and nothing else. */
const SHADOW_TABLE = `create temporary table referral_events (
  id text primary key,
  subject_type text not null,
  subject_id text not null,
  action text not null,
  actor_kind text not null,
  reason text not null,
  reward_refusal_reason text
) on commit drop`;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

describe('#431: the reward-refusal backfill and the CHECK that follows it', () => {
  it('both migrations carry the SAME backfill, and it names the whole tuple', () => {
    const pre = backfillStatement(migrationText('0095'));
    const post = backfillStatement(migrationText('0096'));
    // The floor: an extraction that found a fragment must not let the case
    // below pass by running almost nothing.
    expect(pre.length).toBeGreaterThan(300);
    expect(post).toBe(pre);
    // Every refusal reason has to be recoverable, or the fill is partial in a
    // way only the deploy would report.
    for (const reason of REFERRAL_REWARD_REFUSAL_REASONS) {
      expect(pre).toContain(`'${reason}'`);
    }
    expect(REFERRAL_REWARD_REFUSAL_REASONS.length).toBe(14);
  });

  it('the CHECK cannot be added over unfilled rows, and CAN be after the fill', async () => {
    const backfill = backfillStatement(migrationText('0096'));
    const legacy = [
      { subjectId: 'bf-a-cap', reason: 'cap_reached: no headroom left' },
      { subjectId: 'bf-b-budget', reason: 'budget_exhausted: nothing left' },
      // Not a cap reason: the fill must recover every member of the tuple, not
      // only the two `repeated_cap_attempt` happens to count.
      { subjectId: 'bf-c-zero', reason: 'zero_base: the base was zero' },
    ];

    const seedLegacy = async (tx: DatabaseOrTransaction): Promise<void> => {
      for (const row of legacy) {
        await tx.execute(sql`insert into referral_events
          (id, subject_type, subject_id, action, actor_kind, reason)
          values (${uuidv7()}, 'conversion', ${row.subjectId}, 'reward_accrual_refused',
                  'system', ${row.reason})`);
      }
    };

    // THE NEGATIVE CONTROL, in its own transaction: a failed statement aborts
    // the whole one in PostgreSQL (`25P02`), so the positive proof cannot share
    // it. Both roll back.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(SHADOW_TABLE));
        await seedLegacy(tx);
        // The shadow is real: this row would be refused outright by the
        // production table's own presence CHECK, so reading it back proves the
        // three inserts landed on the temporary table.
        const shadowed = await tx.execute(
          sql`select count(*)::int as total from referral_events where subject_id = 'bf-a-cap'`,
        );
        expect(Number(shadowed[0]?.total)).toBe(1);

        await expect(
          tx.execute(
            sql.raw(
              `alter table referral_events add constraint ${PRESENT_CHECK_NAME} ${PRESENT_CHECK_BODY}`,
            ),
          ),
        ).rejects.toThrow(new RegExp(PRESENT_CHECK_NAME));

        throw new Error('rollback the negative control');
      }),
    ).rejects.toThrow('rollback the negative control');

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(SHADOW_TABLE));
        await seedLegacy(tx);

        // The migration's OWN statement, read off disk and run unmodified.
        await tx.execute(sql.raw(backfill));
        // And the CHECK, which now validates rather than raising.
        await tx.execute(
          sql.raw(
            `alter table referral_events add constraint ${PRESENT_CHECK_NAME} ${PRESENT_CHECK_BODY}`,
          ),
        );

        const rows = await tx.execute(
          sql`select subject_id, reward_refusal_reason from referral_events order by subject_id`,
        );
        expect(rows.map((row) => row.subject_id)).toEqual([
          'bf-a-cap',
          'bf-b-budget',
          'bf-c-zero',
        ]);
        expect(rows.map((row) => row.reward_refusal_reason)).toEqual([
          'cap_reached',
          'budget_exhausted',
          'zero_base',
        ]);

        throw new Error('rollback the ordering proof');
      }),
    ).rejects.toThrow('rollback the ordering proof');
  });
});
