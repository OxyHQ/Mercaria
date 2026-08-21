/**
 * The folding corpus can actually detect a broken fold.
 *
 * Everything here is PURE — it asserts properties of the CORPUS, not of a
 * database, which is `measure.test.ts`'s division and it matters for the same
 * reason: a floor that cannot fail must be provable without a seed, or a broken
 * floor hides behind a slow one.
 *
 * Each floor gets a MUTATION SELF-TEST: a corpus deliberately weakened in
 * exactly the way the floor exists to catch, asserted to produce a violation
 * naming it. A floor with no such test is a floor nobody has seen fail.
 */

import { describe, expect, it } from 'vitest';
import {
  CONFIGURATION_COVERAGE_FLOOR,
  configurationForProbe,
  findFoldingDisagreements,
  findFoldingVacuityViolations,
  FOLDING_DIFFERENCES,
  FOLDING_PROBES,
  FOLDING_SPACES,
  NON_ASCII_PROBE_FRACTION,
  probedConfigurations,
  renderFoldingReport,
  SCRIPT_INTEGRITY_SAMPLES,
  type FoldingProbe,
} from '../folding.js';

/** ASCII-only twin of a probe, for the mutation tests. */
const ASCII_PROBE: FoldingProbe = {
  id: 'ascii-only',
  difference: 'case',
  locale: 'fr',
  stored: 'Red Bicycle',
  query: 'red bicycle',
  expected: { normalized_name: 'match', normalized_alias: 'match', search_vector: 'match' },
  note: 'A probe with no character above U+007F, which is what the ASCII floor exists to refuse.',
};

describe('the folding corpus', () => {
  it('clears every one of its own vacuity floors', () => {
    const violations = findFoldingVacuityViolations();
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every accent probe really contains an accent — the semantic floor', () => {
    // The check that guarantees detection, and the one padding cannot satisfy:
    // an accent difference spelled entirely in ASCII is not an accent
    // difference, so such a row would measure nothing while looking like the
    // most relevant row in the corpus.
    for (const probe of FOLDING_PROBES.filter((entry) => entry.difference === 'accent')) {
      const hasHigh = [...`${probe.stored}${probe.query}`].some((character) => {
        const point = character.codePointAt(0);
        return point !== undefined && point > 127;
      });
      expect(hasHigh, `${probe.id} claims an accent difference in pure ASCII`).toBe(true);
    }
  });

  it('a majority of the corpus carries non-ASCII — the drift tripwire', () => {
    const nonAscii = FOLDING_PROBES.filter((probe) =>
      [...`${probe.stored}${probe.query}`].some((character) => {
        const point = character.codePointAt(0);
        return point !== undefined && point > 127;
      }),
    );
    expect(nonAscii.length).toBeGreaterThanOrEqual(
      FOLDING_PROBES.length * NON_ASCII_PROBE_FRACTION,
    );
  });

  it('the ASCII floors detect — the mutation self-test', () => {
    // A single ASCII probe that CLAIMS to differ by an accent. Both halves must
    // fire: the semantic one by name, and the proportion because 0 of 1 is
    // below half.
    const violations = findFoldingVacuityViolations([
      { ...ASCII_PROBE, difference: 'accent' as const },
    ]);
    expect(violations.join('\n')).toMatch(/claims to differ by an accent/);
    expect(violations.join('\n')).toMatch(/carry a non-ASCII character/);
  });

  it('the proportion floor is diluted by ASCII additions, not satisfied by them', () => {
    // The property a COUNT floor does not have. Padding the corpus with ASCII
    // probes must move it toward the floor; if this passed, the floor would be
    // one more list that only ever grows.
    const padded = [
      ...FOLDING_PROBES,
      ...Array.from({ length: 20 }, (_, index) => ({
        ...ASCII_PROBE,
        id: `pad-${String(index)}`,
      })),
    ];
    const violations = findFoldingVacuityViolations(padded);
    expect(violations.join('\n')).toMatch(/carry a non-ASCII character/);
  });

  it('the constant-column floor detects a space that stopped being measured', () => {
    // Rewrite every probe so `search_vector` always matches. The column then
    // cannot fail, which is exactly the vacuity the floor names.
    const flattened = FOLDING_PROBES.map((probe) => ({
      ...probe,
      expected: { ...probe.expected, search_vector: 'match' as const },
    }));
    const violations = findFoldingVacuityViolations(flattened);
    expect(violations.join('\n')).toMatch(/search_vector expects only "match"/);
  });

  it('the discrimination floor detects three spaces that became one function', () => {
    // Make all three columns agree on every probe. The corpus is then
    // consistent with the three spaces being one fold.
    const identical = FOLDING_PROBES.map((probe) => ({
      ...probe,
      expected: {
        normalized_name: probe.expected.search_vector,
        normalized_alias: probe.expected.search_vector,
        search_vector: probe.expected.search_vector,
      },
    }));
    const violations = findFoldingVacuityViolations(identical);
    expect(violations.join('\n')).toMatch(/space pairs are separated/);
  });

  it('the configuration floor detects a corpus that stopped covering the map', () => {
    const french = FOLDING_PROBES.filter((probe) => probe.locale === 'fr');
    const violations = findFoldingVacuityViolations(french);
    expect(violations.join('\n')).toMatch(/text-search configuration/);
    expect(violations.join('\n')).toMatch(/No probe routes to `simple`/);
  });

  it('the analyser A/B floor detects a corpus that dropped the controlled pair', () => {
    // Removing the `simple` half of the A/B leaves the corpus unable to
    // attribute a stemming win to the configuration rather than to the words.
    const withoutAB = FOLDING_PROBES.filter((probe) => probe.id !== 'analyser-simple');
    const violations = findFoldingVacuityViolations(withoutAB);
    expect(violations.join('\n')).toMatch(/share their text while differing in configuration/);
  });

  it('carries the A/B pair that isolates the analyser from the words', () => {
    const french = FOLDING_PROBES.find((probe) => probe.id === 'analyser-french');
    const simple = FOLDING_PROBES.find((probe) => probe.id === 'analyser-simple');
    expect(french, 'analyser-french is missing').toBeDefined();
    expect(simple, 'analyser-simple is missing').toBeDefined();
    if (!french || !simple) return;

    // Identical text, so nothing but the configuration can explain the
    // difference in verdict.
    expect(french.stored).toBe(simple.stored);
    expect(french.query).toBe(simple.query);
    expect(configurationForProbe(french)).not.toBe(configurationForProbe(simple));
    expect(french.expected.search_vector).toBe('match');
    expect(simple.expected.search_vector).toBe('no_match');
  });

  it('gives every probe a unique id, a real difference and an explanation', () => {
    const ids = FOLDING_PROBES.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const probe of FOLDING_PROBES) {
      expect(FOLDING_DIFFERENCES).toContain(probe.difference);
      // A note is what makes a row readable a year later; a restatement of the
      // verdict is not one, so the floor is long enough to force a sentence.
      expect(probe.note.length, `${probe.id} has no explanation`).toBeGreaterThan(60);
    }
  });

  it('states an expectation for all three spaces on every probe', () => {
    for (const probe of FOLDING_PROBES) {
      for (const space of FOLDING_SPACES) {
        expect(
          probe.expected[space],
          `${probe.id} states nothing for ${space}`,
        ).toMatch(/^(match|no_match)$/);
      }
    }
  });

  it('reaches the configurations it claims, and reports the ones it does not', () => {
    const reached = probedConfigurations();
    expect(reached.length).toBeGreaterThanOrEqual(CONFIGURATION_COVERAGE_FLOOR);
    expect(reached).toContain('simple');
    // Every configuration named here must be one a probe's LOCALE resolves to
    // through the shared map — a probe cannot name a configuration directly,
    // so this cannot drift from the deployed column's CASE.
    for (const probe of FOLDING_PROBES) {
      expect(reached).toContain(configurationForProbe(probe));
    }
  });
});

