import type { AppendActivityInput, CreateNodeInput, CreateRelationInput, RecomputeGovernanceInput } from "../shared/contracts.js";
import type {
  GovernanceEntityType,
  GovernanceEventType,
  GovernanceState,
  NodeStatus
} from "../shared/contracts.js";
import type { GovernanceStateRecord, NodeRecord, RelationRecord, SearchFeedbackSummary } from "../shared/types.js";
import type { MemforgeRepository } from "./repositories.js";
import { AppError } from "./errors.js";
import { countTokensApprox, nowIso } from "./utils.js";

export interface GovernanceDecision {
  canonicality: string;
  status: string;
  reason: string;
}

export interface GovernancePolicy {
  autoApproveLowRisk: boolean;
  trustedSourceToolNames: string[];
}

export interface GovernanceRecomputeResult {
  updatedCount: number;
  promotedCount: number;
  contestedCount: number;
  items: GovernanceStateRecord[];
}

const relaxedShortFormNodeTypes = new Set<CreateNodeInput["type"]>(["reference", "question", "conversation"]);

type GovernanceEvaluation = {
  entityType: GovernanceEntityType;
  entityId: string;
  state: GovernanceState;
  confidence: number;
  reasons: string[];
  eventType: GovernanceEventType;
  nextNodeStatus?: NodeStatus;
  nextCanonicality?: NodeRecord["canonicality"];
  nextRelationStatus?: RelationRecord["status"];
  metadata?: Record<string, unknown>;
};

