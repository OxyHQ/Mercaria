/**
 * The pending-proposal publication gate (#367 step 6, ADR 0007 D9's last
 * paragraph).
 *
 * PURE — no database, no configuration, no clock — which is what makes it
 * testable without a server and what makes it impossible for the verdict to
 * depend on which deployment is asking.
 *
 * The property under test that matters most: the decision comes from the PRODUCT
 * TYPE VERSION's `pendingProposalPolicy` and from nothing else. There is no
 * parameter, flag or override that could produce the other answer, which is
 * D9's "versioned and reviewable rather than a per-request decision" as a
 * property of the signature.
 */

import { describe, expect, it } from 'vitest';
import type { AuthoringValidationResult } from '@mercaria/shared-types';
import {
  decidePendingProposalPublication,
  pendingProposalFindings,
  proposalNotPermittedFinding,
  withProposalFindings,
} from '../publication-gate.js';
import { assertEachOf } from '../../../__tests__/assert-each-of.js';

const CLEAN: AuthoringValidationResult = { publishable: true, findings: [], schemaEtag: 'etag-1' };

describe('decidePendingProposalPublication', () => {
  it('is CLEAR when nothing is pending, whatever the policy says', () => {
    assertEachOf(['block_publication', 'allow_local_claim'] as const, 2, (policy) => {
      expect(
        decidePendingProposalPublication({ pendingProposalPolicy: policy, openProposalIds: [] }),
      ).toEqual({ verdict: 'clear' });
    });
  });

  it('BLOCKS under `block_publication` and names the proposals', () => {
    const verdict = decidePendingProposalPublication({
      pendingProposalPolicy: 'block_publication',
      openProposalIds: ['p1', 'p2'],
    });
    expect(verdict).toEqual({ verdict: 'blocked', proposalIds: ['p1', 'p2'] });
  });

  it('PERMITS a local claim under `allow_local_claim` — ADR 0007 D7/D9', () => {
    const verdict = decidePendingProposalPublication({
      pendingProposalPolicy: 'allow_local_claim',
      openProposalIds: ['p1'],
    });
    expect(verdict).toEqual({ verdict: 'permitted_as_local_claim', proposalIds: ['p1'] });
  });

  it('copies the id list rather than aliasing the caller’s array', () => {
    const ids = ['p1'];
    const verdict = decidePendingProposalPublication({
      pendingProposalPolicy: 'block_publication',
      openProposalIds: ids,
    });
    ids.push('p2');
    expect(verdict.verdict === 'blocked' ? verdict.proposalIds : []).toEqual(['p1']);
  });
});

describe('pendingProposalFindings', () => {
  it('produces ONE error for a blocked draft, not one per proposal', () => {
    // A list of eleven identical errors on a form is a list nobody reads, and the
    // author's remedy is the same whichever pending value is named.
    const findings = pendingProposalFindings({
      verdict: 'blocked',
      proposalIds: ['a', 'b', 'c'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('proposal_pending_blocks_publication');
    expect(findings[0]?.severity).toBe('error');
  });

  it('produces NOTHING for a permitted local claim — not even a warning', () => {
    // A warning would be a sentence saying something is wrong about a publication
    // the versioned policy permits.
    expect(
      pendingProposalFindings({ verdict: 'permitted_as_local_claim', proposalIds: ['a'] }),
    ).toEqual([]);
    expect(pendingProposalFindings({ verdict: 'clear' })).toEqual([]);
  });
});

describe('withProposalFindings', () => {
  it('returns the SAME result object when there is nothing to add', () => {
    expect(withProposalFindings(CLEAN, [])).toBe(CLEAN);
  });

  it('makes a clean result UNPUBLISHABLE when an error is added', () => {
    const merged = withProposalFindings(
      CLEAN,
      pendingProposalFindings({ verdict: 'blocked', proposalIds: ['p1'] }),
    );
    expect(merged.publishable).toBe(false);
    expect(merged.findings).toHaveLength(1);
    expect(merged.schemaEtag).toBe('etag-1');
  });

  it('leaves a result publishable when only warnings are added', () => {
    const merged = withProposalFindings(CLEAN, [
      { code: 'schema_version_superseded', severity: 'warning', path: 'draft.schemaEtag' },
    ]);
    expect(merged.publishable).toBe(true);
  });

  it('never RESTORES publishability that the base result had already lost', () => {
    // The recomputation is over the WHOLE finding list, so a base result carrying
    // an error stays unpublishable however benign the additions are. Reversing
    // this — trusting the base flag and OR-ing in the additions — is the shape
    // that would publish a draft whose price was missing.
    const failing: AuthoringValidationResult = {
      publishable: false,
      findings: [{ code: 'price_missing', severity: 'error', path: 'variants[0].price' }],
      schemaEtag: 'etag-1',
    };
    const merged = withProposalFindings(failing, [
      { code: 'schema_version_superseded', severity: 'warning', path: 'draft.schemaEtag' },
    ]);
    expect(merged.publishable).toBe(false);
  });
});

describe('proposalNotPermittedFinding', () => {
  it('names the field and the attribute, and carries no sentence', () => {
    const finding = proposalNotPermittedFinding('fields.colour', {
      fieldId: 'f1',
      attributeKey: 'colour',
    });
    expect(finding).toEqual({
      code: 'proposal_not_permitted',
      severity: 'error',
      path: 'fields.colour',
      fieldId: 'f1',
      attributeKey: 'colour',
    });
    // ADR 0007 D10: a client never matches on message text, so there is no
    // `message` property to fill in.
    expect('message' in finding).toBe(false);
  });
});
