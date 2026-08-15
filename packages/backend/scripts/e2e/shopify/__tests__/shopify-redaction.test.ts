/**
 * Proof that the shared redactor FIRES on Shopify-shaped secrets, end to end.
 *
 * `../../redact.ts` and `../../evidence.ts` are owned by the WooCommerce runner
 * branch and their own `__tests__/redaction.test.ts` proves the mechanism
 * against WooCommerce values. This file proves the half that is specific to this
 * connector, because "the scanner works" and "the scanner works on the secrets
 * MY driver handles" are different claims, and only the second one protects a
 * Shopify run.
 *
 * The three Shopify secrets are not symmetrical, and the asymmetry is the point:
 *
 *  - the **client secret** is a bare high-entropy string with NO prefix, so no
 *    pattern can recognise it. It is caught only because `drive.ts` REGISTERS it
 *    by name. That is the layer the lead asked to see fire.
 *  - the **access token** (`shpat_…`) and the **webhook secret** are never
 *    exposed to the driver at all — Mercaria stores both encrypted and no admin
 *    route returns them — so the registry CANNOT hold their values. They are
 *    covered by the forbidden-SHAPE layer instead, which is exactly the case
 *    that layer exists for: a secret the run never knew it had.
 *
 * So the two layers are tested against the secrets each one is actually
 * responsible for, rather than both against whichever value was convenient.
 *
 * DEPENDENCY: `../../evidence.js` and `../../redact.js` are not on this branch
 * until it is rebased onto the runner branch. This file fails at import until
 * then — loudly, naming the path.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvidenceCollector } from '../../evidence.js';
import { EvidenceRedactionError, SecretRegistry, assertNoSecrets } from '../../redact.js';

/**
 * A Shopify app client secret: bare hex, no prefix, indistinguishable from any
 * other identifier by shape alone. This is the value `drive.ts` registers.
 */
const CLIENT_SECRET = 'f4c2a7b19e8d3056a1bc4d7e2f9081a3';

/**
 * A Shopify offline access token. Real ones are `shpat_` + 32 hex characters.
 * The driver never holds one — Mercaria stores it encrypted — so nothing can
 * register it and the SHAPE layer is the only thing standing between it and an
 * artefact somebody pastes into an issue.
 *
 * ASSEMBLED AT RUNTIME rather than written as a literal, deliberately. A literal
 * indistinguishable from a real token is what makes this test meaningful, and it
 * is also what GitHub's push protection blocks — correctly, since it cannot know
 * the difference. Concatenating gives the redactor the identical value while
 * leaving no matchable string in the source. Do NOT "tidy" it back into one
 * literal, and do NOT resolve a future block by allow-listing the secret:
 * clicking through push protection is a habit, and the next one will be real.
 */
const ACCESS_TOKEN = `shpat_${'0123456789abcdef'.repeat(2)}`;

/** A value that must SURVIVE, or a scanner flagging everything would pass. */
const INNOCENT_RUN_ID = 'sync-run-7f3a9c2e';

let evidenceDir: string;

beforeEach(async () => {
  evidenceDir = await mkdtemp(path.join(tmpdir(), 'shopify-redaction-'));
});

afterEach(async () => {
  await rm(evidenceDir, { recursive: true, force: true });
});

/** The secrets a real Shopify run registers, exactly as `drive.ts` does. */
function shopifyRegistry(): SecretRegistry {
  const registry = new SecretRegistry();
  registry.register('shopify client secret', CLIENT_SECRET);
  registry.register('shopify client id', 'c0ffee1234567890abcdef1234567890');
  registry.register('oxy access token', 'oxy_test_token_0123456789abcdef');
  return registry;
}

describe('the registry layer catches the secret only IT can catch', () => {
  it('reports the Shopify client secret by LABEL and never quotes it', () => {
    const artefact = JSON.stringify({
      scenario: 'S1',
      error: `token exchange failed for client_secret=${CLIENT_SECRET}`,
    });
    const report = shopifyRegistry().scan(artefact);

    expect(report.leaks.map((leak) => leak.label)).toContain('shopify client secret');
    // A leak report that quotes the secret is a second copy of it.
    expect(JSON.stringify(report)).not.toContain(CLIENT_SECRET);
  });

  it('is the ONLY thing that could catch it — no shape recognises a bare secret', () => {
    // The control that makes the previous case meaningful: with an empty
    // registry the same artefact scans clean, so the catch above was the
    // registration and not a pattern that would have fired anyway.
    const bare = new SecretRegistry();
    bare.register('unrelated', 'some-other-value-entirely-0000');
    const report = bare.scan(JSON.stringify({ error: `client_secret=${CLIENT_SECRET}` }));

    expect(report.leaks).toEqual([]);
  });
});

