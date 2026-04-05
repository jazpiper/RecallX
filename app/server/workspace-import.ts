import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ActivityType, CreateNodeInput, CreateRelationInput, NodeType } from "../shared/contracts.js";
import type {
  JsonMap,
  NodeRecord,
  WorkspaceBackupRecord,
  WorkspaceImportOptions,
  WorkspaceImportPreviewRecord,
  WorkspaceImportRecord,
} from "../shared/types.js";
import { RECALLX_VERSION } from "../shared/version.js";
import { AppError } from "./errors.js";
import { resolveNodeGovernance, resolveRelationStatus } from "./governance.js";
import type { RecallXRepository } from "./repositories.js";
import {
  buildDuplicateIndex,
  buildPreviewFromPlan,
  detectDuplicateMatch,
  normalizeBody,
  normalizeTitle,
  rememberSeenNode,
  resolveImportOptions,
  type DuplicateIndex,
  type ImportFormat,
  type ImportPlan,
  type PlannedActivity,
  type PlannedNode,
  type PlannedRelation,
  type SeenImportIndex,
} from "./workspace-import-helpers.js";
import type { WorkspacePaths } from "./workspace.js";

type ImportSource = {
  actorType: "import";
  actorLabel: string;
  toolName: "recallx-import";
  toolVersion: string;
};

type RecallXJsonExportPayload = {
  workspace?: Record<string, unknown>;
  nodes?: Array<Record<string, unknown>>;
  relations?: Array<Record<string, unknown>>;
  activities?: Array<Record<string, unknown>>;
  artifacts?: Array<Record<string, unknown>>;
  integrations?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
};

type ImportCounts = {
  nodesCreated: number;
  relationsCreated: number;
  activitiesCreated: number;
  skippedNodes: number;
  skippedRelations: number;
  skippedActivities: number;
  warnings: string[];
};

function sanitizeLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/\s+/g, " ").trim() || fallback;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "import";
}

