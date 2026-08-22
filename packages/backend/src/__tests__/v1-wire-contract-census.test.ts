/**
 * The v1 wire contracts are a DERIVED population, and every one is accounted for.
 *
 * Epic #367 line 74. `v1-wire-contracts.ts` carries the reasoning, the measured
 * mutation results and the positive control that makes them mean something; this
 * file is the census that keeps that list honest, and the serving PROOFS it
 * names live in `services/__tests__/v1-wire-contract-serving.test.ts`.
 *
 * ## What is derived and what is declared
 *
 * DERIVED: which properties of `@mercaria/shared-types` are held open for an old
 * client. Recovered with the TypeScript compiler from each property's OWN
 * docblock, so an ADDED contract appears here without anybody editing this file
 * — which is the direction a hand list is blind in, and the direction
 * `docs/isolation-gates.md` measured going wrong across twenty-seven gates.
 *
 * DECLARED: what each one means, where production serves it, and what proves it.
 * None of that is recoverable from a type, and pretending otherwise would be a
 * census that classifies its own subjects.
 *
 * ## The vocabulary, and why it is one token
 *
 * `v1` as a WHOLE WORD, in the member's own JSDoc. Every wider rule measured on
 * this tree was worse: matching the phrase "v1 spelling" misses "the v1 read
 * contract" and "the v1 binary spelling"; matching a docblock anywhere in the
 * file attributes one field's contract to all of its siblings. One token
 * over-collects instead, which is the safe direction — an over-collected member
 * is a `successor` disposition somebody writes down, and an under-collected one
 * is invisible.
 *
 * The digits are IN the boundary class. A `[^A-Za-z_]` boundary would drop `v1`
 * out of `v1's` and `v1-` in some phrasings and return a plausible smaller
 * count; that exact class of silent drop was measured twice in this repository
 * on the day this landed.
 *
 * ## The floors are per SHAPE
 *
 * Three of them, moved independently: files walked, property signatures scanned,
 * members derived. One total would let a shape collapse to zero unnoticed — a
 * parse that produced no members and a package with no v1 contract in it print
 * the same clean line. `statSync` on every file is the other half: a
 * `readdirSync` returning a cached or empty result reads exactly like a tree
 * with nothing in it.
 *
 * ## What this cannot tell you
 *
 * Whether a `provenBy` test ASSERTS anything. A census proves a member exists
 * and was classified; it can never prove the classification is true. It checks
 * the named title is really in the named file — which catches a rename, a
 * deletion and a typo — and the body is what review is for.
 *
 * And it cannot see a v1 contract nobody documented. That hole is stated in
 * `v1-wire-contracts.ts` rather than papered over, and
 * `scripts/validate-catalog-identity-contracts.mjs` is the independent net over
 * the ambiguous-string subset, which needs no prose at all.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as TypeScript from 'typescript';
import { describe, expect, it } from 'vitest';
import { PACKAGES_ROOT, SRC_ROOT, walkPackagesDirectory } from './domain-population.js';
import {
  V1_CONTRACTS_WITHOUT_PROOF,
  V1_SUCCESSOR_MEMBERS,
  V1_WIRE_CONTRACTS,
} from './v1-wire-contracts.js';

/**
 * The real compiler, resolved the way `validate-catalog-identity-contracts.mjs`
 * resolves it — from the repository's own manifest.
 *
 * Typed rather than left as the `any` `createRequire` hands back, so
 * `ts.isPropertySignature` actually NARROWS. Untyped, every guard below silently
 * degrades to a boolean over `any` and the walk would still compile after a
 * member moved to a node kind it does not handle.
 */
const ts: typeof TypeScript = createRequire(join(PACKAGES_ROOT, '..', 'package.json'))(
  'typescript',
);

const CONTRACT_DIR_RELATIVE = 'shared-types/src';
const CONTRACT_DIR = join(PACKAGES_ROOT, CONTRACT_DIR_RELATIVE);

/**
 * `v1` as a whole word. Digits are inside the boundary class deliberately — see
 * the module docblock.
 */
const V1_TOKEN = /(^|[^A-Za-z0-9_])v1([^A-Za-z0-9_]|$)/u;

/* -------------------------------------------------------------------------- */
/*  Floors, per SHAPE                                                           */
/* -------------------------------------------------------------------------- */

