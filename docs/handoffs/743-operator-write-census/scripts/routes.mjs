/**
 * The route list WITHOUT handler resolution — the cheapest form, kept because
 * it is the one to run first when the population is in doubt.
 *
 * Measured 2026-08-23 at 7bcce335: 139 rows across 23 files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES } from './paths.mjs';

const GATE = /requireCatalogOperator|CATALOG_OPERATOR_OXY_USER_IDS/;
const WRITE = /^router\.(post|patch|put|delete)\s*\(\s*(?:\n\s*)?'([^']+)'/gm;
for (const name of readdirSync(ROUTES).filter((n) => n.endsWith('.ts')).sort()) {
  const source = readFileSync(join(ROUTES, name), 'utf8');
  if (!GATE.test(source)) continue;
  const writes = [...source.matchAll(WRITE)];
  if (writes.length === 0) continue;
  console.log(`\n## ${name}`);
  for (const m of writes) console.log(`  ${m[1].toUpperCase().padEnd(6)} ${m[2]}`);
}
