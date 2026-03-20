import { existsSync } from "node:fs";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import mime from "mime-types";
import {
  activitySearchSchema,
  appendActivitySchema,
  appendRelationUsageEventSchema,
  appendSearchFeedbackSchema,
  attachArtifactSchema,
  buildContextBundleSchema,
  captureMemorySchema,
  createWorkspaceSchema,
  createNodeSchema,
  createNodesSchema,
  createRelationSchema,
  governanceIssuesQuerySchema,
  nodeSearchSchema,
  openWorkspaceSchema,
  reindexInferredRelationsSchema,
  recomputeGovernanceSchema,
  recomputeInferredRelationsSchema,
  relationTypes,
  registerIntegrationSchema,
  sourceSchema,
  upsertInferredRelationSchema,
  updateIntegrationSchema,
  updateNodeSchema,
  updateRelationSchema,
  updateSettingsSchema,
  workspaceSearchSchema
} from "../shared/contracts.js";
import type { ApiEnvelope, ApiErrorEnvelope, InferredRelationRecord, NodeRecord } from "../shared/types.js";
import { AppError } from "./errors.js";
import {
  isShortLogLikeAgentNodeInput,
  maybeCreatePromotionCandidate,
  recomputeAutomaticGovernance,
  resolveGovernancePolicy,
  resolveNodeGovernance,
  resolveRelationStatus,
  shouldPromoteActivitySummary
} from "./governance.js";
import { refreshAutomaticInferredRelationsForNode, reindexAutomaticInferredRelations } from "./inferred-relations.js";
import { createObservabilityWriter, summarizePayloadShape } from "./observability.js";
import {
  buildSemanticCandidateBonusMap,
  buildCandidateRelationBonusMap,
  buildContextBundle,
  buildNeighborhoodItems,
  buildTargetRelatedRetrievalItems,
  bundleAsMarkdown,
  computeRankCandidateScore,
  shouldUseSemanticCandidateAugmentation
} from "./retrieval.js";
import { createId, isPathWithinRoot } from "./utils.js";
import type { WorkspaceSessionManager } from "./workspace-session.js";

const relationTypeSet = new Set<string>(relationTypes);
const allowedLoopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const isDesktopManagedApi = process.env.ELECTRON_RUN_AS_NODE === "1";
const updateNodeRequestSchema = updateNodeSchema.extend({
  source: sourceSchema
});
const defaultCaptureSource = {
  actorType: "system" as const,
  actorLabel: "Memforge API",
  toolName: "memforge-api"
};

function parseRelationTypesQuery(value: unknown) {
  const items = parseCommaSeparatedValues(value)?.filter((item): item is (typeof relationTypes)[number] => relationTypeSet.has(item));

  return items?.length ? items : undefined;
}

function isAllowedBrowserOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && allowedLoopbackHostnames.has(url.hostname);
  } catch {
    return false;
  }
}

type SemanticIssueStatus = "pending" | "stale" | "failed";

function parseCommaSeparatedValues(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length ? items : undefined;
}

function parseClampedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numericValue =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(numericValue), min), max);
}

function parseSemanticIssueStatuses(value: unknown): SemanticIssueStatus[] | undefined {
  const statuses = parseCommaSeparatedValues(value)?.filter(
    (status): status is SemanticIssueStatus => status === "pending" || status === "stale" || status === "failed"
  );
  return statuses?.length ? statuses : undefined;
}

function readRequestParam(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : "";
  }

  return "";
}

function normalizeArtifactRelativePath(value: string): string {
  const withForwardSlashes = value
    .replace(/^\//, "")
    .replace(/[\\/]+/g, "/");
  const normalized = path.posix.normalize(withForwardSlashes);
  return normalized === "." ? "" : normalized;
}

function readBearerToken(request: Request): string | null {
  const header = request.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

function deriveCaptureTitle(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Captured note";
  }

  const firstSentence = normalized.match(/^(.{1,80}?[.!?])(?:\s|$)/)?.[1]?.trim();
  if (firstSentence) {
    return firstSentence;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77).trimEnd()}...` : normalized;
}

type AutoRecomputeConfig = {
  enabled: boolean;
  eventThreshold: number;
  debounceMs: number;
  maxStalenessMs: number;
  batchLimit: number;
  lastRunAt: string | null;
};

type AutoRecomputeState = {
  workspaceRoot: string | null;
  pendingRelationIds: Set<string>;
  pendingEventCount: number;
  earliestPendingEventAt: string | null;
  latestPendingEventAt: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
};

type AutoRecomputeStatus = {
  enabled: boolean;
  eventThreshold: number;
  debounceMs: number;
  maxStalenessMs: number;
  batchLimit: number;
  lastRunAt: string | null;
  pendingEventCount: number;
  pendingRelationCount: number;
  earliestPendingEventAt: string | null;
  latestPendingEventAt: string | null;
  running: boolean;
};

type InferredRefreshTrigger = "node-write" | "activity-append";

type AutoRefreshConfig = {
  enabled: boolean;
  debounceMs: number;
  maxStalenessMs: number;
  batchLimit: number;
};

type AutoRefreshState = {
  workspaceRoot: string | null;
  pendingNodeTriggers: Map<string, InferredRefreshTrigger>;
  earliestPendingAt: string | null;
  latestPendingAt: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
};

type AutoRefreshStatus = {
  enabled: boolean;
  debounceMs: number;
  maxStalenessMs: number;
  batchLimit: number;
  pendingNodeCount: number;
  earliestPendingAt: string | null;
  latestPendingAt: string | null;
  running: boolean;
};

type AutoSemanticIndexConfig = {
  enabled: boolean;
  debounceMs: number;
  batchLimit: number;
  lastRunAt: string | null;
};

type AutoSemanticIndexState = {
  workspaceRoot: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
};

type AutoSemanticIndexStatus = {
  enabled: boolean;
  debounceMs: number;
  batchLimit: number;
  lastRunAt: string | null;
  running: boolean;
};

function parseBooleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseNumberSetting(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeApiRequestPath(value: string): string {
  return value
    .replace(/^\/artifacts\/.+$/g, "/artifacts/:path")
    .replace(/\/nodes\/[^/]+\/neighborhood/g, "/nodes/:id/neighborhood")
    .replace(/\/nodes\/[^/]+\/activities/g, "/nodes/:id/activities")
    .replace(/\/nodes\/[^/]+\/artifacts/g, "/nodes/:id/artifacts")
    .replace(/\/nodes\/[^/]+/g, "/nodes/:id")
    .replace(/\/semantic\/reindex\/[^/]+/g, "/semantic/reindex/:nodeId")
    .replace(/\/governance\/state\/[^/]+\/[^/]+/g, "/governance/state/:entityType/:id");
}

function envelope<T>(requestId: string, data: T): ApiEnvelope<T> {
  return {
    ok: true,
    data,
    meta: {
      requestId,
      apiVersion: "v1"
    }
  };
}

function toBatchErrorPayload(error: AppError) {
  return {
    code: error.code,
    message: error.message,
    details: error.details
  };
}

function errorEnvelope(requestId: string, error: AppError): ApiErrorEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details
    },
    meta: {
      requestId,
      apiVersion: "v1"
    }
  };
}

function buildServiceIndex(workspaceInfo: {
  rootPath: string;
  workspaceName: string;
  schemaVersion: number;
  bindAddress: string;
  enabledIntegrationModes: string[];
  authMode: string;
}) {
  return {
    service: {
      name: "Memforge",
      description: "Local-first personal knowledge layer for humans and agents.",
      apiVersion: "v1",
      baseUrl: `http://${workspaceInfo.bindAddress}/api/v1`,
      authMode: workspaceInfo.authMode,
      workspaceName: workspaceInfo.workspaceName,
      workspaceRoot: workspaceInfo.rootPath
    },
    startHere: [
      {
        method: "GET",
        path: "/api/v1",
        purpose: "Discover service capabilities, important endpoints, and request examples."
      },
      {
        method: "GET",
        path: "/api/v1/health",
        purpose: "Check whether the running local Memforge service is healthy."
      },
      {
        method: "GET",
        path: "/api/v1/workspace",
        purpose: "Read the currently active workspace identity and configuration."
      },
      {
        method: "GET",
        path: "/api/v1/workspaces",
        purpose: "List known workspaces and the currently active one."
      }
    ],
    capabilities: [
      "search nodes by keyword and structured filters",
      "read node detail, related nodes, activities, artifacts, and governance summaries",
      "create nodes, relations, activities, capture entries, and artifacts with provenance",
      "upsert inferred relations and append relation usage signals for retrieval feedback",
      "append search-result usefulness feedback for future ranking and governance",
      "recompute automatic governance and inspect contested or low-confidence items",
      "recompute inferred relation scores in an explicit maintenance pass",
      "inspect semantic indexing status and queue bounded reindex passes",
      "build compact context bundles for coding/research/writing",
      "create or open workspaces without restarting the server"
    ],
    cli: {
      binary: "pnw",
      examples: [
        "pnw health --api http://127.0.0.1:8787/api/v1",
        "pnw search --api http://127.0.0.1:8787/api/v1 \"agent memory\"",
        "pnw search workspace --api http://127.0.0.1:8787/api/v1 \"cleanup\"",
        "pnw create --api http://127.0.0.1:8787/api/v1 --type note --title \"Idea\" --body \"...\"",
        "pnw context --api http://127.0.0.1:8787/api/v1 <node-id> --mode compact --preset for-coding",
        "pnw governance issues --api http://127.0.0.1:8787/api/v1",
        "pnw workspace list --api http://127.0.0.1:8787/api/v1",
        "pnw observability summary --api http://127.0.0.1:8787/api/v1 --since 24h"
      ]
    },
    mcp: {
      transport: "stdio",
      command: "node dist/server/app/mcp/index.js",
      env: {
        MEMFORGE_API_URL: `http://${workspaceInfo.bindAddress}/api/v1`,
        MEMFORGE_API_TOKEN: workspaceInfo.authMode === "bearer" ? "<set the active bearer token here>" : null
      },
      docs: "docs/mcp.md"
    },
    endpoints: [
      {
        method: "POST",
        path: "/api/v1/nodes/search",
        purpose: "Search nodes by keyword and filters.",
        requestExample: {
          query: "agent memory",
          filters: {},
          limit: 10,
          offset: 0,
          sort: "relevance"
        }
      },
      {
        method: "POST",
        path: "/api/v1/nodes",
        purpose: "Create a durable node.",
        requestExample: {
          type: "note",
          title: "Example note",
          body: "Shared memory for agents.",
          tags: [],
          source: {
            actorType: "agent",
            actorLabel: "Claude Code",
            toolName: "claude-code"
          },
          metadata: {}
        }
      },
      {
        method: "POST",
        path: "/api/v1/nodes/batch",
        purpose: "Create multiple durable nodes with per-item landing or error details.",
        requestExample: {
          nodes: [
            {
              type: "note",
              title: "Example note",
              body: "Shared memory for agents.",
              tags: [],
              source: {
                actorType: "agent",
                actorLabel: "Claude Code",
                toolName: "claude-code"
              },
              metadata: {}
            }
          ]
        }
      },
      {
        method: "POST",
        path: "/api/v1/capture",
        purpose: "Safely capture agent or system memory and let the server route it to activity or durable storage.",
        requestExample: {
          mode: "auto",
          body: "Finished the MCP validation fix and updated the tests.",
          metadata: {},
          source: {
            actorType: "agent",
            actorLabel: "Claude Code",
            toolName: "claude-code"
          }
        }
      },
      {
        method: "GET",
        path: "/api/v1/nodes/:id/neighborhood",
        purpose: "Fetch lightweight canonical plus inferred neighborhood items for a node."
      },
      {
        method: "POST",
        path: "/api/v1/nodes/:id/refresh-summary",
        purpose: "Refresh a node summary locally using the deterministic stableSummary helper."
      },
      {
        method: "POST",
        path: "/api/v1/relations",
        purpose: "Create a relation between two nodes.",
        requestExample: {
          fromNodeId: "node_...",
          toNodeId: "node_...",
          relationType: "supports",
          status: "suggested",
          source: {
            actorType: "agent",
            actorLabel: "Claude Code",
            toolName: "claude-code"
          },
          metadata: {}
        }
      },
      {
        method: "POST",
        path: "/api/v1/inferred-relations",
        purpose: "Upsert a lightweight inferred relation for retrieval and graph expansion."
      },
      {
        method: "POST",
        path: "/api/v1/relation-usage-events",
        purpose: "Append a lightweight usage signal for canonical or inferred relations."
      },
      {
        method: "POST",
        path: "/api/v1/search-feedback-events",
        purpose: "Append a usefulness signal for a search result after it helped or failed a task."
      },
      {
        method: "POST",
        path: "/api/v1/activities/search",
        purpose: "Search activities by keyword, provenance, target node, or time window."
      },
      {
        method: "POST",
        path: "/api/v1/search",
        purpose: "Search nodes, activities, or both through a single workspace-wide endpoint."
      },
      {
        method: "POST",
        path: "/api/v1/inferred-relations/recompute",
        purpose: "Run an explicit maintenance pass to refresh inferred relation scores from usage events."
      },
      {
        method: "POST",
        path: "/api/v1/inferred-relations/reindex",
        purpose: "Backfill deterministic inferred relations across the active workspace."
      },
      {
        method: "GET",
        path: "/api/v1/semantic/status",
        purpose: "Read semantic indexing provider settings and pending or stale queue counts."
      },
      {
        method: "GET",
        path: "/api/v1/semantic/issues?limit=5",
        purpose: "Read a capped list of pending, stale, or failed semantic indexing items and their reasons."
      },
      {
        method: "POST",
        path: "/api/v1/semantic/reindex",
        purpose: "Queue semantic reindexing for a bounded set of active workspace nodes.",
        requestExample: {
          limit: 250
        }
      },
      {
        method: "GET",
        path: "/api/v1/governance/issues?limit=20",
        purpose: "Read contested or low-confidence governance issues."
      },
      {
        method: "GET",
        path: "/api/v1/governance/state/node/:id",
        purpose: "Read the current automatic governance state for a node."
      },
      {
        method: "GET",
        path: "/api/v1/observability/summary?since=24h",
        purpose: "Read latency, error rate, fallback, and auto-job summaries from local telemetry logs."
      },
      {
        method: "GET",
        path: "/api/v1/observability/errors?since=24h&surface=mcp",
        purpose: "Inspect recent telemetry errors for the API, MCP bridge, or desktop shell."
      },
      {
        method: "POST",
        path: "/api/v1/governance/recompute",
        purpose: "Run a bounded automatic governance recompute pass."
      },
      {
        method: "POST",
        path: "/api/v1/context/bundles",
        purpose: "Build compact context bundles for downstream agents.",
        requestExample: {
          target: {
            id: "node_..."
          },
          mode: "compact",
          preset: "for-coding",
          options: {
            includeRelated: true,
            includeRecentActivities: true,
            includeDecisions: true,
            includeOpenQuestions: true,
            maxItems: 12
          }
        }
      },
      {
        method: "POST",
        path: "/api/v1/workspaces",
        purpose: "Create and switch to a new workspace at runtime.",
        requestExample: {
          rootPath: "/Users/name/Documents/Memforge-Work",
          workspaceName: "Work"
        }
      },
      {
        method: "POST",
        path: "/api/v1/workspaces/open",
        purpose: "Switch the running service to another existing workspace.",
        requestExample: {
          rootPath: "/Users/name/Documents/Memforge-Personal"
        }
      }
    ],
    references: {
      readme: "README.md",
      cliGuide: "app/cli/README.md",
      fullApiContract: "docs/api.md"
    },
    notes: [
      "Do not expect GET search endpoints. Search is POST-based for nodes, activities, and workspace-wide queries.",
      "Reuse the existing running local service instead of starting a second instance when possible.",
      "All durable writes should include a source object for provenance.",
      "Semantic reindex endpoints only queue work. They do not generate embeddings inline on the write path."
    ]
  };
}

