/**
 * The remedy derivation and the sealing boundary (#1016 Workstreams 12 and 19,
 * ADR 0011 D10/D11).
 *
 * Two modules in one file because they are the two halves of the same question —
 * what may be done about a purchase, and what may be read of it — and because
 * both are pure enough to drive exhaustively.
 */

import { describe, expect, it } from 'vitest';
import { DIGITAL_REMEDY_REASONS } from '@mercaria/shared-types';
import { deriveDigitalRemedy, type RemedyFacts } from '../remedy.js';
import {
  SEAL_ALGORITHM,
  artifactDigestMatches,
  environmentKeyResolver,
  maskedHintFor,
  sealArtifactSecret,
  unsealArtifactSecret,
} from '../secrets.js';

/** A delivered, unrevealed activation key — the most common live state. */
function facts(overrides: Partial<RemedyFacts> = {}): RemedyFacts {
  return {
    purchaseOrderStatus: 'fulfilled',
    fulfilmentStatus: 'delivered',
    capability: 'activation_key',
    artifactDelivered: true,
    revealed: false,
    redemptionState: 'unknown',
    buyerReportedFault: false,
    replacementSupported: true,
    withdrawalWaived: false,
    ...overrides,
  };
}

describe('remedies before anything was bought', () => {
  it('cancels for free when procurement has not started', () => {
    const verdict = deriveDigitalRemedy(
      facts({ purchaseOrderStatus: null, fulfilmentStatus: null, artifactDelivered: false }),
    );
    expect(verdict.outcome).toBe('cancel_before_procurement');
  });

  it('asks the SUPPLIER to cancel while an order is in flight', () => {
    expect(
      deriveDigitalRemedy(
        facts({ purchaseOrderStatus: 'submitting', fulfilmentStatus: null, artifactDelivered: false }),
      ).outcome,
    ).toBe('cancel_procurement');
  });

  it('sends an AMBIGUOUS attempt to a human rather than guessing either way', () => {
    // Refunding now is defensible and buying again is not, and the recovery sweep
    // may resolve it within the minute. That is a decision, not an algorithm.
    const verdict = deriveDigitalRemedy(
      facts({ purchaseOrderStatus: 'ambiguous', fulfilmentStatus: null, artifactDelivered: false }),
    );
    expect(verdict.outcome).toBe('manual_review');
    expect(verdict.reasons).toContain('procurement_outcome_unknown');
  });

  it('refunds outright when procurement failed, whatever the buyer waived', () => {
    // A waiver waives a change of mind, not a delivery that never happened.
    for (const status of ['rejected', 'failed', 'cancelled'] as const) {
      const verdict = deriveDigitalRemedy(
        facts({
          purchaseOrderStatus: status,
          fulfilmentStatus: null,
          artifactDelivered: false,
          withdrawalWaived: true,
        }),
      );
      expect(verdict.outcome).toBe('refund_customer');
    }
  });
});

describe('the reveal / redemption distinction — ADR 0011 D10', () => {
  it('refunds a delivered key the buyer never looked at', () => {
    expect(deriveDigitalRemedy(facts()).outcome).toBe('refund_customer');
  });

  it('sends a REVEALED key with an unknown redemption state to a human', () => {
    const verdict = deriveDigitalRemedy(facts({ revealed: true, withdrawalWaived: true }));
    expect(verdict.outcome).toBe('manual_review');
    expect(verdict.reasons).toContain('artifact_revealed');
  });

  it('refunds a revealed key the ecosystem says is UNREDEEMED', () => {
    // This is the whole reason both facts exist: looked at is not used.
    expect(
      deriveDigitalRemedy(
        facts({ revealed: true, withdrawalWaived: true, redemptionState: 'unredeemed' }),
      ).outcome,
    ).toBe('refund_customer');
  });

  it('refuses a REDEEMED key', () => {
    const verdict = deriveDigitalRemedy(
      facts({ revealed: true, redemptionState: 'redeemed', withdrawalWaived: true }),
    );
    expect(verdict.outcome).toBe('not_eligible');
    expect(verdict.reasons).toContain('artifact_redeemed');
  });
});

describe('a reported fault outranks everything below it', () => {
  it('replaces when the rider says the supplier will', () => {
    const verdict = deriveDigitalRemedy(
      facts({ revealed: true, buyerReportedFault: true, replacementSupported: true }),
    );
    expect(verdict.outcome).toBe('replace_artifact');
  });

  it('falls back to a supplier credit when it will not', () => {
    expect(
      deriveDigitalRemedy(
        facts({ revealed: true, buyerReportedFault: true, replacementSupported: false }),
      ).outcome,
    ).toBe('supplier_credit_pending');
  });

  it('treats an ecosystem `invalid` verdict the same as a buyer report', () => {
    expect(
      deriveDigitalRemedy(facts({ revealed: true, redemptionState: 'invalid' })).outcome,
    ).toBe('replace_artifact');
  });
});

describe('capabilities that hand over no secret', () => {
  it('cannot be “revealed”, so their remedy turns on the activation instead', () => {
    const unactivated = deriveDigitalRemedy(
      facts({ capability: 'direct_account_activation', redemptionState: 'unredeemed' }),
    );
    expect(unactivated.outcome).toBe('refund_customer');

    const activated = deriveDigitalRemedy(
      facts({ capability: 'direct_account_activation', redemptionState: 'unknown' }),
    );
    expect(activated.outcome).toBe('manual_review');
  });
});

