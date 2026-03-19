import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemforgeApp } from "../app/server/app.js";
import { createServerConfig } from "../app/server/config.js";
import { openDatabase } from "../app/server/db.js";
import { applyReviewDecision } from "../app/server/governance.js";
import { MemforgeRepository } from "../app/server/repositories.js";
import { isPathWithinRoot } from "../app/server/utils.js";
import { ensureWorkspace } from "../app/server/workspace.js";
import { WorkspaceSessionManager } from "../app/server/workspace-session.js";

const tempRoots: string[] = [];

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
  tempRoots.push(root);
  const workspace = ensureWorkspace(root);
  const db = openDatabase(workspace);
  const repository = new MemforgeRepository(db, root);
  repository.upsertBaseSettings({
    "workspace.name": "Memforge Test"
  });
  return repository;
}

function createWorkspaceSessionManager(root: string, authMode: "optional" | "bearer" = "optional") {
  return new WorkspaceSessionManager(
    {
      ...createServerConfig(root),
      port: 8787,
      bindAddress: "127.0.0.1",
      apiToken: authMode === "bearer" ? "secret-token" : null,
      workspaceName: "Memforge Test",
    },
    root,
    authMode,
  );
}

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
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
        toolName: "memforge-test"
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
});

describe("review provenance", () => {
  it("records provenance on the node when a review approval mutates it", () => {
    const repository = createRepository();
    const node = repository.createNode({
      type: "note",
      title: "Suggested memory note",
      body: "Original suggested content",
      tags: ["memory"],
      source: {
        actorType: "agent",
        actorLabel: "Codex",
        toolName: "codex"
      },
      metadata: {},
      resolvedCanonicality: "suggested",
      resolvedStatus: "review"
    });
    const review = repository.createReviewItem({
      entityType: "node",
      entityId: node.id,
      reviewType: "node_promotion",
      proposedBy: "Codex",
      notes: "Needs approval"
    });

    applyReviewDecision(repository, review.id, "edit-and-approve", {
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "memforge-test"
      },
      patch: {
        body: "Edited canonical content"
      }
    });

    const provenance = repository.listProvenance("node", node.id).map((item) => item.operationType);
    expect(provenance).toContain("update");
    expect(provenance).toContain("promote");
  });
});