export function createMemforgeApp(params: {
  workspaceSessionManager: WorkspaceSessionManager;
  apiToken: string | null;
}) {
  const app = express();
  app.use((request, _response, next) => {
    const origin = request.header("origin");
    if (origin && !isAllowedBrowserOrigin(origin)) {
      next(new AppError(403, "FORBIDDEN", "Browser origin is not allowed."));
      return;
    }
    next();
  });
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          callback(null, false);
          return;
        }
        callback(null, isAllowedBrowserOrigin(origin) ? origin : false);
      }
    })
  );
  const currentSession = () => params.workspaceSessionManager.getCurrent();
  const currentRepository = () => currentSession().repository;
  const currentWorkspaceInfo = () => currentSession().workspaceInfo;
  const currentWorkspaceRoot = () => currentSession().workspaceRoot;
  const currentObservabilityConfig = () => {
    const settings = currentRepository().getSettings([
      "observability.enabled",
      "observability.retentionDays",
      "observability.slowRequestMs",
      "observability.capturePayloadShape"
    ]);

    return {
      enabled: isDesktopManagedApi ? parseBooleanSetting(settings["observability.enabled"], false) : true,
      workspaceRoot: currentWorkspaceRoot(),
      workspaceName: currentWorkspaceInfo().workspaceName,
      retentionDays: Math.max(1, parseNumberSetting(settings["observability.retentionDays"], 14)),
      slowRequestMs: Math.max(1, parseNumberSetting(settings["observability.slowRequestMs"], 250)),
      capturePayloadShape: parseBooleanSetting(settings["observability.capturePayloadShape"], true)
    };
  };
  const observability = createObservabilityWriter({
    getState: currentObservabilityConfig
  });

  async function runObservedSpan<T>(
    operation: string,
    details: Record<string, unknown> | undefined,
    callback: (span: ReturnType<typeof observability.startSpan>) => Promise<T> | T
  ): Promise<T> {
    const span = observability.startSpan({
      surface: "api",
      operation,
      details
    });

    try {
      const result = await span.run(() => callback(span));
      await span.finish({ outcome: "success" });
      return result;
    } catch (error) {
      const appError =
        error instanceof AppError
          ? {
              statusCode: error.statusCode,
              errorCode: error.code,
              errorKind: "app_error" as const
            }
          : error instanceof Error && "issues" in error
            ? {
                statusCode: 400,
                errorCode: "INVALID_INPUT",
                errorKind: "validation_error" as const
              }
            : {
                statusCode: 500,
                errorCode: "INTERNAL_ERROR",
                errorKind: "unexpected_error" as const
              };
      await span.finish({
        outcome: "error",
        statusCode: appError.statusCode,
        errorCode: appError.errorCode,
        errorKind: appError.errorKind
      });
      throw error;
    }
  }

  function handleAsyncRoute(
    handler: (request: Request, response: Response, next: NextFunction) => Promise<void>
  ) {
    return (request: Request, response: Response, next: NextFunction) => {
      void handler(request, response, next).catch(next);
    };
  }
  const eventSubscribers = new Set<Response>();
  const autoRecomputeState: AutoRecomputeState = {
    workspaceRoot: null,
    pendingRelationIds: new Set<string>(),
    pendingEventCount: 0,
    earliestPendingEventAt: null,
    latestPendingEventAt: null,
    timer: null,
    running: false
  };
  const autoRefreshState: AutoRefreshState = {
    workspaceRoot: null,
    pendingNodeTriggers: new Map(),
    earliestPendingAt: null,
    latestPendingAt: null,
    timer: null,
    running: false
  };
  const autoSemanticIndexState: AutoSemanticIndexState = {
    workspaceRoot: null,
    timer: null,
    running: false
  };

  function clearAutoRecomputeTimer() {
    if (autoRecomputeState.timer) {
      clearTimeout(autoRecomputeState.timer);
      autoRecomputeState.timer = null;
    }
  }

  function clearAutoRefreshTimer() {
    if (autoRefreshState.timer) {
      clearTimeout(autoRefreshState.timer);
      autoRefreshState.timer = null;
    }
  }

  function clearAutoSemanticIndexTimer() {
    if (autoSemanticIndexState.timer) {
      clearTimeout(autoSemanticIndexState.timer);
      autoSemanticIndexState.timer = null;
    }
  }

  function resetAutoRecomputeState(workspaceRoot: string) {
    clearAutoRecomputeTimer();
    autoRecomputeState.workspaceRoot = workspaceRoot;
    autoRecomputeState.pendingRelationIds = new Set();
    autoRecomputeState.pendingEventCount = 0;
    autoRecomputeState.earliestPendingEventAt = null;
    autoRecomputeState.latestPendingEventAt = null;
    autoRecomputeState.running = false;
  }

  function resetAutoRefreshState(workspaceRoot: string) {
    clearAutoRefreshTimer();
    autoRefreshState.workspaceRoot = workspaceRoot;
    autoRefreshState.pendingNodeTriggers = new Map();
    autoRefreshState.earliestPendingAt = null;
    autoRefreshState.latestPendingAt = null;
    autoRefreshState.running = false;
  }

  function resetAutoSemanticIndexState(workspaceRoot: string) {
    clearAutoSemanticIndexTimer();
    autoSemanticIndexState.workspaceRoot = workspaceRoot;
    autoSemanticIndexState.running = false;
  }

  function readAutoRecomputeConfig(): AutoRecomputeConfig {
    const settings = currentRepository().getSettings([
      "relations.autoRecompute.enabled",
      "relations.autoRecompute.eventThreshold",
      "relations.autoRecompute.debounceMs",
      "relations.autoRecompute.maxStalenessMs",
      "relations.autoRecompute.batchLimit",
      "relations.autoRecompute.lastRunAt"
    ]);
    return {
      enabled: parseBooleanSetting(settings["relations.autoRecompute.enabled"], true),
      eventThreshold: parseNumberSetting(settings["relations.autoRecompute.eventThreshold"], 12),
      debounceMs: parseNumberSetting(settings["relations.autoRecompute.debounceMs"], 30_000),
      maxStalenessMs: parseNumberSetting(settings["relations.autoRecompute.maxStalenessMs"], 300_000),
      batchLimit: parseNumberSetting(settings["relations.autoRecompute.batchLimit"], 100),
      lastRunAt: typeof settings["relations.autoRecompute.lastRunAt"] === "string"
        ? String(settings["relations.autoRecompute.lastRunAt"])
        : null
    };
  }

  function readAutoRefreshConfig(): AutoRefreshConfig {
    const settings = currentRepository().getSettings([
      "relations.autoRefresh.enabled",
      "relations.autoRefresh.debounceMs",
      "relations.autoRefresh.maxStalenessMs",
      "relations.autoRefresh.batchLimit"
    ]);
    return {
      enabled: parseBooleanSetting(settings["relations.autoRefresh.enabled"], true),
      debounceMs: parseNumberSetting(settings["relations.autoRefresh.debounceMs"], 150),
      maxStalenessMs: parseNumberSetting(settings["relations.autoRefresh.maxStalenessMs"], 2_000),
      batchLimit: parseNumberSetting(settings["relations.autoRefresh.batchLimit"], 24)
    };
  }

  function readAutoSemanticIndexConfig(): AutoSemanticIndexConfig {
    const settings = currentRepository().getSettings([
      "search.semantic.autoIndex.enabled",
      "search.semantic.autoIndex.debounceMs",
      "search.semantic.autoIndex.batchLimit",
      "search.semantic.autoIndex.lastRunAt"
    ]);
    return {
      enabled: parseBooleanSetting(settings["search.semantic.autoIndex.enabled"], true),
      debounceMs: Math.max(100, parseNumberSetting(settings["search.semantic.autoIndex.debounceMs"], 1_500)),
      batchLimit: Math.max(1, parseNumberSetting(settings["search.semantic.autoIndex.batchLimit"], 20)),
      lastRunAt:
        typeof settings["search.semantic.autoIndex.lastRunAt"] === "string"
          ? String(settings["search.semantic.autoIndex.lastRunAt"])
          : null
    };
  }

  function buildAutoRecomputeStatus(): AutoRecomputeStatus {
    const config = readAutoRecomputeConfig();
    return {
      enabled: config.enabled,
      eventThreshold: config.eventThreshold,
      debounceMs: config.debounceMs,
      maxStalenessMs: config.maxStalenessMs,
      batchLimit: config.batchLimit,
      lastRunAt: config.lastRunAt,
      pendingEventCount: autoRecomputeState.pendingEventCount,
      pendingRelationCount: autoRecomputeState.pendingRelationIds.size,
      earliestPendingEventAt: autoRecomputeState.earliestPendingEventAt,
      latestPendingEventAt: autoRecomputeState.latestPendingEventAt,
      running: autoRecomputeState.running
    };
  }

  function buildAutoRefreshStatus(): AutoRefreshStatus {
    const config = readAutoRefreshConfig();
    return {
      enabled: config.enabled,
      debounceMs: config.debounceMs,
      maxStalenessMs: config.maxStalenessMs,
      batchLimit: config.batchLimit,
      pendingNodeCount: autoRefreshState.pendingNodeTriggers.size,
      earliestPendingAt: autoRefreshState.earliestPendingAt,
      latestPendingAt: autoRefreshState.latestPendingAt,
      running: autoRefreshState.running
    };
  }

  function buildAutoSemanticIndexStatus(): AutoSemanticIndexStatus {
    const config = readAutoSemanticIndexConfig();
    return {
      enabled: config.enabled,
      debounceMs: config.debounceMs,
      batchLimit: config.batchLimit,
      lastRunAt: config.lastRunAt,
      running: autoSemanticIndexState.running
    };
  }

  function markPendingRelationUsage(params: { relationId: string; createdAt: string }) {
    const workspaceRoot = currentWorkspaceRoot();
    if (autoRecomputeState.workspaceRoot !== workspaceRoot) {
      resetAutoRecomputeState(workspaceRoot);
    }
    autoRecomputeState.pendingRelationIds.add(params.relationId);
    autoRecomputeState.pendingEventCount += 1;
    if (!autoRecomputeState.earliestPendingEventAt || params.createdAt < autoRecomputeState.earliestPendingEventAt) {
      autoRecomputeState.earliestPendingEventAt = params.createdAt;
    }
    if (!autoRecomputeState.latestPendingEventAt || params.createdAt > autoRecomputeState.latestPendingEventAt) {
      autoRecomputeState.latestPendingEventAt = params.createdAt;
    }
  }

  function mergeRefreshTrigger(
    current: InferredRefreshTrigger | undefined,
    next: InferredRefreshTrigger
  ): InferredRefreshTrigger {
    if (current === "activity-append" || next === "activity-append") {
      return "activity-append";
    }
    return "node-write";
  }

  function markPendingInferredRefresh(nodeId: string, trigger: InferredRefreshTrigger) {
    const workspaceRoot = currentWorkspaceRoot();
    if (autoRefreshState.workspaceRoot !== workspaceRoot) {
      resetAutoRefreshState(workspaceRoot);
    }

    const now = new Date().toISOString();
    autoRefreshState.pendingNodeTriggers.set(nodeId, mergeRefreshTrigger(autoRefreshState.pendingNodeTriggers.get(nodeId), trigger));
    if (!autoRefreshState.earliestPendingAt || now < autoRefreshState.earliestPendingAt) {
      autoRefreshState.earliestPendingAt = now;
    }
    if (!autoRefreshState.latestPendingAt || now > autoRefreshState.latestPendingAt) {
      autoRefreshState.latestPendingAt = now;
    }
  }

  function scheduleAutoRecompute() {
    const config = readAutoRecomputeConfig();
    clearAutoRecomputeTimer();

    if (!config.enabled || autoRecomputeState.running || autoRecomputeState.pendingEventCount === 0) {
      return;
    }

    const now = Date.now();
    const latestMs = autoRecomputeState.latestPendingEventAt ? Date.parse(autoRecomputeState.latestPendingEventAt) : null;
    const earliestMs = autoRecomputeState.earliestPendingEventAt ? Date.parse(autoRecomputeState.earliestPendingEventAt) : null;
    const thresholdReached = autoRecomputeState.pendingEventCount >= config.eventThreshold;
    const dueDebounceMs = thresholdReached && latestMs ? Math.max(0, latestMs + config.debounceMs - now) : Number.POSITIVE_INFINITY;
    const dueStalenessMs = earliestMs ? Math.max(0, earliestMs + config.maxStalenessMs - now) : Number.POSITIVE_INFINITY;
    const nextDelayMs = Math.min(dueDebounceMs, dueStalenessMs);

    if (!Number.isFinite(nextDelayMs)) {
      return;
    }

    autoRecomputeState.timer = setTimeout(() => {
      void runAutoRecompute("auto");
    }, nextDelayMs);
    autoRecomputeState.timer.unref?.();
  }

  function scheduleAutoRefresh() {
    const config = readAutoRefreshConfig();
    clearAutoRefreshTimer();

    if (!config.enabled || autoRefreshState.running || autoRefreshState.pendingNodeTriggers.size === 0) {
      return;
    }

    const now = Date.now();
    const latestMs = autoRefreshState.latestPendingAt ? Date.parse(autoRefreshState.latestPendingAt) : null;
    const earliestMs = autoRefreshState.earliestPendingAt ? Date.parse(autoRefreshState.earliestPendingAt) : null;
    const dueDebounceMs = latestMs ? Math.max(0, latestMs + config.debounceMs - now) : Number.POSITIVE_INFINITY;
    const dueStalenessMs = earliestMs ? Math.max(0, earliestMs + config.maxStalenessMs - now) : Number.POSITIVE_INFINITY;
    const nextDelayMs = Math.min(dueDebounceMs, dueStalenessMs);

    if (!Number.isFinite(nextDelayMs)) {
      return;
    }

    autoRefreshState.timer = setTimeout(() => {
      void runAutoRefresh();
    }, nextDelayMs);
    autoRefreshState.timer.unref?.();
  }

  function scheduleAutoSemanticIndex() {
    const config = readAutoSemanticIndexConfig();
    clearAutoSemanticIndexTimer();

    const semanticStatus = currentRepository().getSemanticStatus();
    const pendingCount = semanticStatus.counts.pending + semanticStatus.counts.stale;
    const workerActive = semanticStatus.enabled || semanticStatus.chunkEnabled;
    if (!config.enabled || !workerActive || autoSemanticIndexState.running || pendingCount === 0) {
      return;
    }

    autoSemanticIndexState.timer = setTimeout(() => {
      void runAutoSemanticIndex();
    }, config.debounceMs);
    autoSemanticIndexState.timer.unref?.();
  }

  function hydrateAutoRecomputeState() {
    const workspaceRoot = currentWorkspaceRoot();
    if (autoRecomputeState.workspaceRoot !== workspaceRoot) {
      resetAutoRecomputeState(workspaceRoot);
    }

    const config = readAutoRecomputeConfig();
    if (!config.enabled) {
      clearAutoRecomputeTimer();
      autoRecomputeState.pendingRelationIds.clear();
      autoRecomputeState.pendingEventCount = 0;
      autoRecomputeState.earliestPendingEventAt = null;
      autoRecomputeState.latestPendingEventAt = null;
      return;
    }

    const pending = currentRepository().getPendingRelationUsageStats(config.lastRunAt);
    autoRecomputeState.pendingRelationIds = new Set(pending.relationIds);
    autoRecomputeState.pendingEventCount = pending.eventCount;
    autoRecomputeState.earliestPendingEventAt = pending.earliestEventAt;
    autoRecomputeState.latestPendingEventAt = pending.latestEventAt;
    scheduleAutoRecompute();
  }

  function hydrateAutoRefreshState() {
    const workspaceRoot = currentWorkspaceRoot();
    if (autoRefreshState.workspaceRoot !== workspaceRoot) {
      resetAutoRefreshState(workspaceRoot);
    }

    const config = readAutoRefreshConfig();
    if (!config.enabled) {
      clearAutoRefreshTimer();
      autoRefreshState.pendingNodeTriggers.clear();
      autoRefreshState.earliestPendingAt = null;
      autoRefreshState.latestPendingAt = null;
      return;
    }

    scheduleAutoRefresh();
  }

  function hydrateAutoSemanticIndexState() {
    const workspaceRoot = currentWorkspaceRoot();
    if (autoSemanticIndexState.workspaceRoot !== workspaceRoot) {
      resetAutoSemanticIndexState(workspaceRoot);
    }

    const config = readAutoSemanticIndexConfig();
    if (!config.enabled) {
      clearAutoSemanticIndexTimer();
      return;
    }

    scheduleAutoSemanticIndex();
  }

  async function runAutoRecompute(reason: "auto" | "manual") {
    if (autoRecomputeState.running) {
      return;
    }

    const config = readAutoRecomputeConfig();
    if (!config.enabled && reason === "auto") {
      return;
    }

    clearAutoRecomputeTimer();
    autoRecomputeState.running = true;
    const startedAt = new Date().toISOString();

    try {
      return await runObservedSpan(
        "auto.recompute_inferred_relations",
        {
          trigger: reason,
          batchLimit: config.batchLimit
        },
        (span) => {
          const pending = currentRepository().getPendingRelationUsageStats(config.lastRunAt);
          const aggregate = {
            updatedCount: 0,
            expiredCount: 0,
            items: [] as InferredRelationRecord[]
          };

          const appendResult = (result: { updatedCount: number; expiredCount: number; items: typeof aggregate.items }) => {
            aggregate.updatedCount += result.updatedCount;
            aggregate.expiredCount += result.expiredCount;
            aggregate.items.push(...result.items);
          };

          if (reason === "manual" && pending.relationIds.length === 0) {
            const totalRelations = currentRepository().countInferredRelations("active");
            if (totalRelations === 0) {
              currentRepository().setSetting("relations.autoRecompute.lastRunAt", startedAt);
              span.addDetails({
                pendingRelationCount: 0,
                processedRelationCount: 0,
                batchCount: 0
              });
              return aggregate;
            }

            const totalBatches = Math.ceil(totalRelations / config.batchLimit);
            for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
              appendResult(
                currentRepository().recomputeInferredRelationScores({
                  limit: config.batchLimit
                })
              );
            }

            currentRepository().setSetting("relations.autoRecompute.lastRunAt", startedAt);
            broadcastWorkspaceEvent({
              reason: "inferred-relation.recomputed",
              entityType: "relation"
            });
            span.addDetails({
              pendingRelationCount: totalRelations,
              processedRelationCount: aggregate.items.length,
              batchCount: totalBatches
            });
            return aggregate;
          }

          if (pending.relationIds.length === 0) {
            currentRepository().setSetting("relations.autoRecompute.lastRunAt", startedAt);
            span.addDetails({
              pendingRelationCount: 0,
              processedRelationCount: 0,
              batchCount: 0
            });
            return aggregate;
          }

          for (let index = 0; index < pending.relationIds.length; index += config.batchLimit) {
            appendResult(
              currentRepository().recomputeInferredRelationScores({
                relationIds: pending.relationIds.slice(index, index + config.batchLimit),
                limit: config.batchLimit
              })
            );
          }

          currentRepository().setSetting("relations.autoRecompute.lastRunAt", startedAt);
          broadcastWorkspaceEvent({
            reason: reason === "auto" ? "inferred-relation.auto-recomputed" : "inferred-relation.recomputed",
            entityType: "relation"
          });
          span.addDetails({
            pendingRelationCount: pending.relationIds.length,
            processedRelationCount: aggregate.items.length,
            batchCount: Math.ceil(pending.relationIds.length / config.batchLimit)
          });
          return aggregate;
        }
      );
    } finally {
      autoRecomputeState.running = false;
      hydrateAutoRecomputeState();
    }
  }

  async function runAutoRefresh() {
    if (autoRefreshState.running) {
      return;
    }

    const config = readAutoRefreshConfig();
    if (!config.enabled || autoRefreshState.pendingNodeTriggers.size === 0) {
      return;
    }

    clearAutoRefreshTimer();
    autoRefreshState.running = true;

    try {
      await runObservedSpan(
        "auto.refresh_inferred_relations",
        {
          batchLimit: config.batchLimit
        },
        (span) => {
          const batch = Array.from(autoRefreshState.pendingNodeTriggers.entries()).slice(0, config.batchLimit);
          for (const [nodeId] of batch) {
            autoRefreshState.pendingNodeTriggers.delete(nodeId);
          }

          if (autoRefreshState.pendingNodeTriggers.size === 0) {
            autoRefreshState.earliestPendingAt = null;
            autoRefreshState.latestPendingAt = null;
          }

          const repository = currentRepository();
          const touchedRelationIds = new Set<string>();
          let processedNodes = 0;

          for (const [nodeId, trigger] of batch) {
            try {
              const result = refreshAutomaticInferredRelationsForNode(repository, nodeId, trigger);
              processedNodes += 1;
              for (const relationId of result.relationIds) {
                touchedRelationIds.add(relationId);
              }
            } catch (error) {
              console.error(`Failed to refresh inferred relations for node ${nodeId}`, error);
            }
          }

          if (processedNodes > 0) {
            broadcastWorkspaceEvent({
              reason: "inferred-relation.auto-refreshed",
              entityType: "relation"
            });
          }

          if (touchedRelationIds.size > 0) {
            scheduleAutoRecompute();
          }

          span.addDetails({
            batchSize: batch.length,
            processedNodes,
            touchedRelationCount: touchedRelationIds.size
          });
        }
      );
    } finally {
      autoRefreshState.running = false;
      hydrateAutoRefreshState();
    }
  }

  async function runAutoSemanticIndex() {
    if (autoSemanticIndexState.running) {
      return;
    }

    const config = readAutoSemanticIndexConfig();
    if (!config.enabled) {
      return;
    }

    clearAutoSemanticIndexTimer();
    autoSemanticIndexState.running = true;
    const startedAt = new Date().toISOString();
    let shouldHydrate = true;

    try {
      try {
        return await runObservedSpan(
          "auto.semantic_index",
          {
            batchLimit: config.batchLimit
          },
          async (span) => {
            const result = await currentRepository().processPendingSemanticIndex(config.batchLimit);
            currentRepository().setSetting("search.semantic.autoIndex.lastRunAt", startedAt);
            if (result.processedCount > 0) {
              broadcastWorkspaceEvent({
                reason: "semantic.auto-indexed",
                entityType: "settings"
              });
            }
            if (result.remainingCount > 0) {
              scheduleAutoSemanticIndex();
            }
            span.addDetails({
              batchSize: config.batchLimit,
              processedCount: result.processedCount,
              remainingCount: result.remainingCount
            });
            return result;
          }
        );
      } catch (error) {
        shouldHydrate = false;
        console.error("Failed to process semantic index backlog", error);
      }
    } finally {
      autoSemanticIndexState.running = false;
      if (shouldHydrate) {
        hydrateAutoSemanticIndexState();
      } else {
        clearAutoSemanticIndexTimer();
      }
    }
  }

  function queueInferredRefresh(nodeId: string, trigger: InferredRefreshTrigger) {
    markPendingInferredRefresh(nodeId, trigger);
    scheduleAutoRefresh();
  }

  function queueInferredRefreshForNodes(nodeIds: string[], trigger: InferredRefreshTrigger) {
    for (const nodeId of new Set(nodeIds)) {
      queueInferredRefresh(nodeId, trigger);
    }
  }

  function broadcastWorkspaceEvent(event: {
    reason: string;
    entityType?: "node" | "relation" | "activity" | "artifact" | "review" | "workspace" | "integration" | "settings";
    entityId?: string;
  }) {
    const payload = {
      type: "workspace.updated",
      workspaceRoot: currentWorkspaceRoot(),
      at: new Date().toISOString(),
      ...event
    };
    for (const subscriber of eventSubscribers) {
      try {
        subscriber.write(`event: workspace.updated\n`);
        subscriber.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        eventSubscribers.delete(subscriber);
      }
    }
  }

  function refreshWorkspaceState() {
    hydrateAutoRecomputeState();
    hydrateAutoRefreshState();
    hydrateAutoSemanticIndexState();
  }

  function buildWorkspaceMutationPayload(workspace: unknown) {
    return {
      workspace,
      current: currentWorkspaceInfo(),
      items: params.workspaceSessionManager.listWorkspaces()
    };
  }

  function commitWorkspaceMutation(response: Response, workspace: unknown, reason: string, statusCode = 200) {
    refreshWorkspaceState();
    broadcastWorkspaceEvent({
      reason,
      entityType: "workspace"
    });
    response.status(statusCode).json(envelope(response.locals.requestId, buildWorkspaceMutationPayload(workspace)));
  }

  function recomputeGovernanceForEntities(entityType: "node" | "relation", entityIds: string[]) {
    const repository = currentRepository();
    if (!entityIds.length) {
      return {
        updatedCount: 0,
        promotedCount: 0,
        contestedCount: 0,
        items: []
      };
    }
    return recomputeAutomaticGovernance(repository, {
      entityType,
      entityIds,
      limit: Math.max(entityIds.length, 1)
    });
  }

  function buildGovernancePayload(
    repository: ReturnType<typeof currentRepository>,
    entityType: "node" | "relation",
    entityId: string,
    preferredState?: ReturnType<typeof repository.getGovernanceStateNullable> | null
  ) {
    return {
      state: preferredState ?? repository.getGovernanceStateNullable(entityType, entityId),
      events: repository.listGovernanceEvents(entityType, entityId, 10)
    };
  }

  function buildLandingPayload(input: {
    storedAs: "node" | "relation" | "activity";
    canonicality?: string;
    status: string;
    governanceState: "healthy" | "low_confidence" | "contested" | null;
    reason: string;
  }) {
    return {
      storedAs: input.storedAs,
      canonicality: input.canonicality,
      status: input.status,
      governanceState: input.governanceState,
      reason: input.reason
    };
  }

  function createDurableNodeResponse(
    repository: ReturnType<typeof currentRepository>,
    input: typeof createNodeSchema._type
  ) {
    const governance = resolveNodeGovernance(
      input,
      resolveGovernancePolicy(repository.getSettings(["review.autoApproveLowRisk", "review.trustedSourceToolNames"]))
    );
    const node = repository.createNode({
      ...input,
      resolvedCanonicality: governance.canonicality,
      resolvedStatus: governance.status
    });
    repository.recordProvenance({
      entityType: "node",
      entityId: node.id,
      operationType: "create",
      source: input.source,
      metadata: {
        reason: governance.reason
      }
    });
    const governanceResult = recomputeGovernanceForEntities("node", [node.id]);
    queueInferredRefresh(node.id, "node-write");
    scheduleAutoSemanticIndex();
    broadcastWorkspaceEvent({
      reason: "node.created",
      entityType: "node",
      entityId: node.id
    });
    const storedNode = repository.getNode(node.id);
    const governancePayload = buildGovernancePayload(
      repository,
      "node",
      node.id,
      governanceResult.items[0] ?? repository.getGovernanceStateNullable("node", node.id)
    );
    return {
      node: storedNode,
      governance: governancePayload,
      landing: buildLandingPayload({
        storedAs: "node",
        canonicality: storedNode.canonicality,
        status: storedNode.status,
        governanceState: governancePayload.state?.state ?? null,
        reason: governance.reason
      })
    };
  }

  hydrateAutoRecomputeState();
  hydrateAutoRefreshState();
  hydrateAutoSemanticIndexState();

  app.use((request, response, next) => {
    const requestId = createId("req");
    const traceId = request.header("x-memforge-trace-id")?.trim() || createId("trace");
    const operation = `${request.method.toUpperCase()} ${normalizeApiRequestPath(request.path)}`;
    const observabilityState = currentObservabilityConfig();
    const requestSpan = observability.startSpan({
      surface: "api",
      operation,
      requestId,
      traceId,
      details: {
        ...(observabilityState.capturePayloadShape ? summarizePayloadShape(request.body) : {}),
        mcpTool: request.header("x-memforge-mcp-tool") ?? null
      }
    });

    response.locals.requestId = requestId;
    response.locals.traceId = traceId;
    response.locals.telemetryRequestSpan = requestSpan;
    response.setHeader("x-memforge-request-id", requestId);
    response.setHeader("x-memforge-trace-id", traceId);
    response.on("finish", () => {
      void requestSpan.finish({
        outcome: response.statusCode >= 400 ? "error" : "success",
        statusCode: response.statusCode,
        errorCode: response.locals.telemetryErrorCode ?? null,
        errorKind: response.locals.telemetryErrorKind ?? null
      });
    });

    observability.withContext(
      {
        traceId,
        requestId,
        workspaceRoot: currentWorkspaceRoot(),
        workspaceName: currentWorkspaceInfo().workspaceName,
        toolName: request.header("x-memforge-mcp-tool") ?? null,
        surface: "api"
      },
      next
    );
  });
  app.use(express.json({ limit: "2mb" }));

  app.use("/api/v1", (request, response, next) => {
    if (!params.apiToken) {
      next();
      return;
    }

    const origin = request.header("origin");
    const allowUnauthenticatedEventStream =
      request.method === "GET" && request.path === "/events" && Boolean(origin && isAllowedBrowserOrigin(origin));
    if (request.path === "/health" || request.path === "/workspace" || request.path === "/bootstrap" || allowUnauthenticatedEventStream) {
      next();
      return;
    }

    const providedToken = readBearerToken(request);
    if (providedToken !== params.apiToken) {
      next(new AppError(401, "UNAUTHORIZED", "Missing or invalid bearer token."));
      return;
    }

    next();
  });

  app.get("/api/v1/health", (_request, response) => {
    const workspaceInfo = currentWorkspaceInfo();
    response.json(
      envelope(response.locals.requestId, {
        status: "ok",
        workspaceLoaded: true,
        workspaceRoot: workspaceInfo.rootPath,
        schemaVersion: workspaceInfo.schemaVersion,
        autoRecompute: buildAutoRecomputeStatus(),
        autoRefresh: buildAutoRefreshStatus(),
        autoSemanticIndex: buildAutoSemanticIndexStatus(),
        semantic: currentRepository().getSemanticStatus()
      })
    );
  });

  app.get("/api/v1", (_request, response) => {
    response.json(envelope(response.locals.requestId, buildServiceIndex(currentWorkspaceInfo())));
  });

  app.get("/api/v1/workspace", (_request, response) => {
    response.json(envelope(response.locals.requestId, currentWorkspaceInfo()));
  });

  app.get("/api/v1/bootstrap", (_request, response) => {
    const workspaceInfo = currentWorkspaceInfo();
    response.json(
      envelope(response.locals.requestId, {
        workspace: workspaceInfo,
        authMode: workspaceInfo.authMode,
        autoRecompute: buildAutoRecomputeStatus(),
        autoRefresh: buildAutoRefreshStatus(),
        autoSemanticIndex: buildAutoSemanticIndexStatus(),
        semantic: currentRepository().getSemanticStatus()
      })
    );
  });

  app.get("/api/v1/semantic/status", (_request, response) => {
    response.json(envelope(response.locals.requestId, currentRepository().getSemanticStatus()));
  });

  app.get("/api/v1/semantic/issues", (request, response) => {
    const limit = parseClampedNumber(request.query.limit, 5, 1, 25);
    const cursor = typeof request.query.cursor === "string" && request.query.cursor.trim() ? request.query.cursor : null;
    const statuses = parseSemanticIssueStatuses(request.query.statuses);
    response.json(
      envelope(
        response.locals.requestId,
        currentRepository().listSemanticIssues({
          limit,
          cursor,
          statuses
        })
      )
    );
  });

  app.post("/api/v1/semantic/reindex", (request, response) => {
    const limit = parseClampedNumber(request.body?.limit, 250, 1, 1000);
    const result = currentRepository().queueSemanticReindex(limit);
    broadcastWorkspaceEvent({
      reason: "semantic.reindex_queued",
      entityType: "settings"
    });
    scheduleAutoSemanticIndex();
    response.json(envelope(response.locals.requestId, result));
  });

  app.post("/api/v1/semantic/reindex/:nodeId", (request, response) => {
    const node = currentRepository().queueSemanticReindexForNode(request.params.nodeId);
    broadcastWorkspaceEvent({
      reason: "semantic.node_reindex_queued",
      entityType: "node",
      entityId: node.id
    });
    scheduleAutoSemanticIndex();
    response.json(
      envelope(response.locals.requestId, {
        nodeId: node.id,
        queued: true
      })
    );
  });

  app.get("/api/v1/events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    response.write("retry: 3000\n");
    response.write(": connected\n\n");

    const heartbeatId = setInterval(() => {
      response.write(": keep-alive\n\n");
    }, 25000);

    eventSubscribers.add(response);

    request.on("close", () => {
      clearInterval(heartbeatId);
      eventSubscribers.delete(response);
    });
  });

  app.get("/api/v1/workspaces", (_request, response) => {
    response.json(
      envelope(response.locals.requestId, {
        current: currentWorkspaceInfo(),
        items: params.workspaceSessionManager.listWorkspaces()
      })
    );
  });

  app.post("/api/v1/workspaces", (request, response) => {
    const input = createWorkspaceSchema.parse(request.body ?? {});
    const workspace = params.workspaceSessionManager.createWorkspace(input.rootPath, input.workspaceName);
    commitWorkspaceMutation(response, workspace, "workspace.created", 201);
  });

  app.post("/api/v1/workspaces/open", (request, response) => {
    const input = openWorkspaceSchema.parse(request.body ?? {});
    const workspace = params.workspaceSessionManager.openWorkspace(input.rootPath);
    commitWorkspaceMutation(response, workspace, "workspace.opened");
  });

  app.get("/api/v1/observability/summary", handleAsyncRoute(async (request, response) => {
    const summary = await observability.summarize({
      since: readRequestParam(request.query.since),
      surface: "all"
    });
    response.json(envelope(response.locals.requestId, summary));
  }));

  app.get("/api/v1/observability/errors", handleAsyncRoute(async (request, response) => {
    const surface = readRequestParam(request.query.surface);
    const normalizedSurface = surface === "api" || surface === "mcp" || surface === "desktop" ? surface : "all";
    const errors = await observability.listErrors({
      since: readRequestParam(request.query.since),
      surface: normalizedSurface,
      limit: parseClampedNumber(request.query.limit, 50, 1, 200)
    });
    response.json(envelope(response.locals.requestId, errors));
  }));

  app.post("/api/v1/nodes/search", handleAsyncRoute(async (request, response) => {
    const input = nodeSearchSchema.parse(request.body ?? {});
    const result = await runObservedSpan(
      "nodes.search",
      {
        queryPresent: Boolean(input.query.trim()),
        limit: input.limit,
        offset: input.offset,
        sort: input.sort
      },
      (span) => {
        const searchResult = currentRepository().searchNodes(input);
        span.addDetails({
          resultCount: searchResult.items.length,
          totalCount: searchResult.total
        });
        return searchResult;
      }
    );
    response.json(envelope(response.locals.requestId, result));
  }));

  app.post("/api/v1/activities/search", handleAsyncRoute(async (request, response) => {
    const input = activitySearchSchema.parse(request.body ?? {});
    const result = await runObservedSpan(
      "activities.search",
      {
        queryPresent: Boolean(input.query.trim()),
        limit: input.limit,
        offset: input.offset,
        sort: input.sort
      },
      (span) => {
        const searchResult = currentRepository().searchActivities(input);
        span.addDetails({
          resultCount: searchResult.items.length,
          totalCount: searchResult.total
        });
        return searchResult;
      }
    );
    response.json(envelope(response.locals.requestId, result));
  }));

  app.post("/api/v1/search", handleAsyncRoute(async (request, response) => {
    const input = workspaceSearchSchema.parse(request.body ?? {});
    const result = await runObservedSpan(
      "workspace.search",
      {
        queryPresent: Boolean(input.query.trim()),
        limit: input.limit,
        offset: input.offset,
        sort: input.sort,
        scopes: input.scopes
      },
      (span) => {
        const searchResult = currentRepository().searchWorkspace(input);
        span.addDetails({
          resultCount: searchResult.items.length,
          totalCount: searchResult.total
        });
        return searchResult;
      }
    );
    response.json(envelope(response.locals.requestId, result));
  }));

  app.get("/api/v1/nodes/:id", (request, response) => {
    const repository = currentRepository();
    const node = repository.getNode(request.params.id);
    response.json(
      envelope(response.locals.requestId, {
        node,
        related: repository.listRelatedNodes(node.id),
        activities: repository.listNodeActivities(node.id, 10),
        artifacts: repository.listArtifacts(node.id),
        provenance: repository.listProvenance("node", node.id),
        governance: buildGovernancePayload(repository, "node", node.id)
      })
    );
  });

  app.post("/api/v1/nodes", (request, response) => {
    const repository = currentRepository();
    const input = createNodeSchema.parse(request.body ?? {});
    response.status(201).json(envelope(response.locals.requestId, createDurableNodeResponse(repository, input)));
  });

  app.post("/api/v1/nodes/batch", (request, response) => {
    const repository = currentRepository();
    const input = createNodesSchema.parse(request.body ?? {});
    const items = input.nodes.map((nodeInput, index) => {
      try {
        return {
          ok: true as const,
          index,
          ...createDurableNodeResponse(repository, nodeInput)
        };
      } catch (error) {
        if (error instanceof AppError) {
          return {
            ok: false as const,
            index,
            error: toBatchErrorPayload(error)
          };
        }
        throw error;
      }
    });
    const successCount = items.filter((item) => item.ok).length;
    const errorCount = items.length - successCount;
    response.status(errorCount > 0 ? 207 : 201).json(
      envelope(response.locals.requestId, {
        items,
        summary: {
          requestedCount: items.length,
          successCount,
          errorCount
        }
      })
    );
  });

  app.post("/api/v1/capture", (request, response) => {
    const repository = currentRepository();
    const input = captureMemorySchema.parse(request.body ?? {});
    const source = input.source ?? defaultCaptureSource;
    const title = input.title ?? deriveCaptureTitle(input.body);
    const baseNodeInput = {
      type: input.mode === "decision" ? "decision" : input.nodeType,
      title,
      body: input.body,
      summary: undefined,
      canonicality: undefined,
      status: undefined,
      tags: input.tags,
      source,
      metadata: input.metadata
    };
    const storedAsNode =
      input.mode === "node" ||
      input.mode === "decision" ||
      (input.mode === "auto" &&
        (baseNodeInput.type === "decision" ||
          Boolean(input.metadata.reusable || input.metadata.durable || input.metadata.promoteCandidate) ||
          !isShortLogLikeAgentNodeInput(baseNodeInput)));

    if (storedAsNode) {
      const governance = resolveNodeGovernance(
        baseNodeInput,
        resolveGovernancePolicy(repository.getSettings(["review.autoApproveLowRisk", "review.trustedSourceToolNames"]))
      );
      const node = repository.createNode({
        ...baseNodeInput,
        resolvedCanonicality: governance.canonicality,
        resolvedStatus: governance.status
      });
      repository.recordProvenance({
        entityType: "node",
        entityId: node.id,
        operationType: "create",
        source,
        metadata: {
          reason: governance.reason,
          captureMode: input.mode
        }
      });
      const governanceResult = recomputeGovernanceForEntities("node", [node.id]);
      queueInferredRefresh(node.id, "node-write");
      scheduleAutoSemanticIndex();
      broadcastWorkspaceEvent({
        reason: "node.created",
        entityType: "node",
        entityId: node.id
      });
      response.status(201).json(
        envelope(response.locals.requestId, (() => {
          const storedNode = repository.getNode(node.id);
          const governancePayload = buildGovernancePayload(
            repository,
            "node",
            node.id,
            governanceResult.items[0] ?? repository.getGovernanceStateNullable("node", node.id)
          );
          return {
            storedAs: "node",
            node: storedNode,
            governance: governancePayload,
            landing: buildLandingPayload({
              storedAs: "node",
              canonicality: storedNode.canonicality,
              status: storedNode.status,
              governanceState: governancePayload.state?.state ?? null,
              reason: governance.reason
            })
          };
        })())
      );
      return;
    }

    const targetNode = input.targetNodeId ? repository.getNode(input.targetNodeId) : repository.ensureWorkspaceInboxNode();
    const activity = repository.appendActivity({
      targetNodeId: targetNode.id,
      activityType: "agent_run_summary",
      body: input.body,
      source,
      metadata: {
        ...input.metadata,
        captureMode: input.mode,
        capturedTitle: title
      }
    });
    repository.recordProvenance({
      entityType: "activity",
      entityId: activity.id,
      operationType: "append",
      source,
      metadata: {
        captureMode: input.mode,
        targetNodeId: targetNode.id
      }
    });
    queueInferredRefresh(activity.targetNodeId, "activity-append");
    scheduleAutoSemanticIndex();
    broadcastWorkspaceEvent({
      reason: "activity.appended",
      entityType: "activity",
      entityId: activity.id
    });
    response.status(201).json(
      envelope(response.locals.requestId, {
        storedAs: "activity",
        activity,
        targetNode: repository.getNode(targetNode.id),
        governance: null,
        landing: buildLandingPayload({
          storedAs: "activity",
          status: "recorded",
          governanceState: null,
          reason:
            input.mode === "activity"
              ? "Capture was explicitly routed to the activity timeline."
              : "Short log-like capture was routed to the activity timeline."
        })
      })
    );
  });

  app.patch("/api/v1/nodes/:id", (request, response) => {
    const repository = currentRepository();
    const body = updateNodeRequestSchema.parse(request.body ?? {});
    const { source, ...input } = body;
    const node = repository.updateNode(request.params.id, input);
    repository.recordProvenance({
      entityType: "node",
      entityId: node.id,
      operationType: "update",
      source,
      metadata: {
        fields: Object.keys(input).filter((key) => key !== "source")
      }
    });
    const governanceResult = recomputeGovernanceForEntities("node", [node.id]);
    queueInferredRefresh(node.id, "node-write");
    scheduleAutoSemanticIndex();
    broadcastWorkspaceEvent({
      reason: "node.updated",
      entityType: "node",
      entityId: node.id
    });
    response.json(
      envelope(response.locals.requestId, {
        node: repository.getNode(node.id),
        governance: buildGovernancePayload(
          repository,
          "node",
          node.id,
          governanceResult.items[0] ?? repository.getGovernanceStateNullable("node", node.id)
        )
      })
    );
  });

  app.post("/api/v1/nodes/:id/refresh-summary", (request, response) => {
    const repository = currentRepository();
    const source = sourceSchema.parse(request.body?.source ?? request.body ?? {});
    const node = repository.refreshNodeSummary(request.params.id);
    repository.recordProvenance({
      entityType: "node",
      entityId: node.id,
      operationType: "update",
      source,
      metadata: {
        fields: ["summary"],
        reason: "summary.refreshed"
      }
    });
    const governanceResult = recomputeGovernanceForEntities("node", [node.id]);
    queueInferredRefresh(node.id, "node-write");
    scheduleAutoSemanticIndex();
    broadcastWorkspaceEvent({
      reason: "node.summary_refreshed",
      entityType: "node",
      entityId: node.id
    });
    response.json(
      envelope(response.locals.requestId, {
        node: repository.getNode(node.id),
        governance: buildGovernancePayload(
          repository,
          "node",
          node.id,
          governanceResult.items[0] ?? repository.getGovernanceStateNullable("node", node.id)
        )
      })
    );
  });

  app.post("/api/v1/nodes/:id/archive", (request, response) => {
    const repository = currentRepository();
    const source = sourceSchema.parse(request.body?.source ?? request.body ?? {});
    const node = repository.archiveNode(request.params.id);
    repository.recordProvenance({
      entityType: "node",
      entityId: node.id,
      operationType: "archive",
      source
    });
    const governanceResult = recomputeGovernanceForEntities("node", [node.id]);
    queueInferredRefresh(node.id, "node-write");
    scheduleAutoSemanticIndex();
    broadcastWorkspaceEvent({
      reason: "node.archived",
      entityType: "node",
      entityId: node.id
    });
    response.json(
      envelope(response.locals.requestId, {
        node: repository.getNode(node.id),
        governance: buildGovernancePayload(
          repository,
          "node",
          node.id,
          governanceResult.items[0] ?? repository.getGovernanceStateNullable("node", node.id)
        )
      })
    );
  });

  app.get("/api/v1/nodes/:id/related", (request, response) => {
    const depth = Number(request.query.depth ?? 1);
    if (depth !== 1) {
      throw new AppError(400, "INVALID_INPUT", "Only depth=1 is supported in the hot path.");
    }
    const types = parseRelationTypesQuery(request.query.types);
    const includeInferred =
      request.query.include_inferred === "1" ||
      request.query.include_inferred === "true" ||
      request.query.include_inferred === undefined;
    const maxInferred = parseClampedNumber(request.query.max_inferred, 4, 0, 10);
    const items = buildNeighborhoodItems(currentRepository(), request.params.id, {
      relationTypes: types,
      includeInferred,
      maxInferred
    });
    response.json(envelope(response.locals.requestId, { items }));
  });

  app.get("/api/v1/nodes/:id/neighborhood", handleAsyncRoute(async (request, response) => {
    const depth = Number(request.query.depth ?? 1);
    if (depth !== 1) {
      throw new AppError(400, "INVALID_INPUT", "Only depth=1 is supported in the hot path.");
    }
    const types = parseRelationTypesQuery(request.query.types);
    const includeInferred = request.query.include_inferred === "1" || request.query.include_inferred === "true" || request.query.include_inferred === undefined;
    const maxInferred = parseClampedNumber(request.query.max_inferred, 4, 0, 10);
    const items = await runObservedSpan(
      "nodes.neighborhood",
      {
        relationTypeCount: types?.length ?? 0,
        includeInferred,
        maxInferred
      },
      (span) => {
        const result = buildNeighborhoodItems(currentRepository(), readRequestParam(request.params.id), {
          relationTypes: types,
          includeInferred,
          maxInferred
        });
        span.addDetails({
          resultCount: result.length
        });
        return result;
      }
    );
    response.json(envelope(response.locals.requestId, { items }));
  }));

  app.post("/api/v1/relations", (request, response) => {
    const repository = currentRepository();
    const input = createRelationSchema.parse(request.body ?? {});
    const governance = resolveRelationStatus(
      input,
      resolveGovernancePolicy(repository.getSettings(["review.autoApproveLowRisk", "review.trustedSourceToolNames"]))
    );
    const relation = repository.createRelation({
      ...input,
      resolvedStatus: governance.status
    });
    repository.recordProvenance({
      entityType: "relation",
      entityId: relation.id,
      operationType: "create",
      source: input.source
    });
    const governanceResult = recomputeGovernanceForEntities("relation", [relation.id]);
    queueInferredRefreshForNodes([relation.fromNodeId, relation.toNodeId], "node-write");
    broadcastWorkspaceEvent({
      reason: "relation.created",
      entityType: "relation",
      entityId: relation.id
    });
    response.status(201).json(
      envelope(response.locals.requestId, (() => {
        const storedRelation = repository.getRelation(relation.id);
        const governancePayload = buildGovernancePayload(
          repository,
          "relation",
          relation.id,
          governanceResult.items[0] ?? repository.getGovernanceStateNullable("relation", relation.id)
        );
        return {
          relation: storedRelation,
          governance: governancePayload,
          landing: buildLandingPayload({
            storedAs: "relation",
            status: storedRelation.status,
            governanceState: governancePayload.state?.state ?? null,
            reason: governance.reason
          })
        };
      })())
    );
  });

  app.post("/api/v1/inferred-relations", (request, response) => {
    const relation = currentRepository().upsertInferredRelation(upsertInferredRelationSchema.parse(request.body ?? {}));
    broadcastWorkspaceEvent({
      reason: "inferred-relation.upserted",
      entityType: "relation",
      entityId: relation.id
    });
    response.status(201).json(envelope(response.locals.requestId, { relation }));
  });

  app.post("/api/v1/relation-usage-events", (request, response) => {
    const repository = currentRepository();
    const event = repository.appendRelationUsageEvent(appendRelationUsageEventSchema.parse(request.body ?? {}));
    markPendingRelationUsage({
      relationId: event.relationId,
      createdAt: event.createdAt
    });
    scheduleAutoRecompute();
    const governanceResult = recomputeGovernanceForEntities("relation", [event.relationId]);
    broadcastWorkspaceEvent({
      reason: "relation-usage.appended",
      entityType: "relation",
      entityId: event.relationId
    });
    response.status(201).json(
      envelope(response.locals.requestId, {
        event,
        governance: buildGovernancePayload(
          repository,
          "relation",
          event.relationId,
          governanceResult.items[0] ?? repository.getGovernanceStateNullable("relation", event.relationId)
        )
      })
    );
  });

  app.post("/api/v1/search-feedback-events", (request, response) => {
    const repository = currentRepository();
    const event = repository.appendSearchFeedbackEvent(appendSearchFeedbackSchema.parse(request.body ?? {}));
    const governanceResult =
      event.resultType === "node"
        ? recomputeGovernanceForEntities("node", [event.resultId])
        : { items: [] };
    broadcastWorkspaceEvent({
      reason: "search-feedback.appended",
      entityType: event.resultType === "activity" ? "activity" : "node",
      entityId: event.resultId
    });
    response.status(201).json(
      envelope(response.locals.requestId, {
        event,
        governance:
          event.resultType === "node"
            ? buildGovernancePayload(
                repository,
                "node",
                event.resultId,
                governanceResult.items[0] ?? repository.getGovernanceStateNullable("node", event.resultId)
              )
            : null
      })
    );
  });

  app.post("/api/v1/inferred-relations/recompute", handleAsyncRoute(async (request, response) => {
    const input = recomputeInferredRelationsSchema.parse(request.body ?? {});
    const isFullMaintenancePass = !input.generator && !input.relationIds?.length;
    if (isFullMaintenancePass) {
      const result = await runAutoRecompute("manual");
      response.json(envelope(response.locals.requestId, result));
      return;
    }

    const result = currentRepository().recomputeInferredRelationScores(input);
    broadcastWorkspaceEvent({
      reason: "inferred-relation.recomputed",
      entityType: "relation"
    });
    response.json(envelope(response.locals.requestId, result));
  }));

  app.post("/api/v1/inferred-relations/reindex", (request, response) => {
    const input = reindexInferredRelationsSchema.parse(request.body ?? {});
    const result = reindexAutomaticInferredRelations(currentRepository(), input);
    broadcastWorkspaceEvent({
      reason: "inferred-relation.reindexed",
      entityType: "relation"
    });
    response.json(envelope(response.locals.requestId, result));
  });

  app.patch("/api/v1/relations/:id", (request, response) => {
    const repository = currentRepository();
    const input = updateRelationSchema.parse(request.body ?? {});
    const relation = repository.updateRelationStatus(request.params.id, input.status);
    repository.recordProvenance({
      entityType: "relation",
      entityId: relation.id,
      operationType: input.status === "active" ? "approve" : input.status,
      source: input.source,
      metadata: input.metadata
    });
    const governanceResult = recomputeGovernanceForEntities("relation", [relation.id]);
    queueInferredRefreshForNodes([relation.fromNodeId, relation.toNodeId], "node-write");
    broadcastWorkspaceEvent({
      reason: "relation.updated",
      entityType: "relation",
      entityId: relation.id
    });
    response.json(
      envelope(response.locals.requestId, {
        relation: repository.getRelation(relation.id),
        governance: buildGovernancePayload(
          repository,
          "relation",
          relation.id,
          governanceResult.items[0] ?? repository.getGovernanceStateNullable("relation", relation.id)
        )
      })
    );
  });

  app.get("/api/v1/nodes/:id/activities", (request, response) => {
    const limit = Number(request.query.limit ?? 20);
    response.json(
      envelope(response.locals.requestId, {
        items: currentRepository().listNodeActivities(request.params.id, limit)
      })
    );
  });

  app.post("/api/v1/activities", (request, response) => {
    const repository = currentRepository();
    const input = appendActivitySchema.parse(request.body ?? {});
    const promotion = shouldPromoteActivitySummary(input) ? maybeCreatePromotionCandidate(repository, input) : {};
    const activity = repository.appendActivity(
      promotion.suggestedNodeId
        ? {
            ...input,
            body: `Durable agent summary promoted to suggested node ${promotion.suggestedNodeId} for automatic governance.`,
            metadata: {
              ...input.metadata,
              promotedToSuggested: true,
              promotedNodeId: promotion.suggestedNodeId,
              rawBodyStoredInActivity: false
            }
          }
        : input
    );
    repository.recordProvenance({
      entityType: "activity",
      entityId: activity.id,
      operationType: "append",
      source: input.source,
      metadata: {
        promotedToSuggested: Boolean(promotion.suggestedNodeId)
      }
    });
    const governanceResult = promotion.suggestedNodeId
      ? recomputeGovernanceForEntities("node", [promotion.suggestedNodeId])
      : { items: [] };
    queueInferredRefresh(activity.targetNodeId, "activity-append");
    scheduleAutoSemanticIndex();
    broadcastWorkspaceEvent({
      reason: "activity.appended",
      entityType: "activity",
      entityId: activity.id
    });
    response.status(201).json(
      envelope(response.locals.requestId, {
        activity,
        promotion,
        governance:
          promotion.suggestedNodeId && governanceResult.items[0]
            ? buildGovernancePayload(repository, "node", promotion.suggestedNodeId, governanceResult.items[0])
            : null
      })
    );
  });

  app.post("/api/v1/artifacts", (request, response) => {
    const repository = currentRepository();
    const input = attachArtifactSchema.parse(request.body ?? {});
    const artifact = repository.attachArtifact({
      ...input,
      metadata: input.metadata
    });
    repository.recordProvenance({
      entityType: "artifact",
      entityId: artifact.id,
      operationType: "attach",
      source: input.source
    });
    queueInferredRefresh(artifact.nodeId, "node-write");
    scheduleAutoSemanticIndex();
    broadcastWorkspaceEvent({
      reason: "artifact.attached",
      entityType: "artifact",
      entityId: artifact.id
    });
    response.status(201).json(envelope(response.locals.requestId, { artifact }));
  });

  app.get("/api/v1/nodes/:id/artifacts", (request, response) => {
    response.json(
      envelope(response.locals.requestId, {
        items: currentRepository().listArtifacts(request.params.id)
      })
    );
  });

  app.post("/api/v1/retrieval/node-summaries", (request, response) => {
    const nodeIds = Array.isArray(request.body?.nodeIds) ? request.body.nodeIds : [];
    const repository = currentRepository();
    const nodes: NodeRecord[] = nodeIds.map((nodeId: string) => repository.getNode(nodeId));
    const items = nodes.map((node) => ({
      id: node.id,
      title: node.title,
      summary: node.summary,
      type: node.type,
      updatedAt: node.updatedAt
    }));
    response.json(envelope(response.locals.requestId, { items }));
  });

  app.get("/api/v1/retrieval/activity-digest/:targetId", (request, response) => {
    const items = currentRepository()
      .listNodeActivities(request.params.targetId, 5)
      .map((activity) => `${activity.activityType}: ${activity.body ?? "No details"}`);
    response.json(envelope(response.locals.requestId, { items }));
  });

  app.get("/api/v1/retrieval/decisions/:targetId", (request, response) => {
    const repository = currentRepository();
    const items = buildTargetRelatedRetrievalItems(repository, readRequestParam(request.params.targetId), {
      types: ["decision"],
      status: ["active", "contested"]
    });
    response.json(envelope(response.locals.requestId, { items }));
  });

  app.get("/api/v1/retrieval/open-questions/:targetId", (request, response) => {
    const repository = currentRepository();
    const items = buildTargetRelatedRetrievalItems(repository, readRequestParam(request.params.targetId), {
      types: ["question"],
      status: ["active", "draft", "contested"]
    });
    response.json(envelope(response.locals.requestId, { items }));
  });

  app.post("/api/v1/retrieval/rank-candidates", handleAsyncRoute(async (request, response) => {
    const ranked = await runObservedSpan(
      "retrieval.rank_candidates",
      {
        candidateCount: Array.isArray(request.body?.candidateNodeIds) ? request.body.candidateNodeIds.length : 0,
        queryPresent: typeof request.body?.query === "string" && request.body.query.trim().length > 0
      },
      async (span) => {
        const repository = currentRepository();
        const query = typeof request.body?.query === "string" ? request.body.query : "";
        const candidateNodeIds: string[] = Array.isArray(request.body?.candidateNodeIds) ? request.body.candidateNodeIds : [];
        const preset = typeof request.body?.preset === "string" ? request.body.preset : "for-assistant";
        const targetNodeId = typeof request.body?.targetNodeId === "string" ? request.body.targetNodeId : null;
        const relationBonuses = targetNodeId ? buildCandidateRelationBonusMap(repository, targetNodeId, candidateNodeIds) : new Map();
        const candidates = candidateNodeIds.map((id: string) => repository.getNode(id));
        const semanticAugmentation = repository.getSemanticAugmentationSettings();
        const semanticEnabled = shouldUseSemanticCandidateAugmentation(query, candidates);
        const semanticBonuses = semanticEnabled
          ? buildSemanticCandidateBonusMap(await repository.rankSemanticCandidates(query, candidateNodeIds), semanticAugmentation)
          : new Map();
        const result = candidates
          .map((node) => {
            const relationRetrievalRank = relationBonuses.get(node.id)?.retrievalRank ?? 0;
            const semanticRetrievalRank = semanticBonuses.get(node.id)?.retrievalRank ?? 0;
            const rankingScore = computeRankCandidateScore(node, query, preset, relationRetrievalRank + semanticRetrievalRank);
            const relationReason = relationBonuses.get(node.id)?.reason ?? null;
            const semanticReason = semanticBonuses.get(node.id)?.reason ?? null;
            return {
              nodeId: node.id,
              score: rankingScore,
              retrievalRank: rankingScore,
              title: node.title,
              relationSource: relationBonuses.get(node.id)?.relationSource ?? null,
              relationType: relationBonuses.get(node.id)?.relationType ?? null,
              relationScore: relationBonuses.get(node.id)?.relationScore ?? null,
              semanticSimilarity: semanticBonuses.get(node.id)?.semanticSimilarity ?? null,
              reason: [relationReason, semanticReason].filter(Boolean).join("; ") || null
            };
          })
          .sort((left: { score: number }, right: { score: number }) => right.score - left.score);
        span.addDetails({
          resultCount: result.length,
          semanticUsed: semanticEnabled
        });
        return result;
      }
    );
    response.json(envelope(response.locals.requestId, { items: ranked }));
  }));

  app.post("/api/v1/context/bundles", handleAsyncRoute(async (request, response) => {
    const input = buildContextBundleSchema.parse(request.body ?? {});
    const bundle = await runObservedSpan(
      "context.bundle",
      {
        mode: input.mode,
        preset: input.preset,
        maxItems: input.options.maxItems,
        includeRelated: input.options.includeRelated
      },
      async (span) => {
        const result = await buildContextBundle(currentRepository(), input);
        span.addDetails({
          itemCount: result.items.length,
          activityDigestCount: result.activityDigest.length
        });
        return result;
      }
    );
    response.json(envelope(response.locals.requestId, { bundle }));
  }));

  app.post("/api/v1/context/bundles/preview", handleAsyncRoute(async (request, response) => {
    const input = buildContextBundleSchema.parse(request.body ?? {});
    const bundle = await buildContextBundle(currentRepository(), input);
    response.json(
      envelope(response.locals.requestId, {
        bundle,
        preview: bundleAsMarkdown(bundle)
      })
    );
  }));

  app.post("/api/v1/context/bundles/export", handleAsyncRoute(async (request, response) => {
    const input = buildContextBundleSchema.parse(request.body ?? {});
    const format = request.body?.format === "json" ? "json" : request.body?.format === "text" ? "text" : "markdown";
    const bundle = await buildContextBundle(currentRepository(), input);
    const output =
      format === "json"
        ? JSON.stringify(bundle, null, 2)
        : format === "text"
          ? bundle.items.map((item) => `${item.title ?? item.nodeId}: ${item.summary ?? "No summary"}`).join("\n")
          : bundleAsMarkdown(bundle);
    response.json(envelope(response.locals.requestId, { format, output, bundle }));
  }));

  app.get("/api/v1/governance/issues", (request, response) => {
    const states = parseCommaSeparatedValues(request.query.states)?.filter(
      (state): state is "healthy" | "low_confidence" | "contested" =>
        state === "healthy" || state === "low_confidence" || state === "contested"
    );
    const input = governanceIssuesQuerySchema.parse({
      states,
      limit: Number(request.query.limit ?? 20)
    });
    response.json(
      envelope(response.locals.requestId, {
        items: currentRepository().listGovernanceIssues(input.limit, input.states)
      })
    );
  });

  app.get("/api/v1/governance/state/:entityType/:id", (request, response) => {
    const entityType = readRequestParam(request.params.entityType);
    if (entityType !== "node" && entityType !== "relation") {
      throw new AppError(400, "INVALID_INPUT", "entityType must be node or relation");
    }
    const repository = currentRepository();
    response.json(
      envelope(response.locals.requestId, {
        state: repository.getGovernanceStateNullable(entityType, request.params.id),
        events: repository.listGovernanceEvents(entityType, request.params.id, 20)
      })
    );
  });

  app.post("/api/v1/governance/recompute", (request, response) => {
    const input = recomputeGovernanceSchema.parse(request.body ?? {});
    const result = recomputeAutomaticGovernance(currentRepository(), input);
    broadcastWorkspaceEvent({
      reason: "governance.recomputed",
      entityType: input.entityType ?? "settings"
    });
    response.json(envelope(response.locals.requestId, result));
  });

  app.get("/api/v1/integrations", (_request, response) => {
    response.json(envelope(response.locals.requestId, { items: currentRepository().listIntegrations() }));
  });

  app.post("/api/v1/integrations", (request, response) => {
    const input = registerIntegrationSchema.parse(request.body ?? {});
    const integration = currentRepository().registerIntegration(input);
    broadcastWorkspaceEvent({
      reason: "integration.registered",
      entityType: "integration",
      entityId: integration.id
    });
    response.status(201).json(envelope(response.locals.requestId, { integration }));
  });

  app.patch("/api/v1/integrations/:id", (request, response) => {
    const input = updateIntegrationSchema.parse(request.body ?? {});
    const integration = currentRepository().updateIntegration(request.params.id, input);
    broadcastWorkspaceEvent({
      reason: "integration.updated",
      entityType: "integration",
      entityId: integration.id
    });
    response.json(envelope(response.locals.requestId, { integration }));
  });

  app.get("/api/v1/settings", (request, response) => {
    const keys = parseCommaSeparatedValues(request.query.keys);
    response.json(envelope(response.locals.requestId, { values: currentRepository().getSettings(keys) }));
  });

  app.patch("/api/v1/settings", (request, response) => {
    const repository = currentRepository();
    const input = updateSettingsSchema.parse(request.body ?? {});
    for (const [key, value] of Object.entries(input.values)) {
      repository.setSetting(key, value);
    }
    broadcastWorkspaceEvent({
      reason: "settings.updated",
      entityType: "settings"
    });
    response.json(envelope(response.locals.requestId, { values: repository.getSettings(Object.keys(input.values)) }));
  });

  app.use("/artifacts", (request, response, next) => {
    if (params.apiToken && readBearerToken(request) !== params.apiToken) {
      next(new AppError(401, "UNAUTHORIZED", "Missing or invalid bearer token."));
      return;
    }

    const session = currentSession();
    const workspaceRoot = session.workspaceRoot;
    const artifactRelativePath = normalizeArtifactRelativePath(request.path);
    const artifactPath = path.resolve(workspaceRoot, artifactRelativePath);
    if (!isPathWithinRoot(session.paths.artifactsDir, artifactPath)) {
      next(new AppError(403, "FORBIDDEN", "Artifact path escapes workspace root."));
      return;
    }
    if (!currentRepository().hasArtifactAtPath(artifactRelativePath)) {
      next(new AppError(404, "NOT_FOUND", "Artifact not found."));
      return;
    }
    if (!existsSync(artifactPath)) {
      next(new AppError(404, "NOT_FOUND", "Artifact not found."));
      return;
    }
    response.type(mime.lookup(artifactPath) || "application/octet-stream");
    response.sendFile(artifactPath);
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.locals.telemetryErrorCode = error.code;
      response.locals.telemetryErrorKind = "app_error";
      response.status(error.statusCode).json(errorEnvelope(response.locals.requestId, error));
      return;
    }

    if (error instanceof Error && "issues" in error) {
      response.locals.telemetryErrorCode = "INVALID_INPUT";
      response.locals.telemetryErrorKind = "validation_error";
      response
        .status(400)
        .json(errorEnvelope(response.locals.requestId, new AppError(400, "INVALID_INPUT", "Invalid input.", error)));
      return;
    }

    const unexpected = new AppError(500, "INTERNAL_ERROR", "Unexpected internal error.");
    response.locals.telemetryErrorCode = unexpected.code;
    response.locals.telemetryErrorKind = "unexpected_error";
    response.status(unexpected.statusCode).json(errorEnvelope(response.locals.requestId, unexpected));
  });

  return app;
}
