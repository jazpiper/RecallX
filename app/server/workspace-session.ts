import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config.js";
import { workspaceInfo } from "./config.js";
import { openDatabase } from "./db.js";
import { AppError } from "./errors.js";
import { bootstrapAutomaticGovernance } from "./governance.js";
import { RecallXRepository } from "./repositories.js";
import {
  beginWorkspaceSession,
  createWorkspaceBackup,
  endWorkspaceSession,
  exportWorkspaceSnapshot,
  listWorkspaceBackups,
  restoreWorkspaceBackup,
} from "./workspace-ops.js";
import { importIntoWorkspace, previewImportIntoWorkspace } from "./workspace-import.js";
import { defaultWorkspaceName, ensureWorkspace, recallxHomeDir, type WorkspacePaths } from "./workspace.js";
import type {
  WorkspaceBackupRecord,
  WorkspaceCatalogItem,
  WorkspaceExportRecord,
  WorkspaceImportOptions,
  WorkspaceImportPreviewRecord,
  WorkspaceImportRecord,
  WorkspaceInfo,
} from "../shared/types.js";
import { RECALLX_VERSION } from "../shared/version.js";

interface WorkspaceSessionState {
  db: DatabaseSync;
  repository: RecallXRepository;
  workspaceInfo: WorkspaceInfo;
  workspaceRoot: string;
  paths: WorkspacePaths;
}

type RestoreWorkspaceResult = {
  workspace: WorkspaceCatalogItem;
  autoBackup: WorkspaceBackupRecord;
};

type PersistedWorkspaceCatalog = {
  version: 1;
  items: PersistedWorkspaceCatalogItem[];
};

type PersistedWorkspaceCatalogItem = {
  rootPath: string;
  workspaceName: string;
  lastOpenedAt: string;
};

const WORKSPACE_CATALOG_FILE = "workspace-catalog.json";

function workspaceCatalogFilePath(): string {
  return path.join(recallxHomeDir(), WORKSPACE_CATALOG_FILE);
}

function buildWorkspaceCatalogPaths(rootPath: string): WorkspaceInfo["paths"] {
  const resolvedRoot = path.resolve(rootPath);
  return {
    dbPath: path.join(resolvedRoot, "workspace.db"),
    artifactsDir: path.join(resolvedRoot, "artifacts"),
    exportsDir: path.join(resolvedRoot, "exports"),
    importsDir: path.join(resolvedRoot, "imports"),
    backupsDir: path.join(resolvedRoot, "backups"),
    configDir: path.join(resolvedRoot, "config"),
    cacheDir: path.join(resolvedRoot, "cache"),
  };
}

function isValidCatalogTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function readPersistedWorkspaceCatalog(filePath: string): PersistedWorkspaceCatalogItem[] {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<PersistedWorkspaceCatalog>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) {
      return [];
    }

    return parsed.items.flatMap((item) => {
      const rootPath = typeof item?.rootPath === "string" ? path.resolve(item.rootPath) : null;
      const workspaceName = typeof item?.workspaceName === "string" && item.workspaceName.trim()
        ? item.workspaceName.trim()
        : null;
      if (!rootPath || !workspaceName || !isValidCatalogTimestamp(item?.lastOpenedAt)) {
        return [];
      }

      return [{
        rootPath,
        workspaceName,
        lastOpenedAt: item.lastOpenedAt,
      }];
    });
  } catch {
    return [];
  }
}

function writePersistedWorkspaceCatalog(filePath: string, items: PersistedWorkspaceCatalogItem[]): void {
  const parentDir = path.dirname(filePath);
  mkdirSync(parentDir, { recursive: true });
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    writeFileSync(tempFilePath, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, "utf8");
    renameSync(tempFilePath, filePath);
  } catch (error) {
    rmSync(tempFilePath, { force: true });
    throw error;
  }
}

export class WorkspaceSessionManager {
  private currentState: WorkspaceSessionState;

