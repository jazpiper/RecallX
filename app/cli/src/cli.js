import { readFile } from "node:fs/promises";
import { getApiBase, getAuthToken, requestJson } from "./http.js";
import {
  renderBundleMarkdown,
  renderBundleText,
  renderJson,
  renderNode,
  renderRelated,
  renderReviewItems,
  renderSearchResults,
  renderText,
  renderWorkspaces,
} from "./format.js";

const DEFAULT_SOURCE = {
  actorType: "human",
  actorLabel: "memforge-cli",
  toolName: "memforge-cli",
  toolVersion: "0.1.0",
};

export async function runCli(argv) {
  const { command, args, options, positionals } = parseArgv(argv.slice(2));
  const apiBase = getApiBase(options);
  const token = getAuthToken(options);
  const format = options.format || "text";

  if (!command || command === "help" || options.help) {
    writeStdout(renderHelp());
    return;
  }

  switch (command) {
    case "health":
      return runHealth(apiBase, token, format);
    case "search":
      return runSearch(apiBase, token, format, args, positionals);
    case "get":
      return runGet(apiBase, token, format, args, positionals);
    case "related":
      return runRelated(apiBase, token, format, args, positionals);
    case "context":
      return runContext(apiBase, token, format, args, positionals);
    case "create":
      return runCreate(apiBase, token, format, args, positionals);
    case "append":
      return runAppend(apiBase, token, format, args, positionals);
    case "link":
      return runLink(apiBase, token, format, args, positionals);
    case "attach":
      return runAttach(apiBase, token, format, args, positionals);
    case "review":
      return runReview(apiBase, token, format, args, positionals);
    case "workspace":
      return runWorkspace(apiBase, token, format, args, positionals);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runHealth(apiBase, token, format) {
  const data = await requestJson(apiBase, "/health", { token });
  outputData({ ok: true, data }, format, "health");
}

async function runSearch(apiBase, token, format, args, positionals) {
  const query = args.query || positionals.join(" ");
  const filters = {};

  if (args.type) filters.types = splitList(args.type);
  if (args.status) filters.status = splitList(args.status);
  if (args["source-label"]) filters.sourceLabels = splitList(args["source-label"]);
  if (args.tag || args.tags) filters.tags = splitList(args.tag || args.tags);

  const payload = {
    query,
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    limit: numberOption(args.limit, 10),
    offset: numberOption(args.offset, 0),
    sort: args.sort || "relevance",
  };

  const data = await requestJson(apiBase, "/nodes/search", {
    method: "POST",
    token,
    body: compactObject(payload),
  });
  outputData(data, format, "search");
}

async function runGet(apiBase, token, format, args, positionals) {
  const id = args.id || positionals[0];
  if (!id) {
    throw new Error("get requires a node id");
  }

  const data = await requestJson(apiBase, `/nodes/${encodeURIComponent(id)}`, { token });
  outputData(data, format, "get");
}

async function runRelated(apiBase, token, format, args, positionals) {
  const id = args.id || positionals[0];
  if (!id) {
    throw new Error("related requires a node id");
  }

  const query = new URLSearchParams();
  if (args.depth) query.set("depth", String(numberOption(args.depth, 1)));
  if (args.type) query.set("types", splitList(args.type).join(","));

  const data = await requestJson(apiBase, `/nodes/${encodeURIComponent(id)}/related${query.toString() ? `?${query}` : ""}`, {
    token,
  });
  outputData(data, format, "related");
}

async function runContext(apiBase, token, format, args, positionals) {
  const targetId = args.id || args.target || positionals[0];
  if (!targetId) {
    throw new Error("context requires a target id");
  }

  const targetType = args["target-type"] || args.targetType || guessTargetType(targetId);
  const payload = {
    target: {
      type: targetType,
      id: targetId,
    },
    mode: args.mode || "compact",
    preset: args.preset || "for-coding",
    options: {
      includeRelated: parseBooleanFlag(args["include-related"], true),
      includeRecentActivities: parseBooleanFlag(args["include-recent-activities"], true),
      includeDecisions: parseBooleanFlag(args["include-decisions"], true),
      includeOpenQuestions: parseBooleanFlag(args["include-open-questions"], true),
      maxItems: numberOption(args["max-items"], 12),
    },
  };

  const data = await requestJson(apiBase, "/context/bundles", {
    method: "POST",
    token,
    body: payload,
  });

  const bundle = data?.data?.bundle || data?.bundle || data;
  outputData(bundle, format, "context");
}

async function runCreate(apiBase, token, format, args, positionals) {
  const body = await readBodyInput(args);
  const payload = {
    type: args.type || positionals[0],
    title: args.title || positionals[1],
    body: body || undefined,
    tags: collectTags(args),
    canonicality: args.canonicality,
    status: args.status,
    source: buildSource(args),
    metadata: parseJsonOption(args.metadata),
  };

  validateRequired(payload.type, "create requires --type");
  validateRequired(payload.title, "create requires --title");

  const data = await requestJson(apiBase, "/nodes", {
    method: "POST",
    token,
    body: compactObject(payload),
  });
  outputData(data, format, "create");
}

async function runAppend(apiBase, token, format, args, positionals) {
  const targetNodeId = args.target || positionals[0];
  const body = await readBodyInput(args);
  validateRequired(targetNodeId, "append requires --target");
  validateRequired(args.type, "append requires --type");

  const payload = {
    targetNodeId,
    activityType: args.type,
    body,
    source: buildSource(args),
    metadata: parseJsonOption(args.metadata),
  };

  const data = await requestJson(apiBase, "/activities", {
    method: "POST",
    token,
    body: compactObject(payload),
  });
  outputData(data, format, "append");
}

async function runLink(apiBase, token, format, args, positionals) {
  const fromNodeId = args.from || positionals[0];
  const toNodeId = args.to || positionals[1];
  const relationType = args["relation-type"] || args.type || positionals[2];

  validateRequired(fromNodeId, "link requires a from node id");
  validateRequired(toNodeId, "link requires a to node id");
  validateRequired(relationType, "link requires a relation type");

  const payload = {
    fromNodeId,
    toNodeId,
    relationType,
    status: args.status || "suggested",
    source: buildSource(args),
    metadata: parseJsonOption(args.metadata),
  };

  const data = await requestJson(apiBase, "/relations", {
    method: "POST",
    token,
    body: compactObject(payload),
  });
  outputData(data, format, "link");
}

async function runAttach(apiBase, token, format, args, positionals) {
  const nodeId = args.node || positionals[0];
  const path = args.path || positionals[1];
  validateRequired(nodeId, "attach requires --node");
  validateRequired(path, "attach requires --path");

  const payload = {
    nodeId,
    path,
    mimeType: args["mime-type"] || args.mimeType,
    checksum: args.checksum,
    source: buildSource(args),
    metadata: parseJsonOption(args.metadata),
  };

  const data = await requestJson(apiBase, "/artifacts", {
    method: "POST",
    token,
    body: compactObject(payload),
  });
  outputData(data, format, "attach");
}

async function runReview(apiBase, token, format, args, positionals) {
  const action = positionals[0] || args.action || "list";

  if (action === "list") {
    const query = new URLSearchParams();
    if (args.status) query.set("status", args.status);
    if (args.type) query.set("review_type", args.type);
    if (args.limit) query.set("limit", String(numberOption(args.limit, 20)));
    const data = await requestJson(apiBase, `/review-queue${query.toString() ? `?${query}` : ""}`, {
      token,
    });
    outputData(data, format, "review-list");
    return;
  }

  const id = positionals[1] || args.id;
  validateRequired(id, `review ${action} requires an id`);

  if (action === "approve") {
    const data = await requestJson(apiBase, `/review-queue/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      token,
      body: compactObject({
        source: buildSource(args),
        notes: args.notes,
      }),
    });
    outputData(data, format, "review-approve");
    return;
  }

  if (action === "reject") {
    const data = await requestJson(apiBase, `/review-queue/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      token,
      body: compactObject({
        source: buildSource(args),
        notes: args.notes,
      }),
    });
    outputData(data, format, "review-reject");
    return;
  }

  if (action === "show") {
    const data = await requestJson(apiBase, `/review-queue/${encodeURIComponent(id)}`, {
      token,
    });
    outputData(data, format, "review-show");
    return;
  }

  if (action === "edit-and-approve") {
    const data = await requestJson(apiBase, `/review-queue/${encodeURIComponent(id)}/edit-and-approve`, {
      method: "POST",
      token,
      body: compactObject({
        patch: compactObject({
          title: args.title,
          body: args.body,
          summary: args.summary,
          tags: collectTags(args),
          metadata: parseJsonOption(args.metadata),
        }),
        notes: args.notes,
        source: buildSource(args),
      }),
    });
    outputData(data, format, "review-edit-and-approve");
    return;
  }

  throw new Error(`Unknown review action: ${action}`);
}

async function runWorkspace(apiBase, token, format, args, positionals) {
  const action = positionals[0] || args.action || "current";

  if (action === "current") {
    const data = await requestJson(apiBase, "/workspace", { token });
    outputData(data, format, "workspace-current");
    return;
  }

  if (action === "list") {
    const data = await requestJson(apiBase, "/workspaces", { token });
    outputData(data, format, "workspace-list");
    return;
  }

  if (action === "create") {
    const rootPath = args.root || args.path || positionals[1];
    validateRequired(rootPath, "workspace create requires --root");
    const data = await requestJson(apiBase, "/workspaces", {
      method: "POST",
      token,
      body: compactObject({
        rootPath,
        workspaceName: args.name || args.title,
      }),
    });
    outputData(data, format, "workspace-create");
    return;
  }

  if (action === "open" || action === "switch") {
    const rootPath = args.root || args.path || positionals[1];
    validateRequired(rootPath, `workspace ${action} requires --root`);
    const data = await requestJson(apiBase, "/workspaces/open", {
      method: "POST",
      token,
      body: {
        rootPath,
      },
    });
    outputData(data, format, "workspace-open");
    return;
  }

  throw new Error(`Unknown workspace action: ${action}`);
}

function buildSource(args) {
  return {
    actorType: args["actor-type"] || args.actorType || DEFAULT_SOURCE.actorType,
    actorLabel: args["actor-label"] || args.actorLabel || DEFAULT_SOURCE.actorLabel,
    toolName: args["tool-name"] || args.toolName || DEFAULT_SOURCE.toolName,
    toolVersion: args["tool-version"] || args.toolVersion || DEFAULT_SOURCE.toolVersion,
  };
}

function outputData(data, format, command) {
  const payload = data?.data ?? data;

  if (format === "json") {
    writeStdout(renderJson(data));
    return;
  }

  if (format === "markdown" && command === "context") {
    writeStdout(renderBundleMarkdown(payload));
    return;
  }

  switch (command) {
    case "search":
      writeStdout(renderSearchResults(payload));
      return;
    case "get":
      writeStdout(renderNode(payload.node || payload));
      return;
    case "related":
      writeStdout(renderRelated(payload));
      return;
    case "review-list":
      writeStdout(renderReviewItems(payload));
      return;
    case "workspace-list":
      writeStdout(renderWorkspaces(payload));
      return;
    case "append":
    case "create":
    case "link":
    case "attach":
    case "review-approve":
    case "review-reject":
    case "review-show":
    case "workspace-current":
    case "workspace-create":
    case "workspace-open":
      writeStdout(renderText(payload));
      return;
    case "context":
      writeStdout(renderBundleText(payload));
      return;
    case "health":
      writeStdout(renderText(payload));
      return;
    default:
      writeStdout(renderText(payload));
  }
}

async function readBodyInput(args) {
  if (args.file) {
    return readFile(args.file, "utf8");
  }

  const value = args.body ?? args.text;
  if (!value) {
    return "";
  }

  if (value === "-") {
    return readAllStdin();
  }

  if (typeof value === "string" && value.startsWith("@")) {
    return readFile(value.slice(1), "utf8");
  }

  return value;
}

function readAllStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parseArgv(argv) {
  const options = {};
  const positionals = [];
  const args = {};
  let command = "";

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (value.startsWith("--")) {
      const [keyPart, inlineValue] = value.slice(2).split("=", 2);
      const key = toOptionKey(keyPart);
      const next = argv[index + 1];
      const optionValue =
        inlineValue !== undefined
          ? inlineValue
          : next && !next.startsWith("-")
            ? (index += 1, next)
            : true;
      options[key] = optionValue;
      continue;
    }

    if (!command) {
      command = value;
      continue;
    }

    positionals.push(value);
  }

  return {
    command: command === "review" ? "review" : command,
    args: options,
    options,
    positionals,
  };
}