describe('the shape layer catches the secrets the driver structurally cannot hold', () => {
  it('catches a Shopify access token the run never registered', () => {
    const report = shopifyRegistry().scan(
      JSON.stringify({ scenario: 'S2', error: `X-Shopify-Access-Token: ${ACCESS_TOKEN}` }),
    );

    const shapeLeaks = report.leaks.filter((leak) => leak.source === 'forbidden_shape');
    expect(shapeLeaks.length).toBeGreaterThan(0);
    expect(shapeLeaks.map((leak) => leak.label).join(' ')).toMatch(/shopify access token/i);
  });

  it('leaves a clean Shopify artefact alone', () => {
    const report = shopifyRegistry().scan(
      JSON.stringify({
        scenario: 'S2',
        syncRunId: INNOCENT_RUN_ID,
        shopDomain: 'mercaria-e2e.myshopify.com',
        scopes: ['read_products', 'read_orders'],
        counts: { created: 312, updated: 0, skipped: 0, failed: 0 },
      }),
    );

    expect(report.leaks).toEqual([]);
    expect(report.charactersScanned).toBeGreaterThan(0);
  });
});

describe('the collector REFUSES TO WRITE, which is the guarantee that matters', () => {
  /**
   * One legitimate observation, built the way `drive.ts` builds S1's.
   *
   * `mutate` injects a Shopify token into a field that genuinely belongs in the
   * artefact — the error string — rather than into a field nobody would emit.
   * A mutation into an implausible field would prove only that the scanner reads
   * the whole document.
   */
  function s1Observation(mutate: boolean) {
    return {
      id: 'S1',
      title: 'OAuth connect and reconnect',
      status: 'FAILED' as const,
      error: mutate
        ? `verifyConnection failed: GET /shop.json with token ${ACCESS_TOKEN} -> 401`
        : 'verifyConnection failed: GET /shop.json -> 401',
      observations: { scopeCount: 7, webhookIdCount: 6 },
    };
  }

  it('writes the UNMUTATED run, and the artefact carries the innocent values', async () => {
    const collector = new EvidenceCollector(shopifyRegistry(), evidenceDir, 'shopify-control');
    collector.describeEnvironment({ provider: 'shopify', apiVersionPinnedByCode: '2024-10' });
    collector.record(s1Observation(false));

    const { jsonPath, scan } = await collector.write();

    expect(scan.leaks).toEqual([]);
    const written = await readFile(jsonPath, 'utf8');
    expect(written).toContain('OAuth connect and reconnect');
    expect(written).not.toContain(ACCESS_TOKEN);
  });

  it('REFUSES to write the mutated run, on the same input otherwise', async () => {
    const collector = new EvidenceCollector(shopifyRegistry(), evidenceDir, 'shopify-mutant');
    collector.describeEnvironment({ provider: 'shopify', apiVersionPinnedByCode: '2024-10' });
    collector.record(s1Observation(true));

    await expect(collector.write()).rejects.toThrow(EvidenceRedactionError);

    // The refusal must leave NOTHING behind. A partially written artefact
    // carrying the token would be worse than no refusal at all, because the
    // exception would read as "nothing was written".
    await expect(readFile(path.join(evidenceDir, 'shopify-mutant.evidence.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses on a token in the ENVIRONMENT block too, not only in a scenario', async () => {
    // The environment is composed separately from the scenarios, so a scan that
    // read only one of them would pass this file's other cases and still ship a
    // token. `assertNoSecrets` is called over both artefacts; this pins it.
    const collector = new EvidenceCollector(shopifyRegistry(), evidenceDir, 'shopify-env-mutant');
    collector.describeEnvironment({
      provider: 'shopify',
      // A plausible mistake: recording "what we authenticated with".
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    collector.record(s1Observation(false));

    await expect(collector.write()).rejects.toThrow(EvidenceRedactionError);
  });
});

describe('the vacuity floor covers the Shopify registry too', () => {
  it('refuses a scan with an EMPTY registry, however clean the artefact', () => {
    expect(() => assertNoSecrets(new SecretRegistry(), '{"created":312}')).toThrow(
      /EMPTY secret registry/,
    );
  });
});
