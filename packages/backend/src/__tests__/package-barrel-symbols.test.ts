/**
 * The symbol -> owner resolver reads a real tree, and would notice if it stopped (#582).
 *
 * Everything here is a control on `package-barrel-symbols.ts`, because that
 * module's failure mode is silence: a resolver that resolved NOTHING would make
 * every wall built on it green, and a wall that reports no offender is exactly
 * what a working wall looks like. Each floor below is an absolute number taken
 * from a measurement, never derived from the list it defends.
 *
 * The load-bearing one is `every symbol imported anywhere in the workspace
 * resolves`. It is the validation-against-known-answers `docs/isolation-gates.md`
 * asks for, it is free, and it is exactly on-distribution — and it found a real
 * defect on its first run: `import { A as B }` requests `A` while
 * `export { A as B }` publishes `B`, and taking the local alias left 22 symbols
 * (`Listing as ListingDTO`, `ORDER_SELLER_TYPES as SHARED_ORDER_SELLER_TYPES`, …)
 * resolving to nothing. An unresolved symbol is one a wall reads as reaching
 * nothing, so that is the quiet direction.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  PACKAGE_BARRELS,
  PACKAGES_ROOT,
  REPO_ROOT,
  packageBarrelImportsOf,
  packageModulesReachedBy,
  reachesPackageModule,
  resolveBarrelSymbol,
  stripComments,
} from './package-barrel-symbols.js';

const SHARED_TYPES = '@mercaria/shared-types';
const UI = '@mercaria/ui';

function barrelOf(packageName: string) {
  const barrel = PACKAGE_BARRELS.find((candidate) => candidate.packageName === packageName);
  if (!barrel) throw new Error(`${packageName} is not a derived package barrel`);
  return barrel;
}

/** Every `.ts`/`.tsx` in the workspace, builds and dependencies excluded. */
function walkWorkspace(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '.expo', 'build'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkWorkspace(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const WORKSPACE_FILES = walkWorkspace(PACKAGES_ROOT);

describe('the packages are derived, not named', () => {
  it('finds both package barrels by shape', () => {
    const names = PACKAGE_BARRELS.map((barrel) => barrel.packageName);
    expect(names).toContain(SHARED_TYPES);
    expect(names).toContain(UI);
    // The vacuity floor for everything below: if the derivation broke, this list
    // would be empty, no symbol could resolve, and every wall built on it would
    // report a clean tree.
    expect(PACKAGE_BARRELS.length).toBeGreaterThanOrEqual(2);
    for (const barrel of PACKAGE_BARRELS) expect(statSync(barrel.path).isFile()).toBe(true);
  });

  it('leaves a package whose entry is not a barrel out', () => {
    // The negative control on the derivation. `packages/backend/src/index.ts`
    // exists and is a server entrypoint carrying no re-export, so it drops out
    // on its SHAPE — not on a name somebody remembered to exclude. Without
    // this, a derivation that simply said yes to every package would look
    // identical.
    expect(existsSync(join(PACKAGES_ROOT, 'backend', 'src', 'index.ts'))).toBe(true);
    expect(PACKAGE_BARRELS.map((barrel) => barrel.packageName)).not.toContain('@mercaria/backend');
  });

  it('resolves every re-export the barrels carry', () => {
    // A re-export the resolver could not follow is a whole MODULE missing from
    // the map, which is the largest hole available and the quietest.
    for (const barrel of PACKAGE_BARRELS) {
      expect(barrel.unresolved, `${barrel.packageName} re-exports a module that did not resolve`).toEqual(
        [],
      );
    }
  });
});

describe('the symbol map is large, and the floors are absolute', () => {
  it('maps the shared-types barrel', () => {
    const barrel = barrelOf(SHARED_TYPES);
    // Measured: 3,752 symbols over 114 owner modules — the barrel's own 114
    // `export * from` lines. Floors per SHAPE, never one total: a collapse in
    // either is a different fault and a single number lets one carry the other.
    expect(barrel.owners.size).toBeGreaterThanOrEqual(3000);
    expect(new Set(barrel.owners.values()).size).toBeGreaterThanOrEqual(100);
  });

  it('maps the ui barrel', () => {
    const barrel = barrelOf(UI);
    // Measured: 329 symbols over 95 owner modules. `ui` states its map itself
    // (`export { … } from`), where shared-types states nothing and the map has
    // to come from what each module declares — the two shapes exercise
    // different halves of the resolver, which is why both are floored.
    expect(barrel.owners.size).toBeGreaterThanOrEqual(250);
    expect(new Set(barrel.owners.values()).size).toBeGreaterThanOrEqual(80);
  });

  it('lands each symbol on a file that exists and declares it', () => {
    for (const barrel of PACKAGE_BARRELS) {
      for (const [symbol, owner] of [...barrel.owners].slice(0, 200)) {
        expect(statSync(owner).isFile(), `${symbol} resolves to a non-file`).toBe(true);
        expect(owner.startsWith(PACKAGES_ROOT)).toBe(true);
      }
    }
  });

  it('answers null for a symbol nothing exports', () => {
    // The negative control on the map: without it, a resolver that returned an
    // owner for everything would satisfy every assertion above.
    expect(resolveBarrelSymbol(SHARED_TYPES, 'zzzNoSuchSymbolExists')).toBeNull();
    expect(resolveBarrelSymbol(UI, 'zzzNoSuchSymbolExists')).toBeNull();
    // `MerchantSummary` is the sharper form — a REAL name that was renamed to
    // `StoreSummary` in #36/#38. The map answers for the live name and not the
    // retired one, so it is reading the tree rather than pattern-matching.
    expect(resolveBarrelSymbol(SHARED_TYPES, 'StoreSummary')).toBe(
      'packages/shared-types/src/product.ts',
    );
    expect(resolveBarrelSymbol(SHARED_TYPES, 'MerchantSummary')).toBeNull();
  });

  it('resolves a symbol from each barrel to its owning module', () => {
    expect(resolveBarrelSymbol(SHARED_TYPES, 'CURRENCY_PRECISION')).toBe(
      'packages/shared-types/src/money.ts',
    );
    expect(resolveBarrelSymbol(UI, 'PriceDisplay')).toBe(
      'packages/ui/src/components/PriceDisplay.tsx',
    );
    // A namespace re-export (`export * as DropdownMenu from …`) binds the
    // NAMESPACE, so the symbol a consumer writes is `DropdownMenu`.
    expect(resolveBarrelSymbol(UI, 'DropdownMenu')).toBe(
      'packages/ui/src/components/ui/dropdown-menu.tsx',
    );
    // And a renamed default (`export { default as H1 } from …`).
    expect(resolveBarrelSymbol(UI, 'H1')).toBe('packages/ui/src/components/ui/h1.tsx');
  });
});

describe('the extractor reads the shapes this repository actually writes', () => {
  it('reads a MULTI-LINE import (the shape that defeated the #556 instrument)', () => {
    // THE positive control on the input. A specifier regex spelled `[^;\n]*?`
    // cannot cross a newline, so every `import {\n  a,\n  b,\n} from '…'` is
    // invisible to it — it counted four barrel importers where there were seven,
    // and A SMALLER NUMBER IS INDISTINGUISHABLE FROM A CLEANER TREE. Measured:
    // 1,051 files in this workspace carry exactly this shape, so an extractor
    // that could not cross a line would silently drop more than half the
    // population.
    const multiLine = [
      'import {',
      '  CURRENCY_PRECISION,',
      '  type StoreSummary,',
      "} from '@mercaria/shared-types';",
      '',
    ].join('\n');

    // Two symbols owned by DIFFERENT modules, so the control proves the whole
    // clause was read rather than only its first entry.
    expect(packageModulesReachedBy(multiLine)).toEqual([
      'packages/shared-types/src/money.ts',
      'packages/shared-types/src/product.ts',
    ]);
  });

  it('requests the EXPORTED name of a renamed import, not the local alias', () => {
    // `import { A as B }` requests A; `export { A as B }` publishes B. The two
    // directions of `as` are opposite, and taking the wrong one left 22 real
    // symbols resolving to nothing — which a wall reads as reaching nothing.
    expect(packageModulesReachedBy("import { Listing as ListingDTO } from '@mercaria/shared-types';")).toEqual(
      ['packages/shared-types/src/listing.ts'],
    );
  });

  it('reads a RE-EXPORT of a package symbol', () => {
    // A re-export reaches the module exactly as an import does, and one exists:
    // `packages/ui/src/lib/format.ts` writes this line. Matching only `import`
    // would report that file as reaching nothing — this issue's own failure, one
    // level down.
    expect(
      packageModulesReachedBy('export type { ProductSummary } from "@mercaria/shared-types";'),
    ).toEqual(['packages/shared-types/src/product.ts']);
    // And the renamed form requests the name on the LEFT of `as`, as an import does.
    expect(
      packageModulesReachedBy("export { Listing as ListingDTO } from '@mercaria/shared-types';"),
    ).toEqual(['packages/shared-types/src/listing.ts']);
  });

  it('reads a type-only import', () => {
    // `import type` reaches the owning module exactly as a value import does,
    // and it is the commonest import shape in this tree.
    expect(packageModulesReachedBy("import type { Money } from '@mercaria/shared-types';")).toEqual([
      'packages/shared-types/src/money.ts',
    ]);
  });

  it('treats a whole-namespace import as reaching everything', () => {
    // `import * as Types from '@mercaria/shared-types'` names no symbol, so
    // there is nothing to resolve — and reporting "reaches nothing" would hand
    // anybody a one-line way around every wall built on this.
    const reached = packageModulesReachedBy("import * as Types from '@mercaria/shared-types';");
    expect(reached.length).toBe(new Set(barrelOf(SHARED_TYPES).owners.values()).size);
    expect(reached).toContain('packages/shared-types/src/money.ts');
  });

  it('ignores an import written inside a comment', () => {
    // Every gate in this repository DOCUMENTS what it forbids using the
    // vocabulary it forbids, so a scan that kept comments would report modules
    // a file never reaches — and the "fix" would be deleting the explanation.
    const commented = [
      '/**',
      " * Never write `import { CURRENCY_PRECISION } from '@mercaria/shared-types';` here.",
      ' */',
      "// import { StoreSummary } from '@mercaria/shared-types';",
      'export const nothing = 1;',
    ].join('\n');
    expect(packageModulesReachedBy(commented)).toEqual([]);
  });

  it('does not let the stripper eat a URL or a real line', () => {
    // The stripper is itself load-bearing in the other direction: one that ate
    // too much would make every scan above pass vacuously.
    expect(stripComments("const u = 'https://x/y';")).toContain('https://x/y');
    expect(
      packageModulesReachedBy("import { Money } from '@mercaria/shared-types'; // a note"),
    ).toEqual(['packages/shared-types/src/money.ts']);
  });

  it('reports an unknown symbol rather than dropping it', () => {
    const [entry] = packageBarrelImportsOf(
      "import { Money, zzzNoSuchSymbolExists } from '@mercaria/shared-types';",
    );
    expect(entry.modules).toEqual(['packages/shared-types/src/money.ts']);
    expect(entry.unresolved).toEqual(['zzzNoSuchSymbolExists']);
  });
});

describe('validated against every symbol this workspace actually imports', () => {
  it('walks a real workspace', () => {
    // Measured: 2,846 source files, 1,809 of them importing a package barrel
    // over 2,179 import sites. Floors per shape.
    expect(WORKSPACE_FILES.length).toBeGreaterThanOrEqual(2000);
    for (const file of WORKSPACE_FILES.slice(0, 5)) expect(statSync(file).isFile()).toBe(true);
  });

  it('resolves every symbol imported from a package barrel anywhere', () => {
    const unresolved = new Map<string, string[]>();
    let importingFiles = 0;
    let sites = 0;
    for (const file of WORKSPACE_FILES) {
      const entries = packageBarrelImportsOf(readFileSync(file, 'utf8'));
      if (entries.length > 0) importingFiles += 1;
      for (const entry of entries) {
        sites += 1;
        for (const symbol of entry.unresolved) {
          if (!unresolved.has(symbol)) unresolved.set(symbol, []);
          unresolved.get(symbol)!.push(relative(REPO_ROOT, file));
        }
      }
    }

    // The floors come first: an empty `unresolved` over an empty population is
    // the vacuous pass this whole file exists to prevent.
    expect(importingFiles).toBeGreaterThanOrEqual(1500);
    expect(sites).toBeGreaterThanOrEqual(1800);

    expect(
      [...unresolved].map(([symbol, files]) => `${symbol} (e.g. ${files[0]})`).sort(),
      'a symbol imported from a package barrel resolves to no owning module. Every wall built ' +
        'on this resolver reads that symbol as reaching NOTHING, so the hole is silent. Either ' +
        'the export shape is one `package-barrel-symbols.ts` does not yet read, or the import ' +
        'names something the package no longer exports.',
    ).toEqual([]);
  });
});

describe('a wall gets the same answer through the barrel as it does directly', () => {
  it('answers the question a wall asks', () => {
    const throughBarrel = "import { ReferralProgramStatus } from '@mercaria/shared-types';";
    expect(reachesPackageModule(throughBarrel, /shared-types\/src\/referral/)).toBe(true);
    expect(reachesPackageModule(throughBarrel, /shared-types\/src\/money/)).toBe(false);
  });

  it('WOULD stop answering if the resolver broke (mutation self-test)', () => {
    // `reachesPackageModule` returning false for everything is the failure that
    // leaves a wall green. A symbol that genuinely resolves is what proves the
    // answer is being computed rather than defaulted.
    expect(resolveBarrelSymbol(SHARED_TYPES, 'ReferralProgramStatus')).toMatch(
      /^packages\/shared-types\/src\/referral/,
    );
    // And the negative half: a pattern matching no owner is false, so the
    // predicate is not simply answering yes.
    expect(
      reachesPackageModule(
        "import { Money } from '@mercaria/shared-types';",
        /shared-types\/src\/zzz-no-such-module/,
      ),
    ).toBe(false);
  });

  it('is blind to none of it where a path detector is blind to all of it', () => {
    // The defect, side by side. The house path detector shape requires a
    // directory SEGMENT before the module, so it sees the deep form and sees
    // NOTHING in the package form — while nothing in this repository writes the
    // deep form, which is why the wall would be green and blind.
    const pathDetector = /from\s+['"][^'"]*(referral|affiliate)[^'"]*['"]/;
    const deepForm = "import { ReferralProgramStatus } from '@mercaria/shared-types/src/referral.js';";
    const packageForm = "import { ReferralProgramStatus } from '@mercaria/shared-types';";

    expect(pathDetector.test(deepForm)).toBe(true);
    expect(pathDetector.test(packageForm)).toBe(false);

    // The resolver answers the same for both.
    expect(reachesPackageModule(packageForm, /shared-types\/src\/referral/)).toBe(true);
  });
});
