import { AsyncLocalStorage } from "node:async_hooks";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  JsonMap,
  SearchLexicalQuality,
  TelemetryErrorKind,
  TelemetryErrorsResponse,
  TelemetryEvent,
  TelemetryOperationSummary,
  TelemetryOutcome,
  TelemetrySummaryResponse,
  TelemetrySurface,
  WorkspaceSemanticFallbackMode
} from "../shared/types.js";
import { createId } from "./utils.js";

type TelemetryState = {
  enabled: boolean;
  workspaceRoot: string;
  workspaceName: string;
  retentionDays: number;
  slowRequestMs: number;
  capturePayloadShape: boolean;
};

type TelemetryContext = {
  traceId: string;
  requestId: string | null;
  workspaceRoot: string;
  workspaceName: string;
  surface: TelemetrySurface;
  toolName: string | null;
  spans: TelemetrySpan[];
};

type TelemetryWriterOptions = {
  getState: () => TelemetryState;
};

type StartSpanInput = {
  surface?: TelemetrySurface;
  operation: string;
  requestId?: string | null;
  traceId?: string;
  parentSpanId?: string | null;
  details?: JsonMap;
};

type FinishSpanInput = {
  outcome?: TelemetryOutcome;
  requestId?: string | null;
  statusCode?: number | null;
  errorCode?: string | null;
  errorKind?: TelemetryErrorKind | null;
  details?: JsonMap;
};

type RecordEventInput = {
  surface?: TelemetrySurface;
  operation: string;
  outcome?: TelemetryOutcome;
  requestId?: string | null;
  traceId?: string;
  durationMs?: number | null;
  statusCode?: number | null;
  errorCode?: string | null;
  errorKind?: TelemetryErrorKind | null;
  details?: JsonMap;
};

type ReadTelemetryOptions = {
  since: string | null;
  surface?: TelemetrySurface | "all";
  limit?: number;
};

const telemetryStorage = new AsyncLocalStorage<TelemetryContext>();

function nowIso() {
  return new Date().toISOString();
}

function createSpanId() {
  return createId("span");
}

function parseJsonLine(line: string): TelemetryEvent | null {
  if (!line.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(line) as Partial<TelemetryEvent>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.ts !== "string" || typeof parsed.operation !== "string") {
      return null;
    }

    return {
      ts: parsed.ts,
      traceId: typeof parsed.traceId === "string" ? parsed.traceId : "trace_unknown",
      spanId: typeof parsed.spanId === "string" ? parsed.spanId : null,
      parentSpanId: typeof parsed.parentSpanId === "string" ? parsed.parentSpanId : null,
      requestId: typeof parsed.requestId === "string" ? parsed.requestId : null,
      surface: parsed.surface === "mcp" ? "mcp" : "api",
      operation: parsed.operation,
      outcome: parsed.outcome === "error" ? "error" : "success",
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : null,
      statusCode: typeof parsed.statusCode === "number" ? parsed.statusCode : null,
      errorCode: typeof parsed.errorCode === "string" ? parsed.errorCode : null,
      errorKind: typeof parsed.errorKind === "string" ? parsed.errorKind : null,
      workspaceName: typeof parsed.workspaceName === "string" ? parsed.workspaceName : null,
      details: parsed.details && typeof parsed.details === "object" && !Array.isArray(parsed.details) ? parsed.details as JsonMap : {}
    };
  } catch {
    return null;
  }
}

function roundDuration(value: number) {
  return Number(value.toFixed(2));
}

function dateStamp(value: string) {
  return value.slice(0, 10);
}

function telemetryLogDate(entry: string): string | null {
  const match = /^telemetry-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(entry);
  return match ? match[1] : null;
}

function normalizeRetentionDays(value: number) {
  return Math.max(1, Math.trunc(value || 14));
}

function normalizeLimit(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(value), 1), 200);
}

function percentiles(durations: number[]) {
  if (!durations.length) {
    return {
      avg: null,
      p50: null,
      p95: null,
      p99: null
    };
  }

  const sorted = [...durations].sort((left, right) => left - right);
  const read = (percentile: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1))];
  const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;

  return {
    avg: roundDuration(avg),
    p50: roundDuration(read(0.5)),
    p95: roundDuration(read(0.95)),
    p99: roundDuration(read(0.99))
  };
}

function parseSince(since: string | null | undefined): number {
  const normalized = since?.trim();
  if (!normalized) {
    return Date.now() - 24 * 60 * 60 * 1000;
  }

  const absolute = Date.parse(normalized);
  if (Number.isFinite(absolute)) {
    return absolute;
  }

  const relativeMatch = normalized.match(/^(\d+)([smhd])$/i);
  if (!relativeMatch) {
    return Date.now() - 24 * 60 * 60 * 1000;
  }

  const amount = Number(relativeMatch[1]);
  const unit = relativeMatch[2].toLowerCase();
  const multiplier =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60 * 1000
        : unit === "h"
          ? 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;

  return Date.now() - amount * multiplier;
}

