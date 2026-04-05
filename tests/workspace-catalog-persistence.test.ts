import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecallXApp } from "../app/server/app.js";
import { createServerConfig } from "../app/server/config.js";
import { recallxHomeDir } from "../app/server/workspace.js";
import { WorkspaceSessionManager } from "../app/server/workspace-session.js";

const tempRoots: string[] = [];
const sessions: WorkspaceSessionManager[] = [];
const servers: Server[] = [];
const originalHome = process.env.HOME;

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createWorkspaceSessionManager(root: string, workspaceName = "RecallX Test"): WorkspaceSessionManager {
  const session = new WorkspaceSessionManager(
    {
      ...createServerConfig(root),
      port: 8787,
      bindAddress: "127.0.0.1",
      apiToken: null,
      workspaceName,
    },
    root,
    "optional",
  );
  sessions.push(session);
  return session;
}

async function closeServer(server: Server): Promise<void> {
  const index = servers.indexOf(server);
  if (index >= 0) {
    servers.splice(index, 1);
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function shutdownSession(session: WorkspaceSessionManager): void {
  const index = sessions.indexOf(session);
  if (index >= 0) {
    sessions.splice(index, 1);
  }
  session.shutdown();
}

async function openServerForWorkspace(root: string, workspaceName: string) {
  const workspaceSessionManager = createWorkspaceSessionManager(root, workspaceName);
  const app = createRecallXApp({
    workspaceSessionManager,
    apiToken: null,
  });
  const server = createServer(app);
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    workspaceSessionManager,
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
  };
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  while (sessions.length) {
    const session = sessions.pop();
    session?.shutdown();
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("workspace catalog persistence", () => {
  it("rehydrates known workspaces after a process restart", () => {
    const homeRoot = createTempRoot("recallx-home-");
    process.env.HOME = homeRoot;
    const rootA = createTempRoot("recallx-workspace-a-");
    const rootB = createTempRoot("recallx-workspace-b-");

    const firstSession = createWorkspaceSessionManager(rootA, "Workspace A");
    firstSession.createWorkspace(rootB, "Workspace B");
    shutdownSession(firstSession);

    const secondSession = createWorkspaceSessionManager(rootB, "Workspace B");
    const items = secondSession.listWorkspaces();

    expect(existsSync(path.join(recallxHomeDir(), "workspace-catalog.json"))).toBe(true);
    expect(items.map((item) => item.rootPath)).toEqual(expect.arrayContaining([rootA, rootB]));
    expect(items.find((item) => item.rootPath === rootB)?.isCurrent).toBe(true);
    expect(items.find((item) => item.rootPath === rootA)?.isCurrent).toBe(false);
  });

  it("ignores malformed persisted catalog files and keeps the current workspace available", () => {
    const homeRoot = createTempRoot("recallx-home-");
    process.env.HOME = homeRoot;
    const root = createTempRoot("recallx-workspace-");
    const catalogPath = path.join(recallxHomeDir(), "workspace-catalog.json");
    mkdirSync(path.dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, "{ not-valid-json", "utf8");

    const session = createWorkspaceSessionManager(root, "Workspace A");
    const items = session.listWorkspaces();

    expect(items).toHaveLength(1);
    expect(items[0]?.rootPath).toBe(root);
    expect(JSON.parse(readFileSync(catalogPath, "utf8"))).toEqual({
      version: 1,
      items: [
        {
          rootPath: root,
          workspaceName: "Workspace A",
          lastOpenedAt: items[0]?.lastOpenedAt,
        },
      ],
    });
  });

  it("returns the persisted workspace catalog through the HTTP API after restart", async () => {
    const homeRoot = createTempRoot("recallx-home-");
    process.env.HOME = homeRoot;
    const rootA = createTempRoot("recallx-http-workspace-a-");
    const rootB = createTempRoot("recallx-http-workspace-b-");

    const firstRuntime = await openServerForWorkspace(rootA, "Workspace A");
    const createResponse = await fetch(`${firstRuntime.baseUrl}/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rootPath: rootB,
        workspaceName: "Workspace B",
      }),
    });

    expect(createResponse.status).toBe(201);

    await closeServer(firstRuntime.server);
    shutdownSession(firstRuntime.workspaceSessionManager);

    const secondRuntime = await openServerForWorkspace(rootB, "Workspace B");
    const listResponse = await fetch(`${secondRuntime.baseUrl}/workspaces`);
    const listBody = await listResponse.json();

    expect(listResponse.status).toBe(200);
    expect(listBody.data.current.rootPath).toBe(rootB);
    expect(listBody.data.items.map((item: { rootPath: string }) => item.rootPath)).toEqual(expect.arrayContaining([rootA, rootB]));
    expect(listBody.data.items.find((item: { rootPath: string }) => item.rootPath === rootB)?.isCurrent).toBe(true);
  });

  it("does not switch the current workspace when catalog persistence fails", () => {
    const homeRoot = createTempRoot("recallx-home-");
    process.env.HOME = homeRoot;
    const rootA = createTempRoot("recallx-workspace-a-");
    const rootB = createTempRoot("recallx-workspace-b-");
    const session = createWorkspaceSessionManager(rootA, "Workspace A");
    const initialCurrentRoot = session.getCurrent().workspaceRoot;
    const invalidHomePath = path.join(homeRoot, "not-a-home-directory");
    writeFileSync(invalidHomePath, "broken-home", "utf8");
    process.env.HOME = invalidHomePath;

    expect(() => session.createWorkspace(rootB, "Workspace B")).toThrow();

    expect(session.getCurrent().workspaceRoot).toBe(initialCurrentRoot);
    expect(session.listWorkspaces().map((item) => item.rootPath)).toEqual([rootA]);
  });
});
