import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, Menu, Tray, clipboard, nativeImage, shell } from "electron";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemforgeMcpServer } from "../mcp/server.js";
import { memforgeHomeDir, resolveWorkspaceRoot } from "../server/workspace.js";

type CliOptions = {
  mcpStdio: boolean;
  api: string | null;
};

type DesktopAction = "quick-capture" | "open-search";
type DesktopServiceStatus = "starting" | "running" | "stopped" | "error";
type DesktopRuntimeState = {
  serviceStatus: DesktopServiceStatus;
  apiBase: string | null;
  workspaceName: string;
  workspaceRoot: string;
  authMode: string;
  lastHealthAt: string | null;
  lastError: string | null;
};

const DESKTOP_BIND = process.env.MEMFORGE_BIND ?? "127.0.0.1";
const DESKTOP_PORT = Number(process.env.MEMFORGE_PORT ?? 8787);
const DESKTOP_WORKSPACE_NAME = process.env.MEMFORGE_WORKSPACE_NAME?.trim() || "Memforge";
const RENDERER_DEV_URL = process.env.MEMFORGE_DESKTOP_DEV_URL;
const API_READY_TIMEOUT_MS = 15_000;
const API_RETRY_DELAY_MS = 250;
const STATUS_POLL_INTERVAL_MS = 15_000;
const MCP_LAUNCHER_PATH = path.join(memforgeHomeDir(), "bin", "memforge-mcp");
const DESKTOP_COMMAND_SHIM_PATH = path.join(os.homedir(), ".local", "bin", "Memforge");
const TRAY_ICON_ASSET_PATH = ["app", "desktop", "assets", "trayTemplate.png"] as const;

let mainWindow: BrowserWindow | null = null;
let apiProcess: ChildProcess | null = null;
let tray: Tray | null = null;
let statusPollTimer: ReturnType<typeof setInterval> | null = null;
let quitting = false;
let managedApiBase: string | null = null;
let managedApiPort: number | null = null;
let keepRunningInBackground = true;

function revealWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  window.show();
  window.focus();
}

function currentMcpCommand(): string {
  return app.isPackaged ? "Memforge --mcp-stdio" : `"${process.execPath}" "${app.getAppPath()}" --mcp-stdio`;
}

function shortenPath(value: string): string {
  const home = os.homedir();
  if (value.startsWith(home)) {
    return `~${value.slice(home.length)}`;
  }

  return value;
}