function buildPayloadShapeSummary(value: unknown): JsonMap {
  if (Array.isArray(value)) {
    return {
      argCount: value.length
    };
  }

  if (!value || typeof value !== "object") {
    return {};
  }

  return {
    argKeys: Object.keys(value as Record<string, unknown>).sort(),
    argCount: Object.keys(value as Record<string, unknown>).length
  };
}

function sanitizeDetails(details: JsonMap | undefined): JsonMap {
  if (!details) {
    return {};
  }

  const sanitized: JsonMap = {};
  const shouldSkipKey = (key: string) => {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return ["body", "summary", "metadata", "token", "authorization", "artifact", "content"].some((part) =>
      normalized.includes(part)
    );
  };

  for (const [key, value] of Object.entries(details)) {
    if (shouldSkipKey(key)) {
      continue;
    }
    if (value === undefined) {
      continue;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
      continue;
    }
    if (typeof value === "string") {
      sanitized[key] = value.length > 200 ? `${value.slice(0, 197)}...` : value;
      continue;
    }
    if (Array.isArray(value)) {
      sanitized[key] = value
        .filter((item) => item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean")
        .slice(0, 20);
      continue;
    }
    if (typeof value === "object") {
      const flat: JsonMap = {};
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (shouldSkipKey(innerKey)) {
          continue;
        }
        if (
          innerValue === null ||
          typeof innerValue === "string" ||
          typeof innerValue === "number" ||
          typeof innerValue === "boolean"
        ) {
          flat[innerKey] = typeof innerValue === "string" && innerValue.length > 200
            ? `${innerValue.slice(0, 197)}...`
            : innerValue;
        }
      }
      sanitized[key] = flat;
    }
  }

  return sanitized;
}

export class TelemetrySpan {
  private readonly startedAt = process.hrtime.bigint();
  private readonly details: JsonMap;
  private finished = false;

  constructor(
    private readonly writer: ObservabilityWriter,
    private readonly state: TelemetryState,
    private readonly context: TelemetryContext,
    readonly spanId: string,
    readonly parentSpanId: string | null,
    private readonly operation: string,
    details?: JsonMap
  ) {
    this.details = sanitizeDetails(details);
  }

  addDetails(details: JsonMap | undefined) {
    Object.assign(this.details, sanitizeDetails(details));
  }

  async finish(input: FinishSpanInput = {}) {
    if (this.finished) {
      return;
    }

    this.finished = true;
    const durationMs = roundDuration(Number(process.hrtime.bigint() - this.startedAt) / 1_000_000);

    await this.writer.enqueue({
      ts: nowIso(),
      traceId: this.context.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      requestId: input.requestId ?? this.context.requestId,
      surface: this.context.surface,
      operation: this.operation,
      outcome: input.outcome ?? "success",
      durationMs,
      statusCode: input.statusCode ?? null,
      errorCode: input.errorCode ?? null,
      errorKind: input.errorKind ?? null,
      workspaceName: this.state.workspaceName,
      details: sanitizeDetails({
        ...this.details,
        ...input.details
      })
    }, this.state);
  }

  run<T>(callback: () => T): T {
    return telemetryStorage.run(
      {
        ...this.context,
        spans: [...this.context.spans, this]
      },
      callback
    );
  }
}

export class ObservabilityWriter {
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly retentionRuns = new Map<string, string>();

  constructor(private readonly options: TelemetryWriterOptions) {}

  currentContext() {
    return telemetryStorage.getStore() ?? null;
  }

  withContext<T>(
    input: Omit<TelemetryContext, "spans">,
    callback: () => T
  ): T {
    const current = telemetryStorage.getStore();
    return telemetryStorage.run(
      {
        ...input,
        spans: current?.spans ?? []
      },
      callback
    );
  }

  startSpan(input: StartSpanInput): TelemetrySpan {
    const state = this.options.getState();
    const current = telemetryStorage.getStore();
    const parentSpan = current?.spans[current.spans.length - 1] ?? null;
    const context: TelemetryContext = {
      traceId: input.traceId ?? current?.traceId ?? "trace_unknown",
      requestId: input.requestId ?? current?.requestId ?? null,
      workspaceRoot: current?.workspaceRoot ?? state.workspaceRoot,
      workspaceName: current?.workspaceName ?? state.workspaceName,
      surface: input.surface ?? current?.surface ?? "api",
      toolName: current?.toolName ?? null,
      spans: current?.spans ?? []
    };

    return new TelemetrySpan(
      this,
      state,
      context,
      createSpanId(),
      input.parentSpanId ?? parentSpan?.spanId ?? null,
      input.operation,
      input.details
    );
  }

