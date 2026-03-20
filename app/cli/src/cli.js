import { readFile } from "node:fs/promises";
import { getApiBase, getAuthToken, requestJson } from "./http.js";
import {
  renderActivitySearchResults,
  renderBundleText,
  renderGovernanceIssues,
  renderJson,
  renderNode,
  renderRelated,
  renderSearchResults,
  renderTelemetryErrors,
  renderTelemetrySummary,
  renderText,
  renderWorkspaceSearchResults,
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
    case "neighborhood":
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
    case "feedback":
      return runFeedback(apiBase, token, format, args, positionals);
    case "governance":
      return runGovernance(apiBase, token, format, args, positionals);
    case "workspace":
      return runWorkspace(apiBase, token, format, args, positionals);
    case "observability":
      return runObservability(apiBase, token, format, args, positionals);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runHealth(apiBase, token, format) {
  const data = await requestJson(apiBase, "/health", { token });
  outputData(data, format, "health");
}

async function runSearch(apiBase, token, format, args, positionals) {
  const mode = args.mode || positionals[0];
  if (mode === "activities" || mode === "activity") {
    return runActivitySearch(apiBase, token, format, args, positionals.slice(1));
  }
  if (mode === "workspace" || mode === "all") {
    return runWorkspaceSearch(apiBase, token, format, args, positionals.slice(1));
  }

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

async function runActivitySearch(apiBase, token, format, args, positionals) {
  const filters = {};
  const query = args.query || positionals.join(" ");

  if (args["target-node-id"] || args.targetNodeId) {
    filters.targetNodeIds = splitList(args["target-node-id"] || args.targetNodeId);
  }
  if (args.type || args["activity-type"] || args.activityType) {
    filters.activityTypes = splitList(args.type || args["activity-type"] || args.activityType);
  }
  if (args["source-label"]) {
    filters.sourceLabels = splitList(args["source-label"]);
  }
  if (args["created-after"] || args.createdAfter) {
    filters.createdAfter = args["created-after"] || args.createdAfter;
  }
  if (args["created-before"] || args.createdBefore) {
    filters.createdBefore = args["created-before"] || args.createdBefore;
  }

  const data = await requestJson(apiBase, "/activities/search", {
    method: "POST",
    token,
    body: compactObject({
      query,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      limit: numberOption(args.limit, 10),
      offset: numberOption(args.offset, 0),
      sort: args.sort || "relevance",
    }),
  });
  outputData(data, format, "search-activities");
}

async function runWorkspaceSearch(apiBase, token, format, args, positionals) {
  const nodeFilters = {};
  const activityFilters = {};
  const query = args.query || positionals.join(" ");
  const scopes = args.scopes ? splitList(args.scopes) : ["nodes", "activities"];

  if (args["node-type"]) nodeFilters.types = splitList(args["node-type"]);
  if (args.status) nodeFilters.status = splitList(args.status);
  if (args.tag || args.tags) nodeFilters.tags = splitList(args.tag || args.tags);
  if (args["node-source-label"]) nodeFilters.sourceLabels = splitList(args["node-source-label"]);

  if (args["target-node-id"] || args.targetNodeId) {
    activityFilters.targetNodeIds = splitList(args["target-node-id"] || args.targetNodeId);
  }
  if (args["activity-type"] || args.activityType) {
    activityFilters.activityTypes = splitList(args["activity-type"] || args.activityType);
  }
  if (args["activity-source-label"]) {
    activityFilters.sourceLabels = splitList(args["activity-source-label"]);
  }
  if (args["created-after"] || args.createdAfter) {
    activityFilters.createdAfter = args["created-after"] || args.createdAfter;
  }
  if (args["created-before"] || args.createdBefore) {
    activityFilters.createdBefore = args["created-before"] || args.createdBefore;
  }

  const data = await requestJson(apiBase, "/search", {
    method: "POST",
    token,
    body: compactObject({
      query,
      scopes,
      nodeFilters: Object.keys(nodeFilters).length > 0 ? nodeFilters : undefined,
      activityFilters: Object.keys(activityFilters).length > 0 ? activityFilters : undefined,
      limit: numberOption(args.limit, 10),
      offset: numberOption(args.offset, 0),
      sort: args.sort || "relevance",
    }),
  });
  outputData(data, format, "search-workspace");
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
    throw new Error("neighborhood requires a node id");
  }

  const query = new URLSearchParams();
  if (args.depth) query.set("depth", String(numberOption(args.depth, 1)));
  if (args.type) query.set("types", splitList(args.type).join(","));
  if (args["include-inferred"] !== undefined) {
    query.set("include_inferred", parseBooleanFlag(args["include-inferred"], true) ? "1" : "0");
  }
  if (args["max-inferred"] !== undefined) {
    query.set("max_inferred", String(numberOption(args["max-inferred"], 4)));
  }

  const data = await requestJson(
    apiBase,
    `/nodes/${encodeURIComponent(id)}/neighborhood${query.toString() ? `?${query}` : ""}`,
    {
      token,
    },
  );
  outputData(data, format, "related");
}

async function runContext(apiBase, token, format, args, positionals) {
  const targetId = args.id || args.target || positionals[0];
  const payload = {
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

  if (targetId) {
    payload.target = {
      id: targetId,
    };
  }

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

async function runFeedback(apiBase, token, format, args, positionals) {
  const resultType = args["result-type"] || args.resultType || positionals[0];
  const resultId = args["result-id"] || args.resultId || positionals[1];
  const verdict = args.verdict || positionals[2];

  validateRequired(resultType, "feedback requires --result-type");
  validateRequired(resultId, "feedback requires --result-id");
  validateRequired(verdict, "feedback requires --verdict");

  return runPostCommand(apiBase, token, format, "/search-feedback-events", "feedback", {
    resultType,
    resultId,
    verdict,
    query: args.query,
    sessionId: args["session-id"] || args.sessionId,
    runId: args["run-id"] || args.runId,
    confidence: numberOption(args.confidence, 1),
    source: buildSource(args),
    metadata: parseJsonOption(args.metadata),
  });
}

async function runGovernance(apiBase, token, format, args, positionals) {
  const action = positionals[0] || args.action || "list";

  switch (action) {
    case "list":
    case "issues": {
      const query = new URLSearchParams();
      if (args.states) query.set("states", splitList(args.states).join(","));
      if (args.limit) query.set("limit", String(numberOption(args.limit, 20)));
      const data = await requestJson(apiBase, `/governance/issues${query.toString() ? `?${query}` : ""}`, {
        token,
      });
      outputData(data, format, "governance-issues");
      return;
    }
    case "show": {
      const entityType = args["entity-type"] || args.entityType || positionals[1];
      const entityId = args["entity-id"] || args.entityId || positionals[2];
      validateRequired(entityType, "governance show requires --entity-type");
      validateRequired(entityId, "governance show requires --entity-id");
      const data = await requestJson(
        apiBase,
        `/governance/state/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
        {
          token,
        }
      );
      outputData(data, format, "governance-show");
      return;
    }
    case "recompute": {
      const data = await requestJson(apiBase, "/governance/recompute", {
        method: "POST",
        token,
        body: compactObject({
          entityType: args["entity-type"] || args.entityType,
          entityIds: args["entity-ids"] || args.entityIds ? splitList(args["entity-ids"] || args.entityIds) : undefined,
          limit: numberOption(args.limit, 100),
        }),
      });
      outputData(data, format, "governance-recompute");
      return;
    }
  }

  throw new Error(`Unknown governance action: ${action}`);
}

async function runWorkspace(apiBase, token, format, args, positionals) {
  const action = positionals[0] || args.action || "current";

  switch (action) {
    case "current": {
      const data = await requestJson(apiBase, "/workspace", { token });
      outputData(data, format, "workspace-current");
      return;
    }
    case "list": {
      const data = await requestJson(apiBase, "/workspaces", { token });
      outputData(data, format, "workspace-list");
      return;
    }
    case "create":
      return runWorkspaceMutation(apiBase, token, format, {
        action: "create",
        rootPath: args.root || args.path || positionals[1],
        workspaceName: args.name || args.title,
      });
    case "open":
    case "switch":
      return runWorkspaceMutation(apiBase, token, format, {
        action,
        rootPath: args.root || args.path || positionals[1],
      });
  }

  throw new Error(`Unknown workspace action: ${action}`);
}

async function runObservability(apiBase, token, format, args, positionals) {
  const action = positionals[0] || args.action || "summary";

  switch (action) {
    case "summary": {
      const query = new URLSearchParams();
      query.set("since", args.since || "24h");
      const data = await requestJson(apiBase, `/observability/summary?${query.toString()}`, { token });
      outputData(data, format, "observability-summary");
      return;
    }
    case "errors": {
      const query = new URLSearchParams();
      query.set("since", args.since || "24h");
      if (args.surface) query.set("surface", args.surface);
      if (args.limit) query.set("limit", String(numberOption(args.limit, 50)));
      const data = await requestJson(apiBase, `/observability/errors?${query.toString()}`, { token });
      outputData(data, format, "observability-errors");
      return;
    }
  }

  throw new Error(`Unknown observability action: ${action}`);
}

function buildSource(args) {
  return {
    actorType: args["actor-type"] || args.actorType || DEFAULT_SOURCE.actorType,
    actorLabel: args["actor-label"] || args.actorLabel || DEFAULT_SOURCE.actorLabel,
    toolName: args["tool-name"] || args.toolName || DEFAULT_SOURCE.toolName,
    toolVersion: args["tool-version"] || args.toolVersion || DEFAULT_SOURCE.toolVersion,
  };
}

async function runWorkspaceMutation(apiBase, token, format, { action, rootPath, workspaceName }) {
  validateRequired(rootPath, `workspace ${action} requires --root`);
  return runPostCommand(
    apiBase,
    token,
    format,
    action === "create" ? "/workspaces" : "/workspaces/open",
    action === "create" ? "workspace-create" : "workspace-open",
    action === "create"
      ? {
          rootPath,
          workspaceName,
        }
      : {
          rootPath,
        },
  );
}

async function runPostCommand(apiBase, token, format, path, command, body) {
  const data = await requestJson(apiBase, path, {
    method: "POST",
    token,
    body: compactObject(body),
  });
  outputData(data, format, command);
}

function outputData(data, format, command) {
  const payload = data?.data ?? data;

  if (format === "json") {
    writeStdout(renderJson(data));
    return;
  }

  switch (command) {
    case "search":
      writeStdout(renderSearchResults(payload));
      return;
    case "search-activities":
      writeStdout(renderActivitySearchResults(payload));
      return;
    case "search-workspace":
      writeStdout(renderWorkspaceSearchResults(payload));
      return;
    case "get":
      writeStdout(renderNode(payload.node || payload));
      return;
    case "related":
      writeStdout(renderRelated(payload));
      return;
    case "governance-issues":
      writeStdout(renderGovernanceIssues(payload));
      return;
    case "workspace-list":
      writeStdout(renderWorkspaces(payload));
      return;
    case "append":
    case "create":
    case "link":
    case "attach":
    case "feedback":
    case "governance-show":
    case "governance-recompute":
    case "workspace-current":
    case "workspace-create":
    case "workspace-open":
      writeStdout(renderText(payload));
      return;
    case "observability-summary":
      writeStdout(renderTelemetrySummary(payload));
      return;
    case "observability-errors":
      writeStdout(renderTelemetryErrors(payload));
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
    command,
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
  pnw search activities "what changed" [--activity-type agent_run_summary]
  pnw search workspace "cleanup" [--scopes nodes,activities]
  pnw get <node-id>
  pnw neighborhood <node-id> [--depth 1] [--include-inferred true] [--max-inferred 4]
  pnw related <node-id> [--depth 1]  # legacy compatibility alias
  pnw context <target-id> [--mode compact] [--preset for-coding]
  pnw create --type note --title "..." [--body "..." | --file path.md]
  pnw append --target <node-id> --type agent_run_summary --text "..."
  pnw link <from-id> <to-id> <relation-type>
  pnw attach --node <node-id> --path artifacts/file.md
  pnw feedback --result-type node --result-id <id> --verdict useful [--query "..."]
  pnw governance issues [--states contested,low_confidence]
  pnw governance show --entity-type node --entity-id <id>
  pnw governance recompute [--entity-type node] [--entity-ids id1,id2]
  pnw workspace current
  pnw workspace list
  pnw workspace create --root /path/to/workspace [--name "Personal"]
  pnw workspace open --root /path/to/workspace
  pnw observability summary [--since 24h]
  pnw observability errors [--since 24h] [--surface mcp] [--limit 50]

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

function toOptionKey(value) {
  return value
    .replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    .replace(/^([A-Z])/, (match) => match.toLowerCase());
}

function writeStdout(value) {
  process.stdout.write(value);
}
