import type {
  AppendActivityInput,
  CreateNodeInput,
  CreateRelationInput,
  ReviewActionInput
} from "../shared/contracts.js";
import type { JsonMap } from "../shared/types.js";
import type { MemforgeRepository } from "./repositories.js";
import { AppError } from "./errors.js";
import { countTokensApprox } from "./utils.js";

export interface GovernanceDecision {
  canonicality: string;
  status: string;
  createReview: boolean;
  reviewType?: string;
  reason: string;
}

export interface GovernancePolicy {
  autoApproveLowRisk: boolean;
  trustedSourceToolNames: string[];
}

export function resolveGovernancePolicy(settings?: Record<string, unknown>): GovernancePolicy {
  const autoApproveLowRisk =
    typeof settings?.["review.autoApproveLowRisk"] === "boolean" ? Boolean(settings["review.autoApproveLowRisk"]) : true;
  const trustedSourceToolNames = Array.isArray(settings?.["review.trustedSourceToolNames"])
    ? settings?.["review.trustedSourceToolNames"].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : typeof settings?.["review.trustedSourceToolNames"] === "string"
      ? settings["review.trustedSourceToolNames"]
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];

  return {
    autoApproveLowRisk,
    trustedSourceToolNames
  };
}

function isTrustedAgentSource(toolName: string, policy: GovernancePolicy): boolean {
  return policy.trustedSourceToolNames.includes(toolName);
}

export function resolveNodeGovernance(input: CreateNodeInput, policy: GovernancePolicy = resolveGovernancePolicy()): GovernanceDecision {
  if (input.source.actorType === "human") {
    return {
      canonicality: input.canonicality ?? "canonical",
      status: input.status ?? "active",
      createReview: false,
      reason: "Human-authored nodes land as canonical by default."
    };
  }

  if (input.source.actorType === "import") {
    return {
      canonicality: "imported",
      status: input.status ?? "active",
      createReview: false,
      reason: "Imported material stays imported."
    };
  }

  const tokenCount = countTokensApprox(input.body);
  const reusable = Boolean(input.metadata.reusable || input.metadata.durable || input.metadata.promoteCandidate);
  const trustedAgentSource =
    input.source.actorType === "agent" ? isTrustedAgentSource(input.source.toolName, policy) : false;

  if (input.type === "decision") {
    return {
      canonicality: "suggested",
      status: "review",
      createReview: true,
      reviewType: "node_promotion",
      reason: "Agent-authored decisions always require human approval."
    };
  }

  if (input.source.actorType === "agent" && tokenCount <= 300 && !reusable) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Short log-like agent output must be appended as activity, not stored as a durable node.",
      { tokenCount, recommendation: "Use POST /api/v1/activities instead." }
    );
  }

  if (input.source.actorType === "agent") {
    if (trustedAgentSource) {
      return {
        canonicality: "appended",
        status: "active",
        createReview: false,
        reason: "Trusted agent-authored nodes land as append-only active content."
      };
    }

    if (!reusable && policy.autoApproveLowRisk) {
      return {
        canonicality: "appended",
        status: "active",
        createReview: false,
        reason: "Low-risk agent-authored nodes land as append-only active content."
      };
    }

    return {
      canonicality: "suggested",
      status: "review",
      createReview: true,
      reviewType: "node_promotion",
      reason: "Reusable agent-authored knowledge lands as suggested and enters review."
    };
  }

  return {
    canonicality: input.canonicality ?? "appended",
    status: input.status ?? "active",
    createReview: false,
    reason: "Fallback append-first behavior."
  };
}

export function resolveRelationStatus(
  input: CreateRelationInput,
  policy: GovernancePolicy = resolveGovernancePolicy()
): { status: string; createReview: boolean } {
  if (input.source.actorType === "agent") {
    if (isTrustedAgentSource(input.source.toolName, policy)) {
      const status = input.status ?? "active";
      return { status, createReview: status === "suggested" };
    }

    return { status: "suggested", createReview: true };
  }

  return { status: input.status ?? "active", createReview: input.status === "suggested" };
}

