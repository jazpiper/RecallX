import { mockWorkspace } from './mockWorkspace';
import type {
  Activity,
  Artifact,
  GraphConnection,
  Integration,
  Node,
  Relation,
  ReviewSettings,
  ReviewQueueItem,
  ContextBundlePreviewItem,
  SemanticIssueItem,
  SemanticIssuePage,
  SemanticStatusSummary,
  Workspace,
  WorkspaceCatalogItem,
  WorkspaceSeed,
} from './types';

const API_BASE =
  (window as Window & { __MEMFORGE_API_BASE__?: string }).__MEMFORGE_API_BASE__ ?? '/api/v1';
const DEFAULT_SOURCE = {
  actorType: 'human',
  actorLabel: 'memforge-renderer',
  toolName: 'memforge-renderer',
  toolVersion: '0.1.0',
} as const;
let rendererToken: string | null = null;

class ApiRequestError extends Error {
  kind: 'http' | 'network';
  status: number;

  constructor(kind: 'http' | 'network', status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface BootstrapInfo {
  workspace: Workspace;
  authMode: Workspace['authMode'];
  hasToken: boolean;
  semantic: SemanticStatusSummary;
}

export interface WorkspaceCatalog {
  current: Workspace;
  items: WorkspaceCatalogItem[];
}

export interface WorkspaceEvent {
  type: 'workspace.updated';
  reason: string;
  entityType?: 'node' | 'relation' | 'activity' | 'artifact' | 'review' | 'workspace' | 'integration' | 'settings';
  entityId?: string;
  workspaceRoot: string;
  at: string;
}

const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  autoApproveLowRisk: true,
  trustedSourceToolNames: [],
};

function cloneWorkspace(seed: WorkspaceSeed) {
  return structuredClone(seed);
}

const fallbackState = cloneWorkspace(mockWorkspace);

function mapWorkspace(payload: any): Workspace {
  const data = payload?.data ?? payload;
  return {
    name: data.workspaceName ?? data.name ?? 'Memforge',
    rootPath: data.rootPath ?? data.workspaceRoot ?? '',
    schemaVersion: data.schemaVersion ?? 1,
    apiBind: data.bindAddress ?? data.apiBind ?? '127.0.0.1:8787',
    integrationModes: data.enabledIntegrationModes ?? data.integrationModes ?? ['read-only', 'append-only'],
    authMode: data.authMode === 'bearer' ? 'bearer' : 'optional',
  };
}

function mapWorkspaceCatalogItem(raw: any): WorkspaceCatalogItem {
  const workspace = mapWorkspace(raw);
  return {
    ...workspace,
    isCurrent: Boolean(raw?.isCurrent),
    lastOpenedAt: raw?.lastOpenedAt ?? new Date().toISOString(),
  };
}

function defaultSemanticStatus(): SemanticStatusSummary {
  return {
    enabled: false,
    provider: 'disabled',
    model: 'none',
    chunkEnabled: false,
    lastBackfillAt: null,
    counts: {
      pending: 0,
      processing: 0,
      stale: 0,
      ready: 0,
      failed: 0,
    },
  };
}

function mapSemanticStatus(raw: any): SemanticStatusSummary {
  const fallback = defaultSemanticStatus();
  const counts = raw?.counts ?? {};
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    provider: typeof raw?.provider === 'string' ? raw.provider : fallback.provider,
    model: typeof raw?.model === 'string' ? raw.model : fallback.model,
    chunkEnabled: typeof raw?.chunkEnabled === 'boolean' ? raw.chunkEnabled : fallback.chunkEnabled,
    lastBackfillAt: typeof raw?.lastBackfillAt === 'string' ? raw.lastBackfillAt : fallback.lastBackfillAt,
    counts: {
      pending: typeof counts.pending === 'number' ? counts.pending : fallback.counts.pending,
      processing: typeof counts.processing === 'number' ? counts.processing : fallback.counts.processing,
      stale: typeof counts.stale === 'number' ? counts.stale : fallback.counts.stale,
      ready: typeof counts.ready === 'number' ? counts.ready : fallback.counts.ready,
      failed: typeof counts.failed === 'number' ? counts.failed : fallback.counts.failed,
    },
  };
}

