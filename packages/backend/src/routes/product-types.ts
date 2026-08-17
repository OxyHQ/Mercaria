/**
 * `/product-types` — the PUBLIC specification layout (#367 step 3, ADR 0007 D5).
 *
 * ONE read, and the seam it closes: a product type's ordered field groups were
 * reachable only through `GET /catalog-authoring/schemas/:productTypeKey`, which
 * is behind `authenticateToken` plus a false-by-default flag, and
 * `ProductTypeVersionView` was served by no route at all. So a product page could
 * group its specification table by entity scope (`product` versus `variant`) and
 * by nothing else — `packages/frontend/lib/catalog/specifications.ts` says so, and
 * its `SpecificationGrouping` has one member because of it.
 *
 * ## Why this is not the authoring schema, and must not become it
 *
 * `/catalog-authoring/schemas/:productTypeKey` composes the product type PLUS the
 * registry versions, the controlled-value policies, the caller's store
 * permissions, the locale and the market (ADR 0007 D10). Every one of those is a
 * fact about a SELLER, which is why that surface is authenticated. This serves the
 * grouping and nothing else: group keys, labels, order, and which attribute key
 * sits in which. `PUBLIC_PRODUCT_TYPE_FORBIDDEN_LAYOUT_FIELDS` names the five
 * authoring facts it may not carry, and a walk of a real emitted layout asserts it
 * — `visibilityRule` above all, which is a conditional expression over other
 * fields and would put the authoring form's branching on a product page.
 *
 * ## Only a PUBLISHED version, and no flow
 *
 * A draft layout is not a public fact. And the read names no authoring flow:
 * `product_type_fields` rows are per flow, so serving one flow's grouping would
 * make a shopper's spec table depend on which form the seller filled in. The
 * layout is derived across every flow and refuses to place an attribute two flows
 * disagree about — see `deriveSpecificationLayout`.
 *
 * No auth and no lever: a published product type's group headings are the same
 * public catalogue metadata `/categories` and `/catalog-attributes` already serve.
 * Rate-limited under `'listings'`, the read-path budget those two share.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { productTypeSpecificationLayoutHandler } from '../controllers/product-types.controller.js';

const router = Router();

router.use(makeRateLimiter('listings'));

/** GET /product-types/:key/specification-layout — the published grouping. */
router.get('/:key/specification-layout', productTypeSpecificationLayoutHandler);

export default router;
