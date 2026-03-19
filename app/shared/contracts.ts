import { z } from "zod";

export const nodeTypes = [
  "note",
  "project",
  "idea",
  "question",
  "decision",
  "reference",
  "artifact_ref",
  "conversation"
] as const;

export const nodeStatuses = ["active", "draft", "review", "archived"] as const;
export const canonicalities = [
  "canonical",
  "appended",
  "suggested",
  "imported",
  "generated"
] as const;
export const relationTypes = [
  "related_to",
  "supports",
  "contradicts",
  "elaborates",
  "depends_on",
  "relevant_to",
  "derived_from",
  "produced_by"
] as const;
export const relationStatuses = ["active", "suggested", "rejected", "archived"] as const;
export const inferredRelationStatuses = ["active", "muted", "hidden", "expired"] as const;
export const relationSources = ["canonical", "inferred"] as const;
export const relationUsageEventTypes = [
  "bundle_included",
  "bundle_clicked",
  "bundle_used_in_output",
  "bundle_skipped",
  "retrieval_confirmed",
  "retrieval_muted",
  "manual_hide"
] as const;
export const activityTypes = [
  "note_appended",
  "agent_run_summary",
  "import_completed",
  "artifact_attached",
  "decision_recorded",
  "review_action",
  "context_bundle_generated"
] as const;
export const sourceTypes = ["human", "agent", "import", "system", "integration"] as const;
export const reviewTypes = [
  "relation_suggestion",
  "node_promotion",
  "canonical_edit",
  "merge_proposal",
  "archive_proposal"
] as const;
export const reviewStatuses = ["pending", "approved", "rejected", "dismissed"] as const;
export const bundleModes = ["micro", "compact", "standard", "deep"] as const;
export const bundlePresets = [
  "for-coding",
  "for-research",
  "for-decision",
  "for-writing",
  "for-assistant"
] as const;

export const sourceSchema = z.object({
  actorType: z.enum(sourceTypes),
  actorLabel: z.string().min(1),
  toolName: z.string().min(1),
  toolVersion: z.string().optional()
});

export const nodeSearchSchema = z.object({
  query: z.string().default(""),
  filters: z
    .object({
      types: z.array(z.enum(nodeTypes)).optional(),
      status: z.array(z.enum(nodeStatuses)).optional(),
      sourceLabels: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional()
    })
    .default({}),
  limit: z.number().int().min(1).max(100).default(10),
  offset: z.number().int().min(0).default(0),
  sort: z.enum(["relevance", "updated_at"]).default("relevance")
});

export const createNodeSchema = z.object({
  type: z.enum(nodeTypes),
  title: z.string().min(1),
  body: z.string().default(""),
  summary: z.string().optional(),
  tags: z.array(z.string()).default([]),
  canonicality: z.enum(canonicalities).optional(),
  status: z.enum(nodeStatuses).optional(),
  source: sourceSchema,
  metadata: z.record(z.any()).default({})
});

export const updateNodeSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
  status: z.enum(nodeStatuses).optional()
});

export const createRelationSchema = z.object({
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  relationType: z.enum(relationTypes),
  status: z.enum(relationStatuses).optional(),
  source: sourceSchema,
  metadata: z.record(z.any()).default({})
});

export const updateRelationSchema = z.object({
  status: z.enum(relationStatuses),
  source: sourceSchema,
  metadata: z.record(z.any()).default({}),
  notes: z.string().optional()
});

export const appendActivitySchema = z.object({
  targetNodeId: z.string().min(1),
  activityType: z.enum(activityTypes),
  body: z.string().default(""),
  source: sourceSchema,
  metadata: z.record(z.any()).default({})
});

export const upsertInferredRelationSchema = z.object({
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  relationType: z.enum(relationTypes),
  baseScore: z.number(),
  usageScore: z.number().default(0),
  finalScore: z.number(),
  status: z.enum(inferredRelationStatuses).default("active"),
  generator: z.string().min(1),
  evidence: z.record(z.any()).default({}),
  expiresAt: z.string().optional(),
  metadata: z.record(z.any()).default({})
});

export const appendRelationUsageEventSchema = z.object({
  relationId: z.string().min(1),
  relationSource: z.enum(relationSources),
  eventType: z.enum(relationUsageEventTypes),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  source: sourceSchema.optional(),
  delta: z.number(),
  metadata: z.record(z.any()).default({})
});

