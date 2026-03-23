import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RecallXApiError } from "../app/mcp/api-client.js";
import { createRecallXMcpServer } from "../app/mcp/server.js";

describe("RecallX MCP server", () => {
  const cleanup: Array<() => Promise<void>> = [];

  function findToolDescription(toolList: { tools: Array<{ name: string; description?: string }> }, name: string) {
    const tool = toolList.tools.find((candidate) => candidate.name === name);
    expect(tool).toBeDefined();
    return tool?.description ?? "";
  }

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
  }, options?: {
    getObservabilityState?: () => {
      enabled: boolean;
      workspaceRoot: string;
      workspaceName: string;
      retentionDays: number;
      slowRequestMs: number;
      capturePayloadShape: boolean;
    } | Promise<{
      enabled: boolean;
      workspaceRoot: string;
      workspaceName: string;
      retentionDays: number;
      slowRequestMs: number;
      capturePayloadShape: boolean;
    }>;
  }) {
    const server = createRecallXMcpServer({
      apiClient: {
        get: apiClient?.get ?? vi.fn(),
        post: apiClient?.post ?? vi.fn(),
        patch: vi.fn()
      },
      getObservabilityState: options?.getObservabilityState
    });
    const client = new Client({
      name: "recallx-mcp-test-client",
      version: "1.0.0"
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanup.push(async () => {
      await Promise.all([client.close(), server.close()]);
    });

    return { client };
  }

  it("advertises the first-pass RecallX tools", async () => {
    const { client } = await connectTestClient();

    const toolList = await client.listTools();
    const toolNames = toolList.tools.map((tool) => tool.name);

    expect(toolNames).toContain("recallx_health");
    expect(toolNames).toContain("recallx_workspace_current");
    expect(toolNames).toContain("recallx_semantic_status");
    expect(toolNames).toContain("recallx_semantic_issues");
    expect(toolNames).toContain("recallx_search_nodes");
    expect(toolNames).toContain("recallx_search_activities");
    expect(toolNames).toContain("recallx_search_workspace");
    expect(toolNames).toContain("recallx_capture_memory");
    expect(toolNames).toContain("recallx_append_activity");
    expect(toolNames).toContain("recallx_create_node");
    expect(toolNames).toContain("recallx_create_nodes");
    expect(toolNames).toContain("recallx_upsert_inferred_relation");
    expect(toolNames).toContain("recallx_append_relation_usage_event");
    expect(toolNames).toContain("recallx_append_search_feedback");
    expect(toolNames).toContain("recallx_recompute_inferred_relations");
    expect(toolNames).toContain("recallx_list_governance_issues");
    expect(toolNames).toContain("recallx_get_governance_state");
    expect(toolNames).toContain("recallx_recompute_governance");
    expect(toolNames).toContain("recallx_context_bundle");
    expect(toolNames).toContain("recallx_semantic_reindex");
    expect(toolNames).toContain("recallx_semantic_reindex_node");
    expect(toolNames).toContain("recallx_rank_candidates");
  });

  it("advertises workspace, project, search, and bundle guidance in tool descriptions", async () => {
    const { client } = await connectTestClient();

    const toolList = await client.listTools();

    expect(findToolDescription(toolList, "recallx_workspace_current")).toContain("default workspace scope");
    expect(findToolDescription(toolList, "recallx_workspace_current")).toContain("switching workspaces");

    expect(findToolDescription(toolList, "recallx_workspace_create")).toContain("user explicitly requests");
    expect(findToolDescription(toolList, "recallx_workspace_open")).toContain("user explicitly requests");

    expect(findToolDescription(toolList, "recallx_search_workspace")).toContain("preferred broad entry point");
    expect(findToolDescription(toolList, "recallx_search_workspace")).toContain("current workspace");
    expect(findToolDescription(toolList, "recallx_search_workspace")).toContain('["nodes", "activities"]');
    expect(findToolDescription(toolList, "recallx_search_workspace")).toContain('comma-separated string like `"nodes,activities"`');

    expect(findToolDescription(toolList, "recallx_search_nodes")).toContain("type=project");
    expect(findToolDescription(toolList, "recallx_search_nodes")).toContain("current workspace");

    expect(findToolDescription(toolList, "recallx_search_activities")).toContain("recent logs");
    expect(findToolDescription(toolList, "recallx_search_activities")).toContain("what happened recently");

    expect(findToolDescription(toolList, "recallx_create_node")).toContain("project node in the current workspace");
    expect(findToolDescription(toolList, "recallx_create_node")).toContain("only create one if no suitable project already exists");

    expect(findToolDescription(toolList, "recallx_capture_memory")).toContain("default write");
    expect(findToolDescription(toolList, "recallx_capture_memory")).toContain("workspace scope");

    expect(findToolDescription(toolList, "recallx_append_activity")).toContain("specific RecallX node or project timeline");
    expect(findToolDescription(toolList, "recallx_append_activity")).toContain("workspace-scope updates");

    expect(findToolDescription(toolList, "recallx_context_bundle")).toContain("workspace-entry bundle");
    expect(findToolDescription(toolList, "recallx_context_bundle")).toContain("project or node should anchor the context");
  });

  it("maps search tool calls onto the RecallX HTTP API contract", async () => {
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
      name: "recallx_search_nodes",
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

  it("allows recallx_health calls with an optional input object and preserves detailed health payloads", async () => {
    const healthGet = vi.fn().mockResolvedValue({
      status: "ok",
      workspaceLoaded: true,
      workspaceRoot: "/Users/test/.recallx/RecallX",
      schemaVersion: 7,
      autoRecompute: {
        enabled: true
      }
    });
    const { client } = await connectTestClient({
      get: healthGet
    });

    const result = await client.callTool({
      name: "recallx_health",
      arguments: {
        includeDetails: true
      }
    });

    expect(healthGet).toHaveBeenCalledWith("/health");
    expect("structuredContent" in result && result.structuredContent).toMatchObject({
      status: "ok",
      autoRecompute: {
        enabled: true
      }
    });
  });

  it("rejects empty search queries by default at the MCP layer", async () => {
    const searchPost = vi.fn().mockResolvedValue({
      items: [],
      total: 0
    });
    const { client } = await connectTestClient({
      post: searchPost
    });

    const result = await client.callTool({
      name: "recallx_search_workspace",
      arguments: {}
    });
    const resultContent = Array.isArray((result as { content?: unknown }).content)
      ? ((result as { content: Array<{ type?: string; text?: string }> }).content)
      : [];

    expect("isError" in result && result.isError).toBe(true);
    expect(resultContent[0]?.text ?? "").toContain("allowEmptyQuery: true");
    expect(searchPost).not.toHaveBeenCalled();
  });

  it("allows browse-style empty queries when allowEmptyQuery is true", async () => {
    const searchPost = vi.fn().mockResolvedValue({
      items: [],
      total: 0
    });
    const { client } = await connectTestClient({
      post: searchPost
    });

    await client.callTool({
      name: "recallx_search_nodes",
      arguments: {
        allowEmptyQuery: true
      }
    });

    expect(searchPost).toHaveBeenCalledWith(
      "/nodes/search",
      expect.objectContaining({
        query: "",
        sort: "relevance"
      })
    );
  });

  it("refreshes observability state for each tool call", async () => {
    const searchPost = vi.fn().mockResolvedValue({
      items: [],
      total: 0
    });
    const getObservabilityState = vi
      .fn()
      .mockResolvedValueOnce({
        enabled: true,
        workspaceRoot: "/tmp/workspace-a",
        workspaceName: "Workspace A",
        retentionDays: 14,
        slowRequestMs: 250,
        capturePayloadShape: true
      })
      .mockResolvedValueOnce({
        enabled: true,
        workspaceRoot: "/tmp/workspace-b",
        workspaceName: "Workspace B",
        retentionDays: 14,
        slowRequestMs: 250,
        capturePayloadShape: true
      });
    const { client } = await connectTestClient(
      {
        post: searchPost
      },
      {
        getObservabilityState
      }
    );

    await client.callTool({
      name: "recallx_search_nodes",
      arguments: {
        query: "first"
      }
    });
    await client.callTool({
      name: "recallx_search_nodes",
      arguments: {
        query: "second"
      }
    });

    expect(getObservabilityState).toHaveBeenCalledTimes(2);
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
      name: "recallx_search_nodes",
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
      name: "recallx_search_nodes",
      arguments: {
        limit: "1e3"
      }
    });

    expect("isError" in result && result.isError).toBe(true);
    expect(searchPost).not.toHaveBeenCalled();
  });

  it("maps activity and workspace search tools onto the RecallX HTTP API contract", async () => {
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
      name: "recallx_search_activities",
      arguments: {
        query: "what changed",
        filters: {
          activityTypes: ["agent_run_summary"]
        }
      }
    });

    await client.callTool({
      name: "recallx_search_workspace",
      arguments: {
        query: "cleanup",
        scopes: ["activities"],
        sort: "smart"
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
        sort: "smart"
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
      name: "recallx_search_activities",
      arguments: {
        query: "what changed",
        activityType: "agent_run_summary",
        targetNodeId: "node_1",
        limit: "3"
      }
    });

    await client.callTool({
      name: "recallx_search_workspace",
      arguments: {
        query: "cleanup",
        scope: "nodes,activities",
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
        scopes: ["nodes", "activities"],
        limit: 4
      })
    );
  });

  it("returns a targeted validation hint when node search receives activity as a type", async () => {
    const { client } = await connectTestClient({
      post: vi.fn()
    });

    const result = await client.callTool({
      name: "recallx_search_nodes",
      arguments: {
        type: "activity"
      }
    });
    const resultContent = Array.isArray((result as { content?: unknown }).content)
      ? ((result as { content: Array<{ type?: string; text?: string }> }).content)
      : [];

    expect("isError" in result && result.isError).toBe(true);
    expect(resultContent[0]?.type).toBe("text");
    expect(resultContent[0]?.text ?? "").toContain("recallx_search_activities");
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
      name: "recallx_create_node",
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
          actorLabel: "RecallX MCP",
          toolName: "recallx-mcp"
        })
      })
    );
  });

  it("fills default provenance for each item when create_nodes omits source", async () => {
    const createPost = vi.fn().mockResolvedValue({
      items: [],
      summary: {
        requestedCount: 2,
        successCount: 2,
        errorCount: 0
      }
    });
    const { client } = await connectTestClient({
      post: createPost
    });

    await client.callTool({
      name: "recallx_create_nodes",
      arguments: {
        nodes: [
          {
            type: "note",
            title: "Batch node one"
          },
          {
            type: "project",
            title: "Batch node two",
            tags: ["batch"]
          }
        ]
      }
    });

    expect(createPost).toHaveBeenCalledWith("/nodes/batch", {
      nodes: [
        expect.objectContaining({
          type: "note",
          title: "Batch node one",
          body: "",
          tags: [],
          metadata: {},
          source: expect.objectContaining({
            actorType: "agent",
            actorLabel: "RecallX MCP",
            toolName: "recallx-mcp"
          })
        }),
        expect.objectContaining({
          type: "project",
          title: "Batch node two",
          body: "",
          tags: ["batch"],
          metadata: {},
          source: expect.objectContaining({
            actorType: "agent",
            actorLabel: "RecallX MCP",
            toolName: "recallx-mcp"
          })
        })
      ]
    });
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
      name: "recallx_append_activity",
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
          actorLabel: "RecallX MCP",
          toolName: "recallx-mcp"
        })
      })
    );
  });

  it("maps capture_memory onto the RecallX HTTP API contract", async () => {
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
      name: "recallx_capture_memory",
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
          actorLabel: "RecallX MCP",
          toolName: "recallx-mcp"
        })
      })
    );
  });

  it("adds a capture hint when create_node is rejected as short log-like content", async () => {
    const { client } = await connectTestClient({
      post: vi.fn().mockRejectedValue(
        new RecallXApiError("Short log-like agent output must be appended as activity, not stored as a durable node.", {
          status: 403,
          code: "FORBIDDEN"
        })
      )
    });

    const result = await client.callTool({
      name: "recallx_create_node",
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
    expect(resultContent[0]?.text ?? "").toContain("recallx_capture_memory");
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
      name: "recallx_append_search_feedback",
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
          actorLabel: "RecallX MCP",
          toolName: "recallx-mcp"
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
      name: "recallx_get_related",
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
      name: "recallx_semantic_status",
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
      name: "recallx_semantic_issues",
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

  it("maps inferred relation writes onto the RecallX HTTP API contract", async () => {
    const postMock = vi.fn().mockResolvedValue({
      relation: {
        id: "irel_1"
      }
    });
    const { client } = await connectTestClient({
      post: postMock
    });

    await client.callTool({
      name: "recallx_upsert_inferred_relation",
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
      name: "recallx_recompute_inferred_relations",
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
      name: "recallx_semantic_reindex",
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
      name: "recallx_semantic_reindex_node",
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
      name: "recallx_rank_candidates",
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
      name: "recallx_context_bundle",
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

  it("allows workspace-entry context bundles without a target id", async () => {
    const postMock = vi.fn().mockResolvedValue({
      bundle: {
        target: {
          type: "workspace",
          id: "workspace",
          title: "Workspace context"
        },
        mode: "compact",
        preset: "for-assistant",
        summary: "Recent workspace context.",
        items: [],
        activityDigest: [],
        decisions: [],
        openQuestions: [],
        sources: []
      }
    });
    const { client } = await connectTestClient({
      post: postMock
    });

    await client.callTool({
      name: "recallx_context_bundle",
      arguments: {
        mode: "compact",
        preset: "for-assistant"
      }
    });

    expect(postMock).toHaveBeenCalledWith(
      "/context/bundles",
      expect.not.objectContaining({
        target: expect.anything()
      })
    );
  });

  it("normalizes mode and preset aliases for context bundles and candidate ranking", async () => {
    const postMock = vi.fn().mockResolvedValue({
      bundle: {
        target: {
          type: "workspace",
          id: "workspace",
          title: "Workspace context"
        },
        mode: "compact",
        preset: "for-coding",
        summary: "Recent workspace context.",
        items: [],
        activityDigest: [],
        decisions: [],
        openQuestions: [],
        sources: []
      },
      items: []
    });
    const { client } = await connectTestClient({
      post: postMock
    });

    await client.callTool({
      name: "recallx_context_bundle",
      arguments: {
        mode: "small",
        preset: "coding"
      }
    });

    await client.callTool({
      name: "recallx_rank_candidates",
      arguments: {
        query: "agent integration",
        candidateNodeIds: ["node_a"],
        preset: "assistant"
      }
    });

    expect(postMock).toHaveBeenNthCalledWith(
      1,
      "/context/bundles",
      expect.objectContaining({
        mode: "micro",
        preset: "for-coding"
      })
    );
    expect(postMock).toHaveBeenNthCalledWith(
      2,
      "/retrieval/rank-candidates",
      expect.objectContaining({
        preset: "for-assistant"
      })
    );
  });

  it("shows actionable hints for unsupported context bundle mode and preset values", async () => {
    const { client } = await connectTestClient({
      post: vi.fn()
    });

    const result = await client.callTool({
      name: "recallx_context_bundle",
      arguments: {
        mode: "enormous",
        preset: "banana"
      }
    });
    const resultContent = Array.isArray((result as { content?: unknown }).content)
      ? ((result as { content: Array<{ type?: string; text?: string }> }).content)
      : [];
    const errorText = resultContent[0]?.text ?? "";

    expect("isError" in result && result.isError).toBe(true);
    expect(errorText).toContain("Unsupported mode 'enormous'");
    expect(errorText).toContain("small -> micro");
    expect(errorText).toContain("Unsupported preset 'banana'");
    expect(errorText).toContain("coding -> for-coding");
  });
});
