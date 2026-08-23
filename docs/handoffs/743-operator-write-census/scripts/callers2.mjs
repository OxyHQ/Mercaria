/**
 * THE CORRECTED PREDICATE for `drives_existing_path`'s second half: files
 * outside routes/ and controllers/ that CALL the symbol and do not DEFINE it.
 *
 * Excluding the definer is the whole fix; without it every symbol passes. Usage:
 *
 *   node callers2.mjs runIntentBenchmark rebuildEntityAggregates ...
 *
 * Measured 2026-08-23 at 7bcce335 on
 * `runIntentBenchmark rebuildEntityAggregates grantRole recordAwinSample`:
 * 0 / 1 / 0 / 0, against 1 / 2 / 1 / 1 from the vacuous version.
 *
 * NOTE, and this is why the census cannot rest on it: a zero here is not a gap.
 * `runIntentBenchmark` has zero non-route callers and is nonetheless disposed
 * of, by `actor_column` (`ranByOxyUserId` NOT NULL plus a CHECK). The five-value
 * vocabulary must be evaluated IN ORDER, so `actor_column` is answered before
 * this predicate is ever consulted.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC } from './paths.mjs';

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}
const files = walk(SRC).filter((p) => !p.includes('__tests__') && !p.endsWith('.test.ts'));

function classify(symbol) {
  const callRe = new RegExp('(?<![.\\w])' + symbol + '\\s*\\(');
  const defRe = new RegExp(
    '(?:export\\s+)?(?:async\\s+)?function\\s+' + symbol + '\\b|const\\s+' + symbol + '\\s*[:=]',
  );
  const definers = [];
  const callers = [];
  for (const p of files) {
    const src = readFileSync(p, 'utf8');
    const isDef = defRe.test(src);
    if (isDef) definers.push(p);
    if (p.includes('/routes/') || p.includes('/controllers/')) continue;
    if (!callRe.test(src)) continue;
    if (isDef) continue; // its own definition is not a caller
    callers.push(p);
  }
  return { definers, callers };
}

for (const symbol of process.argv.slice(2)) {
  const { definers, callers } = classify(symbol);
  console.log(
    symbol.padEnd(34) + ' defs=' + String(definers.length) + '  non-route callers=' + String(callers.length),
  );
  for (const c of callers.slice(0, 3)) console.log('      ' + c.replace(SRC + '/', ''));
}
