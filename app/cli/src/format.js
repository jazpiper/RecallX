function pad(label, value) {
  return `${label}: ${value ?? ""}`;
}

export function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function renderText(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return `${value}\n`;
  }

  if (Array.isArray(value)) {
    return `${value.map((item) => `- ${renderInline(item)}`).join("\n")}\n`;
  }

  if (typeof value === "object") {
    return `${Object.entries(value)
      .map(([key, entry]) => `${key}: ${renderInline(entry)}`)
      .join("\n")}\n`;
  }

  return `${String(value)}\n`;
}

export function renderNode(node) {
  const lines = [
    `${node.title || node.id}`,
    pad("id", node.id),
    pad("type", node.type),
    pad("status", node.status),
    pad("canonicality", node.canonicality),
    pad("summary", node.summary),
    pad("source", node.sourceLabel || node.source_label || ""),
  ];

  if (Array.isArray(node.tags) && node.tags.length > 0) {
    lines.push(pad("tags", node.tags.join(", ")));
  }

  if (node.body) {
    lines.push("");
    lines.push(node.body);
  }

  return `${lines.join("\n")}\n`;
}

export function renderSearchResults(data) {
  const items = data?.items || [];
  if (!items.length) {
    return "No results.\n";
  }

  return `${items
    .map((item, index) => {
      const summary = item.summary ? `\n  ${item.summary}` : "";
      return `${index + 1}. ${item.title || item.id} (${item.type || "node"})\n  id: ${item.id}\n  status: ${item.status || ""}${summary}`;
    })
    .join("\n\n")}\n`;
}

export function renderRelated(data) {
  const items = data?.items || data?.related || [];
  if (!items.length) {
    return "No related nodes.\n";
  }

  return `${items
    .map((item, index) => {
      const node = item?.node || item;
      const relation = item?.relation || item;
      return `${index + 1}. ${node?.title || node?.nodeId || node?.id} (${relation?.relationType || node?.type || ""})`;
    })
    .join("\n")}\n`;
}

export function renderActivities(data) {
  const items = data?.items || [];
  if (!items.length) {
    return "No activities.\n";
  }

  return `${items
    .map((item, index) => `${index + 1}. ${item.activityType || item.type} - ${item.body || ""}`)
    .join("\n")}\n`;
}

export function renderReviewItems(data) {
  const items = data?.items || [];
  if (!items.length) {
    return "No review items.\n";
  }

  return `${items
    .map(
      (item, index) =>
        `${index + 1}. ${item.id} (${item.reviewType || item.type || ""})\n  entity: ${item.entityType || ""}:${item.entityId || ""}\n  status: ${item.status || ""}`,
    )
    .join("\n\n")}\n`;
}

export function renderWorkspaces(data) {
  const items = data?.items || [];
  if (!items.length) {
    return "No workspaces.\n";
  }

  return `${items
    .map((item, index) => {
      const marker = item.isCurrent ? "*" : " ";
      return `${index + 1}. ${marker} ${item.workspaceName}\n  root: ${item.rootPath}\n  auth: ${item.authMode || ""}`;
    })
    .join("\n\n")}\n`;
}

export function renderBundleMarkdown(bundle) {
  const lines = [];
  lines.push(`# ${bundle.target?.title || bundle.target?.id || "Context bundle"}`);
  lines.push("");
  lines.push(`- mode: ${bundle.mode || ""}`);
  lines.push(`- preset: ${bundle.preset || ""}`);
  if (bundle.summary) {
    lines.push("");
    lines.push(bundle.summary);
  }
  if (Array.isArray(bundle.items) && bundle.items.length > 0) {
    lines.push("");
    lines.push("## Items");
    for (const item of bundle.items) {
      lines.push(`- ${item.title || item.nodeId || item.id}${item.summary ? `: ${item.summary}` : ""}`);
    }
  }
  if (Array.isArray(bundle.sources) && bundle.sources.length > 0) {
    lines.push("");
    lines.push("## Sources");
    for (const source of bundle.sources) {
      lines.push(`- ${source.nodeId || source.id}${source.sourceLabel ? ` (${source.sourceLabel})` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderBundleText(bundle) {
  return renderBundleMarkdown(bundle);
}

function renderInline(value) {
  if (value == null) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(renderInline).join(", ");
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}
