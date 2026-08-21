/**
 * Every module that FOLDS text must have fixture coverage for every script
 * family the product ships a locale bundle for (#833).
 *
 * ## The three defects this exists for
 *
 * | Defect | Mechanism |
 * |---|---|
 * | `normalizeEntityName` (#830, fixed #834) | `[^\p{L}\p{N}]+` → space; matras are `Mn`/`Mc`, not letters |
 * | `listings.search_vector` (fixed #826) | generated AND queried as `'english'` |
 * | `redactSupplierOrderMessage` (#832) | `[A-Z]` is ASCII uppercase only |
 *
 * They are one blind spot with three exits. The census behind #833 counted 22
 * test files for normalizers, tokenizers, slugs, aliases, matchers, redactors
 * and folds and found 21 with ZERO characters in any non-Latin range — while
 * `hi.json`, `bn.json`, `ja.json`, `ru.json`, `ar.json` and `zh-Hans.json` ship
 * in `@mercaria/ui`.
 *
 * ## Both populations are DERIVED, and that is the whole design
 *
 * **The required scripts come from the shipped locale bundles.** Not from a
 * written list: `packages/ui/src/i18n/locales/` is what the product claims to
 * serve, so adding `ko.json` tomorrow demands Hangul and nobody has to remember.
 * A hand-maintained script list rots exactly the way the fixtures did — and
 * measurably so: Greek appears in 14 modules of this repository (`Σ`, `µ` in
 * money and matching prose) and is NOT a shipped locale, so a list written by
 * eye would have demanded Greek fixtures and missed Hiragana, which is the one
 * script almost nothing covers.
 *
 * **The modules come from a source walk for FOLD OPERATIONS**, not for file
 * names and not for a path list.
 *
 * ## Why the detector is the OPERATION and not the character class
 *
 * #833 proposes scanning for `\p{L}`, `\p{N}`, `[A-Z]`, `[a-z]` and `\w`.
 * Measured on `99cd1369`, that set does not describe the defects it was drawn
 * from:
 *
 * - `listings.search_vector` (#826) contains NO JavaScript character class at
 *   all — it is `to_tsvector('english', …)` inside a generated column. A
 *   construct scan reports it CLEAN.
 * - `services/search/normalize.ts` and `services/taxonomy/alias-normalization.ts`
 *   — both named in #833's own census — contain none of the five constructs
 *   either. They fold with `.normalize('NFKC')`, `.toLowerCase()` and an
 *   explicit `[\u{300}-\u{36F}]` range.
 *
 * So the unit is a **content fold**: an operation whose OUTPUT depends on the
 * script of its input, and which rewrites the text rather than refusing it. Five
 * kinds, in {@link CONTENT_FOLDS}. Each one silently mangles a script it
 * mishandles, and the mangled value is what gets stored.
 *
 * Two things are deliberately NOT in the surface:
 *
 * - **Collation** (`localeCompare`, `Intl.Collator`). It changes ORDER, not
 *   content. A list in a surprising order is visible and loses no data; that is
 *   a different failure class from the three above, and folding it in here would
 *   add 27 modules whose fixtures would prove nothing about these defects.
 * - **An ASCII alphabet in a VALIDATING position** (`.test(`, a zod `.regex(`,
 *   a SQL `check(`). Those REFUSE non-Latin input loudly — a 400, a constraint
 *   violation — where a `.replace()` corrupts it silently. Measured: including
 *   them takes the surface from 45 to 126, and every one of the 81 added is a
 *   currency code, an ISO country code or a slug policy that is supposed to be
 *   ASCII.
 *
 * ## What counts as coverage
 *
 * The module's own source PLUS every test that DIRECTLY imports it, comments
 * stripped.
 *
 * - **The module's own source counts** because that is where a corpus legitimately
 *   lives: `services/graph-benchmark/folding.ts` carries 31 lines of non-Latin
 *   corpus in the MODULE, and a test-file-only census scores it zero. #833
 *   records getting this wrong.
 * - **Comments are stripped** because a script named in prose is not coverage.
 *   Measured here: `services/canonical/normalization.ts` reads as
 *   Cyrillic-and-Devanagari-covered on raw source and as EMPTY once stripped —
 *   every one of those characters is a docblock example. Same for
 *   `services/matching/text-similarity.ts`.
 * - **DIRECT import, not the transitive closure.** At depth 2 `lib/logger.ts` is
 *   "covered" by 225 tests and `db/schema/catalog.ts` by 126, because an
 *   integration test pulls in the world and donates its fixtures to everything
 *   underneath. That is coverage by proximity, and it is how this gate would go
 *   green while measuring nothing.
 *
 * ## The exemption register, and why it is a register at all
 *
 * Not every fold needs every script, and the judgement turns on **where the
 * folded value came from** — which is not statically derivable. The evidence is
 * that `utils/slug.ts` and `services/referrals/rewards/forbidden-funding.ts`
 * carry nearly the SAME regex (`[^a-z0-9]` → replace) over completely different
 * inputs: a seller's product title, and a funding-code identifier from a closed
 * ASCII set. No scan can tell those apart, so the judgement is written down.
 *
 * Three things stop the register becoming the gate's off switch, and the third
 * is the one worth copying:
 *
 * 1. **Exact in BOTH directions.** Every exempt module must still be in the
 *    surface (`toEqual`, never containment), so an exemption for a module that
 *    was deleted, renamed, or whose fold was removed FAILS rather than lingering.
 * 2. **A closed reason vocabulary** ({@link ExemptionReason}), not free text. A
 *    prose reason is unfalsifiable and unreadable at scale; a closed set can be
 *    counted, and a new kind is a deliberate act with a reviewer attached.
 * 3. **Each entry pins the CONSTRUCT it was judged about.** The register names a
 *    literal fragment of the fold, and the gate asserts that fragment is still in
 *    the file. Rewrite the regex and the exemption dies with the evidence it
 *    rested on — so an entry cannot outlive the thing it excuses. This is
 *    `fixture-date-census.test.ts`'s staleness check pointed at the construct
 *    rather than at the file.
 *
 * `runner_cannot_reach` is the shape to imitate, and it earned its place by
 * catching its own author: the first draft excused the dashboard screen as "the
 * package ships no test runner", the check refuted it — `@mercaria/dashboard`
 * has `vitest run` — and the real reason turned out to be narrower and
 * checkable, that the runner's `include` is `lib/**` only. It is verified
 * against that config, so widening the include RETIRES the exemption and the
 * fixture becomes owed. Every entry above would have this property if it were
 * derivable; the machine-alphabet ones are not, which is why they are written.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRIPT_CORPUS } from './script-corpus.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_ROOT = join(SRC_ROOT, '..', '..');
const LOCALE_BUNDLES = join(PACKAGES_ROOT, 'ui', 'src', 'i18n', 'locales');

/* ------------------------------------------------------------------ *
 * 1. The required script families, derived from the shipped bundles.
 * ------------------------------------------------------------------ */

