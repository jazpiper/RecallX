import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
    expect(toolNames).toContain("memforge_search_nodes");
    expect(toolNames).toContain("memforge_append_activity");
    expect(toolNames).toContain("memforge_create_node");
    expect(toolNames).toContain("memforge_upsert_inferred_relation");
    expect(toolNames).toContain("memforge_append_relation_usage_event");
    expect(toolNames).toContain("memforge_recompute_inferred_relations");
    expect(toolNames).toContain("memforge_review_decide");
    expect(toolNames).toContain("memforge_context_bundle");
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
});
