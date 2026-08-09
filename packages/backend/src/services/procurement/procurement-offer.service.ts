/**
 * Procurement-offer ingestion: validation and normalization in front of the
 * repository's source upsert.
 *
 * Small on purpose. The repository owns the convergence (`ON CONFLICT` on the
 * account+SKU key); this service owns what must be true BEFORE any write: the
 * account really belongs to the supplier the caller names (a mismatch here
 * would let one supplier's feed write offers under another's identity), the
 * agreement really belongs to that supplier too, the cost is a safe minor-unit
 * amount, and country codes are normalized to the uppercase form every scope
 * check compares in.
 */

import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import {
  upsertProcurementOfferFromSource,
  type ProcurementOfferSourceInput,
  type ProcurementOfferUpsertResult,
} from '../../db/procurement/procurementOfferRepository.js';
import { findSupplierAccountById } from '../../db/procurement/supplierAccountRepository.js';
import { findAgreementById } from '../../db/procurement/agreementRepository.js';

/** Uppercase ISO country codes; trims and drops empties. */
function normalizeCountries(codes: string[] | undefined): string[] | undefined {
  if (codes === undefined) return undefined;
  return codes.map((code) => code.trim().toUpperCase()).filter((code) => code.length > 0);
}

/**
 * Apply one source observation, after the cross-record checks the schema
 * cannot express. Throws on an inconsistent write; converges on a repeat.
 */
export async function ingestProcurementOffer(
  input: ProcurementOfferSourceInput,
): Promise<ProcurementOfferUpsertResult> {
  assertSafeMoneyAmount(input.unitCostAmount, 'procurement offer unit cost');
  if (input.unitCostAmount < 0) {
    throw new Error('ingestProcurementOffer refuses a negative unit cost');
  }

  const account = await findSupplierAccountById(input.supplierAccountId);
  if (!account) {
    throw new Error(`ingestProcurementOffer: supplier account ${input.supplierAccountId} not found`);
  }
  if (account.supplierId !== input.supplierId) {
    throw new Error(
      'ingestProcurementOffer refuses a supplier/account mismatch: the account belongs to a ' +
        'different supplier than the observation claims',
    );
  }

  if (input.agreementId) {
    const agreement = await findAgreementById(input.agreementId);
    if (!agreement) {
      throw new Error(`ingestProcurementOffer: agreement ${input.agreementId} not found`);
    }
    if (agreement.supplierId !== input.supplierId) {
      throw new Error(
        'ingestProcurementOffer refuses a supplier/agreement mismatch: the agreement was not ' +
          'signed by the supplier the observation claims',
      );
    }
  }

  return await upsertProcurementOfferFromSource({
    ...input,
    supplierSku: input.supplierSku.trim(),
    fulfilmentOriginCountries: normalizeCountries(input.fulfilmentOriginCountries),
    eligibleDestinationCountries: normalizeCountries(input.eligibleDestinationCountries),
  });
}