function buildTrayIcon(_status: DesktopServiceStatus) {
  try {
    const iconPath = resolveBundledPath(...TRAY_ICON_ASSET_PATH);
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      image.setTemplateImage(true);
      return image;
    }
  } catch (error) {
    console.warn("Failed to load bundled tray icon asset", error);
  }

  const fallbackSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M3 15V3h3l3 6 3-6h3v12" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 13.6h12" fill="none" stroke="black" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const fallback = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(fallbackSvg).toString("base64")}`
  );
  fallback.setTemplateImage(true);
  return fallback.resize({ height: 18 });
}

function updateDesktopState(next: Partial<DesktopRuntimeState>) {
  Object.assign(desktopState, next);
  syncTray();
}

function currentStatusHeadline(): string {
  switch (desktopState.serviceStatus) {
    case "running":
      return "Memforge is running";
    case "starting":
      return "Memforge is starting";
    case "error":
      return "Memforge needs attention";
    default:
      return "Memforge is stopped";
  }
}

function currentTrayTitle(): string {
  switch (desktopState.serviceStatus) {
    case "running":
      return "MF";
    case "starting":
      return "MF...";
    case "error":
      return "MF!";
    default:
      return "MF-";
  }
}

function syncTray(): void {
  if (!tray) {
    return;
  }

  tray.setImage(buildTrayIcon(desktopState.serviceStatus));
  tray.setTitle(currentTrayTitle());
  tray.setToolTip(
    `${currentStatusHeadline()}${desktopState.apiBase ? ` • ${desktopState.apiBase}` : ""}${desktopState.workspaceName ? ` • ${desktopState.workspaceName}` : ""}`
  );

  const launchAtLoginEnabled = app.isPackaged ? app.getLoginItemSettings().openAtLogin : false;
  const menu = Menu.buildFromTemplate([
    {
      label: currentStatusHeadline(),
      enabled: false
    },
    {
      label: `Server: ${desktopState.serviceStatus}`,
      enabled: false
    },
    {
      label: `Workspace: ${desktopState.workspaceName}`,
      enabled: false
    },
    {
      label: `Root: ${shortenPath(desktopState.workspaceRoot)}`,
      enabled: false
    },
    {
      label: `API: ${desktopState.apiBase ?? "Unavailable"}`,
      enabled: false
    },
    {
      label: `Auth: ${desktopState.authMode}`,
      enabled: false
    },
    ...(desktopState.lastError
      ? [
          {
            label: `Last error: ${desktopState.lastError}`,
            enabled: false
          }
        ]
      : []),
    { type: "separator" },
    {
      label: mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? "Hide Memforge" : "Open Memforge",
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
          mainWindow.hide();
          syncTray();
          return;
        }
        void openMainWindow();
      }
    },
    {
      label: "Quick Capture",
      click: () => {
        void dispatchDesktopAction("quick-capture");
      }
    },
    {
      label: "Open Search",
      click: () => {
        void dispatchDesktopAction("open-search");
      }
    },
    { type: "separator" },
    {
      label: "Copy API URL",
      enabled: Boolean(desktopState.apiBase),
      click: async () => {
        const apiBase = desktopState.apiBase ?? (await resolveApiBase());
        clipboard.writeText(apiBase);
      }
    },
    {
      label: "Copy MCP Command",
      click: () => {
        clipboard.writeText(currentMcpCommand());
      }
    },
    {
      label: "Reveal Workspace Folder",
      click: () => {
        void shell.openPath(desktopState.workspaceRoot);
      }
    },
    { type: "separator" },
    {
      label: "Restart Local Service",
      enabled: shouldManageLocalApi(),
      click: () => {
        void restartLocalService();
      }
    },
    {
      label: "Launch at Login",
      type: "checkbox",
      enabled: app.isPackaged,
      checked: launchAtLoginEnabled,
      click: () => {
        if (!app.isPackaged) {
          return;
        }
        app.setLoginItemSettings({
          openAtLogin: !app.getLoginItemSettings().openAtLogin
        });
        syncTray();
      }
    },
    {
      label: "Keep Running in Background",
      type: "checkbox",
      checked: keepRunningInBackground,
      click: () => {
        keepRunningInBackground = !keepRunningInBackground;
        syncTray();
      }
    },
    { type: "separator" },
    {
      label: "Quit Memforge",
      click: () => {
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function createTray(): void {
  if (tray || cliOptions.mcpStdio) {
    return;
  }

  tray = new Tray(buildTrayIcon(desktopState.serviceStatus));
  tray.on("click", () => {
    tray?.popUpContextMenu();
  });
  tray.on("double-click", () => {
    void openMainWindow();
  });
  syncTray();
}

function resolveDesktopWorkspaceRoot(): string {
  if (!process.env.MEMFORGE_WORKSPACE_NAME?.trim()) {
    process.env.MEMFORGE_WORKSPACE_NAME = DESKTOP_WORKSPACE_NAME;
  }

  return resolveWorkspaceRoot({
    allowLegacyProjectRoot: false
  });
}

const DESKTOP_WORKSPACE_ROOT = resolveDesktopWorkspaceRoot();

const desktopState: DesktopRuntimeState = {
  serviceStatus: "starting",
  apiBase: null,
  workspaceName: DESKTOP_WORKSPACE_NAME,
  workspaceRoot: DESKTOP_WORKSPACE_ROOT,
  authMode: "optional",
  lastHealthAt: null,
  lastError: null
};

function apiBaseForPort(port: number): string {
  return `http://${DESKTOP_BIND}:${port}/api/v1`;
}

function parseCliOptions(argv: string[]): CliOptions {
  let mcpStdio = false;
  let api: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mcp-stdio") {
      mcpStdio = true;
      continue;
    }
    if (value === "--api" && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      api = argv[index + 1];
      index += 1;
    }
  }

  return { mcpStdio, api };
}

const cliOptions = parseCliOptions(process.argv.slice(1));

function shouldManageLocalApi(): boolean {
  return !cliOptions.api;
}

