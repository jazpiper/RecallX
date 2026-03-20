import type {
  ActivityType,
  BundleMode,
  BundlePreset,
  Canonicality,
  InferredRelationStatus,
  GovernanceEntityType,
  GovernanceEventType,
  GovernanceState,
  NodeStatus,
  NodeType,
  RelationSource,
  RelationStatus,
  RelationType,
  RelationUsageEventType,
  SearchFeedbackResultType,
  SearchFeedbackVerdict
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

export interface SearchFeedbackEventRecord {
  id: string;
  resultType: SearchFeedbackResultType;
  resultId: string;
  verdict: SearchFeedbackVerdict;
  query: string | null;
  sessionId: string | null;
  runId: string | null;
  actorType: string | null;
  actorLabel: string | null;
  toolName: string | null;
  confidence: number;
  delta: number;
  createdAt: string;
  metadata: JsonMap;
}

export interface SearchFeedbackSummary {
  resultType: SearchFeedbackResultType;
  resultId: string;
  totalDelta: number;
  eventCount: number;
  usefulCount: number;
  notUsefulCount: number;
  uncertainCount: number;
  lastEventAt: string | null;
}

export interface GovernanceEventRecord {
  id: string;
  entityType: GovernanceEntityType;
  entityId: string;
  eventType: GovernanceEventType;
  previousState: GovernanceState | null;
  nextState: GovernanceState;
  confidence: number;
  reason: string;
  createdAt: string;
  metadata: JsonMap;
}

export interface GovernanceStateRecord {
  entityType: GovernanceEntityType;
  entityId: string;
  state: GovernanceState;
  confidence: number;
  reasons: string[];
  lastEvaluatedAt: string;
  lastTransitionAt: string;
  metadata: JsonMap;
}

export interface GovernanceIssueItem extends GovernanceStateRecord {
  title: string | null;
  subtitle: string | null;
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
  matchReason?: SearchMatchReason;
}

export interface ActivitySearchResultItem {
  id: string;
  targetNodeId: string;
  targetNodeTitle: string | null;
  targetNodeType: NodeType | null;
  targetNodeStatus: NodeStatus | null;
  activityType: ActivityType;
  body: string | null;
  sourceLabel: string | null;
  createdAt: string;
  matchReason?: SearchMatchReason;
}

export interface WorkspaceSearchResultItem {
  resultType: "node" | "activity";
  node?: SearchResultItem;
  activity?: ActivitySearchResultItem;
}

export interface SearchMatchReason {
  strategy: "fts" | "like" | "fallback_token" | "semantic" | "browse";
  matchedFields: string[];
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
    type: NodeType | "workspace";
    id: string;
    title: string | null;
  };
  mode: BundleMode;
  preset: BundlePreset;
  summary: string;
  items: Array<{
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
  }>;
  activityDigest: string[];
  decisions: SearchResultItem[];
  openQuestions: SearchResultItem[];
  sources: Array<{
    nodeId: string;
    sourceLabel: string | null;
  }>;
}

export type TelemetrySurface = "api" | "mcp" | "desktop";
export type TelemetryOutcome = "success" | "error";
export type TelemetryErrorKind =
  | "app_error"
  | "validation_error"
  | "normalization_error"
  | "network_error"
  | "http_error"
  | "api_error"
  | "invalid_response"
  | "empty_response"
  | "unexpected_error";

export interface TelemetryEvent {
  ts: string;
  traceId: string;
  requestId: string | null;
  surface: TelemetrySurface;
  operation: string;
  outcome: TelemetryOutcome;
  durationMs: number | null;
  statusCode: number | null;
  errorCode: string | null;
  errorKind: TelemetryErrorKind | null;
  workspaceName: string | null;
  details: JsonMap;
}

export interface TelemetryOperationSummary {
  surface: TelemetrySurface;
  operation: string;
  count: number;
  errorCount: number;
  errorRate: number;
  avgDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  p99DurationMs: number | null;
}

export interface TelemetrySummaryResponse {
  since: string;
  generatedAt: string;
  logsPath: string;
  totalEvents: number;
  operationSummaries: TelemetryOperationSummary[];
  slowOperations: TelemetryOperationSummary[];
  mcpToolFailures: Array<{
    operation: string;
    count: number;
  }>;
  ftsFallbackRate: {
    fallbackCount: number;
    sampleCount: number;
    ratio: number | null;
  };
  semanticAugmentationRate: {
    usedCount: number;
    sampleCount: number;
    ratio: number | null;
  };
  semanticFallbackRate: {
    eligibleCount: number;
    attemptedCount: number;
    hitCount: number;
    attemptRatio: number | null;
    hitRatio: number | null;
  };
  autoJobStats: Array<{
    operation: string;
    count: number;
    avgDurationMs: number | null;
  }>;
}

export interface TelemetryErrorsResponse {
  since: string;
  generatedAt: string;
  surface: TelemetrySurface | "all";
  logsPath: string;
  items: TelemetryEvent[];
}