/**
 * Every script this classifier can name.
 *
 * A CANDIDATE list, never an answer: what makes it safe is
 * {@link classifyBundleLetters} reporting a RESIDUAL, so a letter in a script
 * absent from this tuple fails the gate naming the bundle and the codepoint
 * rather than being skipped. "I found fewer scripts" and "there are fewer
 * scripts" are the same reading otherwise.
 */
const CANDIDATE_SCRIPTS = [
  'Latin', 'Cyrillic', 'Greek', 'Arabic', 'Hebrew', 'Devanagari', 'Bengali', 'Gurmukhi',
  'Gujarati', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Oriya', 'Sinhala', 'Thai', 'Lao',
  'Khmer', 'Myanmar', 'Tibetan', 'Mongolian', 'Hiragana', 'Katakana', 'Han', 'Hangul',
  'Armenian', 'Georgian', 'Ethiopic', 'Cherokee', 'Syriac', 'Thaana', 'Adlam', 'Vai', 'Yi',
] as const;

/**
 * Letters belonging to no script in particular.
 *
 * `ー` (U+30FC, the Japanese prolonged sound mark) and `ـ` (U+0640, the Arabic
 * tatweel) are `\p{L}` and `Script=Common`: they take the script of whatever
 * surrounds them. Counting them as a residual would fail this gate on day one
 * for no reason — measured, 116 of them in `ja.json` and 2 in `ar.json` — so
 * they are neutral rather than unknown.
 */
const SCRIPT_NEUTRAL = ['Common', 'Inherited'] as const;

const LETTER = /\p{L}/u;
const SCRIPT_TESTS = new Map(
  [...CANDIDATE_SCRIPTS, ...SCRIPT_NEUTRAL].map(
    (script) => [script, new RegExp(`^\\p{Script=${script}}$`, 'u')] as const,
  ),
);

/**
 * The share of one bundle's letters a script must reach to be REQUIRED.
 *
 * Measured on `99cd1369` across all twelve bundles: the smallest legitimate
 * family is Katakana at 6.97% of `ja.json`, and once script-neutral letters are
 * excluded the largest artefact is 0.00%. Two percent therefore sits with a
 * 3.5x margin below the smallest real family and above every stray. It exists
 * only to stop one brand name written in another script conscripting a whole
 * script family; it is not a judgement about which languages matter.
 */
const SCRIPT_SHARE_FLOOR = 0.02;

interface BundleClassification {
  readonly bundle: string;
  readonly letters: number;
  /** Script → letter count, script-neutral letters excluded. */
  readonly counts: ReadonlyMap<string, number>;
  /** Codepoints this classifier could not name at all. */
  readonly residual: readonly string[];
}

function localeBundleNames(): string[] {
  return readdirSync(LOCALE_BUNDLES)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
}

/** Every user-visible string in one bundle, however deeply nested. */
function bundleStrings(bundle: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(JSON.parse(readFileSync(join(LOCALE_BUNDLES, bundle), 'utf8')));
  return out;
}

function classifyBundleLetters(bundle: string): BundleClassification {
  const counts = new Map<string, number>();
  const residual: string[] = [];
  let letters = 0;
  for (const character of bundleStrings(bundle).join('')) {
    if (!LETTER.test(character)) continue;
    letters += 1;
    let named: string | undefined;
    for (const [script, test] of SCRIPT_TESTS) {
      if (test.test(character)) {
        named = script;
        break;
      }
    }
    if (named === undefined) {
      residual.push(`U+${character.codePointAt(0)?.toString(16).toUpperCase() ?? '????'}`);
      continue;
    }
    if ((SCRIPT_NEUTRAL as readonly string[]).includes(named)) continue;
    counts.set(named, (counts.get(named) ?? 0) + 1);
  }
  return { bundle, letters, counts, residual };
}

/** The script families the product ships copy in. Sorted, deduped. */
function requiredScriptFamilies(): string[] {
  const required = new Set<string>();
  for (const bundle of localeBundleNames()) {
    const { letters, counts } = classifyBundleLetters(bundle);
    for (const [script, count] of counts) {
      if (count / letters >= SCRIPT_SHARE_FLOOR) required.add(script);
    }
  }
  return [...required].sort();
}

/* ------------------------------------------------------------------ *
 * 2. The fold surface, derived from a source walk.
 * ------------------------------------------------------------------ */

/**
 * The five content folds.
 *
 * Each REWRITES text in a way that depends on the script, so a script it
 * mishandles is corrupted silently and the corruption is what gets stored.
 */
