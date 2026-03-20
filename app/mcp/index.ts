#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemforgeMcpServer } from "./server.js";

async function requestJson(path: string) {
  const baseUrl = process.env.MEMFORGE_API_URL ?? "http://127.0.0.1:8787/api/v1";
  const url = new URL(path.replace(/^\/+/, ""), `${baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`}`);
  const headers = new Headers({
    accept: "application/json"
  });

  if (process.env.MEMFORGE_API_TOKEN) {
    headers.set("authorization", `Bearer ${process.env.MEMFORGE_API_TOKEN}`);
  }

  const response = await fetch(url, {
    method: "GET",
    headers
  });
  if (!response.ok) {
    throw new Error(`Failed to bootstrap MCP observability from ${url.toString()}: ${response.status}`);
  }

  return await response.json() as { data?: Record<string, any> };
}

async function resolveObservabilityState() {
  try {
    const [workspacePayload, settingsPayload] = await Promise.all([
      requestJson("/workspace"),
      requestJson(
        "/settings?keys=observability.enabled,observability.retentionDays,observability.slowRequestMs,observability.capturePayloadShape"
      )
    ]);
    const workspace = workspacePayload.data ?? {};
    const values = (settingsPayload.data?.values ?? {}) as Record<string, unknown>;

    return {
      enabled: values["observability.enabled"] === true,
      workspaceRoot: typeof workspace.rootPath === "string" ? workspace.rootPath : process.cwd(),
      workspaceName: typeof workspace.workspaceName === "string" ? workspace.workspaceName : "Memforge MCP",
      retentionDays: typeof values["observability.retentionDays"] === "number" ? values["observability.retentionDays"] : 14,
      slowRequestMs: typeof values["observability.slowRequestMs"] === "number" ? values["observability.slowRequestMs"] : 250,
      capturePayloadShape: values["observability.capturePayloadShape"] !== false
    };
  } catch {
    return {
      enabled: false,
      workspaceRoot: process.cwd(),
      workspaceName: "Memforge MCP",
      retentionDays: 14,
      slowRequestMs: 250,
      capturePayloadShape: true
    };
  }
}

function printHelp() {
  console.error(`Memforge MCP server

Usage:
  npm run mcp
  npm run dev:mcp
  node dist/server/app/mcp/index.js --api http://127.0.0.1:8787/api/v1

Environment:
  MEMFORGE_API_URL            Local Memforge API base URL (default: http://127.0.0.1:8787/api/v1)
  MEMFORGE_API_TOKEN          Optional bearer token for auth-enabled Memforge instances
  MEMFORGE_MCP_SOURCE_LABEL   Default provenance label for writes (default: Memforge MCP)
  MEMFORGE_MCP_TOOL_NAME      Default provenance tool name (default: memforge-mcp)
`);
}

function parseArgs(argv: string[]) {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (typeof args.api === "string") {
    process.env.MEMFORGE_API_URL = args.api;
  }
  if (typeof args["source-label"] === "string") {
    process.env.MEMFORGE_MCP_SOURCE_LABEL = args["source-label"];
  }
  if (typeof args["tool-name"] === "string") {
    process.env.MEMFORGE_MCP_TOOL_NAME = args["tool-name"];
  }

  const server = createMemforgeMcpServer({
    observabilityState: await resolveObservabilityState(),
    getObservabilityState: resolveObservabilityState
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Memforge MCP connected over stdio -> ${process.env.MEMFORGE_API_URL ?? "http://127.0.0.1:8787/api/v1"}`);
}

main().catch((error) => {
  console.error("Memforge MCP failed to start:", error);
  process.exit(1);
});
