/**
 * The migration CHAIN is intact: one journal entry, one `.sql` and one snapshot
 * per index, agreeing on their tag and linked in order.
 *
 * ## What this gates that nothing else does
 *
 * `migration-handwritten-markers.test.ts` drives `@oxyhq/db`'s own
 * `readMigrationPhases(tags, dir)` from the journal's tags, so it already catches
 * **a journal entry whose `.sql` is missing**. That is one of the six ways the
 * chain comes apart, and it is the only one anything read before this file. The
 * other five are invisible to it, because a reader driven BY the journal can only
 * ever see what the journal names:
 *
 * 1. **A `.sql` the journal does not name.** The migrator applies the journal, so
 *    a stray file is never applied and never reported — it just sits there
 *    looking applied. This is what a rebase leaves when `_journal.json` is
 *    restored to main's version and the branch's own `.sql` is not deleted with
 *    it, which `~/Oxy/AGENTS.md`'s rebase protocol asks for in one breath and is
 *    therefore easy to half-do. It is also blind to the deploy-phase gate: that
 *    check is keyed on tags, so an unnamed file's missing `-- oxy:deploy-phase=`
 *    marker is never looked for. **Measured**, rather than reasoned: dropping a
 *    `0109_stray_no_marker.sql` carrying no phase marker and no trigger into
 *    `drizzle/` leaves `migration-handwritten-markers.test.ts` at 27/27 green and
 *    turns this file red.
 * 2. **A missing snapshot.** `migrate.ts` reads `.sql` files and never opens a
 *    snapshot, so the whole suite is green and `db:generate` breaks for whoever
 *    runs it NEXT — a failure that lands on a different person from the one who
 *    caused it. AGENTS.md records this happening: "A rebase can stage the
 *    deletion of an UPSTREAM snapshot (`git status` showing
 *    `D meta/00NN_snapshot.json` for a file that is not yours)."
 * 3. **A snapshot the journal does not name**, the same fault from the other
 *    side, which is what a hand-renamed migration leaves behind.
 * 4. **A tag that disagrees with its filename.** drizzle resolves a journal entry
 *    to `<tag>.sql`, so `0104_a` in the journal beside `0104_b.sql` on disk is
 *    exactly case 1 and case "missing `.sql`" at once — but only if somebody
 *    thought to compare the two strings.
 * 5. **A broken `prevId` chain.** Each snapshot names its parent, and that chain
 *    is what drizzle-kit diffs the schema against. A hand-written snapshot or a
 *    renumbered file leaves a snapshot diffing against the wrong parent, and the
 *    damage "appears in whoever generates next, not in you". Nothing in this
 *    repository read a snapshot at all before this file.
 *
 * ## Why the mutations run against the REAL chain
 *
 * Every mutation below is a structural copy of the chain read off disk, with one
 * fact changed. A synthetic three-entry fixture would prove the detector can
 * fail, not that it can fail on THIS corpus — and the failure mode these
 * detectors exist for (a set comparison quietly comparing something to itself)
 * survives a fixture and does not survive a copy of the real thing.
 *
 * Nothing here writes to disk. A migration is an applied artefact and a test that
 * edits one is a test that can leave the repository broken.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, '..', '..', '..');
const DRIZZLE_DIR = join(BACKEND, 'drizzle');
const META_DIR = join(DRIZZLE_DIR, 'meta');

/** The nil UUID drizzle-kit writes as the first snapshot's parent. */
const NO_PARENT = '00000000-0000-0000-0000-000000000000';

interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

interface SnapshotHead {
  readonly id: string;
  readonly prevId: string;
}

/**
 * The three directory listings and the journal, as one value the detectors read.
 *
 * Deliberately a plain structure rather than a class: every detector below is a
 * pure function of it, which is what lets the mutation self-tests hand each one a
 * copy of the real corpus with a single fact changed.
 */
