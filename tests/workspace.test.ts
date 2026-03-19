import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memforgeHomeDir, resolveWorkspaceRoot } from "../app/server/workspace.js";

const tempRoots: string[] = [];
const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalWorkspaceRoot = process.env.MEMFORGE_WORKSPACE_ROOT;
const originalWorkspaceName = process.env.MEMFORGE_WORKSPACE_NAME;

function createTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "memforge-workspace-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalWorkspaceRoot === undefined) {
    delete process.env.MEMFORGE_WORKSPACE_ROOT;
  } else {
    process.env.MEMFORGE_WORKSPACE_ROOT = originalWorkspaceRoot;
  }
  if (originalWorkspaceName === undefined) {
    delete process.env.MEMFORGE_WORKSPACE_NAME;
  } else {
    process.env.MEMFORGE_WORKSPACE_NAME = originalWorkspaceName;
  }

  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("resolveWorkspaceRoot", () => {
  it("defaults to ~/.memforge/{workspaceName}", () => {
    const homeRoot = createTempRoot();
    const projectRoot = createTempRoot();
    process.env.HOME = homeRoot;
    delete process.env.MEMFORGE_WORKSPACE_ROOT;
    process.env.MEMFORGE_WORKSPACE_NAME = "Sample Workspace";
    process.chdir(projectRoot);

    const root = resolveWorkspaceRoot();

    expect(root).toBe(path.join(homeRoot, ".memforge", "Sample Workspace"));
  });

  it("migrates a legacy repo-local .memforge-workspace to the user root when needed", () => {
    const homeRoot = createTempRoot();
    const projectRoot = createTempRoot();
    const legacyRoot = path.join(projectRoot, ".memforge-workspace");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(path.join(legacyRoot, "workspace.db"), "legacy");
    process.env.HOME = homeRoot;
    delete process.env.MEMFORGE_WORKSPACE_ROOT;
    process.env.MEMFORGE_WORKSPACE_NAME = "Migrated Workspace";
    process.chdir(projectRoot);

    const root = resolveWorkspaceRoot();

    expect(root).toBe(path.join(homeRoot, ".memforge", "Migrated Workspace"));
    expect(existsSync(path.join(root, "workspace.db"))).toBe(true);
  });

  it("can ignore the legacy repo-local root for desktop-style launches", () => {
    const homeRoot = createTempRoot();
    const projectRoot = createTempRoot();
    const legacyRoot = path.join(projectRoot, ".memforge-workspace");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(path.join(legacyRoot, "workspace.db"), "legacy");
    process.env.HOME = homeRoot;
    delete process.env.MEMFORGE_WORKSPACE_ROOT;
    process.env.MEMFORGE_WORKSPACE_NAME = "Desktop Workspace";
    process.chdir(projectRoot);

    const root = resolveWorkspaceRoot({
      allowLegacyProjectRoot: false
    });

    expect(root).toBe(path.join(memforgeHomeDir(), "Desktop Workspace"));
    expect(existsSync(path.join(root, "workspace.db"))).toBe(false);
  });
});
