/**
 * The generated, reviewable outreach context (#86 acquisition 5).
 *
 * ## It is EVIDENCE, not a draft message
 *
 * There is no subject line, no salutation, no template and no free text. Every
 * line names the metric it came from, the noun that metric may be rendered
 * with, and that metric's attribution limit — so "using only defensible
 * metrics" is checkable by reading the payload rather than by trusting whoever
 * wrote a template. An operator writes the message; this says what they are
 * allowed to say in it.
 *
 * ## It is COMPOSED on read and stored nowhere
 *
 * A stored context is a copy of a number, and the failure mode is an operator
 * quoting last quarter's demand at a merchant who then asks about it. The
 * snapshot is the stored fact; this is a projection of it, and it names the
 * snapshot id so the evidence can be opened.
 *
 * ## The preview partition decides what may appear
 *
 * The same list the public preview uses, for the same reason: an outreach
 * conversation with an unclaimed merchant is a disclosure to somebody who has
 * not proved they are the merchant. A metric that is not preview-safe is
 * WITHHELD and the withholding is reported, so an operator can see that
 * something exists rather than concluding there is nothing.
 */

import {
  MERCHANT_DEMAND_PREVIEW_METRIC_KEYS,
  type MerchantAcquisitionOutreachContext,
  type MerchantDemandSnapshotView,
} from '@mercaria/shared-types';
import { requireMerchantDemandMetric } from './metrics.js';
import { toPreviewValue } from './preview.service.js';

/** Compose the context for one snapshot. */
export function buildOutreachContext(
  view: MerchantDemandSnapshotView,
): MerchantAcquisitionOutreachContext {
  const previewSafe = new Set<string>(MERCHANT_DEMAND_PREVIEW_METRIC_KEYS);
  const lines: MerchantAcquisitionOutreachContext['lines'][number][] = [];
  const withheld: MerchantAcquisitionOutreachContext['withheld'][number][] = [];

  for (const metric of view.metrics) {
    if (!previewSafe.has(metric.metricKey)) {
      withheld.push({ metricKey: metric.metricKey, reason: 'not_preview_safe' });
      continue;
    }
    const definition = requireMerchantDemandMetric(metric.metricKey);
    const value = toPreviewValue(metric.value);
    if (value.state === 'suppressed') {
      withheld.push({ metricKey: metric.metricKey, reason: 'below_floor' });
      continue;
    }
    if (value.state === 'unavailable') {
      withheld.push({ metricKey: metric.metricKey, reason: 'unavailable' });
      continue;
    }
    lines.push({
      metricKey: metric.metricKey,
      title: definition.title,
      noun: definition.noun,
      value,
      attributionLimit: definition.attributionLimit,
    });
  }

  return {
    merchantId: view.merchantId,
    snapshotId: view.id,
    windowFrom: view.windowFrom,
    windowTo: view.windowTo,
    dataFreshAsOf: view.dataFreshAsOf,
    lines,
    withheld,
  };
}
