/**
 * TWO rules about the same mutex, and neither can express the other.
 *
 * 1. **Every advisory lock is issued on a handle whose kind matches the lock's
 *    SCOPE** — the table below.
 * 2. **Every `alter table … disable trigger` runs inside a
 *    `withTriggerToggleLock` callback, on that callback's own handle** — or is
 *    named on an EXACT-COUNT exemption list citing #283.
 *
 * The second exists because the first is blind to the failure it cannot see: it
 * asks which handle a lock was issued on, so a trigger window that takes NO
 * lock at all is invisible to it. Ten files were in exactly that state under a
 * green first rule, and the reason it matters is the same either way — the
 * statement is DATABASE-WIDE, so two files inside a window at once leave one of
 * them deleting against a trigger the other has re-enabled, and on the pool the
 * DDL autocommits, so a throw before the re-enable leaves the trigger off for
 * the rest of the run and every later file asserting it refuses a write passes
 * VACUOUSLY.
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

/**
 * Files permitted to open a trigger-toggle window WITHOUT the lock, and how
 * many such windows each is permitted.
 *
 * `alter table … disable trigger` is DATABASE-WIDE, so a file inside one while
 * another file is inside its own leaves one of them deleting against a trigger
 * the other has just re-enabled — and on the POOL the DDL autocommits, so a
 * throw before the re-enable leaves the trigger off for the rest of the run and
 * every later file asserting it refuses a write passes VACUOUSLY.
 *
 * Every entry here is #283's. They are listed rather than fixed because
 * wrapping the largest of them — `awin-writes`'s, some 25 statements spanning a
 * whole `afterAll` — in one transaction holds ACCESS EXCLUSIVE on three tables
 * for a whole teardown, a convoy in place of a leak, which is a decision and
 * not a mechanical edit. (Digits there, and words for the window COUNT below:
 * the two twenty-fives are unrelated numbers about different things.)
 *
 * The COUNT is per file and EXACT, and the list's own length is asserted. That
 * is what makes it shrink-only: fixing a window fails the build until its entry
 * is corrected or deleted, and adding one fails the build wherever it is added.
 * Counts rather than line numbers, so an unrelated edit above a window cannot
 * fail this gate spuriously.
 */
/**
 * Ten files, twenty-five windows — MEASURED by the rule below with an empty
 * list, not counted by hand.
 *
 * Two things a file-level "does it import the helper?" count gets wrong, both
 * found that way: `offer-freshness-sweep.realdb.test.ts` mentions
 * `alter table … disable trigger` only in PROSE, saying it does not do one, and
 * `adapter-contract-suite.ts` has an unlocked `match_policy_versions` window
 * sitting beside the `catalog_source_policies` one that IS locked. The unit is
 * the statement, not the file.
 */
const EXPECTED_EXEMPTIONS = 10;

const UNLOCKED_TRIGGER_WINDOWS: ReadonlyArray<{
  readonly file: string;
  readonly disables: number;
  readonly reason: string;
}> = [
  {
    file: 'db/__tests__/relationships.realdb.test.ts',
    disables: 1,
    reason: '#283 — `relationship_reviews_append_only`, toggled on the pool in one teardown.',
  },
  {
    file: 'db/__tests__/store-linkage.realdb.test.ts',
    disables: 1,
    reason:
      '#283 — `store_linkage_profile_adoptions_append_only`, toggled on the pool in one teardown.',
  },
  {
    file: 'services/__tests__/awin-writes.realdb.test.ts',
    disables: 4,
    reason:
      '#283 — the file uses the lock for its `catalog_source_policies` window and NOT for three `awin_*` triggers spanning most of its `afterAll` (~25 deletes between the disable and the last enable, whose own comment records a `23503` there as measured) nor for `match_policy_versions`. One transaction over that span holds ACCESS EXCLUSIVE on three tables for a whole teardown — a convoy in place of a leak, which is a decision rather than a mechanical wrap.',
  },
  {
    file: 'services/__tests__/feed-import-writes.realdb.test.ts',
    disables: 3,
    reason: '#283 — three feed-configuration triggers toggled on the pool.',
  },
  {
    file: 'services/__tests__/price-signals.realdb.test.ts',
    disables: 1,
    reason: '#283 — `price_signal_policy_versions_immutable_once_serving`, on the pool.',
  },
  {
    file: 'services/__tests__/referral-rewards.realdb.test.ts',
    disables: 7,
    reason:
      '#283 — the largest: seven windows over reward adjustments, rewards, rules, budgets, the ledger and fee snapshots.',
  },
  {
    file: 'services/ebay/__tests__/ebay-ingestion.realdb.test.ts',
    disables: 2,
    reason:
      '#283 — `catalog_source_policies` and `match_policy_versions`, both toggled on the pool. It used to be the reason `advisory-lock-handle.realdb.test.ts` declined to assert that trigger read `O` before its own window; that case now creates a trigger nothing else can reach, so this entry excuses only itself.',
  },
  {
    file: 'services/ingestion/__tests__/adapter-contract-suite.ts',
    disables: 1,
    reason:
      '#283 — the `match_policy_versions` window, sitting beside the `catalog_source_policies` one this branch DID route through the lock. Proof that the unit is the statement and not the file.',
  },
  {
    file: 'services/matching/__tests__/matching-writes.realdb.test.ts',
    disables: 3,
    reason: '#283 — two benchmark tables plus `match_policy_versions`, on the pool.',
  },
  {
    file: 'services/merchant-demand/__tests__/merchant-demand.realdb.test.ts',
    disables: 2,
    reason: '#283 — two merchant-acquisition append-only triggers, on the pool.',
  },
];

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

