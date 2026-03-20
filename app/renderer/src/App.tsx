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
  getSnapshot,
  getWorkspaceCatalog,
  getWorkspace,
  isAuthError,
  openWorkspace as openWorkspaceSession,
  refreshNodeSummary as refreshNodeSummaryRequest,
  saveRendererToken,
  subscribeWorkspaceEvents,
} from './lib/mockApi';
import type {
  Activity,
  Artifact,
  ContextBundlePreviewItem,
  GovernanceIssueItem,
  GovernancePayload,
  GraphConnection,
  NavView,
  NodeDetail,
  Node,
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

const navigation: { id: NavView; label: string; hint: string }[] = [
  { id: 'home', label: 'Home', hint: 'landing' },
  { id: 'search', label: 'API', hint: 'local access' },
  { id: 'projects', label: 'MCP Tools', hint: 'agent route' },
  { id: 'recent', label: 'Notes', hint: 'reading' },
  { id: 'settings', label: 'Workspace', hint: 'scope' },
];

const utilityNavigation: { id: NavView; label: string }[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'governance', label: 'Governance' },
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

function getViewTitle(view: NavView) {
  switch (view) {
    case 'search':
      return 'API';
    case 'projects':
      return 'MCP Tools';
    case 'recent':
      return 'Notes';
    case 'settings':
      return 'Workspace';
    case 'governance':
      return 'Governance';
    case 'graph':
      return 'Graph';
    default:
      return 'Home';
  }
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

type GuideSection = {
  id: string;
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
  const [isNotePreviewOpen, setIsNotePreviewOpen] = useState(false);
  const [apiGuideSectionId, setApiGuideSectionId] = useState('overview');
  const [mcpGuideSectionId, setMcpGuideSectionId] = useState('overview');
  const bundleUsageEventKeysRef = useRef(new Set<string>());
  const relationUsageSessionIdRef = useRef(
    globalThis.crypto?.randomUUID?.() ?? `memforge-renderer-${Date.now()}`
  );

  async function refreshWorkspaceState(options?: {
    workspaceOverride?: WorkspaceSeed['workspace'];
    catalogOverride?: { current: WorkspaceSeed['workspace']; items: WorkspaceCatalogItem[] };
  }) {
    const [workspaceResult, snapshotResult, catalog] = await Promise.all([
      options?.workspaceOverride ? Promise.resolve(options.workspaceOverride) : getWorkspace(),
      getSnapshot(),
      options?.catalogOverride ? Promise.resolve(options.catalogOverride) : getWorkspaceCatalog(),
    ]);
    setWorkspace(options?.catalogOverride?.current ?? workspaceResult);
    setSnapshot(snapshotResult);
    setWorkspaceCatalog(catalog.items);
    setWorkspaceRootInput(catalog.current.rootPath);
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
        if (bootstrap.authMode === 'bearer' && !bootstrap.hasToken) {
          setAuthRequired(true);
          setAuthError(null);
          setLoadError(null);
          return;
        }

        await refreshWorkspaceState();
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
          setView('recent');
          focusAfterPaint('#notes-search-input');
          return;
        }

        if (payload.type === 'quick-capture') {
          setView('recent');
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

  useEffect(() => {
    if (!snapshot?.nodes.length) {
      return;
    }
    if (!selectedNodeId || nodeMap.has(selectedNodeId)) {
      return;
    }
    setSelectedNodeId(snapshot.nodes[0]?.id ?? '');
  }, [nodeMap, selectedNodeId, snapshot]);

  const graphFocusableNodes = useMemo(
    () =>
      (snapshot?.nodes ?? [])
        .slice()
        .sort((left, right) => (left.title || '').localeCompare(right.title || '') || left.updatedAt.localeCompare(right.updatedAt)),
    [snapshot],
  );

  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) ?? null : null;
  const selectedNodeKey = selectedNode?.id ?? null;

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
    if (!currentNode || !selectedNodeKey) return undefined;
    const nodeId = selectedNodeKey;
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
  }, [selectedNodeKey]);

  useEffect(() => {
    let mounted = true;
    const currentNode = selectedNode;
    if (!currentNode || !selectedNodeKey) return undefined;
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
  }, [graphRadius, selectedNodeKey]);

  const [governanceIssues, setGovernanceIssues] = useState<GovernanceIssueItem[]>([]);
  const noteNodes = useMemo(() => {
    const candidates = snapshot?.nodes ?? [];
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    const filtered = normalizedQuery
      ? candidates.filter((node) =>
          [node.title, node.summary, node.body, node.tags.join(' ')]
            .join(' ')
            .toLowerCase()
            .includes(normalizedQuery),
        )
      : candidates;

    return filtered
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title));
  }, [deferredQuery, snapshot]);
  const activeNoteNode = useMemo(
    () => noteNodes.find((node) => node.id === selectedNodeId) ?? null,
    [noteNodes, selectedNodeId],
  );
  const notePreviewNode = isNotePreviewOpen
    ? detail.node?.id === activeNoteNode?.id
      ? detail.node
      : activeNoteNode
    : null;

  useEffect(() => {
    if (!snapshot || view !== 'governance') return;

    let mounted = true;

    async function loadLists() {
      try {
        const issues = await getGovernanceIssues();

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
  }, [snapshot, view]);

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

  const workspaceName = workspace?.name ?? 'Memforge';
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
  const apiGuideSections: GuideSection[] = [
    {
      id: 'overview',
      label: 'Overview',
      eyebrow: 'Entry point',
      title: 'Start with the local base URL.',
      body: 'This page should feel like a quick reference, not a wall of docs. Use the local API when you want direct loopback access into the current Memforge workspace.',
      points: [
        `Base URL: ${apiBase}`,
        workspace?.authMode === 'bearer' ? 'Bearer auth is enabled for this workspace.' : 'Local mode is available without extra auth friction.',
        'Use this route for health, workspace inspection, and bootstrap calls before deeper integration.',
      ],
      stats: [
        {
          label: 'Base URL',
          value: apiBase,
          description: 'Primary endpoint for local integrations.',
        },
        {
          label: 'Auth mode',
          value: workspace?.authMode === 'bearer' ? 'Bearer auth' : 'Loopback-first',
          description: workspace?.authMode === 'bearer' ? 'Include the Authorization header.' : 'No extra auth header in local mode.',
        },
      ],
    },
    {
      id: 'routes',
      label: 'Core routes',
      eyebrow: 'Starter routes',
      title: 'Keep the first three routes in easy reach.',
      body: 'Most sessions only need a small route set. These are the ones worth surfacing first before expanding into deeper API docs.',
      points: [
        '/health for service status and the currently active workspace.',
        '/workspace for the current workspace metadata and scope details.',
        '/bootstrap for the starting index when a client needs to discover service capabilities.',
      ],
      stats: [
        {
          label: '/health',
          value: 'Check',
          description: 'Service status and active workspace.',
        },
        {
          label: '/workspace',
          value: 'Inspect',
          description: 'Current workspace details.',
        },
        {
          label: '/bootstrap',
          value: 'Begin',
          description: 'Service entry for clients.',
        },
      ],
    },
    {
      id: 'examples',
      label: 'Examples',
      eyebrow: 'Quick example',
      title: 'Copy the local calls and move on.',
      body: 'Examples should stay compact here. The goal is to let someone make the first successful request without digging through a dense reference page.',
      points: [
        'Use curl for the quickest local verification loop.',
        'Keep the Authorization header only when bearer mode is enabled.',
        'Treat this screen as a launchpad, then move detailed API usage elsewhere.',
      ],
      code: apiExample,
    },
    {
      id: 'paths',
      label: 'Workspace paths',
      eyebrow: 'Local paths',
      title: 'Know where the current workspace lives.',
      body: 'This is useful when you need to inspect the underlying local store, database, or artifacts without jumping through another admin page.',
      points: [
        `Workspace root: ${workspaceRoot || 'Unavailable'}`,
        `Database: ${workspaceDbPath || 'Unavailable'}`,
        `Artifacts: ${artifactsPath || 'Unavailable'}`,
      ],
      stats: [
        {
          label: 'Workspace root',
          value: workspaceRoot || 'Unavailable',
          description: 'Current workspace directory.',
        },
        {
          label: 'Database',
          value: workspaceDbPath || 'Unavailable',
          description: 'Primary local store.',
        },
        {
          label: 'Artifacts',
          value: artifactsPath || 'Unavailable',
          description: 'Generated files and attachments.',
        },
      ],
    },
  ];
  const activeApiGuideSection =
    apiGuideSections.find((section) => section.id === apiGuideSectionId) ?? apiGuideSections[0];
  const mcpGuideSections: GuideSection[] = [
    {
      id: 'overview',
      label: 'Overview',
      eyebrow: 'Agent route',
      title: 'Use MCP when the client is an agent, not a human clicking around.',
      body: 'This page should surface the core agent workflow first. Keep it clear which tools are used for broad recall, precise recall, soft capture, and anchored context.',
      points: [
        'Search broad with memforge_search_workspace when the target is still unclear.',
        'Search precise with memforge_search_nodes, especially for type=project checks.',
        'Keep capture soft first, then anchor with targetId only when the project or node is genuinely known.',
      ],
      stats: [
        {
          label: 'Search broad',
          value: 'memforge_search_workspace',
          description: 'Mixed recall across nodes and activities.',
        },
        {
          label: 'Search precise',
          value: 'memforge_search_nodes',
          description: 'Project and durable node checks.',
        },
      ],
    },
    {
      id: 'connect',
      label: 'Connection',
      eyebrow: 'Launch',
      title: 'Start from the MCP launcher configuration.',
      body: 'Keep the connection instructions visible, but compact. Most users need either the mcpServers block or the local launcher command, not a long setup essay.',
      points: [
        'Use the launcher config when wiring Memforge into an agent client.',
        'Use the local command when testing the MCP server directly.',
        'Keep the API target pointed at the active local workspace service.',
      ],
      code: `${genericMcpConfig}\n\n${mcpCommand}`,
    },
    {
      id: 'flow',
      label: 'Search flow',
      eyebrow: 'Recommended flow',
      title: 'Search first, then decide whether to anchor.',
      body: 'The page should make the order obvious so agents do not jump straight into project creation or over-specific retrieval too early.',
      points: [
        '1. Check the current workspace context first.',
        '2. Use memforge_search_nodes with type=project when you are checking for an existing project.',
        '3. Expand to memforge_search_workspace when you need broader recall across nodes and activities.',
      ],
      stats: [
        {
          label: 'Step 1',
          value: 'Check workspace',
          description: 'Stay in current scope by default.',
        },
        {
          label: 'Step 2',
          value: 'Search first',
          description: 'Avoid guessing a project.',
        },
        {
          label: 'Step 3',
          value: 'Anchor later',
          description: 'Bundle only when the target is known.',
        },
      ],
    },
    {
      id: 'capture',
      label: 'Capture',
      eyebrow: 'Write path',
      title: 'Write lightly unless the target is already clear.',
      body: 'This is the part that prevents over-structuring. Use the default write path for general notes or conversation outcomes, then move into stronger anchoring only when it helps.',
      points: [
        'memforge_capture_memory is the safe default when work is not yet tied to a specific project or node.',
        'memforge_append_activity is best for routine summaries and work logs.',
        'memforge_context_bundle should include targetId only after the project or node is truly known.',
      ],
      stats: [
        {
          label: 'Default write',
          value: 'memforge_capture_memory',
          description: 'Low-friction capture path.',
        },
        {
          label: 'Routine logging',
          value: 'memforge_append_activity',
          description: 'Progress and execution notes.',
        },
        {
          label: 'Anchored context',
          value: 'memforge_context_bundle',
          description: 'Use targetId only when ready.',
        },
      ],
    },
  ];
  const activeMcpGuideSection =
    mcpGuideSections.find((section) => section.id === mcpGuideSectionId) ?? mcpGuideSections[0];
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
  const graphRelationGroups = useMemo(
    () =>
      Object.entries(graphRelationCounts)
        .map(([relationType, count]) => ({
          relationType,
          count,
        }))
        .sort((left, right) => right.count - left.count || left.relationType.localeCompare(right.relationType)),
    [graphRelationCounts],
  );
  const graphIncomingCount = useMemo(
    () => graphConnections.filter((item) => item.direction === 'incoming').length,
    [graphConnections],
  );
  const graphOutgoingCount = useMemo(
    () => graphConnections.filter((item) => item.direction === 'outgoing').length,
    [graphConnections],
  );
  const graphSuggestedCount = useMemo(
    () => graphConnections.filter((item) => item.relation.status === 'suggested').length,
    [graphConnections],
  );
  const governanceStateCounts = useMemo(
    () =>
      governanceIssues.reduce<Record<string, number>>((acc, item) => {
        acc[item.state] = (acc[item.state] ?? 0) + 1;
        return acc;
      }, {}),
    [governanceIssues],
  );
  const activeGovernanceNode =
    activeGovernanceIssue?.entityType === 'node' ? nodeMap.get(activeGovernanceIssue.entityId) ?? null : null;

  function resetWorkspaceSelection(nextSnapshot: WorkspaceSeed) {
    setSelectedNodeId(nextSnapshot.nodes[0]?.id ?? '');
    setIsNotePreviewOpen(false);
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
      setIsNotePreviewOpen(false);
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
      const catalog = await createWorkspaceSession({
        rootPath,
        workspaceName: workspaceNameInput.trim() || undefined,
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
    setWorkspaceActionError(null);
    setIsSwitchingWorkspace(true);
    try {
      const catalog = await openWorkspaceSession(rootPath);
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

  function selectView(next: NavView) {
    startTransition(() => {
      setView(next);
    });
  }

  function openNodeInGraph(nodeId: string) {
    focusNode(nodeId, 'graph');
  }

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

    if (authRequired && !snapshot) {
      return (
        <section className="page-section page-section--centered">
          <div className="card auth-card">
            <div className="page-copy">
              <span className="eyebrow">Renderer authentication</span>
              <h2>Connect to continue</h2>
              <p>This workspace requires a bearer token before the renderer can use the live API.</p>
            </div>
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

    if (view === 'search') {
      return (
        <section className="page-section">
          <div className="page-heading">
            <span className="eyebrow">Local access</span>
            <h2>The loopback API, simplified.</h2>
            <p>Use the left menu like a normal guide page. Keep the surface compact and reveal detail only when needed.</p>
          </div>
          <div className="guide-layout">
            <aside className="card guide-nav">
              <div className="page-copy compact-copy">
                <span className="eyebrow">API guide</span>
                <h3>Sections</h3>
              </div>
              <div className="guide-nav-list">
                {apiGuideSections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className={`guide-nav-item ${activeApiGuideSection.id === section.id ? 'active' : ''}`}
                    onClick={() => setApiGuideSectionId(section.id)}
                  >
                    <strong>{section.label}</strong>
                    <span>{section.eyebrow}</span>
                  </button>
                ))}
              </div>
            </aside>
            <section className="card guide-detail">
              <div className="page-copy">
                <span className="eyebrow">{activeApiGuideSection.eyebrow}</span>
                <h3>{activeApiGuideSection.title}</h3>
                <p>{activeApiGuideSection.body}</p>
              </div>
              {activeApiGuideSection.stats?.length ? (
                <div className={`info-grid ${activeApiGuideSection.stats.length >= 3 ? 'three' : 'two'}`}>
                  {activeApiGuideSection.stats.map((item) => (
                    <article key={item.label} className="info-block">
                      <span className="info-label">{item.label}</span>
                      <strong>{item.value}</strong>
                      <p>{item.description}</p>
                    </article>
                  ))}
                </div>
              ) : null}
              <div className="guide-points">
                {activeApiGuideSection.points.map((point) => (
                  <article key={point} className="route-card">
                    <div>
                      <strong>{point}</strong>
                    </div>
                  </article>
                ))}
              </div>
              {activeApiGuideSection.code ? <pre className="code-block">{activeApiGuideSection.code}</pre> : null}
            </section>
          </div>
        </section>
      );
    }

    if (view === 'projects') {
      return (
        <section className="page-section">
          <div className="page-heading">
            <span className="eyebrow">Agent-native route</span>
            <h2>MCP tools, with less noise.</h2>
            <p>Use the left menu to move through the setup and workflow, the way a normal guide page would.</p>
          </div>
          <div className="guide-layout">
            <aside className="card guide-nav">
              <div className="page-copy compact-copy">
                <span className="eyebrow">MCP guide</span>
                <h3>Sections</h3>
              </div>
              <div className="guide-nav-list">
                {mcpGuideSections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className={`guide-nav-item ${activeMcpGuideSection.id === section.id ? 'active' : ''}`}
                    onClick={() => setMcpGuideSectionId(section.id)}
                  >
                    <strong>{section.label}</strong>
                    <span>{section.eyebrow}</span>
                  </button>
                ))}
              </div>
            </aside>
            <section className="card guide-detail">
              <div className="page-copy">
                <span className="eyebrow">{activeMcpGuideSection.eyebrow}</span>
                <h3>{activeMcpGuideSection.title}</h3>
                <p>{activeMcpGuideSection.body}</p>
              </div>
              {activeMcpGuideSection.stats?.length ? (
                <div className={`info-grid ${activeMcpGuideSection.stats.length >= 3 ? 'three' : 'two'}`}>
                  {activeMcpGuideSection.stats.map((item) => (
                    <article key={item.label} className="info-block">
                      <span className="info-label">{item.label}</span>
                      <strong>{item.value}</strong>
                      <p>{item.description}</p>
                    </article>
                  ))}
                </div>
              ) : null}
              <div className="guide-points">
                {activeMcpGuideSection.points.map((point) => (
                  <article key={point} className="route-card">
                    <div>
                      <strong>{point}</strong>
                    </div>
                  </article>
                ))}
              </div>
              {activeMcpGuideSection.code ? <pre className="code-block">{activeMcpGuideSection.code}</pre> : null}
            </section>
          </div>
        </section>
      );
    }

    if (view === 'governance') {
      return (
        <section className="page-section">
          <div className="page-heading">
            <span className="eyebrow">Governance</span>
            <h2>Governance explorer</h2>
            <p>Use this as a triage surface for contested and low-confidence memory. It should make issue state, cause, and next action easy to scan.</p>
          </div>
          <div className="governance-layout">
            <aside className="card governance-list">
              <div className="section-head section-head--compact">
                <div>
                  <span className="eyebrow">Issue queue</span>
                  <h3>Current surfaced items</h3>
                </div>
                <span className="pill tone-muted">{governanceIssues.length}</span>
              </div>
              <div className="info-grid three">
                <article className="info-block">
                  <span className="info-label">Contested</span>
                  <strong>{governanceStateCounts.contested ?? 0}</strong>
                  <p>Highest-priority contradictions or repeated negative signals.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Low confidence</span>
                  <strong>{governanceStateCounts.low_confidence ?? 0}</strong>
                  <p>Items that need stronger repeated confirmation.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Healthy</span>
                  <strong>{governanceStateCounts.healthy ?? 0}</strong>
                  <p>Stable states that are currently not in the issue queue.</p>
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
                      <span>{item.entityType}:{item.entityId}</span>
                      <span>confidence {formatConfidence(item.confidence)}</span>
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
                      <p>Current trust level for the selected issue.</p>
                    </article>
                    <article className="info-block">
                      <span className="info-label">Action</span>
                      <strong>{getGovernanceActionLabel(activeGovernanceIssue)}</strong>
                      <p>{getGovernanceStateSummary(activeGovernanceIssue.state)}</p>
                    </article>
                    <article className="info-block">
                      <span className="info-label">Last transition</span>
                      <strong>{formatTime(activeGovernanceIssue.lastTransitionAt)}</strong>
                      <p>Most recent governance state change.</p>
                    </article>
                  </div>
                  <div className="governance-detail-grid">
                    <article className="card governance-detail-card">
                      <div className="page-copy compact-copy">
                        <span className="eyebrow">Why this surfaced</span>
                        <h3>Reason summary</h3>
                      </div>
                      <div className="card-stack compact-stack">
                        {activeGovernanceIssue.reasons.map((reason) => (
                          <article key={reason} className="mini-card">
                            <strong>{reason}</strong>
                          </article>
                        ))}
                        {!activeGovernanceIssue.reasons.length ? (
                          <div className="empty-state compact">No explicit governance reasons were attached to this issue.</div>
                        ) : null}
                      </div>
                    </article>

                    <article className="card governance-detail-card">
                      <div className="page-copy compact-copy">
                        <span className="eyebrow">Context</span>
                        <h3>Selected entity</h3>
                      </div>
                      {activeGovernanceNode ? (
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
                              Open in notes
                            </button>
                            <button type="button" className="ghost" onClick={() => focusNode(activeGovernanceNode.id, 'graph')}>
                              Open in graph
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="empty-state compact">
                          This issue is not currently attached to a visible node card in the active workspace view.
                        </div>
                      )}
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
            <h2>Relationship explorer</h2>
            <p>Use this as a focused secondary view for connected memory. It should explain what is linked, what is missing, and what to inspect next.</p>
          </div>
          <section className="card page-card">
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
            </div>
            <div className="graph-summary-grid">
              <article className="graph-focus graph-focus-card">
                <span className="eyebrow">Focus node</span>
                <strong>{selectedNode?.title}</strong>
                <p>{selectedNode?.summary}</p>
              </article>
              <article className="mini-card">
                <span className="eyebrow">Connected nodes</span>
                <strong>{graphDistinctNodes.length} nodes</strong>
                <p>{graphConnections.length} visible paths around the current focus.</p>
              </article>
              <article className="mini-card">
                <span className="eyebrow">Signal mix</span>
                <strong>{graphRelationGroups.length} relation types</strong>
                <p>{graphSuggestedCount} suggested links still need review.</p>
              </article>
              <article className="mini-card">
                <span className="eyebrow">Direction</span>
                <strong>{graphOutgoingCount} out / {graphIncomingCount} in</strong>
                <p>Shows whether this node mostly points outward or is referenced by others.</p>
              </article>
            </div>
            {graphError ? <div className="empty-state">{graphError}</div> : null}
            {isGraphLoading ? <div className="empty-state">Loading graph neighborhood...</div> : null}
            {!isGraphLoading && !graphConnections.length ? (
              <div className="graph-empty">
                <div className="empty-state">
                  No linked memory is visible for this node yet. Create relations first, or inspect nearby context signals below.
                </div>
                <div className="graph-support-grid">
                  <article className="mini-card">
                    <strong>Context bundle signals</strong>
                    <p>
                      {detail.bundleItems.length
                        ? `${detail.bundleItems.length} bundle items are available even though explicit graph links are still missing.`
                        : 'No context bundle signals are available for this node yet.'}
                    </p>
                  </article>
                  <article className="mini-card">
                    <strong>Related detail nodes</strong>
                    <p>
                      {detail.related.length
                        ? `${detail.related.length} related nodes were found in node detail and can guide the first relation pass.`
                        : 'Node detail does not currently expose explicit related nodes for this focus.'}
                    </p>
                  </article>
                </div>
              </div>
            ) : null}
            {!!graphRelationGroups.length ? (
              <section className="graph-section-grid">
                <article className="card relation-group-card">
                  <div className="section-head section-head--compact">
                    <div>
                      <span className="eyebrow">Relation groups</span>
                      <h3>What kind of links exist?</h3>
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
                      <h3>Open another node from here</h3>
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
            {(detail.bundleItems.length || detail.activities.length) && !isGraphLoading ? (
              <section className="graph-section-grid">
                <article className="card relation-group-card">
                  <div className="section-head section-head--compact">
                    <div>
                      <span className="eyebrow">Context signals</span>
                      <h3>Suggested nearby memory</h3>
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
                      <h3>Latest movement around this node</h3>
                    </div>
                  </div>
                  <div className="card-stack compact-stack">
                    {detail.activities.slice(0, 3).map((activity) => (
                      <article key={activity.id} className="mini-card">
                        <strong>{activity.activityType}</strong>
                        <p>{activity.body}</p>
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
            <h2>Scope management, not clutter.</h2>
            <p>Workspace switching stays user-directed. Projects stay inside the current workspace instead of replacing it.</p>
          </div>
          <div className="two-column-grid">
            <section className="card page-card">
              <div className="info-grid three">
                <article className="info-block">
                  <span className="info-label">Active</span>
                  <strong>{workspaceName}</strong>
                  <p>Primary local workspace and default scope for recall.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">Mode</span>
                  <strong>Workspace-first</strong>
                  <p>Projects stay inside the current workspace instead of becoming it.</p>
                </article>
                <article className="info-block">
                  <span className="info-label">API bind</span>
                  <strong>{workspace?.apiBind ?? '127.0.0.1:8787'}</strong>
                  <p>Local integration boundary for this workspace.</p>
                </article>
              </div>
              <form className="capture-form compact-form" onSubmit={(event) => void handleCreateWorkspace(event)}>
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
                <h3>Resume another memory field</h3>
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
        </section>
      );
    }

    if (view === 'recent') {
      return (
        <section className="page-section">
          <div className="page-heading">
            <span className="eyebrow">Notes</span>
            <h2>Memory cards for the current workspace.</h2>
            <p>Use the board to scan quickly, then open a card for the full note. Keep the surface lighter than the old wide reading layout.</p>
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
                  placeholder="Search memory field"
                />
              </label>
              <div className="chip-row">
                <span className="chip chip-static">{noteNodes.length} visible</span>
                <span className="chip chip-static">{workspaceName}</span>
              </div>
            </section>

            <section className="card notes-toolbar-card">
              <div className="page-copy compact-copy">
                <span className="eyebrow">Quick note</span>
                <h3>Create a new card</h3>
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
                    {isSavingCapture ? 'Saving...' : 'Create note'}
                  </button>
                </div>
              </form>
              {captureError ? <div className="empty-state compact">{captureError}</div> : null}
              {captureNotice ? <div className="notice">{captureNotice}</div> : null}
            </section>
          </div>

          {noteNodes.length ? (
            <section className="notes-board">
              {noteNodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className={`note-tile ${activeNoteNode?.id === node.id ? 'selected' : ''}`}
                  onClick={() => {
                    focusNode(node.id, 'recent');
                    setIsNotePreviewOpen(true);
                  }}
                >
                  <div className="result-card__top">
                    <span className={`pill ${badgeTone(node.status)}`}>{node.type}</span>
                    <span className="note-tile-time">{formatTime(node.updatedAt)}</span>
                  </div>
                  <strong>{node.title}</strong>
                  <p>{node.summary || node.body || 'No summary yet.'}</p>
                  <div className="chip-row">
                    {node.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="meta-row">
                    <span>{node.sourceLabel}</span>
                  </div>
                </button>
              ))}
            </section>
          ) : (
            <div className="empty-state">
              {snapshot?.nodes.length
                ? 'No cards match this query.'
                : 'There are no saved memory cards in the current workspace yet.'}
            </div>
          )}

          {notePreviewNode ? (
            <div
              className="note-overlay"
              onClick={() => {
                setIsNotePreviewOpen(false);
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
                    <h3>{notePreviewNode.title}</h3>
                  </div>
                  <div className="note-modal-actions">
                    <span className={`pill ${badgeTone(notePreviewNode.status)}`}>{notePreviewNode.type}</span>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setIsNotePreviewOpen(false);
                      }}
                    >
                      Close
                    </button>
                  </div>
                </div>
                <div className="note-reading-pane">{notePreviewNode.body || notePreviewNode.summary}</div>
                <div className="chip-row">
                  {notePreviewNode.tags.map((tag) => (
                    <span key={tag} className="chip">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="action-row">
                  <button type="button" onClick={() => openNodeInGraph(notePreviewNode.id)}>
                    Inspect in graph
                  </button>
                  <button type="button" className="ghost" onClick={() => void handleRefreshSummary()} disabled={isRefreshingSummary}>
                    {isRefreshingSummary ? 'Refreshing...' : 'Refresh summary'}
                  </button>
                </div>
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
                      <strong>{activity.activityType}</strong>
                      <p>{activity.body}</p>
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
        <div className="home-hero">
          <span className="eyebrow">Memforge</span>
          <h2>Local API and MCP access.</h2>
          <p>Start here. Open the rest from the top menu.</p>
          <div className="hero-actions">
            <button type="button" className="hero-button hero-button--primary" onClick={() => selectView('search')}>
              Open API
            </button>
            <button type="button" className="hero-button hero-button--secondary" onClick={() => selectView('projects')}>
              Open MCP Tools
            </button>
          </div>
          <div className="info-grid two">
            <article className="info-block">
              <span className="info-label">Local API</span>
              <strong>Health, workspace, bootstrap.</strong>
              <p>Direct local endpoints.</p>
            </article>
            <article className="info-block">
              <span className="info-label">MCP Tools</span>
              <strong>Search, capture, bundle.</strong>
              <p>Agent-native access.</p>
            </article>
          </div>
        </div>
      </section>
    );
  })();

  return (
    <div className="app-shell">
      <main className="workspace">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" />
            <div>
              <strong>{workspaceName}</strong>
              <p>{getViewTitle(view)}</p>
            </div>
          </div>
          <nav className="nav-list nav-list--top" aria-label="Main navigation">
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
          <div className="topbar-meta">
            <div className="utility-nav" aria-label="Utility navigation">
              {utilityNavigation.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`utility-nav-item ${view === item.id ? 'active' : ''}`}
                  onClick={() => selectView(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <span>{workspace?.apiBind ?? '127.0.0.1:8787'}</span>
            <span>{workspace?.integrationModes.join(' / ') || 'local / append-only'}</span>
          </div>
        </header>
        {loadError && snapshot ? <div className="banner">{loadError}</div> : null}
        <div className="workspace-body">{pageContent}</div>
      </main>
    </div>
  );
}
