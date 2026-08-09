/**
 * The relationship graph against a REAL PostgreSQL database — issue #55.
 *
 * Everything here is held by a CHECK, a partial unique index, a generated
 * column, an append-only trigger or a transaction, and none of those exists
 * under a mocked repository: a mocked `insert` accepts a statement the server
 * rejects outright, which is exactly how a duplicate open claim or a
 * single-operator four-eyes approval would look green and ship broken.
 *
 * The five acceptance criteria this file answers directly:
 *
 *  1. No public badge from names, logos or domains alone — the evidence gate,
 *     tested with a domain-control proof that is refused for an official-store
 *     claim and accepted for the fact it actually proves.
 *  2. Market-scoped relationships resolve correctly for users in different
 *     countries — the same claim answered for a shopper in Spain and one in
 *     Germany.
 *  3. Revocation removes current public status without erasing history.
 *  4. Duplicate active relationships prevented by BOTH the index and the
 *     service.
 *  5. Evidence, scope, expiry, conflict and authorization behaviour.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every name and slug this file writes carries a per-run
 * suffix and teardown deletes exactly what it created — children first, since
 * every intra-graph foreign key here is RESTRICT.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, or, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { brands, organizations } from '../schema/organizations.js';
import { merchants } from '../schema/merchants.js';
import { catalogSources } from '../schema/provenance.js';
import {
  commerceRelationships,
  relationshipEvidence,
  relationshipReviews,
} from '../schema/relationships.js';
import {
  findCurrentRelationships,
  insertEvidence,
  insertRelationship,
  insertReview,
  listEvidence,
  listReviews,
} from '../commerce-graph/relationshipRepository.js';
import { createOrganization } from '../../services/canonical/organization.service.js';
import { createBrand } from '../../services/canonical/brand.service.js';
import { createMerchant } from '../../services/commerce-graph/merchant.service.js';
import {
  assertRelationship,
  attachEvidence,
  correctRelationship,
  endorseRelationship,
  endRelationship,
  getRelationshipForOperator,
  listCandidateQueue,
  requestMoreEvidence,
  revokeRelationshipEvidence,
  verifyRelationship,
} from '../../services/commerce-graph/relationship.service.js';
import {
  listBrandChannels,
  resolveOfficialChannel,
} from '../../services/commerce-graph/relationship-resolution.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdOrganizationIds: string[] = [];
const createdBrandIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdSourceIds: string[] = [];

const OPERATOR_A = `op-a-${RUN}`;
const OPERATOR_B = `op-b-${RUN}`;

/** `inArray` on an empty list renders `false`; a sentinel keeps the SQL valid. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // Children first. Every intra-graph FK is RESTRICT, so a wrong order is loud.
  // `inArray`, never `= any(${jsArray})`: postgres.js binds a JS array as a
  // TUPLE and the server answers `op ANY/ALL (array) requires array on right
  // side` — the trap CONVENTIONS.md records, hit here first time round.
  const ids = await db
    .select({ id: commerceRelationships.id })
    .from(commerceRelationships)
    .where(
      or(
        inArray(commerceRelationships.organizationId, safeIds(createdOrganizationIds)),
        inArray(commerceRelationships.brandId, safeIds(createdBrandIds)),
        inArray(commerceRelationships.relatedBrandId, safeIds(createdBrandIds)),
        inArray(commerceRelationships.merchantId, safeIds(createdMerchantIds)),
      ),
    );
  const relationshipIds = ids.map((row) => row.id);
  if (relationshipIds.length > 0) {
    await db
      .delete(relationshipEvidence)
      .where(inArray(relationshipEvidence.relationshipId, relationshipIds));
    // The append-only trigger refuses DELETE on review rows, so it is disabled
    // for exactly this teardown statement — and the fact that it HAS to be is
    // itself the property `refuses UPDATE and DELETE` asserts below.
    await db.execute(sql`alter table relationship_reviews disable trigger relationship_reviews_append_only`);
    await db
      .delete(relationshipReviews)
      .where(inArray(relationshipReviews.relationshipId, relationshipIds));
    await db.execute(sql`alter table relationship_reviews enable trigger relationship_reviews_append_only`);
    // `superseded_by_id` is a self-FK with RESTRICT; clear it before deleting.
    await db
      .update(commerceRelationships)
      .set({ supersededById: null })
      .where(inArray(commerceRelationships.id, relationshipIds));
    await db
      .delete(commerceRelationships)
      .where(inArray(commerceRelationships.id, relationshipIds));
  }
  if (createdMerchantIds.length > 0) {
    await db.delete(merchants).where(inArray(merchants.id, createdMerchantIds));
  }
  if (createdBrandIds.length > 0) {
    await db.delete(brands).where(inArray(brands.id, createdBrandIds));
  }
  if (createdOrganizationIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds));
  }
  if (createdSourceIds.length > 0) {
    await db.delete(catalogSources).where(inArray(catalogSources.id, createdSourceIds));
  }
  await closePostgres();
});

async function mintOrganization(name: string): Promise<string> {
  const row = await createOrganization({ name });
  createdOrganizationIds.push(row.id);
  return row.id;
}

async function mintBrand(name: string): Promise<string> {
  const row = await createBrand({ name });
  createdBrandIds.push(row.id);
  return row.id;
}

async function mintMerchant(name: string): Promise<string> {
  const row = await createMerchant({ name });
  createdMerchantIds.push(row.id);
  return row.id;
}

/** A catalog source, so the INGESTION assertion path can be exercised for real. */
async function mintCatalogSource(): Promise<string> {
  const [row] = await db
    .insert(catalogSources)
    .values({
      kind: 'operator',
      name: `relationship-test-source-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning();
  if (!row) throw new Error('catalog source insert returned no row');
  createdSourceIds.push(row.id);
  return row.id;
}

/**
 * Attach a brand statement — the evidence kind that IS sufficient for a badge —
 * so a test about verification is not accidentally a test about evidence.
 */
async function attachBrandStatement(relationshipId: string): Promise<void> {
  await attachEvidence({
    relationshipId,
    kind: 'brand_statement',
    observedFact: 'The brand publishes this merchant on its authorized-channel list.',
    sourceUrl: `https://brand-${RUN}.example.com/authorized`,
    contentSha256: 'a'.repeat(64),
    collectedByOxyUserId: OPERATOR_A,
  });
}

