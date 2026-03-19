import { existsSync } from "node:fs";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import mime from "mime-types";
import {
  appendActivitySchema,
  appendRelationUsageEventSchema,
  attachArtifactSchema,
  buildContextBundleSchema,
  createWorkspaceSchema,
  createNodeSchema,
  createRelationSchema,
  nodeSearchSchema,
  openWorkspaceSchema,
  reindexInferredRelationsSchema,
  recomputeInferredRelationsSchema,
  relationTypes,
  registerIntegrationSchema,
  reviewActionSchema,
  sourceSchema,
  upsertInferredRelationSchema,
  updateIntegrationSchema,
  updateNodeSchema,
  updateRelationSchema,
  updateSettingsSchema
} from "../shared/contracts.js";
import type { ApiEnvelope, ApiErrorEnvelope, InferredRelationRecord, NodeRecord } from "../shared/types.js";
import { AppError } from "./errors.js";
import {
  applyReviewDecision,
  maybeCreatePromotionCandidate,
  resolveGovernancePolicy,
  resolveNodeGovernance,
  resolveRelationStatus,
  shouldPromoteActivitySummary
} from "./governance.js";
import { refreshAutomaticInferredRelationsForNode, reindexAutomaticInferredRelations } from "./inferred-relations.js";
import {
  buildSemanticCandidateBonusMap,
  buildCandidateRelationBonusMap,
  buildContextBundle,
  buildNeighborhoodItems,
  bundleAsMarkdown,
  computeRankCandidateScore,
  shouldUseSemanticCandidateAugmentation
} from "./retrieval.js";
import { createId, isPathWithinRoot } from "./utils.js";
import type { WorkspaceSessionManager } from "./workspace-session.js";

const relationTypeSet = new Set<string>(relationTypes);
const allowedLoopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const updateNodeRequestSchema = updateNodeSchema.extend({
  source: sourceSchema
});

function parseRelationTypesQuery(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is (typeof relationTypes)[number] => relationTypeSet.has(item));

  return items.length ? items : undefined;
}

function isAllowedBrowserOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && allowedLoopbackHostnames.has(url.hostname);
  } catch {
    return false;
  }
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
      "read node detail, related nodes, activities, and artifacts",
      "create nodes, relations, activities, and artifacts with provenance",
      "upsert inferred relations and append relation usage signals for retrieval feedback",
      "recompute inferred relation scores in an explicit maintenance pass",
      "inspect semantic indexing status and queue bounded reindex passes",
      "list and act on review queue items",
      "build compact context bundles for coding/research/writing",
      "create or open workspaces without restarting the server"
    ],
    cli: {
      binary: "pnw",
      examples: [
        "pnw health --api http://127.0.0.1:8787/api/v1",
        "pnw search --api http://127.0.0.1:8787/api/v1 \"agent memory\"",
        "pnw create --api http://127.0.0.1:8787/api/v1 --type note --title \"Idea\" --body \"...\"",
        "pnw context --api http://127.0.0.1:8787/api/v1 <node-id> --mode compact --preset for-coding",
        "pnw review list --api http://127.0.0.1:8787/api/v1 --status pending",
        "pnw workspace list --api http://127.0.0.1:8787/api/v1"
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
        path: "/api/v1/review-queue?status=pending",
        purpose: "Read pending governance items."
      },
      {
        method: "POST",
        path: "/api/v1/context/bundles",
        purpose: "Build compact context bundles for downstream agents.",
        requestExample: {
          target: {
            type: "node",
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
      "Do not expect GET /api/v1/nodes/search. Search is POST-based.",
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
  app.use(express.json({ limit: "2mb" }));

  const currentSession = () => params.workspaceSessionManager.getCurrent();
  const currentRepository = () => currentSession().repository;
  const currentWorkspaceInfo = () => currentSession().workspaceInfo;
  const currentWorkspaceRoot = () => currentSession().workspaceRoot;
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
        const totalRelations = currentRepository().countInferredRelations();
        if (totalRelations === 0) {
          currentRepository().setSetting("relations.autoRecompute.lastRunAt", startedAt);
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
        return aggregate;
      }

      if (pending.relationIds.length === 0) {
        currentRepository().setSetting("relations.autoRecompute.lastRunAt", startedAt);
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
      return aggregate;
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
        return result;
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

  hydrateAutoRecomputeState();
  hydrateAutoRefreshState();
  hydrateAutoSemanticIndexState();

  app.use((request, response, next) => {
    const requestId = createId("req");
    response.locals.requestId = requestId;
    next();
  });

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

    const header = request.header("authorization");
    const tokenFromQuery = typeof request.query.token === "string" ? request.query.token : null;
    const providedToken = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : tokenFromQuery;
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
    const rawLimit = typeof request.query.limit === "string" ? Number.parseInt(request.query.limit, 10) : 5;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 25) : 5;
    const cursor = typeof request.query.cursor === "string" && request.query.cursor.trim() ? request.query.cursor : null;
    const statuses =
      typeof request.query.statuses === "string" && request.query.statuses.trim()
        ? request.query.statuses
            .split(",")
            .map((value) => value.trim())
            .filter((value): value is "pending" | "stale" | "failed" => value === "pending" || value === "stale" || value === "failed")
        : undefined;
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
    const limit =
      typeof request.body?.limit === "number" && Number.isFinite(request.body.limit)
        ? Math.max(1, Math.min(1000, Math.trunc(request.body.limit)))
        : 250;
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
    hydrateAutoRecomputeState();
    hydrateAutoRefreshState();
    hydrateAutoSemanticIndexState();
    broadcastWorkspaceEvent({
      reason: "workspace.created",
      entityType: "workspace"
    });
    response.status(201).json(
      envelope(response.locals.requestId, {
        workspace,
        current: currentWorkspaceInfo(),
        items: params.workspaceSessionManager.listWorkspaces()
      })
    );
  });

  app.post("/api/v1/workspaces/open", (request, response) => {
    const input = openWorkspaceSchema.parse(request.body ?? {});
    const workspace = params.workspaceSessionManager.openWorkspace(input.rootPath);
    hydrateAutoRecomputeState();
    hydrateAutoRefreshState();
    hydrateAutoSemanticIndexState();
    broadcastWorkspaceEvent({
      reason: "workspace.opened",
      entityType: "workspace"
    });
    response.json(
      envelope(response.locals.requestId, {
        workspace,
        current: currentWorkspaceInfo(),
        items: params.workspaceSessionManager.listWorkspaces()
      })
    );
  });

  app.post("/api/v1/nodes/search", (request, response) => {
    const input = nodeSearchSchema.parse(request.body ?? {});
    response.json(envelope(response.locals.requestId, currentRepository().searchNodes(input)));
  });

  app.get("/api/v1/nodes/:id", (request, response) => {
    const repository = currentRepository();
    const node = repository.getNode(request.params.id);
    response.json(
      envelope(response.locals.requestId, {
        node,
        related: repository.listRelatedNodes(node.id),
        activities: repository.listNodeActivities(node.id, 10),
        artifacts: repository.listArtifacts(node.id),
        provenance: repository.listProvenance("node", node.id)
      })
    );
  });

  app.post("/api/v1/nodes", (request, response) => {
    const repository = currentRepository();
    const input = createNodeSchema.parse(request.body ?? {});
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
    let reviewItem = null;
    if (governance.createReview) {
      reviewItem = repository.createReviewItem({
        entityType: "node",
        entityId: node.id,
        reviewType: governance.reviewType ?? "node_promotion",
        proposedBy: input.source.actorLabel,
        notes: governance.reason,
        metadata: {
          nodeType: node.type
        }
      });
    }
    queueInferredRefresh(node.id, "node-write");
    scheduleAutoSemanticIndex();
    broadcastWorkspaceEvent({
      reason: "node.created",
      entityType: "node",
      entityId: node.id
    });
    response.status(201).json(envelope(response.locals.requestId, { node, reviewItem }));
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
    queueInferredRefresh(node.id, "node-write");
    scheduleAutoSemanticIndex();
    broadcastWorkspaceEvent({
      reason: "node.updated",
      entityType: "node",
      entityId: node.id
    });
    response.json(envelope(response.locals.requestId, { node }));
  });

  app.post("/api/v1/nodes/:id/refresh-summary", (request, response) => {
    const repository = currentRepository();
    const body = reviewActionSchema.pick({ source: true }).parse(request.body ?? {});
    const node = repository.refreshNodeSummary(request.params.id);
    repository.recordProvenance({
      entityType: "node",
      entityId: node.id,
      operationType: "update",
      source: body.source,
      metadata: {
        fields: ["summary"],
        reason: "summary.refreshed"
      }
    });
    queueInferredRefresh(node.id, "node-write");
    scheduleAutoSemanticIndex();
    broadcastWorkspaceEvent({
      reason: "node.summary_refreshed",
      entityType: "node",
      entityId: node.id
    });
    response.json(envelope(response.locals.requestId, { node }));
  });

  app.post("/api/v1/nodes/:id/archive", (request, response) => {
    const repository = currentRepository();
    const body = reviewActionSchema.pick({ source: true }).parse(request.body ?? {});
    const node = repository.archiveNode(request.params.id);
    repository.recordProvenance({
      entityType: "node",
      entityId: node.id,
      operationType: "archive",
      source: body.source
    });
    queueInferredRefresh(node.id, "node-write");
    scheduleAutoSemanticIndex();
    broadcastWorkspaceEvent({
      reason: "node.archived",
      entityType: "node",
      entityId: node.id
    });
    response.json(envelope(response.locals.requestId, { node }));
  });

  app.get("/api/v1/nodes/:id/related", (request, response) => {
    const depth = Number(request.query.depth ?? 1);
    const types = parseRelationTypesQuery(request.query.types);
    const items = currentRepository().listRelatedNodes(request.params.id, depth, types);
    response.json(envelope(response.locals.requestId, { items }));
  });

  app.get("/api/v1/nodes/:id/neighborhood", (request, response) => {
    const depth = Number(request.query.depth ?? 1);
    if (depth !== 1) {
      throw new AppError(400, "INVALID_INPUT", "Only depth=1 is supported in the hot path.");
    }
    const types = parseRelationTypesQuery(request.query.types);
    const includeInferred =
      request.query.include_inferred === "1" ||
      request.query.include_inferred === "true" ||
      request.query.include_inferred === undefined;
    const requestedMaxInferred = Number(request.query.max_inferred ?? 4);
    const maxInferred = Number.isFinite(requestedMaxInferred) ? Math.max(0, Math.min(requestedMaxInferred, 10)) : 4;
    const items = buildNeighborhoodItems(currentRepository(), request.params.id, {
      relationTypes: types,
      includeInferred,
      maxInferred
    });
    response.json(envelope(response.locals.requestId, { items }));
  });

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
    let reviewItem = null;
    if (governance.createReview) {
      reviewItem = repository.createReviewItem({
        entityType: "relation",
        entityId: relation.id,
        reviewType: "relation_suggestion",
        proposedBy: input.source.actorLabel,
        notes: "Agent-created relations stay suggested until approved."
      });
    }
    queueInferredRefreshForNodes([relation.fromNodeId, relation.toNodeId], "node-write");
    broadcastWorkspaceEvent({
      reason: "relation.created",
      entityType: "relation",
      entityId: relation.id
    });
    response.status(201).json(envelope(response.locals.requestId, { relation, reviewItem }));
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
    const event = currentRepository().appendRelationUsageEvent(appendRelationUsageEventSchema.parse(request.body ?? {}));
    markPendingRelationUsage({
      relationId: event.relationId,
      createdAt: event.createdAt
    });
    scheduleAutoRecompute();
    broadcastWorkspaceEvent({
      reason: "relation-usage.appended",
      entityType: "relation",
      entityId: event.relationId
    });
    response.status(201).json(envelope(response.locals.requestId, { event }));
  });

  app.post("/api/v1/inferred-relations/recompute", async (request, response) => {
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
  });

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
    queueInferredRefreshForNodes([relation.fromNodeId, relation.toNodeId], "node-write");
    broadcastWorkspaceEvent({
      reason: "relation.updated",
      entityType: "relation",
      entityId: relation.id
    });
    response.json(envelope(response.locals.requestId, { relation }));
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
            body: `Durable agent summary promoted to suggested node ${promotion.suggestedNodeId} for review.`,
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
        promotion
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
    const target = repository.getNode(request.params.targetId);
    const related = buildNeighborhoodItems(repository, target.id, {
      includeInferred: true,
      maxInferred: 4
    }).map((item) => item.node.id);
    const items = repository
      .searchNodes({
        query: "",
        filters: { types: ["decision"], status: ["active", "review"] },
        limit: 20,
        offset: 0,
        sort: "updated_at"
      })
      .items.filter((item) => item.id === target.id || related.includes(item.id));
    response.json(envelope(response.locals.requestId, { items }));
  });

  app.get("/api/v1/retrieval/open-questions/:targetId", (request, response) => {
    const repository = currentRepository();
    const target = repository.getNode(request.params.targetId);
    const related = buildNeighborhoodItems(repository, target.id, {
      includeInferred: true,
      maxInferred: 4
    }).map((item) => item.node.id);
    const items = repository
      .searchNodes({
        query: "",
        filters: { types: ["question"], status: ["active", "draft", "review"] },
        limit: 20,
        offset: 0,
        sort: "updated_at"
      })
      .items.filter((item) => item.id === target.id || related.includes(item.id));
    response.json(envelope(response.locals.requestId, { items }));
  });

  app.post("/api/v1/retrieval/rank-candidates", async (request, response) => {
    const repository = currentRepository();
    const query = typeof request.body?.query === "string" ? request.body.query : "";
    const candidateNodeIds: string[] = Array.isArray(request.body?.candidateNodeIds) ? request.body.candidateNodeIds : [];
    const preset = typeof request.body?.preset === "string" ? request.body.preset : "for-assistant";
    const targetNodeId = typeof request.body?.targetNodeId === "string" ? request.body.targetNodeId : null;
    const relationBonuses = targetNodeId ? buildCandidateRelationBonusMap(repository, targetNodeId, candidateNodeIds) : new Map();
    const candidates = candidateNodeIds
      .map((id: string) => repository.getNode(id))
      .map((node) => {
        return node;
      });
    const semanticAugmentation = repository.getSemanticAugmentationSettings();
    const semanticBonuses = shouldUseSemanticCandidateAugmentation(query, candidates)
      ? buildSemanticCandidateBonusMap(await repository.rankSemanticCandidates(query, candidateNodeIds), semanticAugmentation)
      : new Map();
    const ranked = candidates
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
    response.json(envelope(response.locals.requestId, { items: ranked }));
  });

  app.post("/api/v1/context/bundles", async (request, response) => {
    const input = buildContextBundleSchema.parse(request.body ?? {});
    const bundle = await buildContextBundle(currentRepository(), input);
    response.json(envelope(response.locals.requestId, { bundle }));
  });

  app.post("/api/v1/context/bundles/preview", async (request, response) => {
    const input = buildContextBundleSchema.parse(request.body ?? {});
    const bundle = await buildContextBundle(currentRepository(), input);
    response.json(
      envelope(response.locals.requestId, {
        bundle,
        preview: bundleAsMarkdown(bundle)
      })
    );
  });

  app.post("/api/v1/context/bundles/export", async (request, response) => {
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
  });

  app.get("/api/v1/review-queue", (request, response) => {
    const status = typeof request.query.status === "string" ? request.query.status : "pending";
    const limit = Number(request.query.limit ?? 20);
    const reviewType = typeof request.query.review_type === "string" ? request.query.review_type : undefined;
    response.json(
      envelope(response.locals.requestId, {
        items: currentRepository().listReviewItems(status, limit, reviewType)
      })
    );
  });

  app.get("/api/v1/review-queue/:id", (request, response) => {
    const repository = currentRepository();
    const review = repository.getReviewItem(request.params.id);
    let entity: unknown = null;
    if (review.entityType === "node") {
      entity = repository.getNode(review.entityId);
    } else if (review.entityType === "relation") {
      entity = repository.getRelation(review.entityId);
    }
    response.json(envelope(response.locals.requestId, { review, entity }));
  });

  app.post("/api/v1/review-queue/:id/approve", (request, response) => {
    const repository = currentRepository();
    const input = reviewActionSchema.parse(request.body ?? {});
    const review = repository.getReviewItem(request.params.id);
    const result = applyReviewDecision(repository, request.params.id, "approve", input);
    if (review.entityType === "relation") {
      const relation = repository.getRelation(review.entityId);
      queueInferredRefreshForNodes([relation.fromNodeId, relation.toNodeId], "node-write");
    } else if (review.entityType === "node") {
      queueInferredRefresh(review.entityId, "node-write");
    }
    broadcastWorkspaceEvent({
      reason: "review.approved",
      entityType: "review",
      entityId: request.params.id
    });
    response.json(envelope(response.locals.requestId, result));
  });

  app.post("/api/v1/review-queue/:id/reject", (request, response) => {
    const repository = currentRepository();
    const input = reviewActionSchema.parse(request.body ?? {});
    const review = repository.getReviewItem(request.params.id);
    const result = applyReviewDecision(repository, request.params.id, "reject", input);
    if (review.entityType === "relation") {
      const relation = repository.getRelation(review.entityId);
      queueInferredRefreshForNodes([relation.fromNodeId, relation.toNodeId], "node-write");
    } else if (review.entityType === "node") {
      queueInferredRefresh(review.entityId, "node-write");
    }
    broadcastWorkspaceEvent({
      reason: "review.rejected",
      entityType: "review",
      entityId: request.params.id
    });
    response.json(envelope(response.locals.requestId, result));
  });

  app.post("/api/v1/review-queue/:id/edit-and-approve", (request, response) => {
    const repository = currentRepository();
    const input = reviewActionSchema.parse(request.body ?? {});
    const review = repository.getReviewItem(request.params.id);
    const result = applyReviewDecision(repository, request.params.id, "edit-and-approve", input);
    if (review.entityType === "relation") {
      const relation = repository.getRelation(review.entityId);
      queueInferredRefreshForNodes([relation.fromNodeId, relation.toNodeId], "node-write");
    } else if (review.entityType === "node") {
      queueInferredRefresh(review.entityId, "node-write");
    }
    broadcastWorkspaceEvent({
      reason: "review.edit_and_approved",
      entityType: "review",
      entityId: request.params.id
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
    const keys =
      typeof request.query.keys === "string"
        ? request.query.keys
            .split(",")
            .map((key) => key.trim())
            .filter(Boolean)
        : undefined;
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
    const workspaceRoot = currentWorkspaceRoot();
    const artifactPath = path.resolve(workspaceRoot, request.path.replace(/^\//, ""));
    if (!isPathWithinRoot(workspaceRoot, artifactPath)) {
      next(new AppError(403, "FORBIDDEN", "Artifact path escapes workspace root."));
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
      response.status(error.statusCode).json(errorEnvelope(response.locals.requestId, error));
      return;
    }

    if (error instanceof Error && "issues" in error) {
      response
        .status(400)
        .json(errorEnvelope(response.locals.requestId, new AppError(400, "INVALID_INPUT", "Invalid input.", error)));
      return;
    }

    const unexpected = new AppError(500, "INTERNAL_ERROR", "Unexpected internal error.");
    response.status(unexpected.statusCode).json(errorEnvelope(response.locals.requestId, unexpected));
  });

  return app;
}
