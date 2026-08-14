/**
 * Every Postgres advisory lock is issued on a handle whose kind matches the
 * lock's SCOPE.
 *
 * ## The mechanism, which belongs to no single file
 *
 * Postgres has two advisory-lock scopes and postgres.js has three kinds of
 * handle, and only two of the six combinations are safe:
 *
 * | statement | pooled `db` | reserved connection | transaction |
 * |---|---|---|---|
 * | `pg_advisory_lock` / `_unlock` (SESSION) | **broken** | correct | wrong scope |
 * | `pg_advisory_xact_lock` (TRANSACTION) | **broken** | wrong scope | correct |
 *
 * Both broken cells fail SILENTLY, in opposite directions:
 *
 * - A **session** lock taken through the pool is released by nothing the caller
 *   controls. `sql.reserve()` takes an IDLE connection and the connection that
 *   just took the lock is the idlest one there is, so the unlock can be served
 *   by a different backend; `pg_advisory_unlock` then returns **false** and the
 *   lock survives until `sql.end()`. Measured against a real server (#275):
 *   `lock taken on pid 104346 | reserved pid 104346 | unlock ran on pid 104347
 *   | returned: false | locks STILL held: 1`. Six realdb files were in exactly
 *   that shape and not one of them read the boolean.
 * - A **transaction** lock taken through the pool is acquired inside the
 *   implicit transaction of that one statement and released the instant it
 *   commits. It serializes NOTHING and looks exactly like a lock that worked —
 *   `db/referrals/rewardRepository.ts` names this, which is why it refuses the
 *   root connection.
 *
 * Neither raises, neither logs, and the assertions downstream of them keep
 * passing. So the rule is derived here rather than remembered, on
 * `slot-teardown-census.test.ts`'s precedent.
 *
 * ## Why the compiler and not a regular expression
 *
 * The question is *what handle issued this statement*, which is a fact about
 * the expression tree: the tag of a tagged template, or the receiver of the
 * `.execute` call the `sql` fragment was passed to. A regex over lines cannot
 * see either, and `grep` is LINE-based — several of the compliant statements
 * here are written across three lines, so a line pattern reports them as
 * absent, which reads exactly like a clean estate. `typescript` is already the
 * dependency `tsc` runs from.
 *
 * A statement is a TAGGED template, and nothing else can be one: SQL reaches
 * the server through `sql` or through a postgres.js handle used as a tag, while
 * prose about `pg_advisory_lock` — of which this file is the largest example in
 * the repository — is a comment, a plain string or an untagged template. That
 * narrowing is not a nicety; the first run of this census reported
 * `active-policy-slot.ts` as an offender for the ERROR MESSAGE quoting the
 * function whose boolean #275 asked it to read.
 *
 * ## The floors
 *
 * A census that found nothing reports zero offenders, which is what a correct
 * estate reports too. So this file asserts a scanned-file floor, a floor on
 * the statements FOUND, and — the part that matters — that it saw at least one
 * COMPLIANT example of each shape it claims to classify. A classifier that
 * stopped recognising `reserve()` would report every session lock as an
 * offender (loud), but one that stopped recognising the STATEMENTS would report
 * a clean estate (silent), and those two floors are what tell them apart.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The shared trigger-toggle key, which must be declared in exactly ONE module.
 *
 * Its VALUE means nothing and its SAMENESS across every file that opens a
 * database-wide trigger window is the whole mechanism, so a second declaration
 * is the one edit that could silently switch the mutex off for one file. It was
 * declared in nine files under three names before #275.
 */
const TRIGGER_TOGGLE_LOCK_KEY = '6820068';

/** Where that key is allowed to be declared. Exactly one module, by design. */
const TRIGGER_TOGGLE_LOCK_OWNER = 'db/__tests__/trigger-toggle-lock.ts';