function resolveUniqueImportStem(baseStem: string, extension: string, importsDir: string): string {
  let candidate = baseStem;
  let suffix = 2;
  while (existsSync(path.join(importsDir, `${candidate}${extension}`))) {
    candidate = `${baseStem}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function buildImportSource(label: string): ImportSource {
  return {
    actorType: "import",
    actorLabel: label,
    toolName: "recallx-import",
    toolVersion: RECALLX_VERSION,
  };
}

function resolveSourcePath(sourcePath: string): string {
  const resolved = path.resolve(sourcePath);
  if (!existsSync(resolved)) {
    throw new AppError(404, "IMPORT_SOURCE_NOT_FOUND", `Import source not found: ${resolved}`);
  }
  return resolved;
}

function copyImportSource(paths: WorkspacePaths, sourcePath: string, label: string, now: string): string {
  const entry = lstatSync(sourcePath);
  const stamp = now.replace(/[-:.TZ]/g, "").slice(0, 14);
  const extension = entry.isDirectory() ? "" : path.extname(sourcePath);
  mkdirSync(paths.importsDir, { recursive: true });
  const destination = path.join(
    paths.importsDir,
    `${resolveUniqueImportStem(`${stamp}-${slugify(label)}`, extension, paths.importsDir)}${extension}`
  );
  if (entry.isDirectory()) {
    cpSync(sourcePath, destination, { recursive: true });
  } else {
    copyFileSync(sourcePath, destination);
  }
  return destination;
}

function listMarkdownFiles(sourcePath: string): string[] {
  const entry = lstatSync(sourcePath);
  if (entry.isDirectory()) {
    const results: string[] = [];
    for (const child of readdirSync(sourcePath, { withFileTypes: true })) {
      const childPath = path.join(sourcePath, child.name);
      if (child.isDirectory()) {
        results.push(...listMarkdownFiles(childPath));
      } else if (child.isFile() && /\.(md|markdown)$/i.test(child.name)) {
        results.push(childPath);
      }
    }
    return results.sort();
  }

  if (entry.isFile() && /\.(md|markdown)$/i.test(sourcePath)) {
    return [sourcePath];
  }

  throw new AppError(400, "INVALID_IMPORT_SOURCE", "Markdown import expects a .md file or a folder containing markdown files.");
}

function deriveMarkdownTitle(filePath: string, body: string): string {
  const heading = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "));
  if (heading) {
    return heading.slice(2).trim() || path.basename(filePath, path.extname(filePath));
  }
  return path.basename(filePath, path.extname(filePath));
}

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonMap) } : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asActivityType(value: unknown): ActivityType {
  return value === "agent_run_summary" ||
    value === "import_completed" ||
    value === "artifact_attached" ||
    value === "decision_recorded" ||
    value === "review_action" ||
    value === "context_bundle_generated"
    ? value
    : "note_appended";
}

function asNodeType(value: unknown): NodeType {
  return value === "project" ||
    value === "idea" ||
    value === "question" ||
    value === "decision" ||
    value === "reference" ||
    value === "artifact_ref" ||
    value === "conversation"
    ? value
    : "note";
}

function asCanonicality(value: unknown): CreateNodeInput["canonicality"] | undefined {
  return value === "canonical" ||
    value === "appended" ||
    value === "suggested" ||
    value === "imported" ||
    value === "generated"
    ? value
    : undefined;
}

function asNodeStatus(value: unknown): CreateNodeInput["status"] | undefined {
  return value === "active" ||
    value === "draft" ||
    value === "contested" ||
    value === "archived"
    ? value
    : undefined;
}

function asRelationType(value: unknown): CreateRelationInput["relationType"] {
  return value === "supports" ||
    value === "contradicts" ||
    value === "elaborates" ||
    value === "depends_on" ||
    value === "relevant_to" ||
    value === "derived_from" ||
    value === "produced_by"
    ? value
    : "related_to";
}

function asRelationStatus(value: unknown): CreateRelationInput["status"] | undefined {
  return value === "active" ||
    value === "suggested" ||
    value === "rejected" ||
    value === "archived"
    ? value
    : undefined;
}

function buildMarkdownPlan(params: {
  repository: RecallXRepository;
  sourcePath: string;
  label: string;
  now: string;
  options: WorkspaceImportOptions;
}): ImportPlan {
  const files = listMarkdownFiles(params.sourcePath);
  if (!files.length) {
    throw new AppError(400, "NO_MARKDOWN_FILES", "No markdown files were found to import.");
  }

  const existing = buildDuplicateIndex(params.repository.listAllNodes(), params.options);
  const seen: SeenImportIndex = {
    exact: new Map(),
    title: new Map(),
  };

  const nodes: PlannedNode[] = files.map((filePath) => {
    const rawBody = readFileSync(filePath, "utf8");
    const body = normalizeBody(rawBody, params.options);
    const title = normalizeTitle(deriveMarkdownTitle(filePath, rawBody), params.options);
    const plannedNode: PlannedNode = {
      sourcePath: filePath,
      title,
      body,
      type: "note",
      tags: [],
      metadata: {
        importFormat: "markdown",
        importLabel: params.label,
        originalSourcePath: filePath,
      },
      originalId: null,
      originalSourceLabel: null,
      originalCreatedAt: null,
      duplicate: null,
    };
    plannedNode.duplicate = detectDuplicateMatch({
      node: plannedNode,
      options: params.options,
      existing,
      seen,
    });
    rememberSeenNode(plannedNode, params.options, seen);
    return plannedNode;
  });

  return {
    format: "markdown",
    label: params.label,
    sourcePath: params.sourcePath,
    createdAt: params.now,
    options: params.options,
    warnings: [],
    nodes,
    relations: [],
    activities: [],
  };
}

function buildRecallXJsonPlan(params: {
  repository: RecallXRepository;
  sourcePath: string;
  label: string;
  now: string;
  options: WorkspaceImportOptions;
}): ImportPlan {
  const raw = JSON.parse(readFileSync(params.sourcePath, "utf8")) as RecallXJsonExportPayload;
  const existing = buildDuplicateIndex(params.repository.listAllNodes(), params.options);
  const seen: SeenImportIndex = {
    exact: new Map(),
    title: new Map(),
  };
  const warnings: string[] = [];

  const nodes: PlannedNode[] = (Array.isArray(raw.nodes) ? raw.nodes : []).map((rawNode, index) => {
    const originalId = typeof rawNode.id === "string" ? rawNode.id : null;
    const rawTitle = (typeof rawNode.title === "string" && rawNode.title.trim()) || originalId || `Imported node ${index + 1}`;
    const body = normalizeBody(typeof rawNode.body === "string" ? rawNode.body : "", params.options);
    const plannedNode: PlannedNode = {
      sourcePath: `${params.sourcePath}#node:${originalId ?? index + 1}`,
      title: normalizeTitle(rawTitle, params.options),
      body,
      type: asNodeType(rawNode.type),
      summary: typeof rawNode.summary === "string" ? rawNode.summary : undefined,
      tags: asStringArray(rawNode.tags),
      canonicality: asCanonicality(rawNode.canonicality),
      status: asNodeStatus(rawNode.status),
      metadata: {
        ...asObject(rawNode.metadata),
        importFormat: "recallx_json",
        importLabel: params.label,
        originalId,
        originalSourceLabel: typeof rawNode.sourceLabel === "string" ? rawNode.sourceLabel : null,
        originalCreatedAt: typeof rawNode.createdAt === "string" ? rawNode.createdAt : null,
      },
      originalId,
      originalSourceLabel: typeof rawNode.sourceLabel === "string" ? rawNode.sourceLabel : null,
      originalCreatedAt: typeof rawNode.createdAt === "string" ? rawNode.createdAt : null,
      duplicate: null,
    };
    plannedNode.duplicate = detectDuplicateMatch({
      node: plannedNode,
      options: params.options,
      existing,
      seen,
    });
    rememberSeenNode(plannedNode, params.options, seen);
    return plannedNode;
  });

  const relations: PlannedRelation[] = (Array.isArray(raw.relations) ? raw.relations : []).map((rawRelation) => ({
    originalId: typeof rawRelation.id === "string" ? rawRelation.id : null,
    fromOriginalId: typeof rawRelation.fromNodeId === "string" ? rawRelation.fromNodeId : null,
    toOriginalId: typeof rawRelation.toNodeId === "string" ? rawRelation.toNodeId : null,
    relationType: asRelationType(rawRelation.relationType),
    status: asRelationStatus(rawRelation.status),
    metadata: asObject(rawRelation.metadata),
  }));

  const activities: PlannedActivity[] = (Array.isArray(raw.activities) ? raw.activities : []).map((rawActivity) => ({
    originalId: typeof rawActivity.id === "string" ? rawActivity.id : null,
    targetOriginalId: typeof rawActivity.targetNodeId === "string" ? rawActivity.targetNodeId : null,
    activityType: asActivityType(rawActivity.activityType),
    body: typeof rawActivity.body === "string" ? rawActivity.body : "",
    metadata: asObject(rawActivity.metadata),
    originalCreatedAt: typeof rawActivity.createdAt === "string" ? rawActivity.createdAt : null,
  }));

  if ((raw.artifacts?.length ?? 0) > 0) {
    warnings.push("Artifact files were not imported in this flow.");
  }
  if ((raw.integrations?.length ?? 0) > 0) {
    warnings.push("Integration records were not imported in this flow.");
  }
  if (raw.settings && Object.keys(raw.settings).length > 0) {
    warnings.push("Workspace settings were not imported in this flow.");
  }

  return {
    format: "recallx_json",
    label: params.label,
    sourcePath: params.sourcePath,
    createdAt: params.now,
    options: params.options,
    warnings,
    nodes,
    relations,
    activities,
  };
}