describe("node update behavior", () => {
  it("preserves curated summaries on unrelated PATCH updates and records provenance", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
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
        toolName: "memforge-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const app = createMemforgeApp({
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
            toolName: "memforge-test"
          }
        })
      });
      const body = await response.json();
      const provenance = repository.listProvenance("node", node.id);

      expect(response.status).toBe(200);
      expect(body.data.node.summary).toBe("Hand-written retrieval summary");
      expect(body.data.node.tags).toEqual(["updated"]);
      expect(provenance.some((item) => item.operationType === "update")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("marks curated summaries stale after body edits and refreshes them on demand", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
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
        toolName: "memforge-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const app = createMemforgeApp({
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
        toolName: "memforge-test"
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

describe("review queue filtering", () => {
  it("filters review items by review type", () => {
    const repository = createRepository();
    repository.createReviewItem({
      entityType: "node",
      entityId: "node_one",
      reviewType: "node_promotion",
      proposedBy: "Codex",
      notes: "Promote note"
    });
    repository.createReviewItem({
      entityType: "relation",
      entityId: "rel_one",
      reviewType: "relation_suggestion",
      proposedBy: "Codex",
      notes: "Review relation"
    });

    const filtered = repository.listReviewItems("pending", 20, "node_promotion");

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
      toolName: "memforge-test"
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
      toolName: "memforge-test"
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
      toolName: "memforge-test"
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

describe("relation usage events", () => {
  it("appends and lists usage events in reverse chronological order", async () => {
    const repository = createRepository();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "memforge-test"
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
    expect(listed[0]?.toolName).toBe("memforge-test");
  });
});

describe("inferred relation maintenance", () => {
  it("recomputes usage_score and final_score from usage events", () => {
    const repository = createRepository();
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "memforge-test"
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
      toolName: "memforge-test"
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

  it("auto-recomputes after enough usage events and a short debounce", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
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
    const app = createMemforgeApp({
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
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
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

    const app = createMemforgeApp({
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
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    repository.setSetting("relations.autoRecompute.batchLimit", 2);
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "memforge-test"
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

    const app = createMemforgeApp({
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
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "memforge-test"
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

    const app = createMemforgeApp({
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
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
        toolName: "memforge-test",
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
      const inferred = repository.listInferredRelationsForNode(noteId, 10);
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
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
        toolName: "memforge-test",
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
      const inferred = repository.listInferredRelationsForNode(noteBId, 20);

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
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
        toolName: "memforge-test",
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
      const inferred = repository.listInferredRelationsForNode(noteBId, 20);

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
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
        toolName: "memforge-test",
      };

      const targetResponse = await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Runtime Notes",
          body: "Operational notes",
          tags: [],
          metadata: {},
          source,
        }),
      });
      const targetId = (await targetResponse.json()).data.node.id as string;

      const relatedResponse = await fetch(`${baseUrl}/nodes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "note",
          title: "Deployment Checklist",
          body: "Restart steps",
          tags: [],
          metadata: {},
          source,
        }),
      });
      const relatedId = (await relatedResponse.json()).data.node.id as string;

      await fetch(`${baseUrl}/activities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetNodeId: targetId,
          activityType: "agent_run_summary",
          body: "Follow Deployment Checklist after the restart.",
          metadata: {},
          source,
        }),
      });

      const repository = workspaceSessionManager.getCurrent().repository;
      const inferred = repository.listInferredRelationsForNode(targetId, 10);

      expect(inferred.some((item) => item.generator === "deterministic-activity-reference")).toBe(true);
      expect(inferred.some((item) => item.fromNodeId === relatedId || item.toNodeId === relatedId)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("expires stale auto-generated links when deterministic signals disappear", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
        toolName: "memforge-test",
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
      const activeBefore = repository.listInferredRelationsForNode(relatedNode.id, 10);
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

      const refreshed = repository.getInferredRelation(autoRelation.id);

      expect(updateResponse.status).toBe(200);
      expect(refreshed.status).toBe("expired");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("backfills deterministic inferred links across existing workspace nodes through reindex", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const repository = workspaceSessionManager.getCurrent().repository;
    const source = {
      actorType: "human" as const,
      actorLabel: "juhwan",
      toolName: "memforge-test",
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
    const app = createMemforgeApp({
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
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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

      const bundleResponse = await fetch(`${baseUrl}/context/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: {
            type: "node",
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
      expect(neighborhoodBody.data.items).toHaveLength(1);
      expect(neighborhoodBody.data.items[0]?.edge.relationSource).toBe("inferred");
      expect(neighborhoodBody.data.items[0]?.edge.relationScore).toBe(0.76);
      expect(bundleResponse.status).toBe(200);
      expect(bundleBody.data.bundle.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: relatedNode.id,
            relationSource: "inferred",
            relationType: "supports",
            relationScore: 0.76,
          }),
        ])
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("accepts relation usage events through the HTTP API", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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

  it("uses relation usage events to reorder inferred neighborhood items", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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

  it("recomputes inferred relation scores through the HTTP API", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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

describe("bootstrap auth metadata", () => {
  it("keeps bootstrap public without leaking the bearer token", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root, "bearer");
    const app = createMemforgeApp({
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
      expect(bootstrapBody.data.autoRecompute.enabled).toBe(true);
      expect(typeof bootstrapBody.data.autoRecompute.pendingEventCount).toBe("number");
      expect(searchResponse.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("browser origin hardening", () => {
  it("rejects non-loopback browser origins and only reflects local dev origins", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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

  it("allows loopback event streams without query tokens in bearer mode", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root, "bearer");
    const app = createMemforgeApp({
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

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      await response.body?.cancel();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("artifact path hardening", () => {
  it("rejects artifact registration outside the workspace root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
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
        toolName: "memforge-test"
      },
      metadata: {},
      resolvedCanonicality: "canonical",
      resolvedStatus: "active"
    });
    const app = createMemforgeApp({
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
            toolName: "memforge-test"
          },
          metadata: {}
        })
      });

      expect(response.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("treats sibling directories as outside the workspace boundary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
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
    const rootA = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    const rootB = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(rootA, rootB);

    const workspaceSessionManager = createWorkspaceSessionManager(rootA);
    const app = createMemforgeApp({
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
        toolName: "memforge-test",
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
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
          toolName: "memforge-test",
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
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
          body: "This is a longer note body that should land as append-only active content rather than review because it is low-risk project context. ".repeat(30),
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
      expect(payload.data.reviewItem).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("keeps durable agent notes in the review flow", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
          body: "This is a longer durable note body that should remain in review because it is intended for reuse across future sessions and tools. ".repeat(30),
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
      expect(payload.data.node.status).toBe("review");
      expect(payload.data.reviewItem.reviewType).toBe("node_promotion");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("lets trusted source tool names bypass review for durable notes and relations", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
          body: "This durable note should skip review because its toolName is in the trusted source list. ".repeat(30),
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
      expect(nodePayload.data.node.canonicality).toBe("appended");
      expect(nodePayload.data.node.status).toBe("active");
      expect(nodePayload.data.reviewItem).toBeNull();

      expect(relationResponse.status).toBe(201);
      expect(relationPayload.data.relation.status).toBe("active");
      expect(relationPayload.data.reviewItem).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("lets trusted source tool names bypass review for decisions", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);
    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
          body: "Trusted source decisions should bypass review under the workspace trusted-source policy.",
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
      expect(payload.data.reviewItem).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("preserves trusted source settings across server reopen", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);

    const openServer = async () => {
      const workspaceSessionManager = createWorkspaceSessionManager(root);
      const app = createMemforgeApp({
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
      expect(settingsPayload.data.values["review.autoApproveLowRisk"]).toBe(true);
      expect(settingsPayload.data.values["review.trustedSourceToolNames"]).toEqual(["codex"]);
    } finally {
      await new Promise<void>((resolve, reject) => second.server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("service index", () => {
  it("returns a discoverable root index for external agents", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
    tempRoots.push(root);

    const workspaceSessionManager = createWorkspaceSessionManager(root);
    const app = createMemforgeApp({
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
      expect(body.data.service.name).toBe("Memforge");
      expect(body.data.service.baseUrl).toContain(`/api/v1`);
      expect(body.data.startHere.some((item: { path: string }) => item.path === "/api/v1/health")).toBe(true);
      expect(body.data.endpoints.some((item: { path: string }) => item.path === "/api/v1/nodes/search")).toBe(true);
      expect(body.data.cli.examples.some((example: string) => example.includes("pnw search"))).toBe(true);
      expect(body.data.mcp.command).toBe("node dist/server/app/mcp/index.js");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("health auto recompute status", () => {
  it("surfaces pending auto-recompute state in health output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memforge-test-"));
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
    const app = createMemforgeApp({
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
