import { useDeferredValue, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import {
  appendRelationUsageEvent,
  approveReview,
  clearRendererToken,
  createWorkspace as createWorkspaceSession,
  createNode,
  getBootstrap,
  getContextBundlePreview,
  getActivities,
  getArtifacts,
  getNode,
  getGraphNeighborhood,
  getPinnedNodes,
  getRecentNodes,
  getReviewSettings,
  getRelatedNodes,
  getReviewQueue,
  getSemanticIssues,
  getSemanticStatus,
  getSnapshot,
  getWorkspace,
  getWorkspaceCatalog,
  isAuthError,
  openWorkspace as openWorkspaceSession,
  queueSemanticReindex,
  queueSemanticReindexForNode,
  rejectReview,
  refreshNodeSummary as refreshNodeSummaryRequest,
  saveRendererToken,
  searchNodes,
  subscribeWorkspaceEvents,
  updateReviewSettings,
} from './lib/mockApi';
import type {
  Activity,
  Artifact,
  ContextBundlePreviewItem,
  GraphConnection,
  NavView,
  Node,
  ReviewSettings,
  ReviewQueueItem,
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
};

type SemanticIssueFilter = 'all' | 'failed' | 'stale' | 'pending';

const navigation: { id: NavView; label: string; hint: string }[] = [
  { id: 'home', label: 'Home', hint: 're-entry' },
  { id: 'search', label: 'Search', hint: 'retrieval' },
  { id: 'projects', label: 'Projects', hint: 'core nodes' },
  { id: 'recent', label: 'Recent', hint: 'latest work' },
  { id: 'review', label: 'Review', hint: 'governance' },
  { id: 'graph', label: 'Graph', hint: 'secondary' },
  { id: 'settings', label: 'Settings', hint: 'workspace' },
];

const TRUSTED_SOURCE_PRESETS = [
  'codex',
  'claude-code',
  'gemini-cli',
  'openclaw',
] as const;

const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  autoApproveLowRisk: true,
  trustedSourceToolNames: [],
};

function badgeTone(status: string) {
  if (status === 'active' || status === 'approved') return 'tone-good';
  if (status === 'review' || status === 'pending') return 'tone-warn';
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

function normalizeToolName(value: string) {
  return value.trim().toLowerCase();
}

function parseToolNames(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map(normalizeToolName)
        .filter(Boolean),
    ),
  );
}

