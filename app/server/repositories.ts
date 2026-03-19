import { statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ActivityRecord,
  ArtifactRecord,
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
  ReviewQueueRecord,
  SearchResultItem
} from "../shared/types.js";
import type {
  AppendActivityInput,
  AppendRelationUsageEventInput,
  CreateNodeInput,
  CreateRelationInput,
  RecomputeInferredRelationsInput,
  RegisterIntegrationInput,
  Source,
  UpsertInferredRelationInput,
  UpdateIntegrationInput,
  UpdateNodeInput
} from "../shared/contracts.js";
import { AppError, assertPresent } from "./errors.js";
import { computeMaintainedScores } from "./relation-scoring.js";
import { buildSemanticChunks, buildSemanticDocumentText, normalizeTagList } from "./semantic/chunker.js";
import { embedSemanticQueryText, normalizeSemanticProviderConfig, resolveSemanticEmbeddingProvider } from "./semantic/provider.js";
import type { SemanticChunkRecord } from "./semantic/types.js";
import { checksumText, createId, isPathWithinRoot, nowIso, parseJson, stableSummary } from "./utils.js";

type SqlValue = string | number | bigint | Uint8Array | null;

const SUMMARY_UPDATED_AT_KEY = "summaryUpdatedAt";
const SUMMARY_SOURCE_KEY = "summarySource";
const SEARCH_TAG_INDEX_VERSION = 1;
const SEMANTIC_INDEX_STATUS_VALUES = ["pending", "processing", "stale", "ready", "failed"] as const;
const SEMANTIC_ISSUE_STATUS_VALUES = ["pending", "stale", "failed"] as const;
const DEFAULT_SEMANTIC_CHUNK_AGGREGATION = "max" as const;
const SEMANTIC_TOP_K_CHUNK_COUNT = 2;

type SemanticIndexStatus = (typeof SEMANTIC_INDEX_STATUS_VALUES)[number];
type SemanticIssueStatus = (typeof SEMANTIC_ISSUE_STATUS_VALUES)[number];
type SemanticChunkAggregation = "max" | "topk_mean";

type SemanticStatusSummary = {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  chunkEnabled: boolean;
  lastBackfillAt: string | null;
  counts: Record<SemanticIndexStatus, number>;
};

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

type SemanticIndexSettings = {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  chunkEnabled: boolean;
  chunkAggregation: SemanticChunkAggregation;
};