/**
 * Opening a database-wide trigger window: `alter table … disable trigger`.
 *
 * The DISABLE is what the gate keys on rather than the matching `enable`. The
 * disable is what opens the window and what a throw can strand; a re-enable
 * without one is not a hazard, and counting both would double every window and
 * make the exemption counts read as twice the problem.
 */
const DISABLES_TRIGGER = /\balter\s+table\b[\s\S]*?\bdisable\s+trigger\b/iu;

interface TriggerWindowSite {
  readonly line: number;
  readonly handle: string | null;
  readonly locked: boolean;
}

/**
 * Every trigger-toggle window in one file, and whether the lock covers it.
 *
 * `locked` asks TWO things, and one alone is not enough: the statement is
 * lexically inside a callback passed to `withTriggerToggleLock(…)`, AND it is
 * issued on THAT callback's own handle. Inside the callback but issued on `db`
 * is the failure wearing the fix's clothes — the DDL would autocommit on a
 * pooled connection while the transaction beside it held a lock covering
 * nothing.
 *
 * The enclosing-callback walk is the same shape as `slot-teardown-census.ts`'s
 * enclosing-`try` walk, and it is lexical for the same reason: a window DEFINED
 * inside the callback and INVOKED after it would read as protected either way,
 * and no file in this repository does that.
 */
