import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, chmod, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createInterface as createPrompt } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { buildBridgeConfig, pairingIdentity, PAIRING_PHRASE } from "../src/setup-config.mjs";
import { DESKTOP_CODEX_BIN } from "../src/config.mjs";

const QUIET_ENV = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
};
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.resolve(process.env.BRIDGE_CONFIG ?? path.join(projectRoot, "config.local.json"));

function executable(name) {
  const bundled = path.join(projectRoot, "node_modules", ".bin", name);
  if (existsSync(bundled)) return bundled;
  const result = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function nodeMajorVersion() {
  return Number(process.versions.node.split(".")[0]);
}

async function verifyPrerequisites() {
  if (process.platform !== "darwin") throw new Error("家用安装包当前只支持 macOS");
  if (nodeMajorVersion() < 20) throw new Error(`需要 Node.js 20 或更高版本，当前为 ${process.version}`);
  await access(DESKTOP_CODEX_BIN).catch(() => {
    throw new Error(`未找到 Codex Desktop 运行时：${DESKTOP_CODEX_BIN}`);
  });
  const larkBin = executable("lark-cli");
  if (!larkBin) throw new Error("未找到 lark-cli，请先按 README.md 安装");
  const auth = spawnSync(larkBin, ["auth", "status", "--json", "--verify"], {
    encoding: "utf8",
    env: { ...process.env, ...QUIET_ENV }
  });
  if (auth.status !== 0) throw new Error("lark-cli 尚未配置家庭机器人，请先运行 lark-cli config init --new");
  const status = JSON.parse(auth.stdout);
  if (!status.identities?.bot?.available) {
    throw new Error(status.identities?.bot?.message ?? "家庭机器人 bot 身份不可用");
  }
  return { larkBin };
}

function pairWithFeishu(larkBin) {
  return new Promise((resolve, reject) => {
    console.log(`\n请在飞书里打开你创建的机器人。\n看到“配对监听已就绪”后，发送：${PAIRING_PHRASE}\n`);
    const child = spawn(larkBin, [
      "event", "consume", "im.message.receive_v1",
      "--max-events", "1",
      "--timeout", "5m",
      "--as", "bot"
    ], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...QUIET_ENV }
    });
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };

    createInterface({ input: child.stderr }).on("line", (line) => {
      stderr += `${line}\n`;
      if (line.includes("[event] ready event_key=im.message.receive_v1")) {
        console.log("配对监听已就绪，请现在发送配对口令。");
      }
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        const identity = pairingIdentity(JSON.parse(line));
        finish(() => resolve(identity));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      if (settled) return;
      const detail = stderr.trim().split("\n").at(-1) ?? "未收到事件";
      finish(() => reject(new Error(`飞书配对未完成（exit ${code}）：${detail}`)));
    });
  });
}

async function promptWorkspaces(prompt) {
  const entries = [];
  while (true) {
    const alias = (await prompt.question(entries.length === 0 ? "项目代号（默认 my-project）：" : "下一个项目代号：")).trim() || "my-project";
    const directory = (await prompt.question("项目绝对路径：")).trim();
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory()) {
      console.log(`目录不存在或不是文件夹：${directory}`);
      continue;
    }
    const aliases = (await prompt.question("自然语言别名，逗号分隔（可留空）："))
      .split(/[,，]/)
      .map((value) => value.trim())
      .filter(Boolean);
    entries.push({ alias, directory, aliases });
    const more = (await prompt.question("继续添加项目？[y/N]：")).trim().toLowerCase();
    if (more !== "y" && more !== "yes") return entries;
  }
}

async function main() {
  if (existsSync(configPath)) {
    throw new Error(`已存在配置，未覆盖：${configPath}\n如需重配，请先手动备份并移走该文件。`);
  }
  const { larkBin } = await verifyPrerequisites();
  const pairing = await pairWithFeishu(larkBin);
  console.log(`已绑定用户 ${pairing.userId.slice(0, 8)}… 和当前私聊。`);

  const prompt = createPrompt({ input, output });
  try {
    const workspaceEntries = await promptWorkspaces(prompt);
    const defaultAnswer = (await prompt.question(`默认项目（默认 ${workspaceEntries[0].alias}）：`)).trim();
    const defaultWorkspace = defaultAnswer || workspaceEntries[0].alias;
    const detectedFfmpeg = executable("ffmpeg") ?? "/opt/homebrew/bin/ffmpeg";
    const config = buildBridgeConfig({ pairing, workspaceEntries, defaultWorkspace, larkBin, ffmpegBin: detectedFfmpeg });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(configPath, 0o600);
  } finally {
    prompt.close();
  }

  console.log(`\n配置已写入：${configPath}`);
  console.log("下一步执行：");
  console.log("  npm run service -- install");
  console.log("  npm run doctor");
  console.log("  npm run service -- status");
}

main().catch((error) => {
  console.error(`SETUP FAILED  ${error.message}`);
  process.exitCode = 1;
});
