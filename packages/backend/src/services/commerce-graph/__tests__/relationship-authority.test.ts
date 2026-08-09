/**
 * The trust rules of #55, pinned one by one.
 *
 * Each `it` here names an issue rule rather than a function, because the rules
 * are what must survive a refactor: a future author is free to move
 * `findSufficientEvidence` anywhere, and must not be free to make domain control
 * sufficient for an official-store badge.
 */

import { describe, expect, it } from 'vitest';
import {
  BADGE_RELATIONSHIP_KINDS,
  RELATIONSHIP_ASSERTED_BY_KINDS,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_KIND_DEFINITIONS,
  RELATIONSHIP_VERIFICATION_METHODS,
  RELATIONSHIP_VERIFICATION_STATES,
  SUFFICIENT_EVIDENCE_KINDS,
} from '@mercaria/shared-types';
import {
  AUTOMATIC_VERIFICATION_RULES,
  acceptableEvidenceKinds,
  canAutoVerify,
  canTransition,
  findSufficientEvidence,
  maxReachableStatus,
  requiresFourEyes,
  TERMINAL_RELATIONSHIP_STATES,
  type AutomaticVerificationRule,
  type EvidenceFact,
} from '../relationship-authority.js';

describe('a source adapter may create a candidate, never a verified row (evidence rule 2)', () => {
  it('caps ingestion at `candidate`, whatever it asks for', () => {
    expect(maxReachableStatus('ingestion_source')).toBe('candidate');
  });

  it('has NO automatic verification rule today, for any kind', () => {
    // The empty set is the decision (ADR 0002 D10): the one deterministic
    // mechanism Mercaria has proves control of a hostname, which establishes
    // neither brand ownership nor authorization to resell.
    expect(AUTOMATIC_VERIFICATION_RULES).toEqual([]);
    for (const kind of RELATIONSHIP_KINDS) {
      for (const method of RELATIONSHIP_VERIFICATION_METHODS) {
        for (const assertedBy of RELATIONSHIP_ASSERTED_BY_KINDS) {
          expect(canAutoVerify({ kind, method, assertedBy })).toBe(false);
        }
      }
    }
  });

  it('the gate READS the rule table — it is not hardcoded to refuse', () => {
    // Without this, the assertion above is satisfied by `return false`, and the
    // day someone adds a legitimate rule it would be silently ignored. Supplying
    // a rule table is the mutation test: the gate must say yes to exactly the
    // entry it was given and no to its neighbours.
    const rule: AutomaticVerificationRule = {
      kind: 'organization_operates_merchant',
      method: 'domain_control',
      assertedBy: 'platform_verification',
      justification: 'Test-only rule proving the gate reads its table.',
    };
    expect(
      canAutoVerify(
        {
          kind: 'organization_operates_merchant',
          method: 'domain_control',
          assertedBy: 'platform_verification',
        },
        [rule],
      ),
    ).toBe(true);
    expect(
      canAutoVerify(
        {
          kind: 'merchant_official_channel_for_brand',
          method: 'domain_control',
          assertedBy: 'platform_verification',
        },
        [rule],
      ),
    ).toBe(false);
    expect(
      canAutoVerify(
        {
          kind: 'organization_operates_merchant',
          method: 'brand_statement',
          assertedBy: 'platform_verification',
        },
        [rule],
      ),
    ).toBe(false);
  });
});

describe('a merchant self-claim is evidence, never self-verification (evidence rule 3)', () => {
  it('caps a self-claim at `pending_review`', () => {
    expect(maxReachableStatus('merchant_self_claim')).toBe('pending_review');
  });

  it('never lets any asserter reach `verified` on its own', () => {
    for (const assertedBy of RELATIONSHIP_ASSERTED_BY_KINDS) {
      expect(maxReachableStatus(assertedBy)).not.toBe('verified');
    }
  });
});

