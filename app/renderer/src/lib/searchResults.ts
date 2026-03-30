import type { ActivitySearchHit, Canonicality, Node, NodeStatus, NodeType, SearchNodeHit } from './types.js';

export type SearchResultScope = 'all' | 'nodes' | 'activities';

function normalizeTitle(title: string | null, fallback: string) {
  return title && title.trim() ? title : fallback;
}

function normalizeSummary(summary: string | null, fallback: string) {
  return summary && summary.trim() ? summary : fallback;
}

function normalizeSourceLabel(sourceLabel: string | null, fallback = 'unknown') {
  return sourceLabel && sourceLabel.trim() ? sourceLabel : fallback;
}

export function mapSearchNodeHit(raw: any): SearchNodeHit {
  return {
    id: raw.id,
    type: raw.type,
    status: raw.status,
    canonicality: raw.canonicality,
    title: typeof raw.title === 'string' ? raw.title : null,
    summary: typeof raw.summary === 'string' ? raw.summary : null,
    sourceLabel: typeof raw.sourceLabel === 'string' ? raw.sourceLabel : null,
    updatedAt: raw.updatedAt ?? raw.updated_at ?? new Date().toISOString(),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    matchReason: raw.matchReason,
    lexicalQuality: raw.lexicalQuality,
  };
}

function buildNodeStub(input: {
  id: string;
  type: NodeType;
  status: NodeStatus;
  canonicality: Canonicality;
  title: string | null;
  summary: string | null;
  sourceLabel: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  body?: string;
}): Node {
  const sourceLabel = normalizeSourceLabel(input.sourceLabel);
  const summary = normalizeSummary(input.summary, 'No summary yet.');
  return {
    id: input.id,
    type: input.type,
    status: input.status,
    canonicality: input.canonicality,
    visibility: 'normal',
    title: normalizeTitle(input.title, input.id),
    body: input.body ?? '',
    summary,
    createdBy: sourceLabel,
    sourceType: 'system',
    sourceLabel,
    tags: input.tags,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    metadata: {},
  };
}

export function buildSearchNodeStub(hit: SearchNodeHit): Node {
  return buildNodeStub({
    id: hit.id,
    type: hit.type,
    status: hit.status,
    canonicality: hit.canonicality,
    title: hit.title,
    summary: hit.summary,
    sourceLabel: hit.sourceLabel,
    tags: hit.tags,
    createdAt: hit.updatedAt,
    updatedAt: hit.updatedAt,
  });
}

export function buildActivityTargetNodeStub(hit: ActivitySearchHit): Node {
  return buildNodeStub({
    id: hit.targetNodeId,
    type: hit.targetNodeType ?? 'note',
    status: hit.targetNodeStatus ?? 'active',
    canonicality: 'suggested',
    title: hit.targetNodeTitle,
    summary: hit.body || 'Matched activity hit.',
    sourceLabel: hit.sourceLabel,
    tags: [],
    createdAt: hit.createdAt,
    updatedAt: hit.createdAt,
    body: hit.body,
  });
}

export function buildSearchResultNodeMap(
  snapshotNodes: Node[],
  searchNodeHits: SearchNodeHit[],
  activityHits: ActivitySearchHit[],
): Map<string, Node> {
  const map = new Map<string, Node>();
  snapshotNodes.forEach((node) => map.set(node.id, node));
  searchNodeHits.forEach((hit) => {
    if (!map.has(hit.id)) {
      map.set(hit.id, buildSearchNodeStub(hit));
    }
  });
  activityHits.forEach((hit) => {
    if (hit.targetNodeId && !map.has(hit.targetNodeId)) {
      map.set(hit.targetNodeId, buildActivityTargetNodeStub(hit));
    }
  });
  return map;
}

export function buildRecentSelectableNodeIds(searchNodeHits: SearchNodeHit[], activityHits: ActivitySearchHit[]): Set<string> {
  const ids = new Set<string>();
  searchNodeHits.forEach((hit) => ids.add(hit.id));
  activityHits.forEach((hit) => {
    if (hit.targetNodeId) {
      ids.add(hit.targetNodeId);
    }
  });
  return ids;
}

export function buildSearchSourceOptions(searchNodeHits: SearchNodeHit[], activityHits: ActivitySearchHit[]): string[] {
  const counts = new Map<string, number>();

  searchNodeHits.forEach((hit) => {
    const label = normalizeSourceLabel(hit.sourceLabel);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });
  activityHits.forEach((hit) => {
    const label = normalizeSourceLabel(hit.sourceLabel);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label]) => label);
}

export function filterSearchWorkspaceResults(
  searchNodeHits: SearchNodeHit[],
  activityHits: ActivitySearchHit[],
  filters: {
    scope: SearchResultScope;
    nodeType: NodeType | 'all';
    sourceLabel: string | 'all';
  },
) {
  const normalizedSourceFilter =
    filters.sourceLabel === 'all' ? null : normalizeSourceLabel(filters.sourceLabel).toLowerCase();

  const nodes =
    filters.scope === 'activities'
      ? []
      : searchNodeHits.filter((hit) => {
          if (filters.nodeType !== 'all' && hit.type !== filters.nodeType) {
            return false;
          }

          if (!normalizedSourceFilter) {
            return true;
          }

          return normalizeSourceLabel(hit.sourceLabel).toLowerCase() === normalizedSourceFilter;
        });

  const activities =
    filters.scope === 'nodes'
      ? []
      : activityHits.filter((hit) => {
          if (!normalizedSourceFilter) {
            return true;
          }

          return normalizeSourceLabel(hit.sourceLabel).toLowerCase() === normalizedSourceFilter;
        });

  return {
    nodes,
    activities,
    total: nodes.length + activities.length,
  };
}

export function pushRecentEntry(entries: string[], value: string, limit = 5): string[] {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return entries.slice(0, limit);
  }

  const normalizedValue = trimmedValue.toLowerCase();
  return [trimmedValue, ...entries.filter((entry) => entry.trim().toLowerCase() !== normalizedValue)].slice(0, limit);
}
