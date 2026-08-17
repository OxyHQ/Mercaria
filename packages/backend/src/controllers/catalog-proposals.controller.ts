/**
 * The merchant proposal surface (#367 step 6, ADR 0007 D9/D10).
 *
 * Thin, like every controller here: read the request, call one service, shape the
 * response. The two things it owns that a service cannot are the store the
 * request is scoped to and the DRAFT context a proposal inherits — and both are
 * derived from rows the server already read, never from what the body claims.
 *
 * ## The draft supplies the product type version and the flow
 *
 * A proposal that names a draft answer inherits that draft's pinned product type
 * VERSION and its flow, so the "is this field open to proposals" check runs
 * against the exact rules the answer was given under. Taking either from the body
 * would let a client name a version whose fields say something else — the
 * permissive direction, and the one where a merchant attaches free text to a
 * `controlled_value` field.
 *
 * ## `attributeDefinitionVersion` is never read off a body
 *
 * It is in `CATALOG_PROPOSAL_FORBIDDEN_SUBMITTER_FIELDS` and
 * `refuseForbiddenSubmitterFields` refuses it by name; the value stored is the
 * one `requireProposalEnabledField` read off the definition the submission
 * pointed at.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  CatalogProposalState,
  CatalogProposalType,
  ProductTypeAuthoringFlow,
} from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { notFound, respondWithError, validationError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { sendSuccess } from '../utils/api-response.js';
import { findDraft } from '../db/catalogAuthoring/draftRepository.js';
import { requireProposalEnabledField } from '../services/catalog-proposals/eligibility.js';
import {
  listStoreProposals,
  previewDuplicates,
  readProposal,
  submitProposal,
  supplyProposalInformation,
  withdrawProposal,
} from '../services/catalog-proposals/proposal.service.js';

/** The body shape after `submitCatalogProposalSchema`. */
interface SubmitBody {
  readonly type: CatalogProposalType;
  readonly storeId: string;
  readonly proposedLabel: string;
  readonly sourceLocale: string;
  readonly proposedDescription?: string;
  readonly submitterNote?: string;
  readonly categoryId?: string;
  readonly productTypeDefinitionId?: string;
  readonly attributeDefinitionId?: string;
  readonly draftId?: string;
  readonly draftValueId?: string;
}

/**
 * The flow a store member proposes in.
 *
 * `merchant` unless the DRAFT says otherwise, and the draft is a row rather than
 * a parameter — the `requestedFlow` narrowing one surface over, taken one step
 * further because here there is a stored answer to read instead of a word to
 * trust. `operator` and `verified_brand` are powers a store membership does not
 * grant and no branch here can reach them.
 */
const DEFAULT_PROPOSAL_FLOW: ProductTypeAuthoringFlow = 'merchant';

/** `POST /catalog-proposals` — submit, or converge on the open request. */
export async function submitCatalogProposalHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as SubmitBody;
    const db = getDb();
    const actorOxyUserId = getRequiredOxyUserId(req);

    // The draft context, when the proposal came out of a form. Read from the
    // STORE-scoped lookup, so a draft belonging to somebody else answers 404
    // before any of it is used.
    let productTypeDefinitionId = body.productTypeDefinitionId ?? null;
    let categoryId = body.categoryId ?? null;
    let flow: ProductTypeAuthoringFlow = DEFAULT_PROPOSAL_FLOW;
    if (body.draftId !== undefined) {
      const draft = await findDraft(db, body.storeId, body.draftId);
      if (draft === null) throw notFound('No such draft.');
      productTypeDefinitionId = draft.productTypeDefinitionId;
      categoryId = draft.categoryId;
      flow = draft.flow;
    }

    // A draft VALUE names its draft, or the reference cannot be written: the
    // backfill has to bump the DRAFT's version after rewriting one of its
    // answers, and a value id alone cannot say which draft that is
    // (`catalog_proposal_references_draft_pair_check`).
    if ((body.draftValueId === undefined) !== (body.draftId === undefined)) {
      throw validationError('A draft answer is named by both its draft and its value.');
    }

    let attributeDefinitionVersion: number | null = null;
    if (body.attributeDefinitionId !== undefined) {
      if (productTypeDefinitionId === null) {
        throw validationError(
          'A proposal about an attribute names the product type version it was made under.',
        );
      }
      const eligibility = await requireProposalEnabledField(db, {
        attributeDefinitionId: body.attributeDefinitionId,
        productTypeDefinitionId,
        flow,
      });
      attributeDefinitionVersion = eligibility.attributeDefinitionVersion;
    }

    const result = await submitProposal(db, {
      type: body.type,
      storeId: body.storeId,
      submittedByOxyUserId: actorOxyUserId,
      proposedLabel: body.proposedLabel,
      sourceLocale: body.sourceLocale,
      proposedDescription: body.proposedDescription ?? null,
      submitterNote: body.submitterNote ?? null,
      categoryId,
      productTypeDefinitionId,
      attributeDefinitionId: body.attributeDefinitionId ?? null,
      attributeDefinitionVersion,
      draftId: body.draftId ?? null,
      draftValueId: body.draftValueId ?? null,
    });

    // 201 for a new request, 200 for one that joined an existing one. The status
    // carries the same distinction the `outcome` discriminant does, so a client
    // that only looks at the code still tells them apart.
    sendSuccess(res, result, result.outcome === 'created' ? 201 : 200);
  } catch (err) {
    respondWithError(res, err, 'Failed to submit the proposal');
  }
}

