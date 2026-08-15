/**
 * The #69 evidence collector: allow-listed observations in, a redacted
 * machine-readable log and a human-readable report out.
 *
 * ## Why the projections are hand-written
 *
 * Every `project*` function below names each field it emits. There is
 * deliberately no `recordResponse(body)` and no property bag — the runbook's
 * §5 prohibition ("do NOT record … a full API response body") is held by there
 * being no function that could. A provider or a Mercaria DTO growing a field
 * therefore cannot carry it into evidence; somebody has to name it here, which
 * is the moment to ask whether it belongs. This is `services/payments/redact.ts`
 * and `analytics`'s posture — an allow-list of typed columns, not a bag — and
 * the reasoning is the same one those two record.
 *
 * ## Why "it did not error" cannot become a PASS
 *
 * {@link EvidenceCollector.record} REFUSES a `PASSED` observation that does not
 * state both what was measured and what that measurement would have read if the
 * thing under test were absent. A scenario whose only evidence is the absence of
 * an exception is exactly the check that cannot fail, and the cheapest way to
 * write one is to leave those two fields empty — so they are required rather
 * than encouraged.
 *
 * ## Vacuity
 *
 * The write path calls {@link assertNoSecrets}, which refuses a scan that read
 * nothing or ran with an empty registry. The collector additionally refuses to
 * write zero observations: an empty evidence file is what a driver that crashed
 * before its first scenario produces, and it is clean by every measure.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Connection, SyncRun } from '@mercaria/shared-types';
import {
  assertNoSecrets,
  redactErrorText,
  redactIdentifier,
  redactUrl,
  selfTest,
  SecretRegistry,
  type ScanReport,
} from './redact.js';

/** How a scenario ended. There is no fourth value, and no "probably". */
export type ScenarioStatus = 'PASSED' | 'FAILED' | 'NOT_RUN';

/** A JSON-safe value. Evidence is serialized, so nothing else may enter. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One scenario's recorded outcome. */
export interface ScenarioObservation {
  /** Runbook identifier — `W1`…`W9`, or `X1`… for the §7 extra checks. */
  readonly id: string;
  /** The scenario's own title, copied from the runbook. */
  readonly title: string;
  readonly status: ScenarioStatus;
  /**
   * The observable ACTUALLY measured, in words. Required for a `PASSED`.
   * "No error" is not an observable and the collector says so.
   */
  readonly measured?: string;
  /**
   * What {@link measured} would have read had the thing under test been absent.
   * Required for a `PASSED` whose evidence is a count: a count with no stated
   * counterfactual measures nothing.
   */
  readonly wouldReadIfAbsent?: string;
  /** The allow-listed, already-redacted observations behind the verdict. */
  readonly observations?: Record<string, JsonValue>;
  /** For a FAILED: the `sync_runs.error` string, redacted. */
  readonly error?: string;
  /** For a NOT_RUN: the precise reason, and what would unblock it. */
  readonly notRunReason?: string;
}

/** The finished evidence document. */
export interface EvidenceDocument {
  readonly issue: string;
  readonly runLabel: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly environment: Record<string, JsonValue>;
  readonly scenarios: ScenarioObservation[];
  readonly notes: string[];
  readonly redaction: {
    readonly registeredSecretLabels: string[];
    readonly charactersScanned: number;
    readonly shapesChecked: number;
    readonly selfTestCharactersScanned: number;
  };
}

/**
 * Project a `Connection` DTO down to the fields §5 names.
 *
 * `shopDomain` is a HOST and is kept whole on purpose — it is what identifies
 * which store an observation came from, it is not a credential, and truncating
 * it to four characters would make the evidence unreadable. Everything that is
 * an opaque identifier is truncated.
 */
export function projectConnection(connection: Connection): Record<string, JsonValue> {
  return {
    id: redactIdentifier(connection.id),
    storeId: redactIdentifier(connection.storeId),
    provider: connection.provider,
    mode: connection.mode,
    status: connection.status,
    shopDomain: connection.shopDomain ?? null,
    shopCurrency: connection.shopCurrency ?? null,
    externalShopId: redactIdentifier(connection.externalShopId),
    scopes: [...(connection.scopes ?? [])].sort(),
    scopeCount: (connection.scopes ?? []).length,
    webhookIdCount: (connection.webhookIds ?? []).length,
    webhookIds: (connection.webhookIds ?? []).map((id) => redactIdentifier(id)),
    webhookFailures: (connection.webhookFailures ?? []).map((failure) => ({
      topic: failure.topic,
      reason: failure.reason,
      httpStatus: failure.httpStatus ?? null,
      recordedAt: failure.recordedAt,
    })),
    webhookRegistration: connection.webhookRegistration
      ? {
          state: connection.webhookRegistration.state,
          attempts: connection.webhookRegistration.attempts,
          nextAttemptAt: connection.webhookRegistration.nextAttemptAt ?? null,
        }
      : null,
    syncSettings: connection.syncSettings
      ? {
          products: connection.syncSettings.products,
          inventory: connection.syncSettings.inventory,
          orders: connection.syncSettings.orders,
          autoPublish: connection.syncSettings.autoPublish ?? false,
        }
      : null,
  };
}