async function isApiReady(apiBase: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function readWorkspaceRoot(apiBase: string): Promise<string | null> {
  try {
    const response = await fetch(`${apiBase}/workspace`);
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { data?: { rootPath?: string } };
    return typeof payload?.data?.rootPath === "string" ? payload.data.rootPath : null;
  } catch {
    return null;
  }
}

async function canListenOnPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, DESKTOP_BIND, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort: number, attempts = 20): Promise<number> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = startPort + offset;
    if (await canListenOnPort(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to find an available Memforge desktop port starting at ${startPort}`);
}

async function findReusableApiBase(startPort: number, attempts = 20): Promise<string | null> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidatePort = startPort + offset;
    const candidateApiBase = apiBaseForPort(candidatePort);
    if (!(await isApiReady(candidateApiBase))) {
      continue;
    }

    const candidateWorkspaceRoot = await readWorkspaceRoot(candidateApiBase);
    if (candidateWorkspaceRoot === DESKTOP_WORKSPACE_ROOT) {
      managedApiPort = candidatePort;
      managedApiBase = candidateApiBase;
      return candidateApiBase;
    }
  }

  return null;
}

async function resolveManagedApiBase(): Promise<string> {
  if (managedApiBase) {
    return managedApiBase;
  }

  const preferredApiBase = apiBaseForPort(DESKTOP_PORT);
  const preferredIsReady = await isApiReady(preferredApiBase);

  if (preferredIsReady) {
    const existingWorkspaceRoot = await readWorkspaceRoot(preferredApiBase);
    if (existingWorkspaceRoot === DESKTOP_WORKSPACE_ROOT) {
      managedApiPort = DESKTOP_PORT;
      managedApiBase = preferredApiBase;
      return managedApiBase;
    }

    const reusableApiBase = await findReusableApiBase(DESKTOP_PORT + 1);
    if (reusableApiBase) {
      return reusableApiBase;
    }

    const nextPort = await findAvailablePort(DESKTOP_PORT + 1);
    managedApiPort = nextPort;
    managedApiBase = apiBaseForPort(nextPort);
    return managedApiBase;
  }

  managedApiPort = DESKTOP_PORT;
  managedApiBase = preferredApiBase;
  return managedApiBase;
}

async function resolveApiBase(): Promise<string> {
  if (cliOptions.api) {
    return cliOptions.api;
  }

  return resolveManagedApiBase();
}

function resolveBundledPath(...parts: string[]): string {
  const unpackedCandidate = path.join(process.resourcesPath, "app.asar.unpacked", ...parts);
  const appCandidate = path.join(app.getAppPath(), ...parts);
  const candidates = app.isPackaged ? [unpackedCandidate, appCandidate] : [appCandidate];
  const resolved = candidates.find((candidate) => existsSync(candidate));

  if (!resolved) {
    throw new Error(`Failed to resolve bundled path for ${parts.join("/")}`);
  }

  return resolved;
}

function ensureLauncherScripts(): void {
  const genericLauncherScript = app.isPackaged
    ? `#!/bin/sh
exec "${process.execPath}" "$@"
`
    : `#!/bin/sh
exec "${process.execPath}" "${app.getAppPath()}" "$@"
`;
  const mcpLauncherScript = app.isPackaged
    ? `#!/bin/sh
exec "${process.execPath}" --mcp-stdio "$@"
`
    : `#!/bin/sh
exec "${process.execPath}" "${app.getAppPath()}" --mcp-stdio "$@"
`;

  for (const [targetPath, contents] of [
    [DESKTOP_COMMAND_SHIM_PATH, genericLauncherScript],
    [MCP_LAUNCHER_PATH, mcpLauncherScript]
  ] as const) {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, contents, "utf8");
    chmodSync(targetPath, 0o755);
  }
}

function startApiServer(port: number): void {
  if (apiProcess || !shouldManageLocalApi()) {
    return;
  }

  updateDesktopState({
    serviceStatus: "starting",
    apiBase: apiBaseForPort(port),
    lastError: null
  });

  const serverEntry = resolveBundledPath("dist", "server", "app", "server", "index.js");
  apiProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      MEMFORGE_BIND: DESKTOP_BIND,
      MEMFORGE_PORT: String(port),
      MEMFORGE_WORKSPACE_ROOT: DESKTOP_WORKSPACE_ROOT,
      MEMFORGE_WORKSPACE_NAME: DESKTOP_WORKSPACE_NAME
    },
    stdio: "pipe"
  });

  apiProcess.stdout?.on("data", (chunk) => {
    process.stderr.write(`[memforge-api] ${String(chunk)}`);
  });
  apiProcess.stderr?.on("data", (chunk) => {
    process.stderr.write(`[memforge-api] ${String(chunk)}`);
  });
  apiProcess.on("exit", (code) => {
    apiProcess = null;
    if (!quitting && code && code !== 0) {
      console.error(`Memforge API exited with code ${code}`);
      updateDesktopState({
        serviceStatus: "error",
        lastError: `Local service exited with code ${code}`
      });
    } else if (!quitting) {
      updateDesktopState({
        serviceStatus: "stopped"
      });
    }
  });
}

async function refreshDesktopStatus(): Promise<void> {
  if (cliOptions.mcpStdio) {
    return;
  }

  try {
    const apiBase = await resolveApiBase();
    if (!(await isApiReady(apiBase))) {
      updateDesktopState({
        apiBase,
        serviceStatus: apiProcess ? "starting" : "stopped"
      });
      return;
    }

    const response = await fetch(`${apiBase}/workspace`);
    if (!response.ok) {
      throw new Error(`Workspace status request failed (${response.status})`);
    }

    const payload = (await response.json()) as {
      data?: {
        rootPath?: string;
        workspaceName?: string;
        authMode?: string;
      };
    };
    const data = payload?.data ?? {};
    updateDesktopState({
      serviceStatus: "running",
      apiBase,
      workspaceName: typeof data.workspaceName === "string" ? data.workspaceName : DESKTOP_WORKSPACE_NAME,
      workspaceRoot: typeof data.rootPath === "string" ? data.rootPath : DESKTOP_WORKSPACE_ROOT,
      authMode: typeof data.authMode === "string" ? data.authMode : "optional",
      lastHealthAt: new Date().toISOString(),
      lastError: null
    });
  } catch (error) {
    updateDesktopState({
      serviceStatus: "error",
      lastError: error instanceof Error ? error.message : "Unknown desktop status error"
    });
  }
}

function startStatusPolling(): void {
  if (statusPollTimer || cliOptions.mcpStdio) {
    return;
  }

  statusPollTimer = setInterval(() => {
    void refreshDesktopStatus();
  }, STATUS_POLL_INTERVAL_MS);
}

function stopStatusPolling(): void {
  if (!statusPollTimer) {
    return;
  }

  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

async function waitForApiReady(): Promise<void> {
  if (!shouldManageLocalApi()) {
    return;
  }

  const apiBase = await resolveApiBase();
  if (await isApiReady(apiBase)) {
    return;
  }

  startApiServer(managedApiPort ?? DESKTOP_PORT);
  const startedAt = Date.now();

  while (Date.now() - startedAt < API_READY_TIMEOUT_MS) {
    if (await isApiReady(apiBase)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, API_RETRY_DELAY_MS));
  }

  throw new Error(`Memforge API did not become ready within ${API_READY_TIMEOUT_MS}ms`);
}

async function runMcpStdioMode(): Promise<void> {
  if (process.platform === "darwin") {
    app.dock?.hide();
  }

  await waitForApiReady();
  ensureLauncherScripts();

  process.env.MEMFORGE_API_URL = await resolveApiBase();
  const server = createMemforgeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Memforge MCP connected over stdio -> ${process.env.MEMFORGE_API_URL}`);
}

