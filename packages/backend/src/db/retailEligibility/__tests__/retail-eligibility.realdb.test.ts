/**
 * The retail eligibility schema's load-bearing constraints, against a REAL
 * Postgres database (#121) — the properties a mocked repository is structurally
 * blind to:
 *
 *  - **the policy version is immutable once active** (acceptance 7: an answer
 *    is reproducible only if the version it cited cannot be edited underneath
 *    it), and at most ONE version per key is active;
 *  - **a decision cites its version by a NOT NULL COMPOSITE foreign key**, so a
 *    decision naming a version its policy row does not have is refused by
 *    Postgres rather than by a comparison somebody has to remember;
 *  - **decisions and audits are append-only by trigger**;
 *  - **a recall can never be advisory**, and a live suppression per subject is
 *    ONE row however many operators react to the same notice;
 *  - **an exception can never store an unwaivable reason**, and four eyes is
 *    the row's shape rather than a service comparison;
 *  - **the evidence CHECKs** refuse a verification with no reviewer, a
 *    rejection with no reason, a revocation with no actor, and a document that
 *    points at nothing;
 *  - **the EMERGENCY PATH end to end**, independently of any refresh: an
 *    eligible combination, one INSERT, and the very next derivation refuses.
 *
 * No cleanup and no TRUNCATE — vitest runs files in parallel against ONE
 * throwaway database, so every id here is unique per run instead.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../postgres.js';
import {
  retailEligibilityAudits,
  retailEligibilityDecisions,
  retailEligibilityExceptions,
  retailEligibilityPolicies,
  retailResaleEvidence,
} from '../../schema/retailEligibility.js';
import { createSupplier } from '../../procurement/supplierRepository.js';
import {
  activateRetailEligibilityPolicy,
  insertRetailEligibilityPolicy,
  upsertRetailCategoryRule,
  upsertRetailMarketCapability,
  type RetailEligibilityPolicyRecord,
} from '../policyRepository.js';
import {
  insertRetailResaleEvidence,
  verifyRetailResaleEvidence,
  revokeRetailResaleEvidence,
} from '../evidenceRepository.js';
import {
  liftRetailSuppression,
  raiseRetailSuppression,
} from '../suppressionRepository.js';
import { insertRetailEligibilityException } from '../exceptionRepository.js';
import {
  appendRetailEligibilityAudit,
  recordRetailEligibilityDecision,
} from '../decisionRepository.js';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

/**
 * Assert a write is refused by the named CLASS of constraint — the
 * `procurement.realdb.test.ts` helper, because "it threw" alone would also pass
 * when the WRONG constraint fired.
 */
async function expectRefused(
  write: () => Promise<unknown>,
  kind: 'check' | 'unique',
): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the write SUCCEEDED; the constraint did not fire').toBeDefined();
  const matched = kind === 'check' ? isCheckViolation(caught) : isUniqueViolation(caught);
  expect(matched, `expected a ${kind} violation, got: ${String(caught)}`).toBe(true);
}

/** A supplier fixture, unique per call. */
async function makeSupplier(): Promise<string> {
  const supplier = await createSupplier({
    supplierType: 'dropship_distributor',
    canonicalName: `Retail eligibility supplier ${uuidv7()}`,
    establishmentCountries: ['ES'],
    fulfilmentOriginCountries: ['ES'],
  });
  return supplier.id;
}

/** A DRAFT policy version under a key unique to this call. */
async function makeDraftPolicy(
  overrides: Partial<Parameters<typeof insertRetailEligibilityPolicy>[1]> = {},
): Promise<RetailEligibilityPolicyRecord> {
  return await insertRetailEligibilityPolicy(db, {
    policyKey: `key-${uuidv7().replace(/[^a-z0-9]/g, '').slice(0, 30)}`,
    version: 1,
    name: 'Launch policy',
    summary: 'The EU launch scope.',
    effectiveStart: new Date(Date.now() - 86_400_000),
    permittedDestinationCountries: ['ES'],
    permittedFulfilmentOriginCountries: ['ES'],
    permittedChannels: ['mercaria_branded_checkout'],
    permittedCurrencies: ['EUR'],
    permittedFulfilmentMethods: ['standard_delivery'],
    permittedCustomerTypes: ['consumer'],
    createdByOxyUserId: 'oxy-operator-1',
    ...overrides,
  });
}