function mergeToolNames(current: string[], additions: string[]) {
  return Array.from(new Set([...current.map(normalizeToolName), ...additions.map(normalizeToolName)].filter(Boolean)));
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
  const deferredQuery = useDeferredValue(query);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authTokenInput, setAuthTokenInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [captureType, setCaptureType] = useState<Node['type']>('note');
  const [captureTitle, setCaptureTitle] = useState('');
  const [captureBody, setCaptureBody] = useState('');
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [isSavingCapture, setIsSavingCapture] = useState(false);
  const [workspaceRootInput, setWorkspaceRootInput] = useState('');
  const [workspaceNameInput, setWorkspaceNameInput] = useState('');
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false);
  const [savedReviewSettings, setSavedReviewSettings] = useState<ReviewSettings>(DEFAULT_REVIEW_SETTINGS);
  const [reviewSettings, setReviewSettings] = useState<ReviewSettings>(DEFAULT_REVIEW_SETTINGS);
  const [trustedToolNameDraft, setTrustedToolNameDraft] = useState('');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSettingsDirty, setIsSettingsDirty] = useState(false);
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
  }) {
    const filter = options?.filter ?? semanticIssueFilter;
    const page = await getSemanticIssues({
      limit: 5,
      cursor: options?.cursor ?? undefined,
      statuses: semanticIssueStatuses(filter),
    });
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
    return page;
  }

  async function refreshWorkspaceState(options?: { syncReviewSettings?: boolean }) {
    const [workspaceResult, snapshotResult, catalog, nextReviewSettings, nextSemanticStatus, nextSemanticIssues] = await Promise.all([
      getWorkspace(),
      getSnapshot(),
      getWorkspaceCatalog(),
      getReviewSettings(),
      getSemanticStatus(),
      getSemanticIssues({
        limit: 5,
        statuses: semanticIssueStatuses(semanticIssueFilter),
      }),
    ]);
    const shouldSyncReviewSettings = options?.syncReviewSettings ?? !isSettingsDirty;
    setWorkspace(workspaceResult);
    setSnapshot(snapshotResult);
    setWorkspaceCatalog(catalog.items);
    setWorkspaceRootInput(catalog.current.rootPath);
    setSemanticStatus(nextSemanticStatus);
    setSemanticIssues(nextSemanticIssues.items);
    setSemanticIssuesNextCursor(nextSemanticIssues.nextCursor);
    if (shouldSyncReviewSettings) {
      const normalizedNextReviewSettings = {
        autoApproveLowRisk: nextReviewSettings.autoApproveLowRisk,
        trustedSourceToolNames: mergeToolNames([], nextReviewSettings.trustedSourceToolNames),
      };
      setSavedReviewSettings(normalizedNextReviewSettings);
      setReviewSettings(normalizedNextReviewSettings);
      setTrustedToolNameDraft('');
    }
    setSelectedReviewId((current) => current ?? snapshotResult.reviewQueue[0]?.id ?? null);
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
        setSelectedReviewId(snapshotResult.reviewQueue[0]?.id ?? null);
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

  const [detail, setDetail] = useState<DetailPanel>({
    node: null,
    related: [],
    bundleItems: [],
    activities: [],
    artifacts: [],
  });
  const [graphRadius, setGraphRadius] = useState<1 | 2>(1);
  const [graphConnections, setGraphConnections] = useState<GraphConnection[]>([]);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [isGraphLoading, setIsGraphLoading] = useState(false);
  const [isRefreshingSummary, setIsRefreshingSummary] = useState(false);

  useEffect(() => {
    let mounted = true;
    const currentNode = selectedNode;
    if (!currentNode) return undefined;
    const nodeId = currentNode.id;

    async function loadDetail() {
      try {
        const [node, related, bundleItems, activities, artifacts] = await Promise.all([
          getNode(nodeId),
          getRelatedNodes(nodeId),
          getContextBundlePreview(nodeId),
          getActivities(nodeId),
          getArtifacts(nodeId),
        ]);

        if (!mounted) return;
        setDetail({
          node: node ?? currentNode,
          related,
          bundleItems,
          activities,
          artifacts,
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

  const [searchResults, setSearchResults] = useState<Node[]>([]);
  const [recentNodes, setRecentNodes] = useState<Node[]>([]);
  const [pinnedNodes, setPinnedNodes] = useState<Node[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const summaryLifecycle = useMemo(() => getSummaryLifecycle(detail.node), [detail.node]);

  useEffect(() => {
    if (!snapshot) return;

    let mounted = true;

    async function loadLists() {
      try {
        const [recent, pinned, reviews, results] = await Promise.all([
          getRecentNodes(),
          getPinnedNodes(),
          getReviewQueue(),
          searchNodes(deferredQuery),
        ]);

        if (!mounted) return;
        setRecentNodes(recent);
        setPinnedNodes(pinned);
        setReviewQueue(reviews.filter((item) => item.status === 'pending'));
        setSearchResults(results);
        if (selectedReviewId && !reviews.some((item) => item.id === selectedReviewId)) {
          setSelectedReviewId(reviews[0]?.id ?? null);
        }
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
  }, [deferredQuery, selectedReviewId, snapshot]);

  const activeReview = reviewQueue.find((item) => item.id === selectedReviewId) ?? reviewQueue[0];

  const homeActivities = detail.activities.slice(0, 3);
  const workspaceName = workspace?.name ?? 'Memforge';
  const semanticCounts = semanticStatus?.counts ?? {
    pending: 0,
    processing: 0,
    stale: 0,
    ready: 0,
    failed: 0,
  };
  const desktopInfo = useMemo(() => getDesktopIntegrationInfo(), []);
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

  async function refreshReviewQueue() {
    try {
      const reviews = await getReviewQueue();
      setReviewQueue(reviews.filter((item) => item.status === 'pending'));
      setSelectedReviewId((current) => current ?? reviews[0]?.id ?? null);
      setLoadError(null);
    } catch (error) {
      handleRequestFailure(error, 'Failed to refresh review queue.');
    }
  }

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
      const [nextStatus, nextIssues] = await Promise.all([
        getSemanticStatus(),
        getSemanticIssues({
          limit: 5,
          statuses: semanticIssueStatuses(semanticIssueFilter),
        }),
      ]);
      setSemanticStatus(nextStatus);
      setSemanticIssues(nextIssues.items);
      setSemanticIssuesNextCursor(nextIssues.nextCursor);
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
    if (!detail.node) {
      return;
    }
    setIsReindexingSelectedNode(true);
    setSemanticError(null);
    setSemanticNotice(null);
    try {
      await queueSemanticReindexForNode(detail.node.id);
      const [nextStatus, nextIssues] = await Promise.all([
        getSemanticStatus(),
        getSemanticIssues({
          limit: 5,
          statuses: semanticIssueStatuses(semanticIssueFilter),
        }),
      ]);
      setSemanticStatus(nextStatus);
      setSemanticIssues(nextIssues.items);
      setSemanticIssuesNextCursor(nextIssues.nextCursor);
      setSemanticNotice(`Queued semantic reindex for "${detail.node.title}".`);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to queue node reindex.';
      setSemanticError(message);
      handleRequestFailure(error, message);
    } finally {
      setIsReindexingSelectedNode(false);
    }
  }

  async function handleBundlePreviewClick(item: ContextBundlePreviewItem) {
    const targetNodeId = detail.node?.id;
    setSelectedNodeId(item.nodeId);
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
    setIsSavingCapture(true);

    try {
      const node = await createNode({
        type: captureType,
        title: captureTitle.trim(),
        body: captureBody.trim(),
      });
      await refreshWorkspaceState();
      setSelectedNodeId(node.id);
      setView(node.type === 'project' ? 'projects' : 'recent');
      setCaptureTitle('');
      setCaptureBody('');
      setCaptureType('note');
      setLoadError(null);
    } catch (error) {
      if (isAuthError(error)) {
        clearRendererToken();
        setAuthRequired(true);
        setAuthError('Enter the Memforge API token to continue.');
        setCaptureError(null);
      } else {
        setCaptureError(error instanceof Error ? error.message : 'Failed to create node.');
      }
    } finally {
      setIsSavingCapture(false);
    }
  }

  async function handleApprove(id: string) {
    try {
      await approveReview(id);
      await refreshReviewQueue();
    } catch (error) {
      handleRequestFailure(error, 'Failed to approve review item.');
    }
  }

  async function handleReject(id: string) {
    try {
      await rejectReview(id);
      await refreshReviewQueue();
    } catch (error) {
      handleRequestFailure(error, 'Failed to reject review item.');
    }
  }

  async function handleRefreshSummary() {
    if (!detail.node) {
      return;
    }

    setIsRefreshingSummary(true);
    try {
      const refreshedNode = await refreshNodeSummaryRequest(detail.node.id);
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
      setSelectedNodeId(nextSnapshot.nodes[0]?.id ?? '');
      setDetail({ node: null, related: [], bundleItems: [], activities: [], artifacts: [] });
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
      setSelectedNodeId(nextSnapshot.nodes[0]?.id ?? '');
      setDetail({ node: null, related: [], bundleItems: [], activities: [], artifacts: [] });
    } catch (error) {
      handleRequestFailure(error, 'Failed to switch workspace.');
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to switch workspace.');
    } finally {
      setIsSwitchingWorkspace(false);
    }
  }

  async function handleSaveReviewSettings() {
    setIsSavingSettings(true);
    setSettingsError(null);
    setSettingsNotice(null);

    try {
      const saved = await updateReviewSettings({
        autoApproveLowRisk: reviewSettings.autoApproveLowRisk,
        trustedSourceToolNames: mergeToolNames([], reviewSettings.trustedSourceToolNames),
      });
      const normalizedSaved = {
        autoApproveLowRisk: saved.autoApproveLowRisk,
        trustedSourceToolNames: mergeToolNames([], saved.trustedSourceToolNames),
      };
      setSavedReviewSettings(normalizedSaved);
      setReviewSettings(normalizedSaved);
      setTrustedToolNameDraft('');
      setIsSettingsDirty(false);
      setSettingsNotice('Review settings saved.');
      await refreshWorkspaceState({ syncReviewSettings: true });
    } catch (error) {
      if (isAuthError(error)) {
        clearRendererToken();
        setAuthRequired(true);
        setAuthError('Enter the Memforge API token to continue.');
      } else {
        setSettingsError(error instanceof Error ? error.message : 'Failed to save review settings.');
      }
    } finally {
      setIsSavingSettings(false);
    }
  }

  function updateReviewSettingsDraft(next: ReviewSettings) {
    setReviewSettings(next);
    setIsSettingsDirty(true);
    setSettingsNotice(null);
  }

  function toggleTrustedSourceToolName(toolName: string) {
    const normalized = normalizeToolName(toolName);
    setReviewSettings((current) => ({
      ...current,
      trustedSourceToolNames: current.trustedSourceToolNames.includes(normalized)
        ? current.trustedSourceToolNames.filter((item) => item !== normalized)
        : [...current.trustedSourceToolNames, normalized],
    }));
    setIsSettingsDirty(true);
    setSettingsNotice(null);
  }

  function addTrustedToolNamesFromDraft() {
    const additions = parseToolNames(trustedToolNameDraft);
    if (!additions.length) {
      return;
    }

    setReviewSettings((current) => ({
      ...current,
      trustedSourceToolNames: mergeToolNames(current.trustedSourceToolNames, additions),
    }));
    setIsSettingsDirty(true);
    setSettingsNotice(null);
    setTrustedToolNameDraft('');
  }

  function discardReviewSettings() {
    setReviewSettings(savedReviewSettings);
    setTrustedToolNameDraft('');
    setIsSettingsDirty(false);
    setSettingsError(null);
    setSettingsNotice('Changes discarded.');
  }

  function resetReviewSettings() {
    setReviewSettings(DEFAULT_REVIEW_SETTINGS);
    setIsSettingsDirty(true);
    setSettingsNotice(null);
    setTrustedToolNameDraft('');
  }

  function selectView(next: NavView) {
    startTransition(() => {
      setView(next);
    });
  }

  function openNodeInGraph(nodeId: string) {
    setSelectedNodeId(nodeId);
    selectView('graph');
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
          <Section title="Search" subtitle="Fast retrieval over titles, summaries, bodies, and tags.">
            <label className="search-box" htmlFor="search-input">
              <span>Query</span>
              <input
                id="search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search Memforge"
              />
            </label>
          </Section>
          <Section
            title={`Results ${searchResults.length ? `(${searchResults.length})` : ''}`}
            subtitle="Click a result to inspect the node and its local context."
          >
            <div className="stack">
              {searchResults.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className={`result-card ${selectedNodeId === node.id ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedNodeId(node.id);
                    selectView('search');
                  }}
                >
                  <div className="result-card__top">
                    <strong>{node.title}</strong>
                    <span className={`pill ${badgeTone(node.status)}`}>{node.type}</span>
                  </div>
                  <p>{node.summary}</p>
                  <div className="meta-row">
                    <span>{node.sourceLabel}</span>
                    <span>{formatTime(node.updatedAt)}</span>
                  </div>
                </button>
              ))}
              {!searchResults.length ? <div className="empty-state">No matches for this query.</div> : null}
            </div>
          </Section>
        </>
      );
    }

    if (view === 'review') {
      return (
        <Section title="Review queue" subtitle="Approve or reject incoming suggestions and promotions.">
          <div className="stack">
            {reviewQueue.map((item) => (
              <article
                key={item.id}
                className={`review-card ${selectedReviewId === item.id ? 'selected' : ''}`}
                onClick={() => setSelectedReviewId(item.id)}
              >
                <div className="result-card__top">
                  <strong>{item.reviewType}</strong>
                  <span className={`pill ${badgeTone(item.status)}`}>{item.status}</span>
                </div>
                <p>{item.notes}</p>
                <div className="meta-row">
                  <span>Proposed by {item.proposedBy}</span>
                  <span>{item.entityType}:{item.entityId}</span>
                </div>
                <div className="action-row">
                  <button type="button" onClick={() => void handleApprove(item.id)}>
                    Approve
                  </button>
                  <button type="button" className="ghost" onClick={() => void handleReject(item.id)}>
                    Reject
                  </button>
                </div>
              </article>
            ))}
            {!reviewQueue.length ? <div className="empty-state">Nothing pending review.</div> : null}
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
                  setSelectedNodeId(node.id);
                  selectView('projects');
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
                    setSelectedNodeId(event.target.value);
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
                  setSelectedNodeId(item.node.id);
                  selectView('graph');
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
                  <span className="eyebrow">Review policy</span>
                  <h3>Trusted sources and low-risk writes</h3>
                  <p className="settings-copy">Keep review for high-impact content by default. Trusted tools can bypass review for notes, decisions, and default relations.</p>
                </div>
                <div className="settings-head-meta">
                  <span className={`pill ${reviewSettings.autoApproveLowRisk ? 'tone-good' : 'tone-muted'}`}>
                    {reviewSettings.autoApproveLowRisk ? 'Low-risk auto-approve on' : 'Low-risk auto-approve off'}
                  </span>
                  <span className="pill tone-info">{reviewSettings.trustedSourceToolNames.length} trusted tool{reviewSettings.trustedSourceToolNames.length === 1 ? '' : 's'}</span>
                </div>
              </div>

              <div className="toggle-row">
                <input
                  id="auto-approve-low-risk"
                  type="checkbox"
                  checked={reviewSettings.autoApproveLowRisk}
                  onChange={(event) => {
                    updateReviewSettingsDraft({
                      ...reviewSettings,
                      autoApproveLowRisk: event.target.checked,
                    });
                  }}
                />
                <label htmlFor="auto-approve-low-risk" className="toggle-copy">
                  <strong>Auto-approve low-risk agent notes</strong>
                  <span>Useful for short append-only notes and routine agent output.</span>
                </label>
              </div>

              <div className="settings-block">
                <div className="settings-block-head">
                  <div>
                    <span className="eyebrow">Trusted source tools</span>
                    <p className="settings-copy">These `toolName` values bypass review for notes, decisions, and default relations.</p>
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setReviewSettings((current) => ({
                        ...current,
                        trustedSourceToolNames: [],
                      }));
                      setIsSettingsDirty(true);
                      setSettingsNotice(null);
                    }}
                  >
                    Clear all
                  </button>
                </div>

                <div className="chip-row">
                  {reviewSettings.trustedSourceToolNames.length ? (
                    reviewSettings.trustedSourceToolNames.map((toolName) => (
                      <button
                        key={toolName}
                        type="button"
                        className="tool-chip tool-chip--active"
                        onClick={() => toggleTrustedSourceToolName(toolName)}
                        title="Remove trusted tool"
                      >
                        <span>{toolName}</span>
                        <span aria-hidden="true">×</span>
                      </button>
                    ))
                  ) : (
                    <div className="empty-state compact">No trusted tools yet. Add one below or use a preset.</div>
                  )}
                </div>

                <div className="settings-inline">
                  <label className="search-box settings-inline__input">
                    <span>Add trusted tool</span>
                    <input
                      value={trustedToolNameDraft}
                      onChange={(event) => {
                        setTrustedToolNameDraft(event.target.value);
                        setSettingsNotice(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addTrustedToolNamesFromDraft();
                        }
                      }}
                      placeholder="codex, claude-code"
                    />
                  </label>
                  <button type="button" onClick={addTrustedToolNamesFromDraft}>
                    Add
                  </button>
                </div>

                <div className="preset-row">
                  {TRUSTED_SOURCE_PRESETS.map((toolName) => {
                    const active = reviewSettings.trustedSourceToolNames.includes(toolName);
                    return (
                      <button
                        key={toolName}
                        type="button"
                        className={`tool-chip ${active ? 'tool-chip--active' : ''}`}
                        onClick={() => toggleTrustedSourceToolName(toolName)}
                        aria-pressed={active}
                      >
                        {toolName}
                      </button>
                    );
                  })}
                </div>
              </div>

              {settingsError ? <div className="empty-state">{settingsError}</div> : null}
              {settingsNotice ? <div className="empty-state">{settingsNotice}</div> : null}

              <div className="action-row settings-actions">
                <button type="button" onClick={() => void handleSaveReviewSettings()} disabled={isSavingSettings || !isSettingsDirty}>
                  {isSavingSettings ? 'Saving...' : 'Save changes'}
                </button>
                <button type="button" className="ghost" onClick={discardReviewSettings} disabled={isSavingSettings || !isSettingsDirty}>
                  Discard
                </button>
                <button type="button" className="ghost" onClick={resetReviewSettings} disabled={isSavingSettings}>
                  Reset defaults
                </button>
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
                  setSelectedNodeId(node.id);
                  selectView('recent');
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
        <Section title="Home" subtitle="Fast re-entry point for search, review, and pinned context.">
          <div className="home-grid">
            <div className="hero-card">
              <span className="eyebrow">Workspace</span>
              <h3>{workspaceName}</h3>
              <p>
                Retrieve compact context quickly, inspect provenance, and keep suggested content
                reviewable.
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
              <span className="eyebrow">Review</span>
              <strong>{reviewQueue.length} pending items</strong>
              <p>Relation suggestions and node promotions need attention.</p>
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
                {(['all', 'failed', 'stale', 'pending'] as const).map((filter) => (
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
                setSelectedNodeId(node.id);
                selectView('projects');
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
                setSelectedNodeId(node.id);
                selectView('recent');
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
            <span className="eyebrow">Memforge v1</span>
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
              {detail.node ? (
                <div className="detail-stack">
                  <div className="detail-title">
                    <strong>{detail.node.title}</strong>
                    <span className={`pill ${badgeTone(detail.node.status)}`}>{detail.node.type}</span>
                    {summaryLifecycle.isStale ? <span className="pill tone-warn">summary stale</span> : null}
                  </div>
                  <p>{detail.node.summary}</p>
                  <div className="action-row">
                    <button type="button" onClick={() => openNodeInGraph(detail.node!.id)}>
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
                  <div className="body-copy">{detail.node.body}</div>
                  <div className="chip-row">
                    {detail.node.tags.map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="meta-grid">
                    <div>
                      <span className="eyebrow">Source</span>
                      <p>{detail.node.sourceLabel}</p>
                    </div>
                    <div>
                      <span className="eyebrow">Canonicality</span>
                      <p>{detail.node.canonicality}</p>
                    </div>
                    <div>
                      <span className="eyebrow">Summary lifecycle</span>
                      <p>
                        {summaryLifecycle.summarySource ?? 'unknown'}
                        {summaryLifecycle.summaryUpdatedAt ? ` · ${formatTime(summaryLifecycle.summaryUpdatedAt)}` : ''}
                      </p>
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
                        onClick={() => setSelectedNodeId(node.id)}
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

            <Section title="Review focus" subtitle="Highlighted item from the queue.">
              {activeReview ? (
                <div className="mini-card">
                  <strong>{activeReview.reviewType}</strong>
                  <p>{activeReview.notes}</p>
                  <span className={`pill ${badgeTone(activeReview.status)}`}>{activeReview.status}</span>
                </div>
              ) : (
                <div className="empty-state">No review items pending.</div>
              )}
            </Section>
          </aside>
        </div>
      </main>
    </div>
  );
}
