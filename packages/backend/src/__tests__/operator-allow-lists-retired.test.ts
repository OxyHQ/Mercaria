/**
 * The seven `*_OPERATOR_OXY_USER_IDS` allow-lists are retired, and this keeps
 * them retired.
 *
 * Who operates a Mercaria desk is an Oxy APPLICATION ROLE
 * (`middleware/operator-authz.ts`, `~/Oxy/docs/application-roles.md`): Mercaria
 * declares the keys, the owning account's admins grant them to people, and the
 * gate asks Oxy. An env list of user ids beside that would be a second answer to
 * who may operate — changed by whoever can deploy, with no grant audit — which
 * is exactly what the roles replaced.
 *
 * So nothing may READ such a variable: no non-test source file, no environment
 * template, no workflow. The one sanctioned mention is the release step's jq
 * filter in `deploy-aws.yml`, which STRIPS the retired names from a task
 * definition revision that still carries them.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRC_ROOT } from './domain-population.js';

const BACKEND_ROOT = join(SRC_ROOT, '..');
const REPO_ROOT = join(BACKEND_ROOT, '..', '..');

/** A read of an operator allow-list variable, however it is spelled. */
const READS_OPERATOR_LIST =
  /(?:process\.env|strEnv|listEnv|boolEnv|intEnv|env)\s*(?:\.|\[|\()\s*['"`]?[A-Z_]*_OPERATOR_OXY_USER_IDS/u;
/** Any mention at all — the bar for a template or a workflow. */
const NAMES_OPERATOR_LIST = /[A-Z_]*_OPERATOR_OXY_USER_IDS/u;
/** The release filter that removes the retired names from a revision. */
const STRIP_FILTER = /\(\.name \| endswith\("_OPERATOR_OXY_USER_IDS"\) \| not\)/gu;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      files.push(...sourceFiles(path));
    } else if (/\.ts$/u.test(entry) && !/\.test\.ts$/u.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

describe('the operator allow-lists stay retired', () => {
  const files = sourceFiles(SRC_ROOT);

  it('scans the whole source tree — a walk that collapsed cannot pass', () => {
    expect(files.length).toBeGreaterThanOrEqual(1_000);
    expect(files.map((file) => relative(SRC_ROOT, file))).toContain('config/index.ts');
    expect(files.map((file) => relative(SRC_ROOT, file))).toContain('middleware/operator-authz.ts');
  });

  it('no source file reads a *_OPERATOR_OXY_USER_IDS variable', () => {
    const readers = files
      .filter((file) => READS_OPERATOR_LIST.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_ROOT, file));
    expect(readers).toEqual([]);
  });

  it('config/index.ts does not so much as name one', () => {
    expect(readFileSync(join(SRC_ROOT, 'config/index.ts'), 'utf8')).not.toMatch(
      NAMES_OPERATOR_LIST,
    );
  });

  it('no environment template offers one', () => {
    const templates = readdirSync(BACKEND_ROOT).filter((entry) =>
      /^\.env.*\.example$/u.test(entry),
    );
    expect(templates).toContain('.env.example');
    for (const template of templates) {
      expect(readFileSync(join(BACKEND_ROOT, template), 'utf8'), template).not.toMatch(
        NAMES_OPERATOR_LIST,
      );
    }
  });

  it('no workflow sets one; the release only strips them', () => {
    const workflows = join(REPO_ROOT, '.github', 'workflows');
    const names = readdirSync(workflows).filter((entry) => /\.ya?ml$/u.test(entry));
    expect(names).toContain('deploy-aws.yml');
    for (const name of names) {
      const text = readFileSync(join(workflows, name), 'utf8');
      // Comments and the strip filter are the only sanctioned mentions.
      const residue = text
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n')
        .replace(STRIP_FILTER, '');
      expect(residue, name).not.toMatch(NAMES_OPERATOR_LIST);
    }
  });

  it('the detectors detect (mutation self-test)', () => {
    for (const planted of [
      "strEnv('CATALOG_OPERATOR_OXY_USER_IDS', '')",
      'process.env.PAYMENT_OPERATOR_OXY_USER_IDS',
      "process.env['REFERRAL_OPERATOR_OXY_USER_IDS']",
    ]) {
      expect(planted).toMatch(READS_OPERATOR_LIST);
    }
    expect('# PAYMENT_OPERATOR_OXY_USER_IDS=').toMatch(NAMES_OPERATOR_LIST);
    expect('(.name | endswith("_OPERATOR_OXY_USER_IDS") | not)'.replace(STRIP_FILTER, '')).toBe('');
    expect('"GUEST_OPERATOR_OXY_USER_IDS": "a,b"'.replace(STRIP_FILTER, '')).toMatch(
      NAMES_OPERATOR_LIST,
    );
  });
});