/** An ACTIVE policy version. */
async function makeActivePolicy(): Promise<RetailEligibilityPolicyRecord> {
  const draft = await makeDraftPolicy();
  const active = await activateRetailEligibilityPolicy(db, {
    id: draft.id,
    approvedByOxyUserId: 'oxy-operator-2',
  });
  if (!active) throw new Error('fixture policy did not activate');
  return active;
}

describe('a policy version is immutable once it leaves draft', () => {
  it('refuses every scope edit on an ACTIVE version, and permits them on a draft', async () => {
    const draft = await makeDraftPolicy();
    // A draft is editable: the gate is the STATUS, not the table.
    const [edited] = await db
      .update(retailEligibilityPolicies)
      .set({ permittedDestinationCountries: ['ES', 'FR'] })
      .where(eq(retailEligibilityPolicies.id, draft.id))
      .returning();
    expect(edited?.permittedDestinationCountries).toEqual(['ES', 'FR']);

    const active = await activateRetailEligibilityPolicy(db, {
      id: draft.id,
      approvedByOxyUserId: 'oxy-operator-2',
    });
    expect(active?.status).toBe('active');

    await expectRefused(
      () =>
        db
          .update(retailEligibilityPolicies)
          .set({ permittedDestinationCountries: ['US'] })
          .where(eq(retailEligibilityPolicies.id, draft.id)),
      'check',
    );
    await expectRefused(
      () =>
        db
          .update(retailEligibilityPolicies)
          .set({ manualExceptionsPermitted: true })
          .where(eq(retailEligibilityPolicies.id, draft.id)),
      'check',
    );
    // …and a published version is never DELETED.
    await expectRefused(
      () => db.delete(retailEligibilityPolicies).where(eq(retailEligibilityPolicies.id, draft.id)),
      'check',
    );
  });

  it('permits the STATUS transitions activation and retirement still need', async () => {
    // The trigger freezes the scope, not the lifecycle: a version that could
    // not be superseded would make publishing a successor impossible.
    const active = await makeActivePolicy();
    const [retired] = await db
      .update(retailEligibilityPolicies)
      .set({ status: 'retired' })
      .where(eq(retailEligibilityPolicies.id, active.id))
      .returning();
    expect(retired?.status).toBe('retired');
  });

  it('refuses a SECOND active version for one key, even from a writer that skips the service', async () => {
    const first = await makeActivePolicy();
    const second = await insertRetailEligibilityPolicy(db, {
      policyKey: first.policyKey,
      version: 2,
      name: 'Second',
      summary: 'A second version.',
      effectiveStart: new Date(),
      createdByOxyUserId: 'oxy-operator-1',
    });
    await expectRefused(
      () =>
        db
          .update(retailEligibilityPolicies)
          .set({
            status: 'active',
            approvedByOxyUserId: 'oxy-operator-2',
            activatedAt: new Date(),
          })
          .where(eq(retailEligibilityPolicies.id, second.id)),
      'unique',
    );
  });

  it('refuses an anonymous activation and an uncomparable order-value ceiling', async () => {
    const draft = await makeDraftPolicy();
    // An active version names who approved it and when — the fee-schedule rule.
    await expectRefused(
      () =>
        db
          .update(retailEligibilityPolicies)
          .set({ status: 'active' })
          .where(eq(retailEligibilityPolicies.id, draft.id)),
      'check',
    );
    // A ceiling this domain could never compare is unstorable: no FX here.
    await expectRefused(
      () =>
        insertRetailEligibilityPolicy(db, {
          policyKey: `key-${uuidv7().replace(/[^a-z0-9]/g, '').slice(0, 30)}`,
          version: 1,
          name: 'Two currencies',
          summary: 'A ceiling in one currency, two permitted.',
          effectiveStart: new Date(),
          permittedCurrencies: ['EUR', 'USD'],
          maxOrderValue: { amount: 100_000, currency: 'EUR' },
          createdByOxyUserId: 'oxy-operator-1',
        }),
      'check',
    );
  });
});

