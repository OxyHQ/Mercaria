/**
 * `POST /search-intent` — the public natural-language interpretation surface
 * (#95).
 *
 * THIN, like every controller here: it resolves the session, calls the planner,
 * records the turn and answers. The one thing it does that is not plumbing is
 * the REFUSAL mapping, and that is deliberate — a refusal is the visible half of
 * #95 acceptance 3, so the code that turns "this hard constraint has nowhere to
 * be enforced" into a status and a message lives where a reader looking at the
 * HTTP contract will find it.
 *
 * ## It returns an INTERPRETATION, never results
 *
 * The response carries the filters #70 should be given and never runs a search.
 * Two reasons, and the second is the load-bearing one:
 *
 * 1. A client that has an interpretation can edit it — remove a chip, change a
 *    budget basis — and re-run the SEARCH without re-parsing, which is what
 *    makes #95 client rules 2 and 5 cheap rather than a second round trip
 *    through a model.
 * 2. Running the search here would make the interpretation and the results one
 *    response, and a shopper could then never see what Mercaria understood
 *    WITHOUT also paying for the search. Client rule 3 asks for the paraphrase
 *    "before or with results", and only the split makes "before" possible.
 */

import type { Request, Response } from 'express';
import { INTENT_CLARIFICATION_KINDS } from '@mercaria/shared-types';
import type {
  IntentClarificationKind,
  IntentRefusalCode,
  ShoppingIntentRequest,
  ShoppingIntentResult,
} from '@mercaria/shared-types';
import { ANALYTICS_QUERY_TEXT_RETENTION_DAYS } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { recordSearchIntentTurn } from '../db/searchIntent/searchIntentRepository.js';
import { redactSearchQuery } from '../services/analytics/redact-query.js';
import { resolveClarificationAnswer } from '../services/search-intent/clarification.js';
import { languageOf } from '../services/search-intent/locale.js';
import { planLatencyMs, planShoppingIntent } from '../services/search-intent/plan.service.js';
import {
  ensureSession,
  loadSession,
  noteAnswered,
  noteAsked,
} from '../services/search-intent/session.service.js';
import type { ShoppingIntentBody } from '../middleware/search-intent-schemas.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/**
 * Which HTTP status each refusal earns.
 *
 * A 422 rather than a 400 for the two interpretation refusals: the request was
 * well-formed and Mercaria understood it — it simply cannot answer it as asked,
 * and a 400 would tell a client to fix its serialization when the fix is to
 * drop a requirement. `empty_query` IS a 400: an empty string is a malformed
 * request whatever the shopper meant by it.
 */
const REFUSAL_STATUS: Readonly<Record<IntentRefusalCode, number>> = Object.freeze({
  hard_constraint_unenforceable: 422,
  constraint_set_invalid: 422,
  empty_query: 400,
  session_not_found: 404,
  clarification_not_open: 409,
});