interface Chain {
  /** Journal entries in the order the journal lists them, NOT sorted. */
  readonly entries: readonly JournalEntry[];
  /** idx → snapshot head, from `meta/<idx>_snapshot.json`. */
  readonly snapshots: ReadonlyMap<number, SnapshotHead>;
  /** idx → the `.sql` basename with its extension stripped, i.e. its tag. */
  readonly sql: ReadonlyMap<number, string>;
}

function readChain(): Chain {
  const journal = JSON.parse(readFileSync(join(META_DIR, '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };

  const snapshots = new Map<number, SnapshotHead>();
  for (const entry of readdirSync(META_DIR)) {
    const match = /^(\d+)_snapshot\.json$/u.exec(entry);
    if (match === null) continue;
    const head = JSON.parse(readFileSync(join(META_DIR, entry), 'utf8')) as SnapshotHead;
    snapshots.set(Number.parseInt(match[1], 10), { id: head.id, prevId: head.prevId });
  }

  const sql = new Map<number, string>();
  for (const entry of readdirSync(DRIZZLE_DIR)) {
    if (!entry.endsWith('.sql')) continue;
    const match = /^(\d+)_/u.exec(entry);
    // A `.sql` with no numeric prefix is itself a fault, and one the set
    // comparison below cannot express — it has no index to be absent from.
    if (match === null) {
      sql.set(Number.NaN, entry);
      continue;
    }
    sql.set(Number.parseInt(match[1], 10), entry.slice(0, -'.sql'.length));
  }

  return { entries: journal.entries, snapshots, sql };
}

/** A deep-enough copy for a mutation to change one fact and nothing else. */
function copyOf(chain: Chain): {
  entries: JournalEntry[];
  snapshots: Map<number, SnapshotHead>;
  sql: Map<number, string>;
} {
  return {
    entries: chain.entries.map((entry) => ({ ...entry })),
    snapshots: new Map(chain.snapshots),
    sql: new Map(chain.sql),
  };
}

/**
 * The journal's own shape: one entry per index, contiguous from zero, listed in
 * that order, each stamped later than the one before.
 *
 * `idx === position` is the assertion that matters and the one a `Set` size
 * cannot make. drizzle applies entries in ARRAY order and records `idx`; a
 * hand-edited journal that reorders two entries keeps a perfect idx SET while
 * applying `0104` before `0103`, which is how a migration lands against a schema
 * state that does not exist yet.
 */
function journalShape(chain: Chain): string[] {
  const problems: string[] = [];
  chain.entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      problems.push(
        `journal position ${position} carries idx ${entry.idx} — drizzle applies entries in ARRAY order, so the two must agree.`,
      );
    }
  });
  const seen = new Map<number, number>();
  for (const entry of chain.entries) {
    const first = seen.get(entry.idx);
    if (first !== undefined) {
      problems.push(`journal idx ${entry.idx} appears twice (positions ${first} and ${entry.idx}).`);
    }
    seen.set(entry.idx, entry.idx);
  }
  for (const [before, after] of chain.entries.slice(0, -1).map((e, i) => [e, chain.entries[i + 1]])) {
    if (!(before.when < after.when)) {
      problems.push(
        `journal \`when\` does not increase from idx ${before.idx} (${before.when}) to idx ${after.idx} (${after.when}) — a hand-edited or hand-reordered journal.`,
      );
    }
  }
  return problems;
}

/**
 * ADR 0007 D11 rule 5: the journal's index set, the `.sql` set and the snapshot
 * set are the SAME set.
 *
 * Written as four named one-way differences rather than one equality, because
 * "the sets differ" sends a reader to look at the wrong side half the time, and
 * the four faults have four different repairs: delete your `.sql`, restore a
 * snapshot from `origin/main`, re-run `db:generate`, or delete a stray file.
 */
