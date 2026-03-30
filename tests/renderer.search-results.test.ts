import { describe, expect, it } from 'vitest';

import {
  buildRecentSelectableNodeIds,
  buildSearchNodeStub,
  buildSearchResultNodeMap,
  buildSearchSourceOptions,
  filterSearchWorkspaceResults,
  pushRecentEntry,
} from '../app/renderer/src/lib/searchResults.js';
import type { ActivitySearchHit, Node, SearchNodeHit } from '../app/renderer/src/lib/types.js';

function makeSnapshotNode(overrides: Partial<Node> = {}): Node {
  return {
    id: overrides.id ?? 'node_recent',
    type: overrides.type ?? 'note',
    status: overrides.status ?? 'active',
    canonicality: overrides.canonicality ?? 'canonical',
    visibility: overrides.visibility ?? 'normal',
    title: overrides.title ?? 'Recent node',
    body: overrides.body ?? 'Recent body',
    summary: overrides.summary ?? 'Recent summary',
    createdBy: overrides.createdBy ?? 'tester',
    sourceType: overrides.sourceType ?? 'human',
    sourceLabel: overrides.sourceLabel ?? 'tester',
    tags: overrides.tags ?? ['recent'],
    createdAt: overrides.createdAt ?? '2026-03-30T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-03-30T00:00:00.000Z',
    metadata: overrides.metadata ?? {},
  };
}

function makeSearchNodeHit(overrides: Partial<SearchNodeHit> = {}): SearchNodeHit {
  return {
    id: overrides.id ?? 'node_old',
    type: overrides.type ?? 'note',
    title: overrides.title ?? 'Older hit',
    summary: overrides.summary ?? 'Search summary',
    status: overrides.status ?? 'active',
    canonicality: overrides.canonicality ?? 'suggested',
    sourceLabel: overrides.sourceLabel ?? 'search-index',
    updatedAt: overrides.updatedAt ?? '2024-01-10T09:00:00.000Z',
    tags: overrides.tags ?? ['search'],
    matchReason: overrides.matchReason,
    lexicalQuality: overrides.lexicalQuality,
  };
}

function makeActivityHit(overrides: Partial<ActivitySearchHit> = {}): ActivitySearchHit {
  return {
    id: overrides.id ?? 'activity_1',
    targetNodeId: overrides.targetNodeId ?? 'node_activity_only',
    targetNodeTitle: overrides.targetNodeTitle ?? 'Activity target',
    targetNodeType: overrides.targetNodeType ?? 'decision',
    targetNodeStatus: overrides.targetNodeStatus ?? 'draft',
    activityType: overrides.activityType ?? 'review_action',
    body: overrides.body ?? 'Matched activity body',
    sourceLabel: overrides.sourceLabel ?? 'search-index',
    createdAt: overrides.createdAt ?? '2025-12-01T10:15:00.000Z',
  };
}

describe('renderer search result helpers', () => {
  it('keeps recent selection valid for activity-only and node search hits', () => {
    const selectableIds = buildRecentSelectableNodeIds(
      [makeSearchNodeHit({ id: 'node_old_hit' })],
      [makeActivityHit({ targetNodeId: 'node_activity_only_hit' })],
    );

    expect(selectableIds.has('node_old_hit')).toBe(true);
    expect(selectableIds.has('node_activity_only_hit')).toBe(true);
  });

  it('builds preview fallbacks for node and activity hits outside the recent snapshot', () => {
    const snapshotNode = makeSnapshotNode({ id: 'node_recent_only' });
    const searchHit = makeSearchNodeHit({ id: 'node_old_hit', updatedAt: '2024-01-10T09:00:00.000Z' });
    const activityHit = makeActivityHit({ targetNodeId: 'node_activity_only_hit', createdAt: '2025-12-01T10:15:00.000Z' });

    const nodeMap = buildSearchResultNodeMap([snapshotNode], [searchHit], [activityHit]);

    expect(nodeMap.get('node_recent_only')).toEqual(snapshotNode);
    expect(nodeMap.get('node_old_hit')).toMatchObject({
      id: 'node_old_hit',
      summary: 'Search summary',
      updatedAt: '2024-01-10T09:00:00.000Z',
      createdAt: '2024-01-10T09:00:00.000Z',
    });
    expect(nodeMap.get('node_activity_only_hit')).toMatchObject({
      id: 'node_activity_only_hit',
      title: 'Activity target',
      body: 'Matched activity body',
      updatedAt: '2025-12-01T10:15:00.000Z',
    });
  });

  it('does not fabricate a current timestamp for search node previews', () => {
    const stub = buildSearchNodeStub(
      makeSearchNodeHit({
        id: 'node_preserve_time',
        updatedAt: '2021-04-05T06:07:08.000Z',
      }),
    );

    expect(stub.createdAt).toBe('2021-04-05T06:07:08.000Z');
    expect(stub.updatedAt).toBe('2021-04-05T06:07:08.000Z');
  });

  it('builds source options and filters mixed search results with lightweight chips', () => {
    const nodeHits = [
      makeSearchNodeHit({ id: 'project_hit', type: 'project', sourceLabel: 'Codex' }),
      makeSearchNodeHit({ id: 'decision_hit', type: 'decision', sourceLabel: 'human' }),
    ];
    const activityHits = [
      makeActivityHit({ id: 'activity_codex', sourceLabel: 'Codex' }),
      makeActivityHit({ id: 'activity_system', sourceLabel: 'system' }),
    ];

    expect(buildSearchSourceOptions(nodeHits, activityHits)).toEqual(['Codex', 'human', 'system']);

    const filtered = filterSearchWorkspaceResults(nodeHits, activityHits, {
      scope: 'all',
      nodeType: 'project',
      sourceLabel: 'Codex',
    });

    expect(filtered.nodes.map((item) => item.id)).toEqual(['project_hit']);
    expect(filtered.activities.map((item) => item.id)).toEqual(['activity_codex']);
    expect(filtered.total).toBe(2);
  });

  it('keeps recent entries deduplicated and bounded', () => {
    const updated = pushRecentEntry(['Open Graph', 'Open Notes', 'Review Governance'], 'open graph', 3);

    expect(updated).toEqual(['open graph', 'Open Notes', 'Review Governance']);
  });
});
