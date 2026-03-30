import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkspaceBackupRecord, WorkspaceExportRecord, WorkspaceSafetyStatus, WorkspaceSafetyWarning } from "../shared/types.js";
import { AppError } from "./errors.js";
import type { WorkspacePaths } from "./workspace.js";

type WorkspaceSessionMetadata = {
  machineId: string;
  sessionId: string;
  appVersion: string;
  lastOpenedAt: string;
  lastCleanCloseAt: string | null;
};

type WorkspaceLockMetadata = {
  machineId: string;
  sessionId: string;
  appVersion: string;
  lockUpdatedAt: string;
};

type BackupManifest = WorkspaceBackupRecord & {
  appVersion: string;
};

type ExportManifest = WorkspaceExportRecord & {
  appVersion: string;
};

const BACKUP_MANIFEST_FILE = "manifest.json";
const SESSION_METADATA_FILE = "workspace-session.json";
const LOCK_METADATA_FILE = "workspace.lock.json";
const WORKSPACE_ACTIVITY_THRESHOLD_MS = 10 * 60 * 1000;

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/\s+/g, " ").trim() || fallback;
}

function sessionMetadataPath(paths: WorkspacePaths): string {
  return path.join(paths.configDir, SESSION_METADATA_FILE);
}

function lockMetadataPath(paths: WorkspacePaths): string {
  return path.join(paths.configDir, LOCK_METADATA_FILE);
}

function readSessionMetadata(paths: WorkspacePaths): WorkspaceSessionMetadata | null {
  return readJsonFile<WorkspaceSessionMetadata>(sessionMetadataPath(paths));
}

function readLockMetadata(paths: WorkspacePaths): WorkspaceLockMetadata | null {
  return readJsonFile<WorkspaceLockMetadata>(lockMetadataPath(paths));
}

function buildSafetyWarnings(
  previous: WorkspaceSessionMetadata | null,
  lock: WorkspaceLockMetadata | null,
  machineId: string,
  sessionId: string,
): WorkspaceSafetyWarning[] {
  const warnings: WorkspaceSafetyWarning[] = [];
  const isSameActiveSession =
    previous?.sessionId === sessionId &&
    previous.machineId === machineId &&
    lock?.sessionId === sessionId &&
    lock.machineId === machineId;

  if (lock && !isSameActiveSession) {
    warnings.push({
      code: "active_lock",
      message: `Workspace lock marker is still present from ${lock.machineId}. Another session may still be active.`
    });
  }

  if (
    previous &&
    !isSameActiveSession &&
    (!previous.lastCleanCloseAt || previous.lastCleanCloseAt < previous.lastOpenedAt)
  ) {
    warnings.push({
      code: "unclean_shutdown",
      message: "The previous session does not appear to have closed cleanly. Create a backup before heavy edits."
    });
  }

  if (
    previous &&
    previous.machineId !== machineId &&
    Date.now() - Date.parse(previous.lastOpenedAt) <= WORKSPACE_ACTIVITY_THRESHOLD_MS
  ) {
    warnings.push({
      code: "recent_other_machine",
      message: `This workspace was opened recently on ${previous.machineId}. Treat multi-device access as single-writer only.`
    });
  }

  return warnings;
}

export function beginWorkspaceSession(paths: WorkspacePaths, params: {
  sessionId: string;
  appVersion: string;
  now: string;
}): WorkspaceSafetyStatus {
  const machineId = os.hostname() || "unknown-machine";
  const previous = readSessionMetadata(paths);
  const lock = readLockMetadata(paths);
  const warnings = buildSafetyWarnings(previous, lock, machineId, params.sessionId);
  const nextSession: WorkspaceSessionMetadata = {
    machineId,
    sessionId: params.sessionId,
    appVersion: params.appVersion,
    lastOpenedAt: params.now,
    lastCleanCloseAt: previous?.lastCleanCloseAt ?? null
  };
  const nextLock: WorkspaceLockMetadata = {
    machineId,
    sessionId: params.sessionId,
    appVersion: params.appVersion,
    lockUpdatedAt: params.now
  };

  writeJsonFile(sessionMetadataPath(paths), nextSession);
  writeJsonFile(lockMetadataPath(paths), nextLock);

  return {
    machineId,
    sessionId: params.sessionId,
    lastOpenedAt: params.now,
    lastCleanCloseAt: nextSession.lastCleanCloseAt,
    lockPresent: true,
    lockUpdatedAt: params.now,
    activeSessionMachineId: machineId,
    warnings
  };
}

export function endWorkspaceSession(paths: WorkspacePaths, params: {
  sessionId: string;
  appVersion: string;
  now: string;
}): void {
  const machineId = os.hostname() || "unknown-machine";
  const previous = readSessionMetadata(paths);
  const nextSession: WorkspaceSessionMetadata = {
    machineId,
    sessionId: params.sessionId,
    appVersion: params.appVersion,
    lastOpenedAt: previous?.lastOpenedAt ?? params.now,
    lastCleanCloseAt: params.now
  };
  writeJsonFile(sessionMetadataPath(paths), nextSession);

  const lock = readLockMetadata(paths);
  if (lock?.sessionId === params.sessionId && existsSync(lockMetadataPath(paths))) {
    unlinkSync(lockMetadataPath(paths));
  }
}

