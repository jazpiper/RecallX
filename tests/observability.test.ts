import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createObservabilityWriter } from "../app/server/observability.js";

const tempRoots: string[] = [];

async function waitFor<T>(check: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 2_000) {
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

function createWriter() {
  const root = mkdtempSync(path.join(tmpdir(), "memforge-observability-"));
  mkdirSync(path.join(root, "logs"), { recursive: true });
  tempRoots.push(root);
  return {
    root,
    writer: createObservabilityWriter({
      getState: () => ({
        enabled: true,
        workspaceRoot: root,
        workspaceName: "Observability Test",
        retentionDays: 14,
        slowRequestMs: 250,
        capturePayloadShape: true
      })
    })
  };
}

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("observability writer", () => {
  it("redacts sensitive detail keys before writing telemetry logs", async () => {
    const { root, writer } = createWriter();

    await writer.recordEvent({
      surface: "api",
      operation: "nodes.search",
      details: {
        body: "secret body",
        summary: "secret summary",
        metadata: { secret: true },
        authorizationToken: "secret-token",
        argCount: 2,
        flags: {
          semanticUsed: true,
          contentHash: "skip-me"
        }
      }
    });
    await writer.flush();

    const logFile = path.join(root, "logs", `telemetry-${new Date().toISOString().slice(0, 10)}.ndjson`);
    const content = readFileSync(logFile, "utf8");

    expect(content).toContain("\"argCount\":2");
    expect(content).not.toContain("secret body");
    expect(content).not.toContain("secret summary");
    expect(content).not.toContain("secret-token");
    expect(content).not.toContain("skip-me");
  });

  it("summarizes telemetry and lists recent errors", async () => {
    const { writer } = createWriter();

    await writer.recordEvent({
      surface: "api",
      operation: "nodes.search",
      durationMs: 12,
      details: {
        ftsFallback: true
      }
    });
    await writer.recordEvent({
      surface: "api",
      operation: "context.bundle",
      durationMs: 20,
      details: {
        semanticUsed: true
      }
    });
    await writer.recordError({
      surface: "mcp",
      operation: "memforge_search_nodes",
      durationMs: 8,
      errorCode: "NETWORK_ERROR",
      errorKind: "network_error"
    });
    await writer.flush();

    const summary = await writer.summarize({
      since: "24h",
      surface: "all"
    });
    const errors = await writer.listErrors({
      since: "24h",
      surface: "all",
      limit: 10
    });

    expect(summary.totalEvents).toBe(3);
    expect(summary.operationSummaries.some((item) => item.operation === "nodes.search")).toBe(true);
    expect(summary.mcpToolFailures).toEqual([{ operation: "memforge_search_nodes", count: 1 }]);
    expect(summary.ftsFallbackRate.fallbackCount).toBe(1);
    expect(summary.semanticAugmentationRate.usedCount).toBe(1);
    expect(errors.items).toHaveLength(1);
    expect(errors.items[0]?.operation).toBe("memforge_search_nodes");
  });

  it("prunes telemetry files outside retention window", async () => {
    const { root, writer } = createWriter();
    const oldFile = path.join(root, "logs", "telemetry-2000-01-01.ndjson");
    writeFileSync(oldFile, "{\"ts\":\"2000-01-01T00:00:00.000Z\"}\n");

    await writer.summarize({
      since: "24h",
      surface: "all"
    });

    await waitFor(() => !existsSync(oldFile));
    expect(existsSync(oldFile)).toBe(false);
  });
});
