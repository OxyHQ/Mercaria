/**
 * The shopping-intent model port — a NAMED, FAIL-CLOSED seam (#95
 * model-boundary rules 1, 7 and 8).
 *
 * ## No provider is registered, and nothing in this repository registers one
 *
 * That is not an oversight and it is not a stub that lies. It is the same
 * honest refusal `services/guest-portal/transport.ts` makes for outbound mail,
 * `credential.port.ts` makes for supplier secrets and `selected-offer.port.ts`
 * makes for #74's offer selection: the contract is complete, the surface works
 * end to end, and the model half answers `provider_unconfigured` — visibly, in
 * the result's own `fallbackReason`, with a full deterministic interpretation
 * beside it.
 *
 * **The deterministic path is not what happens when this seam is closed badly;
 * it is the floor the whole surface stands on.** A deployment that never
 * registers a provider has a working natural-language search box: identifiers,
 * locale-aware money, magnitudes against #94's registry, condition, channel and
 * category all read deterministically. What a model adds is coverage of the
 * phrasings no rule anticipated — never a capability the fallback lacks.
 *
 * **What closing this seam costs:** one module implementing
 * {@link ShoppingIntentParser} and one call to
 * {@link registerShoppingIntentParser} at boot. Nothing else in #95 changes —
 * not the validation, not the constraint building, not the clarification state
 * machine, not the benchmark, not a single test. And critically: no API key
 * lives in this repository, no provider dependency is installed, and an
 * unconfigured deployment cannot answer as though a model had run, because the
 * mode it reports is derived from whether this registry produced a candidate.
 *
 * ## What a provider is HANDED, and what it can never see
 *
 * `ModelParseInput` (`@mercaria/shared-types`) has six fields plus a closed
 * vocabulary. There is no account id, no session id, no email, no address, no
 * coordinate, no payment detail, no saved list, no order history and no cart —
 * safety rule 6 held by the SIGNATURE. A provider cannot send what it is never
 * given, which is a stronger guarantee than a redaction pass somebody has to
 * keep correct as fields are added.
 *
 * The shopper's text arrives as DATA (safety rule 1). `sanitizeQueryForModel`
 * has already stripped control characters, markup and code fences from it, and
 * every provider's prompt contract is required to place it inside a delimited
 * block declared to be user content. The backend does not trust that
 * declaration either: {@link ShoppingIntentParser} returns a CANDIDATE which is
 * scanned for tool calls, URLs, code and instruction language before any field
 * of it is read.
 *
 * ## A provider never throws its way to a fallback
 *
 * `ModelParseOutcome` is a string-discriminated union with a `refused` and a
 * `failed` member, so the reason a fallback happened is a value from a closed
 * set. A THROW is still handled — as `provider_error` — because a provider that
 * throws is broken rather than one that declined, and the two lead an operator
 * to different places.
 */

import type { ModelParseInput, ModelParseOutcome } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';

/** The port. One method, no lifecycle, no configuration surface. */
export interface ShoppingIntentParser {
  /**
   * A name for the operator trace, the boot log and the recorded provenance.
   * Never a credential, never an endpoint.
   */
  readonly id: string;
  /**
   * The model identifier this provider will use, when it is fixed. Reported in
   * the result's provenance so a benchmark threshold names the model it was
   * measured against.
   */
  readonly model?: string;
  parse(input: ModelParseInput): Promise<ModelParseOutcome>;
}

/**
 * The registry. A single slot, not a map keyed by provider id.
 *
 * Deliberate, and the reasoning is `registerGuestMessageTransport`'s: two
 * providers would need a routing rule, and a routing rule is how one shopper's
 * query goes to a provider a benchmark never measured. One deployment, one
 * parser, one set of recorded thresholds that means something.
 */
let registered: ShoppingIntentParser | undefined;

/**
 * Register the deployment's parser. Called at boot by whoever closes the seam;
 * called by NOTHING today.
 *
 * Refuses a second registration rather than replacing the first: a silent
 * replacement is how a test double reaches production, and the symptom would be
 * "the benchmark thresholds no longer describe the parser" rather than an error
 * anybody could see.
 */
export function registerShoppingIntentParser(parser: ShoppingIntentParser): void {
  if (registered !== undefined) {
    throw new Error(
      `A shopping intent parser is already registered ("${registered.id}"); refusing to replace it.`,
    );
  }
  registered = parser;
  log.general.info({ parser: parser.id }, '[SearchIntent] model parser registered');
}

/**
 * Forget the registered parser. TEST-ONLY, and named so that is obvious in a
 * grep — production has no reason to unregister a parser mid-process.
 */
export function resetShoppingIntentParserForTests(): void {
  registered = undefined;
}

/** Whether this deployment can parse with a model at all. */
export function hasShoppingIntentParser(): boolean {
  return registered !== undefined;
}

/** The registered parser's id, for provenance. `deterministic` when none is. */
export function shoppingIntentParserId(): string {
  return registered === undefined ? 'deterministic' : registered.id;
}

/**
 * The outcome of asking a model, including the two ways there was no model to
 * ask. A string discriminant for the `strict: false` narrowing reason.
 */
export type ShoppingIntentParseAttempt =
  | { readonly status: 'parsed'; readonly outcome: ModelParseOutcome; readonly parserId: string }
  | { readonly status: 'unconfigured' }
  | { readonly status: 'timeout'; readonly parserId: string }
  | { readonly status: 'threw'; readonly parserId: string };

/**
 * Ask the registered parser, under a deadline.
 *
 * The deadline is the caller's rather than the provider's, because a provider
 * that hangs is exactly the case a provider-supplied timeout does not cover
 * (#95 model-boundary rule 7 names a timeout as a fallback trigger, and a
 * timeout only a well-behaved provider honours is not one). The losing promise
 * is abandoned rather than cancelled — there is no cancellation contract on the
 * port, and inventing one would make every provider implement it correctly for
 * the guarantee to hold.
 */
export async function parseWithRegisteredModel(
  input: ModelParseInput,
  timeoutMs: number,
): Promise<ShoppingIntentParseAttempt> {
  const parser = registered;
  if (parser === undefined) return { status: 'unconfigured' };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      parser.parse(input),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (outcome === 'timeout') return { status: 'timeout', parserId: parser.id };
    return { status: 'parsed', outcome, parserId: parser.id };
  } catch (err) {
    log.general.error(
      { err, parser: parser.id },
      '[SearchIntent] model parser threw; falling back to the deterministic interpretation',
    );
    return { status: 'threw', parserId: parser.id };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