function clampConfidence(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function readTrustedSourceToolNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function isTrustedAgentSource(toolName: string, policy: GovernancePolicy): boolean {
  return policy.trustedSourceToolNames.includes(toolName);
}

function feedbackConfidenceBonus(summary: SearchFeedbackSummary | undefined): number {
  if (!summary) {
    return 0;
  }
  return Math.min(Math.max(summary.totalDelta, -2), 2) * 0.12;
}

function stabilityBonus(timestamp: string): number {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  if (ageMs >= 24 * 60 * 60 * 1000) return 0.06;
  if (ageMs >= 60 * 60 * 1000) return 0.03;
  return 0;
}

function chooseNodeHealthyThreshold(node: NodeRecord): number {
  if (node.canonicality === "suggested") {
    return node.type === "decision" ? 0.78 : 0.72;
  }
  if (node.canonicality === "canonical") {
    return 0.55;
  }
  return 0.35;
}

function chooseRelationActiveThreshold(_relation: RelationRecord): number {
  return 0.72;
}

function chooseNodeBaseConfidence(node: NodeRecord, policy: GovernancePolicy): number {
  switch (node.sourceType) {
    case "human":
      return 0.95;
    case "import":
      return 0.84;
    case "integration":
      return 0.72;
    case "system":
      return 0.7;
    case "agent":
      return isTrustedAgentSource(node.sourceLabel ?? "", policy) ? 0.62 : 0.48;
    default:
      return 0.45;
  }
}

function chooseRelationBaseConfidence(relation: RelationRecord, policy: GovernancePolicy): number {
  switch (relation.sourceType) {
    case "human":
      return 0.78;
    case "import":
    case "integration":
    case "system":
      return 0.68;
    case "agent":
      return isTrustedAgentSource(relation.sourceLabel ?? "", policy) ? 0.62 : 0.42;
    default:
      return 0.4;
  }
}

function buildEventType(
  previousState: GovernanceStateRecord | null,
  nextState: GovernanceState,
  changedToCanonical: boolean,
  changedToRejected: boolean
): GovernanceEventType {
  if (!previousState) {
    return "evaluated";
  }
  if (changedToCanonical) {
    return "promoted";
  }
  if (nextState === "contested" && previousState.state !== "contested") {
    return "contested";
  }
  if (changedToRejected) {
    return "demoted";
  }
  return "evaluated";
}

export function resolveGovernancePolicy(settings?: Record<string, unknown>): GovernancePolicy {
  return {
    autoApproveLowRisk:
      typeof settings?.["review.autoApproveLowRisk"] === "boolean"
        ? Boolean(settings["review.autoApproveLowRisk"])
        : true,
    trustedSourceToolNames: readTrustedSourceToolNames(settings?.["review.trustedSourceToolNames"])
  };
}

function computeNodeTokenCount(input: Pick<CreateNodeInput, "title" | "summary" | "body">): number {
  const combined = [input.title, input.summary, input.body]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
  return countTokensApprox(combined);
}

function hasDurableNodeSignals(input: Pick<CreateNodeInput, "summary" | "metadata">): boolean {
  return Boolean(
    input.metadata.reusable ||
      input.metadata.durable ||
      input.metadata.promoteCandidate ||
      (typeof input.summary === "string" && input.summary.trim().length > 0)
  );
}

export function isShortLogLikeAgentNodeInput(input: CreateNodeInput): boolean {
  return (
    input.source.actorType === "agent" &&
    input.type !== "decision" &&
    !hasDurableNodeSignals(input) &&
    !relaxedShortFormNodeTypes.has(input.type) &&
    computeNodeTokenCount(input) <= 300
  );
}

export function resolveNodeGovernance(input: CreateNodeInput, policy: GovernancePolicy = resolveGovernancePolicy()): GovernanceDecision {
  if (input.source.actorType === "human") {
    return {
      canonicality: input.canonicality ?? "canonical",
      status: input.status ?? "active",
      reason: "Human-authored nodes land canonical by default."
    };
  }

  if (input.source.actorType === "import") {
    return {
      canonicality: "imported",
      status: input.status ?? "active",
      reason: "Imported material stays imported."
    };
  }

  const tokenCount = computeNodeTokenCount(input);
  const reusable = hasDurableNodeSignals(input);
  const trustedAgentSource =
    input.source.actorType === "agent" ? isTrustedAgentSource(input.source.toolName, policy) : false;

  if (isShortLogLikeAgentNodeInput(input)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Short log-like agent output must be appended as activity, not stored as a durable node.",
      {
        tokenCount,
        recommendation: "Use POST /api/v1/capture with mode=auto or mode=activity.",
        suggestedMode: "activity",
        suggestedTarget: "workspace-inbox"
      }
    );
  }

  if (input.type === "decision") {
    return {
      canonicality: "suggested",
      status: "active",
      reason: trustedAgentSource
        ? "Trusted agent-authored decisions start suggested and can auto-promote."
        : "Agent-authored decisions start suggested and await automatic confidence promotion."
    };
  }

  if (input.source.actorType === "agent" && reusable) {
    return {
      canonicality: "suggested",
      status: "active",
      reason: "Reusable agent-authored knowledge starts suggested and active."
    };
  }

  return {
    canonicality: "appended",
    status: "active",
    reason: trustedAgentSource
      ? "Trusted or low-risk agent-authored nodes land append-first."
      : "Low-risk agent-authored nodes land append-first."
  };
}

export function resolveRelationStatus(
  input: CreateRelationInput,
  _policy: GovernancePolicy = resolveGovernancePolicy()
): { status: string; reason: string } {
  if (input.source.actorType === "agent") {
    return {
      status: "suggested",
      reason: "Agent-authored relations start suggested and rely on automatic governance promotion."
    };
  }
  return {
    status: input.status ?? "active",
    reason: "Human or imported relations land active unless a status is explicitly provided."
  };
}

export function shouldPromoteActivitySummary(input: AppendActivityInput): boolean {
  const tokenCount = countTokensApprox(input.body);
  const durable = Boolean(input.metadata.reusable || input.metadata.durable || input.metadata.promoteCandidate);
  return input.source.actorType === "agent" && tokenCount > 300 && durable;
}