function setAgreement(chain: Chain): string[] {
  const problems: string[] = [];
  const journal = new Set(chain.entries.map((entry) => entry.idx));
  const snapshots = new Set(chain.snapshots.keys());
  const sql = new Set(chain.sql.keys());

  const missing = (from: Set<number>, against: Set<number>): number[] =>
    [...from].filter((idx) => !against.has(idx)).sort((a, b) => a - b);

  for (const idx of missing(journal, sql)) {
    problems.push(`idx ${idx} is in the journal with no \`.sql\` file — the migrator would fail to read it.`);
  }
  for (const idx of missing(sql, journal)) {
    problems.push(
      `\`${chain.sql.get(idx)}.sql\` is on disk and NOT in the journal — it is never applied and never reported. Delete it and re-run \`db:generate\`, or restore the journal entry.`,
    );
  }
  for (const idx of missing(journal, snapshots)) {
    problems.push(
      `idx ${idx} is in the journal with no \`meta/${String(idx).padStart(4, '0')}_snapshot.json\` — the whole suite stays green and \`db:generate\` breaks for whoever runs it NEXT.`,
    );
  }
  for (const idx of missing(snapshots, journal)) {
    problems.push(
      `\`meta/${String(idx).padStart(4, '0')}_snapshot.json\` exists with no journal entry — what a hand-renamed migration leaves behind.`,
    );
  }
  if (chain.sql.has(Number.NaN)) {
    problems.push(`\`${chain.sql.get(Number.NaN)}\` carries no numeric index prefix.`);
  }
  return problems;
}

/**
 * Every journal tag is its `.sql` file's basename.
 *
 * drizzle resolves an entry to `<tag>.sql` literally. Two files sharing an index
 * cannot both be named by one entry, and the set comparison above reports that as
 * an absence on both sides without ever saying the two strings disagree.
 */
function tagAgreement(chain: Chain): string[] {
  const problems: string[] = [];
  for (const entry of chain.entries) {
    const onDisk = chain.sql.get(entry.idx);
    if (onDisk === undefined) continue; // reported by `setAgreement`, not twice.
    if (onDisk !== entry.tag) {
      problems.push(
        `journal idx ${entry.idx} names tag \`${entry.tag}\` and the file on disk is \`${onDisk}.sql\`. Never hand-rename a migration.`,
      );
    }
  }
  return problems;
}

/**
 * The snapshot chain: `0000` has no parent, and every later snapshot names the
 * previous index's snapshot as its own.
 *
 * This is what drizzle-kit diffs against, and it is the only part of the chain
 * that carries a fact the filenames do not. A renumbered or hand-written
 * snapshot keeps every set and every tag intact and diffs against the wrong
 * parent.
 */
function snapshotChain(chain: Chain): string[] {
  const problems: string[] = [];
  const indexes = [...chain.snapshots.keys()].sort((a, b) => a - b);

  const ids = new Map<string, number>();
  for (const idx of indexes) {
    const head = chain.snapshots.get(idx);
    const first = ids.get(head.id);
    if (first !== undefined) {
      problems.push(`snapshots ${first} and ${idx} share the id \`${head.id}\`.`);
    }
    ids.set(head.id, idx);
  }

  indexes.forEach((idx, position) => {
    const head = chain.snapshots.get(idx);
    if (position === 0) {
      if (head.prevId !== NO_PARENT) {
        problems.push(`the first snapshot (${idx}) names a parent \`${head.prevId}\`.`);
      }
      return;
    }
    const parent = chain.snapshots.get(indexes[position - 1]);
    if (head.prevId !== parent.id) {
      problems.push(
        `snapshot ${idx} names parent \`${head.prevId}\` and snapshot ${indexes[position - 1]} is \`${parent.id}\` — this snapshot diffs against the wrong schema state, and the damage lands on whoever generates NEXT.`,
      );
    }
  });
  return problems;
}

const CHAIN = readChain();

