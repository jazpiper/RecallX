import { contextBridge, ipcRenderer } from "electron";

function readArgument(prefix: string): string | null {
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

const apiBase = readArgument("--recallx-api-base=") ?? "http://127.0.0.1:8788/api/v1";
const healthUrl = readArgument("--recallx-health-url=") ?? `${apiBase}/health`;
const workspaceHome = readArgument("--recallx-workspace-home=");
const workspaceRoot = readArgument("--recallx-workspace-root=");
const commandShimPath = readArgument("--recallx-command-shim-path=");
const mcpLauncherPath = readArgument("--recallx-mcp-launcher-path=");
const mcpCommand = readArgument("--recallx-mcp-command=");
const executablePath = readArgument("--recallx-app-executable=") ?? process.execPath;
const isPackaged = readArgument("--recallx-is-packaged=") === "1";
const appVersion = readArgument("--recallx-app-version=");

function joinWorkspacePath(root: string | null, child: string): string | null {
  if (!root) {
    return null;
  }

  return `${root.replace(/[\\/]+$/, "")}/${child}`;
}

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
  workspaceDbPath: joinWorkspacePath(workspaceRoot, "workspace.db"),
  artifactsPath: joinWorkspacePath(workspaceRoot, "artifacts"),
  isPackaged,
  appVersion: appVersion ?? undefined
};

contextBridge.exposeInMainWorld("__RECALLX_API_BASE__", apiBase);
contextBridge.exposeInMainWorld("__RECALLX_DESKTOP_INFO__", desktopInfo);
contextBridge.exposeInMainWorld("__RECALLX_DESKTOP_ACTIONS__", {
  getRuntimeState() {
    return ipcRenderer.invoke("recallx-desktop-runtime-state");
  },
  onAction(callback: (payload: { type: string }) => void) {
    const listener = (_event: unknown, payload: { type: string }) => {
      callback(payload);
    };
    ipcRenderer.on("recallx-desktop-action", listener);
    return () => {
      ipcRenderer.removeListener("recallx-desktop-action", listener);
    };
  }
});
