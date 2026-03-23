import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const rootPackagePath = path.join(rootDir, "package.json");
const rootPackage = readJson(rootPackagePath);
const nextVersion = rootPackage.version;

if (typeof nextVersion !== "string" || !nextVersion.trim()) {
  throw new Error(`Root package version is missing in ${rootPackagePath}.`);
}

const packageFiles = [
  path.join(rootDir, "app", "cli", "package.json"),
  path.join(rootDir, "app", "renderer", "package.json"),
];

for (const packageFile of packageFiles) {
  const packageJson = readJson(packageFile);
  packageJson.version = nextVersion;
  writeJson(packageFile, packageJson);
}

const lockFiles = [
  path.join(rootDir, "package-lock.json"),
  path.join(rootDir, "app", "renderer", "package-lock.json"),
];

for (const lockFile of lockFiles) {
  const lockJson = readJson(lockFile);
  lockJson.version = nextVersion;
  if (lockJson.packages && typeof lockJson.packages === "object" && lockJson.packages[""]) {
    lockJson.packages[""].version = nextVersion;
  }
  writeJson(lockFile, lockJson);
}

const sharedVersionFile = path.join(rootDir, "app", "shared", "version.ts");
const sharedVersionSource = readFileSync(sharedVersionFile, "utf8");
const nextSharedVersionSource = sharedVersionSource.replace(
  /export const RECALLX_VERSION = "[^"]+";/,
  `export const RECALLX_VERSION = "${nextVersion}";`,
);

if (nextSharedVersionSource === sharedVersionSource) {
  throw new Error(`Failed to update RECALLX_VERSION in ${sharedVersionFile}.`);
}

writeFileSync(sharedVersionFile, nextSharedVersionSource, "utf8");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
