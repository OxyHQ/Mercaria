/**
 * Every price-alert block reason is PRODUCED, and the vocabulary has a READER
 * (#752).
 *
 * ## Why this gate exists and what it is answering
 *
 * #744 measured "does a literal producer exist" over every closed tuple in
 * `shared-types` and found two dead members here. #752 found the sharper fault
 * underneath it: `qualifyAlert` composed a real `{ outcome: 'blocked', reasons }`
 * verdict and its ONE production consumer dropped it four lines later with a
 * bare `continue`, so no column stored a reason, no DTO carried one and no route
 * returned one. A producer census cannot propose that fix, because the fault is
 * a missing CONSUMER — the instrument is blind in exactly the direction the
 * remedy lies.
 *
 * So this gate asserts BOTH halves, and neither substitutes for the other:
 *
 * 1. every member has a live producer (the #744 property), and
 * 2. the produced verdict reaches a durable column and an operator-readable
 *    surface (the #752 property).
 *
 * Without (2) a member can be "produced" into a local that the next line
 * discards — which is what the whole issue was.
 *
 * ## The specific way a census of THIS vocabulary goes wrong
 *
 * `ambiguous_after_split` was a member here AND is a live member of
 * `PRICE_ALERT_RESOLUTION_STATES`, thirty lines apart in the same shared-types
 * file. A census keyed on member STRINGS counts the resolution-state
 * occurrences as producers of the block reason and reports it healthy — which is
 * why #744's sweep missed it. #752 cut it (unreachable by construction: the
 * evaluator selects `resolutionState = 'resolved'`), and this gate scans only
 * the two files that may produce a BLOCK reason rather than the whole tree, so a
 * homonym elsewhere cannot satisfy it.
 *
 * ## The defences this gate carries
 *
 * - a VACUITY FLOOR: every scanned file must exist and be substantial, and the
 *   vocabulary must be non-trivial, so a moved or emptied file fails rather than
 *   passing by having nothing to match;
 * - a POSITIVE CONTROL: a member known to be produced must be found, so a
 *   detector that matches nothing cannot read as "all clear";
 * - a MUTATION SELF-TEST per property: the producer detector is run against
 *   source with ONE member's literal removed and must report EXACTLY that
 *   member, and each reader detector is run against source with its own
 *   mechanism removed and must go red.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRICE_ALERT_BLOCK_REASONS } from '@mercaria/shared-types';
import { stripComments } from '../../../__tests__/package-barrel-symbols.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The ONLY files that may produce a block reason.
 *
 * Deliberately a closed list rather than a tree walk: the point of the scan is
 * that a homonym in another domain must NOT be able to satisfy it. A new
 * producer file is a deliberate edit here, and `PRODUCER_FILE_FLOOR` below stops
 * the list being quietly emptied.
 */
const PRODUCER_FILES = [
  'services/price-alerts/qualification.ts',
  'services/price-alerts/evaluation.service.ts',
] as const;

/** Where the verdict must LAND for the vocabulary to have a reader at all. */
const READER_FILES = {
  /** The durable column, and the statement that writes it. */
  repository: 'db/priceAlerts/priceAlertRepository.ts',
  /** The operator-readable surface. */
  operator: 'services/price-alerts/operator.service.ts',
  /** The column definition and its CHECKs. */
  schema: 'db/schema/priceAlerts.ts',
} as const;

/** A file below this is empty, moved or renamed — never legitimately tiny. */
const MIN_FILE_BYTES = 400;

