/**
 * The provider-neutral SUMMARY adapter (#97 evaluation 5, acceptance 4 and 7).
 *
 * ONE function, taking a {@link ShoppingAgentSummaryPackage} built from a
 * finding that is ALREADY STORED, and returning a strict structured value —
 * never prose. A free-text completion would have to be parsed before it could
 * be checked, and every parse is a place a citation goes missing.
 *
 * ## "A model may only summarise a COMPLETED deterministic finding" is the
 * ## SIGNATURE, not a rule
 *
 * `summarizeStoredFinding` takes a finding ID and reads the row. There is no
 * entry point that takes a draft finding, a plan, an offer or a constraint set,
 * so the sequence #97 evaluation 5 asks for is a property of the call graph:
 * a provider cannot be consulted before a verdict exists, because the only
 * thing that can be handed to one is a row in a table whose `outcome` column is
 * immutable by trigger.
 *
 * And it cannot influence the verdict afterwards either. The package carries no
 * writer, the outcome type carries no verdict field, and
 * `shopping-agent-isolation.test.ts` fails the build if `deterministic.ts`
 * imports this module.
 *
 * ## The default REFUSES, and the deterministic template still renders
 *
 * `unavailableShoppingAgentSummaryProvider` answers `unavailable` for every
 * request. That is not a stub that lies and not a throw: the summary service
 * treats a refusal exactly as it treats a rejected draft, falls back to the
 * rule-based template, and returns a summary either way — which is #97
 * acceptance 7 ("model outage leaves deterministic evaluation and templated
 * notifications functional") held by the call graph rather than by a
 * `try`/`catch` somebody remembered. #96's `adapter.port.ts` made this choice
 * and the reasoning is quoted rather than rediscovered.
 *
 * Nothing registers one today, no API key lives here and no provider dependency
 * is installed. Closing the seam is one module implementing
 * {@link ShoppingAgentSummaryProvider} plus one
 * {@link registerShoppingAgentSummaryProvider} call — and `summary.ts`'s
 * validator is what makes it safe to do so.
 */

import type {
  ShoppingAgentEvidenceCompleteness,
  ShoppingAgentFindingOutcome,
  ShoppingAgentFreshness,
  ShoppingAgentJobKind,
  ShoppingAgentRecordRef,
  ShoppingAgentSummaryDraft,
} from '@mercaria/shared-types';

/**
 * Everything a provider is shown about a stored finding.
 *
 * The ABSENT fields are the enforcement, `analytics_events`' device: there is
 * no owner id, no agent NAME, no agent DESCRIPTION, no note, no location, no
 * merchant contact and no raw query anywhere in it — #97 privacy 5 names four
 * of those explicitly, and the way they would actually arrive is somebody
 * spreading a row into the package rather than naming its fields.
 *
 * `validRefs` is the citation whitelist: a sentence may cite these handles and
 * no others, and they are opaque per-finding refs rather than Mercaria ids.
 */
export interface ShoppingAgentSummaryPackage {
  readonly findingId: string;
  readonly kind: ShoppingAgentJobKind;
  readonly outcome: ShoppingAgentFindingOutcome;
  readonly completeness: ShoppingAgentEvidenceCompleteness;
  readonly freshness: ShoppingAgentFreshness;
  /** Rendered money, already formatted — never a raw amount to re-round. */
  readonly objectiveRendered?: string;
  readonly objectiveDeltaRendered?: string;
  readonly lineCount: number;
  readonly satisfiedConstraintCount: number;
  readonly failedConstraintCount: number;
  readonly unknownConstraintCount: number;
  readonly records: readonly ShoppingAgentRecordRef[];
  readonly validRefs: readonly string[];
  /** Every number a sentence may contain, as it appears in the finding. */
  readonly numericTokens: readonly string[];
}

/** What a provider answers. A STRING discriminant; see `AGENTS.md` on `strict: false`. */
export type ShoppingAgentSummaryOutcome =
  | { readonly outcome: 'drafted'; readonly draft: ShoppingAgentSummaryDraft }
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'failed'; readonly detail: string };

/**
 * One summary provider.
 *
 * `id` and `promptVersion` are recorded on every generated summary (#97
 * finding 10), so a sentence a shopper read can be attributed to the exact
 * prompt and provider that produced it. They are the PROVIDER's to declare — a
 * deployment variable holding a prompt version could only ever disagree with
 * the prompt actually sent, which is the `CROWDSOURCE_APP_ID` mistake.
 */
export interface ShoppingAgentSummaryProvider {
  readonly id: string;
  readonly promptVersion: string;
  /**
   * Summarize the package.
   *
   * @param deadlineMs A wall-clock budget. A provider that cannot answer inside
   *   it must return `unavailable` rather than resolving late: the template is
   *   already composed and a notification is already owed.
   */
  draft(
    pkg: ShoppingAgentSummaryPackage,
    deadlineMs: number,
  ): Promise<ShoppingAgentSummaryOutcome>;
}

/** The default: no provider, honestly. See the module header. */
export const unavailableShoppingAgentSummaryProvider: ShoppingAgentSummaryProvider = {
  id: 'unconfigured',
  promptVersion: '',
  async draft(): Promise<ShoppingAgentSummaryOutcome> {
    return { outcome: 'unavailable' };
  },
};

let registeredProvider: ShoppingAgentSummaryProvider = unavailableShoppingAgentSummaryProvider;

/** Register the real implementation. A deployment's wiring calls this once, at boot. */
export function registerShoppingAgentSummaryProvider(
  provider: ShoppingAgentSummaryProvider,
): void {
  registeredProvider = provider;
}

/** The provider in force. Returns the refusing default until one is registered. */
export function shoppingAgentSummaryProvider(): ShoppingAgentSummaryProvider {
  return registeredProvider;
}

/** Whether a real provider is wired. Read so a surface can say so honestly. */
export function shoppingAgentSummaryProviderAvailable(): boolean {
  return registeredProvider !== unavailableShoppingAgentSummaryProvider;
}

/** Restore the default. Test-only seam; production never un-registers a provider. */
export function resetShoppingAgentSummaryProvider(): void {
  registeredProvider = unavailableShoppingAgentSummaryProvider;
}
