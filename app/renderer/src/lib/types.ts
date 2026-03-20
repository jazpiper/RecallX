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
export type GovernanceState = 'healthy' | 'low_confidence' | 'contested';

export interface Workspace {
  name: string;
  rootPath: string;
  schemaVersion: number;
  apiBind: string;
  integrationModes: string[];
  authMode: 'optional' | 'bearer';
}

export interface WorkspaceCatalogItem extends Workspace {
  isCurrent: boolean;
  lastOpenedAt: string;
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
  semanticSimilarity?: number;
  generator?: string | null;
}

export interface GovernanceStateRecord {
  entityType: 'node' | 'relation';
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
  entityType: 'node' | 'relation';
  entityId: string;
  eventType: 'evaluated' | 'promoted' | 'contested' | 'demoted' | 'migrated';
  previousState: GovernanceState | null;
  nextState: GovernanceState;
  confidence: number;
  reason: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
}

export interface GovernancePayload {
  state: GovernanceStateRecord | null;
  events: GovernanceEventRecord[];
}

export interface SearchMatchReason {
  strategy: 'fts' | 'like' | 'fallback_token' | 'semantic' | 'browse';
  matchedFields: string[];
}

export interface LandingInfo {
  storedAs: 'node' | 'relation' | 'activity';
  canonicality?: string;
  status: string;
  governanceState: 'healthy' | 'low_confidence' | 'contested' | null;
  reason: string;
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
