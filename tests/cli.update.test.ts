import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runUpdate } from "../app/cli/src/cli.js";
import { applyCliUpdate, getCliUpdatePlan } from "../app/cli/src/update.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("getCliUpdatePlan", () => {
  it("returns an npm global update plan for the full runtime", async () => {
    const globalRoot = mkdtempSync(path.join(tmpdir(), "recallx-global-"));
    tempRoots.push(globalRoot);
    const packageRoot = path.join(globalRoot, "recallx");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "recallx", version: "1.0.2" }),
      "utf8",
    );

    const execFileAsyncFn = vi.fn(async (_command, args) => {
      if (args[0] === "root") {
        return { stdout: `${globalRoot}\n` };
      }
      if (args[0] === "view") {
        return { stdout: "\"1.0.3\"\n" };
      }
      throw new Error(`Unexpected command args: ${args.join(" ")}`);
    });

    const plan = await getCliUpdatePlan({
      moduleUrl: pathToFileURL(path.join(packageRoot, "app/cli/src/cli.js")).href,
      execFileAsyncFn,
    });

    expect(plan.packageName).toBe("recallx");
    expect(plan.currentVersion).toBe("1.0.2");
    expect(plan.latestVersion).toBe("1.0.3");
    expect(plan.status).toBe("update_available");
    expect(plan.installCommand).toContain("npm");
    expect(plan.installCommand).toContain("recallx@latest");
  });

  it("rejects source checkouts and other non-global installs", async () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "recallx-project-"));
    const globalRoot = mkdtempSync(path.join(tmpdir(), "recallx-global-"));
    tempRoots.push(packageRoot, globalRoot);
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "recallx", version: "1.0.2" }),
      "utf8",
    );

    const execFileAsyncFn = vi.fn(async () => ({ stdout: `${globalRoot}\n` }));

    await expect(
      getCliUpdatePlan({
        moduleUrl: pathToFileURL(path.join(packageRoot, "app/cli/src/cli.js")).href,
        execFileAsyncFn,
      }),
    ).rejects.toThrow("UPDATE_UNSUPPORTED");
  });
});

describe("runUpdate", () => {
  it("prints an update hint before applying changes", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runUpdate(
      "text",
      {},
      {
        getCliUpdatePlan: vi.fn(async () => ({
          packageName: "recallx",
          currentVersion: "1.0.2",
          latestVersion: "1.0.3",
          installCommand: "\"npm\" \"install\" \"-g\" \"recallx@latest\"",
          packageRoot: "/tmp/npm-root/recallx",
          status: "update_available",
          applied: false,
        })),
      },
    );

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("status: update available");
    expect(output).toContain("recallx update --apply");
    expect(output).toContain("recallx@latest");
  });

  it("applies the npm update when --apply is passed", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const applyCliUpdateMock = vi.fn((plan) => ({
      ...plan,
      status: "updated",
      applied: true,
    }));

    await runUpdate(
      "text",
      { apply: true },
      {
        getCliUpdatePlan: vi.fn(async () => ({
          packageName: "recallx-headless",
          currentVersion: "1.0.2",
          latestVersion: "1.0.3",
          installCommand: "\"npm\" \"install\" \"-g\" \"recallx-headless@latest\"",
          packageRoot: "/tmp/npm-root/recallx-headless",
          status: "update_available",
          applied: false,
        })),
        applyCliUpdate: applyCliUpdateMock,
      },
    );

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(applyCliUpdateMock).toHaveBeenCalledTimes(1);
    expect(output).toContain("status: updated");
    expect(output).toContain("recallx-headless");
  });
});

describe("applyCliUpdate", () => {
  it("skips npm install when the package is already up to date", () => {
    const execFileSyncFn = vi.fn();
    const result = applyCliUpdate(
      {
        packageName: "recallx",
        currentVersion: "1.0.2",
        latestVersion: "1.0.2",
        installArgs: ["install", "-g", "recallx@latest"],
        status: "up_to_date",
        applied: false,
      },
      { execFileSyncFn },
    );

    expect(execFileSyncFn).not.toHaveBeenCalled();
    expect(result.status).toBe("up_to_date");
    expect(result.applied).toBe(false);
  });
});
