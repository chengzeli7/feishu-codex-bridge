import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
const includedEntries = [
  ".github",
  ".gitignore",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "bin",
  "config.example.json",
  "docs",
  "package-lock.json",
  "package.json",
  "scripts",
  "src",
  "test"
];
const forbiddenNames = new Set(["config.local.json", ".env", "data", "node_modules", "dist", ".git"]);
const forbiddenContent = [
  { pattern: /\/Users\/(?!your-name(?:\/|$))[a-z0-9._-]+\//i, label: "可能的本机用户绝对路径" },
  { pattern: /\bou_[a-z0-9_-]{20,}\b/i, label: "真实飞书 open_id" },
  { pattern: /\boc_[a-z0-9_-]{20,}\b/i, label: "真实飞书 chat_id" }
];

function stamp() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function filesUnder(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (forbiddenNames.has(entry.name)) throw new Error(`导出目录包含禁止项：${path.join(relative, entry.name)}`);
    const child = path.join(relative, entry.name);
    const info = await lstat(path.join(root, child));
    if (info.isSymbolicLink()) throw new Error(`导出目录不允许符号链接：${child}`);
    if (info.isDirectory()) files.push(...await filesUnder(root, child));
    else if (info.isFile()) files.push(child);
  }
  return files;
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function verifySanitized(root, files) {
  for (const relative of files) {
    const contents = await readFile(path.join(root, relative));
    if (contents.includes(0)) continue;
    const text = contents.toString("utf8")
      .replaceAll("ou_replace_with_your_open_id", "ou_placeholder")
      .replaceAll("oc_replace_with_your_chat_id", "oc_placeholder");
    for (const rule of forbiddenContent) {
      if (rule.pattern.test(text)) throw new Error(`${relative} 包含${rule.label}，已拒绝导出`);
    }
  }
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-bridge-export-"));
const bundleName = `feishu-codex-bridge-${packageJson.version}-${stamp()}`;
const bundleRoot = path.join(temporaryRoot, bundleName);
const distRoot = path.join(sourceRoot, "dist");
const archivePath = path.join(distRoot, `${bundleName}.zip`);

try {
  await mkdir(bundleRoot, { recursive: true, mode: 0o700 });
  for (const entry of includedEntries) {
    await cp(path.join(sourceRoot, entry), path.join(bundleRoot, entry), { recursive: true, errorOnExist: true });
  }
  const files = (await filesUnder(bundleRoot)).sort();
  await verifySanitized(bundleRoot, files);
  const manifestFiles = [];
  for (const relative of files) {
    manifestFiles.push({ path: relative, sha256: await sha256(path.join(bundleRoot, relative)) });
  }
  await writeFile(path.join(bundleRoot, "BUNDLE_MANIFEST.json"), `${JSON.stringify({
    name: "feishu-codex-bridge",
    version: packageJson.version,
    createdAt: new Date().toISOString(),
    containsCredentials: false,
    containsLocalState: false,
    recommendedDeployment: "single-user-dedicated-feishu-app",
    files: manifestFiles
  }, null, 2)}\n`);

  await mkdir(distRoot, { recursive: true, mode: 0o700 });
  const archived = spawnSync("/usr/bin/ditto", [
    "-c", "-k", "--keepParent",
    "--norsrc", "--noextattr", "--noqtn", "--noacl",
    bundleRoot, archivePath
  ], {
    encoding: "utf8"
  });
  if (archived.error) throw archived.error;
  if (archived.status !== 0) throw new Error(archived.stderr || `ditto exited with ${archived.status}`);
  const archiveHash = await sha256(archivePath);
  const checksumPath = `${archivePath}.sha256`;
  await writeFile(checksumPath, `${archiveHash}  ${path.basename(archivePath)}\n`);
  console.log(JSON.stringify({ archivePath, checksumPath, sha256: archiveHash }, null, 2));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
