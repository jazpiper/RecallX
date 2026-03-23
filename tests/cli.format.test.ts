import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderRelated, renderTelemetrySummary } from "../app/cli/src/format.js";
import { runCli } from "../app/cli/src/cli.js";
import { getAuthToken } from "../app/cli/src/http.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderRelated", () => {
  it("renders nested related node payloads from the live API", () => {
    const output = renderRelated({
      items: [
        {
          relation: { relationType: "supports" },
          node: { id: "node_123", title: "Retrieval rule" }
        }
      ]
    });

    expect(output).toContain("1. Retrieval rule (supports)");
  });
});

describe("renderTelemetrySummary", () => {
  it("renders fallback mode breakdowns once in the telemetry summary", () => {
    const output = renderTelemetrySummary({
      since: "24h",
      logsPath: "/tmp/telemetry",
      totalEvents: 3,
      slowOperations: [],
      mcpToolFailures: [],
      ftsFallbackRate: { fallbackCount: 0, sampleCount: 0, ratio: null },
      searchHitRate: { hitCount: 1, missCount: 0, sampleCount: 1, ratio: 1, operations: [] },
      searchLexicalQualityRate: { strongCount: 1, weakCount: 0, noneCount: 0, sampleCount: 1, operations: [] },
      workspaceResultCompositionRate: {
        emptyCount: 0,
        nodeOnlyCount: 0,
        activityOnlyCount: 0,
        mixedCount: 0,
        semanticNodeOnlyCount: 1,
        semanticMixedCount: 0,
        sampleCount: 1
      },
      searchFeedbackRate: {
        usefulCount: 1,
        notUsefulCount: 0,
        uncertainCount: 0,
        sampleCount: 1,
        usefulRatio: 1,
        top1UsefulCount: 1,
        top1SampleCount: 1,
        top1UsefulRatio: 1,
        top3UsefulCount: 1,
        top3SampleCount: 1,
        top3UsefulRatio: 1,
        semanticUsefulCount: 1,
        semanticNotUsefulCount: 0,
        semanticSampleCount: 1,
        semanticUsefulRatio: 1,
        semanticFalsePositiveRatio: 0,
        semanticLiftUsefulCount: 1,
        semanticLiftSampleCount: 1,
        semanticLiftUsefulRatio: 1,
        byLexicalQuality: [],
        byFallbackMode: [
          {
            fallbackMode: "no_strong_node_hit",
            usefulCount: 1,
            notUsefulCount: 0,
            uncertainCount: 0,
            sampleCount: 1,
            usefulRatio: 1
          }
        ]
      },
      semanticAugmentationRate: { usedCount: 1, sampleCount: 1, ratio: 1 },
      semanticFallbackRate: {
        eligibleCount: 1,
        attemptedCount: 1,
        hitCount: 1,
        attemptRatio: 1,
        hitRatio: 1,
        modes: [
          {
            fallbackMode: "no_strong_node_hit",
            eligibleCount: 1,
            attemptedCount: 1,
            hitCount: 1,
            sampleCount: 1,
            attemptRatio: 1,
            hitRatio: 1
          }
        ]
      },
      operationSummaries: [],
      autoJobStats: []
    });

    expect(output.match(/feedback mode \[no_strong_node_hit\]/g)).toHaveLength(1);
    expect(output.match(/fallback mode \[no_strong_node_hit\]/g)).toHaveLength(1);
    expect(output).toContain("semantic fallback: eligible=1, attempted=1, hit=1, hit_ratio=1");
  });
});

describe("runCli health", () => {
  it("renders the health payload without double-wrapping the envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              status: "ok",
              workspaceLoaded: true
            },
            meta: {
              requestId: "req_test",
              apiVersion: "v1"
            }
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        )
      )
    );
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runCli(["node", "recallx", "health"]);

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("status: ok");
    expect(output).toContain("workspaceLoaded: true");
    expect(output).not.toContain("ok: true");
    expect(output).not.toContain("data:");
  });
});

describe("runCli mcp", () => {
  it("installs a stable launcher script for MCP clients", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "recallx-cli-test-"));
    const launcherPath = path.join(tempDir, "recallx-mcp");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    try {
      await runCli(["node", "recallx", "mcp", "install", "--path", launcherPath]);
      const contents = readFileSync(launcherPath, "utf8");
      const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");

      expect(contents).toContain("recallx-mcp.js");
      expect(contents).toContain("--api");
      expect(contents).toContain('command -v node');
      expect(contents).not.toContain(process.execPath);
      expect(output).toContain(`Installed launcher: ${launcherPath}`);
      expect(output).toContain("\"mcpServers\"");
      expect(output).toContain("RECALLX_API_TOKEN");
      expect(output).toContain("bearer auth");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("does not persist bearer tokens into the installed launcher script", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "recallx-cli-test-"));
    const launcherPath = path.join(tempDir, "recallx-mcp");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    try {
      await runCli(["node", "recallx", "mcp", "install", "--path", launcherPath, "--token", "secret-token"]);
      const contents = readFileSync(launcherPath, "utf8");
      const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");

      expect(contents).not.toContain("secret-token");
      expect(contents).not.toContain("--token");
      expect(output).toContain("RECALLX_API_TOKEN");
      expect(output).toContain("does not persist bearer tokens");
      expect(output).toContain("bearer-mode services");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe("getAuthToken", () => {
  it("prefers the API token env var while keeping the legacy token alias", () => {
    expect(getAuthToken({}, { RECALLX_API_TOKEN: "api-token", RECALLX_TOKEN: "legacy-token" })).toBe("api-token");
    expect(getAuthToken({}, { RECALLX_TOKEN: "legacy-token" })).toBe("legacy-token");
    expect(getAuthToken({ token: "argv-token" }, { RECALLX_API_TOKEN: "api-token" })).toBe("argv-token");
  });
});
