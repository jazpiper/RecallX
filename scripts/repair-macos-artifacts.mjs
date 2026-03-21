import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = process.cwd();
const releaseDir = path.join(rootDir, "release");
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = packageJson.version;
const appPath = path.join(releaseDir, "mac-arm64", "Memforge.app");
const dmgPath = path.join(releaseDir, `Memforge-${version}-arm64.dmg`);
const zipPath = path.join(releaseDir, `Memforge-${version}-arm64-mac.zip`);
const latestYamlPath = path.join(releaseDir, "latest-mac.yml");
const blockmaps = [
  path.join(releaseDir, `Memforge-${version}-arm64.dmg.blockmap`),
  path.join(releaseDir, `Memforge-${version}-arm64-mac.zip.blockmap`),
];

if (process.platform !== "darwin") {
  process.exit(0);
}

run("xattr", ["-cr", appPath]);

rmIfExists(zipPath);
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);

const stagingDir = mkdtempSync(path.join(tmpdir(), "memforge-dmg-"));
const volumeRoot = path.join(stagingDir, "Memforge");

try {
  mkdirSync(volumeRoot, { recursive: true });
  run("ditto", [appPath, path.join(volumeRoot, "Memforge.app")]);
  symlinkSync("/Applications", path.join(volumeRoot, "Applications"));

  rmIfExists(dmgPath);
  run("hdiutil", [
    "create",
    "-volname",
    "Memforge",
    "-srcfolder",
    volumeRoot,
    "-ov",
    "-format",
    "UDZO",
    "-fs",
    "APFS",
    dmgPath,
  ]);
} finally {
  rmSync(stagingDir, { force: true, recursive: true });
}

for (const blockmap of blockmaps) {
  rmIfExists(blockmap);
}

const zipSha512 = sha512Base64(zipPath);
const dmgSha512 = sha512Base64(dmgPath);
const zipSize = statSync(zipPath).size;
const dmgSize = statSync(dmgPath).size;
const releaseDate = new Date().toISOString();

writeFileSync(
  latestYamlPath,
  `version: ${version}
files:
  - url: ${path.basename(zipPath)}
    sha512: ${zipSha512}
    size: ${zipSize}
  - url: ${path.basename(dmgPath)}
    sha512: ${dmgSha512}
    size: ${dmgSize}
path: ${path.basename(zipPath)}
sha512: ${zipSha512}
releaseDate: '${releaseDate}'
`,
);

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function rmIfExists(targetPath) {
  rmSync(targetPath, { force: true, recursive: true });
}

function sha512Base64(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("base64");
}
