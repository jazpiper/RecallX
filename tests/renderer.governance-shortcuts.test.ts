import { describe, expect, it } from 'vitest';

import {
  buildHomeGovernanceFeed,
  buildReviewActionActivities,
  findLatestGovernanceFeedItem,
  findLatestGovernanceIssueFeedItem,
  hasOpenGovernanceIssueForFeedItem,
} from '../app/renderer/src/lib/governance.js';
import type { Activity, GovernanceFeedItem, GovernanceIssueItem } from '../app/renderer/src/lib/types.js';

function makeGovernanceIssue(overrides: Partial<GovernanceIssueItem> = {}): GovernanceIssueItem {
  return {
    entityType: overrides.entityType ?? 'node',
    entityId: overrides.entityId ?? 'node_open',
    state: overrides.state ?? 'low_confidence',
    confidence: overrides.confidence ?? 0.42,
    reasons: overrides.reasons ?? ['Needs review'],
    lastEvaluatedAt: overrides.lastEvaluatedAt ?? '2026-03-31T03:00:00.000Z',
    lastTransitionAt: overrides.lastTransitionAt ?? '2026-03-31T03:00:00.000Z',
    metadata: overrides.metadata ?? {},
    title: overrides.title ?? 'Open governance issue',
    subtitle: overrides.subtitle ?? 'Node issue',
  };
}

function makeGovernanceFeedItem(overrides: Partial<GovernanceFeedItem> = {}): GovernanceFeedItem {
  return {
    id: overrides.id ?? 'event_1',
    entityType: overrides.entityType ?? 'node',
    entityId: overrides.entityId ?? 'node_open',
    eventType: overrides.eventType ?? 'promoted',
    previousState: overrides.previousState ?? 'low_confidence',
    nextState: overrides.nextState ?? 'healthy',
    confidence: overrides.confidence ?? 0.91,
    reason: overrides.reason ?? 'Reviewed manually.',
    createdAt: overrides.createdAt ?? '2026-03-31T03:01:00.000Z',
    metadata: overrides.metadata ?? {},
    action: overrides.action ?? 'promote',
    title: overrides.title ?? 'Reviewed note',
    subtitle: overrides.subtitle ?? 'Node issue',
    nodeId: overrides.nodeId ?? 'node_open',
    fromNodeId: overrides.fromNodeId ?? null,
    toNodeId: overrides.toNodeId ?? null,
    relationType: overrides.relationType ?? null,
  };
}

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: overrides.id ?? 'activity_1',
    activityType: overrides.activityType ?? 'review_action',
    targetNodeId: overrides.targetNodeId ?? 'node_open',
    body: overrides.body ?? 'Reviewed manually.',
    createdBy: overrides.createdBy ?? 'tester',
    sourceType: overrides.sourceType ?? 'human',
    sourceLabel: overrides.sourceLabel ?? 'tester',
    createdAt: overrides.createdAt ?? '2026-03-31T03:02:00.000Z',
    metadata: overrides.metadata ?? {},
  };
}

describe('renderer governance shortcut helpers', () => {
  it('builds the compact Home governance slice from the latest feed items', () => {
    const feed = [
      makeGovernanceFeedItem({ id: 'event_1' }),
      makeGovernanceFeedItem({ id: 'event_2' }),
      makeGovernanceFeedItem({ id: 'event_3' }),
      makeGovernanceFeedItem({ id: 'event_4' }),
    ];

    expect(buildHomeGovernanceFeed(feed).map((item) => item.id)).toEqual(['event_1', 'event_2', 'event_3']);
    expect(findLatestGovernanceFeedItem(feed)?.id).toBe('event_1');
  });

  it('only treats matching still-open issues as issue-entry targets', () => {
    const issues = [makeGovernanceIssue({ entityId: 'node_open' })];
    const openEvent = makeGovernanceFeedItem({ entityId: 'node_open' });
    const resolvedEvent = makeGovernanceFeedItem({ id: 'event_2', entityId: 'node_resolved', nodeId: 'node_resolved' });

    expect(hasOpenGovernanceIssueForFeedItem(issues, openEvent)).toBe(true);
    expect(hasOpenGovernanceIssueForFeedItem(issues, resolvedEvent)).toBe(false);
  });

  it('finds the latest feed item that still maps to an open governance issue', () => {
    const issues = [makeGovernanceIssue({ entityId: 'node_open' })];
    const feed = [
      makeGovernanceFeedItem({ id: 'event_resolved', entityId: 'node_resolved', nodeId: 'node_resolved', createdAt: '2026-03-31T03:05:00.000Z' }),
      makeGovernanceFeedItem({ id: 'event_open', entityId: 'node_open', createdAt: '2026-03-31T03:04:00.000Z' }),
    ];

    expect(findLatestGovernanceIssueFeedItem(feed, issues)?.id).toBe('event_open');
  });

  it('filters review_action activities for detail and preview recall', () => {
    const review = makeActivity({ id: 'activity_review', targetNodeId: 'node_open' });
    const unrelatedReview = makeActivity({ id: 'activity_other_review', targetNodeId: 'node_other' });
    const noteAppend = makeActivity({ id: 'activity_append', activityType: 'note_appended' });

    expect(buildReviewActionActivities([review, unrelatedReview, noteAppend]).map((item) => item.id)).toEqual([
      'activity_review',
      'activity_other_review',
    ]);
    expect(
      buildReviewActionActivities([review, unrelatedReview, noteAppend], { targetNodeId: 'node_open' }).map((item) => item.id),
    ).toEqual(['activity_review']);
  });
});
