import { describe, expect, it } from "vitest";

import {
  buildDuplicateIndex,
  buildPreviewFromPlan,
  detectDuplicateMatch,
  normalizeBody,
  normalizeTitle,
  resolveImportOptions,
  type ImportPlan,
  type PlannedNode,
  type SeenImportIndex,
} from "../app/server/workspace-import-helpers.js";
import type { NodeRecord } from "../app/shared/types.js";

function makeNodeRecord(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id: overrides.id ?? "node_existing",
    type: overrides.type ?? "note",
    title: overrides.title ?? "Existing note",
    body: overrides.body ?? "Existing body",
    summary: overrides.summary ?? "Summary",
    status: overrides.status ?? "active",
    canonicality: overrides.canonicality ?? "canonical",
    visibility: overrides.visibility ?? "normal",
    createdBy: overrides.createdBy ?? "tester",
    sourceType: overrides.sourceType ?? "human",
    sourceLabel: overrides.sourceLabel ?? "tester",
    tags: overrides.tags ?? [],
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? "2026-03-31T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-31T00:00:00.000Z",
  };
}

function makePlannedNode(overrides: Partial<PlannedNode> = {}): PlannedNode {
  return {
    sourcePath: overrides.sourcePath ?? "/tmp/example.md",
    title: overrides.title ?? "Imported note",
    body: overrides.body ?? "Imported body",
    type: overrides.type ?? "note",
    summary: overrides.summary,
    tags: overrides.tags ?? [],
    canonicality: overrides.canonicality,
    status: overrides.status,
    metadata: overrides.metadata ?? {},
    originalId: overrides.originalId ?? null,
    originalSourceLabel: overrides.originalSourceLabel ?? null,
    originalCreatedAt: overrides.originalCreatedAt ?? null,
    duplicate: overrides.duplicate ?? null,
  };
}

describe("workspace import helpers", () => {
  it("resolves import options with safe defaults", () => {
    expect(resolveImportOptions()).toEqual({
      normalizeTitleWhitespace: true,
      trimBodyWhitespace: false,
      duplicateMode: "warn",
    });
    expect(
      resolveImportOptions({
        normalizeTitleWhitespace: false,
        trimBodyWhitespace: true,
        duplicateMode: "skip_exact",
      }),
    ).toEqual({
      normalizeTitleWhitespace: false,
      trimBodyWhitespace: true,
      duplicateMode: "skip_exact",
    });
  });

  it("normalizes titles and bodies before duplicate comparison", () => {
    const options = resolveImportOptions({
      normalizeTitleWhitespace: true,
      trimBodyWhitespace: true,
    });

    expect(normalizeTitle("  Imported   note  ", options)).toBe("Imported note");
    expect(normalizeBody("line  \r\nbody \t \n", options)).toBe("line\nbody");
  });

  it("detects exact duplicates and preview skips from a plan", () => {
    const options = resolveImportOptions({ duplicateMode: "skip_exact" });
    const existing = buildDuplicateIndex(
      [makeNodeRecord({ id: "node_existing", title: "Imported note", body: "Imported body" })],
      options,
    );
    const seen: SeenImportIndex = {
      exact: new Map(),
      title: new Map(),
    };
    const node = makePlannedNode({ originalId: "node_original" });
    const duplicate = detectDuplicateMatch({
      node,
      options,
      existing,
      seen,
    });
    const plan: ImportPlan = {
      format: "markdown",
      label: "Import",
      sourcePath: "/tmp/example.md",
      createdAt: "2026-03-31T00:00:00.000Z",
      options,
      warnings: [],
      nodes: [{ ...node, duplicate }],
      relations: [
        {
          originalId: "rel_1",
          fromOriginalId: "node_original",
          toOriginalId: "node_other",
          relationType: "related_to",
          metadata: {},
        },
      ],
      activities: [
        {
          originalId: "act_1",
          targetOriginalId: "node_original",
          activityType: "note_appended",
          body: "Imported activity",
          metadata: {},
          originalCreatedAt: null,
        },
      ],
    };

    expect(duplicate).toEqual(
      expect.objectContaining({
        matchType: "exact",
        existingNodeId: "node_existing",
      }),
    );
    expect(buildPreviewFromPlan(plan)).toEqual(
      expect.objectContaining({
        duplicateCandidates: 1,
        exactDuplicateCandidates: 1,
        skippedNodes: 1,
        skippedRelations: 1,
        skippedActivities: 1,
      }),
    );
  });
});