/** `POST /search-intent`. */
export async function shoppingIntentHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as ShoppingIntentBody;
  const actor = req.commerceActor ?? { kind: 'anonymous' as const };
  const now = new Date();
  const db = getDb();

  try {
    const session = await loadSession(body.sessionId, actor, now, db);

    // A clarification answer is resolved against the session's OPEN question —
    // never against the answer's own claim about which question it belongs to,
    // because a client replaying an old answer would otherwise re-apply a
    // decision the shopper has since changed.
    let appliedAnswer: { kind: IntentClarificationKind; optionId: string } | undefined;
    if (body.clarificationAnswer !== undefined) {
      const resolution = resolveClarificationAnswer(
        session?.openClarificationId ?? undefined,
        body.clarificationAnswer,
      );
      if (resolution.status === 'not_open') {
        sendError(
          res,
          ErrorCodes.CONFLICT,
          'That question is not open on this search session.',
          REFUSAL_STATUS.clarification_not_open,
        );
        return;
      }
      appliedAnswer = { kind: resolution.kind, optionId: resolution.optionId };
    }

    const request: ShoppingIntentRequest = {
      query: body.query,
      locale: body.locale,
      ...(body.market === undefined ? {} : { market: body.market }),
      ...(body.currency === undefined ? {} : { currency: body.currency }),
      ...(body.categoryId === undefined ? {} : { categoryId: body.categoryId }),
      ...(body.canonicalProductId === undefined
        ? {}
        : { canonicalProductId: body.canonicalProductId }),
      ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
      ...(body.clarificationAnswer === undefined
        ? {}
        : { clarificationAnswer: body.clarificationAnswer }),
      ...(body.selectedFilters === undefined ? {} : { selectedFilters: body.selectedFilters }),
      ...(body.deterministicOnly === undefined
        ? {}
        : { deterministicOnly: body.deterministicOnly }),
    };

    const plan = await planShoppingIntent(
      {
        request,
        ...(session === undefined
          ? {}
          : {
              session: {
                id: session.id,
                // Read BACK out of the closed tuple rather than asserted. The
                // column's CHECK already restricts it, so the filter can only
                // ever be a no-op — and that is the point: an assertion here
                // would keep compiling after somebody widened the column, and
                // this stops compiling.
                askedKinds: session.askedKinds.flatMap((kind) =>
                  INTENT_CLARIFICATION_KINDS.filter((candidate) => candidate === kind),
                ),
                rounds: session.rounds,
              },
            }),
        ...(appliedAnswer === undefined ? {} : { appliedAnswer }),
      },
      db,
    );

    if (plan.status === 'refused') {
      sendError(
        res,
        plan.code === 'empty_query' ? ErrorCodes.VALIDATION_ERROR : ErrorCodes.CONFLICT,
        refusalMessage(plan.code, plan.details),
        REFUSAL_STATUS[plan.code],
      );
      return;
    }

    // The session is created LAZILY and only when there is a question to keep —
    // so a search that resolved cleanly writes no row at all. A shopper who
    // ANSWERED closes the open question whether or not a new one was asked.
    let sessionId = session?.id;
    if (plan.result.clarifications.length > 0) {
      const live = await ensureSession(session, actor, body.locale, body.market, now, db);
      sessionId = live.id;
      const [first] = plan.result.clarifications;
      await noteAsked(
        live.id,
        plan.result.clarifications.map((clarification) => clarification.kind),
        first?.id,
        db,
      );
    } else if (session !== undefined && appliedAnswer !== undefined) {
      await noteAnswered(session.id, db);
    }

    await recordTurn(plan.result, body, sessionId, now);

    sendSuccess(res, {
      ...plan.result,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  } catch (error) {
    respondWithError(res, error, '[search-intent] interpretation failed');
  }
}

/**
 * One line a shopper reads, naming what could not be done.
 *
 * The DETAIL is the constraint's own explanation — "a price of at most 900 €",
 * "screen size of at least 14 in" — because the remedy is to remove or loosen
 * that specific requirement, and a message naming a code would leave a shopper
 * with nothing to act on.
 */
function refusalMessage(
  code: 'hard_constraint_unenforceable' | 'constraint_set_invalid' | 'empty_query',
  details: readonly { readonly id: string; readonly message: string }[],
): string {
  if (code === 'empty_query') return 'Tell us what you are looking for.';
  const named = details.map((detail) => detail.message).join('; ');
  if (code === 'hard_constraint_unenforceable') {
    return `We understood these requirements and cannot narrow by them yet: ${named}`;
  }
  return `We could not make sense of these requirements together: ${named}`;
}

/**
 * Record the turn.
 *
 * The redacted query is #77's OWN redaction (`redactSearchQuery`) and the
 * deadline is #77's own retention period, so the two copies of a shopper's
 * words leave on the same clock rather than one outliving the other under a
 * policy nobody wrote down. There is no parameter here an ORIGINAL could arrive
 * in — the repository's `NewSearchIntentTurn` has no such field.
 *
 * A failure to record is LOGGED and swallowed: the shopper has an
 * interpretation and losing the measurement of it must not cost them the
 * search. That is `recordAnalyticsEvent`'s posture, and the fallback rate this
 * row feeds is a rollout signal rather than a financial one.
 */
async function recordTurn(
  result: ShoppingIntentResult,
  body: ShoppingIntentBody,
  sessionId: string | undefined,
  now: Date,
): Promise<void> {
  try {
    const redacted = redactSearchQuery(body.query);
    await recordSearchIntentTurn({
      ...(sessionId === undefined ? {} : { sessionId }),
      mode: result.mode,
      ...(result.fallbackReason === undefined ? {} : { fallbackReason: result.fallbackReason }),
      provider: result.provenance.provider,
      ...(result.provenance.model === undefined ? {} : { model: result.provenance.model }),
      promptVersion: result.provenance.promptVersion,
      schemaVersion: result.provenance.schemaVersion,
      parserVersion: result.provenance.parserVersion,
      redactedQuery: redacted.redactedText,
      locale: body.locale,
      language: languageOf(body.locale),
      ...(result.interpretation.category === undefined
        ? {}
        : { categoryId: result.interpretation.category.categoryId }),
      hardConstraintCount: result.enforcement.length,
      preferenceCount: result.interpretation.preferenceRanking.length,
      unresolvedCount: result.unresolved.length,
      clarificationCount: result.clarifications.length,
      latencyMs: planLatencyMs(result),
      expiresAt: new Date(
        now.getTime() + ANALYTICS_QUERY_TEXT_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
      ),
    });
  } catch (err) {
    log.general.error({ err }, '[search-intent] failed to record an interpretation turn');
  }
}
