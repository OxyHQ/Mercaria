/**
 * The provider-neutral explanation adapter (#96 explanation rule 1).
 *
 * ONE function, taking a {@link ExplanationPackage} and returning an
 * {@link ExplanationDraft} — a strict structured value, never prose. A free-text
 * completion would have to be parsed before it could be checked, and every
 * parse is a place a citation goes missing.
 *
 * ## The default REFUSES, and the deterministic table still renders
 *
 * `unavailableExplanationProvider` answers `provider_unavailable` for every
 * request. That is not a stub that lies and not a throw: the comparison service
 * treats a refusal exactly as it treats a rejected draft, falls back to the
 * rule-based templates, and returns the deterministic table either way — which
 * is acceptance 7 ("the deterministic comparison and solver still work when
 * model services are unavailable") held by the call graph rather than by a
 * `try`/`catch` somebody remembered.
 *
 * A `console.log` provider or a fixture that returns plausible sentences would
 * look like a working feature in every test and produce nothing in production;
 * a real client against unconfigured credentials would look like one in
 * production and fail like an outage. #108's transport registry made exactly
 * this choice and stated it, and this is the same shape one domain over.
 *
 * ## Why a registry rather than a parameter
 *
 * The same argument #94's `offer-facts.port.ts` makes: an optional argument
 * that defaults to "no provider" is one a caller can forget in exactly the
 * situation where forgetting means a comparison quietly renders without the
 * narrative a deployment paid for. One registration at boot, one place to look.
 *
 * Nothing registers one today. Closing this seam is one module implementing
 * {@link ExplanationProvider} plus one `registerExplanationProvider` call —
 * and the validator in `validation.ts` is what makes it safe to do so.
 */

import type { ExplanationDraft, ExplanationPackage } from '@mercaria/shared-types';

/** What a provider answers. A STRING discriminant; see `AGENTS.md` on `strict: false`. */
export type ExplanationProviderOutcome =
  | { readonly outcome: 'drafted'; readonly draft: ExplanationDraft }
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'failed'; readonly detail: string };

/**
 * One explanation provider.
 *
 * `id` and `promptVersion` are recorded on every explanation (explanation
 * rule 9), so a paragraph a shopper read can be attributed to the exact prompt
 * and the exact provider that produced it. They are the PROVIDER's to declare —
 * a deployment variable holding a prompt version could only ever disagree with
 * the prompt actually sent, which is the `CROWDSOURCE_APP_ID` mistake.
 */
export interface ExplanationProvider {
  readonly id: string;
  readonly promptVersion: string;
  /**
   * Summarize the package.
   *
   * @param deadlineMs A wall-clock budget. A provider that cannot answer inside
   *   it must return `unavailable` rather than resolving late: a comparison is a
   *   page load, and the deterministic table is already composed.
   */
  draft(pkg: ExplanationPackage, deadlineMs: number): Promise<ExplanationProviderOutcome>;
}

/** The default: no provider, honestly. See the module header. */
export const unavailableExplanationProvider: ExplanationProvider = {
  id: 'unconfigured',
  promptVersion: '',
  async draft(): Promise<ExplanationProviderOutcome> {
    return { outcome: 'unavailable' };
  },
};

let registeredProvider: ExplanationProvider = unavailableExplanationProvider;

/** Register the real implementation. A deployment's wiring calls this once, at boot. */
export function registerExplanationProvider(provider: ExplanationProvider): void {
  registeredProvider = provider;
}

/** The provider in force. Returns the refusing default until one is registered. */
export function explanationProvider(): ExplanationProvider {
  return registeredProvider;
}

/** Whether a real provider is wired. Read so a surface can say so honestly. */
export function explanationProviderAvailable(): boolean {
  return registeredProvider !== unavailableExplanationProvider;
}

/** Restore the default. Test-only seam; production never un-registers a provider. */
export function resetExplanationProvider(): void {
  registeredProvider = unavailableExplanationProvider;
}
