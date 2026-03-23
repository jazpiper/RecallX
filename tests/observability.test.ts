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
  const root = mkdtempSync(path.join(tmpdir(), "recallx-observability-"));
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

  it("records nested span ids for child operations", async () => {
    const { root, writer } = createWriter();
    const rootSpan = writer.startSpan({
      surface: "api",
      operation: "request.root",
      traceId: "trace_nested",
      requestId: "req_nested"
    });

    await writer.withContext(
      {
        traceId: "trace_nested",
        requestId: "req_nested",
        workspaceRoot: root,
        workspaceName: "Observability Test",
        surface: "api",
        toolName: null
      },
      async () =>
        rootSpan.run(async () => {
          const childSpan = writer.startSpan({
            operation: "request.child"
          });
          await childSpan.run(async () => {});
          await childSpan.finish();
        })
    );
    await rootSpan.finish();
    await writer.flush();

    const logFile = path.join(root, "logs", `telemetry-${new Date().toISOString().slice(0, 10)}.ndjson`);
    const events = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { operation: string; spanId: string | null; parentSpanId: string | null });
    const rootEvent = events.find((event) => event.operation === "request.root");
    const childEvent = events.find((event) => event.operation === "request.child");

    expect(rootEvent?.spanId).toBeTruthy();
    expect(rootEvent?.parentSpanId).toBeNull();
    expect(childEvent?.spanId).toBeTruthy();
    expect(childEvent?.parentSpanId).toBe(rootEvent?.spanId);
  });

  it("summarizes telemetry and lists recent errors", async () => {
    const { writer } = createWriter();

    await writer.recordEvent({
      surface: "api",
      operation: "nodes.search",
      durationMs: 12,
      details: {
        bestLexicalQuality: "strong",
        searchHit: true,
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
    await writer.recordEvent({
      surface: "api",
      operation: "workspace.search",
      durationMs: 16,
      details: {
        bestNodeLexicalQuality: "weak",
        resultComposition: "semantic_mixed",
        searchHit: false,
        semanticFallbackMode: "no_strong_node_hit",
        semanticFallbackEligible: true,
        semanticFallbackAttempted: true,
        semanticFallbackUsed: true
      }
    });
    await writer.recordError({
      surface: "mcp",
      operation: "recallx_search_nodes",
      durationMs: 8,
      errorCode: "NETWORK_ERROR",
      errorKind: "network_error"
    });
    await writer.recordEvent({
      surface: "api",
      operation: "search.feedback",
      details: {
        feedbackVerdict: "useful",
        feedbackLexicalQuality: "weak",
        feedbackRank: 2,
        feedbackSemanticFallbackMode: "strict_zero"
      }
    });
    await writer.recordEvent({
      surface: "api",
      operation: "search.feedback",
      details: {
        feedbackVerdict: "not_useful",
        feedbackLexicalQuality: "none",
        feedbackMatchStrategy: "semantic",
        feedbackRank: 1,
        feedbackSemanticLifted: true,
        feedbackSemanticFallbackMode: "no_strong_node_hit"
      }
    });
    await writer.recordEvent({
      surface: "api",
      operation: "search.feedback",
      details: {
        feedbackVerdict: "useful",
        feedbackLexicalQuality: "none",
        feedbackMatchStrategy: "semantic",
        feedbackRank: 1,
        feedbackSemanticLifted: true,
        feedbackSemanticFallbackMode: "no_strong_node_hit"
      }
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

    expect(summary.totalEvents).toBe(7);
    expect(summary.operationSummaries.some((item) => item.operation === "nodes.search")).toBe(true);
    expect(summary.mcpToolFailures).toEqual([{ operation: "recallx_search_nodes", count: 1 }]);
    expect(summary.ftsFallbackRate.fallbackCount).toBe(1);
    expect(summary.searchHitRate).toEqual({
      hitCount: 1,
      missCount: 1,
      sampleCount: 2,
      ratio: 0.5,
      operations: [
        {
          surface: "api",
          operation: "nodes.search",
          hitCount: 1,
          missCount: 0,
          sampleCount: 1,
          ratio: 1
        },
        {
          surface: "api",
          operation: "workspace.search",
          hitCount: 0,
          missCount: 1,
          sampleCount: 1,
          ratio: 0
        }
      ]
    });
    expect(summary.searchLexicalQualityRate).toEqual({
      strongCount: 1,
      weakCount: 1,
      noneCount: 0,
      sampleCount: 2,
      operations: [
        {
          surface: "api",
          operation: "nodes.search",
          strongCount: 1,
          weakCount: 0,
          noneCount: 0,
          sampleCount: 1
        },
        {
          surface: "api",
          operation: "workspace.search",
          strongCount: 0,
          weakCount: 1,
          noneCount: 0,
          sampleCount: 1
        }
      ]
    });
    expect(summary.workspaceResultCompositionRate).toEqual({
      emptyCount: 0,
      nodeOnlyCount: 0,
      activityOnlyCount: 0,
      mixedCount: 0,
      semanticNodeOnlyCount: 0,
      semanticMixedCount: 1,
      sampleCount: 1
    });
    expect(summary.workspaceFallbackModeRate).toEqual({
      strictZeroCount: 0,
      noStrongNodeHitCount: 1,
      sampleCount: 1,
      operations: [
        {
          surface: "api",
          operation: "workspace.search",
          strictZeroCount: 0,
          noStrongNodeHitCount: 1,
          sampleCount: 1
        }
      ]
    });
    expect(summary.searchFeedbackRate).toEqual({
      usefulCount: 2,
      notUsefulCount: 1,
      uncertainCount: 0,
      sampleCount: 3,
      usefulRatio: 0.6667,
      top1UsefulCount: 1,
      top1SampleCount: 2,
      top1UsefulRatio: 0.5,
      top3UsefulCount: 2,
      top3SampleCount: 3,
      top3UsefulRatio: 0.6667,
      semanticUsefulCount: 1,
      semanticNotUsefulCount: 1,
      semanticSampleCount: 2,
      semanticUsefulRatio: 0.5,
      semanticFalsePositiveRatio: 0.5,
      semanticLiftUsefulCount: 1,
      semanticLiftSampleCount: 2,
      semanticLiftUsefulRatio: 0.5,
      byLexicalQuality: [
        {
          lexicalQuality: "weak",
          usefulCount: 1,
          notUsefulCount: 0,
          uncertainCount: 0,
          sampleCount: 1,
          usefulRatio: 1
        },
        {
          lexicalQuality: "none",
          usefulCount: 1,
          notUsefulCount: 1,
          uncertainCount: 0,
          sampleCount: 2,
          usefulRatio: 0.5
        }
      ],
      byFallbackMode: [
        {
          fallbackMode: "strict_zero",
          usefulCount: 1,
          notUsefulCount: 0,
          uncertainCount: 0,
          sampleCount: 1,
          usefulRatio: 1
        },
        {
          fallbackMode: "no_strong_node_hit",
          usefulCount: 1,
          notUsefulCount: 1,
          uncertainCount: 0,
          sampleCount: 2,
          usefulRatio: 0.5
        }
      ]
    });
    expect(summary.semanticAugmentationRate.usedCount).toBe(1);
    expect(summary.semanticFallbackRate).toEqual({
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
    });
    expect(errors.items).toHaveLength(1);
    expect(errors.items[0]?.operation).toBe("recallx_search_nodes");
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
