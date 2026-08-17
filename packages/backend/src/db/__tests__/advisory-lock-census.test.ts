/**
 * THREE rules about the same mutex, and none can express another.
 *
 * 1. **Every advisory lock is issued on a handle whose kind matches the lock's
 *    SCOPE** — the table below.
 * 2. **Every `alter table … disable trigger` runs inside a
 *    `withTriggerToggleLock` callback, on that callback's own handle.** No
 *    exemption, and there is no list to add one to.
 * 3. **No window is opened from inside another transaction, another window, or
 *    while taking a session slot** — the three call-site shapes that turn a
 *    queue into a cycle. See {@link windowCallSites}.
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
 * Those ten files carried twenty-five windows and an exact-count exemption
 * entry each. #283 closed all twenty-five, five of them by DELETING the
 * toggle rather than locking it — a `before update` trigger cannot fire on a
 * delete, so those windows had never guarded anything and the narrowest window
 * is no window. The list went with the last entry: an empty allow-list plus the
 * code that reads it is a mechanism nothing exercises, which reads as coverage.
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

/**
 * Floor on `session_replication_role` statements found.
 *
 * ONE today — `buyer-requests.realdb.test.ts`'s teardown, which is also the
 * site that showed the census was blind to this idiom: it has been live and
 * unmeasured. A floor rather than an exact count because the spelling is a
 * legitimate one that other teardowns may adopt; zero means the detector or the
 * walk stopped working, which is indistinguishable from a clean tree without
 * this line. A commit lowering it must name the teardown that went and why.
 */
const SESSION_ROLE_FLOOR = 1;

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
 * Floor on the trigger windows FOUND, and the reason it had to be written.
 *
 * There is no exemption list any more: #283 closed all twenty-five windows, so
 * the rule below is absolute and a file cannot opt out of it. That is the
 * strongest state this gate has been in and it removed a floor nobody had
 * noticed was one — every exemption entry asserted a NON-ZERO unlocked count
 * for its file, so a detector that stopped matching `alter table … disable
 * trigger` used to fail ten of those assertions at once. With the list gone the
 * same regression would report zero offenders over zero windows, which is
 * exactly what a clean estate reports.
 *
 * So the count is asserted directly. THIRTY-FOUR windows in fifteen files
 * today, every one of them locked — measured by running this assertion against
 * an impossible floor and reading what it reports, not counted from a grep,
 * which is LINE-based and counts the prose three of those files carry about the
 * statement.
 *
 * Thirty rather than a comfortable twenty, and a FILE floor beside it. The
 * deleted list asserted a non-zero unlocked count for each of ten named files,
 * so a detector narrowing to a spelling three of them used failed three
 * assertions; a single global floor with generous headroom replaces that with
 * one number, and twenty would tolerate fourteen windows vanishing — more than
 * every window this issue touched. Four windows and three files of headroom is
 * enough for a teardown that legitimately stops needing an escape (five did in
 * #283, where a trigger with no DELETE event turned out never to have guarded
 * anything) and no more. A commit lowering either must name the windows that
 * went and why.
 */
const TRIGGER_WINDOW_FLOOR = 30;

/** Files carrying at least one window. Fifteen today; see the floor above. */
const TRIGGER_WINDOW_FILE_FLOOR = 12;

/**
 * The named anchor for a LOCKED window, on `SESSION_ANCHOR`'s reasoning and
 * with the longest shelf life available: `advisory-lock-handle.realdb.test.ts`
 * opens its window on a trigger it CREATES two statements earlier and drops in
 * a `finally`, so no port, no cutover and no teardown rewrite can invalidate
 * it — it measures the helper itself, and retires with the helper.
 *
 * A floor on the count says the detector saw something. This says it cleared
 * the specific window it was written against rather than something else that
 * happened to match.
 */
const TRIGGER_WINDOW_ANCHOR = 'db/__tests__/advisory-lock-handle.realdb.test.ts';

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
 * The name of the function a call invokes, property access resolved.
 *
 * `helpers.withTriggerToggleLock(…)` and `withTriggerToggleLock(…)` name the
 * same function, and this is written ONCE because the three walks below used to
 * disagree: matching the property name in one place and the full expression text
 * in another meant a qualified call could be counted as a window by one rule and
 * reported as UNLOCKED by another — one correct window failing the build for a
 * reason that is not about it.
 */
