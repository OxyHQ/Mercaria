/**
 * DISPROVED PREDICATE: "files outside routes/ and controllers/ that name this
 * symbol" — the first spelling of `drives_existing_path`'s non-route-caller
 * half, and a VACUOUS one.
 *
 * A symbol's own defining module is outside routes/ and controllers/, so every
 * symbol satisfies the predicate by existing. Measured 2026-08-23 at 7bcce335,
 * on `runIntentBenchmark rebuildEntityAggregates grantRole recordAwinSample`:
 *
 *   callers.mjs  (this file) 1  2  1  1   <- every symbol passes
 *   callers2.mjs             0  1  0  0   <- definer excluded
 *
 * Three of this file's four hits ARE the defining module.
 *
 * Kept so the next reader does not rebuild it.
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

/** Files OUTSIDE routes/ and controllers/ that name the symbol. */
function nonRouteCallers(symbol) {
  const re = new RegExp('(?<![.\\w])' + symbol + '\\s*\\(');
  return files.filter((p) => {
    if (p.includes('/routes/') || p.includes('/controllers/')) return false;
    return re.test(readFileSync(p, 'utf8'));
  });
}

for (const symbol of process.argv.slice(2)) {
  const hits = nonRouteCallers(symbol);
  console.log(String(hits.length).padStart(3) + '  ' + symbol);
  for (const h of hits.slice(0, 4)) console.log('      ' + h.replace(SRC + '/', ''));
}
