/**
 * A test fixture may not carry an absolute date literal dated TODAY OR LATER
 * unless somebody has said why it is safe (#253).
 *
 * ## The measured bug
 *
 * `services/ingestion/__tests__/adapter-contract-suite.ts` pinned a second
 * ingestion pass to `2026-08-10T10:00:00.000Z` while the FIRST pass in the same
 * test took the real wall clock (`new Date()`). The literal was "safely in the
 * future" relative to the day it was written; on 2026-08-10 the real clock
 * caught up and it broke `Lint & Test` on every PR whose CI ran after it. Two
 * siblings detonated on their own thresholds the same way.
 *
 * The class is not "an old date" — a past literal compared against past
 * literals is inert forever. It is **a literal that has to stay ahead of a
 * clock that is still moving toward it**. Time is the input that changes
 * without anybody editing the file, which is why review never catches it and
 * why the failure lands on whoever pushed next rather than on the author.
 *
 * ## Why every future literal is flagged, rather than the ones that look risky
 *
 * The precise discriminator — "is this literal ever compared against the real
 * clock" — is not statically decidable. The clock read that matters is often
 * inside the SERVICE under test rather than in the fixture's own file, so
 * narrowing the scan to files that also call `new Date()` would have reported
 * CLEAN for ten of the eleven files carrying a future literal today, including
 * every one whose expiry a service evaluates internally. That narrowing fails
 * in the permissive direction, which is the direction that ships the bomb.
 *
 * So the detector is blunt — every future-or-today literal is an offender — and
 * the judgement lives in {@link FUTURE_DATED_FIXTURES}, where each entry states
 * the reason in one of three shapes that a reader can check:
 *
 * - **an injected clock** — the code under test takes `now` as a PARAMETER, so
 *   the literal is compared against another literal and the wall clock is not
 *   in the comparison at all. This is the shape that makes a future fixture
 *   safe rather than lucky, and it is what the contract suite lacked.
 * - **inert data** — the value is echoed, round-tripped or refused, and no
 *   comparison of any kind reads it.
 * - **a far sentinel** — chosen to outlive the codebase, so "the clock catches
 *   up" is not a scenario (a `2099` never-expires value).
 *
 * ## What stops the register becoming the gate's off switch
 *
 * An exemption list that only grows is a gate switching itself off one
 * defensible line at a time. Two assertions hold it: an EXACT count (never a
 * floor), and a staleness check requiring every registered literal to still be
 * present in the file that registered it — so an entry cannot outlive the
 * fixture it excuses. The staleness check asks whether the literal is still
 * THERE, deliberately not whether it is still in the future: a registered 2027
 * date stops being future in 2027, and a check keyed on that would be the same
 * kind of time bomb this file exists to prevent.
 *
 * ## Two deliberate limits
 *
 * Raw source is scanned WITHOUT stripping comments, following
 * `canonical-fixture-census.test.ts`: the failure direction of scanning raw
 * source is a false POSITIVE, which fails loudly and is fixed in one line,
 * while comment stripping truncates at a `//` inside a string literal and can
 * hide a real one.
 *
 * A literal dated in the PAST is not examined at all. It cannot start failing
 * on its own, because nothing moves toward it.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** `packages/backend`, from `packages/backend/src/__tests__/`. */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

/** Both trees vitest collects from (see `vitest.config.ts`'s `include`). */
const SCANNED_ROOTS = ['src', 'scripts'];

/**
 * This file, and nothing else.
 *
 * The register below quotes the very literals the detector looks for, so
 * scanning it would make this file its own largest offender. Asserted to have
 * exactly one member: an exclusion list is the other way a scan like this goes
 * quietly blind.
 */
const NOT_SCANNED = ['src/__tests__/fixture-date-census.test.ts'];

/**
 * Why is a future-dated literal safe to leave in a fixture?
 *
 * `date` is the `YYYY-MM-DD` head of the literal — occurrences of one date in
 * one file collapse to one entry, so an entry survives the line moving.
 */
type FutureDatedFixture = {
  readonly file: string;
  readonly date: string;
  readonly reason: string;
};

