/**
 * The DOMAIN-half census (#460), v2.
 *
 * v1 was wrong in the dangerous direction and is kept only as a lesson: it
 * scored every path array as if it were a gate's POPULATION, so it reported
 * `FLAG_READING_CLAIM_MODULES` (an exemption set), `PURE_PATHS` (the modules
 * asserted to be pure) and `CROSSING_PATHS` (the modules that MAY cross) as
 * "derivable and drifted", with a walk of the whole domain as the suggested
 * fix. Acting on that would widen walls that are deliberately narrow — a census
 * that pushes you toward the hazard.
 *
 * v2 asks the structural question first: **is this array the SUBJECT of a scan,
 * or a SUBSET used to except, skip or assert about specific modules?**
 *
 *   subject  — `for (const x of ARR)` whose body asserts over `x`
 *   subset   — reached through `.includes(`, `.some(`, `.filter(` inside another
 *              scan, or asserted whole with `toEqual`/`toContain`
 *
 * Only a SUBJECT array can be a stale population. A SUBSET is bucket C by
 * construction: its narrowness is the point.
 *
 * Then, for subjects, the derivation is taken from the array's OWN entries —
 * walk the owned directories its entries actually live in, plus the flat shared
 * modules whose filename carries the domain slug read off those directories.
 * No score-minimising over guessed words, which is what produced v1's
 * `slug "outbox" -> 71 derived` nonsense.
 *
 * Three buckets:
 *   A derivable and DRIFTED   — the walk finds modules the list does not
 *   B derivable and COMPLETE  — same set today; undefended, needs the
 *                               added-module probe rather than a floor
 *   C NOT derivable / not a population — a legitimate hand list
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ARGS = process.argv.slice(2);
const QUIET = ARGS.includes('--quiet');
/**
 * The positional argument is optional and the FLAG must not be mistaken for it:
 * `process.argv[2]` is `--quiet` when only the flag is passed, which censuses a
 * directory named `--quiet` and dies in `readdirSync`. Measured, on the first
 * version of this file.
 */
const SRC =
  ARGS.find((arg) => !arg.startsWith('--')) ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const walk = (rel: string): string[] => {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(SRC, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '__tests__') continue;
    const c = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(c));
    else if (e.name.endsWith('.ts')) out.push(c);
  }
  return out;
};
const namedIn = (dir: string, re: RegExp): string[] => {
  try {
    return readdirSync(join(SRC, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && re.test(e.name))
      .map((e) => `${dir}/${e.name}`);
  } catch {
    return [];
  }
};
const isFile = (p: string): boolean => {
  try {
    return statSync(join(SRC, p)).isFile();
  } catch {
    return false;
  }
};
const gateFiles = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name);
    return e.isDirectory() ? gateFiles(p) : e.name.endsWith('isolation.test.ts') ? [p] : [];
  });

const FILEISH = /^[@a-zA-Z][\w./@-]*\/[\w./@-]+\.tsx?$/;

/**
 * The BAG directories — those holding modules for MANY domains, named
 * `<domain>.<role>.ts` or `<domain>.ts`.
 *
 * Used twice, for OPPOSITE purposes, which is why they must be ONE constant. As
 * a GUARD they keep a bag out of `owned`, because walking one derives every
 * domain's modules at once. In the FLAT half they are the directories a
 * domain's own modules are picked out of BY FILENAME.
 *
 * This was two separate literals of four names each, and they had drifted from
 * the truth in three ways — every one silent (#593):
 *
 * - **`db/schema` in neither.** Absent from the flat half, so
 *   `db/schema/<domain>.ts` could not be derived and every figure for a domain
 *   with a schema module read ONE LOW, in the flattering direction. Absent from
 *   the guard, so a list that NAMES a schema module made `db/schema` an owned
 *   directory and walked all 82 — measured: `compatibility`'s 2-entry
 *   `AGGREGATE_EXCLUSIONS` derived 150 and reported `+148`, putting a
 *   deliberate hand list in bucket A, whose advice is "convert to a walk". The
 *   two errors point in OPPOSITE directions, which is how one of them survived
 *   somebody reading the output.
 * - **`controllers/admin` absent while `routes/admin` was present.** The
 *   asymmetry is the tell that this was hand-maintained. Latent today — no gate
 *   names one — and the same over-walk the day one does.
 * - **`services` absent.** Its 37 top-level `<domain>.service.ts` modules are
 *   the same shape as `controllers/<domain>.controller.ts`. `db`'s own eight
 *   flat files are deliberately NOT here: they are infrastructure
 *   (`postgres.ts`, `migrate.ts`, `protectedColumns.ts`), named after no domain.
 *
 * **This is a hand list and it stays one**, because the distinction is
 * semantic. That was measured rather than assumed: a detector scoring "how many
 * of this directory's filenames match some domain directory's leaf" separates
 * `db/schema` (67 of 82) from every real domain directory (`db/referrals` 0 of
 * 17, `db/payments` 0 of 8, `db/catalog` 0 of 6) — and then FAILS on
 * `middleware` (2 of 70) and `services` (2 of 37), which are bags whose files
 * are named after concerns that own no directory. A derivation that looks that
 * clean and is wrong in a new way is worse than a list somebody must edit.
 *
 * So the list is DEFENDED rather than derived: `isolation-gate-census.test.ts`
 * fails the build when a directory scores on the half of that signal which does
 * discriminate and is not named here. That tripwire cannot see a
 * `middleware`-shaped bag, and it says so rather than implying coverage.
 */