async function openMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    revealWindow(mainWindow);
    syncTray();
    return mainWindow;
  }

  await createMainWindow();
  syncTray();
  return mainWindow!;
}

async function dispatchDesktopAction(action: DesktopAction): Promise<void> {
  const window = await openMainWindow();
  const sendAction = () => {
    window.webContents.send("memforge-desktop-action", { type: action });
  };

  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once("did-finish-load", sendAction);
  } else {
    sendAction();
  }
}

async function restartLocalService(): Promise<void> {
  if (!shouldManageLocalApi()) {
    return;
  }

  const previousApiBase = desktopState.apiBase;
  const hadWindow = Boolean(mainWindow && !mainWindow.isDestroyed());
  const wasVisible = Boolean(mainWindow?.isVisible());

  updateDesktopState({
    serviceStatus: "starting",
    lastError: null
  });

  stopApiServer();
  managedApiBase = null;
  managedApiPort = null;

  try {
    await waitForApiReady();
    const nextApiBase = await resolveApiBase();
    await refreshDesktopStatus();

    if (hadWindow && mainWindow && !mainWindow.isDestroyed()) {
      if (previousApiBase !== nextApiBase) {
        mainWindow.destroy();
        mainWindow = null;
        await createMainWindow();
        const recreatedWindow = mainWindow as BrowserWindow | null;
        if (!wasVisible && recreatedWindow) {
          recreatedWindow.hide();
        }
      } else {
        mainWindow.webContents.reload();
        if (wasVisible) {
          revealWindow(mainWindow);
        }
      }
    }
  } catch (error) {
    updateDesktopState({
      serviceStatus: "error",
      lastError: error instanceof Error ? error.message : "Failed to restart local service"
    });
  }
}