const FUTURE_DATED_FIXTURES: readonly FutureDatedFixture[] = [
  // ── An injected clock: the code under test takes `now` as an argument ──────
  {
    file: 'src/services/__tests__/retail-fulfilment.realdb.test.ts',
    date: '2026-08-17',
    reason:
      'readRetailDeliveryPromiseView takes its clock as a second argument (2026-08-12), so the promise windows are compared against that instant and never against the wall clock.',
  },
  {
    file: 'src/services/__tests__/retail-fulfilment.realdb.test.ts',
    date: '2026-08-18',
    reason: 'Same injected clock as the 2026-08-17 promise window above.',
  },
  {
    file: 'src/services/__tests__/retail-fulfilment.realdb.test.ts',
    date: '2026-08-20',
    reason: 'Same injected clock as the 2026-08-17 promise window above.',
  },
  {
    file: 'src/services/__tests__/retail-fulfilment.realdb.test.ts',
    date: '2026-09-01',
    reason: 'Same injected clock as the 2026-08-17 promise window above.',
  },
  {
    file: 'src/services/retail-pricing/__tests__/retail-completeness.test.ts',
    date: '2030-01-01',
    reason: 'isRetailQuoteChargeable takes `at` as a parameter; expiry is measured against it.',
  },
  {
    file: 'src/db/merchantPlans/__tests__/merchant-plans.realdb.test.ts',
    date: '2030-05-31',
    reason: 'The grace-window assertions pass `at:` explicitly, so the comparison uses that clock.',
  },
  {
    file: 'src/db/merchantPlans/__tests__/merchant-plans.realdb.test.ts',
    date: '2030-06-01',
    reason: 'Same injected `at:` clock as the 2030-05-31 grace window above.',
  },
  {
    file: 'src/db/merchantPlans/__tests__/merchant-plans.realdb.test.ts',
    date: '2030-06-02',
    reason: 'Same injected `at:` clock as the 2030-05-31 grace window above.',
  },
  {
    file: 'src/services/retail-eligibility/__tests__/eligibility.test.ts',
    date: '2027-08-09',
    reason:
      'A NEXT_YEAR constant fed to a pure derivation beside a fixed NOW; the pair moves together.',
  },
  {
    file: 'src/services/procurement/__tests__/agreement-scope.test.ts',
    date: '2027-01-01',
    reason: 'A FUTURE constant compared against the fixture instants in the same file.',
  },
  {
    file: 'src/services/procurement/__tests__/procurement-eligibility.test.ts',
    date: '2027-01-01',
    reason: 'A FUTURE constant compared against the fixture instants in the same file.',
  },
  {
    file: 'src/services/commerce-graph/__tests__/relationship-conflicts.test.ts',
    date: '2027-01-01',
    reason: 'A relationship validity window compared against the fixture window in the same case.',
  },

  // ── Inert data: echoed, round-tripped or refused, never compared ──────────
  {
    file: 'scripts/e2e/__tests__/redaction.test.ts',
    date: '2026-08-15',
    reason:
      'A timestamp round-tripped through projectConnection/projectSyncRun and asserted equal to itself; the redactor performs no date comparison.',
  },
  {
    file: 'src/connectors/shopify/__tests__/shopify-scopes.test.ts',
    date: '2026-08-15',
    reason:
      "A ScopeProvenance row's `checked` date, recording when the Shopify documentation page it cites was read. The file reads no clock at all, and nothing reads `checked` — only `provenance.kind` and `provenance.settledBy` are ever consulted — so re-pinning it to the past would falsify the record without removing any comparison.",
  },
  {
    file: 'src/db/__tests__/seo.realdb.test.ts',
    date: '2027-01-01',
    reason: 'Stored review/selection timestamps, ordered against each other and not against now.',
  },
  {
    file: 'src/db/__tests__/seo.realdb.test.ts',
    date: '2027-01-15',
    reason: 'Same stored-timestamp ordering as the 2027-01-01 entry above.',
  },
  {
    file: 'src/db/__tests__/seo.realdb.test.ts',
    date: '2027-02-20',
    reason: 'Same stored-timestamp ordering as the 2027-01-01 entry above.',
  },
  {
    file: 'src/db/__tests__/seo.realdb.test.ts',
    date: '2027-03-01',
    reason: 'Same stored-timestamp ordering as the 2027-01-01 entry above.',
  },
  {
    file: 'src/db/__tests__/seo.realdb.test.ts',
    date: '2027-04-01',
    reason: 'Same stored-timestamp ordering as the 2027-01-01 entry above.',
  },
  {
    file: 'src/services/entitlements/__tests__/capabilities.test.ts',
    date: '2030-03-04',
    reason: 'An input to the pure entitlementPeriodKey, whose output is a formatted period string.',
  },
  {
    file: 'src/services/entitlements/__tests__/capabilities.test.ts',
    date: '2030-03-14',
    reason: 'Same pure entitlementPeriodKey input as the 2030-03-04 entry above.',
  },
  {
    file: 'src/services/entitlements/__tests__/capabilities.test.ts',
    date: '2030-03-20',
    reason: 'Same pure entitlementPeriodKey input as the 2030-03-04 entry above.',
  },
  {
    file: 'src/services/__tests__/retail-service-policy.test.ts',
    date: '2029-01-31',
    reason:
      'The expected statutory deadline, derived from fixed inputs in the same assertion; no clock is read.',
  },
  {
    file: 'src/routes/__tests__/internal-retail-eligibility.test.ts',
    date: '2027-01-01',
    reason: 'A request-body expiry echoed back by the route under test.',
  },

  // ── A far sentinel: chosen to outlive the codebase ────────────────────────
  {
    file: 'src/routes/__tests__/guest-portal.integration.test.ts',
    date: '2099-01-01',
    reason:
      'A never-expires value inside a body the recovery endpoint must REFUSE uniformly; the case asserts the refusal, not the date.',
  },
];

