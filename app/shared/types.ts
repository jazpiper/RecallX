import type {
  ActivityType,
  BundleMode,
  BundlePreset,
  Canonicality,
  GovernanceDecisionAction,
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
  paths?: {
    dbPath: string;
    artifactsDir: string;
    exportsDir: string;
    importsDir: string;
    backupsDir: string;
    configDir: string;
    cacheDir: string;
  };
  safety?: WorkspaceSafetyStatus;
}

export interface WorkspaceCatalogItem extends WorkspaceInfo {
  isCurrent: boolean;
  lastOpenedAt: string;
}

export interface WorkspaceSafetyWarning {
  code: "active_lock" | "unclean_shutdown" | "recent_other_machine";
  message: string;
}

export interface WorkspaceSafetyStatus {
  machineId: string;
  sessionId: string;
  lastOpenedAt: string;
  lastCleanCloseAt: string | null;
  lockPresent: boolean;
  lockUpdatedAt: string | null;
  activeSessionMachineId: string | null;
  warnings: WorkspaceSafetyWarning[];
}

export interface WorkspaceBackupRecord {
  id: string;
  label: string;
  createdAt: string;
  backupPath: string;
  workspaceRoot: string;
  workspaceName: string;
}

export interface WorkspaceExportRecord {
  id: string;
  format: "json" | "markdown";
  createdAt: string;
  exportPath: string;
  workspaceRoot: string;
  workspaceName: string;
}

export interface WorkspaceImportOptions {
  normalizeTitleWhitespace: boolean;
  trimBodyWhitespace: boolean;
  duplicateMode: "warn" | "skip_exact";
}

export interface WorkspaceImportPreviewItem {
  title: string;
  type: NodeType;
  sourcePath: string;
  duplicateKind: "exact" | "title" | null;
}

export interface WorkspaceImportPreviewDuplicate {
  title: string;
  sourcePath: string;
  matchType: "exact" | "title";
  existingNodeId: string | null;
  existingNodeTitle: string | null;
  existingSource: "workspace" | "batch";
}

export interface WorkspaceImportPreviewRecord {
  format: "recallx_json" | "markdown";
  label: string;
  sourcePath: string;
  createdAt: string;
  options: WorkspaceImportOptions;
  nodesDetected: number;
  relationsDetected: number;
  activitiesDetected: number;
  duplicateCandidates: number;
  exactDuplicateCandidates: number;
  nodesReady: number;
  relationsReady: number;
  activitiesReady: number;
  skippedNodes: number;
  skippedRelations: number;
  skippedActivities: number;
  warnings: string[];
  sampleItems: WorkspaceImportPreviewItem[];
  duplicateItems: WorkspaceImportPreviewDuplicate[];
}