function mapNode(raw: any): Node {
  return {
    id: raw.id,
    type: raw.type,
    status: raw.status,
    canonicality: raw.canonicality,
    visibility: raw.visibility ?? 'normal',
    title: raw.title ?? 'Untitled',
    body: raw.body ?? '',
    summary: raw.summary ?? 'No summary yet.',
    createdBy: raw.createdBy ?? raw.created_by ?? raw.sourceLabel ?? 'unknown',
    sourceType: raw.sourceType ?? raw.source_type ?? 'system',
    sourceLabel: raw.sourceLabel ?? raw.source_label ?? 'system',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    updatedAt: raw.updatedAt ?? raw.updated_at ?? raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    metadata: raw.metadata ?? {},
  };
}

function mapActivity(raw: any): Activity {
  return {
    id: raw.id,
    targetNodeId: raw.targetNodeId ?? raw.target_node_id,
    activityType: raw.activityType ?? raw.activity_type,
    body: raw.body ?? '',
    createdBy: raw.createdBy ?? raw.created_by ?? raw.sourceLabel ?? 'unknown',
    sourceType: raw.sourceType ?? raw.source_type ?? 'system',
    sourceLabel: raw.sourceLabel ?? raw.source_label ?? 'system',
    createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    metadata: raw.metadata ?? {},
  };
}

function mapRelation(raw: any): Relation {
  return {
    id: raw.id,
    fromNodeId: raw.fromNodeId ?? raw.from_node_id,
    toNodeId: raw.toNodeId ?? raw.to_node_id,
    relationType: raw.relationType ?? raw.relation_type,
    status: raw.status,
    createdBy: raw.createdBy ?? raw.created_by ?? raw.sourceLabel ?? 'unknown',
    sourceType: raw.sourceType ?? raw.source_type ?? 'system',
    sourceLabel: raw.sourceLabel ?? raw.source_label ?? 'system',
    createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    metadata: raw.metadata ?? {},
  };
}

function mapArtifact(raw: any): Artifact {
  return {
    id: raw.id,
    nodeId: raw.nodeId ?? raw.node_id,
    path: raw.path,
    mimeType: raw.mimeType ?? raw.mime_type ?? 'application/octet-stream',
    sizeBytes: raw.sizeBytes ?? raw.size_bytes ?? 0,
    checksum: raw.checksum ?? '',
    createdBy: raw.createdBy ?? raw.created_by ?? raw.sourceLabel ?? 'unknown',
    sourceLabel: raw.sourceLabel ?? raw.source_label ?? 'system',
    createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    metadata: raw.metadata ?? {},
  };
}

function mapReviewItem(raw: any): ReviewQueueItem {
  return {
    id: raw.id,
    entityType: raw.entityType ?? raw.entity_type,
    entityId: raw.entityId ?? raw.entity_id,
    reviewType: raw.reviewType ?? raw.review_type,
    proposedBy: raw.proposedBy ?? raw.proposed_by ?? 'system',
    createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    status: raw.status,
    notes: raw.notes ?? '',
    metadata: raw.metadata ?? {},
  };
}

function mapIntegration(raw: any): Integration {
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind,
    status: raw.status ?? 'active',
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : [],
    updatedAt: raw.updatedAt ?? raw.updated_at ?? raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
  };
}

async function requestJson(path: string, init?: RequestInit) {
  const token = getRendererToken();
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
      ...init,
    });
  } catch (error) {
    throw new ApiRequestError('network', 0, error instanceof Error ? error.message : 'Network request failed.');
  }

  if (!response.ok) {
    throw new ApiRequestError('http', response.status, `Request failed: ${response.status}`);
  }

  return response.json();
}

