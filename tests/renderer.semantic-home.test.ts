import { afterEach, describe, expect, it, vi } from 'vitest';

function stubRendererGlobals(fetchImpl: typeof fetch) {
  vi.stubGlobal('window', {
    __RECALLX_API_BASE__: '/api/v1',
  });
  vi.stubGlobal('fetch', fetchImpl);
}

describe('renderer semantic Home client', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('maps semantic status, filtered issues, and workspace reindex onto the existing API endpoints', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            enabled: false,
            provider: 'disabled',
            model: 'none',
            indexBackend: 'sqlite',
            configuredIndexBackend: 'sqlite-vec',
            extensionStatus: 'fallback',
            extensionLoadError: null,
            chunkEnabled: false,
            workspaceFallbackEnabled: false,
            workspaceFallbackMode: 'strict_zero',
            lastBackfillAt: null,
            counts: {
              pending: 1,
              processing: 0,
              stale: 2,
              ready: 3,
              failed: 1,
            },
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            items: [
              {
                nodeId: 'node_1',
                title: 'Recovery checklist',
                embeddingStatus: 'failed',
                staleReason: 'embedding.provider_not_implemented:openai',
                updatedAt: '2026-03-19T04:00:00.000Z',
              },
            ],
            nextCursor: 'cursor_1',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            queuedNodeIds: ['node_1', 'node_2'],
            queuedCount: 2,
          },
        }),
      } as Response);

    stubRendererGlobals(fetchMock);

    const { getSemanticIssues, getSemanticStatus, queueSemanticReindex } = await import(
      '../app/renderer/src/lib/mockApi.js'
    );

    await expect(getSemanticStatus()).resolves.toMatchObject({
      provider: 'disabled',
      counts: {
        pending: 1,
        failed: 1,
      },
    });
    await expect(
      getSemanticIssues({
        limit: 3,
        cursor: 'cursor_1',
        statuses: ['failed', 'stale'],
      }),
    ).resolves.toMatchObject({
      nextCursor: 'cursor_1',
      items: [
        {
          nodeId: 'node_1',
          embeddingStatus: 'failed',
        },
      ],
    });
    await expect(queueSemanticReindex(20)).resolves.toMatchObject({
      queuedCount: 2,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/semantic/status');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/semantic/issues?limit=3&cursor=cursor_1&statuses=failed%2Cstale');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/semantic/reindex');
  });

  it('uses fallback semantic pagination and updates status after a queued fallback reindex', async () => {
    stubRendererGlobals(vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));

    const { getSemanticIssues, getSemanticStatus, queueSemanticReindex } = await import(
      '../app/renderer/src/lib/mockApi.js'
    );

    const firstPage = await getSemanticIssues({
      limit: 1,
      statuses: ['failed', 'stale'],
    });
    const secondPage = await getSemanticIssues({
      limit: 1,
      cursor: firstPage.nextCursor,
      statuses: ['failed', 'stale'],
    });
    const before = await getSemanticStatus();
    const queued = await queueSemanticReindex(2);
    const after = await getSemanticStatus();

    expect(firstPage.items[0]).toMatchObject({
      embeddingStatus: 'failed',
    });
    expect(secondPage.items[0]).toMatchObject({
      embeddingStatus: 'stale',
    });
    expect(queued).toMatchObject({
      queuedCount: 2,
    });
    expect(after.counts.pending).toBeGreaterThanOrEqual(before.counts.pending);
    expect(after.lastBackfillAt).not.toBeNull();
  });
});
