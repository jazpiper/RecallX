import { describe, expect, it } from 'vitest';

import {
  buildHomeRecentNodes,
  buildHomeSuggestedProjectNode,
  buildPaletteRecentNodes,
  buildPinnedProjectNodes,
  buildSearchNodeTypeOptions,
  filterPaletteRecentNodes,
} from '../app/renderer/src/lib/rendererShell.js';
import type { Node } from '../app/renderer/src/lib/types.js';

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: overrides.id ?? 'node_1',
    type: overrides.type ?? 'note',
    status: overrides.status ?? 'active',
    canonicality: overrides.canonicality ?? 'canonical',
    visibility: overrides.visibility ?? 'normal',
    title: overrides.title ?? 'Example node',
    body: overrides.body ?? '',
    summary: overrides.summary ?? 'Summary',
    createdBy: overrides.createdBy ?? 'tester',
    sourceType: overrides.sourceType ?? 'human',
    sourceLabel: overrides.sourceLabel ?? 'tester',
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? '2026-03-31T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-03-31T00:00:00.000Z',
    metadata: overrides.metadata ?? {},
  };
}

describe('renderer shell selectors', () => {
  it('builds sorted unique search node type options', () => {
    const nodes = [
      makeNode({ type: 'project' }),
      makeNode({ id: 'node_2', type: 'note' }),
      makeNode({ id: 'node_3', type: 'project' }),
    ];

    expect(buildSearchNodeTypeOptions(nodes)).toEqual(['note', 'project']);
  });

  it('uses pinned project ids before project fallbacks', () => {
    const pinned = makeNode({ id: 'project_pinned', type: 'project', title: 'Pinned project' });
    const fallback = makeNode({ id: 'project_fallback', type: 'project', title: 'Fallback project' });
    const nodeMap = new Map<string, Node>([
      [pinned.id, pinned],
      [fallback.id, fallback],
    ]);

    expect(buildPinnedProjectNodes([pinned.id], nodeMap, [fallback])).toEqual([pinned]);
    expect(buildPinnedProjectNodes([], nodeMap, [fallback])).toEqual([fallback]);
  });

  it('prefers recent nodes for the Home card and excludes pinned projects', () => {
    const pinnedProject = makeNode({ id: 'project_1', type: 'project', title: 'Pinned project' });
    const recentNote = makeNode({ id: 'note_recent', title: 'Recent note' });
    const fallbackNote = makeNode({ id: 'note_fallback', title: 'Fallback note' });
    const nodeMap = new Map<string, Node>([
      [pinnedProject.id, pinnedProject],
      [recentNote.id, recentNote],
      [fallbackNote.id, fallbackNote],
    ]);

    expect(buildHomeRecentNodes([pinnedProject.id, recentNote.id], nodeMap, [pinnedProject], [fallbackNote])).toEqual([recentNote]);
    expect(buildHomeRecentNodes([], nodeMap, [pinnedProject], [fallbackNote])).toEqual([fallbackNote]);
  });

  it('deduplicates palette recent nodes while preserving order', () => {
    const activeProject = makeNode({ id: 'project_active', type: 'project', title: 'Active project' });
    const pinnedProject = makeNode({ id: 'project_pinned', type: 'project', title: 'Pinned project' });
    const recentNote = makeNode({ id: 'note_recent', title: 'Recent note' });
    const nodeMap = new Map<string, Node>([
      [activeProject.id, activeProject],
      [pinnedProject.id, pinnedProject],
      [recentNote.id, recentNote],
    ]);

    expect(
      buildPaletteRecentNodes(activeProject, [pinnedProject], [recentNote], [recentNote.id, pinnedProject.id], nodeMap).map(
        (node) => node.id,
      ),
    ).toEqual([activeProject.id, pinnedProject.id, recentNote.id]);
  });

  it('builds the suggested Home project from active, pinned, then project lists', () => {
    const activeProject = makeNode({ id: 'project_active', type: 'project' });
    const pinnedProject = makeNode({ id: 'project_pinned', type: 'project' });
    const project = makeNode({ id: 'project_list', type: 'project' });

    expect(buildHomeSuggestedProjectNode(activeProject, [pinnedProject], [project])?.id).toBe(activeProject.id);
    expect(buildHomeSuggestedProjectNode(null, [pinnedProject], [project])?.id).toBe(pinnedProject.id);
    expect(buildHomeSuggestedProjectNode(null, [], [project])?.id).toBe(project.id);
  });

  it('filters palette recent nodes against the normalized query', () => {
    const note = makeNode({ id: 'note_match', title: 'Recent note', summary: 'Alpha summary' });
    const project = makeNode({ id: 'project_other', type: 'project', title: 'Project beta', summary: 'Other' });

    expect(filterPaletteRecentNodes([note, project], 'alpha').map((node) => node.id)).toEqual([note.id]);
    expect(filterPaletteRecentNodes([note, project], '').map((node) => node.id)).toEqual([note.id, project.id]);
  });
});
