import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config.js";
import { workspaceInfo } from "./config.js";
import { openDatabase } from "./db.js";
import { AppError } from "./errors.js";
import { MemforgeRepository } from "./repositories.js";
import { defaultWorkspaceName, ensureWorkspace, type WorkspacePaths } from "./workspace.js";
import type { WorkspaceCatalogItem, WorkspaceInfo } from "../shared/types.js";

interface WorkspaceSessionState {
  db: DatabaseSync;
  repository: MemforgeRepository;
  workspaceInfo: WorkspaceInfo;
  workspaceRoot: string;
  paths: WorkspacePaths;
}

export class WorkspaceSessionManager {
  private currentState: WorkspaceSessionState;

  private readonly history = new Map<string, WorkspaceCatalogItem>();

  constructor(
    private readonly serverConfig: ServerConfig,
    initialWorkspaceRoot: string,
    private readonly authMode: "optional" | "bearer",
  ) {
    this.currentState = this.loadWorkspace(initialWorkspaceRoot, {
      workspaceName: serverConfig.workspaceName,
      requireExistingRoot: false,
    });
    this.remember(this.currentState);
  }

  getCurrent(): WorkspaceSessionState {
    return this.currentState;
  }

  listWorkspaces(): WorkspaceCatalogItem[] {
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

  private swapWorkspace(
    rootPath: string,
    options: {
      workspaceName?: string;
      requireExistingRoot: boolean;
    },
  ): WorkspaceCatalogItem {
    const nextState = this.loadWorkspace(rootPath, options);
    const previousState = this.currentState;
    this.currentState = nextState;
    this.remember(nextState);
    if (previousState.workspaceRoot !== nextState.workspaceRoot) {
      previousState.db.close();
    } else {
      previousState.db.close();
    }
    return this.getWorkspaceCatalogItem(nextState);
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
    const repository = new MemforgeRepository(db, resolvedRoot);
    const storedSettings = repository.getSettings(["workspace.name"]);
    const resolvedName =
      typeof storedSettings["workspace.name"] === "string" && storedSettings["workspace.name"].trim()
        ? String(storedSettings["workspace.name"])
        : options.workspaceName?.trim() || defaultWorkspaceName(resolvedRoot);

    repository.upsertBaseSettings({
      "workspace.name": resolvedName,
      "workspace.version": "0.1.0",
      "api.bind": `${this.serverConfig.bindAddress}:${this.serverConfig.port}`,
      "api.auth.mode": this.authMode,
      "search.semantic.enabled": false,
      "review.autoApproveLowRisk": false,
      "export.defaultFormat": "markdown",
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
      ),
    };
  }

  private remember(state: WorkspaceSessionState): void {
    this.history.set(state.workspaceRoot, this.getWorkspaceCatalogItem(state));
  }

  private getWorkspaceCatalogItem(state: WorkspaceSessionState): WorkspaceCatalogItem {
    return {
      ...state.workspaceInfo,
      isCurrent: state.workspaceRoot === this.currentState?.workspaceRoot,
      lastOpenedAt: new Date().toISOString(),
    };
  }
}
