/**
 * The verification contract, table-tested (#83).
 *
 * The registry is one table with no branching, so a test over it is a test of
 * the whole contract — and one row of it carries an acceptance criterion:
 * `role_email` must never auto-verify, which is what makes "a matching email
 * domain alone cannot complete a claim" (issue acceptance 2) structural rather
 * than a rule somebody remembers in the state machine.
 */

import { describe, expect, it } from 'vitest';
import { MERCHANT_CLAIM_METHODS } from '@mercaria/shared-types';
import {
  availableMethodOptions,
  isMethodAvailable,
  methodAssurance,
  methodAutoVerifies,
  methodSpec,
} from '../claim-methods.js';

describe('the verification contract is total over the closed set', () => {
  it('has a spec for every method, with no gaps', () => {
    // The vacuity floor: a shrunken tuple must fail here rather than make the
    // loop below iterate over nothing.
    expect(MERCHANT_CLAIM_METHODS.length).toBe(7);
    for (const method of MERCHANT_CLAIM_METHODS) {
      const spec = methodSpec(method);
      expect(spec.method, `${method} maps to the wrong spec`).toBe(method);
      expect(['high', 'standard', 'low']).toContain(spec.assurance);
    }
  });

  it('gives exactly one method no challenge subject, and it is the document review', () => {
    const subjectless = MERCHANT_CLAIM_METHODS.filter(
      (method) => methodSpec(method).subjectKind === null,
    );
    // This is not a stylistic assertion. `merchant_claims_document_subject_check`
    // states the same fact in SQL, and a second subjectless method added here
    // without a migration would be refused by the database at runtime.
    expect(subjectless).toEqual(['business_document']);
  });
});

describe('a low-assurance proof can never complete a claim on its own', () => {
  it('never lets a `low` method auto-verify (issue acceptance 2)', () => {
    const lowMethods = MERCHANT_CLAIM_METHODS.filter(
      (method) => methodAssurance(method) === 'low',
    );
    // The floor: if nothing is `low`, the assertion below passes vacuously and
    // this criterion would be unguarded.
    expect(lowMethods.length).toBeGreaterThan(0);
    for (const method of lowMethods) {
      expect(methodAutoVerifies(method), `${method} may not auto-verify`).toBe(false);
    }
  });

  it('marks the email challenge low-assurance and non-auto-verifying', () => {
    expect(methodAssurance('role_email')).toBe('low');
    expect(methodAutoVerifies('role_email')).toBe(false);
  });

  it('sends the document review to a human too', () => {
    expect(methodAutoVerifies('business_document')).toBe(false);
  });
});

describe('availability is not membership', () => {
  it('keeps the email method in the closed set while refusing to offer it', () => {
    // Mercaria has no outbound email transport, so the token cannot reach the
    // role address. The method stays in the tuple — the state machine, the
    // review path and the database CHECK all exist for it — and is simply not
    // offered, which is issue #83's "safe subset at launch" made explicit
    // rather than dropped.
    expect(MERCHANT_CLAIM_METHODS).toContain('role_email');
    expect(isMethodAvailable('role_email')).toBe(false);
    expect(methodSpec('role_email').unavailableReason).toBe('no_email_transport');
  });

  it('offers every other method, in the closed set’s own order', () => {
    const offered = availableMethodOptions().map((option) => option.method);
    expect(offered).toEqual([
      'dns_txt',
      'well_known_file',
      'meta_tag',
      'platform_oauth',
      'channel_key',
      'business_document',
    ]);
  });

  it('never offers a method it cannot take', () => {
    for (const option of availableMethodOptions()) {
      expect(isMethodAvailable(option.method)).toBe(true);
    }
  });
});

describe('the assurance ladder is the one the issue describes', () => {
  it('rates zone control above site control', () => {
    expect(methodAssurance('dns_txt')).toBe('high');
    expect(methodAssurance('well_known_file')).toBe('standard');
    expect(methodAssurance('meta_tag')).toBe('standard');
  });

  it('rates a platform-authenticated account as high, scoped to that shop', () => {
    expect(methodAssurance('platform_oauth')).toBe('high');
    expect(methodSpec('platform_oauth').subjectKind).toBe('connection');
    expect(methodAssurance('channel_key')).toBe('high');
    expect(methodSpec('channel_key').subjectKind).toBe('connection');
  });

  it('only hands the claimant a token when the token IS the proof', () => {
    for (const method of ['dns_txt', 'well_known_file', 'meta_tag', 'role_email'] as const) {
      expect(methodSpec(method).tokenIsCarriedByClaimant).toBe(true);
    }
    // A platform proof is made with a credential the claimant already holds;
    // sending them a token they cannot use invites them to paste it somewhere.
    for (const method of ['platform_oauth', 'channel_key', 'business_document'] as const) {
      expect(methodSpec(method).tokenIsCarriedByClaimant).toBe(false);
    }
  });
});
