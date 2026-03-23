import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  activityTypes,
  bundleModes,
  bundlePresets,
  canonicalities,
  captureModes,
  governanceStates,
  inferredRelationStatuses,
  nodeStatuses,
  nodeTypes,
  relationSources,
  relationStatuses,
  relationTypes,
  relationUsageEventTypes,
  searchFeedbackResultTypes,
  searchFeedbackVerdicts,
  sourceTypes
} from "../shared/contracts.js";
import type { Source } from "../shared/contracts.js";
import { RECALLX_VERSION } from "../shared/version.js";
import { createObservabilityWriter, summarizePayloadShape } from "../server/observability.js";
import { RecallXApiClient, RecallXApiError } from "./api-client.js";

const jsonRecordSchema = z.record(z.string(), z.any()).default({});
const stringOrStringArraySchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const workspaceSearchScopes = ["nodes", "activities"] as const;
const workspaceScopeSchema = z.enum(workspaceSearchScopes);
const workspaceScopeInputSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return value;
  }
  return parts.length === 1 ? parts[0] : parts;
}, z.union([workspaceScopeSchema, z.array(workspaceScopeSchema).min(1)]));

function parseIntegerLike(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return value;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function coerceIntegerSchema(defaultValue: number, min: number, max: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    if (typeof value === "number") {
      return value;
    }
    const parsed = parseIntegerLike(value);
    if (typeof parsed !== "string") {
      return parsed;
    }
    return value;
  }, z.number().int().min(min).max(max).default(defaultValue));
}

function coerceBooleanSchema(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      if (value === "true") return true;
      if (value === "false") return false;
    }
    return value;
  }, z.boolean().default(defaultValue));
}

function formatStructuredContent(content: unknown) {
  return JSON.stringify(content, null, 2);
}

function toolResult<T>(structuredContent: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: formatStructuredContent(structuredContent)
      }
    ],
    structuredContent
  };
}

function buildSourceSchema(defaultSource: Source) {
  const sourceDefault = {
    actorType: defaultSource.actorType,
    actorLabel: defaultSource.actorLabel,
    toolName: defaultSource.toolName,
    toolVersion: defaultSource.toolVersion
  };

  return z
    .object({
      actorType: z.enum(sourceTypes).default(defaultSource.actorType),
      actorLabel: z.string().min(1).default(defaultSource.actorLabel),
      toolName: z.string().min(1).default(defaultSource.toolName),
      toolVersion: defaultSource.toolVersion
        ? z.string().min(1).optional().default(defaultSource.toolVersion)
        : z.string().min(1).optional()
    })
    .default(sourceDefault);
}

const workspaceInfoSchema = z.object({
  rootPath: z.string(),
  workspaceName: z.string(),
  schemaVersion: z.number(),
  bindAddress: z.string(),
  enabledIntegrationModes: z.array(z.string()),
  authMode: z.string()
});

const healthOutputSchema = z.object({
  status: z.string(),
  workspaceLoaded: z.boolean(),
  workspaceRoot: z.string(),
  schemaVersion: z.number()
}).passthrough();

const sourceDescription =
  "Optional provenance override. If omitted, RecallX MCP uses its own agent identity so durable writes still keep attribution.";
const readOnlyToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true
} as const;

function createGetToolHandler(apiClient: Pick<RecallXApiClient, "get">, path: string) {
  return async () => toolResult(await apiClient.get<Record<string, unknown>>(path));
}

function createPostToolHandler(apiClient: Pick<RecallXApiClient, "post">, path: string) {
  return async (input: Record<string, unknown>) => toolResult(await apiClient.post<Record<string, unknown>>(path, input));
}

function createNormalizedPostToolHandler<TInput extends Record<string, unknown>>(
  apiClient: Pick<RecallXApiClient, "post">,
  path: string,
  normalize: (input: TInput) => Record<string, unknown>
) {
  return async (input: TInput) => toolResult(await apiClient.post<Record<string, unknown>>(path, normalize(input)));
}

function withReadOnlyAnnotations(config: any) {
  return {
    ...config,
    annotations: {
      ...readOnlyToolAnnotations,
      ...(config.annotations ?? {})
    }
  };
}