export const SHARED_FLAT_DIRS = [
  'controllers',
  'controllers/admin',
  'routes',
  'routes/admin',
  'middleware',
  'db/schema',
  'services',
] as const;
const SHARED_DIRS = new Set<string>(SHARED_FLAT_DIRS);

/** slug candidates from the OWNED directory names only: `db/guestClaims` -> guestclaims, guest-claim… */
function slugsFor(owned: string[]): string[] {
  const out = new Set<string>();
  for (const d of owned) {
    // `pop()` on a non-empty split cannot be undefined, but the compiler does
    // not know that and `!` is forbidden here — default instead.
    const leaf = d.split('/').pop() ?? d;
    out.add(leaf.toLowerCase());
    // camelCase -> kebab, and singularised, since `db/guestClaims` serves
    // `controllers/guest-claim-operator.controller.ts`.
    const kebab = leaf.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    out.add(kebab);
    out.add(kebab.replace(/s$/, ''));
    for (const part of kebab.split('-')) if (part.length > 3) out.add(part.replace(/s$/, ''));
  }
  return [...out];
}

const rows: Row[] = [];
for (const file of gateFiles(SRC).sort()) {
  const src = readFileSync(file, 'utf8');
  const rel = file.slice(SRC.length + 1);
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      let i = n.initializer;
      if (ts.isAsExpression(i)) i = i.expression;
      if (ts.isArrayLiteralExpression(i)) {
        const lits = i.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
        const objs = i.elements
          .filter(ts.isObjectLiteralExpression)
          .flatMap((o) =>
            o.properties
              .filter(ts.isPropertyAssignment)
              .map((property) => property.initializer)
              .filter(ts.isStringLiteralLike)
              .map((literal) => literal.text),
          );
        const paths = [...lits, ...objs].filter((s) => FILEISH.test(s));
        if (paths.length >= 2) {
          const name = n.name.text;
          const iterated = new RegExp(`for\\s*\\(\\s*const\\s+\\w+\\s+of\\s+${name}\\b`).test(src);
          rows.push({ rel, name, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, paths, iterated });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

type Row = { rel: string; name: string; line: number; paths: string[]; iterated: boolean };
type Classified = Row & {
  why?: string;
  derived?: string[];
  added?: string[];
  owned?: string[];
  missing?: string[];
};
const A: Classified[] = [];
const B: Classified[] = [];
const C: Classified[] = [];
for (const row of rows) {
  if (!row.iterated) {
    C.push({ ...row, why: 'never iterated as a scan subject — an exception, alias or identity list' });
    continue;
  }
  if (row.paths.some((p) => !isFile(p))) {
    C.push({ ...row, why: 'names path(s) outside packages/backend/src (a cross-package list)' });
    continue;
  }
  const owned = [...new Set(row.paths.map((p) => p.split('/').slice(0, 2).join('/')))].filter(
    (d) => !SHARED_DIRS.has(d) && d.includes('/') && (() => { try { return statSync(join(SRC, d)).isDirectory(); } catch { return false; } })(),
  );
  if (owned.length === 0) {
    C.push({ ...row, why: 'every entry sits in a flat shared directory — no domain directory to walk' });
    continue;
  }
  const slugs = slugsFor(owned);
  const flat = [...new Set(SHARED_FLAT_DIRS.flatMap((d) => slugs.flatMap((s) => namedIn(d, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')))))];
  const derived = [...new Set([...owned.flatMap(walk), ...flat])];
  const missing = row.paths.filter((p) => !derived.includes(p));
  const added = derived.filter((p) => !row.paths.includes(p));
  if (missing.length > 0) {
    C.push({ ...row, why: `the walk misses ${missing.length} listed entr(ies) — the list spans more than its own directories: ${missing.slice(0, 3).join(', ')}`, derived, missing });
  } else if (added.length > 0) {
    A.push({ ...row, derived, added, owned });
  } else {
    B.push({ ...row, derived, owned });
  }
}

const show = (label: string, list: Classified[], extra?: (r: Classified) => void): void => {
  console.log(`\n${'='.repeat(74)}\n${label}  —  ${list.length}\n${'='.repeat(74)}`);
  for (const r of list) {
    console.log(`\n${r.rel}\n   L${r.line} ${r.name} (${r.paths.length} entries)`);
    if (extra && !QUIET) extra(r);
  }
};
show('BUCKET A — a POPULATION, derivable, and DRIFTED', A, (r) => {
  console.log(
    `   walk ${(r.owned ?? []).join(' + ')} -> ${(r.derived ?? []).length}, ` +
      `+${(r.added ?? []).length} outside the list:`,
  );
  for (const p of r.added ?? []) console.log(`        + ${p}`);
});
show('BUCKET B — a POPULATION, derivable, COMPLETE today (undefended)', B, (r) => {
  console.log(
    `   walk ${(r.owned ?? []).join(' + ')} -> ${(r.derived ?? []).length}: same set. ` +
      'Needs the ADDED-module probe, not a floor.',
  );
});
show('BUCKET C — not a population, or not derivable (a legitimate hand list)', C, (r) => {
  console.log(`   ${r.why}`);
});
console.log(`\n\nA=${A.length}  B=${B.length}  C=${C.length}   (${rows.length} arrays over ${gateFiles(SRC).length} gates)`);
