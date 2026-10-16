/**
 * The guest-governance ENGINES run (M8-04), asserted by scan and by registry.
 *
 * The M8 review's sharpest finding was not a missing control but a missing
 * QUESTION: three gates in this domain were green while the retention loop did
 * not exist, the abuse counter was never written and the erasure path wrote
 * nothing — because every gate proved a wall stood and none proved an engine
 * ran. "This domain's tests are unusually good at proving that walls exist and
 * were not built to prove that engines run." Each describe below is one of the
 * assertions the review said would have failed the build, plus the receipt and
 * the start-up wiring the fixes added.
 *
 * Every scan carries a vacuity floor and a positive control, for the review's
 * own reason: a scan that reports zero and a scan that read nothing look
 * identical.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GUEST_DATA_CLASSES,
  GUEST_DATA_INVENTORY,
  GUEST_RETENTION_SCHEDULE,
} from '@mercaria/shared-types';
import {
  carriedMinimizationClasses,
  minimizationClasses,
} from '../guest-governance/retention.service.js';
import {
  composeErasureDispositions,
  type GroupErasureCounts,
} from '../guest-governance/data-request.service.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Comment-stripped source, so a docblock naming a lever cannot count as a read of it. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every non-test `.ts` file under `src/`, OUTSIDE `config/`. */
function sourcesOutsideConfig(): readonly { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(SRC_ROOT, dir), { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (child === 'config') continue;
        walk(child);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push({
          path: child,
          text: withoutComments(readFileSync(join(SRC_ROOT, child), 'utf8')),
        });
      }
    }
  };
  walk('');
  return files;
}

/**
 * The `config.guest` block's properties, each with the lever it resolves from.
 *
 * Extracted from the SOURCE of `config/index.ts` rather than from the frozen
 * object, because the question is which declarations exist — a property whose
 * value happens to be `false` is still a declared lever.
 */
