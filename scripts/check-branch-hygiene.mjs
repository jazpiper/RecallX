import { execFileSync } from "node:child_process";

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
const currentBranch = captureGit(["branch", "--show-current"]).trim();
const statusLines = captureGit(["status", "--short"]).split("\n").map((line) => line.trim()).filter(Boolean);
const [behindCountRaw, aheadCountRaw] = captureGit(["rev-list", "--left-right", "--count", `${baseRef}...HEAD`])
  .trim()
  .split(/\s+/);
const behindCount = Number.parseInt(behindCountRaw ?? "0", 10) || 0;
const aheadCount = Number.parseInt(aheadCountRaw ?? "0", 10) || 0;
const openPullRequest = readOpenPullRequest(currentBranch);

const findings = [];

if (!currentBranch) {
  findings.push({
    level: "error",
    message: "Detached HEAD. Switch to a named branch before starting work."
  });
}

if (currentBranch === "main" || currentBranch === "master") {
  findings.push({
    level: "error",
    message: `Current branch is \`${currentBranch}\`. Start feature work from a dedicated \`codex/*\` branch instead.`
  });
}

if (statusLines.length > 0) {
  findings.push({
    level: "error",
    message: "Working tree is dirty. Commit, stash, or move changes before starting another task."
  });
}

if (aheadCount > 0 && currentBranch && currentBranch !== baseRef) {
  findings.push({
    level: "warning",
    message: `Current branch is ${aheadCount} commit(s) ahead of ${baseRef}. This usually means you are already in task-specific work.`
  });
}

if (behindCount > 0) {
  findings.push({
    level: "warning",
    message: `Current branch is ${behindCount} commit(s) behind ${baseRef}. Rebase or branch fresh from ${baseRef} if you need the latest base.`
  });
}

if (openPullRequest) {
  findings.push({
    level: "warning",
    message: `Branch already has an open PR (#${openPullRequest.number}: ${openPullRequest.title}). Avoid stacking unrelated work on it.`
  });
}

console.log(`Branch: ${currentBranch || "(detached HEAD)"}`);
console.log(`Base: ${baseRef}`);
console.log(`Status: ${statusLines.length ? `${statusLines.length} modified path(s)` : "clean"}`);
console.log(`Ahead/behind ${baseRef}: +${aheadCount} / -${behindCount}`);
if (openPullRequest) {
  console.log(`Open PR: #${openPullRequest.number} ${openPullRequest.title}`);
}

if (findings.length === 0) {
  console.log("\nBranch hygiene looks good for starting isolated work.");
  process.exit(0);
}

console.log("\nFindings:");
for (const finding of findings) {
  const marker = finding.level === "error" ? "ERROR" : "WARN ";
  console.log(`- [${marker}] ${finding.message}`);
}

const hasError = findings.some((finding) => finding.level === "error");
if (hasError) {
  console.log("\nRecommended next step: `npm run branch:new -- <short-task-name>`");
  process.exit(1);
}

console.log("\nRecommended next step: create a fresh task worktree if this is unrelated work.");

function captureGit(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readOpenPullRequest(branchName) {
  if (!branchName || !hasCommand("gh")) {
    return null;
  }

  try {
    const raw = execFileSync(
      "gh",
      ["pr", "list", "--head", branchName, "--state", "open", "--json", "number,title", "--limit", "1"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null;
  } catch {
    return null;
  }
}

function hasCommand(command) {
  try {
    execFileSync("which", [command], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
