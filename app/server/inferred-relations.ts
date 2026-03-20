import type { JsonMap, NodeRecord } from "../shared/types.js";
import type { RelationType } from "../shared/contracts.js";
import type { MemforgeRepository } from "./repositories.js";

const AUTO_INFERRED_GENERATORS = [
  "deterministic-tag-overlap",
  "deterministic-body-reference",
  "deterministic-activity-reference",
  "deterministic-project-membership",
  "deterministic-shared-artifact"
] as const;

const MAX_CANDIDATES = 200;
const MAX_INFERRED_PER_NODE = 12;
const MAX_ACTIVITY_BODIES = 8;

type AutoGenerator = (typeof AUTO_INFERRED_GENERATORS)[number];

type GeneratedCandidate = {
  fromNodeId: string;
  toNodeId: string;
  relationType: RelationType;
  generator: AutoGenerator;
  baseScore: number;
  evidence: JsonMap;
};

type TargetInferenceContext = {
  normalizedTags: string[];
  projectIds: Set<string>;
  artifactKeys: { exactPaths: string[]; baseNames: string[] };
};

type ArtifactKeySet = {
  exactPaths: string[];
  baseNames: string[];
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => normalizeText(tag)).filter(Boolean)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titlePattern(title: string): RegExp | null {
  const normalized = normalizeText(title);
  if (normalized.length < 5) {
    return null;
  }

  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalized)}([^a-z0-9]|$)`, "i");
}

function mentionsNode(haystacks: string[], candidate: NodeRecord): { idMention: boolean; titleMention: boolean } {
  const normalizedHaystacks = haystacks.map(normalizeText).filter(Boolean);
  const idMention = normalizedHaystacks.some((haystack) => haystack.includes(candidate.id.toLowerCase()));
  const candidateTitlePattern = candidate.title ? titlePattern(candidate.title) : null;
  const titleMention = candidateTitlePattern
    ? normalizedHaystacks.some((haystack) => candidateTitlePattern.test(haystack))
    : false;

  return { idMention, titleMention };
}

function sortPair(left: string, right: string): [string, string] {
  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}

function buildTagOverlapCandidate(target: NodeRecord, candidate: NodeRecord, targetTags: string[]): GeneratedCandidate | null {
  const candidateTags = new Set(normalizeTags(candidate.tags));
  const sharedTags = targetTags.filter((tag) => candidateTags.has(tag));
  if (!sharedTags.length) {
    return null;
  }

  const [fromNodeId, toNodeId] = sortPair(target.id, candidate.id);
  return {
    fromNodeId,
    toNodeId,
    relationType: "related_to",
    generator: "deterministic-tag-overlap",
    baseScore: Math.min(0.62, 0.36 + sharedTags.length * 0.1),
    evidence: {
      sharedTags
    }
  };
}

function buildBodyReferenceCandidate(target: NodeRecord, candidate: NodeRecord): GeneratedCandidate | null {
  const targetMentionsCandidate = mentionsNode([target.title ?? "", target.body ?? "", target.summary ?? ""], candidate);
  const candidateMentionsTarget = mentionsNode([candidate.title ?? "", candidate.body ?? "", candidate.summary ?? ""], target);
  if (!targetMentionsCandidate.idMention && !targetMentionsCandidate.titleMention && !candidateMentionsTarget.idMention && !candidateMentionsTarget.titleMention) {
    return null;
  }

  const [fromNodeId, toNodeId] = sortPair(target.id, candidate.id);
  const idMentionCount = Number(targetMentionsCandidate.idMention) + Number(candidateMentionsTarget.idMention);
  const titleMentionCount = Number(targetMentionsCandidate.titleMention) + Number(candidateMentionsTarget.titleMention);

  return {
    fromNodeId,
    toNodeId,
    relationType: "relevant_to",
    generator: "deterministic-body-reference",
    baseScore: Math.min(0.82, 0.52 + idMentionCount * 0.16 + titleMentionCount * 0.1),
    evidence: {
      targetMentionsCandidate,
      candidateMentionsTarget
    }
  };
}

function buildActivityReferenceCandidate(target: NodeRecord, candidate: NodeRecord, activityBodies: string[]): GeneratedCandidate | null {
  const activityMentionsCandidate = mentionsNode(activityBodies, candidate);
  const mentionCount =
    Number(activityMentionsCandidate.idMention) * 2 + Number(activityMentionsCandidate.titleMention);
  if (!mentionCount) {
    return null;
  }

  const [fromNodeId, toNodeId] = sortPair(target.id, candidate.id);
  return {
    fromNodeId,
    toNodeId,
    relationType: "relevant_to",
    generator: "deterministic-activity-reference",
    baseScore: Math.min(0.74, 0.45 + mentionCount * 0.11),
    evidence: {
      targetNodeId: target.id,
      activityMentionsCandidate
    }
  };
}

function buildProjectMembershipCandidate(
  target: NodeRecord,
  candidate: NodeRecord,
  candidateProjectIds: string[],
  targetProjects: Set<string>
): GeneratedCandidate | null {
  const sharedProjectIds = candidateProjectIds.filter((projectId) => targetProjects.has(projectId));

  if (!sharedProjectIds.length) {
    return null;
  }

  const [fromNodeId, toNodeId] = sortPair(target.id, candidate.id);
  return {
    fromNodeId,
    toNodeId,
    relationType: "relevant_to",
    generator: "deterministic-project-membership",
    baseScore: Math.min(0.8, 0.58 + sharedProjectIds.length * 0.08),
    evidence: {
      sharedProjectIds
    }
  };
}

function buildSharedArtifactCandidate(
  target: NodeRecord,
  candidate: NodeRecord,
  candidateArtifacts: ArtifactKeySet,
  targetArtifacts: { exactPaths: string[]; baseNames: string[] }
): GeneratedCandidate | null {
  const candidateExact = new Set(candidateArtifacts.exactPaths);
  const candidateBase = new Set(candidateArtifacts.baseNames);
  const sharedExactPaths = targetArtifacts.exactPaths.filter((artifactPath) => candidateExact.has(artifactPath));
  const sharedBaseNames = targetArtifacts.baseNames.filter((baseName) => candidateBase.has(baseName));

  if (!sharedExactPaths.length && !sharedBaseNames.length) {
    return null;
  }

  const [fromNodeId, toNodeId] = sortPair(target.id, candidate.id);
  return {
    fromNodeId,
    toNodeId,
    relationType: "related_to",
    generator: "deterministic-shared-artifact",
    baseScore: Math.min(0.76, 0.48 + sharedExactPaths.length * 0.16 + sharedBaseNames.length * 0.06),
    evidence: {
      sharedExactPaths,
      sharedBaseNames
    }
  };
}

function collectGeneratedCandidates(
  repository: MemforgeRepository,
  target: NodeRecord,
  trigger: "node-write" | "activity-append" | "reindex"
): GeneratedCandidate[] {
  const candidateMap = new Map<string, NodeRecord>();
  for (const candidate of repository.listInferenceCandidateNodes(target.id, MAX_CANDIDATES)) {
    candidateMap.set(candidate.id, candidate);
  }
  const extraCandidateIds = [
    ...repository.listSharedProjectMemberNodeIds(target.id, MAX_CANDIDATES),
    ...repository.listNodesSharingArtifactPaths(target.id, MAX_CANDIDATES)
  ].filter((candidateId) => !candidateMap.has(candidateId));
  for (const candidate of repository.getNodesByIds(extraCandidateIds).values()) {
    if (candidate.status === "active" || candidate.status === "contested") {
      candidateMap.set(candidate.id, candidate);
    }
  }
  const candidates = Array.from(candidateMap.values());
  const projectMembershipsByNodeId = repository.listProjectMembershipIdsByNodeIds([target.id, ...candidates.map((candidate) => candidate.id)]);
  const artifactKeysByNodeId = repository.listArtifactKeysByNodeIds([target.id, ...candidates.map((candidate) => candidate.id)]);
  const targetContext: TargetInferenceContext = {
    normalizedTags: normalizeTags(target.tags),
    projectIds: new Set(projectMembershipsByNodeId.get(target.id) ?? []),
    artifactKeys: artifactKeysByNodeId.get(target.id) ?? { exactPaths: [], baseNames: [] }
  };
  const activityBodies =
    trigger === "activity-append" || trigger === "reindex"
      ? repository
          .listNodeActivities(target.id, MAX_ACTIVITY_BODIES)
          .map((activity) => activity.body ?? "")
          .filter(Boolean)
      : [];

  return candidates.flatMap((candidate) => {
    const generated: GeneratedCandidate[] = [];
    const tagOverlapCandidate = buildTagOverlapCandidate(target, candidate, targetContext.normalizedTags);
    if (tagOverlapCandidate) {
      generated.push(tagOverlapCandidate);
    }
    const bodyReferenceCandidate = buildBodyReferenceCandidate(target, candidate);
    if (bodyReferenceCandidate) {
      generated.push(bodyReferenceCandidate);
    }
    if (activityBodies.length) {
      const activityReferenceCandidate = buildActivityReferenceCandidate(target, candidate, activityBodies);
      if (activityReferenceCandidate) {
        generated.push(activityReferenceCandidate);
      }
    }
    const projectMembershipCandidate = buildProjectMembershipCandidate(
      target,
      candidate,
      projectMembershipsByNodeId.get(candidate.id) ?? [],
      targetContext.projectIds
    );
    if (projectMembershipCandidate) {
      generated.push(projectMembershipCandidate);
    }
    const sharedArtifactCandidate = buildSharedArtifactCandidate(
      target,
      candidate,
      artifactKeysByNodeId.get(candidate.id) ?? { exactPaths: [], baseNames: [] },
      targetContext.artifactKeys
    );
    if (sharedArtifactCandidate) {
      generated.push(sharedArtifactCandidate);
    }
    return generated;
  });
}

export function refreshAutomaticInferredRelationsForNode(
  repository: MemforgeRepository,
  nodeId: string,
  trigger: "node-write" | "activity-append" | "reindex"
): { upsertedCount: number; expiredCount: number; relationIds: string[] } {
  const target = repository.getNode(nodeId);
  if (target.status === "archived") {
    const expiredCount = repository.expireAutoInferredRelationsForNode(nodeId, [...AUTO_INFERRED_GENERATORS]);
    return { upsertedCount: 0, expiredCount, relationIds: [] };
  }

  const deduped = new Map<string, GeneratedCandidate>();
  for (const candidate of collectGeneratedCandidates(repository, target, trigger)) {
    const key = [candidate.fromNodeId, candidate.toNodeId, candidate.relationType, candidate.generator].join(":");
    const existing = deduped.get(key);
    if (!existing || candidate.baseScore > existing.baseScore) {
      deduped.set(key, candidate);
    }
  }

  const relationIds = Array.from(deduped.values())
    .sort((left, right) => right.baseScore - left.baseScore)
    .slice(0, MAX_INFERRED_PER_NODE)
    .map((candidate) =>
      repository.upsertInferredRelation({
        fromNodeId: candidate.fromNodeId,
        toNodeId: candidate.toNodeId,
        relationType: candidate.relationType,
        baseScore: candidate.baseScore,
        usageScore: 0,
        finalScore: candidate.baseScore,
        status: "active",
        generator: candidate.generator,
        evidence: candidate.evidence,
        metadata: {
          trigger
        }
      }).id
    );

  const expiredCount = repository.expireAutoInferredRelationsForNode(nodeId, [...AUTO_INFERRED_GENERATORS], relationIds);
  return {
    upsertedCount: relationIds.length,
    expiredCount,
    relationIds
  };
}

export function reindexAutomaticInferredRelations(
  repository: MemforgeRepository,
  input?: { limit?: number }
): { processedNodes: number; upsertedCount: number; expiredCount: number; relationIds: string[] } {
  const targetNodeIds = repository.listInferenceTargetNodeIds(input?.limit ?? 250);
  let upsertedCount = 0;
  let expiredCount = 0;
  const relationIds = new Set<string>();

  for (const nodeId of targetNodeIds) {
    const result = refreshAutomaticInferredRelationsForNode(repository, nodeId, "reindex");
    upsertedCount += result.upsertedCount;
    expiredCount += result.expiredCount;
    for (const relationId of result.relationIds) {
      relationIds.add(relationId);
    }
  }

  return {
    processedNodes: targetNodeIds.length,
    upsertedCount,
    expiredCount,
    relationIds: Array.from(relationIds)
  };
}
