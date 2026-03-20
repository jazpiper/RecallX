import type { BuildContextBundleInput, RelationType } from "../shared/contracts.js";
import type { ContextBundle, NeighborhoodItem, RelationUsageSummary, SearchResultItem } from "../shared/types.js";
import { appendCurrentTelemetryDetails } from "./observability.js";
import type { MemforgeRepository } from "./repositories.js";
import { computeUsageBonus, relationTypeSpecificityBonus } from "./relation-scoring.js";

export type RetrievalRankWeights = {
  canonicalBase: number;
  canonicalSpecificityMultiplier: number;
  canonicalUsageMultiplier: number;
  inferredBaseMultiplier: number;
  inferredSpecificityMultiplier: number;
  inferredUsageMultiplier: number;
};

const neighborhoodRetrievalRankWeights: RetrievalRankWeights = {
  canonicalBase: 2,
  canonicalSpecificityMultiplier: 1,
  canonicalUsageMultiplier: 1,
  inferredBaseMultiplier: 1,
  inferredSpecificityMultiplier: 1,
  inferredUsageMultiplier: 1
};

const boostedRelationRankWeights: RetrievalRankWeights = {
  canonicalBase: 70,
  canonicalSpecificityMultiplier: 100,
  canonicalUsageMultiplier: 60,
  inferredBaseMultiplier: 35,
  inferredSpecificityMultiplier: 35,
  inferredUsageMultiplier: 35
};

const semanticCandidateMinSimilarity = 0.2;
const semanticCandidateMaxBonus = 18;

type SemanticAugmentationSettings = {
  minSimilarity?: number;
  maxBonus?: number;
};

export type SemanticCandidateMatch = {
  similarity: number;
  matchedChunks: number;
};

export type SemanticCandidateBonus = {
  retrievalRank: number;
  semanticSimilarity: number;
  reason: string;
};

function resolveSemanticAugmentationSettings(settings?: SemanticAugmentationSettings): Required<SemanticAugmentationSettings> {
  return {
    minSimilarity:
      typeof settings?.minSimilarity === "number" && Number.isFinite(settings.minSimilarity)
        ? Math.min(Math.max(settings.minSimilarity, 0), 1)
        : semanticCandidateMinSimilarity,
    maxBonus:
      typeof settings?.maxBonus === "number" && Number.isFinite(settings.maxBonus)
        ? Math.max(settings.maxBonus, 0)
        : semanticCandidateMaxBonus
  };
}

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

function matchesSearchResultFilters(
  item: SearchResultItem,
  filters: {
    types?: string[];
    status?: string[];
  }
) {
  const typeMatches = !filters.types?.length || filters.types.includes(item.type);
  const statusMatches = !filters.status?.length || filters.status.includes(item.status);
  return typeMatches && statusMatches;
}

function rankNeighborhoodItems(
  items: NeighborhoodItem[],
  usageSummaries: Map<string, RelationUsageSummary>,
  weights: RetrievalRankWeights,
  maxItems?: number
): NeighborhoodItem[] {
  const ranked = items
    .map((item) => {
      const summary = usageSummaries.get(item.edge.relationId);
      const rank = computeRelationRetrievalRank(item.edge, summary, weights);
      return {
        item: {
          ...item,
          edge: {
            ...item.edge,
            reason: formatRelationReason(item.edge.reason, summary)
          }
        },
        rank
      };
    })
    .sort((left, right) => right.rank - left.rank);

  return (typeof maxItems === "number" ? ranked.slice(0, maxItems) : ranked).map((entry) => ({
    ...entry.item,
    edge: {
      ...entry.item.edge,
      retrievalRank: entry.rank
    }
  }));
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

export function computeRelationRetrievalRank(
  edge: Pick<NeighborhoodItem["edge"], "relationSource" | "relationType" | "relationScore">,
  summary?: RelationUsageSummary,
  weights: RetrievalRankWeights = neighborhoodRetrievalRankWeights
): number {
  const usageBonus = computeUsageBonus(summary);
  const specificityBonus = relationTypeSpecificityBonus(edge.relationType);
  if (edge.relationSource === "canonical") {
    return weights.canonicalBase + specificityBonus * weights.canonicalSpecificityMultiplier + usageBonus * weights.canonicalUsageMultiplier;
  }
  return (
    (edge.relationScore ?? 0) * weights.inferredBaseMultiplier +
    specificityBonus * weights.inferredSpecificityMultiplier +
    usageBonus * weights.inferredUsageMultiplier
  );
}

export function computeRankCandidateScore(
  node: Pick<SearchResultItem, "title" | "summary" | "type" | "canonicality">,
  query: string,
  preset: BuildContextBundleInput["preset"],
  relationRetrievalRank = 0
): number {
  const normalizedQuery = query.toLowerCase();

  return (
    (node.title?.toLowerCase().includes(normalizedQuery) ? 50 : 0) +
    (node.summary?.toLowerCase().includes(normalizedQuery) ? 20 : 0) +
    (preset === "for-coding" && node.type === "decision" ? 15 : 0) +
    (node.canonicality === "canonical" ? 10 : 0) +
    relationRetrievalRank
  );
}

export function shouldUseSemanticCandidateAugmentation(
  query: string,
  candidates: Array<Pick<SearchResultItem, "title" | "summary">>
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length < 6) {
    return false;
  }

  return !candidates.some((candidate) => {
    const title = candidate.title?.toLowerCase() ?? "";
    const summary = candidate.summary?.toLowerCase() ?? "";
    return title.includes(normalizedQuery) || summary.includes(normalizedQuery);
  });
}

