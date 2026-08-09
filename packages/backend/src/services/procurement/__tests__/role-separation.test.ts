/**
 * Role separation, pinned statically (#118 acceptance criterion 8 and
 * consistency rules 4–5): the payment domain and the procurement domain never
 * import each other, so "supplier acceptance marks Stripe paid" and "Stripe
 * success marks procurement accepted" are not merely unwritten — there is no
 * import through which either could be written without failing this gate.
 *
 * A grep-shaped test, built with the AGENTS.md defenses: the matched LINES are
 * reported in the failure (never a bare count), and a vacuity floor pins the
 * number of files scanned so a broken traversal cannot pass by reading
 * nothing.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVICES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every non-test `.ts` file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

/** The `from '…'` specifiers of every import/export in one file. */
function importSpecifiers(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** Files under `root` importing a specifier that mentions `needle`. */
function offendingImports(root: string, needle: string): { files: number; offenders: string[] } {
  const files = sourceFiles(root);
  const offenders: string[] = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(file)) {
      if (specifier.includes(needle)) {
        offenders.push(`${relative(SERVICES_DIR, file)} imports '${specifier}'`);
      }
    }
  }
  return { files: files.length, offenders };
}

describe('the domains are decoupled by construction', () => {
  it('nothing in services/procurement imports the payment domain', () => {
    const { files, offenders } = offendingImports(join(SERVICES_DIR, 'procurement'), 'payments');
    // Vacuity floor: the procurement domain has real files to scan.
    expect(files).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });

  it('nothing in services/payments imports the procurement domain', () => {
    const { files, offenders } = offendingImports(join(SERVICES_DIR, 'payments'), 'procurement');
    expect(files).toBeGreaterThanOrEqual(10);
    expect(offenders).toEqual([]);
  });

  it('each domain keeps its OWN order-linkage seam — procurement never reuses payments’', () => {
    // Both seams exist and are distinct files; sharing one would couple the
    // domains through the projection they would then have to co-evolve.
    const procurementSeam = readFileSync(
      join(SERVICES_DIR, 'procurement', 'order-linkage.ts'),
      'utf8',
    );
    const paymentsSeam = readFileSync(join(SERVICES_DIR, 'payments', 'order-linkage.ts'), 'utf8');
    // The procurement seam projects fulfilment data only — no payment pointer,
    // no buyer identity, no totals.
    expect(procurementSeam).not.toMatch(/paymentId|buyerOxyUserId|TotalMinor/);
    // And the payments seam still carries its own shape, untouched by this issue.
    expect(paymentsSeam).toMatch(/paymentId/);
  });
});