describe('a decision cites its policy version, or it is unrepresentable', () => {
  it('accepts a decision naming its own version and refuses one naming another', async () => {
    const policy = await makeActivePolicy();
    const supplierId = await makeSupplier();
    const base = {
      policyId: policy.id,
      policyKey: policy.policyKey,
      policyVersion: policy.version,
      procurementOfferId: `offer-${uuidv7()}`,
      supplierId,
      canonicalVariantId: null,
      destinationCountry: 'ES',
      fulfilmentOriginCountry: 'ES',
      channel: 'mercaria_branded_checkout' as const,
      currency: 'EUR' as const,
      quantity: 1,
      fulfilmentMethod: 'standard_delivery' as const,
      customerType: 'consumer' as const,
      verdict: 'unknown' as const,
      reasons: ['category_not_evaluated' as const],
      nextRequiredAction: 'evaluate_category' as const,
      resaleEvidenceIds: [],
      complianceEvidenceIds: [],
      exceptionId: null,
      contentHash: 'a'.repeat(64),
      evaluatedAt: new Date(),
      surface: 'publication' as const,
    };
    const recorded = await recordRetailEligibilityDecision(db, base);
    expect(recorded.verdict).toBe('unknown');

    // The composite key is what refuses a snapshot that disagrees with the row.
    let caught: unknown;
    try {
      await recordRetailEligibilityDecision(db, { ...base, policyVersion: 99 });
    } catch (error) {
      caught = error;
    }
    expect(caught, 'a decision citing another version was accepted').toBeDefined();
  });

  it('refuses an eligible decision that explains itself, and a blocked one that does not', async () => {
    const policy = await makeActivePolicy();
    const supplierId = await makeSupplier();
    const base = {
      policyId: policy.id,
      policyKey: policy.policyKey,
      policyVersion: policy.version,
      procurementOfferId: `offer-${uuidv7()}`,
      supplierId,
      canonicalVariantId: null,
      destinationCountry: 'ES',
      fulfilmentOriginCountry: 'ES',
      channel: 'mercaria_branded_checkout' as const,
      currency: 'EUR' as const,
      quantity: 1,
      fulfilmentMethod: 'standard_delivery' as const,
      customerType: 'consumer' as const,
      resaleEvidenceIds: [],
      complianceEvidenceIds: [],
      exceptionId: null,
      contentHash: 'b'.repeat(64),
      evaluatedAt: new Date(),
      surface: 'checkout' as const,
    };
    await expectRefused(
      () =>
        recordRetailEligibilityDecision(db, {
          ...base,
          verdict: 'eligible',
          reasons: ['category_prohibited'],
          nextRequiredAction: 'none',
        }),
      'check',
    );
    await expectRefused(
      () =>
        recordRetailEligibilityDecision(db, {
          ...base,
          verdict: 'ineligible',
          reasons: [],
          nextRequiredAction: 'not_available',
        }),
      'check',
    );
    // …and an eligible verdict whose action is not `none`.
    await expectRefused(
      () =>
        recordRetailEligibilityDecision(db, {
          ...base,
          verdict: 'eligible',
          reasons: [],
          nextRequiredAction: 'operator_review',
        }),
      'check',
    );
  });

  it('refuses UPDATE and DELETE on a recorded decision', async () => {
    const policy = await makeActivePolicy();
    const supplierId = await makeSupplier();
    const decision = await recordRetailEligibilityDecision(db, {
      policyId: policy.id,
      policyKey: policy.policyKey,
      policyVersion: policy.version,
      procurementOfferId: `offer-${uuidv7()}`,
      supplierId,
      canonicalVariantId: null,
      destinationCountry: 'ES',
      fulfilmentOriginCountry: 'ES',
      channel: 'mercaria_branded_checkout',
      currency: 'EUR',
      quantity: 1,
      fulfilmentMethod: 'standard_delivery',
      customerType: 'consumer',
      verdict: 'ineligible',
      reasons: ['destination_not_permitted'],
      nextRequiredAction: 'not_available',
      resaleEvidenceIds: [],
      complianceEvidenceIds: [],
      exceptionId: null,
      contentHash: 'c'.repeat(64),
      evaluatedAt: new Date(),
      surface: 'checkout',
    });
    await expectRefused(
      () =>
        db
          .update(retailEligibilityDecisions)
          .set({ verdict: 'eligible' })
          .where(eq(retailEligibilityDecisions.id, decision.id)),
      'check',
    );
    await expectRefused(
      () =>
        db.delete(retailEligibilityDecisions).where(eq(retailEligibilityDecisions.id, decision.id)),
      'check',
    );
  });
});