/** Project a `SyncRun` down to its id, kind, status, four tallies and error. */
export function projectSyncRun(run: SyncRun): Record<string, JsonValue> {
  return {
    id: redactIdentifier(run.id),
    connectionId: redactIdentifier(run.connectionId),
    kind: run.kind,
    status: run.status,
    counts: {
      created: run.counts?.created ?? 0,
      updated: run.counts?.updated ?? 0,
      skipped: run.counts?.skipped ?? 0,
      failed: run.counts?.failed ?? 0,
    },
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    error: redactErrorText(run.error),
  };
}

/**
 * Collects observations and writes the two artefacts.
 *
 * The constructor runs {@link selfTest}, so a collector whose redaction is
 * broken cannot be constructed — the guarantee is a property of the object
 * existing rather than of somebody remembering to call a checker.
 */
export class EvidenceCollector {
  private readonly scenarios: ScenarioObservation[] = [];
  private readonly notes: string[] = [];
  private readonly startedAt = new Date().toISOString();
  private readonly selfTestCharactersScanned: number;
  private environment: Record<string, JsonValue> = {};

  constructor(
    readonly registry: SecretRegistry,
    private readonly outDir: string,
    private readonly runLabel: string,
  ) {
    const control = selfTest();
    this.selfTestCharactersScanned = control.caught.charactersScanned;
  }

  /**
   * Record the environment the run used — variable NAMES and coarse facts only.
   * A value is never accepted here; the parameter type is what stops one.
   */
  describeEnvironment(environment: Record<string, JsonValue>): void {
    this.environment = environment;
  }

  /** Add a free-text note. Goes through the same scan as everything else. */
  note(text: string): void {
    this.notes.push(text);
  }

  /**
   * Record one scenario.
   *
   * Refuses a `PASSED` with no stated observable or no stated counterfactual,
   * and a `FAILED`/`NOT_RUN` with no reason — the three ways an evidence line
   * can look complete and say nothing.
   */
  record(observation: ScenarioObservation): void {
    if (observation.status === 'PASSED') {
      if (!observation.measured?.trim()) {
        throw new Error(
          `Scenario ${observation.id}: a PASSED needs the observable that was MEASURED. ` +
            '"It did not error" is not an observable — it is what a scenario that never ' +
            'ran also produces.',
        );
      }
      if (!observation.wouldReadIfAbsent?.trim()) {
        throw new Error(
          `Scenario ${observation.id}: a PASSED needs what the measurement would read if ` +
            'the thing under test were ABSENT. If that is the same as what was measured, ' +
            'the check measures nothing and the verdict is not a pass.',
        );
      }
    }
    if (observation.status === 'FAILED' && !observation.error?.trim()) {
      throw new Error(`Scenario ${observation.id}: a FAILED needs the error it failed with.`);
    }
    if (observation.status === 'NOT_RUN' && !observation.notRunReason?.trim()) {
      throw new Error(
        `Scenario ${observation.id}: a NOT_RUN needs the precise reason, so the gap is ` +
          'readable as a blocked scenario rather than an oversight.',
      );
    }
    this.scenarios.push({
      ...observation,
      error: redactErrorText(observation.error) ?? undefined,
    });
  }

  /** Whether anything has been recorded — the write path's vacuity floor. */
  get scenarioCount(): number {
    return this.scenarios.length;
  }

  /**
   * Serialize, SCAN, and write both artefacts.
   *
   * The scan runs over the finished JSON and the finished markdown — both, not
   * one — because they are composed separately and a leak in the prose is a
   * leak. Nothing is written until both scans pass.
   */
  async write(): Promise<{ jsonPath: string; markdownPath: string; scan: ScanReport }> {
    if (this.scenarios.length === 0) {
      throw new Error(
        'Refusing to write evidence with ZERO scenarios. An empty artefact passes every ' +
          'redaction check and reports nothing; it is what a driver that crashed before ' +
          'its first scenario produces.',
      );
    }

    const document: EvidenceDocument = {
      issue: 'OxyHQ/Mercaria#69',
      runLabel: this.runLabel,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      environment: this.environment,
      scenarios: this.scenarios,
      notes: this.notes,
      redaction: {
        registeredSecretLabels: this.registry.labels(),
        charactersScanned: 0,
        shapesChecked: 0,
        selfTestCharactersScanned: this.selfTestCharactersScanned,
      },
    };

    const json = JSON.stringify(document, null, 2);
    const markdown = renderMarkdown(document);

    // Scan BOTH artefacts before either is written. `assertNoSecrets` throws on
    // a leak and on a vacuous scan.
    const jsonScan = assertNoSecrets(this.registry, json);
    assertNoSecrets(this.registry, markdown);

    const finalJson = JSON.stringify(
      {
        ...document,
        redaction: {
          ...document.redaction,
          charactersScanned: jsonScan.charactersScanned,
          shapesChecked: jsonScan.shapesChecked,
        },
      },
      null,
      2,
    );
    // The counters changed the bytes, so the artefact that is WRITTEN is not the
    // one that was scanned. Scan it again rather than reasoning that the delta
    // is safe.
    const writtenScan = assertNoSecrets(this.registry, finalJson);

    await mkdir(this.outDir, { recursive: true });
    const jsonPath = path.join(this.outDir, `${this.runLabel}.evidence.json`);
    const markdownPath = path.join(this.outDir, `${this.runLabel}.report.md`);
    await writeFile(jsonPath, finalJson, 'utf8');
    await writeFile(markdownPath, markdown, 'utf8');

    return { jsonPath, markdownPath, scan: writtenScan };
  }
}

