import { createServer } from "node:http";
import { createServerConfig, ensureApiToken } from "./config.js";
import { createMemforgeApp } from "./app.js";
import { resolveWorkspaceRoot } from "./workspace.js";
import { WorkspaceSessionManager } from "./workspace-session.js";

const workspaceRoot = resolveWorkspaceRoot();
const config = createServerConfig(workspaceRoot);
const apiToken = ensureApiToken(config);
const workspaceSessionManager = new WorkspaceSessionManager(
  config,
  workspaceRoot,
  config.apiToken ? "bearer" : "optional",
);
const app = createMemforgeApp({
  workspaceSessionManager,
  apiToken: config.apiToken ? apiToken : null
});

createServer(app).listen(config.port, config.bindAddress, () => {
  console.log(`Memforge API listening on http://${config.bindAddress}:${config.port}`);
  console.log(`Workspace root: ${workspaceSessionManager.getCurrent().workspaceRoot}`);
  if (!config.apiToken) {
    console.log("Auth mode: optional (set MEMFORGE_API_TOKEN to enforce bearer auth)");
  }
});
