import { Suspense, lazy, startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeGovernanceAction as applyNodeGovernanceActionRequest,
  applyRelationGovernanceAction as applyRelationGovernanceActionRequest,
  appendRelationUsageEvent,
  clearRendererToken,
  createWorkspaceBackup,
  createWorkspace as createWorkspaceSession,
  createNode,
  exportWorkspace as exportWorkspaceSnapshot,
  getBootstrap,
  getContextBundlePreview,
  getGovernanceEvents,
  getGovernanceIssues,
  getNodeDetail,
  getRelationDetail,
  getSettings,
  getGraphNeighborhood,
  getProjectGraph,
  getSemanticIssues,
  getSemanticStatus,
  getSnapshot,
  getWorkspaceCatalog,
  getWorkspace,
  isAuthError,
  listWorkspaceBackups,
  openWorkspace as openWorkspaceSession,
  previewWorkspaceImport,
  refreshNodeSummary as refreshNodeSummaryRequest,
  importWorkspace as importWorkspaceRequest,
  restoreWorkspaceBackup,
  saveRendererToken,
  searchWorkspace,
  subscribeWorkspaceEvents,
  queueSemanticReindex,
  updateSettings,
  updateNode as updateNodeRequest,
  archiveNode as archiveNodeRequest,
} from './lib/mockApi';
import { buildProjectGraphEmphasis, filterProjectGraphView, listProjectGraphRelationTypes } from './lib/projectGraph';
import {
  buildRecentSelectableNodeIds,
  buildSearchResultNodeMap,
  buildSearchSourceOptions,
  filterSearchWorkspaceResults,
  pushRecentEntry,
  type SearchResultScope,
} from './lib/searchResults';
import {
  buildHomeRecentNodes,
  buildHomeSuggestedProjectNode,
  buildPaletteRecentNodes,
  buildPinnedProjectNodes,
  buildSearchNodeTypeOptions,
  filterPaletteRecentNodes,
} from './lib/rendererShell.js';
import {
  buildRecentPaletteCommands,
  createPaletteCommands,
  filterPaletteCommands,
} from './lib/rendererPalette.js';
import {
  buildHomeGovernanceFeed,
  buildReviewActionActivities,
  findLatestGovernanceFeedItem,
  findLatestGovernanceIssueFeedItem,
  hasOpenGovernanceIssueForFeedItem,
} from './lib/governance';
import { profileHotPath } from './lib/hotPathProfile.js';
import type {
  Activity,
  ActivitySearchHit,
  Artifact,
  ContextBundlePreviewItem,
  GovernanceDecisionAction,
  GovernanceEntityType,
  GovernanceFeedItem,
  GovernanceIssueItem,
  GovernancePayload,
  GovernanceState,
  GraphConnection,
  NavView,
  NodeDetail,
  NodeGovernanceAction,
  Node,
  ProjectGraphPayload,
  Relation,
  RelationDetail,
  RelationGovernanceAction,
  RelationType,
  SemanticIssue,
  SemanticIssueFilter,
  SemanticStatus,
  SearchNodeHit,
  WorkspaceBackupRecord,
  WorkspaceCatalogItem,
  WorkspaceExportRecord,
  WorkspaceImportOptions,
  WorkspaceImportPreviewRecord,
  WorkspaceImportRecord,
  WorkspaceSeed,
} from './lib/types';

type DetailPanel = {
  node: Node | null;
  related: Node[];
  bundleItems: ContextBundlePreviewItem[];
  activities: Activity[];
  artifacts: Artifact[];
  governance: GovernancePayload;
};

type GovernanceDetailPanel = {
  node: Node | null;
  relation: Relation | null;
  fromNode: Node | null;
  toNode: Node | null;
  governance: GovernancePayload;
};

type SearchPanelState = {
  nodes: SearchNodeHit[];
  activities: ActivitySearchHit[];
  total: number;
  isLoading: boolean;
  error: string | null;
};

type SearchActivityTypeFilter = 'all' | 'review_action';
type GovernanceFeedEntityFilter = 'all' | GovernanceEntityType;
type GovernanceFeedActionFilter = 'all' | GovernanceDecisionAction;
type GraphMode = 'neighborhood' | 'project-map';
type PaletteSection = 'routes' | 'searches' | 'nodes';
const BEARER_RECENT_POLL_INTERVAL_MS = 15000;
const ACTIVE_PROJECT_SETTING_KEY = 'workspace.activeProjectId';
const RECENT_SEARCHES_STORAGE_KEY = 'recallx.recent-searches';
const RECENT_COMMANDS_STORAGE_KEY = 'recallx.recent-commands';
const GOVERNANCE_FEED_ENTITY_FILTER_STORAGE_KEY = 'recallx.governance-feed-entity-filter';
const GOVERNANCE_FEED_ACTION_FILTER_STORAGE_KEY = 'recallx.governance-feed-action-filter';
const searchActivityTypeFilterOptions = ['all', 'review_action'] as const;
const governanceFeedEntityFilterOptions = ['all', 'node', 'relation'] as const;
const governanceFeedActionFilterOptions = ['all', 'promote', 'contest', 'archive', 'accept', 'reject'] as const;
const semanticIssueFilterOptions = ['all', 'failed', 'stale', 'pending'] as const;
const EMPTY_ACTIVE_PROJECT_DIGEST = {
  bundleItems: [] as ContextBundlePreviewItem[],
  activities: [] as Activity[],
  relatedCount: 0,
};

const navigation: { id: NavView; label: string; hint: string }[] = [
  { id: 'home', label: 'Home', hint: 're-entry' },
  { id: 'recent', label: 'Memory', hint: 'browse' },
  { id: 'settings', label: 'Workspace', hint: 'ops' },
];

const utilityNavigation: Array<
  | { id: NavView; label: string; graphMode?: undefined }
  | { id: 'project-map'; label: string; graphMode: GraphMode }
> = [
  { id: 'graph', label: 'Graph' },
  { id: 'project-map', label: 'Project map', graphMode: 'project-map' },
  { id: 'governance', label: 'Review' },
];

function formatApiBase(apiBind: string): string {
  if (apiBind.startsWith('[')) {
    return `http://${apiBind}/api/v1`;
  }

  const colonCount = (apiBind.match(/:/g) ?? []).length;
  if (colonCount > 1) {
    const lastColonIndex = apiBind.lastIndexOf(':');
    const host = apiBind.slice(0, lastColonIndex);
    const port = apiBind.slice(lastColonIndex + 1);
    if (host && /^\d+$/.test(port)) {
      return `http://[${host}]:${port}/api/v1`;
    }
  }

  return `http://${apiBind}/api/v1`;
}

const ProjectGraphCanvas = lazy(async () => {
  const module = await import('./components/ProjectGraphCanvas');
  return { default: module.ProjectGraphCanvas };
});

function badgeTone(status: string) {
  if (status === 'active' || status === 'approved') return 'tone-good';
  if (status === 'contested' || status === 'pending') return 'tone-warn';
  if (status === 'draft' || status === 'suggested') return 'tone-info';
  return 'tone-muted';
}

function relationToneClass(relationType: GraphConnection['relation']['relationType']) {
  switch (relationType) {
    case 'supports':
      return 'relation-chip--supports';
    case 'depends_on':
      return 'relation-chip--depends';
    case 'contradicts':
      return 'relation-chip--contradicts';
    case 'elaborates':
      return 'relation-chip--elaborates';
    case 'derived_from':
      return 'relation-chip--derived';
    case 'produced_by':
      return 'relation-chip--produced';
    case 'relevant_to':
      return 'relation-chip--relevant';
    default:
      return 'relation-chip--related';
  }
}

function relationLabel(value: string) {
  return value.replaceAll('_', ' ');
}

function formatTime(iso: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function semanticIssueTone(status: SemanticIssue['embeddingStatus']) {
  switch (status) {
    case 'failed':
      return 'tone-danger';
    case 'stale':
      return 'tone-info';
    default:
      return 'tone-warn';
  }
}

function buildSemanticIssueStatuses(filter: SemanticIssueFilter): SemanticIssue['embeddingStatus'][] | undefined {
  return filter === 'all' ? undefined : [filter];
}

function mergeSemanticIssuePages(current: SemanticIssue[], incoming: SemanticIssue[]) {
  const seen = new Set(current.map((item) => item.nodeId));
  return [...current, ...incoming.filter((item) => !seen.has(item.nodeId))];
}

function governanceStateRank(state: GovernanceIssueItem['state']) {
  switch (state) {
    case 'contested':
      return 0;
    case 'low_confidence':
      return 1;
    default:
      return 2;
  }
}

function formatConfidence(value: number) {
  return `${(value * 100).toFixed(0)}%`;
}

function formatCompactId(value: string) {
  const separatorIndex = value.indexOf(':');
  const kind = separatorIndex >= 0 ? value.slice(0, separatorIndex) : null;
  const raw = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value;
  const compact = raw.length > 16 ? `${raw.slice(0, 8)}…${raw.slice(-4)}` : raw;
  return kind ? `${kind}:${compact}` : compact;
}

function getGovernanceStateSummary(state: GovernanceIssueItem['state']) {
  switch (state) {
    case 'contested':
      return 'Conflicting signals need review.';
    case 'low_confidence':
      return 'Trust is still weak.';
    default:
      return 'State is stable.';
  }
}

function formatGovernanceStateLabel(state: GovernanceState | null) {
  return state ? state.replaceAll('_', ' ') : 'unknown';
}

function getGovernanceActionLabel(item: GovernanceIssueItem) {
  return item.entityType === 'node' ? 'Inspect node' : 'Relation issue';
}

function getGovernanceDecisionActionLabel(action: GovernanceDecisionAction | null) {
  switch (action) {
    case 'promote':
      return 'Promote';
    case 'contest':
      return 'Contest';
    case 'archive':
      return 'Archive';
    case 'accept':
      return 'Accept';
    case 'reject':
      return 'Reject';
    default:
      return 'Manual review';
  }
}

function isReviewActionActivity(activity: { activityType: string }) {
  return activity.activityType === 'review_action';
}

function getActivityTypeLabel(activity: {
  activityType: string;
  metadata?: Record<string, string | number | boolean>;
}) {
  if (!isReviewActionActivity(activity)) {
    return activity.activityType.replaceAll('_', ' ');
  }

  const action = typeof activity.metadata?.action === 'string' ? activity.metadata.action : null;
  return action ? `Review decision · ${getGovernanceDecisionActionLabel(action as GovernanceDecisionAction)}` : 'Review decision';
}

function getActivityPreviewText(activity: {
  activityType: string;
  body?: string | null;
  metadata?: Record<string, string | number | boolean>;
}) {
  if (activity.body && activity.body.trim()) {
    return activity.body;
  }

  if (isReviewActionActivity(activity)) {
    const action = typeof activity.metadata?.action === 'string' ? activity.metadata.action : null;
    return action
      ? `${getGovernanceDecisionActionLabel(action as GovernanceDecisionAction)} decision recorded for this memory.`
      : 'A manual review decision was recorded for this memory.';
  }

  return activity.activityType.replaceAll('_', ' ');
}

function getReviewActionProvenanceText(activity: {
  activityType: string;
  sourceLabel?: string | null;
  metadata?: Record<string, string | number | boolean>;
}) {
  if (!isReviewActionActivity(activity)) {
    return null;
  }

  const nextState =
    typeof activity.metadata?.nextState === 'string'
      ? formatGovernanceStateLabel(activity.metadata.nextState as GovernanceState)
      : null;
  const sourceLabel = activity.sourceLabel?.trim() || null;

  if (sourceLabel && nextState) {
    return `${sourceLabel} moved this to ${nextState}.`;
  }
  if (nextState) {
    return `Moved to ${nextState}.`;
  }
  if (sourceLabel) {
    return `${sourceLabel} recorded this review.`;
  }
  return 'Review recorded.';
}

function getGovernanceFeedProvenanceText(item: GovernanceFeedItem) {
  const nextState = formatGovernanceStateLabel(item.nextState);
  if (item.entityType === 'relation' && item.relationType) {
    return `${getGovernanceDecisionActionLabel(item.action)} ${relationLabel(item.relationType)} -> ${nextState}`;
  }
  return `${getGovernanceDecisionActionLabel(item.action)} -> ${nextState}`;
}

function isNodeGovernanceCandidate(node: Node | null, governance: GovernancePayload['state'] | null = null) {
  if (!node) {
    return false;
  }
  return (
    node.status === 'contested' ||
    node.canonicality === 'suggested' ||
    node.canonicality === 'generated' ||
    governance?.state === 'low_confidence' ||
    governance?.state === 'contested'
  );
}

function canPromoteNode(node: Node | null) {
  return Boolean(node && node.status !== 'archived' && (node.canonicality === 'suggested' || node.canonicality === 'generated'));
}

function canContestNode(node: Node | null) {
  return Boolean(node && node.status !== 'archived' && node.status !== 'contested');
}

function canArchiveNode(node: Node | null) {
  return Boolean(node && node.status !== 'archived');
}

function canAcceptRelation(relation: Relation | null) {
  return Boolean(relation && relation.status !== 'archived' && relation.status !== 'active');
}

function canRejectRelation(relation: Relation | null) {
  return Boolean(relation && relation.status !== 'archived' && relation.status !== 'rejected');
}

function canArchiveRelation(relation: Relation | null) {
  return Boolean(relation && relation.status !== 'archived');
}

function getViewTitle(view: NavView) {
  switch (view) {
    case 'search':
      return 'Integrations';
    case 'projects':
      return 'Integrations';
    case 'recent':
      return 'Memory';
    case 'settings':
      return 'Workspace';
    case 'governance':
      return 'Review';
    case 'graph':
      return 'Graph';
    default:
      return 'Home';
  }
}

function resolveInitialView(): NavView {
  if (typeof window === 'undefined') {
    return 'home';
  }

  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  switch (view) {
    case 'search':
    case 'guide':
      return 'search';
    case 'graph':
      return 'graph';
    case 'governance':
      return 'governance';
    case 'recent':
      return 'recent';
    case 'settings':
      return 'settings';
    default:
      return 'home';
  }
}

function readStoredHistory(key: string): string[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeStoredHistory(key: string, items: string[]) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Ignore storage failures in the renderer so the command palette stays usable.
  }
}

function readStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === 'undefined') {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    return raw && allowed.includes(raw as T) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredChoice(key: string, value: string) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures so persisted filters stay optional.
  }
}

type GuideSection = {
  id: string;
  group: string;
  label: string;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  note?: string;
  code?: string;
  stats?: Array<{
    label: string;
    value: string;
    description: string;
  }>;
};

function emptyDetailPanel(): DetailPanel {
  return {
    node: null,
    related: [],
    bundleItems: [],
    activities: [],
    artifacts: [],
    governance: {
      state: null,
      events: [],
    },
  };
}

