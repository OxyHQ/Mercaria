/**
 * Translation KEYS for the closed vocabularies the wizard renders.
 *
 * Every value here is a key and never a sentence. Two reasons, and the second
 * is the one that bites: module scope is evaluated once at import, before the
 * locale store has rehydrated, so a resolved string would freeze whatever
 * language the first render happened to see; and `validate:i18n-strings` part C
 * resolves keys from STRING LITERALS in source, so a key assembled at runtime
 * (`t(\`…${axis}\`)`) is invisible to it — the key reads as unused, the guard
 * fails, and the remedy somebody reaches for is deleting the copy.
 *
 * These are total `Record`s over shared-types tuples, so a member added
 * upstream fails `tsc` here rather than rendering a humanised guess at a
 * missing key.
 */

import type { AttributeComponentAxis, ProductTypeFieldRequirement } from "@mercaria/shared-types";
import type { WizardStepId } from "./findings";

/** The axes a `structured` attribute declares — width × height × depth. */
export const COMPONENT_AXIS_LABEL_KEYS: Record<AttributeComponentAxis, string> = {
  width: "products.wizard.axes.width",
  height: "products.wizard.axes.height",
  depth: "products.wizard.axes.depth",
  diagonal: "products.wizard.axes.diagonal",
  circumference: "products.wizard.axes.circumference",
};

/** How hard the schema asks for a field, in this flow. */
export const REQUIREMENT_LABEL_KEYS: Record<ProductTypeFieldRequirement, string> = {
  required: "products.wizard.fields.required",
  recommended: "products.wizard.fields.recommended",
  optional: "products.wizard.fields.optional",
  hidden: "products.wizard.fields.hidden",
  forbidden: "products.wizard.fields.forbidden",
};

/** The wizard's own steps. */
export const STEP_LABEL_KEYS: Record<WizardStepId, string> = {
  classification: "products.wizard.steps.classification",
  details: "products.wizard.steps.details",
  variants: "products.wizard.steps.variants",
  pricing: "products.wizard.steps.pricing",
  listing: "products.wizard.steps.listing",
  review: "products.wizard.steps.review",
};
