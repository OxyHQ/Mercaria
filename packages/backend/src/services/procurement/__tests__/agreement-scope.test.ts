/**
 * Agreement scope, table-tested — the fail-closed half of #118 acceptance
 * criteria 3 and 6.
 *
 * Fixture discipline (the AGENTS.md mutation-testing lesson): every conjunct
 * gets a fixture where IT ALONE fails, so a mutation that drops one conjunct
 * cannot hide behind fixtures that fail several at once.
 */

import { describe, expect, it } from 'vitest';
import {
  agreementGrantsRetailDropship,
  agreementPermitsChannel,
  agreementPermitsDestination,
  isAgreementActive,
  type AgreementScopeFacts,
} from '../agreement-scope.js';

const NOW = new Date('2026-08-09T12:00:00Z');
const PAST = new Date('2026-01-01T00:00:00Z');
const FUTURE = new Date('2027-01-01T00:00:00Z');

/** A fully-granting, currently-active agreement — each test breaks ONE thing. */
function activeAgreement(overrides: Partial<AgreementScopeFacts> = {}): AgreementScopeFacts {
  return {
    approvalState: 'approved',
    effectiveAt: PAST,
    expiresAt: null,
    permittedDestinationCountries: ['ES', 'FR'],
    permittedChannels: ['mercaria_marketplace'],
    resaleRightsGranted: true,
    dropshipRightsGranted: true,
    blindDropshipVerified: true,
    dataProcessingTermsAccepted: true,
    ...overrides,
  };
}

describe('isAgreementActive', () => {
  it('accepts an approved agreement inside its window', () => {
    expect(isAgreementActive(activeAgreement(), NOW)).toBe(true);
    expect(isAgreementActive(activeAgreement({ expiresAt: FUTURE }), NOW)).toBe(true);
  });

  it('refuses every non-approved state, however perfect the window', () => {
    for (const approvalState of [
      'draft',
      'under_review',
      'rejected',
      'superseded',
      'terminated',
    ] as const) {
      expect(isAgreementActive(activeAgreement({ approvalState }), NOW)).toBe(false);
    }
  });

  it('refuses an agreement that has not started', () => {
    expect(isAgreementActive(activeAgreement({ effectiveAt: FUTURE }), NOW)).toBe(false);
  });

  it('refuses an agreement with no effective date at all', () => {
    expect(isAgreementActive(activeAgreement({ effectiveAt: null }), NOW)).toBe(false);
  });

  it('refuses an EXPIRED agreement — expiry removes eligibility, not history (#118 acceptance 6)', () => {
    expect(isAgreementActive(activeAgreement({ expiresAt: PAST }), NOW)).toBe(false);
    // The boundary itself: an agreement expiring exactly now is already over.
    expect(isAgreementActive(activeAgreement({ expiresAt: NOW }), NOW)).toBe(false);
  });
});

describe('agreementPermitsDestination — fail closed', () => {
  it('permits a listed destination, case-insensitively on the query side', () => {
    expect(agreementPermitsDestination(activeAgreement(), 'ES')).toBe(true);
    expect(agreementPermitsDestination(activeAgreement(), 'es')).toBe(true);
  });

  it('refuses an unlisted destination', () => {
    expect(agreementPermitsDestination(activeAgreement(), 'DE')).toBe(false);
  });

  it('an EMPTY list permits NOTHING — a grant that names no destination grants none', () => {
    expect(
      agreementPermitsDestination(activeAgreement({ permittedDestinationCountries: [] }), 'ES'),
    ).toBe(false);
  });
});

describe('agreementPermitsChannel — fail closed', () => {
  it('permits a listed channel and refuses an unlisted one', () => {
    expect(agreementPermitsChannel(activeAgreement(), 'mercaria_marketplace')).toBe(true);
    expect(agreementPermitsChannel(activeAgreement(), 'mercaria_branded_checkout')).toBe(false);
  });

  it('an EMPTY list permits no channel', () => {
    expect(
      agreementPermitsChannel(activeAgreement({ permittedChannels: [] }), 'mercaria_marketplace'),
    ).toBe(false);
  });
});

describe('agreementGrantsRetailDropship — the D2.10 conjunction', () => {
  it('grants only when every conjunct holds', () => {
    expect(agreementGrantsRetailDropship(activeAgreement())).toBe(true);
  });

  // One fixture per conjunct, each failing THAT conjunct alone — so dropping
  // any single `&&` from the implementation fails a named test.
  it.each([
    ['resaleRightsGranted', activeAgreement({ resaleRightsGranted: false })],
    ['dropshipRightsGranted', activeAgreement({ dropshipRightsGranted: false })],
    ['blindDropshipVerified', activeAgreement({ blindDropshipVerified: false })],
    ['dataProcessingTermsAccepted', activeAgreement({ dataProcessingTermsAccepted: false })],
  ])('refuses when %s alone is missing', (_name, agreement) => {
    expect(agreementGrantsRetailDropship(agreement)).toBe(false);
  });
});