function guestConfigProperties(): readonly { property: string; declaration: string }[] {
  const source = readFileSync(join(SRC_ROOT, 'config/index.ts'), 'utf8');
  const start = source.indexOf('\n  guest: Object.freeze({');
  expect(start, 'the config.guest block moved').toBeGreaterThan(0);
  const end = source.indexOf('\n  }),', start);
  const block = source.slice(start, end);
  const properties: { property: string; declaration: string }[] = [];
  for (const match of block.matchAll(
    /^\s+(\w+):\s*(?:Object\.freeze\(\s*)?(?:\w+Env\('(GUEST_[A-Z0-9_]+)'|(resolve\w+)\()/gm,
  )) {
    properties.push({ property: match[1] as string, declaration: match[2] ?? match[3] ?? '' });
  }
  return properties;
}

describe('every declared guest lever has a reader (M8-04, M8-02)', () => {
  it('reads a real, non-trivial set of declarations and sources (vacuity floor)', () => {
    const properties = guestConfigProperties();
    // 27 at the env-flag removals (#1087–#1093), which deleted the guest
    // `*_ENABLED` levers and the abuse/dry-run settings this walk used to count.
    expect(properties.length).toBeGreaterThanOrEqual(27);
    // Positive controls: one lever from each nested block the walk must reach.
    const names = properties.map((entry) => entry.property);
    expect(names).toContain('sessionIdleDays');
    expect(names).toContain('messageBatchSize');
    expect(names).toContain('retentionPollIntervalMs');
    expect(names).toContain('signalWindowSeconds');
    expect(sourcesOutsideConfig().length).toBeGreaterThan(500);
  });

  it('every config.guest property is read somewhere outside config/', () => {
    const corpus = sourcesOutsideConfig()
      .map((file) => file.text)
      .join('\n');
    const unread = guestConfigProperties()
      .filter((entry) => !new RegExp(`\\.${entry.property}\\b`).test(corpus))
      .map((entry) => `${entry.property} (${entry.declaration})`);
    // `retentionPollIntervalMs` was on this list at the review's revision: the
    // loop it times did not exist.
    expect(unread).toEqual([]);
  });

  it('the detector detects a lever nobody reads (mutation self-test)', () => {
    const corpus = 'const x = config.guest.governance.retentionBatchSize;';
    expect(/\.retentionBatchSize\b/.test(corpus)).toBe(true);
    expect(/\.retentionPollIntervalMs\b/.test(corpus)).toBe(false);
  });
});

describe('every class declaring a mechanism is performed by it (M8-04, M8-09)', () => {
  const minimizing = GUEST_RETENTION_SCHEDULE.filter(
    (entry) => entry.mechanism === 'minimization_job',
  ).map((entry) => entry.retentionClass);

  it('the declared minimization classes are EXACTLY the performed plus the carried ones', () => {
    // Exact, both ways. The review measured three classes declaring the
    // mechanism and two implementing it, with `lookup_hash` performed by
    // nothing and refused by the job.
    expect(minimizing.length).toBeGreaterThanOrEqual(3);
    const performed = [
      ...minimizationClasses(),
      ...Object.keys(carriedMinimizationClasses()),
    ].sort();
    expect(performed).toEqual([...minimizing].sort());
  });

  it('a carried class leaves with — never after — the value its carriers erase', () => {
    for (const [carried, carriers] of Object.entries(carriedMinimizationClasses())) {
      const own = GUEST_RETENTION_SCHEDULE.find((entry) => entry.retentionClass === carried);
      expect(carriers?.length ?? 0).toBeGreaterThan(0);
      for (const carrier of carriers ?? []) {
        expect(minimizationClasses()).toContain(carrier);
        const theirs = GUEST_RETENTION_SCHEDULE.find((entry) => entry.retentionClass === carrier);
        expect(theirs?.retentionSeconds ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
          own?.retentionSeconds ?? 0,
        );
      }
    }
  });

  it('no class the job performs declares another mechanism', () => {
    for (const retentionClass of minimizationClasses()) {
      const entry = GUEST_RETENTION_SCHEDULE.find((item) => item.retentionClass === retentionClass);
      expect(entry?.mechanism).toBe('minimization_job');
    }
  });
});

describe('the scheduled loop is started, unconditionally, and stopped (M8-02)', () => {
  const index = withoutComments(readFileSync(join(SRC_ROOT, 'index.ts'), 'utf8'));
  const retention = withoutComments(
    readFileSync(join(SRC_ROOT, 'services/guest-governance/retention.service.ts'), 'utf8'),
  );

  it('src/index.ts starts it beside the expiry sweeper and stops it on shutdown', () => {
    expect(index).toMatch(
      /import\('\.\/services\/guest-governance\/retention\.service\.js'\)\s*\.then\(\(\{ startGuestRetentionLoop \}\) => startGuestRetentionLoop\(\)\)/,
    );
    expect(index).toMatch(/stopGuestRetentionLoop\(\);/);
    // Positive control: the sweeper this sits beside is found by the same read.
    expect(index).toMatch(/startExpirySweeper\(\);/);
  });

  it('nothing in front of the loop reads an environment switch', () => {
    const start = retention.indexOf('export function startGuestRetentionLoop');
    const end = retention.indexOf('export function stopGuestRetentionLoop');
    expect(start).toBeGreaterThan(0);
    const body = retention.slice(start, end);
    // The owner's rule: no `*_ENABLED` switch. The interval is the only config
    // the loop reads.
    expect(body).not.toMatch(/Enabled\b|process\.env/);
    expect(body).toMatch(/retentionPollIntervalMs/);
  });

  it('the tick reads the ACTIVE policy, never the code constant', () => {
    const start = retention.indexOf('export async function runScheduledRetention');
    const end = retention.indexOf('let timer');
    const body = retention.slice(start, end);
    expect(body).toMatch(/readActiveRetentionRules\(/);
    expect(body).not.toMatch(/GUEST_RETENTION_SCHEDULE|proposedRetentionRules/);
  });
});

describe('an erasure receipt reports what was done, not what the schedule eventually does (M8-01)', () => {
  const NOTHING: GroupErasureCounts = {
    groupHasOrders: false,
    contactHeld: false,
    contactMinimized: 0,
    grantsRevoked: 0,
    sessionsDeleted: 0,
    cartsDeleted: 0,
  };

  it('answers every class exactly once', () => {
    const dispositions = composeErasureDispositions(NOTHING);
    expect(dispositions.map((entry) => entry.dataClass).sort()).toEqual(
      [...GUEST_DATA_CLASSES].sort(),
    );
    expect(dispositions).toHaveLength(GUEST_DATA_INVENTORY.length);
  });

  it('an erasure that changed nothing reports nothing affected, in EVERY class', () => {
    // The review's finding, as a test: the old composition reported one row
    // per erasable class whatever had happened.
    for (const entry of composeErasureDispositions(NOTHING)) {
      expect(entry.affectedRowCount, entry.dataClass).toBe(0);
    }
  });

  it('every count on the receipt comes from the counts it was given', () => {
    const dispositions = composeErasureDispositions({
      groupHasOrders: true,
      contactHeld: false,
      contactMinimized: 1,
      grantsRevoked: 3,
      sessionsDeleted: 1,
      cartsDeleted: 2,
    });
    const byClass = new Map(dispositions.map((entry) => [entry.dataClass, entry]));
    expect(byClass.get('paid_guest_checkout')).toMatchObject({
      disposition: 'minimized',
      affectedRowCount: 1,
    });
    expect(byClass.get('pending_guest_checkout')).toMatchObject({
      disposition: 'not_stored',
      affectedRowCount: 0,
    });
    expect(byClass.get('access_grants_and_portal_sessions')).toMatchObject({
      disposition: 'retained_under_obligation',
      retainedReason: 'security_audit',
      affectedRowCount: 3,
    });
    expect(byClass.get('cart_and_discount_intent')?.affectedRowCount).toBe(2);
    const total = dispositions.reduce((sum, entry) => sum + entry.affectedRowCount, 0);
    expect(total).toBe(1 + 3 + 1 + 2);
  });

  it('only the session and the cart are DELETED, and only the contact is MINIMIZED', () => {
    const dispositions = composeErasureDispositions({ ...NOTHING, contactMinimized: 1 });
    expect(
      dispositions
        .filter((entry) => entry.disposition === 'deleted')
        .map((entry) => entry.dataClass)
        .sort(),
    ).toEqual(['cart_and_discount_intent', 'guest_session_metadata']);
    expect(
      dispositions
        .filter((entry) => entry.disposition === 'minimized')
        .map((entry) => entry.dataClass),
    ).toEqual(['pending_guest_checkout']);
  });

  it('a held contact is retained under the hold, and the shipping snapshot under D15', () => {
    const dispositions = composeErasureDispositions({ ...NOTHING, contactHeld: true });
    const byClass = new Map(dispositions.map((entry) => [entry.dataClass, entry]));
    expect(byClass.get('pending_guest_checkout')).toMatchObject({
      disposition: 'retained_under_obligation',
      retainedReason: 'legal_hold',
    });
    expect(byClass.get('destination_snapshot')).toMatchObject({
      disposition: 'retained_under_obligation',
      retainedReason: 'financial_record',
    });
    for (const entry of dispositions) {
      if (entry.disposition === 'retained_under_obligation') {
        expect(entry.retainedReason, entry.dataClass).toBeDefined();
      } else {
        expect(entry.retainedReason, entry.dataClass).toBeUndefined();
      }
    }
  });
});
