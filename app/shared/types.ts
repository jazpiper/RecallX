import type {
  ActivityType,
  BundleMode,
  BundlePreset,
  Canonicality,
  InferredRelationStatus,
  NodeStatus,
  NodeType,
  RelationSource,
  RelationStatus,
  RelationType,
  RelationUsageEventType,
  ReviewStatus,
  ReviewType
} from "./contracts.js";

export type JsonMap = Record<string, unknown>;

export interface ApiEnvelope<T> {
  ok: true;
  data: T;
  meta: {
    requestId: string;
    apiVersion: "v1";
  };
}

export interface ApiErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: {
    requestId: string;
    apiVersion: "v1";
  };
}

export interface WorkspaceInfo {
  rootPath: string;
  workspaceName: string;
  schemaVersion: number;
  bindAddress: string;
  enabledIntegrationModes: string[];
  authMode: string;
}

export interface WorkspaceCatalogItem extends WorkspaceInfo {
  isCurrent: boolean;
  lastOpenedAt: string;
}

export interface SemanticStatusSummary {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  chunkEnabled: boolean;
  lastBackfillAt: string | null;
  counts: {
    pending: number;
    processing: number;
    stale: number;
    ready: number;
    failed: number;
  };
}

export interface SemanticIssueItem {
  nodeId: string;
  title: string | null;
  embeddingStatus: 'pending' | 'processing' | 'stale' | 'ready' | 'failed';
  staleReason: string | null;
  updatedAt: string;
}

export interface SemanticIssuePage {
  items: SemanticIssueItem[];
  nextCursor: string | null;
}

export interface NodeRecord {
  id: string;
  type: NodeType;
  status: NodeStatus;
  canonicality: Canonicality;
  visibility: string;
  title: string | null;
  body: string | null;
  summary: string | null;
  createdBy: string | null;
  sourceType: string | null;
  sourceLabel: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  metadata: JsonMap;
}

export interface RelationRecord {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: RelationType;
  status: RelationStatus;
  createdBy: string | null;
  sourceType: string | null;
  sourceLabel: string | null;
  createdAt: string;
  metadata: JsonMap;
}

export interface ActivityRecord {
  id: string;
  targetNodeId: string;
  activityType: ActivityType;
  body: string | null;
  createdBy: string | null;
  sourceType: string | null;
  sourceLabel: string | null;
  createdAt: string;
  metadata: JsonMap;
}

export interface InferredRelationRecord {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: RelationType;
  baseScore: number;
  usageScore: number;
  finalScore: number;
  status: InferredRelationStatus;
  generator: string;
  evidence: JsonMap;
  lastComputedAt: string;
  expiresAt: string | null;
  metadata: JsonMap;
}

export interface RelationUsageEventRecord {
  id: string;
  relationId: string;
  relationSource: RelationSource;
  eventType: RelationUsageEventType;
  sessionId: string | null;
  runId: string | null;
  actorType: string | null;
  actorLabel: string | null;
  toolName: string | null;
  delta: number;
  createdAt: string;
  metadata: JsonMap;
}

export interface RelationUsageSummary {
  relationId: string;
  totalDelta: number;
  eventCount: number;
  lastEventAt: string | null;
}

export interface InferredRelationRecomputeResult {
  updatedCount: number;
  expiredCount: number;
  items: InferredRelationRecord[];
}

export interface PendingRelationUsageStats {
  relationIds: string[];
  eventCount: number;
  earliestEventAt: string | null;
  latestEventAt: string | null;
}

export interface ArtifactRecord {
  id: string;
  nodeId: string;
  path: string;
  mimeType: string | null;
  sizeBytes: number | null;
  checksum: string | null;
  createdBy: string | null;
  sourceLabel: string | null;
  createdAt: string;
  metadata: JsonMap;
}

export interface ProvenanceRecord {
  id: string;
  entityType: string;
  entityId: string;
  operationType: string;
  actorType: string;
  actorLabel: string | null;
  toolName: string | null;
  toolVersion: string | null;
  timestamp: string;
  inputRef: string | null;
  metadata: JsonMap;
}

export interface ReviewQueueRecord {
  id: string;
  entityType: string;
  entityId: string;
  reviewType: ReviewType;
  proposedBy: string | null;
  createdAt: string;
  status: ReviewStatus;
  notes: string | null;
  metadata: JsonMap;
}

export interface IntegrationRecord {
  id: string;
  name: string;
  kind: string;
  status: string;
  capabilities: string[];
  config: JsonMap;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResultItem {
  id: string;
  type: NodeType;
  title: string | null;
  summary: string | null;
  status: NodeStatus;
  canonicality: Canonicality;
  sourceLabel: string | null;
  updatedAt: string;
  tags: string[];
}

export interface ContextBundleItem {
  nodeId: string;
  type: NodeType;
  title: string | null;
  summary: string | null;
  reason: string;
  relationId?: string;
  relationType?: RelationType;
  relationSource?: RelationSource;
  relationStatus?: RelationStatus | InferredRelationStatus;
  relationScore?: number;
  retrievalRank?: number;
  semanticSimilarity?: number;
  generator?: string | null;
}

export interface NeighborhoodItem {
  node: NodeRecord;
  edge: {
    relationId: string;
    relationType: RelationType;
    relationSource: RelationSource;
    relationStatus: RelationStatus | InferredRelationStatus;
    relationScore: number | null;
    retrievalRank?: number | null;
    generator: string | null;
    reason: string;
    direction: "incoming" | "outgoing";
    hop: number;
  };
}

export interface ContextBundle {
  target: {
    type: string;
    id: string;
    title: string | null;
  };
  mode: BundleMode;
  preset: BundlePreset;
  summary: string;
  items: ContextBundleItem[];
  activityDigest: string[];
  decisions: SearchResultItem[];
  openQuestions: SearchResultItem[];
  sources: Array<{
    nodeId: string;
    sourceLabel: string | null;
  }>;
}