  private readonly history = new Map<string, WorkspaceCatalogItem>();

  private readonly processSessionId = randomUUID();

  constructor(
    private readonly serverConfig: ServerConfig,
    initialWorkspaceRoot: string,
    private readonly authMode: "optional" | "bearer",
  ) {
    this.currentState = this.loadWorkspace(initialWorkspaceRoot, {
      workspaceName: serverConfig.workspaceName,
      requireExistingRoot: false,
    });
    this.hydrateHistory();
    this.remember(this.currentState);
  }

  getCurrent(): WorkspaceSessionState {
    return this.currentState;
  }

  listWorkspaces(): WorkspaceCatalogItem[] {
    this.pruneMissingHistory();
    const currentRoot = this.currentState.workspaceRoot;
    return [...this.history.values()]
      .map((item) => ({
        ...item,
        isCurrent: item.rootPath === currentRoot,
      }))
      .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
  }

  createWorkspace(rootPath: string, workspaceName?: string): WorkspaceCatalogItem {
    return this.swapWorkspace(rootPath, {
      workspaceName,
      requireExistingRoot: false,
    });
  }

  openWorkspace(rootPath: string): WorkspaceCatalogItem {
    return this.swapWorkspace(rootPath, {
      requireExistingRoot: true,
    });
  }

  listBackups(): WorkspaceBackupRecord[] {
    return listWorkspaceBackups(this.currentState.paths);
  }

  createBackup(label?: string): WorkspaceBackupRecord {
    return createWorkspaceBackup(this.currentState.paths, {
      workspaceName: this.currentState.workspaceInfo.workspaceName,
      appVersion: RECALLX_VERSION,
      label,
      now: new Date().toISOString(),
    });
  }

  exportWorkspace(format: "json" | "markdown"): WorkspaceExportRecord {
    const repository = this.currentState.repository;
    const payload = {
      workspace: this.currentState.workspaceInfo,
      nodes: repository.listAllNodes(),
      relations: repository.listAllRelations(),
      activities: repository.listAllActivities(),
      artifacts: repository.listAllArtifacts(),
      integrations: repository.listIntegrations(),
      settings: repository.getSettings(),
    };
    const markdown = [
      `# ${this.currentState.workspaceInfo.workspaceName}`,
      "",
      `- exportedAt: ${new Date().toISOString()}`,
      `- workspaceRoot: ${this.currentState.workspaceRoot}`,
      `- nodes: ${payload.nodes.length}`,
      `- relations: ${payload.relations.length}`,
      `- activities: ${payload.activities.length}`,
      `- artifacts: ${payload.artifacts.length}`,
      `- integrations: ${payload.integrations.length}`,
      "",
      "## Recent Nodes",
      ...payload.nodes.slice(0, 20).map((node) => `- ${node.title ?? node.id} (${node.type})`),
    ].join("\n");

    return exportWorkspaceSnapshot(this.currentState.paths, {
      workspaceName: this.currentState.workspaceInfo.workspaceName,
      appVersion: RECALLX_VERSION,
      now: new Date().toISOString(),
      format,
      payload,
      markdown,
    });
  }

  previewImportWorkspace(
    format: "recallx_json" | "markdown",
    sourcePath: string,
    label?: string,
    options?: Partial<WorkspaceImportOptions> | null
  ): WorkspaceImportPreviewRecord {
    return previewImportIntoWorkspace({
      repository: this.currentState.repository,
      format,
      sourcePath,
      label,
      options,
      now: new Date().toISOString(),
    });
  }

  importWorkspace(
    format: "recallx_json" | "markdown",
    sourcePath: string,
    label?: string,
    options?: Partial<WorkspaceImportOptions> | null
  ): WorkspaceImportRecord {
    const backup = this.createBackup(label ? `before-import ${label}` : "before-import");
    return importIntoWorkspace({
      repository: this.currentState.repository,
      paths: this.currentState.paths,
      format,
      sourcePath,
      label,
      options,
      now: new Date().toISOString(),
      backup,
    });
  }

