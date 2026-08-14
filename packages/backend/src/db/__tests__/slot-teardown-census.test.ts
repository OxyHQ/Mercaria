/**
 * Every holder of a session-level advisory-lock slot reaches `closePostgres()`
 * even when its release throws.
 *
 * ## The mechanism, which belongs to no single file
 *
 * `services/ingestion/__tests__/active-policy-slot.ts` and
 * `services/payments/reconciliation/__tests__/reconciliation-sweep-slot.ts`
 * hand out a Postgres SESSION-level advisory lock taken on a connection
 * reserved out of the suite's shared pool. Both used to promise that returning
 * that connection ended the hold. Measured against a real server (#272), it does
 * not: `reserve()` checks a connection OUT of the pool and `release()` checks it
 * back IN without closing the socket, and a session-level lock survives a
 * check-in. Locks held after `pg_advisory_lock`: 1. After `release()` without
 * unlocking: 1. After `sql.end()`: 0.
 *
 * So the hold ends at `closePostgres()` (postgres.js `sql.end()`) or at process
 * exit, and nothing else. A holder whose `pg_advisory_unlock` throws — or whose
 * teardown raises a `23503` before it gets there — aborts its hook one statement
 * short of the only thing that frees the slot, and vitest reuses the pool worker
 * with that socket still open. Every other claimant then blocks its full 120 s
 * `beforeAll` timeout and fails. One teardown error becomes a run-wide cascade
 * landing on files that did nothing wrong, which is exactly the signature both
 * mutexes exist to remove.
 *
 * ## Why a census and not seven careful files
 *
 * The property has to hold for holders nobody has written yet, and the shape
 * that violates it is the one anybody would write first: `await slot.release()`
 * followed by `await closePostgres()`, which is correct on every run where
 * nothing throws — that is, on every run anybody tests it on. Six of the seven
 * holders had it, and each looked fine in review. So the rule is derived here
 * rather than remembered, on `store-teardown-census.test.ts`'s precedent.
 *
 * ## Why the compiler and not a regular expression
 *
 * The property is lexical: *this call sits inside the `try` of a `try/finally`
 * whose `finally` closes the pool*. A regex would have to count braces, and a
 * brace counter that goes wrong reports a tidy zero offenders — the same output
 * as a clean estate. `typescript` is already the dependency `tsc` runs from, so
 * the parse costs a dependency nobody has to add and answers the question
 * exactly. The detector is mutation-tested below against literal buffers of both
 * the compliant and the offending shape, so a walk that stopped seeing anything
 * fails here rather than reading as clean.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Taking a slot, as a BINDING rather than as a name — `active-policy-slot.test.ts`'s
 * shape and its reasoning.
 *
 * A false positive here is silent in the dangerous direction only for a gate
 * that reads a mention as a HOLD, so the pattern is `= await <call>`, which
 * every claimant spells and which prose about the mutex does not. Comments are
 * stripped for the same asymmetry: a file whose acquire was deleted, with a
 * docblock still quoting the assignment, must not be counted as a holder — the
 * floor below would then be met by a file that holds nothing.
 */
const ACQUIRES_SLOT = new RegExp(
  `=\\s*await\\s+${'acquire'}(${'ActivePolicySlot'}|${'ReconciliationSweepSlot'})\\s*\\(`,
  'u',
);

/**
 * Floor on the holders found, not an exact count.
 *
 * Seven files hold a slot today. Five leaves room for one to legitimately stop
 * needing one without a build failure, and is far enough above zero to catch a
 * broken walk, a moved directory or a detector that stopped matching. It
 * retires when the last slot does; a commit lowering it must name the file that
 * stopped holding one and why.
 */
const HOLDER_FLOOR = 5;

/** The statement that actually ends a session's hold. */
const CLOSES_THE_POOL = 'closePostgres';

/**
 * Every `.ts` a test run loads: anything under a `__tests__` directory — which
 * catches the shared suites that are not named `*.test.ts`, the shape
 * `adapter-contract-suite.ts` established and one of the seven holders — plus
 * any `*.test.ts` elsewhere.
 */
function testSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...testSources(path));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    const underTests = relative(SRC_ROOT, path).split(sep).includes('__tests__');
    if (underTests || entry.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** `{relative path → source}` for every scanned file. */
function scannedSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const path of testSources(SRC_ROOT)) {
    sources.set(relative(SRC_ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8'));
  }
  return sources;
}

/**
 * Comments removed, for the HOLD detector only. See `ACQUIRES_SLOT`.
 *
 * The stripper is syntactic and can truncate at a `//` inside a string literal,
 * which would make it under-report — a holder missed, so its releases go
 * unchecked. That is why the floor above is a real assertion rather than
 * decoration: losing a holder shows up as a count, not as a silent pass.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
}

/**
 * A call to `closePostgres` anywhere in this node's subtree.
 *
 * Used ONLY to find the outermost protecting region, where "the pool is closed
 * somewhere in here" is the right question — `awin-writes` and
 * `adapter-contract-suite` close it through a nested `try`, so a directness
 * requirement would reject the shape this file asks them to adopt.
 */
function closesSomewhere(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(child) && child.expression.getText().endsWith(CLOSES_THE_POOL)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * A `closePostgres` call that is a TOP-LEVEL statement of this block.
 *
 * Used for the region that protects a RELEASE, where the subtree question is
 * too weak: a call buried in an `if`, a `catch` handler or a loop is reached on
 * some paths and not others, and the subtree walk cannot tell the difference —
 * it would report `finally { if (rare) await closePostgres(); }` as protection.
 * Every holder spells this as one bare statement, so requiring it costs nothing
 * and closes the gap.
 */
function closesDirectly(block: ts.Block): boolean {
  return block.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement)) return false;
    const expression = ts.isAwaitExpression(statement.expression)
      ? statement.expression.expression
      : statement.expression;
    return (
      ts.isCallExpression(expression) && expression.expression.getText().endsWith(CLOSES_THE_POOL)
    );
  });
}

/** Is `node` a descendant of `ancestor`? */
function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * The nearest enclosing function, or `undefined` at the top level.
 *
 * `isWithin` is lexical, not control-flow aware, so a release DEFINED inside a
 * try and INVOKED after it reads as protected:
 *
 * ```ts
 * try { deferred = async () => { await slot.release(); }; }
 * finally { await closePostgres(); }
 * await deferred();   // runs after the pool is already closed
 * ```
 *
 * Requiring the release and its protecting `try` to sit in the SAME function
 * rejects that, and no holder is affected: every one of them releases directly
 * in the hook body.
 */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
  }
  return undefined;
}

/**
 * A `<something>.release()` call, and what protects it.
 *
 * `protectedByFinally` means: some ancestor `try` has this call inside its TRY
 * block or its CATCH clause, sits in the same function, and closes the pool as
 * a direct statement of its FINALLY. Transitive on the try side, because
 * `ebay-ingestion.realdb.test.ts` releases inside an INNER `finally` — so that
 * a throwing `releaseMatchPolicy()` above it cannot skip the early release —
 * and that block is itself inside the outer `try` whose `finally` closes the
 * pool. Requiring the release to sit directly in a try block would fail that
 * file for being more careful than the rule. The catch clause is included for
 * the opposite reason: `try {…} catch { await slot.release(); } finally {
 * await closePostgres(); }` is safe, and rejecting it was why nobody could
 * write the natural `try/catch/finally`.
 *
 * `outermostProtectingIsFirst` is the wider property, and it is the one the
 * census docblock always claimed: everything in the hook runs inside a region
 * that closes the pool, so a `23503` in the teardown cannot abort short of it.
 * `null` when there is no protecting region at all, or when it is not a direct
 * statement of a hook body — the shapes the offender list already reports.
 */
interface ReleaseSite {
  readonly line: number;
  readonly protectedByFinally: boolean;
  readonly outermostProtectingIsFirst: boolean | null;
}