/** `.ts` modules under `packages/shared-types/src` today: 124. */
const MINIMUM_CONTRACT_FILES = 110;
/**
 * Every property signature in those modules, nested type literals included,
 * counted once per declaration site: 7,666 today.
 *
 * The population is spelled out because the number is not self-describing —
 * `validate-catalog-identity-contracts.mjs` records three defensible counting
 * rules over the same files giving 7,270 / 7,563 / 7,634, and a floor taken from
 * one rule and compared against a count from another fails for reasons unrelated
 * to what it guards.
 */
const MINIMUM_SCANNED_MEMBERS = 6500;
/** Members whose own docblock names v1: 14 today. */
const MINIMUM_DERIVED_MEMBERS = 12;

/* -------------------------------------------------------------------------- */
/*  The derivation                                                              */
/* -------------------------------------------------------------------------- */

interface DerivedMember {
  readonly path: string;
  readonly file: string;
}

interface Derivation {
  readonly files: number;
  readonly members: number;
  readonly derived: DerivedMember[];
}

/**
 * Every property signature whose OWN docblock names v1, under `directory`.
 *
 * Takes the directory as a parameter so the mutation self-test can run the REAL
 * derivation over a mutated COPY. A self-test that re-implements the walk
 * measures the re-implementation.
 */