/**
 * An absolute date at the head of a quoted string: `'2026-08-10'`,
 * `"2026-08-10T10:00:00.000Z"`, or the same inside a template literal.
 *
 * Anchored on the opening quote so a subtraction like `days - 2026` or a
 * version string cannot be read as a date.
 */
const DATE_LITERAL = /['"`](\d{4}-\d{2}-\d{2})/g;

type DateLiteral = { readonly file: string; readonly date: string; readonly line: number };

function collectScannedFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith('.ts')) continue;
      // Both shapes vitest collects, plus the non-`.test.ts` helpers inside a
      // `__tests__` directory — `adapter-contract-suite.ts`, the file the
      // measured bug was actually in, is one of those.
      if (!full.includes('__tests__') && !full.endsWith('.test.ts')) continue;
      const relative = full.slice(PACKAGE_ROOT.length + 1);
      if (NOT_SCANNED.includes(relative)) continue;
      found.push(relative);
    }
  };
  for (const root of SCANNED_ROOTS) {
    const full = join(PACKAGE_ROOT, root);
    try {
      if (statSync(full).isDirectory()) walk(full);
    } catch {
      // A root that does not exist is reported by the file floor below, not by
      // a throw here — the floor is the assertion that can distinguish "the
      // layout moved" from "the tree is clean".
    }
  }
  return found.sort();
}

/** Every date literal in one source, with the line it sits on. */
function dateLiteralsIn(file: string, source: string): DateLiteral[] {
  const literals: DateLiteral[] = [];
  const lines = source.split('\n');
  lines.forEach((text, index) => {
    for (const match of text.matchAll(DATE_LITERAL)) {
      literals.push({ file, date: match[1], line: index + 1 });
    }
  });
  return literals;
}

/** Today in UTC, as `YYYY-MM-DD`. String comparison on this format IS date order. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

const SCANNED_FILES = collectScannedFiles();
const ALL_LITERALS = SCANNED_FILES.flatMap((file) =>
  dateLiteralsIn(file, readFileSync(join(PACKAGE_ROOT, file), 'utf8')),
);

/**
 * Floors measured on the tree this landed against: 424 scanned files, 458 date
 * literals. Set well below both, because the assertion they carry is "the walk
 * read something", not "the tree has not changed".
 */
const SCANNED_FILE_FLOOR = 300;
const DATE_LITERAL_FLOOR = 300;

