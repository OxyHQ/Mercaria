/**
 * Snapshot and delta expiry semantics, tested SEPARATELY (#63 processing 6 and
 * 7, acceptance 6).
 *
 * The issue asks for the two to be "tested separately", and the reason is that
 * the failures are opposite and both silent: reading a delta's omission as a
 * deletion retires a healthy catalogue on the first successful pass, and
 * refusing to read a snapshot's omission leaves delisted products on sale
 * forever. A single parameterised case would pass with either rule inverted.
 *
 * #62 already owns the retirement DECISION (`CATALOG_SOURCE_RETIRING_OUTCOMES`
 * plus `catalog_source_runs_retirement_check`, exercised end to end by the
 * adapter contract suite). What is tested here is the input #63 supplies to it:
 * whether a pass may claim the completed enumeration that rule reads.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEED_DELIVERY_MODES } from '@mercaria/shared-types';
import { feedCompletionVerdict, mayReportCompleteEnumeration } from '../completion.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('a SNAPSHOT feed', () => {
  it('may claim a completed enumeration when the read reached the end', () => {
    const verdict = feedCompletionVerdict('snapshot', true);
    expect(verdict).toEqual({ deliveryMode: 'snapshot', enumeratedFully: true });
    expect(mayReportCompleteEnumeration(verdict)).toBe(true);
  });

  it('may NOT when the read stopped at a cap or a sample limit', () => {
    // Every cap in `bytes.ts` refuses rather than truncating for this reason:
    // a truncation that reported completion is this failure wearing a success.
    expect(mayReportCompleteEnumeration(feedCompletionVerdict('snapshot', false))).toBe(false);
  });
});

describe('a DELTA feed', () => {
  it('can never claim a completed enumeration, whatever the read did', () => {
    for (const enumeratedFully of [true, false]) {
      expect(mayReportCompleteEnumeration(feedCompletionVerdict('delta', enumeratedFully))).toBe(
        false,
      );
    }
  });

  it('has NO representation for one: the branch carries no such member', () => {
    // The structural half. `FeedCompletionVerdict`'s delta branch has no
    // `enumeratedFully`, so "a delta feed must never expire omitted records" is
    // a fact about the type rather than a branch somebody remembered to write.
    const verdict = feedCompletionVerdict('delta', true);
    expect(Object.keys(verdict)).toEqual(['deliveryMode']);
    expect('enumeratedFully' in verdict).toBe(false);
  });
});

describe('the rule is reachable only through this ONE function', () => {
  it('the adapter reads the verdict and never a boolean of its own', () => {
    const adapter = readFileSync(
      join(HERE, '..', '..', 'ingestion', 'adapters', 'product-feed.ts'),
      'utf8',
    );
    expect(adapter).toContain('mayReportCompleteEnumeration(');
    expect(adapter).toContain('feedCompletionVerdict(');
    // The mutation self-test's target: a `complete: true` written literally
    // anywhere in the adapter would bypass the verdict entirely.
    expect(/complete:\s*true/u.test(adapter), 'the adapter hard-codes a completed enumeration').toBe(
      false,
    );
  });

  it('#63 adds no second retiring-outcome list — it feeds #62’s', () => {
    // Comment-STRIPPED, because the module documents #62's rule in the same
    // vocabulary the detector uses — a scan over raw source would fail on the
    // prose that exists to explain the boundary.
    const completion = readFileSync(join(HERE, '..', 'completion.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .replace(/(^|[^:])\/\/.*$/gmu, '$1 ');
    // The rule that decides what may retire stays #62's; this module decides
    // only what may be CLAIMED. A local retiring-outcome tuple here would be a
    // second authority, which is the disagreement the reference exists to stop.
    expect(completion.includes('RETIRING_OUTCOMES')).toBe(false);
    // …and the detector detects: the mutation self-test.
    expect('const X = CATALOG_SOURCE_RETIRING_OUTCOMES;'.includes('RETIRING_OUTCOMES')).toBe(true);
    expect(FEED_DELIVERY_MODES).toEqual(['snapshot', 'delta']);
  });
});
