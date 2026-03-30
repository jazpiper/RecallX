import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ActivityType, CreateNodeInput, CreateRelationInput } from "../shared/contracts.js";
import type { JsonMap, WorkspaceBackupRecord, WorkspaceImportRecord } from "../shared/types.js";
import { RECALLX_VERSION } from "../shared/version.js";
import { AppError } from "./errors.js";
import { resolveNodeGovernance, resolveRelationStatus } from "./governance.js";
import type { RecallXRepository } from "./repositories.js";
import type { WorkspacePaths } from "./workspace.js";

type ImportFormat = "recallx_json" | "markdown";

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
  const destination = path.join(paths.importsDir, `${stamp}-${slugify(label)}${extension}`);
  mkdirSync(paths.importsDir, { recursive: true });
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

function importMarkdownFiles(params: {
  repository: RecallXRepository;
  sourcePath: string;
  importLabel: string;
  importedPath: string;
  now: string;
}): { nodesCreated: number; relationsCreated: number; activitiesCreated: number; warnings: string[] } {
  const files = listMarkdownFiles(params.sourcePath);
  if (!files.length) {
    throw new AppError(400, "NO_MARKDOWN_FILES", "No markdown files were found to import.");
  }

  const source = buildImportSource(params.importLabel);
  let nodesCreated = 0;

  for (const filePath of files) {
    const body = readFileSync(filePath, "utf8");
    const nodeInput: CreateNodeInput = {
      type: "note",
      title: deriveMarkdownTitle(filePath, body),
      body,
      tags: [],
      source,
      metadata: {
        importFormat: "markdown",
        importLabel: params.importLabel,
        originalSourcePath: filePath,
        importedSourcePath: params.importedPath,
        importedAt: params.now,
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
        originalSourcePath: filePath,
        importedSourcePath: params.importedPath,
      },
    });
    nodesCreated += 1;
  }

  return {
    nodesCreated,
    relationsCreated: 0,
    activitiesCreated: 0,
    warnings: [],
  };
}

function importRecallXJson(params: {
  repository: RecallXRepository;
  sourcePath: string;
  importLabel: string;
  importedPath: string;
  now: string;
}): { nodesCreated: number; relationsCreated: number; activitiesCreated: number; warnings: string[] } {
  const raw = JSON.parse(readFileSync(params.sourcePath, "utf8")) as RecallXJsonExportPayload;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const relations = Array.isArray(raw.relations) ? raw.relations : [];
  const activities = Array.isArray(raw.activities) ? raw.activities : [];
  const source = buildImportSource(params.importLabel);
  const nodeIdMap = new Map<string, string>();
  let nodesCreated = 0;
  let relationsCreated = 0;
  let activitiesCreated = 0;
  const warnings: string[] = [];

  for (const rawNode of nodes) {
    const originalId = typeof rawNode.id === "string" ? rawNode.id : null;
    const nodeInput: CreateNodeInput = {
      type:
        rawNode.type === "project" ||
        rawNode.type === "idea" ||
        rawNode.type === "question" ||
        rawNode.type === "decision" ||
        rawNode.type === "reference" ||
        rawNode.type === "artifact_ref" ||
        rawNode.type === "conversation"
          ? rawNode.type
          : "note",
      title: (typeof rawNode.title === "string" && rawNode.title.trim()) || originalId || "Imported node",
      body: typeof rawNode.body === "string" ? rawNode.body : "",
      summary: typeof rawNode.summary === "string" ? rawNode.summary : undefined,
      tags: asStringArray(rawNode.tags),
      canonicality:
        rawNode.canonicality === "canonical" ||
        rawNode.canonicality === "appended" ||
        rawNode.canonicality === "suggested" ||
        rawNode.canonicality === "imported" ||
        rawNode.canonicality === "generated"
          ? rawNode.canonicality
          : undefined,
      status:
        rawNode.status === "active" ||
        rawNode.status === "draft" ||
        rawNode.status === "contested" ||
        rawNode.status === "archived"
          ? rawNode.status
          : undefined,
      source,
      metadata: {
        ...asObject(rawNode.metadata),
        importFormat: "recallx_json",
        importLabel: params.importLabel,
        originalId,
        originalSourceLabel: typeof rawNode.sourceLabel === "string" ? rawNode.sourceLabel : null,
        originalCreatedAt: typeof rawNode.createdAt === "string" ? rawNode.createdAt : null,
        importedSourcePath: params.importedPath,
        importedAt: params.now,
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
        originalId,
        importedSourcePath: params.importedPath,
      },
    });
    if (originalId) {
      nodeIdMap.set(originalId, node.id);
    }
    nodesCreated += 1;
  }

  for (const rawRelation of relations) {
    const fromNodeId = typeof rawRelation.fromNodeId === "string" ? nodeIdMap.get(rawRelation.fromNodeId) : null;
    const toNodeId = typeof rawRelation.toNodeId === "string" ? nodeIdMap.get(rawRelation.toNodeId) : null;
    if (!fromNodeId || !toNodeId) {
      continue;
    }
    const relationInput: CreateRelationInput = {
      fromNodeId,
      toNodeId,
      relationType:
        rawRelation.relationType === "supports" ||
        rawRelation.relationType === "contradicts" ||
        rawRelation.relationType === "elaborates" ||
        rawRelation.relationType === "depends_on" ||
        rawRelation.relationType === "relevant_to" ||
        rawRelation.relationType === "derived_from" ||
        rawRelation.relationType === "produced_by"
          ? rawRelation.relationType
          : "related_to",
      status:
        rawRelation.status === "active" ||
        rawRelation.status === "suggested" ||
        rawRelation.status === "rejected" ||
        rawRelation.status === "archived"
          ? rawRelation.status
          : undefined,
      source,
      metadata: {
        ...asObject(rawRelation.metadata),
        originalId: typeof rawRelation.id === "string" ? rawRelation.id : null,
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
        originalId: typeof rawRelation.id === "string" ? rawRelation.id : null,
        importedSourcePath: params.importedPath,
      },
    });
    relationsCreated += 1;
  }

  for (const rawActivity of activities) {
    const targetNodeId = typeof rawActivity.targetNodeId === "string" ? nodeIdMap.get(rawActivity.targetNodeId) : null;
    if (!targetNodeId) {
      continue;
    }
    const activity = params.repository.appendActivity({
      targetNodeId,
      activityType: asActivityType(rawActivity.activityType),
      body: typeof rawActivity.body === "string" ? rawActivity.body : "",
      source,
      metadata: {
        ...asObject(rawActivity.metadata),
        originalId: typeof rawActivity.id === "string" ? rawActivity.id : null,
        originalCreatedAt: typeof rawActivity.createdAt === "string" ? rawActivity.createdAt : null,
        importedSourcePath: params.importedPath,
      },
    });
    params.repository.recordProvenance({
      entityType: "activity",
      entityId: activity.id,
      operationType: "import",
      source,
      metadata: {
        originalId: typeof rawActivity.id === "string" ? rawActivity.id : null,
        importedSourcePath: params.importedPath,
      },
    });
    activitiesCreated += 1;
  }

  if ((raw.artifacts?.length ?? 0) > 0) {
    warnings.push("Artifact files were not imported in this first onboarding flow.");
  }
  if ((raw.integrations?.length ?? 0) > 0) {
    warnings.push("Integration records were not imported in this first onboarding flow.");
  }
  if (raw.settings && Object.keys(raw.settings).length > 0) {
    warnings.push("Workspace settings were not imported in this first onboarding flow.");
  }

  return {
    nodesCreated,
    relationsCreated,
    activitiesCreated,
    warnings,
  };
}