/** `POST /catalog-proposals/duplicates` — the pre-submission scan, storing nothing. */
export async function previewCatalogProposalDuplicatesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as {
      type: CatalogProposalType;
      proposedLabel: string;
      categoryId?: string;
      productTypeDefinitionId?: string;
      attributeDefinitionId?: string;
    };
    const scan = await previewDuplicates(getDb(), {
      type: body.type,
      proposedLabel: body.proposedLabel,
      categoryId: body.categoryId ?? null,
      productTypeDefinitionId: body.productTypeDefinitionId ?? null,
      attributeDefinitionId: body.attributeDefinitionId ?? null,
    });
    sendSuccess(res, scan);
  } catch (err) {
    respondWithError(res, err, 'Failed to check for duplicates');
  }
}

/** `GET /catalog-proposals?storeId=` — a store's own proposals. */
export async function listCatalogProposalsHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = req.query as unknown as {
      storeId: string;
      state?: CatalogProposalState;
      type?: CatalogProposalType;
      limit?: number;
      offset?: number;
    };
    const proposals = await listStoreProposals(getDb(), {
      storeId: query.storeId,
      ...(query.state === undefined ? {} : { states: [query.state] }),
      ...(query.type === undefined ? {} : { types: [query.type] }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    });
    sendSuccess(res, proposals);
  } catch (err) {
    respondWithError(res, err, 'Failed to list proposals');
  }
}

/**
 * `GET /catalog-proposals/:proposalId?storeId=` — one of a store's proposals.
 *
 * A proposal belonging to ANOTHER store answers 404 and not 403: a
 * distinguishable answer is an oracle over which merchants have asked for what,
 * which is the `seller-profile` and `merchant-competitiveness` ruling.
 */
export async function getCatalogProposalHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = (req.query as unknown as { storeId: string }).storeId;
    const proposal = await readProposal(getDb(), routeParam(req, 'proposalId'));
    if (proposal.storeId !== storeId) throw notFound('No such proposal.');
    sendSuccess(res, proposal);
  } catch (err) {
    respondWithError(res, err, 'Failed to read the proposal');
  }
}

/** `POST /catalog-proposals/:proposalId/withdraw`. */
export async function withdrawCatalogProposalHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { storeId: string; reason?: string };
    const proposal = await withdrawProposal(getDb(), {
      proposalId: routeParam(req, 'proposalId'),
      storeId: body.storeId,
      actorOxyUserId: getRequiredOxyUserId(req),
      reason: body.reason ?? null,
    });
    sendSuccess(res, proposal);
  } catch (err) {
    respondWithError(res, err, 'Failed to withdraw the proposal');
  }
}

/** `POST /catalog-proposals/:proposalId/information` — answer a reviewer. */
export async function supplyCatalogProposalInformationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as { storeId: string; response: string };
    const proposal = await supplyProposalInformation(getDb(), {
      proposalId: routeParam(req, 'proposalId'),
      storeId: body.storeId,
      actorOxyUserId: getRequiredOxyUserId(req),
      response: body.response,
    });
    sendSuccess(res, proposal);
  } catch (err) {
    respondWithError(res, err, 'Failed to answer the reviewer');
  }
}