function triggerWindowSites(file: string, source: string): TriggerWindowSite[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const sites: TriggerWindowSite[] = [];

  const lockedHandleFor = (node: ts.Node): string | null => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue;
      const call = current.parent;
      if (call === undefined || !ts.isCallExpression(call)) continue;
      if (call.expression.getText() !== 'withTriggerToggleLock') continue;
      const [parameter] = current.parameters;
      return parameter !== undefined && ts.isIdentifier(parameter.name)
        ? parameter.name.text
        : null;
    }
    return null;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && DISABLES_TRIGGER.test(node.template.getText())) {
      const handle = handleFor(node);
      sites.push({
        line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        handle,
        locked: handle !== null && handle === lockedHandleFor(node),
      });
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
  // The trigger-window pass is a SECOND walk over the same estate, narrowed by
  // its own pre-filter. It cannot reuse `candidates`: a file can toggle a
  // trigger without naming an advisory lock anywhere, which is exactly the
  // population this rule exists to find.
  const windows = new Map<string, TriggerWindowSite[]>();
  for (const [file, source] of sources) {
    if (!/disable\s+trigger/iu.test(source)) continue;
    const found = triggerWindowSites(file, source);
    if (found.length > 0) windows.set(file, found);
  }

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

  it('takes the lock for every trigger-toggle window, or exempts it by name', () => {
    // The half the handle rule CANNOT express. Everything above asks which
    // handle a lock was issued on; nothing there can see a window that takes NO
    // lock at all, which is how a ten-file gap sat under a green gate.
    const offenders: string[] = [];
    for (const [file, found] of windows) {
      const unlocked = found.filter((site) => !site.locked);
      if (unlocked.length === 0) continue;
      const exemption = UNLOCKED_TRIGGER_WINDOWS.find((entry) => entry.file === file);
      if (exemption === undefined) {
        offenders.push(
          `${file} — ${unlocked.length} unlocked window(s) at ${unlocked
            .map((site) => site.line)
            .join(', ')}`,
        );
        continue;
      }
      // An EXACT count, so an exemption cannot silently absorb a new window.
      if (exemption.disables !== unlocked.length) {
        offenders.push(
          `${file} — exempted for ${exemption.disables} unlocked window(s), found ${unlocked.length} at ${unlocked
            .map((site) => site.line)
            .join(', ')}`,
        );
      }
    }
    expect(
      offenders,
      'a database-wide `alter table … disable trigger` runs outside `withTriggerToggleLock`. On the POOL that DDL autocommits, so a throw before the matching enable leaves the trigger off for the rest of the run and every later file asserting it refuses a write passes vacuously. Wrap the window in `withTriggerToggleLock(db, async (tx) => …)` and issue every statement on `tx`, or add the file to UNLOCKED_TRIGGER_WINDOWS with a reason.',
    ).toEqual([]);
  });

  it('keeps the exemption list shrink-only and every entry live', () => {
    // The list's OWN exact-count assertion. A floor would let it grow one
    // individually-defensible line at a time, which is the gate switching
    // itself off — and it has to fail on a STALE entry too, so #283 closing a
    // window means deleting its entry rather than leaving one that excuses
    // nothing.
    expect(
      UNLOCKED_TRIGGER_WINDOWS.length,
      'the exemption list changed size — it may only SHRINK, as #283 closes windows',
    ).toBe(EXPECTED_EXEMPTIONS);
    expect(new Set(UNLOCKED_TRIGGER_WINDOWS.map((entry) => entry.file)).size).toBe(
      EXPECTED_EXEMPTIONS,
    );

    const stale: string[] = [];
    for (const entry of UNLOCKED_TRIGGER_WINDOWS) {
      expect(sources.has(entry.file), `${entry.file} is exempted and does not exist`).toBe(true);
      expect(entry.reason, `${entry.file}'s exemption states no reason`).toMatch(/#283/u);
      const unlocked = (windows.get(entry.file) ?? []).filter((site) => !site.locked).length;
      if (unlocked !== entry.disables) stale.push(`${entry.file}: ${unlocked} unlocked, exempted ${entry.disables}`);
    }
    expect(
      stale,
      'an exemption no longer matches what its file does — delete it if #283 closed the window, correct it otherwise',
    ).toEqual([]);
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

  it('detects an unlocked trigger window and clears a locked one', () => {
    // The mutation self-test for the SECOND rule. Like the first, it can only
    // report zero offenders, which is what a dead detector reports too.
    const probe = (body: string): TriggerWindowSite[] => triggerWindowSites('probe.ts', body);

    const pooled = probe('await db.execute(sql`alter table x disable trigger t`);');
    expect(pooled, 'a bare pooled trigger toggle was not detected').toHaveLength(1);
    expect(pooled[0]?.locked, 'a pooled trigger toggle read as locked').toBe(false);

    const locked = probe(`
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(sql\`alter table x disable trigger t\`);
        await tx.delete(x);
        await tx.execute(sql\`alter table x enable trigger t\`);
      });
    `);
    expect(locked).toHaveLength(1);
    expect(locked[0]?.locked, 'a window inside the helper read as unlocked').toBe(true);

    // Inside the callback but issued on `db` — the failure wearing the fix's
    // clothes. The DDL would autocommit on a pooled connection while the
    // transaction beside it held a lock covering nothing, so requiring the
    // callback's OWN handle is the load-bearing half of the rule.
    const wrongHandle = probe(`
      await withTriggerToggleLock(db, async (tx) => {
        await db.execute(sql\`alter table x disable trigger t\`);
      });
    `);
    expect(wrongHandle[0]?.locked, "a pooled toggle inside the callback read as locked").toBe(
      false,
    );

    // A plain `db.transaction` is NOT the lock. It makes the DDL atomic and
    // leaves the window racing every other file, which is the collision the key
    // exists for.
    const bareTransaction = probe(`
      await db.transaction(async (tx) => {
        await tx.execute(sql\`alter table x disable trigger t\`);
      });
    `);
    expect(bareTransaction[0]?.locked, 'a bare transaction read as locked').toBe(false);

    // `disable trigger all` is the same window (offer-freshness spells it that
    // way), and an `enable` alone is NOT counted — counting both would double
    // every window and make each exemption read as twice the problem.
    expect(probe('await tx.execute(sql`alter table x disable trigger all`);')).toHaveLength(1);
    expect(probe('await tx.execute(sql`alter table x enable trigger t`);')).toHaveLength(0);

    // Prose, again. Every one of the ten exempted files documents what it
    // toggles, and this census's own header names the statement repeatedly.
    expect(probe('// await db.execute(sql`alter table x disable trigger t`);')).toHaveLength(0);
    expect(probe('/** toggles `alter table x disable trigger t` */\nconst y = 1;')).toHaveLength(0);
    expect(probe("const sqlText = 'alter table x disable trigger t';")).toHaveLength(0);
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
