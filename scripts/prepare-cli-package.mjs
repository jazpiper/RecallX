import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const outputDir = path.join(rootDir, "release", "npm-cli");
const readmeSource = path.join(rootDir, "app", "cli", "README.md");
const directoriesToCopy = [
  ["app", "cli", "bin"],
  ["dist", "server", "app", "cli"],
  ["dist", "server", "app", "mcp"],
  ["dist", "server", "app", "shared"],
];
const filesToCopy = [
  ["dist", "server", "app", "server", "observability.js"],
  ["app", "cli", "src", "format.js"],
];

for (const parts of directoriesToCopy) {
  const candidate = path.join(rootDir, ...parts);
  if (!existsSync(candidate)) {
    throw new Error(`Missing built directory: ${candidate}. Run npm run build first.`);
  }
}

for (const parts of filesToCopy) {
  const candidate = path.join(rootDir, ...parts);
  if (!existsSync(candidate)) {
    throw new Error(`Missing built file: ${candidate}. Run npm run build first.`);
  }
}

rmSync(outputDir, { force: true, recursive: true });
mkdirSync(outputDir, { recursive: true });

for (const parts of directoriesToCopy) {
  const source = path.join(rootDir, ...parts);
  const relative = parts[0] === "dist"
    ? path.relative(path.join(rootDir, "dist", "server"), source)
    : path.relative(rootDir, source);
  const destination = path.join(outputDir, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

for (const parts of filesToCopy) {
  const source = path.join(rootDir, ...parts);
  const relative = parts[0] === "dist"
    ? path.relative(path.join(rootDir, "dist", "server"), source)
    : path.relative(rootDir, source);
  const destination = path.join(outputDir, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination);
}

cpSync(readmeSource, path.join(outputDir, "README.md"));

writeFileSync(
  path.join(outputDir, "package.json"),
  `${JSON.stringify(
    {
      name: "memforge",
      version: packageJson.version,
      description: "Local-first Memforge CLI and MCP entrypoint.",
      type: "module",
      bin: {
        memforge: "./app/cli/bin/pnw.js",
        pnw: "./app/cli/bin/pnw.js",
        "memforge-mcp": "./app/cli/bin/memforge-mcp.js",
      },
      files: ["app/cli", "app/mcp", "app/shared", "app/server/observability.js", "README.md"],
      engines: {
        node: ">=20",
      },
      keywords: ["memforge", "cli", "mcp", "knowledge", "local-first"],
      repository: {
        type: "git",
        url: "git+https://github.com/jazpiper/Memforge.git",
      },
      homepage: "https://github.com/jazpiper/Memforge#readme",
      bugs: {
        url: "https://github.com/jazpiper/Memforge/issues",
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
