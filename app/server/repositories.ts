import { statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ActivityRecord,
  ArtifactRecord,
  IntegrationRecord,
  JsonMap,
  NodeRecord,
  ProvenanceRecord,
  RelationRecord,
  ReviewQueueRecord,
  SearchResultItem
} from "../shared/types.js";
import type {
  AppendActivityInput,
  CreateNodeInput,
  CreateRelationInput,
  RegisterIntegrationInput,
  Source,
  UpdateIntegrationInput,
  UpdateNodeInput
} from "../shared/contracts.js";
import { AppError, assertPresent } from "./errors.js";
import { checksumText, createId, nowIso, parseJson, stableSummary } from "./utils.js";

type SqlValue = string | number | bigint | Uint8Array | null;

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

export class MemforgeRepository {
  constructor(private readonly db: DatabaseSync, private readonly workspaceRoot: string) {}

  private touchNode(id: string): void {
    this.db.prepare(`UPDATE nodes SET updated_at = ? WHERE id = ?`).run(nowIso(), id);
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
      for (const tag of filters.tags) {
        where.push("n.tags_json LIKE ?");
        whereValues.push(`%${tag}%`);
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
        input.summary ?? stableSummary(input.title, input.body),
        input.source.actorLabel,
        input.source.actorType,
        input.source.actorLabel,
        now,
        now,
        JSON.stringify(input.tags),
        JSON.stringify(input.metadata)
      );

    return this.getNode(id);
  }

  updateNode(id: string, input: UpdateNodeInput): NodeRecord {
    const existing = this.getNode(id);
    const nextTitle = input.title ?? existing.title;
    const nextBody = input.body ?? existing.body;
    const nextSummary = input.summary ?? stableSummary(nextTitle, nextBody);
    const nextTags = input.tags ?? existing.tags;
    const nextMetadata = input.metadata ?? existing.metadata;
    const nextStatus = input.status ?? existing.status;

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
        nowIso(),
        id
      );

    return this.getNode(id);
  }

  archiveNode(id: string): NodeRecord {
    this.db.prepare(`UPDATE nodes SET status = 'archived', updated_at = ? WHERE id = ?`).run(nowIso(), id);
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

  getRelation(id: string): RelationRecord {
    const row = this.db.prepare(`SELECT * FROM relations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return mapRelation(assertPresent(row, `Relation ${id} not found`));
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