function buildImportPlan(params: {
  repository: RecallXRepository;
  format: ImportFormat;
  sourcePath: string;
  label?: string;
  now: string;
  options?: Partial<WorkspaceImportOptions> | null;
}): ImportPlan {
  const resolvedSourcePath = resolveSourcePath(params.sourcePath);
  const label =
    sanitizeLabel(params.label, path.basename(resolvedSourcePath, path.extname(resolvedSourcePath)) || "Workspace import");
  const options = resolveImportOptions(params.options);

  return params.format === "markdown"
    ? buildMarkdownPlan({
        repository: params.repository,
        sourcePath: resolvedSourcePath,
        label,
        now: params.now,
        options,
      })
    : buildRecallXJsonPlan({
        repository: params.repository,
        sourcePath: resolvedSourcePath,
        label,
        now: params.now,
        options,
      });
}


function applyMarkdownPlan(params: {
  repository: RecallXRepository;
  plan: ImportPlan;
  importedPath: string;
}): ImportCounts {
  const source = buildImportSource(params.plan.label);
  let nodesCreated = 0;
  let skippedNodes = 0;

  for (const plannedNode of params.plan.nodes) {
    if (params.plan.options.duplicateMode === "skip_exact" && plannedNode.duplicate?.matchType === "exact") {
      skippedNodes += 1;
      continue;
    }

    const nodeInput: CreateNodeInput = {
      type: plannedNode.type,
      title: plannedNode.title,
      body: plannedNode.body,
      tags: plannedNode.tags,
      source,
      metadata: {
        ...plannedNode.metadata,
        importedSourcePath: params.importedPath,
        importedAt: params.plan.createdAt,
      },
    };
    const governance = resolveNodeGovernance(nodeInput);
    const node = params.repository.createNode({
      ...nodeInput,
      resolvedCanonicality: governance.canonicality,
      resolvedStatus: governance.status,
    });
    params.repository.recordProvenance({
      entityType: "node",
      entityId: node.id,
      operationType: "import",
      source,
      metadata: {
        originalSourcePath: plannedNode.sourcePath,
        importedSourcePath: params.importedPath,
      },
    });
    nodesCreated += 1;
  }

  const warnings = [...params.plan.warnings];
  if (skippedNodes > 0) {
    warnings.push(`Skipped ${skippedNodes} exact duplicate node(s).`);
  }

  return {
    nodesCreated,
    relationsCreated: 0,
    activitiesCreated: 0,
    skippedNodes,
    skippedRelations: 0,
    skippedActivities: 0,
    warnings,
  };
}

