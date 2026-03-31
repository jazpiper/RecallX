import type { Node } from './types.js';

export function buildSearchNodeTypeOptions(nodes: Array<Pick<Node, 'type'>>): Node['type'][] {
  return Array.from(new Set(nodes.map((node) => node.type))).sort((left, right) => left.localeCompare(right));
}

export function buildPinnedProjectNodes(
  pinnedProjectIds: string[] | null | undefined,
  nodeMap: Map<string, Node>,
  projectNodes: Node[],
): Node[] {
  const fromPinned = (pinnedProjectIds ?? [])
    .map((nodeId) => nodeMap.get(nodeId))
    .filter((node): node is Node => node !== undefined && node.type === 'project');

  if (fromPinned.length) {
    return fromPinned;
  }

  return projectNodes.slice(0, 3);
}

export function buildHomeRecentNodes(
  recentNodeIds: string[] | null | undefined,
  nodeMap: Map<string, Node>,
  pinnedProjectNodes: Node[],
  searchableNoteNodes: Node[],
): Node[] {
  const pinnedIds = new Set(pinnedProjectNodes.map((node) => node.id));
  const recentNodes = (recentNodeIds ?? [])
    .map((nodeId) => nodeMap.get(nodeId))
    .filter((node): node is Node => node !== undefined && !pinnedIds.has(node.id));

  if (recentNodes.length) {
    return recentNodes.slice(0, 4);
  }

  return searchableNoteNodes.filter((node) => !pinnedIds.has(node.id)).slice(0, 4);
}

export function buildPaletteRecentNodes(
  activeProjectNode: Node | null,
  pinnedProjectNodes: Node[],
  homeRecentNodes: Node[],
  recentNodeIds: string[] | null | undefined,
  nodeMap: Map<string, Node>,
): Node[] {
  const orderedNodes = [
    activeProjectNode,
    ...pinnedProjectNodes,
    ...homeRecentNodes,
    ...(recentNodeIds ?? []).map((nodeId) => nodeMap.get(nodeId) ?? null),
  ].filter((node): node is Node => node !== null);

  const seen = new Set<string>();
  return orderedNodes
    .filter((node) => {
      if (seen.has(node.id)) {
        return false;
      }
      seen.add(node.id);
      return true;
    })
    .slice(0, 6);
}

export function buildHomeSuggestedProjectNode(
  activeProjectNode: Node | null,
  pinnedProjectNodes: Node[],
  projectNodes: Node[],
): Node | null {
  return activeProjectNode ?? pinnedProjectNodes[0] ?? projectNodes[0] ?? null;
}

export function filterPaletteRecentNodes(nodes: Node[], normalizedQuery: string): Node[] {
  if (!normalizedQuery) {
    return nodes;
  }

  return nodes.filter((node) => [node.title, node.summary, node.type].join(' ').toLowerCase().includes(normalizedQuery));
}