describe('the remedy vocabulary', () => {
  it('never produces an empty reason list, and only declared members', () => {
    const cases: RemedyFacts[] = [
      facts(),
      facts({ purchaseOrderStatus: null, artifactDelivered: false }),
      facts({ fulfilmentStatus: 'refunded' }),
      facts({ revealed: true, redemptionState: 'redeemed' }),
      facts({ buyerReportedFault: true }),
    ];
    for (const candidate of cases) {
      const verdict = deriveDigitalRemedy(candidate);
      expect(verdict.reasons.length).toBeGreaterThan(0);
      for (const reason of verdict.reasons) expect(DIGITAL_REMEDY_REASONS).toContain(reason);
    }
  });

  it('refuses a second refund', () => {
    const verdict = deriveDigitalRemedy(facts({ fulfilmentStatus: 'refunded' }));
    expect(verdict.outcome).toBe('not_eligible');
    expect(verdict.reasons).toContain('already_refunded');
  });
});

/* -------------------------------------------------------------------------- */

const KEY_REFERENCE = '/oxy/mercaria/digital-retail/seal/test';
const RESOLVER = environmentKeyResolver({
  DIGITAL_RETAIL_SEAL_KEY_TEST: Buffer.alloc(32, 7).toString('base64'),
} as NodeJS.ProcessEnv);

describe('sealing an artifact', () => {
  it('round-trips, and the ciphertext does not contain the plaintext', async () => {
    const sealed = await sealArtifactSecret('ABCD-EFGH-IJKL-1234', KEY_REFERENCE, RESOLVER);
    expect(sealed.sealAlgorithm).toBe(SEAL_ALGORITHM);
    expect(sealed.sealedSecret).not.toContain('ABCD');
    expect(await unsealArtifactSecret(sealed.sealedSecret, KEY_REFERENCE, RESOLVER)).toBe(
      'ABCD-EFGH-IJKL-1234',
    );
  });

  it('produces a different ciphertext every time for one plaintext', async () => {
    // A deterministic ciphertext would let anyone holding the table see which
    // buyers were sold the same key — and for a key marketplace that is the whole
    // inventory, visible by equality.
    const first = await sealArtifactSecret('SAME-KEY', KEY_REFERENCE, RESOLVER);
    const second = await sealArtifactSecret('SAME-KEY', KEY_REFERENCE, RESOLVER);
    expect(first.sealedSecret).not.toBe(second.sealedSecret);
    expect(first.plaintextSha256).toBe(second.plaintextSha256);
  });

  it('THROWS on a tampered ciphertext rather than returning garbage', async () => {
    // The reason for GCM: a key that decrypts to plausible nonsense is one a
    // support agent reads out to a customer.
    const sealed = await sealArtifactSecret('ABCD-EFGH', KEY_REFERENCE, RESOLVER);
    const [version, iv, tag, ciphertext] = sealed.sealedSecret.split(':');
    const flipped = Buffer.from(ciphertext!, 'base64');
    flipped[0] ^= 0xff;
    await expect(
      unsealArtifactSecret(
        [version, iv, tag, flipped.toString('base64')].join(':'),
        KEY_REFERENCE,
        RESOLVER,
      ),
    ).rejects.toThrow();
  });

  it('refuses a raw key where a secret-store PATH belongs', async () => {
    await expect(
      sealArtifactSecret('ABCD-EFGH', 'sk_live_51Habc123SECRET', RESOLVER),
    ).rejects.toThrow(/secret-store path/i);
  });

  it('refuses an empty secret: seal nothing, store nothing', async () => {
    await expect(sealArtifactSecret('   ', KEY_REFERENCE, RESOLVER)).rejects.toThrow();
  });

  it('FAILS CLOSED when the deployment has no key configured', async () => {
    const empty = environmentKeyResolver({} as NodeJS.ProcessEnv);
    await expect(sealArtifactSecret('ABCD-EFGH', KEY_REFERENCE, empty)).rejects.toThrow(
      /no sealing key configured/,
    );
  });

  it('refuses a key reference outside this domain’s own prefix', async () => {
    await expect(
      sealArtifactSecret('ABCD-EFGH', '/oxy/mercaria/suppliers/acme/api-key', RESOLVER),
    ).rejects.toThrow(/must live under/);
  });
});

describe('the masked hint', () => {
  it('is the TAIL of the secret, never its head', () => {
    // A leading hint distinguishes nothing: keys of one batch share their prefix.
    expect(maskedHintFor('STEAM-EU-ABCD-WXYZ')).toBe('WXYZ');
  });

  it('is at most four characters', () => {
    expect(maskedHintFor('A'.repeat(64))).toHaveLength(4);
  });

  it('handles a secret shorter than the hint without padding it', () => {
    expect(maskedHintFor('AB')).toBe('AB');
  });
});

describe('matching a customer’s key without revealing either', () => {
  it('matches the digest of the same plaintext', async () => {
    const sealed = await sealArtifactSecret('ABCD-EFGH', KEY_REFERENCE, RESOLVER);
    expect(artifactDigestMatches('ABCD-EFGH', sealed.plaintextSha256)).toBe(true);
    expect(artifactDigestMatches('ABCD-EFGI', sealed.plaintextSha256)).toBe(false);
  });

  it('answers false for a malformed stored digest rather than throwing', () => {
    expect(artifactDigestMatches('ABCD-EFGH', 'not-a-digest')).toBe(false);
  });
});