export interface WorkspaceImportRecord {
  format: "recallx_json" | "markdown";
  label: string;
  sourcePath: string;
  importedPath: string;
  createdAt: string;
  options: WorkspaceImportOptions;
  backupId: string;
  backupPath: string;
  nodesCreated: number;
  relationsCreated: number;
  activitiesCreated: number;
  skippedNodes: number;
  skippedRelations: number;
  skippedActivities: number;
  warnings: string[];
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

export interface GovernanceFeedItem extends Omit<GovernanceEventRecord, "title" | "subtitle"> {
  action: GovernanceDecisionAction | null;
  title: string | null;
  subtitle: string | null;
  nodeId: string | null;
  fromNodeId: string | null;
  toNodeId: string | null;
  relationType: RelationType | null;
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
  lexicalQuality?: SearchLexicalQuality;
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
  lexicalQuality?: SearchLexicalQuality;
}

export interface WorkspaceSearchResultItem {
  resultType: "node" | "activity";
  node?: SearchResultItem;
  activity?: ActivitySearchResultItem;
}

export interface SearchMatchReason {
  strategy: "fts" | "like" | "fallback_token" | "semantic" | "browse";
  matchedFields: string[];
  strength?: Exclude<SearchLexicalQuality, "none">;
  termCoverage?: number | null;
}

export type SearchLexicalQuality = "none" | "weak" | "strong";
export type WorkspaceSemanticFallbackMode = "strict_zero" | "no_strong_node_hit";
export type SemanticWorkspaceFallbackMode = "strict_zero" | "no_strong_node_hit";

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

export interface ProjectGraphNode {
  id: string;
  title: string | null;
  type: NodeType;
  status: NodeStatus;
  canonicality: Canonicality;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  degree: number;
  isFocus: boolean;
  projectRole: "focus" | "member";
}

export interface ProjectGraphEdge {
  id: string;
  source: string;
  target: string;
  relationType: RelationType;
  relationSource: RelationSource;
  status: RelationStatus | InferredRelationStatus;
  score?: number | null;
  generator?: string | null;
  createdAt: string;
  evidence?: JsonMap;
}

export interface ProjectGraphTimelineEvent {
  id: string;
  kind: "node_created" | "relation_created" | "activity";
  at: string;
  nodeId?: string;
  edgeId?: string;
  label: string;
}

export interface ProjectGraphPayload {
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  timeline: ProjectGraphTimelineEvent[];
  meta: {
    focusProjectId: string;
    nodeCount: number;
    edgeCount: number;
    inferredEdgeCount: number;
    timeRange: {
      start: string | null;
      end: string | null;
    };
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

export type TelemetrySurface = "api" | "mcp";
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
  spanId: string | null;
  parentSpanId: string | null;
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
  slowRequestThresholdMs: number;
  operationSummaries: TelemetryOperationSummary[];
  hotOperations: TelemetryOperationSummary[];
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
  searchHitRate: {
    hitCount: number;
    missCount: number;
    sampleCount: number;
    ratio: number | null;
    operations: Array<{
      surface: TelemetrySurface;
      operation: string;
      hitCount: number;
      missCount: number;
      sampleCount: number;
      ratio: number | null;
    }>;
  };
  searchLexicalQualityRate: {
    strongCount: number;
    weakCount: number;
    noneCount: number;
    sampleCount: number;
    operations: Array<{
      surface: TelemetrySurface;
      operation: string;
      strongCount: number;
      weakCount: number;
      noneCount: number;
      sampleCount: number;
    }>;
  };
  workspaceResultCompositionRate: {
    emptyCount: number;
    nodeOnlyCount: number;
    activityOnlyCount: number;
    mixedCount: number;
    semanticNodeOnlyCount: number;
    semanticMixedCount: number;
    sampleCount: number;
  };
  workspaceFallbackModeRate: {
    strictZeroCount: number;
    noStrongNodeHitCount: number;
    sampleCount: number;
    operations: Array<{
      surface: TelemetrySurface;
      operation: string;
      strictZeroCount: number;
      noStrongNodeHitCount: number;
      sampleCount: number;
    }>;
  };
  searchFeedbackRate: {
    usefulCount: number;
    notUsefulCount: number;
    uncertainCount: number;
    sampleCount: number;
    usefulRatio: number | null;
    top1UsefulCount: number;
    top1SampleCount: number;
    top1UsefulRatio: number | null;
    top3UsefulCount: number;
    top3SampleCount: number;
    top3UsefulRatio: number | null;
    semanticUsefulCount: number;
    semanticNotUsefulCount: number;
    semanticSampleCount: number;
    semanticUsefulRatio: number | null;
    semanticFalsePositiveRatio: number | null;
    semanticLiftUsefulCount: number;
    semanticLiftSampleCount: number;
    semanticLiftUsefulRatio: number | null;
    byLexicalQuality: Array<{
      lexicalQuality: SearchLexicalQuality;
      usefulCount: number;
      notUsefulCount: number;
      uncertainCount: number;
      sampleCount: number;
      usefulRatio: number | null;
    }>;
    byFallbackMode: Array<{
      fallbackMode: WorkspaceSemanticFallbackMode;
      usefulCount: number;
      notUsefulCount: number;
      uncertainCount: number;
      sampleCount: number;
      usefulRatio: number | null;
    }>;
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
    modes: Array<{
      fallbackMode: WorkspaceSemanticFallbackMode;
      eligibleCount: number;
      attemptedCount: number;
      hitCount: number;
      sampleCount: number;
      attemptRatio: number | null;
      hitRatio: number | null;
    }>;
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
