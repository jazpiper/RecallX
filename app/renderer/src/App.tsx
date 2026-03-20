import { useDeferredValue, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import {
  appendRelationUsageEvent,
  clearRendererToken,
  createWorkspace as createWorkspaceSession,
  createNode,
  getBootstrap,
  getContextBundlePreview,
  getGovernanceIssues,
  getNodeDetail,
  getGraphNeighborhood,
  getSemanticIssues,
  getSemanticStatus,
  getSnapshot,
  getWorkspaceCatalog,
  getWorkspace,
  isAuthError,
  openWorkspace as openWorkspaceSession,
  queueSemanticReindex,
  queueSemanticReindexForNode,
  refreshNodeSummary as refreshNodeSummaryRequest,
  saveRendererToken,
  searchWorkspace,
  subscribeWorkspaceEvents,
} from './lib/mockApi';
import type {
  Activity,
  Artifact,
  ContextBundlePreviewItem,
  GovernanceEventRecord,
  GovernanceIssueItem,
  GovernancePayload,
  GraphConnection,
  NavView,
  NodeDetail,
  Node,
  SearchResultItem,
  SemanticIssueItem,
  SemanticStatusSummary,
  WorkspaceCatalogItem,
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

type SemanticIssueFilter = 'all' | 'failed' | 'stale' | 'pending';
type SearchScope = 'nodes' | 'activities';

const navigation: { id: NavView; label: string; hint: string }[] = [
  { id: 'home', label: 'Home', hint: 're-entry' },
  { id: 'search', label: 'Search', hint: 'retrieval' },
  { id: 'projects', label: 'Projects', hint: 'core nodes' },
  { id: 'recent', label: 'Recent', hint: 'latest work' },
  { id: 'governance', label: 'Governance', hint: 'automation' },
  { id: 'graph', label: 'Graph', hint: 'secondary' },
  { id: 'settings', label: 'Settings', hint: 'workspace' },
];

const DEFAULT_SEMANTIC_COUNTS = {
  pending: 0,
  processing: 0,
  stale: 0,
  ready: 0,
  failed: 0,
};

const SEMANTIC_ISSUE_FILTERS: SemanticIssueFilter[] = ['all', 'failed', 'stale', 'pending'];
const SEARCH_SCOPE_OPTIONS: Array<{ id: SearchScope | 'all'; label: string; scopes: SearchScope[] }> = [
  { id: 'all', label: 'All', scopes: ['nodes', 'activities'] },
  { id: 'nodes', label: 'Nodes', scopes: ['nodes'] },
  { id: 'activities', label: 'Activities', scopes: ['activities'] },
];

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

function formatMaybeTime(iso: string | null) {
  return iso ? formatTime(iso) : 'Not run yet';
}

function handleSearchSubmit(
  event: React.FormEvent<HTMLFormElement>,
  options: { query: string; onSelectSearch: () => void }
) {
  event.preventDefault();
  if (!options.query.trim()) {
    return;
  }
  options.onSelectSearch();
}

function semanticIssueFilterLabel(filter: SemanticIssueFilter) {
  switch (filter) {
    case 'failed':
      return 'failed issues';
    case 'stale':
      return 'stale issues';
    case 'pending':
      return 'pending issues';
    default:
      return 'all issue buckets';
  }
}

function semanticIssueEmptyState(filter: SemanticIssueFilter) {
  switch (filter) {
    case 'failed':
      return 'No failed semantic issues in this workspace slice.';
    case 'stale':
      return 'No stale semantic issues in this workspace slice.';
    case 'pending':
      return 'No pending semantic issues in this workspace slice.';
    default:
      return 'No semantic issues to triage right now.';
  }
}

function getSummaryLifecycle(node: Node | null) {
  if (!node) {
    return {
      summaryUpdatedAt: null as string | null,
      summarySource: null as string | null,
      isStale: false,
    };
  }

  const summaryUpdatedAt =
    typeof node.metadata.summaryUpdatedAt === 'string' ? node.metadata.summaryUpdatedAt : null;
  const summarySource = typeof node.metadata.summarySource === 'string' ? node.metadata.summarySource : null;
  const isStale = summaryUpdatedAt
    ? new Date(node.updatedAt).getTime() - new Date(summaryUpdatedAt).getTime() > 1000
    : false;

  return {
    summaryUpdatedAt,
    summarySource,
    isStale,
  };
}

function getSearchResultKey(item: SearchResultItem) {
  return item.resultType === 'node' ? item.node?.id ?? 'node-unknown' : item.activity?.id ?? 'activity-unknown';
}

function getSearchResultNodeId(item: SearchResultItem) {
  return item.resultType === 'node' ? item.node?.id ?? null : item.activity?.targetNodeId ?? null;
}

function getSearchResultTitle(item: SearchResultItem) {
  if (item.resultType === 'node') {
    return item.node?.title ?? 'Untitled node';
  }
  return item.activity?.targetNodeTitle ?? item.activity?.targetNodeId ?? 'Activity';
}

function getSearchResultSummary(item: SearchResultItem) {
  if (item.resultType === 'node') {
    return item.node?.summary ?? 'No summary yet.';
  }
  return item.activity?.body ?? 'No activity body available.';
}

function getSearchResultBadge(item: SearchResultItem) {
  if (item.resultType === 'node') {
    return item.node?.type ?? 'node';
  }
  return item.activity?.activityType ?? 'activity';
}

function getSearchResultStatus(item: SearchResultItem) {
  if (item.resultType === 'node') {
    return item.node?.status ?? 'draft';
  }
  return item.activity?.targetNodeStatus ?? 'draft';
}

function getSearchResultMeta(item: SearchResultItem) {
  if (item.resultType === 'node') {
    return {
      source: item.node?.sourceLabel ?? 'unknown',
      updatedAt: item.node?.updatedAt ?? item.node?.createdAt ?? new Date().toISOString(),
    };
  }
  return {
    source: item.activity?.sourceLabel ?? 'unknown',
    updatedAt: item.activity?.createdAt ?? new Date().toISOString(),
  };
}

function getSearchScopeMode(scopes: SearchScope[]) {
  if (scopes.length === 2) {
    return 'all';
  }
  return scopes[0] ?? 'nodes';
}

function getSearchScopeSummary(scopes: SearchScope[]) {
  const mode = getSearchScopeMode(scopes);
  if (mode === 'activities') {
    return 'Activity recall over operational history and target-node context.';
  }
  if (mode === 'nodes') {
    return 'Durable node retrieval over titles, summaries, bodies, and tags.';
  }
  return 'Mixed retrieval across durable nodes and recent activity trails.';
}

function getSearchResultEyebrow(item: SearchResultItem) {
  return item.resultType === 'node' ? 'Durable node' : 'Activity trail';
}

function formatMatchedFieldLabel(field: string) {
  switch (field) {
    case 'targetNodeTitle':
      return 'target title';
    case 'activityType':
      return 'activity type';
    case 'sourceLabel':
      return 'source';
    default:
      return field;
  }
}

function getSearchResultMatchReason(item: SearchResultItem) {
  const matchReason = item.resultType === 'node' ? item.node?.matchReason : item.activity?.matchReason;
  if (!matchReason) {
    return null;
  }

  if (matchReason.strategy === 'browse') {
    return 'Browse mode';
  }

  const fields = matchReason.matchedFields.map(formatMatchedFieldLabel);
  const suffix = fields.length ? ` via ${fields.join(', ')}` : '';

  switch (matchReason.strategy) {
    case 'fts':
      return `Lexical match${suffix}`;
    case 'like':
      return `String match${suffix}`;
    case 'fallback_token':
      return `Fallback token match${suffix}`;
    default:
      return null;
  }
}

function getSearchResultSecondaryMeta(item: SearchResultItem) {
  if (item.resultType === 'node') {
    return [item.node?.type ?? 'node', item.node?.status ?? 'draft'].join(' · ');
  }

  return [
    item.activity?.activityType ?? 'activity',
    item.activity?.targetNodeTitle ? `target ${item.activity.targetNodeTitle}` : item.activity?.targetNodeId ?? 'unlinked',
    item.activity?.createdAt ? formatTime(item.activity.createdAt) : null,
  ]
    .filter(Boolean)
    .join(' · ');
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

function getGovernanceStateSummary(state: GovernanceIssueItem['state']) {
  switch (state) {
    case 'contested':
      return 'Contradiction or repeated negative signals are suppressing trust right now.';
    case 'low_confidence':
      return 'Local evidence exists, but the entity still needs stronger repeated confirmation.';
    default:
      return 'Signals are currently stable and no contest path is active.';
  }
}

function getGovernanceActionLabel(item: GovernanceIssueItem) {
  return item.entityType === 'node' ? 'Inspect node' : 'Relation issue';
}

function getGovernanceEventLabel(event: GovernanceEventRecord) {
  return [event.eventType, event.nextState, formatTime(event.createdAt)].join(' · ');
}

type DesktopIntegrationInfo = {
  apiBase: string;
  healthUrl: string;
  workspaceUrl: string;
  workspaceHome: string | null;
  commandShimPath: string | null;
  executablePath: string;
  mcpLauncherPath: string | null;
  mcpCommand: string | null;
  workspaceRoot: string | null;
  workspaceDbPath: string | null;
  artifactsPath: string | null;
  isPackaged: boolean;
};

type DesktopActionPayload = {
  type: 'quick-capture' | 'open-search';
};

function getDesktopIntegrationInfo(): DesktopIntegrationInfo | null {
  const globalInfo = (
    window as Window & {
      __MEMFORGE_DESKTOP_INFO__?: DesktopIntegrationInfo;
    }
  ).__MEMFORGE_DESKTOP_INFO__;

  return globalInfo ?? null;
}

function getDesktopActionBridge() {
  return (
    window as Window & {
      __MEMFORGE_DESKTOP_ACTIONS__?: {
        onAction: (callback: (payload: DesktopActionPayload) => void) => (() => void) | void;
      };
    }
  ).__MEMFORGE_DESKTOP_ACTIONS__ ?? null;
}

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

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSeed['workspace'] | null>(null);
  const [workspaceCatalog, setWorkspaceCatalog] = useState<WorkspaceCatalogItem[]>([]);
  const [snapshot, setSnapshot] = useState<WorkspaceSeed | null>(null);
  const [view, setView] = useState<NavView>('home');
  const [selectedNodeId, setSelectedNodeId] = useState<string>('node_memforge');
  const [query, setQuery] = useState('');
  const [searchScopes, setSearchScopes] = useState<SearchScope[]>(['nodes', 'activities']);
  const deferredQuery = useDeferredValue(query);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authTokenInput, setAuthTokenInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [selectedGovernanceId, setSelectedGovernanceId] = useState<string | null>(null);
  const [captureType, setCaptureType] = useState<Node['type']>('note');
  const [captureTitle, setCaptureTitle] = useState('');
  const [captureBody, setCaptureBody] = useState('');
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const [isSavingCapture, setIsSavingCapture] = useState(false);
  const [workspaceRootInput, setWorkspaceRootInput] = useState('');
  const [workspaceNameInput, setWorkspaceNameInput] = useState('');
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false);
  const [semanticStatus, setSemanticStatus] = useState<SemanticStatusSummary | null>(null);
  const [semanticIssues, setSemanticIssues] = useState<SemanticIssueItem[]>([]);
  const [semanticIssueFilter, setSemanticIssueFilter] = useState<SemanticIssueFilter>('all');
  const [semanticIssuesNextCursor, setSemanticIssuesNextCursor] = useState<string | null>(null);
  const [semanticNotice, setSemanticNotice] = useState<string | null>(null);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [isReindexingSemantic, setIsReindexingSemantic] = useState(false);
  const [isReindexingSelectedNode, setIsReindexingSelectedNode] = useState(false);
  const bundleUsageEventKeysRef = useRef(new Set<string>());
  const relationUsageSessionIdRef = useRef(
    globalThis.crypto?.randomUUID?.() ?? `memforge-renderer-${Date.now()}`
  );

  function semanticIssueStatuses(filter: SemanticIssueFilter): Array<'pending' | 'stale' | 'failed'> | undefined {
    if (filter === 'all') {
      return undefined;
    }
    return [filter];
  }

  async function loadSemanticIssues(options?: {
    filter?: SemanticIssueFilter;
    cursor?: string | null;
    append?: boolean;
    refreshStatus?: boolean;
  }) {
    const filter = options?.filter ?? semanticIssueFilter;
    const [page, nextStatus] = await Promise.all([
      getSemanticIssues({
        limit: 5,
        cursor: options?.cursor ?? undefined,
        statuses: semanticIssueStatuses(filter),
      }),
      options?.refreshStatus ? getSemanticStatus() : Promise.resolve(null),
    ]);
    setSemanticIssueFilter(filter);
    setSemanticIssues((current) => {
      if (!options?.append) {
        return page.items;
      }
      const seen = new Set(current.map((item) => `${item.nodeId}:${item.embeddingStatus}:${item.updatedAt}`));
      return [
        ...current,
        ...page.items.filter((item) => !seen.has(`${item.nodeId}:${item.embeddingStatus}:${item.updatedAt}`)),
      ];
    });
    setSemanticIssuesNextCursor(page.nextCursor);
    if (nextStatus) {
      setSemanticStatus(nextStatus);
    }
    return page;
  }

  async function refreshWorkspaceState() {
    const [workspaceResult, snapshotResult, catalog, nextSemanticStatus, nextSemanticIssues] = await Promise.all([
      getWorkspace(),
      getSnapshot(),
      getWorkspaceCatalog(),
      getSemanticStatus(),
      getSemanticIssues({
        limit: 5,
        statuses: semanticIssueStatuses(semanticIssueFilter),
      }),
    ]);
    setWorkspace(workspaceResult);
    setSnapshot(snapshotResult);
    setWorkspaceCatalog(catalog.items);
    setWorkspaceRootInput(catalog.current.rootPath);
    setSemanticStatus(nextSemanticStatus);
    setSemanticIssues(nextSemanticIssues.items);
    setSemanticIssuesNextCursor(nextSemanticIssues.nextCursor);
    setLoadError(null);
    return snapshotResult;
  }

  function handleRequestFailure(error: unknown, fallbackMessage: string) {
    if (isAuthError(error)) {
      clearRendererToken();
      setAuthRequired(true);
      setAuthError('Enter the Memforge API token to continue.');
      setLoadError(null);
      return;
    }

    setLoadError(error instanceof Error ? error.message : fallbackMessage);
  }

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const bootstrap = await getBootstrap();
        if (!mounted) return;
        setWorkspace(bootstrap.workspace);
        setSemanticStatus(bootstrap.semantic);
        if (bootstrap.authMode === 'bearer' && !bootstrap.hasToken) {
          setAuthRequired(true);
          setAuthError(null);
          setLoadError(null);
          return;
        }

        const snapshotResult = await refreshWorkspaceState();
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
    const bridge = getDesktopActionBridge();
    if (!bridge) {
      return;
    }

    const focusAfterPaint = (selector: string) => {
      window.setTimeout(() => {
        const target = document.querySelector<HTMLElement>(selector);
        target?.focus();
      }, 60);
    };

    const unsubscribe =
      bridge.onAction((payload) => {
        if (payload.type === 'open-search') {
          setView('search');
          focusAfterPaint('#search-input');
          return;
        }

        if (payload.type === 'quick-capture') {
          setView('home');
          setCaptureType('note');
          setCaptureTitle('');
          setCaptureBody('');
          setCaptureError(null);
          focusAfterPaint('#capture-title-input');
        }
      }) ?? undefined;

    return () => {
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (isLoading || authRequired || view !== 'recent') {
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
        await refreshWorkspaceState();
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
    });

    void refreshRecentView();
    window.addEventListener('focus', handleVisibilityChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('focus', handleVisibilityChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [authRequired, isLoading, view]);

  const nodeMap = useMemo(() => {
    const map = new Map<string, Node>();
    snapshot?.nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [snapshot]);

  const graphFocusableNodes = useMemo(
    () =>
      (snapshot?.nodes ?? [])
        .slice()
        .sort((left, right) => (left.title || '').localeCompare(right.title || '') || left.updatedAt.localeCompare(right.updatedAt)),
    [snapshot],
  );

  const selectedNode = nodeMap.get(selectedNodeId) ?? snapshot?.nodes[0] ?? null;

  const [detail, setDetail] = useState<DetailPanel>(emptyDetailPanel);
  const detailNode = detail.node?.id === selectedNode?.id ? detail.node : selectedNode;
  const [graphRadius, setGraphRadius] = useState<1 | 2>(1);
  const [graphConnections, setGraphConnections] = useState<GraphConnection[]>([]);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [isGraphLoading, setIsGraphLoading] = useState(false);
  const [isRefreshingSummary, setIsRefreshingSummary] = useState(false);
  const desktopInfo = getDesktopIntegrationInfo();

  useEffect(() => {
    let mounted = true;
    const currentNode = selectedNode;
    if (!currentNode) return undefined;
    const nodeId = currentNode.id;
    setDetail({
      ...emptyDetailPanel(),
      node: currentNode,
    });

    async function loadDetail() {
      try {
        const [nodeDetail, bundleItems] = await Promise.all([
          getNodeDetail(nodeId),
          getContextBundlePreview(nodeId),
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
        handleRequestFailure(error, 'Failed to load node detail.');
      }
    }

    void loadDetail();

    return () => {
      mounted = false;
    };
  }, [selectedNode]);

  useEffect(() => {
    let mounted = true;
    const currentNode = selectedNode;
    if (!currentNode) return undefined;
    const nodeId = currentNode.id;

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
  }, [graphRadius, selectedNode]);

  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [governanceIssues, setGovernanceIssues] = useState<GovernanceIssueItem[]>([]);
  const recentNodes = useMemo(
    () => (snapshot ? snapshot.recentNodeIds.map((id) => nodeMap.get(id)).filter((node): node is Node => Boolean(node)) : []),
    [nodeMap, snapshot],
  );
  const pinnedNodes = useMemo(
    () =>
      snapshot ? snapshot.pinnedProjectIds.map((id) => nodeMap.get(id)).filter((node): node is Node => Boolean(node)) : [],
    [nodeMap, snapshot],
  );
  const summaryLifecycle = useMemo(() => getSummaryLifecycle(detailNode), [detailNode]);

  useEffect(() => {
    if (!snapshot) return;

    let mounted = true;

    async function loadLists() {
      try {
        const [issues, results] = await Promise.all([getGovernanceIssues(), searchWorkspace(deferredQuery, searchScopes)]);

        if (!mounted) return;
        setGovernanceIssues(
          issues.slice().sort((left, right) => {
            const rankDiff = governanceStateRank(left.state) - governanceStateRank(right.state);
            if (rankDiff !== 0) {
              return rankDiff;
            }
            return left.confidence - right.confidence || right.lastTransitionAt.localeCompare(left.lastTransitionAt);
          })
        );
        setSearchResults(results);
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
  }, [deferredQuery, searchScopes, snapshot]);

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

  const homeActivities = detail.activities.slice(0, 3);
  const workspaceName = workspace?.name ?? 'Memforge';
  const semanticCounts = semanticStatus?.counts ?? DEFAULT_SEMANTIC_COUNTS;
  const apiBase = desktopInfo?.apiBase ?? `http://${workspace?.apiBind ?? '127.0.0.1:8787'}/api/v1`;
  const workspaceHome = desktopInfo?.workspaceHome ?? '';
  const workspaceRoot = workspace?.rootPath ?? desktopInfo?.workspaceRoot ?? '';
  const workspaceDbPath = desktopInfo?.workspaceDbPath ?? (workspaceRoot ? `${workspaceRoot}/workspace.db` : '');
  const artifactsPath = desktopInfo?.artifactsPath ?? (workspaceRoot ? `${workspaceRoot}/artifacts` : '');
  const commandShimPath = desktopInfo?.commandShimPath ?? '';
  const mcpLauncherPath = desktopInfo?.mcpLauncherPath ?? '';
  const defaultMcpCommand = `node dist/server/app/mcp/index.js --api ${apiBase}`;
  const mcpCommand = desktopInfo?.mcpCommand ?? defaultMcpCommand;
  const executablePath = desktopInfo?.executablePath ?? '';
  const executableLabel = desktopInfo?.isPackaged ? 'App bundle' : 'Executable';
  const executableDisplay = desktopInfo?.isPackaged
    ? 'Current Memforge.app installation'
    : executablePath || 'Unavailable';
  const genericMcpConfig = mcpLauncherPath
    ? `{
  "mcpServers": {
    "memforge": {
      "command": "${mcpLauncherPath}",
      "args": []
    }
  }
}`
    : `{
  "mcpServers": {
    "memforge": {
      "command": "node",
      "args": ["dist/server/app/mcp/index.js", "--api", "${apiBase}"]
    }
  }
}`;
  const apiAuthHeader = workspace?.authMode === 'bearer' ? ' -H "Authorization: Bearer $MEMFORGE_API_TOKEN"' : '';
  const apiExample = `curl${apiAuthHeader} ${apiBase}
curl${apiAuthHeader} ${desktopInfo?.healthUrl ?? `${apiBase}/health`}
curl${apiAuthHeader} ${desktopInfo?.workspaceUrl ?? `${apiBase}/workspace`}`;
  const graphDistinctNodes = useMemo(
    () => Array.from(new Map(graphConnections.map((item) => [item.node.id, item.node])).values()),
    [graphConnections],
  );
  const graphRelationCounts = useMemo(
    () =>
      graphConnections.reduce<Record<string, number>>((acc, item) => {
        acc[item.relation.relationType] = (acc[item.relation.relationType] ?? 0) + 1;
        return acc;
      }, {}),
    [graphConnections],
  );

  async function handleSemanticIssueFilterChange(nextFilter: SemanticIssueFilter) {
    try {
      setSemanticError(null);
      await loadSemanticIssues({ filter: nextFilter });
    } catch (error) {
      setSemanticError(error instanceof Error ? error.message : 'Could not refresh semantic issues.');
    }
  }

  async function handleLoadMoreSemanticIssues() {
    if (!semanticIssuesNextCursor) {
      return;
    }

    try {
      setSemanticError(null);
      await loadSemanticIssues({ cursor: semanticIssuesNextCursor, append: true });
    } catch (error) {
      setSemanticError(error instanceof Error ? error.message : 'Could not load more semantic issues.');
    }
  }

  async function handleQueueSemanticReindex() {
    setIsReindexingSemantic(true);
    setSemanticError(null);
    setSemanticNotice(null);
    try {
      const result = await queueSemanticReindex();
      await loadSemanticIssues({ filter: semanticIssueFilter, refreshStatus: true });
      setSemanticNotice(`Queued ${result.queuedCount} nodes for semantic reindex.`);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to queue semantic reindex.';
      setSemanticError(message);
      handleRequestFailure(error, message);
    } finally {
      setIsReindexingSemantic(false);
    }
  }

  async function handleQueueSelectedNodeSemanticReindex() {
    if (!detailNode) {
      return;
    }
    setIsReindexingSelectedNode(true);
    setSemanticError(null);
    setSemanticNotice(null);
    try {
      await queueSemanticReindexForNode(detailNode.id);
      await loadSemanticIssues({ filter: semanticIssueFilter, refreshStatus: true });
      setSemanticNotice(`Queued semantic reindex for "${detailNode.title}".`);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to queue node reindex.';
      setSemanticError(message);
      handleRequestFailure(error, message);
    } finally {
      setIsReindexingSelectedNode(false);
    }
  }

  function resetWorkspaceSelection(nextSnapshot: WorkspaceSeed) {
    setSelectedNodeId(nextSnapshot.nodes[0]?.id ?? '');
    setDetail(emptyDetailPanel());
  }

  function focusNode(nodeId: string, nextView?: NavView) {
    setSelectedNodeId(nodeId);
    if (nextView) {
      selectView(nextView);
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
      });
      const node = result.node;
      await refreshWorkspaceState();
      focusNode(node.id);
      setView(node.type === 'project' ? 'projects' : 'recent');
      setCaptureTitle('');
      setCaptureBody('');
      setCaptureType('note');
      setCaptureNotice(
        result.landing
          ? `Saved as ${result.landing.canonicality ? `${result.landing.canonicality} ` : ''}${result.landing.status}. ${result.landing.reason}`
          : 'Node saved.'
      );
      setLoadError(null);
    } catch (error) {
      if (isAuthError(error)) {
        clearRendererToken();
        setAuthRequired(true);
        setAuthError('Enter the Memforge API token to continue.');
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
      await refreshWorkspaceState();
      setLoadError(null);
    } catch (error) {
      handleRequestFailure(error, 'Failed to refresh summary.');
    } finally {
      setIsRefreshingSummary(false);
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
      await createWorkspaceSession({
        rootPath,
        workspaceName: workspaceNameInput.trim() || undefined,
      });
      const nextSnapshot = await refreshWorkspaceState();
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
    setWorkspaceActionError(null);
    setIsSwitchingWorkspace(true);
    try {
      await openWorkspaceSession(rootPath);
      const nextSnapshot = await refreshWorkspaceState();
      resetWorkspaceSelection(nextSnapshot);
    } catch (error) {
      handleRequestFailure(error, 'Failed to switch workspace.');
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to switch workspace.');
    } finally {
      setIsSwitchingWorkspace(false);
    }
  }

  function selectView(next: NavView) {
    startTransition(() => {
      setView(next);
    });
  }

  function openNodeInGraph(nodeId: string) {
    focusNode(nodeId, 'graph');
  }

  const centerContent = (() => {
    if (isLoading) {
      return (
        <Section title="Loading workspace" subtitle="Opening the local knowledge layer.">
          <div className="empty-state">Fetching seed workspace and renderer mock data...</div>
        </Section>
      );
    }

    if (loadError && !snapshot) {
      return (
        <Section title="Workspace error" subtitle="The renderer could not load the live workspace.">
          <div className="empty-state">{loadError}</div>
        </Section>
      );
    }

    if (authRequired && !snapshot) {
      return (
        <Section title="Renderer authentication" subtitle="This workspace requires a bearer token before the live API can be used.">
          <form className="capture-form" onSubmit={(event) => void handleAuthSubmit(event)}>
            <label className="search-box" htmlFor="memforge-token">
              <span>API token</span>
              <input
                id="memforge-token"
                type="password"
                value={authTokenInput}
                onChange={(event) => setAuthTokenInput(event.target.value)}
                placeholder="Paste MEMFORGE_API_TOKEN"
              />
            </label>
            {authError ? <div className="empty-state">{authError}</div> : null}
            <div className="action-row">
              <button type="submit" disabled={isLoading}>
                {isLoading ? 'Connecting...' : 'Connect renderer'}
              </button>
            </div>
          </form>
        </Section>
      );
    }

    if (view === 'search') {
      return (
        <>
          {loadError ? (
            <Section title="Connection warning" subtitle="Live API data is currently unavailable.">
              <div className="empty-state">{loadError}</div>
            </Section>
          ) : null}
          <Section title="Search" subtitle={getSearchScopeSummary(searchScopes)}>
            <label className="search-box" htmlFor="search-input">
              <span>Query</span>
              <input
                id="search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search Memforge"
              />
            </label>
            <div className="chip-row">
              {SEARCH_SCOPE_OPTIONS.map((option) => {
                const active =
                  option.scopes.length === searchScopes.length &&
                  option.scopes.every((scope) => searchScopes.includes(scope));
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`tool-chip ${active ? 'tool-chip--active' : ''}`}
                    onClick={() => setSearchScopes(option.scopes)}
                    aria-pressed={active}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="settings-copy">
              Scope is currently <strong>{getSearchScopeMode(searchScopes)}</strong>. Node results surface durable knowledge;
              activity results surface operational history with target-node context.
            </p>
          </Section>
          <Section
            title={`Results ${searchResults.length ? `(${searchResults.length})` : ''}`}
            subtitle="Select a result to inspect the node, governance state, and nearby context."
          >
            <div className="stack">
              {searchResults.map((item) => {
                const nodeId = getSearchResultNodeId(item);
                const meta = getSearchResultMeta(item);
                return (
                  <button
                    key={getSearchResultKey(item)}
                    type="button"
                    className={`result-card ${nodeId && selectedNodeId === nodeId ? 'selected' : ''}`}
                    disabled={!nodeId}
                    onClick={() => {
                      if (nodeId) {
                        focusNode(nodeId, 'search');
                      }
                    }}
                  >
                    <span className="eyebrow">{getSearchResultEyebrow(item)}</span>
                    <div className="result-card__top">
                      <strong>{getSearchResultTitle(item)}</strong>
                      <span className={`pill ${badgeTone(getSearchResultStatus(item))}`}>{getSearchResultBadge(item)}</span>
                    </div>
                    <p>{getSearchResultSummary(item)}</p>
                    <div className="meta-row">
                      <span>{getSearchResultSecondaryMeta(item)}</span>
                      <span>{meta.source}</span>
                    </div>
                    <div className="meta-row">
                      <span>{item.resultType === 'node' ? 'durable retrieval' : 'activity recall'}</span>
                      <span>{formatTime(meta.updatedAt)}</span>
                    </div>
                    {getSearchResultMatchReason(item) ? (
                      <div className="chip-row">
                        <span className="pill tone-info">{getSearchResultMatchReason(item)}</span>
                      </div>
                    ) : null}
                  </button>
                );
              })}
              {!searchResults.length ? <div className="empty-state">No matches for this query.</div> : null}
            </div>
          </Section>
        </>
      );
    }

    if (view === 'governance') {
      return (
        <Section title="Governance" subtitle="Automatic governance highlights contested and low-confidence entities.">
          <div className="stack">
            {governanceIssues.map((item) => (
              <article
                key={`${item.entityType}:${item.entityId}`}
                className={`governance-card ${selectedGovernanceId === item.entityId ? 'selected' : ''}`}
                onClick={() => setSelectedGovernanceId(item.entityId)}
              >
                <span className="eyebrow">{item.entityType === 'node' ? 'Node issue' : 'Relation issue'}</span>
                <div className="result-card__top">
                  <strong>{item.title}</strong>
                  <span className={`pill ${badgeTone(item.state)}`}>{item.state}</span>
                </div>
                <p>{item.subtitle || getGovernanceStateSummary(item.state)}</p>
                <div className="meta-row">
                  <span>{item.entityType}:{item.entityId}</span>
                  <span>confidence {formatConfidence(item.confidence)}</span>
                </div>
                <div className="chip-row">
                  {item.reasons.slice(0, 3).map((reason) => (
                    <span key={reason} className="chip">
                      {reason}
                    </span>
                  ))}
                </div>
                <div className="action-row">
                  <button
                    type="button"
                    className="ghost"
                    disabled={item.entityType !== 'node'}
                    onClick={() => {
                      if (item.entityType === 'node') {
                        focusNode(item.entityId, 'governance');
                      }
                    }}
                  >
                    {getGovernanceActionLabel(item)}
                  </button>
                </div>
              </article>
            ))}
            {!governanceIssues.length ? <div className="empty-state">No governance issues are currently surfaced.</div> : null}
          </div>
        </Section>
      );
    }

    if (view === 'projects') {
      return (
        <Section title="Projects" subtitle="Canonical project nodes and their local context.">
          <div className="stack">
              {pinnedNodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className={`result-card ${selectedNodeId === node.id ? 'selected' : ''}`}
                  onClick={() => {
                    focusNode(node.id, 'projects');
                  }}
                >
                <div className="result-card__top">
                  <strong>{node.title}</strong>
                  <span className={`pill ${badgeTone(node.status)}`}>{node.status}</span>
                </div>
                <p>{node.summary}</p>
              </button>
            ))}
          </div>
        </Section>
      );
    }

    if (view === 'graph') {
      return (
        <Section title="Graph" subtitle="Secondary inspection surface for a user-chosen focus node neighborhood.">
          <div className="graph-toolbar">
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
                    {node.title}
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
            <p className="settings-copy">Pick a focus node, then inspect local density and relation quality without turning this into the main workflow.</p>
          </div>

          <div className="graph-summary-grid">
            <article className="graph-focus graph-focus-card">
              <span className="eyebrow">Focus node</span>
              <strong>{selectedNode?.title}</strong>
              <p>{selectedNode?.summary}</p>
              <div className="chip-row">
                <span className={`pill ${badgeTone(selectedNode?.status ?? 'active')}`}>{selectedNode?.status ?? 'active'}</span>
                <span className="pill tone-muted">{selectedNode?.type ?? 'node'}</span>
                <span className="pill tone-muted">{graphRadius}-hop radius</span>
              </div>
              <div className="meta-row">
                <span>{selectedNode?.sourceLabel ?? 'unknown source'}</span>
                <span>{selectedNode ? `updated ${formatTime(selectedNode.updatedAt)}` : 'no focus node'}</span>
              </div>
            </article>

            <article className="mini-card">
              <span className="eyebrow">Neighborhood</span>
              <strong>{graphDistinctNodes.length} nodes</strong>
              <p>{graphConnections.length} visible relation path{graphConnections.length === 1 ? '' : 's'} around the current focus.</p>
            </article>

            <article className="mini-card">
              <span className="eyebrow">Relation density</span>
              <strong>{Object.keys(graphRelationCounts).length} relation types</strong>
              <p>{graphConnections.filter((item) => item.relation.status === 'suggested').length} suggested links need extra scrutiny.</p>
            </article>
          </div>

          {Object.keys(graphRelationCounts).length ? (
            <div className="graph-legend">
              {Object.entries(graphRelationCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([relationType, count]) => (
                  <span key={relationType} className={`chip relation-chip ${relationToneClass(relationType as GraphConnection['relation']['relationType'])}`}>
                    {relationLabel(relationType)} · {count}
                  </span>
                ))}
            </div>
          ) : null}

          {graphError ? <div className="empty-state">{graphError}</div> : null}

          <div className="graph-shell">
            {isGraphLoading ? <div className="empty-state">Loading graph neighborhood...</div> : null}
            {!isGraphLoading && !graphConnections.length ? (
              <div className="empty-state">No related nodes in this neighborhood yet.</div>
            ) : null}
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
                  <span className="chip">{item.direction}</span>
                  <span className="chip">{item.hop}-hop</span>
                  <span className={`pill ${badgeTone(item.relation.status)}`}>{item.relation.status}</span>
                </div>
                <div className="meta-row">
                  <span>{item.viaNodeTitle ? `via ${item.viaNodeTitle}` : 'direct link'}</span>
                  <span>{item.relation.sourceLabel}</span>
                </div>
              </button>
            ))}
          </div>
        </Section>
      );
    }

    if (view === 'settings') {
      return (
        <Section title="Settings" subtitle="Workspace identity and local integration boundaries.">
          <div className="settings-grid">
            <section className="settings-card">
              <div className="settings-head">
                <div>
                  <span className="eyebrow">Workspace</span>
                  <h3>Current workspace</h3>
                  <p className="settings-copy">Switch or create a workspace without leaving settings.</p>
                </div>
                <span className={`pill ${workspace?.authMode === 'bearer' ? 'tone-warn' : 'tone-good'}`}>
                  {workspace?.authMode === 'bearer' ? 'Bearer auth' : 'Local access'}
                </span>
              </div>
              <div className="meta-grid">
                <div>
                  <span className="eyebrow">Workspace</span>
                  <p>{workspaceName}</p>
                </div>
                <div>
                  <span className="eyebrow">Root</span>
                  <p>{workspace?.rootPath}</p>
                </div>
                <div>
                  <span className="eyebrow">Schema version</span>
                  <p>{workspace?.schemaVersion}</p>
                </div>
                <div>
                  <span className="eyebrow">API bind</span>
                  <p>{workspace?.apiBind}</p>
                </div>
              </div>
              <form className="capture-form" onSubmit={(event) => void handleCreateWorkspace(event)}>
                <label className="search-box">
                  <span>Workspace root</span>
                  <input
                    value={workspaceRootInput}
                    onChange={(event) => setWorkspaceRootInput(event.target.value)}
                    placeholder="/Users/name/Documents/MyMemforge"
                  />
                </label>
                <label className="search-box">
                  <span>Workspace name</span>
                  <input
                    value={workspaceNameInput}
                    onChange={(event) => setWorkspaceNameInput(event.target.value)}
                    placeholder="Optional display name for new workspace"
                  />
                </label>
                {workspaceActionError ? <div className="empty-state">{workspaceActionError}</div> : null}
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

            <section className="settings-card">
              <div className="settings-head">
                <div>
                  <span className="eyebrow">Automatic governance</span>
                  <h3>Deterministic promotion and contest rules</h3>
                  <p className="settings-copy">Memforge v2 no longer requires manual review actions. Governance is derived from local confidence, contradiction signals, and usage feedback.</p>
                </div>
                <div className="settings-head-meta">
                  <span className="pill tone-good">manual review removed</span>
                  <span className="pill tone-info">{governanceIssues.length} live issue{governanceIssues.length === 1 ? '' : 's'}</span>
                </div>
              </div>
              <div className="settings-block">
                <div className="chip-row">
                  <span className="pill tone-good">Search feedback reranks results</span>
                  <span className="pill tone-warn">Contradictions can contest content</span>
                  <span className="pill tone-info">Suggested notes can auto-promote</span>
                </div>
                <p className="settings-copy">
                  Confidence is derived from local source trust, search feedback, relation usage, contradiction signals,
                  and stability over time. Contested entities stay searchable but rank below healthier peers until local
                  evidence improves.
                </p>
                <p className="settings-copy">
                  Use the Governance tab to inspect low-confidence or contested entities. MCP and CLI surfaces expose
                  recompute and issue listing for operational workflows, while `review.*` settings remain legacy
                  compatibility inputs only.
                </p>
              </div>
            </section>

            <section className="settings-card settings-card--wide">
              <div className="settings-head">
                <div>
                  <span className="eyebrow">Recent workspaces</span>
                  <h3>Previously opened roots</h3>
                  <p className="settings-copy">Jump back to a workspace with one click.</p>
                </div>
              </div>
              <div className="stack">
                {workspaceCatalog.map((item) => (
                  <button
                    key={item.rootPath}
                    type="button"
                    className="result-card"
                    disabled={isSwitchingWorkspace || item.isCurrent}
                    onClick={() => {
                      setWorkspaceRootInput(item.rootPath);
                      void handleOpenWorkspace(item.rootPath);
                    }}
                  >
                    <div className="result-card__top">
                      <strong>{item.name}</strong>
                      <span className={`pill ${item.isCurrent ? 'tone-good' : 'tone-muted'}`}>{item.isCurrent ? 'current' : 'available'}</span>
                    </div>
                    <p>{item.rootPath}</p>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </Section>
      );
    }

    if (view === 'recent') {
      return (
        <Section title="Recent" subtitle="Recently touched nodes and activity.">
          <div className="stack">
            {recentNodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className={`result-card ${selectedNodeId === node.id ? 'selected' : ''}`}
                onClick={() => {
                  focusNode(node.id, 'recent');
                }}
              >
                <div className="result-card__top">
                  <strong>{node.title}</strong>
                  <span className={`pill ${badgeTone(node.status)}`}>{node.status}</span>
                </div>
                <p>{node.summary}</p>
              </button>
            ))}
          </div>
        </Section>
      );
    }

    return (
      <>
        {loadError ? (
          <Section title="Connection warning" subtitle="Some live workspace requests are failing.">
            <div className="empty-state">{loadError}</div>
          </Section>
        ) : null}
        <Section title="Home" subtitle="Fast re-entry point for search, governance, and pinned context.">
          <div className="home-grid">
            <div className="hero-card">
              <span className="eyebrow">Workspace</span>
              <h3>{workspaceName}</h3>
              <p>
                Retrieve compact context quickly, inspect provenance, and let automatic governance
                keep durable content healthy.
              </p>
              <form
                className="hero-search"
                onSubmit={(event) =>
                  handleSearchSubmit(event, {
                    query,
                    onSelectSearch: () => selectView('search'),
                  })
                }
              >
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search Memforge"
                  aria-label="Quick search"
                />
                <button type="submit">Search</button>
              </form>
            </div>
            <div className="mini-card">
              <span className="eyebrow">Pinned</span>
              <strong>{pinnedNodes[0]?.title ?? 'None'}</strong>
              <p>{pinnedNodes[0]?.summary}</p>
            </div>
            <div className="mini-card">
              <span className="eyebrow">Governance</span>
              <strong>{governanceIssues.length} surfaced issues</strong>
              <p>Contested or low-confidence entities are available for inspection in one place.</p>
            </div>
          </div>
        </Section>
        <Section title="API & MCP" subtitle="Connection examples and local file locations for the current app session.">
          <div className="integration-grid">
            <article className="mini-card">
              <span className="eyebrow">HTTP API</span>
              <strong>{apiBase}</strong>
              <p>
                Use the loopback API for bootstrap, health checks, and direct local integration.
                {workspace?.authMode === 'bearer' ? ' Bearer mode is active, so include the Authorization header.' : ''}
              </p>
              <pre className="code-block">{apiExample}</pre>
            </article>
            <article className="mini-card">
              <span className="eyebrow">Stdio MCP</span>
              <strong>{mcpLauncherPath || 'node dist/server/app/mcp/index.js --api …'}</strong>
              <p>
                JetBrains AI Assistant and similar GUI MCP clients should use the JSON block below
                with the stable launcher path. The direct command underneath is better suited to
                shell-based clients.
              </p>
              <pre className="code-block">{genericMcpConfig}</pre>
              <pre className="code-block">{mcpCommand}</pre>
            </article>
            <article className="mini-card">
              <span className="eyebrow">Semantic indexing</span>
              <strong>{semanticStatus?.enabled ? 'Enabled' : 'Disabled'}</strong>
              <p>
                Provider {semanticStatus?.provider ?? 'disabled'} · model {semanticStatus?.model ?? 'none'} · chunks{' '}
                {semanticStatus?.chunkEnabled ? 'on' : 'off'}
              </p>
              <div className="chip-row">
                <span className="pill tone-info">pending {semanticCounts.pending}</span>
                <span className="pill tone-muted">processing {semanticCounts.processing}</span>
                <span className="pill tone-warn">stale {semanticCounts.stale}</span>
                <span className="pill tone-good">ready {semanticCounts.ready}</span>
                <span className="pill tone-muted">failed {semanticCounts.failed}</span>
              </div>
              <p>Last workspace reindex: {formatMaybeTime(semanticStatus?.lastBackfillAt ?? null)}</p>
              <div className="chip-row">
                {SEMANTIC_ISSUE_FILTERS.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className={`tool-chip ${semanticIssueFilter === filter ? 'tool-chip--active' : ''}`}
                    onClick={() => void handleSemanticIssueFilterChange(filter)}
                  >
                    {filter === 'all' ? 'All issues' : filter}
                  </button>
                ))}
              </div>
              <p className="semantic-issue-summary">
                Showing {semanticIssues.length} {semanticIssueFilterLabel(semanticIssueFilter)}
                {semanticIssuesNextCursor ? ' with more available.' : '.'}
              </p>
              {semanticIssues.length ? (
                <div className="semantic-issue-list">
                  {semanticIssues.map((issue) => (
                    <p key={`${issue.nodeId}:${issue.embeddingStatus}:${issue.updatedAt}`}>
                      <strong>{issue.title ?? issue.nodeId}</strong> · {issue.embeddingStatus}
                      {issue.staleReason ? ` · ${issue.staleReason}` : ''}
                    </p>
                  ))}
                </div>
              ) : (
                <div className="empty-state compact">{semanticIssueEmptyState(semanticIssueFilter)}</div>
              )}
              <div className="action-row">
                <button type="button" onClick={() => void handleQueueSemanticReindex()} disabled={isReindexingSemantic}>
                  {isReindexingSemantic ? 'Queueing reindex...' : 'Reindex workspace'}
                </button>
                {semanticIssuesNextCursor ? (
                  <button type="button" className="ghost" onClick={() => void handleLoadMoreSemanticIssues()}>
                    Load more issues
                  </button>
                ) : null}
              </div>
              {semanticNotice ? <p>{semanticNotice}</p> : null}
              {semanticError ? <p>{semanticError}</p> : null}
            </article>
          </div>
          <div className="integration-grid">
            <article className="mini-card">
              <span className="eyebrow">File locations</span>
              <div className="path-list">
                <div>
                  <strong>Memforge home</strong>
                  <code>{workspaceHome || 'Unavailable'}</code>
                </div>
                <div>
                  <strong>Workspace root</strong>
                  <code>{workspaceRoot || 'Unavailable'}</code>
                </div>
                <div>
                  <strong>Database</strong>
                  <code>{workspaceDbPath || 'Unavailable'}</code>
                </div>
                <div>
                  <strong>Artifacts</strong>
                  <code>{artifactsPath || 'Unavailable'}</code>
                </div>
              </div>
            </article>
            <article className="mini-card">
              <span className="eyebrow">App paths</span>
              <div className="path-list">
                <div>
                  <strong>CLI shim</strong>
                  <code>{commandShimPath || 'Unavailable'}</code>
                </div>
                <div>
                  <strong>MCP launcher</strong>
                  <code>{mcpLauncherPath || 'Unavailable'}</code>
                </div>
                <div>
                  <strong>Direct MCP command</strong>
                  <code>{mcpCommand || defaultMcpCommand}</code>
                </div>
                <div>
                  <strong>{executableLabel}</strong>
                  <code>{executableDisplay}</code>
                </div>
                <div>
                  <strong>Mode</strong>
                  <code>{desktopInfo?.isPackaged ? 'packaged desktop shell' : 'development shell'}</code>
                </div>
              </div>
            </article>
          </div>
        </Section>
        <Section title="Quick capture" subtitle="Write a durable node into the local workspace.">
          <form className="capture-form" onSubmit={(event) => void handleCreateNode(event)}>
            <label className="search-box">
              <span>Type</span>
              <select value={captureType} onChange={(event) => setCaptureType(event.target.value as Node['type'])}>
                <option value="note">note</option>
                <option value="project">project</option>
                <option value="idea">idea</option>
                <option value="question">question</option>
                <option value="decision">decision</option>
                <option value="reference">reference</option>
              </select>
            </label>
            <label className="search-box">
              <span>Title</span>
              <input
                id="capture-title-input"
                value={captureTitle}
                onChange={(event) => setCaptureTitle(event.target.value)}
                placeholder="Memforge retrieval rule"
              />
            </label>
            <label className="search-box">
              <span>Body</span>
              <textarea
                value={captureBody}
                onChange={(event) => setCaptureBody(event.target.value)}
                placeholder="Add a concise durable summary, question, or decision."
                rows={5}
              />
            </label>
            {captureError ? <div className="empty-state">{captureError}</div> : null}
            {captureNotice ? <p>{captureNotice}</p> : null}
            <div className="action-row">
              <button type="submit" disabled={isSavingCapture}>
                {isSavingCapture ? 'Saving...' : 'Create node'}
              </button>
            </div>
          </form>
        </Section>
        <Section title="Recent activity" subtitle="A compact activity trail for quick re-entry.">
          <div className="stack">
            {homeActivities.map((activity) => (
              <article key={activity.id} className="activity-card">
                <div className="result-card__top">
                  <strong>{activity.activityType}</strong>
                  <span>{formatTime(activity.createdAt)}</span>
                </div>
                <p>{activity.body}</p>
              </article>
            ))}
          </div>
        </Section>
      </>
    );
  })();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <strong>{workspaceName}</strong>
            <p>Local knowledge substrate</p>
          </div>
        </div>
        <button className="capture-button" type="button" onClick={() => selectView('home')}>
          Quick capture
        </button>
        <nav className="nav-list" aria-label="Main navigation">
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
        <div className="sidebar-block">
          <span className="eyebrow">Pinned projects</span>
          {pinnedNodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className="sidebar-link"
              onClick={() => {
                focusNode(node.id, 'projects');
              }}
            >
              {node.title}
            </button>
          ))}
        </div>
        <div className="sidebar-block">
          <span className="eyebrow">Recent nodes</span>
          {recentNodes.slice(0, 3).map((node) => (
            <button
              key={node.id}
              type="button"
              className="sidebar-link"
              onClick={() => {
                focusNode(node.id, 'recent');
              }}
            >
              {node.title}
            </button>
          ))}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">Memforge v2</span>
            <h1>{view.charAt(0).toUpperCase() + view.slice(1)}</h1>
          </div>
          <div className="topbar-meta">
            <span>{workspace?.apiBind ?? '127.0.0.1'}</span>
            <span>{workspace?.integrationModes.join(' / ')}</span>
          </div>
        </header>

        <div className="content-grid">
          <section className="center-pane">{centerContent}</section>

          <aside className="detail-pane">
            <Section title="Node detail" subtitle="Selected node and its local context.">
              {detailNode ? (
                <div className="detail-stack">
                  <div className="detail-title">
                    <strong>{detailNode.title}</strong>
                    <span className={`pill ${badgeTone(detailNode.status)}`}>{detailNode.type}</span>
                    {summaryLifecycle.isStale ? <span className="pill tone-warn">summary stale</span> : null}
                  </div>
                  <p>{detailNode.summary}</p>
                  <div className="action-row">
                    <button type="button" onClick={() => openNodeInGraph(detailNode.id)}>
                      Inspect in Graph
                    </button>
                    <button type="button" onClick={() => void handleRefreshSummary()} disabled={isRefreshingSummary}>
                      {isRefreshingSummary ? 'Refreshing summary...' : 'Refresh summary'}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void handleQueueSelectedNodeSemanticReindex()}
                      disabled={isReindexingSelectedNode}
                    >
                      {isReindexingSelectedNode ? 'Queueing node reindex...' : 'Reindex selected node'}
                    </button>
                  </div>
                  <div className="body-copy">{detailNode.body}</div>
                  <div className="chip-row">
                    {detailNode.tags.map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="meta-grid">
                    <div>
                      <span className="eyebrow">Source</span>
                      <p>{detailNode.sourceLabel}</p>
                    </div>
                    <div>
                      <span className="eyebrow">Canonicality</span>
                      <p>{detailNode.canonicality}</p>
                    </div>
                    <div>
                      <span className="eyebrow">Summary lifecycle</span>
                      <p>
                        {summaryLifecycle.summarySource ?? 'unknown'}
                        {summaryLifecycle.summaryUpdatedAt ? ` · ${formatTime(summaryLifecycle.summaryUpdatedAt)}` : ''}
                      </p>
                    </div>
                    <div>
                      <span className="eyebrow">Governance</span>
                      <p>
                        {detail.governance.state?.state ?? 'healthy'} ·{' '}
                        {detail.governance.state ? formatConfidence(detail.governance.state.confidence) : 'n/a'}
                      </p>
                    </div>
                  </div>
                  <div className="stack compact">
                    <div>
                      <span className="eyebrow">Governance reasons</span>
                      <div className="chip-row">
                        {(detail.governance.state?.reasons ?? ['No governance pressure is currently attached.']).map((reason) => (
                          <span key={reason} className="chip">
                            {reason}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span className="eyebrow">Recent governance events</span>
                      <div className="stack compact">
                        {detail.governance.events.slice(0, 3).map((event) => (
                          <article key={event.id} className="mini-card">
                            <strong>{getGovernanceEventLabel(event)}</strong>
                            <p>{event.reason}</p>
                          </article>
                        ))}
                        {!detail.governance.events.length ? (
                          <div className="empty-state compact">No governance transitions recorded for this node yet.</div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </Section>

            <Section title="Context rail" subtitle="Related nodes, activity, artifacts, and provenance.">
              <div className="stack">
                <div>
                  <span className="eyebrow">Related</span>
                  <div className="stack compact">
                    {detail.related.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        className="sidebar-link"
                        onClick={() => focusNode(node.id)}
                      >
                        {node.title}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="eyebrow">Bundle preview</span>
                  <p className="context-hint">Click a preview item to open it and reinforce useful relation context.</p>
                  <div className="stack compact">
                    {detail.bundleItems.slice(0, 4).map((item) => (
                      <button
                        key={item.nodeId}
                        type="button"
                        className="mini-card mini-card--interactive"
                        onClick={() => void handleBundlePreviewClick(item)}
                      >
                        <div className="result-card__top">
                          <strong>{item.title ?? item.nodeId}</strong>
                          <div className="bundle-preview-actions">
                            <span className="pill tone-muted">{item.type}</span>
                            <span className="bundle-preview-open">Open</span>
                          </div>
                        </div>
                        <p>{item.summary ?? item.reason}</p>
                        <p className="bundle-preview-meta">
                          {[
                            item.relationSource,
                            item.relationType,
                            typeof item.semanticSimilarity === 'number' ? `semantic ${item.semanticSimilarity.toFixed(2)}` : null,
                            typeof item.retrievalRank === 'number' ? `rank ${item.retrievalRank.toFixed(1)}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'Context preview'}
                        </p>
                        <p className="context-reason">{item.reason}</p>
                      </button>
                    ))}
                    {!detail.bundleItems.length ? <div className="empty-state">No bundle preview items yet.</div> : null}
                  </div>
                </div>
                <div>
                  <span className="eyebrow">Recent activity</span>
                  <div className="stack compact">
                    {detail.activities.map((activity) => (
                      <article key={activity.id} className="mini-card">
                        <strong>{activity.activityType}</strong>
                        <p>{activity.body}</p>
                      </article>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="eyebrow">Artifacts</span>
                  <div className="stack compact">
                    {detail.artifacts.map((artifact) => (
                      <article key={artifact.id} className="mini-card">
                        <strong>{artifact.path}</strong>
                        <p>{artifact.mimeType}</p>
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            </Section>

            <Section title="Governance focus" subtitle="Highlighted automatic governance issue.">
              {activeGovernanceIssue ? (
                <div className="mini-card">
                  <span className="eyebrow">{activeGovernanceIssue.entityType === 'node' ? 'Node issue' : 'Relation issue'}</span>
                  <strong>{activeGovernanceIssue.title}</strong>
                  <p>{activeGovernanceIssue.subtitle || getGovernanceStateSummary(activeGovernanceIssue.state)}</p>
                  <div className="chip-row">
                    <span className={`pill ${badgeTone(activeGovernanceIssue.state)}`}>{activeGovernanceIssue.state}</span>
                    <span className="pill tone-muted">confidence {formatConfidence(activeGovernanceIssue.confidence)}</span>
                  </div>
                  <div className="chip-row">
                    {activeGovernanceIssue.reasons.slice(0, 3).map((reason) => (
                      <span key={reason} className="chip">
                        {reason}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="empty-state">No governance issues are currently surfaced.</div>
              )}
            </Section>
          </aside>
        </div>
      </main>
    </div>
  );
}
