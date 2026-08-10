/**
 * The Mercaria storefront's Cloudflare Worker (Static Assets, advanced mode).
 *
 * Two jobs:
 *
 *  1. **MIME correctness for the SPA shell.** Cloudflare's asset pipeline
 *     returns `index.html` for any path that does not match a static file,
 *     regardless of `_redirects`, so a stale hashed `.css`/`.js` URL from a
 *     previous deploy comes back as HTML and the browser rejects it. This
 *     worker turns that into a clean 404.
 *
 *  2. **Server-readable metadata (#75).** Before serving a document it asks the
 *     API what that URL is: a redirect, a page with a rendered `<head>`, an
 *     address that does not exist, or nothing this domain publishes metadata
 *     for. The `<head>` MARKUP is composed by the API
 *     (`services/seo/head.ts`), where a type-checker and a test runner reach
 *     it; this file performs the one string splice, and
 *     `seo-no-js-render.test.ts` in the backend imports {@link injectSeoHead}
 *     and drives it over the real shell so the no-JavaScript render is checked
 *     rather than assumed.
 *
 * ## It FAILS OPEN, everywhere
 *
 * No `SEO_API_ORIGIN`, a slow API, a non-200, unparseable JSON, a shell with no
 * `</head>` — every one of them serves the storefront exactly as it would
 * without this file. The one thing that must never happen is a redirect or a
 * 404 invented because a lookup failed, so both are produced only from an
 * explicit, successfully-parsed answer.
 */

const STATIC_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".map",
  ".wasm",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".avif",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".webm",
  ".ogg",
  ".wav",
  ".pdf",
  ".xml",
  ".txt",
]);

/** How long the worker waits for the API before serving the shell unchanged. */
const SEO_TIMEOUT_MS = 1500;

/**
 * The crawl artefacts the API serves, mapped to the path it serves them at.
 *
 * `/sitemaps/<collection>/<page>.xml` is handled by prefix below. These are
 * proxied rather than redirected: a crawler asked `mercaria.co` for them and a
 * hop to another host is a hop some crawlers do not take.
 */
const CRAWL_ARTEFACTS = new Map([
  ["/robots.txt", "/seo/robots.txt"],
  ["/sitemap.xml", "/seo/sitemap.xml"],
]);

const SITEMAP_PREFIX = "/sitemaps/";

function getExtension(pathname) {
  const lastDot = pathname.lastIndexOf(".");
  return lastDot === -1 ? "" : pathname.slice(lastDot).toLowerCase();
}

/**
 * Is this a request for an HTML DOCUMENT?
 *
 * `GET`/`HEAD` only, and the client must actually say it wants HTML — an
 * `fetch()` from the app itself, a preflight or a service-worker revalidation
 * must not pay for a metadata lookup.
 *
 * Exported for the backend's tests.
 */
