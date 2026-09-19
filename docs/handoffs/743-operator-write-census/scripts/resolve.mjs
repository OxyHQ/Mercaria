/**
 * THE BINDING: does every one of the 139 handler symbols resolve to a module,
 * and does that module's body extract?
 *
 * This is the question that decides whether a census can be written at all. If
 * some handlers arrived through a dispatch table or a factory, the census would
 * need a hand-maintained exception list, and a gate that SKIPS what a
 * hand-maintained map omits is not a gate.
 *
 * Measured 2026-08-23 at 7bcce335:
 *   routes                   139
 *   handler module resolved  139   <- no dispatch tables, no factories
 *   handler body resolved    139
 *     -> reaches a trail        1  <- IN THE HANDLER BODY ONLY, and that is the
 *                                     point: handlers delegate. This number is
 *                                     not a disposition. See SPEC.md.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { SRC, ROUTES } from './paths.mjs';

const GATE = /requireCatalogOperator|CATALOG_OPERATOR_OXY_USER_IDS/;
const WRITE = /^router\.(post|patch|put|delete)\s*\(([\s\S]*?)\);$/gm;
const TRAIL = /(?<![.\w])(recordAuditEvent|recordRevision|recordCompensation|insertReviewEvent)\s*\(/;

/** Every `import { a, b } from './x.js'` in a module, as symbol -> resolved path. */
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

/** The body of `export async function NAME(...)` — brace-matched. */
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

const rows = [];
for (const name of readdirSync(ROUTES).filter((f) => f.endsWith('.ts')).sort()) {
  const file = join(ROUTES, name);
  const src = readFileSync(file, 'utf8');
  if (!GATE.test(src)) continue;
  const imports = importMap(file);
  for (const m of src.matchAll(WRITE)) {
    const args = m[2];
    const path = args.match(/'([^']+)'/)?.[1];
    if (!path) continue;
    const ids = [...args.matchAll(/([A-Za-z_$][\w$]*)\s*,?\s*$/gm)].map((x) => x[1]);
    const handler = ids.at(-1) ?? '?';
    const module = imports.get(handler) ?? null;
    let body = null;
    if (module) body = functionBody(readFileSync(module, 'utf8'), handler);
    rows.push({
      router: name,
      method: m[1].toUpperCase(),
      path,
      handler,
      module: module ? module.replace(SRC + '/', '') : null,
      resolved: Boolean(body),
      trail: body ? TRAIL.test(body) : false,
    });
  }
}

const unresolvedModule = rows.filter((r) => r.module === null);
const unresolvedBody = rows.filter((r) => r.module !== null && !r.resolved);
console.log('routes                 :', rows.length);
console.log('handler module resolved:', rows.length - unresolvedModule.length);
console.log('handler body resolved  :', rows.filter((r) => r.resolved).length);
console.log('  -> reaches a trail   :', rows.filter((r) => r.trail).length);
if (unresolvedModule.length) {
  console.log('\nMODULE UNRESOLVED (' + unresolvedModule.length + '):');
  for (const r of unresolvedModule.slice(0, 10)) console.log('  ', r.router, r.method, r.path, r.handler);
}
if (unresolvedBody.length) {
  console.log('\nBODY UNRESOLVED (' + unresolvedBody.length + '):');
  for (const r of unresolvedBody.slice(0, 10)) console.log('  ', r.router, r.handler, '->', r.module);
}
