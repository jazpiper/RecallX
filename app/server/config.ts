import { randomBytes } from "node:crypto";
import type { WorkspaceInfo } from "../shared/types.js";
import { getSchemaVersion } from "./db.js";
import { defaultWorkspaceName } from "./workspace.js";

export interface ServerConfig {
  port: number;
  bindAddress: string;
  apiToken: string | null;
  workspaceName: string;
}

export function createServerConfig(workspaceRoot: string): ServerConfig {
  return {
    port: Number(process.env.RECALLX_PORT ?? 8787),
    bindAddress: process.env.RECALLX_BIND ?? "127.0.0.1",
    apiToken: process.env.RECALLX_API_TOKEN ?? null,
    workspaceName: process.env.RECALLX_WORKSPACE_NAME ?? defaultWorkspaceName(workspaceRoot)
  };
}

export function ensureApiToken(config: ServerConfig): string {
  if (config.apiToken) {
    return config.apiToken;
  }

  return randomBytes(24).toString("hex");
}

export function workspaceInfo(
  rootPath: string,
  config: ServerConfig,
  authMode: string,
  paths?: WorkspaceInfo["paths"],
  safety?: WorkspaceInfo["safety"],
): WorkspaceInfo {
  return {
    rootPath,
    workspaceName: config.workspaceName,
    schemaVersion: getSchemaVersion(),
    bindAddress: `${config.bindAddress}:${config.port}`,
    enabledIntegrationModes: ["read-only", "append-only"],
    authMode,
    paths,
    safety,
  };
}