export function isDocumentRequest(request, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (STATIC_EXTENSIONS.has(getExtension(pathname))) return false;
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

/**
 * The tags the API's `<head>` fragment REPLACES.
 *
 * Each is removed from the shell before the fragment is appended, so the
 * document ends with exactly one title, one description, one canonical link and
 * one structured-data block. Without the removal a product page would carry the
 * shell's generic "Mercaria" title beside its own, and which one a crawler
 * believes is not something to leave to chance.
 */
function stripReplacedTags(html) {
  return html
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(/<meta\b[^>]*>/gi, (tag) => (isReplacedMeta(tag) ? "" : tag))
    .replace(/<link\b[^>]*>/gi, (tag) => (isReplacedLink(tag) ? "" : tag))
    .replace(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
      "",
    );
}

/** Does this `<meta>` tag carry a value the rendered head supplies? */
function isReplacedMeta(tag) {
  const lower = tag.toLowerCase();
  if (/\bname\s*=\s*["'](description|title|robots)["']/.test(lower)) return true;
  if (/\bproperty\s*=\s*["'](og|twitter):/.test(lower)) return true;
  if (/\bname\s*=\s*["']twitter:/.test(lower)) return true;
  return false;
}

/** Does this `<link>` tag carry a value the rendered head supplies? */
function isReplacedLink(tag) {
  const lower = tag.toLowerCase();
  if (/\brel\s*=\s*["']canonical["']/.test(lower)) return true;
  return /\brel\s*=\s*["']alternate["']/.test(lower) && /\bhreflang\s*=/.test(lower);
}

/**
 * Splice a rendered `<head>` fragment into the shell.
 *
 * Returns the document UNCHANGED when there is no `</head>` to insert before —
 * a shell shaped differently from the one this was written against is a reason
 * to serve the app, not to mangle it.
 *
 * Exported for the backend's no-JavaScript render test, which drives this exact
 * function over the exact fragment the API produces.
 */
export function injectSeoHead(html, head) {
  if (typeof html !== "string" || typeof head !== "string" || head === "") return html;
  const stripped = stripReplacedTags(html);
  const closing = stripped.toLowerCase().lastIndexOf("</head>");
  if (closing === -1) return html;
  return stripped.slice(0, closing) + head + stripped.slice(closing);
}

/** The API URL that answers what one storefront path is. */
function resolveEndpoint(apiOrigin, url) {
  const endpoint = new URL("/seo/resolve", apiOrigin);
  endpoint.searchParams.set("path", url.pathname + url.search);
  return endpoint;
}

/**
 * Ask the API about one path.
 *
 * Returns `null` on ANY failure. The caller then serves the shell, which is the
 * behaviour this file had before #75.
 */
async function fetchResolution(apiOrigin, url) {
  try {
    const response = await fetch(resolveEndpoint(apiOrigin, url), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(SEO_TIMEOUT_MS),
      // The API sets `Cache-Control` on this response; letting Cloudflare hold
      // it is what stops a crawl becoming one API request per page view.
      cf: { cacheEverything: true },
    });
    if (!response.ok) return null;
    const body = await response.json();
    const payload = body && body.data;
    return payload && typeof payload.outcome === "string" ? payload : null;
  } catch {
    return null;
  }
}

/** Proxy one crawl artefact, or `null` when the API cannot answer. */
async function fetchCrawlArtefact(apiOrigin, apiPath) {
  try {
    const response = await fetch(new URL(apiPath, apiOrigin), {
      signal: AbortSignal.timeout(SEO_TIMEOUT_MS),
      cf: { cacheEverything: true },
    });
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const extension = getExtension(pathname);
    const apiOrigin = (env && env.SEO_API_ORIGIN) || "";

    /**
     * `robots.txt` and the sitemaps come from the API, which renders them from
     * ONE disallow list and one indexability policy. When the API cannot answer
     * — including when `SEO_ROUTES_ENABLED` is off, which 404s — the static
     * assets the app ships are served instead. Those are the flag-off floor,
     * and a backend test keeps their rules in step with the rendered ones.
     */
    if (apiOrigin !== "") {
      const artefact = CRAWL_ARTEFACTS.get(pathname);
      if (artefact !== undefined) {
        const proxied = await fetchCrawlArtefact(apiOrigin, artefact);
        if (proxied) return proxied;
      } else if (pathname.startsWith(SITEMAP_PREFIX)) {
        const proxied = await fetchCrawlArtefact(apiOrigin, `/seo${pathname}`);
        if (proxied) return proxied;
        // A sitemap page has no static fallback. Answering 404 is honest: the
        // index that named it came from the same API.
        return new Response("Not Found", { status: 404 });
      }
    }

    /**
     * The metadata lookup, BEFORE the asset fetch, because a redirect must not
     * be preceded by rendering the page it redirects away from.
     */
    let resolution = null;
    if (apiOrigin !== "" && isDocumentRequest(request, pathname)) {
      resolution = await fetchResolution(apiOrigin, url);
      if (resolution && resolution.outcome === "redirect" && resolution.redirect) {
        const location = resolution.redirect.location;
        const status = resolution.redirect.status;
        // Composed by the API from a REGISTERED route and never from anything a
        // caller supplied, and re-checked here for the one property this file
        // can check on its own: it is a path on this origin.
        if (typeof location === "string" && location.startsWith("/") && !location.startsWith("//")) {
          return new Response(null, {
            status: status === 308 ? 308 : 301,
            headers: { location, "cache-control": "public, max-age=3600" },
          });
        }
      }
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get("content-type") || "";

    // The platform returned an HTML fallback for a static-asset URL, so the
    // file does not exist (a stale hashed bundle from a previous deploy).
    if (STATIC_EXTENSIONS.has(extension) && contentType.includes("text/html")) {
      return new Response("Not Found", { status: 404 });
    }

    // Content-addressed bundles are immutable.
    if (pathname.startsWith("/_expo/static/") && !contentType.includes("text/html")) {
      const headers = new Headers(assetResponse.headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        headers,
      });
    }

    if (!resolution || !contentType.includes("text/html") || assetResponse.status !== 200) {
      return assetResponse;
    }

    /**
     * A registered address naming something that does not exist. The SPA still
     * renders its own not-found screen; the STATUS is what stops a crawler
     * collecting a soft 404, and it is set only for an address the API matched
     * against a live route.
     */
    if (resolution.outcome === "not_found") {
      return new Response(assetResponse.body, {
        status: 404,
        headers: assetResponse.headers,
      });
    }

    if (resolution.outcome !== "document" || typeof resolution.head !== "string") {
      return assetResponse;
    }

    const html = await assetResponse.text();
    const headers = new Headers(assetResponse.headers);
    // The body is now per-URL rather than the shared shell, so it must not be
    // cached under the shell's key. The API's own metadata response is what is
    // cached; this document is composed per request from it.
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    headers.delete("content-length");
    return new Response(injectSeoHead(html, resolution.head), {
      status: 200,
      headers,
    });
  },
};