async function withFallback<T>(remote: () => Promise<T>, fallback: () => Promise<T> | T): Promise<T> {
  try {
    return await remote();
  } catch (error) {
    if (error instanceof ApiRequestError && error.kind === 'network') {
      return await fallback();
    }
    throw error;
  }
}

function getRendererToken(): string | null {
  const globalToken = (window as Window & { __MEMFORGE_API_TOKEN__?: string }).__MEMFORGE_API_TOKEN__;
  if (globalToken) {
    return globalToken;
  }

  return rendererToken;
}

export function saveRendererToken(token: string) {
  rendererToken = token;
}

export function clearRendererToken() {
  rendererToken = null;
}

export function isAuthError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

function buildEventStreamUrl() {
  return `${API_BASE}/events`;
}

function fallbackSnapshot(): WorkspaceSeed {
  return cloneWorkspace(fallbackState);
}

export async function getWorkspace(): Promise<Workspace> {
  return withFallback(
    async () => {
      const payload = await requestJson('/workspace');
      return mapWorkspace(payload);
    },
    async () => fallbackState.workspace,
  );
}

export async function getWorkspaceCatalog(): Promise<WorkspaceCatalog> {
  return withFallback(
    async () => {
      const payload = await requestJson('/workspaces');
      return {
        current: mapWorkspace(payload?.data?.current),
        items: ((payload?.data?.items ?? []) as any[]).map(mapWorkspaceCatalogItem),
      };
    },
    async () => ({
      current: fallbackState.workspace,
      items: [
        {
          ...fallbackState.workspace,
          isCurrent: true,
          lastOpenedAt: new Date().toISOString(),
        },
      ],
    }),
  );
}

export async function getBootstrap(): Promise<BootstrapInfo> {
  return withFallback(
    async () => {
      const payload = await requestJson('/bootstrap');
      const data = payload?.data ?? payload;
      const workspace = mapWorkspace(data.workspace ?? data);
      return {
        workspace,
        authMode: data.authMode === 'bearer' ? 'bearer' : workspace.authMode,
        hasToken: Boolean(getRendererToken()),
        semantic: mapSemanticStatus(data.semantic),
      };
    },
    async () => ({
      workspace: fallbackState.workspace,
      authMode: 'optional',
      hasToken: false,
      semantic: defaultSemanticStatus(),
    }),
  );
}

export async function getSemanticStatus(): Promise<SemanticStatusSummary> {
  return withFallback(
    async () => {
      const payload = await requestJson('/semantic/status');
      return mapSemanticStatus(payload?.data ?? payload);
    },
    async () => defaultSemanticStatus(),
  );
}

export async function getSemanticIssues(options?: {
  limit?: number;
  cursor?: string | null;
  statuses?: Array<'pending' | 'stale' | 'failed'>;
}): Promise<SemanticIssuePage> {
  return withFallback(
    async () => {
      const params = new URLSearchParams();
      params.set('limit', String(Math.min(Math.max(options?.limit ?? 5, 1), 25)));
      if (options?.cursor) {
        params.set('cursor', options.cursor);
      }
      if (options?.statuses?.length) {
        params.set('statuses', options.statuses.join(','));
      }
      const payload = await requestJson(`/semantic/issues?${params.toString()}`);
      const items = Array.isArray(payload?.data?.items)
        ? payload.data.items
            .filter((item: any) => item && typeof item.nodeId === 'string')
            .map((item: any) => ({
              nodeId: item.nodeId,
              title: typeof item.title === 'string' ? item.title : null,
              embeddingStatus:
                item.embeddingStatus === 'pending' ||
                item.embeddingStatus === 'processing' ||
                item.embeddingStatus === 'stale' ||
                item.embeddingStatus === 'ready' ||
                item.embeddingStatus === 'failed'
                  ? item.embeddingStatus
                  : 'pending',
              staleReason: typeof item.staleReason === 'string' ? item.staleReason : null,
              updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
            }))
        : [];
      return {
        items,
        nextCursor: typeof payload?.data?.nextCursor === 'string' ? payload.data.nextCursor : null,
      };
    },
    async () => ({
      items: [],
      nextCursor: null,
    }),
  );
}

