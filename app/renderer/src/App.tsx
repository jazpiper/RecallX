import { useDeferredValue, useEffect, useMemo, useState, startTransition } from 'react';
import {
  approveReview,
  clearRendererToken,
  createWorkspace as createWorkspaceSession,
  createNode,
  getBootstrap,
  getActivities,
  getArtifacts,
  getNode,
  getPinnedNodes,
  getRecentNodes,
  getRelatedNodes,
  getReviewQueue,
  getSnapshot,
  getWorkspace,
  getWorkspaceCatalog,
  isAuthError,
  openWorkspace as openWorkspaceSession,
  rejectReview,
  saveRendererToken,
  searchNodes,
} from './lib/mockApi';
import type {
  Activity,
  Artifact,
  NavView,
  Node,
  ReviewQueueItem,
  WorkspaceCatalogItem,
  WorkspaceSeed,
} from './lib/types';

type DetailPanel = {
  node: Node | null;
  related: Node[];
  activities: Activity[];
  artifacts: Artifact[];
};

const navigation: { id: NavView; label: string; hint: string }[] = [
  { id: 'home', label: 'Home', hint: 're-entry' },
  { id: 'search', label: 'Search', hint: 'retrieval' },
  { id: 'projects', label: 'Projects', hint: 'core nodes' },
  { id: 'recent', label: 'Recent', hint: 'latest work' },
  { id: 'review', label: 'Review', hint: 'governance' },
  { id: 'graph', label: 'Graph', hint: 'secondary' },
  { id: 'settings', label: 'Settings', hint: 'workspace' },
];

function badgeTone(status: string) {
  if (status === 'active' || status === 'approved') return 'tone-good';
  if (status === 'review' || status === 'pending') return 'tone-warn';
  if (status === 'draft' || status === 'suggested') return 'tone-info';
  return 'tone-muted';
}

function formatTime(iso: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
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

  async function refreshWorkspaceState() {
    const [workspaceResult, snapshotResult, catalog] = await Promise.all([getWorkspace(), getSnapshot(), getWorkspaceCatalog()]);
    setWorkspace(workspaceResult);
    setSnapshot(snapshotResult);
    setWorkspaceCatalog(catalog.items);
    setWorkspaceRootInput(catalog.current.rootPath);
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

  const nodeMap = useMemo(() => {
    const map = new Map<string, Node>();
    snapshot?.nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [snapshot]);

  const selectedNode = nodeMap.get(selectedNodeId) ?? snapshot?.nodes[0] ?? null;

  const [detail, setDetail] = useState<DetailPanel>({
    node: null,
    related: [],
    activities: [],
    artifacts: [],
  });

  useEffect(() => {
    let mounted = true;
    const currentNode = selectedNode;
    if (!currentNode) return undefined;
    const nodeId = currentNode.id;

    async function loadDetail() {
      try {
        const [node, related, activities, artifacts] = await Promise.all([
          getNode(nodeId),
          getRelatedNodes(nodeId),
          getActivities(nodeId),
          getArtifacts(nodeId),
        ]);

        if (!mounted) return;
        setDetail({
          node: node ?? currentNode,
          related,
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

  const [searchResults, setSearchResults] = useState<Node[]>([]);
  const [recentNodes, setRecentNodes] = useState<Node[]>([]);
  const [pinnedNodes, setPinnedNodes] = useState<Node[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);

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
      setDetail({ node: null, related: [], activities: [], artifacts: [] });
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
      setDetail({ node: null, related: [], activities: [], artifacts: [] });
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
        <Section title="Graph" subtitle="Secondary view, centered on the selected node.">
          <div className="graph-shell">
            {detail.related.map((node) => (
              <div key={node.id} className="graph-node">
                <strong>{node.title}</strong>
                <span>{node.type}</span>
              </div>
            ))}
            <div className="graph-focus">
              <strong>{selectedNode?.title}</strong>
              <span>focus</span>
            </div>
          </div>
        </Section>
      );
    }

    if (view === 'settings') {
      return (
        <Section title="Settings" subtitle="Workspace identity and local integration boundaries.">
          <div className="grid-2">
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
          <div className="stack">
            <span className="eyebrow">Recent workspaces</span>
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
              <input value={captureTitle} onChange={(event) => setCaptureTitle(event.target.value)} placeholder="Memforge retrieval rule" />
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
                  </div>
                  <p>{detail.node.summary}</p>
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
