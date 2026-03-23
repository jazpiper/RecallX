import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecallXApp } from "../app/server/app.js";
import { createServerConfig } from "../app/server/config.js";
import { getSqliteVecExtensionRuntime, openDatabase } from "../app/server/db.js";
import { buildProjectGraph } from "../app/server/project-graph.js";
import { RecallXRepository } from "../app/server/repositories.js";
import { embedSemanticQueryText, resolveSemanticEmbeddingProvider } from "../app/server/semantic/provider.js";
import { isPathWithinRoot } from "../app/server/utils.js";
import { ensureWorkspace } from "../app/server/workspace.js";
import { WorkspaceSessionManager } from "../app/server/workspace-session.js";

const tempRoots: string[] = [];
const LOCAL_NGRAM_EMBEDDING_VERSION = "2";

async function waitFor<T>(
  check: () => T | null | undefined | Promise<T | null | undefined>,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<NonNullable<T>> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 25;
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) {
        return value as NonNullable<T>;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function createRepositoryContext(options: Parameters<typeof openDatabase>[1] = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
  tempRoots.push(root);
  const workspace = ensureWorkspace(root);
  const db = openDatabase(workspace, options);
  const repository = new RecallXRepository(db, root);
  repository.upsertBaseSettings({
    "workspace.name": "RecallX Test"
  });
  return {
    root,
    db,
    repository
  };
}

function createRepository() {
  return createRepositoryContext().repository;
}

function createWorkspaceSessionManager(root: string, authMode: "optional" | "bearer" = "optional") {
  return new WorkspaceSessionManager(
    {
      ...createServerConfig(root),
      port: 8787,
      bindAddress: "127.0.0.1",
      apiToken: authMode === "bearer" ? "secret-token" : null,
      workspaceName: "RecallX Test",
    },
    root,
    authMode,
  );
}

function encodeVector(vector: number[]) {
  return new Uint8Array(new Float32Array(vector).buffer);
}

async function seedSemanticEmbeddings(params: {
  db: ReturnType<typeof openDatabase>;
  repository: RecallXRepository;
  query: string;
  relatedNodeId: string;
  distractorNodeId: string;
}) {
  const queryEmbedding = await embedSemanticQueryText({
    provider: "local-ngram",
    model: "chargram-v1",
    text: params.query
  });
  if (!queryEmbedding?.vector.length) {
    throw new Error("Expected local-ngram query embedding to be available");
  }

  const distractorVector = queryEmbedding.vector.map((value, index) => {
    const basis = index % 2 === 0 ? -0.15 : 0.12;
    return value * 0.05 + basis;
  });
  const now = "2026-03-20T00:00:00.000Z";
  const insertEmbedding = params.db.prepare(
    `INSERT INTO node_embeddings (
       owner_type, owner_id, chunk_ordinal, vector_ref, vector_blob, embedding_provider, embedding_model,
       embedding_version, content_hash, status, created_at, updated_at
     ) VALUES ('node', ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`
  );
  const upsertReadyState = params.db.prepare(
    `INSERT INTO node_index_state (
       node_id, content_hash, embedding_status, embedding_provider, embedding_model, embedding_version, stale_reason, updated_at
     ) VALUES (?, ?, 'ready', ?, ?, ?, NULL, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       content_hash = excluded.content_hash,
       embedding_status = excluded.embedding_status,
       embedding_provider = excluded.embedding_provider,
       embedding_model = excluded.embedding_model,
       embedding_version = excluded.embedding_version,
       stale_reason = excluded.stale_reason,
       updated_at = excluded.updated_at`
  );

  insertEmbedding.run(params.relatedNodeId, 0, null, encodeVector(queryEmbedding.vector), "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, "hash-related", now, now);
  insertEmbedding.run(params.distractorNodeId, 0, null, encodeVector(distractorVector), "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, "hash-distractor", now, now);
  upsertReadyState.run(params.relatedNodeId, "hash-related", "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, now);
  upsertReadyState.run(params.distractorNodeId, "hash-distractor", "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, now);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  }
});

describe("search punctuation handling", () => {
  it("falls back cleanly for punctuation-heavy queries", () => {
    const repository = createRepository();
    repository.createNode({
      type: "note",
      title: "C++ retrieval note",
      body: "foo: bar",
      tags: ["search"],
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const cppResults = repository.searchNodes({
      query: "C++",
      filters: {},
      limit: 10,
      offset: 0,
      sort: "relevance"
    });
    const colonResults = repository.searchNodes({
      query: "foo:",
      filters: {},
      limit: 10,
      offset: 0,
      sort: "relevance"
    });

    expect(cppResults.total).toBe(1);
    expect(cppResults.items[0]?.title).toBe("C++ retrieval note");
    expect(colonResults.total).toBe(1);
    expect(colonResults.items[0]?.title).toBe("C++ retrieval note");
  });

  it("matches tag filters exactly through the normalized tag index", () => {
    const repository = createRepository();
    repository.createNode({
      type: "note",
      title: "Graph retrieval note",
      body: "Exact graph tag",
      tags: ["Graph"],
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    repository.createNode({
      type: "note",
      title: "Graphical rendering note",
      body: "Different tag family",
      tags: ["graphical"],
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const results = repository.searchNodes({
      query: "",
      filters: { tags: [" graph "] },
      limit: 10,
      offset: 0,
      sort: "updated_at"
    });

    expect(results.total).toBe(1);
    expect(results.items[0]?.title).toBe("Graph retrieval note");
  });

  it("backfills legacy activities into the activity FTS index", () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);
    const repository = new RecallXRepository(db, root);
    repository.upsertBaseSettings({
      "workspace.name": "RecallX Test",
      "search.activityFts.version": 0
    });

    const node = repository.createNode({
      type: "note",
      title: "Search target",
      body: "Node for activity backfill test.",
      tags: [],
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    repository.appendActivity({
      targetNodeId: node.id,
      activityType: "agent_run_summary",
      body: "Historical cleanup note for activity FTS backfill.",
      source: {
        actorType: "agent",
        actorLabel: "Codex",
        toolName: "codex"
      },
      metadata: {}
    });

    db.prepare(`INSERT INTO activities_fts(activities_fts) VALUES ('delete-all')`).run();
    repository.setSetting("search.activityFts.version", 0);

    expect(
      repository.searchActivities({
        query: "cleanup",
        filters: {},
        limit: 10,
        offset: 0,
        sort: "relevance"
      }).total
    ).toBe(0);

    repository.ensureActivitySearchIndex();

    const results = repository.searchActivities({
      query: "cleanup",
      filters: {},
      limit: 10,
      offset: 0,
      sort: "relevance"
    });

    expect(results.total).toBe(1);
    expect(results.items[0]?.body).toContain("cleanup");
    db.close();
  });
});

describe("capture workflow behavior", () => {
  it("routes short auto-capture writes into the workspace inbox activity timeline", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/capture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "auto",
          body: "Fixed the MCP alias normalization path.",
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex"
          },
          metadata: {}
        })
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.data.storedAs).toBe("activity");
      expect(payload.data.targetNode.type).toBe("conversation");
      expect(payload.data.targetNode.title).toBe("Workspace Inbox");
      expect(payload.data.activity.targetNodeId).toBe(payload.data.targetNode.id);
      expect(payload.data.landing).toEqual({
        storedAs: "activity",
        status: "recorded",
        governanceState: null,
        reason: "Short log-like capture was routed to the activity timeline."
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("stores reusable auto-capture writes as durable nodes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/capture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "auto",
          body: "Use `scope` as an alias for workspace search and normalize it into scopes.",
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex"
          },
          metadata: {
            reusable: true
          }
        })
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.data.storedAs).toBe("node");
      expect(payload.data.node.type).toBe("note");
      expect(payload.data.landing.storedAs).toBe("node");
      expect(payload.data.landing.reason).toBe("Reusable agent-authored knowledge starts suggested and active.");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("stores decision capture writes as decision nodes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/capture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "decision",
          body: "Default short log-like captures should land in the workspace inbox.",
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex"
          },
          metadata: {}
        })
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.data.storedAs).toBe("node");
      expect(payload.data.node.type).toBe("decision");
      expect(payload.data.landing.reason).toContain("decisions start suggested");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("adds capture recovery hints when explicit create_node stays short-form", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Short update",
          body: "done",
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex"
          },
          metadata: {}
        })
      });
      const payload = await response.json();

      expect(response.status).toBe(403);
      expect(payload.error.details.recommendation).toContain("/api/v1/capture");
      expect(payload.error.details.suggestedMode).toBe("activity");
      expect(payload.error.details.suggestedTarget).toBe("workspace-inbox");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("allows short explicit question nodes through the durable path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "question",
          title: "Follow-up question",
          body: "Should capture use the inbox by default?",
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex"
          },
          metadata: {}
        })
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.data.node.type).toBe("question");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("creates node batches with per-item landing metadata", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/nodes/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodes: [
            {
              type: "note",
              title: "Reusable batch note",
              body: "Use workspace search as the default entry point when the target node is unknown.",
              summary: "Search workspace should be the default mixed retrieval entry point.",
              source: {
                actorType: "agent",
                actorLabel: "Codex",
                toolName: "codex"
              },
              metadata: {}
            },
            {
              type: "question",
              title: "Batch follow-up",
              body: "Should batch create preserve per-item governance landing details?",
              source: {
                actorType: "agent",
                actorLabel: "Codex",
                toolName: "codex"
              },
              metadata: {}
            }
          ]
        })
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.data.summary).toEqual({
        requestedCount: 2,
        successCount: 2,
        errorCount: 0
      });
      expect(payload.data.items).toHaveLength(2);
      expect(payload.data.items[0]).toMatchObject({
        ok: true,
        index: 0,
        landing: {
          storedAs: "node",
          canonicality: "suggested",
          status: "active",
          reason: "Reusable agent-authored knowledge starts suggested and active."
        }
      });
      expect(payload.data.items[1]).toMatchObject({
        ok: true,
        index: 1,
        landing: {
          storedAs: "node",
          status: "active"
        }
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("returns partial success for node batches when one item is short-form agent output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/nodes/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodes: [
            {
              type: "note",
              title: "Short update",
              body: "done",
              source: {
                actorType: "agent",
                actorLabel: "Codex",
                toolName: "codex"
              },
              metadata: {}
            },
            {
              type: "note",
              title: "Durable batch note",
              body: "Use recallx_create_nodes for end-of-session writeback when several durable facts were identified.",
              summary: "Batch durable write for multiple reusable facts.",
              source: {
                actorType: "agent",
                actorLabel: "Codex",
                toolName: "codex"
              },
              metadata: {}
            }
          ]
        })
      });
      const payload = await response.json();

      expect(response.status).toBe(207);
      expect(payload.data.summary).toEqual({
        requestedCount: 2,
        successCount: 1,
        errorCount: 1
      });
      expect(payload.data.items[0]).toMatchObject({
        ok: false,
        index: 0,
        error: {
          code: "FORBIDDEN",
          message: "Short log-like agent output must be appended as activity, not stored as a durable node.",
          details: expect.objectContaining({
            suggestedMode: "activity",
            suggestedTarget: "workspace-inbox"
          })
        }
      });
      expect(payload.data.items[1]).toMatchObject({
        ok: true,
        index: 1,
        landing: {
          storedAs: "node",
          canonicality: "suggested",
          status: "active"
        }
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("node update behavior", () => {
  it("preserves curated summaries on unrelated PATCH updates and records provenance", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const node = repository.createNode({
      type: "note",
      title: "Curated summary note",
      body: "Original body for curated summary preservation.",
      summary: "Hand-written retrieval summary",
      tags: [],
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/nodes/${node.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tags: ["updated"],
          source: {
            actorType: "human",
            actorLabel: "juhwan",
            toolName: "recallx-test"
          }
        })
      });
      const body = await response.json();
      const provenance = repository.listProvenance("node", node.id);

      expect(response.status).toBe(200);
      expect(body.data.node.summary).toBe("Hand-written retrieval summary");
      expect(body.data.node.tags).toEqual(["updated"]);
      expect(body.data.governance).toEqual(
        expect.objectContaining({
          state: expect.any(Object),
          events: expect.any(Array)
        })
      );
      expect(provenance.some((item) => item.operationType === "update")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("marks curated summaries stale after body edits and refreshes them on demand", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const node = repository.createNode({
      type: "note",
      title: "Summary lifecycle note",
      body: "Original body for summary lifecycle.",
      summary: "Curated retrieval summary",
      tags: [],
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      };

      const patchResponse = await fetch(`${baseUrl}/nodes/${node.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "Updated body that should leave the curated summary stale until refreshed.",
          source
        })
      });
      const patchBody = await patchResponse.json();
      const staleNode = patchBody.data.node;

      const refreshResponse = await fetch(`${baseUrl}/nodes/${node.id}/refresh-summary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source })
      });
      const refreshBody = await refreshResponse.json();
      const refreshedNode = refreshBody.data.node;
      const provenance = repository.listProvenance("node", node.id);

      expect(patchResponse.status).toBe(200);
      expect(staleNode.summary).toBe("Curated retrieval summary");
      expect(typeof staleNode.metadata.summaryUpdatedAt).toBe("string");
      expect(staleNode.metadata.summarySource).toBe("explicit");
      expect(new Date(staleNode.updatedAt).getTime()).toBeGreaterThan(new Date(staleNode.metadata.summaryUpdatedAt).getTime());

      expect(refreshResponse.status).toBe(200);
      expect(refreshedNode.summary).toContain("Updated body that should leave the curated summary stale");
      expect(refreshedNode.metadata.summarySource).toBe("manual_refresh");
      expect(refreshedNode.metadata.summaryUpdatedAt).toBe(refreshedNode.updatedAt);
      expect(
        provenance.some(
          (item) => item.operationType === "update" && item.metadata.reason === "summary.refreshed"
        )
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("legacy review queue migration helpers", () => {
  it("keeps migration-only legacy review items filterable by type", () => {
    const repository = createRepository();
    repository.createLegacyReviewItem({
      entityType: "node",
      entityId: "node_one",
      reviewType: "node_promotion",
      proposedBy: "Codex",
      notes: "Promote note"
    });
    repository.createLegacyReviewItem({
      entityType: "relation",
      entityId: "rel_one",
      reviewType: "relation_suggestion",
      proposedBy: "Codex",
      notes: "Review relation"
    });

    const filtered = repository
      .listLegacyReviewItems(20)
      .filter((item) => item.status === "pending" && item.reviewType === "node_promotion");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.reviewType).toBe("node_promotion");
  });
});

describe("recent ordering", () => {
  it("bumps a node when activity is appended so recent views can surface it", async () => {
    const repository = createRepository();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };

    const older = repository.createNode({
      type: "note",
      title: "Older node",
      body: "Created first",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const newer = repository.createNode({
      type: "note",
      title: "Newer node",
      body: "Created second",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    expect(repository.listNodes(2)[0]?.id).toBe(newer.id);

    await new Promise((resolve) => setTimeout(resolve, 5));

    repository.appendActivity({
      targetNodeId: older.id,
      activityType: "agent_run_summary",
      body: "Touched by recent activity",
      source,
      metadata: {}
    });

    expect(repository.listNodes(2)[0]?.id).toBe(older.id);
  });
});

describe("inferred relation storage", () => {
  it("upserts inferred relations by identity and keeps the existing id", () => {
    const repository = createRepository();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const fromNode = repository.createNode({
      type: "note",
      title: "Inference source",
      body: "Source note",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const toNode = repository.createNode({
      type: "project",
      title: "Inference target",
      body: "Target project",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const created = repository.upsertInferredRelation({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      relationType: "supports",
      baseScore: 0.48,
      usageScore: 0.05,
      finalScore: 0.53,
      status: "active",
      generator: "deterministic-linker",
      evidence: {
        sharedTags: ["planning"]
      },
      metadata: {
        pass: "initial"
      }
    });

    const updated = repository.upsertInferredRelation({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      relationType: "supports",
      baseScore: 0.61,
      usageScore: 0.18,
      finalScore: 0.79,
      status: "active",
      generator: "deterministic-linker",
      evidence: {
        sharedTags: ["planning", "graph"]
      },
      metadata: {
        pass: "refresh"
      }
    });

    const listed = repository.listInferredRelationsForNode(fromNode.id);

    expect(updated.id).toBe(created.id);
    expect(updated.baseScore).toBe(0.61);
    expect(updated.usageScore).toBe(0.18);
    expect(updated.finalScore).toBe(0.79);
    expect(updated.metadata.pass).toBe("refresh");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
  });

  it("lists only active, non-expired inferred relations ordered by score", () => {
    const repository = createRepository();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const focus = repository.createNode({
      type: "note",
      title: "Focus node",
      body: "Center of inferred graph",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const highScore = repository.createNode({
      type: "note",
      title: "High score relation",
      body: "Should be first",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const lowScore = repository.createNode({
      type: "note",
      title: "Low score relation",
      body: "Should be second",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const expired = repository.createNode({
      type: "note",
      title: "Expired relation",
      body: "Should be filtered out",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const hidden = repository.createNode({
      type: "note",
      title: "Hidden relation",
      body: "Should be filtered out",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    repository.upsertInferredRelation({
      fromNodeId: focus.id,
      toNodeId: lowScore.id,
      relationType: "relevant_to",
      baseScore: 0.4,
      usageScore: 0.1,
      finalScore: 0.5,
      status: "active",
      generator: "deterministic-linker",
      evidence: {},
      metadata: {}
    });
    repository.upsertInferredRelation({
      fromNodeId: highScore.id,
      toNodeId: focus.id,
      relationType: "supports",
      baseScore: 0.76,
      usageScore: 0.11,
      finalScore: 0.87,
      status: "active",
      generator: "deterministic-linker",
      evidence: {},
      metadata: {}
    });
    repository.upsertInferredRelation({
      fromNodeId: focus.id,
      toNodeId: expired.id,
      relationType: "depends_on",
      baseScore: 0.7,
      usageScore: 0,
      finalScore: 0.7,
      status: "active",
      generator: "deterministic-linker",
      evidence: {},
      expiresAt: "2000-01-01T00:00:00.000Z",
      metadata: {}
    });
    repository.upsertInferredRelation({
      fromNodeId: focus.id,
      toNodeId: hidden.id,
      relationType: "supports",
      baseScore: 0.95,
      usageScore: 0,
      finalScore: 0.95,
      status: "hidden",
      generator: "deterministic-linker",
      evidence: {},
      metadata: {}
    });

    const listed = repository.listInferredRelationsForNode(focus.id);

    expect(listed).toHaveLength(2);
    expect(listed.map((item) => item.finalScore)).toEqual([0.87, 0.5]);
    expect(listed.every((item) => item.status === "active")).toBe(true);
  });
});

describe("semantic skeleton", () => {
  it("creates semantic index tables in a fresh workspace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);

    const tableNames = ["node_index_state", "node_chunks", "node_embeddings"].map((name) =>
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name) as Record<string, unknown> | undefined
    );

    expect(tableNames.map((row) => row?.name)).toEqual(["node_index_state", "node_chunks", "node_embeddings"]);
  });

  it("marks semantic index state as pending on node and activity writes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);
    const repository = new RecallXRepository(db, root);
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };

    const node = repository.createNode({
      type: "note",
      title: "Semantic target",
      body: "Needs indexing",
      tags: ["semantic"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    repository.appendActivity({
      targetNodeId: node.id,
      activityType: "agent_run_summary",
      body: "Updated semantic context",
      source,
      metadata: {}
    });

    const status = repository.getSemanticStatus();
    const row = db
      .prepare(`SELECT embedding_status, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;

    expect(status.counts.pending).toBe(1);
    expect(row?.embedding_status).toBe("pending");
    expect(row?.stale_reason).toBe("activity.appended");
  });

  it("surfaces semantic defaults and reindex status through the HTTP API", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "human" as const,
        actorLabel: "juhwan",
        toolName: "recallx-test"
      };

      const bootstrapResponse = await fetch(`${baseUrl}/bootstrap`);
      const bootstrapBody = await bootstrapResponse.json();

      const node = workspaceSessionManager.getCurrent().repository.createNode({
        type: "note",
        title: "Queued semantic node",
        body: "Pending semantic indexing",
        tags: ["semantic"],
        source,
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active"
      });

      const reindexResponse = await fetch(`${baseUrl}/semantic/reindex/${node.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      const statusResponse = await fetch(`${baseUrl}/semantic/status`);
      const statusBody = await statusResponse.json();

      expect(bootstrapResponse.status).toBe(200);
      expect(bootstrapBody.data.semantic).toMatchObject({
        enabled: false,
        provider: "disabled",
        model: "none",
        configuredIndexBackend: "sqlite-vec",
        chunkEnabled: false,
        workspaceFallbackEnabled: false,
        workspaceFallbackMode: "strict_zero"
      });
      expect(["sqlite", "sqlite-vec"]).toContain(bootstrapBody.data.semantic.indexBackend);
      expect(["loaded", "fallback"]).toContain(bootstrapBody.data.semantic.extensionStatus);
      expect(bootstrapBody.data.autoSemanticIndex).toMatchObject({
        enabled: true,
        batchLimit: 20,
      });
      expect(reindexResponse.status).toBe(200);
      expect(statusResponse.status).toBe(200);
      expect(statusBody.data).toMatchObject({
        enabled: false,
        provider: "disabled",
        model: "none",
        configuredIndexBackend: "sqlite-vec",
        chunkEnabled: false,
        workspaceFallbackEnabled: false,
        workspaceFallbackMode: "strict_zero"
      });
      expect(statusBody.data.counts.pending).toBeGreaterThanOrEqual(1);

      const issuesResponse = await fetch(`${baseUrl}/semantic/issues?limit=2`);
      const issuesBody = await issuesResponse.json();
      expect(issuesResponse.status).toBe(200);
      expect(issuesBody.data.items[0]).toMatchObject({
        nodeId: node.id,
        embeddingStatus: "pending",
        staleReason: "manual.reindex"
      });
      expect(issuesBody.data.nextCursor).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("filters and paginates semantic issues without widening the aggregate semantic status contract", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const db = workspaceSessionManager.getCurrent().db;
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const failedNode = repository.createNode({
      type: "note",
      title: "Failed semantic item",
      body: "Will fail",
      tags: ["semantic"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const staleNode = repository.createNode({
      type: "note",
      title: "Stale semantic item",
      body: "Will become stale",
      tags: ["semantic"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const pendingNode = repository.createNode({
      type: "note",
      title: "Pending semantic item",
      body: "Will stay pending",
      tags: ["semantic"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    db.prepare(
      `UPDATE node_index_state
       SET embedding_status = ?, stale_reason = ?, updated_at = ?
       WHERE node_id = ?`
    ).run("failed", "provider.failed", "2026-03-18T10:00:00.000Z", failedNode.id);
    db.prepare(
      `UPDATE node_index_state
       SET embedding_status = ?, stale_reason = ?, updated_at = ?
       WHERE node_id = ?`
    ).run("stale", "content.changed", "2026-03-18T09:00:00.000Z", staleNode.id);
    db.prepare(
      `UPDATE node_index_state
       SET embedding_status = ?, stale_reason = ?, updated_at = ?
       WHERE node_id = ?`
    ).run("pending", "manual.reindex", "2026-03-18T08:00:00.000Z", pendingNode.id);

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const filteredResponse = await fetch(`${baseUrl}/semantic/issues?limit=1&statuses=failed,stale`);
      const filteredBody = await filteredResponse.json();

      expect(filteredResponse.status).toBe(200);
      expect(filteredBody.data.items).toHaveLength(1);
      expect(filteredBody.data.items[0]).toMatchObject({
        nodeId: failedNode.id,
        embeddingStatus: "failed"
      });
      expect(typeof filteredBody.data.nextCursor).toBe("string");

      const nextResponse = await fetch(
        `${baseUrl}/semantic/issues?limit=1&statuses=failed,stale&cursor=${encodeURIComponent(filteredBody.data.nextCursor)}`
      );
      const nextBody = await nextResponse.json();

      expect(nextResponse.status).toBe(200);
      expect(nextBody.data.items).toHaveLength(1);
      expect(nextBody.data.items[0]).toMatchObject({
        nodeId: staleNode.id,
        embeddingStatus: "stale"
      });
      expect(nextBody.data.nextCursor).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("processes pending semantic items into chunks and marks them ready in chunk-only mode", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);
    const repository = new RecallXRepository(db, root);
    repository.ensureBaseSettings({
      "search.semantic.enabled": false,
      "search.semantic.provider": "disabled",
      "search.semantic.model": "none",
      "search.semantic.chunk.enabled": true,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };

    const node = repository.createNode({
      type: "note",
      title: "Chunk me",
      body: "A".repeat(1800),
      tags: ["semantic", "chunk"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const result = await repository.processPendingSemanticIndex(10);
    const state = db
      .prepare(`SELECT embedding_status, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;
    const chunkRows = db
      .prepare(`SELECT ordinal, chunk_text FROM node_chunks WHERE node_id = ? ORDER BY ordinal ASC`)
      .all(node.id) as Array<Record<string, unknown>>;

    expect(result.processedCount).toBe(1);
    expect(result.mode).toBe("chunk-only");
    expect(state?.embedding_status).toBe("ready");
    expect(state?.stale_reason).toBeNull();
    expect(chunkRows.length).toBeGreaterThan(1);
    expect(String(chunkRows[0]?.chunk_text ?? "")).toContain("Chunk me");
  });

  it("writes local-ngram embeddings and remains idempotent across repeated worker runs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);
    const repository = new RecallXRepository(db, root);
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "local-ngram",
      "search.semantic.model": "chargram-v1",
      "search.semantic.chunk.enabled": false,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };

    const node = repository.createNode({
      type: "note",
      title: "Local n-gram embedding target",
      body: "This content should receive a stable local n-gram vector.",
      tags: ["semantic", "vector"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const first = await repository.processPendingSemanticIndex(10);
    const firstState = db
      .prepare(`SELECT embedding_status, embedding_provider, embedding_model, embedding_version FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;
    const firstEmbeddings = db
      .prepare(`SELECT chunk_ordinal, vector_blob, embedding_provider, embedding_model, embedding_version, status FROM node_embeddings WHERE owner_type = 'node' AND owner_id = ? ORDER BY chunk_ordinal ASC`)
      .all(node.id) as Array<Record<string, unknown>>;

    const second = await repository.processPendingSemanticIndex(10);
    const secondEmbeddings = db
      .prepare(`SELECT chunk_ordinal, vector_blob, embedding_provider, embedding_model, embedding_version, status FROM node_embeddings WHERE owner_type = 'node' AND owner_id = ? ORDER BY chunk_ordinal ASC`)
      .all(node.id) as Array<Record<string, unknown>>;

    expect(first.processedCount).toBe(1);
    expect(first.readyCount).toBe(1);
    expect(firstState?.embedding_status).toBe("ready");
    expect(firstState?.embedding_provider).toBe("local-ngram");
    expect(firstState?.embedding_model).toBe("chargram-v1");
    expect(firstState?.embedding_version).toBe(LOCAL_NGRAM_EMBEDDING_VERSION);
    expect(firstEmbeddings).toHaveLength(1);
    expect(firstEmbeddings[0]?.embedding_provider).toBe("local-ngram");
    expect(firstEmbeddings[0]?.embedding_model).toBe("chargram-v1");
    expect(firstEmbeddings[0]?.embedding_version).toBe(LOCAL_NGRAM_EMBEDDING_VERSION);
    expect(firstEmbeddings[0]?.status).toBe("ready");
    expect((firstEmbeddings[0]?.vector_blob as Uint8Array).byteLength).toBeGreaterThan(0);
    expect(second.processedCount).toBe(0);
    expect(secondEmbeddings).toHaveLength(1);
  });

  it("embeds local-ngram queries at 384 dimensions with provider version 2", async () => {
    const provider = resolveSemanticEmbeddingProvider({
      provider: "local-ngram",
      model: "chargram-v1"
    });
    const queryEmbedding = await embedSemanticQueryText({
      provider: "local-ngram",
      model: "chargram-v1",
      text: "single term"
    });

    expect(provider?.version).toBe(LOCAL_NGRAM_EMBEDDING_VERSION);
    expect(queryEmbedding?.dimension).toBe(384);
    expect(queryEmbedding?.vector).toHaveLength(384);
  });

  it("normalizes legacy deterministic semantic settings onto the local-ngram surface", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);
    const repository = new RecallXRepository(db, root);
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "deterministic",
      "search.semantic.model": "hash-v1",
      "search.semantic.chunk.enabled": false,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };

    const node = repository.createNode({
      type: "note",
      title: "Legacy semantic target",
      body: "Older workspaces should still land on the local n-gram provider.",
      tags: ["semantic", "legacy"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const status = repository.getSemanticStatus();
    const result = await repository.processPendingSemanticIndex(10);
    const state = db
      .prepare(`SELECT embedding_status, embedding_provider, embedding_model, embedding_version FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;

    expect(status.provider).toBe("local-ngram");
    expect(status.model).toBe("chargram-v1");
    expect(status.indexBackend).toBe("sqlite");
    expect(result.readyCount).toBe(1);
    expect(state?.embedding_status).toBe("ready");
    expect(state?.embedding_provider).toBe("local-ngram");
    expect(state?.embedding_model).toBe("chargram-v1");
    expect(state?.embedding_version).toBe(LOCAL_NGRAM_EMBEDDING_VERSION);
  });

  it("queues semantic reindex when chunk settings change and skips no-op semantic updates", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);
    const repository = new RecallXRepository(db, root);
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "local-ngram",
      "search.semantic.model": "chargram-v1",
      "search.semantic.chunk.enabled": false,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };

    const node = repository.createNode({
      type: "note",
      title: "Reindex target",
      body: "Changing semantic chunking should requeue the node for indexing.",
      tags: ["semantic", "reindex"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    await repository.processPendingSemanticIndex(10);
    repository.setSetting("search.semantic.model", "chargram-v1");
    let state = db
      .prepare(`SELECT embedding_status, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;
    expect(state?.embedding_status).toBe("ready");
    expect(state?.stale_reason).toBeNull();

    repository.setSetting("search.semantic.chunk.enabled", true);
    state = db
      .prepare(`SELECT embedding_status, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;
    const lastBackfillAt = repository.getSettings(["search.semantic.last_backfill_at"])["search.semantic.last_backfill_at"];

    expect(state?.embedding_status).toBe("pending");
    expect(state?.stale_reason).toBe("embedding.configuration_changed");
    expect(typeof lastBackfillAt).toBe("string");
  });

  it("defers provider/model reindex until a staged semantic transition is complete", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);
    const repository = new RecallXRepository(db, root);
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "local-ngram",
      "search.semantic.model": "chargram-v1",
      "search.semantic.chunk.enabled": false,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };

    const node = repository.createNode({
      type: "note",
      title: "Staged transition target",
      body: "Changing provider and model separately should not queue against an intermediate config.",
      tags: ["semantic", "staged"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    await repository.processPendingSemanticIndex(10);
    repository.setSetting("search.semantic.provider", "openai");
    let state = db
      .prepare(`SELECT embedding_status, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;
    const partialRun = await repository.processPendingSemanticIndex(10);

    expect(state?.embedding_status).toBe("ready");
    expect(state?.stale_reason).toBeNull();
    expect(partialRun.processedCount).toBe(0);

    repository.setSetting("search.semantic.model", "text-embedding-3-small");
    state = db
      .prepare(`SELECT embedding_status, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;
    const finalRun = await repository.processPendingSemanticIndex(10);
    state = db
      .prepare(`SELECT embedding_status, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;

    expect(state?.embedding_status).toBe("failed");
    expect(state?.stale_reason).toBe("embedding.provider_not_implemented:openai");
    expect(finalRun.failedCount).toBe(1);
  });

  it("queues semantic reindex through batched setSettings updates", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);
    const repository = new RecallXRepository(db, root);
    repository.ensureBaseSettings({
      "search.semantic.enabled": false,
      "search.semantic.provider": "disabled",
      "search.semantic.model": "none",
      "search.semantic.chunk.enabled": false,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };

    const node = repository.createNode({
      type: "note",
      title: "Batch config target",
      body: "Batched semantic settings should queue a full reindex with the final signature.",
      tags: ["semantic", "batch"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    await repository.processPendingSemanticIndex(10);
    repository.setSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "local-ngram",
      "search.semantic.model": "chargram-v1"
    });
    let state = db
      .prepare(`SELECT embedding_status, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;
    expect(state?.embedding_status).toBe("pending");
    expect(state?.stale_reason).toBe("embedding.configuration_changed");

    await repository.processPendingSemanticIndex(10);
    state = db
      .prepare(`SELECT embedding_status, embedding_version, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;
    expect(state?.embedding_status).toBe("ready");
    expect(state?.embedding_version).toBe(LOCAL_NGRAM_EMBEDDING_VERSION);
    expect(state?.stale_reason).toBeNull();
  });

  it("reindexes legacy-version embeddings during worker processing without a prior ranking call", async () => {
    const { db, repository } = createRepositoryContext();
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "local-ngram",
      "search.semantic.model": "chargram-v1",
      "search.semantic.chunk.enabled": false,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const node = repository.createNode({
      type: "note",
      title: "Legacy vector node",
      body: "Rollback runbook service restart and deploy verification.",
      tags: ["semantic", "legacy"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const queryEmbedding = await embedSemanticQueryText({
      provider: "local-ngram",
      model: "chargram-v1",
      text: "rollback runbook service restart"
    });
    if (!queryEmbedding?.vector.length) {
      throw new Error("Expected local-ngram query vector");
    }

    const now = "2026-03-20T12:00:00.000Z";
    db.prepare(
      `INSERT INTO node_embeddings (
         owner_type, owner_id, chunk_ordinal, vector_ref, vector_blob, embedding_provider, embedding_model, embedding_version,
         content_hash, status, created_at, updated_at
       ) VALUES ('node', ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`
    ).run(node.id, 0, null, encodeVector(queryEmbedding.vector), "local-ngram", "chargram-v1", "1", "hash-legacy", now, now);
    db.prepare(
      `UPDATE node_index_state
       SET content_hash = ?, embedding_status = 'ready', embedding_provider = ?, embedding_model = ?, embedding_version = ?, stale_reason = NULL, updated_at = ?
       WHERE node_id = ?`
    ).run("hash-legacy", "local-ngram", "chargram-v1", "1", now, node.id);

    const reindexResult = await repository.processPendingSemanticIndex(10);
    const state = db
      .prepare(`SELECT embedding_status, embedding_version, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;

    expect(reindexResult.readyCount).toBeGreaterThan(0);
    expect(state?.embedding_status).toBe("ready");
    expect(state?.embedding_version).toBe(LOCAL_NGRAM_EMBEDDING_VERSION);
    expect(state?.stale_reason).toBeNull();
  });

  it("marks legacy-version embeddings stale during ranking and excludes them from matches", async () => {
    const { db, repository } = createRepositoryContext();
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "local-ngram",
      "search.semantic.model": "chargram-v1",
      "search.semantic.chunk.enabled": false,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const node = repository.createNode({
      type: "note",
      title: "Legacy rank target",
      body: "Rollback runbook service restart and deploy verification.",
      tags: ["semantic", "legacy"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const queryEmbedding = await embedSemanticQueryText({
      provider: "local-ngram",
      model: "chargram-v1",
      text: "rollback runbook service restart"
    });
    if (!queryEmbedding?.vector.length) {
      throw new Error("Expected local-ngram query vector");
    }

    const now = "2026-03-20T12:00:00.000Z";
    db.prepare(
      `INSERT INTO node_embeddings (
         owner_type, owner_id, chunk_ordinal, vector_ref, vector_blob, embedding_provider, embedding_model, embedding_version,
         content_hash, status, created_at, updated_at
       ) VALUES ('node', ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`
    ).run(node.id, 0, null, encodeVector(queryEmbedding.vector), "local-ngram", "chargram-v1", "1", "hash-legacy-rank", now, now);
    db.prepare(
      `UPDATE node_index_state
       SET content_hash = ?, embedding_status = 'ready', embedding_provider = ?, embedding_model = ?, embedding_version = ?, stale_reason = NULL, updated_at = ?
       WHERE node_id = ?`
    ).run("hash-legacy-rank", "local-ngram", "chargram-v1", "1", now, node.id);

    const matches = await repository.rankSemanticCandidates("rollback runbook service restart", [node.id]);
    const state = db
      .prepare(`SELECT embedding_status, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;

    expect(matches.has(node.id)).toBe(false);
    expect(state?.embedding_status).toBe("stale");
    expect(state?.stale_reason).toBe("embedding.configuration_changed");
  });

  it("fails semantic processing cleanly when a provider is configured but not implemented", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);
    const repository = new RecallXRepository(db, root);
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "openai",
      "search.semantic.model": "text-embedding-3-small",
      "search.semantic.chunk.enabled": false,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };

    const node = repository.createNode({
      type: "note",
      title: "Provider required",
      body: "This should stop at the worker contract boundary for now.",
      tags: ["semantic"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const result = await repository.processPendingSemanticIndex(10);
    const state = db
      .prepare(`SELECT embedding_status, stale_reason, embedding_provider, embedding_model FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;

    expect(result.processedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.mode).toBe("provider-required");
    expect(state?.embedding_status).toBe("failed");
    expect(state?.stale_reason).toBe("embedding.provider_not_implemented:openai");
    expect(state?.embedding_provider).toBe("openai");
    expect(state?.embedding_model).toBe("text-embedding-3-small");
  });

  it("activates sqlite-vec when available while keeping sqlite as the semantic ledger", async () => {
    const { db, repository } = createRepositoryContext();
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "local-ngram",
      "search.semantic.model": "chargram-v1",
      "search.semantic.indexBackend": "sqlite-vec",
      "search.semantic.chunk.enabled": false,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const node = repository.createNode({
      type: "note",
      title: "sqlite-vec target",
      body: "Semantic vectors should stay in sqlite while sqlite-vec handles bounded similarity math.",
      tags: ["semantic", "sqlite-vec"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const result = await repository.processPendingSemanticIndex(10);
    const state = db
      .prepare(`SELECT embedding_status, embedding_provider, embedding_model FROM node_index_state WHERE node_id = ?`)
      .get(node.id) as Record<string, unknown> | undefined;
    const ledgerRows = db
      .prepare(`SELECT chunk_ordinal, vector_ref, vector_blob, embedding_provider, embedding_model, status FROM node_embeddings WHERE owner_type = 'node' AND owner_id = ?`)
      .all(node.id) as Array<Record<string, unknown>>;
    const status = repository.getSemanticStatus();
    const runtime = getSqliteVecExtensionRuntime(db);

    expect(result.readyCount).toBe(1);
    expect(runtime.isLoaded).toBe(true);
    expect(state?.embedding_status).toBe("ready");
    expect(status.indexBackend).toBe("sqlite-vec");
    expect(status.configuredIndexBackend).toBe("sqlite-vec");
    expect(status.extensionStatus).toBe("loaded");
    expect(status.extensionLoadError).toBeNull();
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.vector_ref ?? null).toBeNull();
    expect(ledgerRows[0]?.vector_blob).toBeInstanceOf(Uint8Array);
  });

  it("falls back to sqlite when sqlite-vec fails to load", async () => {
    const { db, repository } = createRepositoryContext({
      sqliteVecLoader: () => {
        throw new Error("simulated sqlite-vec load failure");
      }
    });
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "local-ngram",
      "search.semantic.model": "chargram-v1",
      "search.semantic.indexBackend": "sqlite-vec",
      "search.semantic.chunk.enabled": false,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const node = repository.createNode({
      type: "note",
      title: "Fallback me",
      body: "If sqlite-vec does not load, semantic indexing should keep working with sqlite fallback.",
      tags: ["semantic", "fallback"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const initialStatus = repository.getSemanticStatus();
    const archiveResult = await repository.processPendingSemanticIndex(10);
    const ledgerRows = db
      .prepare(`SELECT owner_id, vector_ref, vector_blob FROM node_embeddings WHERE owner_type = 'node' AND owner_id = ?`)
      .all(node.id) as Array<Record<string, unknown>>;
    const runtime = getSqliteVecExtensionRuntime(db);

    expect(archiveResult.readyCount).toBe(1);
    expect(runtime.isLoaded).toBe(false);
    expect(initialStatus.indexBackend).toBe("sqlite");
    expect(initialStatus.configuredIndexBackend).toBe("sqlite-vec");
    expect(initialStatus.extensionStatus).toBe("fallback");
    expect(initialStatus.extensionLoadError).toContain("simulated sqlite-vec load failure");
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.vector_ref ?? null).toBeNull();
    expect(ledgerRows[0]?.vector_blob).toBeInstanceOf(Uint8Array);
  });
});

describe("relation usage events", () => {
  it("appends and lists usage events in reverse chronological order", async () => {
    const repository = createRepository();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const first = repository.appendRelationUsageEvent({
      relationId: "irel_demo",
      relationSource: "inferred",
      eventType: "bundle_included",
      sessionId: "session-1",
      runId: "run-1",
      source,
      delta: 0.05,
      metadata: {
        query: "graph retrieval"
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = repository.appendRelationUsageEvent({
      relationId: "irel_demo",
      relationSource: "inferred",
      eventType: "bundle_used_in_output",
      sessionId: "session-1",
      runId: "run-2",
      source,
      delta: 0.2,
      metadata: {
        query: "graph retrieval"
      }
    });

    const listed = repository.listRelationUsageEvents("irel_demo");

    expect(listed).toHaveLength(2);
    expect(listed[0]?.id).toBe(second.id);
    expect(listed[1]?.id).toBe(first.id);
    expect(listed[0]?.eventType).toBe("bundle_used_in_output");
    expect(listed[0]?.actorLabel).toBe("juhwan");
    expect(listed[0]?.toolName).toBe("recallx-test");
  });

  it("appends and lists search feedback events in reverse chronological order", async () => {
    const repository = createRepository();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const first = repository.appendSearchFeedbackEvent({
      resultType: "node",
      resultId: "node_demo",
      verdict: "useful",
      query: "cleanup notes",
      sessionId: "session-1",
      runId: "run-1",
      source,
      confidence: 0.8,
      metadata: {}
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = repository.appendSearchFeedbackEvent({
      resultType: "node",
      resultId: "node_demo",
      verdict: "not_useful",
      query: "cleanup notes",
      sessionId: "session-1",
      runId: "run-2",
      source,
      confidence: 0.4,
      metadata: {}
    });

    const listed = repository.listSearchFeedbackEvents("node", "node_demo");
    const summaries = repository.getSearchFeedbackSummaries("node", ["node_demo"]);

    expect(listed).toHaveLength(2);
    expect(listed[0]?.id).toBe(second.id);
    expect(listed[1]?.id).toBe(first.id);
    expect(listed[0]?.verdict).toBe("not_useful");
    expect(summaries.get("node_demo")).toMatchObject({
      totalDelta: 0.4,
      eventCount: 2,
      usefulCount: 1,
      notUsefulCount: 1,
      uncertainCount: 0
    });
  });

  it("uses search feedback to reorder node search results", async () => {
    const repository = createRepository();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const preferredNode = repository.createNode({
      type: "note",
      title: "Cleanup candidate preferred",
      body: "Shared cleanup query target",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    repository.createNode({
      type: "note",
      title: "Cleanup candidate newer",
      body: "Shared cleanup query target",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const baseline = repository.searchNodes({
      query: "cleanup candidate",
      filters: {},
      limit: 10,
      offset: 0,
      sort: "relevance"
    });
    expect(baseline.items[0]?.id).not.toBe(preferredNode.id);

    repository.appendSearchFeedbackEvent({
      resultType: "node",
      resultId: preferredNode.id,
      verdict: "useful",
      query: "cleanup candidate",
      confidence: 1,
      source,
      metadata: {}
    });

    const reranked = repository.searchNodes({
      query: "cleanup candidate",
      filters: {},
      limit: 10,
      offset: 0,
      sort: "relevance"
    });

    expect(reranked.items[0]?.id).toBe(preferredNode.id);
  });

  it("backfills relation usage rollups from existing raw events on startup", () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);

    db.prepare(
      `INSERT INTO relation_usage_events (
         id, relation_id, relation_source, event_type, session_id, run_id, actor_type, actor_label,
         tool_name, delta, created_at, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "rue_legacy_1",
      "irel_legacy",
      "inferred",
      "bundle_included",
      "session-legacy",
      "run-legacy-1",
      "human",
      "juhwan",
      "recallx-test",
      0.1,
      "2025-01-01T00:00:00.000Z",
      "{}"
    );
    db.prepare(
      `INSERT INTO relation_usage_events (
         id, relation_id, relation_source, event_type, session_id, run_id, actor_type, actor_label,
         tool_name, delta, created_at, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "rue_legacy_2",
      "irel_legacy",
      "inferred",
      "bundle_used_in_output",
      "session-legacy",
      "run-legacy-2",
      "human",
      "juhwan",
      "recallx-test",
      0.2,
      "2025-01-02T00:00:00.000Z",
      "{}"
    );

    const repository = new RecallXRepository(db, root);
    const summary = repository.getRelationUsageSummaries(["irel_legacy"]).get("irel_legacy");
    const rollup = db
      .prepare(`SELECT * FROM relation_usage_rollups WHERE relation_id = ?`)
      .get("irel_legacy") as Record<string, unknown> | undefined;

    expect(summary?.eventCount).toBe(2);
    expect(summary?.totalDelta).toBeCloseTo(0.3, 6);
    expect(summary?.lastEventAt).toBe("2025-01-02T00:00:00.000Z");
    expect(Number(rollup?.event_count ?? 0)).toBe(2);
    expect(Number(rollup?.total_delta ?? 0)).toBeCloseTo(0.3, 6);
  });
});

describe("inferred relation maintenance", () => {
  it("recomputes usage_score and final_score from usage events", () => {
    const repository = createRepository();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const fromNode = repository.createNode({
      type: "project",
      title: "Maintenance target",
      body: "Target project",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const toNode = repository.createNode({
      type: "note",
      title: "Maintenance related",
      body: "Related note",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const relation = repository.upsertInferredRelation({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      relationType: "supports",
      baseScore: 0.5,
      usageScore: 0,
      finalScore: 0.5,
      status: "active",
      generator: "deterministic-linker",
      evidence: {},
      metadata: {}
    });
    repository.appendRelationUsageEvent({
      relationId: relation.id,
      relationSource: "inferred",
      eventType: "retrieval_confirmed",
      delta: 0.2,
      source,
      metadata: {}
    });

    const result = repository.recomputeInferredRelationScores({
      relationIds: [relation.id],
      limit: 10
    });

    expect(result.updatedCount).toBe(1);
    expect(result.items[0]?.usageScore).toBeGreaterThan(0.2);
    expect(result.items[0]?.finalScore).toBeGreaterThan(0.7);
  });

  it("marks expired inferred relations during recompute", () => {
    const repository = createRepository();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const fromNode = repository.createNode({
      type: "project",
      title: "Expiry target",
      body: "Target project",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const toNode = repository.createNode({
      type: "note",
      title: "Expired relation node",
      body: "Expired note",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const relation = repository.upsertInferredRelation({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      relationType: "supports",
      baseScore: 0.5,
      usageScore: 0,
      finalScore: 0.5,
      status: "active",
      generator: "deterministic-linker",
      evidence: {},
      expiresAt: "2000-01-01T00:00:00.000Z",
      metadata: {}
    });

    const result = repository.recomputeInferredRelationScores({
      relationIds: [relation.id],
      limit: 10
    });

    expect(result.expiredCount).toBe(1);
    expect(result.items[0]?.status).toBe("expired");
  });

  it("does not resurrect expired inferred relations during manual full recompute", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const fromNode = repository.createNode({
      type: "project",
      title: "Manual recompute target",
      body: "Target body",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const toNode = repository.createNode({
      type: "note",
      title: "Expired edge node",
      body: "Expired edge body",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const relation = repository.upsertInferredRelation({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      relationType: "supports",
      baseScore: 0.5,
      usageScore: 0,
      finalScore: 0.5,
      status: "expired",
      generator: "deterministic-linker",
      evidence: {},
      metadata: {}
    });

    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/inferred-relations/recompute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      const payload = await response.json();
      const refreshed = repository.getInferredRelation(relation.id);

      expect(response.status).toBe(200);
      expect(payload.data.updatedCount).toBe(0);
      expect(refreshed.status).toBe("expired");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("auto-recomputes after enough usage events and a short debounce", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    repository.upsertBaseSettings({
      "relations.autoRecompute.enabled": true,
      "relations.autoRecompute.eventThreshold": 1,
      "relations.autoRecompute.debounceMs": 20,
      "relations.autoRecompute.maxStalenessMs": 200,
      "relations.autoRecompute.batchLimit": 50,
      "relations.autoRecompute.lastRunAt": null
    });
    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex"
    };
    const fromNode = repository.createNode({
      type: "project",
      title: "Auto recompute target",
      body: "Target project",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const toNode = repository.createNode({
      type: "note",
      title: "Auto recompute related",
      body: "Related note",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const relation = repository.upsertInferredRelation({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      relationType: "supports",
      baseScore: 0.4,
      usageScore: 0,
      finalScore: 0.4,
      status: "active",
      generator: "deterministic-linker",
      evidence: {},
      metadata: {}
    });
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const response = await fetch(`${baseUrl}/relation-usage-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          relationId: relation.id,
          relationSource: "inferred",
          eventType: "bundle_used_in_output",
          delta: 0.2,
          source,
          metadata: {}
        })
      });

      expect(response.status).toBe(201);

      await new Promise((resolve) => setTimeout(resolve, 80));

      const updated = repository.getInferredRelation(relation.id);
      const settings = repository.getSettings(["relations.autoRecompute.lastRunAt"]);

      expect(updated.finalScore).toBeGreaterThan(0.6);
      expect(typeof settings["relations.autoRecompute.lastRunAt"]).toBe("string");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("catches up pending usage events on app start after downtime", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    repository.upsertBaseSettings({
      "relations.autoRecompute.enabled": true,
      "relations.autoRecompute.eventThreshold": 50,
      "relations.autoRecompute.debounceMs": 60_000,
      "relations.autoRecompute.maxStalenessMs": 20,
      "relations.autoRecompute.batchLimit": 50,
      "relations.autoRecompute.lastRunAt": null
    });
    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex"
    };
    const fromNode = repository.createNode({
      type: "project",
      title: "Startup catch-up target",
      body: "Target project",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const toNode = repository.createNode({
      type: "note",
      title: "Startup catch-up related",
      body: "Related note",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const relation = repository.upsertInferredRelation({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      relationType: "supports",
      baseScore: 0.45,
      usageScore: 0,
      finalScore: 0.45,
      status: "active",
      generator: "deterministic-linker",
      evidence: {},
      metadata: {}
    });
    repository.appendRelationUsageEvent({
      relationId: relation.id,
      relationSource: "inferred",
      eventType: "retrieval_confirmed",
      delta: 0.2,
      source,
      metadata: {}
    });

    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      await new Promise((resolve) => setTimeout(resolve, 80));

      const updated = repository.getInferredRelation(relation.id);
      const settings = repository.getSettings(["relations.autoRecompute.lastRunAt"]);

      expect(updated.finalScore).toBeGreaterThan(0.65);
      expect(typeof settings["relations.autoRecompute.lastRunAt"]).toBe("string");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("recomputes all pending relation ids even when they exceed the batch cap", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    repository.setSetting("relations.autoRecompute.batchLimit", 2);
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const nodes = Array.from({ length: 4 }, (_, index) =>
      repository.createNode({
        type: "note",
        title: `Pending relation node ${index + 1}`,
        body: "Pending relation node body",
        tags: [],
        source,
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active"
      })
    );
    const relations = [
      repository.upsertInferredRelation({
        fromNodeId: nodes[0]!.id,
        toNodeId: nodes[1]!.id,
        relationType: "supports",
        baseScore: 0.4,
        usageScore: 0,
        finalScore: 0.4,
        status: "active",
        generator: "deterministic-linker",
        evidence: {},
        metadata: {}
      }),
      repository.upsertInferredRelation({
        fromNodeId: nodes[0]!.id,
        toNodeId: nodes[2]!.id,
        relationType: "supports",
        baseScore: 0.45,
        usageScore: 0,
        finalScore: 0.45,
        status: "active",
        generator: "deterministic-linker",
        evidence: {},
        metadata: {}
      }),
      repository.upsertInferredRelation({
        fromNodeId: nodes[0]!.id,
        toNodeId: nodes[3]!.id,
        relationType: "supports",
        baseScore: 0.5,
        usageScore: 0,
        finalScore: 0.5,
        status: "active",
        generator: "deterministic-linker",
        evidence: {},
        metadata: {}
      })
    ];

    for (const relation of relations) {
      repository.appendRelationUsageEvent({
        relationId: relation.id,
        relationSource: "inferred",
        eventType: "bundle_used_in_output",
        delta: 0.12,
        source,
        metadata: {}
      });
    }

    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/inferred-relations/recompute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      const body = await response.json();
      const recomputed = relations.map((relation) => repository.getInferredRelation(relation.id));

      expect(response.status).toBe(200);
      expect(body.data.updatedCount).toBe(3);
      expect(recomputed.every((relation) => relation.usageScore > 0)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("expires stale inferred relations through the manual full recompute endpoint even without new usage events", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const fromNode = repository.createNode({
      type: "note",
      title: "Expiry source",
      body: "Expiry source body",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const toNode = repository.createNode({
      type: "note",
      title: "Expiry target",
      body: "Expiry target body",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const relation = repository.upsertInferredRelation({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      relationType: "relevant_to",
      baseScore: 0.55,
      usageScore: 0,
      finalScore: 0.55,
      status: "active",
      generator: "deterministic-linker",
      evidence: {},
      expiresAt: "2000-01-01T00:00:00.000Z",
      metadata: {}
    });

    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/inferred-relations/recompute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      const recomputed = repository.getInferredRelation(relation.id);

      expect(response.status).toBe(200);
      expect(recomputed.status).toBe("expired");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("automatic inferred relation generation", () => {
  it("creates deterministic inferred links from shared tags and body references on node writes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "human" as const,
        actorLabel: "juhwan",
        toolName: "recallx-test",
      };

      const projectResponse = await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "project",
          title: "Graph Roadmap",
          body: "Primary implementation plan",
          tags: ["graph", "roadmap"],
          metadata: {},
          source,
        }),
      });
      const projectBody = await projectResponse.json();
      const projectId = projectBody.data.node.id as string;

      const noteResponse = await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Graph Memo",
          body: "See Graph Roadmap before changing the graph renderer.",
          tags: ["graph"],
          metadata: {},
          source,
        }),
      });
      const noteBody = await noteResponse.json();
      const noteId = noteBody.data.node.id as string;

      const repository = workspaceSessionManager.getCurrent().repository;
      const inferred = await waitFor(() => {
        const items = repository.listInferredRelationsForNode(noteId, 10);
        return items.some((item) => item.generator === "deterministic-tag-overlap") &&
          items.some((item) => item.generator === "deterministic-body-reference")
          ? items
          : null;
      });
      const neighborhoodResponse = await fetch(`${baseUrl}/nodes/${noteId}/neighborhood?include_inferred=1&max_inferred=4`);
      const neighborhoodBody = await neighborhoodResponse.json();

      expect(projectResponse.status).toBe(201);
      expect(noteResponse.status).toBe(201);
      expect(inferred.some((item) => item.generator === "deterministic-tag-overlap")).toBe(true);
      expect(inferred.some((item) => item.generator === "deterministic-body-reference")).toBe(true);
      expect(neighborhoodResponse.status).toBe(200);
      expect(neighborhoodBody.data.items.some((item: any) => item.node.id === projectId && item.edge.relationSource === "inferred")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("creates deterministic inferred links from shared project membership when active relations are added", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "human" as const,
        actorLabel: "juhwan",
        toolName: "recallx-test",
      };

      const projectBody = await (await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "project",
          title: "Workspace Rollout",
          body: "Project hub",
          tags: [],
          metadata: {},
          source,
        }),
      })).json();
      const noteABody = await (await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Rollout Checklist",
          body: "Track the rollout steps",
          tags: [],
          metadata: {},
          source,
        }),
      })).json();
      const noteBBody = await (await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Rollout Risks",
          body: "Track rollout risks",
          tags: [],
          metadata: {},
          source,
        }),
      })).json();

      const projectId = projectBody.data.node.id as string;
      const noteAId = noteABody.data.node.id as string;
      const noteBId = noteBBody.data.node.id as string;

      await fetch(`${baseUrl}/relations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromNodeId: noteAId,
          toNodeId: projectId,
          relationType: "relevant_to",
          source,
          metadata: {},
        }),
      });
      const relationResponse = await fetch(`${baseUrl}/relations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromNodeId: noteBId,
          toNodeId: projectId,
          relationType: "relevant_to",
          source,
          metadata: {},
        }),
      });
      const repository = workspaceSessionManager.getCurrent().repository;
      const inferred = await waitFor(() => {
        const items = repository.listInferredRelationsForNode(noteBId, 20);
        return items.some((item) => item.generator === "deterministic-project-membership") &&
          items.some(
            (item) =>
              item.generator === "deterministic-project-membership" &&
              [item.fromNodeId, item.toNodeId].includes(noteAId)
          )
          ? items
          : null;
      });

      expect(relationResponse.status).toBe(201);
      expect(inferred.some((item) => item.generator === "deterministic-project-membership")).toBe(true);
      expect(
        inferred.some(
          (item) =>
            item.generator === "deterministic-project-membership" &&
            [item.fromNodeId, item.toNodeId].includes(noteAId)
        )
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("creates deterministic inferred links from shared attached artifacts", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test",
      };

      const noteABody = await (await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Artifact Anchor A",
          body: "Reference the same export artifact",
          tags: [],
          metadata: {},
          source,
        }),
      })).json();
      const noteBBody = await (await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Artifact Anchor B",
          body: "Also references the export artifact",
          tags: [],
          metadata: {},
          source,
        }),
      })).json();

      const noteAId = noteABody.data.node.id as string;
      const noteBId = noteBBody.data.node.id as string;
      const sharedPath = path.join(root, "artifacts", "shared-report.md");
      writeFileSync(sharedPath, "# Shared artifact\n");

      await fetch(`${baseUrl}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: noteAId,
          path: sharedPath,
          source,
          metadata: {},
        }),
      });
      const artifactResponse = await fetch(`${baseUrl}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: noteBId,
          path: sharedPath,
          source,
          metadata: {},
        }),
      });
      const repository = workspaceSessionManager.getCurrent().repository;
      const inferred = await waitFor(() => {
        const items = repository.listInferredRelationsForNode(noteBId, 20);
        return items.some((item) => item.generator === "deterministic-shared-artifact") &&
          items.some(
            (item) =>
              item.generator === "deterministic-shared-artifact" &&
              [item.fromNodeId, item.toNodeId].includes(noteAId)
          )
          ? items
          : null;
      });

      expect(artifactResponse.status).toBe(201);
      expect(inferred.some((item) => item.generator === "deterministic-shared-artifact")).toBe(true);
      expect(
        inferred.some(
          (item) =>
            item.generator === "deterministic-shared-artifact" &&
            [item.fromNodeId, item.toNodeId].includes(noteAId)
        )
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("refreshes inferred links from activity body references", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source: {
        actorType: "human";
        actorLabel: string;
        toolName: string;
      } = {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test",
      };

      const repository = workspaceSessionManager.getCurrent().repository;
      const targetNode = repository.createNode({
        type: "note",
        title: "Runtime Notes",
        body: "Operational notes",
        tags: [],
        metadata: {},
        source,
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const relatedNode = repository.createNode({
        type: "note",
        title: "Deployment Checklist",
        body: "Restart steps",
        tags: [],
        metadata: {},
        source,
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });

      await fetch(`${baseUrl}/activities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetNodeId: targetNode.id,
          activityType: "agent_run_summary",
          body: "Follow Deployment Checklist after the restart.",
          metadata: {},
          source,
        }),
      });

      const inferred = await waitFor(() => {
        const items = repository.listInferredRelationsForNode(targetNode.id, 10);
        return items.some((item) => item.generator === "deterministic-activity-reference") &&
          items.some((item) => item.fromNodeId === relatedNode.id || item.toNodeId === relatedNode.id)
          ? items
          : null;
      }, { timeoutMs: 5_000 });

      expect(inferred.some((item) => item.generator === "deterministic-activity-reference")).toBe(true);
      expect(inferred.some((item) => item.fromNodeId === relatedNode.id || item.toNodeId === relatedNode.id)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 15_000);

  it("expires stale auto-generated links when deterministic signals disappear", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test",
      };

      await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Shared Graph Note",
          body: "Graph planning",
          tags: ["graph"],
          metadata: {},
          source,
        }),
      });
      const relatedResponse = await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Graph Followup",
          body: "Graph planning details",
          tags: ["graph"],
          metadata: {},
          source,
        }),
      });
      const relatedNode = (await relatedResponse.json()).data.node as { id: string };

      const repository = workspaceSessionManager.getCurrent().repository;
      const activeBefore = await waitFor(() => {
        const items = repository.listInferredRelationsForNode(relatedNode.id, 10);
        return items.some((item) => item.generator === "deterministic-tag-overlap") ? items : null;
      });
      const autoRelation = activeBefore.find((item) => item.generator === "deterministic-tag-overlap");
      if (!autoRelation) {
        throw new Error("Expected tag-overlap inferred relation to exist before cleanup.");
      }

      const updateResponse = await fetch(`${baseUrl}/nodes/${relatedNode.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "No overlap remains",
          tags: [],
          source,
        }),
      });

      const refreshed = await waitFor(() => {
        const relation = repository.getInferredRelation(autoRelation.id);
        return relation.status === "expired" ? relation : null;
      });

      expect(updateResponse.status).toBe(200);
      expect(refreshed.status).toBe("expired");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("backfills deterministic inferred links across existing workspace nodes through reindex", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test",
    };
    const first = repository.createNode({
      type: "note",
      title: "Backfill Graph Note",
      body: "Graph planning details",
      tags: ["graph", "planning"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const second = repository.createNode({
      type: "project",
      title: "Backfill Graph Project",
      body: "Graph planning execution",
      tags: ["graph"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const response = await fetch(`${baseUrl}/inferred-relations/reindex`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 50 }),
      });
      const body = await response.json();
      const inferred = repository.listInferredRelationsForNode(first.id, 10);

      expect(response.status).toBe(200);
      expect(body.data.processedNodes).toBeGreaterThanOrEqual(2);
      expect(body.data.upsertedCount).toBeGreaterThan(0);
      expect(inferred.some((item) => item.fromNodeId === second.id || item.toNodeId === second.id)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("inferred relation API integration", () => {
  it("surfaces inferred neighborhood items and includes them in context bundles", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const repository = workspaceSessionManager.getCurrent().repository;
      const source = {
        actorType: "agent" as const,
        actorLabel: "Codex",
        toolName: "codex",
      };
      const targetNode = repository.createNode({
        type: "project",
        title: "Context target",
        body: "Bundle target",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const relatedNode = repository.createNode({
        type: "note",
        title: "Inferred support note",
        body: "Suggested by the deterministic pass",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });

      await fetch(`${baseUrl}/inferred-relations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromNodeId: targetNode.id,
          toNodeId: relatedNode.id,
          relationType: "supports",
          baseScore: 0.64,
          usageScore: 0.12,
          finalScore: 0.76,
          status: "active",
          generator: "deterministic-linker",
          evidence: {
            sharedTerms: ["bundle", "context"],
          },
          metadata: {},
        }),
      });

      const neighborhoodResponse = await fetch(
        `${baseUrl}/nodes/${targetNode.id}/neighborhood?include_inferred=1&max_inferred=4`
      );
      const neighborhoodBody = await neighborhoodResponse.json();
      const relatedAliasResponse = await fetch(
        `${baseUrl}/nodes/${targetNode.id}/related?include_inferred=1&max_inferred=4`
      );
      const relatedAliasBody = await relatedAliasResponse.json();

      const bundleResponse = await fetch(`${baseUrl}/context/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: {
            id: targetNode.id,
          },
          mode: "compact",
          preset: "for-assistant",
          options: {
            includeRelated: true,
            includeInferred: true,
            includeRecentActivities: false,
            includeDecisions: false,
            includeOpenQuestions: false,
            maxInferred: 4,
            maxItems: 10,
          },
        }),
      });
      const bundleBody = await bundleResponse.json();

      expect(neighborhoodResponse.status).toBe(200);
      expect(relatedAliasResponse.status).toBe(200);
      expect(relatedAliasBody.data.items).toEqual(neighborhoodBody.data.items);
      expect(neighborhoodBody.data.items).toHaveLength(1);
      expect(neighborhoodBody.data.items[0]?.edge.relationSource).toBe("inferred");
      expect(neighborhoodBody.data.items[0]?.edge.relationScore).toBe(0.76);
      expect(neighborhoodBody.data.items[0]?.edge.retrievalRank).toBeGreaterThan(0.76);
      expect(bundleResponse.status).toBe(200);
      expect(bundleBody.data.bundle.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: relatedNode.id,
            relationSource: "inferred",
            relationType: "supports",
            relationScore: 0.76,
            retrievalRank: expect.any(Number),
          }),
        ])
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("includes contested decisions and open questions in target-related retrieval and context bundles", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    const targetNode = repository.createNode({
      type: "project",
      title: "Governance target",
      body: "Target body",
      source,
      tags: [],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const contestedDecision = repository.createNode({
      type: "decision",
      title: "Contested decision",
      body: "Decision under dispute",
      source,
      tags: [],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "contested",
    });
    const contestedQuestion = repository.createNode({
      type: "question",
      title: "Contested question",
      body: "Open question under dispute",
      source,
      tags: [],
      metadata: {},
      resolvedCanonicality: "appended",
      resolvedStatus: "contested",
    });
    repository.createRelation({
      fromNodeId: targetNode.id,
      toNodeId: contestedDecision.id,
      relationType: "supports",
      metadata: {},
      source,
      resolvedStatus: "active",
    });
    repository.createRelation({
      fromNodeId: targetNode.id,
      toNodeId: contestedQuestion.id,
      relationType: "elaborates",
      metadata: {},
      source,
      resolvedStatus: "active",
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const [decisionsResponse, questionsResponse, bundleResponse] = await Promise.all([
        fetch(`${baseUrl}/retrieval/decisions/${targetNode.id}`),
        fetch(`${baseUrl}/retrieval/open-questions/${targetNode.id}`),
        fetch(`${baseUrl}/context/bundles`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            target: { id: targetNode.id },
            mode: "compact",
            preset: "for-assistant",
            options: {
              includeRelated: false,
              includeInferred: false,
              includeRecentActivities: false,
              includeDecisions: true,
              includeOpenQuestions: true,
              maxInferred: 0,
              maxItems: 8
            }
          }),
        }),
      ]);
      const decisionsBody = await decisionsResponse.json();
      const questionsBody = await questionsResponse.json();
      const bundleBody = await bundleResponse.json();

      expect(decisionsResponse.status).toBe(200);
      expect(questionsResponse.status).toBe(200);
      expect(bundleResponse.status).toBe(200);
      expect(decisionsBody.data.items.some((item: { id: string }) => item.id === contestedDecision.id)).toBe(true);
      expect(questionsBody.data.items.some((item: { id: string }) => item.id === contestedQuestion.id)).toBe(true);
      expect(bundleBody.data.bundle.decisions.some((item: { id: string }) => item.id === contestedDecision.id)).toBe(true);
      expect(bundleBody.data.bundle.openQuestions.some((item: { id: string }) => item.id === contestedQuestion.id)).toBe(
        true
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("builds a workspace-entry context bundle when no target is provided", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    const project = repository.createNode({
      type: "project",
      title: "Workspace project",
      body: "Recent project context",
      source,
      tags: [],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    repository.appendActivity({
      targetNodeId: project.id,
      activityType: "agent_run_summary",
      body: "Recent workspace activity",
      source,
      metadata: {},
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const bundleResponse = await fetch(`${baseUrl}/context/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "compact",
          preset: "for-assistant",
          options: {
            includeRelated: true,
            includeInferred: true,
            includeRecentActivities: true,
            includeDecisions: true,
            includeOpenQuestions: true,
            maxInferred: 4,
            maxItems: 6
          }
        }),
      });
      const bundleBody = await bundleResponse.json();

      expect(bundleResponse.status).toBe(200);
      expect(bundleBody.data.bundle.target).toEqual({
        type: "workspace",
        id: "workspace",
        title: "Workspace context"
      });
      expect(bundleBody.data.bundle.items.some((item: { nodeId: string }) => item.nodeId === project.id)).toBe(true);
      expect(bundleBody.data.bundle.activityDigest[0]).toContain("Recent workspace activity");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("adds local-ngram semantic bonuses to context bundles when lexical overlap is weak", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "agent" as const,
        actorLabel: "Codex",
        toolName: "codex",
      };
      const targetNode = repository.createNode({
        type: "project",
        title: "Service recovery workspace",
        body: "Operations guide for outage stabilization and deploy verification.",
        source,
        tags: ["ops"],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const semanticRelated = repository.createNode({
        type: "note",
        title: "Recovery sequencing",
        body: "Restart rollback runbook for outage recovery and deploy verification.",
        source,
        tags: ["ops", "runbook"],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      repository.upsertInferredRelation({
        fromNodeId: targetNode.id,
        toNodeId: semanticRelated.id,
        relationType: "supports",
        baseScore: 0.36,
        usageScore: 0,
        finalScore: 0.36,
        status: "active",
        generator: "deterministic-linker",
        evidence: {},
        metadata: {},
      });
      await repository.processPendingSemanticIndex(20);

      const bundleResponse = await fetch(`${baseUrl}/context/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: {
            id: targetNode.id,
          },
          mode: "compact",
          preset: "for-assistant",
          options: {
            includeRelated: true,
            includeInferred: true,
            includeRecentActivities: false,
            includeDecisions: false,
            includeOpenQuestions: false,
            maxInferred: 4,
            maxItems: 5,
          },
        }),
      });
      const bundleBody = await bundleResponse.json();

      const semanticItem = bundleBody.data.bundle.items.find((item: { nodeId: string }) => item.nodeId === semanticRelated.id);

      expect(bundleResponse.status).toBe(200);
      expect(semanticItem).toBeTruthy();
      expect(semanticItem?.semanticSimilarity).toBeGreaterThan(0.2);
      expect(semanticItem?.reason).toContain("Semantic similarity");
      expect(bundleBody.data.bundle.items.filter((item: { nodeId: string }) => item.nodeId === semanticRelated.id)).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("accepts relation usage events through the HTTP API", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const response = await fetch(`${baseUrl}/relation-usage-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          relationId: "irel_demo",
          relationSource: "inferred",
          eventType: "bundle_used_in_output",
          delta: 0.2,
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex",
          },
          metadata: {
            query: "context bundle",
          },
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.data.event.relationId).toBe("irel_demo");
      expect(payload.data.event.eventType).toBe("bundle_used_in_output");
      expect(payload.data.event.delta).toBe(0.2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("accepts search feedback events through the HTTP API", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const response = await fetch(`${baseUrl}/search-feedback-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resultType: "node",
          resultId: "node_demo",
          verdict: "useful",
          query: "cleanup notes",
          confidence: 0.8,
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex",
          },
          metadata: {
            phase: "ranking",
            lexicalQuality: "none",
            matchStrategy: "semantic",
            rank: 1,
            semanticLifted: true,
            semanticFallbackMode: "strict_zero"
          },
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.data.event.resultType).toBe("node");
      expect(payload.data.event.resultId).toBe("node_demo");
      expect(payload.data.event.verdict).toBe("useful");
      expect(payload.data.event.delta).toBe(0.8);

      const summaryResponse = await fetch(`${baseUrl}/observability/summary?since=24h`);
      const summaryPayload = await summaryResponse.json();
      expect(summaryPayload.data.searchFeedbackRate).toMatchObject({
        usefulCount: 1,
        sampleCount: 1,
        usefulRatio: 1,
        top1UsefulCount: 1,
        top1SampleCount: 1,
        top3UsefulCount: 1,
        top3SampleCount: 1,
        semanticUsefulCount: 1,
        semanticSampleCount: 1,
        semanticLiftUsefulCount: 1,
        semanticLiftSampleCount: 1
      });
      expect(summaryPayload.data.searchFeedbackRate.byFallbackMode).toEqual([
        {
          fallbackMode: "strict_zero",
          usefulCount: 1,
          notUsefulCount: 0,
          uncertainCount: 0,
          sampleCount: 1,
          usefulRatio: 1
        }
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("searches activities through the HTTP API", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const repository = workspaceSessionManager.getCurrent().repository;
    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    const node = repository.createNode({
      type: "project",
      title: "Cleanup Project",
      body: "Project for activity search",
      source,
      tags: [],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    repository.appendActivity({
      targetNodeId: node.id,
      activityType: "agent_run_summary",
      body: "Completed cleanup optimization pass.",
      source,
      metadata: {},
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const response = await fetch(`${baseUrl}/activities/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "cleanup optimization",
          filters: {
            activityTypes: ["agent_run_summary"],
          },
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.total).toBe(1);
      expect(payload.data.items[0].targetNodeId).toBe(node.id);
      expect(payload.data.items[0].activityType).toBe("agent_run_summary");
      expect(payload.data.items[0].matchReason.strategy).toBe("fts");
      expect(payload.data.items[0].matchReason.matchedFields).toContain("body");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("searches nodes and activities through the unified workspace endpoint", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const repository = workspaceSessionManager.getCurrent().repository;
    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    const node = repository.createNode({
      type: "note",
      title: "Cleanup plan",
      body: "Durable cleanup guidance",
      source,
      tags: ["cleanup"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    repository.appendActivity({
      targetNodeId: node.id,
      activityType: "agent_run_summary",
      body: "Cleanup execution summary",
      source,
      metadata: {},
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "cleanup",
          scopes: ["nodes", "activities"],
          limit: 5,
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.total).toBeGreaterThanOrEqual(2);
      expect(payload.data.items.some((item: { resultType: string }) => item.resultType === "node")).toBe(true);
      expect(payload.data.items.some((item: { resultType: string }) => item.resultType === "activity")).toBe(true);
      expect(payload.data.items.find((item: { resultType: string }) => item.resultType === "node")?.node?.matchReason?.matchedFields).toContain(
        "title"
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("keeps HTTP blank-query browse behavior and marks browse match reasons", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const repository = workspaceSessionManager.getCurrent().repository;
    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    repository.createNode({
      type: "note",
      title: "Recent browse candidate",
      body: "Visible through browse mode.",
      source,
      tags: ["browse"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const response = await fetch(`${baseUrl}/nodes/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "",
          filters: {},
          limit: 5,
          offset: 0,
          sort: "updated_at",
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.items[0].matchReason).toEqual({
        strategy: "browse",
        matchedFields: []
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("falls back to tokenized workspace search and labels fallback match reasons", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const repository = workspaceSessionManager.getCurrent().repository;
    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    const node = repository.createNode({
      type: "note",
      title: "Cleanup guide",
      body: "Durable note about migrations.",
      source,
      tags: ["cleanup"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    repository.appendActivity({
      targetNodeId: node.id,
      activityType: "agent_run_summary",
      body: "Governance migration completed successfully.",
      source,
      metadata: {},
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "cleanup governance migration",
          scopes: ["nodes", "activities"],
          limit: 10,
          offset: 0,
          sort: "smart",
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.items.some((item: { resultType: string; node?: { matchReason?: { strategy: string } } }) =>
        item.resultType === "node" && item.node?.matchReason?.strategy === "fallback_token"
      )).toBe(true);
      expect(payload.data.items.some((item: { resultType: string; activity?: { matchReason?: { strategy: string } } }) =>
        item.resultType === "activity" && item.activity?.matchReason?.strategy === "fallback_token"
      )).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("uses semantic fallback for workspace search when deterministic results are empty", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const { repository, db } = workspaceSessionManager.getCurrent();
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    repository.setSetting("search.semantic.indexBackend", "sqlite-vec");
    repository.setSetting("search.semantic.workspaceFallback.enabled", true);
    repository.setSetting("search.semantic.workspaceFallback.mode", "strict_zero");
    repository.setSetting("observability.enabled", true);
    repository.setSetting("observability.slowRequestMs", 1);

    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    const relatedNode = repository.createNode({
      type: "note",
      title: "Alpha operations memo",
      body: "Durable operations note with no direct overlap.",
      source,
      tags: ["ops"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const distractorNode = repository.createNode({
      type: "note",
      title: "Visual polish scratchpad",
      body: "Design notes with different meaning.",
      source,
      tags: ["design"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const semanticQuery = "service rollback recovery restart sequencing";
    await seedSemanticEmbeddings({
      db,
      repository,
      query: semanticQuery,
      relatedNodeId: relatedNode.id,
      distractorNodeId: distractorNode.id
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-recallx-mcp-tool": "recallx_search_workspace"
        },
        body: JSON.stringify({
          query: semanticQuery,
          scopes: ["nodes", "activities"],
          limit: 10,
          offset: 0,
          sort: "smart",
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.items).toHaveLength(1);
      expect(payload.data.items[0]?.resultType).toBe("node");
      expect(payload.data.items[0]?.node?.id).toBe(relatedNode.id);
      expect(payload.data.items[0]?.node?.matchReason).toMatchObject({
        strategy: "semantic",
        matchedFields: ["semantic"]
      });

      const summaryPayload = await waitFor(async () => {
        const summaryResponse = await fetch(`${baseUrl}/observability/summary?since=24h`);
        const summary = await summaryResponse.json();
        const childSpan = summary.data?.operationSummaries?.find((item: { operation: string }) => item.operation === "workspace.search.semantic_fallback");
        return childSpan ? summary : null;
      });

      expect(summaryPayload.data.semanticFallbackRate).toEqual({
        eligibleCount: 1,
        attemptedCount: 1,
        hitCount: 1,
        attemptRatio: 1,
        hitRatio: 1,
        modes: [
          {
            fallbackMode: "strict_zero",
            eligibleCount: 1,
            attemptedCount: 1,
            hitCount: 1,
            sampleCount: 1,
            attemptRatio: 1,
            hitRatio: 1
          }
        ]
      });
      expect(summaryPayload.data.workspaceFallbackModeRate).toEqual({
        strictZeroCount: 1,
        noStrongNodeHitCount: 0,
        sampleCount: 1,
        operations: [
          {
            surface: "api",
            operation: "workspace.search",
            strictZeroCount: 1,
            noStrongNodeHitCount: 0,
            sampleCount: 1
          }
        ]
      });
      expect(summaryPayload.data.operationSummaries.some((item: { operation: string }) => item.operation === "workspace.search.semantic_fallback")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("uses semantic fallback for nodes even when activity results already exist", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const { repository, db } = workspaceSessionManager.getCurrent();
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    repository.setSetting("search.semantic.indexBackend", "sqlite-vec");
    repository.setSetting("search.semantic.workspaceFallback.enabled", true);
    repository.setSetting("search.semantic.workspaceFallback.mode", "no_strong_node_hit");

    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    const relatedNode = repository.createNode({
      type: "note",
      title: "Alpha operations memo",
      body: "Durable operations note with no direct overlap.",
      source,
      tags: ["ops"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    repository.appendActivity({
      targetNodeId: relatedNode.id,
      activityType: "agent_run_summary",
      body: "Service rollback recovery restart sequencing checklist validated with operators.",
      source,
      metadata: {},
    });
    const distractorNode = repository.createNode({
      type: "note",
      title: "Visual polish scratchpad",
      body: "Design notes with different meaning.",
      source,
      tags: ["design"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const semanticQuery = "service rollback recovery restart sequencing";
    await seedSemanticEmbeddings({
      db,
      repository,
      query: semanticQuery,
      relatedNodeId: relatedNode.id,
      distractorNodeId: distractorNode.id
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: semanticQuery,
          scopes: ["nodes", "activities"],
          limit: 10,
          offset: 0,
          sort: "smart",
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.items.some((item: { resultType: string; node?: { id: string; matchReason?: { strategy: string } } }) =>
        item.resultType === "node" &&
        item.node?.id === relatedNode.id &&
        item.node?.matchReason?.strategy === "semantic"
      )).toBe(true);
      expect(payload.data.items.some((item: { resultType: string; activity?: { targetNodeId: string; matchReason?: { strategy: string } } }) =>
        item.resultType === "activity" &&
        item.activity?.targetNodeId === relatedNode.id &&
        item.activity?.matchReason?.strategy === "fts"
      )).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("keeps strict_zero mode from retrying when weak lexical node hits already exist", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const { repository, db } = workspaceSessionManager.getCurrent();
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    repository.setSetting("search.semantic.indexBackend", "sqlite-vec");
    repository.setSetting("search.semantic.workspaceFallback.enabled", true);
    repository.setSetting("search.semantic.workspaceFallback.mode", "strict_zero");

    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    const semanticNode = repository.createNode({
      type: "note",
      title: "Alpha operations memo",
      body: "Durable operations note with no direct overlap.",
      source,
      tags: ["ops"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const weakLexicalNode = repository.createNode({
      type: "note",
      title: "Scratchpad",
      body: "Rollback scratch notes and partial recovery reminders.",
      source,
      tags: [],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const distractorNode = repository.createNode({
      type: "note",
      title: "Visual polish scratchpad",
      body: "Design notes with different meaning.",
      source,
      tags: ["design"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const semanticQuery = "service rollback recovery restart sequencing";
    await seedSemanticEmbeddings({
      db,
      repository,
      query: semanticQuery,
      relatedNodeId: semanticNode.id,
      distractorNodeId: distractorNode.id
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: semanticQuery,
          scopes: ["nodes"],
          limit: 10,
          offset: 0,
          sort: "smart",
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.items.some((item: { resultType: string; node?: { id: string } }) =>
        item.resultType === "node" &&
        item.node?.id === weakLexicalNode.id
      )).toBe(true);
      expect(payload.data.items.some((item: { resultType: string; node?: { id: string; matchReason?: { strategy: string } } }) =>
        item.resultType === "node" &&
        item.node?.id === semanticNode.id &&
        item.node?.matchReason?.strategy === "semantic"
      )).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("keeps weak lexical node hits while adding semantic node results", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const { repository, db } = workspaceSessionManager.getCurrent();
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    repository.setSetting("search.semantic.indexBackend", "sqlite-vec");
    repository.setSetting("search.semantic.workspaceFallback.enabled", true);
    repository.setSetting("search.semantic.workspaceFallback.mode", "no_strong_node_hit");
    repository.setSetting("observability.enabled", true);

    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    const weakLexicalNode = repository.createNode({
      type: "note",
      title: "Runbook appendix",
      body: "Rollback appendix with partial recovery notes captured in body text only.",
      source,
      tags: [],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const semanticNode = repository.createNode({
      type: "note",
      title: "Alpha operations memo",
      body: "Durable operations note with no direct overlap.",
      source,
      tags: ["ops"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const distractorNode = repository.createNode({
      type: "note",
      title: "Design archive",
      body: "Unrelated design content.",
      source,
      tags: ["design"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const semanticQuery = "service rollback recovery restart sequencing";
    await seedSemanticEmbeddings({
      db,
      repository,
      query: semanticQuery,
      relatedNodeId: semanticNode.id,
      distractorNodeId: distractorNode.id
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: semanticQuery,
          scopes: ["nodes"],
          limit: 10,
          offset: 0,
          sort: "smart",
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.items.some((item: { resultType: string; node?: { id: string; matchReason?: { strategy: string } } }) =>
        item.resultType === "node" &&
        item.node?.id === semanticNode.id &&
        item.node?.matchReason?.strategy === "semantic"
      )).toBe(true);
      expect(payload.data.items.some((item: { resultType: string; node?: { id: string; lexicalQuality?: string } }) =>
        item.resultType === "node" &&
        item.node?.id === weakLexicalNode.id &&
        item.node?.lexicalQuality === "weak"
      )).toBe(true);

      const summaryPayload = await waitFor(async () => {
        const summaryResponse = await fetch(`${baseUrl}/observability/summary?since=24h`);
        const summary = await summaryResponse.json();
        return summary.data?.workspaceResultCompositionRate ? summary : null;
      });
      expect(summaryPayload.data.workspaceResultCompositionRate).toMatchObject({
        nodeOnlyCount: 0,
        semanticNodeOnlyCount: 1,
        semanticMixedCount: 0
      });
      expect(summaryPayload.data.workspaceFallbackModeRate).toEqual({
        strictZeroCount: 0,
        noStrongNodeHitCount: 1,
        sampleCount: 1,
        operations: [
          {
            surface: "api",
            operation: "workspace.search",
            strictZeroCount: 0,
            noStrongNodeHitCount: 1,
            sampleCount: 1
          }
        ]
      });
      expect(summaryPayload.data.semanticFallbackRate.hitCount).toBe(1);
      expect(summaryPayload.data.semanticFallbackRate.modes).toEqual([
        {
          fallbackMode: "no_strong_node_hit",
          eligibleCount: 1,
          attemptedCount: 1,
          hitCount: 1,
          sampleCount: 1,
          attemptRatio: 1,
          hitRatio: 1
        }
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("uses sqlite semantic fallback when sqlite-vec is not the active backend", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const { repository, db } = workspaceSessionManager.getCurrent();
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    repository.setSetting("search.semantic.indexBackend", "sqlite");
    repository.setSetting("search.semantic.workspaceFallback.enabled", true);
    repository.setSetting("search.semantic.workspaceFallback.mode", "strict_zero");

    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    const relatedNode = repository.createNode({
      type: "note",
      title: "Ops archive",
      body: "No lexical overlap here either.",
      source,
      tags: ["ops"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const distractorNode = repository.createNode({
      type: "note",
      title: "Design archive",
      body: "Unrelated design content.",
      source,
      tags: ["design"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const semanticQuery = "service rollback recovery restart sequencing";
    await seedSemanticEmbeddings({
      db,
      repository,
      query: semanticQuery,
      relatedNodeId: relatedNode.id,
      distractorNodeId: distractorNode.id
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: semanticQuery,
          scopes: ["nodes"],
          limit: 10,
          offset: 0,
          sort: "smart",
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.items).toHaveLength(1);
      expect(payload.data.items[0]?.node?.id).toBe(relatedNode.id);
      expect(payload.data.items[0]?.node?.matchReason?.strategy).toBe("semantic");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("skips workspace semantic fallback when deterministic results already exist", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const repository = workspaceSessionManager.getCurrent().repository;
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    repository.setSetting("search.semantic.workspaceFallback.enabled", true);
    repository.setSetting("search.semantic.workspaceFallback.mode", "strict_zero");
    repository.setSetting("observability.enabled", true);

    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    repository.createNode({
      type: "note",
      title: "Incident cleanup guide",
      body: "Direct lexical overlap should win without semantic fallback.",
      source,
      tags: ["ops"],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "incident cleanup",
          scopes: ["nodes", "activities"],
          limit: 10,
          offset: 0,
          sort: "smart",
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.items[0]?.node?.matchReason?.strategy).toBe("fts");

      const summaryPayload = await waitFor(async () => {
        const summaryResponse = await fetch(`${baseUrl}/observability/summary?since=24h`);
        const summary = await summaryResponse.json();
        return summary.data?.semanticFallbackRate ? summary : null;
      });

      expect(summaryPayload.data.semanticFallbackRate).toEqual({
        eligibleCount: 0,
        attemptedCount: 0,
        hitCount: 0,
        attemptRatio: null,
        hitRatio: null,
        modes: [
          {
            fallbackMode: "strict_zero",
            eligibleCount: 0,
            attemptedCount: 0,
            hitCount: 0,
            sampleCount: 1,
            attemptRatio: null,
            hitRatio: null
          }
        ]
      });
      expect(summaryPayload.data.operationSummaries.some((item: { operation: string }) => item.operation === "workspace.search.semantic_fallback")).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("skips workspace semantic fallback for short queries", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const repository = workspaceSessionManager.getCurrent().repository;
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    repository.setSetting("search.semantic.workspaceFallback.enabled", true);
    repository.setSetting("search.semantic.workspaceFallback.mode", "strict_zero");
    repository.setSetting("observability.enabled", true);

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "abc",
          scopes: ["nodes", "activities"],
          limit: 10,
          offset: 0,
          sort: "smart",
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.items).toHaveLength(0);

      const summaryPayload = await waitFor(async () => {
        const summaryResponse = await fetch(`${baseUrl}/observability/summary?since=24h`);
        const summary = await summaryResponse.json();
        return summary.data?.semanticFallbackRate ? summary : null;
      });

      expect(summaryPayload.data.semanticFallbackRate).toEqual({
        eligibleCount: 0,
        attemptedCount: 0,
        hitCount: 0,
        attemptRatio: null,
        hitRatio: null,
        modes: [
          {
            fallbackMode: "strict_zero",
            eligibleCount: 0,
            attemptedCount: 0,
            hitCount: 0,
            sampleCount: 1,
            attemptRatio: null,
            hitRatio: null
          }
        ]
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("uses smart sort to keep recent activity near the top of mixed search results", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const repository = workspaceSessionManager.getCurrent().repository;
    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex",
    };
    const node = repository.createNode({
      type: "note",
      title: "Cleanup reference",
      body: "Durable cleanup note.",
      source,
      tags: [],
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    repository.appendActivity({
      targetNodeId: node.id,
      activityType: "agent_run_summary",
      body: "Cleanup summary finished a moment ago.",
      source,
      metadata: {},
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "cleanup",
          scopes: ["nodes", "activities"],
          limit: 10,
          offset: 0,
          sort: "smart",
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.items[0].resultType).toBe("activity");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("uses relation usage events to reorder inferred neighborhood items", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const repository = workspaceSessionManager.getCurrent().repository;
      const source = {
        actorType: "agent" as const,
        actorLabel: "Codex",
        toolName: "codex",
      };
      const targetNode = repository.createNode({
        type: "project",
        title: "Ranking target",
        body: "Target project",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const structurallyStrong = repository.createNode({
        type: "note",
        title: "Strong structure",
        body: "Higher base score but no usage",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const usedOften = repository.createNode({
        type: "note",
        title: "Used often",
        body: "Lower base score but strong usage",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });

      const strongRelationResponse = await fetch(`${baseUrl}/inferred-relations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromNodeId: targetNode.id,
          toNodeId: structurallyStrong.id,
          relationType: "supports",
          baseScore: 0.7,
          usageScore: 0,
          finalScore: 0.7,
          status: "active",
          generator: "deterministic-linker",
          evidence: {},
          metadata: {},
        }),
      });
      const strongRelationBody = await strongRelationResponse.json();

      const usedRelationResponse = await fetch(`${baseUrl}/inferred-relations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromNodeId: targetNode.id,
          toNodeId: usedOften.id,
          relationType: "supports",
          baseScore: 0.52,
          usageScore: 0,
          finalScore: 0.52,
          status: "active",
          generator: "deterministic-linker",
          evidence: {},
          metadata: {},
        }),
      });
      const usedRelationBody = await usedRelationResponse.json();

      await fetch(`${baseUrl}/relation-usage-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          relationId: usedRelationBody.data.relation.id,
          relationSource: "inferred",
          eventType: "bundle_used_in_output",
          delta: 0.25,
          source,
          metadata: {},
        }),
      });

      const neighborhoodResponse = await fetch(
        `${baseUrl}/nodes/${targetNode.id}/neighborhood?include_inferred=1&max_inferred=4`
      );
      const neighborhoodBody = await neighborhoodResponse.json();

      expect(strongRelationBody.data.relation.id).toBeTruthy();
      expect(neighborhoodResponse.status).toBe(200);
      expect(neighborhoodBody.data.items[0]?.node.id).toBe(usedOften.id);
      expect(neighborhoodBody.data.items[0]?.edge.reason).toContain("usage +");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("uses relation bonuses when ranking candidates for a target node", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const repository = workspaceSessionManager.getCurrent().repository;
      const source = {
        actorType: "agent" as const,
        actorLabel: "Codex",
        toolName: "codex",
      };
      const targetNode = repository.createNode({
        type: "project",
        title: "Ranking project",
        body: "Target for candidate ranking",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const linkedCandidate = repository.createNode({
        type: "note",
        title: "Shared candidate",
        body: "Both candidates match the text query",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const plainCandidate = repository.createNode({
        type: "note",
        title: "Shared candidate",
        body: "Both candidates match the text query",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });

      const relationResponse = await fetch(`${baseUrl}/inferred-relations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromNodeId: targetNode.id,
          toNodeId: linkedCandidate.id,
          relationType: "supports",
          baseScore: 0.6,
          usageScore: 0,
          finalScore: 0.6,
          status: "active",
          generator: "deterministic-linker",
          evidence: {},
          metadata: {},
        }),
      });
      const relationBody = await relationResponse.json();

      await fetch(`${baseUrl}/relation-usage-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          relationId: relationBody.data.relation.id,
          relationSource: "inferred",
          eventType: "retrieval_confirmed",
          delta: 0.2,
          source,
          metadata: {},
        }),
      });

      const rankingResponse = await fetch(`${baseUrl}/retrieval/rank-candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "shared candidate",
          targetNodeId: targetNode.id,
          candidateNodeIds: [plainCandidate.id, linkedCandidate.id],
          preset: "for-assistant",
        }),
      });
      const rankingBody = await rankingResponse.json();

      expect(rankingResponse.status).toBe(200);
      expect(rankingBody.data.items[0]?.nodeId).toBe(linkedCandidate.id);
      expect(rankingBody.data.items[0]?.relationSource).toBe("inferred");
      expect(rankingBody.data.items[0]?.reason).toContain("usage +");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("adds local-ngram semantic bonuses when deterministic candidate signals are weak", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "agent" as const,
        actorLabel: "Codex",
        toolName: "codex",
      };
      const plainCandidate = repository.createNode({
        type: "note",
        title: "Budget planning memo",
        body: "Quarterly budgeting, forecast tracking, and finance alignment.",
        source,
        tags: ["finance"],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const semanticCandidate = repository.createNode({
        type: "note",
        title: "Recovery checklist",
        body: "Service restart rollback runbook for outage recovery and deploy verification.",
        source,
        tags: ["ops", "runbook"],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      await repository.processPendingSemanticIndex(10);

      const rankingResponse = await fetch(`${baseUrl}/retrieval/rank-candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "rollback runbook service restart",
          candidateNodeIds: [plainCandidate.id, semanticCandidate.id],
          preset: "for-assistant",
        }),
      });
      const rankingBody = await rankingResponse.json();

      expect(rankingResponse.status).toBe(200);
      expect(rankingBody.data.items[0]?.nodeId).toBe(semanticCandidate.id);
      expect(rankingBody.data.items[0]?.semanticSimilarity).toBeGreaterThan(0.2);
      expect(rankingBody.data.items[0]?.reason).toContain("Semantic similarity");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("skips local-ngram semantic bonuses when a strong lexical match already exists", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "agent" as const,
        actorLabel: "Codex",
        toolName: "codex",
      };
      const directMatch = repository.createNode({
        type: "note",
        title: "Restart checklist",
        body: "Service restart rollback runbook for outage recovery.",
        source,
        tags: ["ops"],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const semanticCandidate = repository.createNode({
        type: "note",
        title: "Recovery guide",
        body: "Service restart rollback runbook for outage recovery and deploy verification.",
        source,
        tags: ["ops", "runbook"],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      await repository.processPendingSemanticIndex(10);

      const rankingResponse = await fetch(`${baseUrl}/retrieval/rank-candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "Restart checklist",
          candidateNodeIds: [semanticCandidate.id, directMatch.id],
          preset: "for-assistant",
        }),
      });
      const rankingBody = await rankingResponse.json();

      expect(rankingResponse.status).toBe(200);
      expect(rankingBody.data.items[0]?.nodeId).toBe(directMatch.id);
      expect(rankingBody.data.items[0]?.semanticSimilarity).toBeNull();
      expect(rankingBody.data.items[1]?.semanticSimilarity).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("respects semantic augmentation minSimilarity and maxBonus settings without changing the default gate", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "agent" as const,
        actorLabel: "Codex",
        toolName: "codex",
      };
      const plainCandidate = repository.createNode({
        type: "note",
        title: "Deploy notes",
        body: "Generic operational notes with no rollback checklist or restart details.",
        source,
        tags: ["ops"],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const semanticCandidate = repository.createNode({
        type: "note",
        title: "Recovery checklist",
        body: "Service restart rollback runbook for outage recovery and deploy verification.",
        source,
        tags: ["ops", "runbook"],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      await repository.processPendingSemanticIndex(10);

      repository.setSetting("search.semantic.augmentation.maxBonus", 4);
      const tunedResponse = await fetch(`${baseUrl}/retrieval/rank-candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "rollback runbook service restart",
          candidateNodeIds: [plainCandidate.id, semanticCandidate.id],
          preset: "for-assistant",
        }),
      });
      const tunedBody = await tunedResponse.json();

      expect(tunedResponse.status).toBe(200);
      expect(tunedBody.data.items[0]?.nodeId).toBe(semanticCandidate.id);
      expect(tunedBody.data.items[0]?.semanticSimilarity).toBeGreaterThan(0.2);
      expect(tunedBody.data.items[0]?.score).toBeLessThanOrEqual(24);

      repository.setSetting("search.semantic.augmentation.minSimilarity", 0.99);
      const suppressedResponse = await fetch(`${baseUrl}/retrieval/rank-candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "rollback runbook service restart",
          candidateNodeIds: [plainCandidate.id, semanticCandidate.id],
          preset: "for-assistant",
        }),
      });
      const suppressedBody = await suppressedResponse.json();

      expect(suppressedResponse.status).toBe(200);
      expect(suppressedBody.data.items[0]?.semanticSimilarity).toBeNull();
      expect(suppressedBody.data.items[0]?.reason ?? "").not.toContain("Semantic similarity");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("includes relation ids in context bundle items for relation-backed preview actions", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "human" as const,
        actorLabel: "juhwan",
        toolName: "recallx-test",
      };
      const target = repository.createNode({
        type: "project",
        title: "Context target",
        body: "Primary project",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const related = repository.createNode({
        type: "note",
        title: "Context related",
        body: "Related note",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const relation = repository.createRelation({
        fromNodeId: target.id,
        toNodeId: related.id,
        relationType: "supports",
        metadata: {},
        source,
        resolvedStatus: "active",
      });

      const bundleResponse = await fetch(`${baseUrl}/context/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: { id: target.id },
          mode: "compact",
          preset: "for-assistant",
          options: {
            includeRelated: true,
            includeInferred: false,
            includeRecentActivities: false,
            includeDecisions: false,
            includeOpenQuestions: false,
            maxInferred: 0,
            maxItems: 5
          }
        }),
      });
      const bundleBody = await bundleResponse.json();
      const bundleItem = bundleBody.data.bundle.items.find((item: { nodeId: string }) => item.nodeId === related.id);

      expect(bundleResponse.status).toBe(200);
      expect(bundleItem).toMatchObject({
        nodeId: related.id,
        relationId: relation.id,
        relationType: "supports"
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("supports top-k mean semantic chunk aggregation without changing the default max strategy", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspace = ensureWorkspace(root);
    const db = openDatabase(workspace);
    const repository = new RecallXRepository(db, root);
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "local-ngram",
      "search.semantic.model": "chargram-v1",
      "search.semantic.chunk.enabled": true,
      "search.semantic.chunk.aggregation": "max",
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const exactChunkNode = repository.createNode({
      type: "note",
      title: "Exact chunk node",
      body: "placeholder",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const steadyChunkNode = repository.createNode({
      type: "note",
      title: "Steady chunk node",
      body: "placeholder",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    const queryVector = (await embedSemanticQueryText({
      provider: "local-ngram",
      model: "chargram-v1",
      text: "rollback runbook service restart"
    }))?.vector;
    if (!queryVector?.length) {
      throw new Error("Expected local-ngram query vector");
    }

    const buildOrthogonalUnitVector = (base: number[]) => {
      const pivot = base.reduce(
        (best, value, index) => (Math.abs(value) < Math.abs(base[best] ?? Infinity) ? index : best),
        0
      );
      const candidate = new Array<number>(base.length).fill(0);
      candidate[pivot] = 1;
      const projection = base.reduce((sum, value, index) => sum + value * candidate[index], 0);
      const orthogonal = candidate.map((value, index) => value - projection * base[index]);
      const magnitude = Math.sqrt(orthogonal.reduce((sum, value) => sum + value * value, 0));
      return orthogonal.map((value) => value / magnitude);
    };
    const orthogonalVector = buildOrthogonalUnitVector(queryVector);
    const blendVector = (targetSimilarity: number) =>
      queryVector.map(
        (value, index) => targetSimilarity * value + Math.sqrt(1 - targetSimilarity ** 2) * orthogonalVector[index]
      );
    const encodeVector = (vector: number[]) => new Uint8Array(new Float32Array(vector).buffer);
    const now = "2026-03-19T00:00:00.000Z";
    const insertEmbedding = db.prepare(
      `INSERT INTO node_embeddings (
         owner_type, owner_id, chunk_ordinal, vector_ref, vector_blob, embedding_provider, embedding_model, embedding_version,
         content_hash, status, created_at, updated_at
       ) VALUES ('node', ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`
    );
    const setReadyState = db.prepare(
      `UPDATE node_index_state
       SET embedding_status = 'ready', embedding_provider = ?, embedding_model = ?, embedding_version = ?, stale_reason = NULL, updated_at = ?
       WHERE node_id = ?`
    );

    insertEmbedding.run(exactChunkNode.id, 0, null, encodeVector(queryVector), "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, "hash-a", now, now);
    insertEmbedding.run(
      exactChunkNode.id,
      1,
      null,
      encodeVector(new Array<number>(queryVector.length).fill(0)),
      "local-ngram",
      "chargram-v1",
      LOCAL_NGRAM_EMBEDDING_VERSION,
      "hash-a",
      now,
      now
    );
    insertEmbedding.run(steadyChunkNode.id, 0, null, encodeVector(blendVector(0.8)), "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, "hash-b", now, now);
    insertEmbedding.run(steadyChunkNode.id, 1, null, encodeVector(blendVector(0.8)), "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, "hash-b", now, now);
    setReadyState.run("local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, now, exactChunkNode.id);
    setReadyState.run("local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, now, steadyChunkNode.id);

    const maxMatches = await repository.rankSemanticCandidates("rollback runbook service restart", [
      exactChunkNode.id,
      steadyChunkNode.id
    ]);
    expect(maxMatches.get(exactChunkNode.id)?.similarity).toBeGreaterThan(maxMatches.get(steadyChunkNode.id)?.similarity ?? 0);

    repository.setSetting("search.semantic.chunk.aggregation", "topk_mean");
    const topKMatches = await repository.rankSemanticCandidates("rollback runbook service restart", [
      exactChunkNode.id,
      steadyChunkNode.id
    ]);
    expect(topKMatches.get(steadyChunkNode.id)?.similarity).toBeGreaterThan(topKMatches.get(exactChunkNode.id)?.similarity ?? 0);
  });

  it("filters sqlite-vec semantic searches to the bounded candidate set and aggregates chunk scores", async () => {
    const { db, repository } = createRepositoryContext();
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "local-ngram",
      "search.semantic.model": "chargram-v1",
      "search.semantic.indexBackend": "sqlite-vec",
      "search.semantic.chunk.enabled": true,
      "search.semantic.chunk.aggregation": "max",
    });

    const queryEmbedding = await embedSemanticQueryText({
      provider: "local-ngram",
      model: "chargram-v1",
      text: "rollback runbook service restart"
    });
    if (!queryEmbedding?.vector.length) {
      throw new Error("Expected local-ngram query embedding to be available");
    }

    const encodeVector = (vector: number[]) => new Uint8Array(new Float32Array(vector).buffer);
    const blendVector = (weight: number) =>
      queryEmbedding.vector.map((value, index) => {
        const basis = index === 0 ? 1 : index === 1 ? 0.8 : 0.05 * ((index % 3) + 1);
        return value * weight + basis * (1 - weight);
      });
    const insertEmbedding = db.prepare(
      `INSERT INTO node_embeddings (
         owner_type, owner_id, chunk_ordinal, vector_ref, vector_blob, embedding_provider, embedding_model,
         embedding_version, content_hash, status, created_at, updated_at
       ) VALUES ('node', ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`
    );
    const setReadyState = db.prepare(
      `INSERT INTO node_index_state (
         node_id, content_hash, embedding_status, embedding_provider, embedding_model, embedding_version, stale_reason, updated_at
       ) VALUES (?, ?, 'ready', ?, ?, ?, NULL, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         embedding_status = excluded.embedding_status,
         embedding_provider = excluded.embedding_provider,
         embedding_model = excluded.embedding_model,
         embedding_version = excluded.embedding_version,
         stale_reason = excluded.stale_reason,
         updated_at = excluded.updated_at`
    );
    const now = new Date().toISOString();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const exactChunkNode = repository.createNode({
      type: "note",
      title: "Exact blend",
      body: "Candidate A",
      tags: ["semantic"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const steadyChunkNode = repository.createNode({
      type: "note",
      title: "Steady blend",
      body: "Candidate B",
      tags: ["semantic"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const filteredOutNode = repository.createNode({
      type: "note",
      title: "Filtered out",
      body: "Candidate C",
      tags: ["semantic"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });

    insertEmbedding.run(exactChunkNode.id, 0, null, encodeVector(queryEmbedding.vector), "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, "hash-a", now, now);
    insertEmbedding.run(exactChunkNode.id, 1, null, encodeVector(blendVector(0.1)), "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, "hash-a", now, now);
    insertEmbedding.run(steadyChunkNode.id, 0, null, encodeVector(blendVector(0.8)), "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, "hash-b", now, now);
    insertEmbedding.run(steadyChunkNode.id, 1, null, encodeVector(blendVector(0.8)), "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, "hash-b", now, now);
    insertEmbedding.run(filteredOutNode.id, 0, null, encodeVector(queryEmbedding.vector), "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, "hash-c", now, now);
    setReadyState.run(exactChunkNode.id, "hash-a", "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, now);
    setReadyState.run(steadyChunkNode.id, "hash-b", "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, now);
    setReadyState.run(filteredOutNode.id, "hash-c", "local-ngram", "chargram-v1", LOCAL_NGRAM_EMBEDDING_VERSION, now);

    const maxMatches = await repository.rankSemanticCandidates("rollback runbook service restart", [
      exactChunkNode.id,
      steadyChunkNode.id
    ]);
    repository.setSetting("search.semantic.chunk.aggregation", "topk_mean");
    const topKMatches = await repository.rankSemanticCandidates("rollback runbook service restart", [
      exactChunkNode.id,
      steadyChunkNode.id
    ]);

    expect(maxMatches.get(exactChunkNode.id)?.similarity).toBeGreaterThan(maxMatches.get(steadyChunkNode.id)?.similarity ?? 0);
    expect(topKMatches.get(steadyChunkNode.id)?.similarity).toBeGreaterThan(topKMatches.get(exactChunkNode.id)?.similarity ?? 0);
    expect(maxMatches.has(filteredOutNode.id)).toBe(false);
    expect(topKMatches.has(filteredOutNode.id)).toBe(false);
  });

  it("ignores legacy-version sqlite-vec embeddings and marks them stale", async () => {
    const { db, repository } = createRepositoryContext();
    repository.ensureBaseSettings({
      "search.semantic.enabled": true,
      "search.semantic.provider": "local-ngram",
      "search.semantic.model": "chargram-v1",
      "search.semantic.indexBackend": "sqlite-vec",
      "search.semantic.chunk.enabled": false,
    });
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test"
    };
    const legacyNode = repository.createNode({
      type: "note",
      title: "Legacy sqlite-vec node",
      body: "Rollback runbook service restart and deploy verification.",
      tags: ["semantic", "legacy", "sqlite-vec"],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const queryEmbedding = await embedSemanticQueryText({
      provider: "local-ngram",
      model: "chargram-v1",
      text: "rollback runbook service restart"
    });
    if (!queryEmbedding?.vector.length) {
      throw new Error("Expected local-ngram query embedding to be available");
    }

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO node_embeddings (
         owner_type, owner_id, chunk_ordinal, vector_ref, vector_blob, embedding_provider, embedding_model,
         embedding_version, content_hash, status, created_at, updated_at
       ) VALUES ('node', ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`
    ).run(legacyNode.id, 0, null, encodeVector(queryEmbedding.vector), "local-ngram", "chargram-v1", "1", "hash-legacy-sqlite-vec", now, now);
    db.prepare(
      `INSERT INTO node_index_state (
         node_id, content_hash, embedding_status, embedding_provider, embedding_model, embedding_version, stale_reason, updated_at
       ) VALUES (?, ?, 'ready', ?, ?, ?, NULL, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         embedding_status = excluded.embedding_status,
         embedding_provider = excluded.embedding_provider,
         embedding_model = excluded.embedding_model,
         embedding_version = excluded.embedding_version,
         stale_reason = excluded.stale_reason,
         updated_at = excluded.updated_at`
    ).run(legacyNode.id, "hash-legacy-sqlite-vec", "local-ngram", "chargram-v1", "1", now);

    const matches = await repository.rankSemanticCandidates("rollback runbook service restart", [legacyNode.id]);
    const state = db
      .prepare(`SELECT embedding_status, stale_reason FROM node_index_state WHERE node_id = ?`)
      .get(legacyNode.id) as Record<string, unknown> | undefined;

    expect(matches.has(legacyNode.id)).toBe(false);
    expect(state?.embedding_status).toBe("stale");
    expect(state?.stale_reason).toBe("embedding.configuration_changed");
  });

  it("skips sqlite-vec semantic lookups when a strong lexical candidate match already exists", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const semanticRankSpy = vi.spyOn(repository, "rankSemanticCandidates");
    repository.setSetting("search.semantic.enabled", true);
    repository.setSetting("search.semantic.provider", "local-ngram");
    repository.setSetting("search.semantic.model", "chargram-v1");
    repository.setSetting("search.semantic.indexBackend", "sqlite-vec");
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "agent" as const,
        actorLabel: "Codex",
        toolName: "codex",
      };
      const exactNode = repository.createNode({
        type: "note",
        title: "Incident guide checklist",
        body: "Lexical overlap should be enough to skip semantic augmentation.",
        source,
        tags: ["ops"],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });

      const response = await fetch(`${baseUrl}/retrieval/rank-candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "incident guide",
          candidateNodeIds: [exactNode.id],
          preset: "for-assistant"
        })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(semanticRankSpy).not.toHaveBeenCalled();
      expect(body.data.items[0]?.semanticSimilarity ?? null).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("recomputes inferred relation scores through the HTTP API", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const repository = workspaceSessionManager.getCurrent().repository;
      const source = {
        actorType: "agent" as const,
        actorLabel: "Codex",
        toolName: "codex",
      };
      const targetNode = repository.createNode({
        type: "project",
        title: "Recompute target",
        body: "Maintenance target",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const relatedNode = repository.createNode({
        type: "note",
        title: "Recompute related",
        body: "Maintenance related",
        source,
        tags: [],
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });
      const relation = repository.upsertInferredRelation({
        fromNodeId: targetNode.id,
        toNodeId: relatedNode.id,
        relationType: "supports",
        baseScore: 0.4,
        usageScore: 0,
        finalScore: 0.4,
        status: "active",
        generator: "deterministic-linker",
        evidence: {},
        metadata: {},
      });
      repository.appendRelationUsageEvent({
        relationId: relation.id,
        relationSource: "inferred",
        eventType: "bundle_used_in_output",
        delta: 0.2,
        source,
        metadata: {},
      });

      const response = await fetch(`${baseUrl}/inferred-relations/recompute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          relationIds: [relation.id],
          limit: 10,
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.updatedCount).toBe(1);
      expect(payload.data.items[0]?.id).toBe(relation.id);
      expect(payload.data.items[0]?.finalScore).toBeGreaterThan(0.6);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("project graph API", () => {
  it("returns a bounded project-scoped graph with canonical and inferred edges", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "human" as const,
        actorLabel: "juhwan",
        toolName: "recallx-test",
      };

      const createNodeRequest = async (input: { type: string; title: string; body: string }) => {
        const response = await fetch(`${baseUrl}/nodes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...input,
            tags: [],
            metadata: {},
            source,
          }),
        });
        return response.json();
      };

      const projectBody = await createNodeRequest({
        type: "project",
        title: "Renderer Refresh",
        body: "Project root",
      });
      const otherProjectBody = await createNodeRequest({
        type: "project",
        title: "Another Project",
        body: "Other scope",
      });
      const noteABody = await createNodeRequest({
        type: "note",
        title: "Sigma direction",
        body: "Use Sigma as the core renderer.",
      });
      const noteBBody = await createNodeRequest({
        type: "note",
        title: "Project map filters",
        body: "Keep inferred edges visually distinct.",
      });
      const otherNoteBody = await createNodeRequest({
        type: "note",
        title: "Outside scope",
        body: "Should not leak into the project graph.",
      });

      const projectId = projectBody.data.node.id as string;
      const otherProjectId = otherProjectBody.data.node.id as string;
      const noteAId = noteABody.data.node.id as string;
      const noteBId = noteBBody.data.node.id as string;
      const otherNoteId = otherNoteBody.data.node.id as string;

      const createRelationRequest = async (input: { fromNodeId: string; toNodeId: string; relationType: string }) =>
        fetch(`${baseUrl}/relations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...input,
            source,
            metadata: {},
          }),
        });

      await createRelationRequest({
        fromNodeId: noteAId,
        toNodeId: projectId,
        relationType: "relevant_to",
      });
      await createRelationRequest({
        fromNodeId: noteBId,
        toNodeId: projectId,
        relationType: "relevant_to",
      });
      await createRelationRequest({
        fromNodeId: otherNoteId,
        toNodeId: otherProjectId,
        relationType: "relevant_to",
      });
      await createRelationRequest({
        fromNodeId: noteAId,
        toNodeId: noteBId,
        relationType: "supports",
      });
      await createRelationRequest({
        fromNodeId: noteAId,
        toNodeId: otherNoteId,
        relationType: "supports",
      });
      await fetch(`${baseUrl}/activities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetNodeId: noteAId,
          activityType: "agent_run_summary",
          body: "Renderer work is active on this project.",
          source,
          metadata: {},
        }),
      });

      const repository = workspaceSessionManager.getCurrent().repository;
      await waitFor(() => {
        const inferred = repository.listInferredRelationsForNode(noteBId, 20);
        return inferred.some(
          (item) =>
            item.generator === "deterministic-project-membership" &&
            [item.fromNodeId, item.toNodeId].includes(noteAId)
        )
          ? inferred
          : null;
      });

      const response = await fetch(`${baseUrl}/projects/${projectId}/graph?max_inferred=1`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data.meta.focusProjectId).toBe(projectId);
      expect(body.data.meta.inferredEdgeCount).toBeLessThanOrEqual(1);
      expect(body.data.nodes.map((item: any) => item.id)).toEqual(expect.arrayContaining([projectId, noteAId, noteBId]));
      expect(body.data.nodes.map((item: any) => item.id)).not.toContain(otherNoteId);
      expect(body.data.edges.every((item: any) => [projectId, noteAId, noteBId].includes(item.source))).toBe(true);
      expect(body.data.edges.every((item: any) => [projectId, noteAId, noteBId].includes(item.target))).toBe(true);
      expect(body.data.edges.some((item: any) => item.relationSource === "canonical" && item.relationType === "supports")).toBe(true);
      expect(body.data.timeline[0].at <= body.data.timeline[body.data.timeline.length - 1].at).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("orders project timeline items deterministically when timestamps match", () => {
    const { db, repository } = createRepositoryContext();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test",
    };
    const fixedAt = "2026-03-21T00:00:00.000Z";

    const project = repository.createNode({
      type: "project",
      title: "Timeline Project",
      body: "Project body",
      summary: "Project summary",
      tags: [],
      metadata: {},
      source,
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const note = repository.createNode({
      type: "note",
      title: "Timeline Note",
      body: "Note body",
      summary: "Note summary",
      tags: [],
      metadata: {},
      source,
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const relation = repository.createRelation({
      fromNodeId: note.id,
      toNodeId: project.id,
      relationType: "relevant_to",
      source,
      metadata: {},
      resolvedStatus: "active",
    });
    const activity = repository.appendActivity({
      targetNodeId: note.id,
      activityType: "note_appended",
      body: "Updated the note",
      source,
      metadata: {},
    });

    db.prepare(`UPDATE nodes SET created_at = ?, updated_at = ? WHERE id IN (?, ?)`).run(fixedAt, fixedAt, project.id, note.id);
    db.prepare(`UPDATE relations SET created_at = ? WHERE id = ?`).run(fixedAt, relation.id);
    db.prepare(`UPDATE activities SET created_at = ? WHERE id = ?`).run(fixedAt, activity.id);

    const graph = buildProjectGraph(repository, project.id, {
      includeInferred: false,
    });

    expect(graph.timeline.map((item) => item.kind)).toEqual([
      "node_created",
      "node_created",
      "relation_created",
      "activity",
    ]);
  });

  it("falls back to recent workspace nodes when a project has no explicit graph yet", () => {
    const repository = createRepository();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "recallx-test",
    };

    const project = repository.createNode({
      type: "project",
      title: "Empty Project",
      body: "Project body",
      summary: "Project summary",
      tags: [],
      metadata: {},
      source,
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });
    const note = repository.createNode({
      type: "note",
      title: "Recent Workspace Note",
      body: "Useful exploration seed",
      summary: "Seed summary",
      tags: [],
      metadata: {},
      source,
      resolvedCanonicality: "canonical",
      resolvedStatus: "active",
    });

    const graph = buildProjectGraph(repository, project.id, {
      includeInferred: true,
      maxInferred: 10,
    });

    expect(graph.nodes.map((item) => item.id)).toContain(note.id);
    expect(
      graph.edges.some(
        (item) =>
          item.source === project.id &&
          item.target === note.id &&
          item.relationSource === "inferred" &&
          item.generator === "project-map-fallback"
      )
    ).toBe(true);
  });
});

describe("bootstrap auth metadata", () => {
  it("keeps bootstrap public without leaking the bearer token", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root, "bearer");
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: "secret-token"
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const bootstrapResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/bootstrap`);
      const bootstrapBody = await bootstrapResponse.json();
      const workspaceResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workspace`);
      const searchResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/nodes/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: "",
          filters: {},
          limit: 10,
          offset: 0,
          sort: "updated_at"
        })
      });

      expect(bootstrapResponse.status).toBe(200);
      expect(bootstrapBody.data.authMode).toBe("bearer");
      expect(bootstrapBody.data.apiToken).toBeUndefined();
      expect(bootstrapBody.data.workspace.authMode).toBe("bearer");
      expect(bootstrapBody.data.workspace.workspaceName).toBe("RecallX Test");
      expect(bootstrapBody.data.workspace.bindAddress).toBe("127.0.0.1:8787");
      expect(bootstrapBody.data.workspace.enabledIntegrationModes).toEqual(["read-only", "append-only"]);
      expect(typeof bootstrapBody.data.workspace.workspaceKey).toBe("string");
      expect(bootstrapBody.data.workspace.rootPath).toBeUndefined();
      expect(bootstrapBody.data.workspace.autoRecompute).toBeUndefined();
      expect(workspaceResponse.status).toBe(401);
      expect(searchResponse.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("browser origin hardening", () => {
  it("rejects non-loopback browser origins and only reflects local dev origins", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const disallowed = await fetch(`http://127.0.0.1:${address.port}/api/v1/bootstrap`, {
        headers: {
          origin: "https://example.com"
        }
      });
      const allowed = await fetch(`http://127.0.0.1:${address.port}/api/v1/bootstrap`, {
        headers: {
          origin: "http://127.0.0.1:5173"
        }
      });

      expect(disallowed.status).toBe(403);
      expect(disallowed.headers.get("access-control-allow-origin")).toBeNull();
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("requires bearer auth for event streams in bearer mode", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root, "bearer");
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: "secret-token"
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`, {
        headers: {
          origin: "http://127.0.0.1:5173"
        }
      });

      expect(response.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("rejects query-string bearer tokens on protected API routes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root, "bearer");
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: "secret-token"
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/nodes/search?token=secret-token`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: "",
          filters: {},
          limit: 10,
          offset: 0,
          sort: "updated_at"
        })
      });

      expect(response.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("artifact path hardening", () => {
  it("rejects artifact registration outside the workspace root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    const siblingRoot = `${root}-secret`;
    tempRoots.push(root, siblingRoot);
    mkdirSync(siblingRoot, { recursive: true });
    const outsidePath = path.join(siblingRoot, "leak.txt");
    writeFileSync(outsidePath, "secret");

    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const node = repository.createNode({
      type: "note",
      title: "Artifact target",
      body: "Testing path boundaries",
      tags: [],
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: node.id,
          path: outsidePath,
          source: {
            actorType: "human",
            actorLabel: "juhwan",
            toolName: "recallx-test"
          },
          metadata: {}
        })
      });

      expect(response.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("rejects artifact registration outside the artifacts directory even when still inside the workspace", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const node = repository.createNode({
      type: "note",
      title: "Artifact target",
      body: "Testing artifact root boundaries",
      tags: [],
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const workspaceLocalPath = path.join(root, "workspace-local.txt");
    writeFileSync(workspaceLocalPath, "local-but-not-artifact");
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: node.id,
          path: workspaceLocalPath,
          source: {
            actorType: "human",
            actorLabel: "juhwan",
            toolName: "recallx-test"
          },
          metadata: {}
        })
      });

      expect(response.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("rejects artifact registration when the artifact path is a symlink", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    const siblingRoot = `${root}-secret`;
    tempRoots.push(root, siblingRoot);
    mkdirSync(siblingRoot, { recursive: true });
    const outsidePath = path.join(siblingRoot, "leak.txt");
    writeFileSync(outsidePath, "secret");

    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const node = repository.createNode({
      type: "note",
      title: "Artifact target",
      body: "Testing symlink boundaries",
      tags: [],
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const symlinkPath = path.join(root, "artifacts", "linked-secret.txt");
    symlinkSync(outsidePath, symlinkPath);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: node.id,
          path: symlinkPath,
          source: {
            actorType: "human",
            actorLabel: "juhwan",
            toolName: "recallx-test"
          },
          metadata: {}
        })
      });

      expect(response.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("requires bearer auth and a registered artifact path for raw artifact downloads", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root, "bearer");
    const repository = workspaceSessionManager.getCurrent().repository;
    const node = repository.createNode({
      type: "note",
      title: "Artifact target",
      body: "Testing raw artifact downloads",
      tags: [],
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const registeredPath = path.join(root, "artifacts", "registered.txt");
    const unregisteredPath = path.join(root, "artifacts", "unregistered.txt");
    writeFileSync(registeredPath, "registered");
    writeFileSync(unregisteredPath, "unregistered");
    repository.attachArtifact({
      nodeId: node.id,
      path: registeredPath,
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test"
      },
      metadata: {}
    });
    expect(repository.hasArtifactAtPath("artifacts/registered.txt")).toBe(true);
    expect(repository.hasArtifactAtPath("artifacts\\registered.txt")).toBe(true);

    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: "secret-token"
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const unauthenticated = await fetch(`http://127.0.0.1:${address.port}/artifacts/artifacts/registered.txt`);
      const unregistered = await fetch(`http://127.0.0.1:${address.port}/artifacts/artifacts/unregistered.txt`, {
        headers: {
          authorization: "Bearer secret-token"
        }
      });
      const registered = await fetch(`http://127.0.0.1:${address.port}/artifacts/artifacts/registered.txt`, {
        headers: {
          authorization: "Bearer secret-token"
        }
      });

      expect(unauthenticated.status).toBe(401);
      expect(unregistered.status).toBe(404);
      expect(registered.status).toBe(200);
      expect(await registered.text()).toBe("registered");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("treats sibling directories as outside the workspace boundary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    const siblingRoot = `${root}-secret`;
    tempRoots.push(root, siblingRoot);
    mkdirSync(siblingRoot, { recursive: true });
    const insidePath = path.join(root, "artifacts", "safe.txt");
    const outsidePath = path.join(siblingRoot, "leak.txt");
    writeFileSync(outsidePath, "secret");

    expect(isPathWithinRoot(root, insidePath)).toBe(true);
    expect(isPathWithinRoot(root, outsidePath)).toBe(false);
  });
});

describe("workspace switching", () => {
  it("switches workspaces without restarting the server", async () => {
    const rootA = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    const rootB = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(rootA, rootB);

    const workspaceSessionManager = createWorkspaceSessionManager(rootA);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const source = {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "recallx-test",
      };

      await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Workspace Alpha",
          body: "Stored in the first workspace",
          source,
          tags: [],
          metadata: {},
        }),
      });

      const createWorkspaceResponse = await fetch(`${baseUrl}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rootPath: rootB,
          workspaceName: "Workspace Beta",
        }),
      });
      const createWorkspaceBody = await createWorkspaceResponse.json();

      const afterCreateSearchResponse = await fetch(`${baseUrl}/nodes/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "Workspace Alpha",
          filters: {},
          limit: 10,
          offset: 0,
          sort: "relevance",
        }),
      });
      const afterCreateSearchBody = await afterCreateSearchResponse.json();

      await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "project",
          title: "Workspace Beta Project",
          body: "Stored in the second workspace",
          source,
          tags: [],
          metadata: {},
        }),
      });

      const reopenResponse = await fetch(`${baseUrl}/workspaces/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rootPath: rootA,
        }),
      });
      const reopenBody = await reopenResponse.json();

      const finalSearchResponse = await fetch(`${baseUrl}/nodes/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "",
          filters: {},
          limit: 10,
          offset: 0,
          sort: "updated_at",
        }),
      });
      const finalSearchBody = await finalSearchResponse.json();

      expect(createWorkspaceResponse.status).toBe(201);
      expect(createWorkspaceBody.data.current.rootPath).toBe(rootB);
      expect(createWorkspaceBody.data.current.workspaceName).toBe("Workspace Beta");
      expect(afterCreateSearchBody.data.items).toHaveLength(0);
      expect(reopenResponse.status).toBe(200);
      expect(reopenBody.data.current.rootPath).toBe(rootA);
      expect(finalSearchBody.data.items.map((item: { title: string }) => item.title)).toContain("Workspace Alpha");
      expect(finalSearchBody.data.items.map((item: { title: string }) => item.title)).not.toContain("Workspace Beta Project");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("workspace event stream", () => {
  it("emits async workspace updates when recent content changes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
      const repository = workspaceSessionManager.getCurrent().repository;
      const node = repository.createNode({
        type: "note",
        title: "Async recent node",
        body: "Target node for activity events",
        tags: [],
        source: {
          actorType: "human",
          actorLabel: "juhwan",
          toolName: "recallx-test",
        },
        metadata: {},
        resolvedCanonicality: "canonical",
        resolvedStatus: "active",
      });

      const streamResponse = await fetch(`${baseUrl}/events`);
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
      expect(streamResponse.body).toBeTruthy();

      const reader = streamResponse.body!.getReader();
      const decoder = new TextDecoder();
      const waitForWorkspaceUpdate = async () => {
        let buffer = "";
        const timeoutMs = 3000;
        while (true) {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error("Timed out waiting for workspace event.")), timeoutMs)
            ),
          ]);
          if (chunk.done) {
            throw new Error(`Event stream closed before update arrived. Buffer: ${buffer}`);
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.includes("event: workspace.updated") && buffer.includes('"reason":"activity.appended"')) {
            return buffer;
          }
        }
      };

      const pendingEvent = waitForWorkspaceUpdate();

      const activityResponse = await fetch(`${baseUrl}/activities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetNodeId: node.id,
          activityType: "agent_run_summary",
          body: "Recent view should update from the event stream.",
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex",
          },
          metadata: {},
        }),
      });

      expect(activityResponse.status).toBe(201);

      const eventBuffer = await pendingEvent;
      expect(eventBuffer).toContain("event: workspace.updated");
      expect(eventBuffer).toContain('"entityType":"activity"');
      expect(eventBuffer).toContain('"reason":"activity.appended"');

      await reader.cancel();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("node governance behavior", () => {
  it("stores low-risk agent notes as active appended nodes without review items", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const response = await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Agent-authored implementation note",
          body: "This is a longer note body that should land as append-only active content under automatic governance because it is low-risk project context. ".repeat(30),
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex",
          },
          tags: [],
          metadata: {},
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.data.node.canonicality).toBe("appended");
      expect(payload.data.node.status).toBe("active");
      expect(payload.data.reviewItem).toBeUndefined();
      expect(payload.data.governance.state.state).toBe("healthy");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("keeps durable agent notes suggested for automatic governance", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      const response = await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Durable agent architecture note",
          body: "This is a longer durable note body that should remain suggested because it is intended for reuse across future sessions and tools. ".repeat(30),
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex",
          },
          tags: [],
          metadata: {
            durable: true,
          },
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.data.node.canonicality).toBe("suggested");
      expect(payload.data.node.status).toBe("active");
      expect(payload.data.reviewItem).toBeUndefined();
      expect(payload.data.governance.state.state).toBe("low_confidence");
      expect(payload.data.landing).toEqual({
        storedAs: "node",
        canonicality: "suggested",
        status: "active",
        governanceState: "low_confidence",
        reason: "Reusable agent-authored knowledge starts suggested and active."
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("keeps trusted source tool names within automatic governance for durable notes and relations", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: {
            "review.trustedSourceToolNames": ["codex"]
          }
        }),
      });

      const nodeResponse = await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Trusted durable note",
          body: "This durable note should stay inside automatic governance even when its toolName is trusted. ".repeat(30),
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex",
          },
          tags: [],
          metadata: {
            durable: true,
          },
        }),
      });
      const nodePayload = await nodeResponse.json();

      const relationResponse = await fetch(`${baseUrl}/relations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromNodeId: nodePayload.data.node.id,
          toNodeId: nodePayload.data.node.id,
          relationType: "related_to",
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex",
          },
          metadata: {},
        }),
      });
      const relationPayload = await relationResponse.json();

      expect(nodeResponse.status).toBe(201);
      expect(nodePayload.data.node.canonicality).toBe("suggested");
      expect(nodePayload.data.node.status).toBe("active");
      expect(nodePayload.data.reviewItem).toBeUndefined();
      expect(nodePayload.data.governance.state.state).toBe("low_confidence");
      expect(nodePayload.data.landing.storedAs).toBe("node");

      expect(relationResponse.status).toBe(201);
      expect(relationPayload.data.relation.status).toBe("suggested");
      expect(relationPayload.data.reviewItem).toBeUndefined();
      expect(relationPayload.data.governance.state.state).toBe("low_confidence");
      expect(relationPayload.data.landing).toEqual({
        storedAs: "relation",
        status: "suggested",
        governanceState: "low_confidence",
        reason: "Agent-authored relations start suggested and rely on automatic governance promotion."
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("keeps trusted source tool names within automatic governance for decisions", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: {
            "review.trustedSourceToolNames": ["codex"]
          }
        }),
      });

      const response = await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "decision",
          title: "Use event stream for recent refresh",
          body: "Trusted source decisions should still enter automatic governance under the workspace trusted-source policy.",
          source: {
            actorType: "agent",
            actorLabel: "Codex",
            toolName: "codex",
          },
          tags: [],
          metadata: {},
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.data.node.canonicality).toBe("suggested");
      expect(payload.data.node.status).toBe("active");
      expect(payload.data.reviewItem).toBeUndefined();
      expect(payload.data.governance.state.state).toBe("low_confidence");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("preserves trusted source settings across server reopen", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);

    const openServer = async () => {
      const workspaceSessionManager = createWorkspaceSessionManager(root);
      const app = createRecallXApp({
        workspaceSessionManager,
        apiToken: null,
      });
      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
      };
    };

    const first = await openServer();

    try {
      await fetch(`${first.baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: {
            "review.trustedSourceToolNames": ["codex"],
          },
        }),
      });
    } finally {
      await new Promise<void>((resolve, reject) => first.server.close((error) => (error ? reject(error) : resolve())));
    }

    const second = await openServer();

    try {
      const settingsResponse = await fetch(
        `${second.baseUrl}/settings?keys=review.autoApproveLowRisk,review.trustedSourceToolNames`
      );
      const settingsPayload = await settingsResponse.json();

      expect(settingsResponse.status).toBe(200);
      expect(settingsPayload.data.values["review.autoApproveLowRisk"]).toBeUndefined();
      expect(settingsPayload.data.values["review.trustedSourceToolNames"]).toEqual(["codex"]);
    } finally {
      await new Promise<void>((resolve, reject) => second.server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("service index", () => {
  it("returns a discoverable root index for external agents", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);

    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data.service.name).toBe("RecallX");
      expect(body.data.service.baseUrl).toContain(`/api/v1`);
      expect(body.data.startHere.some((item: { path: string }) => item.path === "/api/v1/health")).toBe(true);
      expect(body.data.endpoints.some((item: { path: string }) => item.path === "/api/v1/nodes/search")).toBe(true);
      expect(body.data.cli.examples.some((example: string) => example.includes("recallx search"))).toBe(true);
      expect(body.data.mcp.command).toBe("node dist/server/app/mcp/index.js");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("health auto recompute status", () => {
  it("surfaces pending auto-recompute state in health output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    repository.upsertBaseSettings({
      "relations.autoRecompute.enabled": true,
      "relations.autoRecompute.eventThreshold": 99,
      "relations.autoRecompute.debounceMs": 60_000,
      "relations.autoRecompute.maxStalenessMs": 60_000,
      "relations.autoRecompute.batchLimit": 100,
      "relations.autoRecompute.lastRunAt": null
    });
    const source = {
      actorType: "agent" as const,
      actorLabel: "Codex",
      toolName: "codex"
    };
    const fromNode = repository.createNode({
      type: "project",
      title: "Health target",
      body: "Target project",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const toNode = repository.createNode({
      type: "note",
      title: "Health related",
      body: "Related note",
      tags: [],
      source,
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const relation = repository.upsertInferredRelation({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      relationType: "supports",
      baseScore: 0.4,
      usageScore: 0,
      finalScore: 0.4,
      status: "active",
      generator: "deterministic-linker",
      evidence: {},
      metadata: {}
    });
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

      await fetch(`${baseUrl}/relation-usage-events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          relationId: relation.id,
          relationSource: "inferred",
          eventType: "bundle_included",
          delta: 0.05,
          source,
          metadata: {}
        })
      });

      const healthResponse = await fetch(`${baseUrl}/health`);
      const healthBody = await healthResponse.json();

      expect(healthResponse.status).toBe(200);
      expect(healthBody.data.autoRecompute.pendingEventCount).toBe(1);
      expect(healthBody.data.autoRecompute.pendingRelationCount).toBe(1);
      expect(healthBody.data.autoRecompute.running).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("renderer package serving", () => {
  it("serves the renderer bundle from / when a renderer dist path is configured", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    const rendererRoot = mkdtempSync(path.join(tmpdir(), "recallx-renderer-test-"));
    tempRoots.push(root, rendererRoot);
    mkdirSync(path.join(rendererRoot, "assets"), { recursive: true });
    writeFileSync(path.join(rendererRoot, "index.html"), "<!doctype html><html><head><title>RecallX</title></head><body>Renderer bundle</body></html>");
    writeFileSync(path.join(rendererRoot, "assets", "app.js"), "console.log('recallx renderer');");

    const previousRendererDistPath = process.env.RECALLX_RENDERER_DIST_PATH;
    process.env.RECALLX_RENDERER_DIST_PATH = rendererRoot;

    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const rootResponse = await fetch(`http://127.0.0.1:${address.port}/`);
      const assetResponse = await fetch(`http://127.0.0.1:${address.port}/assets/app.js`);

      expect(rootResponse.status).toBe(200);
      expect(await rootResponse.text()).toContain("<title>RecallX</title>");
      expect(assetResponse.status).toBe(200);
      expect(await assetResponse.text()).toContain("recallx renderer");
    } finally {
      if (previousRendererDistPath === undefined) {
        delete process.env.RECALLX_RENDERER_DIST_PATH;
      } else {
        process.env.RECALLX_RENDERER_DIST_PATH = previousRendererDistPath;
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("returns a headless runtime notice at / when no renderer bundle is available", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recallx-test-"));
    tempRoots.push(root);
    const previousRendererDistPath = process.env.RECALLX_RENDERER_DIST_PATH;
    process.env.RECALLX_RENDERER_DIST_PATH = path.join(root, "missing-renderer");

    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createRecallXApp({
      workspaceSessionManager,
      apiToken: null,
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("headless runtime");
      expect(body).toContain("/api/v1");
    } finally {
      if (previousRendererDistPath === undefined) {
        delete process.env.RECALLX_RENDERER_DIST_PATH;
      } else {
        process.env.RECALLX_RENDERER_DIST_PATH = previousRendererDistPath;
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