export function maybeCreatePromotionCandidate(
  repository: MemforgeRepository,
  input: AppendActivityInput
): { suggestedNodeId?: string } {
  if (!shouldPromoteActivitySummary(input)) {
    return {};
  }

  const target = repository.getNode(input.targetNodeId);
  const suggested = repository.createNode({
    type: input.metadata.suggestedType === "reference" ? "reference" : "note",
    title: typeof input.metadata.title === "string" ? input.metadata.title : `${target.title ?? "Untitled"} follow-up`,
    body: input.body,
    summary: typeof input.metadata.summary === "string" ? input.metadata.summary : undefined,
    tags: Array.isArray(input.metadata.tags) ? (input.metadata.tags as string[]) : target.tags,
    canonicality: "suggested",
    status: "active",
    resolvedCanonicality: "suggested",
    resolvedStatus: "active",
    source: input.source,
    metadata: {
      ...input.metadata,
      derivedFromActivity: true,
      targetNodeId: input.targetNodeId
    }
  });
  repository.recordProvenance({
    entityType: "node",
    entityId: suggested.id,
    operationType: "create",
    source: input.source,
    metadata: {
      rule: "activity_to_suggested_promotion"
    }
  });

  return { suggestedNodeId: suggested.id };
}

function evaluateNodeGovernance(
  repository: MemforgeRepository,
  node: NodeRecord,
  policy: GovernancePolicy
): GovernanceEvaluation {
  const feedback = repository.getSearchFeedbackSummaries("node", [node.id]).get(node.id);
  const contradictionCount = repository.countContradictionRelations(node.id);
  const reusable = Boolean(node.metadata.reusable || node.metadata.durable || node.metadata.promoteCandidate);
  let confidence = chooseNodeBaseConfidence(node, policy);
  const reasons = [`source:${node.sourceType ?? "unknown"}`];

  if (node.canonicality === "canonical") confidence += 0.12;
  if (node.canonicality === "appended") confidence += 0.05;
  if (node.canonicality === "suggested") confidence += 0.02;
  if (reusable) {
    confidence += 0.08;
    reasons.push("durable");
  }
  if (node.type === "decision") {
    confidence += 0.06;
    reasons.push("decision");
  }

  confidence += stabilityBonus(node.updatedAt);
  confidence += feedbackConfidenceBonus(feedback);

  if (feedback?.eventCount) {
    reasons.push(`feedback:${feedback.totalDelta.toFixed(2)}`);
  }
  if (contradictionCount) {
    confidence -= Math.min(0.5, contradictionCount * 0.35);
    reasons.push(`contradictions:${contradictionCount}`);
  }

  const contested =
    contradictionCount > 0 ||
    (feedback?.notUsefulCount ?? 0) >= 2 ||
    (feedback?.totalDelta ?? 0) <= -1;
  const healthyThreshold = chooseNodeHealthyThreshold(node);
  const canPromote = node.canonicality === "suggested" && !contested && confidence >= healthyThreshold;
  const nextCanonicality = canPromote ? "canonical" : node.canonicality;
  const nextStatus: NodeStatus =
    contested ? "contested" : node.status === "contested" ? "active" : node.status === "archived" ? "archived" : "active";
  const nextState: GovernanceState = contested ? "contested" : confidence >= healthyThreshold ? "healthy" : "low_confidence";
  const previousState = repository.getGovernanceStateNullable("node", node.id);

  return {
    entityType: "node",
    entityId: node.id,
    state: nextState,
    confidence: clampConfidence(confidence),
    reasons,
    eventType: buildEventType(previousState, nextState, canPromote, false),
    nextNodeStatus: nextStatus,
    nextCanonicality,
    metadata: {
      contradictionCount,
      feedbackDelta: feedback?.totalDelta ?? 0,
      feedbackCount: feedback?.eventCount ?? 0
    }
  };
}

