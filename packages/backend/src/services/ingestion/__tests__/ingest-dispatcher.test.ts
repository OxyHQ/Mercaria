import { beforeEach, describe, expect, it, vi } from 'vitest';

// Plain consts and a dynamic import rather than `vi.hoisted` and a static one,
// so the file runs under both vitest and `bun test` (scripts/test-bun.ts):
// bun's `vi.mock` is not hoisted, so the dispatcher must load after it.
const mocks = {
  claimSourceRuns: vi.fn(),
  runIngestionPage: vi.fn(),
};

vi.mock('../../../db/postgres.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/ingestion/catalogSourceConfigRepository.js', () => ({
  claimDueSources: async () => [],
  releaseSourceLease: async () => true,
}));
vi.mock('../../../db/ingestion/catalogSourceRunRepository.js', () => ({
  claimSourceRuns: mocks.claimSourceRuns,
  openSourceRun: vi.fn(),
  yieldSourceRun: async () => true,
}));
vi.mock('../ingest.service.js', () => ({ runIngestionPage: mocks.runIngestionPage }));
vi.mock('../../../lib/logger.js', () => ({
  log: { general: { debug: vi.fn(), info: vi.fn(), error: vi.fn() } },
}));

describe('ingestion dispatcher', () => {
  beforeEach(() => {
    mocks.claimSourceRuns.mockReset();
    mocks.runIngestionPage.mockReset();
  });

  it('drives every claimed run even when one page throws', async () => {
    mocks.claimSourceRuns.mockResolvedValue([
      { id: 'run-a', sourceId: 'source-a' },
      { id: 'run-b', sourceId: 'source-b' },
    ]);
    mocks.runIngestionPage.mockImplementation(async ({ runId }: { runId: string }) => {
      if (runId === 'run-a') throw new Error('violates check constraint');
      return {
        runId,
        sourceId: 'source-b',
        outcome: 'partial_feed',
        hasMore: false,
        skipped: null,
      };
    });

    const { drainCatalogIngestion } = await import('../ingest-dispatcher.js');
    const results = await drainCatalogIngestion(new Date());

    expect(mocks.runIngestionPage).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.runId)).toEqual(['run-b']);
  });

  it('keeps driving a run with more pages within the tick', async () => {
    mocks.claimSourceRuns.mockResolvedValue([{ id: 'run-a', sourceId: 'source-a' }]);
    let pages = 0;
    mocks.runIngestionPage.mockImplementation(async ({ runId }: { runId: string }) => {
      pages += 1;
      return { runId, sourceId: 'source-a', outcome: null, hasMore: pages < 3, skipped: null };
    });

    const { drainCatalogIngestion } = await import('../ingest-dispatcher.js');
    await drainCatalogIngestion(new Date());

    expect(mocks.runIngestionPage).toHaveBeenCalledTimes(3);
  });
});
