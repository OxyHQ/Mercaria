/**
 * Reads and writes for `storefronts` and `storefront_aliases`.
 *
 * The load-bearing write is {@link upsertStorefrontFromSource}: ADR 0002 D22's
 * deterministic-convergence rule applied to this table's natural key,
 * `(provider, external_shop_id)` among non-merged rows. A re-delivered or
 * re-run source observation converges on the existing row in ONE statement —
 * two concurrent first observations race the insert and the loser's
 * `ON CONFLICT` lands as the update, so neither caller has to know the other
 * exists and no duplicate channel is ever minted.
 */

import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { CanonicalAliasKind, StorefrontChannelKind } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { storefrontAliases, storefronts } from '../schema/merchants.js';

/** A storefront row as the services read it back. */
export type StorefrontRow = typeof storefronts.$inferSelect;
/** An alias row for a storefront. */
export type StorefrontAliasRow = typeof storefrontAliases.$inferSelect;

/** What a direct (non-source) create supplies. */
export interface CreateStorefrontInput {
  merchantId: string;
  name: string;
  slug: string;
  channelKind: StorefrontChannelKind;
  provider?: string;
  domain?: string;
  externalShopId?: string;
  country?: string;
  languages?: string[];
  currency?: string;
  publicUrl?: string;
  affiliateCapable?: boolean;
  firstSeenAt: Date;
}

/** The observation fields a source sighting may refresh. */
export interface StorefrontObservation {
  name: string;
  domain?: string;
  country?: string;
  languages?: string[];
  currency?: string;
  publicUrl?: string;
  affiliateCapable?: boolean;
  observedAt: Date;
}

export async function insertStorefront(
  db: DatabaseOrTransaction,
  input: CreateStorefrontInput,
): Promise<StorefrontRow> {
  const [row] = await db
    .insert(storefronts)
    .values({
      merchantId: input.merchantId,
      name: input.name,
      slug: input.slug,
      channelKind: input.channelKind,
      provider: input.provider ?? null,
      domain: input.domain ?? null,
      externalShopId: input.externalShopId ?? null,
      country: input.country ?? null,
      languages: input.languages ?? null,
      currency: input.currency ?? null,
      publicUrl: input.publicUrl ?? null,
      affiliateCapable: input.affiliateCapable ?? false,
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.firstSeenAt,
    })
    .returning();
  if (!row) {
    throw new Error('Inserting a storefront returned no row.');
  }
  return row;
}

/**
 * Converge a source observation on the `(provider, external_shop_id)` key.
 *
 * The conflict target's WHERE clause repeats the partial unique index's
 * predicate verbatim (`storefronts_provider_external_shop_id_key`), which is
 * what lets Postgres infer the arbiter index. The update deliberately touches
 * only OBSERVATION fields: never `slug` (identity, minted once), never
 * `status` (an operator's suppression must survive a re-observation), never
 * `merchant_id` (re-attributing a channel is a review decision, not an
 * ingestion side effect), and never any field named in `pinned_fields` — the
 * caller filters those before building the observation.
 */
export async function upsertStorefrontFromSource(
  db: DatabaseOrTransaction,
  input: {
    merchantId: string;
    provider: string;
    externalShopId: string;
    slug: string;
    channelKind: StorefrontChannelKind;
    observation: StorefrontObservation;
  },
): Promise<StorefrontRow> {
  const { observation } = input;
  const [row] = await db
    .insert(storefronts)
    .values({
      merchantId: input.merchantId,
      name: observation.name,
      slug: input.slug,
      channelKind: input.channelKind,
      provider: input.provider,
      externalShopId: input.externalShopId,
      domain: observation.domain ?? null,
      country: observation.country ?? null,
      languages: observation.languages ?? null,
      currency: observation.currency ?? null,
      publicUrl: observation.publicUrl ?? null,
      affiliateCapable: observation.affiliateCapable ?? false,
      firstSeenAt: observation.observedAt,
      lastSeenAt: observation.observedAt,
    })
    .onConflictDoUpdate({
      target: [storefronts.provider, storefronts.externalShopId],
      targetWhere: sql`${storefronts.provider} is not null and ${storefronts.externalShopId} is not null and ${storefronts.status} <> 'merged'`,
      set: {
        name: observation.name,
        domain: observation.domain ?? null,
        country: observation.country ?? null,
        languages: observation.languages ?? null,
        currency: observation.currency ?? null,
        publicUrl: observation.publicUrl ?? null,
        affiliateCapable: observation.affiliateCapable ?? false,
        lastSeenAt: observation.observedAt,
      },
    })
    .returning();
  if (!row) {
    throw new Error('Upserting a storefront from a source observation returned no row.');
  }
  return row;
}

export async function findStorefrontById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<StorefrontRow | undefined> {
  const [row] = await db.select().from(storefronts).where(eq(storefronts.id, id));
  return row;
}

export async function findStorefrontBySlug(
  db: DatabaseOrTransaction,
  slug: string,
): Promise<StorefrontRow | undefined> {
  const [row] = await db.select().from(storefronts).where(eq(storefronts.slug, slug));
  return row;
}

/** For `ensureUniqueSlug`. */
export async function storefrontSlugExists(
  db: DatabaseOrTransaction,
  slug: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: storefronts.id })
    .from(storefronts)
    .where(eq(storefronts.slug, slug));
  return row !== undefined;
}

/**
 * The one non-merged storefront a source shop id resolves to — the read side
 * of the convergence key, so at most one row can match by construction.
 */
export async function findStorefrontBySource(
  db: DatabaseOrTransaction,
  provider: string,
  externalShopId: string,
): Promise<StorefrontRow | undefined> {
  const [row] = await db
    .select()
    .from(storefronts)
    .where(
      and(
        eq(storefronts.provider, provider),
        eq(storefronts.externalShopId, externalShopId),
        ne(storefronts.status, 'merged'),
      ),
    );
  return row;
}

/** Every storefront addressed at a domain (several country sites may share one). */
export async function findStorefrontsByDomain(
  db: DatabaseOrTransaction,
  domain: string,
): Promise<StorefrontRow[]> {
  return db
    .select()
    .from(storefronts)
    .where(and(eq(storefronts.domain, domain), isNotNull(storefronts.domain)));
}

export async function findStorefrontsByMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<StorefrontRow[]> {
  return db.select().from(storefronts).where(eq(storefronts.merchantId, merchantId));
}

/** Same convergence contract as `insertMerchantAlias`. */
export async function insertStorefrontAlias(
  db: DatabaseOrTransaction,
  input: {
    storefrontId: string;
    alias: string;
    kind: CanonicalAliasKind;
    language?: string;
    createdByOxyUserId?: string;
  },
): Promise<StorefrontAliasRow | undefined> {
  const [row] = await db
    .insert(storefrontAliases)
    .values({
      storefrontId: input.storefrontId,
      alias: input.alias,
      kind: input.kind,
      language: input.language ?? null,
      createdByOxyUserId: input.createdByOxyUserId ?? null,
    })
    .onConflictDoNothing({
      target: [storefrontAliases.storefrontId, storefrontAliases.normalizedAlias],
    })
    .returning();
  return row;
}
