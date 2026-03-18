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
    expect(toolNames).toContain("memforge_create_node");
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
});