function releaseSites(file: string, source: string): ReleaseSite[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const sites: ReleaseSite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 0 &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)) &&
      node.expression.getText().endsWith('.release')
    ) {
      const home = enclosingFunction(node);
      let protectedByFinally = false;
      let outermost: ts.TryStatement | undefined;
      for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if (!ts.isTryStatement(current)) continue;
        if (!current.finallyBlock) continue;
        if (closesSomewhere(current.finallyBlock)) outermost = current;
        if (protectedByFinally) continue;
        const inGuardedRegion =
          isWithin(node, current.tryBlock) ||
          (current.catchClause !== undefined && isWithin(node, current.catchClause));
        if (!inGuardedRegion) continue;
        if (enclosingFunction(current) !== home) continue;
        if (closesDirectly(current.finallyBlock)) protectedByFinally = true;
      }

      let outermostProtectingIsFirst: boolean | null = null;
      if (outermost !== undefined) {
        const block = outermost.parent;
        const isHookBody =
          ts.isBlock(block) &&
          block.parent !== undefined &&
          (ts.isArrowFunction(block.parent) || ts.isFunctionExpression(block.parent));
        outermostProtectingIsFirst = isHookBody ? block.statements[0] === outermost : null;
      }

      sites.push({
        line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        protectedByFinally,
        outermostProtectingIsFirst,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return sites;
}

describe('the slot teardown census', () => {
  const sources = scannedSources();
  const holders = [...sources]
    .filter(([, source]) => ACQUIRES_SLOT.test(stripComments(source)))
    .map(([path]) => path)
    .sort();

  it('walked a plausible test estate and found the slot holders', () => {
    // The vacuity floor. A broken walk, a moved directory or an extension
    // filter that stopped matching all report the same clean zero as a correct
    // scan, and every assertion below would pass on each of them.
    expect(sources.size, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(300);
    expect(
      holders.length,
      'no file holds a slot — the detector or the walk stopped working',
    ).toBeGreaterThanOrEqual(HOLDER_FLOOR);
  });

  it('has every holder release inside a `finally` that closes the pool', () => {
    const offenders: string[] = [];
    let releasesFound = 0;

    for (const file of holders) {
      const sites = releaseSites(file, sources.get(file) ?? '');
      // A holder with no release at all is its own finding: either the parse
      // returned nothing (so this file measured nothing for it) or the slot is
      // never handed back, which strands every sibling for the whole run.
      expect(sites.length, `${file} holds a slot and never releases it`).toBeGreaterThanOrEqual(1);
      releasesFound += sites.length;
      for (const site of sites) {
        if (!site.protectedByFinally) offenders.push(`${file}:${site.line}`);
      }
    }

    // The positive control on the parse: as many releases as holders, at least.
    // A `releaseSites` that returned `[]` for everything would satisfy the
    // offender assertion below by finding nothing wrong.
    expect(releasesFound, 'the AST walk found no release calls at all').toBeGreaterThanOrEqual(
      holders.length,
    );

    expect(
      offenders,
      'a slot release can abort before closePostgres(); returning the reserved connection does NOT end the hold, so nest it: try { await slot.release() } finally { await closePostgres() }',
    ).toEqual([]);
  });

  it('runs the WHOLE teardown inside the region that closes the pool', () => {
    // The wider property, and the one this file's header always claimed: "a
    // holder whose pg_advisory_unlock throws — OR WHOSE TEARDOWN RAISES A 23503
    // BEFORE IT GETS THERE — aborts its hook one statement short". The
    // assertion above only checks the release; it says nothing about what runs
    // above the `try`, and in two holders that was the entire teardown (35
    // statements in awin-writes, 21 in adapter-contract-suite). A `23503` on the
    // canonical deletes is a measured failure mode in this suite (#270), so the
    // unprotected region was not hypothetical.
    //
    // The rule is that the OUTERMOST protecting `try` is the hook's FIRST
    // statement. Five holders already satisfied it; the two that did not are
    // exactly the two whose teardown sat above it.
    const offenders: string[] = [];
    for (const file of holders) {
      for (const site of releaseSites(file, sources.get(file) ?? '')) {
        if (site.outermostProtectingIsFirst === false) offenders.push(`${file}:${site.line}`);
      }
    }
    expect(
      offenders,
      'statements run before the region that closes the pool; a 23503 there strands the slot, so wrap the whole hook: try { …teardown… } finally { try { await slot.release() } finally { await closePostgres() } }',
    ).toEqual([]);
  });

  it('detects the offending shape and clears the compliant ones', () => {
    // The mutation self-test. The census above can only report zero offenders,
    // which is what a dead detector reports too — so the shapes are exercised
    // against literal buffers here, including the two-level nesting one holder
    // actually uses and the near miss of a `finally` that closes nothing.
    const probe = (body: string): ReleaseSite[] => releaseSites('probe.ts', body);

    const sequential = probe(`
      afterAll(async () => {
        await policySlot?.release();
        await closePostgres();
      });
    `);
    expect(sequential).toHaveLength(1);
    expect(sequential[0]?.protectedByFinally, 'the sequential shape read as safe').toBe(false);

    const nested = probe(`
      afterAll(async () => {
        try {
          await policySlot?.release();
        } finally {
          await closePostgres();
        }
      });
    `);
    expect(nested[0]?.protectedByFinally, 'the nested shape read as unsafe').toBe(true);

    const guarded = probe(`
      afterAll(async () => {
        try {
          if (sweepSlot) await sweepSlot.release();
        } finally {
          await closePostgres();
        }
      });
    `);
    expect(guarded[0]?.protectedByFinally, 'the guarded nested shape read as unsafe').toBe(true);

    // Two levels: the release sits in an INNER `finally`, which is inside the
    // OUTER `try` whose `finally` closes the pool. This is `ebay-ingestion`'s
    // shape and it must pass, or the rule would punish the more careful file.
    const twoLevel = probe(`
      afterAll(async () => {
        try {
          try {
            await releaseMatchPolicy();
          } finally {
            await policySlot?.release();
          }
          await db.delete(someTable);
        } finally {
          await closePostgres();
        }
      });
    `);
    expect(twoLevel[0]?.protectedByFinally, 'the two-level shape read as unsafe').toBe(true);

    // A `finally` that closes nothing is not protection. This is the near miss
    // that a "is it inside a try/finally" rule would wave through.
    const emptyFinally = probe(`
      afterAll(async () => {
        try {
          await policySlot?.release();
        } finally {
          await db.delete(offers);
        }
        await closePostgres();
      });
    `);
    expect(emptyFinally[0]?.protectedByFinally, 'a finally closing nothing read as safe').toBe(
      false,
    );

    // And the reverse: closing the pool in the TRY and releasing in the FINALLY
    // is the wrong order — the lock is held on a connection reserved out of that
    // pool, so the unlock would run against a client that is already ending.
    const inverted = probe(`
      afterAll(async () => {
        try {
          await closePostgres();
        } finally {
          await policySlot?.release();
        }
      });
    `);
    expect(inverted[0]?.protectedByFinally, 'releasing after the close read as safe').toBe(false);

    // A CONDITIONAL close is not protection. The subtree walk cannot tell a
    // statement from one buried in an `if`, so `closesDirectly` is what rejects
    // this — and without it the census would have reported a hook that closes
    // the pool on some paths as fully protected.
    const conditional = probe(`
      afterAll(async () => {
        try {
          await policySlot?.release();
        } finally {
          if (rare) {
            await closePostgres();
          }
        }
      });
    `);
    expect(conditional[0]?.protectedByFinally, 'a conditional close read as safe').toBe(false);

    // A release DEFINED inside the try and INVOKED after it. Lexically it sits
    // in the try block, so the containment check alone reports it protected;
    // dynamically it runs once the pool is already closed.
    const deferred = probe(`
      afterAll(async () => {
        let run;
        try {
          run = async () => { await policySlot?.release(); };
        } finally {
          await closePostgres();
        }
        await run();
      });
    `);
    expect(deferred[0]?.protectedByFinally, 'a deferred release read as safe').toBe(false);

    // A release in a CATCH whose finally closes IS safe, and rejecting it was
    // why nobody could write the natural try/catch/finally.
    const caught = probe(`
      afterAll(async () => {
        try {
          await teardown();
        } catch (error) {
          await policySlot?.release();
        } finally {
          await closePostgres();
        }
      });
    `);
    expect(caught[0]?.protectedByFinally, 'a release in a catch read as unsafe').toBe(true);
  });

  it('detects a teardown that runs before the protecting region', () => {
    const probe = (body: string): ReleaseSite[] => releaseSites('probe.ts', body);

    // The shape the two holders had: everything above a correctly nested
    // release, so a throw in the teardown never reaches the close.
    const above = probe(`
      afterAll(async () => {
        await db.delete(someTable).where(x);
        try {
          await policySlot?.release();
        } finally {
          await closePostgres();
        }
      });
    `);
    expect(above[0]?.protectedByFinally, 'the release itself is still nested').toBe(true);
    expect(above[0]?.outermostProtectingIsFirst, 'statements above the region read as safe').toBe(
      false,
    );

    // The shape they now have, and `ebay-ingestion`'s: the whole hook inside a
    // region whose finally closes the pool through a nested try. The outer
    // finally closes only in its SUBTREE, which is why that side of the rule
    // asks the weaker question.
    const wrapped = probe(`
      afterAll(async () => {
        try {
          await db.delete(someTable).where(x);
        } finally {
          try {
            await policySlot?.release();
          } finally {
            await closePostgres();
          }
        }
      });
    `);
    expect(wrapped[0]?.protectedByFinally).toBe(true);
    expect(wrapped[0]?.outermostProtectingIsFirst, 'the wrapped shape read as unsafe').toBe(true);

    // No protecting region at all reports `null` rather than `false`: that file
    // is already named by the offender list above, and reporting it twice would
    // make one defect look like two.
    const bare = probe(`
      afterAll(async () => {
        await policySlot?.release();
        await closePostgres();
      });
    `);
    expect(bare[0]?.protectedByFinally).toBe(false);
    expect(bare[0]?.outermostProtectingIsFirst).toBeNull();
  });

  it('does not mistake an unrelated call for a slot release', () => {
    // `.release` is a plausible name elsewhere. The detector takes any
    // zero-argument `.release()` because all seven holders spell it that way and
    // no other call in the scanned estate does — but a name that merely CONTAINS
    // it, or a call carrying arguments, is a different thing and must not be
    // counted, or a file could fail this gate for something that holds no lock.
    expect(releaseSites('probe.ts', 'await lease.releaseAll();')).toHaveLength(0);
    expect(releaseSites('probe.ts', 'await pool.release(connection);')).toHaveLength(0);
    expect(releaseSites('probe.ts', 'const released = slot.released;')).toHaveLength(0);
    expect(releaseSites('probe.ts', 'await slot.release();')).toHaveLength(1);
  });

  it('counts a holder by its binding and not by a mention of the mutex', () => {
    const acquire = `${'policySlot'} = await ${'acquire'}${'ActivePolicySlot'}(db);`;
    const sweep = `${'sweepSlot'} = await ${'acquire'}${'ReconciliationSweepSlot'}(db);`;
    expect(ACQUIRES_SLOT.test(stripComments(acquire))).toBe(true);
    expect(ACQUIRES_SLOT.test(stripComments(sweep))).toBe(true);
    // The one false positive that would SILENCE this gate rather than fail it:
    // a file whose acquire was deleted, with prose still quoting the assignment,
    // must not be scanned as a holder — its floor contribution would be a lie.
    expect(ACQUIRES_SLOT.test(stripComments(`// ${acquire}`))).toBe(false);
    expect(ACQUIRES_SLOT.test(stripComments(`/**\n * @example\n * ${sweep}\n */`))).toBe(false);
    // And a near miss on the name.
    expect(ACQUIRES_SLOT.test(`const ${'acquire'}${'ActivePolicySlotKey'} = 1;`)).toBe(false);
  });
});