describe('test fixtures carry no unexplained future date', () => {
  it('scanned a real tree and found real literals', () => {
    // The vacuity floor. A moved directory, a wrong root or a broken extension
    // filter all produce an empty scan, and an empty scan reports exactly what
    // a clean tree reports.
    expect(SCANNED_FILES.length, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(
      SCANNED_FILE_FLOOR,
    );
    expect(
      ALL_LITERALS.length,
      'no date literals found at all — the extractor is broken, not the tree',
    ).toBeGreaterThan(DATE_LITERAL_FLOOR);
  });

  it('flags no fixture dated today or later that is not explained', () => {
    const today = todayUtc();
    const registered = new Set(FUTURE_DATED_FIXTURES.map((e) => `${e.file} ${e.date}`));

    const offenders = ALL_LITERALS.filter((l) => l.date >= today)
      .filter((l) => !registered.has(`${l.file} ${l.date}`))
      .map((l) => `${l.file}:${l.line} — ${l.date}`);

    expect(
      [...new Set(offenders)],
      `a test fixture is pinned to a date that is today or still in the future, so the real clock is moving toward it. That is the #253 bug: it passes today, keeps passing, and breaks CI for whoever pushes on the day it arrives — with the failure landing in a file they did not touch. Either re-pin it to a date safely in the PAST (deriving any later instant as an offset from what the code under test actually stamped, never as a second literal), or, if it is genuinely safe, add it to FUTURE_DATED_FIXTURES with the reason — an injected clock, inert data, or a far sentinel — and update FUTURE_DATED_FIXTURE_COUNT.`,
    ).toEqual([]);
  });

  it('carries no register entry whose fixture has gone', () => {
    // Without this, an entry outlives the literal it excuses and the register
    // becomes a list of permissions for code nobody can find.
    const present = new Set(ALL_LITERALS.map((l) => `${l.file} ${l.date}`));
    const stale = FUTURE_DATED_FIXTURES.filter(
      (e) => !present.has(`${e.file} ${e.date}`),
    ).map((e) => `${e.file} — ${e.date}`);

    expect(
      stale,
      'a FUTURE_DATED_FIXTURES entry names a literal that is no longer in that file. Drop the entry and decrement FUTURE_DATED_FIXTURE_COUNT.',
    ).toEqual([]);
  });

  it('holds the register to an exact size and a stated reason', () => {
    // EXACT, never a floor: a list that may grow silently is the gate turning
    // itself off one defensible line at a time.
    expect(
      FUTURE_DATED_FIXTURES.length,
      'FUTURE_DATED_FIXTURES changed size. Every entry is a decision, so the count moves in the same diff as the reason.',
    ).toBe(FUTURE_DATED_FIXTURE_COUNT);

    for (const entry of FUTURE_DATED_FIXTURES) {
      expect(entry.reason.trim().length, `${entry.file} ${entry.date} has no reason`).toBeGreaterThan(
        20,
      );
    }

    const keys = FUTURE_DATED_FIXTURES.map((e) => `${e.file} ${e.date}`);
    expect(new Set(keys).size, 'a (file, date) pair is registered twice').toBe(keys.length);
  });

  it('excludes only itself from the scan', () => {
    expect(NOT_SCANNED).toEqual(['src/__tests__/fixture-date-census.test.ts']);
  });
});

/**
 * The register's size, stated separately so a diff that adds an entry has to
 * touch this line too.
 */
const FUTURE_DATED_FIXTURE_COUNT = 25;

describe('the census can actually see what it claims to', () => {
  // Probe dates are assembled from parts so this file's own controls cannot be
  // read as fixtures by a future scan that stops excluding it.
  const future = `2${'0'}99-12-31`;
  const past = `1${'9'}99-01-02`;

  it('extracts a date from every quoting style, and records its line', () => {
    const source = [
      `const a = '${future}';`,
      `const b = "${future}T10:00:00.000Z";`,
      'const c = `' + future + '`;',
      `const d = new Date('${past}');`,
    ].join('\n');

    const found = dateLiteralsIn('probe.ts', source);

    // The positive control, in the same currency as the measurement: every
    // shape the detector claims to handle is present and each one moved it.
    expect(found.map((l) => l.date)).toEqual([future, future, future, past]);
    expect(found.map((l) => l.line)).toEqual([1, 2, 3, 4]);
  });

  it('does not read a bare number or a version string as a date', () => {
    const found = dateLiteralsIn('probe.ts', ['const n = 2099 - 12;', "const v = 'v1.2.3';"].join('\n'));
    expect(found).toEqual([]);
  });

  it('separates future from past at today, with today counting as future', () => {
    const today = todayUtc();
    // `>=`, not `>`: the measured bug detonated ON its own date, so a literal
    // dated today is already spent rather than safely ahead.
    expect(today >= today).toBe(true);
    expect(future >= today).toBe(true);
    expect(past >= today).toBe(false);
  });

  it('excuses a registered pair only on an EXACT match of file AND date', () => {
    // The mutation self-test for the register's lookup: if the key were built
    // from the date alone, one file's explanation would silently excuse every
    // other file's literal of the same date — and 2027-01-01 is registered by
    // four different files today.
    const registered = new Set(FUTURE_DATED_FIXTURES.map((e) => `${e.file} ${e.date}`));
    const sample = FUTURE_DATED_FIXTURES[0];

    expect(registered.has(`${sample.file} ${sample.date}`)).toBe(true);
    expect(registered.has(`some/other/file.test.ts ${sample.date}`)).toBe(false);
    expect(registered.has(`${sample.file} ${future}`)).toBe(false);
  });

  it('would report an unregistered future literal as an offender', () => {
    // Proves the gate can FAIL. Without it, "no offenders" is also what a
    // detector that classifies nothing reports.
    const literals = dateLiteralsIn('unregistered.test.ts', `const x = '${future}';`);
    const today = todayUtc();
    const registered = new Set(FUTURE_DATED_FIXTURES.map((e) => `${e.file} ${e.date}`));

    const offenders = literals
      .filter((l) => l.date >= today)
      .filter((l) => !registered.has(`${l.file} ${l.date}`));

    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.date).toBe(future);
  });
});