export async function getContextBundlePreview(targetId: string): Promise<ContextBundlePreviewItem[]> {
  return withFallback(
    async () => {
      const payload = await requestJson('/context/bundles', {
        method: 'POST',
        body: JSON.stringify({
          target: {
            type: 'node',
            id: targetId,
          },
          mode: 'compact',
          preset: 'for-assistant',
          options: {
            includeRelated: true,
            includeInferred: true,
            includeRecentActivities: false,
            includeDecisions: true,
            includeOpenQuestions: true,
            maxInferred: 4,
            maxItems: 6,
          },
        }),
      });

      return Array.isArray(payload?.data?.bundle?.items)
        ? payload.data.bundle.items
            .filter((item: any) => item && typeof item.nodeId === 'string' && item.nodeId !== targetId)
            .map((item: any) => ({
              nodeId: item.nodeId,
              type: item.type,
              title: typeof item.title === 'string' ? item.title : null,
              summary: typeof item.summary === 'string' ? item.summary : null,
              reason: typeof item.reason === 'string' ? item.reason : 'Included for context',
              relationId: typeof item.relationId === 'string' ? item.relationId : undefined,
              relationType: typeof item.relationType === 'string' ? item.relationType : undefined,
              relationSource:
                item.relationSource === 'canonical' || item.relationSource === 'inferred'
                  ? item.relationSource
                  : undefined,
              relationScore: typeof item.relationScore === 'number' ? item.relationScore : undefined,
              retrievalRank: typeof item.retrievalRank === 'number' ? item.retrievalRank : undefined,
              semanticSimilarity: typeof item.semanticSimilarity === 'number' ? item.semanticSimilarity : undefined,
              generator: typeof item.generator === 'string' ? item.generator : null,
            }))
        : [];
    },
    async () => [],
  );
}

export async function appendRelationUsageEvent(input: {
  relationId: string;
  relationSource: 'canonical' | 'inferred';
  eventType: 'bundle_clicked';
  sessionId?: string;
  delta: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await requestJson('/relation-usage-events', {
    method: 'POST',
    body: JSON.stringify({
      relationId: input.relationId,
      relationSource: input.relationSource,
      eventType: input.eventType,
      sessionId: input.sessionId,
      delta: input.delta,
      source: DEFAULT_SOURCE,
      metadata: input.metadata ?? {},
    }),
  });
}

export async function queueSemanticReindex(limit = 250): Promise<{ queuedNodeIds: string[]; queuedCount: number }> {
  const payload = await requestJson('/semantic/reindex', {
    method: 'POST',
    body: JSON.stringify({ limit }),
  });
  return {
    queuedNodeIds: Array.isArray(payload?.data?.queuedNodeIds) ? payload.data.queuedNodeIds : [],
    queuedCount: typeof payload?.data?.queuedCount === 'number' ? payload.data.queuedCount : 0,
  };
}

export async function queueSemanticReindexForNode(nodeId: string): Promise<{ nodeId: string; queued: boolean }> {
  const payload = await requestJson(`/semantic/reindex/${encodeURIComponent(nodeId)}`, {
    method: 'POST',
  });
  return {
    nodeId: typeof payload?.data?.nodeId === 'string' ? payload.data.nodeId : nodeId,
    queued: Boolean(payload?.data?.queued),
  };
}

export async function getReviewSettings(): Promise<ReviewSettings> {
  return withFallback(
    async () => {
      const payload = await requestJson('/settings?keys=review.autoApproveLowRisk,review.trustedSourceToolNames');
      const values = payload?.data?.values ?? {};
      return {
        autoApproveLowRisk:
          typeof values['review.autoApproveLowRisk'] === 'boolean'
            ? values['review.autoApproveLowRisk']
            : DEFAULT_REVIEW_SETTINGS.autoApproveLowRisk,
        trustedSourceToolNames: Array.isArray(values['review.trustedSourceToolNames'])
          ? values['review.trustedSourceToolNames'].filter((value: unknown): value is string => typeof value === 'string')
          : DEFAULT_REVIEW_SETTINGS.trustedSourceToolNames,
      };
    },
    async () => DEFAULT_REVIEW_SETTINGS,
  );
}

export async function updateReviewSettings(input: ReviewSettings): Promise<ReviewSettings> {
  const payload = await requestJson('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      values: {
        'review.autoApproveLowRisk': input.autoApproveLowRisk,
        'review.trustedSourceToolNames': input.trustedSourceToolNames,
      },
    }),
  });
  const values = payload?.data?.values ?? {};
  return {
    autoApproveLowRisk:
      typeof values['review.autoApproveLowRisk'] === 'boolean'
        ? values['review.autoApproveLowRisk']
        : input.autoApproveLowRisk,
    trustedSourceToolNames: Array.isArray(values['review.trustedSourceToolNames'])
      ? values['review.trustedSourceToolNames'].filter((value: unknown): value is string => typeof value === 'string')
      : input.trustedSourceToolNames,
  };
}