export function buildSemanticCandidateBonusMap(
  semanticMatches: Map<string, SemanticCandidateMatch>,
  settings?: SemanticAugmentationSettings
): Map<string, SemanticCandidateBonus> {
  const resolved = resolveSemanticAugmentationSettings(settings);
  return new Map(
    [...semanticMatches.entries()]
      .filter(([, match]) => Number.isFinite(match.similarity) && match.similarity >= resolved.minSimilarity)
      .map(([nodeId, match]) => {
        const normalizedSimilarity =
          resolved.minSimilarity >= 1
            ? 0
            : Math.min(1, Math.max(0, match.similarity - resolved.minSimilarity) / (1 - resolved.minSimilarity));
        const retrievalRank = Number((normalizedSimilarity * resolved.maxBonus).toFixed(4));
        return [
          nodeId,
          {
            retrievalRank,
            semanticSimilarity: Number(match.similarity.toFixed(4)),
            reason: `Semantic similarity ${match.similarity.toFixed(2)} via local-ngram across ${match.matchedChunks} chunk${match.matchedChunks === 1 ? "" : "s"}`
          }
        ] as const;
      })
  );
}

function computeBundleRelationBoost(item: NeighborhoodItem, summary?: RelationUsageSummary): number {
  return computeRelationRetrievalRank(item.edge, summary, {
    canonicalBase: 120,
    canonicalSpecificityMultiplier: 100,
    canonicalUsageMultiplier: 80,
    inferredBaseMultiplier: 40,
    inferredSpecificityMultiplier: 40,
    inferredUsageMultiplier: 40
  });
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
      retrievalRank: null,
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
                retrievalRank: relation.finalScore,
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
  const rankedCanonical = rankNeighborhoodItems(canonicalItems, usageSummaries, neighborhoodRetrievalRankWeights);
  const rankedInferred =
    options?.includeInferred && options.maxInferred
      ? rankNeighborhoodItems(inferredItems, usageSummaries, neighborhoodRetrievalRankWeights, options.maxInferred)
      : [];

  return [...rankedCanonical, ...rankedInferred];
}

export function buildCandidateRelationBonusMap(
  repository: MemforgeRepository,
  targetNodeId: string,
  candidateNodeIds: string[]
) {
  const neighborhood = buildNeighborhoodItems(repository, targetNodeId, {
    includeInferred: true,
    maxInferred: Math.max(4, Math.min(candidateNodeIds.length, 10))
  });
  const usageSummaries = repository.getRelationUsageSummaries(neighborhood.map((item) => item.edge.relationId));

  return new Map(
    neighborhood
      .filter((item) => candidateNodeIds.includes(item.node.id))
      .map((item) => [
        item.node.id,
        {
          retrievalRank: computeRelationRetrievalRank(
            item.edge,
            usageSummaries.get(item.edge.relationId),
            boostedRelationRankWeights
          ),
          relationSource: item.edge.relationSource,
          relationType: item.edge.relationType,
          relationScore: item.edge.relationScore,
          reason: item.edge.reason
        }
      ] as const)
  );
}

export function buildTargetRelatedRetrievalItems(
  repository: MemforgeRepository,
  targetId: string,
  filters: {
    types?: string[];
    status?: string[];
  }
): SearchResultItem[] {
  const target = repository.getNode(targetId);
  const candidateItems = new Map<string, SearchResultItem>();

  const addCandidate = (nodeId: string) => {
    const node = repository.getNode(nodeId);
    candidateItems.set(node.id, {
      id: node.id,
      type: node.type,
      title: node.title,
      summary: node.summary,
      status: node.status,
      canonicality: node.canonicality,
      sourceLabel: node.sourceLabel,
      updatedAt: node.updatedAt,
      tags: node.tags
    });
  };

  addCandidate(target.id);
  for (const item of buildNeighborhoodItems(repository, target.id, { includeInferred: true, maxInferred: 4 })) {
    addCandidate(item.node.id);
  }

  return Array.from(candidateItems.values()).filter((item) => matchesSearchResultFilters(item, filters));
}

