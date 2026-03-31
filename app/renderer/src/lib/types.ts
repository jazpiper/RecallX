export type SourceType = 'human' | 'agent' | 'import' | 'system' | 'integration';

export type NodeType =
  | 'note'
  | 'project'
  | 'idea'
  | 'question'
  | 'decision'
  | 'reference'
  | 'artifact_ref'
  | 'conversation'
  | 'spec';

export type NodeStatus = 'active' | 'draft' | 'contested' | 'archived';
export type Canonicality = 'canonical' | 'appended' | 'suggested' | 'imported' | 'generated';
export type RelationType =
  | 'related_to'
  | 'supports'
  | 'contradicts'
  | 'elaborates'
  | 'depends_on'
  | 'relevant_to'
  | 'derived_from'
  | 'produced_by';
export type RelationStatus = 'active' | 'suggested' | 'rejected' | 'archived';
export type ActivityType =
  | 'note_appended'
  | 'agent_run_summary'
  | 'import_completed'
  | 'artifact_attached'
  | 'decision_recorded'
  | 'review_action'
  | 'context_bundle_generated';
export type GovernanceEntityType = 'node' | 'relation';
export type GovernanceState = 'healthy' | 'low_confidence' | 'contested';
export type GovernanceDecisionAction = 'promote' | 'contest' | 'archive' | 'accept' | 'reject';
export type NodeGovernanceAction = 'promote' | 'contest' | 'archive';
export type RelationGovernanceAction = 'accept' | 'reject' | 'archive';