export async function createWorkspace(input: { rootPath: string; workspaceName?: string }): Promise<WorkspaceCatalog> {
  const payload = await requestJson('/workspaces', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return {
    current: mapWorkspace(payload?.data?.current),
    items: ((payload?.data?.items ?? []) as any[]).map(mapWorkspaceCatalogItem),
  };
}

export async function openWorkspace(rootPath: string): Promise<WorkspaceCatalog> {
  const payload = await requestJson('/workspaces/open', {
    method: 'POST',
    body: JSON.stringify({ rootPath }),
  });
  return {
    current: mapWorkspace(payload?.data?.current),
    items: ((payload?.data?.items ?? []) as any[]).map(mapWorkspaceCatalogItem),
  };
}

export async function getSnapshot(): Promise<WorkspaceSeed> {
  return withFallback(
    async () => {
      const [workspacePayload, nodesPayload, reviewsPayload, integrationsPayload] = await Promise.all([
        requestJson('/workspace'),
        requestJson('/nodes/search', {
          method: 'POST',
          body: JSON.stringify({
            query: '',
            filters: {},
            limit: 50,
            offset: 0,
            sort: 'updated_at',
          }),
        }),
        requestJson('/review-queue?status=pending&limit=20'),
        requestJson('/integrations'),
      ]);

      const nodes = ((nodesPayload?.data?.items ?? []) as any[]).map(mapNode);
      const reviewQueue = ((reviewsPayload?.data?.items ?? []) as any[]).map(mapReviewItem);
      const integrations = ((integrationsPayload?.data?.items ?? []) as any[]).map(mapIntegration);
      const recentNodeIds = [...nodes]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 5)
        .map((node) => node.id);
      const pinnedProjectIds = nodes.filter((node) => node.type === 'project').slice(0, 3).map((node) => node.id);

      return {
        workspace: mapWorkspace(workspacePayload),
        nodes,
        relations: [],
        activities: [],
        artifacts: [],
        reviewQueue,
        integrations,
        pinnedProjectIds,
        recentNodeIds,
      };
    },
    async () => fallbackSnapshot(),
  );
}

export async function searchNodes(query: string): Promise<Node[]> {
  return withFallback(
    async () => {
      const payload = await requestJson('/nodes/search', {
        method: 'POST',
        body: JSON.stringify({
          query,
          filters: {},
          limit: 20,
          offset: 0,
          sort: query.trim() ? 'relevance' : 'updated_at',
        }),
      });
      return ((payload?.data?.items ?? []) as any[]).map(mapNode);
    },
    async () => {
      const normalized = query.trim().toLowerCase();
      return fallbackState.nodes.filter((node) => {
        if (!normalized) return node.status !== 'archived';
        const haystack = [node.title, node.summary, node.body, node.tags.join(' '), node.sourceLabel, node.type]
          .join(' ')
          .toLowerCase();
        return haystack.includes(normalized);
      });
    },
  );
}

