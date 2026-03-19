import type { BuildContextBundleInput, RelationType } from "../shared/contracts.js";
import type { ContextBundle, NeighborhoodItem, RelationUsageSummary, SearchResultItem } from "../shared/types.js";
import type { MemforgeRepository } from "./repositories.js";
import { computeUsageBonus, relationTypeSpecificityBonus } from "./relation-scoring.js";

function prioritizeItems(
  items: SearchResultItem[],
  preset: BuildContextBundleInput["preset"],
  maxItems: number,
  bonuses?: Map<string, number>
): SearchResultItem[] {
  const weighted = [...items].sort((left, right) => {
    const leftScore = scoreItem(left, preset) + (bonuses?.get(left.id) ?? 0);
    const rightScore = scoreItem(right, preset) + (bonuses?.get(right.id) ?? 0);
    return rightScore - leftScore || right.updatedAt.localeCompare(left.updatedAt);
  });

  return weighted.slice(0, maxItems);
}

function scoreItem(item: SearchResultItem, preset: BuildContextBundleInput["preset"]): number {
  let score = 0;
  if (item.canonicality === "canonical") score += 30;
  if (item.status === "active") score += 10;

  if (preset === "for-coding") {
    if (item.type === "project") score += 40;
    if (item.type === "decision") score += 25;
    if (item.type === "reference") score += 20;
  }

  if (preset === "for-research") {
    if (item.type === "reference") score += 35;
    if (item.type === "idea") score += 20;
    if (item.type === "question") score += 20;
  }

  if (preset === "for-assistant") {
    if (item.type === "project") score += 25;
    if (item.type === "note") score += 20;
    if (item.type === "question") score += 10;
  }

  return score;
}

function computeNeighborhoodRank(item: NeighborhoodItem, summary?: RelationUsageSummary): number {
  const usageBonus = computeUsageBonus(summary);
  const specificityBonus = relationTypeSpecificityBonus(item.edge.relationType);
  if (item.edge.relationSource === "canonical") {
    return 2 + specificityBonus + usageBonus;
  }
  return (item.edge.relationScore ?? 0) + specificityBonus + usageBonus;
}

function computeBundleRelationBoost(item: NeighborhoodItem, summary?: RelationUsageSummary): number {
  const usageBonus = computeUsageBonus(summary);
  if (item.edge.relationSource === "canonical") {
    return 120 + relationTypeSpecificityBonus(item.edge.relationType) * 100 + usageBonus * 80;
  }
  return ((item.edge.relationScore ?? 0) + relationTypeSpecificityBonus(item.edge.relationType) + usageBonus) * 40;
}

function formatRelationReason(baseReason: string, summary?: RelationUsageSummary): string {
  const usageBonus = computeUsageBonus(summary);
  if (!usageBonus) {
    return baseReason;
  }
  const direction = usageBonus > 0 ? "+" : "";
  return `${baseReason}, usage ${direction}${usageBonus.toFixed(2)}`;
}

export function buildNeighborhoodItems(
  repository: MemforgeRepository,
  nodeId: string,
  options?: {
    relationTypes?: RelationType[];
    includeInferred?: boolean;
    maxInferred?: number;
  }
): NeighborhoodItem[] {
  const canonicalItems: NeighborhoodItem[] = repository.listRelatedNodes(nodeId, 1, options?.relationTypes).map(({ node, relation }) => ({
    node,
    edge: {
      relationId: relation.id,
      relationType: relation.relationType,
      relationSource: "canonical" as const,
      relationStatus: relation.status,
      relationScore: null,
      generator: null,
      reason: `Related via ${relation.relationType}`,
      direction: relation.fromNodeId === nodeId ? ("outgoing" as const) : ("incoming" as const),
      hop: 1
    }
  }));
  const seenNodeIds = new Set(canonicalItems.map((item) => item.node.id));
  const inferredItems: NeighborhoodItem[] =
    options?.includeInferred && options.maxInferred
      ? repository
          .listInferredRelationsForNode(nodeId, Math.max(options.maxInferred * 3, options.maxInferred))
          .filter((relation) => !options.relationTypes?.length || options.relationTypes.includes(relation.relationType))
          .map((relation) => {
            const relatedNodeId = relation.fromNodeId === nodeId ? relation.toNodeId : relation.fromNodeId;
            const node = repository.getNode(relatedNodeId);
            return {
              node,
              edge: {
                relationId: relation.id,
                relationType: relation.relationType,
                relationSource: "inferred" as const,
                relationStatus: relation.status,
                relationScore: relation.finalScore,
                generator: relation.generator,
                reason: `Inferred via ${relation.relationType} (score ${relation.finalScore.toFixed(2)})`,
                direction: relation.fromNodeId === nodeId ? ("outgoing" as const) : ("incoming" as const),
                hop: 1
              }
            };
          })
          .filter((item) => {
            if (seenNodeIds.has(item.node.id)) {
              return false;
            }
            seenNodeIds.add(item.node.id);
            return true;
          })
      : [];

  const usageSummaries = repository.getRelationUsageSummaries(
    [...canonicalItems, ...inferredItems].map((item) => item.edge.relationId)
  );

  const rankedCanonical = canonicalItems
    .map((item) => ({
      item: {
        ...item,
        edge: {
          ...item.edge,
          reason: formatRelationReason(item.edge.reason, usageSummaries.get(item.edge.relationId))
        }
      },
      rank: computeNeighborhoodRank(item, usageSummaries.get(item.edge.relationId))
    }))
    .sort((left, right) => right.rank - left.rank)
    .map((entry) => entry.item);

  const rankedInferred = inferredItems
    .map((item) => ({
      item: {
        ...item,
        edge: {
          ...item.edge,
          reason: formatRelationReason(item.edge.reason, usageSummaries.get(item.edge.relationId))
        }
      },
      rank: computeNeighborhoodRank(item, usageSummaries.get(item.edge.relationId))
    }))
    .sort((left, right) => right.rank - left.rank)
    .slice(0, options?.maxInferred ?? 0)
    .map((entry) => entry.item);

  return [...rankedCanonical, ...rankedInferred];
}

