import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemforgeApp } from "../app/server/app.js";
import { createServerConfig } from "../app/server/config.js";
import { WorkspaceSessionManager } from "../app/server/workspace-session.js";

const tempRoots: string[] = [];

function createWorkspaceSessionManager(root: string) {
  return new WorkspaceSessionManager(
    {
      ...createServerConfig(root),
      port: 8787,
      bindAddress: "127.0.0.1",
      apiToken: null,
      workspaceName: "Observability API Test"
    },
    root,
    "optional"
  );
}

async function createTestServer(root: string) {
  const workspaceSessionManager = createWorkspaceSessionManager(root);
  const repository = workspaceSessionManager.getCurrent().repository;
  repository.setSetting("observability.enabled", true);
  repository.setSetting("observability.retentionDays", 14);
  repository.setSetting("observability.slowRequestMs", 1);
  repository.setSetting("observability.capturePayloadShape", true);

  const app = createMemforgeApp({
    workspaceSessionManager,
    apiToken: null
  });
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`
  };
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for condition");
}

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("observability API", () => {
  it("returns summary and recent error views from telemetry logs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-observability-api-"));
    tempRoots.push(root);
    const { server, baseUrl } = await createTestServer(root);

    try {
      const okResponse = await fetch(`${baseUrl}/nodes/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-memforge-trace-id": "trace_test_summary",
          "x-memforge-mcp-tool": "memforge_search_nodes"
        },
        body: JSON.stringify({
          query: "nothing yet",
          limit: 5
        })
      });
      expect(okResponse.status).toBe(200);

      const badResponse = await fetch(`${baseUrl}/nodes/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: "bad",
          limit: "oops"
        })
      });
      expect(badResponse.status).toBe(400);

      const summary = await waitFor(async () => {
        const response = await fetch(`${baseUrl}/observability/summary?since=24h`);
        const payload = (await response.json()) as { data?: Record<string, any> };
        return payload.data?.totalEvents && payload.data.totalEvents >= 2 ? payload : null;
      });
      const errorsPayload = await waitFor(async () => {
        const errorsResponse = await fetch(`${baseUrl}/observability/errors?since=24h&surface=api&limit=10`);
        const payload = (await errorsResponse.json()) as { data?: { items?: Array<{ operation: string; errorKind: string }> } };
        return payload.data?.items?.some((item) => item.errorKind === "validation_error") ? payload : null;
      });

      expect(summary.data?.operationSummaries.some((item: { operation: string }) => item.operation === "nodes.search")).toBe(true);
      expect(summary.data?.mcpToolFailures).toEqual([]);
      expect(errorsPayload.data?.items?.some((item) => item.errorKind === "validation_error")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 10_000);
});
