/**
 * Every `enqueue*` that takes a database handle takes it as a REQUIRED
 * parameter — never `= getDb()`, never `db?`, and never `db ?? getDb()` one
 * frame up.
 *
 * ## Why a census rather than a runtime guard
 *
 * The root `Database` and a transaction handle share the ONE
 * `DatabaseOrTransaction` type, so the compiler cannot tell them apart. A
 * defaulted handle therefore makes "I forgot to thread `tx`" a legal call that
 * compiles, lints and passes any test asserting the row exists — while writing
 * on the root connection, outside the transaction the caller believed it was in.
 * Making the parameter required converts exactly that mistake into a compile
 * error, which is why nine of these already spelled it that way and why #584
 * removed the five that did not.
 *
 * The house pattern has a second, stronger form and it is deliberately NOT what
 * this file asserts: `enqueueModerationOutboxEvent` REFUSES the root connection
 * at runtime through `requireTransaction`, which discriminates a transaction by
 * whether `.rollback` is a function. That is right for a row which must commit
 * with the abuse report or the report is lost. It is wrong for a convergence
 * request that reads live state when it runs, where the root connection is a
 * real answer — so those enqueues take the handle, and the caller says which one
 * it means.
 *
 * ## Why a test asserting today's callers pass `tx` would not do
 *
 * Because it goes green again the moment somebody adds a second caller, which is
 * the case the guard is for. #584 says so in as many words. The property is
 * about the SIGNATURE, so the census is over signatures.
 *
 * ## What the compile error is worth, measured
 *
 * Four cases run against a real server while #584 was written, and the spread is
 * the reason the signature has to carry this rather than a convention:
 *
 * | shape | omitting the handle |
 * |---|---|
 * | repository called directly, inside the tx CREATING the subject | `23503` — loud, fails closed |
 * | the same, through a wrapper that catches (`requestNativeOfferSync`, `requestMatch`) | swallowed to a WARN; the subject commits and the job is LOST |
 * | already-committed subject, caller's tx rolls back | the row SURVIVES the rollback |
 * | handle threaded correctly | the row rolls back with its caller |
 *
 * Only the first is loud, and it is reachable from exactly one call site in the
 * repository (`catalog-authoring/publish.service.ts`, which calls the repository
 * rather than the wrapper, deliberately — a swallowed error inside a transaction
 * poisons it, `25P02`). Everything else is silent.
 *
 * ## Required is NECESSARY and not SUFFICIENT, and this is where to read why
 *
 * The backend compiles `strict: false`. Without `strictNullChecks` an
 * `undefined` satisfies a required parameter, so a caller holding an OPTIONAL
 * handle — `applyGraphWriter(tx?: DatabaseOrTransaction)` — can pass the bare
 * `tx` and type-check cleanly, then throw inside the enqueue where the wrappers
 * swallow. Measured while #584 was written: the catalogue backfill reported a
 * successful run and materialized ZERO native offers where it had produced two,
 * and `tsc`, eslint and this census were all green on it. The suite is what
 * caught it.
 *
 * So this file states the SIGNATURE half of the rule and cannot state the
 * argument half. A caller whose own handle is optional coalesces at the call
 * site (`tx ?? getDb()`), where the optionality is known — which is still the
 * caller deciding, and is exactly what a default in the callee is not.
 *
 * ## Two things this deliberately does not do
 *
 * It does NOT require every `enqueue*` to have a handle. `queue/producers.ts`
 * enqueues into BullMQ and touches no database, so there is nothing to omit;
 * a rule demanding one would be satisfied by adding an unused parameter. The
 * population is keyed on the USE — a `DatabaseOrTransaction` in the signature —
 * and the vacuity floors below are what stop that definition from emptying out.
 *
 * It does NOT strip comments, following `listing-publication-chokepoint.test.ts`
 * and `ledger-order-chokepoint.test.ts`: the failure direction of scanning raw
 * source is a false POSITIVE, corrected in one line, while comment stripping
 * truncates at a `//` inside a string literal and can hide a real declaration.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..');
const DB_ROOT = join(SRC_ROOT, 'db');

/**
 * This file, excluded by NAME.
 *
 * The fixtures below are offending source built as strings, so a census that
 * scanned itself would report a defect that is a test string — and the cost of
 * getting that wrong is a permanently red gate somebody disables.
 */
const SELF = basename(fileURLToPath(import.meta.url));

/** The handle's type, assembled so this file never contains the literal. */
const HANDLE_TYPE = 'DatabaseOr' + 'Transaction';

/** The default that #584 removed, assembled for the same reason. */
const ROOT_DEFAULT = 'get' + 'Db()';

/** One `enqueue*` declaration: where it is, and its raw parameter-list text. */
interface EnqueueDeclaration {
  readonly file: string;
  readonly name: string;
  /** The text between the declaration's parentheses, balanced. */
  readonly params: string;
}