describe('the audit trail is append-only, refusals included', () => {
  it('records a refusal and then refuses to be edited or deleted', async () => {
    const audit = await appendRetailEligibilityAudit(db, {
      action: 'resale_evidence_verified',
      subjectTable: 'retail_resale_evidence',
      subjectId: `evidence-${uuidv7()}`,
      outcome: 'refused',
      reason: 'the document was already revoked',
      actorOxyUserId: 'oxy-operator-1',
    });
    expect(audit.outcome).toBe('refused');
    await expectRefused(
      () =>
        db
          .update(retailEligibilityAudits)
          .set({ outcome: 'applied' })
          .where(eq(retailEligibilityAudits.id, audit.id)),
      'check',
    );
    await expectRefused(
      () => db.delete(retailEligibilityAudits).where(eq(retailEligibilityAudits.id, audit.id)),
      'check',
    );
  });

  it('refuses an anonymous or unexplained audit row', async () => {
    await expectRefused(
      () =>
        db.insert(retailEligibilityAudits).values({
          action: 'suppression_lifted',
          subjectTable: 'retail_suppressions',
          subjectId: 'x',
          outcome: 'applied',
          reason: '   ',
          actorOxyUserId: 'oxy-operator-1',
          at: new Date(),
        }),
      'check',
    );
    await expectRefused(
      () =>
        db.insert(retailEligibilityAudits).values({
          action: 'suppression_lifted',
          subjectTable: 'retail_suppressions',
          subjectId: 'x',
          outcome: 'applied',
          reason: 'because',
          actorOxyUserId: '',
          at: new Date(),
        }),
      'check',
    );
  });
});

describe('suppressions: the emergency control', () => {
  it('refuses an ADVISORY recall — the one combination that would change nothing', async () => {
    const supplierId = await makeSupplier();
    await expectRefused(
      () =>
        raiseRetailSuppression(db, {
          scope: 'supplier',
          scopeRef: supplierId,
          kind: 'recall',
          severity: 'advisory',
          source: 'authority',
          reason: 'authority notice ABC-1',
          raisedByOxyUserId: 'oxy-operator-1',
        }),
      'check',
    );
  });

  it('converges two operators reacting to ONE notice onto ONE live row', async () => {
    const supplierId = await makeSupplier();
    const raise = (actor: string) =>
      raiseRetailSuppression(db, {
        scope: 'supplier',
        scopeRef: supplierId,
        kind: 'recall',
        severity: 'stop_sale',
        source: 'authority',
        reason: `authority notice ${actor}`,
        raisedByOxyUserId: actor,
      });
    const [first, second] = await Promise.all([raise('oxy-operator-1'), raise('oxy-operator-2')]);
    expect(first.id).toBe(second.id);

    // …and lifting it lets a NEW one be raised for the same subject, which is
    // what makes the partial unique a live-row constraint rather than a
    // permanent one.
    const lifted = await liftRetailSuppression(db, {
      id: first.id,
      liftedByOxyUserId: 'oxy-operator-3',
      reason: 'the authority withdrew the notice',
    });
    expect(lifted?.liftedAt).toBeInstanceOf(Date);
    const again = await raise('oxy-operator-4');
    expect(again.id).not.toBe(first.id);
  });

  it('refuses an unattributable or unexplained lift', async () => {
    const supplierId = await makeSupplier();
    const raised = await raiseRetailSuppression(db, {
      scope: 'supplier',
      scopeRef: supplierId,
      kind: 'kill_switch',
      severity: 'stop_sale',
      source: 'operator',
      reason: 'pausing the pilot',
      raisedByOxyUserId: 'oxy-operator-1',
    });
    const { retailSuppressions } = await import('../../schema/retailEligibility.js');
    await expectRefused(
      () =>
        db
          .update(retailSuppressions)
          .set({ liftedAt: new Date() })
          .where(eq(retailSuppressions.id, raised.id)),
      'check',
    );
  });

  it('refuses a market suppression whose reference is not a country code', async () => {
    await expectRefused(
      () =>
        raiseRetailSuppression(db, {
          scope: 'market',
          scopeRef: 'the whole of europe',
          kind: 'kill_switch',
          severity: 'stop_sale',
          source: 'operator',
          reason: 'a market pause',
          raisedByOxyUserId: 'oxy-operator-1',
        }),
      'check',
    );
  });
});

