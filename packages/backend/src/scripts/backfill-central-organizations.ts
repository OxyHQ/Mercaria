/** Explicit, resumable source-ID migration. Dry-run is the default; never matches names. */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { OxyServices } from '@oxy.so/core';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDatabase } from '@oxy.so/db';
import * as schema from '../db/schema/index.js';
import {
  organizations,
  organizationAliases,
  organizationIdentityArchives,
} from '../db/schema/organizations.js';
import {
  applyOrganizationBackfill,
  planOrganizationBackfill,
} from '../services/organizations/backfill.js';

const { values } = parseArgs({
  options: {
    'target-database': { type: 'string' },
    'plan-sha256': { type: 'string' },
    'plan-output': { type: 'string' },
    'reviewed-mappings': { type: 'string' },
    'acknowledge-domain-reverification': { type: 'boolean', default: false },
    apply: { type: 'boolean', default: false },
  },
});
const url = process.env.DATABASE_URL;
if (!url || !values['target-database'])
  throw new Error('DATABASE_URL and --target-database are required');
if (decodeURIComponent(new URL(url).pathname.slice(1)) !== values['target-database']) {
  throw new Error('Explicit target database does not match configured database');
}
const reviewedMappingSchema = z.array(
  z.strictObject({
    organizationId: z.string().min(1),
    accountId: z.string().min(1),
    evidenceReference: z.string().trim().min(1),
  }),
);
const reviewedMappings = values['reviewed-mappings']
  ? reviewedMappingSchema.parse(JSON.parse(await readFile(values['reviewed-mappings'], 'utf8')))
  : [];
const { db, client } = createDatabase({ databaseUrl: url, schema, client: { max: 1 } });
try {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    const [identity] = await tx.execute<{ name: string }>(sql`select current_database() as name`);
    if (identity?.name !== values['target-database'])
      throw new Error('Connected to an unexpected database');
    const [references, archives, aliases] = await Promise.all([
      tx.select().from(organizations).orderBy(organizations.id),
      tx.select().from(organizationIdentityArchives),
      tx.select().from(organizationAliases).orderBy(organizationAliases.id),
    ]);
    const archiveById = new Map(archives.map((row) => [row.organizationId, row]));
    const aliasesById = new Map<string, typeof aliases>();
    for (const row of aliases)
      aliasesById.set(row.organizationId, [...(aliasesById.get(row.organizationId) ?? []), row]);
    return references.map((row) => ({
      ...row,
      archive: archiveById.get(row.id) ?? null,
      aliases: aliasesById.get(row.id) ?? [],
    }));
  });
  const plan = planOrganizationBackfill(rows, reviewedMappings);
  if (values['plan-output']) {
    await writeFile(
      values['plan-output'],
      JSON.stringify(
        {
          database: values['target-database'],
          sha256: plan.sha256,
          reviewedMappings,
          groups: plan.groups,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
  }
  console.log(
    JSON.stringify(
      {
        mode: values.apply ? 'apply' : 'dry-run',
        database: values['target-database'],
        sha256: plan.sha256,
        references: rows.length,
        companies: plan.groups.length,
        mapped: rows.filter((row) => row.oxyAccountId).length,
        reviewedMappings: reviewedMappings.length,
        domainReverificationRequired: rows.flatMap((row) =>
          row.archive?.verifiedDomains.length
            ? [{ organizationId: row.id, domains: row.archive.verifiedDomains }]
            : [],
        ),
        nonactiveCompanies: plan.groups
          .filter((group) => group.winner.status !== 'active')
          .map((group) => group.winner.id),
      },
      null,
      2,
    ),
  );
  if (values.apply) {
    if (!values['plan-sha256'])
      throw new Error('Apply requires --plan-sha256 from the reviewed dry-run');
    if (rows.length && !process.env.OXY_ADMIN_ACCESS_TOKEN)
      throw new Error('OXY_ADMIN_ACCESS_TOKEN is required for nonempty migrations');
    const directory = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
    if (process.env.OXY_ADMIN_ACCESS_TOKEN)
      directory.http.setTokens(process.env.OXY_ADMIN_ACCESS_TOKEN);
    const mappings = await applyOrganizationBackfill({
      rows,
      reviewedMappings,
      acknowledgeDomainReverification: values['acknowledge-domain-reverification'],
      expectedPlanSha256: values['plan-sha256'],
      directory: directory.organizations,
      saveMappings: async (items) =>
        db.transaction(async (tx) => {
          for (const item of items) {
            const updated = await tx
              .update(organizations)
              .set({ oxyAccountId: item.accountId })
              .where(
                and(
                  eq(organizations.id, item.organizationId),
                  or(
                    isNull(organizations.oxyAccountId),
                    eq(organizations.oxyAccountId, item.accountId),
                  ),
                ),
              )
              .returning({ id: organizations.id });
            if (updated.length !== 1)
              throw new Error(
                `Mapping changed for ${item.organizationId}; no local mappings applied`,
              );
          }
        }),
    });
    console.log(
      JSON.stringify({ appliedMappings: mappings.length, database: values['target-database'] }),
    );
  }
} finally {
  await client.end();
}