/**
 * Every `function enqueue…(` in one source text, with its balanced parameter
 * text.
 *
 * A balanced scan rather than a regex, because these signatures routinely open
 * with an inline options object — `enqueueMatch(input: { … }, db, now?)` — and a
 * regex bounded by the first `)` truncates on `Promise<void>` or on a nested
 * generic. A truncated parameter list reads as "declares no handle", which drops
 * the declaration out of the population silently: a false CLEAN, and precisely
 * the failure that let #584's own census report nine compliant enqueues when
 * four of them were not.
 */
function enqueueDeclarations(file: string, source: string): EnqueueDeclaration[] {
  const found: EnqueueDeclaration[] = [];
  const opener = /(?:export\s+)?(?:async\s+)?function\s+(enqueue\w*)\s*\(/gu;
  let match = opener.exec(source);
  while (match !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      index += 1;
    }
    // An unbalanced tail means the scan ran off the end, which can only happen
    // on source that does not parse. Recording the remaining text keeps the
    // failure LOUD rather than silently dropping the declaration.
    found.push({
      file,
      name: match[1] ?? '',
      params: source.slice(start, depth === 0 ? index - 1 : source.length),
    });
    match = opener.exec(source);
  }
  return found;
}

/** Does this signature take a database handle at all? */
function takesHandle(params: string): boolean {
  return params.includes(HANDLE_TYPE);
}

/**
 * Is the handle OPTIONAL — defaulted, `?`-marked, or explicitly `| undefined`?
 *
 * Three spellings of one defect. `db?: DatabaseOrTransaction` reads as the more
 * cautious one and is worse in practice: the callee then writes
 * `db ?? getDb()`, so the default still exists and has simply moved somewhere a
 * reader of the signature cannot see it. The union spelling is the same again
 * with the optionality written out — and under `strict: false` it is the one
 * that changes nothing at all about what callers may pass, which is exactly why
 * it must not read as compliant.
 */
function handleIsOptional(params: string): boolean {
  const defaulted = new RegExp(`:\\s*${HANDLE_TYPE}\\s*=`, 'u');
  const questioned = new RegExp(`\\w+\\s*\\?\\s*:\\s*${HANDLE_TYPE}`, 'u');
  const unioned = new RegExp(`:\\s*${HANDLE_TYPE}\\s*\\|\\s*undefined`, 'u');
  return defaulted.test(params) || questioned.test(params) || unioned.test(params);
}

/**
 * A coalesced handle passed INTO an `enqueue*` call.
 *
 * The wrapper-level spelling of the same default, and the one that matters more
 * than the repository's: every caller who could omit a handle reaches the
 * repository through a service wrapper, so leaving `db ?? getDb()` there moves
 * the omission one frame up and changes nothing.
 */
function coalescedHandleCalls(file: string, source: string): string[] {
  const pattern = new RegExp(`\\benqueue\\w*\\s*\\([^;]*\\?\\?\\s*${ROOT_DEFAULT}`, 'gsu');
  return (source.match(pattern) ?? []).map(
    (hit) => `${file}: ${hit.replace(/\s+/gu, ' ').trim().slice(0, 120)}`,
  );
}

/** Every `.ts` under a root, excluding this file. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry === SELF) continue;
    found.push(full);
  }
  return found;
}

/** A test file? Fixtures declare deliberately wrong shapes; production does not. */
function isTestSource(file: string): boolean {
  return file.includes(`${'__tests__'}/`) || file.includes('.test.');
}

const productionFiles = sourceFiles(SRC_ROOT)
  .map((file) => relative(SRC_ROOT, file))
  .filter((file) => !isTestSource(file));

const declarations = productionFiles.flatMap((file) =>
  enqueueDeclarations(file, readFileSync(join(SRC_ROOT, file), 'utf8')),
);

const withHandle = declarations.filter((declaration) => takesHandle(declaration.params));

