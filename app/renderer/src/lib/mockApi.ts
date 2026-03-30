import { mockWorkspace } from './mockWorkspace';
import type {
  ActivitySearchHit,
  Activity,
  Artifact,
  GovernanceEventRecord,
  GovernanceIssueItem,
  GovernancePayload,
  GovernanceStateRecord,
  GraphConnection,
  Integration,
  NodeDetail,
  Node,
  ProjectGraphPayload,
  Relation,
  ContextBundlePreviewItem,
  SearchNodeHit,
  Workspace,
  WorkspaceBackupRecord,
  WorkspaceCatalogItem,
  WorkspaceExportRecord,
  WorkspaceImportRecord,
  WorkspaceRestoreResult,
  WorkspaceSeed,
} from './types';
import { RECALLX_VERSION } from '../../../shared/version';
import { mapSearchNodeHit } from './searchResults';

type LandingInfo = {
  storedAs: 'node' | 'relation' | 'activity';
  canonicality?: string;
  status: string;
  governanceState: 'healthy' | 'low_confidence' | 'contested' | null;
  reason: string;
};

const API_BASE =
  (window as Window & { __RECALLX_API_BASE__?: string }).__RECALLX_API_BASE__ ?? '/api/v1';
const DEFAULT_SOURCE = {
  actorType: 'human',
  actorLabel: 'recallx-renderer',
  toolName: 'recallx-renderer',
  toolVersion: RECALLX_VERSION,
} as const;
let rendererToken: string | null = null;
const fallbackSettings = new Map<string, unknown>();

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
}

export interface WorkspaceCatalog {
  current: Workspace;
  items: WorkspaceCatalogItem[];
}

export interface WorkspaceEvent {
  type: 'workspace.updated';
  reason: string;
  entityType?: 'node' | 'relation' | 'activity' | 'artifact' | 'workspace' | 'integration' | 'settings';
  entityId?: string;
  workspaceRoot: string;
  at: string;
}

function cloneWorkspace(seed: WorkspaceSeed) {
  return structuredClone(seed);
}

let fallbackState: WorkspaceSeed | null = null;

function getFallbackState() {
  if (!fallbackState) {
    fallbackState = cloneWorkspace(mockWorkspace);
  }
  return fallbackState;
}

function mapWorkspace(payload: any): Workspace {
  const data = payload?.data ?? payload;
  return {
    name: data.workspaceName ?? data.name ?? 'RecallX',
    rootPath: data.rootPath ?? data.workspaceRoot ?? '',
    schemaVersion: data.schemaVersion ?? 1,
    apiBind: data.bindAddress ?? data.apiBind ?? '127.0.0.1:8787',
    integrationModes: data.enabledIntegrationModes ?? data.integrationModes ?? ['read-only', 'append-only'],
    authMode: data.authMode === 'bearer' ? 'bearer' : 'optional',
    paths: data.paths
      ? {
          dbPath: data.paths.dbPath ?? '',
          artifactsDir: data.paths.artifactsDir ?? '',
          exportsDir: data.paths.exportsDir ?? '',
          importsDir: data.paths.importsDir ?? '',
          backupsDir: data.paths.backupsDir ?? '',
          configDir: data.paths.configDir ?? '',
          cacheDir: data.paths.cacheDir ?? '',
        }
      : undefined,
    safety: data.safety
      ? {
          machineId: data.safety.machineId ?? 'unknown-machine',
          sessionId: data.safety.sessionId ?? 'unknown-session',
          lastOpenedAt: data.safety.lastOpenedAt ?? new Date().toISOString(),
          lastCleanCloseAt: data.safety.lastCleanCloseAt ?? null,
          lockPresent: Boolean(data.safety.lockPresent),
          lockUpdatedAt: data.safety.lockUpdatedAt ?? null,
          activeSessionMachineId: data.safety.activeSessionMachineId ?? null,
          warnings: Array.isArray(data.safety.warnings)
            ? data.safety.warnings.map((warning: any) => ({
                code: warning?.code ?? 'unclean_shutdown',
                message: warning?.message ?? 'Workspace safety warning.',
              }))
            : [],
        }
      : undefined,
  };
}

function readPayloadData<T = any>(payload: any): T {
  return payload?.data ?? payload;
}

function readPayloadItems(payload: any): any[] {
  const data = readPayloadData(payload);
  return Array.isArray(data?.items) ? data.items : [];
}

function readBundleItems(payload: any): any[] {
  const data = readPayloadData(payload);
  return Array.isArray(data?.bundle?.items) ? data.bundle.items : [];
}