function classifyMcpError(error: unknown) {
  if (error instanceof RecallXApiError) {
    if (error.code === "NETWORK_ERROR") {
      return { errorKind: "network_error" as const, errorCode: error.code, statusCode: error.status };
    }
    if (error.code === "INVALID_RESPONSE") {
      return { errorKind: "invalid_response" as const, errorCode: error.code, statusCode: error.status };
    }
    if (error.code === "EMPTY_RESPONSE") {
      return { errorKind: "empty_response" as const, errorCode: error.code, statusCode: error.status };
    }
    if (error.code === "HTTP_ERROR") {
      return { errorKind: "http_error" as const, errorCode: error.code, statusCode: error.status };
    }
    return { errorKind: "api_error" as const, errorCode: error.code, statusCode: error.status };
  }

  if (error instanceof Error && "issues" in error) {
    return { errorKind: "validation_error" as const, errorCode: "INVALID_INPUT", statusCode: 400 };
  }

  if (error instanceof Error && error.message.startsWith("Invalid arguments for tool ")) {
    return { errorKind: "normalization_error" as const, errorCode: "INVALID_ARGUMENTS", statusCode: 400 };
  }

  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return {
      errorKind: "api_error" as const,
      errorCode: String((error as { code: string }).code),
      statusCode: 400
    };
  }

  return { errorKind: "unexpected_error" as const, errorCode: "UNEXPECTED_ERROR", statusCode: 500 };
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length ? items : undefined;
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return undefined;
}

function mergeStringLists(...values: unknown[]): string[] | undefined {
  const merged = values.flatMap((value) => normalizeStringList(value) ?? []);
  return merged.length ? Array.from(new Set(merged)) : undefined;
}

function normalizeCommaSeparatedList(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return value;
  }
  return parts.length === 1 ? parts[0] : parts;
}

function assertSupportedEnumValues<T extends string>(
  toolName: string,
  fieldName: string,
  values: string[] | undefined,
  supportedValues: readonly T[],
  hints: Partial<Record<string, string>> = {}
): T[] | undefined {
  if (!values?.length) {
    return undefined;
  }

  const supported = new Set<string>(supportedValues);
  const invalid = values.find((value) => !supported.has(value));
  if (invalid) {
    const hint = hints[invalid];
    if (hint) {
      throw new Error(`Invalid arguments for tool ${toolName}: ${hint}`);
    }
    throw new Error(
      `Invalid arguments for tool ${toolName}: unsupported ${fieldName} '${invalid}'. Expected one of ${supportedValues.join(", ")}.`
    );
  }

  return values as T[];
}

function readSearchQuery(toolName: string, input: Record<string, unknown>) {
  const query = typeof input.query === "string" ? input.query : "";
  const allowEmptyQuery = input.allowEmptyQuery === true;
  if (!query.trim() && !allowEmptyQuery) {
    throw new Error(
      `Invalid arguments for tool ${toolName}: empty query is disabled by default. If you want browse-style results, pass allowEmptyQuery: true.`
    );
  }
  return query;
}

function normalizeNodeSearchInput(input: Record<string, unknown>) {
  const rawFilters = (typeof input.filters === "object" && input.filters ? input.filters : {}) as Record<string, unknown>;
  const filters = {
    types: assertSupportedEnumValues(
      "recallx_search_nodes",
      "node type",
      mergeStringLists(input.type, input.types, rawFilters.types),
      nodeTypes,
      {
        activity: "`activity` is not a node type. Use `recallx_search_activities` for operational logs."
      }
    ),
    status: assertSupportedEnumValues(
      "recallx_search_nodes",
      "node status",
      mergeStringLists(input.status, rawFilters.status),
      nodeStatuses
    ),
    sourceLabels: mergeStringLists(rawFilters.sourceLabels),
    tags: mergeStringLists(input.tag, rawFilters.tags)
  };
  return {
    query: readSearchQuery("recallx_search_nodes", input),
    filters,
    limit: Number(input.limit ?? 10),
    offset: Number(input.offset ?? 0),
    sort: input.sort === "updated_at" ? "updated_at" : "relevance"
  };
}

function normalizeActivitySearchInput(input: Record<string, unknown>) {
  const rawFilters = (typeof input.filters === "object" && input.filters ? input.filters : {}) as Record<string, unknown>;
  const filters = {
    targetNodeIds: mergeStringLists(input.targetNodeId, rawFilters.targetNodeIds),
    activityTypes: assertSupportedEnumValues(
      "recallx_search_activities",
      "activity type",
      mergeStringLists(input.activityType, rawFilters.activityTypes),
      activityTypes
    ),
    sourceLabels: mergeStringLists(rawFilters.sourceLabels),
    createdAfter: typeof rawFilters.createdAfter === "string" ? rawFilters.createdAfter : undefined,
    createdBefore: typeof rawFilters.createdBefore === "string" ? rawFilters.createdBefore : undefined
  };
  return {
    query: readSearchQuery("recallx_search_activities", input),
    filters,
    limit: Number(input.limit ?? 10),
    offset: Number(input.offset ?? 0),
    sort: input.sort === "updated_at" ? "updated_at" : "relevance"
  };
}