function evaluateRelationGovernance(
  repository: MemforgeRepository,
  relation: RelationRecord,
  policy: GovernancePolicy
): GovernanceEvaluation {
  const usage = repository.getRelationUsageSummaries([relation.id]).get(relation.id);
  let confidence = chooseRelationBaseConfidence(relation, policy);
  const reasons = [`source:${relation.sourceType ?? "unknown"}`];

  if (relation.status === "active") {
    confidence += 0.08;
  }
  if (usage) {
    confidence += Math.min(Math.max(usage.totalDelta, -2), 2) * 0.15;
    reasons.push(`usage:${usage.totalDelta.toFixed(2)}`);
  }
  confidence = clampConfidence(confidence);

  const hardReject = (usage?.eventCount ?? 0) >= 2 && (usage?.totalDelta ?? 0) <= -1.25;
  const contested = (usage?.totalDelta ?? 0) <= -0.75;
  const activeThreshold = chooseRelationActiveThreshold(relation);
  const nextRelationStatus: RelationRecord["status"] = hardReject
    ? "rejected"
    : confidence >= activeThreshold
      ? "active"
      : "suggested";
  const nextState: GovernanceState = contested ? "contested" : confidence >= activeThreshold ? "healthy" : "low_confidence";
  const previousState = repository.getGovernanceStateNullable("relation", relation.id);

  return {
    entityType: "relation",
    entityId: relation.id,
    state: nextState,
    confidence,
    reasons,
    eventType: buildEventType(previousState, nextState, false, nextRelationStatus === "rejected"),
    nextRelationStatus,
    metadata: {
      usageDelta: usage?.totalDelta ?? 0,
      usageCount: usage?.eventCount ?? 0
    }
  };
}

function persistGovernanceEvaluation(repository: MemforgeRepository, evaluation: GovernanceEvaluation): GovernanceStateRecord {
  const currentState = repository.getGovernanceStateNullable(evaluation.entityType, evaluation.entityId);
  const beforeNode = evaluation.entityType === "node" ? repository.getNode(evaluation.entityId) : null;
  const beforeRelation = evaluation.entityType === "relation" ? repository.getRelation(evaluation.entityId) : null;

  if (evaluation.entityType === "node") {
    if (evaluation.nextCanonicality && beforeNode && beforeNode.canonicality !== evaluation.nextCanonicality) {
      repository.setNodeCanonicality(evaluation.entityId, evaluation.nextCanonicality);
    }
    if (evaluation.nextNodeStatus && beforeNode && beforeNode.status !== evaluation.nextNodeStatus) {
      repository.updateNode(evaluation.entityId, { status: evaluation.nextNodeStatus });
    }
  }

  if (evaluation.entityType === "relation" && evaluation.nextRelationStatus && beforeRelation && beforeRelation.status !== evaluation.nextRelationStatus) {
    repository.updateRelationStatus(evaluation.entityId, evaluation.nextRelationStatus);
  }

  const state = repository.upsertGovernanceState({
    entityType: evaluation.entityType,
    entityId: evaluation.entityId,
    state: evaluation.state,
    confidence: evaluation.confidence,
    reasons: evaluation.reasons,
    lastEvaluatedAt: nowIso(),
    metadata: evaluation.metadata
  });
  repository.appendGovernanceEvent({
    entityType: evaluation.entityType,
    entityId: evaluation.entityId,
    eventType: evaluation.eventType,
    previousState: currentState?.state ?? null,
    nextState: evaluation.state,
    confidence: evaluation.confidence,
    reason: evaluation.reasons.join(", "),
    metadata: {
      ...evaluation.metadata,
      nextCanonicality: evaluation.nextCanonicality ?? null,
      nextNodeStatus: evaluation.nextNodeStatus ?? null,
      nextRelationStatus: evaluation.nextRelationStatus ?? null
    }
  });

  return state;
}

