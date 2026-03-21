import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderRelated } from "../app/cli/src/format.js";
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

describe("runCli mcp", () => {
  it("installs a stable launcher script for MCP clients", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "memforge-cli-test-"));
    const launcherPath = path.join(tempDir, "memforge-mcp");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    try {
      await runCli(["node", "memforge", "mcp", "install", "--path", launcherPath]);
      const contents = readFileSync(launcherPath, "utf8");
      const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");

      expect(contents).toContain("memforge-mcp.js");
      expect(contents).toContain("--api");
      expect(output).toContain(`Installed launcher: ${launcherPath}`);
      expect(output).toContain("\"mcpServers\"");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