describe('the corpus this gate reads', () => {
  it('found a real chain, not three empty listings', () => {
    // Every assertion in this file is a comparison between three sets. Three
    // EMPTY sets are equal, every tag agrees, and the snapshot chain of nothing
    // is intact — so without these floors the whole file passes against a
    // directory it failed to read. Floored independently, because a single total
    // is satisfied by one populated listing and two empty ones.
    expect(CHAIN.entries.length, 'no journal entries').toBeGreaterThanOrEqual(100);
    expect(CHAIN.sql.size, 'no `.sql` migrations').toBeGreaterThanOrEqual(100);
    expect(CHAIN.snapshots.size, 'no snapshots').toBeGreaterThanOrEqual(100);
    // Printed on success so a later reader can see what was measured rather than
    // trusting that something was.
    console.info(
      `[migration chain] journal=${CHAIN.entries.length} sql=${CHAIN.sql.size} snapshots=${CHAIN.snapshots.size} highest-idx=${Math.max(...CHAIN.entries.map((e) => e.idx))}`,
    );
  });

  it('read a snapshot head out of every snapshot file', () => {
    // The floor for `snapshotChain`: a map of 109 entries whose `id` is
    // `undefined` throughout has a perfectly intact chain of `undefined`s, and
    // a uniqueness check over one repeated `undefined` would be the only thing
    // that noticed.
    const withIds = [...CHAIN.snapshots.values()].filter(
      (head) => typeof head.id === 'string' && head.id.length > 0,
    );
    expect(withIds).toHaveLength(CHAIN.snapshots.size);
    const withParents = [...CHAIN.snapshots.values()].filter(
      (head) => typeof head.prevId === 'string' && head.prevId.length > 0,
    );
    expect(withParents).toHaveLength(CHAIN.snapshots.size);
  });
});

describe('ADR 0007 D11 rule 5 — the journal, the `.sql` files and the snapshots are one set', () => {
  it('names the same indexes in all three places', () => {
    expect(
      setAgreement(CHAIN),
      'The three listings disagree. This is the fault a rebase leaves: `~/Oxy/AGENTS.md` asks you to ' +
        'delete your `.sql` AND your `meta/<idx>_snapshot.json` AND restore `_journal.json` to main’s ' +
        'version, and doing two of the three leaves a chain that applies cleanly and breaks the next ' +
        'person to run `db:generate`.',
    ).toEqual([]);
  });

  it('agrees on every tag', () => {
    expect(tagAgreement(CHAIN)).toEqual([]);
  });

  it('lists every entry once, in index order, each stamped after the last', () => {
    expect(journalShape(CHAIN)).toEqual([]);
  });

  it('links every snapshot to the one before it', () => {
    expect(
      snapshotChain(CHAIN),
      'A snapshot diffing against the wrong parent. Never hand-write a snapshot or hand-rename a ' +
        'migration — delete both and re-run `db:generate` against the post-merge chain.',
    ).toEqual([]);
  });
});

