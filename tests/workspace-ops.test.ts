import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServerConfig } from "../app/server/config.js";
import { AppError } from "../app/server/errors.js";
import { createWorkspaceBackup, exportWorkspaceSnapshot, restoreWorkspaceBackup } from "../app/server/workspace-ops.js";
import { importIntoWorkspace } from "../app/server/workspace-import.js";
import { ensureWorkspace } from "../app/server/workspace.js";
import { WorkspaceSessionManager } from "../app/server/workspace-session.js";
import { RECALLX_VERSION } from "../app/shared/version.js";

const tempRoots: string[] = [];
const sessions: WorkspaceSessionManager[] = [];

function createTempRoot(prefix: string) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createWorkspaceSessionManager(root: string) {
  const session = new WorkspaceSessionManager(
    {
      ...createServerConfig(root),
      port: 8787,
      bindAddress: "127.0.0.1",
      apiToken: null,
      workspaceName: "RecallX Test"
    },
    root,
    "optional"
  );
  sessions.push(session);
  return session;
}

afterEach(() => {
  while (sessions.length) {
    const session = sessions.pop();
    session?.shutdown();
  }

  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("workspace artifact reliability", () => {
  it("allocates distinct backup ids for same-second backups with the same label", () => {
    const root = createTempRoot("recallx-workspace-ops-");
    const paths = ensureWorkspace(root);
    writeFileSync(paths.dbPath, "workspace-db");
    const now = "2026-04-04T12:34:56.000Z";

    const first = createWorkspaceBackup(paths, {
      workspaceName: "RecallX Test",
      appVersion: RECALLX_VERSION,
      label: "Before import",
      now
    });
    const second = createWorkspaceBackup(paths, {
      workspaceName: "RecallX Test",
      appVersion: RECALLX_VERSION,
      label: "Before import",
      now
    });

    expect(first.id).toBe("20260404123456-before-import");
    expect(second.id).toBe("20260404123456-before-import-2");
    expect(first.backupPath).not.toBe(second.backupPath);
    expect(existsSync(path.join(first.backupPath, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(second.backupPath, "manifest.json"))).toBe(true);
  });

  it("allocates distinct export ids for same-second exports", () => {
    const root = createTempRoot("recallx-workspace-ops-");
    const paths = ensureWorkspace(root);
    const now = "2026-04-04T12:34:56.000Z";

    const first = exportWorkspaceSnapshot(paths, {
      workspaceName: "RecallX Test",
      appVersion: RECALLX_VERSION,
      now,
      format: "json",
      payload: { export: 1 },
      markdown: "# ignored"
    });
    const second = exportWorkspaceSnapshot(paths, {
      workspaceName: "RecallX Test",
      appVersion: RECALLX_VERSION,
      now,
      format: "json",
      payload: { export: 2 },
      markdown: "# ignored"
    });

    expect(first.id).toBe("20260404123456-workspace-export");
    expect(second.id).toBe("20260404123456-workspace-export-2");
    expect(first.exportPath).not.toBe(second.exportPath);
    expect(JSON.parse(readFileSync(first.exportPath, "utf8"))).toEqual({ export: 1 });
    expect(JSON.parse(readFileSync(second.exportPath, "utf8"))).toEqual({ export: 2 });
    expect(existsSync(path.join(paths.exportsDir, `${first.id}.manifest.json`))).toBe(true);
    expect(existsSync(path.join(paths.exportsDir, `${second.id}.manifest.json`))).toBe(true);
  });

  it("allocates distinct staged import paths for same-second imports with the same label", () => {
    const workspaceRoot = createTempRoot("recallx-workspace-import-");
    const markdownRoot = createTempRoot("recallx-markdown-import-");
    writeFileSync(path.join(markdownRoot, "overview.md"), "# Architecture Overview\n\nLocal-first memory notes.");

    const session = createWorkspaceSessionManager(workspaceRoot);
    const state = session.getCurrent();
    const now = "2026-04-04T12:34:56.000Z";
    const baseBackup = {
      label: "Before import",
      createdAt: now,
      workspaceRoot: state.paths.root,
      workspaceName: state.workspaceInfo.workspaceName
    };

    const first = importIntoWorkspace({
      repository: state.repository,
      paths: state.paths,
      format: "markdown",
      sourcePath: markdownRoot,
      label: "Imported notes",
      now,
      backup: {
        ...baseBackup,
        id: "backup-1",
        backupPath: path.join(state.paths.backupsDir, "backup-1")
      },
      options: {
        duplicateMode: "skip_exact"
      }
    });
    const second = importIntoWorkspace({
      repository: state.repository,
      paths: state.paths,
      format: "markdown",
      sourcePath: markdownRoot,
      label: "Imported notes",
      now,
      backup: {
        ...baseBackup,
        id: "backup-2",
        backupPath: path.join(state.paths.backupsDir, "backup-2")
      },
      options: {
        duplicateMode: "skip_exact"
      }
    });

    expect(first.importedPath).toBe(path.join(state.paths.importsDir, "20260404123456-imported-notes"));
    expect(second.importedPath).toBe(path.join(state.paths.importsDir, "20260404123456-imported-notes-2"));
    expect(existsSync(first.importedPath)).toBe(true);
    expect(existsSync(second.importedPath)).toBe(true);
    expect(second.nodesCreated).toBe(0);
    expect(second.skippedNodes).toBe(1);
    expect(second.warnings.some((warning) => warning.includes("Skipped 1 exact duplicate node"))).toBe(true);
  });

  it("rejects incomplete backups before restore and leaves the target untouched", () => {
    const root = createTempRoot("recallx-workspace-ops-");
    const targetParent = createTempRoot("recallx-restore-target-");
    const paths = ensureWorkspace(root);
    writeFileSync(paths.dbPath, "workspace-db");
    const backup = createWorkspaceBackup(paths, {
      workspaceName: "RecallX Test",
      appVersion: RECALLX_VERSION,
      label: "Before restore",
      now: "2026-04-04T12:34:56.000Z"
    });
    const targetRoot = path.join(targetParent, "restored-workspace");

    unlinkSync(path.join(backup.backupPath, "workspace.db"));

    let thrown: unknown;
    try {
      restoreWorkspaceBackup(paths, {
        backupId: backup.id,
        targetRootPath: targetRoot
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(409);
    expect((thrown as AppError).code).toBe("INVALID_BACKUP");
    expect(existsSync(targetRoot)).toBe(false);
    expect(readdirSync(targetParent)).toEqual([]);
  });
});
