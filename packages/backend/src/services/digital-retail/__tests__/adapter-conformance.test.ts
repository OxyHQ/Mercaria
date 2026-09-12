/**
 * The adapter conformance suite, driven against the sandbox adapter and against
 * deliberately broken ones (#1016 Workstream 2, acceptance criterion 24).
 *
 * ## Every check has a NEGATIVE control, and that is the point of the file
 *
 * A conformance suite that only ever runs against a good adapter proves that the
 * good adapter is good. It says nothing about whether the suite could notice a
 * bad one — which is the only thing it exists for. So each broken adapter below
 * breaks exactly ONE contract, and the assertion is that the suite names that one
 * and not something else.
 */

import { describe, expect, it } from 'vitest';
import type { AdapterContext, DigitalSupplierAdapter } from '../adapter.js';
import { redactProviderMessage, runAdapterOperation } from '../adapter.js';
import { runAdapterConformance } from '../conformance.js';
import { createSandboxAdapter } from '../sandbox-adapter.js';

const CONTEXT: AdapterContext = {
  supplierAccountId: 'acct-conformance',
  environment: 'test',
  timeoutMs: 5_000,
};

const OPTIONS = {
  sku: 'SKU-CONFORMANCE',
  activationTerritory: 'ES',
  currency: 'EUR',
  context: CONTEXT,
  allowPurchase: true,
} as const;

const failures = (findings: { severity: string; check: string }[]) =>
  findings.filter((finding) => finding.severity === 'fail').map((finding) => finding.check);

describe('the sandbox adapter conforms', () => {
  it('passes every check with no failures', async () => {
    const findings = await runAdapterConformance(createSandboxAdapter(), OPTIONS);
    expect(failures(findings)).toEqual([]);
  });

  it('WARNS rather than passing silently when purchase is not exercised', async () => {
    // A run that never bought anything proves the shape and not the behaviour,
    // and a clean report for it would be read as a launch signal.
    const findings = await runAdapterConformance(createSandboxAdapter(), {
      ...OPTIONS,
      allowPurchase: false,
    });
    expect(failures(findings)).toEqual([]);
    expect(findings.some((finding) => finding.severity === 'warn')).toBe(true);
  });
});

describe('the negative controls — each breaks exactly one contract', () => {
  it('catches an adapter that cannot recover an ambiguous purchase', async () => {
    const adapter = createSandboxAdapter();
    const crippled: DigitalSupplierAdapter = {
      ...adapter,
      capabilities: adapter.capabilities.filter(
        (capability) => capability !== 'purchase_recovery',
      ),
    };
    const findings = await runAdapterConformance(crippled, OPTIONS);
    expect(failures(findings)).toContain('required-capability');
  });

  it('catches an adapter whose idempotency key buys twice', async () => {
    const inner = createSandboxAdapter();
    let call = 0;
    const doubleBuying: DigitalSupplierAdapter = {
      ...inner,
      async purchase(request, context) {
        // A fresh key per call is exactly what a provider that ignores the
        // idempotency header does, and it is the failure that costs a key.
        call += 1;
        return inner.purchase({ ...request, idempotencyKey: `${request.idempotencyKey}-${call}` }, context);
      },
    };
    const findings = await runAdapterConformance(doubleBuying, OPTIONS);
    expect(failures(findings)).toContain('idempotency');
  });

  it('catches an adapter that absorbs a cost above the accepted maximum', async () => {
    const inner = createSandboxAdapter();
    const absorbing: DigitalSupplierAdapter = {
      ...inner,
      async purchase(request, context) {
        return inner.purchase({ ...request, maxAcceptedCostAmount: Number.MAX_SAFE_INTEGER }, context);
      },
    };
    const findings = await runAdapterConformance(absorbing, OPTIONS);
    expect(failures(findings)).toContain('bound-refusal');
  });

  it('catches an adapter that puts the secret in its customer-facing instructions', async () => {
    const inner = createSandboxAdapter();
    const leaking: DigitalSupplierAdapter = {
      ...inner,
      async getFulfilment(providerOrderId, context) {
        const result = await inner.getFulfilment(providerOrderId, context);
        if (result.ok !== true) return result;
        return {
          ok: true,
          value: { ...result.value, instructions: `Enter ${result.value.secret} at checkout` },
        };
      },
    };
    const findings = await runAdapterConformance(leaking, OPTIONS);
    expect(failures(findings)).toContain('secret-in-instructions');
  });

  it('catches an adapter that claims an unused idempotency key already exists', async () => {
    const inner = createSandboxAdapter();
    const overEager: DigitalSupplierAdapter = {
      ...inner,
      async recoverPurchase(_key, _context) {
        return {
          ok: true,
          value: {
            found: true,
            purchase: {
              providerOrderId: 'sbx_invented',
              accepted: true,
              finalCostAmount: 1,
              finalCostCurrency: 'EUR',
              fulfilmentReady: true,
            },
          },
        };
      },
    };
    const findings = await runAdapterConformance(overEager, OPTIONS);
    expect(failures(findings)).toContain('recovery-unknown');
  });

  it('catches a declared capability with no implementation behind it', async () => {
    const inner = createSandboxAdapter();
    const { cancel: _cancel, ...withoutCancel } = inner;
    const findings = await runAdapterConformance(withoutCancel as DigitalSupplierAdapter, OPTIONS);
    expect(failures(findings)).toContain('declared-not-implemented');
  });

  it('stops at an unhealthy provider rather than reporting its consequences', async () => {
    const inner = createSandboxAdapter();
    const down: DigitalSupplierAdapter = {
      ...inner,
      async health() {
        return {
          ok: false,
          failure: { kind: 'provider_unavailable', messageRedacted: 'down' },
        };
      },
    };
    const findings = await runAdapterConformance(down, OPTIONS);
    expect(failures(findings)).toEqual(['health']);
  });
});

describe('the port’s own safety rails', () => {
  it('converts a thrown adapter error into `other`, which is NOT ambiguous', async () => {
    // `other` deliberately sits outside AMBIGUOUS_PROCUREMENT_ERROR_KINDS: a
    // throw must not silently license a fallback, because nothing on this side of
    // the wire knows whether the provider bought something.
    const result = await runAdapterOperation(async () => {
      throw new Error('boom sk_live_ABCDEFGHIJKLMNOP');
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.failure.kind).toBe('other');
      expect(result.failure.messageRedacted).not.toContain('ABCDEFGHIJKLMNOP');
    }
  });

  it('redacts what is key-shaped and leaves the sentence readable', () => {
    expect(redactProviderMessage('key ABCD-EFGH-IJKL rejected')).toBe('key [redacted] rejected');
    expect(redactProviderMessage('out of stock, order rejected')).toBe('out of stock, order rejected');
    expect(redactProviderMessage('sku SKU12345678 unknown')).toBe('sku [redacted] unknown');
  });

  it('bounds the length of a message that is long rather than secret', () => {
    // Truncation is the second rule and it is independent of redaction: a
    // provider that returns a kilobyte of HTML must not become a kilobyte row.
    expect(redactProviderMessage('word '.repeat(400))).toHaveLength(200);
  });
});
