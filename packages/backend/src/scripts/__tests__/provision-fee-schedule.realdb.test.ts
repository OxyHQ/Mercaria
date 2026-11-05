/**
 * `provision-fee-schedule.ts` against a REAL, empty database, driven exactly as
 * `publish-fee-schedules.yml` drives it: preview writes nothing, `--apply`
 * drafts the reviewed catalogue once, and `--activate` refuses while a
 * payment-ready seller the schedule reaches has not accepted it.
 *
 * ## Its OWN throwaway database, because the activation guard is a census
 *
 * "Which payment-ready sellers have not accepted this version" is a question
 * about every `provider_accounts` row in the database. In the shared suite
 * database any sibling file's ready seller would answer it, so the refusal and
 * the success below would depend on what ran beside them.
 *
 * Driven as a SUBPROCESS: the script runs `main()` when it is the entry point,
 * against whatever `DATABASE_URL` it is given, and the exit code is part of what
 * an operator observes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@oxy.so/db';
import type postgres from 'postgres';
import * as schema from '../../db/schema/index.js';
import type { Database } from '../../db/postgres.js';
import { createMercariaTestDatabase, dropMercariaTestDatabase } from '../../db/testDatabase.js';
import {
  insertFeeScheduleAcceptance,
  listFeeSchedules,
} from '../../db/fees/feeScheduleRepository.js';
import {
  applyProviderAccountState,
  insertProviderAccount,
} from '../../db/payments/providerAccountRepository.js';
import { FEE_SCHEDULE_CATALOG } from '../../services/fees/catalog.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(PACKAGE_ROOT, 'src', 'scripts', 'provision-fee-schedule.ts');
const ADMIN_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';
const REF = 'a'.repeat(40);

let databaseUrl: string;
let client: postgres.Sql;
let db: Database;

async function run(...args: string[]): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', SCRIPT, ...args], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, text }));
  });
}

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabase(ADMIN_URL);
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 2, onnotice: () => undefined },
  });
  client = instance.client;
  db = instance.db;
}, 300_000);

afterAll(async () => {
  await client.end({ timeout: 5 });
  await dropMercariaTestDatabase(databaseUrl);
});

describe('provision-fee-schedule', () => {
  it('refuses a reference that is not a full commit id', async () => {
    const result = await run('--ref=main');
    expect(result.code).not.toBe(0);
    expect(await listFeeSchedules(db)).toEqual([]);
  }, 120_000);

  it('previews by default and writes nothing', async () => {
    const result = await run(`--ref=${REF}`);
    expect(result.code, result.text).toBe(0);
    expect(await listFeeSchedules(db)).toEqual([]);
  }, 120_000);

  it('drafts the catalogue once, authored by the commit, and a re-run changes nothing', async () => {
    expect(FEE_SCHEDULE_CATALOG.length).toBeGreaterThan(0);
    const first = await run('--apply', `--ref=${REF}`);
    expect(first.code, first.text).toBe(0);
    const drafted = await listFeeSchedules(db);
    expect(drafted).toHaveLength(FEE_SCHEDULE_CATALOG.length);
    for (const row of drafted) {
      expect(row.status).toBe('draft');
      expect(row.draftedByAuthority).toBe('deployment');
      expect(row.draftedByRef).toBe(REF);
    }

    const second = await run('--apply', `--ref=${'b'.repeat(40)}`);
    expect(second.code, second.text).toBe(0);
    expect(await listFeeSchedules(db)).toEqual(drafted);
  }, 240_000);

  it('refuses to activate while a ready seller it reaches has not accepted, then activates', async () => {
    const [definition] = FEE_SCHEDULE_CATALOG;
    if (!definition) throw new Error('the catalogue is empty');
    const ownerType = definition.eligibleSellerType === 'user' ? 'user' : 'store';
    const ownerId = `seller-${String(Date.now())}`;
    const account = await insertProviderAccount(db, {
      provider: 'peable',
      ownerType,
      ownerId,
      providerAccountId: `acct_${ownerId}`,
      country: 'US',
    });
    await applyProviderAccountState(db, {
      id: account.id,
      state: {
        onboardingState: 'ready',
        chargesEnabled: true,
        payoutsEnabled: true,
        transfersCapability: 'active',
        requirementsCurrentlyDue: 0,
        requirementsEventuallyDue: 0,
        requirementsPastDue: 0,
        requirementsPendingVerification: 0,
        disabledReasonCodes: [],
        syncedAt: new Date(),
      },
    });

    const refused = await run('--activate', `--ref=${REF}`);
    expect(refused.code).not.toBe(0);
    expect(refused.text).toContain('have not accepted it');
    expect((await listFeeSchedules(db)).map((row) => row.status)).toEqual(
      FEE_SCHEDULE_CATALOG.map(() => 'draft'),
    );

    for (const entry of FEE_SCHEDULE_CATALOG) {
      await insertFeeScheduleAcceptance(db, {
        scheduleKey: entry.scheduleKey,
        scheduleVersion: entry.version,
        termsVersion: entry.termsVersion,
        ownerType,
        ownerId,
        acceptedByOxyUserId: 'owner-1',
      });
    }

    const activated = await run('--activate', `--ref=${REF}`);
    expect(activated.code, activated.text).toBe(0);
    for (const row of await listFeeSchedules(db)) {
      expect(row.status).toBe('active');
      expect(row.approvedByAuthority).toBe('deployment');
      expect(row.approvedByRef).toBe(REF);
    }

    // Activating again is a no-op, not an error.
    const again = await run('--activate', `--ref=${REF}`);
    expect(again.code, again.text).toBe(0);
  }, 300_000);
});