export function shouldPromoteActivitySummary(input: AppendActivityInput): boolean {
  const tokenCount = countTokensApprox(input.body);
  const durable = Boolean(input.metadata.reusable || input.metadata.durable || input.metadata.promoteCandidate);
  return input.source.actorType === "agent" && tokenCount > 300 && durable;
}

export function maybeCreatePromotionCandidate(
  repository: MemforgeRepository,
  input: AppendActivityInput
): { suggestedNodeId?: string; reviewId?: string } {
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
    status: "review",
    resolvedCanonicality: "suggested",
    resolvedStatus: "review",
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
  const review = repository.createReviewItem({
    entityType: "node",
    entityId: suggested.id,
    reviewType: "node_promotion",
    proposedBy: input.source.actorLabel,
    notes: "Promotion candidate created from durable agent activity.",
    metadata: {
      sourceActivityType: input.activityType,
      targetNodeId: input.targetNodeId
    }
  });

  return { suggestedNodeId: suggested.id, reviewId: review.id };
}

export function applyReviewDecision(
  repository: MemforgeRepository,
  reviewId: string,
  action: "approve" | "reject" | "edit-and-approve",
  input: ReviewActionInput
): { review: unknown; effectedEntity: JsonMap } {
  const review = repository.getReviewItem(reviewId);

  if (review.status !== "pending") {
    throw new AppError(409, "CONFLICT", `Review item ${reviewId} has already been resolved.`);
  }

  let effectedEntity: JsonMap = {};

  if (review.entityType === "relation") {
    const relationStatus = action === "reject" ? "rejected" : "active";
    const relation = repository.updateRelationStatus(review.entityId, relationStatus);
    repository.recordProvenance({
      entityType: "relation",
      entityId: relation.id,
      operationType: action === "reject" ? "reject" : "approve",
      source: input.source,
      metadata: {
        reviewId,
        reviewType: review.reviewType
      }
    });
    effectedEntity = { relation };
  }

  if (review.entityType === "node") {
    const patch = input.patch ?? {};
    if (action === "reject") {
      const node = repository.updateNode(review.entityId, {
        status: "archived",
        metadata: {
          ...repository.getNode(review.entityId).metadata,
          rejectedAt: new Date().toISOString()
        }
      });
      repository.recordProvenance({
        entityType: "node",
        entityId: node.id,
        operationType: "reject",
        source: input.source,
        metadata: {
          reviewId,
          reviewType: review.reviewType
        }
      });
      effectedEntity = { node };
    } else {
      const existing = repository.getNode(review.entityId);
      repository.updateNode(review.entityId, {
        ...patch,
        status: "active",
        metadata: patch.metadata ?? existing.metadata
      });
      const node = repository.setNodeCanonicality(review.entityId, "canonical");
      if (Object.keys(patch).length > 0) {
        repository.recordProvenance({
          entityType: "node",
          entityId: node.id,
          operationType: "update",
          source: input.source,
          metadata: {
            reviewId,
            reviewType: review.reviewType,
            patchKeys: Object.keys(patch)
          }
        });
      }
      repository.recordProvenance({
        entityType: "node",
        entityId: node.id,
        operationType: "promote",
        source: input.source,
        metadata: {
          reviewId,
          reviewType: review.reviewType
        }
      });
      effectedEntity = { node };
    }
  }

  const nextStatus = action === "reject" ? "rejected" : "approved";
  const updatedReview = repository.updateReviewItemStatus(reviewId, nextStatus, input.notes ?? review.notes);
  repository.recordProvenance({
    entityType: "review_queue_item",
    entityId: reviewId,
    operationType: action === "reject" ? "reject" : "approve",
    source: input.source,
    metadata: {
      reviewType: review.reviewType,
      entityType: review.entityType,
      entityId: review.entityId
    }
  });

  return { review: updatedReview, effectedEntity };
}
