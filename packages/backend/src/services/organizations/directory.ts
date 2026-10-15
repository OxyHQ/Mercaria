/** Company facts come exclusively from Oxy; Mercaria retains commerce references. */
import type { Organization } from '@mercaria/shared-types';
import type { Organization as OxyOrganization } from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findOrganizationById,
  findOrganizationBySlug,
  findOrganizationsByIds,
} from '../../db/canonical/organizationRepository.js';
import { oxyClient } from '../../middleware/auth.js';
import { conflict, serviceUnavailable } from '../../lib/errors/error-codes.js';

/** Batch both the local references and canonical identities, never one request per company. */
export async function getPublicOrganizations(
  ids: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, Organization>> {
  const unique = [...new Set(ids)];
  const output = new Map<string, Organization>();
  const rows = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    rows.push(...(await findOrganizationsByIds(db, unique.slice(offset, offset + 100))));
  }
  const accountIds = [...new Set(rows.map((row) => row.oxyAccountId))];
  if (accountIds.some((id) => !id)) {
    throw serviceUnavailable('Company identity migration is not complete.');
  }
  const identities = new Map<string, OxyOrganization>();
  for (let offset = 0; offset < accountIds.length; offset += 100) {
    try {
      const result = await oxyClient.organizations.batch({
        ids: accountIds.slice(offset, offset + 100),
      });
      for (const item of result.items) identities.set(item.requestedAccountId, item.organization);
    } catch {
      throw serviceUnavailable('The company directory is unavailable.');
    }
  }
  for (const row of rows) {
    const identity = identities.get(row.oxyAccountId);
    if (!identity || identity.status === 'suppressed' || row.status === 'suppressed') continue;
    output.set(row.id, {
      id: row.id,
      oxyAccountId: identity.accountId,
      slug: row.slug,
      status: row.status === 'merged' || row.status === 'inactive' ? row.status : identity.status,
      name: identity.name,
      ...(identity.legalName ? { legalName: identity.legalName } : {}),
      ...(identity.websiteUrl ? { websiteUrl: identity.websiteUrl } : {}),
      verifiedDomains: identity.verifiedDomains,
      ...(identity.countryCode ? { countryCode: identity.countryCode } : {}),
      ...(identity.avatar ? { logoFileId: identity.avatar } : {}),
      aliases: identity.aliases,
      ...(row.mergedIntoId ? { mergedIntoId: row.mergedIntoId } : {}),
      firstSeenAt: row.firstSeenAt.toISOString(),
      ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt.toISOString() } : {}),
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
    });
  }
  return output;
}

/** Historical URLs stay valid while the content is fetched from its single owner. */
export async function getPublicOrganization(idOrSlug: string): Promise<Organization | undefined> {
  const db = getDb();
  const row =
    (await findOrganizationById(db, idOrSlug)) ?? (await findOrganizationBySlug(db, idOrSlug));
  if (!row) return undefined;
  return (await getPublicOrganizations([row.id], db)).get(row.id);
}

/** A commerce merge may only consolidate references Oxy already resolves to the same company. */
export async function assertSameCanonicalOrganization(
  loserId: string,
  winnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const companies = await getPublicOrganizations([loserId, winnerId], db);
  const loser = companies.get(loserId);
  const winner = companies.get(winnerId);
  if (!loser || !winner || loser.oxyAccountId !== winner.oxyAccountId) {
    throw conflict('Merge company identity in Oxy before consolidating Mercaria references.');
  }
}
