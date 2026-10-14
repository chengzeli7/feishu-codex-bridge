import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { VERSION } from "../src/version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guideUrl = "https://github.com/chengzeli7/feishu-codex-bridge/blob/main/docs/CODEX_INSTALL.md";
const prompts = {
  en: `Install and configure Feishu Codex Bridge on this Mac by following:\n${guideUrl}\nRead the guide and then execute it autonomously. Pause only when the guide says\nthat I must complete a browser, Feishu, macOS, or pairing action.`,
  zh: `请按照下面的 Codex 托管安装指南，在这台 Mac 上安装并配置 Feishu Codex Bridge：\n${guideUrl}\n阅读指南后直接自主执行。只有指南明确要求我完成浏览器、飞书、macOS 授权或配对操作时\n才暂停。`
};
for (const [language, files] of Object.entries({ en: ["README.md", "docs/INSTALL.md"], zh: ["README.zh-CN.md", "docs/INSTALL.zh-CN.md"] })) {
  for (const file of files) {
    const text = await readFile(path.join(root, file), "utf8");
    assert.ok(text.includes("```text\n" + prompts[language] + "\n```"), `${file}: preserve the existing installation prompt verbatim`);
  }
}
for (const file of ["README.md", "README.zh-CN.md"]) {
  const text = await readFile(path.join(root, file), "utf8");
  assert.ok(text.includes(`version-${VERSION}-orange.svg`), `${file}: badge version`);
}
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
assert.equal(lock.version, VERSION);
assert.equal(lock.packages[""].version, VERSION);
const docs = (await readdir(path.join(root, "docs"))).filter((file) => file.endsWith(".md")).map((file) => `docs/${file}`);
const files = [...(await readdir(root)).filter((file) => file.endsWith(".md")), ...docs];
let checked = 0;
for (const file of files) {
  const text = await readFile(path.join(root, file), "utf8");
  const targets = [...text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g), ...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  for (const target of targets) {
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const pathname = target.split("#")[0];
    const resolved = path.resolve(root, path.dirname(file), decodeURIComponent(pathname));
    assert.ok(resolved.startsWith(root + path.sep), `${file}: link escapes repository: ${target}`);
    assert.ok((await stat(resolved).catch(() => null))?.isFile(), `${file}: missing target: ${target}`);
    checked += 1;
  }
}
console.log(`Validated ${files.length} Markdown files, ${checked} local links/assets, version ${VERSION}, and unchanged installation prompts.`);