export function deriveV1Members(directory: string, files: readonly string[]): Derivation {
  let members = 0;
  const derived: DerivedMember[] = [];

  for (const relative of files) {
    const absolute = join(directory, relative);
    // A `readdirSync` answering from a cache, or a path that has moved, reads
    // exactly like a tree with nothing in it. This is what makes the file floor
    // a measurement rather than an arithmetic identity.
    statSync(absolute);
    const text = readFileSync(absolute, 'utf8');
    const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);

    const ownerChain = (node: TypeScript.Node): string[] => {
      const chain: string[] = [];
      let current = node.parent;
      while (current) {
        if (ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) {
          chain.unshift(current.name.getText(source));
          break;
        }
        if (ts.isPropertySignature(current) && current.name) {
          chain.unshift(current.name.getText(source));
        }
        current = current.parent;
      }
      return chain;
    };

    const visit = (node: TypeScript.Node): void => {
      if (ts.isPropertySignature(node) && node.name) {
        members += 1;
        const doc = ts
          .getJSDocCommentsAndTags(node)
          .map((tag: TypeScript.Node) => tag.getFullText(source))
          .join('\n');
        if (V1_TOKEN.test(doc)) {
          derived.push({
            path: [...ownerChain(node), node.name.getText(source)].join('.'),
            file: relative,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return { files: files.length, members, derived };
}

/** The `.ts` modules of `packages/shared-types/src`, relative to it. */
function contractFiles(): string[] {
  return walkPackagesDirectory(CONTRACT_DIR_RELATIVE).map((path) =>
    path.slice(CONTRACT_DIR_RELATIVE.length + 1),
  );
}

const REAL = deriveV1Members(CONTRACT_DIR, contractFiles());

/* -------------------------------------------------------------------------- */

describe('v1 wire contracts — the derived population', () => {
  it('walked a real tree: files, members and derived members each clear their own floor', () => {
    expect(REAL.files).toBeGreaterThanOrEqual(MINIMUM_CONTRACT_FILES);
    expect(REAL.members).toBeGreaterThanOrEqual(MINIMUM_SCANNED_MEMBERS);
    expect(REAL.derived.length).toBeGreaterThanOrEqual(MINIMUM_DERIVED_MEMBERS);
  });

  it('derives no DUPLICATE path, so collapsing to a set below loses nothing', () => {
    // The exactness check compares SETS, and a set silently absorbs a second
    // declaration of one path — which would let a member be excused by an entry
    // written for its twin. Asserting the multiset and the set are the same size
    // is what makes that collapse provably lossless rather than merely unlikely.
    const paths = REAL.derived.map((member) => member.path);
    const duplicated = paths.filter((path, index) => paths.indexOf(path) !== index);

    expect(duplicated, 'one path derived from two declaration sites').toEqual([]);
    expect(new Set(paths).size).toBe(REAL.derived.length);
  });

  it('the registry covers EXACTLY the derived set, in both directions', () => {
    const derivedPaths = [...new Set(REAL.derived.map((member) => member.path))].sort();
    const registeredPaths = [...new Set(V1_WIRE_CONTRACTS.map((entry) => entry.path))].sort();

    // Named separately so a failure says WHICH direction went wrong: an
    // unregistered contract is a new promise nobody decided about, and a
    // registered one that no longer derives is a contract that was retired
    // without the entry being removed. They need opposite remedies.
    const unregistered = derivedPaths.filter((path) => !registeredPaths.includes(path));
    const stale = registeredPaths.filter((path) => !derivedPaths.includes(path));

    expect(unregistered, 'derived from shared-types but absent from V1_WIRE_CONTRACTS').toEqual([]);
    expect(stale, 'in V1_WIRE_CONTRACTS but no longer derived from shared-types').toEqual([]);
  });

  it('every entry names the file it is declared in', () => {
    const byPath = new Map(REAL.derived.map((member) => [member.path, member.file]));
    for (const entry of V1_WIRE_CONTRACTS) {
      expect(byPath.get(entry.path), `${entry.path} declaring module`).toBe(entry.file);
    }
  });

  it('pins the un-proven and successor counts EXACTLY, in both directions', () => {
    const unproven = V1_WIRE_CONTRACTS.filter(
      (entry) => entry.direction !== 'successor' && entry.provenBy === null,
    );
    const successors = V1_WIRE_CONTRACTS.filter((entry) => entry.direction === 'successor');

    // `toBe`, never `toBeLessThanOrEqual`: a ceiling admits a proof being
    // deleted, and a floor admits a new un-gated contract. See
    // `V1_CONTRACTS_WITHOUT_PROOF`.
    expect(
      unproven.length,
      `un-proven: ${unproven.map((entry) => entry.path).join(', ')}`,
    ).toBe(V1_CONTRACTS_WITHOUT_PROOF);
    expect(successors.length).toBe(V1_SUCCESSOR_MEMBERS);
  });
});

describe('v1 wire contracts — every entry is bound to production', () => {
  /** Source of a backend module, by path under `src/`. */
  const backendSource = (relative: string): string =>
    readFileSync(join(SRC_ROOT, relative), 'utf8');

  it('a successor carries no serving site and a contract always does', () => {
    for (const entry of V1_WIRE_CONTRACTS) {
      if (entry.direction === 'successor') {
        expect(entry.servedBy, `${entry.path} is a successor`).toBeNull();
      } else {
        expect(entry.servedBy, `${entry.path} must name where production serves it`).not.toBeNull();
      }
    }
  });

  it('every serving site EXPORTS the symbol it names', () => {
    const sites = V1_WIRE_CONTRACTS.flatMap((entry) =>
      entry.servedBy ? [{ path: entry.path, site: entry.servedBy }] : [],
    );
    // The vacuity floor for this clause: a registry whose entries all lost their
    // serving site would make the loop body unreachable and the clause silent.
    expect(sites.length).toBeGreaterThanOrEqual(12);

    for (const { path, site } of sites) {
      const source = backendSource(site.module);
      const exported = new RegExp(
        `export\\s+(?:async\\s+)?(?:function|const|class)\\s+${site.symbol}\\b`,
        'u',
      );
      expect(
        exported.test(source),
        `${path}: ${site.module} must export \`${site.symbol}\` — a rename must break this gate`,
      ).toBe(true);
    }
  });

  it('every serving module is imported by a PRODUCTION caller, not only by tests', () => {
    // #367's own finding, and four issues were filed on the day this landed for
    // exactly this shape: a capability exists, its test passes by driving it
    // directly, and nothing in production reaches it. A serving site no route
    // can reach serves nobody.
    const production = walkPackagesDirectory('backend/src').filter(
      (path) => !path.includes('/__tests__/') && !/\.test\.tsx?$/u.test(path),
    );
    expect(production.length).toBeGreaterThanOrEqual(1500);

    const sources = production.map((path) => ({
      path,
      text: readFileSync(join(PACKAGES_ROOT, path), 'utf8'),
    }));

    for (const entry of V1_WIRE_CONTRACTS) {
      if (!entry.servedBy) continue;
      const basename = entry.servedBy.module.split('/').pop() ?? '';
      const specifier = basename.replace(/\.ts$/u, '.js');
      // Anchored on a path separator or the opening quote, so
      // `canonical-search.service.js` cannot satisfy `search.service.js`.
      const imported = new RegExp(`['"][^'"]*['"/]${specifier.replace(/\./gu, '\\.')}['"]`, 'u');
      const importers = sources.filter(
        (module) => module.path !== `backend/src/${entry.servedBy?.module}` && imported.test(module.text),
      );
      expect(
        importers.length,
        `${entry.path}: nothing in production imports ${entry.servedBy.module}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('every proof names a test title that really exists in the file it names', () => {
    const proofs = V1_WIRE_CONTRACTS.flatMap((entry) =>
      entry.provenBy ? [{ path: entry.path, proof: entry.provenBy }] : [],
    );
    // Moves with `V1_CONTRACTS_WITHOUT_PROOF` — stated as its complement over
    // the non-successor entries so the two numbers cannot drift apart.
    const contracts = V1_WIRE_CONTRACTS.filter((entry) => entry.direction !== 'successor');
    expect(proofs.length).toBe(contracts.length - V1_CONTRACTS_WITHOUT_PROOF);

    for (const { path, proof } of proofs) {
      const source = backendSource(proof.file);
      expect(
        source.includes(proof.title),
        `${path}: ${proof.file} no longer contains the test titled "${proof.title}"`,
      ).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Mutation self-test — both directions                                        */
/* -------------------------------------------------------------------------- */

/**
 * The derivation is run over SYNTHETIC modules written to a temporary directory
 * and parsed by the REAL `deriveV1Members`.
 *
 * A self-test that asserted a regex against a string would measure the regex.
 * This measures the walk, the compiler pass, the docblock recovery and the owner
 * chain — every part of the instrument the census depends on.
 */
describe('v1 wire contracts — the derivation can fail', () => {
  const fixture = (contents: string): Derivation => {
    const dir = mkdtempSync(join(tmpdir(), 'v1-census-'));
    writeFileSync(join(dir, 'sample.ts'), contents, 'utf8');
    return deriveV1Members(dir, ['sample.ts']);
  };

  it('ADD direction: a newly documented v1 field is derived, so it would fail the exactness check', () => {
    const added = fixture(
      [
        'export interface Sample {',
        '  /** The v1 spelling of `successor`. */',
        '  legacyField: string;',
        '}',
        '',
      ].join('\n'),
    );

    expect(added.derived.map((member) => member.path)).toEqual(['Sample.legacyField']);
    // The consequence the census would draw, spelled out rather than assumed:
    // the derived path is not in the registry, so the exactness clause reports it.
    const registered = V1_WIRE_CONTRACTS.map((entry) => entry.path);
    expect(registered).not.toContain('Sample.legacyField');
  });

  it('REMOVE direction: the same field with the v1 sentence taken out derives NOTHING', () => {
    const removed = fixture(
      [
        'export interface Sample {',
        '  /** The spelling of `successor`. */',
        '  legacyField: string;',
        '}',
        '',
      ].join('\n'),
    );

    // The member is still SCANNED — this is the control that separates "the
    // sentence went away" from "the walk stopped working", which produce the
    // same empty `derived` and mean opposite things.
    expect(removed.members).toBe(1);
    expect(removed.derived).toEqual([]);
  });

  it('a sibling member does not inherit its neighbour\'s v1 docblock', () => {
    const both = fixture(
      [
        'export interface Sample {',
        '  /** The v1 spelling of `successor`. */',
        '  legacyField: string;',
        '  /** An ordinary field. */',
        '  ordinaryField: string;',
        '}',
        '',
      ].join('\n'),
    );

    expect(both.members).toBe(2);
    expect(both.derived.map((member) => member.path)).toEqual(['Sample.legacyField']);
  });

  it('CAN produce a duplicate path, which is what stops the distinctness clause being vacuous', () => {
    // An assertion whose subject cannot exist reads as coverage and is none.
    // Duplicates are producible here because TypeScript MERGES two declarations
    // of one interface, so a field documented on both sides of a merge derives
    // twice under one path — the case the distinctness clause licenses the
    // set-collapse against.
    const merged = fixture(
      [
        'export interface Sample {',
        '  /** The v1 spelling of `successor`. */',
        '  legacyField: string;',
        '}',
        'export interface Sample {',
        '  /** Also the v1 spelling, declared again. */',
        '  legacyField: string;',
        '}',
        '',
      ].join('\n'),
    );

    expect(merged.derived.map((member) => member.path)).toEqual([
      'Sample.legacyField',
      'Sample.legacyField',
    ]);
    // And the collapse the real clause guards against, demonstrated: the set
    // hides one of them completely.
    expect(new Set(merged.derived.map((member) => member.path)).size).toBe(1);
  });

  it('the boundary class does not swallow `v1` beside a digit or a letter', () => {
    // `v10` and `sv1` are not `v1`. Measured as a real hazard on this tree: a
    // boundary class without digits drops identifiers and returns a plausible
    // smaller count.
    const near = fixture(
      [
        'export interface Sample {',
        '  /** Uses the v10 protocol. */',
        '  tenth: string;',
        '  /** The sv1 encoding. */',
        '  encoded: string;',
        '}',
        '',
      ].join('\n'),
    );

    expect(near.members).toBe(2);
    expect(near.derived).toEqual([]);
  });
});