function calleeName(call: ts.CallExpression): string {
  return ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : call.expression.getText();
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
      if (callbackOpeners.has(calleeName(node))) {
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

/**
 * The OTHER way to turn triggers off, and the broader one:
 * `set [local] session_replication_role = replica` suppresses every trigger on
 * every table for the rest of its scope.
 *
 * It is kept as a SEPARATE detector rather than folded into `DISABLES_TRIGGER`
 * because it fits none of the machinery above: it names no table and no
 * trigger, so `TOGGLE_SUBJECT` cannot read a subject out of it, there is no
 * matching `enable` for the pairing walk to find, and rule 4's "one table per
 * window" is not a question that can be asked of a statement whose scope is
 * "all of them".
 *
 * It is deliberately NOT held to `withTriggerToggleLock`. That lock exists
 * because `alter table … disable trigger` takes ShareRowExclusive on each table
 * it names, which conflicts with an ordinary writer; `set local` takes no table
 * lock at all, so requiring the mutex here would queue teardowns behind each
 * other for no benefit and re-create the #301 deadlock — a gate that pushes you
 * toward the hazard is worse than no gate.
 *
 * What it IS held to is the two ways this statement fails silently, below.
 */
const DISABLES_TRIGGERS_SESSION_WIDE = /\bsession_replication_role\b/iu;

/** `SET LOCAL`, as opposed to a bare `SET` that outlives the transaction. */
const SCOPED_TO_TRANSACTION = /\bset\s+local\s+session_replication_role\b/iu;

interface TriggerWindowSite {
  readonly line: number;
  readonly handle: string | null;
  readonly locked: boolean;
  /** `<table>/<trigger>`, as written. `null` when the statement cannot be read. */
  readonly toggles: string | null;
  /** Whether the SAME window re-enables what this statement disabled. */
  readonly reEnabled: boolean;
  /**
   * Identity of the enclosing `withTriggerToggleLock` callback, so two disables
   * can be told to be in ONE window rather than in two. The callback's start
   * offset; `null` when the statement is in no window at all (which rule 2
   * already fails it for).
   */
  readonly windowStart: number | null;
  /** The TABLE this statement names, as written. `null` when unreadable. */
  readonly table: string | null;
}

/**
 * The table and trigger a toggle names, as WRITTEN.
 *
 * Compared as text and not resolved: two statements in one window either spell
 * the same table and trigger or they do not, and the interpolated spellings
 * (`${sql.raw(PROBE_TABLE)}`) pair with each other exactly as literal ones do.
 *
 * The captures exclude backticks and quotes deliberately. `\S+` swallows the
 * template's own closing backtick, so a disable written inline and its enable
 * written across three lines capture DIFFERENT tokens for one trigger and fail
 * to pair — a false positive on correct code, which is the direction that gets
 * a gate deleted.
 */
const TOGGLE_SUBJECT =
  /\balter\s+table\s+(?<table>[^\s`'"]+)\s+(?<action>disable|enable)\s+trigger\s+(?<trigger>[^\s`'";]+)/iu;

/**
 * The ONE file allowed to disable a trigger and never re-enable it, and it must
 * do so EXACTLY once.
 *
 * `advisory-lock-handle.realdb.test.ts` disables its own probe trigger and then
 * THROWS, because what it measures is that the ROLLBACK restores it — an
 * `enable` there would destroy the measurement by making the assertion pass
 * whether or not the transaction rolled anything back. Same reasoning, and the
 * same exact-count shape, as `MEASUREMENT_EXEMPTION` above: zero would mean the
 * measurement stopped exercising the case, and two would mean a second site was
 * absorbed.
 */
const UNPAIRED_DISABLE_EXEMPTION = MEASUREMENT_EXEMPTION;
const UNPAIRED_DISABLE_SITES = 1;

interface SessionRoleSite {
  readonly line: number;
  /** `set local …` rather than a bare `set …`. */
  readonly scopedToTransaction: boolean;
  /** The handle the statement was issued on, as written. `null` when unreadable. */
  readonly handle: string | null;
  /** Whether that handle is a transaction handle by `transactionNames`' rules. */
  readonly onTransactionHandle: boolean;
}

/**
 * Every `session_replication_role` statement in one file.
 *
 * The handle is read the same way the advisory-lock walk reads one, and
 * classified by the SAME `transactionNames` set, so "is this a transaction
 * handle" has one answer in this file rather than two that can disagree.
 */
function sessionRoleSites(file: string, source: string): SessionRoleSite[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = transactionNames(parsed);
  const sites: SessionRoleSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node) === 'execute') {
      const statement = node.arguments.map((argument) => argument.getText(parsed)).join(' ');
      if (DISABLES_TRIGGERS_SESSION_WIDE.test(statement)) {
        const callee = node.expression;
        const handle =
          ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
            ? callee.expression.text
            : null;
        sites.push({
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
          scopedToTransaction: SCOPED_TO_TRANSACTION.test(statement),
          handle,
          onTransactionHandle: handle !== null && names.has(handle),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return sites;
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

  /** The callback of the `withTriggerToggleLock(…)` this node sits inside. */
  const enclosingWindow = (node: ts.Node): ts.ArrowFunction | ts.FunctionExpression | null => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue;
      const call = current.parent;
      if (call === undefined || !ts.isCallExpression(call)) continue;
      if (calleeName(call) !== 'withTriggerToggleLock') continue;
      return current;
    }
    return null;
  };

  const handleOf = (window: ts.ArrowFunction | ts.FunctionExpression | null): string | null => {
    const parameter = window?.parameters[0];
    return parameter !== undefined && ts.isIdentifier(parameter.name) ? parameter.name.text : null;
  };

  /**
   * Every `<table>/<trigger>` this window ENABLES.
   *
   * Collected from the whole callback rather than from the statements after the
   * disable: a window that re-enables before it deletes would be a different
   * bug, and one this rule is not about — what it asks is whether the window
   * COMMITS with the trigger off.
   */
  const enabledWithin = (window: ts.ArrowFunction | ts.FunctionExpression): Set<string> => {
    const enabled = new Set<string>();
    const walk = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node)) {
        const match = TOGGLE_SUBJECT.exec(node.template.getText());
        if (match?.groups?.action?.toLowerCase() === 'enable') {
          enabled.add(`${match.groups.table}/${match.groups.trigger}`);
        }
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(window, walk);
    return enabled;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && DISABLES_TRIGGER.test(node.template.getText())) {
      const handle = handleFor(node);
      const window = enclosingWindow(node);
      const subject = TOGGLE_SUBJECT.exec(node.template.getText())?.groups;
      const toggles =
        subject?.table !== undefined && subject.trigger !== undefined
          ? `${subject.table}/${subject.trigger}`
          : null;
      sites.push({
        line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        handle,
        locked: handle !== null && handle === handleOf(window),
        toggles,
        reEnabled: window !== null && toggles !== null && enabledWithin(window).has(toggles),
        windowStart: window === null ? null : window.getStart(parsed),
        table: subject?.table ?? null,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return sites;
}

interface WindowCallSite {
  readonly line: number;
  readonly insideTransaction: boolean;
  readonly insideWindow: boolean;
  readonly takesSlotInside: boolean;
}

/**
 * Taking a session slot, or reserving a connection, from inside a window.
 *
 * The estate's lock ORDER is one-way today: in every file that does both, the
 * slot is acquired strictly before any window opens. Stated as the ordering
 * property and not as hook names, because the hook names are already wrong —
 * `matching-writes.realdb.test.ts` takes its slot in `beforeAll` and opens its
 * windows in `afterEach`, which preserves the order while contradicting the
 * tidier sentence. A window that took a slot would be the edge that closes the
 * cycle.
 */
const SLOT_ACQUISITION = /acquire\w*Slot\s*\(|\$client\.reserve\s*\(|\bsql\.reserve\s*\(/u;

/**
 * Every `withTriggerToggleLock` call in one file, and the three shapes around it
 * that would DEADLOCK rather than fail.
 *
 * The helper takes the mutex as its transaction's FIRST statement, so a waiter
 * holds no table locks while it queues and two teardowns queue rather than
 * cycle. That reasoning is a property of the CALL SITE as much as of the helper,
 * and all three ways to break it are invisible to every rule above:
 *
 * - **inside another transaction** — the outer one already holds row locks on
 *   whatever it has written, and goes on holding them while the inner waits for
 *   the mutex. A second teardown holding the mutex and waiting for ACCESS
 *   EXCLUSIVE on one of those tables completes the cycle. Postgres would break
 *   it with a `40P01`, so this one at least fails loudly.
 * - **inside another window** — the inner call opens a SECOND pooled connection
 *   and asks for a transaction lock its own caller holds. Nothing detects that:
 *   it is two sessions, so it is not re-entrancy, and the deadlock detector sees
 *   one waiter and no cycle. It HANGS to the hook timeout.
 * - **a session slot taken inside a window** — reverses the estate's one-way
 *   order between this mutex and the two file-scoped slot mutexes.
 *
 * Zero instances today, over 27 call sites — which is why the mutation self-test
 * below is the load-bearing half: a detector with nothing to find reports the
 * same clean estate as one that stopped working.
 *
 * What it does NOT see, stated rather than implied: `takesSlotInside` reads the
 * SOURCE TEXT of the callback argument, so a window whose callback is a named
 * function (`withTriggerToggleLock(db, teardownWindow)`) or which delegates to a
 * helper that reserves is invisible to it. `insideWindow` is lexical for the
 * same reason and misses a window opened by a function its CALLER wrapped —
 * `adapter-contract-suite.ts`'s two windows run from several adapter test files.
 * The nesting half is covered at RUNTIME instead, by the helper itself:
 * `withTriggerToggleLock` throws a named error on re-entry rather than blocking
 * forever on a lock its own caller holds. The slot half has no runtime
 * counterpart and is a stated limit of this scan, not a covered case.
 */
function windowCallSites(file: string, source: string): WindowCallSite[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const sites: WindowCallSite[] = [];

  const isCallOf = (node: ts.Node, name: string): boolean =>
    ts.isCallExpression(node) && calleeName(node) === name;

  const enclosedBy = (node: ts.Node, name: string): boolean => {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      if (isCallOf(current, name)) return true;
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (isCallOf(node, 'withTriggerToggleLock')) {
      const callback = ts.isCallExpression(node) ? node.arguments[1] : undefined;
      sites.push({
        line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        insideTransaction: enclosedBy(node, 'transaction'),
        insideWindow: enclosedBy(node, 'withTriggerToggleLock'),
        takesSlotInside: callback !== undefined && SLOT_ACQUISITION.test(callback.getText()),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return sites;
}

/**
 * Floor on the window CALL SITES found. Twenty-seven today across FIFTEEN
 * files — the same fifteen the window floor counts, measured the same way. The
 * call count is lower than the window count because a call may carry more than
 * one disable: two children-first tables torn down together share one
 * acquisition rather than taking the mutex twice.
 */
const WINDOW_CALL_SITE_FLOOR = 15;

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
  // The session-wide pass. Its own pre-filter for the same reason the window
  // pass has one: a file can suppress every trigger without naming
  // `disable trigger` or an advisory lock anywhere, and that population — the
  // one this detector was added for — is invisible to both passes above.
  const sessionRoles = new Map<string, SessionRoleSite[]>();
  for (const [file, source] of sources) {
    if (!DISABLES_TRIGGERS_SESSION_WIDE.test(source)) continue;
    const found = sessionRoleSites(file, source);
    if (found.length > 0) sessionRoles.set(file, found);
  }
  const allSessionRoles = [...sessionRoles].flatMap(([file, found]) =>
    found.map((site) => ({ file, ...site })),
  );

  // The call-site walk is a THIRD pass, hoisted here beside the other two so a
  // second consumer does not re-parse the same files a fourth time.
  const calls = [...sources].flatMap(([file, source]) =>
    source.includes('withTriggerToggleLock')
      ? windowCallSites(file, source).map((site) => ({ file, ...site }))
      : [],
  );

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

  it('scopes every session-wide trigger suppression to its own transaction', () => {
    // The idiom the window detector above cannot see. `alter table … disable
    // trigger` is one of TWO ways to turn triggers off, and this is the other —
    // broader, since it suppresses every trigger on every table.
    //
    // The vacuity floor first: this detector was added because nothing matched
    // the idiom at all, so "no sites" is exactly what the defect looked like.
    expect(
      allSessionRoles.length,
      'no `session_replication_role` statement was found — the detector or the walk stopped working',
    ).toBeGreaterThanOrEqual(SESSION_ROLE_FLOOR);

    // Rule one: `SET LOCAL`. A bare `SET` outlives the transaction and, on a
    // POOLED connection, outlives the test — the next file to borrow that
    // backend runs with every trigger silenced and its append-only assertions
    // pass vacuously. Exactly the pooled-leak shape #275 measured one domain
    // over, with a blast radius of every table instead of one lock.
    const unscoped = allSessionRoles
      .filter((site) => !site.scopedToTransaction)
      .map((site) => `${site.file}:${site.line}`);
    expect(
      unscoped,
      'a `session_replication_role` statement is not `SET LOCAL`. A bare `SET` persists after the ' +
        'transaction commits and, on a pooled connection, after the test releases it — every ' +
        'later file on that backend then runs with all triggers off and passes vacuously.',
    ).toEqual([]);

    // Rule two: it must be issued on a TRANSACTION handle. `SET LOCAL` outside
    // a transaction is scoped to the statement and silently does nothing, so
    // the teardown it was meant to unblock fails on the trigger it thought it
    // had disabled — the plausible failure, not an error.
    const unscopedHandle = allSessionRoles
      .filter((site) => !site.onTransactionHandle)
      .map(
        (site) =>
          `${site.file}:${site.line} — issued on ${
            site.handle === null ? 'an unidentifiable handle' : `\`${site.handle}\``
          }`,
      );
    expect(
      unscopedHandle,
      'a `SET LOCAL session_replication_role` is issued outside a transaction. `SET LOCAL` outside ' +
        'a transaction block applies to the current statement only, so it suppresses nothing and ' +
        'the write it was meant to permit still hits the trigger.',
    ).toEqual([]);
  });

  it('detects both ways of suppressing a session-wide trigger — the self-test', () => {
    // Written from the IDIOM. There was no probe for this construct anywhere in
    // the census before #454, which is the sharper version of the defect: a
    // MISSING probe is invisible to review in a way a wrong assertion is not,
    // because there is no line to read and disagree with.
    //
    // The detector is fed real statements rather than tokens lifted out of its
    // own pattern, and the parser is run over a synthetic MODULE, so what is
    // measured is the classifier a real file goes through — not the regex.
    const specimen = [
      'export async function teardown(db: Database) {',
      '  await db.transaction(async (tx) => {',
      '    await tx.execute(sql`set local session_replication_role = replica`);',
      '  });',
      '}',
    ].join('\n');
    const good = sessionRoleSites('specimen.ts', specimen);
    expect(good.length, 'the detector no longer sees the statement at all').toBe(1);
    expect(good[0]?.scopedToTransaction).toBe(true);
    expect(good[0]?.onTransactionHandle).toBe(true);

    // The bare `SET`, which is the leak.
    const bare = sessionRoleSites(
      'specimen.ts',
      [
        'export async function teardown(db: Database) {',
        '  await db.transaction(async (tx) => {',
        '    await tx.execute(sql`set session_replication_role = replica`);',
        '  });',
        '}',
      ].join('\n'),
    );
    expect(bare[0]?.scopedToTransaction, 'a bare SET is being read as scoped').toBe(false);

    // And the statement issued on the ROOT handle inside a transaction — the
    // failure wearing the fix's clothes, the same shape the advisory-lock
    // handle rule exists to catch.
    const pooled = sessionRoleSites(
      'specimen.ts',
      [
        'export async function teardown(db: Database) {',
        '  await db.transaction(async (tx) => {',
        '    await db.execute(sql`set local session_replication_role = replica`);',
        '  });',
        '}',
      ].join('\n'),
    );
    expect(pooled[0]?.onTransactionHandle, 'a root-handle statement is being read as scoped').toBe(
      false,
    );
  });

  it('declares the shared trigger-toggle key in exactly one module', () => {
    // Not a floor: an EXACT set. The key's sameness is the whole mechanism, so
    // a second declaration is the one edit that silently switches the mutex off
    // for one file while every test stays green.
    expect(filesDeclaringNumber(sources, TRIGGER_TOGGLE_LOCK_KEY)).toEqual([
      TRIGGER_TOGGLE_LOCK_OWNER,
    ]);
  });

  it('takes the lock for every trigger-toggle window, with no exemption', () => {
    // The half the handle rule CANNOT express. Everything above asks which
    // handle a lock was issued on; nothing there can see a window that takes NO
    // lock at all, which is how a ten-file gap sat under a green gate.
    //
    // There is no opt-out. The list that used to sit here carried ten entries
    // and an exact length so it could only shrink; #283 shrank it to nothing,
    // and an empty list plus the machinery to read it is a mechanism no test
    // exercises — so the mechanism went with the last entry. Re-introducing one
    // is a visible act rather than a line appended to an array.
    const offenders: string[] = [];
    for (const [file, found] of windows) {
      const unlocked = found.filter((site) => !site.locked);
      if (unlocked.length === 0) continue;
      offenders.push(
        `${file} — ${unlocked.length} unlocked window(s) at ${unlocked
          .map((site) => site.line)
          .join(', ')}`,
      );
    }
    expect(
      offenders,
      'a database-wide `alter table … disable trigger` runs outside `withTriggerToggleLock`. On the POOL that DDL autocommits, so a throw before the matching enable leaves the trigger off for the rest of the run and every later file asserting it refuses a write passes vacuously. Wrap the window in `withTriggerToggleLock(db, async (tx) => …)` and issue every statement on `tx` — and before you do, check whether the trigger has an event the window can even fire: several of #283\'s turned out to be `before update` triggers bracketing a delete, and the narrowest window is no window.',
    ).toEqual([]);
  });

  it('opens no window over more than ONE table', () => {
    // RULE 4 (#301), and it is the half rules 1-3 cannot express: all three ask
    // about the LOCK, and this one is about how many TABLE locks the window
    // holds at once.
    //
    // `alter table … disable trigger` takes ShareRowExclusive — not ACCESS
    // EXCLUSIVE, which is what this repository said until #301 measured it off a
    // real `pg_locks` wait and off CI's own `40P01` detail. ShareRowExclusive
    // does NOT conflict with AccessShare, so a plain reader is not the
    // counterparty and never was; it conflicts with RowExclusive, which is what
    // every ordinary INSERT/UPDATE/DELETE holds. So a window holding one
    // table's lock while acquiring a second's deadlocks against any writer that
    // takes the two in the opposite order — and the shared mutex CANNOT prevent
    // it, because the mutex serialises window against window and this
    // counterparty is a plain write from any sibling file. Measured: it killed
    // a `Deploy to AWS` run on `main` (merge 9c1d430) on `ledger_entries` ->
    // `ledger_transactions` against `insertLedgerTransaction`.
    //
    // The rule is "one table", not "the writer's order", deliberately. Ordering
    // is correct only until somebody adds a writer with the opposite one, and
    // both orders already exist here: `insertLedgerTransaction` writes parent
    // then child (the foreign key forces it) while `applyRewardAdjustment`
    // writes child then parent. With one disable per window the transaction
    // holds exactly ONE strong lock, and every other lock it takes is
    // RowExclusive, which never conflicts with another RowExclusive — so no
    // cycle can form, whatever any writer does later.
    const offenders: string[] = [];
    let windowsExamined = 0;
    for (const [file, found] of windows) {
      const byWindow = new Map<number, TriggerWindowSite[]>();
      for (const site of found) {
        if (site.windowStart === null) continue;
        const group = byWindow.get(site.windowStart) ?? [];
        group.push(site);
        byWindow.set(site.windowStart, group);
      }
      for (const group of byWindow.values()) {
        windowsExamined++;
        const tables = new Set(group.map((site) => site.table ?? '<unreadable>'));
        if (tables.size > 1) {
          offenders.push(
            `${file}:${group[0]?.line} — one window over ${tables.size} tables (${[...tables].join(', ')})`,
          );
        }
      }
    }

    // The floor is what separates "no window holds two tables" from "the
    // grouping stopped working" — a parser that lost `windowStart` reports the
    // same empty list a clean estate does.
    expect(
      windowsExamined,
      'the one-table rule grouped no windows at all, so its empty offender list measures nothing',
    ).toBeGreaterThanOrEqual(TRIGGER_WINDOW_FLOOR - 4);

    expect(
      offenders,
      'a `withTriggerToggleLock` window disables triggers on more than one table. `alter table … disable trigger` takes ShareRowExclusive, which conflicts with the RowExclusive an ordinary INSERT/UPDATE/DELETE holds — so holding one table\'s lock while acquiring another\'s deadlocks (40P01) against any writer taking the pair the other way round, and the shared mutex cannot prevent it because it serialises windows against windows while the counterparty is a plain writer. Split it: one `withTriggerToggleLock` call per table, keeping the DELETES children-first where a foreign key requires it. Do NOT instead reorder the disables to match the current writer — both orders already exist in this repository, so that is a bet rather than a fix.',
    ).toEqual([]);
  });

  it('detects a two-table window and clears two one-table windows', () => {
    // The mutation self-test for RULE 4. Like the others it can only report an
    // empty list, which is what a dead detector reports too.
    const probe = (body: string): TriggerWindowSite[] => triggerWindowSites('probe.ts', body);
    const windowCount = (sites: TriggerWindowSite[]): number =>
      new Set(sites.filter((site) => site.windowStart !== null).map((site) => site.windowStart))
        .size;

    // The shape that cost the deploy: ONE window, two tables.
    const merged = probe(`
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(sql\`alter table ledger_entries disable trigger a\`);
        await tx.execute(sql\`alter table ledger_transactions disable trigger b\`);
      });
    `);
    expect(merged, 'the two disables were not detected').toHaveLength(2);
    expect(windowCount(merged), 'two disables in one callback read as two windows').toBe(1);
    expect(
      new Set(merged.map((site) => site.table)).size,
      'the two tables were not told apart',
    ).toBe(2);

    // The fix: two windows, one table each.
    const split = probe(`
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(sql\`alter table ledger_entries disable trigger a\`);
      });
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(sql\`alter table ledger_transactions disable trigger b\`);
      });
    `);
    expect(windowCount(split), 'two separate calls read as one window').toBe(2);
    for (const site of split) {
      expect(site.windowStart, 'a split window lost its identity').not.toBeNull();
    }

    // Two disables of the SAME table in one window are not an offence — the
    // second acquires no new lock. `offer-freshness` spells one `disable
    // trigger all`, and a window may legitimately name its table twice.
    const sameTable = probe(`
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(sql\`alter table x disable trigger a\`);
        await tx.execute(sql\`alter table x disable trigger b\`);
      });
    `);
    expect(windowCount(sameTable)).toBe(1);
    expect(new Set(sameTable.map((site) => site.table)).size).toBe(1);
  });

  it('re-enables in the same window everything it disables', () => {
    // The rule the other two cannot express, and #283's own failure surviving
    // its fix: locking a window says nothing about whether it CLOSES. Drop the
    // matching `enable` and the transaction COMMITS with the trigger off — every
    // other assertion here passes, the window count is unchanged, and the
    // trigger is off database-wide for the rest of the run. This branch
    // restructured twenty-five windows, including two merges and one three-way
    // split, which is exactly the edit that loses an enable.
    const offenders: string[] = [];
    for (const [file, found] of windows) {
      if (file === UNPAIRED_DISABLE_EXEMPTION) continue;
      for (const site of found) {
        if (site.reEnabled) continue;
        offenders.push(
          `${file}:${site.line} — disables ${site.toggles ?? 'an unreadable subject'} and never enables it in the same window`,
        );
      }
    }
    expect(
      offenders,
      'a window disables a trigger and commits without re-enabling it, which leaves it off database-wide for the rest of the run — the failure the lock exists to prevent, arriving through the front door. Add the matching `alter table … enable trigger …` on the same handle, inside the same callback.',
    ).toEqual([]);

    // The deliberate offender, as an EXACT count in both directions. Zero means
    // the rollback measurement stopped exercising the case it exists for.
    const deliberate = (windows.get(UNPAIRED_DISABLE_EXEMPTION) ?? []).filter(
      (site) => !site.reEnabled,
    );
    expect(
      deliberate.length,
      `${UNPAIRED_DISABLE_EXEMPTION} must disable-without-enabling exactly ${UNPAIRED_DISABLE_SITES} time(s) — that window throws on purpose, because what it measures is the ROLLBACK restoring the trigger`,
    ).toBe(UNPAIRED_DISABLE_SITES);
  });

  it('found trigger windows to police, and cleared the one it was written against', () => {
    // The vacuity floor for the SECOND rule, and it exists because deleting the
    // exemption list deleted the floor nobody had noticed was one: ten entries
    // each asserting a non-zero unlocked count meant a detector that stopped
    // matching failed loudly. Without them, "zero offenders" is what a dead
    // detector and a clean estate both report.
    const all = [...windows].flatMap(([file, found]) => found.map((site) => ({ file, ...site })));
    expect(
      all.length,
      'no trigger-toggle window was found at all — the detector or the walk stopped working',
    ).toBeGreaterThanOrEqual(TRIGGER_WINDOW_FLOOR);
    // A count alone can be met by one file carrying every window, so the file
    // spread is asserted too: a detector narrowing to a spelling a few files
    // share drops the file count first.
    expect(
      windows.size,
      'the windows found are spread over too few files — a detector narrowed to one spelling reports exactly this',
    ).toBeGreaterThanOrEqual(TRIGGER_WINDOW_FILE_FLOOR);
    // And the anchor, which pins that the detector cleared the specific window
    // it was written against. Retirement condition at the constant.
    const anchored = all.filter((site) => site.file === TRIGGER_WINDOW_ANCHOR);
    expect(anchored.length, `${TRIGGER_WINDOW_ANCHOR} no longer opens a trigger window`).toBe(1);
    expect(anchored[0]?.locked, `${TRIGGER_WINDOW_ANCHOR}'s own window read as unlocked`).toBe(true);
  });

  it('opens no trigger window from inside a transaction, a window or a slot', () => {
    // The third rule, and the only one whose failure is a HANG rather than a
    // red test. See `windowCallSites` for the three shapes and why the helper's
    // "the lock is the first statement" guarantee is a property of the call site
    // too.
    expect(
      calls.length,
      'no `withTriggerToggleLock` call was found at all — the detector or the walk stopped working',
    ).toBeGreaterThanOrEqual(WINDOW_CALL_SITE_FLOOR);

    // The measurement file drives the nested shape against a real server, to
    // prove the helper THROWS a named error rather than blocking to the hook
    // timeout. An exact count in both directions, like the other two exemptions
    // here: zero means that measurement stopped exercising the case.
    const deliberate = calls.filter(
      (site) => site.file === MEASUREMENT_EXEMPTION && site.insideWindow,
    );
    expect(
      deliberate.length,
      `${MEASUREMENT_EXEMPTION} must nest a window exactly ${MEASUREMENT_EXEMPTION_SITES} time(s) — that is where the runtime guard is measured`,
    ).toBe(MEASUREMENT_EXEMPTION_SITES);

    const offenders = calls
      .filter((site) => !(site.file === MEASUREMENT_EXEMPTION && site.insideWindow))
      .filter((site) => site.insideTransaction || site.insideWindow || site.takesSlotInside)
      .map(
        (site) =>
          `${site.file}:${site.line} — ${
            site.insideWindow
              ? 'nested inside another window; the inner call opens a SECOND connection and waits for a lock its own caller holds, which hangs to the hook timeout rather than deadlocking'
              : site.insideTransaction
                ? 'opened inside another transaction, which holds its row locks while this one queues for the mutex'
                : 'takes a session slot inside the window, reversing the one-way order between this mutex and the two file-scoped slot mutexes'
          }`,
      );
    expect(
      offenders,
      'a trigger-toggle window is opened from a place that can deadlock. The mutex is the transaction\'s FIRST statement precisely so a waiter holds no table locks while it queues — hoist the window out of the enclosing transaction, or take the slot before the window rather than inside it.',
    ).toEqual([]);
  });

  it('detects all three deadlock shapes and clears the correct one', () => {
    // The mutation self-test, and here it is the whole of the evidence: the rule
    // above has ZERO instances to find, so a detector that stopped working
    // reports exactly what a healthy estate reports.
    const probe = (body: string): WindowCallSite[] => windowCallSites('probe.ts', body);

    const nested = probe(
      'await db.transaction(async (outer) => { await outer.insert(t); await withTriggerToggleLock(db, async (tx) => { await tx.execute(sql`x`); }); });',
    );
    expect(nested.at(-1)?.insideTransaction, 'a window inside a transaction read as safe').toBe(
      true,
    );

    const inWindow = probe(
      'await withTriggerToggleLock(db, async (a) => { await withTriggerToggleLock(db, async (b) => { await b.execute(sql`x`); }); });',
    );
    expect(inWindow.some((site) => site.insideWindow), 'a nested window read as safe').toBe(true);

    // The slot name here is FICTIONAL, and deliberately. `slot-teardown-census`
    // detects a holder with a regex over comment-stripped source, so it reads a
    // real `= await acquireActivePolicySlot(` inside a string literal as a
    // genuine acquisition — measured: this file was reported as a holder that
    // never releases, which is a file with no slot meeting that census's holder
    // floor. Its false positives are loud by design, so the fix belongs here.
    // `SLOT_ACQUISITION` matches on the SHAPE (`acquire…Slot`), so a fictional
    // name exercises it exactly as a real one would.
    const slot = probe(
      'await withTriggerToggleLock(db, async (tx) => { const s = await acquireFictionalSlot(db); await tx.execute(sql`x`); });',
    );
    expect(slot[0]?.takesSlotInside, 'a slot taken inside a window read as safe').toBe(true);

    // The other alternative in the same pattern, which is how the two
    // file-scoped mutexes actually take their connection.
    const reserved = probe(
      'await withTriggerToggleLock(db, async (tx) => { const c = await db.$client.reserve(); await tx.execute(sql`x`); });',
    );
    expect(reserved[0]?.takesSlotInside, 'a reserve() inside a window read as safe').toBe(true);

    // The control, in the same currency: the shape every teardown in this
    // repository uses must clear all three.
    const clean = probe(
      'await withTriggerToggleLock(db, async (tx) => { await tx.execute(sql`alter table x disable trigger t`); });',
    );
    expect(clean).toHaveLength(1);
    expect(
      clean[0]?.insideTransaction || clean[0]?.insideWindow || clean[0]?.takesSlotInside,
      'the ordinary teardown shape read as a deadlock',
    ).toBe(false);
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
