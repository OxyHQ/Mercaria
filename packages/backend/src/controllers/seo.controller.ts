/**
 * The public routing and SEO controller (THIN) — #75.
 *
 * Four handlers, all reads, all cacheable, none of which decides anything: the
 * resolver, the policy, the renderers and the registry are the services'.
 *
 * ## Why `/seo/resolve` returns the rendered HEAD as well as the document
 *
 * The Cloudflare Worker is plain JavaScript with no type-checker and no test
 * runner in this repository. Every decision that can be got wrong — which tags,
 * which order, what is escaped, whether a `noindex` page carries structured
 * data — is made in `services/seo/head.ts`, where `tsc` and vitest reach it,
 * and the worker performs one string splice it is scanned for. The DOCUMENT
 * travels beside the markup because a test and `/internal/seo/diagnose` both
 * need the structured value and not a blob of HTML.
 *
 * What does NOT travel is the indexability REASON. This surface is public, and
 * a refusal spanning nine conditions gets one public answer — the reason is
 * served only from the operator surface, which reads the same `diagnoseSeoUrl`
 * call this handler projects it away from.
 *
 * ## `Cache-Control` is part of the contract
 *
 * A document costs a ranked comparison and a sitemap page costs an offset scan,
 * and both are asked for once per crawled URL. The headers here are what make
 * the edge answer most of that traffic without reaching the API at all.
 */

import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { renderSeoHead } from '../services/seo/head.js';
import { renderRobotsTxt } from '../services/seo/robots.js';
import { resolveSeoUrl } from '../services/seo/seo.service.js';
import { readSitemapIndex, readSitemapPage } from '../services/seo/sitemap.service.js';
import { isSitemapCollection, renderSitemapIndex, renderUrlset } from '../services/seo/sitemap.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';

/** The `Cache-Control` a document response carries. */
function documentCacheControl(): string {
  const maxAge = config.seo.documentCacheSeconds;
  return `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 10}`;
}

/** The `Cache-Control` a sitemap or `robots.txt` response carries. */
function sitemapCacheControl(): string {
  return `public, max-age=${config.seo.sitemapCacheSeconds}`;
}

/**
 * `GET /seo/resolve?path=…` — what the edge should do with one public URL.
 *
 * ALWAYS 200, whatever the outcome. The outcome is data the worker acts on: a
 * 404 here would make "this product does not exist" indistinguishable from "the
 * SEO service is down", and the worker's behaviour on those two must differ —
 * one is a 404 for the crawler, the other is the shell served unchanged.
 */
export async function resolveSeoDocumentHandler(req: Request, res: Response): Promise<void> {
  const { path } = req.query as { path: string };
  try {
    const url = new URL(path, config.web.origin);
    const resolution = await resolveSeoUrl({
      pathname: url.pathname,
      query: url.searchParams,
    });

    res.setHeader('Cache-Control', documentCacheControl());
    if (resolution.outcome === 'document') {
      sendSuccess(res, { ...resolution, head: renderSeoHead(resolution.document) });
      return;
    }
    sendSuccess(res, resolution);
  } catch (error) {
    respondWithError(res, error, 'Failed to resolve the URL');
  }
}

/** `GET /seo/sitemap.xml` — the index over every collection. */
export async function seoSitemapIndexHandler(_req: Request, res: Response): Promise<void> {
  try {
    const entries = await readSitemapIndex(config.web.origin);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', sitemapCacheControl());
    res.status(200).send(renderSitemapIndex(entries));
  } catch (error) {
    respondWithError(res, error, 'Failed to build the sitemap index');
  }
}

/** `GET /seo/sitemaps/:collection/:file` — one page of one collection. */
export async function seoSitemapPageHandler(req: Request, res: Response): Promise<void> {
  const collection = routeParam(req, 'collection');
  const file = routeParam(req, 'file');
  try {
    if (!isSitemapCollection(collection)) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }
    // Exactly `<digits>.xml`. `Number.parseInt` would accept `3abc`, and two
    // spellings of one address make a crawler fetch the same rows twice.
    const match = /^(\d+)\.xml$/u.exec(file);
    if (match === null) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }

    const entries = await readSitemapPage(
      collection,
      Number.parseInt(match[1], 10),
      config.web.origin,
    );
    if (entries === undefined) {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', sitemapCacheControl());
    res.status(200).send(renderUrlset(entries));
  } catch (error) {
    respondWithError(res, error, 'Failed to build the sitemap page');
  }
}

/** `GET /seo/robots.txt` — rendered from the ONE disallow list. */
export function seoRobotsHandler(_req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', sitemapCacheControl());
  res.status(200).send(renderRobotsTxt(config.web.origin));
}
