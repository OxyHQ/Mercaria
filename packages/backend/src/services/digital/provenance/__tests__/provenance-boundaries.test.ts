/**
 * #1015 W8's three prohibitions, asserted STRUCTURALLY rather than behaviourally.
 *
 * Each of them is a thing this directory must never be able to do, and each is one
 * import away from being possible. A behavioural test proves the current code path
 * does not do it; a scan over the directory proves a future one cannot without
 * somebody editing this file and explaining why.
 *
 *  1. **No automatic enforcement.** A fingerprint match must not restrict, archive,
 *     withdraw or unlist anything, so the directory may not reach the enforcement
 *     service or the catalogue write service at all.
 *  2. **No notification.** Nothing here may tell a creator that somebody's upload
 *     resembles theirs — the honest form of that message is an undecided
 *     accusation aimed at an unjudged person, and the next request it provokes is
 *     "show me the file".
 *  3. **No bytes and no storage key.** `asset_files.storage_key` is a PROTECTED
 *     column and `download.service.ts` is its only sanctioned reader. A provenance
 *     review that carried one would hand one creator another creator's file.
 *
 * Both scanners carry the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity floor,
 * so a broken directory walk cannot pass by scanning nothing, and a mutation
 * self-test, so a detector that matches nothing cannot pass by detecting nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEachOf } from '../../../../__tests__/assert-each-of.js';

const PROVENANCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every module of the directory, excluding the test tree. Walked, never listed. */
function provenanceModules(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(PROVENANCE_ROOT, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    if (entry.isFile() && entry.name.endsWith('.ts')) found.push(entry.name);
  }
  return found;
}

const MODULES = provenanceModules();

/** One module's source, refusing an empty or moved file. */
function sourceOf(name: string): string {
  const source = readFileSync(join(PROVENANCE_ROOT, name), 'utf8');
  expect(source.length, `${name} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/** The import specifiers of one module. */
function importsOf(name: string): string[] {
  return [...sourceOf(name).matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
}

describe('#1015 W8 — the population this gate scans', () => {
  it('is the whole directory and is not empty', () => {
    // The vacuity floor. Six modules today: mesh-vertices, fingerprint,
    // preview-hash, derive-signals, sweep, review, appeal. A walk that returned
    // nothing would pass every assertion below.
    expect(MODULES.length).toBeGreaterThanOrEqual(6);
    for (const name of MODULES) {
      expect(statSync(join(PROVENANCE_ROOT, name)).isFile(), `${name} is not a file`).toBe(true);
    }
    expect(MODULES.filter((name) => name.includes('.test.'))).toEqual([]);
  });
});

describe('#1015 W8 prohibition 1 — a match never enforces anything', () => {
  /**
   * Modules a provenance signal may not reach.
   *
   * Each is a real lever: `enforcement.service` applies a moderation decision,
   * `catalog-write.service` is the only writer of `listings.status` (and the home
   * of the three #402 escapes), `right.service` and `download.service` are what a
   * buyer's access runs through, and `order.service` is what freezes money.
   */
  const FORBIDDEN_TARGETS = [
    'enforcement.service',
    'enforcement-plan',
    'catalog-write.service',
    'right.service',
    'download.service',
    'order.service',
    'storage',
  ] as const;

  it('no module imports an enforcement lever', () => {
    const offenders: string[] = [];
    for (const name of MODULES) {
      for (const specifier of importsOf(name)) {
        for (const target of FORBIDDEN_TARGETS) {
          if (specifier.includes(target)) offenders.push(`${name} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the ONE moderation import is the report intake, and it is in `review.ts` only', () => {
    // Stated as an identity rather than an absence: the whole design is that a
    // match reaches a human through the path that already exists, so the import
    // must BE there — and it must be the only one, in the only module entitled to
    // it. An absence test would pass if the integration were deleted.
    const reaching = MODULES.filter((name) =>
      importsOf(name).some((specifier) => specifier.includes('moderation/')),
    );
    expect(reaching).toEqual(['review.ts']);
    expect(importsOf('review.ts').filter((specifier) => specifier.includes('moderation/'))).toEqual([
      '../../moderation/report-intake.service.js',
    ]);
  });

  it('the detector detects — the mutation self-test', () => {
    const seeded = "import { applyPlan } from '../../moderation/enforcement.service.js';";
    expect(FORBIDDEN_TARGETS.some((target) => seeded.includes(target))).toBe(true);
    const innocent = "import { createAbuseReport } from '../../moderation/report-intake.service.js';";
    expect(FORBIDDEN_TARGETS.some((target) => innocent.includes(target))).toBe(false);
  });
});

describe('#1015 W8 prohibition 2 — nothing here notifies anybody', () => {
  const NOTIFICATION_TOKENS = [
    'notification-service',
    'seller-notification',
    'sendNotification',
    'sendEmail',
    'notifySeller',
  ] as const;

  it('no module reaches a notification sender', () => {
    const offenders: string[] = [];
    for (const name of MODULES) {
      const source = sourceOf(name);
      for (const token of NOTIFICATION_TOKENS) {
        // Import specifiers AND call sites, because the hazard is the effect
        // rather than the module boundary.
        if (new RegExp(`(from\\s+'[^']*${token}|\\b${token}\\s*\\()`).test(source)) {
          offenders.push(`${name} reaches ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the detector detects — the mutation self-test', () => {
    const seeded = "await sendNotification({ userId: claimant, type: 'provenance_match' });";
    expect(
      NOTIFICATION_TOKENS.some((token) =>
        new RegExp(`(from\\s+'[^']*${token}|\\b${token}\\s*\\()`).test(seeded),
      ),
    ).toBe(true);
    const innocent = "const packet = buildProvenanceReviewPacket(sweep);";
    expect(
      NOTIFICATION_TOKENS.some((token) =>
        new RegExp(`(from\\s+'[^']*${token}|\\b${token}\\s*\\()`).test(innocent),
      ),
    ).toBe(false);
  });
});

describe('#1015 W8 prohibition 3 — no bytes and no storage key leave this directory', () => {
  it('nothing reads a protected storage column', () => {
    assertEachOf(
      ['findAssetFileStorageKey', 'storageKey', 'storage_key', 'presign', 'signedUrl'],
      5,
      (token) => {
        const offenders = MODULES.filter((name) => {
          const source = sourceOf(name);
          // A docblock may NAME the column — `review.ts` explains why it carries
          // none — so the offence is the identifier in code, not the words. Lines
          // inside a block comment are excluded by the leading `*` test.
          return source
            .split('\n')
            .some((line) => !line.trim().startsWith('*') && line.includes(token));
        });
        expect(offenders, `${token} appears in code`).toEqual([]);
      },
    );
  });

  it('the review packet type declares no field that could carry one', () => {
    const source = sourceOf('review.ts');
    const declaration = source.slice(
      source.indexOf('export interface ProvenanceReviewPacket'),
      source.indexOf('export interface ProvenanceReviewPacket') + 2_000,
    );
    const body = declaration.slice(0, declaration.indexOf('\n}'));
    assertEachOf(
      ['fileId', 'fileName', 'storageKey', 'bytes', 'url', 'candidateVersionId', 'storeId'],
      7,
      (field) => {
        expect(
          body.split('\n').some((line) => !line.trim().startsWith('*') && line.includes(`${field}:`)),
          `ProvenanceReviewPacket declares ${field}`,
        ).toBe(false);
      },
    );
    // The floor: the slice really contains the declaration rather than an empty
    // string, which would make every assertion above vacuous.
    expect(body).toContain('subjectVersionId:');
  });
});
