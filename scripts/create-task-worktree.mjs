import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const rawName = process.argv.slice(2).find((value) => !value.startsWith("--"));
if (!rawName) {
  console.error("Usage: npm run branch:new -- <task-name> [--base origin/main] [--allow-dirty]");
  process.exit(1);
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) {
    continue;
  }

  const [flag, inlineValue] = arg.split("=", 2);
  const next = process.argv[index + 1];
  if (inlineValue !== undefined) {
    args.set(flag, inlineValue);
    continue;
  }

  if (next && !next.startsWith("--")) {
    args.set(flag, next);
    index += 1;
    continue;
  }

  args.set(flag, "true");
}

const baseRef = args.get("--base") ?? "origin/main";
const allowDirty = args.has("--allow-dirty");
const slug = sanitizeBranchName(rawName);
const branchName = slug.includes("/") ? slug : `codex/${slug}`;
const repoRoot = captureGit(["rev-parse", "--show-toplevel"]).trim();
const currentBranch = captureGit(["branch", "--show-current"]).trim();
const statusLines = captureGit(["status", "--short"]).split("\n").map((line) => line.trim()).filter(Boolean);
const repoName = path.basename(repoRoot);
const outputDir = path.resolve(path.dirname(repoRoot), `${repoName}-${slug.replaceAll("/", "-")}`);

if (statusLines.length > 0 && !allowDirty) {
  console.error("Working tree is dirty. Commit or stash current edits first, or rerun with --allow-dirty if you really want a separate worktree right now.");
  process.exit(1);
}

ensureRefExists(baseRef);
ensureBranchDoesNotExist(branchName);

if (existsSync(outputDir)) {
  console.error(`Target path already exists: ${outputDir}`);
  process.exit(1);
}

captureGit(["fetch", "origin"], { stdio: "inherit" });
captureGit(["worktree", "add", "-b", branchName, outputDir, baseRef], { stdio: "inherit" });

console.log("");
console.log(`Created branch: ${branchName}`);
console.log(`Base ref: ${baseRef}`);
console.log(`Source branch at creation time: ${currentBranch || "(detached HEAD)"}`);
console.log(`Worktree path: ${outputDir}`);
console.log("");
console.log("Next:");
console.log(`- cd ${outputDir}`);
console.log("- npm run branch:check");

function sanitizeBranchName(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
}

function ensureRefExists(ref) {
  try {
    captureGit(["rev-parse", "--verify", ref]);
  } catch {
    console.error(`Base ref not found: ${ref}`);
    process.exit(1);
  }
}

function ensureBranchDoesNotExist(branch) {
  try {
    captureGit(["show-ref", "--verify", `refs/heads/${branch}`]);
    console.error(`Local branch already exists: ${branch}`);
    process.exit(1);
  } catch {
    // expected when the branch does not exist locally
  }

  try {
    captureGit(["ls-remote", "--exit-code", "--heads", "origin", branch]);
    console.error(`Remote branch already exists: origin/${branch}`);
    process.exit(1);
  } catch {
    // expected when the branch does not exist remotely
  }
}

function captureGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}
