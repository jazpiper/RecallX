import { createServer } from "node:http";
import { createServerConfig, ensureApiToken } from "./config.js";
import { createRecallXApp, resolveRendererDistDir } from "./app.js";
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
const app = createRecallXApp({
  workspaceSessionManager,
  apiToken: config.apiToken ? apiToken : null
});

const server = createServer(app);

function shutdown() {
  try {
    workspaceSessionManager.shutdown();
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(config.port, config.bindAddress, () => {
  console.log(`RecallX API listening on http://${config.bindAddress}:${config.port}`);
  if (resolveRendererDistDir()) {
    console.log(`RecallX UI available at http://${config.bindAddress}:${config.port}/`);
  } else {
    console.log("Renderer bundle: not installed (headless mode)");
  }
  console.log(`Workspace root: ${workspaceSessionManager.getCurrent().workspaceRoot}`);
  if (!config.apiToken) {
    console.log("Auth mode: optional (set RECALLX_API_TOKEN to enforce bearer auth)");
  }
});