describe('domain control proves control of that domain and nothing else (evidence rule 4)', () => {
  const domainControlOnly: EvidenceFact[] = [{ kind: 'domain_control', status: 'active' }];

  it('cannot verify an official-store badge', () => {
    expect(findSufficientEvidence('merchant_official_channel_for_brand', domainControlOnly)).toEqual(
      [],
    );
  });

  it('cannot verify an authorized-reseller badge', () => {
    expect(
      findSufficientEvidence('merchant_authorized_reseller_for_brand', domainControlOnly),
    ).toEqual([]);
  });

  it('cannot verify brand ownership', () => {
    expect(findSufficientEvidence('organization_owns_brand', domainControlOnly)).toEqual([]);
  });

  it('CAN verify that an organization operates its own merchant presence', () => {
    // The one fact domain control actually establishes. Without this case the
    // three refusals above would also pass against a rule table that refuses
    // domain control everywhere, which would be a different (and wrong) design.
    expect(findSufficientEvidence('organization_operates_merchant', domainControlOnly)).toHaveLength(
      1,
    );
  });

  it('names what WOULD have been enough, per kind', () => {
    expect(acceptableEvidenceKinds('merchant_official_channel_for_brand')).toContain(
      'brand_statement',
    );
    expect(acceptableEvidenceKinds('merchant_official_channel_for_brand')).not.toContain(
      'domain_control',
    );
  });

  it('ignores evidence that has been revoked or has expired', () => {
    const lapsed: EvidenceFact[] = [
      { kind: 'brand_statement', status: 'revoked' },
      { kind: 'operator_attestation', status: 'expired' },
    ];
    expect(findSufficientEvidence('merchant_official_channel_for_brand', lapsed)).toEqual([]);
  });

  it('gives every kind at least one sufficient evidence kind', () => {
    // A kind with an empty list would be permanently unverifiable — a silent
    // dead end rather than a deliberate refusal.
    for (const kind of RELATIONSHIP_KINDS) {
      expect(SUFFICIENT_EVIDENCE_KINDS[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('four-eyes covers exactly the badge-producing kinds', () => {
  it('requires a second operator for every kind that reaches a shopper', () => {
    expect([...BADGE_RELATIONSHIP_KINDS].sort()).toEqual([
      'merchant_authorized_reseller_for_brand',
      'merchant_official_channel_for_brand',
    ]);
    for (const kind of BADGE_RELATIONSHIP_KINDS) {
      expect(requiresFourEyes(kind, true)).toBe(true);
    }
  });

  it('does not require it for kinds that produce no public badge', () => {
    expect(requiresFourEyes('organization_owns_brand', true)).toBe(false);
    expect(requiresFourEyes('organization_manufactures', true)).toBe(false);
  });

  it('is a deployment switch, and the switch turns it off', () => {
    expect(requiresFourEyes('merchant_official_channel_for_brand', false)).toBe(false);
  });
});

describe('the transition table', () => {
  it('admits no path back from any ending', () => {
    // The correction path is a NEW row linked by `superseded_by_id`, precisely so
    // a revoked claim cannot be edited back into a live one.
    expect([...TERMINAL_RELATIONSHIP_STATES].sort()).toEqual(['expired', 'rejected', 'revoked']);
    for (const state of TERMINAL_RELATIONSHIP_STATES) {
      for (const target of RELATIONSHIP_VERIFICATION_STATES) {
        expect(canTransition(state, target)).toBe(false);
      }
    }
  });

  it('reaches `verified` only from a live claim', () => {
    expect(canTransition('candidate', 'verified')).toBe(true);
    expect(canTransition('pending_review', 'verified')).toBe(true);
    expect(canTransition('revoked', 'verified')).toBe(false);
    expect(canTransition('expired', 'verified')).toBe(false);
    expect(canTransition('rejected', 'verified')).toBe(false);
  });

  it('lets a verified claim only END, never change its mind', () => {
    expect(canTransition('verified', 'expired')).toBe(true);
    expect(canTransition('verified', 'revoked')).toBe(true);
    expect(canTransition('verified', 'rejected')).toBe(false);
    expect(canTransition('verified', 'candidate')).toBe(false);
  });
});

describe('confidence is not verification (issue field 5)', () => {
  it('appears in no rule that decides a verdict', () => {
    // Structural, not behavioural: none of the authority functions takes a
    // confidence argument, so no amount of it can influence a decision. A
    // signature check is the strongest form this claim can take. (`Function
    // .length` stops at the first defaulted parameter, which is why
    // `canAutoVerify` — whose rule table is defaulted — reports 1.)
    expect(maxReachableStatus.length).toBe(1);
    expect(requiresFourEyes.length).toBe(2);
    expect(findSufficientEvidence.length).toBe(2);
    expect(canAutoVerify.length).toBe(1);
  });

  it('every badge-producing kind still needs evidence, at any confidence', () => {
    for (const kind of BADGE_RELATIONSHIP_KINDS) {
      expect(findSufficientEvidence(kind, [])).toEqual([]);
      expect(RELATIONSHIP_KIND_DEFINITIONS[kind].publicBadge).not.toBeNull();
    }
  });
});
