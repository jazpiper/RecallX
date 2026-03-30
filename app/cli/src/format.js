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

export function renderActivitySearchResults(data) {
  const items = data?.items || [];
  if (!items.length) {
    return "No activity results.\n";
  }

  return `${items
    .map((item, index) => {
      const headline = item.targetNodeTitle || item.targetNodeId;
      const body = item.body ? `\n  ${item.body}` : "";
      return `${index + 1}. ${headline} (${item.activityType})\n  id: ${item.id}\n  target: ${item.targetNodeId}\n  created: ${item.createdAt}${body}`;
    })
    .join("\n\n")}\n`;
}

export function renderWorkspaceSearchResults(data) {
  const items = data?.items || [];
  if (!items.length) {
    return "No workspace results.\n";
  }

  return `${items
    .map((item, index) => {
      if (item.resultType === "activity" && item.activity) {
        const headline = item.activity.targetNodeTitle || item.activity.targetNodeId;
        const body = item.activity.body ? `\n  ${item.activity.body}` : "";
        return `${index + 1}. [activity] ${headline} (${item.activity.activityType})\n  id: ${item.activity.id}\n  target: ${item.activity.targetNodeId}\n  created: ${item.activity.createdAt}${body}`;
      }

      const node = item.node || {};
      const summary = node.summary ? `\n  ${node.summary}` : "";
      return `${index + 1}. [node] ${node.title || node.id} (${node.type || "node"})\n  id: ${node.id}\n  status: ${node.status || ""}${summary}`;
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

export function renderGovernanceIssues(data) {
  const items = data?.items || [];
  if (!items.length) {
    return "No governance issues.\n";
  }

  return `${items
    .map(
      (item, index) =>
        `${index + 1}. ${item.title || item.entityId}\n  entity: ${item.entityType || ""}:${item.entityId || ""}\n  state: ${item.state || ""}\n  confidence: ${item.confidence ?? ""}\n  reasons: ${Array.isArray(item.reasons) ? item.reasons.join(", ") : ""}`,
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

export function renderWorkspaceBackups(data) {
  const items = data?.items || [];
  if (!items.length) {
    return "No backups.\n";
  }

  return `${items
    .map(
      (item, index) =>
        `${index + 1}. ${item.label || item.id}\n  id: ${item.id}\n  created: ${item.createdAt}\n  path: ${item.backupPath}`,
    )
    .join("\n\n")}\n`;
}

export function renderUpdateResult(data) {
  const lines = [
    `package: ${data?.packageName || ""}`,
    `current: ${data?.currentVersion || ""}`,
    `latest: ${data?.latestVersion || ""}`,
  ];

  if (data?.status === "updated") {
    lines.push("status: updated");
  } else if (data?.status === "up_to_date") {
    lines.push("status: up to date");
  } else {
    lines.push("status: update available");
  }

  if (data?.installCommand) {
    lines.push(`command: ${data.installCommand}`);
  }

  if (data?.status === "update_available" && data?.applied !== true) {
    lines.push("hint: re-run with `recallx update --apply` to install the latest npm package from this shell.");
  }

  if (data?.packageRoot) {
    lines.push(`packageRoot: ${data.packageRoot}`);
  }

  return `${lines.join("\n")}\n`;
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

export function renderTelemetrySummary(data) {
  const lines = [
    `since: ${data?.since || ""}`,
    `logs: ${data?.logsPath || ""}`,
    `events: ${data?.totalEvents ?? 0}`,
    `slow threshold: ${data?.slowRequestThresholdMs ?? ""}ms`,
  ];

  const hot = Array.isArray(data?.hotOperations) ? data.hotOperations : [];
  if (hot.length > 0) {
    lines.push("");
    lines.push("Hot operations:");
    for (const item of hot.slice(0, 5)) {
      lines.push(`- [${item.surface}] ${item.operation} p95=${item.p95DurationMs ?? ""}ms errors=${item.errorCount}/${item.count}`);
    }
  }

  const slow = Array.isArray(data?.slowOperations) ? data.slowOperations : [];
  if (slow.length > 0) {
    lines.push("");
    lines.push("Slow operations:");
    for (const item of slow.slice(0, 5)) {
      lines.push(`- [${item.surface}] ${item.operation} p95=${item.p95DurationMs ?? ""}ms errors=${item.errorCount}/${item.count}`);
    }
  }

  const mcpFailures = Array.isArray(data?.mcpToolFailures) ? data.mcpToolFailures : [];
  if (mcpFailures.length > 0) {
    lines.push("");
    lines.push("MCP failures:");
    for (const item of mcpFailures.slice(0, 5)) {
      lines.push(`- ${item.operation}: ${item.count}`);
    }
  }

  if (data?.ftsFallbackRate) {
    lines.push("");
    lines.push(
      `fts fallback: ${data.ftsFallbackRate.fallbackCount}/${data.ftsFallbackRate.sampleCount} (${data.ftsFallbackRate.ratio ?? "n/a"})`
    );
  }
  if (data?.searchHitRate) {
    lines.push(
      `search hit rate: ${data.searchHitRate.hitCount}/${data.searchHitRate.sampleCount} (${data.searchHitRate.ratio ?? "n/a"})`
    );
    const searchHitOps = Array.isArray(data.searchHitRate.operations) ? data.searchHitRate.operations : [];
    for (const item of searchHitOps.slice(0, 5)) {
      lines.push(
        `- [${item.surface}] ${item.operation}: ${item.hitCount}/${item.sampleCount} hits (${item.ratio ?? "n/a"})`
      );
    }
  }
  if (data?.searchLexicalQualityRate) {
    lines.push(
      `lexical quality: strong=${data.searchLexicalQualityRate.strongCount}, weak=${data.searchLexicalQualityRate.weakCount}, none=${data.searchLexicalQualityRate.noneCount}`
    );
  }
  if (data?.workspaceResultCompositionRate) {
    lines.push(
      `workspace composition: node_only=${data.workspaceResultCompositionRate.nodeOnlyCount}, semantic_node_only=${data.workspaceResultCompositionRate.semanticNodeOnlyCount}, activity_only=${data.workspaceResultCompositionRate.activityOnlyCount}, mixed=${data.workspaceResultCompositionRate.mixedCount}, semantic_mixed=${data.workspaceResultCompositionRate.semanticMixedCount}, empty=${data.workspaceResultCompositionRate.emptyCount}`
    );
  }
  if (data?.workspaceFallbackModeRate) {
    lines.push(
      `workspace fallback modes: strict_zero=${data.workspaceFallbackModeRate.strictZeroCount}, no_strong_node_hit=${data.workspaceFallbackModeRate.noStrongNodeHitCount}`
    );
  }
  if (data?.searchFeedbackRate) {
    lines.push(
      `search feedback: useful=${data.searchFeedbackRate.usefulCount}/${data.searchFeedbackRate.sampleCount} (${data.searchFeedbackRate.usefulRatio ?? "n/a"}), top1=${data.searchFeedbackRate.top1UsefulCount}/${data.searchFeedbackRate.top1SampleCount} (${data.searchFeedbackRate.top1UsefulRatio ?? "n/a"}), top3=${data.searchFeedbackRate.top3UsefulCount}/${data.searchFeedbackRate.top3SampleCount} (${data.searchFeedbackRate.top3UsefulRatio ?? "n/a"}), semantic_fp=${data.searchFeedbackRate.semanticFalsePositiveRatio ?? "n/a"}`
    );
    const qualityBuckets = Array.isArray(data.searchFeedbackRate.byLexicalQuality) ? data.searchFeedbackRate.byLexicalQuality : [];
    for (const item of qualityBuckets) {
      lines.push(
        `- feedback [${item.lexicalQuality}]: ${item.usefulCount}/${item.sampleCount} useful (${item.usefulRatio ?? "n/a"})`
      );
    }
    const fallbackModeBuckets = Array.isArray(data.searchFeedbackRate.byFallbackMode) ? data.searchFeedbackRate.byFallbackMode : [];
    for (const item of fallbackModeBuckets) {
      lines.push(
        `- feedback mode [${item.fallbackMode}]: ${item.usefulCount}/${item.sampleCount} useful (${item.usefulRatio ?? "n/a"})`
      );
    }
  }
  if (data?.semanticAugmentationRate) {
    lines.push(
      `semantic augmentation: ${data.semanticAugmentationRate.usedCount}/${data.semanticAugmentationRate.sampleCount} (${data.semanticAugmentationRate.ratio ?? "n/a"})`
    );
  }
  if (data?.semanticFallbackRate) {
    lines.push(
      `semantic fallback: eligible=${data.semanticFallbackRate.eligibleCount}, attempted=${data.semanticFallbackRate.attemptedCount}, hit=${data.semanticFallbackRate.hitCount}, hit_ratio=${data.semanticFallbackRate.hitRatio ?? "n/a"}`
    );
    const fallbackModes = Array.isArray(data.semanticFallbackRate.modes) ? data.semanticFallbackRate.modes : [];
    for (const item of fallbackModes) {
      lines.push(
        `- fallback mode [${item.fallbackMode}]: attempted=${item.attemptedCount}/${item.eligibleCount} (${item.attemptRatio ?? "n/a"}), hit=${item.hitCount}/${item.attemptedCount} (${item.hitRatio ?? "n/a"})`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderTelemetryErrors(data) {
  const items = data?.items || [];
  if (!items.length) {
    return "No telemetry errors.\n";
  }

  return `${items
    .map(
      (item, index) =>
        `${index + 1}. [${item.surface}] ${item.operation}\n  ts: ${item.ts}\n  trace: ${item.traceId}\n  span: ${item.spanId ?? ""}\n  parent: ${item.parentSpanId ?? ""}\n  error: ${item.errorKind || ""}/${item.errorCode || ""}\n  status: ${item.statusCode ?? ""}\n  durationMs: ${item.durationMs ?? ""}`
    )
    .join("\n\n")}\n`;
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