async function createMainWindow(): Promise<void> {
  await waitForApiReady();
  ensureLauncherScripts();

  const apiBase = await resolveApiBase();
  const preload = resolveBundledPath("dist", "server", "app", "desktop", "preload.cjs");
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    show: false,
    backgroundColor: "#0b1020",
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [
        `--memforge-api-base=${apiBase}`,
        `--memforge-health-url=${apiBase}/health`,
        `--memforge-workspace-home=${memforgeHomeDir()}`,
        `--memforge-workspace-root=${DESKTOP_WORKSPACE_ROOT}`,
        `--memforge-command-shim-path=${DESKTOP_COMMAND_SHIM_PATH}`,
        `--memforge-mcp-launcher-path=${MCP_LAUNCHER_PATH}`,
        `--memforge-mcp-command=${app.isPackaged ? "Memforge --mcp-stdio" : `"${process.execPath}" "${app.getAppPath()}" --mcp-stdio`}`,
        `--memforge-app-executable=${process.execPath}`,
        `--memforge-is-packaged=${app.isPackaged ? "1" : "0"}`
      ]
    }
  });

  window.once("ready-to-show", () => {
    revealWindow(window);
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.error(`[memforge-renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  window.webContents.on("did-finish-load", () => {
    revealWindow(window);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`Memforge renderer failed to load (${errorCode}): ${errorDescription}`);
    revealWindow(window);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Memforge renderer process gone: ${details.reason}`);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (RENDERER_DEV_URL) {
    await window.loadURL(RENDERER_DEV_URL);
  } else {
    const rendererIndex = resolveBundledPath("dist", "renderer", "index.html");
    await window.loadFile(rendererIndex);
  }

  revealWindow(window);

  window.on("close", (event) => {
    if (!quitting && keepRunningInBackground) {
      event.preventDefault();
      window.hide();
      syncTray();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
    syncTray();
  });

  mainWindow = window;
  syncTray();
  void refreshDesktopStatus();
}

function stopApiServer(): void {
  if (!apiProcess) {
    updateDesktopState({
      serviceStatus: "stopped"
    });
    return;
  }

  apiProcess.kill();
  apiProcess = null;
  updateDesktopState({
    serviceStatus: "stopped"
  });
}

app.on("window-all-closed", () => {
  if (cliOptions.mcpStdio) {
    return;
  }
  if (!keepRunningInBackground) {
    app.quit();
  }
});

app.on("before-quit", () => {
  quitting = true;
  stopStatusPolling();
  stopApiServer();
});

if (!cliOptions.mcpStdio) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      void openMainWindow();
    });
  }
}

app.whenReady().then(async () => {
  try {
    if (cliOptions.mcpStdio) {
      await runMcpStdioMode();
      return;
    }
    createTray();
    startStatusPolling();
    syncTray();
    await createMainWindow();
    await refreshDesktopStatus();
  } catch (error) {
    console.error(error);
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      revealWindow(mainWindow);
      syncTray();
      return;
    }

    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});
