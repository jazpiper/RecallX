import { useEffect, useRef } from 'react';
import Graph from 'graphology';
import circular from 'graphology-layout/circular';
import Sigma from 'sigma';
import { projectGraphEdgeTone } from '../lib/projectGraph';
import type { ProjectGraphPayload } from '../lib/types';

type ProjectGraphCanvasProps = {
  graph: ProjectGraphPayload;
  selectedNodeId: string | null;
  emphasizedNodeIds: string[];
  emphasizedEdgeIds: string[];
  onSelectNode: (nodeId: string) => void;
};

export function ProjectGraphCanvas({
  graph,
  selectedNodeId,
  emphasizedNodeIds,
  emphasizedEdgeIds,
  onSelectNode,
}: ProjectGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const sigmaGraphRef = useRef<Graph | null>(null);
  const onSelectNodeRef = useRef(onSelectNode);

  useEffect(() => {
    onSelectNodeRef.current = onSelectNode;
  }, [onSelectNode]);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const sigmaGraph = buildSigmaGraph(graph);
    const sigma = sigmaRef.current;
    sigmaGraphRef.current = sigmaGraph;

    if (!sigma) {
      const nextSigma = new Sigma(sigmaGraph, containerRef.current, {
        renderEdgeLabels: false,
        labelDensity: 0.08,
        labelGridCellSize: 120,
        labelRenderedSizeThreshold: 10,
        labelColor: {
          color: '#ffffff',
        },
        defaultNodeType: 'circle',
        allowInvalidContainer: true,
        zIndex: true,
      });
      nextSigma.on('clickNode', ({ node }) => {
        onSelectNodeRef.current(node);
      });
      sigmaRef.current = nextSigma;
    } else {
      sigma.setGraph(sigmaGraph);
    }

    applyGraphPresentation(sigmaGraph, graph, selectedNodeId, emphasizedNodeIds, emphasizedEdgeIds);
    sigmaRef.current?.refresh();

    return undefined;
  }, [graph]);

  useEffect(() => {
    const sigmaGraph = sigmaGraphRef.current;
    if (!sigmaGraph || !sigmaRef.current) {
      return;
    }

    applyGraphPresentation(sigmaGraph, graph, selectedNodeId, emphasizedNodeIds, emphasizedEdgeIds);
    sigmaRef.current.refresh();
  }, [emphasizedEdgeIds, emphasizedNodeIds, graph, selectedNodeId]);

  useEffect(() => {
    function handleResize() {
      sigmaRef.current?.resize();
    }

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(
    () => () => {
      sigmaRef.current?.kill();
      sigmaRef.current = null;
      sigmaGraphRef.current = null;
    },
    [],
  );

  return <div ref={containerRef} className="project-graph-canvas" aria-label="Project graph canvas" />;
}

export function buildSigmaGraph(
  graph: ProjectGraphPayload,
) {
  const sigmaGraph = new Graph({ multi: true });

  for (const node of graph.nodes) {
    sigmaGraph.addNode(node.id, {
      label: node.title,
      size: baseNodeSize(node, false),
      color: nodeColor(node, { isSelected: false, isEmphasized: false }),
      x: 0,
      y: 0,
      zIndex: node.isFocus ? 2 : 1,
    });
  }

  circular.assign(sigmaGraph, {
    scale: 14,
  });
  const focusNode = graph.nodes.find((node) => node.isFocus);
  if (focusNode && sigmaGraph.hasNode(focusNode.id)) {
    sigmaGraph.mergeNodeAttributes(focusNode.id, {
      x: 0,
      y: 0,
    });
    sigmaGraph.forEachNode((nodeKey, attributes) => {
      if (nodeKey === focusNode.id) {
        return;
      }
      sigmaGraph.mergeNodeAttributes(nodeKey, {
        x: attributes.x * 1.35,
        y: attributes.y * 1.35,
      });
    });
  }

  for (const edge of graph.edges) {
    if (!sigmaGraph.hasNode(edge.source) || !sigmaGraph.hasNode(edge.target)) {
      continue;
    }

    sigmaGraph.addEdgeWithKey(edge.id, edge.source, edge.target, {
      size: baseEdgeSize(edge),
      color: edgeColor(edge, false),
      type: 'line',
      zIndex: baseEdgeZIndex(edge),
    });
  }

  return sigmaGraph;
}

function applyGraphPresentation(
  sigmaGraph: Graph,
  graph: ProjectGraphPayload,
  selectedNodeId: string | null,
  emphasizedNodeIds: string[],
  emphasizedEdgeIds: string[],
) {
  const emphasizedNodeSet = new Set(emphasizedNodeIds);
  const emphasizedEdgeSet = new Set(emphasizedEdgeIds);

  for (const node of graph.nodes) {
    if (!sigmaGraph.hasNode(node.id)) {
      continue;
    }

    const isSelected = node.id === selectedNodeId;
    const isEmphasized = emphasizedNodeSet.has(node.id);
    sigmaGraph.mergeNodeAttributes(node.id, {
      size: baseNodeSize(node, isSelected),
      color: nodeColor(node, { isSelected, isEmphasized }),
      zIndex: node.isFocus ? 2 : isSelected ? 3 : 1,
    });
  }

  for (const edge of graph.edges) {
    if (!sigmaGraph.hasEdge(edge.id)) {
      continue;
    }

    sigmaGraph.mergeEdgeAttributes(edge.id, {
      size: baseEdgeSize(edge),
      color: edgeColor(edge, emphasizedEdgeSet.has(edge.id)),
      zIndex: baseEdgeZIndex(edge),
    });
  }
}

function baseNodeSize(node: ProjectGraphPayload['nodes'][number], isSelected: boolean) {
  return (node.isFocus ? 20 : Math.min(14, 8 + node.degree * 0.8)) + (isSelected ? 3 : 0);
}

function baseEdgeSize(edge: ProjectGraphPayload['edges'][number]) {
  return edge.relationSource === 'canonical' ? 2.2 : 1.4;
}

function baseEdgeZIndex(edge: ProjectGraphPayload['edges'][number]) {
  return edge.relationSource === 'canonical' ? 1 : 0;
}

function nodeColor(
  node: ProjectGraphPayload['nodes'][number],
  options: {
    isSelected: boolean;
    isEmphasized: boolean;
  },
) {
  if (options.isSelected) {
    return '#0f172a';
  }

  if (node.isFocus) {
    return options.isEmphasized ? '#1d4ed8' : 'rgba(29, 78, 216, 0.35)';
  }

  if (options.isEmphasized) {
    switch (node.type) {
      case 'decision':
        return '#b45309';
      case 'question':
        return '#7c3aed';
      case 'reference':
        return '#0f766e';
      case 'project':
        return '#2563eb';
      default:
        return '#475569';
    }
  }

  return 'rgba(100, 116, 139, 0.28)';
}

function edgeColor(edge: ProjectGraphPayload['edges'][number], isEmphasized: boolean) {
  const base = projectGraphEdgeTone(edge);
  return withAlpha(base, isEmphasized ? (edge.relationSource === 'canonical' ? 0.72 : 0.5) : 0.14);
}

function withAlpha(color: string, alpha: number) {
  if (!color.startsWith('#')) {
    return color;
  }

  const normalized = color.slice(1);
  const expanded = normalized.length === 3 ? normalized.split('').map((part) => part + part).join('') : normalized;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