export function recomputeAutomaticGovernance(
  repository: MemforgeRepository,
  input: RecomputeGovernanceInput,
  policy: GovernancePolicy = resolveGovernancePolicy(
    repository.getSettings(["review.autoApproveLowRisk", "review.trustedSourceToolNames"])
  )
): GovernanceRecomputeResult {
  const targets = repository.recomputeGovernanceTargets(input);
  const items: GovernanceStateRecord[] = [];
  let promotedCount = 0;
  let contestedCount = 0;

  for (const nodeId of targets.nodeIds) {
    const node = repository.getNode(nodeId);
    const evaluation = evaluateNodeGovernance(repository, node, policy);
    if (evaluation.nextCanonicality === "canonical" && node.canonicality !== "canonical") {
      promotedCount += 1;
    }
    if (evaluation.state === "contested") {
      contestedCount += 1;
    }
    items.push(persistGovernanceEvaluation(repository, evaluation));
  }

  for (const relationId of targets.relationIds) {
    const relation = repository.getRelation(relationId);
    const evaluation = evaluateRelationGovernance(repository, relation, policy);
    if (evaluation.state === "contested") {
      contestedCount += 1;
    }
    items.push(persistGovernanceEvaluation(repository, evaluation));
  }

  return {
    updatedCount: items.length,
    promotedCount,
    contestedCount,
    items
  };
}

export function bootstrapAutomaticGovernance(repository: MemforgeRepository): GovernanceRecomputeResult {
  const legacyReviewItems = repository.listLegacyReviewItems();
  if (legacyReviewItems.length === 0) {
    return {
      updatedCount: 0,
      promotedCount: 0,
      contestedCount: 0,
      items: []
    };
  }

  const migratedNodeIds = new Set<string>();
  const migratedRelationIds = new Set<string>();
  for (const item of legacyReviewItems) {
    if (item.entityType !== "node" && item.entityType !== "relation") {
      continue;
    }
    const state: GovernanceState = item.status === "pending" ? "contested" : "low_confidence";
    const current = repository.getGovernanceStateNullable(item.entityType, item.entityId);
    repository.upsertGovernanceState({
      entityType: item.entityType,
      entityId: item.entityId,
      state,
      confidence: item.status === "pending" ? 0.2 : 0.4,
      reasons: [`legacy review migrated from ${item.status}`],
      metadata: {
        legacyReviewId: item.id,
        legacyReviewType: item.reviewType
      }
    });
    repository.appendGovernanceEvent({
      entityType: item.entityType,
      entityId: item.entityId,
      eventType: "migrated",
      previousState: current?.state ?? null,
      nextState: state,
      confidence: item.status === "pending" ? 0.2 : 0.4,
      reason: `Migrated legacy review item ${item.id}`,
      metadata: {
        legacyReviewStatus: item.status,
        legacyReviewType: item.reviewType
      }
    });
    if (item.entityType === "node") {
      migratedNodeIds.add(item.entityId);
    } else {
      migratedRelationIds.add(item.entityId);
    }
  }

  repository.clearLegacyReviewQueue();

  const nodeResult =
    migratedNodeIds.size > 0
      ? recomputeAutomaticGovernance(repository, {
          entityType: "node",
          entityIds: Array.from(migratedNodeIds),
          limit: migratedNodeIds.size
        })
      : { updatedCount: 0, promotedCount: 0, contestedCount: 0, items: [] as GovernanceStateRecord[] };
  const relationResult =
    migratedRelationIds.size > 0
      ? recomputeAutomaticGovernance(repository, {
          entityType: "relation",
          entityIds: Array.from(migratedRelationIds),
          limit: migratedRelationIds.size
        })
      : { updatedCount: 0, promotedCount: 0, contestedCount: 0, items: [] as GovernanceStateRecord[] };

  return {
    updatedCount: nodeResult.updatedCount + relationResult.updatedCount,
    promotedCount: nodeResult.promotedCount + relationResult.promotedCount,
    contestedCount: nodeResult.contestedCount + relationResult.contestedCount,
    items: [...nodeResult.items, ...relationResult.items]
  };
}
