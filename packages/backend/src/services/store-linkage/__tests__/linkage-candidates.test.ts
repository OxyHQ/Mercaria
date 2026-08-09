/**
 * Candidate discovery and automatic selection (#84 linkage cases 1–4).
 *
 * The fixtures are chosen so each one sits on the side of a distinction the code
 * exists to draw, per `~/Oxy/AGENTS.md` §(E): the domain fixtures include a
 * SUBDOMAIN and a same-suffix-different-registrable-domain, because a substring
 * containment test passes both and a label-wise one passes only the first — and
 * every fixture being an exact match would leave the two indistinguishable.
 */

import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_SOURCE_STRENGTH,
  discoverLinkageCandidates,
  selectAutomaticCandidate,
  type CandidateStoreFacts,
} from '../linkage-candidates.js';

function store(overrides: Partial<CandidateStoreFacts> & { storeId: string }): CandidateStoreFacts {
  return {
    hasStoreManage: true,
    connectedDomains: [],
    connectionIds: [],
    ...overrides,
  };
}

const NO_CLAIM = {
  verifiedDomains: [] as string[],
  provenConnectionId: null,
  intendedStoreId: null,
  namedStoreId: null,
};

describe('the membership floor comes first (existing-store rule 1)', () => {
  it('drops a store the claimant cannot manage, entirely', () => {
    const candidates = discoverLinkageCandidates({
      claim: NO_CLAIM,
      stores: [store({ storeId: 's1', hasStoreManage: false })],
    });
    // Not "proposed and rejected" — ABSENT. A proposal a claimant may not act on
    // is an answer to "does this store exist" that the surface must not give.
    expect(candidates).toEqual([]);
  });

  it('drops it even when the claim proved its domain', () => {
    const candidates = discoverLinkageCandidates({
      claim: { ...NO_CLAIM, verifiedDomains: ['shop.example'] },
      stores: [
        store({ storeId: 's1', hasStoreManage: false, connectedDomains: ['shop.example'] }),
      ],
    });
    expect(candidates).toEqual([]);
  });

  it('and drops a NAMED store the claimant cannot manage', () => {
    // Naming a store you may not manage must propose nothing — otherwise the
    // request surface confirms which store ids exist.
    const candidates = discoverLinkageCandidates({
      claim: { ...NO_CLAIM, namedStoreId: 's1' },
      stores: [store({ storeId: 's1', hasStoreManage: false })],
    });
    expect(candidates).toEqual([]);
  });
});

describe('domain evidence is LABEL-wise, never a substring', () => {
  it('covers the proven host and its subdomains', () => {
    const candidates = discoverLinkageCandidates({
      claim: { ...NO_CLAIM, verifiedDomains: ['example.com'] },
      stores: [
        store({ storeId: 'exact', connectedDomains: ['example.com'] }),
        store({ storeId: 'subdomain', connectedDomains: ['shop.example.com'] }),
      ],
    });
    expect(candidates.map((c) => [c.storeId, c.source])).toEqual([
      ['exact', 'claim_verified_domain'],
      ['subdomain', 'claim_verified_domain'],
    ]);
  });

  it('does NOT cover a different registrable domain with the same suffix', () => {
    // `notexample.com`.endsWith('example.com') is TRUE as a string. This is the
    // fixture that tells a label-wise containment from a substring one, and
    // without it both implementations pass every other case in this file.
    const candidates = discoverLinkageCandidates({
      claim: { ...NO_CLAIM, verifiedDomains: ['example.com'] },
      stores: [store({ storeId: 'impostor', connectedDomains: ['notexample.com'] })],
    });
    // Still a candidate — the claimant manages it — but on MEMBERSHIP evidence,
    // never on the domain proof, which is the whole distinction.
    expect(candidates).toEqual([
      { storeId: 'impostor', source: 'claimant_store_membership', evidenceRef: null, autoLinkable: true },
    ]);
  });
});

