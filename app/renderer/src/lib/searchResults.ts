import type { ActivitySearchHit, Canonicality, Node, NodeStatus, NodeType, SearchNodeHit } from './types.js';

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