describe('the script integrity table', () => {
  it('records at least one corrupted and one preserved script', () => {
    // Both directions, or the table is a list rather than a measurement: an
    // all-preserved table would pass a fold that had stopped touching anything,
    // and an all-corrupted one would pass a fold that destroyed everything.
    const verdicts = new Set(SCRIPT_INTEGRITY_SAMPLES.map((sample) => sample.verdict));
    expect(verdicts.has('corrupted')).toBe(true);
    expect(verdicts.has('preserved')).toBe(true);
  });

  it('names the four catalogue languages measured to be corrupted', () => {
    // Pinned by NAME rather than by count: a count floor is met by adding a
    // sample, and what matters is that these four specific languages are on
    // record. Turning any of them `preserved` is a deliberate change to
    // `normalizeEntityName` and must edit this list in the same commit.
    const corrupted = SCRIPT_INTEGRITY_SAMPLES.filter((sample) => sample.verdict === 'corrupted')
      .map((sample) => sample.language)
      .sort();
    expect(corrupted).toEqual(['Bengali', 'Hindi', 'Japanese', 'Russian']);
  });

  it('every sample explains its mechanism', () => {
    for (const sample of SCRIPT_INTEGRITY_SAMPLES) {
      expect(sample.note.length, `${sample.language} has no explanation`).toBeGreaterThan(50);
    }
  });
});

describe('the folding report', () => {
  it('refuses to publish a matrix when the corpus measured nothing', () => {
    const report = renderFoldingReport({ cells: [] }, ['a floor that was not cleared']);
    expect(report).toMatch(/THIS RUN MEASURED NOTHING/);
    // And prints NO table — the early return is the point. A refusal that still
    // rendered a grid is one somebody reads a conclusion off.
    expect(report).not.toMatch(/differs by/);
  });

  it('refuses when a measured verdict disagrees with the defined one', () => {
    const report = renderFoldingReport(
      {
        cells: [
          {
            probeId: 'fr-accent',
            space: 'search_vector',
            expected: 'no_match',
            actual: 'match',
            evidence: "'bicyclet':1 'bon':3 'etat':4",
          },
        ],
      },
      [],
    );
    expect(report).toMatch(/THIS RUN MEASURED NOTHING/);
    expect(report).toMatch(/fr-accent \/ search_vector/);
  });

  it('finds no disagreement when every cell matches its definition', () => {
    const cells = FOLDING_PROBES.flatMap((probe) =>
      FOLDING_SPACES.map((space) => ({
        probeId: probe.id,
        space,
        expected: probe.expected[space],
        actual: probe.expected[space],
        evidence: 'measured',
      })),
    );
    expect(findFoldingDisagreements({ cells })).toEqual([]);
  });
});