export interface Workspace {
  name: string;
  rootPath: string;
  schemaVersion: number;
  apiBind: string;
  integrationModes: string[];
  authMode: 'optional' | 'bearer';
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

export interface WorkspaceCatalogItem extends Workspace {
  isCurrent: boolean;
  lastOpenedAt: string;
}

export interface WorkspaceSafetyWarning {
  code: 'active_lock' | 'unclean_shutdown' | 'recent_other_machine';
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
  format: 'json' | 'markdown';
  createdAt: string;
  exportPath: string;
  workspaceRoot: string;
  workspaceName: string;
}

export interface WorkspaceImportOptions {
  normalizeTitleWhitespace: boolean;
  trimBodyWhitespace: boolean;
  duplicateMode: 'warn' | 'skip_exact';
}

export interface WorkspaceImportPreviewItem {
  title: string;
  type: NodeType;
  sourcePath: string;
  duplicateKind: 'exact' | 'title' | null;
}

export interface WorkspaceImportPreviewDuplicate {
  title: string;
  sourcePath: string;
  matchType: 'exact' | 'title';
  existingNodeId: string | null;
  existingNodeTitle: string | null;
  existingSource: 'workspace' | 'batch';
}

export interface WorkspaceImportPreviewRecord {
  format: 'recallx_json' | 'markdown';
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
  format: 'recallx_json' | 'markdown';
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

export interface WorkspaceRestoreResult {
  catalog: {
    current: Workspace;
    items: WorkspaceCatalogItem[];
  };
  autoBackup: WorkspaceBackupRecord | null;
}

export interface ActivitySearchHit {
  id: string;
  targetNodeId: string;
  targetNodeTitle: string | null;
  targetNodeType: NodeType | null;
  targetNodeStatus: NodeStatus | null;
  activityType: ActivityType;
  body: string;
  sourceLabel: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
}

export interface SearchNodeHit {
  id: string;
  type: NodeType;
  title: string | null;
  summary: string | null;
  status: NodeStatus;
  canonicality: Canonicality;
  sourceLabel: string | null;
  updatedAt: string;
  tags: string[];
  matchReason?: {
    strategy: 'fts' | 'like' | 'fallback_token' | 'semantic' | 'browse';
    matchedFields: string[];
    strength?: Exclude<'none' | 'weak' | 'strong', 'none'>;
    termCoverage?: number | null;
  };
  lexicalQuality?: 'none' | 'weak' | 'strong';
}

export interface ContextBundlePreviewItem {
  nodeId: string;
  type: NodeType;
  title: string | null;
  summary: string | null;
  reason: string;
  relationId?: string;
  relationType?: RelationType;
  relationSource?: 'canonical' | 'inferred';
  relationScore?: number;
  retrievalRank?: number;
  generator?: string | null;
}

export interface GovernanceStateRecord {
  entityType: GovernanceEntityType;
  entityId: string;
  state: GovernanceState;
  confidence: number;
  reasons: string[];
  lastEvaluatedAt: string;
  lastTransitionAt: string;
  metadata: Record<string, string | number | boolean>;
}

export interface GovernanceIssueItem extends GovernanceStateRecord {
  title: string;
  subtitle: string;
}

export interface GovernanceEventRecord {
  id: string;
  entityType: GovernanceEntityType;
  entityId: string;
  eventType: 'evaluated' | 'promoted' | 'contested' | 'demoted' | 'migrated';
  previousState: GovernanceState | null;
  nextState: GovernanceState;
  confidence: number;
  reason: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
  title?: string;
  subtitle?: string;
}

export interface GovernanceFeedItem extends Omit<GovernanceEventRecord, 'title' | 'subtitle'> {
  action: GovernanceDecisionAction | null;
  title: string | null;
  subtitle: string | null;
  nodeId: string | null;
  fromNodeId: string | null;
  toNodeId: string | null;
  relationType: RelationType | null;
}

export interface GovernancePayload {
  state: GovernanceStateRecord | null;
  events: GovernanceEventRecord[];
}

export interface Node {
  id: string;
  type: NodeType;
  status: NodeStatus;
  canonicality: Canonicality;
  visibility: 'normal' | 'hidden' | 'system';
  title: string;
  body: string;
  summary: string;
  createdBy: string;
  sourceType: SourceType;
  sourceLabel: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, string | number | boolean>;
}

export interface Relation {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: RelationType;
  status: RelationStatus;
  createdBy: string;
  sourceType: SourceType;
  sourceLabel: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
}

export interface GraphConnection {
  node: Node;
  relation: Relation;
  direction: 'incoming' | 'outgoing';
  hop: 1 | 2;
  viaNodeId?: string;
  viaNodeTitle?: string;
}

export interface ProjectGraphNode {
  id: string;
  title: string;
  type: NodeType;
  status: NodeStatus;
  canonicality: Canonicality;
  summary: string;
  createdAt: string;
  updatedAt: string;
  degree: number;
  isFocus: boolean;
  projectRole: 'focus' | 'member';
}

export interface ProjectGraphEdge {
  id: string;
  source: string;
  target: string;
  relationType: RelationType;
  relationSource: 'canonical' | 'inferred';
  status: RelationStatus | 'muted' | 'hidden' | 'expired';
  score?: number | null;
  generator?: string | null;
  createdAt: string;
  evidence?: Record<string, unknown>;
}

export interface ProjectGraphTimelineEvent {
  id: string;
  kind: 'node_created' | 'relation_created' | 'activity';
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

export interface Activity {
  id: string;
  targetNodeId: string;
  activityType: ActivityType;
  body: string;
  createdBy: string;
  sourceType: SourceType;
  sourceLabel: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
}

export interface Artifact {
  id: string;
  nodeId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  createdBy: string;
  sourceLabel: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
}

export interface Integration {
  id: string;
  name: string;
  kind: 'openclaw' | 'claude_code' | 'codex' | 'gemini_cli' | 'custom';
  status: 'active' | 'paused' | 'disabled';
  capabilities: string[];
  updatedAt: string;
}

export type NavView = 'home' | 'search' | 'projects' | 'recent' | 'governance' | 'graph' | 'settings';

export interface WorkspaceSeed {
  workspace: Workspace;
  nodes: Node[];
  relations: Relation[];
  activities: Activity[];
  artifacts: Artifact[];
  integrations: Integration[];
  pinnedProjectIds: string[];
  recentNodeIds: string[];
}

export interface NodeDetail {
  node: Node | null;
  related: Node[];
  activities: Activity[];
  artifacts: Artifact[];
  governance: GovernancePayload;
}

export interface RelationDetail {
  relation: Relation | null;
  fromNode: Node | null;
  toNode: Node | null;
  governance: GovernancePayload;
}