/**
 * Floor on the advisory statements found. FOURTEEN today: two `lock`/`unlock`
 * pairs on reserved connections (the two slot mutexes), one transaction lock in
 * the shared teardown helper, two in `rewardRepository`, and seven in
 * `advisory-lock-handle.realdb.test.ts`, which drives every cell of the table
 * above against a real server.
 *
 * Eight is far enough above zero to catch a broken walk, a moved directory or a
 * detector that stopped matching, while leaving room for one mechanism to
 * legitimately retire without a build failure. A commit lowering it must name
 * the lock that went and why.
 */
const STATEMENT_FLOOR = 8;

/** Scanned-file floor. 1,673 `.ts` files under `src/` today. */
const SCANNED_FILE_FLOOR = 1_000;

/**
 * The named anchor for the SESSION/reserved shape.
 *
 * `active-policy-slot.ts` is #63's mutex over the global active-matching-policy
 * slot: five realdb files queue on it and none of them can hold it in a
 * transaction, because the hold spans a whole FILE. Retires when the last of
 * those files stops needing an active matching policy — at which point this
 * anchor must be repointed at `reconciliation-sweep-slot.ts` (the only other
 * session-level holder) rather than deleted, or the compliant-session floor
 * below stops proving the classifier works.
 */
const SESSION_ANCHOR = 'services/ingestion/__tests__/active-policy-slot.ts';

/**
 * The named anchor for the TRANSACTION/xact shape, and deliberately a
 * PRODUCTION module: a control naming test code has a shelf life equal to that
 * test's, and the two partner/campaign cap locks are the only advisory locks
 * this service takes while serving a request. Retires when referral reward caps
 * stop being enforced by a read-then-write window.
 */
const TRANSACTION_ANCHOR = 'db/referrals/rewardRepository.ts';

/**
 * The ONE file permitted to issue the broken shape, and it must issue it
 * EXACTLY ONCE.
 *
 * `advisory-lock-handle.realdb.test.ts` measures the defect against a real
 * server: it takes a session lock on a reserved connection and then unlocks it
 * through the POOL, so that `pg_advisory_unlock` returning **false** and the
 * lock surviving are observed facts rather than a claim this census makes about
 * source text. That statement cannot be written any other way — the pool is the
 * subject.
 *
 * It is an exact COUNT and not a permission. `toBe(1)` fails in both
 * directions: a second deliberate offender in that file has to be argued for
 * rather than absorbed, and a count of ZERO means the measurement stopped
 * measuring, which is the failure an allow-list would hide. Everything else in
 * that file — its lock, its own-session unlock, its transaction cases — is
 * checked normally.
 */
const MEASUREMENT_EXEMPTION = 'db/__tests__/advisory-lock-handle.realdb.test.ts';
const MEASUREMENT_EXEMPTION_SITES = 1;

/** `{relative path → source}` for every `.ts` under `src/`. */
function scannedSources(): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      sources.set(relative(SRC_ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8'));
    }
  };
  walk(SRC_ROOT);
  return sources;
}

/** How long a lock lives, which is a property of the FUNCTION it names. */
type LockScope = 'session' | 'transaction';

/**
 * Every advisory-lock entry point Postgres publishes, as ONE pattern.
 *
 * The whole family, not the two spellings this repository happens to use:
 * `_shared`, `pg_try_*` and `pg_advisory_unlock_all` are all real functions with
 * the same two scopes, and a detector narrowed to today's usage would clear a
 * `pg_advisory_lock_shared` taken through the pool — a miss in the permissive
 * direction, which is the one that reads as a clean estate. The `(` is required
 * so a name that merely CONTAINS one of these is not a call.
 */