function normalizeWorkspaceSearchInput(input: Record<string, unknown>) {
  const rawNodeFilters = (typeof input.nodeFilters === "object" && input.nodeFilters ? input.nodeFilters : {}) as Record<string, unknown>;
  const rawActivityFilters =
    typeof input.activityFilters === "object" && input.activityFilters ? (input.activityFilters as Record<string, unknown>) : {};
  const scopes =
    assertSupportedEnumValues(
      "recallx_search_workspace",
      "scope",
      mergeStringLists(normalizeCommaSeparatedList(input.scope), normalizeCommaSeparatedList(input.scopes)),
      workspaceSearchScopes
    ) ?? [...workspaceSearchScopes];
  const nodeFilters = {
    types: assertSupportedEnumValues(
      "recallx_search_workspace",
      "node type",
      mergeStringLists(rawNodeFilters.types),
      nodeTypes
    ),
    status: assertSupportedEnumValues(
      "recallx_search_workspace",
      "node status",
      mergeStringLists(rawNodeFilters.status),
      nodeStatuses
    ),
    sourceLabels: mergeStringLists(rawNodeFilters.sourceLabels),
    tags: mergeStringLists(rawNodeFilters.tags)
  };
  const activityFilters = {
    targetNodeIds: mergeStringLists(rawActivityFilters.targetNodeIds),
    activityTypes: assertSupportedEnumValues(
      "recallx_search_workspace",
      "activity type",
      mergeStringLists(rawActivityFilters.activityTypes),
      activityTypes
    ),
    sourceLabels: mergeStringLists(rawActivityFilters.sourceLabels),
    createdAfter: typeof rawActivityFilters.createdAfter === "string" ? rawActivityFilters.createdAfter : undefined,
    createdBefore: typeof rawActivityFilters.createdBefore === "string" ? rawActivityFilters.createdBefore : undefined
  };
  return {
    query: readSearchQuery("recallx_search_workspace", input),
    scopes,
    nodeFilters,
    activityFilters,
    limit: Number(input.limit ?? 10),
    offset: Number(input.offset ?? 0),
    sort: input.sort === "updated_at" ? "updated_at" : input.sort === "smart" ? "smart" : "relevance"
  };
}

