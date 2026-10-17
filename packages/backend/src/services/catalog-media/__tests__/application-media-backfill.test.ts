/**
 * The application-media backfill asks Oxy in BATCH requests: Oxy charges its
 * 30-a-minute application budget per request, and a batch carries up to 50
 * sources. Each row still gets its own answer and its own compare-and-swap (the
 * swap itself is exercised against the real rows in the realdb file).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ importAppFiles: vi.fn() }));
vi.mock('../../../capabilities/oxy-service-client.js', () => ({
  oxyServiceClient: () => ({ assets: { importAppFiles: sdk.importAppFiles } }),
}));
const repo = vi.hoisted(() => ({ page: vi.fn(), apply: vi.fn() }));
vi.mock('../../../db/oxyFiles/applicationMediaRepository.js', () => ({
  findApplicationMediaPage: repo.page,
  applyApplicationMediaFile: repo.apply,
}));
vi.mock('../../../db/oxyFiles/applicationFileRepository.js', () => ({
  recordApplicationFiles: vi.fn(async () => undefined),
  findApplicationFileIds: vi.fn(async () => new Set()),
}));

const { backfillApplicationMedia } = await import('../application-media-backfill.js');

const db = {} as never;
const row = (index: number) => ({
  id: `category-${String(index).padStart(3, '0')}`,
  kind: 'image' as const,
  fileId: null,
  sourceUrl: `https://images.example.test/${index}.jpg`,
});
const stored = (index: number) => ({
  id: `oxy-file-${index}`,
  mime: 'image/png',
  size: 10,
  visibility: 'public',
  status: 'active',
});

beforeEach(() => {
  vi.resetAllMocks();
  repo.apply.mockResolvedValue('applied');
  sdk.importAppFiles.mockImplementation(async (items: { sourceUrl: string }[]) =>
    items.map(({ sourceUrl }, index) => ({
      index,
      ok: true,
      file: stored(Number(/(\d+)\.jpg$/.exec(sourceUrl)?.[1])),
      outcome: 'downloaded',
      deduplicated: false,
    })),
  );
});

describe('the application-media backfill imports in batches', () => {
  it('asks Oxy once per 50 rows, and applies each row with its own file', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => row(index));
    repo.page.mockResolvedValue(rows);
    const report = await backfillApplicationMedia(
      { target: 'category_image', mode: 'apply', limit: 120 },
      db,
    );
    expect(sdk.importAppFiles.mock.calls.map(([items]) => items.length)).toEqual([50, 50, 20]);
    expect(report.entries.every((entry) => entry.outcome === 'applied')).toBe(true);
    expect(repo.apply).toHaveBeenCalledTimes(120);
    expect(repo.apply.mock.calls[7]?.slice(1, 3)).toEqual([rows[7], 'oxy-file-7']);
  });

  it('reports a source Oxy refused on its row, and applies the rest', async () => {
    repo.page.mockResolvedValue([row(1), row(2), row(3)]);
    sdk.importAppFiles.mockResolvedValue([
      { index: 0, ok: true, file: stored(1), outcome: 'downloaded', deduplicated: false },
      { index: 1, ok: false, error: { status: 422, code: 'SOURCE_URL_REFUSED', message: 'x' } },
      { index: 2, ok: true, file: stored(3), outcome: 'existing', deduplicated: true },
    ]);
    const report = await backfillApplicationMedia(
      { target: 'category_image', mode: 'apply', limit: 3 },
      db,
    );
    expect(report.entries.map((entry) => [entry.id, entry.outcome, entry.reason])).toEqual([
      ['category-001', 'applied', undefined],
      ['category-002', 'failed', 'Oxy could not import the media source (HTTP 422).'],
      ['category-003', 'applied', undefined],
    ]);
    expect(report.retryIds).toEqual(['category-002']);
  });

  it('a request Oxy rate-limits past the retry bound fails its rows for a rerun, never a file', async () => {
    repo.page.mockResolvedValue([row(1), row(2)]);
    sdk.importAppFiles.mockRejectedValue(
      Object.assign(new Error('Too many'), { status: 429, details: { retryAfterSeconds: 3600 } }),
    );
    const report = await backfillApplicationMedia(
      { target: 'category_image', mode: 'apply', limit: 2 },
      db,
    );
    expect(sdk.importAppFiles).toHaveBeenCalledTimes(1);
    expect(report.entries.map((entry) => entry.reason)).toEqual([
      'Oxy could not import the media source (HTTP 429).',
      'Oxy could not import the media source (HTTP 429).',
    ]);
    expect(report.retryIds).toEqual(['category-001', 'category-002']);
    expect(repo.apply).not.toHaveBeenCalled();
  });

  it('a preview asks Oxy nothing', async () => {
    repo.page.mockResolvedValue([row(1)]);
    await backfillApplicationMedia({ target: 'category_image', mode: 'preview', limit: 1 }, db);
    expect(sdk.importAppFiles).not.toHaveBeenCalled();
  });
});
