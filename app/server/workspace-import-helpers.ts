import type { ActivityType, CreateNodeInput, CreateRelationInput, NodeType } from "../shared/contracts.js";
import type {
  JsonMap,
  NodeRecord,
  WorkspaceImportOptions,
  WorkspaceImportPreviewDuplicate,
  WorkspaceImportPreviewItem,
  WorkspaceImportPreviewRecord,
} from "../shared/types.js";

export type ImportFormat = "recallx_json" | "markdown";

export type PlannedNode = {
  sourcePath: string;
  title: string;
  body: string;
  type: NodeType;
  summary?: string;
  tags: string[];
  canonicality?: CreateNodeInput["canonicality"];
  status?: CreateNodeInput["status"];
  metadata: JsonMap;
  originalId: string | null;
  originalSourceLabel: string | null;
  originalCreatedAt: string | null;
  duplicate: WorkspaceImportPreviewDuplicate | null;
};

export type PlannedRelation = {
  originalId: string | null;
  fromOriginalId: string | null;
  toOriginalId: string | null;
  relationType: CreateRelationInput["relationType"];
  status?: CreateRelationInput["status"];
  metadata: JsonMap;
};

export type PlannedActivity = {
  originalId: string | null;
  targetOriginalId: string | null;
  activityType: ActivityType;
  body: string;
  metadata: JsonMap;
  originalCreatedAt: string | null;
};

export type ImportPlan = {
  format: ImportFormat;
  label: string;
  sourcePath: string;
  createdAt: string;
  options: WorkspaceImportOptions;
  warnings: string[];
  nodes: PlannedNode[];
  relations: PlannedRelation[];
  activities: PlannedActivity[];
};

export type DuplicateIndex = {
  exact: Map<string, NodeRecord[]>;
  title: Map<string, NodeRecord[]>;
};

export type SeenImportIndex = {
  exact: Map<string, PlannedNode>;
  title: Map<string, PlannedNode>;
};

export const DEFAULT_IMPORT_OPTIONS: WorkspaceImportOptions = {
  normalizeTitleWhitespace: true,
  trimBodyWhitespace: false,
  duplicateMode: "warn",
};

export function resolveImportOptions(options?: Partial<WorkspaceImportOptions> | null): WorkspaceImportOptions {
  return {
    normalizeTitleWhitespace:
      typeof options?.normalizeTitleWhitespace === "boolean"
        ? options.normalizeTitleWhitespace
        : DEFAULT_IMPORT_OPTIONS.normalizeTitleWhitespace,
    trimBodyWhitespace:
      typeof options?.trimBodyWhitespace === "boolean"
        ? options.trimBodyWhitespace
        : DEFAULT_IMPORT_OPTIONS.trimBodyWhitespace,
    duplicateMode:
      options?.duplicateMode === "skip_exact" || options?.duplicateMode === "warn"
        ? options.duplicateMode
        : DEFAULT_IMPORT_OPTIONS.duplicateMode,
  };
}

export function normalizeTitle(value: string, options: WorkspaceImportOptions): string {
  const trimmed = value.trim();
  if (!options.normalizeTitleWhitespace) {
    return trimmed || "Imported node";
  }
  return trimmed.replace(/\s+/g, " ").trim() || "Imported node";
}

export function normalizeBody(value: string, options: WorkspaceImportOptions): string {
  const unix = value.replace(/\r\n/g, "\n");
  if (!options.trimBodyWhitespace) {
    return unix;
  }
  return unix.replace(/[ \t]+$/gm, "").replace(/\s+$/u, "");
}

export function buildTitleKey(title: string, options: WorkspaceImportOptions): string {
  return normalizeTitle(title, options).toLowerCase();
}

export function buildExactKey(type: NodeType, title: string, body: string, options: WorkspaceImportOptions): string {
  return `${type}::${buildTitleKey(title, options)}::${normalizeBody(body, options)}`;
}

export function buildDuplicateIndex(existingNodes: NodeRecord[], options: WorkspaceImportOptions): DuplicateIndex {
  const exact = new Map<string, NodeRecord[]>();
  const title = new Map<string, NodeRecord[]>();

  for (const node of existingNodes) {
    const nodeType = node.type;
    const nodeTitle = node.title ?? node.id;
    const nodeBody = node.body ?? "";
    const exactKey = buildExactKey(nodeType, nodeTitle, nodeBody, options);
    const titleKey = buildTitleKey(nodeTitle, options);
    exact.set(exactKey, [...(exact.get(exactKey) ?? []), node]);
    title.set(titleKey, [...(title.get(titleKey) ?? []), node]);
  }

  return { exact, title };
}