describe('every enqueue takes its database handle as a required parameter', () => {
  it('finds enqueue declarations, and finds handles among them', () => {
    // The vacuity floor. A renamed directory, a moved `db/`, a broken opener
    // regex and a truncating parameter scan all produce a clean, confident,
    // meaningless green — and each of the assertions below is also what ZERO
    // declarations would report.
    expect(declarations.length).toBeGreaterThanOrEqual(20);
    expect(withHandle.length).toBeGreaterThanOrEqual(11);

    // The population definition is "takes a handle", so it can empty out by the
    // handles disappearing rather than by the enqueues doing. Both ends are
    // floored: some enqueues legitimately take none (`queue/producers.ts` writes
    // to BullMQ), so a run where EVERY enqueue lacks one is a broken scan.
    expect(declarations.length).toBeGreaterThan(withHandle.length);
  });

  it('every repository enqueue under db/ declares a handle', () => {
    // The population above is keyed on the handle being present, which cannot
    // see an enqueue that lost one. A Postgres queue repository must have one:
    // there is no other way for its row to join a caller's transaction.
    const repositoryEnqueues = declarations.filter((declaration) =>
      declaration.file.startsWith(`${relative(SRC_ROOT, DB_ROOT)}/`),
    );
    expect(repositoryEnqueues.length).toBeGreaterThanOrEqual(11);

    const handleless = repositoryEnqueues
      .filter((declaration) => !takesHandle(declaration.params))
      .map((declaration) => `${declaration.file}: ${declaration.name}`);
    expect(handleless).toEqual([]);
  });

  it('no enqueue defaults or optionalizes its handle', () => {
    const offenders = withHandle
      .filter((declaration) => handleIsOptional(declaration.params))
      .map((declaration) => `${declaration.file}: ${declaration.name}`);

    // No exemption list, deliberately. An exemption here would excuse exactly
    // the defect this file exists to forbid, and there is no shape of caller
    // that needs one: a caller outside a transaction passes `getDb()` and says
    // so, which is the difference between a decision and an omission.
    expect(offenders).toEqual([]);
  });

  it('no caller coalesces a handle into an enqueue', () => {
    const offenders = productionFiles.flatMap((file) =>
      coalescedHandleCalls(file, readFileSync(join(SRC_ROOT, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the census can actually see the defect it forbids', () => {
  // Every assertion above passes on a codebase with no enqueues, no handles and
  // a scanner that matches nothing. These are the positive controls: with the
  // expected offender set empty, the self-test is the ONLY thing standing
  // between this file and a gate that reports green because it measures nothing.
  const fixture = (params: string): string =>
    `export async function enqueueFixture(\n${params}\n): Promise<void> {}`;

  it('flags a defaulted handle', () => {
    const source = fixture(`  input: { id: string },\n  db: ${HANDLE_TYPE} = ${ROOT_DEFAULT},`);
    const [declaration] = enqueueDeclarations('fixture.ts', source);
    expect(declaration).toBeDefined();
    expect(takesHandle(declaration?.params ?? '')).toBe(true);
    expect(handleIsOptional(declaration?.params ?? '')).toBe(true);
  });

  it('flags a `?`-marked handle', () => {
    const source = fixture(`  input: { id: string },\n  db?: ${HANDLE_TYPE},`);
    const [declaration] = enqueueDeclarations('fixture.ts', source);
    expect(handleIsOptional(declaration?.params ?? '')).toBe(true);
  });

  it('flags an explicitly `| undefined` handle', () => {
    // The spelling that looks the most deliberate and, under `strict: false`,
    // constrains callers exactly as little as the other two.
    const source = fixture(`  input: { id: string },\n  db: ${HANDLE_TYPE} | undefined,`);
    const [declaration] = enqueueDeclarations('fixture.ts', source);
    expect(handleIsOptional(declaration?.params ?? '')).toBe(true);
  });

  it('passes a required handle', () => {
    const source = fixture(`  input: { id: string },\n  db: ${HANDLE_TYPE},\n  now: Date = new Date(),`);
    const [declaration] = enqueueDeclarations('fixture.ts', source);
    expect(takesHandle(declaration?.params ?? '')).toBe(true);
    expect(handleIsOptional(declaration?.params ?? '')).toBe(false);
    // The `now` default must NOT read as an optional handle: it is a defaulted
    // parameter beside the handle, which is the shape four of the five real
    // offenders had. A looser `=`-anywhere test flags this and reads as
    // coverage while measuring the wrong thing.
  });

  it('reads a signature whose first parameter is an inline object', () => {
    // The shape #584's own census missed: with an options object first, the
    // handle sits seven lines down and a probe anchored on the line AFTER the
    // declaration reports "no handle" — which classified two defaulted enqueues
    // as compliant. A regex bounded by the first `)` fails the same way.
    const source = [
      'export async function enqueueFixture(',
      '  input: {',
      '    readonly triggerId: string;',
      '    readonly channel: (a: string) => string;',
      '  },',
      `  db: ${HANDLE_TYPE} = ${ROOT_DEFAULT},`,
      '): Promise<string> {}',
    ].join('\n');
    const [declaration] = enqueueDeclarations('fixture.ts', source);
    expect(takesHandle(declaration?.params ?? '')).toBe(true);
    expect(handleIsOptional(declaration?.params ?? '')).toBe(true);
  });

  it('flags a coalesced handle at a call site, and not a plain one', () => {
    expect(
      coalescedHandleCalls('fixture.ts', `await enqueueFixture(input, db ?? ${ROOT_DEFAULT});`),
    ).toHaveLength(1);
    expect(coalescedHandleCalls('fixture.ts', 'await enqueueFixture(input, db);')).toHaveLength(0);
    // A coalesce that is not feeding an enqueue is none of this file's business:
    // 14 read paths spell `input.db ?? getDb()` legitimately, and flagging them
    // would make the rule one somebody turns off.
    expect(
      coalescedHandleCalls('fixture.ts', `const db = input.db ?? ${ROOT_DEFAULT};`),
    ).toHaveLength(0);
  });
});
