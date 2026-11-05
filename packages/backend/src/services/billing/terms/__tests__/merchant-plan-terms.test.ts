import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_MERCHANT_PLAN_TERMS_VERSION,
  MERCHANT_PLAN_TERMS,
  findMerchantPlanTerms,
  merchantPlanTermsPlaceholders,
  renderMerchantPlanTermsHtml,
} from '../merchant-plan-terms.js';

/**
 * A published version's text is what somebody agreed to. These hashes make an
 * edit to one a red build: a change is a NEW version (a new entry, named by a
 * new plan version), never an edit.
 */
const PUBLISHED_SHA256: Record<string, string> = {
  'merchant-plans-2026-11-05': '17107e7e89e0520b3d84937747e3113c5c95ecac623f7b41503b1f693bb6efa3',
};

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('merchant plan terms', () => {
  it('every published version is pinned, and none was edited', () => {
    expect(Object.keys(MERCHANT_PLAN_TERMS).sort()).toEqual(Object.keys(PUBLISHED_SHA256).sort());
    for (const [version, terms] of Object.entries(MERCHANT_PLAN_TERMS)) {
      expect(terms.version).toBe(version);
      expect(sha256(`${terms.title}\n${terms.effectiveOn}\n${terms.body}`), version).toBe(
        PUBLISHED_SHA256[version],
      );
    }
  });

  it('names the contracting entity and carries exactly the owner-completed placeholders', () => {
    const terms = findMerchantPlanTerms(CURRENT_MERCHANT_PLAN_TERMS_VERSION);
    if (!terms) throw new Error('missing current terms');
    expect(terms.body).toContain('Oxy Platforms, Inc.');
    expect(terms.body).toContain('seller of record');
    expect(merchantPlanTermsPlaceholders(terms)).toEqual([
      '[REGISTERED ADDRESS — TO BE COMPLETED BY THE OWNER]',
      '[GOVERNING LAW AND JURISDICTION — TO BE COMPLETED BY THE OWNER]',
    ]);
  });

  it('the current version exists', () => {
    expect(findMerchantPlanTerms(CURRENT_MERCHANT_PLAN_TERMS_VERSION)).toBeDefined();
    expect(findMerchantPlanTerms('__proto__')).toBeUndefined();
    expect(findMerchantPlanTerms('nope')).toBeUndefined();
  });

  it('renders escaped HTML with the version and its sections', () => {
    const terms = findMerchantPlanTerms(CURRENT_MERCHANT_PLAN_TERMS_VERSION);
    if (!terms) throw new Error('missing current terms');
    const html = renderMerchantPlanTermsHtml(terms);
    expect(html).toContain(`Version ${terms.version}`);
    expect(html).toContain('<h2>5. Cancelling</h2>');
    expect(html).toContain('<a href="https://oxy.so/transparency/legal">');
    expect(html).not.toMatch(/<script/i);
    const injected = renderMerchantPlanTermsHtml({
      ...terms,
      body: '<script>alert(1)</script>',
    });
    expect(injected).toContain('&lt;script&gt;');
    expect(injected).not.toContain('<script>');
  });
});
