import type { RelationType } from "../shared/contracts.js";
import type { RelationUsageSummary } from "../shared/types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function relationTypeSpecificityBonus(relationType: RelationType): number {
  switch (relationType) {
    case "depends_on":
      return 0.14;
    case "supports":
      return 0.12;
    case "contradicts":
      return 0.1;
    case "derived_from":
    case "produced_by":
      return 0.08;
    case "elaborates":
    case "relevant_to":
      return 0.05;
    case "related_to":
    default:
      return 0.02;
  }
}

export function computeUsageBonus(summary?: RelationUsageSummary): number {
  if (!summary) {
    return 0;
  }

  let bonus = clamp(summary.totalDelta, -0.25, 0.35);
  if (summary.lastEventAt) {
    const ageMs = Date.now() - Date.parse(summary.lastEventAt);
    if (Number.isFinite(ageMs) && ageMs <= 1000 * 60 * 60 * 24 * 30) {
      bonus += summary.totalDelta >= 0 ? 0.03 : -0.03;
    }
  }

  return clamp(bonus, -0.3, 0.4);
}

export function computeAgeDecay(referenceAt?: string | null): number {
  if (!referenceAt) {
    return 0;
  }

  const ageMs = Date.now() - Date.parse(referenceAt);
  if (!Number.isFinite(ageMs) || ageMs <= 0) {
    return 0;
  }

  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 30) {
    return 0;
  }

  return clamp((ageDays - 30) * 0.0025, 0, 0.2);
}

export function computeMaintainedScores(baseScore: number, summary?: RelationUsageSummary, referenceAt?: string | null) {
  const usageScore = computeUsageBonus(summary);
  const ageDecay = computeAgeDecay(summary?.lastEventAt ?? referenceAt);
  const finalScore = clamp(baseScore + usageScore - ageDecay, 0, 1.5);
  return {
    usageScore,
    ageDecay,
    finalScore
  };
}