export async function getNode(id: string): Promise<Node | undefined> {
  return withFallback(
    async () => {
      const payload = await requestJson(`/nodes/${encodeURIComponent(id)}`);
      return mapNode(payload?.data?.node);
    },
    async () => fallbackState.nodes.find((node) => node.id === id),
  );
}

export async function getRelatedNodes(id: string): Promise<Node[]> {
  return withFallback(
    async () => {
      const payload = await requestJson(`/nodes/${encodeURIComponent(id)}/related`);
      return ((payload?.data?.items ?? []) as any[]).map((item) => mapNode(item.node));
    },
    async () => {
      const linked = fallbackState.relations
        .filter((relation) => relation.fromNodeId === id || relation.toNodeId === id)
        .map((relation) => (relation.fromNodeId === id ? relation.toNodeId : relation.fromNodeId));
      return fallbackState.nodes.filter((node) => linked.includes(node.id) && node.status !== 'archived');
    },
  );
}

export async function getRelatedConnections(id: string): Promise<GraphConnection[]> {
  return withFallback(
    async () => {
      const payload = await requestJson(`/nodes/${encodeURIComponent(id)}/neighborhood?include_inferred=1&max_inferred=4`);
      return ((payload?.data?.items ?? []) as any[]).map((item) => {
        const node = mapNode(item.node);
        const edge = item.edge ?? {};
        const relation: Relation = {
          id: edge.relationId ?? edge.relation_id ?? `edge:${id}:${node.id}:${edge.relationType ?? edge.relation_type ?? 'related_to'}`,
          fromNodeId: edge.direction === 'incoming' ? node.id : id,
          toNodeId: edge.direction === 'incoming' ? id : node.id,
          relationType: edge.relationType ?? edge.relation_type ?? 'related_to',
          status: edge.relationStatus ?? edge.relation_status ?? 'active',
          createdBy: edge.generator ?? edge.relationSource ?? 'memforge',
          sourceType: edge.relationSource === 'inferred' ? 'system' : 'human',
          sourceLabel:
            edge.relationSource === 'inferred'
              ? `inferred:${edge.generator ?? 'derived'}`
              : 'canonical',
          createdAt: new Date().toISOString(),
          metadata: {},
        };
        return {
          node,
          relation,
          direction: edge.direction === 'incoming' ? 'incoming' : 'outgoing',
          hop: 1 as const,
        };
      });
    },
    async () => {
      const items = fallbackState.relations
        .filter((relation) => (relation.fromNodeId === id || relation.toNodeId === id) && relation.status !== 'archived')
        .map((relation) => {
          const relatedId = relation.fromNodeId === id ? relation.toNodeId : relation.fromNodeId;
          const node = fallbackState.nodes.find((item) => item.id === relatedId);
          if (!node || node.status === 'archived') {
            return null;
          }
          return {
            node,
            relation,
            direction: relation.fromNodeId === id ? ('outgoing' as const) : ('incoming' as const),
            hop: 1 as const,
          };
        });

      return items.filter((item): item is NonNullable<(typeof items)[number]> => item !== null);
    },
  );
}

