import type { RelationType } from "../shared/contracts.js";
import type { ProjectGraphEdge, ProjectGraphNode, ProjectGraphPayload, ProjectGraphTimelineEvent } from "../shared/types.js";
import { AppError } from "./errors.js";
import type { RecallXRepository } from "./repositories.js";

const DEFAULT_PROJECT_MEMBER_LIMIT = 120;
const DEFAULT_PROJECT_ACTIVITY_LIMIT = 200;
const DEFAULT_PROJECT_FALLBACK_NODE_LIMIT = 8;
const DEFAULT_PROJECT_INFERRED_LIMIT = 60;

function relationLabel(value: RelationType) {
  return value.replaceAll("_", " ");
}

function relationEdgeKey(sourceNodeId: string, targetNodeId: string) {
  return `${sourceNodeId}:${targetNodeId}`;
}

export function buildProjectGraph(
  repository: RecallXRepository,
  projectId: string,
  options?: {
    includeInferred?: boolean;
    maxInferred?: number;
    memberLimit?: number;
    activityLimit?: number;
  }
): ProjectGraphPayload {
  const project = repository.getNode(projectId);
  if (project.type !== "project") {
    throw new AppError(400, "INVALID_INPUT", "Project graph only supports project nodes.");
  }

  const includeInferred = options?.includeInferred ?? true;
  const memberLimit = options?.memberLimit ?? DEFAULT_PROJECT_MEMBER_LIMIT;
  const activityLimit = options?.activityLimit ?? DEFAULT_PROJECT_ACTIVITY_LIMIT;
  const inferredLimit = options?.maxInferred ?? DEFAULT_PROJECT_INFERRED_LIMIT;
  const membership = repository.listProjectMemberNodes(projectId, memberLimit);
  const scopedNodeIdSet = new Set([projectId, ...membership.map(({ node }) => node.id)]);
  const scopedNodeIds = Array.from(scopedNodeIdSet);
  const scopedNodes = repository.getNodesByIds(scopedNodeIds);
  scopedNodes.set(project.id, project);

  let canonicalEdges = repository.listRelationsBetweenNodeIds(scopedNodeIds);
  let inferredEdges = includeInferred ? repository.listInferredRelationsBetweenNodeIds(scopedNodeIds, inferredLimit) : [];
  const fallbackNodeIds =
    scopedNodeIdSet.size <= 1 && canonicalEdges.length === 0 && inferredEdges.length === 0
      ? repository
          .searchNodes({
            query: "",
            filters: {
              types: ["note", "idea", "question", "decision", "reference", "artifact_ref"],
              status: ["active"]
            },
            limit: DEFAULT_PROJECT_FALLBACK_NODE_LIMIT,
            offset: 0,
            sort: "updated_at"
          })
          .items
          .filter((item) => item.id !== projectId)
          .map((item) => item.id)
      : [];

  const uniqueFallbackNodeIds = Array.from(new Set(fallbackNodeIds));

  const fallbackNodeMap = uniqueFallbackNodeIds.length > 0 ? repository.getNodesByIds(uniqueFallbackNodeIds) : new Map();
  const fallbackNodes =
    uniqueFallbackNodeIds.length > 0
      ? uniqueFallbackNodeIds
          .map((nodeId) => fallbackNodeMap.get(nodeId))
          .filter((node): node is NonNullable<typeof node> => Boolean(node))
      : [];

  for (const node of fallbackNodes) {
    scopedNodeIdSet.add(node.id);
    scopedNodes.set(node.id, node);
  }

  if (fallbackNodes.length) {
    const expandedScopedNodeIds = Array.from(scopedNodeIdSet);
    canonicalEdges = repository.listRelationsBetweenNodeIds(expandedScopedNodeIds);
    inferredEdges = includeInferred ? repository.listInferredRelationsBetweenNodeIds(expandedScopedNodeIds, inferredLimit) : [];
  }
  const connectedEdgeKeys = new Set([
    ...canonicalEdges.map((edge) => relationEdgeKey(edge.fromNodeId, edge.toNodeId)),
    ...inferredEdges.map((edge) => relationEdgeKey(edge.fromNodeId, edge.toNodeId)),
  ]);
  const syntheticFallbackEdges = fallbackNodes
    .filter(
      (node) =>
        !connectedEdgeKeys.has(relationEdgeKey(node.id, projectId)) &&
        !connectedEdgeKeys.has(relationEdgeKey(projectId, node.id))
    )
    .map((node) => ({
      id: `project-map-fallback:${projectId}:${node.id}`,
      source: projectId,
      target: node.id,
      relationType: "related_to" as const,
      relationSource: "inferred" as const,
      status: "active" as const,
      score: 0.2,
      generator: "project-map-fallback",
      createdAt: node.updatedAt,
      evidence: {
        strategy: "workspace_recent",
        reason: "Recent active workspace node used as exploratory seed because the project has no explicit membership graph yet."
      }
    }));
  const allEdges = [
    ...canonicalEdges.map((edge) => ({
      id: edge.id,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      relationType: edge.relationType,
      relationSource: "canonical" as const,
      status: edge.status,
      score: null,
      generator: null,
      createdAt: edge.createdAt,
      evidence: undefined,
    })),
    ...inferredEdges.map((edge) => ({
      id: edge.id,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      relationType: edge.relationType,
      relationSource: "inferred" as const,
      status: edge.status,
      score: edge.finalScore,
      generator: edge.generator,
      createdAt: edge.lastComputedAt,
      evidence: edge.evidence,
    })),
    ...syntheticFallbackEdges,
  ] satisfies ProjectGraphEdge[];

  const degreeByNodeId = new Map<string, number>();
  for (const edge of allEdges) {
    degreeByNodeId.set(edge.source, (degreeByNodeId.get(edge.source) ?? 0) + 1);
    degreeByNodeId.set(edge.target, (degreeByNodeId.get(edge.target) ?? 0) + 1);
  }

  const nodes = Array.from(scopedNodeIdSet)
    .map((nodeId) => scopedNodes.get(nodeId))
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .map((node) => ({
      id: node.id,
      title: node.title,
      type: node.type,
      status: node.status,
      canonicality: node.canonicality,
      summary: node.summary,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      degree: degreeByNodeId.get(node.id) ?? 0,
      isFocus: node.id === projectId,
      projectRole: node.id === projectId ? "focus" : "member",
    })) satisfies ProjectGraphNode[];

  const nodeLabelById = new Map(nodes.map((node) => [node.id, node.title ?? node.id] as const));
  const activities = repository.listActivitiesForNodeIds(Array.from(scopedNodeIdSet), activityLimit);
  const timeline = [
    ...nodes.map((node) => ({
      id: `timeline-node:${node.id}`,
      kind: "node_created" as const,
      at: node.createdAt,
      nodeId: node.id,
      label: `${node.title ?? node.id} created`,
    })),
    ...canonicalEdges.map((edge) => ({
      id: `timeline-edge:${edge.id}`,
      kind: "relation_created" as const,
      at: edge.createdAt,
      edgeId: edge.id,
      nodeId: edge.fromNodeId,
      label: `${nodeLabelById.get(edge.fromNodeId) ?? edge.fromNodeId} ${relationLabel(edge.relationType)} ${nodeLabelById.get(edge.toNodeId) ?? edge.toNodeId}`,
    })),
    ...activities.map((activity) => ({
      id: `timeline-activity:${activity.id}`,
      kind: "activity" as const,
      at: activity.createdAt,
      nodeId: activity.targetNodeId,
      label: `${activity.activityType.replaceAll("_", " ")} on ${nodeLabelById.get(activity.targetNodeId) ?? activity.targetNodeId}`,
    })),
    ...syntheticFallbackEdges.map((edge) => ({
      id: `timeline-fallback-edge:${edge.id}`,
      kind: "relation_created" as const,
      at: edge.createdAt,
      edgeId: edge.id,
      nodeId: edge.source,
      label: `${nodeLabelById.get(edge.source) ?? edge.source} related to ${nodeLabelById.get(edge.target) ?? edge.target}`,
    })),
  ] satisfies ProjectGraphTimelineEvent[];

  timeline.sort((left, right) => {
    const timeDelta = left.at.localeCompare(right.at);
    if (timeDelta !== 0) {
      return timeDelta;
    }

    const kindRank = kindOrder(left.kind) - kindOrder(right.kind);
    if (kindRank !== 0) {
      return kindRank;
    }

    return left.id.localeCompare(right.id);
  });

  const timeRange = timeline.length
    ? {
        start: timeline[0]?.at ?? null,
        end: timeline[timeline.length - 1]?.at ?? null,
      }
    : {
        start: project.createdAt,
        end: project.createdAt,
      };

  return {
    nodes,
    edges: allEdges,
    timeline,
    meta: {
      focusProjectId: projectId,
      nodeCount: nodes.length,
      edgeCount: allEdges.length,
      inferredEdgeCount: inferredEdges.length + syntheticFallbackEdges.length,
      timeRange,
    },
  };
}

function kindOrder(kind: ProjectGraphTimelineEvent["kind"]) {
  switch (kind) {
    case "node_created":
      return 0;
    case "relation_created":
      return 1;
    default:
      return 2;
  }
}
