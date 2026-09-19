/**
 * POPULATION, the exclusion: `__tests__` files under routes/ also match the
 * gate, and they are not routers. The census must ASSERT this exclusion rather
 * than perform it silently — a test file quietly dropped is indistinguishable
 * from a router that was never there.
 *
 * Measured 2026-08-23 at 7bcce335:
 *   all .ts under routes/       43
 *   gated (incl. __tests__)     43   <- every .ts under routes/ matches the gate
 *   of which __tests__          13
 *   routers (excl. __tests__)   30
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES } from './paths.mjs';

const GATE = /requireCatalogOperator|CATALOG_OPERATOR_OXY_USER_IDS/;
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
const all = walk(ROUTES);
const gated = all.filter((p) => GATE.test(readFileSync(p, 'utf8')));
const tests = gated.filter((p) => p.includes('__tests__'));
console.log('all .ts under routes/      :', all.length);
console.log('gated (incl. __tests__)    :', gated.length);
console.log('  of which __tests__       :', tests.length);
console.log('  routers (excl. __tests__):', gated.length - tests.length);