describe('evidence: the CHECKs a mocked repository cannot see', () => {
  it('refuses a document that points at nothing', async () => {
    const supplierId = await makeSupplier();
    await expectRefused(
      () =>
        db.insert(retailResaleEvidence).values({
          supplierId,
          kind: 'signed_supply_agreement',
          recordedByOxyUserId: 'oxy-operator-1',
          recordedAt: new Date(),
        }),
      'check',
    );
  });

  it('refuses a verification with no reviewer and a rejection with no reason', async () => {
    const supplierId = await makeSupplier();
    const evidence = await insertRetailResaleEvidence(db, {
      supplierId,
      kind: 'signed_supply_agreement',
      documentUrl: 'https://vault.example/contract.pdf',
      recordedByOxyUserId: 'oxy-operator-1',
    });
    await expectRefused(
      () =>
        db
          .update(retailResaleEvidence)
          .set({ reviewState: 'verified' })
          .where(eq(retailResaleEvidence.id, evidence.id)),
      'check',
    );
    await expectRefused(
      () =>
        db
          .update(retailResaleEvidence)
          .set({ reviewState: 'rejected' })
          .where(eq(retailResaleEvidence.id, evidence.id)),
      'check',
    );
  });

  it('verifies, then refuses a revocation with no actor, then revokes properly', async () => {
    const supplierId = await makeSupplier();
    const evidence = await insertRetailResaleEvidence(db, {
      supplierId,
      kind: 'signed_supply_agreement',
      documentUrl: 'https://vault.example/contract.pdf',
      recordedByOxyUserId: 'oxy-operator-1',
    });
    const verified = await verifyRetailResaleEvidence(db, {
      id: evidence.id,
      verifiedByOxyUserId: 'oxy-operator-2',
    });
    expect(verified?.reviewState).toBe('verified');

    await expectRefused(
      () =>
        db
          .update(retailResaleEvidence)
          .set({ reviewState: 'revoked', revokedAt: new Date() })
          .where(eq(retailResaleEvidence.id, evidence.id)),
      'check',
    );

    const revoked = await revokeRetailResaleEvidence(db, {
      id: evidence.id,
      revokedByOxyUserId: 'oxy-operator-3',
      reason: 'the supplier terminated the agreement',
    });
    expect(revoked?.reviewState).toBe('revoked');

    // A revoked document cannot be quietly re-verified: the CAS refuses it.
    const reVerified = await verifyRetailResaleEvidence(db, {
      id: evidence.id,
      verifiedByOxyUserId: 'oxy-operator-2',
    });
    expect(reVerified).toBeUndefined();
  });

  it('refuses a document whose expiry precedes its issue date', async () => {
    const supplierId = await makeSupplier();
    await expectRefused(
      () =>
        insertRetailResaleEvidence(db, {
          supplierId,
          kind: 'territory_grant',
          documentUrl: 'https://vault.example/grant.pdf',
          issuedAt: new Date('2026-08-09T00:00:00Z'),
          expiresAt: new Date('2026-01-01T00:00:00Z'),
          recordedByOxyUserId: 'oxy-operator-1',
        }),
      'check',
    );
  });
});

