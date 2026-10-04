import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = process.cwd();
const base = root + '/docs/audits/2026-10-04-cohort-canonical-store-ids';
const outfile = root + '/packages/backend/dist/cohort-config-smoke.js';
// Same external-package policy as packages/backend/build.ts; a local fixture
// entry, not a claim that the shipping image exports independent leaf modules.
await esbuild.build({ entryPoints:[base+'/compiled-config-entry.ts'], bundle:true,
  platform:'node', target:'node24', format:'esm', outfile, sourcemap:false,
  minify:false, logLevel:'info', plugins:[{name:'externalize-third-party',setup(build) {
    build.onResolve({filter:/^[^./]/}, args => args.path.startsWith('@mercaria/') ? undefined : {path:args.path,external:true});
  }}] });
const env = Object.fromEntries(['PATH','HOME','LANG','LC_ALL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{NODE_ENV:'production',DATABASE_URL:'postgresql://fixture@127.0.0.1:1/fixture',STRIPE_ENABLED:'false',MERCHANT_BILLING_ENABLED:'false',STRIPE_SECRET_KEY:'sk_live_fixture',PEABLE_APP_PUBLIC_KEY:'fixture-public',PEABLE_APP_SECRET:'fixture-secret',MERCHANT_BILLING_PEABLE_COHORT:JSON.stringify(JSON.parse(readFileSync(base+'/cohort.production.json','utf8'))),PEABLE_BASE_URL:'https://api.peable.to',OXY_API_URL:'https://api.oxy.so'});
const result=spawnSync('node',[outfile],{env,cwd:root,stdio:'inherit'});
assert.equal(result.status,0,'Compiled isolated configuration smoke failed');
