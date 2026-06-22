/**
 * Cloudflare Pages Worker -- SPA routing with proper MIME-type handling.
 *
 * Cloudflare Pages' asset pipeline (env.ASSETS.fetch) returns index.html for
 * any path that doesn't match a static file, regardless of _redirects settings.
 * This causes browsers to reject stale hashed CSS/JS URLs because the response
 * has text/html MIME type instead of the expected type.
 *
 * This worker intercepts asset responses and returns a proper 404 when the
 * platform returns HTML for a URL with a static-asset file extension.
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

function getExtension(pathname) {
  const lastDot = pathname.lastIndexOf(".");
  return lastDot === -1 ? "" : pathname.slice(lastDot).toLowerCase();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const extension = getExtension(pathname);

    // Try the asset pipeline first.
    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get("content-type") || "";

    // Detect when the platform returns an HTML fallback for a static-asset URL.
    // If the URL has a known static extension but the response is HTML, the
    // actual file doesn't exist (e.g., stale hashed bundle from a previous
    // deploy). Return a clean 404 instead of HTML with the wrong MIME type.
    if (STATIC_EXTENSIONS.has(extension) && contentType.includes("text/html")) {
      return new Response("Not Found", { status: 404 });
    }

    // For existing static assets under /_expo/static/, set immutable caching
    // since these filenames are content-addressed (hash in the filename).
    if (pathname.startsWith("/_expo/static/") && !contentType.includes("text/html")) {
      const headers = new Headers(assetResponse.headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        headers,
      });
    }

    // For non-asset paths (SPA navigation routes), the platform's index.html
    // fallback is correct behavior. Return the response as-is.
    return assetResponse;
  },
};