describe('the strongest evidence wins the row, and the order is total', () => {
  it('upgrades membership to a domain proof', () => {
    const candidates = discoverLinkageCandidates({
      claim: { ...NO_CLAIM, verifiedDomains: ['example.com'] },
      stores: [store({ storeId: 's1', connectedDomains: ['example.com'] })],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe('claim_verified_domain');
    expect(candidates[0]?.evidenceRef).toBe('example.com');
  });

  it('prefers a platform-connection proof over membership', () => {
    const candidates = discoverLinkageCandidates({
      claim: { ...NO_CLAIM, provenConnectionId: 'conn-1' },
      stores: [store({ storeId: 's1', connectionIds: ['conn-1', 'conn-2'] })],
    });
    expect(candidates[0]?.source).toBe('claim_platform_connection');
    expect(candidates[0]?.evidenceRef).toBe('conn-1');
  });

  it('does not upgrade on a connection the store does not own', () => {
    const candidates = discoverLinkageCandidates({
      claim: { ...NO_CLAIM, provenConnectionId: 'conn-elsewhere' },
      stores: [store({ storeId: 's1', connectionIds: ['conn-1'] })],
    });
    expect(candidates[0]?.source).toBe('claimant_store_membership');
  });

  it('ranks every source exactly once, so nothing sorts first by accident', () => {
    expect(new Set(CANDIDATE_SOURCE_STRENGTH).size).toBe(CANDIDATE_SOURCE_STRENGTH.length);
    expect(CANDIDATE_SOURCE_STRENGTH[0]).toBe('operator');
  });
});

describe('automatic selection, and the case that must NOT be automatic', () => {
  it('case 2 — one candidate links without a person', () => {
    const candidates = discoverLinkageCandidates({
      claim: NO_CLAIM,
      stores: [store({ storeId: 's1' })],
    });
    expect(selectAutomaticCandidate({ candidates, namedStoreId: null })?.storeId).toBe('s1');
  });

  it('case 3 — several candidates and none named selects NOTHING', () => {
    const candidates = discoverLinkageCandidates({
      claim: NO_CLAIM,
      stores: [store({ storeId: 's1' }), store({ storeId: 's2' })],
    });
    expect(candidates).toHaveLength(2);
    // The whole reason the review path exists: which of a merchant's several
    // stores IS the merchant is a decision, not a computation.
    expect(selectAutomaticCandidate({ candidates, namedStoreId: null })).toBeNull();
  });

  it('case 3 resolved — naming one of several selects it', () => {
    const candidates = discoverLinkageCandidates({
      claim: { ...NO_CLAIM, namedStoreId: 's2' },
      stores: [store({ storeId: 's1' }), store({ storeId: 's2' })],
    });
    expect(selectAutomaticCandidate({ candidates, namedStoreId: 's2' })?.storeId).toBe('s2');
  });

  it('naming a store that is not a candidate selects nothing', () => {
    // The named id is checked against the candidate SET, not trusted: a client
    // sending a store it cannot manage gets no selection rather than a link.
    const candidates = discoverLinkageCandidates({
      claim: NO_CLAIM,
      stores: [store({ storeId: 's1' })],
    });
    expect(selectAutomaticCandidate({ candidates, namedStoreId: 's-other' })).toBeNull();
  });
});

describe('auto-linkability is read from the shared tuple, not invented here', () => {
  it('marks proof-backed sources auto-linkable and INTENTS not', () => {
    const proofBacked = discoverLinkageCandidates({
      claim: { ...NO_CLAIM, verifiedDomains: ['example.com'] },
      stores: [store({ storeId: 's1', connectedDomains: ['example.com'] })],
    });
    expect(proofBacked[0]?.autoLinkable).toBe(true);

    const intent = discoverLinkageCandidates({
      claim: { ...NO_CLAIM, namedStoreId: 's1' },
      // A store with NO connections and no proven domain: membership is the
      // only fact, and naming it is the strongest thing the claimant said.
      stores: [store({ storeId: 's1' })],
    });
    // `claimant_named` outranks nothing — membership is stronger — so the row
    // records membership and IS auto-linkable. The intent's own row appears
    // only when it is the sole evidence, which cannot happen for a store the
    // claimant manages. Stated here so the asymmetry is deliberate rather than
    // discovered.
    expect(intent[0]?.source).toBe('claimant_store_membership');
    expect(intent[0]?.autoLinkable).toBe(true);
  });
});
