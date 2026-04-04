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
  normalizeBundleMode,
  normalizeBundlePreset,
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

type JsonRecord = Record<string, unknown>;
const textSummaryItemLimit = 5;
const textSummaryLength = 140;
const textTitleLength = 80;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanInlineText(value: string, maxLength = textSummaryLength) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatKeyLabel(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function capitalize(value: string) {
  return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function pickString(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}

function summarizeValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return cleanInlineText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} item(s)`;
  }
  if (isRecord(value)) {
    const title = pickString(value, ["title", "name", "id", "nodeId"]);
    if (title) {
      return cleanInlineText(title);
    }
    return `${Object.keys(value).length} field(s)`;
  }
  return undefined;
}

function unwrapSummaryRecord(record: JsonRecord) {
  const resultType = typeof record.resultType === "string" ? record.resultType : undefined;
  if (resultType && isRecord(record[resultType])) {
    const nested = record[resultType] as JsonRecord;
    return {
      kind:
        (resultType === "activity" ? pickString(nested, ["activityType"]) : undefined) ??
        (resultType === "node" ? pickString(nested, ["type"]) : undefined) ??
        resultType,
      value: nested
    };
  }
  if (isRecord(record.node)) {
    return {
      kind: resultType ?? "node",
      value: record.node
    };
  }
  if (isRecord(record.activity)) {
    return {
      kind: resultType ?? "activity",
      value: record.activity
    };
  }
  return {
    kind:
      pickString(record, ["type", "activityType", "status"]) ??
      (typeof record.resultType === "string" ? record.resultType : undefined),
    value: record
  };
}

function summarizeRecordLine(record: JsonRecord, index: number) {
  const { kind, value } = unwrapSummaryRecord(record);
  const title = pickString(value, ["title", "targetNodeTitle", "name", "workspaceName", "rootPath", "id", "nodeId"]);
  const identifier = pickString(value, ["id", "nodeId", "targetNodeId"]);
  const detail = pickString(value, ["summary", "reason", "body", "message", "staleReason", "workspaceRoot"]);
  const parts = [`${index}.`];

  if (kind) {
    parts.push(`[${kind}]`);
  }
  if (title) {
    parts.push(cleanInlineText(title, textTitleLength));
  }
  if (identifier && identifier !== title) {
    parts.push(`(id: ${cleanInlineText(identifier, textTitleLength)})`);
  }

  let line = parts.join(" ");
  if (detail) {
    line += ` - ${cleanInlineText(detail)}`;
  }
  return line;
}

function formatItemsSummary(payload: JsonRecord) {
  const rawItems = payload.items;
  if (!Array.isArray(rawItems)) {
    return null;
  }

  const items = rawItems.filter(isRecord);
  const shown = Math.min(items.length, textSummaryItemLimit);
  const total = typeof payload.total === "number" ? payload.total : items.length;
  const lines = [`Results: ${shown} shown of ${total} total.`];

  if (!items.length) {
    lines.push("No results.");
  } else {
    for (const [index, item] of items.slice(0, textSummaryItemLimit).entries()) {
      lines.push(summarizeRecordLine(item, index + 1));
    }
  }

  if (total > shown) {
    lines.push(`More available: ${total - shown} additional result(s).`);
  } else if (items.length > shown) {
    lines.push(`More available: ${items.length - shown} additional item(s).`);
  }

  if (typeof payload.nextCursor === "string" && payload.nextCursor.trim()) {
    lines.push(`Next cursor: ${cleanInlineText(payload.nextCursor, textTitleLength)}`);
  }

  return lines.join("\n");
}

function formatBundleSummary(payload: JsonRecord) {
  const bundle = isRecord(payload.bundle) ? payload.bundle : payload;
  if (!isRecord(payload.bundle) && !isRecord(bundle.target)) {
    return null;
  }

  const target = isRecord(bundle.target) ? bundle.target : null;
  const type = target ? pickString(target, ["type"]) : undefined;
  const mode = pickString(bundle, ["mode"]);
  const preset = pickString(bundle, ["preset"]);
  const summary = pickString(bundle, ["summary"]);
  const items = Array.isArray(bundle.items) ? bundle.items.filter(isRecord) : [];
  const decisions = Array.isArray(bundle.decisions) ? bundle.decisions : [];
  const openQuestions = Array.isArray(bundle.openQuestions) ? bundle.openQuestions : [];
  const activityDigest = Array.isArray(bundle.activityDigest) ? bundle.activityDigest : [];
  const lines = [`Context bundle: Target${type ? ` [${type}]` : ""}.`];

  if (mode || preset) {
    lines.push(`Mode: ${[mode, preset].filter(Boolean).join(", ")}.`);
  }
  if (summary) {
    lines.push(`Summary: ${cleanInlineText(summary)}`);
  }

  lines.push(`Items: ${items.length}.`);
  for (const [index, item] of items.slice(0, textSummaryItemLimit).entries()) {
    lines.push(summarizeRecordLine(item, index + 1));
  }
  if (items.length > textSummaryItemLimit) {
    lines.push(`More bundle items: ${items.length - textSummaryItemLimit}.`);
  }
  if (activityDigest.length) {
    lines.push(`Activity digest: ${activityDigest.length} entr${activityDigest.length === 1 ? "y" : "ies"}.`);
  }
  if (decisions.length) {
    lines.push(`Decisions: ${decisions.length}.`);
  }
  if (openQuestions.length) {
    lines.push(`Open questions: ${openQuestions.length}.`);
  }

  return lines.join("\n");
}

function formatWriteSummary(payload: JsonRecord) {
  const primaryKey = ["node", "activity", "relation"].find((key) => isRecord(payload[key]));
  if (!primaryKey && !isRecord(payload.landing)) {
    return null;
  }

  const lines: string[] = [];
  if (primaryKey && isRecord(payload[primaryKey])) {
    lines.push(`${capitalize(primaryKey)} stored: ${summarizeRecordLine(payload[primaryKey], 1).replace(/^1\.\s*/, "")}`);
  }

  if (isRecord(payload.landing)) {
    const landing = payload.landing;
    const parts = [
      typeof landing.storedAs === "string" ? `storedAs=${landing.storedAs}` : null,
      typeof landing.canonicality === "string" ? `canonicality=${landing.canonicality}` : null,
      typeof landing.status === "string" ? `status=${landing.status}` : null,
      typeof landing.governanceState === "string" ? `governance=${landing.governanceState}` : null
    ].filter((value): value is string => Boolean(value));

    if (parts.length) {
      lines.push(`Landing: ${parts.join(", ")}.`);
    }
    if (typeof landing.reason === "string" && landing.reason.trim()) {
      lines.push(`Reason: ${cleanInlineText(landing.reason)}`);
    }
  }

  return lines.length ? lines.join("\n") : null;
}

function formatObjectSummary(payload: JsonRecord) {
  const preferredKeys = [
    "status",
    "message",
    "workspaceName",
    "workspaceRoot",
    "rootPath",
    "schemaVersion",
    "authMode",
    "bindAddress",
    "queued",
    "queuedCount",
    "nodeId",
    "id",
    "title",
    "type",
    "summary",
    "reason",
    "nextCursor"
  ];
  const orderedKeys = Array.from(
    new Set([...preferredKeys.filter((key) => key in payload), ...Object.keys(payload).filter((key) => !preferredKeys.includes(key))])
  );
  const lines: string[] = [];

  for (const key of orderedKeys) {
    const summary = summarizeValue(payload[key]);
    if (!summary) {
      continue;
    }
    lines.push(`${formatKeyLabel(key)}: ${summary}`);
    if (lines.length >= 8) {
      break;
    }
  }

  return lines.length ? lines.join("\n") : "Structured response returned.";
}

function formatArraySummary(items: unknown[]) {
  const recordItems = items.filter(isRecord);
  if (!recordItems.length) {
    return `Items: ${items.length}.`;
  }
  const lines = [`Items: ${recordItems.length}.`];
  for (const [index, item] of recordItems.slice(0, textSummaryItemLimit).entries()) {
    lines.push(summarizeRecordLine(item, index + 1));
  }
  if (recordItems.length > textSummaryItemLimit) {
    lines.push(`More available: ${recordItems.length - textSummaryItemLimit} additional item(s).`);
  }
  return lines.join("\n");
}

function formatStructuredContent(content: unknown) {
  if (Array.isArray(content)) {
    return formatArraySummary(content);
  }
  if (isRecord(content)) {
    return formatBundleSummary(content) ?? formatItemsSummary(content) ?? formatWriteSummary(content) ?? formatObjectSummary(content);
  }
  if (typeof content === "string" && content.trim()) {
    return cleanInlineText(content);
  }
  if (typeof content === "number" || typeof content === "boolean") {
    return String(content);
  }
  return "Structured response returned.";
}

function renderToolText(_toolName: string, structuredContent: unknown) {
  return formatStructuredContent(structuredContent);
}

function formatInvalidBundleModeMessage(input: unknown) {
  const quotedInput = typeof input === "string" && input.trim() ? `'${input}'` : "that value";
  return `Unsupported mode ${quotedInput}. Use one of ${bundleModes.join(", ")}. Common aliases also work: small -> micro, concise -> compact, normal -> standard, full -> deep.`;
}

function formatInvalidBundlePresetMessage(input: unknown) {
  const quotedInput = typeof input === "string" && input.trim() ? `'${input}'` : "that value";
  return `Unsupported preset ${quotedInput}. Use one of ${bundlePresets.join(", ")}. Common aliases also work: coding -> for-coding, assistant/default -> for-assistant.`;
}

function bundleModeSchema(defaultValue: (typeof bundleModes)[number]) {
  return z.preprocess(
    normalizeBundleMode,
    z.enum(bundleModes, {
      error: (issue) => formatInvalidBundleModeMessage(issue.input)
    })
  ).default(defaultValue);
}

function bundlePresetSchema(defaultValue: (typeof bundlePresets)[number]) {
  return z.preprocess(
    normalizeBundlePreset,
    z.enum(bundlePresets, {
      error: (issue) => formatInvalidBundlePresetMessage(issue.input)
    })
  ).default(defaultValue);
}

function toolResult<T>(toolName: string, structuredContent: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: renderToolText(toolName, structuredContent)
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

function createGetToolHandler<T = Record<string, unknown>>(toolName: string, apiClient: Pick<RecallXApiClient, "get">, path: string) {
  return async () => toolResult(toolName, await apiClient.get<T>(path));
}

function createPostToolHandler(toolName: string, apiClient: Pick<RecallXApiClient, "post">, path: string) {
  return async (input: Record<string, unknown>) => toolResult(toolName, await apiClient.post<Record<string, unknown>>(path, input));
}

function createNormalizedPostToolHandler<TInput extends Record<string, unknown>>(
  toolName: string,
  apiClient: Pick<RecallXApiClient, "post">,
  path: string,
  normalize: (input: TInput) => Record<string, unknown>
) {
  return async (input: TInput) => toolResult(toolName, await apiClient.post<Record<string, unknown>>(path, normalize(input)));
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
    slowRequestMs: 50,
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

  // Session-level feedback tracking for automatic signal collection.
  // Tracks which node IDs appeared in read results so that after a write we can
  // auto-append search/relation feedback for items that were actually useful.
  const sessionFeedback = {
    recentSearches: [] as Array<{ query: string; resultIds: string[]; resultType: string }>,
    recentBundles: [] as Array<{ targetId?: string; itemIds: string[] }>,
    runId: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    trackSearch(query: string, resultIds: string[], resultType: string) {
      this.recentSearches.push({ query, resultIds, resultType });
      if (this.recentSearches.length > 50) this.recentSearches.shift();
    },
    trackBundle(targetId: string | undefined, itemIds: string[]) {
      this.recentBundles.push({ targetId, itemIds });
      if (this.recentBundles.length > 50) this.recentBundles.shift();
    }
  };

  /**
   * Try to auto-append feedback for search results that led to successful reads.
   * Called after a successful write tool (create_node, append_activity, capture_memory).
   */
  async function autoAppendSearchFeedback() {
    // Only append for the most recent search that had results. Avoid spam by
    // checking if we already appended feedback for the same search in this session.
    const lastSearch = sessionFeedback.recentSearches.at(-1);
    if (!lastSearch || !lastSearch.resultIds.length) return;
    try {
      await apiClient.post("/search-feedback-events", {
        resultType: lastSearch.resultType as "node" | "activity",
        resultId: lastSearch.resultIds[0],
        verdict: "useful" as const,
        query: lastSearch.query,
        sessionId: sessionFeedback.runId,
        confidence: 0.7
      });
      // Remove the search so we don't append again for the same search.
      sessionFeedback.recentSearches.pop();
    } catch {
      // Feedback append is best-effort — don't break the main tool call.
    }
  }

  const server = new McpServer(
    {
      name: "recallx-mcp",
      version: params?.serverVersion ?? RECALLX_VERSION
    },
    {
      instructions:
        "Use RecallX as the default local memory layer for meaningful work, not as an afterthought. Treat the current workspace as the default scope, and do not create or open another workspace unless the user explicitly asks. Before making assumptions or starting a meaningful task, read context first: confirm the active workspace, use recallx_search_workspace as the broad default when the target is still unclear, narrow with recallx_search_nodes or recallx_search_activities when needed, and build a compact recallx_context_bundle before deep execution when a node or project is known. When the work is clearly project-shaped, search for an existing project inside the current workspace first, create one only if no suitable project exists, and then anchor follow-up context and routine logs to that project. Once a project is known, do not keep writing untargeted workspace captures for routine work logs: append activity to that project or pass targetNodeId on capture writes. Reserve workspace-scope inbox activity for genuinely untargeted, cross-project, or not-yet-classified short logs. Prefer read tools before durable writes, prefer compact context over repeated broad browsing, and write back concise summaries, decisions, or feedback when RecallX materially helped the task. Include source details on durable writes when you want caller-specific provenance. Feedback signals (search usefulness, relation usefulness) are automatically recorded on your behalf — you do NOT need to call feedback tools manually.",
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
    async () => toolResult("recallx_health", await apiClient.get<Record<string, unknown>>("/health"))
  );

  registerReadOnlyTool(
    server,
    "recallx_workspace_info",
    {
      title: "Workspace Information",
      description:
        "Read the active RecallX workspace and optionally list all known workspaces in one call. **When to use:** at the start of any task to confirm scope. Do not create or open another workspace unless the user explicitly asks.",
      inputSchema: {
        includeList: coerceBooleanSchema(false).describe("Set true to also return all known workspaces alongside the active one.")
      },
      outputSchema: z.object({
        current: workspaceInfoSchema,
        items: z.array(workspaceInfoSchema.extend({ isCurrent: z.boolean(), lastOpenedAt: z.string() })).optional()
      })
    },
    async ({ includeList }) => {
      const current = await apiClient.get<Record<string, unknown>>("/workspace");
      const result: { current: JsonRecord; items?: JsonRecord[] } = { current: current as JsonRecord };
      if (includeList) {
        const list = await apiClient.get<Record<string, unknown>>("/workspaces");
        result.items = (list.items ?? []) as JsonRecord[];
      }
      return toolResult("recallx_workspace_info", result);
    }
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
    createPostToolHandler("recallx_workspace_create", apiClient, "/workspaces")
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
    createPostToolHandler("recallx_workspace_open", apiClient, "/workspaces/open")
  );

  registerReadOnlyTool(
    server,
    "recallx_semantic_overview",
    {
      title: "Semantic Overview",
      description:
        "Read semantic index status, counts, and optionally active issues in one call. **When to use:** during workspace health checks or when search results seem unexpectedly stale. Not needed for routine coding tasks.",
      inputSchema: {
        includeIssues: coerceBooleanSchema(false).describe("Set true to also return recent semantic indexing issues."),
        issueLimit: coerceIntegerSchema(5, 1, 25).describe("Max issue items when includeIssues is true."),
        issueStatuses: z.array(z.enum(["pending", "stale", "failed"])).max(3).optional().describe("Issue statuses to include.")
      },
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
        }),
        issues: z.array(
          z.object({
            nodeId: z.string(),
            title: z.string().nullable(),
            embeddingStatus: z.enum(["pending", "processing", "stale", "ready", "failed"]),
            staleReason: z.string().nullable(),
            updatedAt: z.string()
          })
        ).optional(),
        nextCursor: z.string().nullable().optional()
      })
    },
    async ({ includeIssues, issueLimit, issueStatuses }) => {
      const status = await apiClient.get<Record<string, unknown>>("/semantic/status");
      const result: JsonRecord = { ...status };
      if (includeIssues) {
        const params = new URLSearchParams();
        params.set("limit", String(issueLimit));
        if (issueStatuses?.length) {
          params.set("statuses", issueStatuses.join(","));
        }
        const issuesPayload = await apiClient.get<Record<string, unknown>>(`/semantic/issues?${params.toString()}`);
        result.issues = (issuesPayload.items ?? []) as JsonRecord[];
        result.nextCursor = typeof issuesPayload.nextCursor === "string" ? issuesPayload.nextCursor : null;
      }
      return toolResult("recallx_semantic_overview", result);
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
    async (input) => {
      const result = await apiClient.post<Record<string, unknown>>("/nodes/search", normalizeNodeSearchInput(input));
      const items = Array.isArray((result as any).items) ? (result as any).items : [];
      const ids = items.filter((item: JsonRecord) => isRecord(item) && typeof item.id === "string").map((item: JsonRecord) => item.id);
      const query = typeof input.query === "string" ? input.query : "";
      sessionFeedback.trackSearch(query, ids, "node");
      return toolResult("recallx_search_nodes", result);
    }
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
    async (input) => {
      const result = await apiClient.post<Record<string, unknown>>("/activities/search", normalizeActivitySearchInput(input));
      const items = Array.isArray((result as any).items) ? (result as any).items : [];
      const ids = items.filter((item: JsonRecord) => isRecord(item) && typeof item.id === "string").map((item: JsonRecord) => item.id);
      const query = typeof input.query === "string" ? input.query : "";
      sessionFeedback.trackSearch(query, ids, "activity");
      return toolResult("recallx_search_activities", result);
    }
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
    async (input) => {
      const result = await apiClient.post<Record<string, unknown>>("/search", normalizeWorkspaceSearchInput(input));
      const items = Array.isArray((result as any).items) ? (result as any).items : [];
      const ids = items.filter((item: JsonRecord) => isRecord(item) && typeof (item.id ?? item.nodeId) === "string").map((item: JsonRecord) => (item.id ?? item.nodeId) as string);
      const mixedTypes = [...new Set(items.filter((item: JsonRecord) => isRecord(item) && typeof item.type === "string").map((item: JsonRecord) => item.type))] as string[];
      const query = typeof input.query === "string" ? input.query : "";
      sessionFeedback.trackSearch(query, ids, `mixed(${mixedTypes.join(",") || "unknown"})`);
      return toolResult("recallx_search_workspace", result);
    }
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
    async ({ nodeId }) => toolResult("recallx_get_node", await apiClient.get(`/nodes/${encodeURIComponent(nodeId)}`))
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
      return toolResult("recallx_get_related", await apiClient.get(`/nodes/${encodeURIComponent(nodeId)}/neighborhood?${query.toString()}`));
    }
  );

  registerTool(
    server,
    "recallx_manage_inferred_relations",
    {
      title: "Manage Inferred Relations",
      description:
        "Create or update inferred relations, or trigger a maintenance recompute pass. Use `action='upsert'` to add/update a single relation; use `action='recompute'` to refresh scores from usage events. **When to use:** only when you have strong evidence that two nodes are related and the system has not already inferred it (upsert), or during maintenance workflows (recompute). For routine tasks, prefer `recallx_get_related` to read existing inferred links.",
      inputSchema: {
        action: z.enum(["upsert", "recompute"]).describe("Whether to upsert a single inferred relation or trigger a recompute pass."),
        fromNodeId: z.string().min(1).optional().describe("Source node for upsert action."),
        toNodeId: z.string().min(1).optional().describe("Target node for upsert action."),
        relationType: z.enum(relationTypes).optional().describe("Relation type for upsert."),
        baseScore: z.number().optional().describe("Base confidence score for upsert."),
        usageScore: z.number().default(0).describe("Usage bonus for upsert."),
        finalScore: z.number().optional().describe("Combined score for upsert."),
        status: z.enum(inferredRelationStatuses).default("active"),
        generator: z.string().min(1).optional().describe("Generator label for upsert or filter for recompute."),
        evidence: jsonRecordSchema,
        expiresAt: z.string().optional(),
        metadata: jsonRecordSchema,
        relationIds: z.array(z.string().min(1)).max(200).optional().describe("Specific relation IDs to recompute."),
        limit: z.number().int().min(1).max(500).default(100).describe("Max relations for recompute pass.")
      }
    },
    async (input) => {
      if (input.action === "upsert") {
        if (!input.fromNodeId || !input.toNodeId || !input.relationType || input.baseScore === undefined || input.finalScore === undefined) {
          throw new Error("Invalid arguments for tool recallx_manage_inferred_relations: action='upsert' requires fromNodeId, toNodeId, relationType, baseScore, and finalScore.");
        }
        const body: Record<string, unknown> = {
          fromNodeId: input.fromNodeId,
          toNodeId: input.toNodeId,
          relationType: input.relationType,
          baseScore: input.baseScore,
          usageScore: input.usageScore,
          finalScore: input.finalScore,
          status: input.status,
          generator: input.generator,
          evidence: input.evidence,
          expiresAt: input.expiresAt,
          metadata: input.metadata
        };
        return toolResult("recallx_manage_inferred_relations", await apiClient.post<Record<string, unknown>>("/inferred-relations", body));
      }
      const body: Record<string, unknown> = { limit: input.limit };
      if (input.relationIds?.length) body.relationIds = input.relationIds;
      if (input.generator) body.generator = input.generator;
      return toolResult("recallx_manage_inferred_relations", await apiClient.post<Record<string, unknown>>("/inferred-relations/recompute", body));
    }
  );

  registerTool(
    server,
    "recallx_append_feedback",
    {
      title: "Append Feedback",
      description:
        "Append a usefulness signal for search results or relation links. **Note:** this tool is normally called automatically by the MCP bridge after your task completes. Only call it directly if you want to record ad-hoc feedback during a session.",
      inputSchema: {
        feedbackType: z.enum(["search", "relation"]).describe("Whether this is search result feedback or relation usage feedback."),
        resultType: z.enum(searchFeedbackResultTypes).optional().describe("Required when feedbackType='search': 'node' or 'activity'."),
        resultId: z.string().min(1).optional().describe("Required when feedbackType='search': the node or activity ID."),
        verdict: z.enum(searchFeedbackVerdicts).optional().describe("Required when feedbackType='search': 'useful', 'not_useful', or 'uncertain'."),
        relationId: z.string().min(1).optional().describe("Required when feedbackType='relation': the relation ID."),
        relationSource: z.enum(relationSources).optional().describe("Required when feedbackType='relation': 'canonical' or 'inferred'."),
        relationEventType: z.enum(relationUsageEventTypes).optional().describe("Required when feedbackType='relation': e.g. 'bundle_included', 'bundle_used_in_output'."),
        query: z.string().optional().describe("Original search query for context."),
        sessionId: z.string().optional(),
        runId: z.string().optional(),
        source: sourceSchema.optional(),
        confidence: z.number().min(0).max(1).default(1),
        delta: z.number().default(1).describe("Score delta for relation feedback."),
        metadata: jsonRecordSchema
      }
    },
    async (input) => {
      if (input.feedbackType === "search") {
        if (!input.resultType || !input.resultId || !input.verdict) {
          throw new Error("Invalid arguments for tool recallx_append_feedback: feedbackType='search' requires resultType, resultId, and verdict.");
        }
        return toolResult("recallx_append_feedback", await apiClient.post<Record<string, unknown>>("/search-feedback-events", {
          resultType: input.resultType,
          resultId: input.resultId,
          verdict: input.verdict,
          query: input.query,
          sessionId: input.sessionId,
          runId: input.runId,
          source: input.source,
          confidence: input.confidence,
          metadata: input.metadata
        }));
      }
      if (!input.relationId || !input.relationSource || !input.relationEventType) {
        throw new Error("Invalid arguments for tool recallx_append_feedback: feedbackType='relation' requires relationId, relationSource, and relationEventType.");
      }
      return toolResult("recallx_append_feedback", await apiClient.post<Record<string, unknown>>("/relation-usage-events", {
        relationId: input.relationId,
        relationSource: input.relationSource,
        eventType: input.relationEventType,
        sessionId: input.sessionId,
        runId: input.runId,
        source: input.source,
        delta: input.delta,
        metadata: input.metadata
      }));
    }
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
    createPostToolHandler("recallx_append_activity", apiClient, "/activities")
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
    createPostToolHandler("recallx_capture_memory", apiClient, "/capture")
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
        const result = await apiClient.post<Record<string, unknown>>("/nodes", input);
        await autoAppendSearchFeedback();
        return toolResult("recallx_create_node", result);
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
    async (input: Record<string, unknown>) => {
      const result = await apiClient.post<Record<string, unknown>>("/nodes/batch", input);
      await autoAppendSearchFeedback();
      return toolResult("recallx_create_nodes", result);
    }
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
    createPostToolHandler("recallx_create_relation", apiClient, "/relations")
  );

  registerReadOnlyTool(
    server,
    "recallx_governance",
    {
      title: "Governance",
      description:
        "Read governance issues, check a specific entity's state, or trigger a recompute pass. **When to use:** after creating/editing content to verify it landed in good shape, or when reviewing items flagged as contested/low_confidence. Use action='issues' (default) to list problems, action='state' to inspect one entity, or action='recompute' to refresh state.",
      inputSchema: {
        action: z.enum(["issues", "state", "recompute"]).default("issues"),
        states: z.array(z.enum(governanceStates)).default(["contested", "low_confidence"]).describe("Issue states to include (for action='issues')."),
        limit: z.number().int().min(1).max(100).default(20).describe("Max issues (for action='issues') or recompute batch (for action='recompute')."),
        entityType: z.enum(["node", "relation"]).optional().describe("Required for action='state': entity type to inspect."),
        entityId: z.string().min(1).optional().describe("Required for action='state': entity ID to inspect."),
        entityIds: z.array(z.string().min(1)).max(200).optional().describe("Specific entity IDs to recompute (for action='recompute').")
      }
    },
    async ({ action, states, limit, entityType, entityId, entityIds }) => {
      if (action === "state") {
        if (!entityType || !entityId) {
          throw new Error("Invalid arguments for tool recallx_governance: action='state' requires entityType and entityId.");
        }
        return toolResult("recallx_governance", await apiClient.get(`/governance/state/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`));
      }
      if (action === "recompute") {
        const body: Record<string, unknown> = { limit };
        if (entityIds?.length) body.entityIds = entityIds;
        return toolResult("recallx_governance", await apiClient.post("/governance/recompute", body));
      }
      const query = new URLSearchParams({
        states: states.join(","),
        limit: String(limit)
      });
      return toolResult("recallx_governance", await apiClient.get(`/governance/issues?${query.toString()}`));
    }
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
        mode: bundleModeSchema("compact"),
        preset: bundlePresetSchema("for-assistant"),
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
    async ({ targetId, ...input }) => {
      const result = await apiClient.post<JsonRecord>("/context/bundles", {
        ...input,
        ...(targetId
          ? {
              target: {
                id: targetId
              }
            }
          : {})
      });
      const items = Array.isArray((result as any).items) ? (result as any).items : [];
      const ids = items.filter((item: JsonRecord) => isRecord(item) && typeof item.id === "string").map((item: JsonRecord) => item.id);
      sessionFeedback.trackBundle(targetId, ids);
      return toolResult("recallx_context_bundle", result);
    }
  );

  registerTool(
    server,
    "recallx_semantic_reindex",
    {
      title: "Semantic Reindex",
      description:
        "Queue semantic reindexing for recent workspace nodes or a specific node. **When to use:** after editing node content that needs updated embeddings, or when semantic search results seem stale. Omit nodeId to reindex recent nodes.",
      inputSchema: {
        nodeId: z.string().min(1).optional().describe("If provided, reindex only this specific node. Otherwise, reindex recent active nodes."),
        limit: coerceIntegerSchema(250, 1, 1000).describe("Max nodes to reindex (ignored when nodeId is provided).")
      }
    },
    async ({ nodeId, limit }) => {
      if (nodeId) {
        return toolResult("recallx_semantic_reindex", await apiClient.post(`/semantic/reindex/${encodeURIComponent(nodeId)}`, {}));
      }
      return toolResult("recallx_semantic_reindex", await apiClient.post("/semantic/reindex", { limit }));
    }
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
        preset: bundlePresetSchema("for-assistant"),
        targetNodeId: z.string().optional()
      }
    },
    createPostToolHandler("recallx_rank_candidates", apiClient, "/retrieval/rank-candidates")
  );

  return server;
}
