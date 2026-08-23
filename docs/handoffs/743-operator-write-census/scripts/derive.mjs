/**
 * POPULATION, first cut: how many write routes sit behind the catalog-operator
 * gate, per router file.
 *
 * Measured 2026-08-23 at 7bcce335: 23 routers, 139 write routes.
 * Confirmed independently by the team lead at the same figure.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES } from './paths.mjs';

const GATE = /requireCatalogOperator|CATALOG_OPERATOR_OXY_USER_IDS/;
const WRITE = /^router\.(post|patch|put|delete)\s*\(\s*(?:\n\s*)?'([^']+)'/gm;

let totalRoutes = 0;
const rows = [];
for (const name of readdirSync(ROUTES).filter((n) => n.endsWith('.ts')).sort()) {
  const source = readFileSync(join(ROUTES, name), 'utf8');
  if (!GATE.test(source)) continue;
  const writes = [...source.matchAll(WRITE)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  totalRoutes += writes.length;
  rows.push({ name, count: writes.length, writes });
}
rows.sort((a, b) => b.count - a.count);
for (const r of rows) console.log(String(r.count).padStart(3), r.name);
console.log('---');
console.log('gated routers:', rows.length, ' write routes:', totalRoutes);
