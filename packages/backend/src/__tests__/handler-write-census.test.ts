import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A route handler issues no database write (#367 relational boundaries).
 *
 * Writes go through a repository or a service, so an invariant has one place to
 * live: `insertOrder` is the only writer of an order's fee snapshot,
 * `enqueueModerationOutboxEvent` refuses the root connection so a caller cannot
 * commit the row outside its transaction, and `ledgerRepository` refuses an
 * unbalanced set before issuing SQL. None of that survives a handler reaching
 * for `getDb().update(...)`.
 *
 * ## Why this exists when six chokepoint gates already do
 *
 * Those six pin one table each — the writers of `listings.status`, of the
 * ledger, of the taxonomy. **A NEW table written straight from a handler is
 * caught by none of them**, because it is in no gate's population. This one's
 * population is the handler directories rather than a table, so a table nobody
 * has thought of is covered on the day it is added.
 *
 * ## The two ways this census goes wrong, both measured
 *
 * **The pattern.** `.insert(`, `.update(` and `.delete(` are Express router
 * methods as well as drizzle writers, and `router.delete('/:id', handler)` is
 * on almost every route file. A bare match reports a wall of false positives.
 * The pattern here requires a database HANDLE in front — `db`, `tx`, `trx` or
 * `getDb()`.
 *
 * **The population.** Fixtures under `__tests__/` write directly all the time
 * and should: a test that had to go through a service to arrange its own state
 * would be testing the service. Scanning them reports seven files that are all
 * correct. They are excluded here, and the exclusion is what
 * {@link SCANNED_FLOOR} then has to defend, since excluding everything also
 * reports zero.
 */

const SRC = join(__dirname, '..');

/** Where a request is served. Both, because a route file can hold a handler inline. */
const HANDLER_DIRECTORIES = ['controllers', 'routes'] as const;

/**
 * A drizzle write, qualified by the handle it is issued on.
 *
 * `getDb()` spelled out as well as the bare identifiers, because
 * `getDb().insert(...)` is the shortest way to do this from a handler and it
 * names no variable.
 */
const WRITE = /(?:\bdb|\btx|\btrx|getDb\(\))\s*\.\s*(?:insert|update|delete)\s*\(/u;

/** Below this, the walk found nothing and every absence below is vacuous. */
const SCANNED_FLOOR = 60;

/** Every production `.ts` under a directory, excluding tests. */
function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      found.push(...walk(path));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

const handlerFiles = HANDLER_DIRECTORIES.flatMap((directory) => walk(join(SRC, directory)));

describe('no route handler writes to the database', () => {
  it('scanned a real population', () => {
    expect(
      handlerFiles.length,
      'the walk found almost no handler files — a moved directory makes the census vacuous',
    ).toBeGreaterThanOrEqual(SCANNED_FLOOR);
  });

  it('the pattern can match a write at all — the positive control', () => {
    // Without this, "zero writes in handlers" is equally satisfied by a regex
    // that matches nothing anywhere. The repository layer is where writes
    // genuinely live, so it is where the detector has to fire.
    const repositoryFiles = walk(join(SRC, 'db'));
    const writing = repositoryFiles.filter((file) => WRITE.test(readFileSync(file, 'utf8')));
    expect(
      writing.length,
      'the detector found no write in db/, so it cannot see one in a handler either',
    ).toBeGreaterThanOrEqual(50);
  });

  it('the pattern does NOT match an Express router method — the false-positive control', () => {
    // `router.delete('/:id', handler)` is on almost every route file, and a
    // bare `.delete(` census reports every one of them. This pins the
    // discrimination rather than trusting it.
    expect(WRITE.test("router.delete('/:alertId', validateId('alertId'), handler);")).toBe(false);
    expect(WRITE.test("router.put('/x', h); router.update;")).toBe(false);
    // And it DOES match the shapes a handler would actually use.
    expect(WRITE.test('await getDb().insert(table).values(row);')).toBe(true);
    expect(WRITE.test('await db.update(table).set({ a: 1 });')).toBe(true);
    expect(WRITE.test('await tx.delete(table).where(eq(table.id, id));')).toBe(true);
  });

  it('no handler file issues one', () => {
    const offenders = handlerFiles
      .filter((file) => WRITE.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(SRC.length + 1))
      .sort();
    expect(
      offenders,
      'a route handler writes to the database directly. Move the write behind a repository or '
        + 'service function: a handler write is outside every chokepoint, so whatever invariant '
        + 'that table has — a transaction guard, a balanced set, a single-writer rule — does not '
        + 'apply to it.',
    ).toEqual([]);
  });
});
