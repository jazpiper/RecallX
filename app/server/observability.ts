import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  JsonMap,
  TelemetryErrorKind,
  TelemetryErrorsResponse,
  TelemetryEvent,
  TelemetryOperationSummary,
  TelemetryOutcome,
  TelemetrySummaryResponse,
  TelemetrySurface
} from "../shared/types.js";

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

function parseJsonLine(line: string): TelemetryEvent | null {
  if (!line.trim()) {
    return null;
  }

  try {
    return JSON.parse(line) as TelemetryEvent;
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
    return telemetryStorage.run(
      {
        ...input,
        spans: []
      },
      callback
    );
  }

  startSpan(input: StartSpanInput): TelemetrySpan {
    const state = this.options.getState();
    const current = telemetryStorage.getStore();
    const context: TelemetryContext = {
      traceId: input.traceId ?? current?.traceId ?? "trace_unknown",
      requestId: input.requestId ?? current?.requestId ?? null,
      workspaceRoot: current?.workspaceRoot ?? state.workspaceRoot,
      workspaceName: current?.workspaceName ?? state.workspaceName,
      surface: input.surface ?? current?.surface ?? "api",
      toolName: current?.toolName ?? null,
      spans: current?.spans ?? []
    };

    return new TelemetrySpan(this, state, context, input.operation, input.details);
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
      .sort();

    const events: TelemetryEvent[] = [];
    for (const file of files) {
      const filePath = path.join(logsDir, file);
      const content = await readFile(filePath, "utf8").catch(() => "");
      for (const line of content.split("\n")) {
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
    let ftsFallbackCount = 0;
    let ftsSampleCount = 0;
    let semanticUsedCount = 0;
    let semanticSampleCount = 0;

    for (const event of events) {
      if (typeof event.details.ftsFallback === "boolean") {
        ftsSampleCount += 1;
        if (event.details.ftsFallback) {
          ftsFallbackCount += 1;
        }
      }
      if (typeof event.details.semanticUsed === "boolean") {
        semanticSampleCount += 1;
        if (event.details.semanticUsed) {
          semanticUsedCount += 1;
        }
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
      semanticAugmentationRate: {
        usedCount: semanticUsedCount,
        sampleCount: semanticSampleCount,
        ratio: semanticSampleCount > 0 ? Number((semanticUsedCount / semanticSampleCount).toFixed(4)) : null
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
