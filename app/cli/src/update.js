import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SUPPORTED_NPM_PACKAGES = new Set(["recallx", "recallx-headless"]);

export async function getCliUpdatePlan(options = {}) {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const packageRoot = options.packageRoot ?? resolveCliPackageRoot(moduleUrl);
  const packageJson = readPackageJson(packageRoot, options.readFileSyncFn ?? readFileSync);
  const packageName = options.packageName ?? packageJson.name;
  const currentVersion = options.currentVersion ?? packageJson.version;
  const platform = options.platform ?? process.platform;
  const npmCommand = options.npmCommand ?? resolveNpmCommand(platform);
  const execAsync = options.execFileAsyncFn ?? execFileAsync;

  if (!SUPPORTED_NPM_PACKAGES.has(packageName)) {
    throw new Error(
      "UPDATE_UNSUPPORTED: `recallx update` currently supports npm-installed `recallx` and `recallx-headless` runtimes only.",
    );
  }

  const globalRoot = (await runCommand(execAsync, npmCommand, ["root", "-g"])).trim();
  if (!globalRoot || !isPathInside(packageRoot, globalRoot)) {
    throw new Error(
      "UPDATE_UNSUPPORTED: `recallx update` only works for npm global installs. For source checkouts or other install methods, update the package with your package manager directly.",
    );
  }

  const latestVersionRaw = await runCommand(execAsync, npmCommand, ["view", packageName, "version", "--json"]);
  const latestVersion = normalizeVersionPayload(latestVersionRaw);
  const installArgs = ["install", "-g", `${packageName}@latest`];

  return {
    packageName,
    currentVersion,
    latestVersion,
    packageRoot,
    globalRoot,
    npmCommand,
    installArgs,
    installCommand: [npmCommand, ...installArgs].map(quoteShellArg).join(" "),
    status: currentVersion === latestVersion ? "up_to_date" : "update_available",
    applied: false,
  };
}

export function applyCliUpdate(plan, options = {}) {
  if (!plan || typeof plan !== "object") {
    throw new Error("UPDATE_INVALID_PLAN: Missing update plan.");
  }

  if (plan.status === "up_to_date") {
    return {
      ...plan,
      applied: false,
    };
  }

  const platform = options.platform ?? process.platform;
  const npmCommand = options.npmCommand ?? plan.npmCommand ?? resolveNpmCommand(platform);
  const execSync = options.execFileSyncFn ?? execFileSync;
  execSync(npmCommand, plan.installArgs ?? ["install", "-g", `${plan.packageName}@latest`], {
    stdio: "inherit",
  });

  return {
    ...plan,
    status: "updated",
    applied: true,
  };
}

function resolveCliPackageRoot(moduleUrl) {
  const modulePath = fileURLToPath(moduleUrl);
  return path.resolve(path.dirname(modulePath), "../../..");
}

function readPackageJson(packageRoot, readFileSyncFn) {
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`UPDATE_UNSUPPORTED: Could not find package metadata at ${packageJsonPath}.`);
  }
  return JSON.parse(readFileSyncFn(packageJsonPath, "utf8"));
}

async function runCommand(execAsync, command, args) {
  try {
    const result = await execAsync(command, args, { encoding: "utf8" });
    return typeof result.stdout === "string" ? result.stdout.trim() : "";
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`UPDATE_COMMAND_FAILED: ${detail}`);
  }
}

function normalizeVersionPayload(value) {
  if (!value) {
    throw new Error("UPDATE_LOOKUP_FAILED: npm did not return a version.");
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      const last = parsed.at(-1);
      if (typeof last === "string" && last.trim()) {
        return last;
      }
    }
    if (typeof parsed === "string" && parsed.trim()) {
      return parsed;
    }
  } catch {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  throw new Error("UPDATE_LOOKUP_FAILED: npm returned an invalid version payload.");
}

function isPathInside(candidatePath, parentPath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function quoteShellArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function resolveNpmCommand(platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}