describe('exceptions: what the database refuses to store', () => {
  it('refuses an UNWAIVABLE reason outright', async () => {
    const policy = await makeActivePolicy();
    const supplierId = await makeSupplier();
    await expectRefused(
      () =>
        db.insert(retailEligibilityExceptions).values({
          policyId: policy.id,
          supplierId,
          // `product_recalled` is not in `RETAIL_WAIVABLE_REASONS`, so the
          // containment CHECK refuses it — no service comparison involved.
          waivedReasons: ['product_recalled'],
          justification: 'the recall is not really about this batch',
          requestedByOxyUserId: 'oxy-operator-1',
          requestedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      'check',
    );
  });

  it('accepts a waivable one and holds four eyes as the row shape', async () => {
    const policy = await makeActivePolicy();
    const supplierId = await makeSupplier();
    const exception = await insertRetailEligibilityException(db, {
      policyId: policy.id,
      supplierId,
      waivedReasons: ['category_requires_approval'],
      justification: 'the category assessment is in flight and the SKU is low risk',
      requestedByOxyUserId: 'oxy-operator-1',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(exception.state).toBe('requested');

    // The REQUESTER cannot approve their own waiver.
    await expectRefused(
      () =>
        db
          .update(retailEligibilityExceptions)
          .set({ state: 'approved', approvedByOxyUserId: 'oxy-operator-1', approvedAt: new Date() })
          .where(eq(retailEligibilityExceptions.id, exception.id)),
      'check',
    );

    const [approved] = await db
      .update(retailEligibilityExceptions)
      .set({ state: 'approved', approvedByOxyUserId: 'oxy-operator-2', approvedAt: new Date() })
      .where(eq(retailEligibilityExceptions.id, exception.id))
      .returning();
    expect(approved?.approvedByOxyUserId).toBe('oxy-operator-2');

    // …and the SAME person cannot be both approvers.
    await expectRefused(
      () =>
        db
          .update(retailEligibilityExceptions)
          .set({ secondApprovedByOxyUserId: 'oxy-operator-2', secondApprovedAt: new Date() })
          .where(eq(retailEligibilityExceptions.id, exception.id)),
      'check',
    );

    const [twoEyes] = await db
      .update(retailEligibilityExceptions)
      .set({ secondApprovedByOxyUserId: 'oxy-operator-3', secondApprovedAt: new Date() })
      .where(eq(retailEligibilityExceptions.id, exception.id))
      .returning();
    expect(twoEyes?.secondApprovedByOxyUserId).toBe('oxy-operator-3');
  });

  it('refuses a waiver with no end and one with an empty reason set', async () => {
    const policy = await makeActivePolicy();
    const supplierId = await makeSupplier();
    await expectRefused(
      () =>
        db.insert(retailEligibilityExceptions).values({
          policyId: policy.id,
          supplierId,
          waivedReasons: [],
          justification: 'because',
          requestedByOxyUserId: 'oxy-operator-1',
          requestedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      'check',
    );
    await expectRefused(
      () =>
        db.insert(retailEligibilityExceptions).values({
          policyId: policy.id,
          supplierId,
          waivedReasons: ['category_requires_approval'],
          justification: 'because',
          requestedByOxyUserId: 'oxy-operator-1',
          requestedAt: new Date(),
          // An end BEFORE the request: a waiver that never applied.
          expiresAt: new Date(Date.now() - 86_400_000),
        }),
      'check',
    );
  });
});

describe('category rules and market capabilities', () => {
  it('refuses a prohibited category that also carries requirements', async () => {
    const policy = await makeActivePolicy();
    await expectRefused(
      () =>
        upsertRetailCategoryRule(db, {
          policyId: policy.id,
          categoryKey: 'weapons',
          admissibility: 'prohibited',
          requiredComplianceEvidenceKinds: ['test_report'],
          reason: 'not sold at launch',
          recordedByOxyUserId: 'oxy-operator-1',
        }),
      'check',
    );
  });

  it('converges a corrected rule onto ONE row per (policy, category)', async () => {
    const policy = await makeActivePolicy();
    const first = await upsertRetailCategoryRule(db, {
      policyId: policy.id,
      categoryKey: 'kitchen-knives',
      admissibility: 'requires_approval',
      reason: 'pending the safety review',
      recordedByOxyUserId: 'oxy-operator-1',
    });
    const second = await upsertRetailCategoryRule(db, {
      policyId: policy.id,
      categoryKey: 'kitchen-knives',
      admissibility: 'permitted',
      requiredComplianceEvidenceKinds: ['gpsr_traceability_pack'],
      reason: 'the safety review cleared it',
      recordedByOxyUserId: 'oxy-operator-2',
    });
    expect(second.id).toBe(first.id);
    expect(second.admissibility).toBe('permitted');
  });

  it('refuses a FINAL price claim while duty, import or VAT is open', async () => {
    // "Do not publish `no additional fees` unless the exact route supports it."
    const policy = await makeActivePolicy();
    await expectRefused(
      () =>
        upsertRetailMarketCapability(db, {
          policyId: policy.id,
          destinationCountry: 'ES',
          fulfilmentOriginCountry: 'ES',
          customerType: 'consumer',
          priceFinality: 'final',
          vatTreatment: 'destination_vat_oss',
          importerOfRecord: 'not_applicable',
          // …and the duty question left open.
          dutyResponsibility: 'undetermined',
          reason: 'intra-EU route',
          recordedByOxyUserId: 'oxy-operator-1',
        }),
      'check',
    );
  });

  it('refuses a claimed registration with no reference', async () => {
    const policy = await makeActivePolicy();
    await expectRefused(
      () =>
        upsertRetailMarketCapability(db, {
          policyId: policy.id,
          destinationCountry: 'FR',
          fulfilmentOriginCountry: 'ES',
          customerType: 'consumer',
          sellerRegistrationRecorded: true,
          reason: 'OSS registered',
          recordedByOxyUserId: 'oxy-operator-1',
        }),
      'check',
    );
  });
});