  restoreBackup(backupId: string, targetRootPath: string, workspaceName?: string): RestoreWorkspaceResult {
    const autoBackup = this.createBackup(workspaceName ? `before-restore ${workspaceName}` : "before-restore");
    const manifest = restoreWorkspaceBackup(this.currentState.paths, {
      backupId,
      targetRootPath,
    });

    return {
      workspace: this.swapWorkspace(targetRootPath, {
        workspaceName: workspaceName?.trim() || manifest.workspaceName,
        requireExistingRoot: true,
      }),
      autoBackup,
    };
  }

  shutdown(): void {
    this.closeState(this.currentState);
  }

  private swapWorkspace(
    rootPath: string,
    options: {
      workspaceName?: string;
      requireExistingRoot: boolean;
    },
  ): WorkspaceCatalogItem {
    const nextState = this.loadWorkspace(rootPath, options);
    const previousState = this.currentState;

    try {
      this.remember(nextState, nextState.workspaceRoot);
      this.currentState = nextState;
      this.closeState(previousState);
      return this.getWorkspaceCatalogItem(nextState);
    } catch (error) {
      this.closeState(nextState);
      throw error;
    }
  }

  private loadWorkspace(
    rootPath: string,
    options: {
      workspaceName?: string;
      requireExistingRoot: boolean;
    },
  ): WorkspaceSessionState {
    const resolvedRoot = path.resolve(rootPath);
    if (options.requireExistingRoot && !existsSync(resolvedRoot)) {
      throw new AppError(404, "WORKSPACE_NOT_FOUND", `Workspace root not found: ${resolvedRoot}`);
    }

    const paths = ensureWorkspace(resolvedRoot);
    const db = openDatabase(paths);
    const repository = new RecallXRepository(db, resolvedRoot);
    const storedSettings = repository.getSettings(["workspace.name"]);
    const resolvedName =
      options.workspaceName?.trim() ||
      (typeof storedSettings["workspace.name"] === "string" && storedSettings["workspace.name"].trim()
        ? String(storedSettings["workspace.name"])
        : defaultWorkspaceName(resolvedRoot));

    repository.setSetting("workspace.name", resolvedName);
    repository.setSetting("workspace.version", RECALLX_VERSION);
    repository.setSetting("api.bind", `${this.serverConfig.bindAddress}:${this.serverConfig.port}`);
    repository.setSetting("api.auth.mode", this.authMode);
    repository.ensureBaseSettings({
      "search.semantic.enabled": false,
      "search.semantic.provider": "disabled",
      "search.semantic.model": "none",
      "search.semantic.indexBackend": "sqlite-vec",
      "search.semantic.chunk.enabled": false,
      "search.semantic.chunk.aggregation": "max",
      "search.semantic.workspaceFallback.enabled": false,
      "search.semantic.workspaceFallback.mode": "strict_zero",
      "search.semantic.augmentation.minSimilarity": 0.2,
      "search.semantic.augmentation.maxBonus": 18,
      "search.semantic.last_backfill_at": null,
      "search.semantic.autoIndex.enabled": true,
      "search.semantic.autoIndex.debounceMs": 1500,
      "search.semantic.autoIndex.batchLimit": 20,
      "search.semantic.autoIndex.lastRunAt": null,
      "search.tagIndex.version": 0,
      "search.activityFts.version": 0,
      "relations.autoRefresh.enabled": true,
      "relations.autoRefresh.debounceMs": 150,
      "relations.autoRefresh.maxStalenessMs": 2_000,
      "relations.autoRefresh.batchLimit": 24,
      "relations.autoRecompute.enabled": true,
      "relations.autoRecompute.eventThreshold": 12,
      "relations.autoRecompute.debounceMs": 30_000,
      "relations.autoRecompute.maxStalenessMs": 300_000,
      "relations.autoRecompute.batchLimit": 100,
      "relations.autoRecompute.lastRunAt": null,
      "observability.enabled": false,
      "observability.retentionDays": 14,
      "observability.slowRequestMs": 50,
      "observability.capturePayloadShape": true,
      "export.defaultFormat": "markdown",
    });
    repository.ensureSearchTagIndex();
    repository.ensureActivitySearchIndex();
    bootstrapAutomaticGovernance(repository);
    const now = new Date().toISOString();
    const safety = beginWorkspaceSession(paths, {
      sessionId: this.processSessionId,
      appVersion: RECALLX_VERSION,
      now,
    });

    return {
      db,
      repository,
      paths,
      workspaceRoot: resolvedRoot,
      workspaceInfo: workspaceInfo(
        resolvedRoot,
        {
          ...this.serverConfig,
          workspaceName: resolvedName,
        },
        this.authMode,
        {
          dbPath: paths.dbPath,
          artifactsDir: paths.artifactsDir,
          exportsDir: paths.exportsDir,
          importsDir: paths.importsDir,
          backupsDir: paths.backupsDir,
          configDir: paths.configDir,
          cacheDir: paths.cacheDir,
        },
        safety,
      ),
    };
  }