function mapPayloadItems<T>(payload: any, mapper: (raw: any) => T): T[] {
  return readPayloadItems(payload).map(mapper);
}

function mapWorkspaceCatalogItem(raw: any): WorkspaceCatalogItem {
  const workspace = mapWorkspace(raw);
  return {
    ...workspace,
    isCurrent: Boolean(raw?.isCurrent),
    lastOpenedAt: raw?.lastOpenedAt ?? new Date().toISOString(),
  };
}

function mapWorkspaceCatalogItems(rawItems: unknown): WorkspaceCatalogItem[] {
  return Array.isArray(rawItems) ? rawItems.map(mapWorkspaceCatalogItem) : [];
}

function mapWorkspaceCatalogResponse(payload: any): WorkspaceCatalog {
  const data = readPayloadData(payload);
  return {
    current: mapWorkspace(data?.current),
    items: mapWorkspaceCatalogItems(data?.items),
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

function mapGovernanceState(raw: any): GovernanceStateRecord {
  return {
    entityType: raw.entityType ?? raw.entity_type,
    entityId: raw.entityId ?? raw.entity_id,
    state: raw.state ?? 'healthy',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
    reasons: Array.isArray(raw.reasons) ? raw.reasons : [],
    lastEvaluatedAt: raw.lastEvaluatedAt ?? raw.last_evaluated_at ?? new Date().toISOString(),
    lastTransitionAt: raw.lastTransitionAt ?? raw.last_transition_at ?? new Date().toISOString(),
    metadata: raw.metadata ?? {},
  };
}

function mapGovernanceIssue(raw: any): GovernanceIssueItem {
  const state = mapGovernanceState(raw);
  return {
    ...state,
    title: raw.title ?? raw.display_title ?? `${state.entityType}:${state.entityId}`,
    subtitle: raw.subtitle ?? raw.display_subtitle ?? '',
  };
}

function mapGovernanceEvent(raw: any): GovernanceEventRecord {
  return {
    id: raw.id ?? `gov-event:${raw.entityType ?? raw.entity_type}:${raw.entityId ?? raw.entity_id}:${raw.eventType ?? raw.event_type ?? 'evaluated'}`,
    entityType: raw.entityType ?? raw.entity_type ?? 'node',
    entityId: raw.entityId ?? raw.entity_id,
    eventType: raw.eventType ?? raw.event_type ?? 'evaluated',
    previousState: raw.previousState ?? raw.previous_state ?? null,
    nextState: raw.nextState ?? raw.next_state ?? 'healthy',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
    reason: raw.reason ?? 'No governance reason available.',
    createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    metadata: raw.metadata ?? {},
  };
}

function mapGovernancePayload(raw: any): GovernancePayload {
  return {
    state: raw?.state ? mapGovernanceState(raw.state) : null,
    events: Array.isArray(raw?.events) ? raw.events.map(mapGovernanceEvent) : [],
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

function buildWorkspaceCatalog(workspace: Workspace, lastOpenedAt = new Date().toISOString()): WorkspaceCatalog {
  return {
    current: workspace,
    items: [
      {
        ...workspace,
        isCurrent: true,
        lastOpenedAt,
      },
    ],
  };
}

function buildFallbackGovernanceState(node: Node): GovernanceStateRecord {
  if (node.status === 'contested') {
    return {
      entityType: 'node',
      entityId: node.id,
      state: 'contested',
      confidence: 0.22,
      reasons: ['Historical contradiction or migration pressure is still attached to this node.'],
      lastEvaluatedAt: node.updatedAt,
      lastTransitionAt: node.updatedAt,
      metadata: {
        source: 'fallback',
      },
    };
  }

  if (node.canonicality === 'suggested' || node.canonicality === 'generated') {
    return {
      entityType: 'node',
      entityId: node.id,
      state: 'low_confidence',
      confidence: 0.56,
      reasons: ['Suggested or generated content still needs repeated local confirmation signals.'],
      lastEvaluatedAt: node.updatedAt,
      lastTransitionAt: node.updatedAt,
      metadata: {
        source: 'fallback',
      },
    };
  }

  return {
    entityType: 'node',
    entityId: node.id,
    state: 'healthy',
    confidence: 0.86,
    reasons: ['Canonical or appended content is currently stable in the fallback workspace.'],
    lastEvaluatedAt: node.updatedAt,
    lastTransitionAt: node.updatedAt,
    metadata: {
      source: 'fallback',
    },
  };
}

function buildFallbackGovernanceEvents(node: Node, state: GovernanceStateRecord): GovernanceEventRecord[] {
  return [
    {
      id: `gov-fallback:${node.id}`,
      entityType: 'node',
      entityId: node.id,
      eventType: state.state === 'contested' ? 'contested' : 'evaluated',
      previousState: null,
      nextState: state.state,
      confidence: state.confidence,
      reason: state.reasons[0] ?? 'Fallback governance evaluation.',
      createdAt: node.updatedAt,
      metadata: {
        source: 'fallback',
      },
    },
  ];
}

function buildFallbackNodeDetail(node: Node): NodeDetail {
  const governanceState = buildFallbackGovernanceState(node);
  const fallback = getFallbackState();
  return {
    node,
    related: fallback.relations
      .filter((relation) => relation.fromNodeId === node.id || relation.toNodeId === node.id)
      .map((relation) => (relation.fromNodeId === node.id ? relation.toNodeId : relation.fromNodeId))
      .map((relatedId) => fallback.nodes.find((item) => item.id === relatedId))
      .filter((item): item is Node => Boolean(item)),
    activities: fallback.activities.filter((activity) => activity.targetNodeId === node.id),
    artifacts: fallback.artifacts.filter((artifact) => artifact.nodeId === node.id),
    governance: {
      state: governanceState,
      events: buildFallbackGovernanceEvents(node, governanceState),
    },
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

function mapNeighborhoodConnection(targetNodeId: string, raw: any): GraphConnection {
  const node = mapNode(raw.node);
  const edge = raw.edge ?? {};
  const relation: Relation = {
    id: edge.relationId ?? edge.relation_id ?? `edge:${targetNodeId}:${node.id}:${edge.relationType ?? edge.relation_type ?? 'related_to'}`,
    fromNodeId: edge.direction === 'incoming' ? node.id : targetNodeId,
    toNodeId: edge.direction === 'incoming' ? targetNodeId : node.id,
    relationType: edge.relationType ?? edge.relation_type ?? 'related_to',
    status: edge.relationStatus ?? edge.relation_status ?? 'active',
    createdBy: edge.generator ?? edge.relationSource ?? 'recallx',
    sourceType: edge.relationSource === 'inferred' ? 'system' : 'human',
    sourceLabel: edge.relationSource === 'inferred' ? `inferred:${edge.generator ?? 'derived'}` : 'canonical',
    createdAt: new Date().toISOString(),
    metadata: {},
  };

  return {
    node,
    relation,
    direction: edge.direction === 'incoming' ? 'incoming' : 'outgoing',
    hop: edge.hop === 2 ? 2 : 1,
    viaNodeId: typeof raw.viaNodeId === 'string' ? raw.viaNodeId : undefined,
    viaNodeTitle: typeof raw.viaNodeTitle === 'string' ? raw.viaNodeTitle : undefined,
  };
}

function mapProjectGraphPayload(raw: any): ProjectGraphPayload {
  const data = readPayloadData(raw);
  return {
    nodes: Array.isArray(data?.nodes)
      ? data.nodes.map((item: any) => ({
          id: item.id,
          title: item.title ?? 'Untitled',
          type: item.type,
          status: item.status ?? 'active',
          canonicality: item.canonicality ?? 'appended',
          summary: item.summary ?? 'No summary yet.',
          createdAt: item.createdAt ?? item.created_at ?? new Date().toISOString(),
          updatedAt: item.updatedAt ?? item.updated_at ?? item.createdAt ?? item.created_at ?? new Date().toISOString(),
          degree: typeof item.degree === 'number' ? item.degree : 0,
          isFocus: Boolean(item.isFocus),
          projectRole: item.projectRole === 'focus' ? 'focus' : 'member',
        }))
      : [],
    edges: Array.isArray(data?.edges)
      ? data.edges.map((item: any) => ({
          id: item.id,
          source: item.source,
          target: item.target,
          relationType: item.relationType ?? item.relation_type ?? 'related_to',
          relationSource: item.relationSource === 'inferred' ? 'inferred' : 'canonical',
          status: item.status ?? 'active',
          score: typeof item.score === 'number' ? item.score : null,
          generator: typeof item.generator === 'string' ? item.generator : null,
          createdAt: item.createdAt ?? item.created_at ?? new Date().toISOString(),
          evidence: item.evidence ?? {},
        }))
      : [],
    timeline: Array.isArray(data?.timeline)
      ? data.timeline.map((item: any) => ({
          id: item.id,
          kind: item.kind ?? 'activity',
          at: item.at ?? new Date().toISOString(),
          nodeId: typeof item.nodeId === 'string' ? item.nodeId : undefined,
          edgeId: typeof item.edgeId === 'string' ? item.edgeId : undefined,
          label: item.label ?? 'Graph event',
        }))
      : [],
    meta: {
      focusProjectId: data?.meta?.focusProjectId ?? data?.meta?.focus_project_id ?? '',
      nodeCount: typeof data?.meta?.nodeCount === 'number' ? data.meta.nodeCount : 0,
      edgeCount: typeof data?.meta?.edgeCount === 'number' ? data.meta.edgeCount : 0,
      inferredEdgeCount: typeof data?.meta?.inferredEdgeCount === 'number' ? data.meta.inferredEdgeCount : 0,
      timeRange: {
        start: data?.meta?.timeRange?.start ?? null,
        end: data?.meta?.timeRange?.end ?? null,
      },
    },
  };
}

function buildFallbackProjectGraph(state: WorkspaceSeed, projectId: string): ProjectGraphPayload {
  const project = state.nodes.find((node) => node.id === projectId && node.type === 'project');
  if (!project) {
    throw new Error('Project not found in fallback workspace.');
  }

  const membershipRelations = state.relations.filter(
    (relation) =>
      relation.relationType === 'relevant_to' &&
      relation.status !== 'archived' &&
      relation.status !== 'rejected' &&
      (relation.fromNodeId === projectId || relation.toNodeId === projectId),
  );
  const memberNodeIds = new Set<string>([projectId]);
  membershipRelations.forEach((relation) => {
    memberNodeIds.add(relation.fromNodeId === projectId ? relation.toNodeId : relation.fromNodeId);
  });

  const nodes = state.nodes
    .filter((node) => memberNodeIds.has(node.id))
    .map((node) => ({
      id: node.id,
      title: node.title,
      type: node.type,
      status: node.status,
      canonicality: node.canonicality,
      summary: node.summary,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      degree: state.relations.filter(
        (relation) => memberNodeIds.has(relation.fromNodeId) && memberNodeIds.has(relation.toNodeId) && (relation.fromNodeId === node.id || relation.toNodeId === node.id),
      ).length,
      isFocus: node.id === projectId,
      projectRole: node.id === projectId ? ('focus' as const) : ('member' as const),
    }));
  const nodeTitleById = new Map(nodes.map((node) => [node.id, node.title] as const));
  const edges = state.relations
    .filter(
      (relation) =>
        memberNodeIds.has(relation.fromNodeId) &&
        memberNodeIds.has(relation.toNodeId) &&
        relation.status !== 'archived' &&
        relation.status !== 'rejected',
    )
    .map((relation) => ({
      id: relation.id,
      source: relation.fromNodeId,
      target: relation.toNodeId,
      relationType: relation.relationType,
      relationSource: 'canonical' as const,
      status: relation.status,
      score: null,
      generator: null,
      createdAt: relation.createdAt,
      evidence: {},
    }));
  const timeline = [
    ...nodes.map((node) => ({
      id: `timeline-node:${node.id}`,
      kind: 'node_created' as const,
      at: node.createdAt,
      nodeId: node.id,
      label: `${node.title} created`,
    })),
    ...edges.map((edge) => ({
      id: `timeline-edge:${edge.id}`,
      kind: 'relation_created' as const,
      at: edge.createdAt,
      edgeId: edge.id,
      nodeId: edge.source,
      label: `${nodeTitleById.get(edge.source) ?? edge.source} ${edge.relationType.replaceAll('_', ' ')} ${nodeTitleById.get(edge.target) ?? edge.target}`,
    })),
    ...state.activities
      .filter((activity) => memberNodeIds.has(activity.targetNodeId))
      .map((activity) => ({
        id: `timeline-activity:${activity.id}`,
        kind: 'activity' as const,
        at: activity.createdAt,
        nodeId: activity.targetNodeId,
        label: `${activity.activityType.replaceAll('_', ' ')} on ${nodeTitleById.get(activity.targetNodeId) ?? activity.targetNodeId}`,
      })),
  ].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));

  return {
    nodes,
    edges,
    timeline,
    meta: {
      focusProjectId: projectId,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      inferredEdgeCount: 0,
      timeRange: {
        start: timeline[0]?.at ?? project.createdAt,
        end: timeline[timeline.length - 1]?.at ?? project.createdAt,
      },
    },
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
  const globalToken = (window as Window & { __RECALLX_API_TOKEN__?: string }).__RECALLX_API_TOKEN__;
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
  return cloneWorkspace(getFallbackState());
}

export async function getWorkspace(): Promise<Workspace> {
  return withFallback(
    async () => {
      const payload = await requestJson('/workspace');
      return mapWorkspace(payload);
    },
    async () => getFallbackState().workspace,
  );
}

export async function getWorkspaceCatalog(): Promise<WorkspaceCatalog> {
  return withFallback(
    async () => {
      const payload = await requestJson('/workspaces');
      return mapWorkspaceCatalogResponse(payload);
    },
    async () => buildWorkspaceCatalog(getFallbackState().workspace),
  );
}

export async function getBootstrap(): Promise<BootstrapInfo> {
  return withFallback(
    async () => {
      const payload = await requestJson('/bootstrap');
      const data = readPayloadData(payload);
      const workspace = mapWorkspace(data.workspace ?? data);
      return {
        workspace,
        authMode: data.authMode === 'bearer' ? 'bearer' : workspace.authMode,
        hasToken: Boolean(getRendererToken()),
      };
    },
    async () => ({
      workspace: getFallbackState().workspace,
      authMode: 'optional',
      hasToken: false,
    }),
  );
}

export async function getSettings(keys?: string[]): Promise<Record<string, unknown>> {
  return withFallback(
    async () => {
      const query = keys?.length ? `?keys=${encodeURIComponent(keys.join(','))}` : '';
      const payload = await requestJson(`/settings${query}`);
      const data = readPayloadData(payload);
      return typeof data?.values === 'object' && data?.values !== null ? data.values : {};
    },
    async () => {
      if (!keys?.length) {
        return Object.fromEntries(fallbackSettings.entries());
      }

      return keys.reduce<Record<string, unknown>>((acc, key) => {
        if (fallbackSettings.has(key)) {
          acc[key] = fallbackSettings.get(key);
        }
        return acc;
      }, {});
    },
  );
}

export async function updateSettings(values: Record<string, unknown>): Promise<Record<string, unknown>> {
  return withFallback(
    async () => {
      const payload = await requestJson('/settings', {
        method: 'PATCH',
        body: JSON.stringify({ values }),
      });
      const data = readPayloadData(payload);
      return typeof data?.values === 'object' && data?.values !== null ? data.values : {};
    },
    async () => {
      Object.entries(values).forEach(([key, value]) => {
        fallbackSettings.set(key, value);
      });
      return values;
    },
  );
}

export async function getContextBundlePreview(targetId: string): Promise<ContextBundlePreviewItem[]> {
  return withFallback(
    async () => {
      const payload = await requestJson('/context/bundles', {
        method: 'POST',
        body: JSON.stringify({
          target: {
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

      return readBundleItems(payload)
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
          generator: typeof item.generator === 'string' ? item.generator : null,
        }));
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

export async function createWorkspace(input: { rootPath: string; workspaceName?: string }): Promise<WorkspaceCatalog> {
  const payload = await requestJson('/workspaces', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return mapWorkspaceCatalogResponse(payload);
}

export async function openWorkspace(rootPath: string): Promise<WorkspaceCatalog> {
  const payload = await requestJson('/workspaces/open', {
    method: 'POST',
    body: JSON.stringify({ rootPath }),
  });
  return mapWorkspaceCatalogResponse(payload);
}

export async function listWorkspaceBackups(): Promise<WorkspaceBackupRecord[]> {
  const payload = await requestJson('/workspaces/backups');
  return mapPayloadItems(payload, (raw: any) => ({
    id: raw.id,
    label: raw.label ?? raw.id,
    createdAt: raw.createdAt ?? new Date().toISOString(),
    backupPath: raw.backupPath ?? '',
    workspaceRoot: raw.workspaceRoot ?? '',
    workspaceName: raw.workspaceName ?? 'RecallX',
  }));
}

export async function createWorkspaceBackup(label?: string): Promise<WorkspaceBackupRecord> {
  const payload = await requestJson('/workspaces/backups', {
    method: 'POST',
    body: JSON.stringify(label ? { label } : {}),
  });
  const data = readPayloadData(payload);
  return {
    id: data?.backup?.id ?? '',
    label: data?.backup?.label ?? data?.backup?.id ?? 'snapshot',
    createdAt: data?.backup?.createdAt ?? new Date().toISOString(),
    backupPath: data?.backup?.backupPath ?? '',
    workspaceRoot: data?.backup?.workspaceRoot ?? '',
    workspaceName: data?.backup?.workspaceName ?? 'RecallX',
  };
}

export async function exportWorkspace(format: 'json' | 'markdown'): Promise<WorkspaceExportRecord> {
  const payload = await requestJson('/workspaces/export', {
    method: 'POST',
    body: JSON.stringify({ format }),
  });
  const data = readPayloadData(payload);
  return {
    id: data?.export?.id ?? '',
    format: data?.export?.format === 'markdown' ? 'markdown' : 'json',
    createdAt: data?.export?.createdAt ?? new Date().toISOString(),
    exportPath: data?.export?.exportPath ?? '',
    workspaceRoot: data?.export?.workspaceRoot ?? '',
    workspaceName: data?.export?.workspaceName ?? 'RecallX',
  };
}

export async function importWorkspace(input: {
  format: 'recallx_json' | 'markdown';
  sourcePath: string;
  label?: string;
}): Promise<WorkspaceImportRecord> {
  const payload = await requestJson('/workspaces/import', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const data = readPayloadData(payload);
  return {
    format: data?.import?.format === 'markdown' ? 'markdown' : 'recallx_json',
    label: data?.import?.label ?? 'Workspace import',
    sourcePath: data?.import?.sourcePath ?? '',
    importedPath: data?.import?.importedPath ?? '',
    createdAt: data?.import?.createdAt ?? new Date().toISOString(),
    backupId: data?.import?.backupId ?? '',
    backupPath: data?.import?.backupPath ?? '',
    nodesCreated: typeof data?.import?.nodesCreated === 'number' ? data.import.nodesCreated : 0,
    relationsCreated: typeof data?.import?.relationsCreated === 'number' ? data.import.relationsCreated : 0,
    activitiesCreated: typeof data?.import?.activitiesCreated === 'number' ? data.import.activitiesCreated : 0,
    warnings: Array.isArray(data?.import?.warnings) ? data.import.warnings.filter((item: unknown): item is string => typeof item === 'string') : [],
  };
}

export async function restoreWorkspaceBackup(input: {
  backupId: string;
  targetRootPath: string;
  workspaceName?: string;
}): Promise<WorkspaceRestoreResult> {
  const payload = await requestJson('/workspaces/restore', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const data = readPayloadData(payload);
  return {
    catalog: mapWorkspaceCatalogResponse(payload),
    autoBackup: data?.autoBackup
      ? {
          id: data.autoBackup.id ?? '',
          label: data.autoBackup.label ?? data.autoBackup.id ?? 'snapshot',
          createdAt: data.autoBackup.createdAt ?? new Date().toISOString(),
          backupPath: data.autoBackup.backupPath ?? '',
          workspaceRoot: data.autoBackup.workspaceRoot ?? '',
          workspaceName: data.autoBackup.workspaceName ?? 'RecallX',
        }
      : null,
  };
}

export async function searchWorkspace(input: {
  query: string;
  limit?: number;
  offset?: number;
}): Promise<{ nodes: SearchNodeHit[]; activities: ActivitySearchHit[]; total: number }> {
  return withFallback(
    async () => {
      const payload = await requestJson('/search', {
        method: 'POST',
        body: JSON.stringify({
          query: input.query,
          scopes: ['nodes', 'activities'],
          limit: input.limit ?? 24,
          offset: input.offset ?? 0,
          sort: 'smart',
        }),
      });
      const data = readPayloadData(payload);
      const items = Array.isArray(data?.items) ? data.items : [];
      return {
        nodes: items
          .filter((item: any) => item?.resultType === 'node' && item.node)
          .map((item: any) => mapSearchNodeHit(item.node)),
        activities: items
          .filter((item: any) => item?.resultType === 'activity' && item.activity)
          .map((item: any) => ({
            id: item.activity.id,
            targetNodeId: item.activity.targetNodeId ?? item.activity.target_node_id,
            targetNodeTitle: item.activity.targetNodeTitle ?? null,
            targetNodeType: item.activity.targetNodeType ?? null,
            targetNodeStatus: item.activity.targetNodeStatus ?? null,
            activityType: item.activity.activityType ?? item.activity.activity_type,
            body: item.activity.body ?? '',
            sourceLabel: item.activity.sourceLabel ?? 'unknown',
            createdAt: item.activity.createdAt ?? item.activity.created_at ?? new Date().toISOString(),
          })),
        total: typeof data?.total === 'number' ? data.total : items.length,
      };
    },
    async () => {
      const normalizedQuery = input.query.trim().toLowerCase();
      const items = getFallbackState().nodes.filter((node) =>
        [node.title, node.summary, node.body, node.tags.join(' ')].join(' ').toLowerCase().includes(normalizedQuery),
      );
      return {
        nodes: items.map((node) => mapSearchNodeHit(node)),
        activities: getFallbackState().activities
          .filter((activity) => activity.body.toLowerCase().includes(normalizedQuery))
          .map((activity) => ({
            id: activity.id,
            targetNodeId: activity.targetNodeId,
            targetNodeTitle: getFallbackState().nodes.find((node) => node.id === activity.targetNodeId)?.title ?? null,
            targetNodeType: getFallbackState().nodes.find((node) => node.id === activity.targetNodeId)?.type ?? null,
            targetNodeStatus: getFallbackState().nodes.find((node) => node.id === activity.targetNodeId)?.status ?? null,
            activityType: activity.activityType,
            body: activity.body,
            sourceLabel: activity.sourceLabel,
            createdAt: activity.createdAt,
          })),
        total: items.length,
      };
    },
  );
}

export async function getSnapshot(options?: { workspace?: Workspace }): Promise<WorkspaceSeed> {
  return withFallback(
    async () => {
      const [workspacePayload, nodesPayload, integrationsPayload] = await Promise.all([
        options?.workspace ? Promise.resolve(options.workspace) : requestJson('/workspace'),
        requestJson('/nodes/search', {
          method: 'POST',
          body: JSON.stringify({
            query: '',
            filters: {},
            limit: 100,
            offset: 0,
            sort: 'updated_at',
          }),
        }),
        requestJson('/integrations'),
      ]);

      const nodes = mapPayloadItems(nodesPayload, mapNode);
      const integrations = mapPayloadItems(integrationsPayload, mapIntegration);
      const recentNodeIds = nodes.slice(0, 5).map((node) => node.id);
      const pinnedProjectIds = nodes.filter((node) => node.type === 'project').slice(0, 3).map((node) => node.id);

      return {
        workspace: options?.workspace ?? mapWorkspace(workspacePayload),
        nodes,
        relations: [],
        activities: [],
        artifacts: [],
        integrations,
        pinnedProjectIds,
        recentNodeIds,
      };
    },
    async () => fallbackSnapshot(),
  );
}


export async function getNodeDetail(id: string): Promise<NodeDetail | undefined> {
  return withFallback(
    async () => {
      const payload = await requestJson(`/nodes/${encodeURIComponent(id)}`);
      const data = readPayloadData(payload);
      return {
        node: data?.node ? mapNode(data.node) : null,
        related: Array.isArray(data?.related) ? data.related.map((item: any) => mapNode(item.node ?? item)) : [],
        activities: Array.isArray(data?.activities) ? data.activities.map(mapActivity) : [],
        artifacts: Array.isArray(data?.artifacts) ? data.artifacts.map(mapArtifact) : [],
        governance: mapGovernancePayload(data?.governance),
      };
    },
    async () => {
      const node = getFallbackState().nodes.find((item) => item.id === id);
      return node ? buildFallbackNodeDetail(node) : undefined;
    },
  );
}

function getFallbackRelatedConnections(state: WorkspaceSeed, id: string): GraphConnection[] {
  const nodeById = new Map(state.nodes.map((node) => [node.id, node] as const));
  return state.relations.reduce<GraphConnection[]>((connections, relation) => {
    if ((relation.fromNodeId !== id && relation.toNodeId !== id) || relation.status === 'archived') {
      return connections;
    }

    const relatedId = relation.fromNodeId === id ? relation.toNodeId : relation.fromNodeId;
    const node = nodeById.get(relatedId);
    if (!node || node.status === 'archived') {
      return connections;
    }

    connections.push({
      node,
      relation,
      direction: relation.fromNodeId === id ? 'outgoing' : 'incoming',
      hop: 1,
    });
    return connections;
  }, []);
}

export async function getGraphNeighborhood(id: string, hops: 1 | 2): Promise<GraphConnection[]> {
  return withFallback(
    async () => {
      const payload = await requestJson(
        `/nodes/${encodeURIComponent(id)}/neighborhood?include_inferred=1&max_inferred=4&depth=${hops}`
      );
      return mapPayloadItems(payload, (item) => mapNeighborhoodConnection(id, item));
    },
    async () => {
      const fallback = getFallbackState();
      const firstHop = getFallbackRelatedConnections(fallback, id);
      if (hops === 1) {
        return firstHop;
      }

      const secondHopGroups = firstHop.map((connection) =>
        getFallbackRelatedConnections(fallback, connection.node.id)
          .filter((item) => item.node.id !== id)
          .map((item) => ({
            ...item,
            hop: 2 as const,
            viaNodeId: connection.node.id,
            viaNodeTitle: connection.node.title,
          }))
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
  );
}

export async function getProjectGraph(projectId: string): Promise<ProjectGraphPayload> {
  return withFallback(
    async () => {
      const payload = await requestJson(`/projects/${encodeURIComponent(projectId)}/graph?include_inferred=1&max_inferred=60`);
      return mapProjectGraphPayload(payload);
    },
    async () => buildFallbackProjectGraph(getFallbackState(), projectId),
  );
}

export async function getGovernanceIssues(): Promise<GovernanceIssueItem[]> {
  return withFallback(
    async () => {
      const payload = await requestJson('/governance/issues?limit=20');
      return mapPayloadItems(payload, mapGovernanceIssue);
    },
    async () =>
      getFallbackState().nodes
        .filter((node) => node.status === 'contested' || node.canonicality === 'suggested')
        .map((node) => ({
          entityType: 'node' as const,
          entityId: node.id,
          state: node.status === 'contested' ? 'contested' : 'low_confidence',
          confidence: node.status === 'contested' ? 0.2 : 0.55,
          reasons: node.status === 'contested' ? ['fallback contested node'] : ['fallback suggested node'],
          lastEvaluatedAt: node.updatedAt,
          lastTransitionAt: node.updatedAt,
          metadata: {},
          title: node.title,
          subtitle: node.type,
        })),
  );
}

export function subscribeWorkspaceEvents(handlers: {
  onWorkspaceUpdate?: (event: WorkspaceEvent) => void;
  onError?: () => void;
}): () => void {
  if (typeof window === 'undefined' || typeof window.fetch === 'undefined') {
    return () => {};
  }

  const controller = new AbortController();
  let reconnectTimer: number | null = null;

  async function connect() {
    try {
      const token = getRendererToken();
      const response = await fetch(buildEventStreamUrl(), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Workspace event stream failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        let boundaryIndex = findEventBoundary(buffer);
        while (boundaryIndex >= 0) {
          const chunk = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(skipEventBoundary(buffer, boundaryIndex));
          emitWorkspaceEventChunk(chunk, handlers.onWorkspaceUpdate);
          boundaryIndex = findEventBoundary(buffer);
        }
      }
    } catch {
      if (controller.signal.aborted) {
        return;
      }
      handlers.onError?.();
    }

    if (!controller.signal.aborted) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, 1000);
    }
  }

  void connect();

  return () => {
    controller.abort();
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
    }
  };
}

function findEventBoundary(buffer: string): number {
  const lfBoundary = buffer.indexOf('\n\n');
  const crlfBoundary = buffer.indexOf('\r\n\r\n');
  if (lfBoundary < 0) {
    return crlfBoundary;
  }
  if (crlfBoundary < 0) {
    return lfBoundary;
  }
  return Math.min(lfBoundary, crlfBoundary);
}

function skipEventBoundary(buffer: string, boundaryIndex: number): number {
  return buffer.startsWith('\r\n\r\n', boundaryIndex) ? boundaryIndex + 4 : boundaryIndex + 2;
}

function emitWorkspaceEventChunk(chunk: string, onWorkspaceUpdate?: (event: WorkspaceEvent) => void) {
  const lines = chunk.split(/\r?\n/);
  let eventName = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (eventName !== 'workspace.updated' || dataLines.length === 0) {
    return;
  }

  try {
    onWorkspaceUpdate?.(JSON.parse(dataLines.join('\n')) as WorkspaceEvent);
  } catch {
    // Ignore malformed events and keep the stream open.
  }
}

export async function createNode(input: {
  type: Node['type'];
  title: string;
  body: string;
  projectId?: string;
  tags?: string[];
}): Promise<{ node: Node; landing: LandingInfo | null }> {
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
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
    }),
  });
  return {
    node: mapNode(payload?.data?.node),
    landing: payload?.data?.landing ?? null,
  };
}

export async function refreshNodeSummary(id: string): Promise<Node> {
  const payload = await requestJson(`/nodes/${encodeURIComponent(id)}/refresh-summary`, {
    method: 'POST',
    body: JSON.stringify({ source: DEFAULT_SOURCE }),
  });
  return mapNode(payload?.data?.node);
}

export async function updateNode(input: {
  id: string;
  title?: string;
  body?: string;
}): Promise<Node> {
  const payload = await requestJson(`/nodes/${encodeURIComponent(input.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      source: DEFAULT_SOURCE,
    }),
  });
  return mapNode(payload?.data?.node);
}

export async function archiveNode(id: string): Promise<Node> {
  const payload = await requestJson(`/nodes/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    body: JSON.stringify({ source: DEFAULT_SOURCE }),
  });
  return mapNode(payload?.data?.node);
}