const CONTENT_FOLDS = {
  /** Unicode normalization — the decomposition differs per script. */
  unicode_normalize: /\.normalize\(\s*['"]NF[KD]?[CD]['"]\s*\)/,
  /** A Unicode property class over letters, numbers or marks — the #830 shape. */
  property_class: /\\p\{(?:L|N|M|Letter|Number|Mark|Alpha\w*|L[ulto]|N[dlo]|M[ncf])\}/,
  /** An ASCII alphabet class REWRITING text — the #832 shape. */
  ascii_alphabet_rewrite:
    /\.(?:replace|replaceAll|split|match|matchAll)\(\s*\/(?:[^/\\\n]|\\.)*(?:\[[^\]\n]*(?:[Aa]-[Zz])[^\]\n]*\]|\\w)/,
  /**
   * A hand-drawn codepoint boundary — a script edge somebody chose.
   *
   * Three spellings, and the third is not optional: `utils/slug.ts` writes its
   * combining-mark range as RAW characters (`[̀-ͯ]`) rather than as `̀`.
   * The escape-only detector missed it, which the self-test below caught. A
   * module whose only fold were spelled that way would be outside the surface.
   */
  //
  // The raw arm is spelled with `\P{ASCII}` rather than `[^\x00-\x7F]`: the
  // latter is the obvious way to write "a non-ASCII character" and `no-control-regex`
  // rejects it, because naming NUL at all is the shape of a control-character bug.
  codepoint_range:
    /\[\s*\\u\{?[0-9A-Fa-f]{2,6}\}?\s*-\s*\\u\{?[0-9A-Fa-f]{2,6}\}?|\[[^\]\n]*\P{ASCII}-\P{ASCII}[^\]\n]*\]/u,
  /** Postgres full text — the analyser is per-language by construction (#826). */
  text_search_config: /to_tsvector\s*\(|to_tsquery\s*\(|websearch_to_tsquery\s*\(|plainto_tsquery\s*\(/,
} as const;

type FoldKind = keyof typeof CONTENT_FOLDS;

/**
 * The package roots walked.
 *
 * Every package, not just the backend: all three defects were backend, and a
 * fold added to a client tomorrow would be outside a backend-only walk with
 * nothing saying so. It costs two entries today.
 */
const WALKED_ROOTS = [
  'backend/src', 'shared-types/src', 'ui/src', 'frontend', 'dashboard', 'pos',
] as const;

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.expo', 'android', 'ios', '.git']);

function walkPackage(root: string, relativeDirectory: string, out: string[]): string[] {
  let entries;
  try {
    entries = readdirSync(join(PACKAGES_ROOT, root, relativeDirectory), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walkPackage(root, child, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(`${root}/${child}`);
    }
  }
  return out;
}

/** Every source file in every walked package, as a `packages/`-relative path. */
function allSourceFiles(): string[] {
  return WALKED_ROOTS.flatMap((root) => walkPackage(root, '', [])).sort();
}

const absolute = (id: string): string => join(PACKAGES_ROOT, id);
const isTestFile = (id: string): boolean => /\.test\.tsx?$/.test(id);
const isTestScoped = (id: string): boolean => /\.test\.tsx?$|__tests__\//.test(id);

/**
 * Strip comments before scanning.
 *
 * Load-bearing twice over: the fold detectors would fire on a docblock quoting
 * the regex it explains, and the fixture COUNT would read a script named in
 * prose as coverage. #833 requires the second explicitly, and this repository
 * has counted prose as code three times in one week.
 *
 * The `[^:]` guard keeps `https://` inside a string from being eaten.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every production module carrying a content fold, with the kinds it carries. */
function foldSurface(): Map<string, FoldKind[]> {
  const surface = new Map<string, FoldKind[]>();
  for (const id of allSourceFiles()) {
    if (isTestScoped(id)) continue;
    const source = stripComments(readFileSync(absolute(id), 'utf8'));
    const kinds = (Object.keys(CONTENT_FOLDS) as FoldKind[]).filter((kind) =>
      CONTENT_FOLDS[kind].test(source),
    );
    if (kinds.length > 0) surface.set(id, kinds);
  }
  return surface;
}

/* ------------------------------------------------------------------ *
 * 3. Coverage: the module plus its DIRECT importers.
 * ------------------------------------------------------------------ */

/**
 * A relative import, across newlines.
 *
 * `[^;]` rather than `[^\n;]` deliberately: this codebase writes multi-line
 * import blocks everywhere, and the newline-bounded spelling silently sees NONE
 * of them. Measured while building this gate — it reported
 * `services/canonical/normalization.ts` as covering one script when its own test
 * file carries six, because the test imports it over four lines.
 */
const RELATIVE_IMPORT = /\b(?:import|export)\b[^;]*?\bfrom\s*['"](\.[^'"]+)['"]/g;

/**
 * A workspace import, with the names it pulls.
 *
 * `shared-types/src/condition.ts` holds a fold and `@mercaria/shared-types` has
 * no runner of its own, so its only possible coverage is a backend test — which
 * reaches it as `import { normalizeSourceConditionLabel } from
 * '@mercaria/shared-types'`. Resolving that to the whole package would donate
 * one test's fixtures to all 120 of its modules, which is the proximity problem
 * that made the transitive closure useless. Resolving it by SYMBOL does not:
 * only the module that DECLARES the imported name is credited. This is
 * `import-closure.ts`'s "the unit is module#symbol" applied to coverage.
 */
const WORKSPACE_IMPORT = /\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@mercaria\/([a-z-]+)['"]/g;

/** Symbol → the module declaring it, for one workspace package's `src/`. */
function declaredSymbols(packageName: string): Map<string, string> {
  const index = new Map<string, string>();
  const root = `${packageName}/src`;
  for (const id of walkPackage(root, '', [])) {
    if (isTestScoped(id)) continue;
    const source = readFileSync(absolute(id), 'utf8');
    const declaration = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|type|interface|enum)\s+(\w+)/gm;
    let match: RegExpExecArray | null;
    while ((match = declaration.exec(source)) !== null) {
      if (!index.has(match[1])) index.set(match[1], id);
    }
  }
  return index;
}

/** module id → the test files that import it directly, or import one of its symbols. */
function directImporters(): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  const symbolIndex = new Map<string, Map<string, string>>();
  const credit = (target: string, test: string): void => {
    const list = importers.get(target);
    if (list === undefined) importers.set(target, [test]);
    else if (!list.includes(test)) list.push(test);
  };

  for (const id of allSourceFiles().filter(isTestFile)) {
    const source = readFileSync(absolute(id), 'utf8');

    RELATIVE_IMPORT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RELATIVE_IMPORT.exec(source)) !== null) {
      const base = resolve(dirname(absolute(id)), match[1].replace(/\.js$/, ''));
      for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
        if (!existsSync(candidate)) continue;
        credit(relative(PACKAGES_ROOT, candidate), id);
        break;
      }
    }

    WORKSPACE_IMPORT.lastIndex = 0;
    while ((match = WORKSPACE_IMPORT.exec(source)) !== null) {
      const packageName = match[2];
      if (!existsSync(join(PACKAGES_ROOT, packageName, 'src'))) continue;
      let index = symbolIndex.get(packageName);
      if (index === undefined) {
        index = declaredSymbols(packageName);
        symbolIndex.set(packageName, index);
      }
      for (const raw of match[1].split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        const target = name === '' ? undefined : index.get(name);
        if (target !== undefined) credit(target, id);
      }
    }
  }
  return importers;
}

/** A test that DRIVES the shared corpus rather than pasting its own words. */
const DRIVES_CORPUS = /\bSCRIPT_CORPUS\b|\bscriptSample\s*\(/;

const CORPUS_MODULE = 'backend/src/__tests__/script-corpus.ts';

/**
 * The comment-stripped text a module's coverage is counted over.
 *
 * A test that loops over {@link SCRIPT_CORPUS} exercises all eight scripts and
 * contains not one non-Latin character, so a pure character census reads it as
 * covering nothing — measured, on the first run of this gate against its own
 * fixtures. Counting the corpus for a test that drives it is what makes ONE
 * shared corpus possible; the alternative is pasting the same eight words into
 * twenty files, which is the duplication a corpus exists to prevent.
 *
 * The limit, stated rather than papered over: this cannot tell a test that loops
 * over the corpus from one that imports it and asserts nothing — exactly as it
 * cannot tell a pasted Devanagari string that is asserted on from one that is
 * not. No character census can. It raises the cost of an empty fixture and is
 * not a proof of one; the reviewer reads the diff.
 */
function coveringText(id: string, importers: ReadonlyMap<string, string[]>): string {
  const parts = [stripComments(readFileSync(absolute(id), 'utf8'))];
  let usesCorpus = false;
  for (const test of importers.get(id) ?? []) {
    const source = stripComments(readFileSync(absolute(test), 'utf8'));
    parts.push(source);
    if (DRIVES_CORPUS.test(source)) usesCorpus = true;
  }
  if (usesCorpus) parts.push(stripComments(readFileSync(absolute(CORPUS_MODULE), 'utf8')));
  return parts.join('\n');
}

function scriptsPresentIn(text: string): Set<string> {
  const present = new Set<string>();
  for (const script of CANDIDATE_SCRIPTS) {
    if (new RegExp(`\\p{Script=${script}}`, 'u').test(text)) present.add(script);
  }
  return present;
}

/* ------------------------------------------------------------------ *
 * 4. The exemption register.
 * ------------------------------------------------------------------ */

/**
 * Why a fold legitimately needs no non-Latin fixture. A CLOSED set: a new kind
 * is a deliberate act, and the counts below make the register auditable.
 */
type ExemptionReason =
  /**
   * The folded value is a MACHINE token — a bearer credential, a request body
   * key, an ISO code, a column name, a scope name, an HTML tag name. Non-Latin
   * input either cannot occur or is refused loudly rather than corrupted.
   */
  | 'machine_alphabet'
  /**
   * The fold is applied against a hard-coded ENGLISH lexicon shipped in the
   * module. The module can only ever match English spellings; that is what it is
   * for, and a Devanagari fixture would prove nothing about the lexicon.
   */
  | 'latin_only_corpus'
  /**
   * No test runner in this repository can reach the module, so no fixture can
   * exist for it anywhere.
   *
   * The three Expo runners are `lib/**`-only with no renderer (#469 — importing
   * a component pulls `react-native`, whose Flow source Rollup cannot parse), so
   * a fold inside a SCREEN is unmountable. Held by
   * {@link runnerIncludeGlobs} rather than by assertion: the day the include is
   * widened or a renderer is added, the exemption fails and the fixture is owed.
   */
  | 'runner_cannot_reach'
  /**
   * The module's ONLY fold is `.normalize('NFC')` — CANONICAL composition, which
   * is lossless and round-trips for every script by definition. It cannot
   * corrupt text, so a per-script fixture would assert `x === x` eight times.
   *
   * Deliberately narrow, and checked by {@link foldsOnlyByCanonicalComposition}:
   * NFKC and NFKD are COMPATIBILITY mappings and ARE lossy (half-width katakana
   * folds onto full-width, a ligature onto its letters), and NFD leaves marks
   * detached for a later class to delete — which is exactly how two of the three
   * defects in this file's header work. Only NFC qualifies, and only when
   * nothing else in the module folds.
   */
  | 'canonical_composition_only';

interface ScriptCoverageExemption {
  /** `packages/`-relative path. Must be in the derived surface. */
  readonly module: string;
  readonly reason: ExemptionReason;
  /**
   * A literal fragment of the fold this judgement was made about, still present
   * in the file. Rewrite the fold and the exemption dies with its evidence.
   */
  readonly construct: string;
  /** What the folded value actually is. One sentence, for a reviewer. */
  readonly note: string;
}

const SCRIPT_COVERAGE_EXEMPTIONS: readonly ScriptCoverageExemption[] = [
  {
    module: 'backend/src/controllers/supplier-preflight-operator.controller.ts',
    reason: 'machine_alphabet',
    construct: "key.toLowerCase().replace(/[^a-z0-9]/g, '')",
    note: 'Folds request BODY KEYS to match a closed set of ASCII field names, never a value.',
  },
  {
    module: 'backend/src/db/catalogLocalization/revisionRepository.ts',
    reason: 'machine_alphabet',
    construct: '.replace(/[A-Z]/gu,',
    note: 'camelCase to snake_case for a COLUMN name declared in this repository.',
  },
  {
    module: 'backend/src/lib/errors/sanitize.ts',
    reason: 'machine_alphabet',
    construct: 'Bearer\\s+[a-zA-Z0-9._-]+',
    note: 'Redacts bearer tokens and API keys, which are base64url/hex by construction.',
  },
  {
    module: 'backend/src/lib/logger.ts',
    reason: 'machine_alphabet',
    construct: 'Bearer\\s+[a-zA-Z0-9._-]+',
    note: 'Redacts bearer tokens and Mercaria/Stripe secret keys from log lines.',
  },
  {
    module: 'backend/src/scripts/seed-verticals/apply.ts',
    reason: 'machine_alphabet',
    construct: "replace(/[^a-z0-9]+/gu, '_')",
    note: 'Builds a vertical NAMESPACE identifier, refused by name if it is not [a-z0-9_].',
  },
  {
    module: 'backend/src/services/attributes/marketing-claims.ts',
    reason: 'latin_only_corpus',
    construct: 'MARKETING_PHRASES',
    note: 'Matches a hard-coded English marketing-phrase lexicon; the class is a word boundary.',
  },
  {
    module: 'backend/src/services/awin/feed-list.ts',
    reason: 'machine_alphabet',
    construct: "replace(/[^a-z0-9]+/gu, '_')",
    note: "Folds Awin's own CSV header names to match a closed set of expected columns.",
  },
  {
    module: 'backend/src/services/commerce-graph/merchant.service.ts',
    reason: 'machine_alphabet',
    construct: "value.replace(/^[a-z][a-z0-9+.-]*:\\/\\//, '')",
    note: 'Normalizes a HOSTNAME, which reaches this code already punycoded (LDH-only).',
  },
  {
    module: 'backend/src/services/feed-import/mapping.ts',
    reason: 'machine_alphabet',
    construct: "readCode('country'",
    note: 'Reads ISO-3166 country and BCP-47 language CODES, refusing anything else.',
  },
  {
    module: 'backend/src/services/feed-import/suggest.ts',
    reason: 'machine_alphabet',
    construct: "replace(/[^a-z0-9_]/gu, '')",
    note: 'Folds a column ROLE name against the closed set of roles this importer knows.',
  },
  {
    module: 'backend/src/services/feed-import/transforms.ts',
    reason: 'machine_alphabet',
    construct: '<\\/?[A-Za-z][^>]{0,2000}>',
    note: 'Strips HTML TAGS; tag names are ASCII by the HTML spec, and the content is kept.',
  },
  {
    module: 'backend/src/services/guest-portal/recovery.service.ts',
    reason: 'canonical_composition_only',
    construct: "request.email.normalize('NFC').trim().toLowerCase()",
    note: 'Folds a recovery email for its HMAC subject; NFC composes and destroys nothing.',
  },
  {
    module: 'backend/src/services/referrals/rewards/forbidden-funding.ts',
    reason: 'latin_only_corpus',
    construct: 'FORBIDDEN_FUNDING',
    note: 'Matches a hard-coded English keyword list naming prohibited funding sources.',
  },
  {
    module: 'backend/src/services/retail-eligibility/forbidden-evidence.ts',
    reason: 'latin_only_corpus',
    construct: 'FORBIDDEN_PATTERNS',
    note: 'Matches a hard-coded English keyword list naming prohibited evidence kinds.',
  },
  {
    module: 'backend/src/services/retail-pricing/forbidden-components.ts',
    reason: 'latin_only_corpus',
    construct: 'FORBIDDEN_PATTERNS',
    note: 'Matches a hard-coded English keyword list naming prohibited cost components.',
  },
  {
    module: 'backend/src/services/retail-reconciliation/forbidden-outputs.ts',
    reason: 'latin_only_corpus',
    construct: 'FORBIDDEN_PATTERNS',
    note: 'Matches a hard-coded English keyword list naming prohibited accounting outputs.',
  },
  {
    module: 'backend/src/services/search-intent/locale.ts',
    reason: 'machine_alphabet',
    construct: '\\b([A-Z]{3})\\b',
    note: 'Extracts an ISO-4217 currency CODE, which is three ASCII letters by the standard.',
  },
  {
    module: 'backend/src/services/sell-yours/draft.service.ts',
    reason: 'machine_alphabet',
    construct: "key.toLowerCase().replace(/[^a-z]/g, '')",
    note: 'Folds request BODY KEYS against a closed set of ASCII field names.',
  },
  {
    module: 'backend/src/services/shopping-agents/authorization.ts',
    reason: 'machine_alphabet',
    construct: "token.toLowerCase().replace(/[^a-z]/g, '')",
    note: 'Folds an authorization SCOPE token against the closed set of scopes.',
  },
  {
    module: 'dashboard/app/(app)/collections/index.tsx',
    reason: 'runner_cannot_reach',
    construct: 'replace(/[^a-z0-9]+/g, "-")',
    note: 'An inline slug in a SCREEN; the dashboard runner is lib-only with no renderer (#469).',
  },
];

/**
 * The globs a package's own vitest runner collects tests from.
 *
 * Read out of the config rather than assumed, because the whole value of the
 * `runner_cannot_reach` exemption is that widening the include RETIRES it.
 */
function runnerIncludeGlobs(packageDirectory: string): string[] {
  const config = join(PACKAGES_ROOT, packageDirectory, 'vitest.config.ts');
  if (!existsSync(config)) return [];
  const include = /include:\s*\[([^\]]*)\]/.exec(readFileSync(config, 'utf8'));
  if (include === null) return [];
  return [...include[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

/**
 * Is this module's ONLY fold a canonical (lossless) NFC composition?
 *
 * Two conditions, both necessary: `unicode_normalize` must be the module's only
 * fold KIND, and every normalize call in it must name `NFC`. A single `NFKC`,
 * `NFKD` or `NFD` anywhere disqualifies it — compatibility mappings are lossy
 * and NFD is the first half of two of the three defects this gate exists for.
 */
function foldsOnlyByCanonicalComposition(id: string, kinds: readonly FoldKind[]): boolean {
  if (kinds.length !== 1 || kinds[0] !== 'unicode_normalize') return false;
  const source = stripComments(readFileSync(absolute(id), 'utf8'));
  const forms = [...source.matchAll(/\.normalize\(\s*['"](NF[A-Z]{1,2})['"]\s*\)/g)].map(
    (match) => match[1],
  );
  return forms.length > 0 && forms.every((form) => form === 'NFC');
}

/** The directory prefix a glob can collect from — `lib/**\/x` → `lib/`. */
function globPrefix(glob: string): string {
  const wildcard = glob.search(/[*?[]/);
  const head = wildcard === -1 ? glob : glob.slice(0, wildcard);
  return head.slice(0, head.lastIndexOf('/') + 1);
}

/* ------------------------------------------------------------------ *
 * The gate.
 * ------------------------------------------------------------------ */

describe('the required script families are derived from the shipped locale bundles', () => {
  it('names every script the product ships copy in, and nothing it does not', () => {
    const bundles = localeBundleNames();
    // A derivation over no bundles produces no requirement and passes every
    // assertion below it.
    expect(bundles.length, 'no locale bundles found — did the path move?')
      .toBeGreaterThanOrEqual(8);

    const required = requiredScriptFamilies();
    expect(required.length, 'the derivation produced almost no scripts')
      .toBeGreaterThanOrEqual(6);
    // Latin alone is what a Latin-only product would produce, and is exactly the
    // state #833 exists to make impossible.
    expect(required.filter((script) => script !== 'Latin').length)
      .toBeGreaterThanOrEqual(5);
  });

  it('classifies every letter in every bundle — the residual is the vacuity floor', () => {
    // A classifier that named nothing would report an empty required set and read
    // exactly like a Latin-only product. An unnameable letter fails HERE, naming
    // the bundle and the codepoint, rather than being silently skipped.
    for (const bundle of localeBundleNames()) {
      const { letters, residual } = classifyBundleLetters(bundle);
      expect(letters, `${bundle} contains no letters at all`).toBeGreaterThan(200);
      expect(
        [...new Set(residual)],
        `${bundle} contains letters this classifier cannot name — add the script to CANDIDATE_SCRIPTS`,
      ).toEqual([]);
    }
  });

  it('does NOT require a script that only appears as a mathematical symbol', () => {
    // Greek is in 14 modules of this repository as `Σ` and `µ` in money and
    // matching prose, and ships in no bundle. A hand-written script list drawn by
    // looking at the code would have demanded Greek fixtures — this asserts the
    // derivation does not, which is the whole reason it is a derivation.
    expect(requiredScriptFamilies()).not.toContain('Greek');
    const anyModuleNamesGreek = allSourceFiles().some(
      (id) => !isTestScoped(id) && /\p{Script=Greek}/u.test(readFileSync(absolute(id), 'utf8')),
    );
    expect(anyModuleNamesGreek, 'the control is vacuous — no module contains Greek at all')
      .toBe(true);
  });

  it('the classifier fires on each required script and not on the others', () => {
    // The mutation self-test for the instrument itself.
    for (const sample of SCRIPT_CORPUS) {
      const present = scriptsPresentIn(sample.noun);
      expect(present, `${sample.script} sample does not read as ${sample.script}`)
        .toContain(sample.script);
    }
    expect(scriptsPresentIn('plain ascii')).toEqual(new Set(['Latin']));
    expect(scriptsPresentIn('')).toEqual(new Set());
  });

  it('the corpus covers exactly what the bundles require', () => {
    // The corpus is not the authority and must not silently fall behind one. A
    // locale added tomorrow fails HERE, naming the script that has no sample.
    const required = requiredScriptFamilies();
    const covered: string[] = SCRIPT_CORPUS.map((sample) => sample.script).sort();
    expect(covered).toEqual([...required].sort());
  });
});

describe('the fold surface is derived from a source walk', () => {
  it('finds a non-trivial number of folds across the packages', () => {
    const surface = foldSurface();
    // A walk that reached nothing passes every coverage assertion below.
    expect(surface.size, 'the fold walk found almost nothing — did the roots move?')
      .toBeGreaterThanOrEqual(30);
    for (const id of surface.keys()) {
      expect(existsSync(absolute(id)), `${id} is in the surface but does not exist`).toBe(true);
    }
    // …and every fold kind is actually exercised by the tree, or a kind could be
    // silently broken and the surface would look healthy on the remaining four.
    for (const kind of Object.keys(CONTENT_FOLDS) as FoldKind[]) {
      const found = [...surface.values()].filter((kinds) => kinds.includes(kind)).length;
      expect(found, `no module matched the ${kind} detector — is it broken?`)
        .toBeGreaterThanOrEqual(1);
    }
  });

  it('contains the site of every defect #833 was opened for', () => {
    // The anchor. A narrowing of the detectors that stops examining one of these
    // is a narrowing that would have missed a defect that actually shipped, and
    // it fails here naming the module. Each names a state of the WORLD — these
    // modules fold text — so it survives the defects being fixed.
    const surface = foldSurface();
    const anchors = [
      ['backend/src/services/canonical/normalization.ts', '#830 normalizeEntityName'],
      ['backend/src/db/schema/catalog.ts', '#826 listings.search_vector, write side'],
      ['backend/src/db/catalog/listingRepository.ts', '#826 the query side'],
      ['backend/src/services/supplier-orders/redact.ts', '#832 redactSupplierOrderMessage'],
      ['backend/src/services/search/normalize.ts', "named in #833's census"],
      ['backend/src/services/taxonomy/alias-normalization.ts', "named in #833's census"],
      ['backend/src/services/graph-benchmark/folding.ts', "#833's module-corpus case"],
    ] as const;
    for (const [id, why] of anchors) {
      expect(surface.has(id), `${id} (${why}) is not in the derived surface`).toBe(true);
    }
  });

  it('strips comments, so a fold quoted in prose is not a fold', () => {
    expect(stripComments('const a = 1; // .normalize("NFKD")')).not.toContain('normalize');
    expect(stripComments('/* to_tsvector(x) */ const a = 1;')).not.toContain('to_tsvector');
    expect(stripComments("const url = 'https://x';")).toContain('https://x');
    // The positive control: a REAL fold survives the stripper.
    expect(stripComments("const a = x.normalize('NFKD');")).toContain('normalize');
  });

  it('each detector fires on its own shape and not on a validating one', () => {
    const fires = (kind: FoldKind, source: string): boolean => CONTENT_FOLDS[kind].test(source);
    expect(fires('unicode_normalize', "x.normalize('NFKD')")).toBe(true);
    expect(fires('unicode_normalize', 'x.normalizeThing()')).toBe(false);
    expect(fires('property_class', String.raw`/[^\p{L}\p{N}]/u`)).toBe(true);
    expect(fires('property_class', String.raw`/\p{Script=Latin}/u`)).toBe(false);
    expect(fires('text_search_config', "sql`to_tsvector('english', x)`")).toBe(true);
    expect(fires('codepoint_range', String.raw`/[̀-ͯ]/`)).toBe(true);
    expect(fires('codepoint_range', String.raw`/[\u{300}-\u{36F}]/gu`)).toBe(true);
    // The rewrite/validate line, which is what keeps the surface at 45 and not 126.
    expect(fires('ascii_alphabet_rewrite', String.raw`value.replace(/[^a-z0-9]+/g, '-')`)).toBe(true);
    expect(fires('ascii_alphabet_rewrite', String.raw`/^[A-Z]{3}$/.test(code)`)).toBe(false);
    expect(fires('ascii_alphabet_rewrite', String.raw`z.string().regex(/^[a-z-]+$/)`)).toBe(false);
  });

  it('resolves a MULTI-LINE import, which is how this codebase writes them', () => {
    // The instrument bug that made this gate report six scripts as one. Without
    // this control the coverage half reads almost everything as uncovered, and
    // the remedy would have been to add fixtures that already existed.
    const multiline = "import {\n  a,\n  b,\n} from '../thing.js';";
    RELATIVE_IMPORT.lastIndex = 0;
    expect([...multiline.matchAll(RELATIVE_IMPORT)].map((m) => m[1])).toEqual(['../thing.js']);
    RELATIVE_IMPORT.lastIndex = 0;
    expect([...("import x from 'vitest';".matchAll(RELATIVE_IMPORT))]).toEqual([]);
  });
});

/**
 * Every module short of a required script, as sentences.
 *
 * `erase` is the seam the mutation self-test drives: it removes one script from
 * whatever a module's covering text would otherwise contain, which is what
 * deleting that script's fixtures does. Injected rather than performed on disk,
 * so the self-test cannot leave a half-applied edit behind — the failure mode
 * `AGENTS.md` records as indistinguishable from a mutation that survived.
 */
function coverageGaps(erase?: { readonly script: string; readonly from: string }): string[] {
  const required = requiredScriptFamilies();
  const surface = foldSurface();
  const importers = directImporters();
  const exempt = new Set(SCRIPT_COVERAGE_EXEMPTIONS.map((entry) => entry.module));

  const gaps: string[] = [];
  for (const id of [...surface.keys()].sort()) {
    if (exempt.has(id)) continue;
    let text = coveringText(id, importers);
    if (erase !== undefined && id === erase.from) {
      text = text.replace(new RegExp(`\\p{Script=${erase.script}}`, 'gu'), '');
    }
    const present = scriptsPresentIn(text);
    const missing = required.filter((script) => !present.has(script));
    if (missing.length > 0) gaps.push(`${id} is missing ${missing.join(', ')}`);
  }
  return gaps;
}

describe('every fold has fixture coverage for every required script', () => {
  it('names each module and the scripts it is missing', () => {
    expect(coverageGaps()).toEqual([]);
  });

  it('goes RED naming the file and the script when one script’s fixtures go — the mutation', () => {
    // The self-test the whole file rests on. Without it "no gaps" is satisfied
    // by a census that examines nothing, and every floor above it is satisfied
    // by the remainder.
    //
    // Also verified by hand against the real file on 2026-08-21: removing the
    // Bengali title from `listing-localization.realdb.test.ts` exits 1 and names
    // `db/schema/catalog.ts`, `db/schema/catalogLocalization.ts` and
    // `db/catalog/listingRepository.ts`, all missing Bengali.
    const target = 'backend/src/utils/slug.ts';
    const gaps = coverageGaps({ script: 'Devanagari', from: target });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain(target);
    expect(gaps[0]).toContain('Devanagari');
    // …and it must name ONLY the script that was erased, or the mutation is
    // reporting a coincidence rather than the thing it removed.
    expect(gaps[0]).toBe(`${target} is missing Devanagari`);
  });

  it('counts the module source as well as the tests', () => {
    // #833 records getting this wrong: `graph-benchmark/folding.ts` carries its
    // non-Latin corpus in the MODULE, and a test-file-only census scored it zero.
    const importers = directImporters();
    const moduleOnly = scriptsPresentIn(
      stripComments(readFileSync(absolute('backend/src/services/graph-benchmark/folding.ts'), 'utf8')),
    );
    expect(moduleOnly.size, 'the module-corpus case no longer carries a corpus')
      .toBeGreaterThanOrEqual(5);
    expect(coveringText('backend/src/services/graph-benchmark/folding.ts', importers).length)
      .toBeGreaterThan(0);
  });

  it('does not count a script that appears only in a comment', () => {
    // The mutation self-test for "fixtures, not mentions". Both halves matter:
    // the stripped text must LOSE the prose script and KEEP a fixture one.
    const source = `// Devanagari example: साइकिल\nconst fixture = 'велосипед';`;
    const scripts = scriptsPresentIn(stripComments(source));
    expect(scripts.has('Devanagari'), 'a script named in a comment counted as coverage')
      .toBe(false);
    expect(scripts.has('Cyrillic'), 'the stripper ate a real fixture').toBe(true);
  });
});

describe('the exemption register is exact in both directions', () => {
  it('every exempt module is still in the surface, with its construct intact', () => {
    const surface = foldSurface();
    for (const entry of SCRIPT_COVERAGE_EXEMPTIONS) {
      expect(
        surface.has(entry.module),
        `${entry.module} is exempted but is no longer a fold — delete the exemption`,
      ).toBe(true);
      // The staleness check, pointed at the EVIDENCE rather than at the file: an
      // exemption may not outlive the construct it was judged about.
      expect(
        readFileSync(absolute(entry.module), 'utf8'),
        `${entry.module}'s exemption pins a construct that is no longer there — re-judge it`,
      ).toContain(entry.construct);
      expect(entry.note.length, `${entry.module} has no reviewable note`).toBeGreaterThan(30);
    }
  });

  it('has no duplicate entries and no entry outside the walked packages', () => {
    const modules = SCRIPT_COVERAGE_EXEMPTIONS.map((entry) => entry.module);
    expect(new Set(modules).size).toBe(modules.length);
    expect([...modules].sort(), 'keep the register sorted so a diff is readable').toEqual(modules);
  });

  it('the runner_cannot_reach exemption cannot go stale', () => {
    // An exemption that is CHECKED rather than asserted, which is the property
    // every entry above would have if it were derivable. The day the dashboard
    // runner's include reaches `app/`, this fails and the fixture is owed.
    const unreachable = SCRIPT_COVERAGE_EXEMPTIONS.filter(
      (entry) => entry.reason === 'runner_cannot_reach',
    );
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
    for (const entry of unreachable) {
      const packageDirectory = entry.module.split('/')[0];
      const globs = runnerIncludeGlobs(packageDirectory);
      expect(globs.length, `${packageDirectory} has no readable vitest include`)
        .toBeGreaterThan(0);
      const within = entry.module.slice(packageDirectory.length + 1);
      for (const glob of globs) {
        expect(
          within.startsWith(globPrefix(glob)),
          `${packageDirectory}'s runner now collects from '${glob}', which reaches ${entry.module} — write the fixture`,
        ).toBe(false);
      }
    }
    // The positive control. Without it the loop above passes for a package whose
    // config could not be read, which is indistinguishable from one that cannot
    // reach the module.
    expect(globPrefix('lib/**/__tests__/**/*.test.ts')).toBe('lib/');
    expect('app/(app)/collections/index.tsx'.startsWith(globPrefix('app/**/*.test.tsx'))).toBe(true);
  });

  it('the canonical_composition_only exemption cannot go stale either', () => {
    // Also CHECKED rather than asserted. Adding any other fold to one of these
    // modules — an NFKC, an NFD, a character class — retires the exemption.
    const surface = foldSurface();
    const canonical = SCRIPT_COVERAGE_EXEMPTIONS.filter(
      (entry) => entry.reason === 'canonical_composition_only',
    );
    expect(canonical.length).toBeGreaterThanOrEqual(1);
    for (const entry of canonical) {
      expect(
        foldsOnlyByCanonicalComposition(entry.module, surface.get(entry.module) ?? []),
        `${entry.module} folds by more than canonical NFC — write the fixtures`,
      ).toBe(true);
    }
    // The positive control, on real modules: a compatibility fold and a
    // character-class fold must BOTH be refused, or the probe above is satisfied
    // by anything at all.
    for (const lossy of [
      'backend/src/services/search/normalize.ts',
      'backend/src/services/taxonomy/alias-normalization.ts',
      'backend/src/utils/slug.ts',
    ]) {
      expect(
        foldsOnlyByCanonicalComposition(lossy, surface.get(lossy) ?? []),
        `${lossy} was accepted as lossless, which it is not`,
      ).toBe(false);
    }
  });

  it('exempts a minority of the surface', () => {
    // A register that grew to cover most of the surface would be the gate
    // switching itself off one defensible line at a time. A RATIO rather than a
    // count, so it does not conflict on every rebase, and it names a state of the
    // world: more folds in this codebase handle human text than machine tokens.
    //
    // The headroom is deliberately small — 20 of 45 today — and hitting it is a
    // signal rather than a nuisance. The question to ask then is not "raise the
    // ratio" but "has the SURFACE definition drifted": a detector that started
    // matching validation, or a domain that grew a dozen key folds, both show up
    // here first. Raising it is the last resort, and it needs a sentence saying
    // which of those two happened.
    const surface = foldSurface();
    expect(
      SCRIPT_COVERAGE_EXEMPTIONS.length,
      `${SCRIPT_COVERAGE_EXEMPTIONS.length} of ${surface.size} folds are exempt — check whether the surface definition drifted before widening this`,
    ).toBeLessThan(surface.size / 2);
  });
});
