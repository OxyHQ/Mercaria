/**
 * `run-media-backfill.yml` holds the production deploy role and starts a task
 * with Mercaria's Oxy authority, so its safety is a set of properties of the
 * FILE — and no runner executes a workflow in CI. This reads the real workflow,
 * `build.ts` and the scripts, and fails when they stop agreeing:
 *
 * - dispatch-only, and only from protected `main`;
 * - the task runs the LIVE task definition — nothing registered, nothing built;
 * - the command is built from closed inputs, and no input is interpolated into
 *   a shell (`${{ inputs.* }}` inside `run:` is an injection point);
 * - preview is the default;
 * - every script option is an image entry point, and every target option is
 *   one the script accepts — an option the image cannot run is a red run in
 *   production, the worst place to learn it.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { APPLICATION_MEDIA_TARGETS } from '../../services/catalog-media/application-media-backfill.js';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Input {
  type?: string;
  default?: string | number;
  options?: string[];
}
interface Workflow {
  on: Record<string, { inputs?: Record<string, Input> } | null>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, { if?: string; steps: Step[] }>;
}

/** The repo root, from this file: `packages/backend/src/db/__tests__`. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const BACKEND_ROOT = join(REPO_ROOT, 'packages', 'backend');
const raw = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'run-media-backfill.yml'), 'utf8');
const workflow = parse(raw) as Workflow;
const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const buildTs = readFileSync(join(BACKEND_ROOT, 'build.ts'), 'utf8');

describe('run-media-backfill.yml', () => {
  it('is dispatch-only and runs only from protected main', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const jobs = Object.values(workflow.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.if).toBe("github.ref == 'refs/heads/main'");
  });

  it('runs the live task definition and never registers or builds one', () => {
    const resolve = steps.find((step) => step.id === 'ecs');
    expect(resolve?.run).toContain('aws ecs describe-services');
    expect(resolve?.run).toContain('.taskDefinition\' <<<"$service"');
    expect(raw).not.toContain('register-task-definition');
    expect(raw).not.toMatch(/docker (build|buildx|push)/);
    const runner = steps.find((step) => step.run?.includes('run-ecs-task.sh'));
    expect(runner?.env?.TASK_DEFINITION).toBe('${{ steps.ecs.outputs.task_definition }}');
    expect(runner?.env?.COMMAND_JSON).toBe('${{ steps.command.outputs.json }}');
    expect(runner?.env?.PRINT_TASK_LOG).toBe('true');
  });

  it('interpolates no input into a shell', () => {
    // Vacuity floor: the steps that matter are present and carry scripts.
    expect(steps.filter((step) => step.run).length).toBeGreaterThanOrEqual(3);
    for (const step of steps) {
      expect(step.run ?? '', `${step.name}: read inputs through env:`).not.toMatch(
        /\$\{\{\s*(github\.event\.)?inputs\./,
      );
    }
  });

  it('defaults to preview, and apply is the only other mode', () => {
    expect(inputs.mode?.type).toBe('choice');
    expect(inputs.mode?.default).toBe('preview');
    expect(inputs.mode?.options).toEqual(['preview', 'apply']);
  });

  it('closes every input that reaches the command', () => {
    for (const name of ['script', 'mode', 'target']) expect(inputs[name]?.type).toBe('choice');
    expect(inputs.limit?.type).toBe('number');
    expect(Object.keys(inputs).sort()).toEqual(['after', 'limit', 'mode', 'script', 'target']);
  });

  it('offers exactly the backfills the image carries', () => {
    const scripts = inputs.script?.options ?? [];
    expect(scripts.length).toBeGreaterThanOrEqual(4);
    for (const script of scripts) {
      const source = `src/scripts/backfill-${script}.ts`;
      expect(existsSync(join(BACKEND_ROOT, source)), source).toBe(true);
      expect(buildTs, `${source} must be a build.ts entry point`).toContain(`'${source}'`);
    }
  });

  it('offers exactly the application-media targets the script accepts', () => {
    const script = readFileSync(
      join(BACKEND_ROOT, 'src', 'scripts', 'backfill-application-media.ts'),
      'utf8',
    );
    const extra = /const EXTRA_TARGETS = \[([^\]]*)\] as const/.exec(script)?.[1] ?? '';
    const extraTargets = [...extra.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(extraTargets.length).toBeGreaterThan(0);
    expect([...(inputs.target?.options ?? [])].sort()).toEqual(
      [...APPLICATION_MEDIA_TARGETS, ...extraTargets].sort(),
    );
  });

  it('queues runs of one script rather than cancelling them', () => {
    expect(workflow.concurrency?.group).toContain('${{ inputs.script }}');
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(false);
  });
});
