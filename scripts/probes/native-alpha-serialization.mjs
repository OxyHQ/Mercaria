/** Reproduce the Metro serialization boundary, without changing dependencies.
 * Run: bun scripts/probes/native-alpha-serialization.mjs
 * Currently fails with react-native-css 3.1.0-rc.0; remove this diagnostic only
 * after the official fix and real native rendering have both been verified.
 * https://github.com/nativewind/react-native-css/pull/464
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from '@tailwindcss/node';
import { compile as compileNative } from 'react-native-css/compiler';

const candidates = ['bg-black/30', 'bg-black/75', 'bg-black/[0.04]', 'bg-white/75'];
let failures = 0;
for (const app of ['frontend', 'dashboard', 'pos']) {
  const base = fileURLToPath(new URL(`../../packages/${app}/`, import.meta.url));
  const tailwind = await compile(await readFile(`${base}/global.css`, 'utf8'), { base, onDependency() {} });
  // These are the actual withNativeWind options. The default inlineVariables
  // optimization hides the bug by evaluating fixed colors before serialization.
  const sheet = compileNative(tailwind.build(candidates), { inlineVariables: false, inlineRem: 16 }).stylesheet();
  const serialized = JSON.parse(JSON.stringify(sheet));
  for (const candidate of candidates) {
    const rules = serialized.s?.find(([name]) => name === candidate)?.[1];
    if (!rules?.length) throw new Error(`Missing ${app} rule: ${candidate}`);
    const invalid = [];
    function visit(value) {
      if (!Array.isArray(value) && (value === null || typeof value !== 'object')) return;
      if (Array.isArray(value) && value[1] === 'colorMix' && value[2]?.includes(null)) invalid.push(value[2]);
      for (const child of Object.values(value)) visit(child);
    }
    visit(rules);
    if (invalid.length) {
      failures++;
      console.error(`${app} ${candidate}: serialized optional weights contain null`, JSON.stringify(invalid));
    }
  }
}
if (failures) {
  console.error(`${failures} native color descriptors fail the compiler/runtime contract. Native alpha rendering remains unresolved.`);
  process.exitCode = 1;
} else {
  console.log('No null color-mix weights after serialization. Verify colors on a native device before closing the issue.');
}
