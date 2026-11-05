/**
 * `publish-merchant-plans.yml` holds the production deploy role and starts a
 * task with Mercaria's Peable workload authority and the production database
 * (#89). Its safety is a set of properties of the FILE — no runner executes a
 * workflow in CI — so this reads the real workflow and `build.ts`:
 * dispatch-only from protected `main`, the LIVE task definition, a command from
 * a closed input with no input interpolated into a shell, preview by default,
 * the merchant pinned, and the script an image entry point.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

interface Step {
  name?: string;
  id?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Workflow {
  on: Record<
    string,
    { inputs?: Record<string, { type?: string; default?: string; options?: string[] }> } | null
  >;
  env?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, { if?: string; steps: Step[] }>;
}

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const BACKEND_ROOT = join(REPO_ROOT, 'packages', 'backend');
const raw = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'publish-merchant-plans.yml'),
  'utf8',
);
const workflow = parse(raw) as Workflow;
const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
/** A GitHub Actions `${{ … }}` expression, spelled without a template-looking literal. */
const expression = (body: string) => ['$', '{{ ', body, ' }}'].join('');

describe('publish-merchant-plans.yml', () => {
  it('is dispatch-only and runs only from protected main', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const jobs = Object.values(workflow.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.if).toBe("github.ref == 'refs/heads/main'");
  });

  it('runs the live task definition and never registers or builds one', () => {
    expect(steps.find((step) => step.id === 'ecs')?.run).toContain('aws ecs describe-services');
    expect(raw).not.toContain('register-task-definition');
    expect(raw).not.toMatch(/docker (build|buildx|push)/);
    const runner = steps.find((step) => step.run?.includes('run-ecs-task.sh'));
    expect(runner?.env?.TASK_DEFINITION).toBe(expression('steps.ecs.outputs.task_definition'));
    expect(runner?.env?.COMMAND_JSON).toBe(expression('steps.command.outputs.json'));
  });

  it('interpolates no input into a shell', () => {
    expect(steps.filter((step) => step.run).length).toBeGreaterThanOrEqual(3);
    for (const step of steps) {
      expect(step.run ?? '', `${step.name}: read inputs through env:`).not.toMatch(
        /\$\{\{\s*(github\.event\.)?inputs\./,
      );
    }
  });

  it('defaults to preview, has no other input, and pins Mercaria’s merchant', () => {
    expect(Object.keys(inputs)).toEqual(['mode']);
    expect(inputs.mode?.default).toBe('preview');
    expect(inputs.mode?.options).toEqual(['preview', 'apply']);
    expect(workflow.env?.PEABLE_MERCHANT).toMatch(/^merch_[a-z0-9]+$/);
  });

  it('runs a script the image actually carries', () => {
    expect(readFileSync(join(BACKEND_ROOT, 'build.ts'), 'utf8')).toContain(
      "'src/scripts/publish-merchant-plans.ts'",
    );
    expect(existsSync(join(BACKEND_ROOT, 'src', 'scripts', 'publish-merchant-plans.ts'))).toBe(
      true,
    );
    expect(raw).toContain('packages/backend/dist/scripts/publish-merchant-plans.js');
  });

  it('queues runs rather than cancelling one mid-write', () => {
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(false);
  });
});
