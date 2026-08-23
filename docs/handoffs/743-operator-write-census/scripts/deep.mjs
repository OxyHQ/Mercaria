/**
 * DISPROVED HINT GENERATOR #2: the same walk to depth 5, with memoisation.
 *
 * Run it to see the numbers; do NOT use the numbers. Deepening the walk moved
 * five routes out of `neither` and left `POST /roles` — an AUDITED route whose
 * trail writer sits 30 lines inside the very first callee — still in it. A
 * walker that misses a two-hop chain it was built to find will miss others in
 * whichever direction its silent `null` pushes them, and a `neither` row is
 * indistinguishable from a real gap.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { ROUTES } from './paths.mjs';

const GATE = /requireCatalogOperator|CATALOG_OPERATOR_OXY_USER_IDS/;
const WRITE = /^router\.(post|patch|put|delete)\s*\(([\s\S]*?)\);$/gm;
const TRAIL = /(?<![.\w])(recordAuditEvent|recordRevision|recordCompensation|insertReviewEvent)\s*\(/;
const ACTOR = /[A-Za-z]+ByOxyUserId/;
const MAX_DEPTH = 5;

const srcCache = new Map();
const read = (p) => {
  if (!srcCache.has(p)) srcCache.set(p, readFileSync(p, 'utf8'));
  return srcCache.get(p);
};

const importCache = new Map();
function importMap(file) {
  if (importCache.has(file)) return importCache.get(file);
  const map = new Map();
  for (const m of read(file).matchAll(/import\s+\{([^}]+)\}\s+from\s+'([^']+)'/g)) {
    if (!m[2].startsWith('.')) continue;
    const target = resolve(dirname(file), m[2].replace(/\.js$/, '.ts'));
    if (!existsSync(target)) continue;
    for (const raw of m[1].split(',')) {
      const name = raw.replace(/\btype\b/, '').split(/\s+as\s+/)[0].trim();
      if (name) map.set(name, target);
    }
  }
  importCache.set(file, map);
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

/** Walk the call graph from one symbol, returning what it reaches. */
function reaches(file, symbol, depth, seen) {
  const key = file + '#' + symbol;
  if (depth > MAX_DEPTH || seen.has(key)) return { trail: false, actor: false, depth: 0 };
  seen.add(key);
  const body = functionBody(read(file), symbol);
  if (!body) return { trail: false, actor: false, depth: 0 };
  if (TRAIL.test(body)) return { trail: true, actor: ACTOR.test(body), depth };
  let actor = ACTOR.test(body);
  const imports = importMap(file);
  for (const m of body.matchAll(/(?<![.\w])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const target = imports.get(m[1]);
    if (!target) continue;
    const r = reaches(target, m[1], depth + 1, seen);
    if (r.trail) return { trail: true, actor: actor || r.actor, depth: r.depth };
    actor = actor || r.actor;
  }
  return { trail: false, actor, depth: 0 };
}

const buckets = { trail: [], actor: [], neither: [] };
for (const name of readdirSync(ROUTES).filter((f) => f.endsWith('.ts')).sort()) {
  const file = join(ROUTES, name);
  const src = read(file);
  if (!GATE.test(src)) continue;
  const routerImports = importMap(file);
  for (const m of src.matchAll(WRITE)) {
    const path = m[2].match(/'([^']+)'/)?.[1];
    if (!path) continue;
    const ids = [...m[2].matchAll(/([A-Za-z_$][\w$]*)\s*,?\s*$/gm)].map((x) => x[1]);
    const handler = ids.at(-1);
    const module = routerImports.get(handler);
    if (!module) continue;
    const r = reaches(module, handler, 1, new Set());
    const row = name.replace('internal-', '').replace('.ts', '') + '  ' + m[1].toUpperCase() + ' ' + path;
    if (r.trail) buckets.trail.push(row + '   (depth ' + r.depth + ')');
    else if (r.actor) buckets.actor.push(row);
    else buckets.neither.push(row);
  }
}

console.log('trail   :', buckets.trail.length);
console.log('actor   :', buckets.actor.length);
console.log('neither :', buckets.neither.length);
console.log('\n--- neither ---');
for (const r of buckets.neither) console.log('  ' + r);