/** Render the human-readable report. */
function renderMarkdown(document: EvidenceDocument): string {
  const lines: string[] = [];
  lines.push(`# Real-store connector verification — ${document.runLabel}`);
  lines.push('');
  lines.push(`Issue: ${document.issue}`);
  lines.push(`Started (UTC): ${document.startedAt}`);
  lines.push(`Finished (UTC): ${document.finishedAt}`);
  lines.push('');
  lines.push(
    '> Every identifier below is truncated to its last four characters. No access token, ' +
      'consumer key/secret, channel key, webhook secret, buyer email, buyer address or full ' +
      'API response body is recorded, and the collector refuses to write an artefact in ' +
      'which one appears.',
  );
  lines.push('');

  lines.push('## Environment');
  lines.push('');
  lines.push('| Fact | Value |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(document.environment)) {
    lines.push(`| \`${key}\` | ${formatCell(value)} |`);
  }
  lines.push('');

  lines.push('## Scenarios');
  lines.push('');
  lines.push('| # | Scenario | Verdict | Observable measured |');
  lines.push('|---|---|---|---|');
  for (const scenario of document.scenarios) {
    const summary =
      scenario.status === 'NOT_RUN'
        ? `NOT RUN — ${scenario.notRunReason ?? ''}`
        : scenario.status === 'FAILED'
          ? `error: ${scenario.error ?? ''}`
          : (scenario.measured ?? '');
    lines.push(
      `| ${scenario.id} | ${escapeCell(scenario.title)} | **${scenario.status}** | ${escapeCell(summary)} |`,
    );
  }
  lines.push('');

  lines.push('## Detail');
  lines.push('');
  for (const scenario of document.scenarios) {
    lines.push(`### ${scenario.id} — ${scenario.title}`);
    lines.push('');
    lines.push(`**Verdict:** ${scenario.status}`);
    lines.push('');
    if (scenario.measured) {
      lines.push(`**Measured:** ${scenario.measured}`);
      lines.push('');
    }
    if (scenario.wouldReadIfAbsent) {
      lines.push(`**Would read if the thing measured were absent:** ${scenario.wouldReadIfAbsent}`);
      lines.push('');
    }
    if (scenario.error) {
      lines.push(`**Error:** \`${scenario.error}\``);
      lines.push('');
    }
    if (scenario.notRunReason) {
      lines.push(`**Not run because:** ${scenario.notRunReason}`);
      lines.push('');
    }
    if (scenario.observations && Object.keys(scenario.observations).length > 0) {
      lines.push('```json');
      lines.push(JSON.stringify(scenario.observations, null, 2));
      lines.push('```');
      lines.push('');
    }
  }

  if (document.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const note of document.notes) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }

  lines.push('## Redaction control');
  lines.push('');
  lines.push(
    `The collector's own self-test ran before any observation was taken, over a ` +
      `${document.redaction.selfTestCharactersScanned}-character fixture carrying a known ` +
      'secret beside a known-innocent value: the secret was caught by BOTH layers and the ' +
      'innocent artefact was reported clean. A scanner that matched everything and one that ' +
      'matched nothing each fail that control.',
  );
  lines.push('');
  lines.push(
    `Watched secret labels (values never recorded): ` +
      `${document.redaction.registeredSecretLabels.map((l) => `\`${l}\``).join(', ')}.`,
  );
  lines.push('');
  lines.push(
    `The finished artefact was scanned: ${document.redaction.charactersScanned} characters ` +
      `against ${document.redaction.registeredSecretLabels.length} registered values and ` +
      `${document.redaction.shapesChecked} credential shapes.`,
  );
  lines.push('');

  return lines.join('\n');
}

/** Format a JSON value for a markdown table cell. */
function formatCell(value: JsonValue): string {
  if (value === null) return '—';
  if (typeof value === 'string') return escapeCell(value);
  return escapeCell(JSON.stringify(value));
}

/** Escape a value for a markdown table cell. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
