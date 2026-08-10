/**
 * The STATIC sitemap.xml — the `SEO_ROUTES_ENABLED=false` floor (#75).
 *
 * The real sitemaps are served by the API and proxied by `public/_worker.js`:
 * four paginated collections behind an index, with membership decided by the
 * indexability policy and `lastmod` from meaningful public changes
 * (`docs/seo.md`). This file writes what a crawler gets when that lookup cannot
 * answer — the home page and nothing else, which is honest for a deployment
 * that has not switched the SEO layer on.
 *
 * It deliberately does NOT enumerate the catalogue. A build-time list would be
 * a second sitemap authority, stale from the moment it was written, and it
 * could not apply the policy at all.
 *
 * Run: bun run generate-sitemap
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SITE_URL = 'https://mercaria.co';
const CURRENT_DATE = new Date().toISOString().split('T')[0];

interface SitemapURL {
  loc: string;
  lastmod: string;
  changefreq: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority: number;
}

// Static, public, indexable routes.
const staticRoutes: SitemapURL[] = [
  {
    loc: '/',
    lastmod: CURRENT_DATE,
    changefreq: 'daily',
    priority: 1.0,
  },
];

function generateSitemapXML(urls: SitemapURL[]): string {
  const urlEntries = urls
    .map(
      ({ loc, lastmod, changefreq, priority }) => `
  <url>
    <loc>${SITE_URL}${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urlEntries}
</urlset>`;
}

async function generateSitemap() {
  console.log('🗺️  Generating sitemap.xml for Mercaria...');

  const sitemapXML = generateSitemapXML(staticRoutes);

  // Save to /public
  const publicPath = path.resolve(__dirname, '../public/sitemap.xml');
  fs.writeFileSync(publicPath, sitemapXML, 'utf-8');
  console.log(`✅ Sitemap generated: ${publicPath}`);

  // Also save to /dist if it exists
  const distPath = path.resolve(__dirname, '../dist/sitemap.xml');
  const distDir = path.dirname(distPath);
  if (fs.existsSync(distDir)) {
    fs.writeFileSync(distPath, sitemapXML, 'utf-8');
    console.log(`✅ Sitemap copied to: ${distPath}`);
  }

  console.log(`\n📊 Total URLs in sitemap: ${staticRoutes.length}`);
  console.log('🎉 Sitemap generated successfully!');
}

// Execute
generateSitemap().catch(console.error);