  addCurrentSpanDetails(details: JsonMap | undefined) {
    const current = telemetryStorage.getStore();
    current?.spans[current.spans.length - 1]?.addDetails(details);
  }

  async recordEvent(input: RecordEventInput) {
    const state = this.options.getState();
    if (!state.enabled) {
      return;
    }

    const current = telemetryStorage.getStore();
    await this.enqueue(
      {
        ts: nowIso(),
        traceId: input.traceId ?? current?.traceId ?? "trace_unknown",
        spanId: createSpanId(),
        parentSpanId: current?.spans[current.spans.length - 1]?.spanId ?? null,
        requestId: input.requestId ?? current?.requestId ?? null,
        surface: input.surface ?? current?.surface ?? "api",
        operation: input.operation,
        outcome: input.outcome ?? "success",
        durationMs: input.durationMs ?? null,
        statusCode: input.statusCode ?? null,
        errorCode: input.errorCode ?? null,
        errorKind: input.errorKind ?? null,
        workspaceName: state.workspaceName,
        details: sanitizeDetails(input.details)
      },
      state
    );
  }

  async recordError(input: RecordEventInput) {
    await this.recordEvent({
      ...input,
      outcome: "error"
    });
  }

  async enqueue(event: TelemetryEvent, state: TelemetryState) {
    if (!state.enabled) {
      return;
    }

    void this.pruneLogsIfNeeded(state);

    const filePath = path.join(state.workspaceRoot, "logs", `telemetry-${dateStamp(event.ts)}.ndjson`);
    const write = (async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
    })();