function emptyGovernanceDetailPanel(): GovernanceDetailPanel {
  return {
    node: null,
    relation: null,
    fromNode: null,
    toNode: null,
    governance: {
      state: null,
      events: [],
    },
  };
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSeed['workspace'] | null>(null);
  const [workspaceCatalog, setWorkspaceCatalog] = useState<WorkspaceCatalogItem[]>([]);
  const [snapshot, setSnapshot] = useState<WorkspaceSeed | null>(null);
  const [view, setView] = useState<NavView>(resolveInitialView);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('node_recallx');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [searchScopeFilter, setSearchScopeFilter] = useState<SearchResultScope>('all');
  const [searchNodeTypeFilter, setSearchNodeTypeFilter] = useState<Node['type'] | 'all'>('all');
  const [searchActivityTypeFilter, setSearchActivityTypeFilter] = useState<SearchActivityTypeFilter>('all');
  const [searchSourceFilter, setSearchSourceFilter] = useState<string | 'all'>('all');
  const [searchPanel, setSearchPanel] = useState<SearchPanelState>({
    nodes: [],
    activities: [],
    total: 0,
    isLoading: false,
    error: null,
  });
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [paletteSection, setPaletteSection] = useState<PaletteSection>('routes');
  const [paletteQuery, setPaletteQuery] = useState('');
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [recentCommands, setRecentCommands] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authTokenInput, setAuthTokenInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [selectedGovernanceId, setSelectedGovernanceId] = useState<string | null>(null);
  const [governanceDetail, setGovernanceDetail] = useState<GovernanceDetailPanel>(emptyGovernanceDetailPanel());
  const [isGovernanceDetailLoading, setIsGovernanceDetailLoading] = useState(false);
  const [governanceFeed, setGovernanceFeed] = useState<GovernanceFeedItem[]>([]);
  const [isGovernanceFeedLoading, setIsGovernanceFeedLoading] = useState(false);
  const [semanticStatus, setSemanticStatus] = useState<SemanticStatus | null>(null);
  const [semanticIssues, setSemanticIssues] = useState<SemanticIssue[]>([]);
  const [semanticIssueFilter, setSemanticIssueFilter] = useState<SemanticIssueFilter>('all');
  const [semanticIssuesCursor, setSemanticIssuesCursor] = useState<string | null>(null);
  const [isSemanticStatusLoading, setIsSemanticStatusLoading] = useState(false);
  const [isSemanticIssuesLoading, setIsSemanticIssuesLoading] = useState(false);
  const [isSemanticIssuesLoadingMore, setIsSemanticIssuesLoadingMore] = useState(false);
  const [isSemanticReindexing, setIsSemanticReindexing] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [semanticNotice, setSemanticNotice] = useState<string | null>(null);
  const [governanceFeedEntityFilter, setGovernanceFeedEntityFilter] = useState<GovernanceFeedEntityFilter>(() =>
    readStoredChoice(GOVERNANCE_FEED_ENTITY_FILTER_STORAGE_KEY, governanceFeedEntityFilterOptions, 'all')
  );
  const [governanceFeedActionFilter, setGovernanceFeedActionFilter] = useState<GovernanceFeedActionFilter>(() =>
    readStoredChoice(GOVERNANCE_FEED_ACTION_FILTER_STORAGE_KEY, governanceFeedActionFilterOptions, 'all')
  );
  const [captureType, setCaptureType] = useState<Node['type']>('note');
  const [captureProjectId, setCaptureProjectId] = useState('');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeProjectError, setActiveProjectError] = useState<string | null>(null);
  const [isSavingActiveProject, setIsSavingActiveProject] = useState(false);
  const [activeProjectDigest, setActiveProjectDigest] = useState(EMPTY_ACTIVE_PROJECT_DIGEST);
  const [isActiveProjectDigestLoading, setIsActiveProjectDigestLoading] = useState(false);
  const [captureTitle, setCaptureTitle] = useState('');
  const [captureBody, setCaptureBody] = useState('');
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const [isSavingCapture, setIsSavingCapture] = useState(false);
  const [workspaceRootInput, setWorkspaceRootInput] = useState('');
  const [workspaceNameInput, setWorkspaceNameInput] = useState('');
  const [restoreTargetRootInput, setRestoreTargetRootInput] = useState('');
  const [backupLabelInput, setBackupLabelInput] = useState('');
  const [importSourcePathInput, setImportSourcePathInput] = useState('');
  const [importLabelInput, setImportLabelInput] = useState('');
  const [importFormat, setImportFormat] = useState<'recallx_json' | 'markdown'>('markdown');
  const [importOptions, setImportOptions] = useState<WorkspaceImportOptions>({
    normalizeTitleWhitespace: true,
    trimBodyWhitespace: false,
    duplicateMode: 'warn',
  });
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const [workspaceImportError, setWorkspaceImportError] = useState<string | null>(null);
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false);
  const [workspaceBackups, setWorkspaceBackups] = useState<WorkspaceBackupRecord[]>([]);
  const [isWorkspaceBackupBusy, setIsWorkspaceBackupBusy] = useState(false);
  const [isWorkspaceImportPreviewBusy, setIsWorkspaceImportPreviewBusy] = useState(false);
  const [isWorkspaceImportBusy, setIsWorkspaceImportBusy] = useState(false);
  const [workspaceBackupNotice, setWorkspaceBackupNotice] = useState<string | null>(null);
  const [lastWorkspaceExport, setLastWorkspaceExport] = useState<WorkspaceExportRecord | null>(null);
  const [workspaceImportPreview, setWorkspaceImportPreview] = useState<WorkspaceImportPreviewRecord | null>(null);
  const [lastWorkspaceImport, setLastWorkspaceImport] = useState<WorkspaceImportRecord | null>(null);
  const [notePreviewTargetId, setNotePreviewTargetId] = useState<string | null>(null);
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [noteEditTitle, setNoteEditTitle] = useState('');
  const [noteEditBody, setNoteEditBody] = useState('');
  const [noteEditError, setNoteEditError] = useState<string | null>(null);
  const [isSavingNoteEdit, setIsSavingNoteEdit] = useState(false);
  const [isArchivingNote, setIsArchivingNote] = useState(false);
  const [governanceDecisionNote, setGovernanceDecisionNote] = useState('');
  const [governanceActionError, setGovernanceActionError] = useState<string | null>(null);
  const [governanceActionPending, setGovernanceActionPending] = useState<NodeGovernanceAction | null>(null);
  const [relationGovernanceActionPending, setRelationGovernanceActionPending] = useState<RelationGovernanceAction | null>(null);
  const [guideSectionId, setGuideSectionId] = useState('overview');
  const bundleUsageEventKeysRef = useRef(new Set<string>());
  const activeProjectBundleUsageEventKeysRef = useRef(new Set<string>());
  const captureProjectAutofillRef = useRef<string | null>(null);
  const commandPaletteInputRef = useRef<HTMLInputElement | null>(null);
  const relationUsageSessionIdRef = useRef(
    globalThis.crypto?.randomUUID?.() ?? `recallx-renderer-${Date.now()}`
  );
  const isRecallBrowseView = view === 'home' || view === 'recent';

  async function refreshSnapshotState(workspaceOverride?: WorkspaceSeed['workspace']) {
    const snapshotResult = await getSnapshot(
      workspaceOverride
        ? {
            workspace: workspaceOverride,
          }
        : undefined,
    );
    setSnapshot(snapshotResult);
    setLoadError(null);
    return snapshotResult;
  }

  async function refreshWorkspaceState(options?: {
    workspaceOverride?: WorkspaceSeed['workspace'];
    catalogOverride?: { current: WorkspaceSeed['workspace']; items: WorkspaceCatalogItem[] };
  }) {
    const [snapshotResult, catalog, backups] = await Promise.all([
      refreshSnapshotState(options?.workspaceOverride),
      options?.catalogOverride ? Promise.resolve(options.catalogOverride) : getWorkspaceCatalog(),
      listWorkspaceBackups().catch(() => []),
    ]);
    setWorkspace(options?.catalogOverride?.current ?? options?.workspaceOverride ?? snapshotResult.workspace);
    setWorkspaceCatalog(catalog.items);
    setWorkspaceBackups(backups);
    setWorkspaceRootInput(catalog.current.rootPath);
    setLoadError(null);
    return snapshotResult;
  }

  async function loadGovernanceIssues() {
    const issues = await getGovernanceIssues();
    return issues.slice().sort((left, right) => {
      const rankDiff = governanceStateRank(left.state) - governanceStateRank(right.state);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return left.confidence - right.confidence || right.lastTransitionAt.localeCompare(left.lastTransitionAt);
    });
  }

  async function loadGovernanceFeed() {
    const items = await getGovernanceEvents({
      entityTypes: governanceFeedEntityFilter === 'all' ? undefined : [governanceFeedEntityFilter],
      actions: governanceFeedActionFilter === 'all' ? undefined : [governanceFeedActionFilter],
      limit: 12,
    });
    return items.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async function loadSemanticOverview(filter: SemanticIssueFilter, cursor?: string | null) {
    const [status, issuesPage] = await Promise.all([
      getSemanticStatus(),
      getSemanticIssues({
        limit: 5,
        cursor,
        statuses: buildSemanticIssueStatuses(filter),
      }),
    ]);

    return {
      status,
      issuesPage,
    };
  }

  function handleRequestFailure(error: unknown, fallbackMessage: string) {
    if (isAuthError(error)) {
      clearRendererToken();
      setAuthRequired(true);
      setAuthError('Enter the RecallX API token to continue.');
      setLoadError(null);
      return;
    }

    setLoadError(error instanceof Error ? error.message : fallbackMessage);
  }

  function isNotFoundError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'status' in error && (error as { status?: unknown }).status === 404;
  }

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const bootstrap = await getBootstrap();
        if (!mounted) return;
        setWorkspace(bootstrap.workspace);
        if (bootstrap.authMode === 'bearer' && !bootstrap.hasToken) {
          setAuthRequired(true);
          setAuthError(null);
          setLoadError(null);
          return;
        }

        await refreshWorkspaceState({ workspaceOverride: bootstrap.workspace });
        if (!mounted) return;
        setAuthRequired(false);
        setAuthError(null);
        setSelectedGovernanceId(null);
      } catch (error) {
        if (!mounted) return;
        handleRequestFailure(error, 'Failed to load workspace.');
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (isLoading || authRequired || !isRecallBrowseView) {
      return;
    }

    let cancelled = false;
    let refreshInFlight = false;
    let refreshQueued = false;

    async function refreshRecentView() {
      if (cancelled || document.hidden) {
        return;
      }

      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }

      refreshInFlight = true;

      try {
        await refreshSnapshotState();
        setLoadError(null);
      } catch (error) {
        if (!cancelled) {
          handleRequestFailure(error, 'Failed to refresh recent activity.');
        }
      } finally {
        refreshInFlight = false;
        if (refreshQueued && !cancelled) {
          refreshQueued = false;
          void refreshRecentView();
        }
      }
    }

    function handleVisibilityChange() {
      if (!document.hidden) {
        void refreshRecentView();
      }
    }

    const unsubscribe = subscribeWorkspaceEvents({
      onWorkspaceUpdate: () => {
        void refreshRecentView();
      },
      onError: () => {
        if (!document.hidden) {
          void refreshRecentView();
        }
      },
    });
    const pollTimer =
      workspace?.authMode === 'bearer'
        ? window.setInterval(() => {
            if (!document.hidden) {
              void refreshRecentView();
            }
          }, BEARER_RECENT_POLL_INTERVAL_MS)
        : null;

    void refreshRecentView();
    window.addEventListener('focus', handleVisibilityChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      unsubscribe();
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
      }
      window.removeEventListener('focus', handleVisibilityChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [authRequired, isLoading, isRecallBrowseView, workspace?.authMode]);

  useEffect(() => {
    if (isLoading || authRequired || !isRecallBrowseView) {
      return;
    }

    const normalizedQuery = deferredQuery.trim();
    if (!normalizedQuery) {
      setSearchPanel({
        nodes: [],
        activities: [],
        total: 0,
        isLoading: false,
        error: null,
      });
      return;
    }

    let cancelled = false;
    setSearchPanel((current) => ({
      ...current,
      isLoading: true,
      error: null,
    }));

    void searchWorkspace({
      query: normalizedQuery,
      limit: 24,
      offset: 0,
    })
      .then((result) => {
        if (cancelled) return;
        setSearchPanel({
          nodes: result.nodes,
          activities: result.activities,
          total: result.total,
          isLoading: false,
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setSearchPanel({
          nodes: [],
          activities: [],
          total: 0,
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to search the workspace.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [authRequired, deferredQuery, isLoading, isRecallBrowseView]);

  const searchSourceOptions = useMemo(
    () => buildSearchSourceOptions(searchPanel.nodes, searchPanel.activities).slice(0, 4),
    [searchPanel.activities, searchPanel.nodes],
  );
  const searchNodeTypeOptions = useMemo(
    () => buildSearchNodeTypeOptions(searchPanel.nodes),
    [searchPanel.nodes],
  );
  const filteredSearchResults = useMemo(
    () =>
      profileHotPath('search.filteredResults', () =>
        filterSearchWorkspaceResults(searchPanel.nodes, searchPanel.activities, {
          scope: searchScopeFilter,
          nodeType: searchNodeTypeFilter,
          sourceLabel: searchSourceFilter,
          activityType: searchActivityTypeFilter,
        }),
      ),
    [searchActivityTypeFilter, searchNodeTypeFilter, searchPanel.activities, searchPanel.nodes, searchScopeFilter, searchSourceFilter],
  );
  const filteredSearchNodes = filteredSearchResults.nodes;
  const filteredSearchActivityHits = filteredSearchResults.activities;
  const filteredSearchTotal = filteredSearchResults.total;

  useEffect(() => {
    setRecentSearches(readStoredHistory(RECENT_SEARCHES_STORAGE_KEY));
    setRecentCommands(readStoredHistory(RECENT_COMMANDS_STORAGE_KEY));
  }, []);

  useEffect(() => {
    if (searchSourceFilter === 'all') {
      return;
    }

    if (!searchSourceOptions.includes(searchSourceFilter)) {
      setSearchSourceFilter('all');
    }
  }, [searchSourceFilter, searchSourceOptions]);

  useEffect(() => {
    if (searchNodeTypeFilter === 'all') {
      return;
    }

    if (!searchNodeTypeOptions.includes(searchNodeTypeFilter)) {
      setSearchNodeTypeFilter('all');
    }
  }, [searchNodeTypeFilter, searchNodeTypeOptions]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setIsCommandPaletteOpen(true);
        return;
      }

      if (event.key === 'Escape') {
        setIsCommandPaletteOpen(false);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!isCommandPaletteOpen) {
      setPaletteQuery('');
      return;
    }

    const timeout = window.setTimeout(() => {
      commandPaletteInputRef.current?.focus();
      commandPaletteInputRef.current?.select();
    }, 0);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [isCommandPaletteOpen]);

  const nodeMap = useMemo(
    () =>
      profileHotPath('search.nodeMap', () =>
        buildSearchResultNodeMap(snapshot?.nodes ?? [], searchPanel.nodes, searchPanel.activities),
      ),
    [searchPanel.activities, searchPanel.nodes, snapshot],
  );

  const recentSelectableNodeIds = useMemo(
    () =>
      profileHotPath('search.recentSelectableNodeIds', () =>
        buildRecentSelectableNodeIds(searchPanel.nodes, searchPanel.activities),
      ),
    [searchPanel.activities, searchPanel.nodes],
  );

  useEffect(() => {
    if (!snapshot?.nodes.length) {
      return;
    }
    if (!selectedNodeId || nodeMap.has(selectedNodeId)) {
      return;
    }
    if (view === 'recent' && recentSelectableNodeIds.has(selectedNodeId)) {
      return;
    }
    setSelectedNodeId(snapshot.nodes[0]?.id ?? '');
  }, [nodeMap, recentSelectableNodeIds, selectedNodeId, snapshot, view]);

  const graphFocusableNodes = useMemo(
    () =>
      (snapshot?.nodes ?? [])
        .slice()
        .sort((left, right) => (left.title || '').localeCompare(right.title || '') || left.updatedAt.localeCompare(right.updatedAt)),
    [snapshot],
  );
  const projectNodes = useMemo(
    () => graphFocusableNodes.filter((node) => node.type === 'project'),
    [graphFocusableNodes],
  );
  const activeProjectNode = useMemo(
    () => (activeProjectId ? projectNodes.find((node) => node.id === activeProjectId) ?? null : null),
    [activeProjectId, projectNodes],
  );
  useEffect(() => {
    if (!captureProjectId) {
      return;
    }

    if (!projectNodes.some((node) => node.id === captureProjectId)) {
      setCaptureProjectId('');
    }
  }, [captureProjectId, projectNodes]);

  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) ?? null : null;
  const selectedNodeKey = selectedNode?.id ?? null;

  const [detail, setDetail] = useState<DetailPanel>(emptyDetailPanel);
  const detailNode = detail.node?.id === selectedNode?.id ? detail.node : selectedNode;
  const [graphMode, setGraphMode] = useState<GraphMode>('neighborhood');
  const [graphRadius, setGraphRadius] = useState<1 | 2>(1);
  const [graphConnections, setGraphConnections] = useState<GraphConnection[]>([]);
  const [projectGraphProjectId, setProjectGraphProjectId] = useState<string | null>(null);
  const [projectGraph, setProjectGraph] = useState<ProjectGraphPayload | null>(null);
  const [projectGraphSources, setProjectGraphSources] = useState({
    canonical: true,
    inferred: true,
  });
  const [projectGraphRelationTypes, setProjectGraphRelationTypes] = useState<RelationType[]>([]);
  const [projectGraphTimelineIndex, setProjectGraphTimelineIndex] = useState(0);
  const [isProjectGraphPlaying, setIsProjectGraphPlaying] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [isGraphLoading, setIsGraphLoading] = useState(false);
  const [isRefreshingSummary, setIsRefreshingSummary] = useState(false);
  useEffect(() => {
    if (!projectNodes.length) {
      setProjectGraphProjectId(null);
      return;
    }

    if (selectedNode?.type === 'project') {
      setProjectGraphProjectId(selectedNode.id);
      return;
    }

    if (!projectGraphProjectId || !projectNodes.some((node) => node.id === projectGraphProjectId)) {
      const defaultProjectId =
        activeProjectId && projectNodes.some((node) => node.id === activeProjectId)
          ? activeProjectId
          : projectNodes[0]?.id ?? null;
      setProjectGraphProjectId(defaultProjectId);
    }
  }, [activeProjectId, projectGraphProjectId, projectNodes, selectedNode]);

  useEffect(() => {
    let mounted = true;
    const currentNode = selectedNode;
    if (view !== 'graph' || !currentNode || !selectedNodeKey) return undefined;
    const nodeId = selectedNodeKey;
    setDetail({
      ...emptyDetailPanel(),
      node: currentNode,
    });

    async function loadDetail() {
      try {
        const [nodeDetail, bundleItems] = await Promise.all([
          getNodeDetail(nodeId),
          profileHotPath('compactContext.graphDetailPreview', () => getContextBundlePreview(nodeId)),
        ]);

        if (!mounted) return;
        const resolvedDetail: NodeDetail =
          nodeDetail ?? {
            ...emptyDetailPanel(),
            node: currentNode,
          };
        setDetail({
          node: resolvedDetail.node?.id === nodeId ? resolvedDetail.node : currentNode,
          related: resolvedDetail.related,
          bundleItems,
          activities: resolvedDetail.activities,
          artifacts: resolvedDetail.artifacts,
          governance: resolvedDetail.governance,
        });
        setLoadError(null);
      } catch (error) {
        if (!mounted) return;
        if (isNotFoundError(error)) {
          setDetail({
            ...emptyDetailPanel(),
            node: currentNode,
          });
          setLoadError(null);
          return;
        }
        handleRequestFailure(error, 'Failed to load node detail.');
      }
    }

    void loadDetail();

    return () => {
      mounted = false;
    };
  }, [selectedNodeKey]);

  useEffect(() => {
    let mounted = true;
    const currentNode = selectedNode;
    if (view !== 'graph' || graphMode !== 'neighborhood' || !currentNode || !selectedNodeKey) return undefined;
    const nodeId = selectedNodeKey;

    async function loadGraph() {
      setIsGraphLoading(true);
      try {
        const connections = await getGraphNeighborhood(nodeId, graphRadius);
        if (!mounted) return;
        setGraphConnections(connections);
        setGraphError(null);
      } catch (error) {
        if (!mounted) return;
        setGraphConnections([]);
        setGraphError(error instanceof Error ? error.message : 'Failed to load graph neighborhood.');
      } finally {
        if (mounted) {
          setIsGraphLoading(false);
        }
      }
    }

    void loadGraph();

    return () => {
      mounted = false;
    };
  }, [graphMode, graphRadius, selectedNodeKey, view]);

  useEffect(() => {
    let mounted = true;
    if (view !== 'graph' || graphMode !== 'project-map' || !projectGraphProjectId) return undefined;
    const projectId = projectGraphProjectId;

    async function loadProjectGraph() {
      setIsGraphLoading(true);
      try {
        const nextGraph = await getProjectGraph(projectId);
        if (!mounted) return;
        setProjectGraph(nextGraph);
        const relationTypes = listProjectGraphRelationTypes(nextGraph);
        setProjectGraphRelationTypes((current) => (current.length ? current.filter((item) => relationTypes.includes(item)) : relationTypes));
        setProjectGraphTimelineIndex(Math.max(nextGraph.timeline.length - 1, 0));
        setGraphConnections([]);
        setGraphError(null);
      } catch (error) {
        if (!mounted) return;
        setProjectGraph(null);
        setGraphError(error instanceof Error ? error.message : 'Failed to load project graph.');
      } finally {
        if (mounted) {
          setIsGraphLoading(false);
        }
      }
    }

    void loadProjectGraph();

    return () => {
      mounted = false;
    };
  }, [graphMode, projectGraphProjectId, view]);

  const [governanceIssues, setGovernanceIssues] = useState<GovernanceIssueItem[]>([]);
  const searchableNoteNodes = useMemo(
    () =>
      profileHotPath('notes.searchableNoteNodes', () =>
        (snapshot?.nodes ?? []).slice().sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title),
        ),
      ),
    [snapshot],
  );
  const noteNodes = useMemo(() => {
    if (!deferredQuery.trim()) {
      return searchableNoteNodes;
    }

    return filteredSearchNodes;
  }, [deferredQuery, filteredSearchNodes, searchableNoteNodes]);
  const noteActivityHits = useMemo(
    () => (deferredQuery.trim() ? filteredSearchActivityHits : []),
    [deferredQuery, filteredSearchActivityHits],
  );
  const activeNoteNode = useMemo(
    () => noteNodes.find((node) => node.id === selectedNodeId) ?? null,
    [noteNodes, selectedNodeId],
  );
  const notePreviewNode = notePreviewTargetId
    ? detail.node?.id === notePreviewTargetId
      ? detail.node
      : nodeMap.get(notePreviewTargetId) ?? null
    : null;
  const notePreviewSupportsGovernanceActions = isNodeGovernanceCandidate(notePreviewNode, detail.governance.state);
  const detailReviewActions = useMemo(
    () => profileHotPath('governance.detailReviewActions', () => buildReviewActionActivities(detail.activities)),
    [detail.activities],
  );
  const notePreviewReviewActions = useMemo(
    () =>
      profileHotPath('governance.notePreviewReviewActions', () =>
        buildReviewActionActivities(detail.activities, {
          targetNodeId: notePreviewNode?.id ?? null,
        }),
      ),
    [detail.activities, notePreviewNode],
  );
  const pinnedProjectNodes = useMemo(() => {
    return buildPinnedProjectNodes(snapshot?.pinnedProjectIds, nodeMap, projectNodes);
  }, [nodeMap, projectNodes, snapshot?.pinnedProjectIds]);
  const homeRecentNodes = useMemo(() => {
    return profileHotPath('home.homeRecentNodes', () =>
      buildHomeRecentNodes(snapshot?.recentNodeIds, nodeMap, pinnedProjectNodes, searchableNoteNodes),
    );
  }, [nodeMap, pinnedProjectNodes, searchableNoteNodes, snapshot?.recentNodeIds]);
  const paletteRecentNodes = useMemo(() => {
    return profileHotPath('palette.recentNodes', () =>
      buildPaletteRecentNodes(activeProjectNode, pinnedProjectNodes, homeRecentNodes, snapshot?.recentNodeIds, nodeMap),
    );
  }, [activeProjectNode, homeRecentNodes, nodeMap, pinnedProjectNodes, snapshot?.recentNodeIds]);
  const homeSearchNodes = useMemo(
    () => (deferredQuery.trim() ? filteredSearchNodes.slice(0, 5) : []),
    [deferredQuery, filteredSearchNodes],
  );
  const homeSearchActivityHits = useMemo(
    () => (deferredQuery.trim() ? filteredSearchActivityHits.slice(0, 4) : []),
    [deferredQuery, filteredSearchActivityHits],
  );
  const latestGovernanceFeedItem = useMemo(() => findLatestGovernanceFeedItem(governanceFeed), [governanceFeed]);
  const homeGovernanceFeed = useMemo(
    () => profileHotPath('governance.homeFeed', () => buildHomeGovernanceFeed(governanceFeed)),
    [governanceFeed],
  );
  const latestGovernanceIssueFeedItem = useMemo(
    () => findLatestGovernanceIssueFeedItem(governanceFeed, governanceIssues),
    [governanceFeed, governanceIssues],
  );
  const homeSuggestedProjectNode = useMemo(
    () => buildHomeSuggestedProjectNode(activeProjectNode, pinnedProjectNodes, projectNodes),
    [activeProjectNode, pinnedProjectNodes, projectNodes],
  );

  useEffect(() => {
    if (!notePreviewNode) {
      setIsEditingNote(false);
      setNoteEditTitle('');
      setNoteEditBody('');
      setNoteEditError(null);
      return;
    }

    setNoteEditTitle(notePreviewNode.title);
    setNoteEditBody(notePreviewNode.body);
    setNoteEditError(null);
  }, [notePreviewNode]);

  useEffect(() => {
    setGovernanceDecisionNote('');
    setGovernanceActionError(null);
  }, [notePreviewTargetId, selectedGovernanceId, view]);

  useEffect(() => {
    let mounted = true;
    const nodeId = notePreviewTargetId;
    const currentNode = nodeId ? nodeMap.get(nodeId) ?? null : null;
    if (view !== 'recent' || !nodeId || !currentNode) return undefined;
    const targetNodeId = nodeId;
    setDetail({
      ...emptyDetailPanel(),
      node: currentNode,
    });

    async function loadRecentNoteDetail() {
      try {
        const [nodeDetail, bundleItems] = await Promise.all([
          getNodeDetail(targetNodeId),
          profileHotPath('compactContext.recentNotePreview', () => getContextBundlePreview(targetNodeId)),
        ]);

        if (!mounted) return;
        const resolvedDetail: NodeDetail =
          nodeDetail ?? {
            ...emptyDetailPanel(),
            node: currentNode,
          };
        setDetail({
          node: resolvedDetail.node?.id === targetNodeId ? resolvedDetail.node : currentNode,
          related: resolvedDetail.related,
          bundleItems,
          activities: resolvedDetail.activities,
          artifacts: resolvedDetail.artifacts,
          governance: resolvedDetail.governance,
        });
        setLoadError(null);
      } catch (error) {
        if (!mounted) return;
        if (isNotFoundError(error)) {
          setDetail({
            ...emptyDetailPanel(),
            node: currentNode,
          });
          setLoadError(null);
          return;
        }
        handleRequestFailure(error, 'Failed to load note detail.');
      }
    }

    void loadRecentNoteDetail();

    return () => {
      mounted = false;
    };
  }, [nodeMap, notePreviewTargetId, view]);

  useEffect(() => {
    if (view !== 'governance' && view !== 'home') return;

    let mounted = true;

    async function loadLists() {
      try {
        const issues = await loadGovernanceIssues();
        if (!mounted) return;
        setGovernanceIssues(issues);
        setLoadError(null);
      } catch (error) {
        if (!mounted) return;
        handleRequestFailure(error, 'Failed to refresh workspace lists.');
      }
    }

    void loadLists();

    return () => {
      mounted = false;
    };
  }, [view]);

  useEffect(() => {
    if (view !== 'governance' && view !== 'home') {
      setIsGovernanceFeedLoading(false);
      return;
    }

    let mounted = true;
    setIsGovernanceFeedLoading(true);

    async function loadFeed() {
      try {
        const items = await loadGovernanceFeed();
        if (!mounted) return;
        setGovernanceFeed(items);
        setLoadError(null);
      } catch (error) {
        if (!mounted) return;
        handleRequestFailure(error, 'Failed to load governance decision feed.');
      } finally {
        if (mounted) {
          setIsGovernanceFeedLoading(false);
        }
      }
    }

    void loadFeed();

    return () => {
      mounted = false;
    };
  }, [governanceFeedActionFilter, governanceFeedEntityFilter, view]);

  useEffect(() => {
    if (isLoading || authRequired || view !== 'home' || deferredQuery.trim()) {
      setIsSemanticStatusLoading(false);
      setIsSemanticIssuesLoading(false);
      setIsSemanticIssuesLoadingMore(false);
      return;
    }

    let mounted = true;
    setIsSemanticStatusLoading(true);
    setIsSemanticIssuesLoading(true);

    async function loadSemanticCard() {
      try {
        const { status, issuesPage } = await loadSemanticOverview(semanticIssueFilter);
        if (!mounted) return;
        setSemanticStatus(status);
        setSemanticIssues(issuesPage.items);
        setSemanticIssuesCursor(issuesPage.nextCursor);
        setSemanticError(null);
      } catch (error) {
        if (!mounted) return;
        handleRequestFailure(error, 'Failed to load semantic status.');
        setSemanticError(error instanceof Error ? error.message : 'Failed to load semantic status.');
      } finally {
        if (mounted) {
          setIsSemanticStatusLoading(false);
          setIsSemanticIssuesLoading(false);
        }
      }
    }

    void loadSemanticCard();

    return () => {
      mounted = false;
    };
  }, [authRequired, deferredQuery, isLoading, semanticIssueFilter, view]);

  useEffect(() => {
    writeStoredChoice(GOVERNANCE_FEED_ENTITY_FILTER_STORAGE_KEY, governanceFeedEntityFilter);
  }, [governanceFeedEntityFilter]);

  useEffect(() => {
    writeStoredChoice(GOVERNANCE_FEED_ACTION_FILTER_STORAGE_KEY, governanceFeedActionFilter);
  }, [governanceFeedActionFilter]);

  useEffect(() => {
    if (!governanceIssues.length) {
      if (selectedGovernanceId !== null) {
        setSelectedGovernanceId(null);
      }
      return;
    }
    if (!selectedGovernanceId || !governanceIssues.some((item) => item.entityId === selectedGovernanceId)) {
      setSelectedGovernanceId(governanceIssues[0]?.entityId ?? null);
    }
  }, [governanceIssues, selectedGovernanceId]);

  const activeGovernanceIssue =
    governanceIssues.find((item) => item.entityId === selectedGovernanceId) ?? governanceIssues[0];

  useEffect(() => {
    if (view !== 'governance' || !activeGovernanceIssue) {
      setGovernanceDetail(emptyGovernanceDetailPanel());
      setIsGovernanceDetailLoading(false);
      return;
    }

    let mounted = true;
    setIsGovernanceDetailLoading(true);

    async function loadGovernanceDetail() {
      try {
        if (activeGovernanceIssue.entityType === 'node') {
          const nodeDetail = await getNodeDetail(activeGovernanceIssue.entityId);
          if (!mounted) return;
          setGovernanceDetail({
            node: nodeDetail?.node ?? null,
            relation: null,
            fromNode: null,
            toNode: null,
            governance: nodeDetail?.governance ?? emptyGovernanceDetailPanel().governance,
          });
        } else {
          const relationDetail = await getRelationDetail(activeGovernanceIssue.entityId);
          if (!mounted) return;
          setGovernanceDetail({
            node: null,
            relation: relationDetail?.relation ?? null,
            fromNode: relationDetail?.fromNode ?? null,
            toNode: relationDetail?.toNode ?? null,
            governance: relationDetail?.governance ?? emptyGovernanceDetailPanel().governance,
          });
        }
        setLoadError(null);
      } catch (error) {
        if (!mounted) return;
        if (isNotFoundError(error)) {
          setGovernanceDetail(emptyGovernanceDetailPanel());
          setLoadError(null);
          return;
        }
        handleRequestFailure(error, 'Failed to load governance detail.');
      } finally {
        if (mounted) {
          setIsGovernanceDetailLoading(false);
        }
      }
    }

    void loadGovernanceDetail();

    return () => {
      mounted = false;
    };
  }, [activeGovernanceIssue, view]);

  const workspaceName = workspace?.name ?? 'RecallX';
  const apiBase = formatApiBase(workspace?.apiBind ?? '127.0.0.1:8787');
  const workspaceRoot = workspace?.rootPath ?? '';
  const workspaceDbPath = workspace?.paths?.dbPath ?? (workspaceRoot ? `${workspaceRoot}/workspace.db` : '');
  const artifactsPath = workspace?.paths?.artifactsDir ?? (workspaceRoot ? `${workspaceRoot}/artifacts` : '');
  const exportsPath = workspace?.paths?.exportsDir ?? (workspaceRoot ? `${workspaceRoot}/exports` : '');
  const importsPath = workspace?.paths?.importsDir ?? (workspaceRoot ? `${workspaceRoot}/imports` : '');
  const backupsPath = workspace?.paths?.backupsDir ?? (workspaceRoot ? `${workspaceRoot}/backups` : '');
  const workspaceSafetyWarnings = workspace?.safety?.warnings ?? [];
  const hasRecentOtherMachineWarning = workspaceSafetyWarnings.some((warning) => warning.code === 'recent_other_machine');
  const hasUncleanShutdownWarning = workspaceSafetyWarnings.some((warning) => warning.code === 'unclean_shutdown');
  const safeHandoffSteps = [
    'Close RecallX on the current machine before opening the same workspace somewhere else.',
    'Wait for Dropbox, Drive, or iCloud sync to finish before switching devices.',
    hasRecentOtherMachineWarning
      ? 'This workspace was opened recently on another machine, so treat the next open as read carefully and avoid concurrent writes.'
      : 'Open the workspace on the next machine only after the previous session finished and sync is complete.',
    hasUncleanShutdownWarning
      ? 'Create a snapshot before heavier edits because the previous session may not have closed cleanly.'
      : 'Create a manual snapshot if anything about the handoff felt uncertain.',
  ];
  const defaultMcpCommand = `node dist/server/app/mcp/index.js --api ${apiBase}`;
  const mcpCommand = defaultMcpCommand;
  const genericMcpConfig = `{
  "mcpServers": {
    "recallx": {
      "command": "node",
      "args": ["dist/server/app/mcp/index.js", "--api", "${apiBase}"]
    }
  }
}`;
  const apiAuthHeader = workspace?.authMode === 'bearer' ? ' -H "Authorization: Bearer $RECALLX_API_TOKEN"' : '';
  const apiExample = `curl${apiAuthHeader} ${apiBase}
curl${apiAuthHeader} ${apiBase}/health
curl${apiAuthHeader} ${apiBase}/workspace`;

  useEffect(() => {
    if (isLoading || authRequired || !workspaceRoot) {
      return;
    }

    let mounted = true;

    async function loadActiveProjectSetting() {
      try {
        const values = await getSettings([ACTIVE_PROJECT_SETTING_KEY]);
        if (!mounted) return;
        const nextActiveProjectId =
          typeof values[ACTIVE_PROJECT_SETTING_KEY] === 'string' ? String(values[ACTIVE_PROJECT_SETTING_KEY]) : null;
        setActiveProjectId(nextActiveProjectId);
        setActiveProjectError(null);
      } catch (error) {
        if (!mounted) return;
        handleRequestFailure(error, 'Failed to load workspace settings.');
      }
    }

    void loadActiveProjectSetting();

    return () => {
      mounted = false;
    };
  }, [authRequired, isLoading, workspaceRoot]);

  useEffect(() => {
    if (!activeProjectId) {
      return;
    }

    if (!projectNodes.some((node) => node.id === activeProjectId)) {
      setActiveProjectId(null);
      setActiveProjectDigest(EMPTY_ACTIVE_PROJECT_DIGEST);
    }
  }, [activeProjectId, projectNodes]);

  useEffect(() => {
    if (!activeProjectId || !projectNodes.some((node) => node.id === activeProjectId)) {
      setCaptureProjectId((current) => {
        if (current && current === captureProjectAutofillRef.current) {
          captureProjectAutofillRef.current = null;
          return '';
        }
        captureProjectAutofillRef.current = null;
        return current;
      });
      return;
    }

    setCaptureProjectId((current) => {
      const lastAutofill = captureProjectAutofillRef.current;
      if (!current || current === lastAutofill) {
        captureProjectAutofillRef.current = activeProjectId;
        return activeProjectId;
      }
      return current;
    });
  }, [activeProjectId, projectNodes]);

  useEffect(() => {
    const currentActiveProject = activeProjectNode;
    if (!currentActiveProject) {
      setActiveProjectDigest(EMPTY_ACTIVE_PROJECT_DIGEST);
      setIsActiveProjectDigestLoading(false);
      return;
    }
    const currentActiveProjectId = currentActiveProject.id;

    let mounted = true;
    setIsActiveProjectDigestLoading(true);

    async function loadActiveProjectDigest() {
      try {
        const [nodeDetail, bundleItems] = await Promise.all([
          getNodeDetail(currentActiveProjectId),
          profileHotPath('compactContext.activeProjectDigest', () => getContextBundlePreview(currentActiveProjectId)),
        ]);
        if (!mounted) return;
        setActiveProjectDigest({
          bundleItems: bundleItems.slice(0, 3),
          activities: (nodeDetail?.activities ?? []).slice(0, 3),
          relatedCount: nodeDetail?.related.length ?? 0,
        });
        setActiveProjectError(null);
      } catch (error) {
        if (!mounted) return;
        setActiveProjectDigest(EMPTY_ACTIVE_PROJECT_DIGEST);
        setActiveProjectError(error instanceof Error ? error.message : 'Failed to load the active project digest.');
      } finally {
        if (mounted) {
          setIsActiveProjectDigestLoading(false);
        }
      }
    }

    void loadActiveProjectDigest();

    return () => {
      mounted = false;
    };
  }, [activeProjectNode]);
  const guideSections: GuideSection[] = [
    {
      id: 'overview',
      group: 'Getting started',
      label: 'Overview',
      eyebrow: 'Unified guide',
      title: 'One page for human access and agent access.',
      body: 'This guide merges the loopback API and MCP setup into one quiet reference. The left menu should feel like a documentation tree: start broad, then drill into one detail page at a time.',
      points: [
        'Use HTTP when a person or script wants direct loopback access.',
        'Use MCP when an agent client needs tool-shaped access and guided workflow.',
        'Keep the surface text-first and operational, not dashboard-like.',
      ],
    },
    {
      id: 'base-url',
      group: 'HTTP API',
      label: 'Base URL',
      eyebrow: 'Loopback entry',
      title: 'Start with the current loopback endpoint.',
      body: 'Everything else in the local API hangs off one base URL. Keep auth rules explicit, but do not bury the main path under decorative UI.',
      points: [
        `Base URL: ${apiBase}`,
        workspace?.authMode === 'bearer' ? 'Auth mode: bearer header required for protected requests.' : 'Auth mode: local optional access for loopback requests.',
        'Use this first for health, workspace, bootstrap, and direct endpoint inspection.',
      ],
    },
    {
      id: 'routes',
      group: 'HTTP API',
      label: 'Starter routes',
      eyebrow: 'Small surface first',
      title: 'Keep the first three routes in easy reach.',
      body: 'Most sessions only need a tiny route set. Show those clearly before any deeper reference material.',
      points: [
        '/health for service status and active workspace state.',
        '/workspace for current workspace metadata and local scope details.',
        '/bootstrap for client startup and service capability discovery.',
      ],
    },
    {
      id: 'http-examples',
      group: 'HTTP API',
      label: 'Example requests',
      eyebrow: 'Quick start',
      title: 'Copy a request, verify locally, then move on.',
      body: 'The examples should stay short and immediately runnable. This page is a launchpad, not a full API encyclopedia.',
      points: [
        'Use curl for the fastest first verification loop.',
        'Add the bearer header only when this workspace requires it.',
        'After the first successful request, move into the route or workflow you actually need.',
      ],
      code: apiExample,
    },
    {
      id: 'mcp-connect',
      group: 'MCP',
      label: 'Connection',
      eyebrow: 'Agent route',
      title: 'Use MCP when the client is an agent, not a person making raw requests.',
      body: 'Show the launcher configuration and the direct command together, but keep the page visually quiet. The important part is the connection shape, not extra chrome.',
      points: [
        'Use the launcher config when wiring RecallX into an MCP-capable agent client.',
        'Use the direct local command when testing the server manually.',
        'Keep the API target pointed at the current workspace service.',
      ],
      code: `${genericMcpConfig}\n\n${mcpCommand}`,
    },
    {
      id: 'mcp-search-flow',
      group: 'MCP',
      label: 'Search flow',
      eyebrow: 'Recommended flow',
      title: 'Search first, then decide whether to anchor.',
      body: 'The guide should make the order obvious so agent clients do not jump into over-specific context too early.',
      points: [
        '1. Start broad with recallx_search_workspace when the target is still unclear.',
        '2. Use recallx_search_nodes when checking for an existing project or durable node.',
        '3. Use recallx_context_bundle only after the target is actually known.',
      ],
    },
    {
      id: 'mcp-write-flow',
      group: 'MCP',
      label: 'Write path',
      eyebrow: 'Capture rules',
      title: 'Write lightly unless the target is already clear.',
      body: 'This is the part that prevents over-structuring. Treat durable memory, activity logs, and anchored bundles as separate decisions.',
      points: [
        'recallx_capture_memory is the safe default only before a project or node is known.',
        'Once a project is known, stop using untargeted capture for routine logs and append activity to that project instead.',
        'recallx_append_activity is best for routine summaries and work logs after the target is known.',
        'recallx_context_bundle should include targetId only after the project or node is truly known.',
      ],
    },
    {
      id: 'workspace-paths',
      group: 'Workspace',
      label: 'Workspace paths',
      eyebrow: 'Local files',
      title: 'Know where the current workspace lives on disk.',
      body: 'Keep the local paths visible for debugging, inspection, and operational work. This should read like a simple system note, not an admin panel.',
      points: [
        `Workspace root: ${workspaceRoot || 'Unavailable'}`,
        `Database: ${workspaceDbPath || 'Unavailable'}`,
        `Artifacts: ${artifactsPath || 'Unavailable'}`,
      ],
    },
  ];
  const activeGuideSection =
    guideSections.find((section) => section.id === guideSectionId) ?? guideSections[0]!;
  const guideGroups = Array.from(new Set(guideSections.map((section) => section.group))).map((group) => ({
    group,
    sections: guideSections.filter((section) => section.group === group),
  }));
  const graphSummary = useMemo(() => {
    const distinctNodes = new Map<string, Node>();
    const relationCounts: Record<string, number> = {};
    let incomingCount = 0;
    let outgoingCount = 0;
    let suggestedCount = 0;

    for (const item of graphConnections) {
      distinctNodes.set(item.node.id, item.node);
      relationCounts[item.relation.relationType] = (relationCounts[item.relation.relationType] ?? 0) + 1;
      if (item.direction === 'incoming') {
        incomingCount += 1;
      } else {
        outgoingCount += 1;
      }
      if (item.relation.status === 'suggested') {
        suggestedCount += 1;
      }
    }

    return {
      distinctNodes: Array.from(distinctNodes.values()),
      relationCounts,
      incomingCount,
      outgoingCount,
      suggestedCount,
    };
  }, [graphConnections]);
  const graphRelationGroups = useMemo(
    () =>
      Object.entries(graphSummary.relationCounts)
        .map(([relationType, count]) => ({
          relationType,
          count,
        }))
        .sort((left, right) => right.count - left.count || left.relationType.localeCompare(right.relationType)),
    [graphSummary.relationCounts],
  );
  const projectGraphAvailableRelationTypes = useMemo(
    () => listProjectGraphRelationTypes(projectGraph),
    [projectGraph],
  );
  const effectiveProjectGraphRelationTypes = projectGraphRelationTypes.length
    ? projectGraphRelationTypes
    : projectGraphAvailableRelationTypes;
  const filteredProjectGraphView = useMemo(
    () =>
      filterProjectGraphView(projectGraph, {
        relationTypes: effectiveProjectGraphRelationTypes,
        sources: projectGraphSources,
      }),
    [effectiveProjectGraphRelationTypes, projectGraph, projectGraphSources],
  );
  const projectGraphEmphasis = useMemo(
    () => buildProjectGraphEmphasis(projectGraph, filteredProjectGraphView, projectGraphTimelineIndex),
    [filteredProjectGraphView, projectGraph, projectGraphTimelineIndex],
  );
  const projectGraphView = useMemo(
    () => ({
      ...filteredProjectGraphView,
      ...projectGraphEmphasis,
    }),
    [filteredProjectGraphView, projectGraphEmphasis],
  );
  const projectGraphCanvasGraph = useMemo(
    () =>
      projectGraph
        ? {
            ...projectGraph,
            nodes: filteredProjectGraphView.nodes,
            edges: filteredProjectGraphView.edges,
          }
        : null,
    [filteredProjectGraphView.edges, filteredProjectGraphView.nodes, projectGraph],
  );
  const projectGraphRelationGroups = useMemo(
    () =>
      Object.entries(
        projectGraphView.edges.reduce<Record<string, number>>((acc, edge) => {
          acc[edge.relationType] = (acc[edge.relationType] ?? 0) + 1;
          return acc;
        }, {}),
      )
        .map(([relationType, count]) => ({
          relationType,
          count,
        }))
        .sort((left, right) => right.count - left.count || left.relationType.localeCompare(right.relationType)),
    [projectGraphView.edges],
  );
  const activeProjectGraphProject =
    (projectGraphProjectId ? nodeMap.get(projectGraphProjectId) : undefined) ?? projectNodes.find((node) => node.id === projectGraphProjectId) ?? null;
  const currentProjectGraphEvent = projectGraph?.timeline[projectGraphTimelineIndex] ?? null;

  useEffect(() => {
    if (!isProjectGraphPlaying || !projectGraph?.timeline.length) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setProjectGraphTimelineIndex((current) => {
        if (current >= projectGraph.timeline.length - 1) {
          setIsProjectGraphPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 900);

    return () => {
      window.clearInterval(timer);
    };
  }, [isProjectGraphPlaying, projectGraph]);

  useEffect(() => {
    if (graphMode !== 'project-map') {
      setIsProjectGraphPlaying(false);
    }
  }, [graphMode]);
  const governanceStateCounts = useMemo(
    () =>
      governanceIssues.reduce<Record<string, number>>((acc, item) => {
        acc[item.state] = (acc[item.state] ?? 0) + 1;
        return acc;
      }, {}),
    [governanceIssues],
  );
  const semanticCountCards = useMemo(
    () => [
      { key: 'pending', label: 'Pending', value: semanticStatus?.counts.pending ?? 0 },
      { key: 'processing', label: 'Processing', value: semanticStatus?.counts.processing ?? 0 },
      { key: 'stale', label: 'Stale', value: semanticStatus?.counts.stale ?? 0 },
      { key: 'ready', label: 'Ready', value: semanticStatus?.counts.ready ?? 0 },
      { key: 'failed', label: 'Failed', value: semanticStatus?.counts.failed ?? 0 },
    ],
    [semanticStatus],
  );
  const activeGovernanceNode =
    activeGovernanceIssue?.entityType === 'node'
      ? governanceDetail.node ?? nodeMap.get(activeGovernanceIssue.entityId) ?? null
      : null;
  const activeGovernanceRelation = activeGovernanceIssue?.entityType === 'relation' ? governanceDetail.relation : null;
  const activeGovernanceNodeCanPromote = canPromoteNode(activeGovernanceNode);
  const activeGovernanceNodeCanContest = canContestNode(activeGovernanceNode);
  const activeGovernanceNodeCanArchive = canArchiveNode(activeGovernanceNode);
  const activeGovernanceRelationCanAccept = canAcceptRelation(activeGovernanceRelation);
  const activeGovernanceRelationCanReject = canRejectRelation(activeGovernanceRelation);
  const activeGovernanceRelationCanArchive = canArchiveRelation(activeGovernanceRelation);

  function resetWorkspaceSelection(nextSnapshot: WorkspaceSeed) {
    const nextProjectNodes = nextSnapshot.nodes.filter((node) => node.type === 'project');
    const nextProjectGraphProjectId =
      activeProjectId && nextProjectNodes.some((node) => node.id === activeProjectId)
        ? activeProjectId
        : nextProjectNodes[0]?.id ?? null;
    setSelectedNodeId(nextSnapshot.nodes[0]?.id ?? '');
    setNotePreviewTargetId(null);
    setDetail(emptyDetailPanel());
    setProjectGraph(null);
    setProjectGraphProjectId(nextProjectGraphProjectId);
  }

  function focusNode(nodeId: string, nextView?: NavView) {
    setSelectedNodeId(nodeId);
    if (nextView) {
      selectView(nextView);
    }
  }

  function openNodeInNotes(nodeId: string) {
    focusNode(nodeId, 'recent');
    setNotePreviewTargetId(nodeId);
  }

  function inspectGovernanceFeedItem(item: GovernanceFeedItem) {
    if (item.entityType === 'node' && item.nodeId) {
      openNodeInNotes(item.nodeId);
      return;
    }

    if (item.fromNodeId) {
      openNodeInNotes(item.fromNodeId);
    }
  }

  function openGovernanceFeedGraph(item: GovernanceFeedItem) {
    if (item.entityType === 'node' && item.nodeId) {
      focusNode(item.nodeId, 'graph');
      return;
    }

    if (item.toNodeId) {
      focusNode(item.toNodeId, 'graph');
      return;
    }

    if (item.fromNodeId) {
      focusNode(item.fromNodeId, 'graph');
    }
  }

  function handleSelectProjectGraphProject(nodeId: string) {
    setProjectGraphProjectId(nodeId);
    focusNode(nodeId, 'graph');
  }

  function handleSelectProjectGraphNode(nodeId: string) {
    focusNode(nodeId, 'graph');
  }

  function toggleProjectGraphRelationType(relationType: RelationType) {
    setProjectGraphRelationTypes((current) => {
      if (!current.length) {
        return projectGraphAvailableRelationTypes.filter((item) => item !== relationType);
      }

      if (current.includes(relationType)) {
        return current.length === 1 ? current : current.filter((item) => item !== relationType);
      }

      return [...current, relationType].sort((left, right) => left.localeCompare(right));
    });
  }

  async function handleLoadMoreSemanticIssues() {
    if (!semanticIssuesCursor) {
      return;
    }

    setIsSemanticIssuesLoadingMore(true);
    try {
      const issuesPage = await getSemanticIssues({
        limit: 5,
        cursor: semanticIssuesCursor,
        statuses: buildSemanticIssueStatuses(semanticIssueFilter),
      });
      setSemanticIssues((current) => mergeSemanticIssuePages(current, issuesPage.items));
      setSemanticIssuesCursor(issuesPage.nextCursor);
      setSemanticError(null);
    } catch (error) {
      handleRequestFailure(error, 'Failed to load more semantic issues.');
      setSemanticError(error instanceof Error ? error.message : 'Failed to load more semantic issues.');
    } finally {
      setIsSemanticIssuesLoadingMore(false);
    }
  }

  async function handleSemanticReindex() {
    setSemanticNotice(null);
    setSemanticError(null);
    setIsSemanticReindexing(true);
    try {
      const result = await queueSemanticReindex();
      const { status, issuesPage } = await loadSemanticOverview(semanticIssueFilter);
      setSemanticStatus(status);
      setSemanticIssues(issuesPage.items);
      setSemanticIssuesCursor(issuesPage.nextCursor);
      setSemanticNotice(result.queuedCount ? `Queued ${result.queuedCount} nodes for semantic rebuild.` : 'No semantic rebuild work was queued.');
    } catch (error) {
      handleRequestFailure(error, 'Failed to queue semantic reindex.');
      setSemanticError(error instanceof Error ? error.message : 'Failed to queue semantic reindex.');
    } finally {
      setIsSemanticReindexing(false);
    }
  }

  async function handleBundlePreviewClick(item: ContextBundlePreviewItem) {
    const targetNodeId = detailNode?.id;
    focusNode(item.nodeId);
    if (!targetNodeId || !item.relationId || !item.relationSource) {
      return;
    }

    const eventKey = `${targetNodeId}:${item.relationId}:bundle_clicked`;
    if (bundleUsageEventKeysRef.current.has(eventKey)) {
      return;
    }

    bundleUsageEventKeysRef.current.add(eventKey);
    try {
      await appendRelationUsageEvent({
        relationId: item.relationId,
        relationSource: item.relationSource,
        eventType: 'bundle_clicked',
        sessionId: relationUsageSessionIdRef.current,
        delta: 0.4,
        metadata: {
          targetNodeId,
          surfacedVia: 'context_bundle_preview',
          selectedNodeId: item.nodeId,
        },
      });
    } catch {
      bundleUsageEventKeysRef.current.delete(eventKey);
    }
  }

  async function handleActiveProjectBundleClick(item: ContextBundlePreviewItem) {
    if (!activeProjectNode) {
      return;
    }

    focusNode(item.nodeId, 'recent');
    setNotePreviewTargetId(item.nodeId);
    if (!item.relationId || !item.relationSource) {
      return;
    }

    const eventKey = `${activeProjectNode.id}:${item.relationId}:home_bundle_clicked`;
    if (activeProjectBundleUsageEventKeysRef.current.has(eventKey)) {
      return;
    }

    activeProjectBundleUsageEventKeysRef.current.add(eventKey);
    try {
      await appendRelationUsageEvent({
        relationId: item.relationId,
        relationSource: item.relationSource,
        eventType: 'bundle_clicked',
        sessionId: relationUsageSessionIdRef.current,
        delta: 0.4,
        metadata: {
          targetNodeId: activeProjectNode.id,
          surfacedVia: 'home_active_project_digest',
          selectedNodeId: item.nodeId,
        },
      });
    } catch {
      activeProjectBundleUsageEventKeysRef.current.delete(eventKey);
    }
  }

  async function handleSetActiveProject(nextProjectId: string | null) {
    const previousActiveProjectId = activeProjectId;
    setActiveProjectId(nextProjectId);
    setActiveProjectError(null);
    setIsSavingActiveProject(true);

    try {
      await updateSettings({
        [ACTIVE_PROJECT_SETTING_KEY]: nextProjectId,
      });
      setLoadError(null);
    } catch (error) {
      setActiveProjectId(previousActiveProjectId);
      if (isAuthError(error)) {
        handleRequestFailure(error, 'Failed to update workspace settings.');
      } else {
        setActiveProjectError(error instanceof Error ? error.message : 'Failed to update the active project.');
      }
    } finally {
      setIsSavingActiveProject(false);
    }
  }

  function handleCaptureProjectSelection(nextProjectId: string) {
    setCaptureProjectId(nextProjectId);
    captureProjectAutofillRef.current = nextProjectId && nextProjectId === activeProjectId ? nextProjectId : null;
  }

  async function handleCreateNode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!captureTitle.trim()) {
      setCaptureError('Title is required.');
      return;
    }

    setCaptureError(null);
    setCaptureNotice(null);
    setIsSavingCapture(true);

    try {
      const result = await createNode({
        type: captureType,
        title: captureTitle.trim(),
        body: captureBody.trim(),
        projectId: captureProjectId || undefined,
      });
      const node = result.node;
      await refreshSnapshotState();
      focusNode(node.id);
      setNotePreviewTargetId(null);
      setView('recent');
      setCaptureTitle('');
      setCaptureBody('');
      setCaptureType('note');
      setCaptureProjectId(activeProjectId ?? '');
      captureProjectAutofillRef.current = activeProjectId ?? null;
      const captureProject = captureProjectId ? projectNodes.find((project) => project.id === captureProjectId) ?? null : null;
      setCaptureNotice(
        result.landing
          ? `Saved as ${result.landing.canonicality ? `${result.landing.canonicality} ` : ''}${result.landing.status}.${captureProject ? ` Linked to ${captureProject.title}.` : ''} ${result.landing.reason}`
          : 'Node saved.'
      );
      setLoadError(null);
    } catch (error) {
      if (isAuthError(error)) {
        clearRendererToken();
        setAuthRequired(true);
        setAuthError('Enter the RecallX API token to continue.');
        setCaptureError(null);
        setCaptureNotice(null);
      } else {
        setCaptureError(error instanceof Error ? error.message : 'Failed to create node.');
        setCaptureNotice(null);
      }
    } finally {
      setIsSavingCapture(false);
    }
  }

  async function handleRefreshSummary() {
    if (!detailNode) {
      return;
    }

    setIsRefreshingSummary(true);
    try {
      const refreshedNode = await refreshNodeSummaryRequest(detailNode.id);
      setDetail((current) => ({
        ...current,
        node: refreshedNode,
      }));
      await refreshSnapshotState();
      setLoadError(null);
    } catch (error) {
      handleRequestFailure(error, 'Failed to refresh summary.');
    } finally {
      setIsRefreshingSummary(false);
    }
  }

  async function handleSaveNoteEdit() {
    if (!notePreviewNode) {
      return;
    }

    if (!noteEditTitle.trim()) {
      setNoteEditError('Title is required.');
      return;
    }

    setNoteEditError(null);
    setIsSavingNoteEdit(true);
    try {
      const updatedNode = await updateNodeRequest({
        id: notePreviewNode.id,
        title: noteEditTitle.trim(),
        body: noteEditBody,
      });
      setDetail((current) => ({
        ...current,
        node: updatedNode,
      }));
      await refreshSnapshotState();
      setCaptureNotice('Saved note changes.');
      setIsEditingNote(false);
      setLoadError(null);
    } catch (error) {
      handleRequestFailure(error, 'Failed to save note changes.');
      setNoteEditError(error instanceof Error ? error.message : 'Failed to save note changes.');
    } finally {
      setIsSavingNoteEdit(false);
    }
  }

  async function handleArchiveNote() {
    if (!notePreviewNode) {
      return;
    }

    setNoteEditError(null);
    setIsArchivingNote(true);
    try {
      await archiveNodeRequest(notePreviewNode.id);
      await refreshSnapshotState();
      setCaptureNotice(`Archived ${notePreviewNode.title}.`);
      setNotePreviewTargetId(null);
      setIsEditingNote(false);
      setLoadError(null);
    } catch (error) {
      handleRequestFailure(error, 'Failed to archive node.');
      setNoteEditError(error instanceof Error ? error.message : 'Failed to archive node.');
    } finally {
      setIsArchivingNote(false);
    }
  }

  async function handleApplyNodeGovernanceAction(action: NodeGovernanceAction, node: Node) {
    setGovernanceActionError(null);
    setGovernanceActionPending(action);
    try {
      const result = await applyNodeGovernanceActionRequest({
        id: node.id,
        action,
        note: governanceDecisionNote,
      });
      setDetail((current) =>
        current.node?.id === node.id
          ? {
              ...current,
              node: result.node,
              governance: result.governance,
              activities: result.activity ? [result.activity, ...current.activities] : current.activities,
            }
          : current
      );
      setGovernanceDetail((current) =>
        current.node?.id === node.id
          ? {
              ...current,
              node: result.node,
              governance: result.governance,
            }
          : current
      );
      await refreshSnapshotState();
      setGovernanceIssues(await loadGovernanceIssues());
      setGovernanceFeed(await loadGovernanceFeed());
      setCaptureNotice(
        action === 'promote'
          ? `Promoted ${result.node.title} to canonical.`
          : action === 'contest'
            ? `Marked ${result.node.title} contested.`
            : `Archived ${result.node.title} from governance.`
      );
      setGovernanceDecisionNote('');
      setLoadError(null);
      if (action === 'archive' && notePreviewTargetId === node.id) {
        setNotePreviewTargetId(null);
        setIsEditingNote(false);
        setNoteEditError(null);
      }
    } catch (error) {
      handleRequestFailure(error, 'Failed to apply governance action.');
      setGovernanceActionError(error instanceof Error ? error.message : 'Failed to apply governance action.');
    } finally {
      setGovernanceActionPending(null);
    }
  }

  async function handleApplyRelationGovernanceAction(action: RelationGovernanceAction, relation: Relation) {
    setGovernanceActionError(null);
    setRelationGovernanceActionPending(action);
    try {
      const result = await applyRelationGovernanceActionRequest({
        id: relation.id,
        action,
        note: governanceDecisionNote,
      });
      setGovernanceDetail((current) =>
        current.relation?.id === relation.id
          ? {
              ...current,
              relation: result.relation,
              governance: result.governance,
            }
          : current
      );
      await refreshSnapshotState();
      setGovernanceIssues(await loadGovernanceIssues());
      setGovernanceFeed(await loadGovernanceFeed());
      setCaptureNotice(
        action === 'accept'
          ? `Accepted relation ${result.relation.relationType}.`
          : action === 'reject'
            ? `Rejected relation ${result.relation.relationType}.`
            : `Archived relation ${result.relation.relationType}.`
      );
      setGovernanceDecisionNote('');
      setLoadError(null);
    } catch (error) {
      handleRequestFailure(error, 'Failed to apply relation governance action.');
      setGovernanceActionError(error instanceof Error ? error.message : 'Failed to apply relation governance action.');
    } finally {
      setRelationGovernanceActionPending(null);
    }
  }

  async function handleAuthSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = authTokenInput.trim();
    if (!token) {
      setAuthError('API token is required in bearer mode.');
      return;
    }

    saveRendererToken(token);
    setAuthError(null);
    setIsLoading(true);

    try {
      await refreshWorkspaceState();
      setAuthRequired(false);
      setAuthTokenInput('');
      setLoadError(null);
    } catch (error) {
      clearRendererToken();
      setAuthRequired(true);
      handleRequestFailure(error, 'Failed to authenticate renderer.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCreateWorkspace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rootPath = workspaceRootInput.trim();
    if (!rootPath) {
      setWorkspaceActionError('Workspace root is required.');
      return;
    }

    setWorkspaceActionError(null);
    setIsSwitchingWorkspace(true);
    try {
      const workspaceName = workspaceNameInput.trim();
      const catalog = await createWorkspaceSession({
        rootPath,
        ...(workspaceName ? { workspaceName } : {}),
      });
      const nextSnapshot = await refreshWorkspaceState({
        workspaceOverride: catalog.current,
        catalogOverride: catalog,
      });
      resetWorkspaceSelection(nextSnapshot);
      setWorkspaceNameInput('');
    } catch (error) {
      handleRequestFailure(error, 'Failed to create workspace.');
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to create workspace.');
    } finally {
      setIsSwitchingWorkspace(false);
    }
  }

  async function handleOpenWorkspace(rootPath: string) {
    const trimmedRootPath = rootPath.trim();
    if (!trimmedRootPath) {
      setWorkspaceActionError('Workspace root is required.');
      return;
    }

    setWorkspaceActionError(null);
    setIsSwitchingWorkspace(true);
    try {
      const catalog = await openWorkspaceSession(trimmedRootPath);
      const nextSnapshot = await refreshWorkspaceState({
        workspaceOverride: catalog.current,
        catalogOverride: catalog,
      });
      resetWorkspaceSelection(nextSnapshot);
    } catch (error) {
      handleRequestFailure(error, 'Failed to switch workspace.');
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to switch workspace.');
    } finally {
      setIsSwitchingWorkspace(false);
    }
  }

  async function handleCreateWorkspaceBackup() {
    setWorkspaceBackupNotice(null);
    setWorkspaceActionError(null);
    setIsWorkspaceBackupBusy(true);
    try {
      const backup = await createWorkspaceBackup(backupLabelInput.trim() || undefined);
      const backups = await listWorkspaceBackups();
      setWorkspaceBackups(backups);
      setBackupLabelInput('');
      setWorkspaceBackupNotice(`Created snapshot at ${backup.backupPath}`);
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to create workspace backup.');
    } finally {
      setIsWorkspaceBackupBusy(false);
    }
  }

  async function handleExportWorkspace(format: 'json' | 'markdown') {
    setWorkspaceBackupNotice(null);
    setWorkspaceActionError(null);
    setIsWorkspaceBackupBusy(true);
    try {
      const exportRecord = await exportWorkspaceSnapshot(format);
      setLastWorkspaceExport(exportRecord);
      setWorkspaceBackupNotice(`Exported ${format.toUpperCase()} snapshot to ${exportRecord.exportPath}`);
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to export workspace.');
    } finally {
      setIsWorkspaceBackupBusy(false);
    }
  }

  async function handleRestoreWorkspaceBackup(backupId: string) {
    const targetRootPath = restoreTargetRootInput.trim();
    if (!targetRootPath) {
      setWorkspaceActionError('Restore target root is required.');
      return;
    }

    setWorkspaceBackupNotice(null);
    setWorkspaceActionError(null);
    setIsWorkspaceBackupBusy(true);
    try {
      const restoreResult = await restoreWorkspaceBackup({
        backupId,
        targetRootPath,
        workspaceName: workspaceNameInput.trim() || undefined,
      });
      const nextSnapshot = await refreshWorkspaceState({
        workspaceOverride: restoreResult.catalog.current,
        catalogOverride: restoreResult.catalog,
      });
      resetWorkspaceSelection(nextSnapshot);
      setRestoreTargetRootInput('');
      setWorkspaceBackupNotice(
        restoreResult.autoBackup
          ? `Created safety snapshot ${restoreResult.autoBackup.id} before restoring ${backupId} into ${targetRootPath}.`
          : `Restored backup ${backupId} into ${targetRootPath}.`,
      );
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to restore workspace backup.');
    } finally {
      setIsWorkspaceBackupBusy(false);
    }
  }

  async function handleImportWorkspace() {
    const sourcePath = importSourcePathInput.trim();
    if (!sourcePath) {
      setWorkspaceImportError('Import source path is required.');
      return;
    }
    if (!workspaceImportPreview) {
      setWorkspaceImportError('Preview the import before running it.');
      return;
    }

    setWorkspaceImportError(null);
    setWorkspaceActionError(null);
    setWorkspaceBackupNotice(null);
    setIsWorkspaceImportBusy(true);
    try {
      const importRecord = await importWorkspaceRequest({
        format: importFormat,
        sourcePath,
        label: importLabelInput.trim() || undefined,
        options: importOptions,
      });
      await refreshWorkspaceState();
      setLastWorkspaceImport(importRecord);
      setWorkspaceImportPreview(null);
      setImportSourcePathInput('');
      setImportLabelInput('');
      setWorkspaceBackupNotice(`Created snapshot ${importRecord.backupId} before import.`);
    } catch (error) {
      setWorkspaceImportError(error instanceof Error ? error.message : 'Failed to import into workspace.');
    } finally {
      setIsWorkspaceImportBusy(false);
    }
  }

  async function handlePreviewWorkspaceImport() {
    const sourcePath = importSourcePathInput.trim();
    if (!sourcePath) {
      setWorkspaceImportError('Import source path is required.');
      return;
    }

    setWorkspaceImportError(null);
    setWorkspaceActionError(null);
    setWorkspaceBackupNotice(null);
    setLastWorkspaceImport(null);
    setIsWorkspaceImportPreviewBusy(true);
    try {
      const preview = await previewWorkspaceImport({
        format: importFormat,
        sourcePath,
        label: importLabelInput.trim() || undefined,
        options: importOptions,
      });
      setWorkspaceImportPreview(preview);
    } catch (error) {
      setWorkspaceImportPreview(null);
      setWorkspaceImportError(error instanceof Error ? error.message : 'Failed to preview workspace import.');
    } finally {
      setIsWorkspaceImportPreviewBusy(false);
    }
  }

  function invalidateWorkspaceImportPreview() {
    setWorkspaceImportPreview(null);
    setLastWorkspaceImport(null);
  }

  function selectView(next: NavView) {
    setLoadError(null);
    startTransition(() => {
      setView(next);
    });
  }

  function handleOpenGovernanceFeedItem(item: GovernanceFeedItem) {
    setSelectedGovernanceId(item.entityId);
    selectView('governance');
  }

  function openNodeInGraph(nodeId: string) {
    const node = nodeMap.get(nodeId);
    if (node?.type === 'project') {
      setGraphMode('project-map');
      setProjectGraphProjectId(nodeId);
    }
    focusNode(nodeId, 'graph');
  }

  function openNodeInRecent(nodeId: string) {
    focusNode(nodeId, 'recent');
    setNotePreviewTargetId(nodeId);
  }

  function rememberSearch(value: string) {
    setRecentSearches((current) => {
      const next = pushRecentEntry(current, value);
      writeStoredHistory(RECENT_SEARCHES_STORAGE_KEY, next);
      return next;
    });
  }

  function rememberCommand(value: string) {
    setRecentCommands((current) => {
      const next = pushRecentEntry(current, value);
      writeStoredHistory(RECENT_COMMANDS_STORAGE_KEY, next);
      return next;
    });
  }

  function handleOpenSearchResult(nodeId: string) {
    const normalizedQuery = deferredQuery.trim();
    if (normalizedQuery) {
      rememberSearch(normalizedQuery);
    }
    openNodeInRecent(nodeId);
  }

  function handleApplyRecentSearch(value: string) {
    rememberSearch(value);
    setQuery(value);
    selectView('home');
    setIsCommandPaletteOpen(false);
    setPaletteSection('searches');
  }

  function openGovernanceWithFilters(
    entityFilter: GovernanceFeedEntityFilter = 'all',
    actionFilter: GovernanceFeedActionFilter = 'all',
  ) {
    setGovernanceFeedEntityFilter(entityFilter);
    setGovernanceFeedActionFilter(actionFilter);
    selectView('governance');
  }

  function handleRunPaletteCommand(command: { label: string; run: () => void }) {
    rememberCommand(command.label);
    setIsCommandPaletteOpen(false);
    command.run();
  }

  function handleOpenPaletteNode(nodeId: string) {
    setIsCommandPaletteOpen(false);
    openNodeInRecent(nodeId);
  }

  function renderSearchRefinementControls(location: 'home' | 'notes') {
    if (!deferredQuery.trim()) {
      return null;
    }

    return (
      <section className="card search-refinement-card">
        <div className="page-copy compact-copy">
          <span className="eyebrow">Search refinement</span>
          <h3>{location === 'home' ? 'Keep Home search narrow and fast' : 'Trim mixed search results without rerunning the backend'}</h3>
        </div>
        <div className="search-refinement-groups">
          <div className="search-filter-group">
            <span className="search-filter-label">Scope</span>
            <div className="chip-row">
              {[
                ['all', 'All'],
                ['nodes', 'Nodes'],
                ['activities', 'Activity'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`chip-button ${searchScopeFilter === value ? 'active' : ''}`}
                  onClick={() => setSearchScopeFilter(value as SearchResultScope)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="search-filter-group">
            <span className="search-filter-label">Node type</span>
            <div className="chip-row">
              <button type="button" className={`chip-button ${searchNodeTypeFilter === 'all' ? 'active' : ''}`} onClick={() => setSearchNodeTypeFilter('all')}>
                All
              </button>
              {searchNodeTypeOptions.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`chip-button ${searchNodeTypeFilter === type ? 'active' : ''}`}
                  onClick={() => setSearchNodeTypeFilter(type)}
                  disabled={searchScopeFilter === 'activities'}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>
          <div className="search-filter-group">
            <span className="search-filter-label">Activity type</span>
            <div className="chip-row">
              {searchActivityTypeFilterOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`chip-button ${searchActivityTypeFilter === value ? 'active' : ''}`}
                  onClick={() => setSearchActivityTypeFilter(value)}
                  disabled={searchScopeFilter === 'nodes'}
                >
                  {value === 'all' ? 'All' : 'Review decisions'}
                </button>
              ))}
            </div>
          </div>
          <div className="search-filter-group">
            <span className="search-filter-label">Source</span>
            <div className="chip-row">
              <button type="button" className={`chip-button ${searchSourceFilter === 'all' ? 'active' : ''}`} onClick={() => setSearchSourceFilter('all')}>
                All
              </button>
              {searchSourceOptions.map((sourceLabel) => (
                <button
                  key={sourceLabel}
                  type="button"
                  className={`chip-button ${searchSourceFilter === sourceLabel ? 'active' : ''}`}
                  onClick={() => setSearchSourceFilter(sourceLabel)}
                >
                  {sourceLabel}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="chip-row">
          <span className="chip chip-static">{filteredSearchTotal} filtered hits</span>
          <span className="chip chip-static">{searchPanel.total} backend hits</span>
          <span className="chip chip-static">Cmd/Ctrl+K opens the palette</span>
        </div>
      </section>
    );
  }

  const commandPaletteRouteCommands = useMemo(
    () =>
      profileHotPath('palette.routeCommands', () =>
        createPaletteCommands([
          { label: 'Open Home', hint: 'Return to the re-entry surface', run: () => selectView('home') },
          { label: 'Open Memory', hint: 'Browse memory and quick capture', run: () => selectView('recent') },
          {
            label: 'Open Graph',
            hint: 'Inspect the broader memory graph',
            run: () => {
              setGraphMode('neighborhood');
              selectView('graph');
            },
          },
          { label: 'Open Review', hint: 'Inspect trust and review signals', run: () => selectView('governance') },
          {
            label: 'Review promoted decisions',
            hint: 'Open Review filtered to recent promote actions',
            run: () => openGovernanceWithFilters('all', 'promote'),
          },
          {
            label: 'Review archived decisions',
            hint: 'Open Review filtered to recent archive actions',
            run: () => openGovernanceWithFilters('all', 'archive'),
          },
          {
            label: 'Review contested nodes',
            hint: 'Open Review filtered to contested node decisions',
            run: () => openGovernanceWithFilters('node', 'contest'),
          },
          {
            label: 'Review relation decisions',
            hint: 'Open Review filtered to relation review activity',
            run: () => openGovernanceWithFilters('relation', 'all'),
          },
          ...(latestGovernanceFeedItem
            ? [
                {
                  label: 'Open latest review in notes',
                  hint: `${latestGovernanceFeedItem.title ?? latestGovernanceFeedItem.entityId} · ${getGovernanceDecisionActionLabel(latestGovernanceFeedItem.action)} · ${formatTime(latestGovernanceFeedItem.createdAt)}`,
                  run: () => inspectGovernanceFeedItem(latestGovernanceFeedItem),
                },
                {
                  label: 'Open latest review in graph',
                  hint: `${latestGovernanceFeedItem.title ?? latestGovernanceFeedItem.entityId} · graph context`,
                  run: () => openGovernanceFeedGraph(latestGovernanceFeedItem),
                },
              ]
            : []),
          ...(latestGovernanceIssueFeedItem
            ? [
                {
                  label: 'Open latest review issue',
                  hint: `${latestGovernanceIssueFeedItem.title ?? latestGovernanceIssueFeedItem.entityId} · reopen Review detail`,
                  run: () => handleOpenGovernanceFeedItem(latestGovernanceIssueFeedItem),
                },
              ]
            : []),
          { label: 'Open Workspace', hint: 'Open backup, import, and safety tools', run: () => selectView('settings') },
          { label: 'Open API guide', hint: 'Read HTTP and MCP access guidance', run: () => selectView('search') },
          ...(activeProjectNode
            ? [
                {
                  label: `Open ${activeProjectNode.title} project map`,
                  hint: 'Jump straight to the active project graph',
                  run: () => openNodeInGraph(activeProjectNode.id),
                },
              ]
            : []),
        ]),
      ),
    [activeProjectNode, latestGovernanceFeedItem, latestGovernanceIssueFeedItem],
  );
  const normalizedPaletteQuery = paletteQuery.trim().toLowerCase();
  const filteredPaletteRouteCommands = useMemo(
    () =>
      profileHotPath('palette.filteredRouteCommands', () =>
        filterPaletteCommands(commandPaletteRouteCommands, normalizedPaletteQuery),
      ),
    [commandPaletteRouteCommands, normalizedPaletteQuery],
  );
  const recentPaletteCommands = useMemo(
    () =>
      profileHotPath('palette.recentCommands', () =>
        buildRecentPaletteCommands(recentCommands, commandPaletteRouteCommands, normalizedPaletteQuery),
      ),
    [commandPaletteRouteCommands, normalizedPaletteQuery, recentCommands],
  );
  const filteredPaletteRecentSearches = useMemo(
    () => recentSearches.filter((item) => !normalizedPaletteQuery || item.toLowerCase().includes(normalizedPaletteQuery)),
    [normalizedPaletteQuery, recentSearches],
  );
  const filteredPaletteRecentNodes = useMemo(
    () => filterPaletteRecentNodes(paletteRecentNodes, normalizedPaletteQuery),
    [normalizedPaletteQuery, paletteRecentNodes],
  );

  const pageContent = (() => {
    if (isLoading) {
      return (
        <section className="page-section page-section--centered">
          <div className="empty-state">Opening the local memory field...</div>
        </section>
      );
    }

    if (loadError && !snapshot) {
      return (
        <section className="page-section page-section--centered">
          <div className="empty-state">{loadError}</div>
        </section>
      );
    }

    if (authRequired) {
      return (
        <section className="page-section page-section--centered">
          <div className="card auth-card">
            <div className="page-copy">
              <span className="eyebrow">Renderer authentication</span>
              <h2>Connect to continue</h2>
              <p>This workspace requires a bearer token before the renderer can use the live API.</p>
            </div>
            <form className="capture-form" onSubmit={(event) => void handleAuthSubmit(event)}>
              <label className="search-box" htmlFor="recallx-token">
                <span>API token</span>
                <input
                  id="recallx-token"
                  type="password"
                  value={authTokenInput}
                  onChange={(event) => setAuthTokenInput(event.target.value)}
                  placeholder="Paste RECALLX_API_TOKEN"
                />
              </label>
              {authError ? <div className="empty-state compact">{authError}</div> : null}
              <div className="action-row">
                <button type="submit" disabled={isLoading}>
                  {isLoading ? 'Connecting...' : 'Connect renderer'}
                </button>
              </div>
            </form>
          </div>
        </section>
      );
    }

    if (view === 'search' || view === 'projects') {
      return (
        <section className="page-section page-section--guide">
          <div className="page-heading">
            <span className="eyebrow">Integrations</span>
            <h2>API and MCP access.</h2>
          </div>
          <div className="guide-shell">
            <aside className="guide-sidebar">
              <div className="guide-sidebar-head">
                <span className="eyebrow">Developer guide</span>
                <h3>Contents</h3>
              </div>
              <div className="guide-tree">
                {guideGroups.map((group) => (
                  <section key={group.group} className="guide-tree-group">
                    <div className="guide-tree-group-label">{group.group}</div>
                    <div className="guide-tree-children">
                      {group.sections.map((section) => (
                        <button
                          key={section.id}
                          type="button"
                          className={`guide-tree-item ${activeGuideSection.id === section.id ? 'active' : ''}`}
                          onClick={() => setGuideSectionId(section.id)}
                        >
                          {section.label}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </aside>
            <section className="guide-content">
              <article className="guide-article">
                <div className="guide-kicker-row">
                  <span className="eyebrow">{activeGuideSection.group}</span>
                  <span className="guide-section-meta">{activeGuideSection.eyebrow}</span>
                </div>
                <h3>{activeGuideSection.title}</h3>
                <p className="guide-body">{activeGuideSection.body}</p>
                <div className="guide-copy-list">
                  {activeGuideSection.points.map((point) => (
                    <p key={point}>{point}</p>
                  ))}
                </div>
                {activeGuideSection.code ? <pre className="guide-code-block">{activeGuideSection.code}</pre> : null}
              </article>
            </section>
          </div>
        </section>
      );
    }

    if (view === 'governance') {
      return (
        <section className="page-section">
          <div className="page-heading">
            <span className="eyebrow">Review</span>
            <h2>Issue queue</h2>
          </div>
          <div className="governance-layout">
            <aside className="card governance-list">
              <div className="section-head section-head--compact">
                <div>
                  <span className="eyebrow">Issue queue</span>
                  <h3>Current items</h3>
                </div>
                <span className="pill tone-muted">{governanceIssues.length}</span>
              </div>
              <div className="info-grid three">
                <article className="info-block">
                  <span className="info-label">Contested</span>
                  <strong>{governanceStateCounts.contested ?? 0}</strong>
                  <p>Needs direct review.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Low confidence</span>
                  <strong>{governanceStateCounts.low_confidence ?? 0}</strong>
                  <p>Needs stronger proof.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Healthy</span>
                  <strong>{governanceStateCounts.healthy ?? 0}</strong>
                  <p>Out of queue.</p>
                </article>
              </div>
              <div className="card-stack">
                {governanceIssues.map((item) => (
                  <button
                    key={`${item.entityType}:${item.entityId}`}
                    type="button"
                    className={`result-card governance-card ${selectedGovernanceId === item.entityId ? 'selected' : ''}`}
                    onClick={() => setSelectedGovernanceId(item.entityId)}
                  >
                    <span className="eyebrow">{item.entityType === 'node' ? 'Node issue' : 'Relation issue'}</span>
                    <div className="result-card__top">
                      <strong>{item.title}</strong>
                      <span className={`pill ${badgeTone(item.state)}`}>{item.state}</span>
                    </div>
                    <p>{item.subtitle || getGovernanceStateSummary(item.state)}</p>
                    <div className="meta-row">
                      <span>{formatCompactId(`${item.entityType}:${item.entityId}`)}</span>
                      <span>{formatConfidence(item.confidence)}</span>
                    </div>
                  </button>
                ))}
                {!governanceIssues.length ? <div className="empty-state">No governance issues are currently surfaced.</div> : null}
              </div>
            </aside>

            <section className="card governance-detail">
              {activeGovernanceIssue ? (
                <>
                  <div className="section-head section-head--compact">
                    <div>
                      <span className="eyebrow">{activeGovernanceIssue.entityType === 'node' ? 'Selected node issue' : 'Selected relation issue'}</span>
                      <h3>{activeGovernanceIssue.title}</h3>
                    </div>
                    <span className={`pill ${badgeTone(activeGovernanceIssue.state)}`}>{activeGovernanceIssue.state}</span>
                  </div>
                  <div className="info-grid three">
                    <article className="info-block">
                      <span className="info-label">Confidence</span>
                      <strong>{formatConfidence(activeGovernanceIssue.confidence)}</strong>
                      <p>Current trust.</p>
                    </article>
                    <article className="info-block">
                      <span className="info-label">Action</span>
                      <strong>{getGovernanceActionLabel(activeGovernanceIssue)}</strong>
                      <p>{getGovernanceStateSummary(activeGovernanceIssue.state)}</p>
                    </article>
                    <article className="info-block">
                      <span className="info-label">Last transition</span>
                      <strong>{formatTime(activeGovernanceIssue.lastTransitionAt)}</strong>
                      <p>Most recent change.</p>
                    </article>
                  </div>
                  <div className="governance-detail-grid">
                    <article className="card governance-detail-card">
                      <div className="page-copy compact-copy">
                        <span className="eyebrow">Why this surfaced</span>
                        <h3>Reason</h3>
                      </div>
                      <div className="card-stack compact-stack">
                        {activeGovernanceIssue.reasons.map((reason) => (
                          <article key={reason} className="mini-card">
                            <strong>{reason}</strong>
                          </article>
                        ))}
                        {!activeGovernanceIssue.reasons.length ? (
                          <div className="empty-state compact">No explicit reasons yet.</div>
                        ) : null}
                      </div>
                    </article>

                    <article className="card governance-detail-card">
                      <div className="page-copy compact-copy">
                        <span className="eyebrow">Context</span>
                        <h3>Entity</h3>
                      </div>
                      {isGovernanceDetailLoading ? (
                        <div className="empty-state compact">Loading issue detail...</div>
                      ) : activeGovernanceNode ? (
                        <div className="card-stack compact-stack">
                          <article className="mini-card">
                            <strong>{activeGovernanceNode.title}</strong>
                            <p>{activeGovernanceNode.summary}</p>
                          </article>
                          <div className="chip-row">
                            <span className="chip chip-static">{activeGovernanceNode.type}</span>
                            <span className="chip chip-static">{activeGovernanceNode.status}</span>
                            <span className="chip chip-static">{activeGovernanceNode.sourceLabel}</span>
                          </div>
                          <div className="action-row">
                            <button type="button" onClick={() => focusNode(activeGovernanceNode.id, 'recent')}>
                              Open
                            </button>
                            <button type="button" className="ghost" onClick={() => focusNode(activeGovernanceNode.id, 'graph')}>
                              Graph
                            </button>
                          </div>
                          {(activeGovernanceNodeCanPromote || activeGovernanceNodeCanContest || activeGovernanceNodeCanArchive) ? (
                            <>
                              <label className="search-box" htmlFor="governance-decision-note">
                                <span>Decision note</span>
                                <textarea
                                  id="governance-decision-note"
                                  value={governanceDecisionNote}
                                  onChange={(event) => setGovernanceDecisionNote(event.target.value)}
                                  placeholder="Optional short rationale for this human decision."
                                  rows={3}
                                />
                              </label>
                              <div className="action-row">
                                {activeGovernanceNodeCanPromote ? (
                                  <button
                                    type="button"
                                    onClick={() => void handleApplyNodeGovernanceAction('promote', activeGovernanceNode)}
                                    disabled={governanceActionPending !== null}
                                  >
                                    {governanceActionPending === 'promote' ? 'Promoting...' : 'Promote'}
                                  </button>
                                ) : null}
                                {activeGovernanceNodeCanContest ? (
                                  <button
                                    type="button"
                                    className="ghost"
                                    onClick={() => void handleApplyNodeGovernanceAction('contest', activeGovernanceNode)}
                                    disabled={governanceActionPending !== null}
                                  >
                                    {governanceActionPending === 'contest' ? 'Marking...' : 'Mark contested'}
                                  </button>
                                ) : null}
                                {activeGovernanceNodeCanArchive ? (
                                  <button
                                    type="button"
                                    className="ghost"
                                    onClick={() => void handleApplyNodeGovernanceAction('archive', activeGovernanceNode)}
                                    disabled={governanceActionPending !== null}
                                  >
                                    {governanceActionPending === 'archive' ? 'Archiving...' : 'Archive suggestion'}
                                  </button>
                                ) : null}
                              </div>
                              {governanceActionError ? <div className="empty-state compact">{governanceActionError}</div> : null}
                            </>
                          ) : null}
                        </div>
                      ) : activeGovernanceRelation ? (
                        <div className="card-stack compact-stack">
                          <article className="mini-card">
                            <strong>{activeGovernanceIssue.title}</strong>
                            <p>{activeGovernanceIssue.subtitle || `${activeGovernanceRelation.relationType} relation`}</p>
                          </article>
                          <div className="chip-row">
                            <span className="chip chip-static">{activeGovernanceRelation.relationType}</span>
                            <span className="chip chip-static">{activeGovernanceRelation.status}</span>
                            <span className="chip chip-static">{activeGovernanceRelation.sourceLabel}</span>
                          </div>
                          <div className="card-stack compact-stack">
                            <article className="mini-card">
                              <strong>From</strong>
                              <p>{governanceDetail.fromNode?.title ?? activeGovernanceRelation.fromNodeId}</p>
                            </article>
                            <article className="mini-card">
                              <strong>To</strong>
                              <p>{governanceDetail.toNode?.title ?? activeGovernanceRelation.toNodeId}</p>
                            </article>
                          </div>
                          <div className="action-row">
                            {governanceDetail.fromNode ? (
                              <button type="button" onClick={() => focusNode(governanceDetail.fromNode!.id, 'recent')}>
                                Source
                              </button>
                            ) : null}
                            {governanceDetail.toNode ? (
                              <button type="button" className="ghost" onClick={() => focusNode(governanceDetail.toNode!.id, 'graph')}>
                                Graph
                              </button>
                            ) : null}
                          </div>
                          {(activeGovernanceRelationCanAccept || activeGovernanceRelationCanReject || activeGovernanceRelationCanArchive) ? (
                            <>
                              <label className="search-box" htmlFor="governance-relation-decision-note">
                                <span>Decision note</span>
                                <textarea
                                  id="governance-relation-decision-note"
                                  value={governanceDecisionNote}
                                  onChange={(event) => setGovernanceDecisionNote(event.target.value)}
                                  placeholder="Optional short rationale for this relation decision."
                                  rows={3}
                                />
                              </label>
                              <div className="action-row">
                                {activeGovernanceRelationCanAccept ? (
                                  <button
                                    type="button"
                                    onClick={() => void handleApplyRelationGovernanceAction('accept', activeGovernanceRelation)}
                                    disabled={relationGovernanceActionPending !== null}
                                  >
                                    {relationGovernanceActionPending === 'accept' ? 'Accepting...' : 'Accept'}
                                  </button>
                                ) : null}
                                {activeGovernanceRelationCanReject ? (
                                  <button
                                    type="button"
                                    className="ghost"
                                    onClick={() => void handleApplyRelationGovernanceAction('reject', activeGovernanceRelation)}
                                    disabled={relationGovernanceActionPending !== null}
                                  >
                                    {relationGovernanceActionPending === 'reject' ? 'Rejecting...' : 'Reject'}
                                  </button>
                                ) : null}
                                {activeGovernanceRelationCanArchive ? (
                                  <button
                                    type="button"
                                    className="ghost"
                                    onClick={() => void handleApplyRelationGovernanceAction('archive', activeGovernanceRelation)}
                                    disabled={relationGovernanceActionPending !== null}
                                  >
                                    {relationGovernanceActionPending === 'archive' ? 'Archiving...' : 'Archive'}
                                  </button>
                                ) : null}
                              </div>
                              {governanceActionError ? <div className="empty-state compact">{governanceActionError}</div> : null}
                            </>
                          ) : null}
                        </div>
                      ) : (
                        <div className="empty-state compact">
                          No extra entity detail is available here yet.
                        </div>
                      )}
                    </article>

                    <article className="card governance-detail-card">
                      <div className="page-copy compact-copy">
                        <span className="eyebrow">Recent decisions</span>
                        <h3>Recent decisions</h3>
                      </div>
                      <div className="governance-feed-toolbar">
                        <div className="chip-row">
                          {governanceFeedEntityFilterOptions.map((value) => (
                            <button
                              key={value}
                              type="button"
                              className={`tool-chip ${governanceFeedEntityFilter === value ? 'tool-chip--active' : ''}`}
                              onClick={() => setGovernanceFeedEntityFilter(value)}
                            >
                              {value === 'all' ? 'All entities' : value === 'node' ? 'Nodes' : 'Relations'}
                            </button>
                          ))}
                        </div>
                        <div className="chip-row">
                          {governanceFeedActionFilterOptions.map((value) => (
                            <button
                              key={value}
                              type="button"
                              className={`tool-chip ${governanceFeedActionFilter === value ? 'tool-chip--active' : ''}`}
                              onClick={() => setGovernanceFeedActionFilter(value)}
                            >
                              {value === 'all' ? 'All actions' : getGovernanceDecisionActionLabel(value)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="governance-feed-list">
                        {isGovernanceFeedLoading ? <div className="empty-state compact">Loading recent governance decisions...</div> : null}
                        {!isGovernanceFeedLoading
                          ? governanceFeed.map((event) => (
                              <article key={event.id} className="mini-card governance-feed-card">
                                <div className="result-card__top">
                                  <div>
                                    <strong>{event.title ?? formatCompactId(`${event.entityType}:${event.entityId}`)}</strong>
                                    <p>{event.reason}</p>
                                  </div>
                                  <span className={`pill ${badgeTone(event.nextState)}`}>{getGovernanceDecisionActionLabel(event.action)}</span>
                                </div>
                                <div className="meta-row">
                                  <span>{getGovernanceFeedProvenanceText(event)}</span>
                                </div>
                                <div className="chip-row">
                                  <span className="chip chip-static">{event.entityType}</span>
                                  {event.subtitle ? <span className="chip chip-static">{event.subtitle}</span> : null}
                                  {event.relationType ? <span className="chip chip-static">{relationLabel(event.relationType)}</span> : null}
                                </div>
                                <div className="meta-row">
                                  <span>{formatTime(event.createdAt)}</span>
                                  <span>{formatConfidence(event.confidence)}</span>
                                </div>
                                <div className="action-row governance-feed-card__actions">
                                  <button type="button" onClick={() => inspectGovernanceFeedItem(event)}>
                                    Open
                                  </button>
                                  <button type="button" className="ghost" onClick={() => openGovernanceFeedGraph(event)}>
                                    Graph
                                  </button>
                                  {hasOpenGovernanceIssueForFeedItem(governanceIssues, event) ? (
                                    <button
                                      type="button"
                                      className="ghost"
                                      onClick={() => setSelectedGovernanceId(event.entityId)}
                                    >
                                      Issue
                                    </button>
                                  ) : null}
                                </div>
                              </article>
                            ))
                          : null}
                        {!isGovernanceFeedLoading && !governanceFeed.length ? <div className="empty-state compact">No decisions match current filters.</div> : null}
                      </div>
                    </article>
                  </div>
                </>
              ) : (
                <div className="empty-state">No governance issue is selected.</div>
              )}
            </section>
          </div>
        </section>
      );
    }

    if (view === 'graph') {
      return (
        <section className="page-section">
          <div className="page-heading">
            <span className="eyebrow">Graph</span>
            <h2>Relationships</h2>
          </div>
          <section className="card page-card">
            <div className="graph-toolbar">
              <div className="chip-row">
                <button
                  type="button"
                  className={`tool-chip ${graphMode === 'neighborhood' ? 'tool-chip--active' : ''}`}
                  onClick={() => setGraphMode('neighborhood')}
                >
                  Neighborhood
                </button>
                <button
                  type="button"
                  className={`tool-chip ${graphMode === 'project-map' ? 'tool-chip--active' : ''}`}
                  onClick={() => setGraphMode('project-map')}
                >
                  Project map
                </button>
              </div>
              {graphMode === 'neighborhood' ? (
                <>
                  <label className="search-box">
                    <span>Focus node</span>
                    <select
                      value={selectedNode?.id ?? ''}
                      onChange={(event) => {
                        if (event.target.value) {
                          focusNode(event.target.value);
                        }
                      }}
                    >
                      {graphFocusableNodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {`${node.title} · ${node.type}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="chip-row">
                    <button
                      type="button"
                      className={`tool-chip ${graphRadius === 1 ? 'tool-chip--active' : ''}`}
                      onClick={() => setGraphRadius(1)}
                    >
                      1 hop
                    </button>
                    <button
                      type="button"
                      className={`tool-chip ${graphRadius === 2 ? 'tool-chip--active' : ''}`}
                      onClick={() => setGraphRadius(2)}
                    >
                      2 hops
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label className="search-box">
                    <span>Focus project</span>
                    <select
                      value={activeProjectGraphProject?.id ?? ''}
                      onChange={(event) => {
                        if (event.target.value) {
                          handleSelectProjectGraphProject(event.target.value);
                        }
                      }}
                    >
                      {projectNodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="chip-row">
                    <button
                      type="button"
                      className={`tool-chip ${projectGraphSources.canonical ? 'tool-chip--active' : ''}`}
                      onClick={() => setProjectGraphSources((current) => ({ ...current, canonical: !current.canonical }))}
                    >
                      Canonical
                    </button>
                    <button
                      type="button"
                      className={`tool-chip ${projectGraphSources.inferred ? 'tool-chip--active' : ''}`}
                      onClick={() => setProjectGraphSources((current) => ({ ...current, inferred: !current.inferred }))}
                    >
                      Inferred
                    </button>
                  </div>
                </>
              )}
            </div>
            {graphMode === 'project-map' && !!projectGraphAvailableRelationTypes.length ? (
              <div className="graph-filter-row">
                {projectGraphAvailableRelationTypes.map((relationType) => {
                  const isActive = effectiveProjectGraphRelationTypes.includes(relationType);
                  return (
                    <button
                      key={relationType}
                      type="button"
                      className={`tool-chip ${isActive ? 'tool-chip--active' : ''}`}
                      onClick={() => toggleProjectGraphRelationType(relationType)}
                    >
                      {relationLabel(relationType)}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="graph-summary-grid">
              {graphMode === 'neighborhood' ? (
                <>
                  <article className="graph-focus graph-focus-card">
                    <span className="eyebrow">Focus node</span>
                    <strong>{selectedNode?.title}</strong>
                    <p>{selectedNode?.summary}</p>
                  </article>
                  <article className="mini-card">
                    <span className="eyebrow">Connected nodes</span>
                    <strong>{graphSummary.distinctNodes.length} nodes</strong>
                    <p>{graphConnections.length} visible paths.</p>
                  </article>
                  <article className="mini-card">
                    <span className="eyebrow">Signal mix</span>
                    <strong>{graphRelationGroups.length} relation types</strong>
                    <p>{graphSummary.suggestedCount} links still need review.</p>
                  </article>
                  <article className="mini-card">
                    <span className="eyebrow">Direction</span>
                    <strong>{graphSummary.outgoingCount} out / {graphSummary.incomingCount} in</strong>
                    <p>Outbound vs inbound.</p>
                  </article>
                </>
              ) : (
                <>
                  <article className="graph-focus graph-focus-card">
                    <span className="eyebrow">Focus project</span>
                    <strong>{activeProjectGraphProject?.title ?? 'No project selected'}</strong>
                    <p>{activeProjectGraphProject?.summary ?? 'Select a project to open its graph.'}</p>
                  </article>
                  <article className="mini-card">
                    <span className="eyebrow">Visible graph</span>
                    <strong>{projectGraphView.nodes.length} nodes</strong>
                    <p>{projectGraphView.edges.length} visible edges.</p>
                  </article>
                  <article className="mini-card">
                    <span className="eyebrow">Signal split</span>
                    <strong>{projectGraph?.meta.inferredEdgeCount ?? 0} inferred</strong>
                    <p>{projectGraph?.meta.edgeCount ?? 0} total edges in scope.</p>
                  </article>
                  <article className="mini-card">
                    <span className="eyebrow">Timeline</span>
                    <strong>{projectGraph?.timeline.length ?? 0} events</strong>
                    <p>{currentProjectGraphEvent ? currentProjectGraphEvent.label : 'Use the scrubber to move in time.'}</p>
                  </article>
                </>
              )}
            </div>
            {graphError ? <div className="empty-state">{graphError}</div> : null}
            {isGraphLoading ? <div className="empty-state">{graphMode === 'project-map' ? 'Loading project graph...' : 'Loading graph neighborhood...'}</div> : null}
            {!isGraphLoading && graphMode === 'neighborhood' && !graphConnections.length ? (
              <div className="graph-empty">
                <div className="empty-state">No linked memory for this node yet.</div>
                <div className="graph-support-grid">
                  <article className="mini-card">
                    <strong>Context bundle signals</strong>
                    <p>
                      {detail.bundleItems.length
                        ? `${detail.bundleItems.length} bundle items are available even without graph links.`
                        : 'No bundle signals for this node yet.'}
                    </p>
                  </article>
                  <article className="mini-card">
                    <strong>Related detail nodes</strong>
                    <p>
                      {detail.related.length
                        ? `${detail.related.length} related nodes can guide the first relation pass.`
                        : 'No explicit related nodes for this focus.'}
                    </p>
                  </article>
                </div>
              </div>
            ) : null}
            {!isGraphLoading && graphMode === 'project-map' && !activeProjectGraphProject ? (
              <div className="graph-empty">
                <div className="empty-state">Select a project to open the map.</div>
              </div>
            ) : null}
            {!isGraphLoading && graphMode === 'project-map' && !!activeProjectGraphProject && !projectGraphView.edges.length ? (
              <div className="graph-empty">
                <div className="empty-state">This project map is still sparse.</div>
              </div>
            ) : null}
            {graphMode === 'neighborhood' && !!graphRelationGroups.length ? (
              <section className="graph-section-grid">
                <article className="card relation-group-card">
                  <div className="section-head section-head--compact">
                    <div>
                      <span className="eyebrow">Relation groups</span>
                      <h3>Link types</h3>
                    </div>
                  </div>
                  <div className="relation-group-grid">
                    {graphRelationGroups.map((item) => (
                      <article key={item.relationType} className="mini-card">
                        <span className={`chip relation-chip ${relationToneClass(item.relationType as GraphConnection['relation']['relationType'])}`}>
                          {relationLabel(item.relationType)}
                        </span>
                        <strong>{item.count} links</strong>
                        <p>Visible in the current {graphRadius}-hop neighborhood.</p>
                      </article>
                    ))}
                  </div>
                </article>

                <article className="card relation-group-card">
                  <div className="section-head section-head--compact">
                    <div>
                      <span className="eyebrow">Connected memory</span>
                      <h3>Nearby nodes</h3>
                    </div>
                  </div>
                  <div className="graph-related-grid">
                    {graphConnections.map((item) => (
                      <button
                        key={`${item.relation.id}:${item.node.id}:${item.viaNodeId ?? 'focus'}`}
                        type="button"
                        className={`graph-node graph-node--hop-${item.hop}`}
                        onClick={() => {
                          focusNode(item.node.id, 'graph');
                        }}
                      >
                        <div className="result-card__top">
                          <strong>{item.node.title}</strong>
                          <span className={`pill ${badgeTone(item.node.status)}`}>{item.node.type}</span>
                        </div>
                        <p>{item.node.summary}</p>
                        <div className="chip-row">
                          <span className={`chip relation-chip ${relationToneClass(item.relation.relationType)}`}>
                            {relationLabel(item.relation.relationType)}
                          </span>
                          <span className="chip chip-static">{item.direction}</span>
                          <span className="chip chip-static">{item.hop} hop</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </article>
              </section>
            ) : null}
            {graphMode === 'project-map' && !!projectGraphCanvasGraph && !!projectGraphView.nodes.length ? (
              <section className="graph-section-grid graph-section-grid--project">
                <article className="card relation-group-card project-graph-card">
                  <div className="section-head section-head--compact">
                    <div>
                      <span className="eyebrow">Project map</span>
                      <h3>Project field</h3>
                    </div>
                    <div className="chip-row">
                      <button
                        type="button"
                        className={`tool-chip ${isProjectGraphPlaying ? 'tool-chip--active' : ''}`}
                        disabled={!projectGraphCanvasGraph.timeline.length}
                        onClick={() => {
                          setIsProjectGraphPlaying((current) => !current);
                        }}
                      >
                        {isProjectGraphPlaying ? 'Pause' : 'Play'}
                      </button>
                      <button
                        type="button"
                        className="tool-chip"
                        disabled={!projectGraphCanvasGraph.timeline.length}
                        onClick={() => setProjectGraphTimelineIndex(Math.max(projectGraphCanvasGraph.timeline.length - 1, 0))}
                      >
                        Latest
                      </button>
                    </div>
                  </div>
                  <Suspense fallback={<div className="empty-state compact">Loading project graph canvas...</div>}>
                    <ProjectGraphCanvas
                      graph={projectGraphCanvasGraph}
                      selectedNodeId={selectedNode?.id ?? null}
                      emphasizedNodeIds={projectGraphView.emphasizedNodeIds}
                      emphasizedEdgeIds={projectGraphView.emphasizedEdgeIds}
                      onSelectNode={handleSelectProjectGraphNode}
                    />
                  </Suspense>
                  <div className="project-graph-controls">
                    <label className="search-box project-graph-scrubber">
                      <span>Time emphasis</span>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(projectGraphCanvasGraph.timeline.length - 1, 0)}
                        value={Math.min(projectGraphTimelineIndex, Math.max(projectGraphCanvasGraph.timeline.length - 1, 0))}
                        onChange={(event) => {
                          setIsProjectGraphPlaying(false);
                          setProjectGraphTimelineIndex(Number(event.target.value));
                        }}
                      />
                    </label>
                    <div className="mini-card">
                      <span className="eyebrow">Current event</span>
                      <strong>{currentProjectGraphEvent?.label ?? 'Latest state'}</strong>
                      <p>{currentProjectGraphEvent ? formatTime(currentProjectGraphEvent.at) : 'No timeline events yet.'}</p>
                    </div>
                  </div>
                </article>
                <article className="card relation-group-card">
                  <div className="section-head section-head--compact">
                    <div>
                      <span className="eyebrow">Relation groups</span>
                      <h3>Top link types</h3>
                    </div>
                  </div>
                  <div className="relation-group-grid">
                    {projectGraphRelationGroups.map((item) => (
                      <article key={item.relationType} className="mini-card">
                        <span className={`chip relation-chip ${relationToneClass(item.relationType as GraphConnection['relation']['relationType'])}`}>
                          {relationLabel(item.relationType)}
                        </span>
                        <strong>{item.count} links</strong>
                        <p>Visible in the current project map filters.</p>
                      </article>
                    ))}
                    {!projectGraphRelationGroups.length ? <div className="empty-state compact">No relation groups are visible with the current filters.</div> : null}
                  </div>
                </article>
              </section>
            ) : null}
            {(detail.bundleItems.length || detail.activities.length) && !isGraphLoading ? (
              <section className="graph-section-grid">
                <article className="card relation-group-card">
                  <div className="section-head section-head--compact">
                    <div>
                      <span className="eyebrow">Context signals</span>
                      <h3>Nearby memory</h3>
                    </div>
                  </div>
                  <div className="card-stack compact-stack">
                    {detail.bundleItems.slice(0, 3).map((item) => (
                      <button
                        key={item.nodeId}
                        type="button"
                        className="mini-card mini-card--interactive"
                        onClick={() => void handleBundlePreviewClick(item)}
                      >
                        <strong>{item.title ?? item.nodeId}</strong>
                        <p>{item.reason}</p>
                      </button>
                    ))}
                    {!detail.bundleItems.length ? <div className="empty-state compact">No bundle signals for this focus yet.</div> : null}
                  </div>
                </article>
                <article className="card relation-group-card">
                  <div className="section-head section-head--compact">
                    <div>
                      <span className="eyebrow">Recent activity</span>
                      <h3>Recent activity</h3>
                    </div>
                  </div>
                  <div className="card-stack compact-stack">
                {detail.activities.slice(0, 3).map((activity) => (
                  <article key={activity.id} className="mini-card">
                    <strong>{getActivityTypeLabel(activity)}</strong>
                    <p>{getActivityPreviewText(activity)}</p>
                  </article>
                ))}
                {!detail.activities.length ? <div className="empty-state compact">No recent activity on this node yet.</div> : null}
              </div>
            </article>
              </section>
            ) : null}
          </section>
        </section>
      );
    }

    if (view === 'settings') {
      return (
        <section className="page-section">
          <div className="page-heading">
            <span className="eyebrow">Current workspace</span>
            <h2>Workspace ops</h2>
          </div>
          <div className="two-column-grid">
            <section id="workspace-settings-card" tabIndex={-1} className="card page-card">
              <div className="info-grid three">
                <article className="info-block">
                  <span className="info-label">Active</span>
                  <strong>{workspaceName}</strong>
                  <p>Primary local memory field.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Mode</span>
                  <strong>Workspace-first</strong>
                  <p>Projects stay inside this workspace.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">API bind</span>
                  <strong>{workspace?.apiBind ?? '127.0.0.1:8787'}</strong>
                  <p>Local integration address.</p>
                </article>
              </div>
              <form className="capture-form compact-form" onSubmit={(event) => void handleCreateWorkspace(event)}>
                <label className="search-box">
                  <span>Workspace root</span>
                  <input
                    value={workspaceRootInput}
                    onChange={(event) => setWorkspaceRootInput(event.target.value)}
                    placeholder="/Users/name/Documents/MyRecallX"
                  />
                </label>
                <label className="search-box">
                  <span>Workspace name</span>
                  <input
                    value={workspaceNameInput}
                    onChange={(event) => setWorkspaceNameInput(event.target.value)}
                    placeholder="Optional display name"
                  />
                </label>
                {workspaceActionError ? <div className="empty-state compact">{workspaceActionError}</div> : null}
                <div className="action-row">
                  <button type="submit" disabled={isSwitchingWorkspace}>
                    {isSwitchingWorkspace ? 'Switching...' : 'Create and switch'}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={isSwitchingWorkspace}
                    onClick={() => void handleOpenWorkspace(workspaceRootInput)}
                  >
                    Open existing
                  </button>
                </div>
              </form>
            </section>
            <aside className="card page-card">
              <div className="page-copy">
                <span className="eyebrow">Recent workspaces</span>
                <h3>Recent workspaces</h3>
              </div>
              <div className="card-stack">
                {workspaceCatalog.map((item) => (
                  <button
                    key={item.rootPath}
                    type="button"
                    className="route-card"
                    disabled={isSwitchingWorkspace || item.isCurrent}
                    onClick={() => {
                      setWorkspaceRootInput(item.rootPath);
                      void handleOpenWorkspace(item.rootPath);
                    }}
                  >
                    <div>
                      <strong>{item.name}</strong>
                      <span>{item.rootPath}</span>
                    </div>
                    <em>{item.isCurrent ? 'Current' : 'Open'}</em>
                  </button>
                ))}
              </div>
            </aside>
          </div>
          <div className="two-column-grid">
            <section id="server-status-card" tabIndex={-1} className="card page-card">
              <div className="page-copy">
                <span className="eyebrow">Server status</span>
                <h3>API health</h3>
              </div>
              <div className="info-grid three">
                <article className="info-block">
                  <span className="info-label">Status</span>
                  <strong>{workspace ? 'running' : 'starting'}</strong>
                  <p>Available for renderer, CLI, and MCP.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">API base</span>
                  <strong>{apiBase}</strong>
                  <p>Loopback base URL.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Auth mode</span>
                  <strong>{workspace?.authMode ?? 'optional'}</strong>
                  <p>Bootstrap auth mode.</p>
                </article>
              </div>
            </section>
            <section id="workspace-status-card" tabIndex={-1} className="card page-card">
              <div className="page-copy">
                <span className="eyebrow">Workspace status</span>
                <h3>Paths</h3>
              </div>
              <div className="info-grid three">
                <article className="info-block">
                  <span className="info-label">Root</span>
                  <strong>{workspaceRoot || 'Unavailable'}</strong>
                  <p>Current workspace root.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Database</span>
                  <strong>{workspaceDbPath || 'Unavailable'}</strong>
                  <p>SQLite source of truth for the active memory field.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Artifacts</span>
                  <strong>{artifactsPath || 'Unavailable'}</strong>
                  <p>Attachment file storage.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Exports</span>
                  <strong>{exportsPath || 'Unavailable'}</strong>
                  <p>Portable export files.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Imports</span>
                  <strong>{importsPath || 'Unavailable'}</strong>
                  <p>Imported source staging.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Backups</span>
                  <strong>{backupsPath || 'Unavailable'}</strong>
                  <p>Manual snapshot storage.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Safety</span>
                  <strong>{workspaceSafetyWarnings.length ? `${workspaceSafetyWarnings.length} warning(s)` : 'clear'}</strong>
                  <p>Session and lock signals.</p>
                </article>
              </div>
            </section>
          </div>
          <div className="two-column-grid">
            <section className="card page-card">
              <div className="page-copy">
                <span className="eyebrow">Safety</span>
                <h3>Safety signals</h3>
              </div>
              <div className="info-grid three">
                <article className="info-block">
                  <span className="info-label">Machine</span>
                  <strong>{workspace?.safety?.machineId ?? 'Unavailable'}</strong>
                  <p>Current host marker.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Last opened</span>
                  <strong>{workspace?.safety?.lastOpenedAt ? formatTime(workspace.safety.lastOpenedAt) : 'Unavailable'}</strong>
                  <p>Most recent session open.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Last clean close</span>
                  <strong>{workspace?.safety?.lastCleanCloseAt ? formatTime(workspace.safety.lastCleanCloseAt) : 'Not recorded yet'}</strong>
                  <p>Latest clean shutdown marker.</p>
                </article>
              </div>
              {workspaceSafetyWarnings.length ? (
                <div className="card-stack compact-stack">
                  {workspaceSafetyWarnings.map((warning) => (
                    <div key={warning.code} className="empty-state compact">
                      {warning.message}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="notice">No active lock or unclean-close warning.</div>
              )}
            </section>
            <section className="card page-card">
              <div className="page-copy">
                <span className="eyebrow">Safe handoff</span>
                <h3>Device handoff</h3>
              </div>
              <div className="card-stack compact-stack">
                {safeHandoffSteps.map((step) => (
                  <article key={step} className="mini-card">
                    <p>{step}</p>
                  </article>
                ))}
              </div>
              <div className="info-grid three">
                <article className="info-block">
                  <span className="info-label">Model</span>
                  <strong>Single writer</strong>
                  <p>Sync is transport, not collaboration.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Warning state</span>
                  <strong>{workspaceSafetyWarnings.length ? 'needs care' : 'clear'}</strong>
                  <p>Cross-machine and shutdown signals.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Best next step</span>
                  <strong>{workspaceSafetyWarnings.length ? 'snapshot first' : 'handoff normally'}</strong>
                  <p>Back up first if handoff feels uncertain.</p>
                </article>
              </div>
            </section>
            <section className="card page-card">
              <div className="page-copy">
                <span className="eyebrow">Backup and restore</span>
                <h3>Snapshot before risky moves</h3>
              </div>
              <form
                className="capture-form compact-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleCreateWorkspaceBackup();
                }}
              >
                <label className="search-box">
                  <span>Snapshot label</span>
                  <input
                    value={backupLabelInput}
                    onChange={(event) => setBackupLabelInput(event.target.value)}
                    placeholder="before-upgrade"
                  />
                </label>
                <label className="search-box">
                  <span>Restore target root</span>
                  <input
                    value={restoreTargetRootInput}
                    onChange={(event) => setRestoreTargetRootInput(event.target.value)}
                    placeholder="/Users/name/Documents/RecallX-Restore"
                  />
                </label>
                {workspaceActionError ? <div className="empty-state compact">{workspaceActionError}</div> : null}
                {workspaceBackupNotice ? <div className="notice">{workspaceBackupNotice}</div> : null}
                {lastWorkspaceExport ? <div className="notice">Latest export: {lastWorkspaceExport.exportPath}</div> : null}
                <div className="action-row">
                  <button type="submit" disabled={isWorkspaceBackupBusy}>
                    {isWorkspaceBackupBusy ? 'Working...' : 'Create snapshot'}
                  </button>
                  <button type="button" className="ghost" disabled={isWorkspaceBackupBusy} onClick={() => void handleExportWorkspace('json')}>
                    Export JSON
                  </button>
                  <button type="button" className="ghost" disabled={isWorkspaceBackupBusy} onClick={() => void handleExportWorkspace('markdown')}>
                    Export Markdown
                  </button>
                </div>
              </form>
              <div className="card-stack compact-stack">
                {workspaceBackups.length ? (
                  workspaceBackups.slice(0, 5).map((backup) => (
                    <button
                      key={backup.id}
                      type="button"
                      className="route-card"
                      disabled={isWorkspaceBackupBusy}
                      onClick={() => void handleRestoreWorkspaceBackup(backup.id)}
                    >
                      <div>
                        <strong>{backup.label}</strong>
                        <span>{backup.backupPath}</span>
                      </div>
                      <em>{formatTime(backup.createdAt)}</em>
                    </button>
                  ))
                ) : (
                  <div className="empty-state compact">No snapshots yet.</div>
                )}
              </div>
            </section>
          </div>
          <section className="card page-card">
            <div className="page-copy">
              <span className="eyebrow">Import onboarding</span>
              <h3>Import notes into this workspace</h3>
            </div>
            <form
              className="capture-form compact-form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleImportWorkspace();
              }}
            >
              <label className="search-box">
                <span>Import format</span>
                <select
                  value={importFormat}
                  onChange={(event) => {
                    setImportFormat(event.target.value as 'recallx_json' | 'markdown');
                    invalidateWorkspaceImportPreview();
                  }}
                >
                  <option value="markdown">Markdown file or folder</option>
                  <option value="recallx_json">RecallX JSON export</option>
                </select>
              </label>
              <label className="search-box">
                <span>Local source path</span>
                <input
                  value={importSourcePathInput}
                  onChange={(event) => {
                    setImportSourcePathInput(event.target.value);
                    invalidateWorkspaceImportPreview();
                  }}
                  placeholder={
                    importFormat === 'markdown'
                      ? '/Users/name/Documents/notes'
                      : '/Users/name/Downloads/recallx-export.json'
                  }
                />
              </label>
              <label className="search-box">
                <span>Import label</span>
                <input
                  value={importLabelInput}
                  onChange={(event) => {
                    setImportLabelInput(event.target.value);
                    invalidateWorkspaceImportPreview();
                  }}
                  placeholder="Imported project notes"
                />
              </label>
              <div className="info-grid three">
                <label className="search-box">
                  <span>Title cleanup</span>
                  <select
                    value={importOptions.normalizeTitleWhitespace ? 'normalize' : 'preserve'}
                    onChange={(event) => {
                      setImportOptions((current) => ({
                        ...current,
                        normalizeTitleWhitespace: event.target.value === 'normalize',
                      }));
                      invalidateWorkspaceImportPreview();
                    }}
                  >
                    <option value="normalize">Normalize whitespace</option>
                    <option value="preserve">Preserve existing spacing</option>
                  </select>
                </label>
                <label className="search-box">
                  <span>Body cleanup</span>
                  <select
                    value={importOptions.trimBodyWhitespace ? 'trim' : 'preserve'}
                    onChange={(event) => {
                      setImportOptions((current) => ({
                        ...current,
                        trimBodyWhitespace: event.target.value === 'trim',
                      }));
                      invalidateWorkspaceImportPreview();
                    }}
                  >
                    <option value="preserve">Preserve body spacing</option>
                    <option value="trim">Trim trailing blank lines</option>
                  </select>
                </label>
                <label className="search-box">
                  <span>Duplicate mode</span>
                  <select
                    value={importOptions.duplicateMode}
                    onChange={(event) => {
                      setImportOptions((current) => ({
                        ...current,
                        duplicateMode: event.target.value === 'skip_exact' ? 'skip_exact' : 'warn',
                      }));
                      invalidateWorkspaceImportPreview();
                    }}
                  >
                    <option value="warn">Warn only</option>
                    <option value="skip_exact">Skip exact duplicates</option>
                  </select>
                </label>
              </div>
              {workspaceImportError ? <div className="empty-state compact">{workspaceImportError}</div> : null}
              {workspaceImportPreview ? (
                <div className="card-stack compact-stack">
                  <div className="notice">
                    Previewed {workspaceImportPreview.nodesDetected} nodes, {workspaceImportPreview.relationsDetected} relations, and{' '}
                    {workspaceImportPreview.activitiesDetected} activities from {workspaceImportPreview.sourcePath}.
                  </div>
                  <div className="info-grid three">
                    <article className="info-block">
                      <span className="info-label">Ready</span>
                      <strong>{workspaceImportPreview.nodesReady} nodes</strong>
                      <p>{workspaceImportPreview.duplicateCandidates} likely duplicates detected.</p>
                    </article>
                    <article className="info-block">
                      <span className="info-label">Skipped if applied</span>
                      <strong>{workspaceImportPreview.skippedNodes} nodes</strong>
                      <p>
                        {workspaceImportPreview.skippedRelations} relations and {workspaceImportPreview.skippedActivities} activities would be
                        skipped.
                      </p>
                    </article>
                    <article className="info-block">
                      <span className="info-label">Normalization</span>
                      <strong>{workspaceImportPreview.options.normalizeTitleWhitespace ? 'Normalized titles' : 'Original spacing'}</strong>
                      <p>{workspaceImportPreview.options.trimBodyWhitespace ? 'Trailing blank lines trimmed.' : 'Body spacing preserved.'}</p>
                    </article>
                  </div>
                  {workspaceImportPreview.sampleItems.length ? (
                    <div className="card-stack compact-stack">
                      {workspaceImportPreview.sampleItems.map((item) => (
                        <div key={`${item.sourcePath}-${item.title}`} className="empty-state compact">
                          <strong>{item.title}</strong>
                          <div>{item.sourcePath}</div>
                          <div>{item.duplicateKind ? `Duplicate signal: ${item.duplicateKind}` : 'No duplicate signal detected.'}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {workspaceImportPreview.duplicateItems.length ? (
                    <div className="card-stack compact-stack">
                      {workspaceImportPreview.duplicateItems.map((item) => (
                        <div key={`${item.sourcePath}-${item.existingNodeId ?? item.existingNodeTitle ?? item.title}`} className="empty-state compact">
                          <strong>{item.title}</strong>
                          <div>{item.sourcePath}</div>
                          <div>
                            {item.matchType === 'exact' ? 'Exact duplicate' : 'Title match'} against{' '}
                            {item.existingSource === 'workspace' ? 'workspace content' : 'another item in this import'}.
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {lastWorkspaceImport ? (
                <div className="notice">
                  Imported {lastWorkspaceImport.nodesCreated} nodes, {lastWorkspaceImport.relationsCreated} relations, and{' '}
                  {lastWorkspaceImport.activitiesCreated} activities from {lastWorkspaceImport.sourcePath}. Skipped{' '}
                  {lastWorkspaceImport.skippedNodes} nodes, {lastWorkspaceImport.skippedRelations} relations, and{' '}
                  {lastWorkspaceImport.skippedActivities} activities.
                </div>
              ) : null}
              <div className="action-row">
                <button type="button" onClick={() => void handlePreviewWorkspaceImport()} disabled={isWorkspaceImportBusy || isWorkspaceImportPreviewBusy}>
                  {isWorkspaceImportPreviewBusy ? 'Previewing...' : 'Preview import'}
                </button>
                <button type="submit" disabled={isWorkspaceImportBusy || isWorkspaceImportPreviewBusy || !workspaceImportPreview}>
                  {isWorkspaceImportBusy ? 'Importing...' : 'Run import'}
                </button>
              </div>
            </form>
            <div className="info-grid three">
              <article className="info-block">
                <span className="info-label">Safety</span>
                <strong>Snapshot first</strong>
                <p>Backup runs before import.</p>
              </article>
              <article className="info-block">
                <span className="info-label">Provenance</span>
                <strong>{importsPath || 'Unavailable'}</strong>
                <p>Source files are copied into imports.</p>
              </article>
              <article className="info-block">
                <span className="info-label">Scope</span>
                <strong>v1 inbound path</strong>
                <p>Markdown and RecallX JSON are supported.</p>
              </article>
            </div>
            {lastWorkspaceImport?.warnings.length ? (
              <div className="card-stack compact-stack">
                {lastWorkspaceImport.warnings.map((warning) => (
                  <div key={warning} className="empty-state compact">
                    {warning}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
          <section id="mcp-status-card" tabIndex={-1} className="card page-card">
            <div className="page-copy">
              <span className="eyebrow">Launchers</span>
              <h3>CLI and MCP entrypoints</h3>
            </div>
            <div className="info-grid two">
              <article className="info-block">
                <span className="info-label">CLI version</span>
                <strong>{workspace?.name ? 'active workspace loaded' : 'Unavailable'}</strong>
                <p>Use `recallx update` to check npm updates for installed runtimes.</p>
              </article>
              <article className="info-block">
                <span className="info-label">MCP command</span>
                <strong>{mcpCommand}</strong>
                <p>Direct command for testing the MCP server outside editor integration.</p>
              </article>
            </div>
          </section>
        </section>
      );
    }

    if (view === 'recent') {
      return (
        <section className="page-section">
          <div className="page-heading">
            <span className="eyebrow">Memory</span>
            <h2>Browse memory</h2>
          </div>
          <div className="notes-toolbar">
            <section className="card notes-toolbar-card">
              <div className="page-copy compact-copy">
                <span className="eyebrow">Search</span>
                <h3>Find cards</h3>
              </div>
              <label className="search-box" htmlFor="notes-search-input">
                <span>Query</span>
                <input
                  id="notes-search-input"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search memory"
                />
              </label>
              <div className="chip-row">
                <span className="chip chip-static">
                  {deferredQuery.trim() ? `${filteredSearchTotal} filtered hits` : `${noteNodes.length} recent cards`}
                </span>
                <span className="chip chip-static">{workspaceName}</span>
                {deferredQuery.trim() ? <span className="chip chip-static">{searchPanel.total} backend hits</span> : null}
                <button type="button" className="chip-button" onClick={() => setIsCommandPaletteOpen(true)}>
                  Cmd/Ctrl+K
                </button>
              </div>
            </section>

            <section className="card notes-toolbar-card">
              <div className="page-copy compact-copy">
                <span className="eyebrow">Capture</span>
                <h3>Add memory</h3>
              </div>
              <form className="capture-form notes-capture-form" onSubmit={(event) => void handleCreateNode(event)}>
                <label className="search-box">
                  <span>Type</span>
                  <select value={captureType} onChange={(event) => setCaptureType(event.target.value as Node['type'])}>
                    <option value="note">note</option>
                    <option value="idea">idea</option>
                    <option value="question">question</option>
                    <option value="decision">decision</option>
                    <option value="reference">reference</option>
                    <option value="project">project</option>
                  </select>
                </label>
                <label className="search-box">
                  <span>Project</span>
                  <select value={captureProjectId} onChange={(event) => handleCaptureProjectSelection(event.target.value)}>
                    <option value="">No project</option>
                    {projectNodes.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="search-box">
                  <span>Title</span>
                  <input
                    id="capture-title-input"
                    value={captureTitle}
                    onChange={(event) => setCaptureTitle(event.target.value)}
                    placeholder="Note title"
                  />
                </label>
                <label className="search-box notes-capture-body">
                  <span>Body</span>
                  <textarea
                    value={captureBody}
                    onChange={(event) => setCaptureBody(event.target.value)}
                    placeholder="Write a concise note."
                    rows={3}
                  />
                </label>
                <div className="action-row">
                  <button type="submit" disabled={isSavingCapture}>
                    {isSavingCapture ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </form>
              {captureError ? <div className="empty-state compact">{captureError}</div> : null}
              {captureNotice ? <div className="notice">{captureNotice}</div> : null}
            </section>
          </div>

          {renderSearchRefinementControls('notes')}

          {searchPanel.error ? <div className="empty-state compact">{searchPanel.error}</div> : null}
          {searchPanel.isLoading ? <div className="empty-state compact">Searching the full workspace...</div> : null}

          {noteNodes.length ? (
            <section className="notes-board">
              {noteNodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className={`note-tile ${activeNoteNode?.id === node.id ? 'selected' : ''}`}
                  onClick={() => {
                    handleOpenSearchResult(node.id);
                  }}
                >
                  <div className="result-card__top">
                    <span className={`pill ${badgeTone(node.status)}`}>{node.type}</span>
                    <span className="note-tile-time">{formatTime(node.updatedAt)}</span>
                  </div>
                  <strong>{node.title ?? node.id}</strong>
                  <p>{node.summary || 'No summary yet.'}</p>
                  <div className="chip-row">
                    {node.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="meta-row">
                    <span>{node.sourceLabel ?? 'unknown'}</span>
                  </div>
                </button>
              ))}
            </section>
          ) : (
            <div className="empty-state">
              {deferredQuery.trim()
                ? 'No node hits matched this workspace query.'
                : snapshot?.nodes.length
                ? 'No cards match this query.'
                : 'There are no saved memory cards in the current workspace yet.'}
            </div>
          )}

          {noteActivityHits.length ? (
            <section className="card page-card">
              <div className="page-copy compact-copy">
                <span className="eyebrow">Activity hits</span>
                <h3>Recent movement that matched this search</h3>
              </div>
              <div className="card-stack compact-stack">
                {noteActivityHits.map((activity) => (
                  <button
                    key={activity.id}
                    type="button"
                    className="route-card"
                    onClick={() => {
                      if (activity.targetNodeId) {
                        handleOpenSearchResult(activity.targetNodeId);
                      }
                    }}
                  >
                    <div>
                      <strong>{activity.targetNodeTitle ?? activity.targetNodeId}</strong>
                      <span>{getActivityPreviewText(activity)}</span>
                      <div className="meta-row">
                        <span>{getActivityTypeLabel(activity)}</span>
                        <span>{activity.sourceLabel}</span>
                      </div>
                    </div>
                    <em>{formatTime(activity.createdAt)}</em>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {notePreviewNode ? (
            <div
              className="note-overlay"
              onClick={() => {
                setNotePreviewTargetId(null);
                setIsEditingNote(false);
                setNoteEditError(null);
              }}
            >
              <section
                className="card note-modal"
                onClick={(event) => {
                  event.stopPropagation();
                }}
              >
                <div className="section-head section-head--compact">
                  <div>
                    <span className="eyebrow">Selected note</span>
                    <h3>{isEditingNote ? 'Edit note' : notePreviewNode.title}</h3>
                  </div>
                  <div className="note-modal-actions">
                    <span className={`pill ${badgeTone(notePreviewNode.status)}`}>{notePreviewNode.type}</span>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setNotePreviewTargetId(null);
                        setIsEditingNote(false);
                        setNoteEditError(null);
                      }}
                    >
                      Close
                    </button>
                  </div>
                </div>
                {isEditingNote ? (
                  <div className="capture-form compact-form">
                    <label className="search-box" htmlFor="note-edit-title-input">
                      <span>Title</span>
                      <input
                        id="note-edit-title-input"
                        value={noteEditTitle}
                        onChange={(event) => setNoteEditTitle(event.target.value)}
                        placeholder="Short durable title"
                      />
                    </label>
                    <label className="search-box notes-capture-body" htmlFor="note-edit-body-input">
                      <span>Body</span>
                      <textarea
                        id="note-edit-body-input"
                        value={noteEditBody}
                        onChange={(event) => setNoteEditBody(event.target.value)}
                        placeholder="Keep the memory concise and attributable."
                        rows={8}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="note-reading-pane">{notePreviewNode.body || notePreviewNode.summary}</div>
                )}
                {noteEditError ? <div className="empty-state compact">{noteEditError}</div> : null}
                {notePreviewSupportsGovernanceActions && !isEditingNote ? (
                  <div className="card-stack compact-stack">
                    <article className="mini-card">
                      <strong>Governance actions</strong>
                      <p>Use a direct human decision here when this note should be promoted, contested, or archived.</p>
                    </article>
                    <label className="search-box" htmlFor="note-governance-decision-note">
                      <span>Decision note</span>
                      <textarea
                        id="note-governance-decision-note"
                        value={governanceDecisionNote}
                        onChange={(event) => setGovernanceDecisionNote(event.target.value)}
                        placeholder="Optional short rationale for this governance decision."
                        rows={3}
                      />
                    </label>
                    <div className="action-row">
                      {canPromoteNode(notePreviewNode) ? (
                        <button
                          type="button"
                          onClick={() => notePreviewNode && void handleApplyNodeGovernanceAction('promote', notePreviewNode)}
                          disabled={governanceActionPending !== null}
                        >
                          {governanceActionPending === 'promote' ? 'Promoting...' : 'Promote'}
                        </button>
                      ) : null}
                      {canContestNode(notePreviewNode) ? (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => notePreviewNode && void handleApplyNodeGovernanceAction('contest', notePreviewNode)}
                          disabled={governanceActionPending !== null}
                        >
                          {governanceActionPending === 'contest' ? 'Marking...' : 'Mark contested'}
                        </button>
                      ) : null}
                      {canArchiveNode(notePreviewNode) ? (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => notePreviewNode && void handleApplyNodeGovernanceAction('archive', notePreviewNode)}
                          disabled={governanceActionPending !== null}
                        >
                          {governanceActionPending === 'archive' ? 'Archiving...' : 'Archive suggestion'}
                        </button>
                      ) : null}
                    </div>
                    {governanceActionError ? <div className="empty-state compact">{governanceActionError}</div> : null}
                  </div>
                ) : null}
                {notePreviewReviewActions.length && !isEditingNote ? (
                  <div className="card-stack compact-stack">
                    <article className="mini-card">
                      <strong>Review recall</strong>
                      <p>Recent manual trust decisions for this note stay visible here so you can reopen the surrounding context quickly.</p>
                    </article>
                    {notePreviewReviewActions.slice(0, 3).map((activity) => (
                      <article key={activity.id} className="mini-card">
                        <strong>{getActivityTypeLabel(activity)}</strong>
                        <p>{getActivityPreviewText(activity)}</p>
                        {getReviewActionProvenanceText(activity) ? (
                          <div className="meta-row">
                            <span>{getReviewActionProvenanceText(activity)}</span>
                          </div>
                        ) : null}
                        <div className="meta-row">
                          <span>{formatTime(activity.createdAt)}</span>
                          <span>{activity.sourceLabel}</span>
                        </div>
                      </article>
                    ))}
                    <div className="action-row">
                      <button type="button" onClick={() => selectView('governance')}>
                        Open governance
                      </button>
                      <button type="button" className="ghost" onClick={() => openNodeInGraph(notePreviewNode.id)}>
                        Inspect in graph
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="chip-row">
                  {notePreviewNode.tags.map((tag) => (
                    <span key={tag} className="chip">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="action-row">
                  {isEditingNote ? (
                    <>
                      <button type="button" onClick={() => void handleSaveNoteEdit()} disabled={isSavingNoteEdit || isArchivingNote || governanceActionPending !== null}>
                        {isSavingNoteEdit ? 'Saving...' : 'Save changes'}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          setIsEditingNote(false);
                          setNoteEditTitle(notePreviewNode.title);
                          setNoteEditBody(notePreviewNode.body);
                          setNoteEditError(null);
                        }}
                        disabled={isSavingNoteEdit || isArchivingNote || governanceActionPending !== null}
                      >
                        Cancel
                      </button>
                      <button type="button" className="ghost" onClick={() => void handleArchiveNote()} disabled={isSavingNoteEdit || isArchivingNote || governanceActionPending !== null}>
                        {isArchivingNote ? 'Archiving...' : 'Archive'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => openNodeInGraph(notePreviewNode.id)}>
                        Inspect in graph
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void handleRefreshSummary()}
                        disabled={isRefreshingSummary}
                      >
                        {isRefreshingSummary ? 'Refreshing...' : 'Refresh summary'}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          setIsEditingNote(true);
                          setNoteEditTitle(notePreviewNode.title);
                          setNoteEditBody(notePreviewNode.body);
                          setNoteEditError(null);
                        }}
                        disabled={isArchivingNote || governanceActionPending !== null}
                      >
                        Edit
                      </button>
                      {!notePreviewSupportsGovernanceActions ? (
                        <button type="button" className="ghost" onClick={() => void handleArchiveNote()} disabled={isArchivingNote || governanceActionPending !== null}>
                          {isArchivingNote ? 'Archiving...' : 'Archive'}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
                {detail.governance.events.length ? (
                  <div className="card-stack compact-stack">
                    {detail.governance.events.slice(0, 3).map((event) => (
                      <article key={event.id} className="mini-card">
                        <strong>{event.eventType}</strong>
                        <p>{event.reason}</p>
                      </article>
                    ))}
                  </div>
                ) : null}
                <div className="card-stack compact-stack">
                  {detail.bundleItems.slice(0, 2).map((item) => (
                    <button
                      key={item.nodeId}
                      type="button"
                      className="mini-card mini-card--interactive"
                      onClick={() => void handleBundlePreviewClick(item)}
                    >
                      <strong>{item.title ?? item.nodeId}</strong>
                      <p>{item.reason}</p>
                    </button>
                  ))}
                  {detail.activities.slice(0, 2).map((activity) => (
                    <article key={activity.id} className="mini-card">
                      <strong>{getActivityTypeLabel(activity)}</strong>
                      <p>{getActivityPreviewText(activity)}</p>
                    </article>
                  ))}
                </div>
              </section>
            </div>
          ) : null}
        </section>
      );
    }

    return (
      <section className="page-section home-section">
        <div className="home-shell">
          <section className="card home-hero-card">
            <div className="page-copy">
              <span className="eyebrow">Home</span>
              <h2>Search workspace</h2>
              <p>Find the next useful memory.</p>
            </div>
            <label className="search-box home-search-box" htmlFor="home-search-input">
              <span>Workspace-wide search</span>
              <input
                id="home-search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="projects, decisions, questions, recent activity"
              />
            </label>
            <div className="chip-row">
              <span className="chip chip-static">{pinnedProjectNodes.length} active projects</span>
              <span className="chip chip-static">{homeRecentNodes.length} recent nodes</span>
              <span className="chip chip-static">{governanceIssues.length} review signals</span>
              <span className="chip chip-static">{activeProjectNode ? `focus ${activeProjectNode.title}` : 'no active project'}</span>
              {deferredQuery.trim() ? <span className="chip chip-static">{filteredSearchTotal} filtered hits</span> : null}
            </div>
            <div className="hero-actions">
              <button type="button" className="hero-button hero-button--primary" onClick={() => selectView('recent')}>
                Open Memory
              </button>
              <button type="button" className="hero-button hero-button--secondary" onClick={() => setIsCommandPaletteOpen(true)}>
                Command
              </button>
              <button type="button" className="hero-button hero-button--secondary" onClick={() => selectView('graph')}>
                Graph
              </button>
              <button type="button" className="hero-button hero-button--secondary" onClick={() => selectView('governance')}>
                Review
              </button>
              <button type="button" className="hero-button hero-button--secondary" onClick={() => selectView('settings')}>
                Workspace
              </button>
            </div>
          </section>

          <aside className="card home-summary-card">
            <div className="page-copy">
              <span className="eyebrow">Workspace</span>
              <h3>{workspaceName}</h3>
              <p>
                {activeProjectNode ? `${activeProjectNode.title} is active.` : 'Set one active project.'}
              </p>
            </div>
            <div className="info-grid two">
              <article className="info-block">
                <span className="info-label">Projects</span>
                <strong>{projectNodes.length}</strong>
                <p>Visible now.</p>
              </article>
              <article className="info-block">
                <span className="info-label">Recent nodes</span>
                <strong>{snapshot?.recentNodeIds.length ?? 0}</strong>
                <p>Ready to reopen.</p>
              </article>
              <article className="info-block">
                <span className="info-label">Review</span>
                <strong>{governanceIssues.length || 'clear'}</strong>
                <p>Open signals.</p>
              </article>
              <article className="info-block">
                <span className="info-label">API</span>
                <strong>{workspace?.apiBind ?? '127.0.0.1:8787'}</strong>
                <p>Local access.</p>
              </article>
            </div>
          </aside>
        </div>

        {searchPanel.error ? <div className="empty-state compact">{searchPanel.error}</div> : null}
        {searchPanel.isLoading ? <div className="empty-state compact">Searching the full workspace...</div> : null}
        {renderSearchRefinementControls('home')}

        {deferredQuery.trim() ? (
          <section className="home-results-grid">
            <section className="card page-card">
              <div className="section-head section-head--compact">
                <div>
                  <span className="eyebrow">Search results</span>
                  <h3>Matching memory</h3>
                </div>
                <span className="pill tone-info">{homeSearchNodes.length}</span>
              </div>
              <div className="card-stack">
                {homeSearchNodes.map((node) => (
                  <button key={node.id} type="button" className="route-card" onClick={() => handleOpenSearchResult(node.id)}>
                    <div>
                      <strong>{node.title ?? node.id}</strong>
                      <span>{node.summary ?? 'No summary yet.'}</span>
                      <div className="meta-row">
                        <span>{node.type}</span>
                        <span>{node.sourceLabel ?? 'unknown'}</span>
                        <span>{formatTime(node.updatedAt)}</span>
                      </div>
                    </div>
                    <em>Open</em>
                  </button>
                ))}
                {!homeSearchNodes.length ? <div className="empty-state compact">No node hits matched this search yet.</div> : null}
              </div>
            </section>

            <section className="card page-card">
              <div className="section-head section-head--compact">
                <div>
                  <span className="eyebrow">Activity hits</span>
                  <h3>Matching activity</h3>
                </div>
                <span className="pill tone-muted">{homeSearchActivityHits.length}</span>
              </div>
              <div className="card-stack">
                {homeSearchActivityHits.map((activity) => (
                  <button
                    key={activity.id}
                    type="button"
                    className="route-card"
                    onClick={() => {
                      if (activity.targetNodeId) {
                        handleOpenSearchResult(activity.targetNodeId);
                      }
                    }}
                  >
                    <div>
                      <strong>{activity.targetNodeTitle ?? activity.targetNodeId}</strong>
                      <span>{getActivityPreviewText(activity)}</span>
                      <div className="meta-row">
                        <span>{getActivityTypeLabel(activity)}</span>
                        <span>{activity.sourceLabel}</span>
                        <span>{formatTime(activity.createdAt)}</span>
                      </div>
                    </div>
                    <em>Jump</em>
                  </button>
                ))}
                {!homeSearchActivityHits.length ? (
                  <div className="empty-state compact">No activity hits matched this workspace query.</div>
                ) : null}
              </div>
            </section>
          </section>
        ) : (
          <section className="home-results-grid">
            <section className="card page-card home-digest-card">
              <div className="section-head section-head--compact">
                <div>
                  <span className="eyebrow">Active project</span>
                  <h3>{activeProjectNode?.title ?? 'Choose a project anchor'}</h3>
                </div>
                <span className={`pill ${activeProjectNode ? badgeTone(activeProjectNode.status) : 'tone-muted'}`}>
                  {isSavingActiveProject ? 'Saving...' : activeProjectNode ? activeProjectNode.canonicality : 'unset'}
                </span>
              </div>

              {activeProjectNode ? (
                <>
                  <p className="home-digest-copy">
                    {activeProjectNode.summary || 'Active for Home, capture, and graph.'}
                  </p>
                  <div className="chip-row">
                    <span className="chip chip-static">{activeProjectDigest.relatedCount} related nodes</span>
                    <span className="chip chip-static">{activeProjectDigest.activities.length} recent activities</span>
                    <span className="chip chip-static">{activeProjectDigest.bundleItems.length} nearby context items</span>
                  </div>
                  <div className="action-row">
                    <button type="button" onClick={() => openNodeInGraph(activeProjectNode.id)}>
                      Open project map
                    </button>
                    <button type="button" className="ghost" onClick={() => openNodeInRecent(activeProjectNode.id)}>
                      Memory
                    </button>
                    <button type="button" className="ghost" onClick={() => void handleSetActiveProject(null)} disabled={isSavingActiveProject}>
                      Clear active project
                    </button>
                  </div>
                  {isActiveProjectDigestLoading ? <div className="empty-state compact">Loading project digest...</div> : null}
                  {activeProjectError ? <div className="empty-state compact">{activeProjectError}</div> : null}
                  <div className="card-stack compact-stack">
                    {activeProjectDigest.bundleItems.map((item) => (
                      <button
                        key={item.nodeId}
                        type="button"
                        className="mini-card mini-card--interactive"
                        onClick={() => void handleActiveProjectBundleClick(item)}
                      >
                        <strong>{item.title ?? item.nodeId}</strong>
                        <p>{item.reason}</p>
                      </button>
                    ))}
                    {activeProjectDigest.activities.map((activity) => (
                      <article key={activity.id} className="mini-card">
                        <strong>{activity.activityType}</strong>
                        <p>{activity.body || 'Recent project activity'}</p>
                      </article>
                    ))}
                    {!activeProjectDigest.bundleItems.length && !activeProjectDigest.activities.length && !isActiveProjectDigestLoading ? (
                      <div className="empty-state compact">No nearby project context yet.</div>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <p className="home-digest-copy">
                    Pick one project to keep Home and graph aligned.
                  </p>
                  <div className="action-row">
                    <button
                      type="button"
                      onClick={() => {
                        if (homeSuggestedProjectNode) {
                          void handleSetActiveProject(homeSuggestedProjectNode.id);
                        }
                      }}
                      disabled={!homeSuggestedProjectNode || isSavingActiveProject}
                    >
                      {homeSuggestedProjectNode ? `Set ${homeSuggestedProjectNode.title}` : 'Add a project first'}
                    </button>
                    <button type="button" className="ghost" onClick={() => selectView('recent')}>
                      Open memory
                    </button>
                  </div>
                  {activeProjectError ? <div className="empty-state compact">{activeProjectError}</div> : null}
                </>
              )}
            </section>

            <section className="card page-card">
              <div className="section-head section-head--compact">
                <div>
                  <span className="eyebrow">Active projects</span>
                  <h3>Project memory</h3>
                </div>
              </div>
              <div className="home-project-grid">
                {pinnedProjectNodes.map((node) => (
                  <article key={node.id} className={`note-tile home-project-card ${activeProjectNode?.id === node.id ? 'selected' : ''}`}>
                    <div className="result-card__top">
                      <span className={`pill ${badgeTone(node.status)}`}>{node.type}</span>
                      <span className="note-tile-time">{formatTime(node.updatedAt)}</span>
                    </div>
                    <strong>{node.title}</strong>
                    <p>{node.summary || 'No summary yet.'}</p>
                    <div className="chip-row">
                      <span className="chip chip-static">{node.canonicality}</span>
                      <span className="chip chip-static">{node.sourceLabel}</span>
                    </div>
                    <div className="home-project-card-actions">
                      <button type="button" onClick={() => openNodeInGraph(node.id)}>
                        Open
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void handleSetActiveProject(node.id)}
                        disabled={isSavingActiveProject}
                      >
                        {activeProjectNode?.id === node.id ? 'Active' : 'Make active'}
                      </button>
                    </div>
                  </article>
                ))}
                {!pinnedProjectNodes.length ? <div className="empty-state">No project nodes are available yet.</div> : null}
              </div>
            </section>

            <section className="card page-card home-governance-card">
              <div className="section-head section-head--compact">
                <div>
                  <span className="eyebrow">Review</span>
                  <h3>Recent review signals</h3>
                </div>
                <span className="pill tone-muted">{homeGovernanceFeed.length}</span>
              </div>
              <div className="chip-row">
                <span className="chip chip-static">
                  {governanceFeedEntityFilter === 'all' ? 'all entities' : `${governanceFeedEntityFilter} only`}
                </span>
                <span className="chip chip-static">
                  {governanceFeedActionFilter === 'all'
                    ? 'all actions'
                    : `${getGovernanceDecisionActionLabel(governanceFeedActionFilter)} decisions`}
                </span>
                <span className="chip chip-static">{governanceFeed.length} recent decisions</span>
              </div>
              <div className="action-row">
                <button type="button" onClick={() => selectView('governance')}>
                  Open review
                </button>
                {governanceFeedEntityFilter !== 'all' || governanceFeedActionFilter !== 'all' ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setGovernanceFeedEntityFilter('all');
                      setGovernanceFeedActionFilter('all');
                    }}
                  >
                    Clear feed filters
                  </button>
                ) : null}
              </div>
              <div className="card-stack compact-stack">
                {isGovernanceFeedLoading ? (
                  <div className="empty-state compact">Loading recent governance decisions...</div>
                ) : null}
                {!isGovernanceFeedLoading
                  ? homeGovernanceFeed.map((event) => (
                      <article key={event.id} className="mini-card governance-feed-card">
                        <div className="result-card__top">
                          <div>
                            <strong>{event.title ?? formatCompactId(`${event.entityType}:${event.entityId}`)}</strong>
                            <p>{event.reason}</p>
                          </div>
                          <span className={`pill ${badgeTone(event.nextState)}`}>{getGovernanceDecisionActionLabel(event.action)}</span>
                        </div>
                        <div className="meta-row">
                          <span>{getGovernanceFeedProvenanceText(event)}</span>
                        </div>
                        <div className="meta-row">
                          <span>{formatTime(event.createdAt)}</span>
                          <span>{event.entityType}</span>
                          {event.relationType ? <span>{relationLabel(event.relationType)}</span> : null}
                        </div>
                        <div className="action-row governance-feed-card__actions">
                          <button type="button" onClick={() => inspectGovernanceFeedItem(event)}>
                            Open
                          </button>
                          <button type="button" className="ghost" onClick={() => openGovernanceFeedGraph(event)}>
                            Graph
                          </button>
                          {hasOpenGovernanceIssueForFeedItem(governanceIssues, event) ? (
                            <button type="button" className="ghost" onClick={() => handleOpenGovernanceFeedItem(event)}>
                              Issue
                            </button>
                          ) : null}
                        </div>
                      </article>
                    ))
                  : null}
                {!isGovernanceFeedLoading && !governanceFeed.length ? (
                  <div className="empty-state compact">No recent manual governance decisions are available for Home yet.</div>
                ) : null}
              </div>
            </section>

            <section className="card page-card home-semantic-card">
              <div className="section-head section-head--compact">
                <div>
                  <span className="eyebrow">Semantic</span>
                  <h3>Index status</h3>
                </div>
                <span className={`pill ${semanticStatus?.enabled ? 'tone-good' : 'tone-muted'}`}>
                  {semanticStatus?.enabled ? 'enabled' : 'disabled'}
                </span>
              </div>
              <div className="chip-row">
                <span className="chip chip-static">{semanticStatus?.provider ?? 'loading'} </span>
                <span className="chip chip-static">{semanticStatus?.model ?? 'loading'} </span>
                <span className="chip chip-static">{semanticStatus?.indexBackend ?? 'sqlite'}</span>
                <span className="chip chip-static">
                  {semanticStatus?.lastBackfillAt ? `last reindex ${formatTime(semanticStatus.lastBackfillAt)}` : 'no reindex yet'}
                </span>
              </div>
              <div className="info-grid five semantic-count-grid">
                {semanticCountCards.map((item) => (
                  <article key={item.key} className="info-block semantic-count-card">
                    <span className="info-label">{item.label}</span>
                    <strong>{item.value}</strong>
                  </article>
                ))}
              </div>
              <div className="semantic-card-toolbar">
                <div className="chip-row">
                  {semanticIssueFilterOptions.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`tool-chip ${semanticIssueFilter === value ? 'tool-chip--active' : ''}`}
                      onClick={() => setSemanticIssueFilter(value)}
                      disabled={isSemanticIssuesLoading || isSemanticStatusLoading || isSemanticReindexing}
                    >
                      {value === 'all' ? 'All' : value.charAt(0).toUpperCase() + value.slice(1)}
                    </button>
                  ))}
                </div>
                <div className="action-row semantic-card-actions">
                  <button type="button" onClick={() => void handleSemanticReindex()} disabled={isSemanticReindexing}>
                    {isSemanticReindexing ? 'Queueing...' : 'Reindex workspace'}
                  </button>
                </div>
              </div>
              {semanticNotice ? <div className="notice">{semanticNotice}</div> : null}
              {semanticError ? <div className="empty-state compact">{semanticError}</div> : null}
              {isSemanticStatusLoading || isSemanticIssuesLoading ? (
                <div className="empty-state compact">Loading semantic status...</div>
              ) : null}
              {!isSemanticStatusLoading && !isSemanticIssuesLoading ? (
                <div className="card-stack compact-stack semantic-issue-list">
                  {semanticIssues.map((item) => (
                    <article key={item.nodeId} className="mini-card semantic-issue-card">
                      <div className="result-card__top">
                        <div>
                          <strong>{item.title}</strong>
                          <p>{item.staleReason ?? 'Semantic work is queued for this note.'}</p>
                        </div>
                        <span className={`pill ${semanticIssueTone(item.embeddingStatus)}`}>{item.embeddingStatus}</span>
                      </div>
                      <div className="meta-row">
                        <span>{formatCompactId(item.nodeId)}</span>
                        <span>{formatTime(item.updatedAt)}</span>
                      </div>
                    </article>
                  ))}
                  {!semanticIssues.length ? (
                    <div className="empty-state compact">No semantic issues match this filter.</div>
                  ) : null}
                </div>
              ) : null}
              {semanticIssuesCursor ? (
                <div className="action-row semantic-card-footer">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void handleLoadMoreSemanticIssues()}
                    disabled={isSemanticIssuesLoadingMore || isSemanticReindexing}
                  >
                    {isSemanticIssuesLoadingMore ? 'Loading...' : 'Load more'}
                  </button>
                </div>
              ) : null}
            </section>

            <section className="card page-card">
              <div className="section-head section-head--compact">
                <div>
                  <span className="eyebrow">Recent movement</span>
                  <h3>Return to the latest durable changes</h3>
                </div>
              </div>
              <div className="card-stack">
                {homeRecentNodes.map((node) => (
                  <button key={node.id} type="button" className="route-card" onClick={() => openNodeInRecent(node.id)}>
                    <div>
                      <strong>{node.title}</strong>
                      <span>{node.summary || 'No summary yet.'}</span>
                      <div className="meta-row">
                        <span>{node.type}</span>
                        <span>{node.sourceLabel}</span>
                        <span>{formatTime(node.updatedAt)}</span>
                      </div>
                    </div>
                    <em>Open</em>
                  </button>
                ))}
                {!homeRecentNodes.length ? <div className="empty-state compact">No recent nodes are available yet.</div> : null}
              </div>
            </section>
          </section>
        )}
      </section>
    );
  })();

  return (
    <div className="app-shell">
      <main className="workspace">
        <div className="workspace-shell">
          <aside className="sidebar">
            <div className="sidebar-brand">
              <div className="brand">
                <span className="brand-mark" />
                <div>
                  <strong>{workspaceName}</strong>
                  <p>RecallX</p>
                </div>
              </div>
            </div>
            <nav className="nav-list nav-list--sidebar" aria-label="Main navigation">
              {navigation.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nav-item ${view === item.id ? 'active' : ''}`}
                  onClick={() => selectView(item.id)}
                >
                  <span>{item.label}</span>
                  <small>{item.hint}</small>
                </button>
              ))}
            </nav>
            <div className="sidebar-divider" />
            <div className="utility-nav utility-nav--sidebar" aria-label="Utility navigation">
              {utilityNavigation.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`utility-nav-item ${
                    item.id === 'project-map'
                      ? view === 'graph' && graphMode === 'project-map'
                        ? 'active'
                        : ''
                      : view === item.id
                        ? 'active'
                        : ''
                  }`}
                  onClick={() => {
                    if (item.id === 'project-map') {
                      setGraphMode('project-map');
                      selectView('graph');
                      return;
                    }

                    if (item.id === 'graph') {
                      setGraphMode('neighborhood');
                    }
                    selectView(item.id);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="sidebar-meta">
              <span className="sidebar-meta-label">Active project</span>
              <strong>{activeProjectNode?.title ?? 'None'}</strong>
              <p>{workspace?.apiBind ?? '127.0.0.1:8787'}</p>
            </div>
            <div className="sidebar-actions">
              <button type="button" className="sidebar-action sidebar-action--primary" onClick={() => setIsCommandPaletteOpen(true)}>
                Command
              </button>
              <button type="button" className="sidebar-action" onClick={() => selectView('search')}>
                API guide
              </button>
            </div>
          </aside>
          <section className="workspace-main">
            <header className="topbar">
              <div className="topbar-heading">
                <span className="eyebrow">Current view</span>
                <h1>{getViewTitle(view)}</h1>
              </div>
              <div className="topbar-meta">
                <span>{workspace?.integrationModes.join(' / ') || 'local / append-only'}</span>
                <span>{workspace?.apiBind ?? '127.0.0.1:8787'}</span>
              </div>
            </header>
            {loadError && snapshot ? <div className="banner">{loadError}</div> : null}
            <div className="workspace-body">{pageContent}</div>
          </section>
        </div>
        {isCommandPaletteOpen ? (
          <div
            className="command-palette-overlay"
            onClick={() => {
              setIsCommandPaletteOpen(false);
            }}
          >
            <section
              className="card command-palette-modal"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <div className="section-head section-head--compact">
                <div>
                  <span className="eyebrow">Command palette</span>
                  <h3>Jump quickly without changing the product shape</h3>
                </div>
                <button type="button" className="ghost" onClick={() => setIsCommandPaletteOpen(false)}>
                  Close
                </button>
              </div>
              <label className="search-box" htmlFor="command-palette-input">
                <span>Query</span>
                <input
                  id="command-palette-input"
                  ref={commandPaletteInputRef}
                  value={paletteQuery}
                  onChange={(event) => setPaletteQuery(event.target.value)}
                  placeholder="routes, recent searches, recent nodes"
                />
              </label>
              <div className="command-palette-tabs">
                {[
                  ['routes', 'Routes'],
                  ['searches', 'Recent searches'],
                  ['nodes', 'Recent nodes'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`chip-button ${paletteSection === value ? 'active' : ''}`}
                    onClick={() => setPaletteSection(value as PaletteSection)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="command-palette-results">
                {paletteSection === 'routes' ? (
                  <>
                    {recentPaletteCommands.length ? (
                      <div className="command-palette-group">
                        <span className="search-filter-label">Recent commands</span>
                        <div className="card-stack compact-stack">
                          {recentPaletteCommands.map((command) => (
                            <button
                              key={`recent-${command.label}`}
                              type="button"
                              className="route-card command-palette-result"
                              onClick={() => handleRunPaletteCommand(command)}
                            >
                              <div>
                                <strong>{command.label}</strong>
                                <span>{command.hint}</span>
                              </div>
                              <em>Recent</em>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {filteredPaletteRouteCommands.map((command) => (
                      <button
                        key={command.label}
                        type="button"
                        className="route-card command-palette-result"
                        onClick={() => handleRunPaletteCommand(command)}
                      >
                        <div>
                          <strong>{command.label}</strong>
                          <span>{command.hint}</span>
                        </div>
                        <em>Run</em>
                      </button>
                    ))}
                  </>
                ) : null}
                {paletteSection === 'searches'
                  ? filteredPaletteRecentSearches.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className="route-card command-palette-result"
                        onClick={() => handleApplyRecentSearch(item)}
                      >
                        <div>
                          <strong>{item}</strong>
                          <span>Reuse a recent workspace query</span>
                        </div>
                        <em>Search</em>
                      </button>
                    ))
                  : null}
                {paletteSection === 'nodes'
                  ? filteredPaletteRecentNodes.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        className="route-card command-palette-result"
                        onClick={() => handleOpenPaletteNode(node.id)}
                      >
                        <div>
                          <strong>{node.title}</strong>
                          <span>{node.summary || node.type}</span>
                        </div>
                        <em>{node.type}</em>
                      </button>
                    ))
                  : null}
                {paletteSection === 'routes' && !filteredPaletteRouteCommands.length ? (
                  <div className="empty-state compact">No route commands matched this palette query.</div>
                ) : null}
                {paletteSection === 'searches' && !filteredPaletteRecentSearches.length ? (
                  <div className="empty-state compact">No recent searches are stored yet.</div>
                ) : null}
                {paletteSection === 'nodes' && !filteredPaletteRecentNodes.length ? (
                  <div className="empty-state compact">No recent nodes matched this palette query.</div>
                ) : null}
              </div>
              <div className="chip-row">
                <span className="chip chip-static">Cmd/Ctrl+K</span>
                <span className="chip chip-static">{recentCommands.length} recent commands</span>
                <span className="chip chip-static">{recentSearches.length} recent searches</span>
              </div>
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