function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function copyWorkspaceSnapshot(sourcePaths: WorkspacePaths, backupDir: string): void {
  mkdirSync(backupDir, { recursive: true });
  if (existsSync(sourcePaths.dbPath)) {
    copyFileSync(sourcePaths.dbPath, path.join(backupDir, "workspace.db"));
  }
  for (const [from, name] of [
    [sourcePaths.artifactsDir, "artifacts"],
    [sourcePaths.exportsDir, "exports"],
  ] as const) {
    if (existsSync(from)) {
      cpSync(from, path.join(backupDir, name), { recursive: true });
    }
  }

  if (existsSync(sourcePaths.configDir)) {
    const targetConfigDir = path.join(backupDir, "config");
    mkdirSync(targetConfigDir, { recursive: true });
    for (const entry of readdirSync(sourcePaths.configDir, { withFileTypes: true })) {
      if (entry.name === SESSION_METADATA_FILE || entry.name === LOCK_METADATA_FILE) {
        continue;
      }
      const sourcePath = path.join(sourcePaths.configDir, entry.name);
      const destinationPath = path.join(targetConfigDir, entry.name);
      if (entry.isDirectory()) {
        cpSync(sourcePath, destinationPath, { recursive: true });
      } else {
        copyFileSync(sourcePath, destinationPath);
      }
    }
  }
}

export function createWorkspaceBackup(paths: WorkspacePaths, params: {
  workspaceName: string;
  appVersion: string;
  label?: string;
  now: string;
}): WorkspaceBackupRecord {
  const id = `${params.now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${sanitizeLabel(params.label, "snapshot").replace(/\s+/g, "-").toLowerCase()}`;
  const backupDir = path.join(paths.backupsDir, id);
  if (existsSync(backupDir)) {
    throw new AppError(409, "BACKUP_EXISTS", `Backup already exists: ${id}`);
  }

  copyWorkspaceSnapshot(paths, backupDir);
  const manifest: BackupManifest = {
    id,
    label: sanitizeLabel(params.label, "Manual snapshot"),
    createdAt: params.now,
    backupPath: backupDir,
    workspaceRoot: paths.root,
    workspaceName: params.workspaceName,
    appVersion: params.appVersion
  };
  writeJsonFile(path.join(backupDir, BACKUP_MANIFEST_FILE), manifest);
  return manifest;
}

export function listWorkspaceBackups(paths: WorkspacePaths): WorkspaceBackupRecord[] {
  if (!existsSync(paths.backupsDir)) {
    return [];
  }

  return readdirSync(paths.backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJsonFile<BackupManifest>(path.join(paths.backupsDir, entry.name, BACKUP_MANIFEST_FILE)))
    .filter((entry): entry is BackupManifest => Boolean(entry))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function restoreWorkspaceBackup(paths: WorkspacePaths, params: {
  backupId: string;
  targetRootPath: string;
}): WorkspaceBackupRecord {
  const manifest = listWorkspaceBackups(paths).find((item) => item.id === params.backupId);
  if (!manifest) {
    throw new AppError(404, "BACKUP_NOT_FOUND", `Backup ${params.backupId} not found.`);
  }

  const targetRoot = path.resolve(params.targetRootPath);
  if (targetRoot === path.resolve(paths.root)) {
    throw new AppError(400, "INVALID_INPUT", "Restore target must be a different workspace root.");
  }

  if (existsSync(targetRoot)) {
    const existingEntries = readdirSync(targetRoot);
    if (existingEntries.length > 0) {
      throw new AppError(409, "RESTORE_TARGET_NOT_EMPTY", "Restore target root must be empty or not exist.");
    }
  } else {
    mkdirSync(targetRoot, { recursive: true });
  }

  for (const entry of ["workspace.db", "artifacts", "exports", "config"] as const) {
    const sourcePath = path.join(manifest.backupPath, entry);
    const destinationPath = path.join(targetRoot, entry);
    if (!existsSync(sourcePath)) {
      continue;
    }
    if (entry === "workspace.db") {
      copyFileSync(sourcePath, destinationPath);
    } else {
      cpSync(sourcePath, destinationPath, { recursive: true });
    }
  }

  return manifest;
}

export function exportWorkspaceSnapshot(paths: WorkspacePaths, params: {
  workspaceName: string;
  appVersion: string;
  now: string;
  format: "json" | "markdown";
  payload: unknown;
  markdown: string;
}): WorkspaceExportRecord {
  const id = `${params.now.replace(/[-:.TZ]/g, "").slice(0, 14)}-workspace-export`;
  const extension = params.format === "json" ? "json" : "md";
  const exportPath = path.join(paths.exportsDir, `${id}.${extension}`);
  const body = params.format === "json" ? `${JSON.stringify(params.payload, null, 2)}\n` : `${params.markdown}\n`;
  writeFileSync(exportPath, body, "utf8");
  const manifest: ExportManifest = {
    id,
    format: params.format,
    createdAt: params.now,
    exportPath,
    workspaceRoot: paths.root,
    workspaceName: params.workspaceName,
    appVersion: params.appVersion
  };
  writeJsonFile(path.join(paths.exportsDir, `${id}.manifest.json`), manifest);
  return manifest;
}

export function summarizeBackupRecord(record: WorkspaceBackupRecord): string {
  const stats = existsSync(record.backupPath) ? statSync(record.backupPath) : null;
  const sizeLabel = stats ? formatArtifactSize(stats.size) : "unknown";
  return `${record.label} (${record.id}) at ${record.createdAt} -> ${record.backupPath} [${sizeLabel}]`;
}

export function removeWorkspaceDirectory(rootPath: string): void {
  if (existsSync(rootPath)) {
    rmSync(rootPath, { recursive: true, force: true });
  }
}