describe('the detectors — each mutation is a copy of the REAL chain with one fact changed', () => {
  /**
   * The highest index, i.e. the slot a branch would have taken. Mutations aim
   * there because that is where a rebase actually goes wrong; a mutation at
   * index 3 would also be caught by a detector that only ever looks at the
   * oldest entry.
   */
  const TOP = Math.max(...CHAIN.entries.map((entry) => entry.idx));

  it('catches a `.sql` the journal does not name', () => {
    const mutated = copyOf(CHAIN);
    mutated.entries = mutated.entries.filter((entry) => entry.idx !== TOP);
    // The mutation APPLIED: the file is still on disk and the entry is gone.
    expect(mutated.sql.has(TOP)).toBe(true);
    expect(mutated.entries.some((entry) => entry.idx === TOP)).toBe(false);

    const problems = setAgreement(mutated);
    expect(problems.join('\n')).toMatch(/on disk and NOT in the journal/u);
    // …and the real chain reports nothing, which is what makes the line above
    // about the mutation rather than about the corpus.
    expect(setAgreement(CHAIN)).toEqual([]);
  });

  it('catches a journal entry whose `.sql` is missing', () => {
    const mutated = copyOf(CHAIN);
    mutated.sql.delete(TOP);
    expect(mutated.sql.has(TOP)).toBe(false);
    expect(setAgreement(mutated).join('\n')).toMatch(/in the journal with no `\.sql` file/u);
  });

  it('catches the deleted UPSTREAM snapshot, which every other check calls healthy', () => {
    const mutated = copyOf(CHAIN);
    // Not the top one: the fault AGENTS.md records is a rebase staging the
    // deletion of a snapshot that is NOT yours, so aim below the tip.
    const victim = TOP - 3;
    mutated.snapshots.delete(victim);
    expect(mutated.snapshots.has(victim)).toBe(false);

    expect(setAgreement(mutated).join('\n')).toMatch(/_snapshot\.json` — the whole suite stays green/u);
    // The point of this clause, stated as an assertion: nothing else notices.
    // The journal is untouched, every `.sql` is present and every tag agrees, so
    // the three detectors a reader would expect to cover this all pass.
    expect(journalShape(mutated)).toEqual([]);
    expect(tagAgreement(mutated)).toEqual([]);
    // The `prevId` walk cannot see it either: it links whatever snapshots ARE
    // present, and with one removed the survivors' parents no longer match, so
    // it reports a DIFFERENT fault and would send a reader to rewrite a
    // snapshot instead of restoring one.
    expect(snapshotChain(mutated).join('\n')).toMatch(/diffs against the wrong schema state/u);
  });

  it('catches a snapshot the journal does not name', () => {
    const mutated = copyOf(CHAIN);
    mutated.snapshots.set(TOP + 1, { id: 'orphan', prevId: mutated.snapshots.get(TOP).id });
    expect(setAgreement(mutated).join('\n')).toMatch(/exists with no journal entry/u);
  });

  it('catches a hand-renamed migration, which keeps both sets intact', () => {
    const mutated = copyOf(CHAIN);
    const original = mutated.sql.get(TOP);
    mutated.sql.set(TOP, `${original}_renamed`);
    expect(mutated.sql.get(TOP)).not.toBe(original);

    expect(tagAgreement(mutated).join('\n')).toMatch(/Never hand-rename a migration/u);
    // The set comparison is blind to it — the index is still present on both
    // sides — which is why the tag clause is not redundant with it.
    expect(setAgreement(mutated)).toEqual([]);
  });

  it('catches two journal entries swapped, which keeps the idx SET intact', () => {
    const mutated = copyOf(CHAIN);
    const last = mutated.entries.length - 1;
    [mutated.entries[last - 1], mutated.entries[last]] = [
      mutated.entries[last],
      mutated.entries[last - 1],
    ];
    // The mutation applied, and the SET is unchanged — which is the whole point.
    expect(mutated.entries[last].idx).toBe(TOP - 1);
    expect(new Set(mutated.entries.map((e) => e.idx)).size).toBe(CHAIN.entries.length);
    expect(setAgreement(mutated)).toEqual([]);

    const problems = journalShape(mutated).join('\n');
    expect(problems).toMatch(/drizzle applies entries in ARRAY order/u);
    expect(problems).toMatch(/`when` does not increase/u);
  });

  it('catches a hand-written snapshot pointing at the wrong parent', () => {
    const mutated = copyOf(CHAIN);
    mutated.snapshots.set(TOP, { ...mutated.snapshots.get(TOP), prevId: NO_PARENT });
    expect(mutated.snapshots.get(TOP).prevId).toBe(NO_PARENT);

    expect(snapshotChain(mutated).join('\n')).toMatch(/diffs against the wrong schema state/u);
    // Sets and tags are untouched: this is the fault only the chain can see.
    expect(setAgreement(mutated)).toEqual([]);
    expect(tagAgreement(mutated)).toEqual([]);
  });

  it('catches a duplicated snapshot id, which a copied file produces', () => {
    const mutated = copyOf(CHAIN);
    const donor = mutated.snapshots.get(TOP - 1);
    mutated.snapshots.set(TOP, { id: donor.id, prevId: donor.prevId });
    expect(snapshotChain(mutated).join('\n')).toMatch(/share the id/u);
  });

  it('catches a `.sql` with no numeric prefix', () => {
    const mutated = copyOf(CHAIN);
    mutated.sql.set(Number.NaN, 'catalogLocalization.pending');
    expect(setAgreement(mutated).join('\n')).toMatch(/carries no numeric index prefix/u);
    expect(setAgreement(CHAIN)).toEqual([]);
  });
});
