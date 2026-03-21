import path from "node:path";
import { contextBridge, ipcRenderer } from "electron";

function readArgument(prefix: string): string | null {
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

const apiBase = readArgument("--memforge-api-base=") ?? "http://127.0.0.1:8788/api/v1";
const healthUrl = readArgument("--memforge-health-url=") ?? `${apiBase}/health`;
const workspaceHome = readArgument("--memforge-workspace-home=");
const workspaceRoot = readArgument("--memforge-workspace-root=");
const commandShimPath = readArgument("--memforge-command-shim-path=");
const mcpLauncherPath = readArgument("--memforge-mcp-launcher-path=");
const mcpCommand = readArgument("--memforge-mcp-command=");
const executablePath = readArgument("--memforge-app-executable=") ?? process.execPath;
const isPackaged = readArgument("--memforge-is-packaged=") === "1";
const appVersion = readArgument("--memforge-app-version=") ?? "1.0.0";

const desktopInfo = {
  apiBase,
  healthUrl,
  workspaceUrl: `${apiBase}/workspace`,
  workspaceHome,
  commandShimPath,
  executablePath,
  mcpLauncherPath,
  mcpCommand,
  workspaceRoot,
  workspaceDbPath: workspaceRoot ? path.join(workspaceRoot, "workspace.db") : null,
  artifactsPath: workspaceRoot ? path.join(workspaceRoot, "artifacts") : null,
  isPackaged,
  appVersion
};

contextBridge.exposeInMainWorld("__MEMFORGE_API_BASE__", apiBase);
contextBridge.exposeInMainWorld("__MEMFORGE_DESKTOP_INFO__", desktopInfo);
contextBridge.exposeInMainWorld("__MEMFORGE_DESKTOP_ACTIONS__", {
  getRuntimeState() {
    return ipcRenderer.invoke("memforge-desktop-runtime-state");
  },
  onAction(callback: (payload: { type: string }) => void) {
    const listener = (_event: unknown, payload: { type: string }) => {
      callback(payload);
    };
    ipcRenderer.on("memforge-desktop-action", listener);
    return () => {
      ipcRenderer.removeListener("memforge-desktop-action", listener);
    };
  }
});
