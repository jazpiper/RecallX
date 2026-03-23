import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const packageKind = process.argv[2];
const rootDir = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));

const runtimeDependencyAllowlist = [
  "@modelcontextprotocol/sdk",
  "cors",
  "express",
  "mime-types",
  "sqlite-vec",
  "ulid",
  "zod",
];

const packageConfigs = {
  full: {
    outputDir: path.join(rootDir, "release", "npm-recallx"),
    readmeSource: path.join(rootDir, "README.md"),
    description: "Local-first RecallX runtime with API, renderer, CLI, and MCP entrypoint.",
    packageName: "recallx",
    files: ["app/cli", "app/mcp", "app/shared", "app/server", "dist/renderer", "README.md"],
    directoriesToCopy: [
      ["app", "cli", "bin"],
      ["dist", "server", "app", "cli"],
      ["dist", "server", "app", "mcp"],
      ["dist", "server", "app", "shared"],
      ["dist", "server", "app", "server"],
      ["dist", "renderer"],
    ],
    filesToCopy: [["app", "cli", "src", "format.js"]],
  },
  headless: {
    outputDir: path.join(rootDir, "release", "npm-headless"),
    readmeSource: path.join(rootDir, "app", "cli", "README.md"),
    description: "Headless RecallX runtime with API, CLI, and MCP entrypoint.",
    packageName: "recallx-headless",
    files: ["app/cli", "app/mcp", "app/shared", "app/server", "README.md"],
    directoriesToCopy: [
      ["app", "cli", "bin"],
      ["dist", "server", "app", "cli"],
      ["dist", "server", "app", "mcp"],
      ["dist", "server", "app", "shared"],
      ["dist", "server", "app", "server"],
    ],
    filesToCopy: [["app", "cli", "src", "format.js"]],
  },
};

const selectedConfig = packageConfigs[packageKind];
if (!selectedConfig) {
  throw new Error(`Unknown package kind "${packageKind}". Expected one of: ${Object.keys(packageConfigs).join(", ")}.`);
}

const packageDependencies = Object.fromEntries(
  runtimeDependencyAllowlist.map((dependencyName) => {
    const version = packageJson.dependencies?.[dependencyName];
    if (typeof version !== "string" || !version.trim()) {
      throw new Error(
        `Missing runtime dependency "${dependencyName}" in root package.json dependencies. Update scripts/prepare-package.mjs allowlist or root dependencies.`,
      );
    }

    return [dependencyName, version];
  }),
);

for (const parts of selectedConfig.directoriesToCopy) {
  const candidate = path.join(rootDir, ...parts);
  if (!existsSync(candidate)) {
    throw new Error(`Missing built directory: ${candidate}. Run npm run build first.`);
  }
}

for (const parts of selectedConfig.filesToCopy) {
  const candidate = path.join(rootDir, ...parts);
  if (!existsSync(candidate)) {
    throw new Error(`Missing file: ${candidate}.`);
  }
}

rmSync(selectedConfig.outputDir, { force: true, recursive: true });
mkdirSync(selectedConfig.outputDir, { recursive: true });

for (const parts of selectedConfig.directoriesToCopy) {
  const source = path.join(rootDir, ...parts);
  const relative = resolvePackageRelativePath(parts);
  const destination = path.join(selectedConfig.outputDir, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

for (const parts of selectedConfig.filesToCopy) {
  const source = path.join(rootDir, ...parts);
  const relative = path.relative(rootDir, source);
  const destination = path.join(selectedConfig.outputDir, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination);
}

cpSync(selectedConfig.readmeSource, path.join(selectedConfig.outputDir, "README.md"));

writeFileSync(
  path.join(selectedConfig.outputDir, "package.json"),
  `${JSON.stringify(
    {
      name: selectedConfig.packageName,
      version: packageJson.version,
      description: selectedConfig.description,
      type: "module",
      bin: {
        recallx: "./app/cli/bin/recallx.js",
        recallx: "./app/cli/bin/recallx.js",
        "recallx-mcp": "./app/cli/bin/recallx-mcp.js",
      },
      files: selectedConfig.files,
      dependencies: packageDependencies,
      engines: {
        node: ">=22.13.0",
      },
      keywords: ["recallx", packageKind, "cli", "mcp", "knowledge", "local-first"],
      repository: {
        type: "git",
        url: "git+https://github.com/jazpiper/RecallX.git",
      },
      homepage: "https://github.com/jazpiper/RecallX#readme",
      bugs: {
        url: "https://github.com/jazpiper/RecallX/issues",
      },
      publishConfig: {
        access: "public",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

function resolvePackageRelativePath(parts) {
  if (parts[0] !== "dist") {
    return path.relative(rootDir, path.join(rootDir, ...parts));
  }

  const source = path.join(rootDir, ...parts);
  const distServerRoot = path.join(rootDir, "dist", "server");
  if (source.startsWith(`${distServerRoot}${path.sep}`)) {
    return path.relative(distServerRoot, source);
  }

  return path.relative(rootDir, source);
}