function applyRecallXJsonPlan(params: {
  repository: RecallXRepository;
  plan: ImportPlan;
  importedPath: string;
}): ImportCounts {
  const source = buildImportSource(params.plan.label);
  const nodeIdMap = new Map<string, string>();
  const skippedOriginalIds = new Set<string>();
  let nodesCreated = 0;
  let relationsCreated = 0;
  let activitiesCreated = 0;
  let skippedNodes = 0;
  let skippedRelations = 0;
  let skippedActivities = 0;

  for (const plannedNode of params.plan.nodes) {
    if (params.plan.options.duplicateMode === "skip_exact" && plannedNode.duplicate?.matchType === "exact") {
      skippedNodes += 1;
      if (plannedNode.originalId) {
        skippedOriginalIds.add(plannedNode.originalId);
      }
      continue;
    }

    const nodeInput: CreateNodeInput = {
      type: plannedNode.type,
      title: plannedNode.title,
      body: plannedNode.body,
      summary: plannedNode.summary,
      tags: plannedNode.tags,
      canonicality: plannedNode.canonicality,
      status: plannedNode.status,
      source,
      metadata: {
        ...plannedNode.metadata,
        importedSourcePath: params.importedPath,
        importedAt: params.plan.createdAt,
      },
    };
    const governance = resolveNodeGovernance(nodeInput);
    const node = params.repository.createNode({
      ...nodeInput,
      resolvedCanonicality: governance.canonicality,
      resolvedStatus: governance.status,
    });
    params.repository.recordProvenance({
      entityType: "node",
      entityId: node.id,
      operationType: "import",
      source,
      metadata: {
        originalId: plannedNode.originalId,
        importedSourcePath: params.importedPath,
      },
    });
    if (plannedNode.originalId) {
      nodeIdMap.set(plannedNode.originalId, node.id);
    }
    nodesCreated += 1;
  }

  for (const plannedRelation of params.plan.relations) {
    if (
      (plannedRelation.fromOriginalId && skippedOriginalIds.has(plannedRelation.fromOriginalId)) ||
      (plannedRelation.toOriginalId && skippedOriginalIds.has(plannedRelation.toOriginalId))
    ) {
      skippedRelations += 1;
      continue;
    }
    const fromNodeId = plannedRelation.fromOriginalId ? nodeIdMap.get(plannedRelation.fromOriginalId) : null;
    const toNodeId = plannedRelation.toOriginalId ? nodeIdMap.get(plannedRelation.toOriginalId) : null;
    if (!fromNodeId || !toNodeId) {
      skippedRelations += 1;
      continue;
    }
    const relationInput: CreateRelationInput = {
      fromNodeId,
      toNodeId,
      relationType: plannedRelation.relationType,
      status: plannedRelation.status,
      source,
      metadata: {
        ...plannedRelation.metadata,
        originalId: plannedRelation.originalId,
        importedSourcePath: params.importedPath,
      },
    };
    const resolved = resolveRelationStatus(relationInput);
    const relation = params.repository.createRelation({
      ...relationInput,
      resolvedStatus: resolved.status,
    });
    params.repository.recordProvenance({
      entityType: "relation",
      entityId: relation.id,
      operationType: "import",
      source,
      metadata: {
        originalId: plannedRelation.originalId,
        importedSourcePath: params.importedPath,
      },
    });
    relationsCreated += 1;
  }

  for (const plannedActivity of params.plan.activities) {
    if (plannedActivity.targetOriginalId && skippedOriginalIds.has(plannedActivity.targetOriginalId)) {
      skippedActivities += 1;
      continue;
    }
    const targetNodeId = plannedActivity.targetOriginalId ? nodeIdMap.get(plannedActivity.targetOriginalId) : null;
    if (!targetNodeId) {
      skippedActivities += 1;
      continue;
    }
    const activity = params.repository.appendActivity({
      targetNodeId,
      activityType: plannedActivity.activityType,
      body: plannedActivity.body,
      source,
      metadata: {
        ...plannedActivity.metadata,
        originalId: plannedActivity.originalId,
        originalCreatedAt: plannedActivity.originalCreatedAt,
        importedSourcePath: params.importedPath,
      },
    });
    params.repository.recordProvenance({
      entityType: "activity",
      entityId: activity.id,
      operationType: "import",
      source,
      metadata: {
        originalId: plannedActivity.originalId,
        importedSourcePath: params.importedPath,
      },
    });
    activitiesCreated += 1;
  }

  const warnings = [...params.plan.warnings];
  if (skippedNodes > 0) {
    warnings.push(`Skipped ${skippedNodes} exact duplicate node(s).`);
  }

  return {
    nodesCreated,
    relationsCreated,
    activitiesCreated,
    skippedNodes,
    skippedRelations,
    skippedActivities,
    warnings,
  };
}

