/**
 * The site proofs' two halves: SSRF refusal, and reading a proof off a page.
 *
 * ## The SSRF cases are REAL, not mocked
 *
 * Every address below is an IP literal, so `assertSafePublicUrl` decides
 * without a DNS lookup and the test needs no network, no fixture server and no
 * mock of the thing under test. That matters: a mocked `safeFetch` would prove
 * that a fake refused a fake, which is exactly the shape `~/Oxy/AGENTS.md`
 * calls a check that cannot distinguish success from failure. Here the real
 * guard refuses the real address, and the code path being exercised is the one
 * production runs.
 *
 * A hostname-based case is deliberately absent: it would resolve through
 * whatever resolver the runner has, which makes the outcome a property of the
 * environment rather than of the code.
 */

import { describe, expect, it } from 'vitest';
import {
  claimDnsRecordName,
  claimDnsRecordValue,
  claimSiteRootUrl,
  claimWellKnownUrl,
  metaTagCarriesToken,
  verifyMetaTagChallenge,
  verifyWellKnownFileChallenge,
} from '../site-verification.js';
import {
  CLAIM_WELL_KNOWN_PATH,
  hasChallengeTokenShape,
  hashChallengeToken,
  challengeTokenMatches,
  mintChallengeToken,
} from '../challenge-token.js';

/**
 * Addresses a verification fetch must never reach. Loopback, the two private
 * ranges an ECS task actually sits in, link-local, and the cloud metadata
 * endpoint — the one whose disclosure is a credential compromise rather than
 * an information leak.
 */
const BLOCKED_TARGETS = ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '[::1]'];

describe('site verification refuses to fetch a non-public address (issue security 3)', () => {
  it('refuses every private, loopback, link-local and metadata target', async () => {
    // The floor: an emptied list would make this loop assert nothing.
    expect(BLOCKED_TARGETS.length).toBeGreaterThan(4);
    for (const target of BLOCKED_TARGETS) {
      const outcome = await verifyWellKnownFileChallenge({
        domain: target,
        expectedToken: 'mcc_whatever',
      });
      expect(outcome, `${target} must be refused before any connection`).toBe('blocked_address');
    }
  }, 30_000);

  it('refuses the same targets on the meta-tag path', async () => {
    for (const target of ['127.0.0.1', '169.254.169.254']) {
      const outcome = await verifyMetaTagChallenge({
        domain: target,
        expectedToken: 'mcc_whatever',
      });
      expect(outcome).toBe('blocked_address');
    }
  }, 20_000);

  it('builds https URLs only — there is no http path to downgrade to', () => {
    expect(claimWellKnownUrl('example.com')).toBe(`https://example.com${CLAIM_WELL_KNOWN_PATH}`);
    expect(claimSiteRootUrl('example.com')).toBe('https://example.com/');
  });
});

describe('the published proof values', () => {
  it('puts the DNS record under an underscore label that cannot collide with a host', () => {
    expect(claimDnsRecordName('example.com')).toBe('_mercaria-challenge.example.com');
  });

  it('prefixes the TXT value, so an unrelated TXT record cannot satisfy it', () => {
    expect(claimDnsRecordValue('mcc_abc')).toBe('mercaria-merchant-verification=mcc_abc');
  });
});

describe('reading a meta tag off a page', () => {
  const token = 'mcc_TOKEN123';

  it('accepts the tag with either attribute order and either quote style', () => {
    expect(
      metaTagCarriesToken(
        `<html><head><meta name="mercaria-merchant-verification" content="${token}"></head></html>`,
        token,
      ),
    ).toBe(true);
    expect(
      metaTagCarriesToken(
        `<meta content='${token}' name='mercaria-merchant-verification'>`,
        token,
      ),
    ).toBe(true);
  });

  it('refuses a DIFFERENT token in the right tag', () => {
    expect(
      metaTagCarriesToken(
        '<meta name="mercaria-merchant-verification" content="mcc_SOMEONE_ELSE">',
        token,
      ),
    ).toBe(false);
  });

  it('refuses the right token in a DIFFERENT tag', () => {
    // The mistake this catches: searching the body for the token, which a
    // forum post, a support article or an error page echoing the URL would
    // satisfy.
    expect(metaTagCarriesToken(`<meta name="description" content="${token}">`, token)).toBe(false);
    expect(metaTagCarriesToken(`<p>our verification code is ${token}</p>`, token)).toBe(false);
  });

  it('finds the tag among many', () => {
    const html =
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width">' +
      `<meta name="mercaria-merchant-verification" content="${token}">`;
    expect(metaTagCarriesToken(html, token)).toBe(true);
  });
});

describe('challenge tokens are random, hashed, and compared in constant time', () => {
  it('mints a distinct token every time and stores only its digest', () => {
    const a = mintChallengeToken();
    const b = mintChallengeToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
    // The digest is not the token, and is not reversible to it.
    expect(a.tokenHash).not.toContain(a.token);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tokenHash).toBe(hashChallengeToken(a.token));
  });

  it('accepts its own token and refuses another challenge’s (issue acceptance 3)', () => {
    const mine = mintChallengeToken();
    const theirs = mintChallengeToken();
    expect(challengeTokenMatches(mine.token, mine.tokenHash)).toBe(true);
    // A token stolen from another claim's DNS record does not verify this one.
    expect(challengeTokenMatches(theirs.token, mine.tokenHash)).toBe(false);
  });

  it('rejects a malformed token on shape, before any comparison', () => {
    expect(hasChallengeTokenShape(mintChallengeToken().token)).toBe(true);
    expect(hasChallengeTokenShape('')).toBe(false);
    expect(hasChallengeTokenShape('mcc_short')).toBe(false);
    expect(hasChallengeTokenShape('mck_0000000000000000000000000000000000000000000')).toBe(false);
  });
});
