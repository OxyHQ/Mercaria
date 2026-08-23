/**
 * THE ROUTE LIST: method, path and handler SYMBOL for each of the 139.
 *
 * The handler is the LAST bare identifier in the `router.<verb>(...)` argument
 * list, which is how the codebase spells it everywhere. `routes.txt` beside
 * this directory is this script's output at 7bcce335.
 *
 * Measured 2026-08-23 at 7bcce335: files 23, routes 139.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES } from './paths.mjs';

const GATE = /requireCatalogOperator|CATALOG_OPERATOR_OXY_USER_IDS/;
const WRITE = /^router\.(post|patch|put|delete)\s*\(([\s\S]*?)\);$/gm;

let total = 0;
const perFile = [];
for (const name of readdirSync(ROUTES).filter((f) => f.endsWith('.ts')).sort()) {
  const src = readFileSync(join(ROUTES, name), 'utf8');
  if (!GATE.test(src)) continue;
  const rows = [];
  for (const m of src.matchAll(WRITE)) {
    const method = m[1].toUpperCase();
    const args = m[2];
    const pathMatch = args.match(/'([^']+)'/);
    if (!pathMatch) continue;
    const ids = [...args.matchAll(/([A-Za-z_$][\w$]*)\s*,?\s*$/gm)].map((x) => x[1]);
    const handler = ids.length > 0 ? ids[ids.length - 1] : '?';
    rows.push({ method, path: pathMatch[1], handler });
    total += 1;
  }
  if (rows.length > 0) perFile.push({ name, rows });
}

for (const f of perFile) {
  console.log('\n## ' + f.name + '  (' + String(f.rows.length) + ')');
  for (const r of f.rows) {
    console.log('  ' + r.method.padEnd(6) + ' ' + r.path.padEnd(50) + ' ' + r.handler);
  }
}
console.log('\nfiles: ' + String(perFile.length) + '  routes: ' + String(total));
