import { DatabaseSync } from "node:sqlite";
import type { WorkspacePaths } from "./workspace.js";

const schemaVersion = 5;

function execMigration(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      canonicality TEXT NOT NULL DEFAULT 'canonical',
      visibility TEXT NOT NULL DEFAULT 'normal',
      title TEXT,
      body TEXT,
      summary TEXT,
      created_by TEXT,
      source_type TEXT,
      source_label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      tags_json TEXT,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS node_tags (
      node_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (node_id, tag),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS node_index_state (
      node_id TEXT PRIMARY KEY,
      content_hash TEXT,
      embedding_status TEXT NOT NULL DEFAULT 'pending',
      embedding_provider TEXT,
      embedding_model TEXT,
      embedding_version TEXT,
      stale_reason TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS node_chunks (
      node_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      chunk_hash TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      token_count INTEGER,
      start_offset INTEGER,
      end_offset INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (node_id, ordinal),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS node_embeddings (
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      chunk_ordinal INTEGER,
      vector_ref TEXT,
      vector_blob BLOB,
      embedding_provider TEXT,
      embedding_model TEXT,
      embedding_version TEXT,
      content_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_type, owner_id, chunk_ordinal)
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT,
      source_type TEXT,
      source_label TEXT,
      created_at TEXT NOT NULL,
      metadata_json TEXT,
      FOREIGN KEY (from_node_id) REFERENCES nodes(id),
      FOREIGN KEY (to_node_id) REFERENCES nodes(id)
    );

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      target_node_id TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      body TEXT,
      created_by TEXT,
      source_type TEXT,
      source_label TEXT,
      created_at TEXT NOT NULL,
      metadata_json TEXT,
      FOREIGN KEY (target_node_id) REFERENCES nodes(id)
    );

    CREATE TABLE IF NOT EXISTS inferred_relations (
      id TEXT PRIMARY KEY,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      base_score REAL NOT NULL,
      usage_score REAL NOT NULL DEFAULT 0,
      final_score REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      generator TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      last_computed_at TEXT NOT NULL,
      expires_at TEXT,
      metadata_json TEXT,
      FOREIGN KEY (from_node_id) REFERENCES nodes(id),
      FOREIGN KEY (to_node_id) REFERENCES nodes(id)
    );

    CREATE TABLE IF NOT EXISTS relation_usage_events (
      id TEXT PRIMARY KEY,
      relation_id TEXT NOT NULL,
      relation_source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      session_id TEXT,
      run_id TEXT,
      actor_type TEXT,
      actor_label TEXT,
      tool_name TEXT,
      delta REAL NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS relation_usage_rollups (
      relation_id TEXT PRIMARY KEY,
      total_delta REAL NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      last_event_at TEXT NOT NULL,
      last_event_rowid INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relation_usage_rollup_state (
      id TEXT PRIMARY KEY,
      last_event_rowid INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      path TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      checksum TEXT,
      created_by TEXT,
      source_label TEXT,
      created_at TEXT NOT NULL,
      metadata_json TEXT,
      FOREIGN KEY (node_id) REFERENCES nodes(id)
    );

    CREATE TABLE IF NOT EXISTS provenance_events (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_label TEXT,
      tool_name TEXT,
      tool_version TEXT,
      timestamp TEXT NOT NULL,
      input_ref TEXT,
      metadata_json TEXT
    );

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

    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      capabilities_json TEXT,
      config_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id UNINDEXED,
      title,
      body,
      summary,
      content=''
    );

    CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, title, body, summary)
      VALUES (new.rowid, new.id, coalesce(new.title, ''), coalesce(new.body, ''), coalesce(new.summary, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, title, body, summary)
      VALUES ('delete', old.rowid, old.id, old.title, old.body, old.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, title, body, summary)
      VALUES ('delete', old.rowid, old.id, old.title, old.body, old.summary);
      INSERT INTO nodes_fts(rowid, id, title, body, summary)
      VALUES (new.rowid, new.id, coalesce(new.title, ''), coalesce(new.body, ''), coalesce(new.summary, ''));
    END;

    CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
    CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
    CREATE INDEX IF NOT EXISTS idx_nodes_updated_at ON nodes(updated_at);
    CREATE INDEX IF NOT EXISTS idx_node_tags_tag_node
      ON node_tags(tag, node_id);
    CREATE INDEX IF NOT EXISTS idx_node_index_state_status
      ON node_index_state(embedding_status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_node_chunks_hash
      ON node_chunks(chunk_hash);
    CREATE INDEX IF NOT EXISTS idx_node_embeddings_status
      ON node_embeddings(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_node_embeddings_owner
      ON node_embeddings(owner_type, owner_id);
    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_node_id);
    CREATE INDEX IF NOT EXISTS idx_relations_from_status_created_at
      ON relations(from_node_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_relations_to_status_created_at
      ON relations(to_node_id, status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inferred_relations_identity
      ON inferred_relations(from_node_id, to_node_id, relation_type, generator);
    CREATE INDEX IF NOT EXISTS idx_inferred_relations_from_score
      ON inferred_relations(from_node_id, final_score DESC);
    CREATE INDEX IF NOT EXISTS idx_inferred_relations_to_score
      ON inferred_relations(to_node_id, final_score DESC);
    CREATE INDEX IF NOT EXISTS idx_inferred_relations_status
      ON inferred_relations(status);
    CREATE INDEX IF NOT EXISTS idx_relation_usage_relation
      ON relation_usage_events(relation_id);
    CREATE INDEX IF NOT EXISTS idx_relation_usage_created_at
      ON relation_usage_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_relation_usage_rollups_last_event_at
      ON relation_usage_rollups(last_event_at);
    CREATE INDEX IF NOT EXISTS idx_activities_target ON activities(target_node_id);
    CREATE INDEX IF NOT EXISTS idx_activities_target_created_at
      ON activities(target_node_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_node ON artifacts(node_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_node_created_at
      ON artifacts(node_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_path_created_at
      ON artifacts(path, created_at DESC, node_id);
    CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(status);
    CREATE INDEX IF NOT EXISTS idx_review_queue_status_type_created_at
      ON review_queue(status, review_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provenance_entity ON provenance_events(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_provenance_entity_timestamp
      ON provenance_events(entity_type, entity_id, timestamp DESC);
  `);
}

export function openDatabase(paths: WorkspacePaths): DatabaseSync {
  const db = new DatabaseSync(paths.dbPath);
  execMigration(db);

  return db;
}

export function getSchemaVersion(): number {
  return schemaVersion;
}
