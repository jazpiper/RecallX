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
  buildContextBundle,
  buildNeighborhoodItems,
  bundleAsMarkdown
} from "./retrieval.js";
import { computeUsageBonus, relationTypeSpecificityBonus } from "./relation-scoring.js";
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

function buildCandidateRelationBonusMap(
  repository: ReturnType<WorkspaceSessionManager["getCurrent"]>["repository"],
  targetNodeId: string,
  candidateNodeIds: string[]
) {
  const neighborhood = buildNeighborhoodItems(repository, targetNodeId, {
    includeInferred: true,
    maxInferred: Math.max(4, Math.min(candidateNodeIds.length, 10))
  });
  const usageSummaries = repository.getRelationUsageSummaries(neighborhood.map((item) => item.edge.relationId));

  return new Map(
    neighborhood
      .filter((item) => candidateNodeIds.includes(item.node.id))
      .map((item) => {
        const usageBonus = computeUsageBonus(usageSummaries.get(item.edge.relationId));
        const relationBonus =
          item.edge.relationSource === "canonical"
            ? 70 + relationTypeSpecificityBonus(item.edge.relationType) * 100 + usageBonus * 60
            : ((item.edge.relationScore ?? 0) + relationTypeSpecificityBonus(item.edge.relationType) + usageBonus) * 35;
        return [
          item.node.id,
          {
            score: relationBonus,
            relationSource: item.edge.relationSource,
            relationType: item.edge.relationType,
            relationScore: item.edge.relationScore,
            reason: item.edge.reason
          }
        ] as const;
      })
  );
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
      "All durable writes should include a source object for provenance."
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

  function clearAutoRecomputeTimer() {
    if (autoRecomputeState.timer) {
      clearTimeout(autoRecomputeState.timer);
      autoRecomputeState.timer = null;
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
        autoRecompute: buildAutoRecomputeStatus()
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
        autoRecompute: buildAutoRecomputeStatus()
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
    refreshAutomaticInferredRelationsForNode(repository, node.id, "node-write");
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
    refreshAutomaticInferredRelationsForNode(repository, node.id, "node-write");
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
    refreshAutomaticInferredRelationsForNode(repository, node.id, "node-write");
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
    refreshAutomaticInferredRelationsForNode(repository, node.id, "node-write");
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
    refreshAutomaticInferredRelationsForNode(repository, relation.fromNodeId, "node-write");
    refreshAutomaticInferredRelationsForNode(repository, relation.toNodeId, "node-write");
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
    refreshAutomaticInferredRelationsForNode(repository, relation.fromNodeId, "node-write");
    refreshAutomaticInferredRelationsForNode(repository, relation.toNodeId, "node-write");
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
    refreshAutomaticInferredRelationsForNode(repository, activity.targetNodeId, "activity-append");
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
    refreshAutomaticInferredRelationsForNode(repository, artifact.nodeId, "node-write");
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

  app.post("/api/v1/retrieval/rank-candidates", (request, response) => {
    const repository = currentRepository();
    const query = typeof request.body?.query === "string" ? request.body.query : "";
    const candidateNodeIds: string[] = Array.isArray(request.body?.candidateNodeIds) ? request.body.candidateNodeIds : [];
    const preset = typeof request.body?.preset === "string" ? request.body.preset : "for-assistant";
    const targetNodeId = typeof request.body?.targetNodeId === "string" ? request.body.targetNodeId : null;
    const relationBonuses = targetNodeId ? buildCandidateRelationBonusMap(repository, targetNodeId, candidateNodeIds) : new Map();
    const ranked = candidateNodeIds
      .map((id: string) => repository.getNode(id))
      .map((node) => ({
        nodeId: node.id,
        score:
          (node.title?.toLowerCase().includes(query.toLowerCase()) ? 50 : 0) +
          (node.summary?.toLowerCase().includes(query.toLowerCase()) ? 20 : 0) +
          (preset === "for-coding" && node.type === "decision" ? 15 : 0) +
          (node.canonicality === "canonical" ? 10 : 0) +
          (relationBonuses.get(node.id)?.score ?? 0),
        title: node.title,
        relationSource: relationBonuses.get(node.id)?.relationSource ?? null,
        relationType: relationBonuses.get(node.id)?.relationType ?? null,
        relationScore: relationBonuses.get(node.id)?.relationScore ?? null,
        reason: relationBonuses.get(node.id)?.reason ?? null
      }))
      .sort((left: { score: number }, right: { score: number }) => right.score - left.score);
    response.json(envelope(response.locals.requestId, { items: ranked }));
  });

  app.post("/api/v1/context/bundles", (request, response) => {
    const input = buildContextBundleSchema.parse(request.body ?? {});
    const bundle = buildContextBundle(currentRepository(), input);
    response.json(envelope(response.locals.requestId, { bundle }));
  });

  app.post("/api/v1/context/bundles/preview", (request, response) => {
    const input = buildContextBundleSchema.parse(request.body ?? {});
    const bundle = buildContextBundle(currentRepository(), input);
    response.json(
      envelope(response.locals.requestId, {
        bundle,
        preview: bundleAsMarkdown(bundle)
      })
    );
  });

  app.post("/api/v1/context/bundles/export", (request, response) => {
    const input = buildContextBundleSchema.parse(request.body ?? {});
    const format = request.body?.format === "json" ? "json" : request.body?.format === "text" ? "text" : "markdown";
    const bundle = buildContextBundle(currentRepository(), input);
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
      refreshAutomaticInferredRelationsForNode(repository, relation.fromNodeId, "node-write");
      refreshAutomaticInferredRelationsForNode(repository, relation.toNodeId, "node-write");
    } else if (review.entityType === "node") {
      refreshAutomaticInferredRelationsForNode(repository, review.entityId, "node-write");
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
      refreshAutomaticInferredRelationsForNode(repository, relation.fromNodeId, "node-write");
      refreshAutomaticInferredRelationsForNode(repository, relation.toNodeId, "node-write");
    } else if (review.entityType === "node") {
      refreshAutomaticInferredRelationsForNode(repository, review.entityId, "node-write");
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
      refreshAutomaticInferredRelationsForNode(repository, relation.fromNodeId, "node-write");
      refreshAutomaticInferredRelationsForNode(repository, relation.toNodeId, "node-write");
    } else if (review.entityType === "node") {
      refreshAutomaticInferredRelationsForNode(repository, review.entityId, "node-write");
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