type SemanticAugmentationSettings = {
  minSimilarity: number;
  maxBonus: number;
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

function normalizeTagValue(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, " ");
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

function decodeVectorBlob(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

function computeCosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number(left[index] ?? 0);
    const rightValue = Number(right[index] ?? 0);
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
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

function mapReviewQueue(row: Record<string, unknown>): ReviewQueueRecord {
  return {
    id: String(row.id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    reviewType: row.review_type as ReviewQueueRecord["reviewType"],
    proposedBy: row.proposed_by ? String(row.proposed_by) : null,
    createdAt: String(row.created_at),
    status: row.status as ReviewQueueRecord["status"],
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

export class MemforgeRepository {
  constructor(private readonly db: DatabaseSync, private readonly workspaceRoot: string) {}

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
      "search.semantic.chunk.enabled",
      "search.semantic.chunk.aggregation"
    ]);
    const normalizedProvider = normalizeSemanticProviderConfig({
      provider: typeof settings["search.semantic.provider"] === "string" ? String(settings["search.semantic.provider"]) : null,
      model: typeof settings["search.semantic.model"] === "string" ? String(settings["search.semantic.model"]) : null,
    });
    return {
      enabled: typeof settings["search.semantic.enabled"] === "boolean" ? Boolean(settings["search.semantic.enabled"]) : false,
      provider: normalizedProvider.provider,
      model: normalizedProvider.model,
      chunkEnabled:
        typeof settings["search.semantic.chunk.enabled"] === "boolean"
          ? Boolean(settings["search.semantic.chunk.enabled"])
          : false,
      chunkAggregation: normalizeSemanticChunkAggregation(settings["search.semantic.chunk.aggregation"])
    };
  }

  getSemanticAugmentationSettings(): SemanticAugmentationSettings {
    const settings = this.getSettings([
      "search.semantic.augmentation.minSimilarity",
      "search.semantic.augmentation.maxBonus"
    ]);

    return {
      minSimilarity:
        typeof settings["search.semantic.augmentation.minSimilarity"] === "number" &&
        Number.isFinite(settings["search.semantic.augmentation.minSimilarity"])
          ? Math.min(Math.max(Number(settings["search.semantic.augmentation.minSimilarity"]), 0), 1)
          : 0.2,
      maxBonus:
        typeof settings["search.semantic.augmentation.maxBonus"] === "number" &&
        Number.isFinite(settings["search.semantic.augmentation.maxBonus"])
          ? Math.max(Number(settings["search.semantic.augmentation.maxBonus"]), 0)
          : 18
    };
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
    chunks: SemanticChunkRecord[],
    params: {
      provider: string;
      model: string;
      version: string | null;
      contentHash: string;
      vectors: number[][];
      updatedAt: string;
    }
  ): void {
    this.db.prepare(`DELETE FROM node_embeddings WHERE owner_type = 'node' AND owner_id = ?`).run(nodeId);
    if (!chunks.length || !params.vectors.length) {
      return;
    }

    const insertStatement = this.db.prepare(
      `INSERT INTO node_embeddings (
         owner_type, owner_id, chunk_ordinal, vector_ref, vector_blob, embedding_provider, embedding_model, embedding_version,
         content_hash, status, created_at, updated_at
       ) VALUES ('node', ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`
    );

    for (const chunk of chunks) {
      const vector = params.vectors[chunk.ordinal];
      if (!vector) {
        continue;
      }
      const vectorBlob = new Uint8Array(new Float32Array(vector).buffer);
      insertStatement.run(
        nodeId,
        chunk.ordinal,
        null,
        vectorBlob,
        params.provider,
        params.model,
        params.version,
        params.contentHash,
        params.updatedAt,
        params.updatedAt
      );
    }
  }

  async processPendingSemanticIndex(limit = 25) {
    const settings = this.readSemanticIndexSettings();
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

        this.runInTransaction(() => {
          if (node.status === "archived") {
            this.db.prepare(`DELETE FROM node_chunks WHERE node_id = ?`).run(node.id);
            this.db.prepare(`DELETE FROM node_embeddings WHERE owner_type = 'node' AND owner_id = ?`).run(node.id);
            this.upsertSemanticIndexState({
              nodeId: node.id,
              status: "ready",
              staleReason: null,
              contentHash,
              embeddingProvider: settings.provider,
              embeddingModel: settings.model,
              updatedAt: finishedAt
            });
            readyNodeIds.push(node.id);
            return;
          }

          this.replaceSemanticChunks(node.id, chunks, finishedAt);

          if (!settings.enabled || settings.provider === "disabled" || settings.model === "none" || !settings.provider || !settings.model) {
            this.db.prepare(`DELETE FROM node_embeddings WHERE owner_type = 'node' AND owner_id = ?`).run(node.id);
            this.upsertSemanticIndexState({
              nodeId: node.id,
              status: "ready",
              staleReason: null,
              contentHash,
              embeddingProvider: settings.provider,
              embeddingModel: settings.model,
              updatedAt: finishedAt
            });
            readyNodeIds.push(node.id);
            return;
          }

          if (provider && embeddingResults.length === chunks.length) {
            this.replaceSemanticEmbeddings(node.id, chunks, {
              provider: provider.provider,
              model: provider.model ?? settings.model,
              version: provider.version,
              contentHash,
              vectors: embeddingResults.map((item) => item.vector),
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
            readyNodeIds.push(node.id);
            return;
          }

          this.db.prepare(`DELETE FROM node_embeddings WHERE owner_type = 'node' AND owner_id = ?`).run(node.id);
          this.upsertSemanticIndexState({
            nodeId: node.id,
            status: "failed",
            staleReason: `embedding.provider_not_implemented:${settings.provider}`,
            contentHash,
            embeddingProvider: settings.provider,
            embeddingModel: settings.model,
            updatedAt: finishedAt
          });
          failedNodeIds.push(node.id);
        });
      } catch {
        this.upsertSemanticIndexState({
          nodeId: row.nodeId,
          status: "failed",
          staleReason: "embedding.node_not_found",
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

  listSemanticIndexTargetNodeIds(limit = 250): string[] {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM nodes
         WHERE status IN ('active', 'draft', 'review')
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => String(row.id));
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
    for (const nodeId of nodeIds) {
      this.queueSemanticReindexForNode(nodeId, reason);
    }
    this.setSetting("search.semantic.last_backfill_at", nowIso());
    return {
      queuedNodeIds: nodeIds,
      queuedCount: nodeIds.length
    };
  }

  getSemanticStatus(): SemanticStatusSummary {
    const settings = this.getSettings([
      "search.semantic.enabled",
      "search.semantic.provider",
      "search.semantic.model",
      "search.semantic.chunk.enabled",
      "search.semantic.last_backfill_at"
    ]);
    const normalizedProvider = normalizeSemanticProviderConfig({
      provider: typeof settings["search.semantic.provider"] === "string" ? String(settings["search.semantic.provider"]) : null,
      model: typeof settings["search.semantic.model"] === "string" ? String(settings["search.semantic.model"]) : null,
    });
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
      enabled: typeof settings["search.semantic.enabled"] === "boolean" ? Boolean(settings["search.semantic.enabled"]) : false,
      provider: normalizedProvider.provider,
      model: normalizedProvider.model,
      chunkEnabled:
        typeof settings["search.semantic.chunk.enabled"] === "boolean"
          ? Boolean(settings["search.semantic.chunk.enabled"])
          : false,
      lastBackfillAt:
        typeof settings["search.semantic.last_backfill_at"] === "string"
          ? String(settings["search.semantic.last_backfill_at"])
          : null,
      counts
    };
  }

  listSemanticIssues(input: {
    limit?: number;
    statuses?: SemanticIssueStatus[];
    cursor?: string | null;
  } = {}): SemanticIssuePage {
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

    const rows = this.db
      .prepare(
        `SELECT owner_id, vector_blob
         FROM node_embeddings
         WHERE owner_type = 'node'
           AND status = 'ready'
           AND embedding_provider = ?
           AND embedding_model = ?
           AND owner_id IN (${candidateNodeIds.map(() => "?").join(", ")})`
      )
      .all(settings.provider, settings.model, ...candidateNodeIds) as Array<Record<string, unknown>>;

    const similarityByNode = new Map<string, number[]>();
    for (const row of rows) {
      if (!(row.vector_blob instanceof Uint8Array)) {
        continue;
      }
      const nodeId = String(row.owner_id);
      const similarity = computeCosineSimilarity(queryEmbedding.vector, decodeVectorBlob(row.vector_blob));
      if (!Number.isFinite(similarity)) {
        continue;
      }
      const similarities = similarityByNode.get(nodeId) ?? [];
      similarities.push(similarity);
      similarityByNode.set(nodeId, similarities);
    }

    const matches = new Map<string, SemanticCandidateSimilarity>();
    for (const [nodeId, similarities] of similarityByNode.entries()) {
      matches.set(nodeId, {
        similarity: aggregateChunkSimilarities(similarities, settings.chunkAggregation),
        matchedChunks: similarities.length
      });
    }

    return matches;
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

  listInferenceCandidateNodes(targetNodeId: string, limit = 200): NodeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE id != ?
           AND status IN ('active', 'review')
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(targetNodeId, limit) as Record<string, unknown>[];

    return rows.map(mapNode);
  }

  listSharedProjectMemberNodeIds(targetNodeId: string, limit = 200): string[] {
    const target = this.getNode(targetNodeId);
    const projectIds = new Set<string>();

    if (target.type === "project" && target.status === "active") {
      projectIds.add(target.id);
    }

    for (const item of this.listRelatedNodes(targetNodeId)) {
      if (item.relation.status === "active" && item.node.status === "active" && item.node.type === "project") {
        projectIds.add(item.node.id);
      }
    }

    if (!projectIds.size) {
      return [];
    }

    const candidateIds = new Set<string>();
    for (const projectId of projectIds) {
      for (const item of this.listRelatedNodes(projectId)) {
        if (item.relation.status !== "active" || item.node.status !== "active" || item.node.id === targetNodeId) {
          continue;
        }
        candidateIds.add(item.node.id);
        if (candidateIds.size >= limit) {
          return Array.from(candidateIds);
        }
      }
    }

    return Array.from(candidateIds);
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
         WHERE status IN ('active', 'review')
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
        return this.searchNodesWithFts(input);
      } catch {
        return this.searchNodesWithLike(input);
      }
    }

    return this.searchNodesWithLike(input);
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
      orderBy = "bm25(nodes_fts, 3.0, 1.5, 2.0), n.updated_at DESC";
    }

    return this.runSearchQuery(from, where, values, orderBy, [], input.limit, input.offset, input.filters);
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
    let orderBy = "n.updated_at DESC";

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
          n.updated_at DESC
        `;
        values.push(queryLike, queryLike);
      }
    }

    const orderValues = input.sort === "relevance" && input.query.trim() ? values.slice(-2) : [];
    const whereValues = orderValues.length ? values.slice(0, -2) : values;

    return this.runSearchQuery("nodes n", where, whereValues, orderBy, orderValues, input.limit, input.offset, input.filters);
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
    }
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

    const rows = this.db
      .prepare(
        `SELECT n.id, n.type, n.title, n.summary, n.status, n.canonicality, n.source_label, n.updated_at, n.tags_json
         FROM ${from}
         ${whereClause}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`
      )
      .all(...rowValues, limit, offset) as Record<string, unknown>[];

    return {
      total: countRow.total,
      items: rows.map((row) => ({
        id: String(row.id),
        type: row.type as SearchResultItem["type"],
        title: row.title ? String(row.title) : null,
        summary: row.summary ? String(row.summary) : null,
        status: row.status as SearchResultItem["status"],
        canonicality: row.canonicality as SearchResultItem["canonicality"],
        sourceLabel: row.source_label ? String(row.source_label) : null,
        updatedAt: String(row.updated_at),
        tags: parseJson<string[]>(row.tags_json as string | null, [])
      }))
    };
  }

  getNode(id: string): NodeRecord {
    const row = this.db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return mapNode(assertPresent(row, `Node ${id} not found`));
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
           r.*,
           CASE WHEN r.from_node_id = ? THEN r.to_node_id ELSE r.from_node_id END AS related_id
         FROM relations r
         WHERE (r.from_node_id = ? OR r.to_node_id = ?)
           AND r.status != 'archived'
           ${relationWhere}
         ORDER BY r.created_at DESC`
      )
      .all(nodeId, nodeId, nodeId, ...(relationFilter ?? [])) as Record<string, unknown>[];

    return rows.map((row) => ({
      relation: mapRelation(row),
      node: this.getNode(String(row.related_id))
    }));
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

    this.syncRelationUsageRollups();
    const rows = this.db
      .prepare(
        `SELECT
           relation_id,
           total_delta,
           event_count,
           last_event_at
         FROM relation_usage_rollups
         WHERE relation_id IN (${relationIds.map(() => "?").join(", ")})
         ORDER BY relation_id`
      )
      .all(...relationIds) as Array<Record<string, unknown>>;

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
    for (const row of rows) {
      const id = String(row.id);
      const currentStatus = String(row.status) as InferredRelationRecord["status"];
      const expiresAt = row.expires_at ? String(row.expires_at) : null;
      const recomputed = computeMaintainedScores(Number(row.base_score), summaries.get(id), String(row.last_computed_at));
      const nextStatus =
        expiresAt && expiresAt <= now ? "expired" : currentStatus === "expired" ? "active" : currentStatus;
      if (nextStatus === "expired") {
        expiredCount += 1;
      }
      updateStatement.run(recomputed.usageScore, recomputed.finalScore, nextStatus, now, id);
    }

    return {
      updatedCount: rows.length,
      expiredCount,
      items: relationIds.map((id) => this.getInferredRelation(id))
    };
  }

  countInferredRelations(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM inferred_relations`).get() as { total: number };
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
    if (!isPathWithinRoot(this.workspaceRoot, absolutePath)) {
      throw new AppError(403, "FORBIDDEN", "Artifact path escapes workspace root.");
    }
    const stats = statSync(absolutePath);
    this.db
      .prepare(
        `INSERT INTO artifacts (
          id, node_id, path, mime_type, size_bytes, checksum, created_by, source_label, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.nodeId,
        path.relative(this.workspaceRoot, absolutePath),
        input.mimeType ?? null,
        stats.size,
        checksumText(`${absolutePath}:${stats.size}:${stats.mtimeMs}`),
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

  getArtifact(id: string): ArtifactRecord {
    const row = this.db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return mapArtifact(assertPresent(row, `Artifact ${id} not found`));
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

  createReviewItem(params: {
    entityType: string;
    entityId: string;
    reviewType: string;
    proposedBy: string | null;
    notes?: string | null;
    metadata?: JsonMap;
  }): ReviewQueueRecord {
    const id = createId("rev");
    this.db
      .prepare(
        `INSERT INTO review_queue (
          id, entity_type, entity_id, review_type, proposed_by, created_at, status, notes, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        id,
        params.entityType,
        params.entityId,
        params.reviewType,
        params.proposedBy,
        nowIso(),
        params.notes ?? null,
        JSON.stringify(params.metadata ?? {})
      );
    return this.getReviewItem(id);
  }

  listReviewItems(status = "pending", limit = 20, reviewType?: string): ReviewQueueRecord[] {
    const rows = reviewType
      ? ((this.db
          .prepare(
            `SELECT * FROM review_queue
             WHERE status = ? AND review_type = ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(status, reviewType, limit) as Record<string, unknown>[]))
      : ((this.db
          .prepare(`SELECT * FROM review_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
          .all(status, limit) as Record<string, unknown>[]));
    return rows.map(mapReviewQueue);
  }

  getReviewItem(id: string): ReviewQueueRecord {
    const row = this.db.prepare(`SELECT * FROM review_queue WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return mapReviewQueue(assertPresent(row, `Review item ${id} not found`));
  }

  updateReviewItemStatus(id: string, status: string, notes?: string | null): ReviewQueueRecord {
    const existing = this.getReviewItem(id);
    this.db
      .prepare(`UPDATE review_queue SET status = ?, notes = ? WHERE id = ?`)
      .run(status, notes ?? existing.notes ?? null, id);
    return this.getReviewItem(id);
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

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(key, JSON.stringify(value));
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
    for (const [key, value] of Object.entries(settings)) {
      this.setSetting(key, value);
    }
  }
}
