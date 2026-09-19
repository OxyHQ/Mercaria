/**
 * DISPROVED HINT GENERATOR #1: follow each handler one hop further, into the
 * symbols its module imported, and look for a trail writer or an actor column.
 *
 * Run it to see the numbers; do NOT use the numbers. See SPEC.md, "The two
 * demonstrated negatives". `POST /roles` lands in `neither` and is audited:
 * `grantRoleHandler` calls `grantRole` (`services/catalog-governance/role.service.ts:129`),
 * which calls `recordAuditEvent` at `:159` — two hops is not enough, and five
 * is not enough either.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { ROUTES } from './paths.mjs';

const GATE = /requireCatalogOperator|CATALOG_OPERATOR_OXY_USER_IDS/;
const WRITE = /^router\.(post|patch|put|delete)\s*\(([\s\S]*?)\);$/gm;
const TRAIL = /(?<![.\w])(recordAuditEvent|recordRevision|recordCompensation|insertReviewEvent)\s*\(/;
const ACTOR = /[A-Za-z]+ByOxyUserId/;

function importMap(file) {
  const src = readFileSync(file, 'utf8');
  const map = new Map();
  for (const m of src.matchAll(/import\s+\{([^}]+)\}\s+from\s+'([^']+)'/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
    if (!existsSync(target)) continue;
    for (const raw of m[1].split(',')) {
      const name = raw.replace(/\btype\b/, '').split(/\s+as\s+/)[0].trim();
      if (name) map.set(name, target);
    }
  }
  return map;
}

function functionBody(source, name) {
  const head = new RegExp('(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const at = source.search(head);
  if (at < 0) return null;
  const open = source.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/** Symbols the body calls that the module imported — the next hop. */
function nextHops(body, imports) {
  const hops = [];
  for (const m of body.matchAll(/(?<![.\w])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const target = imports.get(m[1]);
    if (target) hops.push({ symbol: m[1], module: target });
  }
  return hops;
}

let routes = 0;
const tally = { handlerTrail: 0, hop2Trail: 0, hop2Actor: 0, neither: 0 };
const neither = [];

for (const name of readdirSync(ROUTES).filter((f) => f.endsWith('.ts')).sort()) {
  const file = join(ROUTES, name);
  const src = readFileSync(file, 'utf8');
  if (!GATE.test(src)) continue;
  const routerImports = importMap(file);
  for (const m of src.matchAll(WRITE)) {
    const path = m[2].match(/'([^']+)'/)?.[1];
    if (!path) continue;
    const ids = [...m[2].matchAll(/([A-Za-z_$][\w$]*)\s*,?\s*$/gm)].map((x) => x[1]);
    const handler = ids.at(-1);
    const module = routerImports.get(handler);
    if (!module) continue;
    routes += 1;
    const modSrc = readFileSync(module, 'utf8');
    const body = functionBody(modSrc, handler) ?? '';
    if (TRAIL.test(body)) {
      tally.handlerTrail += 1;
      continue;
    }
    const hops = nextHops(body, importMap(module));
    let trail = false;
    let actor = false;
    for (const hop of hops) {
      const hopSrc = readFileSync(hop.module, 'utf8');
      const hopBody = functionBody(hopSrc, hop.symbol);
      if (hopBody && TRAIL.test(hopBody)) trail = true;
      if (hopBody && ACTOR.test(hopBody)) actor = true;
    }
    if (trail) tally.hop2Trail += 1;
    else if (actor) tally.hop2Actor += 1;
    else {
      tally.neither += 1;
      neither.push(name + '  ' + m[1].toUpperCase() + ' ' + path + '  ' + handler);
    }
  }
}

console.log('routes examined        :', routes);
console.log('trail in handler       :', tally.handlerTrail);
console.log('trail at hop 2         :', tally.hop2Trail);
console.log('actor column at hop 2  :', tally.hop2Actor);
console.log('neither (candidates)   :', tally.neither);
console.log('\nfirst 15 candidates:');
for (const n of neither.slice(0, 15)) console.log('  ' + n);