function applyImportPlan(params: {
  repository: RecallXRepository;
  plan: ImportPlan;
  importedPath: string;
  backup: WorkspaceBackupRecord;
}): WorkspaceImportRecord {
  const counts =
    params.plan.format === "markdown"
      ? applyMarkdownPlan({
          repository: params.repository,
          plan: params.plan,
          importedPath: params.importedPath,
        })
      : applyRecallXJsonPlan({
          repository: params.repository,
          plan: params.plan,
          importedPath: params.importedPath,
        });

  const source = buildImportSource(params.plan.label);
  const inboxNode = params.repository.ensureWorkspaceInboxNode();
  const skippedSummary =
    counts.skippedNodes || counts.skippedRelations || counts.skippedActivities
      ? ` Skipped ${counts.skippedNodes} node(s), ${counts.skippedRelations} relation(s), and ${counts.skippedActivities} activity item(s).`
      : "";
  const summaryActivity = params.repository.appendActivity({
    targetNodeId: inboxNode.id,
    activityType: "import_completed",
    body:
      `Imported ${counts.nodesCreated} node(s), ${counts.relationsCreated} relation(s), and ${counts.activitiesCreated} activity item(s) from ${path.basename(params.plan.sourcePath)}.` +
      skippedSummary,
    source,
    metadata: {
      importFormat: params.plan.format,
      importLabel: params.plan.label,
      sourcePath: params.plan.sourcePath,
      importedPath: params.importedPath,
      backupId: params.backup.id,
      backupPath: params.backup.backupPath,
      options: params.plan.options,
      warnings: counts.warnings,
      skippedNodes: counts.skippedNodes,
      skippedRelations: counts.skippedRelations,
      skippedActivities: counts.skippedActivities,
    },
  });
  params.repository.recordProvenance({
    entityType: "activity",
    entityId: summaryActivity.id,
    operationType: "import",
    source,
    metadata: {
      sourcePath: params.plan.sourcePath,
      importedPath: params.importedPath,
      backupId: params.backup.id,
    },
  });

  return {
    format: params.plan.format,
    label: params.plan.label,
    sourcePath: params.plan.sourcePath,
    importedPath: params.importedPath,
    createdAt: params.plan.createdAt,
    options: params.plan.options,
    backupId: params.backup.id,
    backupPath: params.backup.backupPath,
    nodesCreated: counts.nodesCreated,
    relationsCreated: counts.relationsCreated,
    activitiesCreated: counts.activitiesCreated + 1,
    skippedNodes: counts.skippedNodes,
    skippedRelations: counts.skippedRelations,
    skippedActivities: counts.skippedActivities,
    warnings: counts.warnings,
  };
}

export function previewImportIntoWorkspace(params: {
  repository: RecallXRepository;
  format: ImportFormat;
  sourcePath: string;
  label?: string;
  now: string;
  options?: Partial<WorkspaceImportOptions> | null;
}): WorkspaceImportPreviewRecord {
  const plan = buildImportPlan(params);
  return buildPreviewFromPlan(plan);
}

export function importIntoWorkspace(params: {
  repository: RecallXRepository;
  paths: WorkspacePaths;
  format: ImportFormat;
  sourcePath: string;
  label?: string;
  now: string;
  backup: WorkspaceBackupRecord;
  options?: Partial<WorkspaceImportOptions> | null;
}): WorkspaceImportRecord {
  const plan = buildImportPlan({
    repository: params.repository,
    format: params.format,
    sourcePath: params.sourcePath,
    label: params.label,
    now: params.now,
    options: params.options,
  });
  const importedPath = copyImportSource(params.paths, plan.sourcePath, plan.label, plan.createdAt);
  return applyImportPlan({
    repository: params.repository,
    plan,
    importedPath,
    backup: params.backup,
  });
}
