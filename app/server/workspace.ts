import { cpSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WorkspacePaths {
  root: string;
  dbPath: string;
  artifactsDir: string;
  exportsDir: string;
  importsDir: string;
  backupsDir: string;
  logsDir: string;
  configDir: string;
  cacheDir: string;
  embeddingsDir: string;
  searchCacheDir: string;
}

type ResolveWorkspaceRootOptions = {
  allowLegacyProjectRoot?: boolean;
  legacyProjectRoot?: string;
};

export function memforgeHomeDir(): string {
  return path.join(os.homedir(), ".memforge");
}

function sanitizeWorkspaceName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/\s+/g, " ").trim() || "Memforge";
}

function preferredWorkspaceName(): string {
  const configured = process.env.MEMFORGE_WORKSPACE_NAME;
  if (typeof configured === "string" && configured.trim()) {
    return sanitizeWorkspaceName(configured);
  }

  return sanitizeWorkspaceName(path.basename(process.cwd()) || "Memforge");
}

export function resolveWorkspaceRoot(options?: ResolveWorkspaceRootOptions): string {
  const configured = process.env.MEMFORGE_WORKSPACE_ROOT;
  if (configured) {
    return path.resolve(configured);
  }

  const preferredRoot = path.join(memforgeHomeDir(), preferredWorkspaceName());
  const allowLegacyProjectRoot = options?.allowLegacyProjectRoot ?? true;
  const legacyRoot = path.resolve(options?.legacyProjectRoot ?? process.cwd(), ".memforge-workspace");

  if (existsSync(preferredRoot)) {
    return preferredRoot;
  }

  if (allowLegacyProjectRoot && existsSync(legacyRoot)) {
    try {
      mkdirSync(path.dirname(preferredRoot), { recursive: true });
      cpSync(legacyRoot, preferredRoot, { recursive: true, errorOnExist: false, force: false });
      return preferredRoot;
    } catch {
      return legacyRoot;
    }
  }

  return preferredRoot;
}

export function ensureWorkspace(root: string): WorkspacePaths {
  const paths: WorkspacePaths = {
    root,
    dbPath: path.join(root, "workspace.db"),
    artifactsDir: path.join(root, "artifacts"),
    exportsDir: path.join(root, "exports"),
    importsDir: path.join(root, "imports"),
    backupsDir: path.join(root, "backups"),
    logsDir: path.join(root, "logs"),
    configDir: path.join(root, "config"),
    cacheDir: path.join(root, "cache"),
    embeddingsDir: path.join(root, "cache", "embeddings"),
    searchCacheDir: path.join(root, "cache", "search")
  };

  for (const directory of [
    paths.root,
    paths.artifactsDir,
    paths.exportsDir,
    paths.importsDir,
    paths.backupsDir,
    paths.logsDir,
    paths.configDir,
    paths.cacheDir,
    paths.embeddingsDir,
    paths.searchCacheDir
  ]) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
  }

  return paths;
}

export function defaultWorkspaceName(root: string): string {
  const resolved = path.resolve(root);
  const base = path.basename(resolved);
  if (base.startsWith(".")) {
    return path.basename(path.dirname(resolved)) || "Memforge";
  }

  return base.replace(/^\.*/, "") || "Memforge";
}