export function detectDuplicateMatch(params: {
  node: Pick<PlannedNode, "type" | "title" | "body" | "sourcePath">;
  options: WorkspaceImportOptions;
  existing: DuplicateIndex;
  seen: SeenImportIndex;
}): WorkspaceImportPreviewDuplicate | null {
  const exactKey = buildExactKey(params.node.type, params.node.title, params.node.body, params.options);
  const titleKey = buildTitleKey(params.node.title, params.options);
  const workspaceExact = params.existing.exact.get(exactKey)?.[0];
  if (workspaceExact) {
    return {
      title: params.node.title,
      sourcePath: params.node.sourcePath,
      matchType: "exact",
      existingNodeId: workspaceExact.id,
      existingNodeTitle: workspaceExact.title,
      existingSource: "workspace",
    };
  }

  const batchExact = params.seen.exact.get(exactKey);
  if (batchExact) {
    return {
      title: params.node.title,
      sourcePath: params.node.sourcePath,
      matchType: "exact",
      existingNodeId: null,
      existingNodeTitle: batchExact.title,
      existingSource: "batch",
    };
  }

  const workspaceTitle = params.existing.title.get(titleKey)?.[0];
  if (workspaceTitle) {
    return {
      title: params.node.title,
      sourcePath: params.node.sourcePath,
      matchType: "title",
      existingNodeId: workspaceTitle.id,
      existingNodeTitle: workspaceTitle.title,
      existingSource: "workspace",
    };
  }

  const batchTitle = params.seen.title.get(titleKey);
  if (batchTitle) {
    return {
      title: params.node.title,
      sourcePath: params.node.sourcePath,
      matchType: "title",
      existingNodeId: null,
      existingNodeTitle: batchTitle.title,
      existingSource: "batch",
    };
  }

  return null;
}

export function rememberSeenNode(node: PlannedNode, options: WorkspaceImportOptions, seen: SeenImportIndex) {
  const exactKey = buildExactKey(node.type, node.title, node.body, options);
  const titleKey = buildTitleKey(node.title, options);
  if (!seen.exact.has(exactKey)) {
    seen.exact.set(exactKey, node);
  }
  if (!seen.title.has(titleKey)) {
    seen.title.set(titleKey, node);
  }
}

export function buildPreviewFromPlan(plan: ImportPlan): WorkspaceImportPreviewRecord {
  const duplicateItems = plan.nodes
    .filter((node): node is PlannedNode & { duplicate: WorkspaceImportPreviewDuplicate } => node.duplicate !== null)
    .map((node) => node.duplicate);
  const exactDuplicateCandidates = duplicateItems.filter((item) => item.matchType === "exact").length;
  const skippedOriginalIds = new Set(
    plan.options.duplicateMode === "skip_exact"
      ? plan.nodes.filter((node) => node.duplicate?.matchType === "exact" && node.originalId).map((node) => node.originalId as string)
      : []
  );
  const skippedNodes = plan.options.duplicateMode === "skip_exact"
    ? plan.nodes.filter((node) => node.duplicate?.matchType === "exact").length
    : 0;
  const skippedRelations = plan.options.duplicateMode === "skip_exact"
    ? plan.relations.filter((relation) =>
        (relation.fromOriginalId && skippedOriginalIds.has(relation.fromOriginalId)) ||
        (relation.toOriginalId && skippedOriginalIds.has(relation.toOriginalId))
      ).length
    : 0;
  const skippedActivities = plan.options.duplicateMode === "skip_exact"
    ? plan.activities.filter((activity) => activity.targetOriginalId && skippedOriginalIds.has(activity.targetOriginalId)).length
    : 0;

  return {
    format: plan.format,
    label: plan.label,
    sourcePath: plan.sourcePath,
    createdAt: plan.createdAt,
    options: plan.options,
    nodesDetected: plan.nodes.length,
    relationsDetected: plan.relations.length,
    activitiesDetected: plan.activities.length,
    duplicateCandidates: duplicateItems.length,
    exactDuplicateCandidates,
    nodesReady: plan.nodes.length - skippedNodes,
    relationsReady: plan.relations.length - skippedRelations,
    activitiesReady: plan.activities.length - skippedActivities,
    skippedNodes,
    skippedRelations,
    skippedActivities,
    warnings: [
      ...plan.warnings,
      ...(duplicateItems.length
        ? [`Detected ${duplicateItems.length} likely duplicate node(s) in the current import preview.`]
        : []),
    ],
    sampleItems: plan.nodes.slice(0, 5).map<WorkspaceImportPreviewItem>((node) => ({
      title: node.title,
      type: node.type,
      sourcePath: node.sourcePath,
      duplicateKind: node.duplicate?.matchType ?? null,
    })),
    duplicateItems,
  };
}
