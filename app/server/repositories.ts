import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ActivitySearchResultItem,
  ActivityRecord,
  ArtifactRecord,
  GovernanceEventRecord,
  GovernanceFeedItem,
  GovernanceIssueItem,
  GovernanceStateRecord,
  InferredRelationRecord,
  InferredRelationRecomputeResult,
  IntegrationRecord,
  JsonMap,
  NodeRecord,
  PendingRelationUsageStats,
  ProvenanceRecord,
  RelationRecord,
  RelationUsageEventRecord,
  RelationUsageSummary,
  SearchMatchReason,
  SearchLexicalQuality,
  SemanticWorkspaceFallbackMode,
  SearchFeedbackEventRecord,
  SearchFeedbackSummary,
  SearchResultItem,
  WorkspaceSearchResultItem
} from "../shared/types.js";
import type {
  ActivitySearchInput,
  AppendActivityInput,
  AppendRelationUsageEventInput,
  AppendSearchFeedbackInput,
  CreateNodeInput,
  CreateRelationInput,
  GovernanceDecisionAction,
  GovernanceEntityType,
  GovernanceState,
  RecomputeInferredRelationsInput,
  RecomputeGovernanceInput,
  RegisterIntegrationInput,
  Source,
  UpsertInferredRelationInput,
  UpdateIntegrationInput,
  UpdateNodeInput,
  WorkspaceSearchInput
} from "../shared/contracts.js";
import { getSqliteVecExtensionRuntime } from "./db.js";
import { AppError, assertPresent } from "./errors.js";
import { appendCurrentTelemetryDetails } from "./observability.js";
import { computeMaintainedScores } from "./relation-scoring.js";
import { buildSemanticChunks, buildSemanticDocumentText, normalizeTagList } from "./semantic/chunker.js";
import { embedSemanticQueryText, normalizeSemanticProviderConfig, resolveSemanticEmbeddingProvider } from "./semantic/provider.js";
import type { SemanticChunkRecord } from "./semantic/types.js";
import {
  createVectorIndexStore,
  type SemanticIndexBackend,
  type VectorIndexStore,
  VectorIndexStoreError
} from "./semantic/vector-store.js";
import { checksumText, createId, isPathWithinRoot, nowIso, parseJson, stableSummary } from "./utils.js";

function normalizeArtifactPath(value: string): string {
  const withForwardSlashes = value.replace(/[\\/]+/g, "/");
  const normalized = path.posix.normalize(withForwardSlashes);
  return normalized === "." ? "" : normalized;
}

type SqlValue = string | number | bigint | Uint8Array | null;

const SUMMARY_UPDATED_AT_KEY = "summaryUpdatedAt";
const SUMMARY_SOURCE_KEY = "summarySource";
const SEARCH_TAG_INDEX_VERSION = 1;
const SEARCH_ACTIVITY_FTS_VERSION = 1;
const SEMANTIC_INDEX_STATUS_VALUES = ["pending", "processing", "stale", "ready", "failed"] as const;
const SEMANTIC_ISSUE_STATUS_VALUES = ["pending", "stale", "failed"] as const;
const DEFAULT_SEMANTIC_CHUNK_AGGREGATION = "max" as const;
const SEMANTIC_TOP_K_CHUNK_COUNT = 2;
const SEMANTIC_CONFIGURATION_CHANGED_REASON = "embedding.configuration_changed";
const SEMANTIC_CONFIGURATION_SWEEP_LIMIT = 100;
const SEMANTIC_PENDING_TRANSITION_KEYS_SETTING = "search.semantic.configuration.pendingKeys";
const SEARCH_FEEDBACK_WINDOW_PADDING = 20;
const SEARCH_FEEDBACK_MAX_WINDOW = 100;
const ACTIVITY_RESULT_CAP_PER_TARGET = 2;
const WORKSPACE_CAPTURE_INBOX_KEY = "workspace.capture.inboxNodeId";
const SEARCH_FALLBACK_TOKEN_LIMIT = 5;
const workspaceInboxSource: Source = {
  actorType: "system",
  actorLabel: "RecallX",
  toolName: "recallx-system"
};

type SemanticIndexStatus = (typeof SEMANTIC_INDEX_STATUS_VALUES)[number];
type SemanticIssueStatus = (typeof SEMANTIC_ISSUE_STATUS_VALUES)[number];
type SemanticChunkAggregation = "max" | "topk_mean";
type WorkspaceSemanticFallbackMode = SemanticWorkspaceFallbackMode;
const DEFAULT_WORKSPACE_SEMANTIC_FALLBACK_MODE = "strict_zero" as const;

type SemanticEmbeddingSignature = {
  provider: string | null;
  model: string | null;
  version: string | null;
};

type SemanticStatusSummary = {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  indexBackend: SemanticIndexBackend;
  configuredIndexBackend: SemanticIndexBackend;
  extensionStatus: "loaded" | "fallback" | "disabled";
  extensionLoadError: string | null;
  chunkEnabled: boolean;
  workspaceFallbackEnabled: boolean;
  workspaceFallbackMode: WorkspaceSemanticFallbackMode;
  lastBackfillAt: string | null;
  counts: Record<SemanticIndexStatus, number>;
};

export interface LegacyReviewQueueRecord {
  id: string;
  entityType: string;
  entityId: string;
  reviewType: string;
  proposedBy: string | null;
  createdAt: string;
  status: string;
  notes: string | null;
  metadata: JsonMap;
}

type SemanticIssueItem = {
  nodeId: string;
  title: string | null;
  embeddingStatus: SemanticIndexStatus;
  staleReason: string | null;
  updatedAt: string;
};

type SemanticIssuePage = {
  items: SemanticIssueItem[];
  nextCursor: string | null;
};

type SemanticIssueCursor = {
  statusRank: number;
  updatedAt: string;
  nodeId: string;
};

type SearchFieldMatcher = {
  trimmedQuery: string;
  matchTerms: string[];
};

type SearchFieldSignals = {
  matchedFields: string[];
  exactFields: string[];
  matchedTermCount: number;
  matchedTermCounts: Record<string, number>;
  totalTermCount: number;
};

function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase();
}

function tokenizeSearchQuery(query: string, maxTokens = 12): string[] {
  const matches = normalizeSearchText(query).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return Array.from(new Set(matches)).slice(0, maxTokens);
}

function createSearchFieldMatcher(query: string): SearchFieldMatcher | null {
  const trimmedQuery = normalizeSearchText(query).trim();
  if (!trimmedQuery) {
    return null;
  }

  const tokens = tokenizeSearchQuery(trimmedQuery);
  return {
    trimmedQuery,
    matchTerms: tokens.length ? tokens : [trimmedQuery]
  };
}

function collectSearchFieldSignals(
  matcher: SearchFieldMatcher | null,
  candidates: Array<{ field: string; value: string | null | undefined }>
): SearchFieldSignals {
  if (!matcher) {
    return {
      matchedFields: [],
      exactFields: [],
      matchedTermCount: 0,
      matchedTermCounts: {},
      totalTermCount: 0
    };
  }

  const matchedFields = new Set<string>();
  const exactFields = new Set<string>();
  const matchedTerms = new Set<string>();
  const matchedTermCounts: Record<string, number> = {};

  for (const candidate of candidates) {
    const haystack = normalizeSearchText(candidate.value);
    if (!haystack) {
      continue;
    }

    const exactMatch = haystack.includes(matcher.trimmedQuery);
    const termMatches = matcher.matchTerms.filter((term) => haystack.includes(term));
    if (!exactMatch && !termMatches.length) {
      continue;
    }

    matchedFields.add(candidate.field);
    matchedTermCounts[candidate.field] = termMatches.length;
    if (exactMatch) {
      exactFields.add(candidate.field);
    }
    for (const term of termMatches) {
      matchedTerms.add(term);
    }
  }

  return {
    matchedFields: [...matchedFields],
    exactFields: [...exactFields],
    matchedTermCount: matchedTerms.size,
    matchedTermCounts,
    totalTermCount: matcher.matchTerms.length
  };
}

function classifyNodeLexicalQuality(
  strategy: SearchMatchReason["strategy"],
  signals: SearchFieldSignals
): SearchLexicalQuality {
  if (strategy === "browse" || strategy === "semantic" || !signals.matchedFields.length) {
    return "none";
  }

  const strongExactFields = new Set(["title", "summary", "tags", "body"]);
  if (signals.exactFields.some((field) => strongExactFields.has(field))) {
    return "strong";
  }

  const termCoverage = signals.totalTermCount > 0 ? signals.matchedTermCount / signals.totalTermCount : 0;
  const titleCoverage =
    signals.totalTermCount > 0 ? (signals.matchedTermCounts.title ?? 0) / signals.totalTermCount : 0;
  if (strategy === "fallback_token") {
    return titleCoverage >= 0.5 ? "strong" : "weak";
  }
  if (strategy === "fts" && titleCoverage >= 0.5) {
    return "strong";
  }
  if (strategy === "fts" && termCoverage >= 0.6 && signals.matchedFields.some((field) => strongExactFields.has(field))) {
    return "strong";
  }

  return "weak";
}

function classifyActivityLexicalQuality(
  strategy: SearchMatchReason["strategy"],
  signals: SearchFieldSignals
): SearchLexicalQuality {
  if (strategy === "browse" || strategy === "semantic" || !signals.matchedFields.length) {
    return "none";
  }
  if (strategy === "fallback_token") {
    return "weak";
  }

  if (signals.exactFields.some((field) => field === "targetNodeTitle" || field === "body" || field === "activityType")) {
    return "strong";
  }

  const termCoverage = signals.totalTermCount > 0 ? signals.matchedTermCount / signals.totalTermCount : 0;
  return strategy === "fts" && termCoverage >= 0.6 ? "strong" : "weak";
}

function summarizeLexicalQuality(items: Array<{ lexicalQuality?: SearchLexicalQuality }>): SearchLexicalQuality {
  if (items.some((item) => item.lexicalQuality === "strong")) {
    return "strong";
  }
  if (items.some((item) => item.lexicalQuality === "weak")) {
    return "weak";
  }
  return "none";
}

function computeWorkspaceResultComposition(input: {
  nodeCount: number;
  activityCount: number;
  semanticUsed: boolean;
}): "empty" | "node_only" | "activity_only" | "mixed" | "semantic_node_only" | "semantic_mixed" {
  if (input.nodeCount === 0 && input.activityCount === 0) {
    return "empty";
  }
  if (input.nodeCount > 0 && input.activityCount === 0) {
    return input.semanticUsed ? "semantic_node_only" : "node_only";
  }
  if (input.nodeCount === 0 && input.activityCount > 0) {
    return "activity_only";
  }
  return input.semanticUsed ? "semantic_mixed" : "mixed";
}

function mergeLexicalQuality(
  left: SearchLexicalQuality | undefined,
  right: SearchLexicalQuality | undefined
): SearchLexicalQuality {
  if (left === "strong" || right === "strong") {
    return "strong";
  }
  if (left === "weak" || right === "weak") {
    return "weak";
  }
  return "none";
}

function mergeNodeSearchItems(primary: SearchResultItem[], secondary: SearchResultItem[]): SearchResultItem[] {
  const merged = [...primary];
  const indexById = new Map(primary.map((item, index) => [item.id, index] as const));

  for (const item of secondary) {
    const existingIndex = indexById.get(item.id);
    if (existingIndex == null) {
      indexById.set(item.id, merged.length);
      merged.push(item);
      continue;
    }

    const existing = merged[existingIndex];
    merged[existingIndex] = {
      ...existing,
      lexicalQuality: existing.lexicalQuality === "strong" ? "strong" : item.lexicalQuality ?? existing.lexicalQuality,
      matchReason:
        existing.matchReason && item.matchReason
          ? mergeMatchReasons(existing.matchReason, item.matchReason, existing.matchReason.strategy)
          : existing.matchReason ?? item.matchReason
    };
  }

  return merged;
}

function buildSearchMatchReason(
  strategy: SearchMatchReason["strategy"],
  matchedFields: string[],
  extras: {
    strength?: Exclude<SearchLexicalQuality, "none">;
    termCoverage?: number | null;
  } = {}
): SearchMatchReason {
  return {
    strategy,
    matchedFields,
    ...(extras.strength ? { strength: extras.strength } : {}),
    ...(extras.termCoverage != null ? { termCoverage: extras.termCoverage } : {})
  };
}

function mergeMatchReasons(
  left: SearchMatchReason | undefined,
  right: SearchMatchReason | undefined,
  strategy: SearchMatchReason["strategy"]
): SearchMatchReason {
  return {
    strategy,
    matchedFields: Array.from(new Set([...(left?.matchedFields ?? []), ...(right?.matchedFields ?? [])])),
    strength: left?.strength ?? right?.strength,
    termCoverage:
      typeof left?.termCoverage === "number" || typeof right?.termCoverage === "number"
        ? Math.max(left?.termCoverage ?? 0, right?.termCoverage ?? 0)
        : null
  };
}

function computeWorkspaceRankBonus(index: number, total: number) {
  if (total <= 0) {
    return 0;
  }

  return Math.max(0, Math.round(((total - index) / total) * 24));
}

function computeWorkspaceSmartScore(input: {
  index: number;
  total: number;
  timestamp: string;
  resultType: "node" | "activity";
  contested: boolean;
  nowMs: number;
  matchReason?: SearchMatchReason;
  lexicalQuality?: SearchLexicalQuality;
}) {
  const matchBonus =
    input.matchReason?.strategy === "semantic"
      ? 3
      : input.lexicalQuality === "strong"
        ? 10
        : input.lexicalQuality === "weak"
          ? input.matchReason?.strategy === "fallback_token"
            ? 1
            : 4
          : 0;
  return (
    computeWorkspaceRankBonus(input.index, input.total) +
    computeWorkspaceRecencyBonusFromAge(input.nowMs - new Date(input.timestamp).getTime(), input.resultType) +
    matchBonus +
    (input.resultType === "activity" ? 4 : 0) -
    (input.contested ? 20 : 0)
  );
}

function computeWorkspaceRecencyBonusFromAge(ageMs: number, resultType: "node" | "activity") {
  if (ageMs <= 60 * 60 * 1000) return resultType === "activity" ? 16 : 12;
  if (ageMs <= 24 * 60 * 60 * 1000) return resultType === "activity" ? 12 : 8;
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return resultType === "activity" ? 7 : 5;
  if (ageMs <= 30 * 24 * 60 * 60 * 1000) return resultType === "activity" ? 3 : 2;
  return 0;
}

type SemanticIndexSettings = {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  version: string | null;
  configuredIndexBackend: SemanticIndexBackend;
  indexBackend: SemanticIndexBackend;
  extensionStatus: "loaded" | "fallback" | "disabled";
  extensionLoadError: string | null;
  chunkEnabled: boolean;
  chunkAggregation: SemanticChunkAggregation;
  workspaceFallbackEnabled: boolean;
  workspaceFallbackMode: WorkspaceSemanticFallbackMode;
};

type SemanticAugmentationSettings = {
  minSimilarity: number;
  maxBonus: number;
};

type WorkspaceSearchTelemetry = {
  semanticFallbackEligible: boolean;
  semanticFallbackAttempted: boolean;
  semanticFallbackUsed: boolean;
  semanticFallbackMode: WorkspaceSemanticFallbackMode | null;
  semanticFallbackCandidateCount: number;
  semanticFallbackResultCount: number;
  semanticFallbackBackend: SemanticIndexBackend | null;
  semanticFallbackConfiguredBackend: SemanticIndexBackend | null;
  semanticFallbackSkippedReason: string | null;
  semanticFallbackQueryLengthBucket: "short" | "medium" | "long" | null;
};

type PendingSemanticIndexRow = {
  nodeId: string;
  contentHash: string | null;
  embeddingStatus: SemanticIndexStatus;
  staleReason: string | null;
  updatedAt: string;
};

type SemanticCandidateSimilarity = {
  similarity: number;
  matchedChunks: number;
};

function clampSearchFeedbackDelta(value: number): number {
  return Math.min(Math.max(value, -2), 2);
}

function computeSearchFeedbackDelta(verdict: AppendSearchFeedbackInput["verdict"], confidence: number): number {
  switch (verdict) {
    case "useful":
      return confidence;
    case "not_useful":
      return -confidence;
    default:
      return 0;
  }
}

function clampConfidence(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function normalizeTagValue(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, " ");
}

function readBooleanSetting(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof settings[key] === "boolean" ? Boolean(settings[key]) : fallback;
}

function readStringSetting(settings: Record<string, unknown>, key: string): string | null {
  return typeof settings[key] === "string" ? String(settings[key]) : null;
}