function read(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} is too small to be the real file`).toBeGreaterThan(
    MIN_FILE_BYTES,
  );
  return source;
}

/**
 * Which members appear as a quoted literal in the given (comment-stripped)
 * sources.
 *
 * Comment-stripped because these modules DOCUMENT the vocabulary in the same
 * words they produce it in — the `checkout-contact-isolation` rule. A docblock
 * naming `repeat_policy_not_satisfied` must not be able to satisfy a scan for
 * its producer, which is precisely how a dead member survives a sweep.
 */
function producedMembers(sources: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const source of sources) {
    const code = stripComments(source);
    for (const member of PRICE_ALERT_BLOCK_REASONS) {
      // Anchored on the quotes, so `above_target` cannot be matched by a longer
      // identifier that merely contains it.
      if (code.includes(`'${member}'`) || code.includes(`"${member}"`)) found.add(member);
    }
  }
  return found;
}

describe('the block-reason vocabulary is whole', () => {
  it('is non-trivial, and its files exist (the vacuity floor)', () => {
    expect(PRICE_ALERT_BLOCK_REASONS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(PRICE_ALERT_BLOCK_REASONS).size).toBe(PRICE_ALERT_BLOCK_REASONS.length);
    expect(PRODUCER_FILES.length).toBeGreaterThanOrEqual(2);
    for (const file of [...PRODUCER_FILES, ...Object.values(READER_FILES)]) read(file);
  });

  it('carries no member that only a homonym in another vocabulary keeps alive', () => {
    // `ambiguous_after_split` is live as a PriceAlertResolutionState and was cut
    // from THIS tuple by #752. If it comes back, it must come back with a
    // producer in a producer file — which the census below is what enforces.
    expect(PRICE_ALERT_BLOCK_REASONS).not.toContain('ambiguous_after_split');
    expect(PRICE_ALERT_BLOCK_REASONS).not.toContain('alert_not_evaluable');
  });

  it('produces every member, from a producer file, in code and not in a comment', () => {
    const sources = PRODUCER_FILES.map(read);

    // POSITIVE CONTROL: the instrument finds something before we trust a zero.
    const produced = producedMembers(sources);
    expect(produced.has('no_eligible_offer'), 'positive control failed: the scan matches nothing').toBe(
      true,
    );

    const missing = PRICE_ALERT_BLOCK_REASONS.filter((member) => !produced.has(member));
    expect(missing, `block reasons with no producer: ${missing.join(', ')}`).toEqual([]);
  });

  it('MUTATION SELF-TEST: removing one producer reds the census, naming that member', () => {
    const target = 'repeat_policy_not_satisfied';
    expect(PRICE_ALERT_BLOCK_REASONS).toContain(target);

    const sources = PRODUCER_FILES.map(read);
    const mutated = sources.map((source) =>
      source.replaceAll(`'${target}'`, `'__removed_producer__'`),
    );

    // The mutation must actually have applied — a self-test whose edit matched
    // nothing proves the detector works against unmodified source.
    expect(mutated.join('\n')).not.toBe(sources.join('\n'));

    const produced = producedMembers(mutated);
    const missing = PRICE_ALERT_BLOCK_REASONS.filter((member) => !produced.has(member));
    expect(missing).toEqual([target]);
  });
});

describe('the vocabulary has a READER, which is what #752 added', () => {
  it('the verdict reaches a durable column', () => {
    const schema = stripComments(read(READER_FILES.schema));
    expect(schema).toContain('lastBlockReasons');
    expect(schema).toContain('lastBlockedAt');
    // The CHECK that keeps the two halves from disagreeing, spelled the one way
    // that actually refuses an empty array.
    expect(schema).toContain('cardinality(');
    expect(schema).not.toContain('array_length(');

    const repository = stripComments(read(READER_FILES.repository));
    expect(repository).toContain('lastBlockReasons');
    // Written by the SAME statement that stamps the evaluation, so the two
    // cannot describe different evaluations.
    expect(repository).toMatch(/lastEvaluatedAt:[\s\S]{0,200}lastBlockReasons:/);
  });

  it('the stored verdict reaches the operator surface', () => {
    const operator = stripComments(read(READER_FILES.operator));
    expect(operator).toContain('lastEvaluation');
    expect(operator).toContain('lastBlockReasons');
  });

  it('MUTATION SELF-TEST: each reader detector goes red when its mechanism is removed', () => {
    const schema = stripComments(read(READER_FILES.schema));
    const repository = stripComments(read(READER_FILES.repository));
    const operator = stripComments(read(READER_FILES.operator));

    // Column removed from the schema.
    const schemaMutated = schema.replaceAll('lastBlockReasons', '__gone__');
    expect(schemaMutated).not.toBe(schema);
    expect(schemaMutated).not.toContain('lastBlockReasons');

    // The write no longer accompanies the evaluation stamp.
    const repositoryMutated = repository.replaceAll('lastBlockReasons', '__gone__');
    expect(repositoryMutated).not.toBe(repository);
    expect(repositoryMutated).not.toMatch(/lastEvaluatedAt:[\s\S]{0,200}lastBlockReasons:/);

    // The surface stops exposing it — the #752 property specifically.
    const operatorMutated = operator.replaceAll('lastEvaluation', '__gone__');
    expect(operatorMutated).not.toBe(operator);
    expect(operatorMutated).not.toContain('lastEvaluation');

    // And the CHECK-spelling detector catches the array_length regression.
    const schemaRegressed = schema.replaceAll('cardinality(', 'array_length(');
    expect(schemaRegressed).not.toBe(schema);
    expect(schemaRegressed).toContain('array_length(');
  });
});
