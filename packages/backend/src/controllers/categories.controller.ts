/**
 * Categories controller (THIN).
 *
 * Serves the category taxonomy as a tree (`GET /categories`) and a cursor browse
 * of a category's active listings (`GET /categories/:slug/listings`).
 */

import type { Request, Response } from 'express';
import type { CategoryNode, CursorPage, Listing } from '@mercaria/shared-types';
import { Category, type ICategory } from '../models/category.js';
import { searchListingsCursor } from '../services/search.service.js';
import { hydrateListings } from '../services/catalog-hydration.service.js';
import { parsePagination } from '../utils/pagination.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, notFound } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Build the nested `CategoryNode` tree from a flat list of categories. */
function buildTree(categories: ICategory[]): CategoryNode[] {
  const nodeById = new Map<string, CategoryNode>();
  const roots: CategoryNode[] = [];

  for (const c of categories) {
    const id = String((c as { _id: unknown })._id);
    const node: CategoryNode = {
      id,
      name: c.name,
      slug: c.slug,
      parentId: c.parentId,
      children: [],
    };
    if (c.imageUrl) {
      node.imageUrl = c.imageUrl;
    }
    nodeById.set(id, node);
  }

  for (const node of nodeById.values()) {
    if (node.parentId && nodeById.has(node.parentId)) {
      nodeById.get(node.parentId)?.children?.push(node);
    } else {
      roots.push(node);
    }
  }

  // Drop empty children arrays for leaf nodes.
  for (const node of nodeById.values()) {
    if (node.children && node.children.length === 0) {
      delete node.children;
    }
  }

  return roots;
}

/** GET /categories — the active category taxonomy as a tree. */
export async function getCategoryTree(_req: Request, res: Response): Promise<void> {
  try {
    const categories = await Category.find({ isActive: true })
      .sort({ position: 1 })
      .lean<ICategory[]>();
    sendSuccess(res, buildTree(categories));
  } catch (err) {
    log.general.error({ err }, 'Failed to load category tree');
    respondWithError(res, err, 'Failed to load categories');
  }
}

/** GET /categories/:slug/listings — cursor browse of active listings in a category. */
export async function getCategoryListings(req: Request, res: Response): Promise<void> {
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  try {
    const category = await Category.findOne({ slug, isActive: true }).lean<ICategory | null>();
    if (!category) {
      throw notFound('Category not found');
    }

    const { limit } = parsePagination(req.query);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const result = await searchListingsCursor({ category: slug, sort: 'newest', cursor }, limit);
    const data = await hydrateListings(result.listings, { viewerId: req.user?.id });

    const page: CursorPage<Listing> = { data, hasMore: result.hasMore };
    if (result.nextCursor) {
      page.nextCursor = result.nextCursor;
    }
    sendSuccess(res, page);
  } catch (err) {
    log.general.error({ err, slug }, 'Failed to load category listings');
    respondWithError(res, err, 'Failed to load category listings');
  }
}