    this.pendingWrites.add(write);
    write.finally(() => {
      this.pendingWrites.delete(write);
    }).catch(() => {});
  }

  async flush() {
    await Promise.allSettled([...this.pendingWrites]);
  }

  async pruneLogsIfNeeded(state: TelemetryState) {
    const retentionDays = normalizeRetentionDays(state.retentionDays);
    const today = dateStamp(nowIso());
    const workspaceKey = `${state.workspaceRoot}:${retentionDays}`;
    if (this.retentionRuns.get(workspaceKey) === today) {
      return;
    }
    this.retentionRuns.set(workspaceKey, today);

    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
    const cutoffStamp = dateStamp(cutoff.toISOString());
    const logsDir = path.join(state.workspaceRoot, "logs");

    let entries: string[];
    try {
      entries = await readdir(logsDir);
    } catch {
      return;
    }

    await Promise.all(
      entries
        .filter((entry) => /^telemetry-\d{4}-\d{2}-\d{2}\.ndjson$/.test(entry))
        .filter((entry) => entry.slice("telemetry-".length, "telemetry-".length + 10) < cutoffStamp)
        .map((entry) => unlink(path.join(logsDir, entry)).catch(() => {}))
    );
  }

  async readEvents(options: ReadTelemetryOptions): Promise<{ logsPath: string; events: TelemetryEvent[]; since: string }> {
    const state = this.options.getState();
    const sinceMs = parseSince(options.since);
    const logsDir = path.join(state.workspaceRoot, "logs");

    void this.pruneLogsIfNeeded(state);

    let entries: string[];
    try {
      entries = await readdir(logsDir);
    } catch {
      return {
        logsPath: logsDir,
        events: [],
        since: new Date(sinceMs).toISOString()
      };
    }

    const files = entries
      .filter((entry) => /^telemetry-\d{4}-\d{2}-\d{2}\.ndjson$/.test(entry))
      .filter((entry) => {
        const stamp = telemetryLogDate(entry);
        return stamp !== null && stamp >= dateStamp(new Date(sinceMs).toISOString());
      })
      .sort();

    const events: TelemetryEvent[] = [];
    for (const file of files) {
      const filePath = path.join(logsDir, file);
      const stream = createReadStream(filePath, { encoding: "utf8" });
      const lines = createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY
      });
      try {
        for await (const line of lines) {
          const event = parseJsonLine(line);
          if (!event) {
            continue;
          }
          const eventMs = Date.parse(event.ts);
          if (!Number.isFinite(eventMs) || eventMs < sinceMs) {
            continue;
          }
          if (options.surface && options.surface !== "all" && event.surface !== options.surface) {
            continue;
          }
          events.push(event);
        }
      } catch {
        // Ignore individual file read failures so observability endpoints stay resilient.
      } finally {
        lines.close();
        stream.destroy();
      }
    }

    return {
      logsPath: logsDir,
      events,
      since: new Date(sinceMs).toISOString()
    };
  }

  async summarize(options: ReadTelemetryOptions): Promise<TelemetrySummaryResponse> {
    const state = this.options.getState();
    const { logsPath, events, since } = await this.readEvents(options);
    const buckets = new Map<string, { summary: TelemetryOperationSummary; durations: number[] }>();
    const mcpFailures = new Map<string, number>();
    const autoJobs = new Map<string, number[]>();
    const searchHitBuckets = new Map<string, { surface: TelemetrySurface; operation: string; hitCount: number; missCount: number }>();
    const lexicalQualityBuckets = new Map<
      string,
      { surface: TelemetrySurface; operation: string; strongCount: number; weakCount: number; noneCount: number }
    >();
    const workspaceFallbackModeBuckets = new Map<
      string,
      { surface: TelemetrySurface; operation: string; strictZeroCount: number; noStrongNodeHitCount: number }
    >();
    const feedbackByLexicalQuality = new Map<SearchLexicalQuality, { usefulCount: number; notUsefulCount: number; uncertainCount: number }>();
    const feedbackByFallbackMode = new Map<
      WorkspaceSemanticFallbackMode,
      { usefulCount: number; notUsefulCount: number; uncertainCount: number }
    >();
    const semanticFallbackByMode = new Map<
      WorkspaceSemanticFallbackMode,
      { eligibleCount: number; attemptedCount: number; hitCount: number; sampleCount: number }
    >();
    let ftsFallbackCount = 0;
    let ftsSampleCount = 0;
    let searchHitCount = 0;
    let searchMissCount = 0;
    let searchSampleCount = 0;
    let strongLexicalCount = 0;
    let weakLexicalCount = 0;
    let noLexicalCount = 0;
    let lexicalSampleCount = 0;
    let emptyCompositionCount = 0;
    let nodeOnlyCompositionCount = 0;
    let activityOnlyCompositionCount = 0;
    let mixedCompositionCount = 0;
    let semanticNodeOnlyCompositionCount = 0;
    let semanticMixedCompositionCount = 0;
    let compositionSampleCount = 0;
    let strictZeroFallbackModeCount = 0;
    let noStrongNodeHitFallbackModeCount = 0;
    let workspaceFallbackModeSampleCount = 0;
    let feedbackUsefulCount = 0;
    let feedbackNotUsefulCount = 0;
    let feedbackUncertainCount = 0;
    let feedbackSampleCount = 0;
    let feedbackTop1UsefulCount = 0;
    let feedbackTop1SampleCount = 0;
    let feedbackTop3UsefulCount = 0;
    let feedbackTop3SampleCount = 0;
    let feedbackSemanticUsefulCount = 0;
    let feedbackSemanticNotUsefulCount = 0;
    let feedbackSemanticSampleCount = 0;
    let feedbackSemanticLiftUsefulCount = 0;
    let feedbackSemanticLiftSampleCount = 0;
    let semanticUsedCount = 0;
    let semanticSampleCount = 0;
    let semanticFallbackEligibleCount = 0;
    let semanticFallbackAttemptedCount = 0;
    let semanticFallbackHitCount = 0;

    for (const event of events) {
      if (typeof event.details.ftsFallback === "boolean") {
        ftsSampleCount += 1;
        if (event.details.ftsFallback) {
          ftsFallbackCount += 1;
        }
      }
      if (typeof event.details.searchHit === "boolean") {
        searchSampleCount += 1;
        if (event.details.searchHit) {
          searchHitCount += 1;
        } else {
          searchMissCount += 1;
        }

        const bucketKey = `${event.surface}:${event.operation}`;
        const current =
          searchHitBuckets.get(bucketKey) ?? {
            surface: event.surface,
            operation: event.operation,
            hitCount: 0,
            missCount: 0
          };
        if (event.details.searchHit) {
          current.hitCount += 1;
        } else {
          current.missCount += 1;
        }
        searchHitBuckets.set(bucketKey, current);
      }
      if (
        event.details.bestLexicalQuality === "strong" ||
        event.details.bestLexicalQuality === "weak" ||
        event.details.bestLexicalQuality === "none" ||
        event.details.bestNodeLexicalQuality === "strong" ||
        event.details.bestNodeLexicalQuality === "weak" ||
        event.details.bestNodeLexicalQuality === "none"
      ) {
        const quality = (event.details.bestNodeLexicalQuality ??
          event.details.bestLexicalQuality) as SearchLexicalQuality;
        lexicalSampleCount += 1;
        if (quality === "strong") {
          strongLexicalCount += 1;
        } else if (quality === "weak") {
          weakLexicalCount += 1;
        } else {
          noLexicalCount += 1;
        }

        const bucketKey = `${event.surface}:${event.operation}`;
        const current =
          lexicalQualityBuckets.get(bucketKey) ?? {
            surface: event.surface,
            operation: event.operation,
            strongCount: 0,
            weakCount: 0,
            noneCount: 0
          };
        if (quality === "strong") {
          current.strongCount += 1;
        } else if (quality === "weak") {
          current.weakCount += 1;
        } else {
          current.noneCount += 1;
        }
        lexicalQualityBuckets.set(bucketKey, current);
      }
      if (typeof event.details.resultComposition === "string") {
        compositionSampleCount += 1;
        switch (event.details.resultComposition) {
          case "node_only":
            nodeOnlyCompositionCount += 1;
            break;
          case "activity_only":
            activityOnlyCompositionCount += 1;
            break;
          case "mixed":
            mixedCompositionCount += 1;
            break;
          case "semantic_node_only":
            semanticNodeOnlyCompositionCount += 1;
            break;
          case "semantic_mixed":
            semanticMixedCompositionCount += 1;
            break;
          default:
            emptyCompositionCount += 1;
            break;
        }
      }
      if (
        event.operation === "workspace.search" &&
        (event.details.semanticFallbackMode === "strict_zero" || event.details.semanticFallbackMode === "no_strong_node_hit")
      ) {
        workspaceFallbackModeSampleCount += 1;
        if (event.details.semanticFallbackMode === "strict_zero") {
          strictZeroFallbackModeCount += 1;
        } else {
          noStrongNodeHitFallbackModeCount += 1;
        }

        const bucketKey = `${event.surface}:${event.operation}`;
        const current =
          workspaceFallbackModeBuckets.get(bucketKey) ?? {
            surface: event.surface,
            operation: event.operation,
            strictZeroCount: 0,
            noStrongNodeHitCount: 0
          };
        if (event.details.semanticFallbackMode === "strict_zero") {
          current.strictZeroCount += 1;
        } else {
          current.noStrongNodeHitCount += 1;
        }
        workspaceFallbackModeBuckets.set(bucketKey, current);
      }
      if (
        event.operation === "search.feedback" &&
        (
          event.details.feedbackVerdict === "useful" ||
          event.details.feedbackVerdict === "not_useful" ||
          event.details.feedbackVerdict === "uncertain"
        )
      ) {
        feedbackSampleCount += 1;
        if (event.details.feedbackVerdict === "useful") {
          feedbackUsefulCount += 1;
        } else if (event.details.feedbackVerdict === "not_useful") {
          feedbackNotUsefulCount += 1;
        } else {
          feedbackUncertainCount += 1;
        }
        const feedbackRank =
          typeof event.details.feedbackRank === "number" && Number.isFinite(event.details.feedbackRank)
            ? event.details.feedbackRank
            : null;
        if (feedbackRank != null) {
          if (feedbackRank <= 1) {
            feedbackTop1SampleCount += 1;
            if (event.details.feedbackVerdict === "useful") {
              feedbackTop1UsefulCount += 1;
            }
          }
          if (feedbackRank <= 3) {
            feedbackTop3SampleCount += 1;
            if (event.details.feedbackVerdict === "useful") {
              feedbackTop3UsefulCount += 1;
            }
          }
        }
        const feedbackMatchStrategy =
          event.details.feedbackMatchStrategy === "fts" ||
          event.details.feedbackMatchStrategy === "like" ||
          event.details.feedbackMatchStrategy === "fallback_token" ||
          event.details.feedbackMatchStrategy === "semantic" ||
          event.details.feedbackMatchStrategy === "browse"
            ? event.details.feedbackMatchStrategy
            : null;
        if (feedbackMatchStrategy === "semantic") {
          feedbackSemanticSampleCount += 1;
          if (event.details.feedbackVerdict === "useful") {
            feedbackSemanticUsefulCount += 1;
          } else if (event.details.feedbackVerdict === "not_useful") {
            feedbackSemanticNotUsefulCount += 1;
          }
        }
        if (event.details.feedbackSemanticLifted === true) {
          feedbackSemanticLiftSampleCount += 1;
          if (event.details.feedbackVerdict === "useful") {
            feedbackSemanticLiftUsefulCount += 1;
          }
        }

        const lexicalQuality =
          event.details.feedbackLexicalQuality === "strong" ||
          event.details.feedbackLexicalQuality === "weak" ||
          event.details.feedbackLexicalQuality === "none"
            ? (event.details.feedbackLexicalQuality as SearchLexicalQuality)
            : null;
        if (lexicalQuality) {
          const current = feedbackByLexicalQuality.get(lexicalQuality) ?? {
            usefulCount: 0,
            notUsefulCount: 0,
            uncertainCount: 0
          };
          if (event.details.feedbackVerdict === "useful") {
            current.usefulCount += 1;
          } else if (event.details.feedbackVerdict === "not_useful") {
            current.notUsefulCount += 1;
          } else {
            current.uncertainCount += 1;
          }
          feedbackByLexicalQuality.set(lexicalQuality, current);
        }

        const feedbackFallbackMode =
          event.details.feedbackSemanticFallbackMode === "strict_zero" ||
          event.details.feedbackSemanticFallbackMode === "no_strong_node_hit"
            ? (event.details.feedbackSemanticFallbackMode as WorkspaceSemanticFallbackMode)
            : null;
        if (feedbackFallbackMode) {
          const current = feedbackByFallbackMode.get(feedbackFallbackMode) ?? {
            usefulCount: 0,
            notUsefulCount: 0,
            uncertainCount: 0
          };
          if (event.details.feedbackVerdict === "useful") {
            current.usefulCount += 1;
          } else if (event.details.feedbackVerdict === "not_useful") {
            current.notUsefulCount += 1;
          } else {
            current.uncertainCount += 1;
          }
          feedbackByFallbackMode.set(feedbackFallbackMode, current);
        }
      }
      if (typeof event.details.semanticUsed === "boolean") {
        semanticSampleCount += 1;
        if (event.details.semanticUsed) {
          semanticUsedCount += 1;
        }
      }
      if (typeof event.details.semanticFallbackEligible === "boolean") {
        if (event.details.semanticFallbackEligible) {
          semanticFallbackEligibleCount += 1;
        }
      }
      if (typeof event.details.semanticFallbackAttempted === "boolean") {
        if (event.details.semanticFallbackAttempted) {
          semanticFallbackAttemptedCount += 1;
        }
      }
      if (typeof event.details.semanticFallbackUsed === "boolean") {
        if (event.details.semanticFallbackUsed) {
          semanticFallbackHitCount += 1;
        }
      }
      const semanticFallbackMode =
        event.operation === "workspace.search" &&
        (event.details.semanticFallbackMode === "strict_zero" || event.details.semanticFallbackMode === "no_strong_node_hit")
          ? (event.details.semanticFallbackMode as WorkspaceSemanticFallbackMode)
          : null;
      if (semanticFallbackMode) {
        const current = semanticFallbackByMode.get(semanticFallbackMode) ?? {
          eligibleCount: 0,
          attemptedCount: 0,
          hitCount: 0,
          sampleCount: 0
        };
        current.sampleCount += 1;
        if (event.details.semanticFallbackEligible === true) {
          current.eligibleCount += 1;
        }
        if (event.details.semanticFallbackAttempted === true) {
          current.attemptedCount += 1;
        }
        if (event.details.semanticFallbackUsed === true) {
          current.hitCount += 1;
        }
        semanticFallbackByMode.set(semanticFallbackMode, current);
      }

      if (event.durationMs != null) {
        const bucketKey = `${event.surface}:${event.operation}`;
        const current =
          buckets.get(bucketKey) ??
          {
            summary: {
              surface: event.surface,
              operation: event.operation,
              count: 0,
              errorCount: 0,
              errorRate: 0,
              avgDurationMs: null,
              p50DurationMs: null,
              p95DurationMs: null,
              p99DurationMs: null
            },
            durations: []
          };
        current.summary.count += 1;
        if (event.outcome === "error") {
          current.summary.errorCount += 1;
        }
        current.durations.push(event.durationMs);
        buckets.set(bucketKey, current);
      }

      if (event.surface === "mcp" && event.outcome === "error") {
        mcpFailures.set(event.operation, (mcpFailures.get(event.operation) ?? 0) + 1);
      }

      if (event.operation.startsWith("auto.")) {
        const durations = autoJobs.get(event.operation) ?? [];
        if (event.durationMs != null) {
          durations.push(event.durationMs);
        }
        autoJobs.set(event.operation, durations);
      }
    }

    const operationSummaries = [...buckets.values()]
      .map(({ summary, durations }) => {
        const stats = percentiles(durations);
        return {
          ...summary,
          errorRate: summary.count > 0 ? Number((summary.errorCount / summary.count).toFixed(4)) : 0,
          avgDurationMs: stats.avg,
          p50DurationMs: stats.p50,
          p95DurationMs: stats.p95,
          p99DurationMs: stats.p99
        };
      })
      .sort((left, right) => (right.p95DurationMs ?? 0) - (left.p95DurationMs ?? 0));

    return {
      since,
      generatedAt: nowIso(),
      logsPath,
      totalEvents: events.length,
      operationSummaries,
      slowOperations: operationSummaries
        .filter((item) => (item.p95DurationMs ?? 0) >= state.slowRequestMs)
        .slice(0, 10),
      mcpToolFailures: [...mcpFailures.entries()]
        .map(([operation, count]) => ({ operation, count }))
        .sort((left, right) => right.count - left.count),
      ftsFallbackRate: {
        fallbackCount: ftsFallbackCount,
        sampleCount: ftsSampleCount,
        ratio: ftsSampleCount > 0 ? Number((ftsFallbackCount / ftsSampleCount).toFixed(4)) : null
      },
      searchHitRate: {
        hitCount: searchHitCount,
        missCount: searchMissCount,
        sampleCount: searchSampleCount,
        ratio: searchSampleCount > 0 ? Number((searchHitCount / searchSampleCount).toFixed(4)) : null,
        operations: [...searchHitBuckets.values()]
          .map((item) => ({
            ...item,
            sampleCount: item.hitCount + item.missCount,
            ratio:
              item.hitCount + item.missCount > 0
                ? Number((item.hitCount / (item.hitCount + item.missCount)).toFixed(4))
                : null
          }))
          .sort((left, right) => right.sampleCount - left.sampleCount || left.operation.localeCompare(right.operation))
      },
      searchLexicalQualityRate: {
        strongCount: strongLexicalCount,
        weakCount: weakLexicalCount,
        noneCount: noLexicalCount,
        sampleCount: lexicalSampleCount,
        operations: [...lexicalQualityBuckets.values()]
          .map((item) => ({
            ...item,
            sampleCount: item.strongCount + item.weakCount + item.noneCount
          }))
          .sort((left, right) => right.sampleCount - left.sampleCount || left.operation.localeCompare(right.operation))
      },
      workspaceResultCompositionRate: {
        emptyCount: emptyCompositionCount,
        nodeOnlyCount: nodeOnlyCompositionCount,
        activityOnlyCount: activityOnlyCompositionCount,
        mixedCount: mixedCompositionCount,
        semanticNodeOnlyCount: semanticNodeOnlyCompositionCount,
        semanticMixedCount: semanticMixedCompositionCount,
        sampleCount: compositionSampleCount
      },
      workspaceFallbackModeRate: {
        strictZeroCount: strictZeroFallbackModeCount,
        noStrongNodeHitCount: noStrongNodeHitFallbackModeCount,
        sampleCount: workspaceFallbackModeSampleCount,
        operations: [...workspaceFallbackModeBuckets.values()]
          .map((item) => ({
            ...item,
            sampleCount: item.strictZeroCount + item.noStrongNodeHitCount
          }))
          .sort((left, right) => right.sampleCount - left.sampleCount || left.operation.localeCompare(right.operation))
      },
      searchFeedbackRate: {
        usefulCount: feedbackUsefulCount,
        notUsefulCount: feedbackNotUsefulCount,
        uncertainCount: feedbackUncertainCount,
        sampleCount: feedbackSampleCount,
        usefulRatio: feedbackSampleCount > 0 ? Number((feedbackUsefulCount / feedbackSampleCount).toFixed(4)) : null,
        top1UsefulCount: feedbackTop1UsefulCount,
        top1SampleCount: feedbackTop1SampleCount,
        top1UsefulRatio:
          feedbackTop1SampleCount > 0 ? Number((feedbackTop1UsefulCount / feedbackTop1SampleCount).toFixed(4)) : null,
        top3UsefulCount: feedbackTop3UsefulCount,
        top3SampleCount: feedbackTop3SampleCount,
        top3UsefulRatio:
          feedbackTop3SampleCount > 0 ? Number((feedbackTop3UsefulCount / feedbackTop3SampleCount).toFixed(4)) : null,
        semanticUsefulCount: feedbackSemanticUsefulCount,
        semanticNotUsefulCount: feedbackSemanticNotUsefulCount,
        semanticSampleCount: feedbackSemanticSampleCount,
        semanticUsefulRatio:
          feedbackSemanticSampleCount > 0 ? Number((feedbackSemanticUsefulCount / feedbackSemanticSampleCount).toFixed(4)) : null,
        semanticFalsePositiveRatio:
          feedbackSemanticSampleCount > 0 ? Number((feedbackSemanticNotUsefulCount / feedbackSemanticSampleCount).toFixed(4)) : null,
        semanticLiftUsefulCount: feedbackSemanticLiftUsefulCount,
        semanticLiftSampleCount: feedbackSemanticLiftSampleCount,
        semanticLiftUsefulRatio:
          feedbackSemanticLiftSampleCount > 0
            ? Number((feedbackSemanticLiftUsefulCount / feedbackSemanticLiftSampleCount).toFixed(4))
            : null,
        byLexicalQuality: (["strong", "weak", "none"] as SearchLexicalQuality[])
          .map((lexicalQuality) => {
            const counts = feedbackByLexicalQuality.get(lexicalQuality) ?? {
              usefulCount: 0,
              notUsefulCount: 0,
              uncertainCount: 0
            };
            const sampleCount = counts.usefulCount + counts.notUsefulCount + counts.uncertainCount;
            return {
              lexicalQuality,
              ...counts,
              sampleCount,
              usefulRatio: sampleCount > 0 ? Number((counts.usefulCount / sampleCount).toFixed(4)) : null
            };
          })
          .filter((item) => item.sampleCount > 0),
        byFallbackMode: (["strict_zero", "no_strong_node_hit"] as WorkspaceSemanticFallbackMode[])
          .map((fallbackMode) => {
            const counts = feedbackByFallbackMode.get(fallbackMode) ?? {
              usefulCount: 0,
              notUsefulCount: 0,
              uncertainCount: 0
            };
            const sampleCount = counts.usefulCount + counts.notUsefulCount + counts.uncertainCount;
            return {
              fallbackMode,
              ...counts,
              sampleCount,
              usefulRatio: sampleCount > 0 ? Number((counts.usefulCount / sampleCount).toFixed(4)) : null
            };
          })
          .filter((item) => item.sampleCount > 0)
      },
      semanticAugmentationRate: {
        usedCount: semanticUsedCount,
        sampleCount: semanticSampleCount,
        ratio: semanticSampleCount > 0 ? Number((semanticUsedCount / semanticSampleCount).toFixed(4)) : null
      },
      semanticFallbackRate: {
        eligibleCount: semanticFallbackEligibleCount,
        attemptedCount: semanticFallbackAttemptedCount,
        hitCount: semanticFallbackHitCount,
        attemptRatio:
          semanticFallbackEligibleCount > 0
            ? Number((semanticFallbackAttemptedCount / semanticFallbackEligibleCount).toFixed(4))
            : null,
        hitRatio:
          semanticFallbackAttemptedCount > 0
            ? Number((semanticFallbackHitCount / semanticFallbackAttemptedCount).toFixed(4))
            : null,
        modes: (["strict_zero", "no_strong_node_hit"] as WorkspaceSemanticFallbackMode[])
          .map((fallbackMode) => {
            const counts = semanticFallbackByMode.get(fallbackMode) ?? {
              eligibleCount: 0,
              attemptedCount: 0,
              hitCount: 0,
              sampleCount: 0
            };
            return {
              fallbackMode,
              ...counts,
              attemptRatio:
                counts.eligibleCount > 0 ? Number((counts.attemptedCount / counts.eligibleCount).toFixed(4)) : null,
              hitRatio:
                counts.attemptedCount > 0 ? Number((counts.hitCount / counts.attemptedCount).toFixed(4)) : null
            };
          })
          .filter((item) => item.sampleCount > 0)
      },
      autoJobStats: [...autoJobs.entries()].map(([operation, durations]) => ({
        operation,
        count: durations.length,
        avgDurationMs: durations.length ? roundDuration(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null
      }))
    };
  }

  async listErrors(options: ReadTelemetryOptions): Promise<TelemetryErrorsResponse> {
    const { logsPath, events, since } = await this.readEvents(options);
    return {
      since,
      generatedAt: nowIso(),
      surface: options.surface ?? "all",
      logsPath,
      items: events
        .filter((event) => event.outcome === "error")
        .sort((left, right) => right.ts.localeCompare(left.ts))
        .slice(0, normalizeLimit(options.limit))
    };
  }
}

export function createObservabilityWriter(options: TelemetryWriterOptions) {
  return new ObservabilityWriter(options);
}

export function currentTelemetryContext() {
  return telemetryStorage.getStore() ?? null;
}

export function currentTelemetrySpanId() {
  const current = telemetryStorage.getStore();
  return current?.spans[current.spans.length - 1]?.spanId ?? null;
}

export function appendCurrentTelemetryDetails(details: JsonMap | undefined) {
  const current = telemetryStorage.getStore();
  current?.spans[current.spans.length - 1]?.addDetails(details);
}

export function summarizePayloadShape(value: unknown): JsonMap {
  return buildPayloadShapeSummary(value);
}

export function parseTelemetrySince(value: string | null | undefined) {
  return new Date(parseSince(value)).toISOString();
}
