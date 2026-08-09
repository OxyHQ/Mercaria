/**
 * The fourteen things that are never resale authority (#121 acceptance 1).
 *
 * Two properties, and the second is the one that makes the first worth having:
 * every forbidden kind is DETECTED by the shape somebody would actually type,
 * and every ALLOWED kind survives — a detector that refused everything would
 * pass a naive "does it refuse an affiliate feed" test while making the domain
 * unusable.
 */

import { describe, expect, it } from 'vitest';
import {
  RETAIL_COMPLIANCE_EVIDENCE_KINDS,
  RETAIL_FORBIDDEN_EVIDENCE_KINDS,
  RETAIL_FORBIDDEN_EVIDENCE_LABELS,
  RETAIL_RESALE_EVIDENCE_KINDS,
} from '@mercaria/shared-types';
import {
  assertNoForbiddenResaleEvidence,
  detectForbiddenResaleEvidence,
} from '../forbidden-evidence.js';

describe('the forbidden-evidence detector', () => {
  it('detects every forbidden kind by its own name', () => {
    for (const kind of RETAIL_FORBIDDEN_EVIDENCE_KINDS) {
      const matches = detectForbiddenResaleEvidence([kind]);
      expect(matches, kind).toHaveLength(1);
      expect(matches[0]?.reason.length, kind).toBeGreaterThan(20);
    }
  });

  it('names the SPECIFIC prohibition, not a broader one', () => {
    // A refusal that names the wrong prohibition teaches the wrong lesson.
    expect(detectForbiddenResaleEvidence(['affiliate_product_feed'])[0]?.kind).toBe(
      'affiliate_product_feed',
    );
    expect(detectForbiddenResaleEvidence(['affiliate_program_membership'])[0]?.kind).toBe(
      'affiliate_program_membership',
    );
  });

  it('matches SHAPES, not spellings — the four ways one attempt is written', () => {
    for (const spelling of ['affiliateFeed', 'affiliate_feed', 'Affiliate Feed', 'AFFILIATE-FEED']) {
      expect(detectForbiddenResaleEvidence([spelling]), spelling).toHaveLength(1);
    }
  });

  it('catches the attempt as it actually arrives: free text on the issuer', () => {
    // "issuer: our affiliate dashboard" is the shape this rule has to catch in
    // practice — the `kind` enum already blocks the structured version.
    expect(detectForbiddenResaleEvidence(['our affiliate dashboard export'])).toHaveLength(1);
    expect(detectForbiddenResaleEvidence(['screenshot of the product page'])).toHaveLength(1);
    expect(detectForbiddenResaleEvidence(['we were told on a phone call'])).toHaveLength(1);
  });

  it('leaves every ALLOWED resale kind alone', () => {
    // The vacuity floor: a detector that refused everything would pass the
    // cases above and make the domain unusable.
    for (const kind of RETAIL_RESALE_EVIDENCE_KINDS) {
      expect(detectForbiddenResaleEvidence([kind]), kind).toEqual([]);
    }
    expect(RETAIL_RESALE_EVIDENCE_KINDS.length).toBeGreaterThanOrEqual(12);
  });

  it('leaves every COMPLIANCE kind alone too', () => {
    for (const kind of RETAIL_COMPLIANCE_EVIDENCE_KINDS) {
      expect(detectForbiddenResaleEvidence([kind]), kind).toEqual([]);
    }
  });

  it('leaves ordinary supplier prose alone', () => {
    for (const text of [
      'Contrato marco de suministro firmado 2026',
      'Distributor agreement, annex B',
      'Notified body 0123 certificate',
    ]) {
      expect(detectForbiddenResaleEvidence([text]), text).toEqual([]);
    }
  });
});

describe('the refusal', () => {
  it('names the attempt, the prohibition and why it proves nothing', () => {
    expect(() => {
      assertNoForbiddenResaleEvidence(['affiliate_program_membership'], 'Retail resale evidence');
    }).toThrow(/affiliate_program_membership/);
    expect(() => {
      assertNoForbiddenResaleEvidence(['api_key_possession'], 'Retail resale evidence');
    }).toThrow(/credential/);
    // …and it says what WOULD work, so the answer is actionable.
    expect(() => {
      assertNoForbiddenResaleEvidence(['public_product_page'], 'Retail resale evidence');
    }).toThrow(/WRITTEN grant/);
  });

  it('passes an allowed submission through in silence', () => {
    expect(() => {
      assertNoForbiddenResaleEvidence(
        ['signed_supply_agreement', 'Acme S.L.'],
        'Retail resale evidence',
      );
    }).not.toThrow();
  });

  it('every forbidden kind has a label long enough to be an explanation', () => {
    for (const kind of RETAIL_FORBIDDEN_EVIDENCE_KINDS) {
      expect(RETAIL_FORBIDDEN_EVIDENCE_LABELS[kind].length, kind).toBeGreaterThan(40);
    }
  });
});