function readNumberSetting(settings: Record<string, unknown>, key: string, fallback: number): number {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeWorkspaceSemanticFallbackMode(value: unknown): WorkspaceSemanticFallbackMode {
  return value === "no_strong_node_hit" ? "no_strong_node_hit" : DEFAULT_WORKSPACE_SEMANTIC_FALLBACK_MODE;
}

function normalizeSemanticIndexBackend(value: unknown): SemanticIndexBackend {
  return value === "sqlite-vec" ? "sqlite-vec" : "sqlite";
}

function resolveActiveSemanticIndexBackend(configuredBackend: SemanticIndexBackend, sqliteVecLoaded: boolean): SemanticIndexBackend {
  if (configuredBackend === "sqlite-vec" && sqliteVecLoaded) {
    return "sqlite-vec";
  }
  return "sqlite";
}

function resolveSemanticExtensionStatus(
  configuredBackend: SemanticIndexBackend,
  sqliteVecLoaded: boolean
): "loaded" | "fallback" | "disabled" {
  if (configuredBackend !== "sqlite-vec") {
    return "disabled";
  }

  return sqliteVecLoaded ? "loaded" : "fallback";
}

function resolveSemanticEmbeddingSignature(input: {
  provider: string | null;
  model: string | null;
}): SemanticEmbeddingSignature {
  const normalized = normalizeSemanticProviderConfig(input);
  const provider = resolveSemanticEmbeddingProvider(normalized);
  return {
    provider: provider?.provider ?? normalized.provider,
    model: provider?.model ?? normalized.model,
    version: provider?.version ?? null
  };
}

function readSemanticIndexSettingSnapshot(
  settings: Record<string, unknown>,
  runtime: { sqliteVecLoaded: boolean; sqliteVecLoadError: string | null }
) {
  const signature = resolveSemanticEmbeddingSignature({
    provider: readStringSetting(settings, "search.semantic.provider"),
    model: readStringSetting(settings, "search.semantic.model")
  });
  const configuredIndexBackend = normalizeSemanticIndexBackend(settings["search.semantic.indexBackend"]);

  return {
    enabled: readBooleanSetting(settings, "search.semantic.enabled", false),
    provider: signature.provider,
    model: signature.model,
    version: signature.version,
    configuredIndexBackend,
    indexBackend: resolveActiveSemanticIndexBackend(configuredIndexBackend, runtime.sqliteVecLoaded),
    extensionStatus: resolveSemanticExtensionStatus(configuredIndexBackend, runtime.sqliteVecLoaded),
    extensionLoadError: configuredIndexBackend === "sqlite-vec" && !runtime.sqliteVecLoaded ? runtime.sqliteVecLoadError : null,
    chunkEnabled: readBooleanSetting(settings, "search.semantic.chunk.enabled", false),
    workspaceFallbackEnabled: readBooleanSetting(settings, "search.semantic.workspaceFallback.enabled", false),
    workspaceFallbackMode: normalizeWorkspaceSemanticFallbackMode(settings["search.semantic.workspaceFallback.mode"])
  };
}

function shouldReindexForSemanticConfigChange(
  previous: Pick<SemanticIndexSettings, "enabled" | "provider" | "model" | "version" | "chunkEnabled">,
  next: Pick<SemanticIndexSettings, "enabled" | "provider" | "model" | "version" | "chunkEnabled">
): boolean {
  return (
    previous.enabled !== next.enabled ||
    previous.chunkEnabled !== next.chunkEnabled ||
    previous.provider !== next.provider ||
    previous.model !== next.model ||
    previous.version !== next.version
  );
}

function buildSemanticContentHash(input: {
  title: string | null;
  body: string | null;
  summary: string | null;
  tags: string[];
}): string {
  return checksumText(
    JSON.stringify({
      title: input.title ?? "",
      body: input.body ?? "",
      summary: input.summary ?? "",
      tags: normalizeTagList(input.tags)
    })
  );
}

function semanticIssueStatusRank(status: SemanticIndexStatus): number {
  switch (status) {
    case "failed":
      return 0;
    case "stale":
      return 1;
    default:
      return 2;
  }
}

function encodeSemanticIssueCursor(cursor: SemanticIssueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSemanticIssueCursor(cursor: string | null | undefined): SemanticIssueCursor | null {
  if (!cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<SemanticIssueCursor>;
    if (
      typeof parsed.statusRank !== "number" ||
      !Number.isFinite(parsed.statusRank) ||
      typeof parsed.updatedAt !== "string" ||
      !parsed.updatedAt ||
      typeof parsed.nodeId !== "string" ||
      !parsed.nodeId
    ) {
      return null;
    }

    return {
      statusRank: parsed.statusRank,
      updatedAt: parsed.updatedAt,
      nodeId: parsed.nodeId
    };
  } catch {
    return null;
  }
}

function normalizeSemanticChunkAggregation(value: unknown): SemanticChunkAggregation {
  return value === "topk_mean" ? "topk_mean" : DEFAULT_SEMANTIC_CHUNK_AGGREGATION;
}

function aggregateChunkSimilarities(similarities: number[], aggregation: SemanticChunkAggregation): number {
  if (!similarities.length) {
    return 0;
  }

  if (aggregation === "topk_mean") {
    const topK = [...similarities].sort((left, right) => right - left).slice(0, SEMANTIC_TOP_K_CHUNK_COUNT);
    return topK.reduce((sum, value) => sum + value, 0) / topK.length;
  }

  return Math.max(...similarities);
}

type SemanticSimilarityAccumulator = {
  matchedChunks: number;
  maxSimilarity: number;
  topSimilarities: number[];
};

function updateSemanticSimilarityAccumulator(
  accumulator: SemanticSimilarityAccumulator,
  similarity: number,
  aggregation: SemanticChunkAggregation
) {
  accumulator.matchedChunks += 1;
  accumulator.maxSimilarity = Math.max(accumulator.maxSimilarity, similarity);

  if (aggregation !== "topk_mean") {
    return;
  }

  accumulator.topSimilarities.push(similarity);
  accumulator.topSimilarities.sort((left, right) => right - left);
  if (accumulator.topSimilarities.length > SEMANTIC_TOP_K_CHUNK_COUNT) {
    accumulator.topSimilarities.length = SEMANTIC_TOP_K_CHUNK_COUNT;
  }
}

function normalizeSemanticBonusSimilarity(similarity: number, minSimilarity: number): number {
  if (!Number.isFinite(similarity) || similarity < minSimilarity || minSimilarity >= 1) {
    return 0;
  }

  return Math.min(1, Math.max(0, similarity - minSimilarity) / (1 - minSimilarity));
}

function computeSemanticRetrievalRank(similarity: number, settings: SemanticAugmentationSettings): number {
  const normalizedSimilarity = normalizeSemanticBonusSimilarity(similarity, settings.minSimilarity);
  return Number((normalizedSimilarity * settings.maxBonus).toFixed(4));
}

function bucketSemanticQueryLength(length: number): "short" | "medium" | "long" {
  if (length <= 12) {
    return "short";
  }
  if (length <= 32) {
    return "medium";
  }
  return "long";
}

function mapNode(row: Record<string, unknown>): NodeRecord {
  return {
    id: String(row.id),
    type: row.type as NodeRecord["type"],
    status: row.status as NodeRecord["status"],
    canonicality: row.canonicality as NodeRecord["canonicality"],
    visibility: String(row.visibility),
    title: row.title ? String(row.title) : null,
    body: row.body ? String(row.body) : null,
    summary: row.summary ? String(row.summary) : null,
    createdBy: row.created_by ? String(row.created_by) : null,
    sourceType: row.source_type ? String(row.source_type) : null,
    sourceLabel: row.source_label ? String(row.source_label) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    tags: parseJson<string[]>(row.tags_json as string | null, []),
    metadata: parseJson<JsonMap>(row.metadata_json as string | null, {})
  };
}

function mapRelation(row: Record<string, unknown>): RelationRecord {
  return {
    id: String(row.id),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    relationType: row.relation_type as RelationRecord["relationType"],
    status: row.status as RelationRecord["status"],
    createdBy: row.created_by ? String(row.created_by) : null,
    sourceType: row.source_type ? String(row.source_type) : null,
    sourceLabel: row.source_label ? String(row.source_label) : null,
    createdAt: String(row.created_at),
    metadata: parseJson<JsonMap>(row.metadata_json as string | null, {})
  };
}

function mapActivity(row: Record<string, unknown>): ActivityRecord {
  return {
    id: String(row.id),
    targetNodeId: String(row.target_node_id),
    activityType: row.activity_type as ActivityRecord["activityType"],
    body: row.body ? String(row.body) : null,
    createdBy: row.created_by ? String(row.created_by) : null,
    sourceType: row.source_type ? String(row.source_type) : null,
    sourceLabel: row.source_label ? String(row.source_label) : null,
    createdAt: String(row.created_at),
    metadata: parseJson<JsonMap>(row.metadata_json as string | null, {})
  };
}

function mapInferredRelation(row: Record<string, unknown>): InferredRelationRecord {
  return {
    id: String(row.id),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    relationType: row.relation_type as InferredRelationRecord["relationType"],
    baseScore: Number(row.base_score),
    usageScore: Number(row.usage_score),
    finalScore: Number(row.final_score),
    status: row.status as InferredRelationRecord["status"],
    generator: String(row.generator),
    evidence: parseJson<JsonMap>(row.evidence_json as string | null, {}),
    lastComputedAt: String(row.last_computed_at),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    metadata: parseJson<JsonMap>(row.metadata_json as string | null, {})
  };
}

function mapRelationUsageEvent(row: Record<string, unknown>): RelationUsageEventRecord {
  return {
    id: String(row.id),
    relationId: String(row.relation_id),
    relationSource: row.relation_source as RelationUsageEventRecord["relationSource"],
    eventType: row.event_type as RelationUsageEventRecord["eventType"],
    sessionId: row.session_id ? String(row.session_id) : null,
    runId: row.run_id ? String(row.run_id) : null,
    actorType: row.actor_type ? String(row.actor_type) : null,
    actorLabel: row.actor_label ? String(row.actor_label) : null,
    toolName: row.tool_name ? String(row.tool_name) : null,
    delta: Number(row.delta),
    createdAt: String(row.created_at),
    metadata: parseJson<JsonMap>(row.metadata_json as string | null, {})
  };
}

function mapSearchFeedbackEvent(row: Record<string, unknown>): SearchFeedbackEventRecord {
  return {
    id: String(row.id),
    resultType: String(row.result_type) as SearchFeedbackEventRecord["resultType"],
    resultId: String(row.result_id),
    verdict: String(row.verdict) as SearchFeedbackEventRecord["verdict"],
    query: row.query ? String(row.query) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    runId: row.run_id ? String(row.run_id) : null,
    actorType: row.actor_type ? String(row.actor_type) : null,
    actorLabel: row.actor_label ? String(row.actor_label) : null,
    toolName: row.tool_name ? String(row.tool_name) : null,
    confidence: Number(row.confidence),
    delta: Number(row.delta),
    createdAt: String(row.created_at),
    metadata: parseJson<JsonMap>(row.metadata_json as string | null, {})
  };
}

function mapGovernanceEvent(row: Record<string, unknown>): GovernanceEventRecord {
  return {
    id: String(row.id),
    entityType: row.entity_type as GovernanceEventRecord["entityType"],
    entityId: String(row.entity_id),
    eventType: row.event_type as GovernanceEventRecord["eventType"],
    previousState: row.previous_state ? (row.previous_state as GovernanceEventRecord["previousState"]) : null,
    nextState: row.next_state as GovernanceEventRecord["nextState"],
    confidence: Number(row.confidence),
    reason: String(row.reason),
    createdAt: String(row.created_at),
    metadata: parseJson<JsonMap>(row.metadata_json as string | null, {})
  };
}

function mapGovernanceState(row: Record<string, unknown>): GovernanceStateRecord {
  return {
    entityType: row.entity_type as GovernanceStateRecord["entityType"],
    entityId: String(row.entity_id),
    state: row.state as GovernanceStateRecord["state"],
    confidence: Number(row.confidence),
    reasons: parseJson<string[]>(row.reasons_json as string | null, []),
    lastEvaluatedAt: String(row.last_evaluated_at),
    lastTransitionAt: String(row.last_transition_at),
    metadata: parseJson<JsonMap>(row.metadata_json as string | null, {})
  };
}

function mapArtifact(row: Record<string, unknown>): ArtifactRecord {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    path: String(row.path),
    mimeType: row.mime_type ? String(row.mime_type) : null,
    sizeBytes: row.size_bytes ? Number(row.size_bytes) : null,
    checksum: row.checksum ? String(row.checksum) : null,
    createdBy: row.created_by ? String(row.created_by) : null,
    sourceLabel: row.source_label ? String(row.source_label) : null,
    createdAt: String(row.created_at),
    metadata: parseJson<JsonMap>(row.metadata_json as string | null, {})
  };
}

function mapProvenance(row: Record<string, unknown>): ProvenanceRecord {
  return {
    id: String(row.id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    operationType: String(row.operation_type),
    actorType: String(row.actor_type),
    actorLabel: row.actor_label ? String(row.actor_label) : null,
    toolName: row.tool_name ? String(row.tool_name) : null,
    toolVersion: row.tool_version ? String(row.tool_version) : null,
    timestamp: String(row.timestamp),
    inputRef: row.input_ref ? String(row.input_ref) : null,
    metadata: parseJson<JsonMap>(row.metadata_json as string | null, {})
  };
}

function mapLegacyReviewQueue(row: Record<string, unknown>): LegacyReviewQueueRecord {
  return {
    id: String(row.id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    reviewType: String(row.review_type),
    proposedBy: row.proposed_by ? String(row.proposed_by) : null,
    createdAt: String(row.created_at),
    status: String(row.status),
    notes: row.notes ? String(row.notes) : null,
    metadata: parseJson<JsonMap>(row.metadata_json as string | null, {})
  };
}

function withSummaryMetadata(
  metadata: JsonMap,
  summaryUpdatedAt: string,
  summarySource: "derived" | "explicit" | "manual_refresh"
): JsonMap {
  return {
    ...metadata,
    [SUMMARY_UPDATED_AT_KEY]: summaryUpdatedAt,
    [SUMMARY_SOURCE_KEY]: summarySource
  };
}

function mapIntegration(row: Record<string, unknown>): IntegrationRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind),
    status: String(row.status),
    capabilities: parseJson<string[]>(row.capabilities_json as string | null, []),
    config: parseJson<JsonMap>(row.config_json as string | null, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

const RELATION_USAGE_ROLLUP_STATE_ID = "bootstrap";

export class RecallXRepository {
  private readonly workspaceKey: string;

  private readonly sqliteVectorIndexStore: VectorIndexStore;

  private readonly sqliteVecVectorIndexStore: VectorIndexStore;

  private readonly sqliteVecRuntime: ReturnType<typeof getSqliteVecExtensionRuntime>;

  constructor(
    private readonly db: DatabaseSync,
    private readonly workspaceRoot: string
  ) {
    this.workspaceKey = checksumText(path.resolve(workspaceRoot));
    this.sqliteVecRuntime = getSqliteVecExtensionRuntime(db);
    this.sqliteVectorIndexStore = createVectorIndexStore(db, {
      backend: "sqlite",
      workspaceKey: this.workspaceKey
    });
    this.sqliteVecVectorIndexStore = createVectorIndexStore(db, {
      backend: "sqlite-vec",
      workspaceKey: this.workspaceKey
    });
  }

  private resolveVectorIndexStore(backend: SemanticIndexBackend): VectorIndexStore {
    return backend === "sqlite-vec" ? this.sqliteVecVectorIndexStore : this.sqliteVectorIndexStore;
  }

  private runInTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures and rethrow the original error
      }
      throw error;
    }
  }

  private ensureRelationUsageRollupState(updatedAt = nowIso()): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO relation_usage_rollup_state (id, last_event_rowid, updated_at)
         VALUES (?, 0, ?)`
      )
      .run(RELATION_USAGE_ROLLUP_STATE_ID, updatedAt);
  }

  private getRelationUsageRollupWatermark(): number {
    this.ensureRelationUsageRollupState();
    const row = this.db
      .prepare(`SELECT last_event_rowid FROM relation_usage_rollup_state WHERE id = ?`)
      .get(RELATION_USAGE_ROLLUP_STATE_ID) as Record<string, unknown> | undefined;
    return Number(row?.last_event_rowid ?? 0);
  }

  private syncRelationUsageRollups(): void {
    const lastEventRowid = this.getRelationUsageRollupWatermark();
    const maxRowidRow = this.db
      .prepare(`SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM relation_usage_events`)
      .get() as Record<string, unknown>;
    const maxRowid = Number(maxRowidRow.max_rowid ?? 0);

    if (maxRowid <= lastEventRowid) {
      return;
    }

    const updatedAt = nowIso();
    this.runInTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO relation_usage_rollups (
             relation_id, total_delta, event_count, last_event_at, last_event_rowid, updated_at
           )
           SELECT
             relation_id,
             COALESCE(SUM(delta), 0) AS total_delta,
             COUNT(*) AS event_count,
             MAX(created_at) AS last_event_at,
             MAX(rowid) AS last_event_rowid,
             ? AS updated_at
           FROM relation_usage_events
           WHERE rowid > ?
           GROUP BY relation_id
           ON CONFLICT(relation_id) DO UPDATE SET
             total_delta = total_delta + excluded.total_delta,
             event_count = event_count + excluded.event_count,
             last_event_at = CASE
               WHEN excluded.last_event_at > last_event_at THEN excluded.last_event_at
               ELSE last_event_at
             END,
             last_event_rowid = CASE
               WHEN excluded.last_event_rowid > last_event_rowid THEN excluded.last_event_rowid
               ELSE last_event_rowid
             END,
             updated_at = excluded.updated_at`
        )
        .run(updatedAt, lastEventRowid);

      this.db
        .prepare(
          `UPDATE relation_usage_rollup_state
           SET last_event_rowid = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(maxRowid, updatedAt, RELATION_USAGE_ROLLUP_STATE_ID);
    });
  }

  private touchNode(id: string): void {
    this.db.prepare(`UPDATE nodes SET updated_at = ? WHERE id = ?`).run(nowIso(), id);
  }

  private upsertSemanticIndexState(params: {
    nodeId: string;
    status: SemanticIndexStatus;
    staleReason?: string | null;
    contentHash?: string | null;
    embeddingProvider?: string | null;
    embeddingModel?: string | null;
    embeddingVersion?: string | null;
    updatedAt?: string;
  }): void {
    const updatedAt = params.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO node_index_state (
           node_id, content_hash, embedding_status, embedding_provider, embedding_model, embedding_version, stale_reason, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           embedding_status = excluded.embedding_status,
           embedding_provider = excluded.embedding_provider,
           embedding_model = excluded.embedding_model,
           embedding_version = excluded.embedding_version,
           stale_reason = excluded.stale_reason,
           updated_at = excluded.updated_at`
      )
      .run(
        params.nodeId,
        params.contentHash ?? null,
        params.status,
        params.embeddingProvider ?? null,
        params.embeddingModel ?? null,
        params.embeddingVersion ?? null,
        params.staleReason ?? null,
        updatedAt
      );
  }

  private markNodeSemanticIndexState(
    nodeId: string,
    reason: string,
    input: { status?: SemanticIndexStatus; contentHash?: string | null; updatedAt?: string } = {}
  ): void {
    this.upsertSemanticIndexState({
      nodeId,
      status: input.status ?? "pending",
      staleReason: reason,
      contentHash: input.contentHash,
      updatedAt: input.updatedAt
    });
  }

  private syncNodeTags(nodeId: string, tags: string[]): void {
    const normalizedTags = normalizeTagList(tags);
    this.db.prepare(`DELETE FROM node_tags WHERE node_id = ?`).run(nodeId);
    if (!normalizedTags.length) {
      return;
    }

    const insertStatement = this.db.prepare(`INSERT INTO node_tags (node_id, tag) VALUES (?, ?)`);
    for (const tag of normalizedTags) {
      insertStatement.run(nodeId, tag);
    }
  }

  private readSemanticIndexSettings(): SemanticIndexSettings {
    const settings = this.getSettings([
      "search.semantic.enabled",
      "search.semantic.provider",
      "search.semantic.model",
      "search.semantic.indexBackend",
      "search.semantic.chunk.enabled",
      "search.semantic.chunk.aggregation",
      "search.semantic.workspaceFallback.enabled",
      "search.semantic.workspaceFallback.mode"
    ]);
    return {
      ...readSemanticIndexSettingSnapshot(settings, {
        sqliteVecLoaded: this.sqliteVecRuntime.isLoaded,
        sqliteVecLoadError: this.sqliteVecRuntime.loadError
      }),
      chunkAggregation: normalizeSemanticChunkAggregation(settings["search.semantic.chunk.aggregation"]),
      workspaceFallbackEnabled: readBooleanSetting(settings, "search.semantic.workspaceFallback.enabled", false),
      workspaceFallbackMode: normalizeWorkspaceSemanticFallbackMode(settings["search.semantic.workspaceFallback.mode"])
    };
  }

  getSemanticAugmentationSettings(): SemanticAugmentationSettings {
    const settings = this.getSettings([
      "search.semantic.augmentation.minSimilarity",
      "search.semantic.augmentation.maxBonus"
    ]);

    return {
      minSimilarity: Math.min(Math.max(readNumberSetting(settings, "search.semantic.augmentation.minSimilarity", 0.2), 0), 1),
      maxBonus: Math.max(readNumberSetting(settings, "search.semantic.augmentation.maxBonus", 18), 0)
    };
  }

  private markSemanticConfigurationMismatchesStale(limit = SEMANTIC_CONFIGURATION_SWEEP_LIMIT): number {
    const settings = this.readSemanticIndexSettings();
    const rows = this.db
      .prepare(
        `SELECT nis.node_id
         FROM node_index_state nis
         JOIN nodes n ON n.id = nis.node_id
         WHERE n.status IN ('active', 'draft')
           AND nis.embedding_status = 'ready'
           AND (
             nis.embedding_provider IS NOT ?
             OR nis.embedding_model IS NOT ?
             OR nis.embedding_version IS NOT ?
           )
         ORDER BY nis.updated_at ASC
         LIMIT ?`
      )
      .all(settings.provider, settings.model, settings.version, limit) as Array<Record<string, unknown>>;

    if (!rows.length) {
      return 0;
    }

    const updatedAt = nowIso();
    const updateStatement = this.db.prepare(
      `UPDATE node_index_state
       SET embedding_status = 'stale', stale_reason = ?, updated_at = ?
       WHERE node_id = ? AND embedding_status = 'ready'`
    );
    for (const row of rows) {
      updateStatement.run(SEMANTIC_CONFIGURATION_CHANGED_REASON, updatedAt, String(row.node_id));
    }

    return rows.length;
  }

  private queueSemanticConfigurationReindex(reason = SEMANTIC_CONFIGURATION_CHANGED_REASON): void {
    const nodeIds = this.listSemanticIndexTargetNodeIds();
    const updatedAt = nowIso();
    this.queueSemanticReindexForNodeIds(nodeIds, reason, updatedAt);
    this.writeSetting("search.semantic.last_backfill_at", updatedAt);
  }

  private readPendingSemanticTransitionKeys(): string[] {
    const value = this.getSettings([SEMANTIC_PENDING_TRANSITION_KEYS_SETTING])[SEMANTIC_PENDING_TRANSITION_KEYS_SETTING];
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item): item is string => typeof item === "string")
      .filter((item) => item === "search.semantic.provider" || item === "search.semantic.model");
  }

  private writePendingSemanticTransitionKeys(keys: string[]): void {
    this.writeSetting(SEMANTIC_PENDING_TRANSITION_KEYS_SETTING, keys);
  }

  private updateSemanticSetting(key: string, value: unknown): void {
    const previousSettings = this.readSemanticIndexSettings();
    this.writeSetting(key, value);
    const nextSettings = this.readSemanticIndexSettings();
    if (!shouldReindexForSemanticConfigChange(previousSettings, nextSettings)) {
      if (key === "search.semantic.provider" || key === "search.semantic.model") {
        const pendingKeys = new Set(this.readPendingSemanticTransitionKeys());
        pendingKeys.delete(key);
        this.writePendingSemanticTransitionKeys([...pendingKeys]);
      }
      return;
    }

    if (key === "search.semantic.provider" || key === "search.semantic.model") {
      const pendingKeys = new Set(this.readPendingSemanticTransitionKeys());
      pendingKeys.add(key);
      if (!pendingKeys.has("search.semantic.provider") || !pendingKeys.has("search.semantic.model")) {
        this.writePendingSemanticTransitionKeys([...pendingKeys]);
        return;
      }

      this.writePendingSemanticTransitionKeys([]);
    }

    this.queueSemanticConfigurationReindex();
  }

  private listPendingSemanticIndexRows(limit = 25): PendingSemanticIndexRow[] {
    const rows = this.db
      .prepare(
        `SELECT node_id, content_hash, embedding_status, stale_reason, updated_at
         FROM node_index_state
         WHERE embedding_status IN ('pending', 'stale')
         ORDER BY updated_at ASC
         LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      nodeId: String(row.node_id),
      contentHash: row.content_hash ? String(row.content_hash) : null,
      embeddingStatus: String(row.embedding_status) as SemanticIndexStatus,
      staleReason: row.stale_reason ? String(row.stale_reason) : null,
      updatedAt: String(row.updated_at)
    }));
  }

  private replaceSemanticChunks(nodeId: string, chunks: SemanticChunkRecord[], updatedAt: string): void {
    this.db.prepare(`DELETE FROM node_chunks WHERE node_id = ?`).run(nodeId);
    if (!chunks.length) {
      return;
    }

    const insertStatement = this.db.prepare(
      `INSERT INTO node_chunks (
         node_id, ordinal, chunk_hash, chunk_text, token_count, start_offset, end_offset, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const chunk of chunks) {
      insertStatement.run(
        nodeId,
        chunk.ordinal,
        chunk.chunkHash,
        chunk.chunkText,
        chunk.tokenCount,
        chunk.startOffset,
        chunk.endOffset,
        updatedAt
      );
    }
  }

  private replaceSemanticEmbeddings(
    nodeId: string,
    params: {
      provider: string;
      model: string | null;
      version: string | null;
      contentHash: string;
      rows: Array<{
        chunkOrdinal: number;
        vectorRef: string | null;
        vectorBlob: Uint8Array | null;
      }>;
      updatedAt: string;
    }
  ): void {
    this.db.prepare(`DELETE FROM node_embeddings WHERE owner_type = 'node' AND owner_id = ?`).run(nodeId);
    if (!params.rows.length) {
      return;
    }

    const insertStatement = this.db.prepare(
      `INSERT INTO node_embeddings (
         owner_type, owner_id, chunk_ordinal, vector_ref, vector_blob, embedding_provider, embedding_model, embedding_version,
         content_hash, status, created_at, updated_at
       ) VALUES ('node', ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`
    );

    for (const row of params.rows) {
      insertStatement.run(
        nodeId,
        row.chunkOrdinal,
        row.vectorRef,
        row.vectorBlob,
        params.provider,
        params.model,
        params.version,
        params.contentHash,
        params.updatedAt,
        params.updatedAt
      );
    }
  }

  private async syncSemanticDelete(
    vectorIndexStore: VectorIndexStore,
    nodeId: string,
    finishedAt: string,
    params: {
      contentHash: string;
      embeddingProvider: string | null;
      embeddingModel: string | null;
      embeddingVersion?: string | null;
      status: SemanticIndexStatus;
      staleReason: string | null;
      clearChunks: boolean;
    }
  ): Promise<void> {
    await vectorIndexStore.deleteNode(nodeId);
    this.runInTransaction(() => {
      if (params.clearChunks) {
        this.db.prepare(`DELETE FROM node_chunks WHERE node_id = ?`).run(nodeId);
      }
      this.db.prepare(`DELETE FROM node_embeddings WHERE owner_type = 'node' AND owner_id = ?`).run(nodeId);
      this.upsertSemanticIndexState({
        nodeId,
        status: params.status,
        staleReason: params.staleReason,
        contentHash: params.contentHash,
        embeddingProvider: params.embeddingProvider,
        embeddingModel: params.embeddingModel,
        embeddingVersion: params.embeddingVersion,
        updatedAt: finishedAt
      });
    });
  }

  async processPendingSemanticIndex(limit = 25) {
    const settings = this.readSemanticIndexSettings();
    if (this.readPendingSemanticTransitionKeys().length) {
      return {
        processedNodeIds: [],
        processedCount: 0,
        readyCount: 0,
        failedCount: 0,
        remainingCount: this.listPendingSemanticIndexRows(limit).length,
        mode: !settings.enabled || settings.provider === "disabled" || settings.model === "none" ? "chunk-only" : "provider-required"
      };
    }

    this.markSemanticConfigurationMismatchesStale(limit);
    const vectorIndexStore = this.resolveVectorIndexStore(settings.indexBackend);
    const provider = resolveSemanticEmbeddingProvider({
      provider: settings.provider,
      model: settings.model
    });
    const pendingRows = this.listPendingSemanticIndexRows(limit);
    const processedNodeIds: string[] = [];
    const readyNodeIds: string[] = [];
    const failedNodeIds: string[] = [];

    for (const row of pendingRows) {
      const startedAt = nowIso();
      this.upsertSemanticIndexState({
        nodeId: row.nodeId,
        status: "processing",
        staleReason: row.staleReason,
        contentHash: row.contentHash,
        embeddingProvider: settings.provider,
        embeddingModel: settings.model,
        updatedAt: startedAt
      });

      try {
        const node = this.getNode(row.nodeId);
        const contentHash = buildSemanticContentHash({
          title: node.title,
          body: node.body,
          summary: node.summary,
          tags: node.tags
        });
        const chunkText = buildSemanticDocumentText({
          title: node.title,
          summary: node.summary,
          body: node.body,
          tags: node.tags
        });
        const chunks = buildSemanticChunks(chunkText, settings.chunkEnabled);
        const embeddingResults =
          provider && chunks.length
            ? await provider.embedBatch(
                chunks.map((chunk) => ({
                  nodeId: node.id,
                  chunkOrdinal: chunk.ordinal,
                  contentHash,
                  text: chunk.chunkText
                }))
              )
            : [];
        const finishedAt = nowIso();
        if (node.status === "archived") {
          await this.syncSemanticDelete(vectorIndexStore, node.id, finishedAt, {
            clearChunks: true,
            contentHash,
            embeddingProvider: settings.provider,
            embeddingModel: settings.model,
            status: "ready",
            staleReason: null
          });
          readyNodeIds.push(node.id);
          processedNodeIds.push(row.nodeId);
          continue;
        }

        this.replaceSemanticChunks(node.id, chunks, finishedAt);

        if (!settings.enabled || settings.provider === "disabled" || settings.model === "none" || !settings.provider || !settings.model) {
          await this.syncSemanticDelete(vectorIndexStore, node.id, finishedAt, {
            clearChunks: false,
            contentHash,
            embeddingProvider: settings.provider,
            embeddingModel: settings.model,
            status: "ready",
            staleReason: null
          });
          readyNodeIds.push(node.id);
          processedNodeIds.push(row.nodeId);
          continue;
        }

        if (provider && embeddingResults.length === chunks.length) {
          const ledgerRows = await vectorIndexStore.upsertNodeChunks({
            nodeId: node.id,
            chunks,
            embeddings: embeddingResults,
            contentHash,
            embeddingProvider: provider.provider,
            embeddingModel: provider.model ?? settings.model,
            embeddingVersion: provider.version,
            updatedAt: finishedAt
          });

          this.runInTransaction(() => {
            this.replaceSemanticEmbeddings(node.id, {
              provider: provider.provider,
              model: provider.model ?? settings.model,
              version: provider.version,
              contentHash,
              rows: ledgerRows,
              updatedAt: finishedAt
            });
            this.upsertSemanticIndexState({
              nodeId: node.id,
              status: "ready",
              staleReason: null,
              contentHash,
              embeddingProvider: provider.provider,
              embeddingModel: provider.model ?? settings.model,
              embeddingVersion: provider.version,
              updatedAt: finishedAt
            });
          });
          readyNodeIds.push(node.id);
          processedNodeIds.push(row.nodeId);
          continue;
        }

        await this.syncSemanticDelete(vectorIndexStore, node.id, finishedAt, {
          clearChunks: false,
          contentHash,
          embeddingProvider: settings.provider,
          embeddingModel: settings.model,
          status: "failed",
          staleReason: `embedding.provider_not_implemented:${settings.provider}`
        });
        failedNodeIds.push(node.id);
      } catch (error) {
        const staleReason =
          error instanceof VectorIndexStoreError ? error.code : "embedding.node_not_found";
        this.upsertSemanticIndexState({
          nodeId: row.nodeId,
          status: "failed",
          staleReason,
          contentHash: row.contentHash,
          embeddingProvider: settings.provider,
          embeddingModel: settings.model
        });
        failedNodeIds.push(row.nodeId);
      }

      processedNodeIds.push(row.nodeId);
    }

    return {
      processedNodeIds,
      processedCount: processedNodeIds.length,
      readyCount: readyNodeIds.length,
      failedCount: failedNodeIds.length,
      remainingCount: this.listPendingSemanticIndexRows(limit).length,
      mode: !settings.enabled || settings.provider === "disabled" || settings.model === "none" ? "chunk-only" : "provider-required"
    };
  }

  ensureSearchTagIndex(): void {
    const settings = this.getSettings(["search.tagIndex.version"]);
    if (Number(settings["search.tagIndex.version"] ?? 0) >= SEARCH_TAG_INDEX_VERSION) {
      return;
    }

    this.runInTransaction(() => {
      this.db.prepare(`DELETE FROM node_tags`).run();
      const rows = this.db
        .prepare(`SELECT id, tags_json FROM nodes`)
        .all() as Array<Record<string, unknown>>;
      const insertStatement = this.db.prepare(`INSERT INTO node_tags (node_id, tag) VALUES (?, ?)`);

      for (const row of rows) {
        const nodeId = String(row.id);
        const tags = normalizeTagList(parseJson<string[]>(row.tags_json as string | null, []));
        for (const tag of tags) {
          insertStatement.run(nodeId, tag);
        }
      }

      this.setSetting("search.tagIndex.version", SEARCH_TAG_INDEX_VERSION);
    });
  }

  ensureActivitySearchIndex(): void {
    const settings = this.getSettings(["search.activityFts.version"]);
    if (Number(settings["search.activityFts.version"] ?? 0) >= SEARCH_ACTIVITY_FTS_VERSION) {
      return;
    }

    this.runInTransaction(() => {
      this.db.prepare(`INSERT INTO activities_fts(activities_fts) VALUES ('delete-all')`).run();
      const rows = this.db
        .prepare(`SELECT rowid, id, body FROM activities`)
        .all() as Array<Record<string, unknown>>;
      const insertStatement = this.db.prepare(`INSERT INTO activities_fts(rowid, id, body) VALUES (?, ?, ?)`);

      for (const row of rows) {
        insertStatement.run(Number(row.rowid), String(row.id), row.body ? String(row.body) : "");
      }

      this.setSetting("search.activityFts.version", SEARCH_ACTIVITY_FTS_VERSION);
    });
  }

  listSemanticIndexTargetNodeIds(limit?: number): string[] {
    const rows = (
      limit === undefined
        ? this.db
            .prepare(
              `SELECT id
               FROM nodes
               WHERE status IN ('active', 'draft')
               ORDER BY updated_at DESC`
            )
            .all()
        : this.db
            .prepare(
              `SELECT id
               FROM nodes
               WHERE status IN ('active', 'draft')
               ORDER BY updated_at DESC
               LIMIT ?`
            )
            .all(limit)
    ) as Array<Record<string, unknown>>;

    return rows.map((row) => String(row.id));
  }

  private queueSemanticReindexForNodeIds(nodeIds: string[], reason: string, updatedAt = nowIso()): void {
    const nodesById = this.getNodesByIds(nodeIds);
    for (const nodeId of nodeIds) {
      const node = nodesById.get(nodeId);
      if (!node) {
        continue;
      }

      const contentHash = buildSemanticContentHash({
        title: node.title,
        body: node.body,
        summary: node.summary,
        tags: node.tags
      });
      this.markNodeSemanticIndexState(node.id, reason, {
        status: "pending",
        contentHash,
        updatedAt
      });
    }
  }

  queueSemanticReindexForNode(nodeId: string, reason = "manual.reindex"): NodeRecord {
    const node = this.getNode(nodeId);
    const contentHash = buildSemanticContentHash({
      title: node.title,
      body: node.body,
      summary: node.summary,
      tags: node.tags
    });
    this.markNodeSemanticIndexState(node.id, reason, {
      status: "pending",
      contentHash
    });
    return node;
  }

  queueSemanticReindex(limit = 250, reason = "manual.reindex") {
    const nodeIds = this.listSemanticIndexTargetNodeIds(limit);
    const updatedAt = nowIso();
    this.queueSemanticReindexForNodeIds(nodeIds, reason, updatedAt);
    this.setSetting("search.semantic.last_backfill_at", updatedAt);
    return {
      queuedNodeIds: nodeIds,
      queuedCount: nodeIds.length
    };
  }

  getSemanticStatus(): SemanticStatusSummary {
    this.markSemanticConfigurationMismatchesStale();
    const settings = this.getSettings([
      "search.semantic.enabled",
      "search.semantic.provider",
      "search.semantic.model",
      "search.semantic.indexBackend",
      "search.semantic.chunk.enabled",
      "search.semantic.workspaceFallback.enabled",
      "search.semantic.workspaceFallback.mode",
      "search.semantic.last_backfill_at"
    ]);
    const semanticSettings = readSemanticIndexSettingSnapshot(settings, {
      sqliteVecLoaded: this.sqliteVecRuntime.isLoaded,
      sqliteVecLoadError: this.sqliteVecRuntime.loadError
    });
    const { version: _version, ...semanticStatusSettings } = semanticSettings;
    const counts = Object.fromEntries(
      SEMANTIC_INDEX_STATUS_VALUES.map((status) => [status, 0])
    ) as Record<SemanticIndexStatus, number>;
    const rows = this.db
      .prepare(
        `SELECT embedding_status, COUNT(*) AS total
         FROM node_index_state
         GROUP BY embedding_status`
      )
      .all() as Array<Record<string, unknown>>;

    for (const row of rows) {
      const status = String(row.embedding_status) as SemanticIndexStatus;
      if (SEMANTIC_INDEX_STATUS_VALUES.includes(status)) {
        counts[status] = Number(row.total ?? 0);
      }
    }

    return {
      ...semanticStatusSettings,
      workspaceFallbackEnabled: readBooleanSetting(settings, "search.semantic.workspaceFallback.enabled", false),
      workspaceFallbackMode: normalizeWorkspaceSemanticFallbackMode(settings["search.semantic.workspaceFallback.mode"]),
      lastBackfillAt: readStringSetting(settings, "search.semantic.last_backfill_at"),
      counts
    };
  }

  listSemanticIssues(input: {
    limit?: number;
    statuses?: SemanticIssueStatus[];
    cursor?: string | null;
  } = {}): SemanticIssuePage {
    this.markSemanticConfigurationMismatchesStale();
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 25);
    const normalizedStatuses = (input.statuses?.length ? input.statuses : [...SEMANTIC_ISSUE_STATUS_VALUES]).filter(
      (status, index, values) => SEMANTIC_ISSUE_STATUS_VALUES.includes(status) && values.indexOf(status) === index
    );
    const statuses = normalizedStatuses.length ? normalizedStatuses : [...SEMANTIC_ISSUE_STATUS_VALUES];
    const cursor = decodeSemanticIssueCursor(input.cursor);
    const statusRankExpression = `CASE nis.embedding_status
             WHEN 'failed' THEN 0
             WHEN 'stale' THEN 1
             ELSE 2
           END`;
    const whereClauses = [`nis.embedding_status IN (${statuses.map(() => "?").join(", ")})`];
    const values: SqlValue[] = [...statuses];

    if (cursor) {
      whereClauses.push(
        `(
          ${statusRankExpression} > ?
          OR (${statusRankExpression} = ? AND nis.updated_at < ?)
          OR (${statusRankExpression} = ? AND nis.updated_at = ? AND nis.node_id < ?)
        )`
      );
      values.push(cursor.statusRank, cursor.statusRank, cursor.updatedAt, cursor.statusRank, cursor.updatedAt, cursor.nodeId);
    }

    const rows = this.db
      .prepare(
        `SELECT nis.node_id, n.title, nis.embedding_status, nis.stale_reason, nis.updated_at,
                ${statusRankExpression} AS status_rank
         FROM node_index_state nis
         JOIN nodes n ON n.id = nis.node_id
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY
           status_rank ASC,
           nis.updated_at DESC,
           nis.node_id DESC
         LIMIT ?`
      )
      .all(...values, limit + 1) as Array<Record<string, unknown>>;

    const items = rows.slice(0, limit).map((row) => ({
      nodeId: String(row.node_id),
      title: row.title ? String(row.title) : null,
      embeddingStatus: String(row.embedding_status) as SemanticIndexStatus,
      staleReason: row.stale_reason ? String(row.stale_reason) : null,
      updatedAt: String(row.updated_at)
    }));
    const hasMore = rows.length > limit;
    const lastItem = items.at(-1);

    return {
      items,
      nextCursor:
        hasMore && lastItem
          ? encodeSemanticIssueCursor({
              statusRank: semanticIssueStatusRank(lastItem.embeddingStatus),
              updatedAt: lastItem.updatedAt,
              nodeId: lastItem.nodeId
            })
          : null
    };
  }

  async rankSemanticCandidates(
    query: string,
    candidateNodeIds: string[]
  ): Promise<Map<string, SemanticCandidateSimilarity>> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || !candidateNodeIds.length) {
      return new Map();
    }

    this.markSemanticConfigurationMismatchesStale();
    const settings = this.readSemanticIndexSettings();
    if (!settings.enabled || !settings.provider || !settings.model) {
      return new Map();
    }

    const queryEmbedding = await embedSemanticQueryText({
      provider: settings.provider,
      model: settings.model,
      text: normalizedQuery,
    });
    if (!queryEmbedding?.vector.length) {
      return new Map();
    }

    const similarityByNode = new Map<string, SemanticSimilarityAccumulator>();
    const matches = await this.resolveVectorIndexStore(settings.indexBackend).searchCandidates({
      queryVector: queryEmbedding.vector,
      candidateNodeIds,
      embeddingProvider: settings.provider,
      embeddingModel: settings.model,
      embeddingVersion: settings.version
    }).catch(() => []);
    for (const match of matches) {
      const accumulator = similarityByNode.get(match.nodeId) ?? {
        matchedChunks: 0,
        maxSimilarity: Number.NEGATIVE_INFINITY,
        topSimilarities: []
      };
      updateSemanticSimilarityAccumulator(accumulator, match.similarity, settings.chunkAggregation);
      similarityByNode.set(match.nodeId, accumulator);
    }

    const rankedMatches = new Map<string, SemanticCandidateSimilarity>();
    for (const [nodeId, accumulator] of similarityByNode.entries()) {
      const similarities =
        settings.chunkAggregation === "topk_mean" ? accumulator.topSimilarities : [accumulator.maxSimilarity];
      rankedMatches.set(nodeId, {
        similarity: aggregateChunkSimilarities(similarities, settings.chunkAggregation),
        matchedChunks: accumulator.matchedChunks
      });
    }

    return rankedMatches;
  }

  listNodes(limit = 20): SearchResultItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, title, summary, status, canonicality, source_label, updated_at, tags_json
         FROM nodes
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: String(row.id),
      type: row.type as SearchResultItem["type"],
      title: row.title ? String(row.title) : null,
      summary: row.summary ? String(row.summary) : null,
      status: row.status as SearchResultItem["status"],
      canonicality: row.canonicality as SearchResultItem["canonicality"],
      sourceLabel: row.source_label ? String(row.source_label) : null,
      updatedAt: String(row.updated_at),
      tags: parseJson<string[]>(row.tags_json as string | null, [])
    }));
  }

  listAllNodes(): NodeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM nodes ORDER BY updated_at DESC, id DESC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapNode);
  }

  listActiveNodesByType(type: string, limit = 20): NodeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM nodes
         WHERE type = ?
           AND status = 'active'
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`
      )
      .all(type, limit) as Record<string, unknown>[];

    return rows.map(mapNode);
  }

  listInferenceCandidateNodes(targetNodeId: string, limit = 200): NodeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE id != ?
           AND status = 'active'
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(targetNodeId, limit) as Record<string, unknown>[];

    return rows.map(mapNode);
  }

  listProjectMembershipIdsByNodeIds(nodeIds: string[]): Map<string, string[]> {
    if (!nodeIds.length) {
      return new Map();
    }

    const uniqueIds = Array.from(new Set(nodeIds));
    const memberships = new Map(uniqueIds.map((nodeId) => [nodeId, new Set<string>()] as const));
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const projectRows = this.db
      .prepare(
        `SELECT id
         FROM nodes
         WHERE id IN (${placeholders})
           AND type = 'project'`
      )
      .all(...uniqueIds) as Array<Record<string, unknown>>;

    for (const row of projectRows) {
      const nodeId = String(row.id);
      memberships.get(nodeId)?.add(nodeId);
    }

    const relationRows = this.db
      .prepare(
        `SELECT r.from_node_id AS node_id, r.to_node_id AS project_id
         FROM relations r
         JOIN nodes p ON p.id = r.to_node_id
         WHERE r.status = 'active'
           AND r.from_node_id IN (${placeholders})
           AND p.type = 'project'
           AND p.status = 'active'
         UNION
         SELECT r.to_node_id AS node_id, r.from_node_id AS project_id
         FROM relations r
         JOIN nodes p ON p.id = r.from_node_id
         WHERE r.status = 'active'
           AND r.to_node_id IN (${placeholders})
           AND p.type = 'project'
           AND p.status = 'active'`
      )
      .all(...uniqueIds, ...uniqueIds) as Array<Record<string, unknown>>;

    for (const row of relationRows) {
      const nodeId = String(row.node_id);
      memberships.get(nodeId)?.add(String(row.project_id));
    }

    return new Map(
      [...memberships.entries()].map(([nodeId, projectIds]) => [nodeId, Array.from(projectIds)] as const)
    );
  }

  listArtifactKeysByNodeIds(nodeIds: string[]): Map<string, { exactPaths: string[]; baseNames: string[] }> {
    if (!nodeIds.length) {
      return new Map();
    }

    const uniqueIds = Array.from(new Set(nodeIds));
    const artifactsByNode = new Map(
      uniqueIds.map((nodeId) => [nodeId, { exactPaths: new Set<string>(), baseNames: new Set<string>() }] as const)
    );
    const rows = this.db
      .prepare(
        `SELECT node_id, path
         FROM artifacts
         WHERE node_id IN (${uniqueIds.map(() => "?").join(", ")})
         ORDER BY created_at DESC`
      )
      .all(...uniqueIds) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const nodeId = String(row.node_id);
      const pathValue = normalizeSearchText(row.path ? String(row.path) : null);
      if (!pathValue) {
        continue;
      }

      const bucket = artifactsByNode.get(nodeId);
      if (!bucket) {
        continue;
      }

      bucket.exactPaths.add(pathValue);
      bucket.baseNames.add(normalizeSearchText(path.basename(pathValue)));
    }

    return new Map(
      [...artifactsByNode.entries()].map(([nodeId, values]) => [
        nodeId,
        {
          exactPaths: Array.from(values.exactPaths),
          baseNames: Array.from(values.baseNames)
        }
      ])
    );
  }

  listSharedProjectMemberNodeIds(targetNodeId: string, limit = 200): string[] {
    const projectIds = this.listProjectMembershipIdsByNodeIds([targetNodeId]).get(targetNodeId) ?? [];
    if (!projectIds.length) {
      return [];
    }

    const placeholders = projectIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT node_id
         FROM (
           SELECT
             CASE
               WHEN r.from_node_id IN (${placeholders}) THEN r.to_node_id
               ELSE r.from_node_id
             END AS node_id,
             MAX(r.created_at) AS last_related_at
           FROM relations r
           JOIN nodes n
             ON n.id = CASE
               WHEN r.from_node_id IN (${placeholders}) THEN r.to_node_id
               ELSE r.from_node_id
             END
           WHERE r.status = 'active'
             AND (
               r.from_node_id IN (${placeholders})
               OR r.to_node_id IN (${placeholders})
             )
             AND n.status = 'active'
             AND n.id != ?
           GROUP BY node_id
         )
         ORDER BY last_related_at DESC
         LIMIT ?`
      )
      .all(
        ...projectIds,
        ...projectIds,
        ...projectIds,
        ...projectIds,
        targetNodeId,
        limit
      ) as Array<Record<string, unknown>>;

    return rows.map((row) => String(row.node_id));
  }

  listNodesSharingArtifactPaths(targetNodeId: string, limit = 200): string[] {
    const artifactPaths = Array.from(
      new Set(
        this.listArtifacts(targetNodeId)
          .map((artifact) => artifact.path)
          .filter(Boolean)
      )
    );
    if (!artifactPaths.length) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT DISTINCT node_id
         FROM artifacts
         WHERE path IN (${artifactPaths.map(() => "?").join(", ")})
           AND node_id != ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...artifactPaths, targetNodeId, limit) as Record<string, unknown>[];

    return rows.map((row) => String(row.node_id));
  }

  listInferenceTargetNodeIds(limit = 250): string[] {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM nodes
         WHERE status = 'active'
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => String(row.id));
  }

  searchNodes(input: {
    query: string;
    filters: {
      types?: string[];
      status?: string[];
      sourceLabels?: string[];
      tags?: string[];
    };
    limit: number;
    offset: number;
    sort: "relevance" | "updated_at";
  }): { items: SearchResultItem[]; total: number } {
    if (input.query.trim()) {
      try {
        const result = this.searchNodesWithFts(input);
        appendCurrentTelemetryDetails({
          ftsFallback: false,
          lexicalQuality: summarizeLexicalQuality(result.items),
          resultCount: result.items.length,
          totalCount: result.total
        });
        return result;
      } catch {
        const fallbackResult = this.searchNodesWithLike(input);
        appendCurrentTelemetryDetails({
          ftsFallback: true,
          lexicalQuality: summarizeLexicalQuality(fallbackResult.items),
          resultCount: fallbackResult.items.length,
          totalCount: fallbackResult.total
        });
        return fallbackResult;
      }
    }

    const result = this.searchNodesWithLike(input);
    appendCurrentTelemetryDetails({
      ftsFallback: false,
      lexicalQuality: summarizeLexicalQuality(result.items),
      resultCount: result.items.length,
      totalCount: result.total
    });
    return result;
  }

  searchActivities(input: ActivitySearchInput): { items: ActivitySearchResultItem[]; total: number } {
    if (input.query.trim()) {
      try {
        const result = this.searchActivitiesWithFts(input);
        appendCurrentTelemetryDetails({
          ftsFallback: false,
          lexicalQuality: summarizeLexicalQuality(result.items),
          resultCount: result.items.length,
          totalCount: result.total
        });
        return result;
      } catch {
        const fallbackResult = this.searchActivitiesWithLike(input);
        appendCurrentTelemetryDetails({
          ftsFallback: true,
          lexicalQuality: summarizeLexicalQuality(fallbackResult.items),
          resultCount: fallbackResult.items.length,
          totalCount: fallbackResult.total
        });
        return fallbackResult;
      }
    }

    const result = this.searchActivitiesWithLike(input);
    appendCurrentTelemetryDetails({
      ftsFallback: false,
      lexicalQuality: summarizeLexicalQuality(result.items),
      resultCount: result.items.length,
      totalCount: result.total
    });
    return result;
  }

  private listWorkspaceSemanticFallbackCandidateNodeIds(
    filters: WorkspaceSearchInput["nodeFilters"],
    settings: Pick<SemanticIndexSettings, "provider" | "model" | "version">,
    limit: number
  ): string[] {
    if (!settings.provider || !settings.model) {
      return [];
    }

    this.markSemanticConfigurationMismatchesStale();

    const where = [
      `n.status IN (${(filters?.status?.length ? filters.status : ["active", "draft"]).map(() => "?").join(", ")})`,
      `nis.embedding_status = 'ready'`,
      `nis.embedding_provider = ?`,
      `nis.embedding_model = ?`,
      `nis.embedding_version ${settings.version === null ? "IS NULL" : "= ?"}`
    ];
    const whereValues: SqlValue[] = [
      ...((filters?.status?.length ? filters.status : ["active", "draft"]) as SqlValue[]),
      settings.provider,
      settings.model,
      ...(settings.version === null ? [] : [settings.version])
    ];

    if (filters?.types?.length) {
      where.push(`n.type IN (${filters.types.map(() => "?").join(", ")})`);
      whereValues.push(...(filters.types as SqlValue[]));
    }

    if (filters?.sourceLabels?.length) {
      where.push(`n.source_label IN (${filters.sourceLabels.map(() => "?").join(", ")})`);
      whereValues.push(...(filters.sourceLabels as SqlValue[]));
    }

    if (filters?.tags?.length) {
      for (const tag of normalizeTagList(filters.tags)) {
        where.push("EXISTS (SELECT 1 FROM node_tags nt WHERE nt.node_id = n.id AND nt.tag = ?)");
        whereValues.push(tag);
      }
    }

    const rows = this.db
      .prepare(
        `SELECT n.id
         FROM nodes n
         JOIN node_index_state nis ON nis.node_id = n.id
         WHERE ${where.join(" AND ")}
         ORDER BY n.updated_at DESC
         LIMIT ?`
      )
      .all(...whereValues, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => String(row.id));
  }

  private buildWorkspaceSemanticFallbackNodeItems(
    candidateNodeIds: string[],
    semanticMatches: Map<string, SemanticCandidateSimilarity>,
    settings: SemanticAugmentationSettings
  ): SearchResultItem[] {
    type RankedSemanticSearchResultItem = SearchResultItem & {
      matchReason: SearchMatchReason;
      semanticSimilarity: number;
      semanticRetrievalRank: number;
    };

    const rankedItems: RankedSemanticSearchResultItem[] = [];
    const candidateNodes = this.getNodesByIds(candidateNodeIds);
    for (const nodeId of candidateNodeIds) {
      const semanticMatch = semanticMatches.get(nodeId);
      if (!semanticMatch) {
        continue;
      }

      const retrievalRank = computeSemanticRetrievalRank(semanticMatch.similarity, settings);
      if (retrievalRank <= 0) {
        continue;
      }

      const node = candidateNodes.get(nodeId);
      if (!node) {
        continue;
      }

      rankedItems.push({
        id: node.id,
        type: node.type,
        title: node.title,
        summary: node.summary,
        status: node.status,
        canonicality: node.canonicality,
        sourceLabel: node.sourceLabel,
        updatedAt: node.updatedAt,
        tags: node.tags,
        matchReason: buildSearchMatchReason("semantic", ["semantic"]),
        semanticSimilarity: Number(semanticMatch.similarity.toFixed(4)),
        semanticRetrievalRank: retrievalRank
      });
    }

    return rankedItems
      .sort(
        (left, right) =>
          right.semanticRetrievalRank - left.semanticRetrievalRank || right.updatedAt.localeCompare(left.updatedAt)
      )
      .map(({ semanticSimilarity: _semanticSimilarity, semanticRetrievalRank: _semanticRetrievalRank, ...item }) => item);
  }

  async searchWorkspace(
    input: WorkspaceSearchInput,
    options: {
      runSemanticFallbackSpan?: <T>(
        details: JsonMap,
        callback: () => Promise<T>
      ) => Promise<T>;
    } = {}
  ): Promise<{ items: WorkspaceSearchResultItem[]; total: number; telemetry: WorkspaceSearchTelemetry }> {
    const includeNodes = input.scopes.includes("nodes");
    const includeActivities = input.scopes.includes("activities");
    const requestedWindow = Math.min(input.limit + input.offset + SEARCH_FEEDBACK_WINDOW_PADDING, SEARCH_FEEDBACK_MAX_WINDOW);
    const queryPresent = Boolean(input.query.trim());
    const searchSort = input.sort === "smart" ? (queryPresent ? "relevance" : "updated_at") : input.sort;
    const normalizedQuery = input.query.trim();
    const nodeResults = includeNodes
      ? this.searchNodes({
          query: input.query,
          filters: input.nodeFilters ?? {},
          limit: requestedWindow,
          offset: 0,
          sort: searchSort
        })
      : { items: [], total: 0 };
    const activityResults = includeActivities
      ? this.searchActivities({
          query: input.query,
          filters: input.activityFilters ?? {},
          limit: requestedWindow,
          offset: 0,
          sort: searchSort
        })
      : { items: [], total: 0 };
    const fallbackTriggered = queryPresent && nodeResults.total + activityResults.total === 0;
    const fallbackTokens = fallbackTriggered ? tokenizeSearchQuery(input.query, SEARCH_FALLBACK_TOKEN_LIMIT) : [];
    const resolvedNodeResults =
      fallbackTokens.length >= 2 && includeNodes
        ? this.searchWorkspaceNodeFallback(fallbackTokens, input.nodeFilters ?? {}, requestedWindow)
        : nodeResults;
    const resolvedActivityResults =
      fallbackTokens.length >= 2 && includeActivities
        ? this.searchWorkspaceActivityFallback(fallbackTokens, input.activityFilters ?? {}, requestedWindow)
        : activityResults;
    const bestNodeLexicalQuality = summarizeLexicalQuality(resolvedNodeResults.items);
    const bestActivityLexicalQuality = summarizeLexicalQuality(resolvedActivityResults.items);
    const merged = this.mergeWorkspaceSearchResults(
      resolvedNodeResults.items,
      resolvedActivityResults.items,
      input.sort
    );

    const deterministicResult = {
      total:
        fallbackTokens.length >= 2
          ? merged.length
          : resolvedNodeResults.total + resolvedActivityResults.total,
      items: merged.slice(input.offset, input.offset + input.limit)
    };
    const semanticSettings = this.readSemanticIndexSettings();
    const telemetry: WorkspaceSearchTelemetry = {
      semanticFallbackEligible: false,
      semanticFallbackAttempted: false,
      semanticFallbackUsed: false,
      semanticFallbackMode:
        includeNodes && semanticSettings.workspaceFallbackEnabled ? semanticSettings.workspaceFallbackMode : null,
      semanticFallbackCandidateCount: 0,
      semanticFallbackResultCount: 0,
      semanticFallbackBackend: null,
      semanticFallbackConfiguredBackend: semanticSettings.configuredIndexBackend,
      semanticFallbackSkippedReason: null,
      semanticFallbackQueryLengthBucket: queryPresent ? bucketSemanticQueryLength(normalizedQuery.length) : null
    };
    const appendWorkspaceSearchTelemetry = (result: { items: WorkspaceSearchResultItem[]; total: number }) => {
      const nodeItems = result.items.flatMap((item) => item.resultType === "node" && item.node ? [item.node] : []);
      const activityItems = result.items.flatMap((item) =>
        item.resultType === "activity" && item.activity ? [item.activity] : []
      );
      appendCurrentTelemetryDetails({
        searchHit: result.items.length > 0,
        candidateCount: requestedWindow,
        nodeCandidateCount: resolvedNodeResults.items.length,
        activityCandidateCount: resolvedActivityResults.items.length,
        nodeResultCount: nodeItems.length,
        activityResultCount: activityItems.length,
        bestNodeLexicalQuality,
        bestActivityLexicalQuality,
        lexicalNodeHit: bestNodeLexicalQuality !== "none",
        strongNodeLexicalHit: bestNodeLexicalQuality === "strong",
        resultComposition: computeWorkspaceResultComposition({
          nodeCount: nodeItems.length,
          activityCount: activityItems.length,
          semanticUsed: telemetry.semanticFallbackUsed
        }),
        resultCount: result.items.length,
        totalCount: result.total,
        fallbackTokenCount: fallbackTokens.length,
        semanticFallbackEligible: telemetry.semanticFallbackEligible,
        semanticFallbackAttempted: telemetry.semanticFallbackAttempted,
        semanticFallbackUsed: telemetry.semanticFallbackUsed,
        semanticFallbackMode: telemetry.semanticFallbackMode ?? undefined,
        semanticFallbackCandidateCount: telemetry.semanticFallbackCandidateCount,
        semanticFallbackResultCount: telemetry.semanticFallbackResultCount,
        semanticFallbackBackend: telemetry.semanticFallbackBackend,
        semanticFallbackConfiguredBackend: telemetry.semanticFallbackConfiguredBackend,
        semanticFallbackSkippedReason: telemetry.semanticFallbackSkippedReason
      });
    };

    const strictZeroFallbackBlocked = resolvedNodeResults.total + resolvedActivityResults.total > 0;
    const noStrongNodeFallbackBlocked = bestNodeLexicalQuality === "strong";
    const semanticFallbackBlockedByMode =
      semanticSettings.workspaceFallbackMode === "strict_zero"
        ? strictZeroFallbackBlocked
        : noStrongNodeFallbackBlocked;

    const shouldAttemptSemanticFallback =
      includeNodes &&
      semanticSettings.workspaceFallbackEnabled &&
      queryPresent &&
      normalizedQuery.length >= 6 &&
      semanticSettings.enabled &&
      Boolean(semanticSettings.provider && semanticSettings.model) &&
      !semanticFallbackBlockedByMode;

    if (!includeNodes) {
      telemetry.semanticFallbackSkippedReason = "nodes_scope_disabled";
    } else if (!queryPresent) {
      telemetry.semanticFallbackSkippedReason = "query_empty";
    } else if (normalizedQuery.length < 6) {
      telemetry.semanticFallbackSkippedReason = "query_too_short";
    } else if (!semanticSettings.workspaceFallbackEnabled) {
      telemetry.semanticFallbackSkippedReason = "workspace_fallback_disabled";
    } else if (!semanticSettings.enabled) {
      telemetry.semanticFallbackSkippedReason = "semantic_disabled";
    } else if (!semanticSettings.provider || !semanticSettings.model) {
      telemetry.semanticFallbackSkippedReason = "semantic_provider_unconfigured";
    } else if (semanticSettings.workspaceFallbackMode === "strict_zero" && strictZeroFallbackBlocked) {
      telemetry.semanticFallbackSkippedReason = "strict_zero_results_present";
    } else if (semanticSettings.workspaceFallbackMode === "no_strong_node_hit" && noStrongNodeFallbackBlocked) {
      telemetry.semanticFallbackSkippedReason = "strong_node_lexical_present";
    }

    if (shouldAttemptSemanticFallback) {
      const candidateNodeIds = this.listWorkspaceSemanticFallbackCandidateNodeIds(
        input.nodeFilters ?? {},
        semanticSettings,
        200
      );
      telemetry.semanticFallbackEligible = true;
      telemetry.semanticFallbackCandidateCount = candidateNodeIds.length;
      telemetry.semanticFallbackBackend = semanticSettings.indexBackend;

      if (!candidateNodeIds.length) {
        telemetry.semanticFallbackSkippedReason = "candidate_pool_empty";
      } else {
        telemetry.semanticFallbackAttempted = true;
        const runSemanticFallback = async () => {
          const items = this.buildWorkspaceSemanticFallbackNodeItems(
            candidateNodeIds,
            await this.rankSemanticCandidates(normalizedQuery, candidateNodeIds),
            this.getSemanticAugmentationSettings()
          );
          return {
            items,
            resultCount: items.length
          };
        };

        try {
          const semanticResult = options.runSemanticFallbackSpan
            ? await options.runSemanticFallbackSpan(
                {
                  semanticFallbackCandidateCount: candidateNodeIds.length,
                  semanticFallbackBackend: semanticSettings.indexBackend,
                  semanticFallbackConfiguredBackend: semanticSettings.configuredIndexBackend,
                  semanticFallbackMode: telemetry.semanticFallbackMode ?? undefined,
                  semanticFallbackQueryLengthBucket: telemetry.semanticFallbackQueryLengthBucket
                },
                runSemanticFallback
              )
            : await runSemanticFallback();
          telemetry.semanticFallbackResultCount = semanticResult.resultCount;

          if (semanticResult.resultCount > 0) {
            telemetry.semanticFallbackUsed = true;
            const mergedNodeItems = mergeNodeSearchItems(semanticResult.items, resolvedNodeResults.items);
            const mergedSemanticItems = this.mergeWorkspaceSearchResults(
              mergedNodeItems,
              resolvedActivityResults.items,
              input.sort
            );
            const semanticWorkspaceResult = {
              total: mergedNodeItems.length + (includeActivities ? resolvedActivityResults.total : 0),
              items: mergedSemanticItems.slice(input.offset, input.offset + input.limit)
            };
            appendWorkspaceSearchTelemetry(semanticWorkspaceResult);
            return {
              ...semanticWorkspaceResult,
              telemetry
            };
          }

          telemetry.semanticFallbackSkippedReason = "semantic_no_matches";
        } catch (error) {
          telemetry.semanticFallbackSkippedReason =
            error instanceof VectorIndexStoreError ? error.code : "semantic_fallback_error";
        }
      }
    }

    appendWorkspaceSearchTelemetry(deterministicResult);
    return {
      ...deterministicResult,
      telemetry
    };
  }

  private searchWorkspaceNodeFallback(
    tokens: string[],
    filters: WorkspaceSearchInput["nodeFilters"],
    limit: number
  ): { items: SearchResultItem[]; total: number } {
    if (!tokens.length) {
      return { total: 0, items: [] };
    }

    const queryLikes = tokens.map((token) => `%${token}%`);
    const tokenWhere = tokens
      .map(
        () =>
          `(lower(coalesce(n.title, '')) LIKE lower(?) OR lower(coalesce(n.body, '')) LIKE lower(?) OR lower(coalesce(n.summary, '')) LIKE lower(?))`
      )
      .join(" OR ");

    return this.runSearchQuery(
      "nodes n",
      [`(${tokenWhere})`],
      queryLikes.flatMap((token) => [token, token, token]),
      "CASE WHEN n.status = 'contested' THEN 1 ELSE 0 END, n.updated_at DESC",
      [],
      limit,
      0,
      filters ?? {},
      false,
      tokens.join(" "),
      "fallback_token"
    );
  }

  private searchWorkspaceActivityFallback(
    tokens: string[],
    filters: WorkspaceSearchInput["activityFilters"],
    limit: number
  ): { items: ActivitySearchResultItem[]; total: number } {
    if (!tokens.length) {
      return { total: 0, items: [] };
    }

    const queryLikes = tokens.map((token) => `%${token}%`);
    const initialWhere = [
      `(${tokens
        .map(
          () =>
            `(lower(coalesce(a.body, '')) LIKE lower(?) OR lower(coalesce(n.title, '')) LIKE lower(?) OR lower(coalesce(a.activity_type, '')) LIKE lower(?) OR lower(coalesce(a.source_label, '')) LIKE lower(?))`
        )
        .join(" OR ")})`
    ];

    return this.runActivitySearchQuery({
      from: "activities a JOIN nodes n ON n.id = a.target_node_id",
      initialWhere,
      initialWhereValues: queryLikes.flatMap((token) => [token, token, token, token]),
      orderBy: "CASE WHEN n.status = 'contested' THEN 1 ELSE 0 END, a.created_at DESC",
      orderValues: [],
      input: {
        query: tokens.join(" "),
        filters: filters ?? {},
        limit,
        offset: 0,
        sort: "updated_at"
      },
      strategy: "fallback_token"
    });
  }

  private mergeWorkspaceSearchResults(
    nodeItems: SearchResultItem[],
    activityItems: ActivitySearchResultItem[],
    sort: WorkspaceSearchInput["sort"]
  ): WorkspaceSearchResultItem[] {
    const includeSmartScore = sort === "smart";
    const nowMs = includeSmartScore ? Date.now() : 0;
    const merged = [
      ...nodeItems.map((node, index) => ({
        resultType: "node" as const,
        node,
        index,
        total: nodeItems.length,
        timestamp: node.updatedAt,
        contested: node.status === "contested",
        smartScore: includeSmartScore
          ? computeWorkspaceSmartScore({
              index,
              total: nodeItems.length,
              timestamp: node.updatedAt,
              resultType: "node",
              contested: node.status === "contested",
              matchReason: node.matchReason,
              lexicalQuality: node.lexicalQuality,
              nowMs
            })
          : 0
      })),
      ...activityItems.map((activity, index) => ({
        resultType: "activity" as const,
        activity,
        index,
        total: activityItems.length,
        timestamp: activity.createdAt,
        contested: activity.targetNodeStatus === "contested",
        smartScore: includeSmartScore
          ? computeWorkspaceSmartScore({
              index,
              total: activityItems.length,
              timestamp: activity.createdAt,
              resultType: "activity",
              contested: activity.targetNodeStatus === "contested",
              matchReason: activity.matchReason,
              lexicalQuality: activity.lexicalQuality,
              nowMs
            })
          : 0
      }))
    ];

    if (sort === "updated_at") {
      return merged
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .map(({ index: _index, total: _total, timestamp: _timestamp, contested: _contested, smartScore: _smartScore, ...item }) => item);
    }

    if (sort === "smart") {
      return merged
        .sort((left, right) => right.smartScore - left.smartScore || right.timestamp.localeCompare(left.timestamp))
        .map(({ index: _index, total: _total, timestamp: _timestamp, contested: _contested, smartScore: _smartScore, ...item }) => item);
    }

    return merged.map(({ index: _index, total: _total, timestamp: _timestamp, contested: _contested, smartScore: _smartScore, ...item }) => item);
  }

  private mergeNodeSearchResults(primary: SearchResultItem[], secondary: SearchResultItem[]): SearchResultItem[] {
    const merged = new Map<string, SearchResultItem>();
    for (const item of [...primary, ...secondary]) {
      const current = merged.get(item.id);
      if (!current) {
        merged.set(item.id, item);
        continue;
      }

      merged.set(item.id, {
        ...current,
        matchReason:
          current.matchReason?.strategy === "semantic" && item.matchReason
            ? item.matchReason
            : current.matchReason ?? item.matchReason,
        lexicalQuality: mergeLexicalQuality(current.lexicalQuality, item.lexicalQuality)
      });
    }
    return Array.from(merged.values());
  }

  private searchNodesWithFts(input: {
    query: string;
    filters: {
      types?: string[];
      status?: string[];
      sourceLabels?: string[];
      tags?: string[];
    };
    limit: number;
    offset: number;
    sort: "relevance" | "updated_at";
  }): { items: SearchResultItem[]; total: number } {
    const where: string[] = [];
    const values: unknown[] = [];
    const from = "nodes n JOIN nodes_fts fts ON fts.rowid = n.rowid";
    let orderBy = "n.updated_at DESC";

    where.push("nodes_fts MATCH ?");
    values.push(input.query.trim());
    if (input.sort === "relevance") {
      orderBy = "CASE WHEN n.status = 'contested' THEN 1 ELSE 0 END, bm25(nodes_fts, 3.0, 1.5, 2.0), n.updated_at DESC";
    }

    return this.runSearchQuery(
      from,
      where,
      values,
      orderBy,
      [],
      input.limit,
      input.offset,
      input.filters,
      input.sort === "relevance",
      input.query,
      "fts"
    );
  }

  private searchNodesWithLike(input: {
    query: string;
    filters: {
      types?: string[];
      status?: string[];
      sourceLabels?: string[];
      tags?: string[];
    };
    limit: number;
    offset: number;
    sort: "relevance" | "updated_at";
  }): { items: SearchResultItem[]; total: number } {
    const where: string[] = [];
    const values: unknown[] = [];
    let orderBy = "CASE WHEN n.status = 'contested' THEN 1 ELSE 0 END, n.updated_at DESC";

    if (input.query.trim()) {
      where.push(
        `(lower(coalesce(n.title, '')) LIKE lower(?) OR lower(coalesce(n.body, '')) LIKE lower(?) OR lower(coalesce(n.summary, '')) LIKE lower(?))`
      );
      const queryLike = `%${input.query.trim()}%`;
      values.push(queryLike, queryLike, queryLike);
      if (input.sort === "relevance") {
        orderBy = `
          CASE
            WHEN lower(coalesce(n.title, '')) LIKE lower(?) THEN 0
            WHEN lower(coalesce(n.summary, '')) LIKE lower(?) THEN 1
            ELSE 2
          END,
          CASE WHEN n.status = 'contested' THEN 1 ELSE 0 END,
          n.updated_at DESC
        `;
        values.push(queryLike, queryLike);
      }
    }

    const orderValues = input.sort === "relevance" && input.query.trim() ? values.slice(-2) : [];
    const whereValues = orderValues.length ? values.slice(0, -2) : values;

    return this.runSearchQuery(
      "nodes n",
      where,
      whereValues,
      orderBy,
      orderValues,
      input.limit,
      input.offset,
      input.filters,
      input.sort === "relevance",
      input.query,
      input.query.trim() ? "like" : "browse"
    );
  }

  private applySearchFeedbackBoost(items: SearchResultItem[]): SearchResultItem[] {
    if (items.length <= 1) {
      return items;
    }

    const summaries = this.getSearchFeedbackSummaries("node", items.map((item) => item.id));
    return [...items]
      .map((item, index) => ({
        item,
        score:
          items.length - index +
          clampSearchFeedbackDelta(summaries.get(item.id)?.totalDelta ?? 0) * 2 -
          (item.status === "contested" ? 1 : 0)
      }))
      .sort((left, right) => right.score - left.score || right.item.updatedAt.localeCompare(left.item.updatedAt))
      .map(({ item }) => item);
  }

  private applyActivitySearchFeedbackBoost(items: ActivitySearchResultItem[]): ActivitySearchResultItem[] {
    if (items.length <= 1) {
      return items;
    }

    const summaries = this.getSearchFeedbackSummaries("activity", items.map((item) => item.id));
    return [...items]
      .map((item, index) => ({
        item,
        score:
          items.length - index +
          clampSearchFeedbackDelta(summaries.get(item.id)?.totalDelta ?? 0) * 2 -
          (item.targetNodeStatus === "contested" ? 1 : 0)
      }))
      .sort((left, right) => right.score - left.score || right.item.createdAt.localeCompare(left.item.createdAt))
      .map(({ item }) => item);
  }

  private searchActivitiesWithFts(input: ActivitySearchInput): { items: ActivitySearchResultItem[]; total: number } {
    return this.runActivitySearchQuery({
      from: "activities a JOIN activities_fts ON activities_fts.rowid = a.rowid JOIN nodes n ON n.id = a.target_node_id",
      initialWhere: ["activities_fts MATCH ?"],
      initialWhereValues: [input.query.trim()],
      orderBy:
        input.sort === "relevance"
          ? "CASE WHEN n.status = 'contested' THEN 1 ELSE 0 END, bm25(activities_fts, 2.0, 1.0), a.created_at DESC"
          : "CASE WHEN n.status = 'contested' THEN 1 ELSE 0 END, a.created_at DESC",
      orderValues: [],
      input,
      strategy: "fts"
    });
  }

  private searchActivitiesWithLike(input: ActivitySearchInput): { items: ActivitySearchResultItem[]; total: number } {
    const initialWhere: string[] = [];
    const initialWhereValues: SqlValue[] = [];
    let orderBy = "CASE WHEN n.status = 'contested' THEN 1 ELSE 0 END, a.created_at DESC";
    const orderValues: SqlValue[] = [];

    if (input.query.trim()) {
      const queryLike = `%${input.query.trim()}%`;
      initialWhere.push(
        `(lower(coalesce(a.body, '')) LIKE lower(?) OR lower(coalesce(n.title, '')) LIKE lower(?) OR lower(coalesce(a.activity_type, '')) LIKE lower(?) OR lower(coalesce(a.source_label, '')) LIKE lower(?))`
      );
      initialWhereValues.push(queryLike, queryLike, queryLike, queryLike);
      if (input.sort === "relevance") {
        orderBy = `
          CASE
            WHEN lower(coalesce(a.body, '')) LIKE lower(?) THEN 0
            WHEN lower(coalesce(n.title, '')) LIKE lower(?) THEN 1
            WHEN lower(coalesce(a.activity_type, '')) LIKE lower(?) THEN 2
            ELSE 3
          END,
          CASE WHEN n.status = 'contested' THEN 1 ELSE 0 END,
          a.created_at DESC
        `;
        orderValues.push(queryLike, queryLike, queryLike);
      }
    }

    return this.runActivitySearchQuery({
      from: "activities a JOIN nodes n ON n.id = a.target_node_id",
      initialWhere,
      initialWhereValues,
      orderBy,
      orderValues,
      input,
      strategy: input.query.trim() ? "like" : "browse"
    });
  }

  private capActivityResultsPerTarget(items: ActivitySearchResultItem[]): ActivitySearchResultItem[] {
    const counts = new Map<string, number>();
    const capped: ActivitySearchResultItem[] = [];

    for (const item of items) {
      const currentCount = counts.get(item.targetNodeId) ?? 0;
      if (currentCount >= ACTIVITY_RESULT_CAP_PER_TARGET) {
        continue;
      }
      counts.set(item.targetNodeId, currentCount + 1);
      capped.push(item);
    }

    return capped;
  }

  private runActivitySearchQuery(params: {
    from: string;
    initialWhere: string[];
    initialWhereValues: SqlValue[];
    orderBy: string;
    orderValues: SqlValue[];
    input: ActivitySearchInput;
    strategy: SearchMatchReason["strategy"];
  }): { items: ActivitySearchResultItem[]; total: number } {
    const where = [...params.initialWhere];
    const whereValues = [...params.initialWhereValues];
    const { input } = params;

    if (input.filters.targetNodeIds?.length) {
      where.push(`a.target_node_id IN (${input.filters.targetNodeIds.map(() => "?").join(", ")})`);
      whereValues.push(...(input.filters.targetNodeIds as SqlValue[]));
    }

    if (input.filters.activityTypes?.length) {
      where.push(`a.activity_type IN (${input.filters.activityTypes.map(() => "?").join(", ")})`);
      whereValues.push(...(input.filters.activityTypes as SqlValue[]));
    }

    if (input.filters.sourceLabels?.length) {
      where.push(`a.source_label IN (${input.filters.sourceLabels.map(() => "?").join(", ")})`);
      whereValues.push(...(input.filters.sourceLabels as SqlValue[]));
    }

    if (input.filters.createdAfter) {
      where.push(`a.created_at >= ?`);
      whereValues.push(input.filters.createdAfter);
    }

    if (input.filters.createdBefore) {
      where.push(`a.created_at <= ?`);
      whereValues.push(input.filters.createdBefore);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS total
         FROM ${params.from}
         ${whereClause}`
      )
      .get(...whereValues) as { total: number };

    const useSearchFeedbackBoost = input.sort === "relevance";
    const effectiveLimit = useSearchFeedbackBoost
      ? Math.min(input.limit + input.offset + SEARCH_FEEDBACK_WINDOW_PADDING, SEARCH_FEEDBACK_MAX_WINDOW)
      : input.limit;
    const effectiveOffset = useSearchFeedbackBoost ? 0 : input.offset;
    const rows = this.db
      .prepare(
        `SELECT
           a.id,
           a.target_node_id,
           a.activity_type,
           a.body,
           a.source_label,
           a.created_at,
           a.metadata_json,
           n.title AS target_title,
           n.type AS target_type,
           n.status AS target_status
         FROM ${params.from}
         ${whereClause}
         ORDER BY ${params.orderBy}
         LIMIT ? OFFSET ?`
      )
      .all(...whereValues, ...params.orderValues, effectiveLimit, effectiveOffset) as Record<string, unknown>[];

    const matcher = params.strategy === "browse" ? null : createSearchFieldMatcher(params.input.query);
    const items = rows.map((row) => {
      const signals = collectSearchFieldSignals(matcher, [
        { field: "body", value: row.body ? String(row.body) : null },
        { field: "targetNodeTitle", value: row.target_title ? String(row.target_title) : null },
        { field: "activityType", value: row.activity_type ? String(row.activity_type) : null },
        { field: "sourceLabel", value: row.source_label ? String(row.source_label) : null }
      ]);
      const lexicalQuality = classifyActivityLexicalQuality(params.strategy, signals);
      return {
        id: String(row.id),
        targetNodeId: String(row.target_node_id),
        targetNodeTitle: row.target_title ? String(row.target_title) : null,
        targetNodeType: row.target_type ? (row.target_type as ActivitySearchResultItem["targetNodeType"]) : null,
        targetNodeStatus: row.target_status ? (row.target_status as ActivitySearchResultItem["targetNodeStatus"]) : null,
        activityType: row.activity_type as ActivitySearchResultItem["activityType"],
        body: row.body ? String(row.body) : null,
        sourceLabel: row.source_label ? String(row.source_label) : null,
        createdAt: String(row.created_at),
        metadata: parseJson<JsonMap>(row.metadata_json as string | null, {}),
        lexicalQuality,
        matchReason: buildSearchMatchReason(
          params.strategy,
          signals.matchedFields,
          {
            strength: lexicalQuality === "none" ? undefined : lexicalQuality,
            termCoverage:
              signals.totalTermCount > 0 ? Number((signals.matchedTermCount / signals.totalTermCount).toFixed(4)) : null
          }
        )
      };
    });
    const rankedItems = useSearchFeedbackBoost ? this.applyActivitySearchFeedbackBoost(items) : items;
    const cappedItems = this.capActivityResultsPerTarget(rankedItems);

    return {
      total: Number(countRow.total ?? 0),
      items: useSearchFeedbackBoost ? cappedItems.slice(input.offset, input.offset + input.limit) : cappedItems
    };
  }

  private runSearchQuery(
    from: string,
    initialWhere: string[],
    initialWhereValues: unknown[],
    orderBy: string,
    orderValues: unknown[],
    limit: number,
    offset: number,
    filters: {
      types?: string[];
      status?: string[];
      sourceLabels?: string[];
      tags?: string[];
    },
    useSearchFeedbackBoost: boolean,
    query: string,
    strategy: SearchMatchReason["strategy"]
  ): { items: SearchResultItem[]; total: number } {
    const where = [...initialWhere];
    const whereValues = [...initialWhereValues];

    if (filters.types?.length) {
      where.push(`n.type IN (${filters.types.map(() => "?").join(", ")})`);
      whereValues.push(...filters.types);
    }

    if (filters.status?.length) {
      where.push(`n.status IN (${filters.status.map(() => "?").join(", ")})`);
      whereValues.push(...filters.status);
    }

    if (filters.sourceLabels?.length) {
      where.push(`n.source_label IN (${filters.sourceLabels.map(() => "?").join(", ")})`);
      whereValues.push(...filters.sourceLabels);
    }

    if (filters.tags?.length) {
      for (const tag of normalizeTagList(filters.tags)) {
        where.push("EXISTS (SELECT 1 FROM node_tags nt WHERE nt.node_id = n.id AND nt.tag = ?)");
        whereValues.push(tag);
      }
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countValues = whereValues as SqlValue[];
    const rowValues = [...whereValues, ...orderValues] as SqlValue[];
    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM ${from} ${whereClause}`)
      .get(...countValues) as { total: number };

    const effectiveLimit = useSearchFeedbackBoost ? Math.min(limit + offset + SEARCH_FEEDBACK_WINDOW_PADDING, SEARCH_FEEDBACK_MAX_WINDOW) : limit;
    const effectiveOffset = useSearchFeedbackBoost ? 0 : offset;
    const rows = this.db
      .prepare(
        `SELECT n.id, n.type, n.title, n.body, n.summary, n.status, n.canonicality, n.source_label, n.updated_at, n.tags_json
         FROM ${from}
         ${whereClause}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`
      )
      .all(...rowValues, effectiveLimit, effectiveOffset) as Record<string, unknown>[];

    const matcher = strategy === "browse" ? null : createSearchFieldMatcher(query);
    const items = rows.map((row) => {
      const tags = parseJson<string[]>(row.tags_json as string | null, []);
      const signals = collectSearchFieldSignals(matcher, [
        { field: "title", value: row.title ? String(row.title) : null },
        { field: "summary", value: row.summary ? String(row.summary) : null },
        { field: "body", value: row.body ? String(row.body) : null },
        { field: "tags", value: tags.join(" ") },
        { field: "sourceLabel", value: row.source_label ? String(row.source_label) : null }
      ]);
      const lexicalQuality = classifyNodeLexicalQuality(strategy, signals);
      return {
        id: String(row.id),
        type: row.type as SearchResultItem["type"],
        title: row.title ? String(row.title) : null,
        summary: row.summary ? String(row.summary) : null,
        status: row.status as SearchResultItem["status"],
        canonicality: row.canonicality as SearchResultItem["canonicality"],
        sourceLabel: row.source_label ? String(row.source_label) : null,
        updatedAt: String(row.updated_at),
        tags,
        lexicalQuality,
        matchReason: buildSearchMatchReason(
          strategy,
          signals.matchedFields,
          {
            strength: lexicalQuality === "none" ? undefined : lexicalQuality,
            termCoverage:
              signals.totalTermCount > 0 ? Number((signals.matchedTermCount / signals.totalTermCount).toFixed(4)) : null
          }
        )
      };
    });
    const rankedItems = useSearchFeedbackBoost ? this.applySearchFeedbackBoost(items) : items;

    return {
      total: countRow.total,
      items: useSearchFeedbackBoost ? rankedItems.slice(offset, offset + limit) : rankedItems
    };
  }

  getNode(id: string): NodeRecord {
    const row = this.db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return mapNode(assertPresent(row, `Node ${id} not found`));
  }

  getNodesByIds(ids: string[]): Map<string, NodeRecord> {
    if (!ids.length) {
      return new Map();
    }

    const uniqueIds = Array.from(new Set(ids));
    const rows = this.db
      .prepare(`SELECT * FROM nodes WHERE id IN (${uniqueIds.map(() => "?").join(", ")})`)
      .all(...uniqueIds) as Record<string, unknown>[];

    return new Map(
      rows.map((row) => {
        const node = mapNode(row);
        return [node.id, node] as const;
      })
    );
  }

  ensureWorkspaceInboxNode(): NodeRecord {
    const settings = this.getSettings([WORKSPACE_CAPTURE_INBOX_KEY]);
    const inboxNodeId =
      typeof settings[WORKSPACE_CAPTURE_INBOX_KEY] === "string" ? String(settings[WORKSPACE_CAPTURE_INBOX_KEY]) : null;

    if (inboxNodeId) {
      try {
        const existing = this.getNode(inboxNodeId);
        if (existing.type === "conversation" && existing.status !== "archived") {
          return existing;
        }
      } catch {
        // fall through and recreate the system inbox node
      }
    }

    const inboxNode = this.createNode({
      type: "conversation",
      title: "Workspace Inbox",
      body: "Default timeline for captured agent updates when no target node is specified.",
      summary: "System-managed conversation node for untargeted capture activity.",
      tags: ["inbox"],
      source: workspaceInboxSource,
      metadata: {
        workspaceInbox: true,
        systemManaged: true
      },
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    this.setSetting(WORKSPACE_CAPTURE_INBOX_KEY, inboxNode.id);
    return inboxNode;
  }

  createNode(input: CreateNodeInput & { resolvedCanonicality: string; resolvedStatus: string }): NodeRecord {
    const now = nowIso();
    const id = createId("node");
    const nextSummary = input.summary ?? stableSummary(input.title, input.body);
    const nextMetadata = withSummaryMetadata(input.metadata, now, input.summary !== undefined ? "explicit" : "derived");
    this.runInTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO nodes (
            id, type, status, canonicality, visibility, title, body, summary,
            created_by, source_type, source_label, created_at, updated_at, tags_json, metadata_json
          ) VALUES (?, ?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.type,
          input.resolvedStatus,
          input.resolvedCanonicality,
          input.title,
          input.body,
          nextSummary,
          input.source.actorLabel,
          input.source.actorType,
          input.source.actorLabel,
          now,
          now,
          JSON.stringify(input.tags),
          JSON.stringify(nextMetadata)
        );
      this.syncNodeTags(id, input.tags);
      this.markNodeSemanticIndexState(id, "node.created", {
        status: "pending",
        contentHash: buildSemanticContentHash({
          title: input.title,
          body: input.body,
          summary: nextSummary,
          tags: input.tags
        }),
        updatedAt: now
      });
    });

    return this.getNode(id);
  }

  updateNode(id: string, input: UpdateNodeInput): NodeRecord {
    const existing = this.getNode(id);
    const nextTitle = input.title ?? existing.title;
    const nextBody = input.body ?? existing.body;
    const existingDerivedSummary = stableSummary(existing.title, existing.body);
    const shouldRefreshDerivedSummary =
      input.summary !== undefined
        ? false
        : input.title !== undefined || input.body !== undefined
          ? !existing.summary || existing.summary === existingDerivedSummary
          : false;
    const nextSummary =
      input.summary !== undefined
        ? input.summary
        : shouldRefreshDerivedSummary
          ? stableSummary(nextTitle, nextBody)
          : existing.summary;
    const nextTags = input.tags ?? existing.tags;
    const mergedMetadata = input.metadata ? { ...existing.metadata, ...input.metadata } : existing.metadata;
    const updatedAt = nowIso();
    const nextMetadata =
      input.summary !== undefined
        ? withSummaryMetadata(mergedMetadata, updatedAt, "explicit")
        : shouldRefreshDerivedSummary
          ? withSummaryMetadata(mergedMetadata, updatedAt, "derived")
          : mergedMetadata;
    const nextStatus = input.status ?? existing.status;

    this.runInTransaction(() => {
      this.db
        .prepare(
          `UPDATE nodes
           SET title = ?, body = ?, summary = ?, tags_json = ?, metadata_json = ?, status = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          nextTitle,
          nextBody,
          nextSummary,
          JSON.stringify(nextTags),
          JSON.stringify(nextMetadata),
          nextStatus,
          updatedAt,
          id
        );
      this.syncNodeTags(id, nextTags);
      this.markNodeSemanticIndexState(id, "node.updated", {
        status: "pending",
        contentHash: buildSemanticContentHash({
          title: nextTitle,
          body: nextBody,
          summary: nextSummary,
          tags: nextTags
        }),
        updatedAt
      });
    });

    return this.getNode(id);
  }

  refreshNodeSummary(id: string): NodeRecord {
    const existing = this.getNode(id);
    const updatedAt = nowIso();
    const nextSummary = stableSummary(existing.title, existing.body);
    const nextMetadata = withSummaryMetadata(existing.metadata, updatedAt, "manual_refresh");

    this.db
      .prepare(
        `UPDATE nodes
         SET summary = ?, metadata_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(nextSummary, JSON.stringify(nextMetadata), updatedAt, id);
    this.markNodeSemanticIndexState(id, "summary.refreshed", {
      status: "pending",
      contentHash: buildSemanticContentHash({
        title: existing.title,
        body: existing.body,
        summary: nextSummary,
        tags: existing.tags
      }),
      updatedAt
    });

    return this.getNode(id);
  }

  archiveNode(id: string): NodeRecord {
    const updatedAt = nowIso();
    this.db.prepare(`UPDATE nodes SET status = 'archived', updated_at = ? WHERE id = ?`).run(updatedAt, id);
    this.markNodeSemanticIndexState(id, "node.archived", {
      status: "stale",
      updatedAt
    });
    return this.getNode(id);
  }

  setNodeCanonicality(id: string, canonicality: string): NodeRecord {
    this.db.prepare(`UPDATE nodes SET canonicality = ?, updated_at = ? WHERE id = ?`).run(canonicality, nowIso(), id);
    return this.getNode(id);
  }

  listRelatedNodes(nodeId: string, depth = 1, relationFilter?: string[]): Array<{ relation: RelationRecord; node: NodeRecord }> {
    if (depth !== 1) {
      throw new AppError(400, "INVALID_INPUT", "Only depth=1 is supported in the hot path");
    }

    const relationWhere = relationFilter?.length
      ? `AND r.relation_type IN (${relationFilter.map(() => "?").join(", ")})`
      : "";
    const rows = this.db
      .prepare(
        `SELECT
           r.id,
           r.from_node_id,
           r.to_node_id,
           r.relation_type,
           r.status,
           r.created_by,
           r.source_type,
           r.source_label,
           r.created_at,
           r.metadata_json,
           n.id AS node_id,
           n.type AS node_type,
           n.status AS node_status,
           n.canonicality AS node_canonicality,
           n.visibility AS node_visibility,
           n.title AS node_title,
           n.body AS node_body,
           n.summary AS node_summary,
           n.created_by AS node_created_by,
           n.source_type AS node_source_type,
           n.source_label AS node_source_label,
           n.created_at AS node_created_at,
           n.updated_at AS node_updated_at,
           n.tags_json AS node_tags_json,
           n.metadata_json AS node_metadata_json
         FROM relations r
         JOIN nodes n
           ON n.id = CASE WHEN r.from_node_id = ? THEN r.to_node_id ELSE r.from_node_id END
         WHERE (r.from_node_id = ? OR r.to_node_id = ?)
           AND r.status != 'archived'
           ${relationWhere}
         ORDER BY r.created_at DESC`
      )
      .all(nodeId, nodeId, nodeId, ...(relationFilter ?? [])) as Record<string, unknown>[];

    return rows.map((row) => ({
      relation: mapRelation(row),
      node: {
        id: String(row.node_id),
        type: row.node_type as NodeRecord["type"],
        status: row.node_status as NodeRecord["status"],
        canonicality: row.node_canonicality as NodeRecord["canonicality"],
        visibility: String(row.node_visibility),
        title: row.node_title ? String(row.node_title) : null,
        body: row.node_body ? String(row.node_body) : null,
        summary: row.node_summary ? String(row.node_summary) : null,
        createdBy: row.node_created_by ? String(row.node_created_by) : null,
        sourceType: row.node_source_type ? String(row.node_source_type) : null,
        sourceLabel: row.node_source_label ? String(row.node_source_label) : null,
        createdAt: String(row.node_created_at),
        updatedAt: String(row.node_updated_at),
        tags: parseJson<string[]>(row.node_tags_json as string | null, []),
        metadata: parseJson<JsonMap>(row.node_metadata_json as string | null, {})
      }
    }));
  }

  listProjectMemberNodes(projectId: string, limit: number): Array<{ relation: RelationRecord; node: NodeRecord }> {
    const rows = this.db
      .prepare(
        `SELECT
           r.*,
           CASE WHEN r.from_node_id = ? THEN r.to_node_id ELSE r.from_node_id END AS related_id
         FROM relations r
         JOIN nodes n
           ON n.id = CASE WHEN r.from_node_id = ? THEN r.to_node_id ELSE r.from_node_id END
         WHERE (r.from_node_id = ? OR r.to_node_id = ?)
           AND r.relation_type = 'relevant_to'
           AND r.status NOT IN ('archived', 'rejected')
           AND n.status != 'archived'
         ORDER BY r.created_at DESC
         LIMIT ?`
      )
      .all(projectId, projectId, projectId, projectId, limit) as Record<string, unknown>[];

    const relatedNodes = this.getNodesByIds(rows.map((row) => String(row.related_id)));

    return rows.flatMap((row) => {
      const node = relatedNodes.get(String(row.related_id));
      if (!node) {
        return [];
      }

      return [{
        relation: mapRelation(row),
        node
      }];
    });
  }

  listRelationsBetweenNodeIds(nodeIds: string[]): RelationRecord[] {
    if (!nodeIds.length) {
      return [];
    }

    const uniqueIds = Array.from(new Set(nodeIds));
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT *
         FROM relations
         WHERE from_node_id IN (${placeholders})
           AND to_node_id IN (${placeholders})
           AND status NOT IN ('archived', 'rejected')
         ORDER BY created_at ASC, id ASC`
      )
      .all(...uniqueIds, ...uniqueIds) as Record<string, unknown>[];

    return rows.map(mapRelation);
  }

  listAllRelations(): RelationRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM relations ORDER BY created_at ASC, id ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapRelation);
  }

  createRelation(input: CreateRelationInput & { resolvedStatus: string }): RelationRecord {
    const now = nowIso();
    const id = createId("rel");
    this.db
      .prepare(
        `INSERT INTO relations (
          id, from_node_id, to_node_id, relation_type, status, created_by, source_type,
          source_label, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.fromNodeId,
        input.toNodeId,
        input.relationType,
        input.resolvedStatus,
        input.source.actorLabel,
        input.source.actorType,
        input.source.actorLabel,
        now,
        JSON.stringify(input.metadata)
      );

    return this.getRelation(id);
  }

  upsertInferredRelation(input: UpsertInferredRelationInput): InferredRelationRecord {
    const existing = this.db
      .prepare(
        `SELECT id FROM inferred_relations
         WHERE from_node_id = ? AND to_node_id = ? AND relation_type = ? AND generator = ?`
      )
      .get(input.fromNodeId, input.toNodeId, input.relationType, input.generator) as { id: string } | undefined;
    const id = existing?.id ?? createId("irel");
    const now = nowIso();

    this.db
      .prepare(
        `INSERT INTO inferred_relations (
          id, from_node_id, to_node_id, relation_type, base_score, usage_score, final_score, status,
          generator, evidence_json, last_computed_at, expires_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(from_node_id, to_node_id, relation_type, generator) DO UPDATE SET
          base_score = excluded.base_score,
          usage_score = excluded.usage_score,
          final_score = excluded.final_score,
          status = excluded.status,
          evidence_json = excluded.evidence_json,
          last_computed_at = excluded.last_computed_at,
          expires_at = excluded.expires_at,
          metadata_json = excluded.metadata_json`
      )
      .run(
        id,
        input.fromNodeId,
        input.toNodeId,
        input.relationType,
        input.baseScore,
        input.usageScore,
        input.finalScore,
        input.status,
        input.generator,
        JSON.stringify(input.evidence),
        now,
        input.expiresAt ?? null,
        JSON.stringify(input.metadata)
      );

    return this.getInferredRelationByIdentity(input.fromNodeId, input.toNodeId, input.relationType, input.generator);
  }

  getRelation(id: string): RelationRecord {
    const row = this.db.prepare(`SELECT * FROM relations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return mapRelation(assertPresent(row, `Relation ${id} not found`));
  }

  getInferredRelation(id: string): InferredRelationRecord {
    const row = this.db
      .prepare(`SELECT * FROM inferred_relations WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return mapInferredRelation(assertPresent(row, `Inferred relation ${id} not found`));
  }

  getInferredRelationByIdentity(fromNodeId: string, toNodeId: string, relationType: string, generator: string): InferredRelationRecord {
    const row = this.db
      .prepare(
        `SELECT * FROM inferred_relations
         WHERE from_node_id = ? AND to_node_id = ? AND relation_type = ? AND generator = ?`
      )
      .get(fromNodeId, toNodeId, relationType, generator) as Record<string, unknown> | undefined;
    return mapInferredRelation(assertPresent(row, `Inferred relation ${fromNodeId}:${toNodeId}:${relationType}:${generator} not found`));
  }

  listInferredRelationsForNode(nodeId: string, limit = 20, status = "active"): InferredRelationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inferred_relations
         WHERE status = ?
           AND (from_node_id = ? OR to_node_id = ?)
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY final_score DESC, last_computed_at DESC
         LIMIT ?`
      )
      .all(status, nodeId, nodeId, nowIso(), limit) as Record<string, unknown>[];
    return rows.map(mapInferredRelation);
  }

  listInferredRelationsBetweenNodeIds(nodeIds: string[], limit = 100, status = "active"): InferredRelationRecord[] {
    if (!nodeIds.length) {
      return [];
    }

    const uniqueIds = Array.from(new Set(nodeIds));
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT *
         FROM inferred_relations
         WHERE status = ?
           AND from_node_id IN (${placeholders})
           AND to_node_id IN (${placeholders})
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY final_score DESC, last_computed_at DESC, id ASC
         LIMIT ?`
      )
      .all(status, ...uniqueIds, ...uniqueIds, nowIso(), limit) as Record<string, unknown>[];

    return rows.map(mapInferredRelation);
  }

  expireAutoInferredRelationsForNode(nodeId: string, generators: string[], keepRelationIds: string[] = []): number {
    if (!generators.length) {
      return 0;
    }

    const where = [
      `(from_node_id = ? OR to_node_id = ?)`,
      `generator IN (${generators.map(() => "?").join(", ")})`,
      `status != 'expired'`
    ];
    const values: SqlValue[] = [nodeId, nodeId, ...generators];

    if (keepRelationIds.length) {
      where.push(`id NOT IN (${keepRelationIds.map(() => "?").join(", ")})`);
      values.push(...keepRelationIds);
    }

    const result = this.db
      .prepare(
        `UPDATE inferred_relations
         SET status = 'expired', last_computed_at = ?
         WHERE ${where.join(" AND ")}`
      )
      .run(nowIso(), ...values);

    return Number(result.changes ?? 0);
  }

  appendRelationUsageEvent(input: AppendRelationUsageEventInput): RelationUsageEventRecord {
    const id = createId("rue");
    const now = nowIso();
    this.runInTransaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO relation_usage_events (
            id, relation_id, relation_source, event_type, session_id, run_id, actor_type, actor_label,
            tool_name, delta, created_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.relationId,
          input.relationSource,
          input.eventType,
          input.sessionId ?? null,
          input.runId ?? null,
          input.source?.actorType ?? null,
          input.source?.actorLabel ?? null,
          input.source?.toolName ?? null,
          input.delta,
          now,
          JSON.stringify(input.metadata)
        );
      const rowid = Number(result.lastInsertRowid ?? 0);

      this.db
        .prepare(
          `INSERT INTO relation_usage_rollups (
             relation_id, total_delta, event_count, last_event_at, last_event_rowid, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(relation_id) DO UPDATE SET
             total_delta = total_delta + excluded.total_delta,
             event_count = event_count + excluded.event_count,
             last_event_at = CASE
               WHEN excluded.last_event_at > last_event_at THEN excluded.last_event_at
               ELSE last_event_at
             END,
             last_event_rowid = CASE
               WHEN excluded.last_event_rowid > last_event_rowid THEN excluded.last_event_rowid
               ELSE last_event_rowid
             END,
             updated_at = excluded.updated_at`
        )
        .run(input.relationId, input.delta, 1, now, rowid, now);

      this.ensureRelationUsageRollupState(now);
      this.db
        .prepare(
          `UPDATE relation_usage_rollup_state
           SET last_event_rowid = CASE
             WHEN ? > last_event_rowid THEN ?
             ELSE last_event_rowid
           END,
               updated_at = ?
           WHERE id = ?`
        )
        .run(rowid, rowid, now, RELATION_USAGE_ROLLUP_STATE_ID);
    });
    return this.getRelationUsageEvent(id);
  }

  getRelationUsageEvent(id: string): RelationUsageEventRecord {
    const row = this.db
      .prepare(`SELECT * FROM relation_usage_events WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return mapRelationUsageEvent(assertPresent(row, `Relation usage event ${id} not found`));
  }

  listRelationUsageEvents(relationId: string, limit = 50): RelationUsageEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM relation_usage_events
         WHERE relation_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(relationId, limit) as Record<string, unknown>[];
    return rows.map(mapRelationUsageEvent);
  }

  getRelationUsageSummaries(relationIds: string[]): Map<string, RelationUsageSummary> {
    if (!relationIds.length) {
      return new Map();
    }

    const uniqueIds = Array.from(new Set(relationIds));
    const readRows = () =>
      this.db
        .prepare(
          `SELECT
             relation_id,
             total_delta,
             event_count,
             last_event_at
           FROM relation_usage_rollups
           WHERE relation_id IN (${uniqueIds.map(() => "?").join(", ")})
           ORDER BY relation_id`
        )
        .all(...uniqueIds) as Array<Record<string, unknown>>;

    let rows = readRows();
    if (rows.length < uniqueIds.length) {
      this.syncRelationUsageRollups();
      rows = readRows();
    }

    return new Map(
      rows.map((row) => [
        String(row.relation_id),
        {
          relationId: String(row.relation_id),
          totalDelta: Number(row.total_delta),
          eventCount: Number(row.event_count),
          lastEventAt: row.last_event_at ? String(row.last_event_at) : null
        }
      ])
    );
  }

  appendSearchFeedbackEvent(input: AppendSearchFeedbackInput): SearchFeedbackEventRecord {
    const id = createId("sfe");
    const now = nowIso();
    const delta = computeSearchFeedbackDelta(input.verdict, input.confidence);

    this.runInTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO search_feedback_events (
            id, result_type, result_id, verdict, query, session_id, run_id, actor_type, actor_label,
            tool_name, confidence, delta, created_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.resultType,
          input.resultId,
          input.verdict,
          input.query ?? null,
          input.sessionId ?? null,
          input.runId ?? null,
          input.source?.actorType ?? null,
          input.source?.actorLabel ?? null,
          input.source?.toolName ?? null,
          input.confidence,
          delta,
          now,
          JSON.stringify(input.metadata)
        );

      this.db
        .prepare(
          `INSERT INTO search_feedback_rollups (
             result_type, result_id, total_delta, event_count, useful_count, not_useful_count, uncertain_count, last_event_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(result_type, result_id) DO UPDATE SET
             total_delta = total_delta + excluded.total_delta,
             event_count = event_count + excluded.event_count,
             useful_count = useful_count + excluded.useful_count,
             not_useful_count = not_useful_count + excluded.not_useful_count,
             uncertain_count = uncertain_count + excluded.uncertain_count,
             last_event_at = CASE
               WHEN excluded.last_event_at > last_event_at THEN excluded.last_event_at
               ELSE last_event_at
             END,
             updated_at = excluded.updated_at`
        )
        .run(
          input.resultType,
          input.resultId,
          delta,
          1,
          input.verdict === "useful" ? 1 : 0,
          input.verdict === "not_useful" ? 1 : 0,
          input.verdict === "uncertain" ? 1 : 0,
          now,
          now
        );
    });

    return this.getSearchFeedbackEvent(id);
  }

  getSearchFeedbackEvent(id: string): SearchFeedbackEventRecord {
    const row = this.db
      .prepare(`SELECT * FROM search_feedback_events WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return mapSearchFeedbackEvent(assertPresent(row, `Search feedback event ${id} not found`));
  }

  listSearchFeedbackEvents(resultType: SearchFeedbackEventRecord["resultType"], resultId: string, limit = 50): SearchFeedbackEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM search_feedback_events
         WHERE result_type = ? AND result_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(resultType, resultId, limit) as Record<string, unknown>[];
    return rows.map(mapSearchFeedbackEvent);
  }

  getSearchFeedbackSummaries(
    resultType: SearchFeedbackEventRecord["resultType"],
    resultIds: string[]
  ): Map<string, SearchFeedbackSummary> {
    if (!resultIds.length) {
      return new Map();
    }

    const rows = this.db
      .prepare(
        `SELECT
           result_id,
           total_delta,
           event_count,
           useful_count,
           not_useful_count,
           uncertain_count,
           last_event_at
         FROM search_feedback_rollups
         WHERE result_type = ?
           AND result_id IN (${resultIds.map(() => "?").join(", ")})
         ORDER BY result_id`
      )
      .all(resultType, ...resultIds) as Array<Record<string, unknown>>;

    return new Map(
      rows.map((row) => [
        String(row.result_id),
        {
          resultType,
          resultId: String(row.result_id),
          totalDelta: Number(row.total_delta),
          eventCount: Number(row.event_count),
          usefulCount: Number(row.useful_count),
          notUsefulCount: Number(row.not_useful_count),
          uncertainCount: Number(row.uncertain_count),
          lastEventAt: row.last_event_at ? String(row.last_event_at) : null
        }
      ])
    );
  }

  appendGovernanceEvent(params: {
    entityType: GovernanceEntityType;
    entityId: string;
    eventType: GovernanceEventRecord["eventType"];
    previousState: GovernanceState | null;
    nextState: GovernanceState;
    confidence: number;
    reason: string;
    metadata?: JsonMap;
  }): GovernanceEventRecord {
    const id = createId("gov");
    const now = nowIso();
    const confidence = clampConfidence(params.confidence);
    const metadata = params.metadata ?? {};
    this.db
      .prepare(
        `INSERT INTO governance_events (
          id, entity_type, entity_id, event_type, previous_state, next_state, confidence, reason, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.entityType,
        params.entityId,
        params.eventType,
        params.previousState ?? null,
        params.nextState,
        confidence,
        params.reason,
        now,
        JSON.stringify(metadata)
      );
    return {
      id,
      entityType: params.entityType,
      entityId: params.entityId,
      eventType: params.eventType,
      previousState: params.previousState,
      nextState: params.nextState,
      confidence,
      reason: params.reason,
      createdAt: now,
      metadata
    };
  }

  getGovernanceEvent(id: string): GovernanceEventRecord {
    const row = this.db
      .prepare(`SELECT * FROM governance_events WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return mapGovernanceEvent(assertPresent(row, `Governance event ${id} not found`));
  }

  listGovernanceEvents(entityType: GovernanceEntityType, entityId: string, limit = 20): GovernanceEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM governance_events
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(entityType, entityId, limit) as Record<string, unknown>[];
    return rows.map(mapGovernanceEvent);
  }

  listRecentGovernanceEvents(options?: {
    limit?: number;
    entityTypes?: GovernanceEntityType[];
    actions?: GovernanceDecisionAction[];
  }): GovernanceFeedItem[] {
    const limit = options?.limit ?? 12;
    const entityTypes = options?.entityTypes?.length ? options.entityTypes : undefined;
    const actions = options?.actions?.length ? options.actions : undefined;
    const where: string[] = [`json_extract(ge.metadata_json, '$.manualAction') IS NOT NULL`];
    const params: SqlValue[] = [];

    if (entityTypes?.length) {
      where.push(`ge.entity_type IN (${entityTypes.map(() => "?").join(", ")})`);
      params.push(...entityTypes);
    }

    if (actions?.length) {
      where.push(`json_extract(ge.metadata_json, '$.manualAction') IN (${actions.map(() => "?").join(", ")})`);
      params.push(...actions);
    }

    const rows = this.db
      .prepare(
        `SELECT
           ge.*,
           json_extract(ge.metadata_json, '$.manualAction') AS manual_action,
           CASE
             WHEN ge.entity_type = 'node' THEN n.title
             ELSE COALESCE(fn.title, r.from_node_id) || ' ' || r.relation_type || ' ' || COALESCE(tn.title, r.to_node_id)
           END AS display_title,
           CASE
             WHEN ge.entity_type = 'node' THEN n.type
             ELSE r.status
           END AS display_subtitle,
           CASE WHEN ge.entity_type = 'node' THEN ge.entity_id ELSE NULL END AS node_id,
           CASE WHEN ge.entity_type = 'relation' THEN r.from_node_id ELSE NULL END AS from_node_id,
           CASE WHEN ge.entity_type = 'relation' THEN r.to_node_id ELSE NULL END AS to_node_id,
           CASE WHEN ge.entity_type = 'relation' THEN r.relation_type ELSE NULL END AS relation_type
         FROM governance_events ge
         LEFT JOIN nodes n
           ON ge.entity_type = 'node'
          AND ge.entity_id = n.id
         LEFT JOIN relations r
           ON ge.entity_type = 'relation'
          AND ge.entity_id = r.id
         LEFT JOIN nodes fn ON fn.id = r.from_node_id
         LEFT JOIN nodes tn ON tn.id = r.to_node_id
         WHERE ${where.join(" AND ")}
         ORDER BY ge.created_at DESC
         LIMIT ?`
      )
      .all(...params, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      ...mapGovernanceEvent(row),
      action: row.manual_action ? (String(row.manual_action) as GovernanceDecisionAction) : null,
      title: row.display_title ? String(row.display_title) : null,
      subtitle: row.display_subtitle ? String(row.display_subtitle) : null,
      nodeId: row.node_id ? String(row.node_id) : null,
      fromNodeId: row.from_node_id ? String(row.from_node_id) : null,
      toNodeId: row.to_node_id ? String(row.to_node_id) : null,
      relationType: row.relation_type ? (String(row.relation_type) as GovernanceFeedItem["relationType"]) : null
    }));
  }

  upsertGovernanceState(params: {
    entityType: GovernanceEntityType;
    entityId: string;
    state: GovernanceState;
    confidence: number;
    reasons: string[];
    lastEvaluatedAt?: string;
    metadata?: JsonMap;
    previousState?: GovernanceStateRecord | null;
  }): GovernanceStateRecord {
    const now = params.lastEvaluatedAt ?? nowIso();
    const existing = params.previousState === undefined
      ? this.getGovernanceStateNullable(params.entityType, params.entityId)
      : params.previousState;
    const lastTransitionAt = existing?.state === params.state ? existing.lastTransitionAt : now;
    this.db
      .prepare(
        `INSERT INTO governance_state (
          entity_type, entity_id, state, confidence, reasons_json, last_evaluated_at, last_transition_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
          state = excluded.state,
          confidence = excluded.confidence,
          reasons_json = excluded.reasons_json,
          last_evaluated_at = excluded.last_evaluated_at,
          last_transition_at = excluded.last_transition_at,
          metadata_json = excluded.metadata_json`
      )
      .run(
        params.entityType,
        params.entityId,
        params.state,
        clampConfidence(params.confidence),
        JSON.stringify(params.reasons),
        now,
        lastTransitionAt,
        JSON.stringify(params.metadata ?? {})
      );
    return {
      entityType: params.entityType,
      entityId: params.entityId,
      state: params.state,
      confidence: clampConfidence(params.confidence),
      reasons: [...params.reasons],
      lastEvaluatedAt: now,
      lastTransitionAt,
      metadata: params.metadata ?? {}
    };
  }

  getGovernanceState(entityType: GovernanceEntityType, entityId: string): GovernanceStateRecord {
    const row = this.db
      .prepare(`SELECT * FROM governance_state WHERE entity_type = ? AND entity_id = ?`)
      .get(entityType, entityId) as Record<string, unknown> | undefined;
    return mapGovernanceState(assertPresent(row, `Governance state ${entityType}:${entityId} not found`));
  }

  getGovernanceStateNullable(entityType: GovernanceEntityType, entityId: string): GovernanceStateRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM governance_state WHERE entity_type = ? AND entity_id = ?`)
      .get(entityType, entityId) as Record<string, unknown> | undefined;
    return row ? mapGovernanceState(row) : null;
  }

  listGovernanceIssues(limit = 20, states?: GovernanceState[]): GovernanceIssueItem[] {
    const effectiveStates = states?.length ? states : (["low_confidence", "contested"] satisfies GovernanceState[]);
    const nodeRows = this.db
      .prepare(
        `SELECT
           gs.*,
           n.title AS display_title,
           n.type AS display_subtitle
         FROM governance_state gs
         JOIN nodes n
           ON gs.entity_type = 'node'
          AND gs.entity_id = n.id
         WHERE gs.state IN (${effectiveStates.map(() => "?").join(", ")})
           AND n.status != 'archived'
         ORDER BY CASE WHEN gs.state = 'contested' THEN 0 ELSE 1 END, gs.confidence ASC, gs.last_transition_at DESC
         LIMIT ?`
      )
      .all(...(effectiveStates as SqlValue[]), limit) as Record<string, unknown>[];
    const relationRows = this.db
      .prepare(
        `SELECT
           gs.*,
           COALESCE(fn.title, r.from_node_id) || ' ' || r.relation_type || ' ' || COALESCE(tn.title, r.to_node_id) AS display_title,
           r.status AS display_subtitle
         FROM governance_state gs
         JOIN relations r
           ON gs.entity_type = 'relation'
          AND gs.entity_id = r.id
         LEFT JOIN nodes fn ON fn.id = r.from_node_id
         LEFT JOIN nodes tn ON tn.id = r.to_node_id
         WHERE gs.state IN (${effectiveStates.map(() => "?").join(", ")})
           AND r.status != 'archived'
         ORDER BY CASE WHEN gs.state = 'contested' THEN 0 ELSE 1 END, gs.confidence ASC, gs.last_transition_at DESC
         LIMIT ?`
      )
      .all(...(effectiveStates as SqlValue[]), limit) as Record<string, unknown>[];

    return [...nodeRows, ...relationRows]
      .map((row) => ({
        ...mapGovernanceState(row),
        title: row.display_title ? String(row.display_title) : null,
        subtitle: row.display_subtitle ? String(row.display_subtitle) : null
      }))
      .sort((left, right) => {
        const leftPriority = left.state === "contested" ? 0 : left.state === "low_confidence" ? 1 : 2;
        const rightPriority = right.state === "contested" ? 0 : right.state === "low_confidence" ? 1 : 2;
        return leftPriority - rightPriority || left.confidence - right.confidence || right.lastTransitionAt.localeCompare(left.lastTransitionAt);
      })
      .slice(0, limit);
  }

  listNodeIdsForGovernance(limit = 100, entityIds?: string[]): string[] {
    const rows = entityIds?.length
      ? ((this.db
          .prepare(
            `SELECT id
             FROM nodes
             WHERE id IN (${entityIds.map(() => "?").join(", ")})
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(...entityIds, limit) as Record<string, unknown>[]))
      : ((this.db
          .prepare(
            `SELECT id
             FROM nodes
             WHERE status != 'archived'
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(limit) as Record<string, unknown>[]));
    return rows.map((row) => String(row.id));
  }

  listRelationIdsForGovernance(limit = 100, entityIds?: string[]): string[] {
    const rows = entityIds?.length
      ? ((this.db
          .prepare(
            `SELECT id
             FROM relations
             WHERE id IN (${entityIds.map(() => "?").join(", ")})
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(...entityIds, limit) as Record<string, unknown>[]))
      : ((this.db
          .prepare(
            `SELECT id
             FROM relations
             WHERE status != 'archived'
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(limit) as Record<string, unknown>[]));
    return rows.map((row) => String(row.id));
  }

  countContradictionRelations(nodeId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total
         FROM relations
         WHERE relation_type = 'contradicts'
           AND status = 'active'
           AND (from_node_id = ? OR to_node_id = ?)`
      )
      .get(nodeId, nodeId) as Record<string, unknown>;
    return Number(row.total ?? 0);
  }

  listLegacyReviewItems(limit = 500): LegacyReviewQueueRecord[] {
    if (!this.hasLegacyReviewQueueTable()) {
      return [];
    }
    const rows = this.db
      .prepare(`SELECT * FROM review_queue ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapLegacyReviewQueue);
  }

  clearLegacyReviewQueue(): void {
    if (!this.hasLegacyReviewQueueTable()) {
      return;
    }
    this.db.prepare(`DELETE FROM review_queue`).run();
  }

  private hasLegacyReviewQueueTable(): boolean {
    const row = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_queue'`)
      .get() as Record<string, unknown> | undefined;
    return Boolean(row?.name);
  }

  private ensureLegacyReviewQueueTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS review_queue (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        review_type TEXT NOT NULL,
        proposed_by TEXT,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        notes TEXT,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(status);
      CREATE INDEX IF NOT EXISTS idx_review_queue_status_type_created_at
        ON review_queue(status, review_type, created_at DESC);
    `);
  }

  createLegacyReviewItem(params: {
    entityType: string;
    entityId: string;
    reviewType: string;
    proposedBy: string | null;
    status?: string;
    notes?: string | null;
    metadata?: JsonMap;
  }): LegacyReviewQueueRecord {
    this.ensureLegacyReviewQueueTable();
    const id = createId("rev");
    this.db
      .prepare(
        `INSERT INTO review_queue (
          id, entity_type, entity_id, review_type, proposed_by, created_at, status, notes, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.entityType,
        params.entityId,
        params.reviewType,
        params.proposedBy,
        nowIso(),
        params.status ?? "pending",
        params.notes ?? null,
        JSON.stringify(params.metadata ?? {})
      );
    const row = this.db.prepare(`SELECT * FROM review_queue WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return mapLegacyReviewQueue(assertPresent(row, `Legacy review item ${id} not found`));
  }

  recomputeGovernanceTargets(input: RecomputeGovernanceInput): { nodeIds: string[]; relationIds: string[] } {
    const limit = input.limit;
    const targetIds = input.entityIds?.length ? input.entityIds : undefined;
    const nodeIds =
      !input.entityType || input.entityType === "node" ? this.listNodeIdsForGovernance(limit, targetIds) : [];
    const relationIds =
      !input.entityType || input.entityType === "relation" ? this.listRelationIdsForGovernance(limit, targetIds) : [];
    return { nodeIds, relationIds };
  }

  getPendingRelationUsageStats(since: string | null): PendingRelationUsageStats {
    const whereClause = since ? "WHERE created_at > ?" : "";
    const bindings = since ? [since] : [];
    const statsRow = this.db
      .prepare(
        `SELECT
           COUNT(*) AS event_count,
           MIN(created_at) AS earliest_event_at,
           MAX(created_at) AS latest_event_at
         FROM relation_usage_events
         ${whereClause}`
      )
      .get(...bindings) as Record<string, unknown>;
    const relationRows = this.db
      .prepare(
        `SELECT
           relation_id,
           MAX(created_at) AS latest_event_at
         FROM relation_usage_events
         ${whereClause}
         GROUP BY relation_id
         ORDER BY latest_event_at DESC`
      )
      .all(...bindings) as Array<Record<string, unknown>>;

    return {
      relationIds: relationRows.map((row) => String(row.relation_id)),
      eventCount: Number(statsRow.event_count ?? 0),
      earliestEventAt: statsRow.earliest_event_at ? String(statsRow.earliest_event_at) : null,
      latestEventAt: statsRow.latest_event_at ? String(statsRow.latest_event_at) : null
    };
  }

  recomputeInferredRelationScores(input: RecomputeInferredRelationsInput): InferredRelationRecomputeResult {
    const where: string[] = [];
    const values: SqlValue[] = [];

    if (!input.relationIds?.length) {
      where.push(`status != 'expired'`);
    }

    if (input.generator) {
      where.push("generator = ?");
      values.push(input.generator);
    }

    if (input.relationIds?.length) {
      where.push(`id IN (${input.relationIds.map(() => "?").join(", ")})`);
      values.push(...input.relationIds);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM inferred_relations
         ${whereClause}
         ORDER BY last_computed_at ASC
         LIMIT ?`
      )
      .all(...values, input.limit) as Record<string, unknown>[];

    if (!rows.length) {
      return {
        updatedCount: 0,
        expiredCount: 0,
        items: []
      };
    }

    const relationIds = rows.map((row) => String(row.id));
    const summaries = this.getRelationUsageSummaries(relationIds);
    const now = nowIso();
    const updateStatement = this.db.prepare(
      `UPDATE inferred_relations
       SET usage_score = ?, final_score = ?, status = ?, last_computed_at = ?
       WHERE id = ?`
    );

    let expiredCount = 0;
    const items: InferredRelationRecord[] = [];
    this.runInTransaction(() => {
      for (const row of rows) {
        const id = String(row.id);
        const currentStatus = String(row.status) as InferredRelationRecord["status"];
        const expiresAt = row.expires_at ? String(row.expires_at) : null;
        const recomputed = computeMaintainedScores(Number(row.base_score), summaries.get(id), String(row.last_computed_at));
        const nextStatus = expiresAt && expiresAt <= now ? "expired" : currentStatus;
        if (nextStatus === "expired") {
          expiredCount += 1;
        }
        updateStatement.run(recomputed.usageScore, recomputed.finalScore, nextStatus, now, id);
        items.push(mapInferredRelation({
          ...row,
          usage_score: recomputed.usageScore,
          final_score: recomputed.finalScore,
          status: nextStatus,
          last_computed_at: now
        }));
      }
    });

    return {
      updatedCount: rows.length,
      expiredCount,
      items
    };
  }

  countInferredRelations(status?: InferredRelationRecord["status"]): number {
    const row = status
      ? (this.db.prepare(`SELECT COUNT(*) AS total FROM inferred_relations WHERE status = ?`).get(status) as { total: number })
      : (this.db.prepare(`SELECT COUNT(*) AS total FROM inferred_relations`).get() as { total: number });
    return Number(row.total ?? 0);
  }

  updateRelationStatus(id: string, status: string): RelationRecord {
    this.db.prepare(`UPDATE relations SET status = ? WHERE id = ?`).run(status, id);
    return this.getRelation(id);
  }

  listNodeActivities(nodeId: string, limit = 20): ActivityRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM activities WHERE target_node_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(nodeId, limit) as Record<string, unknown>[];
    return rows.map(mapActivity);
  }

  listActivitiesForNodeIds(nodeIds: string[], limit = 200): ActivityRecord[] {
    if (!nodeIds.length) {
      return [];
    }

    const uniqueIds = Array.from(new Set(nodeIds));
    const rows = this.db
      .prepare(
        `SELECT *
         FROM activities
         WHERE target_node_id IN (${uniqueIds.map(() => "?").join(", ")})
         ORDER BY created_at ASC, id ASC
         LIMIT ?`
      )
      .all(...uniqueIds, limit) as Record<string, unknown>[];
    return rows.map(mapActivity);
  }

  listAllActivities(): ActivityRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM activities ORDER BY created_at ASC, id ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapActivity);
  }

  appendActivity(input: AppendActivityInput): ActivityRecord {
    const id = createId("act");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO activities (
          id, target_node_id, activity_type, body, created_by, source_type, source_label, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.targetNodeId,
        input.activityType,
        input.body,
        input.source.actorLabel,
        input.source.actorType,
        input.source.actorLabel,
        now,
        JSON.stringify(input.metadata)
      );
    this.touchNode(input.targetNodeId);
    this.markNodeSemanticIndexState(input.targetNodeId, "activity.appended", {
      status: "pending",
      updatedAt: now
    });
    return this.getActivity(id);
  }

  getActivity(id: string): ActivityRecord {
    const row = this.db.prepare(`SELECT * FROM activities WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return mapActivity(assertPresent(row, `Activity ${id} not found`));
  }

  attachArtifact(input: {
    nodeId: string;
    path: string;
    mimeType?: string;
    source: Source;
    metadata: JsonMap;
  }): ArtifactRecord {
    const id = createId("art");
    const now = nowIso();
    const absolutePath = path.isAbsolute(input.path) ? input.path : path.resolve(this.workspaceRoot, input.path);
    const realWorkspaceRoot = realpathSync(this.workspaceRoot);
    if (!isPathWithinRoot(this.workspaceRoot, absolutePath)) {
      throw new AppError(403, "FORBIDDEN", "Artifact path escapes workspace root.");
    }
    const artifactRoot = path.join(this.workspaceRoot, "artifacts");
    const realArtifactRoot = realpathSync(artifactRoot);
    if (!isPathWithinRoot(artifactRoot, absolutePath)) {
      throw new AppError(403, "FORBIDDEN", "Artifact path must stay inside the workspace artifacts directory.");
    }
    let resolvedPath = "";
    let stats: Stats | null = null;
    try {
      const entryStats = lstatSync(absolutePath);
      if (entryStats.isSymbolicLink()) {
        throw new AppError(403, "FORBIDDEN", "Artifact path must not be a symbolic link.");
      }

      resolvedPath = realpathSync(absolutePath);
      if (!isPathWithinRoot(realWorkspaceRoot, resolvedPath)) {
        throw new AppError(403, "FORBIDDEN", "Artifact path escapes workspace root.");
      }
      if (!isPathWithinRoot(realArtifactRoot, resolvedPath)) {
        throw new AppError(403, "FORBIDDEN", "Artifact path must stay inside the workspace artifacts directory.");
      }

      stats = statSync(resolvedPath);
      if (!stats.isFile()) {
        throw new AppError(400, "INVALID_INPUT", "Artifact path must reference a regular file.");
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
      ) {
        throw new AppError(404, "NOT_FOUND", "Artifact path does not exist.");
      }
      throw error;
    }
    if (!stats) {
      throw new AppError(500, "INTERNAL_ERROR", "Artifact metadata could not be read.");
    }

    this.db
      .prepare(
        `INSERT INTO artifacts (
          id, node_id, path, mime_type, size_bytes, checksum, created_by, source_label, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.nodeId,
        normalizeArtifactPath(path.relative(this.workspaceRoot, absolutePath)),
        input.mimeType ?? null,
        stats.size,
        checksumText(`${resolvedPath}:${stats.size}:${stats.mtimeMs}`),
        input.source.actorLabel,
        input.source.actorLabel,
        now,
        JSON.stringify(input.metadata)
      );
    this.markNodeSemanticIndexState(input.nodeId, "artifact.attached", {
      status: "pending",
      updatedAt: now
    });
    return this.getArtifact(id);
  }

  listArtifacts(nodeId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM artifacts WHERE node_id = ? ORDER BY created_at DESC`)
      .all(nodeId) as Record<string, unknown>[];
    return rows.map(mapArtifact);
  }

  listAllArtifacts(): ArtifactRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM artifacts ORDER BY created_at DESC, id DESC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapArtifact);
  }

  getArtifact(id: string): ArtifactRecord {
    const row = this.db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return mapArtifact(assertPresent(row, `Artifact ${id} not found`));
  }

  getWorkspaceKey(): string {
    return this.workspaceKey;
  }

  hasArtifactAtPath(relativePath: string): boolean {
    const normalizedPath = normalizeArtifactPath(relativePath);
    const row = this.db
      .prepare(`SELECT 1 AS present FROM artifacts WHERE path = ? LIMIT 1`)
      .get(normalizedPath) as { present?: number } | undefined;
    return Boolean(row?.present);
  }

  recordProvenance(params: {
    entityType: string;
    entityId: string;
    operationType: string;
    source: Source;
    metadata?: JsonMap;
    inputRef?: string | null;
  }): ProvenanceRecord {
    const id = createId("prov");
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO provenance_events (
          id, entity_type, entity_id, operation_type, actor_type, actor_label, tool_name, tool_version,
          timestamp, input_ref, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.entityType,
        params.entityId,
        params.operationType,
        params.source.actorType,
        params.source.actorLabel,
        params.source.toolName,
        params.source.toolVersion ?? null,
        timestamp,
        params.inputRef ?? null,
        JSON.stringify(params.metadata ?? {})
      );
    return this.getProvenance(id);
  }

  listProvenance(entityType: string, entityId: string): ProvenanceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM provenance_events
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY timestamp DESC`
      )
      .all(entityType, entityId) as Record<string, unknown>[];
    return rows.map(mapProvenance);
  }

  getProvenance(id: string): ProvenanceRecord {
    const row = this.db
      .prepare(`SELECT * FROM provenance_events WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return mapProvenance(assertPresent(row, `Provenance ${id} not found`));
  }

  listIntegrations(): IntegrationRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM integrations ORDER BY updated_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapIntegration);
  }

  registerIntegration(input: RegisterIntegrationInput): IntegrationRecord {
    const id = createId("int");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO integrations (
          id, name, kind, status, capabilities_json, config_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(id, input.name, input.kind, JSON.stringify(input.capabilities), JSON.stringify(input.config), now, now);
    return this.getIntegration(id);
  }

  updateIntegration(id: string, input: UpdateIntegrationInput): IntegrationRecord {
    const existing = this.getIntegration(id);
    this.db
      .prepare(
        `UPDATE integrations
         SET name = ?, status = ?, capabilities_json = ?, config_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name ?? existing.name,
        input.status ?? existing.status,
        JSON.stringify(input.capabilities ?? existing.capabilities),
        JSON.stringify(input.config ?? existing.config),
        nowIso(),
        id
      );
    return this.getIntegration(id);
  }

  getIntegration(id: string): IntegrationRecord {
    const row = this.db.prepare(`SELECT * FROM integrations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return mapIntegration(assertPresent(row, `Integration ${id} not found`));
  }

  getSettings(keys?: string[]): Record<string, unknown> {
    const rows = keys?.length
      ? (this.db
          .prepare(`SELECT * FROM settings WHERE key IN (${keys.map(() => "?").join(", ")})`)
          .all(...keys) as Record<string, unknown>[])
      : ((this.db.prepare(`SELECT * FROM settings`).all() as Record<string, unknown>[]));

    return Object.fromEntries(rows.map((row) => [String(row.key), parseJson(row.value_json as string, null)]));
  }

  private writeSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(key, JSON.stringify(value));
  }

  private isSemanticReindexSettingKey(key: string): boolean {
    return (
      key === "search.semantic.enabled" ||
      key === "search.semantic.provider" ||
      key === "search.semantic.model" ||
      key === "search.semantic.chunk.enabled"
    );
  }

  setSetting(key: string, value: unknown): void {
    if (this.isSemanticReindexSettingKey(key)) {
      this.updateSemanticSetting(key, value);
      return;
    }

    this.writeSetting(key, value);
  }

  setSettings(values: Record<string, unknown>): void {
    const keys = Object.keys(values);
    if (!keys.length) {
      return;
    }

    const requiresSemanticCheck = keys.some((key) => this.isSemanticReindexSettingKey(key));
    const previousSettings = requiresSemanticCheck ? this.readSemanticIndexSettings() : null;
    for (const [key, value] of Object.entries(values)) {
      this.writeSetting(key, value);
    }
    if (requiresSemanticCheck) {
      this.writePendingSemanticTransitionKeys([]);
    }
    if (!requiresSemanticCheck || !previousSettings) {
      return;
    }

    const nextSettings = this.readSemanticIndexSettings();
    if (shouldReindexForSemanticConfigChange(previousSettings, nextSettings)) {
      this.queueSemanticConfigurationReindex();
    }
  }

  setSettingIfMissing(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json)
         VALUES (?, ?)
         ON CONFLICT(key) DO NOTHING`
      )
      .run(key, JSON.stringify(value));
  }

  ensureBaseSettings(settings: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(settings)) {
      this.setSettingIfMissing(key, value);
    }
  }

  upsertBaseSettings(settings: Record<string, unknown>): void {
    this.setSettings(settings);
  }
}
