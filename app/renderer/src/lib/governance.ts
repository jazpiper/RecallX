import type { Activity, GovernanceFeedItem, GovernanceIssueItem } from './types.js';

export function buildHomeGovernanceFeed(governanceFeed: GovernanceFeedItem[], limit = 3) {
  return governanceFeed.slice(0, limit);
}

export function findLatestGovernanceFeedItem(governanceFeed: GovernanceFeedItem[]) {
  return governanceFeed[0] ?? null;
}

export function hasOpenGovernanceIssueForFeedItem(
  governanceIssues: GovernanceIssueItem[],
  event: GovernanceFeedItem,
) {
  return governanceIssues.some(
    (item) => item.entityType === event.entityType && item.entityId === event.entityId,
  );
}

export function findLatestGovernanceIssueFeedItem(
  governanceFeed: GovernanceFeedItem[],
  governanceIssues: GovernanceIssueItem[],
) {
  return governanceFeed.find((event) => hasOpenGovernanceIssueForFeedItem(governanceIssues, event)) ?? null;
}

export function buildReviewActionActivities(
  activities: Activity[],
  options: {
    targetNodeId?: string | null;
  } = {},
) {
  const { targetNodeId } = options;

  return activities.filter((activity) => {
    if (activity.activityType !== 'review_action') {
      return false;
    }

    if (!targetNodeId) {
      return true;
    }

    return activity.targetNodeId === targetNodeId;
  });
}