export function importIntoWorkspace(params: {
  repository: RecallXRepository;
  paths: WorkspacePaths;
  format: ImportFormat;
  sourcePath: string;
  label?: string;
  now: string;
  backup: WorkspaceBackupRecord;
}): WorkspaceImportRecord {
  const resolvedSourcePath = resolveSourcePath(params.sourcePath);
  const label =
    sanitizeLabel(params.label, path.basename(resolvedSourcePath, path.extname(resolvedSourcePath)) || "Workspace import");
  const importedPath = copyImportSource(params.paths, resolvedSourcePath, label, params.now);
  const source = buildImportSource(label);
  const counts =
    params.format === "markdown"
      ? importMarkdownFiles({
          repository: params.repository,
          sourcePath: resolvedSourcePath,
          importLabel: label,
          importedPath,
          now: params.now,
        })
      : importRecallXJson({
          repository: params.repository,
          sourcePath: resolvedSourcePath,
          importLabel: label,
          importedPath,
          now: params.now,
        });

  const inboxNode = params.repository.ensureWorkspaceInboxNode();
  const summaryActivity = params.repository.appendActivity({
    targetNodeId: inboxNode.id,
    activityType: "import_completed",
    body: `Imported ${counts.nodesCreated} node(s), ${counts.relationsCreated} relation(s), and ${counts.activitiesCreated} activity item(s) from ${path.basename(resolvedSourcePath)}.`,
    source,
    metadata: {
      importFormat: params.format,
      importLabel: label,
      sourcePath: resolvedSourcePath,
      importedPath,
      backupId: params.backup.id,
      backupPath: params.backup.backupPath,
      warnings: counts.warnings,
    },
  });
  params.repository.recordProvenance({
    entityType: "activity",
    entityId: summaryActivity.id,
    operationType: "import",
    source,
    metadata: {
      sourcePath: resolvedSourcePath,
      importedPath,
      backupId: params.backup.id,
    },
  });

  return {
    format: params.format,
    label,
    sourcePath: resolvedSourcePath,
    importedPath,
    createdAt: params.now,
    backupId: params.backup.id,
    backupPath: params.backup.backupPath,
    nodesCreated: counts.nodesCreated,
    relationsCreated: counts.relationsCreated,
    activitiesCreated: counts.activitiesCreated + 1,
    warnings: counts.warnings,
  };
}
