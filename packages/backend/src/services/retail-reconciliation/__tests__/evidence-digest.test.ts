/**
 * The evidence digest — the convergence key of a reconciliation revision.
 *
 * The property under test is that a re-run under unchanged evidence produces
 * the SAME digest and therefore no new revision. Get it wrong in the permissive
 * direction and every sweep tick writes a revision, every order accumulates one
 * per minute, and "exactly one customer adjustment obligation" becomes one per
 * tick with every earlier one superseded.
 */

import { describe, expect, it } from 'vitest';
import {
  reconciliationEvidenceDigest,
  serializeReconciliationEvidence,
  type EvidenceDigestInput,
} from '../evidence-digest.js';

const BASE: EvidenceDigestInput = {
  orderId: 'ord-1',
  policyKey: 'mercaria-retail-reconciliation',
  policyVersion: 3,
  accountingCurrency: 'EUR',
  toleranceMinor: 1,
  records: [
    {
      kind: 'supplier_invoice',
      reference: 'INV-2',
      amountMinor: 9_000,
      currency: 'USD',
      observedAt: new Date('2026-08-01T10:00:00.000Z'),
    },
    {
      kind: 'retail_cost_quote',
      reference: 'q-1',
      amountMinor: 10_000,
      currency: 'EUR',
      observedAt: new Date('2026-07-30T09:00:00.000Z'),
    },
  ],
  blockedBy: [],
};

describe('the digest converges on unchanged evidence', () => {
  it('is identical for two hashings of one evidence set', () => {
    expect(reconciliationEvidenceDigest(BASE)).toBe(reconciliationEvidenceDigest(BASE));
  });

  it('does not depend on the ORDER the records arrived in', () => {
    const reversed: EvidenceDigestInput = { ...BASE, records: [...BASE.records].reverse() };
    expect(reconciliationEvidenceDigest(reversed)).toBe(reconciliationEvidenceDigest(BASE));
  });

  it('never reads a clock', () => {
    // The load-bearing property and the easy mistake. A preimage containing the
    // computation time would differ on every pass, and the "converge on
    // unchanged evidence" behaviour would silently become "write a revision
    // every tick".
    const preimage = serializeReconciliationEvidence(BASE);
    const nowYear = String(new Date().getUTCFullYear());
    // `observedAt` IS in the preimage and is a fact about the RECORD, so the
    // check is that no CURRENT instant appears: the fixture's dates are 2026 and
    // the run's year is compared against the parts that are not them.
    const withoutRecordDates = preimage
      .replaceAll('2026-08-01T10:00:00.000Z', '')
      .replaceAll('2026-07-30T09:00:00.000Z', '');
    expect(withoutRecordDates).not.toContain(nowYear);
    expect(withoutRecordDates).not.toContain(String(Date.now()).slice(0, 5));
  });

  it('is 64 lower-case hex characters, as the CHECK requires', () => {
    expect(reconciliationEvidenceDigest(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the digest MOVES when the answer would', () => {
  it('changes when a record’s amount changes', () => {
    const changed: EvidenceDigestInput = {
      ...BASE,
      records: BASE.records.map((record, index) =>
        index === 0 ? { ...record, amountMinor: 9_500 } : record,
      ),
    };
    expect(reconciliationEvidenceDigest(changed)).not.toBe(reconciliationEvidenceDigest(BASE));
  });

  it('changes when a record is added', () => {
    const added: EvidenceDigestInput = {
      ...BASE,
      records: [
        ...BASE.records,
        {
          kind: 'supplier_credit_note',
          reference: 'CN-1',
          amountMinor: 400,
          currency: 'USD',
          observedAt: new Date('2026-08-05T00:00:00.000Z'),
        },
      ],
    };
    expect(reconciliationEvidenceDigest(added)).not.toBe(reconciliationEvidenceDigest(BASE));
  });

  it('changes when a supplier REISSUES a document with a later date', () => {
    const reissued: EvidenceDigestInput = {
      ...BASE,
      records: BASE.records.map((record, index) =>
        index === 0
          ? { ...record, observedAt: new Date('2026-08-02T10:00:00.000Z') }
          : record,
      ),
    };
    expect(reconciliationEvidenceDigest(reissued)).not.toBe(reconciliationEvidenceDigest(BASE));
  });

  it('changes when the POLICY version changes', () => {
    // Not evidence, but it changes the ANSWER: a revision whose verdict differs
    // from its predecessor's while its digest matches would be a verdict nobody
    // could reproduce. Including it means activating a new version re-reconciles
    // every open order exactly once.
    const other: EvidenceDigestInput = { ...BASE, policyVersion: 4 };
    expect(reconciliationEvidenceDigest(other)).not.toBe(reconciliationEvidenceDigest(BASE));
  });

  it('changes when the TOLERANCE changes', () => {
    const other: EvidenceDigestInput = { ...BASE, toleranceMinor: 5 };
    expect(reconciliationEvidenceDigest(other)).not.toBe(reconciliationEvidenceDigest(BASE));
  });

  it('changes when a blocking condition is resolved', () => {
    // "The invoice is still missing" and "the invoice arrived" can otherwise
    // share an evidence set: the first has one record fewer, but so does an
    // order whose supplier simply charged no handling fee. Without the block
    // list in the preimage, resolving a block would sometimes fail to produce a
    // new revision — which is the case an operator is waiting for.
    const blocked: EvidenceDigestInput = { ...BASE, blockedBy: ['missing_supplier_invoice'] };
    expect(reconciliationEvidenceDigest(blocked)).not.toBe(reconciliationEvidenceDigest(BASE));
  });

  it('does not depend on the ORDER of the blocking list', () => {
    const a: EvidenceDigestInput = { ...BASE, blockedBy: ['missing_provider_fee', 'x'] };
    const b: EvidenceDigestInput = { ...BASE, blockedBy: ['x', 'missing_provider_fee'] };
    expect(reconciliationEvidenceDigest(a)).toBe(reconciliationEvidenceDigest(b));
  });
});

describe('the preimage is readable', () => {
  it('is exported so a test can assert what is hashed', () => {
    // A digest test that only compares two opaque strings passes just as well
    // when both are of the empty string.
    const preimage = serializeReconciliationEvidence(BASE);
    expect(preimage).toContain('ord-1');
    expect(preimage).toContain('supplier_invoice');
    expect(preimage).toContain('INV-2');
    expect(preimage.length).toBeGreaterThan(50);
  });

  it('serializes an absent optional as a VALUE rather than a hole', () => {
    // Two records differing only in whether an amount is present must not
    // collide, which is what an omitted field would allow.
    const withAmount = serializeReconciliationEvidence({
      ...BASE,
      records: [
        { kind: 'purchase_order', reference: 'po-1', amountMinor: 0, currency: 'EUR', observedAt: new Date(0) },
      ],
    });
    const withoutAmount = serializeReconciliationEvidence({
      ...BASE,
      records: [{ kind: 'purchase_order', reference: 'po-1', observedAt: new Date(0) }],
    });
    expect(withAmount).not.toBe(withoutAmount);
  });
});
