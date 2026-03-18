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

export type NodeStatus = 'active' | 'draft' | 'review' | 'archived';
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
export type ReviewType =
  | 'relation_suggestion'
  | 'node_promotion'
  | 'canonical_edit'
  | 'merge_proposal'
  | 'archive_proposal';
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'dismissed';

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

export interface ReviewQueueItem {
  id: string;
  entityType: 'node' | 'relation' | 'activity' | 'artifact' | 'review_queue_item';
  entityId: string;
  reviewType: ReviewType;
  proposedBy: string;
  createdAt: string;
  status: ReviewStatus;
  notes: string;
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

export type NavView = 'home' | 'search' | 'projects' | 'recent' | 'review' | 'graph' | 'settings';

export interface WorkspaceSeed {
  workspace: Workspace;
  nodes: Node[];
  relations: Relation[];
  activities: Activity[];
  artifacts: Artifact[];
  reviewQueue: ReviewQueueItem[];
  integrations: Integration[];
  pinnedProjectIds: string[];
  recentNodeIds: string[];
}
