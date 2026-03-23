import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const bumpArg = process.argv.slice(2).find((value) => !value.startsWith("--"));
if (!bumpArg) {
  console.error("Usage: npm run version:bump -- patch|minor|major|<semver> [--dry-run]");
  process.exit(1);
}

const rootDir = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const currentVersion = readJson(path.join(rootDir, "package.json")).version;
const mainVersion = readMainVersion(rootDir);
const registryVersion = readRegistryVersion();
const baseline = maxVersion([currentVersion, mainVersion, registryVersion].filter(Boolean));
const nextVersion = isReleaseBumpType(bumpArg) ? bumpVersion(baseline, bumpArg) : bumpArg;

console.log(`Current root version: ${currentVersion}`);
console.log(`origin/main version: ${mainVersion ?? "unavailable"}`);
console.log(`npm latest version: ${registryVersion ?? "unavailable"}`);
console.log(`Baseline version: ${baseline}`);
console.log(`Next version: ${nextVersion}`);

if (!isValidSemver(nextVersion)) {
  console.error(`Invalid version: ${nextVersion}`);
  process.exit(1);
}

if (compareVersions(nextVersion, baseline) <= 0) {
  console.error(`Next version (${nextVersion}) must be greater than the highest known baseline (${baseline}).`);
  process.exit(1);
}

if (dryRun) {
  console.log("\nDry run only. No files were changed.");
  process.exit(0);
}

execFileSync("npm", ["version", nextVersion, "--no-git-tag-version"], {
  cwd: rootDir,
  stdio: "inherit",
});

execFileSync("node", ["scripts/sync-package-versions.mjs"], {
  cwd: rootDir,
  stdio: "inherit",
});

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
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

function isReleaseBumpType(value) {
  return value === "patch" || value === "minor" || value === "major";
}

function bumpVersion(baseVersion, type) {
  const [major, minor, patch] = normalizeVersion(baseVersion);
  if (type === "major") {
    return `${major + 1}.0.0`;
  }
  if (type === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

function isValidSemver(value) {
  return /^\d+\.\d+\.\d+$/.test(String(value).trim());
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