export function createRecallXMcpServer(params?: {
  apiClient?: Pick<RecallXApiClient, "get" | "post" | "patch">;
  defaultSource?: Source;
  serverVersion?: string;
  observabilityState?: {
    enabled: boolean;
    workspaceRoot: string;
    workspaceName: string;
    retentionDays: number;
    slowRequestMs: number;
    capturePayloadShape: boolean;
  };
  getObservabilityState?: () =>
    | {
        enabled: boolean;
        workspaceRoot: string;
        workspaceName: string;
        retentionDays: number;
        slowRequestMs: number;
        capturePayloadShape: boolean;
      }
    | Promise<{
        enabled: boolean;
        workspaceRoot: string;
        workspaceName: string;
        retentionDays: number;
        slowRequestMs: number;
        capturePayloadShape: boolean;
      }>;
}) {
  const apiClient =
    params?.apiClient ??
    new RecallXApiClient(
      process.env.RECALLX_API_URL ?? "http://127.0.0.1:8787/api/v1",
      process.env.RECALLX_API_TOKEN
    );
  const defaultSource: Source = params?.defaultSource ?? {
    actorType: "agent",
    actorLabel: process.env.RECALLX_MCP_SOURCE_LABEL ?? "RecallX MCP",
    toolName: process.env.RECALLX_MCP_TOOL_NAME ?? "recallx-mcp",
    toolVersion: params?.serverVersion ?? RECALLX_VERSION
  };
  const sourceSchema = buildSourceSchema(defaultSource).describe(sourceDescription);
  const defaultObservabilityState = {
    enabled: false,
    workspaceRoot: process.cwd(),
    workspaceName: "RecallX MCP",
    retentionDays: 14,
    slowRequestMs: 250,
    capturePayloadShape: true
  };
  let currentObservabilityState = params?.observabilityState ?? defaultObservabilityState;
  const readObservabilityState = async () => {
    if (!params?.getObservabilityState) {
      return currentObservabilityState;
    }

    try {
      currentObservabilityState = await params.getObservabilityState();
    } catch {
      // Keep the last known-good state so observability refresh failures do not break tool calls.
    }

    return currentObservabilityState;
  };
  const observability = createObservabilityWriter({
    getState: () => currentObservabilityState
  });

  const server = new McpServer(
    {
      name: "recallx-mcp",
      version: params?.serverVersion ?? RECALLX_VERSION
    },
    {
      instructions:
        "Use RecallX as a local knowledge backend. Treat the current workspace as the default scope, and do not create or open another workspace unless the user explicitly asks. When the work is clearly project-shaped, search for an existing project inside the current workspace first: prefer recallx_search_nodes with type=project, broaden with recallx_search_workspace when needed, create a project node only if no suitable one exists, and then anchor follow-up context with recallx_context_bundle targetId. Once a project is known, do not keep writing untargeted workspace captures for routine work logs: append activity to that project or pass targetNodeId on capture writes. Reserve workspace-scope inbox activity for genuinely untargeted, cross-project, or not-yet-classified short logs. If the conversation is not project-specific, keep memory at workspace scope. Prefer read tools first, and include source details on durable writes when you want caller-specific provenance.",
      capabilities: {
        logging: {}
      }
    }
  );

  const registerTool = (server: McpServer, name: string, config: any, handler: (...args: any[]) => any) => {
    server.registerTool(
      name,
      config,
      async (...args: any[]) => {
        const input = args[0];
        const observabilityState = await readObservabilityState();
        const traceId = `trace_mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const span = observability.startSpan({
          surface: "mcp",
          operation: name,
          traceId,
          details: observabilityState.capturePayloadShape ? summarizePayloadShape(input) : undefined
        });

        try {
          return await observability.withContext(
            {
              traceId,
              requestId: null,
              workspaceRoot: observabilityState.workspaceRoot,
              workspaceName: observabilityState.workspaceName,
              toolName: name,
              surface: "mcp"
            },
            () =>
              span.run(async () => {
                const result = await handler(...args);
                span.addDetails({ success: true });
                await span.finish({ outcome: "success" });
                return result;
              })
          );
        } catch (error) {
          const classified = classifyMcpError(error);
          await span.finish({
            outcome: "error",
            statusCode: classified.statusCode,
            errorCode: classified.errorCode,
            errorKind: classified.errorKind
          });
          throw error;
        }
      }
    );
  };

  const registerReadOnlyTool = (server: McpServer, name: string, config: any, handler: (...args: any[]) => any) => {
    registerTool(server, name, withReadOnlyAnnotations(config), handler);
  };

  registerReadOnlyTool(
    server,
    "recallx_health",
    {
      title: "RecallX Health",
      description: "Check whether the running local RecallX API is healthy and which workspace is loaded.",
      inputSchema: z.object({
        includeDetails: z.boolean().optional().default(true)
      }),
      outputSchema: healthOutputSchema
    },
    async () => toolResult(await apiClient.get<Record<string, unknown>>("/health"))
  );

  registerReadOnlyTool(
    server,
    "recallx_workspace_current",
    {
      title: "Current Workspace",
      description:
        "Read the currently active RecallX workspace and auth mode. Use this to confirm the default workspace scope before deciding whether an explicit user request justifies switching workspaces.",
      outputSchema: workspaceInfoSchema
    },
    createGetToolHandler(apiClient, "/workspace")
  );

  registerReadOnlyTool(
    server,
    "recallx_workspace_list",
    {
      title: "List Workspaces",
      description: "List known RecallX workspaces and identify the currently active one.",
      outputSchema: z.object({
        current: workspaceInfoSchema,
        items: z.array(workspaceInfoSchema.extend({ isCurrent: z.boolean(), lastOpenedAt: z.string() }))
      })
    },
    createGetToolHandler(apiClient, "/workspaces")
  );

  registerTool(
    server,
    "recallx_workspace_create",
    {
      title: "Create Workspace",
      description:
        "Create a RecallX workspace on disk and switch the running service to it without restarting. Only use this when the user explicitly requests creating or switching to a new workspace.",
      inputSchema: {
        rootPath: z.string().min(1).describe("Absolute or user-resolved path for the new workspace root."),
        workspaceName: z.string().min(1).optional().describe("Human-friendly workspace name.")
      }
    },
    createPostToolHandler(apiClient, "/workspaces")
  );

  registerTool(
    server,
    "recallx_workspace_open",
    {
      title: "Open Workspace",
      description:
        "Switch the running RecallX service to another existing workspace. Only use this when the user explicitly requests opening or switching workspaces.",
      inputSchema: {
        rootPath: z.string().min(1).describe("Existing workspace root path to open.")
      }
    },
    createPostToolHandler(apiClient, "/workspaces/open")
  );

  registerReadOnlyTool(
    server,
    "recallx_semantic_status",
    {
      title: "Semantic Index Status",
      description: "Read the current semantic indexing status, provider configuration, and queued item counts.",
      outputSchema: z.object({
        enabled: z.boolean(),
        provider: z.string().nullable(),
        model: z.string().nullable(),
        chunkEnabled: z.boolean(),
        lastBackfillAt: z.string().nullable(),
        counts: z.object({
          pending: z.number(),
          processing: z.number(),
          stale: z.number(),
          ready: z.number(),
          failed: z.number()
        })
      })
    },
    createGetToolHandler(apiClient, "/semantic/status")
  );

  registerReadOnlyTool(
    server,
    "recallx_semantic_issues",
    {
      title: "Semantic Index Issues",
      description: "Read semantic indexing issues with optional status filters and cursor pagination.",
      inputSchema: {
        limit: coerceIntegerSchema(5, 1, 25).describe("Maximum number of semantic issue items to return."),
        cursor: z.string().min(1).optional().describe("Opaque cursor from a previous semantic issues call."),
        statuses: z.array(z.enum(["pending", "stale", "failed"])).max(3).optional().describe("Optional issue statuses to include.")
      },
      outputSchema: z.object({
        items: z.array(
          z.object({
            nodeId: z.string(),
            title: z.string().nullable(),
            embeddingStatus: z.enum(["pending", "processing", "stale", "ready", "failed"]),
            staleReason: z.string().nullable(),
            updatedAt: z.string()
          })
        ),
        nextCursor: z.string().nullable()
      })
    },
    async ({ limit, cursor, statuses }) => {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (cursor) {
        params.set("cursor", cursor);
      }
      if (statuses?.length) {
        params.set("statuses", statuses.join(","));
      }
      return toolResult(await apiClient.get(`/semantic/issues?${params.toString()}`));
    }
  );

  registerReadOnlyTool(
    server,
    "recallx_search_nodes",
    {
      title: "Search Nodes",
      description:
        "Search durable RecallX nodes by keyword and optional filters. Prefer this for durable-only recall, especially when checking for an existing project in the current workspace by filtering with type=project. Valid node types include note, project, idea, question, decision, reference, artifact_ref, and conversation. `activity` is not a node type.",
      inputSchema: {
        query: z.string().default("").describe("Keyword or phrase query."),
        allowEmptyQuery: coerceBooleanSchema(false).describe("Set true to browse recent durable nodes without a query."),
        type: stringOrStringArraySchema.optional().describe("Alias for filters.types. Example: `note`."),
        types: stringOrStringArraySchema.optional().describe("Node type filter. Accepts a string or array."),
        status: stringOrStringArraySchema.optional().describe("Alias for filters.status."),
        tag: stringOrStringArraySchema.optional().describe("Alias for filters.tags."),
        filters: z
          .object({
            types: stringOrStringArraySchema.optional(),
            status: stringOrStringArraySchema.optional(),
            sourceLabels: stringOrStringArraySchema.optional(),
            tags: stringOrStringArraySchema.optional()
          })
          .default({}),
        limit: coerceIntegerSchema(10, 1, 100),
        offset: coerceIntegerSchema(0, 0, 10_000),
        sort: z.enum(["relevance", "updated_at"]).default("relevance")
      }
    },
    createNormalizedPostToolHandler(apiClient, "/nodes/search", normalizeNodeSearchInput)
  );

  registerReadOnlyTool(
    server,
    "recallx_search_activities",
    {
      title: "Search Activities",
      description:
        "Search operational activity timelines by keyword and optional filters. Prefer this for recent logs, change history, and 'what happened recently' questions. Accepts `activityType` and `targetNodeId` aliases and normalizes single strings into arrays.",
      inputSchema: {
        query: z.string().default("").describe("Keyword or phrase query."),
        allowEmptyQuery: coerceBooleanSchema(false).describe("Set true to browse recent activity results without a query."),
        activityType: stringOrStringArraySchema.optional().describe("Alias for filters.activityTypes."),
        targetNodeId: stringOrStringArraySchema.optional().describe("Alias for filters.targetNodeIds."),
        filters: z
          .object({
            targetNodeIds: stringOrStringArraySchema.optional(),
            activityTypes: stringOrStringArraySchema.optional(),
            sourceLabels: stringOrStringArraySchema.optional(),
            createdAfter: z.string().optional(),
            createdBefore: z.string().optional()
          })
          .default({}),
        limit: coerceIntegerSchema(10, 1, 100),
        offset: coerceIntegerSchema(0, 0, 10_000),
        sort: z.enum(["relevance", "updated_at"]).default("relevance")
      }
    },
    createNormalizedPostToolHandler(apiClient, "/activities/search", normalizeActivitySearchInput)
  );

  registerReadOnlyTool(
    server,
    "recallx_search_workspace",
    {
      title: "Search Workspace",
      description:
        "Search nodes, activities, or both through one workspace-wide endpoint. This is the preferred broad entry point when the target node or request shape is still unclear, or when you need both node and activity recall in the current workspace. Use `scopes` as an array such as `[\"nodes\", \"activities\"]`, or use `scope: \"activities\"` for a single scope. Do not pass a comma-separated string like `\"nodes,activities\"`.",
      inputSchema: {
        query: z.string().default("").describe("Keyword or phrase query."),
        allowEmptyQuery: coerceBooleanSchema(false).describe("Set true to browse mixed recent results without a query."),
        scope: workspaceScopeInputSchema.optional().describe("Alias for scopes. Use a single scope like `activities`, not a comma-separated string."),
        scopes: workspaceScopeInputSchema.optional().describe("Array of scopes such as `[\"nodes\", \"activities\"]`."),
        nodeFilters: z
          .object({
            types: stringOrStringArraySchema.optional(),
            status: stringOrStringArraySchema.optional(),
            sourceLabels: stringOrStringArraySchema.optional(),
            tags: stringOrStringArraySchema.optional()
          })
          .optional(),
        activityFilters: z
          .object({
            targetNodeIds: stringOrStringArraySchema.optional(),
            activityTypes: stringOrStringArraySchema.optional(),
            sourceLabels: stringOrStringArraySchema.optional(),
            createdAfter: z.string().optional(),
            createdBefore: z.string().optional()
          })
          .optional(),
        limit: coerceIntegerSchema(10, 1, 100),
        offset: coerceIntegerSchema(0, 0, 10_000),
        sort: z.enum(["relevance", "updated_at", "smart"]).default("relevance")
      }
    },
    createNormalizedPostToolHandler(apiClient, "/search", normalizeWorkspaceSearchInput)
  );

  registerReadOnlyTool(
    server,
    "recallx_get_node",
    {
      title: "Get Node",
      description: "Fetch a node together with its related nodes, activities, artifacts, and provenance.",
      inputSchema: {
        nodeId: z.string().min(1).describe("Target node id.")
      }
    },
    async ({ nodeId }) => toolResult(await apiClient.get(`/nodes/${encodeURIComponent(nodeId)}`))
  );

  registerReadOnlyTool(
    server,
    "recallx_get_related",
    {
      title: "Get Node Neighborhood",
      description: "Fetch the canonical RecallX node neighborhood with optional inferred relations.",
      inputSchema: {
        nodeId: z.string().min(1).describe("Target node id."),
        depth: coerceIntegerSchema(1, 1, 1),
        relationTypes: z.array(z.enum(relationTypes)).default([]),
        includeInferred: coerceBooleanSchema(true),
        maxInferred: coerceIntegerSchema(4, 0, 10)
      }
    },
    async ({ nodeId, depth, relationTypes: relationTypeFilter, includeInferred, maxInferred }) => {
      const query = new URLSearchParams({
        depth: String(depth),
        include_inferred: includeInferred ? "1" : "0",
        max_inferred: String(maxInferred)
      });
      if (relationTypeFilter.length) {
        query.set("types", relationTypeFilter.join(","));
      }
      return toolResult(await apiClient.get(`/nodes/${encodeURIComponent(nodeId)}/neighborhood?${query.toString()}`));
    }
  );

  registerTool(
    server,
    "recallx_upsert_inferred_relation",
    {
      title: "Upsert Inferred Relation",
      description: "Upsert a lightweight inferred relation for retrieval, graph expansion, and later weight adjustment.",
      inputSchema: {
        fromNodeId: z.string().min(1),
        toNodeId: z.string().min(1),
        relationType: z.enum(relationTypes),
        baseScore: z.number(),
        usageScore: z.number().default(0),
        finalScore: z.number(),
        status: z.enum(inferredRelationStatuses).default("active"),
        generator: z.string().min(1).describe("Short generator label such as deterministic-linker or coaccess-pass."),
        evidence: jsonRecordSchema,
        expiresAt: z.string().optional(),
        metadata: jsonRecordSchema
      }
    },
    createPostToolHandler(apiClient, "/inferred-relations")
  );

  registerTool(
    server,
    "recallx_append_relation_usage_event",
    {
      title: "Append Relation Usage Event",
      description: "Append a lightweight usage signal after a relation actually helped retrieval or final output.",
      inputSchema: {
        relationId: z.string().min(1),
        relationSource: z.enum(relationSources),
        eventType: z.enum(relationUsageEventTypes),
        sessionId: z.string().optional(),
        runId: z.string().optional(),
        source: sourceSchema.optional(),
        delta: z.number(),
        metadata: jsonRecordSchema
      }
    },
    createPostToolHandler(apiClient, "/relation-usage-events")
  );

  registerTool(
    server,
    "recallx_append_search_feedback",
    {
      title: "Append Search Feedback",
      description: "Append a usefulness signal for a node or activity search result after it helped or failed a task.",
      inputSchema: {
        resultType: z.enum(searchFeedbackResultTypes),
        resultId: z.string().min(1),
        verdict: z.enum(searchFeedbackVerdicts),
        query: z.string().optional(),
        sessionId: z.string().optional(),
        runId: z.string().optional(),
        source: sourceSchema.optional(),
        confidence: z.number().min(0).max(1).default(1),
        metadata: jsonRecordSchema
      }
    },
    createPostToolHandler(apiClient, "/search-feedback-events")
  );

  registerTool(
    server,
    "recallx_recompute_inferred_relations",
    {
      title: "Recompute Inferred Relations",
      description: "Run an explicit maintenance pass that refreshes inferred relation usage_score and final_score from usage events.",
      inputSchema: {
        relationIds: z.array(z.string().min(1)).max(200).optional(),
        generator: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    createPostToolHandler(apiClient, "/inferred-relations/recompute")
  );

  registerTool(
    server,
    "recallx_append_activity",
    {
      title: "Append Activity",
      description:
        "Append an activity entry to a specific RecallX node or project timeline with provenance. Use this when you already know the target node or project; otherwise prefer recallx_capture_memory for general workspace-scope updates.",
      inputSchema: {
        targetNodeId: z.string().min(1).describe("Target node id."),
        activityType: z.enum(activityTypes),
        body: z.string().default(""),
        source: sourceSchema,
        metadata: jsonRecordSchema
      }
    },
    createPostToolHandler(apiClient, "/activities")
  );

  registerTool(
    server,
    "recallx_capture_memory",
    {
      title: "Capture Memory",
      description:
        "Safely capture a memory item without choosing low-level storage first. Prefer this as the default write only when the conversation is not yet tied to a specific project or node. Once a project or target node is known, include targetNodeId or switch to recallx_append_activity for routine work logs. General short logs can stay at workspace scope and be auto-routed into activities, while reusable content can still land as durable memory.",
      inputSchema: {
        mode: z.enum(captureModes).default("auto"),
        body: z.string().min(1),
        title: z.string().min(1).optional(),
        targetNodeId: z.string().min(1).optional().describe("Optional target node for activity capture."),
        nodeType: z.enum(nodeTypes).default("note"),
        tags: z.array(z.string()).default([]),
        source: sourceSchema,
        metadata: jsonRecordSchema
      }
    },
    createPostToolHandler(apiClient, "/capture")
  );

  registerTool(
    server,
    "recallx_create_node",
    {
      title: "Create Node",
      description:
        "Create a durable RecallX node with provenance. Use this for reusable knowledge; when creating a project node in the current workspace, search first and only create one if no suitable project already exists. Short work-log updates are usually better captured with `recallx_capture_memory` or `recallx_append_activity`.",
      inputSchema: {
        type: z.enum(nodeTypes),
        title: z.string().min(1),
        body: z.string().default(""),
        summary: z.string().optional(),
        tags: z.array(z.string()).default([]),
        canonicality: z.enum(canonicalities).optional(),
        status: z.enum(nodeStatuses).optional(),
        source: sourceSchema,
        metadata: jsonRecordSchema
      }
    },
    async (input: Record<string, unknown>) => {
      try {
        return toolResult(await apiClient.post<Record<string, unknown>>("/nodes", input));
      } catch (error) {
        if (
          error instanceof RecallXApiError &&
          error.code === "FORBIDDEN" &&
          error.message.includes("Short log-like agent output")
        ) {
          const redirectError = new Error(
            `${error.message} Hint: use recallx_capture_memory with mode=auto or mode=activity instead.`
          ) as Error & { code?: string };
          redirectError.code = "SHORT_LOG_REDIRECT";
          throw redirectError;
        }
        throw error;
      }
    }
  );

  registerTool(
    server,
    "recallx_create_nodes",
    {
      title: "Create Nodes",
      description:
        "Create multiple durable RecallX nodes with provenance. This batch endpoint allows partial success and returns per-item landing or error details.",
      inputSchema: {
        nodes: z
          .array(
            z.object({
              type: z.enum(nodeTypes),
              title: z.string().min(1),
              body: z.string().default(""),
              summary: z.string().optional(),
              tags: z.array(z.string()).default([]),
              canonicality: z.enum(canonicalities).optional(),
              status: z.enum(nodeStatuses).optional(),
              source: sourceSchema,
              metadata: jsonRecordSchema
            })
          )
          .min(1)
          .max(100)
      }
    },
    async (input: Record<string, unknown>) => toolResult(await apiClient.post<Record<string, unknown>>("/nodes/batch", input))
  );

  registerTool(
    server,
    "recallx_create_relation",
    {
      title: "Create Relation",
      description: "Create a relation between two nodes. Agent-created relations typically start suggested and are promoted automatically when confidence improves.",
      inputSchema: {
        fromNodeId: z.string().min(1),
        toNodeId: z.string().min(1),
        relationType: z.enum(relationTypes),
        status: z.enum(relationStatuses).optional(),
        source: sourceSchema,
        metadata: jsonRecordSchema
      }
    },
    createPostToolHandler(apiClient, "/relations")
  );

  registerReadOnlyTool(
    server,
    "recallx_list_governance_issues",
    {
      title: "List Governance Issues",
      description: "List contested or low-confidence governance items that may need inspection.",
      inputSchema: {
        states: z.array(z.enum(governanceStates)).default(["contested", "low_confidence"]),
        limit: z.number().int().min(1).max(100).default(20)
      }
    },
    async ({ states, limit }) => {
      const query = new URLSearchParams({
        states: states.join(","),
        limit: String(limit)
      });
      return toolResult(await apiClient.get(`/governance/issues?${query.toString()}`));
    }
  );

  registerReadOnlyTool(
    server,
    "recallx_get_governance_state",
    {
      title: "Get Governance State",
      description: "Read the current automatic governance state and recent events for a node or relation.",
      inputSchema: {
        entityType: z.enum(["node", "relation"]),
        entityId: z.string().min(1)
      }
    },
    async ({ entityType, entityId }) =>
      toolResult(await apiClient.get(`/governance/state/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`))
  );

  registerTool(
    server,
    "recallx_recompute_governance",
    {
      title: "Recompute Governance",
      description: "Run a bounded automatic governance recompute pass for nodes, relations, or both.",
      inputSchema: {
        entityType: z.enum(["node", "relation"]).optional(),
        entityIds: z.array(z.string().min(1)).max(200).optional(),
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    createPostToolHandler(apiClient, "/governance/recompute")
  );

  registerReadOnlyTool(
    server,
    "recallx_context_bundle",
    {
      title: "Build Context Bundle",
      description:
        "Build a compact RecallX context bundle for coding, research, writing, or decision support. Omit targetId to get a workspace-entry bundle when the work is not yet tied to a specific project or node, and add targetId only after you know which project or node should anchor the context.",
      inputSchema: {
        targetId: z.string().min(1).optional(),
        mode: z.enum(bundleModes).default("compact"),
        preset: z.enum(bundlePresets).default("for-assistant"),
        options: z
          .object({
            includeRelated: coerceBooleanSchema(true),
            includeInferred: coerceBooleanSchema(true),
            includeRecentActivities: coerceBooleanSchema(true),
            includeDecisions: coerceBooleanSchema(true),
            includeOpenQuestions: coerceBooleanSchema(true),
            maxInferred: coerceIntegerSchema(4, 0, 10),
            maxItems: coerceIntegerSchema(10, 1, 30)
          })
          .default({
            includeRelated: true,
            includeInferred: true,
            includeRecentActivities: true,
            includeDecisions: true,
            includeOpenQuestions: true,
            maxInferred: 4,
            maxItems: 10
          })
      }
    },
    async ({ targetId, ...input }) =>
      toolResult(
        await apiClient.post("/context/bundles", {
          ...input,
          ...(targetId
            ? {
                target: {
                  id: targetId
                }
              }
            : {})
        })
      )
  );

  registerTool(
    server,
    "recallx_semantic_reindex",
    {
      title: "Queue Semantic Reindex",
      description: "Queue semantic reindexing for a bounded set of recent active workspace nodes.",
      inputSchema: {
        limit: coerceIntegerSchema(250, 1, 1000)
      }
    },
    createPostToolHandler(apiClient, "/semantic/reindex")
  );

  registerTool(
    server,
    "recallx_semantic_reindex_node",
    {
      title: "Queue Node Semantic Reindex",
      description: "Queue semantic reindexing for a specific node id.",
      inputSchema: {
        nodeId: z.string().min(1)
      }
    },
    async ({ nodeId }) => toolResult(await apiClient.post(`/semantic/reindex/${encodeURIComponent(nodeId)}`, {}))
  );

  registerReadOnlyTool(
    server,
    "recallx_rank_candidates",
    {
      title: "Rank Candidate Nodes",
      description: "Rank a bounded set of candidate node ids for a target using RecallX request-time retrieval scoring.",
      inputSchema: {
        query: z.string().default(""),
        candidateNodeIds: z.array(z.string().min(1)).min(1).max(100),
        preset: z.enum(bundlePresets).default("for-assistant"),
        targetNodeId: z.string().optional()
      }
    },
    createPostToolHandler(apiClient, "/retrieval/rank-candidates")
  );

  return server;
}
