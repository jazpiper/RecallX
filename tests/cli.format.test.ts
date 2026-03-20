import { afterEach, describe, expect, it, vi } from "vitest";
import { renderRelated } from "../app/cli/src/format.js";
// The CLI entry is plain JS in this repo, so the test imports it without TS declarations.
// @ts-expect-error No TypeScript declaration file is emitted for the CLI module.
import { runCli } from "../app/cli/src/cli.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderRelated", () => {
  it("renders nested related node payloads from the live API", () => {
    const output = renderRelated({
      items: [
        {
          relation: { relationType: "supports" },
          node: { id: "node_123", title: "Retrieval rule" }
        }
      ]
    });

    expect(output).toContain("1. Retrieval rule (supports)");
  });
});

describe("runCli health", () => {
  it("renders the health payload without double-wrapping the envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              status: "ok",
              workspaceLoaded: true
            },
            meta: {
              requestId: "req_test",
              apiVersion: "v1"
            }
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        )
      )
    );
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runCli(["node", "memforge", "health"]);

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("status: ok");
    expect(output).toContain("workspaceLoaded: true");
    expect(output).not.toContain("ok: true");
    expect(output).not.toContain("data:");
  });
});
