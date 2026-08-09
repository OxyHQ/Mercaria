/**
 * Binding one Awin advertiser to the #62 source that IS it (#66 acceptance 3
 * and 5).
 *
 * ## ONE writer, because two could disagree
 *
 * The binding is stated twice by construction — `catalog_source_configs`
 * carries `source_account_ref = <advertiser row id>` (which is how the adapter
 * finds its advertiser) and `awin_advertisers.catalog_source_id` names the
 * source (which is how an operator finds the run history). Two calls that each
 * wrote one half could leave a source pointing at advertiser A while advertiser
 * B claims the source, and the adapter would then ingest B's feed under A's
 * merchant — a wrong retailer on every offer, with no error anywhere.
 *
 * So there is exactly one function that writes either, it writes both in ONE
 * transaction, and `awin-writes.realdb.test.ts` asserts they agree.
 *
 * ## The merchant and the storefront are the operator's to supply
 *
 * #62's rule is unchanged: a source with no merchant produces no offers, and
 * the merchant comes from the source's own BINDING rather than from a payload
 * hint. This service does not MINT a merchant from an advertiser's name —
 * `merchant_hint` stays a hint that resolves nothing, and inventing a commercial
 * actor from a feed's contents is the shape of the claim #55 exists to prevent.
 */

import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { AWIN_FEED_PROVIDER } from '../ingestion/adapters/awin-feed.js';
import { configureIngestionSource } from '../ingestion/source.service.js';
import {
  bindAwinAdvertiserSource,
  findAwinAdvertiser,
  type AwinAdvertiserRow,
} from '../../db/awin/awinAdvertiserRepository.js';

export interface RegisterAwinAdvertiserSourceInput {
  advertiserRowId: string;
  merchantId: string;
  storefrontId?: string;
  territories?: readonly string[];
  freshnessTtlSeconds?: number;
  pageSize?: number;
}

/**
 * Register the #62 source for one advertiser, or converge on the one it has.
 *
 * `configureIngestionSource` converges on the registry row's NAME, so calling
 * this twice reconfigures rather than minting a second source — and the name is
 * derived from the account and advertiser ids rather than from the display name,
 * because a retailer that rebrands must not become a second source with a second
 * catalogue.
 *
 * The source is created in `draft` with NO rights, which is #62's fail-closed
 * direction and is not overridden here: publishing a rights policy against the
 * signed programme terms and activating the source are separate acts by
 * separate people, on `/internal/ingestion`.
 */
export async function registerAwinAdvertiserSource(
  input: RegisterAwinAdvertiserSourceInput,
): Promise<AwinAdvertiserRow> {
  const advertiser = await findAwinAdvertiser(input.advertiserRowId);
  if (advertiser === null) throw notFound('Awin advertiser not found');
  if (advertiser.activation === 'closed') {
    throw conflict(
      'This Awin advertiser is closed. A closed programme is re-opened by Awin naming it in the ' +
        'feed list again, not by binding a source to it.',
    );
  }

  const resolved = await configureIngestionSource({
    name: `Awin ${advertiser.accountId}/${advertiser.advertiserId}`,
    // `affiliate_network`, which is what makes #62's own `offerKindFor` produce
    // an `affiliate` offer once the rights permit affiliate parameters.
    kind: 'affiliate_network',
    provider: AWIN_FEED_PROVIDER,
    // The advertiser ROW id — how the adapter finds which advertiser this run
    // is for. #63's arrangement, where a feed source binds its configuration id.
    sourceAccountRef: advertiser.id,
    merchantId: input.merchantId,
    ...(input.storefrontId === undefined ? {} : { storefrontId: input.storefrontId }),
    ...(input.territories === undefined ? {} : { territories: input.territories }),
    ...(input.freshnessTtlSeconds === undefined
      ? {}
      : { freshnessTtlSeconds: input.freshnessTtlSeconds }),
    ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
  });

  const bound = await bindAwinAdvertiserSource({
    advertiserRowId: advertiser.id,
    catalogSourceId: resolved.source.config.sourceId,
  });
  if (bound === null) throw notFound('Awin advertiser not found');
  return bound;
}