  private closeState(state: WorkspaceSessionState): void {
    endWorkspaceSession(state.paths, {
      sessionId: this.processSessionId,
      appVersion: RECALLX_VERSION,
      now: new Date().toISOString(),
    });
    state.db.close();
  }

  private remember(state: WorkspaceSessionState, currentRoot = this.currentState.workspaceRoot): void {
    const previous = this.history.get(state.workspaceRoot);
    this.history.set(state.workspaceRoot, this.getWorkspaceCatalogItem(state));

    try {
      this.persistHistory(currentRoot);
    } catch (error) {
      if (previous) {
        this.history.set(state.workspaceRoot, previous);
      } else {
        this.history.delete(state.workspaceRoot);
      }
      throw error;
    }
  }

  private hydrateHistory(): void {
    for (const item of readPersistedWorkspaceCatalog(workspaceCatalogFilePath())) {
      if (!existsSync(item.rootPath)) {
        continue;
      }

      const existing = this.history.get(item.rootPath);
      if (existing && existing.lastOpenedAt >= item.lastOpenedAt) {
        continue;
      }

      this.history.set(item.rootPath, {
        ...workspaceInfo(
          item.rootPath,
          {
            ...this.serverConfig,
            workspaceName: item.workspaceName,
          },
          this.authMode,
          buildWorkspaceCatalogPaths(item.rootPath),
        ),
        isCurrent: false,
        lastOpenedAt: item.lastOpenedAt,
      });
    }
  }

  private pruneMissingHistory(): void {
    const currentRoot = this.currentState.workspaceRoot;
    let changed = false;
    for (const rootPath of [...this.history.keys()]) {
      if (rootPath === currentRoot) {
        continue;
      }
      if (!existsSync(rootPath)) {
        this.history.delete(rootPath);
        changed = true;
      }
    }

    if (changed) {
      this.persistHistory();
    }
  }

  private persistHistory(currentRoot = this.currentState.workspaceRoot): void {
    const items = [...this.history.values()]
      .filter((item) => item.rootPath === currentRoot || existsSync(item.rootPath))
      .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
      .map((item) => ({
        rootPath: item.rootPath,
        workspaceName: item.workspaceName,
        lastOpenedAt: item.lastOpenedAt,
      }));

    writePersistedWorkspaceCatalog(workspaceCatalogFilePath(), items);
  }

  private getWorkspaceCatalogItem(state: WorkspaceSessionState): WorkspaceCatalogItem {
    return {
      ...state.workspaceInfo,
      isCurrent: state.workspaceRoot === this.currentState?.workspaceRoot,
      lastOpenedAt: state.workspaceInfo.safety?.lastOpenedAt ?? new Date().toISOString(),
    };
  }
}