async function buildWorkspaceContextBundle(
  repository: MemforgeRepository,
  input: BuildContextBundleInput
): Promise<ContextBundle> {
  const recentNodes = repository
    .listNodes(Math.max(input.options.maxItems * 3, 18))
    .filter((item) => item.status !== "archived");
  const decisions = input.options.includeDecisions
    ? recentNodes.filter((item) => item.type === "decision" && (item.status === "active" || item.status === "contested"))
    : [];
  const openQuestions = input.options.includeOpenQuestions
    ? recentNodes.filter((item) => item.type === "question" && ["active", "draft", "contested"].includes(item.status))
    : [];
  const candidateItems = Array.from(new Map([...recentNodes, ...decisions, ...openQuestions].map((item) => [item.id, item])).values());
  const baseItems = prioritizeItems(
    candidateItems,
    input.preset,
    input.mode === "micro" ? Math.min(input.options.maxItems, 5) : input.options.maxItems
  );
  const activityDigest = input.options.includeRecentActivities
    ? repository
        .searchActivities({
          query: "",
          filters: {},
          limit: input.mode === "micro" ? 3 : 6,
          offset: 0,
          sort: "updated_at"
        })
        .items.map(
          (activity) =>
            `${activity.targetNodeTitle ?? activity.targetNodeId} · ${activity.activityType}: ${activity.body ?? "No details"}`
        )
    : [];

  return {
    target: {
      type: "workspace",
      id: "workspace",
      title: "Workspace context"
    },
    mode: input.mode,
    preset: input.preset,
    summary:
      baseItems[0]?.summary ??
      "Recent workspace context across active nodes, open questions, decisions, and recent activity trails.",
    items: baseItems.map((item) => ({
      nodeId: item.id,
      type: item.type,
      title: item.title,
      summary: item.summary,
      reason: item.type === "project" ? "Recent workspace project context" : `Recent workspace context for ${input.preset}`
    })),
    activityDigest,
    decisions,
    openQuestions,
    sources: baseItems.map((item) => ({
      nodeId: item.id,
      sourceLabel: item.sourceLabel
    }))
  };
}

export async function buildContextBundle(
  repository: MemforgeRepository,
  input: BuildContextBundleInput
): Promise<ContextBundle> {
  if (!input.target?.id) {
    return buildWorkspaceContextBundle(repository, input);
  }

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
    relationId: item.edge.relationId,
    relationType: item.edge.relationType,
    relationSource: item.edge.relationSource,
    relationStatus: item.edge.relationStatus,
    relationScore: item.edge.relationScore ?? undefined,
    retrievalRank: item.edge.retrievalRank ?? undefined,
    generator: item.edge.generator
  }));

  const decisions = input.options.includeDecisions
    ? buildTargetRelatedRetrievalItems(repository, target.id, {
        types: ["decision"],
        status: ["active", "contested"]
      })
    : [];

  const openQuestions = input.options.includeOpenQuestions
    ? buildTargetRelatedRetrievalItems(repository, target.id, {
        types: ["question"],
        status: ["active", "draft", "contested"]
      })
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
  const candidateItems = [targetItem, ...relatedItems, ...decisions, ...openQuestions];
  const dedupedItems = Array.from(new Map(candidateItems.map((item) => [item.id, item])).values());
  const semanticQuery = [target.title, target.summary ?? target.body].filter(Boolean).join("\n");
  const semanticBonuses = shouldUseSemanticCandidateAugmentation(
    semanticQuery,
    dedupedItems.filter((item) => item.id !== target.id)
  )
    ? buildSemanticCandidateBonusMap(
        await repository.rankSemanticCandidates(
          semanticQuery,
          dedupedItems.filter((item) => item.id !== target.id).map((item) => item.id)
        ),
        repository.getSemanticAugmentationSettings()
      )
    : new Map();
  appendCurrentTelemetryDetails({
    neighborhoodCount: neighborhood.length,
    relatedCandidateCount: relatedItems.length,
    decisionCount: decisions.length,
    openQuestionCount: openQuestions.length,
    semanticUsed: semanticBonuses.size > 0
  });
  const combinedBonuses = new Map<string, number>();
  for (const item of dedupedItems) {
    combinedBonuses.set(item.id, (relationBonuses.get(item.id) ?? 0) + (semanticBonuses.get(item.id)?.retrievalRank ?? 0));
  }

  const baseItems = prioritizeItems(
    dedupedItems,
    input.preset,
    input.mode === "micro" ? Math.min(input.options.maxItems, 5) : input.options.maxItems,
    combinedBonuses
  );

  const itemById = new Map(related.map((item) => [item.nodeId, item]));

  const bundle = {
    target: {
      type: target.type,
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
      reason:
        [
          itemById.get(item.id)?.reason ?? (item.id === target.id ? "Primary target" : `Included for ${input.preset}`),
          semanticBonuses.get(item.id)?.reason ?? null
        ]
          .filter(Boolean)
          .join("; "),
      relationId: itemById.get(item.id)?.relationId,
      relationType: itemById.get(item.id)?.relationType,
      relationSource: itemById.get(item.id)?.relationSource,
      relationStatus: itemById.get(item.id)?.relationStatus,
      relationScore: itemById.get(item.id)?.relationScore,
      retrievalRank: (itemById.get(item.id)?.retrievalRank ?? 0) + (semanticBonuses.get(item.id)?.retrievalRank ?? 0) || undefined,
      semanticSimilarity: semanticBonuses.get(item.id)?.semanticSimilarity,
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
  appendCurrentTelemetryDetails({
    bundleItemCount: bundle.items.length,
    bundleSourceCount: bundle.sources.length
  });
  return bundle;
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
