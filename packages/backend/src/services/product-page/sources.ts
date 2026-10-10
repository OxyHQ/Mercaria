/**
 * Name the open-data source a row's facts came from (ADR 0014 D5).
 *
 * The keyless providers publish under licences that require naming them
 * wherever their data is shown — ODbL for Open Prices and Open Food Facts,
 * Spain's reuse terms for MITECO's fuel prices — and a crowd-sourced price is
 * only honest beside the DATE somebody saw it. Both are read here, once per
 * page, rather than by each client: the provider's name, homepage and licence
 * come from its descriptor (code, reviewed in the PR that added it), and the
 * observation date from the offer's own source record.
 */

import type { Offer, ProductPageOfferSource } from '@mercaria/shared-types';
import { OPEN_DATA_LICENCE_LABELS } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { findSourceRecordUpdatedAt } from '../../db/productPage/productPageRepository.js';
import { findOpenDataProvider } from '../open-data/catalogue.js';

/** offer id → the source to name, for every offer an open-data provider supplied. */
export async function resolveOfferSources(
  offers: readonly Offer[],
  db: DatabaseOrTransaction,
): Promise<Map<string, ProductPageOfferSource>> {
  const openData = offers.flatMap((offer) => {
    const provider =
      offer.provenance.provider === undefined
        ? undefined
        : findOpenDataProvider(offer.provenance.provider);
    return provider === undefined ? [] : [{ offer, provider }];
  });
  const observed = await findSourceRecordUpdatedAt(
    db,
    openData.flatMap(({ offer }) =>
      offer.provenance.sourceRecordId === undefined ? [] : [offer.provenance.sourceRecordId],
    ),
  );

  const result = new Map<string, ProductPageOfferSource>();
  for (const { offer, provider } of openData) {
    const observedAt =
      offer.provenance.sourceRecordId === undefined
        ? undefined
        : observed.get(offer.provenance.sourceRecordId);
    result.set(offer.id, {
      name: provider.name,
      homepage: provider.homepage,
      licence: provider.licence,
      licenceLabel: OPEN_DATA_LICENCE_LABELS[provider.licence],
      ...(observedAt === undefined ? {} : { observedAt: observedAt.toISOString() }),
    });
  }
  return result;
}