export const recomputeInferredRelationsSchema = z.object({
  relationIds: z.array(z.string().min(1)).max(200).optional(),
  generator: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).default(100)
});

export const reindexInferredRelationsSchema = z.object({
  limit: z.number().int().min(1).max(1000).default(250)
});

export const attachArtifactSchema = z.object({
  nodeId: z.string().min(1),
  path: z.string().min(1),
  mimeType: z.string().optional(),
  source: sourceSchema,
  metadata: z.record(z.any()).default({})
});

export const buildContextBundleSchema = z.object({
  target: z.object({
    type: z.string().default("node"),
    id: z.string().min(1)
  }),
  mode: z.enum(bundleModes).default("compact"),
  preset: z.enum(bundlePresets).default("for-assistant"),
  options: z
    .object({
      includeRelated: z.boolean().default(true),
      includeInferred: z.boolean().default(true),
      includeRecentActivities: z.boolean().default(true),
      includeDecisions: z.boolean().default(true),
      includeOpenQuestions: z.boolean().default(true),
      maxInferred: z.number().int().min(0).max(10).default(4),
      maxItems: z.number().int().min(1).max(30).default(10)
    })
    .default({})
});

export const reviewActionSchema = z.object({
  source: sourceSchema,
  notes: z.string().optional(),
  patch: z
    .object({
      title: z.string().optional(),
      body: z.string().optional(),
      summary: z.string().optional(),
      tags: z.array(z.string()).optional(),
      metadata: z.record(z.any()).optional()
    })
    .optional()
});

export const registerIntegrationSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  config: z.record(z.any()).default({})
});

export const updateIntegrationSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  config: z.record(z.any()).optional()
});

export const updateSettingsSchema = z.object({
  values: z.record(z.any())
});

export const createWorkspaceSchema = z.object({
  rootPath: z.string().min(1),
  workspaceName: z.string().min(1).optional()
});

export const openWorkspaceSchema = z.object({
  rootPath: z.string().min(1)
});

export type NodeType = (typeof nodeTypes)[number];
export type NodeStatus = (typeof nodeStatuses)[number];
export type Canonicality = (typeof canonicalities)[number];
export type RelationType = (typeof relationTypes)[number];
export type RelationStatus = (typeof relationStatuses)[number];
export type InferredRelationStatus = (typeof inferredRelationStatuses)[number];
export type RelationSource = (typeof relationSources)[number];
export type RelationUsageEventType = (typeof relationUsageEventTypes)[number];
export type ActivityType = (typeof activityTypes)[number];
export type ReviewType = (typeof reviewTypes)[number];
export type ReviewStatus = (typeof reviewStatuses)[number];
export type BundleMode = (typeof bundleModes)[number];
export type BundlePreset = (typeof bundlePresets)[number];
export type Source = z.infer<typeof sourceSchema>;
export type NodeSearchInput = z.infer<typeof nodeSearchSchema>;
export type CreateNodeInput = z.infer<typeof createNodeSchema>;
export type UpdateNodeInput = z.infer<typeof updateNodeSchema>;
export type CreateRelationInput = z.infer<typeof createRelationSchema>;
export type UpdateRelationInput = z.infer<typeof updateRelationSchema>;
export type AppendActivityInput = z.infer<typeof appendActivitySchema>;
export type UpsertInferredRelationInput = z.infer<typeof upsertInferredRelationSchema>;
export type AppendRelationUsageEventInput = z.infer<typeof appendRelationUsageEventSchema>;
export type RecomputeInferredRelationsInput = z.infer<typeof recomputeInferredRelationsSchema>;
export type ReindexInferredRelationsInput = z.infer<typeof reindexInferredRelationsSchema>;
export type AttachArtifactInput = z.infer<typeof attachArtifactSchema>;
export type BuildContextBundleInput = z.infer<typeof buildContextBundleSchema>;
export type ReviewActionInput = z.infer<typeof reviewActionSchema>;
export type RegisterIntegrationInput = z.infer<typeof registerIntegrationSchema>;
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type OpenWorkspaceInput = z.infer<typeof openWorkspaceSchema>;