const ADVISORY_CALL =
  /\bpg_(?:try_)?advisory_(?<xact>xact_)?(?:lock|unlock)(?:_shared|_all)?\s*\(/u;

/** What kind of connection issued it, as far as this file can establish. */
type HandleKind = 'reserved' | 'transaction' | 'other';

interface AdvisorySite {
  readonly line: number;
  readonly scope: LockScope;
  readonly handle: string | null;
  readonly handleKind: HandleKind;
  readonly compliant: boolean;
}

/**
 * The handle a TAGGED template was issued on.
 *
 * Two shapes, and no third exists in this repository:
 *
 * - `` reserved`select pg_advisory_lock(1)` `` — a postgres.js handle used
 *   directly as a template tag, so the TAG is the handle. Type arguments are
 *   irrelevant: `` reserved<Row[]>`…` `` has the same tag.
 * - `` db.execute(sql`select pg_advisory_lock(1)`) `` — a drizzle fragment
 *   passed to `.execute`, so the RECEIVER of that call is the handle.
 *
 * `null` means a `sql` fragment this file cannot attribute to an `.execute`,
 * which is REPORTED rather than waved through: a statement whose issuer cannot
 * be named is a statement this census cannot clear.
 */
function handleFor(tagged: ts.TaggedTemplateExpression): string | null {
  const tag = tagged.tag.getText();
  if (tag !== 'sql') return tag;

  const call = tagged.parent;
  if (
    call !== undefined &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === 'execute'
  ) {
    return call.expression.expression.getText();
  }
  return null;
}

/**
 * Identifiers this file binds to a RESERVED connection.
 *
 * The binding is `= await <anything>.reserve(…)`, which is the only way to take
 * a connection out of a postgres.js pool. Named rather than inferred, because
 * "is this handle borrowable by somebody else" is the entire question.
 */
function reservedNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isAwaitExpression(node.initializer) &&
      ts.isCallExpression(node.initializer.expression) &&
      ts.isPropertyAccessExpression(node.initializer.expression.expression) &&
      node.initializer.expression.expression.name.text === 'reserve'
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return names;
}

/**
 * The three ways this repository establishes that a handle is a TRANSACTION,
 * each a named authority rather than a naming convention:
 *
 * 1. the parameter of a callback passed to `.transaction(…)` — drizzle's own
 *    entry point;
 * 2. a binding from `requireTransaction(…)` — `db/moderation/transactionGuard.ts`,
 *    which discriminates a real transaction handle from the root connection at
 *    RUNTIME, because the two share a type;
 * 3. the parameter of a callback passed to `withTriggerToggleLock(…)`, which is
 *    (1) one call deep and hands its callback the `tx` it opened.
 *
 * A parameter merely ANNOTATED `Transaction` is deliberately not enough: the
 * root `Database` and a transaction share `DatabaseOrTransaction`, which is the
 * exact confusion `requireTransaction` exists to resolve.
 */
function transactionNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const callbackOpeners = new Set(['transaction', 'withTriggerToggleLock']);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText();
      if (callbackOpeners.has(callee)) {
        for (const argument of node.arguments) {
          if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) continue;
          const [parameter] = argument.parameters;
          if (parameter !== undefined && ts.isIdentifier(parameter.name)) {
            names.add(parameter.name.text);
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText() === 'requireTransaction'
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return names;
}

/** Every advisory-lock statement in one file, classified. */
function advisorySites(file: string, source: string): AdvisorySite[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const reserved = reservedNames(parsed);
  const transactional = transactionNames(parsed);
  const sites: AdvisorySite[] = [];

  const visit = (node: ts.Node): void => {
    /**
     * TAGGED templates only, and that is the load-bearing narrowing.
     *
     * SQL cannot be issued from an untagged template — every path goes through
     * `sql` or a postgres.js handle — while a mention of the function name in
     * ordinary prose is untagged by definition. This census's own first run
     * proved the point: it reported `active-policy-slot.ts` as an offender for
     * the ERROR MESSAGE that quotes `pg_advisory_unlock(…)` when the unlock
     * comes back false, which is the very line #275 asked for.
     *
     * The hole it accepts is a statement assembled at runtime
     * (`sql.raw(someString)`); no census over source can see one, and nothing
     * in this repository builds an advisory lock that way.
     */
    if (ts.isTaggedTemplateExpression(node)) {
      const call = ADVISORY_CALL.exec(node.template.getText());
      const scope: LockScope | null =
        call === null ? null : call.groups?.xact === undefined ? 'session' : 'transaction';
      if (scope !== null) {
        const handle = handleFor(node);
        const handleKind: HandleKind =
          handle !== null && reserved.has(handle)
            ? 'reserved'
            : handle !== null && transactional.has(handle)
              ? 'transaction'
              : 'other';
        sites.push({
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
          scope,
          handle,
          handleKind,
          compliant:
            (scope === 'session' && handleKind === 'reserved') ||
            (scope === 'transaction' && handleKind === 'transaction'),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return sites;
}

/** Files declaring a given numeric literal, comments and prose excluded. */
function filesDeclaringNumber(sources: Map<string, string>, value: string): string[] {
  const found: string[] = [];
  for (const [file, source] of sources) {
    // Separators stripped, so `6_820_068` and `6820068` are one pre-filter. It
    // can only over-match, and the AST pass below is what decides.
    if (!source.replace(/_/gu, '').includes(value)) continue;
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    let declares = false;
    const visit = (node: ts.Node): void => {
      if (declares) return;
      if (ts.isNumericLiteral(node) && node.getText().replace(/_/gu, '') === value) {
        declares = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(parsed, visit);
    if (declares) found.push(file);
  }
  return found.sort();
}

describe('the advisory-lock census', () => {
  const sources = scannedSources();
  // Parsing 1,600 files to find seven statements is wasted work, so the parse
  // is narrowed by a raw-text pre-filter. The filter can only ADD files (a
  // comment mentioning the function parses to no statement), never remove one,
  // and the assertions below pin that it saw the two known-present anchors.
  const candidates = [...sources].filter(([, source]) => source.includes('pg_advisory'));
  const sites = new Map<string, AdvisorySite[]>();
  for (const [file, source] of candidates) {
    const found = advisorySites(file, source);
    if (found.length > 0) sites.set(file, found);
  }
  const allSites = [...sites].flatMap(([file, found]) => found.map((site) => ({ file, ...site })));

  it('walked a plausible source tree and found advisory-lock statements', () => {
    // The vacuity floor. A broken walk, a moved directory or an extension
    // filter that stopped matching all report the same clean zero as a correct
    // scan, and every assertion below would pass on each of them.
    expect(sources.size, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(
      SCANNED_FILE_FLOOR,
    );
    expect(
      allSites.length,
      'no advisory-lock statement was found at all — the detector or the walk stopped working',
    ).toBeGreaterThanOrEqual(STATEMENT_FLOOR);
  });

  it('classified a compliant example of BOTH shapes it claims to detect', () => {
    // The positive control on the OUTPUT, and the one that matters. A
    // classifier that stopped recognising `reserve()` fails loudly (every
    // session lock becomes an offender); one that stopped recognising the
    // statements reports a clean estate, which is indistinguishable from
    // success. These two floors are what separate them.
    const compliantSession = allSites.filter(
      (site) => site.scope === 'session' && site.compliant,
    );
    const compliantTransaction = allSites.filter(
      (site) => site.scope === 'transaction' && site.compliant,
    );
    expect(
      compliantSession.length,
      'no session lock was classified as compliant — the reserved-connection classifier is not working',
    ).toBeGreaterThanOrEqual(2);
    expect(
      compliantTransaction.length,
      'no transaction lock was classified as compliant — the transaction-handle classifier is not working',
    ).toBeGreaterThanOrEqual(1);

    // And the anchors, which pin that the two classifiers cleared the specific
    // modules they were written against rather than something else that
    // happened to match. Retirement conditions are at each constant.
    expect(compliantSession.map((site) => site.file)).toContain(SESSION_ANCHOR);
    expect(compliantTransaction.map((site) => site.file)).toContain(TRANSACTION_ANCHOR);
  });

  it('deliberately issues the broken shape exactly once, where it is measured', () => {
    // The exemption, as an EXACT count in both directions. Zero would mean the
    // real-server measurement stopped exercising the defect — the silent
    // failure an allow-list cannot report — and two would mean a second site
    // was absorbed into a list that only ever grows.
    const deliberate = allSites.filter(
      (site) => site.file === MEASUREMENT_EXEMPTION && !site.compliant,
    );
    expect(
      deliberate.length,
      `${MEASUREMENT_EXEMPTION} must issue the pooled unlock it measures exactly ${MEASUREMENT_EXEMPTION_SITES} time(s)`,
    ).toBe(MEASUREMENT_EXEMPTION_SITES);
    expect(deliberate[0]?.scope, 'the exempted statement is not the one #275 is about').toBe(
      'session',
    );
    // And the rest of that file is held to the rule like everything else, so
    // the exemption covers one statement rather than one file.
    expect(
      allSites.filter((site) => site.file === MEASUREMENT_EXEMPTION && site.compliant).length,
      'the measurement file issues nothing correct — it can no longer show the contrast',
    ).toBeGreaterThanOrEqual(3);
  });

  it('issues every advisory lock on a handle matching its scope', () => {
    const offenders = allSites
      .filter((site) => !site.compliant && site.file !== MEASUREMENT_EXEMPTION)
      .map(
        (site) =>
          `${site.file}:${site.line} — ${site.scope}-scoped lock on ${
            site.handle === null ? 'an unidentifiable handle' : `\`${site.handle}\` (${site.handleKind})`
          }`,
      );
    expect(
      offenders,
      [
        'an advisory lock is issued on the wrong kind of handle.',
        'A SESSION lock (pg_advisory_lock/pg_advisory_unlock) belongs on a connection nobody else can borrow — `const reserved = await db.$client.reserve()` — because a pooled unlock can be served by a different backend, returns false and leaks the lock until the pool closes.',
        'A TRANSACTION lock (pg_advisory_xact_lock) belongs inside a transaction, because outside one it is released by the implicit commit of its own statement and serializes nothing.',
        'For a database-wide trigger-toggle window, call `withTriggerToggleLock`.',
      ].join(' '),
    ).toEqual([]);
  });

  it('declares the shared trigger-toggle key in exactly one module', () => {
    // Not a floor: an EXACT set. The key's sameness is the whole mechanism, so
    // a second declaration is the one edit that silently switches the mutex off
    // for one file while every test stays green.
    expect(filesDeclaringNumber(sources, TRIGGER_TOGGLE_LOCK_KEY)).toEqual([
      TRIGGER_TOGGLE_LOCK_OWNER,
    ]);
  });

  it('detects both broken shapes and clears both correct ones', () => {
    // The mutation self-test. The census above can only report zero offenders,
    // which is what a dead detector reports too — so every cell of the table in
    // this file's header is exercised against a literal buffer.
    const probe = (body: string): AdvisorySite[] => advisorySites('probe.ts', body);

    const pooledSession = probe(`
      afterAll(async () => {
        await db.execute(sql\`select pg_advisory_lock(6820068)\`);
        try {
          await db.delete(policies);
        } finally {
          await db.execute(sql\`select pg_advisory_unlock(6820068)\`);
        }
      });
    `);
    expect(pooledSession, 'the shape #275 reported was not detected twice').toHaveLength(2);
    expect(pooledSession.every((site) => site.scope === 'session')).toBe(true);
    expect(pooledSession.every((site) => site.compliant), 'a pooled session lock read as safe').toBe(
      false,
    );
    expect(pooledSession[0]?.handle).toBe('db');

    const reservedSession = probe(`
      const reserved = await db.$client.reserve();
      await reserved\`select pg_advisory_lock(1)\`;
      const [row] = await reserved<{ released: boolean }[]>\`select pg_advisory_unlock(1) as released\`;
    `);
    expect(reservedSession).toHaveLength(2);
    expect(
      reservedSession.every((site) => site.compliant),
      'a session lock on a reserved connection read as unsafe',
    ).toBe(true);

    // The #275 shape exactly: the LOCK on the reserved connection and the
    // UNLOCK back through the pool. Only the unlock is an offender, which is
    // what makes the finding readable.
    const halfReserved = probe(`
      const reserved = await db.$client.reserve();
      await reserved\`select pg_advisory_lock(1)\`;
      await db.execute(sql\`select pg_advisory_unlock(1)\`);
    `);
    expect(halfReserved.map((site) => site.compliant)).toEqual([true, false]);

    const transactionXact = probe(`
      await db.transaction(async (tx) => {
        await tx.execute(sql\`select pg_advisory_xact_lock(6820068)\`);
        await tx.delete(policies);
      });
    `);
    expect(transactionXact).toHaveLength(1);
    expect(transactionXact[0]?.scope).toBe('transaction');
    expect(transactionXact[0]?.compliant, 'a xact lock inside a transaction read as unsafe').toBe(
      true,
    );

    // A transaction lock on the POOL is the mirror failure: acquired and
    // released by the implicit transaction of its own statement, serializing
    // nothing, with no error and no log line.
    const pooledXact = probe(`await db.execute(sql\`select pg_advisory_xact_lock(1)\`);`);
    expect(pooledXact, 'a xact lock outside a transaction was not detected').toHaveLength(1);
    expect(pooledXact[0]?.compliant, 'a xact lock on the pool read as safe').toBe(false);

    // `requireTransaction` is the repository's runtime discriminator, so a
    // handle it produced is a transaction — `rewardRepository`'s shape.
    const guarded = probe(`
      const tx = requireTransaction(db, 'lockPartnerCapWindow');
      await tx.execute(sql\`select pg_advisory_xact_lock(CLASS, hashtext(key))\`);
    `);
    expect(guarded[0]?.compliant, 'a xact lock behind requireTransaction read as unsafe').toBe(true);

    // And the helper's callback parameter, which is one call deeper than
    // drizzle's own `.transaction(`.
    const helper = probe(`
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(sql\`select pg_advisory_xact_lock(1)\`);
      });
    `);
    expect(helper[0]?.compliant, "the helper's callback handle read as unsafe").toBe(true);
  });

  it('counts statements and not prose', () => {
    // This file, and every docblock the six fixed teardowns carry, discusses
    // `pg_advisory_lock` at length. A detector that read a mention as a
    // statement would fail the build on the documentation of the rule.
    const probe = (body: string): AdvisorySite[] => advisorySites('probe.ts', body);
    expect(probe('// await db.execute(sql`select pg_advisory_lock(1)`);')).toHaveLength(0);
    expect(probe('/** Takes `pg_advisory_lock(1)` through the pool. */\nconst x = 1;')).toHaveLength(
      0,
    );
    expect(probe("const name = 'pg_advisory_lock';")).toHaveLength(0);
    // The one this census found in itself on its first run: an error message
    // quoting the function it exists to police. Untagged, therefore not a
    // statement — and the regression case for the narrowing that fixed it.
    expect(
      probe('throw new Error(`pg_advisory_unlock(${KEY}) returned ${String(row)}`);'),
    ).toHaveLength(0);
    // A near miss on the function NAME must not be counted: a call is a name
    // followed by an open paren, and `…_helper(` is a different function.
    expect(probe('await db.execute(sql`select my_pg_advisory_lock_helper(1)`);')).toHaveLength(0);
    // The positive control on those four negatives: the same buffer WITH a real
    // statement is counted, so "zero" above is absence and not blindness.
    expect(probe('await db.execute(sql`select pg_advisory_lock(1)`);')).toHaveLength(1);

    // The rest of the family, which nothing in this repository uses today and
    // which a detector written from today's usage would silently clear. Each is
    // a real Postgres entry point with a real scope.
    const family = (statement: string): AdvisorySite | undefined =>
      probe(`await db.execute(sql\`select ${statement}\`);`)[0];
    expect(family('pg_advisory_lock_shared(1)')?.scope).toBe('session');
    expect(family('pg_try_advisory_lock(1)')?.scope).toBe('session');
    expect(family('pg_advisory_unlock_all()')?.scope).toBe('session');
    expect(family('pg_advisory_xact_lock_shared(1)')?.scope).toBe('transaction');
    expect(family('pg_try_advisory_xact_lock(1)')?.scope).toBe('transaction');
  });
});