export function buildContextBundle(
  repository: MemforgeRepository,
  input: BuildContextBundleInput
): ContextBundle {
  const target = repository.getNode(input.target.id);
  const neighborhood = input.options.includeRelated
    ? buildNeighborhoodItems(repository, target.id, {
        includeInferred: input.options.includeInferred,
        maxInferred: input.options.maxInferred
      })
    : [];
  const related = neighborhood.map((item) => ({
    nodeId: item.node.id,
    type: item.node.type,
    title: item.node.title,
    summary: item.node.summary,
    reason: item.edge.reason,
    relationType: item.edge.relationType,
    relationSource: item.edge.relationSource,
    relationStatus: item.edge.relationStatus,
    relationScore: item.edge.relationScore ?? undefined,
    generator: item.edge.generator
  }));

  const decisions = input.options.includeDecisions
    ? repository
        .searchNodes({
          query: "",
          filters: { types: ["decision"], status: ["active", "review"] },
          limit: Math.min(input.options.maxItems, 10),
          offset: 0,
          sort: "updated_at"
        })
        .items.filter((item) => item.id === target.id || neighborhood.some((relatedItem) => relatedItem.node.id === item.id))
    : [];

  const openQuestions = input.options.includeOpenQuestions
    ? repository
        .searchNodes({
          query: "",
          filters: { types: ["question"], status: ["active", "draft", "review"] },
          limit: Math.min(input.options.maxItems, 10),
          offset: 0,
          sort: "updated_at"
        })
        .items.filter((item) => item.id === target.id || neighborhood.some((relatedItem) => relatedItem.node.id === item.id))
    : [];

  const targetItem: SearchResultItem = {
    id: target.id,
    type: target.type,
    title: target.title,
    summary: target.summary,
    status: target.status,
    canonicality: target.canonicality,
    sourceLabel: target.sourceLabel,
    updatedAt: target.updatedAt,
    tags: target.tags
  };
  const relatedItems: SearchResultItem[] = neighborhood.map((item) => ({
    id: item.node.id,
    type: item.node.type,
    title: item.node.title,
    summary: item.node.summary,
    status: item.node.status,
    canonicality: item.node.canonicality,
    sourceLabel: item.node.sourceLabel,
    updatedAt: item.node.updatedAt,
    tags: item.node.tags
  }));
  const bundleUsageSummaries = repository.getRelationUsageSummaries(neighborhood.map((item) => item.edge.relationId));
  const relationBonuses = new Map(
    neighborhood.map((item) => [
      item.node.id,
      computeBundleRelationBoost(item, bundleUsageSummaries.get(item.edge.relationId))
    ])
  );

  const baseItems = prioritizeItems(
    [targetItem, ...relatedItems, ...decisions, ...openQuestions],
    input.preset,
    input.mode === "micro" ? Math.min(input.options.maxItems, 5) : input.options.maxItems,
    relationBonuses
  );

  const itemById = new Map(related.map((item) => [item.nodeId, item]));

  return {
    target: {
      type: input.target.type,
      id: target.id,
      title: target.title
    },
    mode: input.mode,
    preset: input.preset,
    summary: target.summary ?? "No target summary yet.",
    items: baseItems.map((item) => ({
      nodeId: item.id,
      type: item.type,
      title: item.title,
      summary: item.summary,
      reason: itemById.get(item.id)?.reason ?? (item.id === target.id ? "Primary target" : `Included for ${input.preset}`),
      relationType: itemById.get(item.id)?.relationType,
      relationSource: itemById.get(item.id)?.relationSource,
      relationStatus: itemById.get(item.id)?.relationStatus,
      relationScore: itemById.get(item.id)?.relationScore,
      generator: itemById.get(item.id)?.generator ?? null
    })),
    activityDigest: input.options.includeRecentActivities
      ? repository
          .listNodeActivities(target.id, input.mode === "micro" ? 3 : 6)
          .map((activity) => `${activity.activityType}: ${activity.body ?? "No details"}`)
      : [],
    decisions,
    openQuestions,
    sources: baseItems.map((item) => ({
      nodeId: item.id,
      sourceLabel: item.sourceLabel
    }))
  };
}

export function bundleAsMarkdown(bundle: ContextBundle): string {
  const sections = [
    `# ${bundle.target.title ?? bundle.target.id}`,
    "",
    `Mode: ${bundle.mode}`,
    `Preset: ${bundle.preset}`,
    "",
    "## Summary",
    bundle.summary,
    "",
    "## Items",
    ...bundle.items.map((item) => `- ${item.title ?? item.nodeId}: ${item.summary ?? "No summary"} (${item.reason})`)
  ];

  if (bundle.decisions.length) {
    sections.push("", "## Decisions", ...bundle.decisions.map((item) => `- ${item.title ?? item.id}: ${item.summary ?? "No summary"}`));
  }

  if (bundle.openQuestions.length) {
    sections.push("", "## Open Questions", ...bundle.openQuestions.map((item) => `- ${item.title ?? item.id}`));
  }

  if (bundle.activityDigest.length) {
    sections.push("", "## Recent Activities", ...bundle.activityDigest.map((item) => `- ${item}`));
  }

  return sections.join("\n");
}
