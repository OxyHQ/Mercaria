import { createHash } from 'node:crypto';
import type { OxyServices } from '@oxy.so/core';
import type {
  organizationAliases,
  organizationIdentityArchives,
  organizations,
} from '../../db/schema/organizations.js';

type Reference = Omit<typeof organizations.$inferSelect, 'oxyAccountId'> & {
  oxyAccountId: string | null;
};
type Archive = typeof organizationIdentityArchives.$inferSelect;
type Alias = typeof organizationAliases.$inferSelect;
export type OrganizationMigrationRow = Reference & { archive: Archive | null; aliases: Alias[] };
export type ReviewedOrganizationMapping = {
  organizationId: string;
  accountId: string;
  evidenceReference: string;
};

export function planOrganizationBackfill(
  rows: OrganizationMigrationRow[],
  reviewedMappings: ReviewedOrganizationMapping[] = [],
) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const groups = new Map<string, OrganizationMigrationRow[]>();
  for (const row of rows) {
    let winner = row;
    const seen = new Set<string>();
    while (winner.mergedIntoId) {
      if (seen.has(winner.id)) throw new Error(`Organization redirect cycle at ${winner.id}`);
      seen.add(winner.id);
      const next = byId.get(winner.mergedIntoId);
      if (!next) throw new Error(`Missing organization redirect target for ${winner.id}`);
      winner = next;
    }
    if (!winner.archive && !winner.oxyAccountId) {
      throw new Error(
        `Organization ${winner.id} has neither migration evidence nor a canonical identity`,
      );
    }
    groups.set(winner.id, [...(groups.get(winner.id) ?? []), row]);
  }
  const plan = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([winnerId, members]) => {
      const winner = byId.get(winnerId);
      if (!winner) throw new Error('Missing migration group winner');
      return { winner, members: members.sort((a, b) => a.id.localeCompare(b.id)) };
    });
  return {
    groups: plan,
    sha256: createHash('sha256')
      .update(
        JSON.stringify({
          groups: plan,
          reviewedMappings: [...reviewedMappings].sort((a, b) =>
            a.organizationId.localeCompare(b.organizationId),
          ),
        }),
      )
      .digest('hex'),
  };
}

/** Source IDs, reviewed mappings and historical redirects are evidence; equal names never are. */
export async function applyOrganizationBackfill(input: {
  rows: OrganizationMigrationRow[];
  expectedPlanSha256: string;
  reviewedMappings: ReviewedOrganizationMapping[];
  directory: Pick<OxyServices['organizations'], 'importExternal'>;
  acknowledgeDomainReverification?: boolean;
  saveMappings: (mappings: { organizationId: string; accountId: string }[]) => Promise<void>;
}) {
  const plan = planOrganizationBackfill(input.rows, input.reviewedMappings);
  if (plan.sha256 !== input.expectedPlanSha256)
    throw new Error('Migration plan changed; run dry-run again');
  const overrides = new Map<string, ReviewedOrganizationMapping>();
  for (const mapping of input.reviewedMappings) {
    if (!mapping.evidenceReference.trim()) throw new Error('A reviewed mapping requires evidence');
    if (overrides.has(mapping.organizationId))
      throw new Error('Duplicate reviewed organization mapping');
    overrides.set(mapping.organizationId, mapping);
  }
  for (const id of overrides.keys()) {
    if (!input.rows.some((row) => row.id === id))
      throw new Error(`Reviewed mapping names unknown organization ${id}`);
  }
  if (
    !input.acknowledgeDomainReverification &&
    input.rows.some((row) => row.archive?.verifiedDomains.length)
  ) {
    throw new Error(
      'Legacy verified domains require explicit acknowledgment: Oxy must verify domain ownership again',
    );
  }
  for (const group of plan.groups) {
    const known = new Set(
      group.members.flatMap((row) =>
        [row.oxyAccountId, overrides.get(row.id)?.accountId].filter(Boolean),
      ),
    );
    if (known.size > 1)
      throw new Error(`Conflicting company mappings for ${group.winner.id}; review in Oxy first`);
    if (group.winner.status !== 'active' && known.size === 0) {
      throw new Error(
        `Nonactive company ${group.winner.id} requires a reviewed canonical mapping; migration cannot publish it`,
      );
    }
  }
  const results: { organizationId: string; accountId: string }[] = [];
  for (const group of plan.groups) {
    const known = new Set(
      group.members.flatMap((row) => {
        const reviewed = overrides.get(row.id);
        return [
          ...(row.oxyAccountId ? [row.oxyAccountId] : []),
          ...(reviewed ? [reviewed.accountId] : []),
        ];
      }),
    );
    if (known.size > 1)
      throw new Error(`Conflicting company mappings for ${group.winner.id}; review in Oxy first`);
    let accountId = [...known][0];
    const archive = group.winner.archive;
    if (!archive) {
      if (!accountId) throw new Error('Missing company archive');
      results.push(...group.members.map((row) => ({ organizationId: row.id, accountId })));
      continue;
    }
    const aliases = new Map<string, { alias: string; kind: Alias['kind']; language?: string }>();
    for (const member of group.members) {
      if (member.archive && member.id !== group.winner.id) {
        aliases.set(member.archive.name, { alias: member.archive.name, kind: 'former_name' });
      }
      for (const alias of member.aliases)
        aliases.set(`${alias.kind}:${alias.language ?? ''}:${alias.alias}`, {
          alias: alias.alias,
          kind: alias.kind,
          ...(alias.language ? { language: alias.language } : {}),
        });
    }
    if (aliases.size > 100)
      throw new Error(
        `Organization ${group.winner.id} exceeds Oxy's alias limit; review before migration`,
      );
    const organization = {
      name: archive.name,
      organizationType: 'business' as const,
      legalName: archive.legalName,
      websiteUrl: archive.websiteUrl,
      countryCode: archive.countryCode,
      aliases: [...aliases.values()],
    };
    // The canonical external namespace is idempotent even if a process stops before the local transaction.
    for (const member of [
      group.winner,
      ...group.members.filter((row) => row.id !== group.winner.id),
    ]) {
      const linked = await input.directory.importExternal({
        namespace: 'mercaria',
        externalId: member.id,
        evidenceReference:
          overrides.get(member.id)?.evidenceReference ??
          `mercaria:organization_identity_archives:${member.archive?.id ?? group.winner.archive?.id}`,
        ...(archive.logoFileId ? { avatarFileId: archive.logoFileId } : {}),
        ...(accountId ? { accountId } : {}),
        organization,
      });
      if (accountId && accountId !== linked.accountId)
        throw new Error(`Oxy mapping conflict for ${member.id}`);
      accountId = linked.accountId;
      results.push({ organizationId: member.id, accountId });
    }
  }
  await input.saveMappings(results);
  return results;
}
