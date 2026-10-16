import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import type { CheckoutInput } from '@mercaria/shared-types';
import { findVariantById } from '../db/catalog/variantRepository.js';
import { findOrdersByCheckoutGroup } from '../db/orders/orderRepository.js';
import { addItem, removeItem, updateItem } from '../services/cart.service.js';
import { checkout } from '../services/checkout.service.js';
import {
  openCheckoutPayment,
  readCheckoutPaymentStatus,
} from '../services/payments/checkout-payment.service.js';
import {
  browseReviewedShopping,
  readableShoppingListings,
  readReviewedShoppingCart,
} from '../services/supervised-shopping/catalog.service.js';
import {
  requestCheckoutApproval,
  type SupervisedPurchaseContext,
} from '../services/supervised-shopping/purchase.service.js';
import { shoppingContentDigest } from '../services/supervised-shopping/catalog-review.service.js';
import {
  conflict,
  forbidden,
  notFound,
  respondWithError,
  validationError,
} from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { sendSuccess } from '../utils/api-response.js';

function context(
  req: Request,
  phase: SupervisedPurchaseContext['phase'] = 'prepare',
): SupervisedPurchaseContext {
  if (!req.accessToken) throw forbidden('A verified personal session is required.');
  return { buyerOxyUserId: getRequiredOxyUserId(req), accessToken: req.accessToken, phase };
}

export async function browseSupervisedShopping(req: Request, res: Response): Promise<void> {
  try {
    const ctx = context(req);
    if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string')
      throw validationError('Invalid shopping cursor.');
    sendSuccess(
      res,
      await browseReviewedShopping(ctx.accessToken, req.query.cursor as string | undefined),
    );
  } catch (error) {
    respondWithError(res, error, 'Could not load reviewed shopping.');
  }
}

export async function getSupervisedCart(req: Request, res: Response): Promise<void> {
  try {
    const ctx = context(req);
    sendSuccess(res, await readReviewedShoppingCart(ctx.buyerOxyUserId, ctx.accessToken));
  } catch (error) {
    respondWithError(res, error, 'Could not load your basket.');
  }
}

async function assertReadableVariant(variantId: string, accessToken: string): Promise<void> {
  const variant = await findVariantById(variantId);
  if (!variant) throw notFound('Item not found.');
  const readable = await readableShoppingListings([variant.listingId], accessToken);
  if (!readable.get(variant.listingId)?.variants.some((item) => item.id === variantId)) {
    throw conflict('This item is unavailable for supervised shopping.');
  }
}

export async function addSupervisedCartItem(req: Request, res: Response): Promise<void> {
  try {
    const ctx = context(req);
    await assertReadableVariant(req.body.variantId, ctx.accessToken);
    await addItem({ owner: { kind: 'oxy_user', oxyUserId: ctx.buyerOxyUserId } }, req.body);
    sendSuccess(res, await readReviewedShoppingCart(ctx.buyerOxyUserId, ctx.accessToken));
  } catch (error) {
    respondWithError(res, error, 'Could not add this item.');
  }
}

export async function updateSupervisedCartItem(req: Request, res: Response): Promise<void> {
  try {
    const ctx = context(req);
    const variantId = routeParam(req, 'variantId');
    if (req.body.quantity > 0) await assertReadableVariant(variantId, ctx.accessToken);
    await updateItem(
      { owner: { kind: 'oxy_user', oxyUserId: ctx.buyerOxyUserId } },
      variantId,
      req.body.quantity,
    );
    sendSuccess(res, await readReviewedShoppingCart(ctx.buyerOxyUserId, ctx.accessToken));
  } catch (error) {
    respondWithError(res, error, 'Could not update this item.');
  }
}

export async function removeSupervisedCartItem(req: Request, res: Response): Promise<void> {
  try {
    const ctx = context(req);
    await removeItem(
      { owner: { kind: 'oxy_user', oxyUserId: ctx.buyerOxyUserId } },
      routeParam(req, 'variantId'),
    );
    sendSuccess(res, await readReviewedShoppingCart(ctx.buyerOxyUserId, ctx.accessToken));
  } catch (error) {
    respondWithError(res, error, 'Could not remove this item.');
  }
}

export async function prepareSupervisedCheckout(req: Request, res: Response): Promise<void> {
  try {
    const ctx = context(req);
    const key = req.header('Idempotency-Key');
    if (!key || key.length > 128)
      throw validationError('A stable checkout idempotency key is required.');
    const input = req.body as CheckoutInput;
    if (input.sellerKeys !== undefined || req.query.currency !== undefined) {
      throw validationError(
        'Supervised checkout uses the complete basket and the account’s display currency.',
      );
    }
    if (input.paymentMethod && !['card', 'stripe'].includes(input.paymentMethod)) {
      throw validationError('Supervised purchases require the card payment rail.');
    }
    ctx.requestFingerprint = shoppingContentDigest({ ...input, paymentMethod: 'card' });
    const result = await checkout(
      { kind: 'oxy', oxyUserId: ctx.buyerOxyUserId },
      { ...input, paymentMethod: 'card' },
      key,
      undefined,
      ctx,
    );
    const purchaseApproval = await requestCheckoutApproval(result.checkoutGroupId, ctx);
    // The ordinary order summary includes unreviewed seller/media presentation;
    // expose only the exact canonical approval evidence here.
    sendSuccess(res, { checkoutGroupId: result.checkoutGroupId, purchaseApproval });
  } catch (error) {
    respondWithError(res, error, 'Could not prepare this purchase.');
  }
}

export async function readSupervisedCheckout(req: Request, res: Response): Promise<void> {
  try {
    const ctx = context(req);
    const checkoutGroupId = routeParam(req, 'checkoutGroupId');
    const purchaseApproval = await requestCheckoutApproval(checkoutGroupId, ctx);
    const paymentStatus = await readCheckoutPaymentStatus(
      { kind: 'oxy_user', oxyUserId: ctx.buyerOxyUserId },
      checkoutGroupId,
    );
    sendSuccess(res, { checkoutGroupId, purchaseApproval, paymentStatus });
  } catch (error) {
    respondWithError(res, error, 'Could not load this purchase.');
  }
}

export async function resumeSupervisedCheckout(req: Request, res: Response): Promise<void> {
  try {
    const ctx = context(req, 'resume');
    const checkoutGroupId = routeParam(req, 'checkoutGroupId');
    const purchaseApproval = await requestCheckoutApproval(checkoutGroupId, ctx);
    if (!['approved', 'reserved'].includes(purchaseApproval.status)) {
      sendSuccess(res, { checkoutGroupId, purchaseApproval });
      return;
    }
    const orders = await findOrdersByCheckoutGroup(checkoutGroupId, {
      kind: 'oxy_user',
      oxyUserId: ctx.buyerOxyUserId,
    });
    const payment = await openCheckoutPayment({
      rail: 'card',
      checkoutGroupId,
      buyerOxyUserId: ctx.buyerOxyUserId,
      orders,
      supervisedPurchase: ctx,
    });
    sendSuccess(res, { checkoutGroupId, purchaseApproval, payment });
  } catch (error) {
    respondWithError(res, error, 'Could not resume this purchase.');
  }
}