export async function getGraphNeighborhood(id: string, hops: 1 | 2): Promise<GraphConnection[]> {
  const firstHop = await getRelatedConnections(id);
  if (hops === 1) {
    return firstHop;
  }

  const secondHopGroups = await Promise.all(
    firstHop.map(async (connection) => {
      const nested = await getRelatedConnections(connection.node.id);
      return nested
        .filter((item) => item.node.id !== id)
        .map((item) => ({
          ...item,
          hop: 2 as const,
          viaNodeId: connection.node.id,
          viaNodeTitle: connection.node.title,
        }));
    }),
  );

  const merged = [...firstHop];
  const seen = new Set(firstHop.map((item) => `${item.relation.id}:${item.node.id}:1`));

  secondHopGroups.flat().forEach((item) => {
    const key = `${item.relation.id}:${item.node.id}:${item.viaNodeId ?? 'direct'}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(item);
  });

  return merged;
}

export async function getRecentNodes(): Promise<Node[]> {
  const snapshot = await getSnapshot();
  return snapshot.recentNodeIds
    .map((id) => snapshot.nodes.find((node) => node.id === id))
    .filter((node): node is Node => Boolean(node));
}

export async function getPinnedNodes(): Promise<Node[]> {
  const snapshot = await getSnapshot();
  return snapshot.pinnedProjectIds
    .map((id) => snapshot.nodes.find((node) => node.id === id))
    .filter((node): node is Node => Boolean(node));
}

export async function getActivities(nodeId?: string): Promise<Activity[]> {
  return withFallback(
    async () => {
      if (!nodeId) {
        return [];
      }
      const payload = await requestJson(`/nodes/${encodeURIComponent(nodeId)}/activities?limit=20`);
      return ((payload?.data?.items ?? []) as any[]).map(mapActivity);
    },
    async () =>
      nodeId ? fallbackState.activities.filter((activity) => activity.targetNodeId === nodeId) : fallbackState.activities,
  );
}

export async function getArtifacts(nodeId?: string): Promise<Artifact[]> {
  return withFallback(
    async () => {
      if (!nodeId) {
        return [];
      }
      const payload = await requestJson(`/nodes/${encodeURIComponent(nodeId)}/artifacts`);
      return ((payload?.data?.items ?? []) as any[]).map(mapArtifact);
    },
    async () => (nodeId ? fallbackState.artifacts.filter((artifact) => artifact.nodeId === nodeId) : fallbackState.artifacts),
  );
}

export async function getReviewQueue(): Promise<ReviewQueueItem[]> {
  return withFallback(
    async () => {
      const payload = await requestJson('/review-queue?status=pending&limit=20');
      return ((payload?.data?.items ?? []) as any[]).map(mapReviewItem);
    },
    async () => fallbackState.reviewQueue,
  );
}

export async function approveReview(id: string): Promise<void> {
  await requestJson(`/review-queue/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ source: DEFAULT_SOURCE }),
  });
}

export async function rejectReview(id: string): Promise<void> {
  await requestJson(`/review-queue/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ source: DEFAULT_SOURCE }),
  });
}

export function subscribeWorkspaceEvents(handlers: {
  onWorkspaceUpdate?: (event: WorkspaceEvent) => void;
  onError?: () => void;
}): () => void {
  if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
    return () => {};
  }

  const stream = new window.EventSource(buildEventStreamUrl());
  const handleWorkspaceUpdate = (event: MessageEvent<string>) => {
    try {
      handlers.onWorkspaceUpdate?.(JSON.parse(event.data) as WorkspaceEvent);
    } catch {
      // Ignore malformed events and keep the stream open.
    }
  };

  stream.addEventListener('workspace.updated', handleWorkspaceUpdate as EventListener);
  stream.onerror = () => {
    handlers.onError?.();
  };

  return () => {
    stream.removeEventListener('workspace.updated', handleWorkspaceUpdate as EventListener);
    stream.close();
  };
}

export async function getRelations(): Promise<Relation[]> {
  const snapshot = await getSnapshot();
  return snapshot.relations;
}

export async function createNode(input: {
  type: Node['type'];
  title: string;
  body: string;
  tags?: string[];
}): Promise<Node> {
  const payload = await requestJson('/nodes', {
    method: 'POST',
    body: JSON.stringify({
      type: input.type,
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      source: DEFAULT_SOURCE,
      metadata: {
        createdFrom: 'renderer-quick-capture',
      },
    }),
  });
  return mapNode(payload?.data?.node);
}

export async function refreshNodeSummary(id: string): Promise<Node> {
  const payload = await requestJson(`/nodes/${encodeURIComponent(id)}/refresh-summary`, {
    method: 'POST',
    body: JSON.stringify({ source: DEFAULT_SOURCE }),
  });
  return mapNode(payload?.data?.node);
}
