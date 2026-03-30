import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecallXApp } from "../app/server/app.js";
import { createServerConfig } from "../app/server/config.js";
import { selectSemanticCandidateIds } from "../app/server/retrieval.js";
import { WorkspaceSessionManager } from "../app/server/workspace-session.js";

const tempRoots: string[] = [];

function createWorkspaceSessionManager(root: string) {
  return new WorkspaceSessionManager(
    {
      ...createServerConfig(root),
      port: 8787,
      bindAddress: "127.0.0.1",
      apiToken: null,
      workspaceName: "Retrieval Hotpath Test"
    },
    root,
    "optional"
  );
}

async function createTestServer() {
  const root = mkdtempSync(path.join(tmpdir(), "recallx-retrieval-hotpath-"));
  tempRoots.push(root);
  const workspaceSessionManager = createWorkspaceSessionManager(root);
  const repository = workspaceSessionManager.getCurrent().repository;
  const app = createRecallXApp({
    workspaceSessionManager,
    apiToken: null
  });
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }

  return {
    repository,
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`
  };
}

function createNode(
  repository: ReturnType<WorkspaceSessionManager["getCurrent"]>["repository"],
  title: string
) {
  return repository.createNode({
    type: "note",
    title,
    body: `${title} body`,
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
}

function createRelation(
  repository: ReturnType<WorkspaceSessionManager["getCurrent"]>["repository"],
  fromNodeId: string,
  toNodeId: string
) {
  return repository.createRelation({
    fromNodeId,
    toNodeId,
    relationType: "related_to",
    source: {
      actorType: "human",
      actorLabel: "juhwan",
      toolName: "recallx-test"
    },
    metadata: {},
    resolvedStatus: "active"
  });
}

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("retrieval hotpaths", () => {
  it("caps semantic prefilter candidates while preserving the strongest lexical match", () => {
    const candidates = Array.from({ length: 300 }, (_, index) => ({
      id: `node_${index}`,
      title: `Generic note ${index}`,
      summary: `Background context ${index}`,
      updatedAt: `2026-03-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`
    }));
    candidates[17] = {
      id: "semantic_best",
      title: "Graph memory retrieval architecture",
      summary: "Semantic retrieval candidate with an exact title hit",
      updatedAt: "2026-03-01T00:00:00.000Z"
    };

    const selected = selectSemanticCandidateIds("graph memory retrieval", candidates, 32);

    expect(selected).toHaveLength(32);
    expect(selected).toContain("semantic_best");
  });

  it("preserves separate second-hop entries for the same shared node via different first-hop nodes", async () => {
    const { repository, server, baseUrl } = await createTestServer();

    try {
      const focus = createNode(repository, "Focus");
      const viaA = createNode(repository, "Via A");
      const viaB = createNode(repository, "Via B");
      const shared = createNode(repository, "Shared");

      createRelation(repository, focus.id, viaA.id);
      createRelation(repository, focus.id, viaB.id);
      createRelation(repository, viaA.id, shared.id);
      createRelation(repository, viaB.id, shared.id);

      const response = await fetch(
        `${baseUrl}/nodes/${focus.id}/neighborhood?depth=2&include_inferred=0`
      );
      const body = await response.json() as {
        data: {
          items: Array<{
            node: { id: string };
            edge: { hop: number; relationId: string };
            viaNodeId?: string;
          }>;
        };
      };

      const sharedSecondHopItems = body.data.items.filter(
        (item) => item.node.id === shared.id && item.edge.hop === 2
      );

      expect(response.status).toBe(200);
      expect(sharedSecondHopItems).toHaveLength(2);
      expect(new Set(sharedSecondHopItems.map((item) => item.viaNodeId)).size).toBe(2);
      expect(sharedSecondHopItems.map((item) => item.viaNodeId).sort()).toEqual(
        [viaA.id, viaB.id].sort()
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
