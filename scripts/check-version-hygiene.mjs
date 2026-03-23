import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const versions = readWorkspaceVersions(rootDir);
const mainVersion = readMainVersion(rootDir);
const registryVersion = readRegistryVersion();
const latestKnown = maxVersion([versions.root, mainVersion, registryVersion].filter(Boolean));

const mismatches = Object.entries(versions).filter(([, value]) => value !== versions.root);

console.log("Current versions:");
for (const [label, value] of Object.entries(versions)) {
  console.log(`- ${label}: ${value}`);
}
console.log(`- origin/main: ${mainVersion ?? "unavailable"}`);
console.log(`- npm latest: ${registryVersion ?? "unavailable"}`);
console.log(`- max known baseline: ${latestKnown ?? versions.root}`);

if (mismatches.length > 0) {
  console.log("\nMismatches:");
  for (const [label, value] of mismatches) {
    console.log(`- ${label} differs from root package version (${value} != ${versions.root})`);
  }
  process.exit(1);
}

if (latestKnown && compareVersions(versions.root, latestKnown) < 0) {
  console.log(`\nWARN: current root version (${versions.root}) is behind the latest known baseline (${latestKnown}).`);
  console.log("Use `npm run version:bump -- patch|minor|major` to advance from the highest known version.");
  process.exit(0);
}

console.log("\nVersion hygiene looks consistent.");

function readWorkspaceVersions(cwd) {
  const rootPackage = readJson(path.join(cwd, "package.json"));
  const rootLock = readJson(path.join(cwd, "package-lock.json"));
  const cliPackage = readJson(path.join(cwd, "app", "cli", "package.json"));
  const rendererPackage = readJson(path.join(cwd, "app", "renderer", "package.json"));
  const rendererLock = readJson(path.join(cwd, "app", "renderer", "package-lock.json"));
  const sharedVersionSource = readFileSync(path.join(cwd, "app", "shared", "version.ts"), "utf8");
  const sharedVersion = sharedVersionSource.match(/RECALLX_VERSION = "([^"]+)"/)?.[1] ?? "unknown";

  return {
    root: rootPackage.version,
    rootLock: rootLock.version,
    cli: cliPackage.version,
    renderer: rendererPackage.version,
    rendererLock: rendererLock.version,
    shared: sharedVersion,
  };
}

function readMainVersion(cwd) {
  try {
    const raw = execFileSync("git", ["show", "origin/main:package.json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

function readRegistryVersion() {
  try {
    return execFileSync("npm", ["view", "recallx", "version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function maxVersion(versions) {
  return versions.reduce((current, candidate) => {
    if (!current) {
      return candidate;
    }
    return compareVersions(candidate, current) > 0 ? candidate : current;
  }, null);
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index] - rightParts[index];
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function normalizeVersion(value) {
  const parts = String(value).trim().split(".").map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) {
    parts.push(0);
  }
  return parts.slice(0, 3);
}