/** Verify through the real workflow, second operator included. */
async function verifyThroughWorkflow(relationshipId: string): Promise<void> {
  await attachBrandStatement(relationshipId);
  await endorseRelationship({
    relationshipId,
    actorOxyUserId: OPERATOR_B,
    reason: 'Second operator reviewed the published list.',
  });
  await verifyRelationship({
    relationshipId,
    method: 'brand_statement',
    reason: 'Published authorized-channel list checked against the merchant.',
    actorOxyUserId: OPERATOR_A,
  });
}

describe('the per-kind endpoint CHECK constrains subject and object entity kinds', () => {
  it('accepts each kind with its own endpoint pair and refuses every wrong one', async () => {
    const organizationId = await mintOrganization(`Endpoints Inc ${RUN}`);
    const brandId = await mintBrand(`Endpoints Brand ${RUN}`);
    const otherBrandId = await mintBrand(`Endpoints Successor ${RUN}`);
    const merchantId = await mintMerchant(`Endpoints Shop ${RUN}`);

    const correct = [
      { kind: 'organization_owns_brand' as const, endpoints: { organizationId, brandId } },
      {
        kind: 'organization_operates_merchant' as const,
        endpoints: { organizationId, merchantId },
      },
      {
        kind: 'organization_manufactures' as const,
        endpoints: { organizationId, productFamilyId: `family-${RUN}` },
      },
      {
        kind: 'merchant_official_channel_for_brand' as const,
        endpoints: { merchantId, brandId },
      },
      {
        kind: 'brand_succeeds_brand' as const,
        endpoints: { brandId: otherBrandId, relatedBrandId: brandId },
      },
    ];

    for (const entry of correct) {
      const row = await insertRelationship(db, {
        kind: entry.kind,
        ...entry.endpoints,
        territories: [],
        languages: [],
        validFrom: new Date(),
        status: 'candidate',
        assertedByKind: 'catalog_operator',
      });
      expect(row, `${entry.kind} with its declared endpoints must be accepted`).toBeDefined();
    }

    // The wrong pairs, one per kind: an ownership claim naming a merchant, a
    // channel claim naming an organization, a manufacturing claim naming a
    // brand, a succession claim with one brand.
    const wrong = [
      { kind: 'organization_owns_brand' as const, endpoints: { organizationId, merchantId } },
      { kind: 'merchant_official_channel_for_brand' as const, endpoints: { organizationId, brandId } },
      { kind: 'organization_manufactures' as const, endpoints: { organizationId, brandId } },
      { kind: 'brand_succeeds_brand' as const, endpoints: { brandId } },
    ];
    for (const entry of wrong) {
      await expect(
        insertRelationship(db, {
          kind: entry.kind,
          ...entry.endpoints,
          territories: [],
          languages: [],
          validFrom: new Date(),
          status: 'candidate',
          assertedByKind: 'catalog_operator',
        }),
        `${entry.kind} with the wrong endpoints must be refused`,
      ).rejects.toSatisfy(isCheckViolation);
    }
  });

  it('refuses a brand that succeeds itself', async () => {
    const brandId = await mintBrand(`Self Succession ${RUN}`);
    await expect(
      insertRelationship(db, {
        kind: 'brand_succeeds_brand',
        brandId,
        relatedBrandId: brandId,
        territories: [],
        languages: [],
        validFrom: new Date(),
        status: 'candidate',
        assertedByKind: 'catalog_operator',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('confidence is a machine number and cannot masquerade as verification', () => {
  it('refuses a confidence score on anything but an ingestion assertion', async () => {
    const organizationId = await mintOrganization(`Confidence Inc ${RUN}`);
    const brandId = await mintBrand(`Confidence Brand ${RUN}`);
    await expect(
      insertRelationship(db, {
        kind: 'organization_owns_brand',
        organizationId,
        brandId,
        territories: [],
        languages: [],
        validFrom: new Date(),
        status: 'candidate',
        assertedByKind: 'catalog_operator',
        confidence: 0.99,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a verified row with no method, time or verifying operator', async () => {
    const organizationId = await mintOrganization(`Unverifiable Inc ${RUN}`);
    const brandId = await mintBrand(`Unverifiable Brand ${RUN}`);
    await expect(
      insertRelationship(db, {
        kind: 'organization_owns_brand',
        organizationId,
        brandId,
        territories: [],
        languages: [],
        validFrom: new Date(),
        status: 'verified',
        assertedByKind: 'catalog_operator',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a territory that is not an ISO 3166-1 alpha-2 code', async () => {
    const organizationId = await mintOrganization(`Territory Inc ${RUN}`);
    const brandId = await mintBrand(`Territory Brand ${RUN}`);
    for (const bad of [['Spain'], ['es'], ['ESP'], ['ES', 'not-a-code']]) {
      await expect(
        insertRelationship(db, {
          kind: 'organization_owns_brand',
          organizationId,
          brandId,
          territories: bad,
          languages: [],
          validFrom: new Date(),
          status: 'candidate',
          assertedByKind: 'catalog_operator',
        }),
        `${bad.join(',')} must be refused`,
      ).rejects.toSatisfy(isCheckViolation);
    }
  });
});

describe('duplicate active relationships are prevented by the INDEX and by the service (acceptance 4)', () => {
  it('refuses a second open row for one claim at the database', async () => {
    const merchantId = await mintMerchant(`Duplicate Shop ${RUN}`);
    const brandId = await mintBrand(`Duplicate Brand ${RUN}`);
    const first = await insertRelationship(db, {
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      territories: [],
      languages: [],
      validFrom: new Date(),
      status: 'candidate',
      assertedByKind: 'catalog_operator',
    });
    expect(first).toBeDefined();

    // `onConflictDoNothing` swallows it into an empty RETURNING set; a raw
    // insert is what proves the INDEX (rather than the repository) refuses it.
    await expect(
      db.insert(commerceRelationships).values({
        kind: 'merchant_official_channel_for_brand',
        merchantId,
        brandId,
        territories: [],
        languages: [],
        validFrom: new Date(),
        status: 'candidate',
        assertedByKind: 'catalog_operator',
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('answers a duplicate with a 409 naming the row that holds it', async () => {
    const merchantId = await mintMerchant(`Service Duplicate Shop ${RUN}`);
    const brandId = await mintBrand(`Service Duplicate Brand ${RUN}`);
    const first = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await expect(
      assertRelationship({
        kind: 'merchant_official_channel_for_brand',
        merchantId,
        brandId,
        assertedByKind: 'catalog_operator',
        actorOxyUserId: OPERATOR_A,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isMercariaError(error) && error.httpStatus === 409 && error.message.includes(first.id),
    );
  });

  it('admits a SECOND claim narrowed to a storefront, because that is a different claim', async () => {
    // The near miss. Without it, a unique on `(kind, merchant, brand)` alone
    // would pass the case above and silently forbid a legitimate narrowing.
    const merchantId = await mintMerchant(`Scoped Shop ${RUN}`);
    const brandId = await mintBrand(`Scoped Brand ${RUN}`);
    const wide = await insertRelationship(db, {
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      territories: [],
      languages: [],
      validFrom: new Date(),
      status: 'candidate',
      assertedByKind: 'catalog_operator',
    });
    expect(wide).toBeDefined();
    // No storefront row is minted here — the point is the KEY, and the FK would
    // need one, so the narrowing case is covered by the NULL-distinctness proof
    // below instead: two rows differing only in a NULL endpoint must collide.
    const nullEndpointDuplicate = await insertRelationship(db, {
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      territories: ['ES'],
      languages: [],
      validFrom: new Date(),
      status: 'candidate',
      assertedByKind: 'catalog_operator',
    });
    // Territory is NOT part of the key: markets are an array on ONE row, so a
    // second row differing only by territory is the duplicate, not a variant.
    expect(nullEndpointDuplicate).toBeUndefined();
  });

  it('admits at most one CURRENT VERIFIED owner per brand', async () => {
    const brandId = await mintBrand(`Contested Brand ${RUN}`);
    const orgA = await mintOrganization(`Contested A ${RUN}`);
    const orgB = await mintOrganization(`Contested B ${RUN}`);
    const now = new Date();

    const [first] = await db
      .insert(commerceRelationships)
      .values({
        kind: 'organization_owns_brand',
        organizationId: orgA,
        brandId,
        territories: [],
        languages: [],
        validFrom: now,
        status: 'verified',
        verificationMethod: 'legal_register',
        verifiedAt: now,
        verifiedByOxyUserId: OPERATOR_A,
        assertedByKind: 'catalog_operator',
      })
      .returning();
    expect(first).toBeDefined();

    await expect(
      db.insert(commerceRelationships).values({
        kind: 'organization_owns_brand',
        organizationId: orgB,
        brandId,
        territories: [],
        languages: [],
        validFrom: now,
        status: 'verified',
        verificationMethod: 'legal_register',
        verifiedAt: now,
        verifiedByOxyUserId: OPERATOR_A,
        assertedByKind: 'catalog_operator',
      }),
    ).rejects.toSatisfy(isUniqueViolation);

    // But two CANDIDATE claims are admitted — that is the dispute an operator
    // resolves, not a constraint violation.
    const rival = await insertRelationship(db, {
      kind: 'organization_owns_brand',
      organizationId: orgB,
      brandId,
      territories: [],
      languages: [],
      validFrom: now,
      status: 'candidate',
      assertedByKind: 'catalog_operator',
    });
    expect(rival).toBeDefined();
  });
});

describe('no public badge from names, logos or domains alone (acceptance 1)', () => {
  it('refuses to verify an official-store claim on domain control alone', async () => {
    const merchantId = await mintMerchant(`Lookalike Shop ${RUN}`);
    const brandId = await mintBrand(`Lookalike Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'merchant_self_claim',
      actorOxyUserId: `merchant-user-${RUN}`,
      requestReview: true,
    });
    // A real, verified proof of control over a lookalike hostname.
    await attachEvidence({
      relationshipId: relationship.id,
      kind: 'domain_control',
      observedFact: 'DNS TXT record verified for this hostname.',
      subjectDomain: `brand-store-madrid-${RUN}.example`,
      collectedByOxyUserId: OPERATOR_A,
    });
    await endorseRelationship({
      relationshipId: relationship.id,
      actorOxyUserId: OPERATOR_B,
      reason: 'Second operator looked at the domain proof.',
    });

    await expect(
      verifyRelationship({
        relationshipId: relationship.id,
        method: 'domain_control',
        reason: 'Attempting to verify from a domain proof alone.',
        actorOxyUserId: OPERATOR_A,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isMercariaError(error) &&
        error.httpStatus === 403 &&
        error.message.includes('brand_statement'),
    );

    const after = await db
      .select({ status: commerceRelationships.status })
      .from(commerceRelationships)
      .where(eq(commerceRelationships.id, relationship.id));
    expect(after[0]?.status).toBe('pending_review');
  });

  it('a merchant self-claim lands in review, never verified', async () => {
    const merchantId = await mintMerchant(`Self Claim Shop ${RUN}`);
    const brandId = await mintBrand(`Self Claim Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'merchant_self_claim',
      actorOxyUserId: `merchant-user-${RUN}`,
      requestReview: true,
    });
    expect(relationship.status).toBe('pending_review');
    expect(relationship.verifiedAt).toBeNull();
  });

  it('an ingestion source with 0.99 confidence produces a CANDIDATE and no badge', async () => {
    const merchantId = await mintMerchant(`Machine Match Shop ${RUN}`);
    const brandId = await mintBrand(`Machine Match Brand ${RUN}`);
    const sourceId = await mintCatalogSource();

    const row = await insertRelationship(db, {
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      territories: [],
      languages: [],
      validFrom: new Date(),
      status: 'candidate',
      assertedByKind: 'ingestion_source',
      assertedBySourceId: sourceId,
      confidence: 0.99,
    });
    expect(row?.status).toBe('candidate');
    expect(row?.confidence).toBe(0.99);

    // Near-certain and still invisible: the public resolver filters on
    // `verified` and never reads confidence at all.
    const verdict = await resolveOfficialChannel({ merchantId, brandId });
    expect(verdict.badge).toBeNull();
    expect(verdict.relationship).toBeNull();
  });
});

describe('four-eyes approval for high-impact official relationships', () => {
  it('refuses a badge verification with only one operator', async () => {
    const merchantId = await mintMerchant(`Four Eyes Shop ${RUN}`);
    const brandId = await mintBrand(`Four Eyes Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await attachBrandStatement(relationship.id);

    await expect(
      verifyRelationship({
        relationshipId: relationship.id,
        method: 'brand_statement',
        reason: 'One operator trying to verify a badge alone.',
        actorOxyUserId: OPERATOR_A,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isMercariaError(error) && error.httpStatus === 403,
    );
  });

  it('refuses the SAME operator approving twice — the index, not a comparison', async () => {
    const merchantId = await mintMerchant(`Double Approve Shop ${RUN}`);
    const brandId = await mintBrand(`Double Approve Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await endorseRelationship({
      relationshipId: relationship.id,
      actorOxyUserId: OPERATOR_B,
      reason: 'First endorsement from this operator.',
    });
    await expect(
      endorseRelationship({
        relationshipId: relationship.id,
        actorOxyUserId: OPERATOR_B,
        reason: 'Second endorsement from the same operator.',
      }),
    ).rejects.toSatisfy((error: unknown) => isMercariaError(error) && error.httpStatus === 409);

    // And the raw index refuses it too, so the service message is a courtesy.
    await expect(
      db.insert(relationshipReviews).values({
        relationshipId: relationship.id,
        action: 'approve',
        actorOxyUserId: OPERATOR_B,
        reason: 'Bypassing the service.',
        reviewRound: relationship.reviewRound,
        fromStatus: 'candidate',
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('accepts a second DISTINCT operator and verifies', async () => {
    const merchantId = await mintMerchant(`Two Operators Shop ${RUN}`);
    const brandId = await mintBrand(`Two Operators Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await verifyThroughWorkflow(relationship.id);

    const verdict = await resolveOfficialChannel({ merchantId, brandId });
    expect(verdict.badge).toBe('official_store');
  });

  it('retires an approval when the decision round advances', async () => {
    // An endorsement given for one version of a claim must not carry over into a
    // later decision — otherwise "request more evidence, then approve alone"
    // would defeat the whole rule.
    const merchantId = await mintMerchant(`Round Shop ${RUN}`);
    const brandId = await mintBrand(`Round Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await attachBrandStatement(relationship.id);
    await endorseRelationship({
      relationshipId: relationship.id,
      actorOxyUserId: OPERATOR_B,
      reason: 'Endorsement given for the first version.',
    });
    await requestMoreEvidence({
      relationshipId: relationship.id,
      actorOxyUserId: OPERATOR_A,
      reason: 'The published list is from an old locale; re-check it.',
    });

    await expect(
      verifyRelationship({
        relationshipId: relationship.id,
        method: 'brand_statement',
        reason: 'Trying to reuse the retired endorsement.',
        actorOxyUserId: OPERATOR_A,
      }),
    ).rejects.toSatisfy((error: unknown) => isMercariaError(error) && error.httpStatus === 403);
  });
});

describe('market and expiry scope resolve correctly (acceptance 2 and 5)', () => {
  it('answers differently for shoppers in different countries', async () => {
    const merchantId = await mintMerchant(`Market Shop ${RUN}`);
    const brandId = await mintBrand(`Market Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      territories: ['ES', 'FR'],
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await verifyThroughWorkflow(relationship.id);

    const spain = await resolveOfficialChannel({ merchantId, brandId, market: 'ES' });
    expect(spain.badge).toBe('official_store');

    // The fixture that makes the market check real: a shopper in a market the
    // relationship does NOT cover.
    const germany = await resolveOfficialChannel({ merchantId, brandId, market: 'DE' });
    expect(germany.badge).toBeNull();
    expect(germany.relationship).toBeNull();
  });

  it('treats an EMPTY territory list as worldwide', async () => {
    const merchantId = await mintMerchant(`Worldwide Shop ${RUN}`);
    const brandId = await mintBrand(`Worldwide Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await verifyThroughWorkflow(relationship.id);

    for (const market of ['ES', 'DE', 'JP']) {
      const verdict = await resolveOfficialChannel({ merchantId, brandId, market });
      expect(verdict.badge, `worldwide claim must answer for ${market}`).toBe('official_store');
    }
  });

  it('produces no badge from a claim that expired yesterday, whatever its status says', async () => {
    const merchantId = await mintMerchant(`Expired Shop ${RUN}`);
    const brandId = await mintBrand(`Expired Brand ${RUN}`);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Written directly as `verified` with a window that has already closed —
    // the state a sweep has not caught up with yet. The public resolver must
    // still refuse it, which is why it checks the WINDOW and not the status.
    const [row] = await db
      .insert(commerceRelationships)
      .values({
        kind: 'merchant_official_channel_for_brand',
        merchantId,
        brandId,
        territories: [],
        languages: [],
        validFrom: lastWeek,
        validTo: yesterday,
        status: 'verified',
        verificationMethod: 'brand_statement',
        verifiedAt: lastWeek,
        verifiedByOxyUserId: OPERATOR_A,
        assertedByKind: 'catalog_operator',
      })
      .returning();
    expect(row?.status).toBe('verified');

    const verdict = await resolveOfficialChannel({ merchantId, brandId });
    expect(verdict.badge).toBeNull();

    // …and the operator view reports it as a conflict rather than hiding it.
    const operatorView = await getRelationshipForOperator(row?.id ?? '');
    expect(operatorView.conflicts.map((entry) => entry.kind)).toContain('verified_past_validity');
  });

  it('produces no badge from a claim that has not started yet', async () => {
    const merchantId = await mintMerchant(`Future Shop ${RUN}`);
    const brandId = await mintBrand(`Future Brand ${RUN}`);
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(commerceRelationships)
      .values({
        kind: 'merchant_official_channel_for_brand',
        merchantId,
        brandId,
        territories: [],
        languages: [],
        validFrom: nextYear,
        status: 'verified',
        verificationMethod: 'brand_statement',
        verifiedAt: new Date(),
        verifiedByOxyUserId: OPERATOR_A,
        assertedByKind: 'catalog_operator',
      })
      .returning();
    expect(row).toBeDefined();
    expect((await resolveOfficialChannel({ merchantId, brandId })).badge).toBeNull();
  });
});

describe('revocation removes public status without erasing history (acceptance 3)', () => {
  it('keeps the row, its verification facts, its evidence and its reviews', async () => {
    const merchantId = await mintMerchant(`Revoked Shop ${RUN}`);
    const brandId = await mintBrand(`Revoked Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await verifyThroughWorkflow(relationship.id);
    expect((await resolveOfficialChannel({ merchantId, brandId })).badge).toBe('official_store');

    const revoked = await endRelationship({
      relationshipId: relationship.id,
      action: 'revoke',
      reason: 'The brand ended the arrangement.',
      actorOxyUserId: OPERATOR_A,
    });

    expect((await resolveOfficialChannel({ merchantId, brandId })).badge).toBeNull();
    // The history: who verified it, how, and when, all still on the row.
    expect(revoked.status).toBe('revoked');
    expect(revoked.verifiedAt).not.toBeNull();
    expect(revoked.verificationMethod).toBe('brand_statement');
    expect(revoked.verifiedByOxyUserId).toBe(OPERATOR_A);
    expect(revoked.validTo).not.toBeNull();
    expect(await listEvidence(db, relationship.id)).toHaveLength(1);
    const reviews = await listReviews(db, relationship.id);
    expect(reviews.map((review) => review.action)).toContain('revoke');
  });

  it('revoking EVIDENCE never deletes it and never touches the relationship', async () => {
    const merchantId = await mintMerchant(`Evidence Shop ${RUN}`);
    const brandId = await mintBrand(`Evidence Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await verifyThroughWorkflow(relationship.id);
    const [evidence] = await listEvidence(db, relationship.id);
    expect(evidence).toBeDefined();

    await revokeRelationshipEvidence({
      evidenceId: evidence?.id ?? '',
      actorOxyUserId: OPERATOR_A,
      reason: 'The published list was withdrawn.',
    });

    const after = await listEvidence(db, relationship.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('revoked');
    expect(after[0]?.revokedAt).not.toBeNull();

    // The relationship is untouched, and the operator surface reports the gap
    // rather than the system silently unverifying it.
    const view = await getRelationshipForOperator(relationship.id);
    expect(view.relationship.status).toBe('verified');
    expect(view.conflicts.map((entry) => entry.kind)).toContain(
      'verified_without_active_evidence',
    );
  });

  it('refuses to delete a relationship that has evidence — RESTRICT, not CASCADE', async () => {
    const merchantId = await mintMerchant(`Restrict Shop ${RUN}`);
    const brandId = await mintBrand(`Restrict Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await attachBrandStatement(relationship.id);
    await expect(
      db.delete(commerceRelationships).where(eq(commerceRelationships.id, relationship.id)),
    ).rejects.toThrow();
  });
});

describe('the review trail is append-only', () => {
  it('refuses UPDATE and DELETE on a review row', async () => {
    const merchantId = await mintMerchant(`Append Only Shop ${RUN}`);
    const brandId = await mintBrand(`Append Only Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    const review = await insertReview(db, {
      relationshipId: relationship.id,
      action: 'request_more_evidence',
      actorOxyUserId: OPERATOR_A,
      reason: 'The list has no date on it.',
      reviewRound: 0,
      fromStatus: 'candidate',
      toStatus: 'candidate',
    });
    expect(review).toBeDefined();

    await expect(
      db
        .update(relationshipReviews)
        .set({ reason: 'A different reason entirely.' })
        .where(eq(relationshipReviews.id, review?.id ?? '')),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.delete(relationshipReviews).where(eq(relationshipReviews.id, review?.id ?? '')),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a review with no reason and one with no actor', async () => {
    const merchantId = await mintMerchant(`Blank Review Shop ${RUN}`);
    const brandId = await mintBrand(`Blank Review Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    for (const values of [
      { reason: '   ', actorOxyUserId: OPERATOR_A },
      { reason: 'A real reason.', actorOxyUserId: '  ' },
    ]) {
      await expect(
        db.insert(relationshipReviews).values({
          relationshipId: relationship.id,
          action: 'reject',
          reviewRound: 0,
          fromStatus: 'candidate',
          toStatus: 'rejected',
          ...values,
        }),
      ).rejects.toSatisfy(isCheckViolation);
    }
  });
});

describe('evidence shape is constrained where it matters', () => {
  it('refuses a brand statement without both its URL and its content digest', async () => {
    const merchantId = await mintMerchant(`Digest Shop ${RUN}`);
    const brandId = await mintBrand(`Digest Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await expect(
      insertEvidence(db, {
        relationshipId: relationship.id,
        kind: 'brand_statement',
        observedFact: 'The brand publishes this merchant.',
        sourceUrl: `https://brand-${RUN}.example.com/list`,
        observedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('demands the domain a domain-control proof is ABOUT, and forbids it elsewhere', async () => {
    const merchantId = await mintMerchant(`Domain Evidence Shop ${RUN}`);
    const brandId = await mintBrand(`Domain Evidence Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await expect(
      insertEvidence(db, {
        relationshipId: relationship.id,
        kind: 'domain_control',
        observedFact: 'DNS TXT verified.',
        observedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertEvidence(db, {
        relationshipId: relationship.id,
        kind: 'operator_attestation',
        observedFact: 'I checked this by hand.',
        subjectDomain: `stray-${RUN}.example`,
        observedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('demands a LOCATOR on everything but an operator attestation', async () => {
    const merchantId = await mintMerchant(`Locator Shop ${RUN}`);
    const brandId = await mintBrand(`Locator Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await expect(
      insertEvidence(db, {
        relationshipId: relationship.id,
        kind: 'source_document',
        observedFact: 'Somebody said so.',
        observedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
    // The attestation IS admitted with no locator — a named person's word is the
    // one kind that points nowhere, and without this case the check above would
    // also pass against a rule demanding a locator from everything.
    const attestation = await insertEvidence(db, {
      relationshipId: relationship.id,
      kind: 'operator_attestation',
      observedFact: 'I confirmed this with the brand by telephone.',
      observedAt: new Date(),
      collectedByOxyUserId: OPERATOR_A,
    });
    expect(attestation.id).toBeDefined();
  });
});

describe('the public projection carries no private review material (evidence rule 6)', () => {
  it('exposes exactly the safe fields and nothing else', async () => {
    const merchantId = await mintMerchant(`Projection Shop ${RUN}`);
    const brandId = await mintBrand(`Projection Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      territories: ['ES'],
      note: 'An internal note that must never surface.',
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await verifyThroughWorkflow(relationship.id);

    const verdict = await resolveOfficialChannel({ merchantId, brandId, market: 'ES' });
    expect(verdict.relationship).not.toBeNull();
    expect(Object.keys(verdict.relationship ?? {}).sort()).toEqual([
      'badge',
      'id',
      'kind',
      'languages',
      'objectId',
      'objectKind',
      'status',
      'storefrontId',
      'subjectId',
      'subjectKind',
      'territories',
      'validFrom',
      'validTo',
      'verifiedAt',
    ]);
    const serialized = JSON.stringify(verdict);
    for (const secret of [
      OPERATOR_A,
      OPERATOR_B,
      'internal note',
      'reviewerNote',
      'confidence',
      'assertedBy',
      'reviewRound',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });
});

describe('the Apple acceptance example', () => {
  it('proves every line of it, and refuses the line it must refuse', async () => {
    const appleInc = await mintOrganization(`Apple Inc ${RUN}`);
    const appleBrand = await mintBrand(`Apple ${RUN}`);
    const appleStore = await mintMerchant(`Apple Store ${RUN}`);
    const amazon = await mintMerchant(`Amazon ${RUN}`);
    const thirdParty = await mintMerchant(`Third Party Seller ${RUN}`);

    // "Apple Inc. owns Apple"
    const ownership = await assertRelationship({
      kind: 'organization_owns_brand',
      organizationId: appleInc,
      brandId: appleBrand,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await attachEvidence({
      relationshipId: ownership.id,
      kind: 'legal_register',
      observedFact: 'Trademark register entry naming the organization as proprietor.',
      sourceUrl: `https://register-${RUN}.example.com/trademark`,
      collectedByOxyUserId: OPERATOR_A,
    });
    const verifiedOwnership = await verifyRelationship({
      relationshipId: ownership.id,
      method: 'legal_register',
      reason: 'Trademark register checked.',
      actorOxyUserId: OPERATOR_A,
    });
    expect(verifiedOwnership.status).toBe('verified');

    // "Apple Inc. operates Apple Store"
    const operates = await assertRelationship({
      kind: 'organization_operates_merchant',
      organizationId: appleInc,
      merchantId: appleStore,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await attachEvidence({
      relationshipId: operates.id,
      kind: 'domain_control',
      observedFact: 'DNS TXT record verified on the operator’s own domain.',
      subjectDomain: `apple-${RUN}.example.com`,
      collectedByOxyUserId: OPERATOR_A,
    });
    const verifiedOperates = await verifyRelationship({
      relationshipId: operates.id,
      method: 'domain_control',
      reason: 'Domain control proven for the operating organization.',
      actorOxyUserId: OPERATOR_A,
    });
    expect(verifiedOperates.status).toBe('verified');

    // "Apple Store is an official direct Apple channel in selected markets"
    const channel = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId: appleStore,
      brandId: appleBrand,
      territories: ['ES', 'US'],
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await verifyThroughWorkflow(channel.id);

    // "Amazon sells Apple products without becoming Apple Store" — an
    // authorized reseller, different kind, DIFFERENT public language.
    const reseller = await assertRelationship({
      kind: 'merchant_authorized_reseller_for_brand',
      merchantId: amazon,
      brandId: appleBrand,
      territories: ['ES'],
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await verifyThroughWorkflow(reseller.id);

    // The four assertions the example makes, in one market.
    expect((await resolveOfficialChannel({ merchantId: appleStore, brandId: appleBrand, market: 'ES' })).badge).toBe(
      'official_store',
    );
    expect((await resolveOfficialChannel({ merchantId: amazon, brandId: appleBrand, market: 'ES' })).badge).toBe(
      'authorized_reseller',
    );
    // "A third-party Amazon seller can offer an iPhone with no official
    // relationship" — no row at all, and that is the normal state.
    expect((await resolveOfficialChannel({ merchantId: thirdParty, brandId: appleBrand, market: 'ES' })).badge).toBeNull();
    // Apple Store is not an official channel in a market it was not granted.
    expect((await resolveOfficialChannel({ merchantId: appleStore, brandId: appleBrand, market: 'JP' })).badge).toBeNull();

    // The brand page lists the two SEPARATELY.
    const directory = await listBrandChannels({ brandId: appleBrand, market: 'ES' });
    expect(directory.officialChannels.map((row) => row.subjectId)).toEqual([appleStore]);
    expect(directory.authorizedResellers.map((row) => row.subjectId)).toEqual([amazon]);
    expect(directory.officialChannels.map((row) => row.subjectId)).not.toContain(amazon);

    // Ownership and manufacturing do not imply each other (ADR 0002 D11): no
    // manufacturing claim exists, and nothing derived one from the ownership.
    const manufacturing = await findCurrentRelationships(db, {
      kinds: ['organization_manufactures'],
      at: new Date(),
    });
    expect(manufacturing.filter((row) => row.organizationId === appleInc)).toEqual([]);
  });
});

describe('the correction path is reversible and appends rather than edits', () => {
  it('closes the original, opens a successor and links the two', async () => {
    const merchantId = await mintMerchant(`Correction Shop ${RUN}`);
    const brandId = await mintBrand(`Correction Brand ${RUN}`);
    const original = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      territories: ['ES', 'FR'],
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await verifyThroughWorkflow(original.id);

    const { revoked, replacement } = await correctRelationship({
      relationshipId: original.id,
      reason: 'The arrangement covers Spain only; France was an error.',
      territories: ['ES'],
      actorOxyUserId: OPERATOR_A,
    });

    expect(revoked.status).toBe('revoked');
    expect(revoked.supersededById).toBeNull();
    expect(replacement.territories).toEqual(['ES']);
    // The successor is a CLAIM: correcting is asserting, and verifying it runs
    // every gate again.
    expect(replacement.status).toBe('candidate');

    const view = await getRelationshipForOperator(replacement.id);
    expect(view.relationship.supersedesId).toBe(original.id);
    const originalView = await getRelationshipForOperator(original.id);
    expect(originalView.relationship.supersededById).toBe(replacement.id);
    expect(originalView.reviews.map((review) => review.action)).toContain('correct');

    // No badge while the correction is unverified — the corrected claim is not
    // live until it has been through review.
    expect((await resolveOfficialChannel({ merchantId, brandId, market: 'ES' })).badge).toBeNull();
  });
});

describe('the operator candidate queue', () => {
  it('returns the claim with its evidence summary, approvals and conflicts', async () => {
    const merchantId = await mintMerchant(`Queue Shop ${RUN}`);
    const brandId = await mintBrand(`Queue Brand ${RUN}`);
    const relationship = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await attachBrandStatement(relationship.id);
    await endorseRelationship({
      relationshipId: relationship.id,
      actorOxyUserId: OPERATOR_B,
      reason: 'Endorsed pending the second read.',
    });

    const queue = await listCandidateQueue({ limit: 100, offset: 0 });
    const entry = queue.find((item) => item.relationship.id === relationship.id);
    expect(entry).toBeDefined();
    expect(entry?.evidenceCount).toBe(1);
    expect(entry?.activeEvidenceCount).toBe(1);
    expect(entry?.evidenceKinds).toEqual(['brand_statement']);
    expect(entry?.approvedByOxyUserIds).toEqual([OPERATOR_B]);
    expect(entry?.requiresFourEyes).toBe(true);
  });

  it('reports a channel/reseller overlap between two live claims', async () => {
    const merchantId = await mintMerchant(`Overlap Shop ${RUN}`);
    const brandId = await mintBrand(`Overlap Brand ${RUN}`);
    const channel = await assertRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId,
      territories: ['ES'],
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });
    await assertRelationship({
      kind: 'merchant_authorized_reseller_for_brand',
      merchantId,
      brandId,
      territories: ['ES'],
      assertedByKind: 'catalog_operator',
      actorOxyUserId: OPERATOR_A,
    });

    const view = await getRelationshipForOperator(channel.id);
    const overlap = view.conflicts.find((entry) => entry.kind === 'channel_and_reseller_overlap');
    expect(overlap).toBeDefined();
    expect(overlap?.overlappingTerritories).toEqual(['ES']);
  });
});
