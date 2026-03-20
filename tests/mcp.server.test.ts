import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemforgeApiError } from "../app/mcp/api-client.js";
import { createMemforgeMcpServer } from "../app/mcp/server.js";

describe("Memforge MCP server", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length) {
      const close = cleanup.pop();
      if (close) {
        await close();
      }
    }
  });

  async function connectTestClient(apiClient?: {
    get?: ReturnType<typeof vi.fn>;
    post?: ReturnType<typeof vi.fn>;
    patch?: ReturnType<typeof vi.fn>;
  }) {
    const server = createMemforgeMcpServer({
      apiClient: {
        get: apiClient?.get ?? vi.fn(),
        post: apiClient?.post ?? vi.fn(),
        patch: apiClient?.patch ?? vi.fn()
      }
    });
    const client = new Client({
      name: "memforge-mcp-test-client",
      version: "1.0.0"
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanup.push(async () => {
      await Promise.all([client.close(), server.close()]);
    });

    return { client };
  }

  it("advertises the first-pass Memforge tools", async () => {
    const { client } = await connectTestClient();

    const toolList = await client.listTools();
    const toolNames = toolList.tools.map((tool) => tool.name);

    expect(toolNames).toContain("memforge_health");
    expect(toolNames).toContain("memforge_workspace_current");
    expect(toolNames).toContain("memforge_semantic_status");
    expect(toolNames).toContain("memforge_semantic_issues");
    expect(toolNames).toContain("memforge_search_nodes");
    expect(toolNames).toContain("memforge_search_activities");
    expect(toolNames).toContain("memforge_search_workspace");
    expect(toolNames).toContain("memforge_capture_memory");
    expect(toolNames).toContain("memforge_append_activity");
    expect(toolNames).toContain("memforge_create_node");
    expect(toolNames).toContain("memforge_upsert_inferred_relation");
    expect(toolNames).toContain("memforge_append_relation_usage_event");
    expect(toolNames).toContain("memforge_append_search_feedback");
    expect(toolNames).toContain("memforge_recompute_inferred_relations");
    expect(toolNames).toContain("memforge_list_governance_issues");
    expect(toolNames).toContain("memforge_get_governance_state");
    expect(toolNames).toContain("memforge_recompute_governance");
    expect(toolNames).toContain("memforge_context_bundle");
    expect(toolNames).toContain("memforge_semantic_reindex");
    expect(toolNames).toContain("memforge_semantic_reindex_node");
    expect(toolNames).toContain("memforge_rank_candidates");
  });

  it("maps search tool calls onto the Memforge HTTP API contract", async () => {
    const searchPost = vi.fn().mockResolvedValue({
      items: [{ id: "node_1", title: "Agent memory", type: "note" }],
      total: 1,
      limit: 10,
      offset: 0
    });
    const { client } = await connectTestClient({
      post: searchPost
    });

    const result = await client.callTool({
      name: "memforge_search_nodes",
      arguments: {
        query: "agent memory"
      }
    });

    expect(searchPost).toHaveBeenCalledWith(
      "/nodes/search",
      expect.objectContaining({
        query: "agent memory",
        filters: {},
        limit: 10,
        offset: 0,
        sort: "relevance"
      })
    );
    expect("structuredContent" in result && result.structuredContent).toMatchObject({
      total: 1
    });
  });

  it("normalizes node search aliases before calling the HTTP API", async () => {
    const searchPost = vi.fn().mockResolvedValue({
      items: [],
      total: 0
    });
    const { client } = await connectTestClient({
      post: searchPost
    });

    await client.callTool({
      name: "memforge_search_nodes",
      arguments: {
        query: "agent memory",
        type: "note",
        status: "active",
        tag: "graph",
        limit: "5",
        offset: "2"
      }
    });

    expect(searchPost).toHaveBeenCalledWith(
      "/nodes/search",
      expect.objectContaining({
        filters: {
          types: ["note"],
          status: ["active"],
          sourceLabels: undefined,
          tags: ["graph"]
        },
        limit: 5,
        offset: 2
      })
    );
  });

  it("rejects malformed integer-like strings in search numeric arguments", async () => {
    const searchPost = vi.fn().mockResolvedValue({
      items: [],
      total: 0
    });
    const { client } = await connectTestClient({
      post: searchPost
    });

    const result = await client.callTool({
      name: "memforge_search_nodes",
      arguments: {
        limit: "1e3"
      }
    });

    expect("isError" in result && result.isError).toBe(true);
    expect(searchPost).not.toHaveBeenCalled();
  });

  it("maps activity and workspace search tools onto the Memforge HTTP API contract", async () => {
    const searchPost = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: "activity_1", targetNodeId: "node_1", activityType: "agent_run_summary" }],
        total: 1
      })
      .mockResolvedValueOnce({
        items: [{ resultType: "activity", activity: { id: "activity_1", targetNodeId: "node_1" } }],
        total: 1
      });
    const { client } = await connectTestClient({
      post: searchPost
    });

    await client.callTool({
      name: "memforge_search_activities",
      arguments: {
        query: "what changed",
        filters: {
          activityTypes: ["agent_run_summary"]
        }
      }
    });

    await client.callTool({
      name: "memforge_search_workspace",
      arguments: {
        query: "cleanup",
        scopes: ["activities"]
      }
    });

    expect(searchPost).toHaveBeenNthCalledWith(
      1,
      "/activities/search",
      expect.objectContaining({
        query: "what changed",
        filters: {
          activityTypes: ["agent_run_summary"]
        },
        limit: 10,
        offset: 0,
        sort: "relevance"
      })
    );
    expect(searchPost).toHaveBeenNthCalledWith(
      2,
      "/search",
      expect.objectContaining({
        query: "cleanup",
        scopes: ["activities"],
        limit: 10,
        offset: 0,
        sort: "relevance"
      })
    );
  });

  it("normalizes activity and workspace search aliases before calling the HTTP API", async () => {
    const searchPost = vi
      .fn()
      .mockResolvedValueOnce({
        items: [],
        total: 0
      })
      .mockResolvedValueOnce({
        items: [],
        total: 0
      });
    const { client } = await connectTestClient({
      post: searchPost
    });

    await client.callTool({
      name: "memforge_search_activities",
      arguments: {
        query: "what changed",
        activityType: "agent_run_summary",
        targetNodeId: "node_1",
        limit: "3"
      }
    });

    await client.callTool({
      name: "memforge_search_workspace",
      arguments: {
        query: "cleanup",
        scope: "activities",
        limit: "4"
      }
    });

    expect(searchPost).toHaveBeenNthCalledWith(
      1,
      "/activities/search",
      expect.objectContaining({
        filters: expect.objectContaining({
          targetNodeIds: ["node_1"],
          activityTypes: ["agent_run_summary"]
        }),
        limit: 3
      })
    );
    expect(searchPost).toHaveBeenNthCalledWith(
      2,
      "/search",
      expect.objectContaining({
        scopes: ["activities"],
        limit: 4
      })
    );
  });

  it("returns a targeted validation hint when node search receives activity as a type", async () => {
    const { client } = await connectTestClient({
      post: vi.fn()
    });

    const result = await client.callTool({
      name: "memforge_search_nodes",
      arguments: {
        type: "activity"
      }
    });
    const resultContent = Array.isArray((result as { content?: unknown }).content)
      ? ((result as { content: Array<{ type?: string; text?: string }> }).content)
      : [];

    expect("isError" in result && result.isError).toBe(true);
    expect(resultContent[0]?.type).toBe("text");
    expect(resultContent[0]?.text ?? "").toContain("memforge_search_activities");
  });

  it("fills default provenance when create_node omits source", async () => {
    const createPost = vi.fn().mockResolvedValue({
      node: {
        id: "node_1"
      },
      reviewItem: null
    });
    const { client } = await connectTestClient({
      post: createPost
    });

    await client.callTool({
      name: "memforge_create_node",
      arguments: {
        type: "note",
        title: "Captured from MCP"
      }
    });

    expect(createPost).toHaveBeenCalledWith(
      "/nodes",
      expect.objectContaining({
        type: "note",
        title: "Captured from MCP",
        body: "",
        tags: [],
        metadata: {},
        source: expect.objectContaining({
          actorType: "agent",
          actorLabel: "Memforge MCP",
          toolName: "memforge-mcp"
        })
      })
    );
  });

  it("fills default provenance when append_activity omits source", async () => {
    const appendPost = vi.fn().mockResolvedValue({
      activity: {
        id: "activity_1"
      },
      promotion: {}
    });
    const { client } = await connectTestClient({
      post: appendPost
    });

    await client.callTool({
      name: "memforge_append_activity",
      arguments: {
        targetNodeId: "node_1",
        activityType: "agent_run_summary",
        body: "Summarized the latest task outcome."
      }
    });

    expect(appendPost).toHaveBeenCalledWith(
      "/activities",
      expect.objectContaining({
        targetNodeId: "node_1",
        activityType: "agent_run_summary",
        body: "Summarized the latest task outcome.",
        metadata: {},
        source: expect.objectContaining({
          actorType: "agent",
          actorLabel: "Memforge MCP",
          toolName: "memforge-mcp"
        })
      })
    );
  });

  it("maps capture_memory onto the Memforge HTTP API contract", async () => {
    const capturePost = vi.fn().mockResolvedValue({
      storedAs: "activity",
      activity: {
        id: "activity_1"
      }
    });
    const { client } = await connectTestClient({
      post: capturePost
    });

    await client.callTool({
      name: "memforge_capture_memory",
      arguments: {
        body: "Finished wiring the MCP validation recovery path."
      }
    });

    expect(capturePost).toHaveBeenCalledWith(
      "/capture",
      expect.objectContaining({
        mode: "auto",
        body: "Finished wiring the MCP validation recovery path.",
        nodeType: "note",
        tags: [],
        metadata: {},
        source: expect.objectContaining({
          actorType: "agent",
          actorLabel: "Memforge MCP",
          toolName: "memforge-mcp"
        })
      })
    );
  });

  it("adds a capture hint when create_node is rejected as short log-like content", async () => {
    const { client } = await connectTestClient({
      post: vi.fn().mockRejectedValue(
        new MemforgeApiError("Short log-like agent output must be appended as activity, not stored as a durable node.", {
          status: 403,
          code: "FORBIDDEN"
        })
      )
    });

    const result = await client.callTool({
      name: "memforge_create_node",
      arguments: {
        type: "note",
        title: "Short update",
        body: "done"
      }
    });
    const resultContent = Array.isArray((result as { content?: unknown }).content)
      ? ((result as { content: Array<{ type?: string; text?: string }> }).content)
      : [];

    expect("isError" in result && result.isError).toBe(true);
    expect(resultContent[0]?.type).toBe("text");
    expect(resultContent[0]?.text ?? "").toContain("memforge_capture_memory");
  });

  it("fills default provenance when append_search_feedback omits source", async () => {
    const appendPost = vi.fn().mockResolvedValue({
      event: {
        id: "sfe_1"
      }
    });
    const { client } = await connectTestClient({
      post: appendPost
    });

    await client.callTool({
      name: "memforge_append_search_feedback",
      arguments: {
        resultType: "node",
        resultId: "node_1",
        verdict: "useful",
        query: "cleanup notes"
      }
    });

    expect(appendPost).toHaveBeenCalledWith(
      "/search-feedback-events",
      expect.objectContaining({
        resultType: "node",
        resultId: "node_1",
        verdict: "useful",
        query: "cleanup notes",
        confidence: 1,
        metadata: {},
        source: expect.objectContaining({
          actorType: "agent",
          actorLabel: "Memforge MCP",
          toolName: "memforge-mcp"
        })
      })
    );
  });

  it("routes get_related through the neighborhood endpoint with inferred options", async () => {
    const getMock = vi.fn().mockResolvedValue({
      items: []
    });
    const { client } = await connectTestClient({
      get: getMock
    });

    await client.callTool({
      name: "memforge_get_related",
      arguments: {
        nodeId: "node_1"
      }
    });

    expect(getMock).toHaveBeenCalledWith("/nodes/node_1/neighborhood?depth=1&include_inferred=1&max_inferred=4");
  });

  it("maps semantic status onto the semantic status endpoint", async () => {
    const getMock = vi.fn().mockResolvedValue({
      enabled: false,
      provider: "disabled",
      model: "none",
      chunkEnabled: false,
      lastBackfillAt: null,
      counts: {
        pending: 1,
        processing: 0,
        stale: 2,
        ready: 3,
        failed: 0
      }
    });
    const { client } = await connectTestClient({
      get: getMock
    });

    const result = await client.callTool({
      name: "memforge_semantic_status",
      arguments: {}
    });

    expect(getMock).toHaveBeenCalledWith("/semantic/status");
    expect("structuredContent" in result && result.structuredContent).toMatchObject({
      counts: {
        pending: 1,
        stale: 2,
        ready: 3
      }
    });
  });

  it("maps semantic issues onto the semantic issues endpoint", async () => {
    const getMock = vi.fn().mockResolvedValue({
      items: [
        {
          nodeId: "node_1",
          title: "Recovery checklist",
          embeddingStatus: "failed",
          staleReason: "embedding.provider_not_implemented:openai",
          updatedAt: "2026-03-19T04:00:00.000Z"
        }
      ],
      nextCursor: "cursor_1"
    });
    const { client } = await connectTestClient({
      get: getMock
    });

    const result = await client.callTool({
      name: "memforge_semantic_issues",
      arguments: {
        limit: 3,
        cursor: "cursor_0",
        statuses: ["failed"]
      }
    });

    expect(getMock).toHaveBeenCalledWith("/semantic/issues?limit=3&cursor=cursor_0&statuses=failed");
    expect("structuredContent" in result && result.structuredContent).toMatchObject({
      items: [
        {
          nodeId: "node_1",
          embeddingStatus: "failed",
          staleReason: "embedding.provider_not_implemented:openai"
        }
      ],
      nextCursor: "cursor_1"
    });
  });

  it("maps inferred relation writes onto the Memforge HTTP API contract", async () => {
    const postMock = vi.fn().mockResolvedValue({
      relation: {
        id: "irel_1"
      }
    });
    const { client } = await connectTestClient({
      post: postMock
    });

    await client.callTool({
      name: "memforge_upsert_inferred_relation",
      arguments: {
        fromNodeId: "node_a",
        toNodeId: "node_b",
        relationType: "supports",
        baseScore: 0.7,
        finalScore: 0.8,
        generator: "deterministic-linker"
      }
    });

    expect(postMock).toHaveBeenCalledWith(
      "/inferred-relations",
      expect.objectContaining({
        fromNodeId: "node_a",
        toNodeId: "node_b",
        relationType: "supports",
        baseScore: 0.7,
        usageScore: 0,
        finalScore: 0.8,
        status: "active",
        generator: "deterministic-linker",
        evidence: {},
        metadata: {}
      })
    );
  });

  it("maps inferred relation recompute onto the maintenance endpoint", async () => {
    const postMock = vi.fn().mockResolvedValue({
      updatedCount: 1,
      expiredCount: 0,
      items: []
    });
    const { client } = await connectTestClient({
      post: postMock
    });

    await client.callTool({
      name: "memforge_recompute_inferred_relations",
      arguments: {
        generator: "deterministic-linker",
        limit: 25
      }
    });

    expect(postMock).toHaveBeenCalledWith(
      "/inferred-relations/recompute",
      expect.objectContaining({
        generator: "deterministic-linker",
        limit: 25
      })
    );
  });

  it("maps semantic reindex onto the batch queue endpoint", async () => {
    const postMock = vi.fn().mockResolvedValue({
      queuedNodeIds: ["node_a", "node_b"],
      queuedCount: 2
    });
    const { client } = await connectTestClient({
      post: postMock
    });

    const result = await client.callTool({
      name: "memforge_semantic_reindex",
      arguments: {
        limit: 20
      }
    });

    expect(postMock).toHaveBeenCalledWith(
      "/semantic/reindex",
      expect.objectContaining({
        limit: 20
      })
    );
    expect("structuredContent" in result && result.structuredContent).toMatchObject({
      queuedCount: 2
    });
  });

  it("maps semantic node reindex onto the single-node queue endpoint", async () => {
    const postMock = vi.fn().mockResolvedValue({
      nodeId: "node target",
      queued: true
    });
    const { client } = await connectTestClient({
      post: postMock
    });

    const result = await client.callTool({
      name: "memforge_semantic_reindex_node",
      arguments: {
        nodeId: "node target"
      }
    });

    expect(postMock).toHaveBeenCalledWith("/semantic/reindex/node%20target", {});
    expect("structuredContent" in result && result.structuredContent).toMatchObject({
      nodeId: "node target",
      queued: true
    });
  });

  it("maps rank_candidates onto the retrieval ranking endpoint", async () => {
    const postMock = vi.fn().mockResolvedValue({
      items: [
        {
          nodeId: "node_b",
          score: 118.4,
          retrievalRank: 118.4
        }
      ]
    });
    const { client } = await connectTestClient({
      post: postMock
    });

    const result = await client.callTool({
      name: "memforge_rank_candidates",
      arguments: {
        query: "agent integration",
        candidateNodeIds: ["node_a", "node_b"],
        preset: "for-coding",
        targetNodeId: "node_target"
      }
    });

    expect(postMock).toHaveBeenCalledWith(
      "/retrieval/rank-candidates",
      expect.objectContaining({
        query: "agent integration",
        candidateNodeIds: ["node_a", "node_b"],
        preset: "for-coding",
        targetNodeId: "node_target"
      })
    );
    expect("structuredContent" in result && result.structuredContent).toMatchObject({
      items: [
        {
          nodeId: "node_b",
          score: 118.4,
          retrievalRank: 118.4
        }
      ]
    });
  });

  it("passes retrievalRank through context bundle structured content", async () => {
    const postMock = vi.fn().mockResolvedValue({
      bundle: {
        target: { type: "node", id: "node_1", title: "Target" },
        mode: "compact",
        preset: "for-assistant",
        summary: "Bundle summary",
        items: [
          {
            nodeId: "node_2",
            type: "note",
            title: "Related note",
            summary: "Related summary",
            reason: "Inferred via supports (score 0.82), usage +0.06",
            relationType: "supports",
            relationSource: "inferred",
            relationStatus: "active",
            relationScore: 0.82,
            retrievalRank: 0.89,
            semanticSimilarity: 0.31,
            generator: "deterministic-linker"
          }
        ],
        activityDigest: [],
        decisions: [],
        openQuestions: [],
        sources: []
      }
    });
    const { client } = await connectTestClient({
      post: postMock
    });

    const result = await client.callTool({
      name: "memforge_context_bundle",
      arguments: {
        targetId: "node_1",
        mode: "compact",
        preset: "for-assistant"
      }
    });

    expect(postMock).toHaveBeenCalledWith(
      "/context/bundles",
      expect.objectContaining({
        target: {
          id: "node_1"
        }
      })
    );
    expect("structuredContent" in result && result.structuredContent).toMatchObject({
      bundle: {
        items: [
          {
            nodeId: "node_2",
            relationScore: 0.82,
            retrievalRank: 0.89,
            semanticSimilarity: 0.31
          }
        ]
      }
    });
  });
});
