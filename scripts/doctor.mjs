import { access, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";

const run = promisify(execFile);
const config = await loadConfig();
const checks = [];

async function check(name, operation, { required = true } = {}) {
  try {
    const detail = await operation();
    checks.push({ name, ok: true, required, detail });
  } catch (error) {
    checks.push({ name, ok: false, required, detail: error.message });
  }
}

await check("config", async () => `${config.allowedUserIds.length} user / ${config.allowedChatIds.length} chat`);
await check("state directory", async () => {
  await mkdir(path.dirname(config.stateFile), { recursive: true, mode: 0o700 });
  await access(path.dirname(config.stateFile));
  return path.dirname(config.stateFile);
});
await check("attachments directory", async () => {
  await mkdir(config.attachmentsDir, { recursive: true, mode: 0o700 });
  await access(config.attachmentsDir);
  return config.attachmentsDir;
});
for (const [alias, workspace] of Object.entries(config.workspaces)) {
  await check(`workspace:${alias}`, async () => { await access(workspace); return workspace; });
}
await check("codex", async () => (await run(config.codexBin, ["--version"])).stdout.trim());
if (config.codexAppServerSocket) {
  await check("official app-server socket", async () => {
    await access(config.codexAppServerSocket);
    return config.codexAppServerSocket;
  });
  await check("official app-server daemon", async () => {
    const status = JSON.parse((await run(config.codexBin, ["app-server", "daemon", "version"])).stdout);
    if (status.status !== "running" || status.socketPath !== config.codexAppServerSocket || !status.appServerVersion) {
      throw new Error(`unexpected official app-server status: ${JSON.stringify(status)}`);
    }
    return status.appServerVersion;
  });
}
await check("lark-cli", async () => (await run(config.larkBin, ["--version"], { env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" } })).stdout.trim());
await check("lark bot auth", async () => {
  const status = JSON.parse((await run(config.larkBin, ["auth", "status", "--json"], {
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" }
  })).stdout);
  if (!status.identities?.bot?.available) throw new Error(status.identities?.bot?.message ?? "bot identity unavailable");
  return status.identities.bot.message;
});
await check("ffmpeg (optional voice input)", async () => (await run(config.ffmpegBin, ["-version"])).stdout.split("\n")[0], { required: false });

for (const item of checks) console.log(`${item.ok ? "PASS" : item.required ? "FAIL" : "WARN"}  ${item.name}  ${item.detail}`);
if (checks.some((item) => item.required && !item.ok)) process.exitCode = 1;
