import { describe, expect, it } from "vitest";
import { resolveGovernancePolicy, resolveNodeGovernance, resolveRelationStatus } from "../app/server/governance.js";

describe("resolveNodeGovernance", () => {
  it("keeps human nodes canonical", () => {
    const decision = resolveNodeGovernance({
      type: "note",
      title: "Human note",
      body: "This is durable.",
      tags: [],
      source: {
        actorType: "human",
        actorLabel: "juhwan",
        toolName: "memforge"
      },
      metadata: {}
    });

    expect(decision.canonicality).toBe("canonical");
    expect(decision.createReview).toBe(false);
  });

  it("forces agent decisions into review", () => {
    const decision = resolveNodeGovernance({
      type: "decision",
      title: "Use SQLite",
      body: "Adopt SQLite as the canonical store.",
      tags: [],
      source: {
        actorType: "agent",
        actorLabel: "Codex",
        toolName: "codex"
      },
      metadata: {}
    });

    expect(decision.canonicality).toBe("suggested");
    expect(decision.createReview).toBe(true);
  });

  it("lets trusted agent decisions bypass review", () => {
    const decision = resolveNodeGovernance(
      {
        type: "decision",
        title: "Use SQLite",
        body: "Adopt SQLite as the canonical store.",
        tags: [],
        source: {
          actorType: "agent",
          actorLabel: "Codex",
          toolName: "codex"
        },
        metadata: {}
      },
      resolveGovernancePolicy({
        "review.trustedSourceToolNames": ["codex"]
      })
    );

    expect(decision.canonicality).toBe("appended");
    expect(decision.status).toBe("active");
    expect(decision.createReview).toBe(false);
  });

  it("lets low-risk agent notes land as appended active nodes", () => {
    const decision = resolveNodeGovernance({
      type: "note",
      title: "Agent note",
      body: "This note captures a low-risk implementation detail that is useful to keep as append-only project context. ".repeat(30),
      tags: [],
      source: {
        actorType: "agent",
        actorLabel: "Codex",
        toolName: "codex"
      },
      metadata: {}
    });

    expect(decision.canonicality).toBe("appended");
    expect(decision.status).toBe("active");
    expect(decision.createReview).toBe(false);
  });

  it("keeps durable agent notes in review", () => {
    const decision = resolveNodeGovernance({
      type: "note",
      title: "Durable agent note",
      body: "This note captures reusable durable knowledge that should stay in the review flow until a human promotes it. ".repeat(30),
      tags: [],
      source: {
        actorType: "agent",
        actorLabel: "Codex",
        toolName: "codex"
      },
      metadata: {
        durable: true
      }
    });

    expect(decision.canonicality).toBe("suggested");
    expect(decision.status).toBe("review");
    expect(decision.createReview).toBe(true);
  });

  it("lets trusted agent tools bypass review for durable notes", () => {
    const decision = resolveNodeGovernance(
      {
        type: "note",
        title: "Trusted durable note",
        body: "This note captures reusable durable knowledge but comes from a trusted source. ".repeat(30),
        tags: [],
        source: {
          actorType: "agent",
          actorLabel: "Codex",
          toolName: "codex"
        },
        metadata: {
          durable: true
        }
      },
      resolveGovernancePolicy({
        "review.trustedSourceToolNames": ["codex"]
      })
    );

    expect(decision.canonicality).toBe("appended");
    expect(decision.status).toBe("active");
    expect(decision.createReview).toBe(false);
  });
});

describe("resolveRelationStatus", () => {
  it("forces agent relations to suggested", () => {
    const status = resolveRelationStatus({
      fromNodeId: "node_a",
      toNodeId: "node_b",
      relationType: "supports",
      source: {
        actorType: "agent",
        actorLabel: "Claude Code",
        toolName: "claude-code"
      },
      metadata: {}
    });

    expect(status.status).toBe("suggested");
    expect(status.createReview).toBe(true);
  });

  it("lets trusted agent relations become active by default", () => {
    const status = resolveRelationStatus(
      {
        fromNodeId: "node_a",
        toNodeId: "node_b",
        relationType: "supports",
        source: {
          actorType: "agent",
          actorLabel: "Codex",
          toolName: "codex"
        },
        metadata: {}
      },
      resolveGovernancePolicy({
        "review.trustedSourceToolNames": ["codex"]
      })
    );

    expect(status.status).toBe("active");
    expect(status.createReview).toBe(false);
  });
});
