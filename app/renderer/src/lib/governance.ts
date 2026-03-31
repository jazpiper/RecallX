import type { GovernanceFeedItem, GovernanceIssueItem } from './types.js';

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