function renderHelp() {
  return `Memforge CLI

Usage:
  pnw health
  pnw search "agent memory" [--type project] [--limit 5]
  pnw get <node-id>
  pnw related <node-id> [--depth 1]
  pnw context <target-id> [--mode compact] [--preset for-coding]
  pnw create --type note --title "..." [--body "..." | --file path.md]
  pnw append --target <node-id> --type agent_run_summary --text "..."
  pnw link <from-id> <to-id> <relation-type>
  pnw attach --node <node-id> --path artifacts/file.md
  pnw review list [--status pending]
  pnw review approve <id>
  pnw review reject <id>
  pnw review edit-and-approve <id> [--title "…"] [--body "…"]
  pnw workspace current
  pnw workspace list
  pnw workspace create --root /path/to/workspace [--name "Personal"]
  pnw workspace open --root /path/to/workspace

Global flags:
  --api <url>        Override API base URL
  --token <token>    Override bearer token
  --format <text|json|markdown>
`;
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value.flatMap(splitList);
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function compactObject(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(compactObject).filter((entry) => entry !== undefined);
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  );
}

function collectTags(args) {
  const tags = [];
  if (args.tag) tags.push(...splitList(args.tag));
  if (args.tags) tags.push(...splitList(args.tags));
  return tags.length > 0 ? tags : undefined;
}

function parseJsonOption(value) {
  if (!value) {
    return undefined;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function validateRequired(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function numberOption(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function guessTargetType(targetId) {
  if (targetId.startsWith("node_")) {
    return "node";
  }
  return "node";
}

function toOptionKey(value) {
  return value
    .replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    .replace(/^([A-Z])/, (match) => match.toLowerCase());
}

function writeStdout(value) {
  process.stdout.write(value);
}
