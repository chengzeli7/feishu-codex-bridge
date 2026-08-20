import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";

const LOCAL_DAEMON_ENV = "CODEX_APP_SERVER_USE_LOCAL_DAEMON";
const config = await loadConfig();

if (!config.codexAppServerSocket) {
  throw new Error("codexAppServerSocket is required for the shared Codex app-server service");
}

const socketDirectory = path.dirname(config.codexAppServerSocket);
await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
await chmod(socketDirectory, 0o700);

const setEnvironment = spawnSync("/bin/launchctl", ["setenv", LOCAL_DAEMON_ENV, "1"], { encoding: "utf8" });
if (setEnvironment.status !== 0) {
  throw new Error(`failed to enable Codex Desktop shared app-server mode: ${setEnvironment.stderr?.trim() || setEnvironment.error?.message || setEnvironment.status}`);
}

const child = spawn(config.codexBin, [
  "-c",
  "features.code_mode_host=true",
  "app-server",
  "--listen",
  `unix://${config.codexAppServerSocket}`
], { stdio: "inherit" });

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
};

process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (!stopping) console.error(`shared Codex app-server exited (code=${code}, signal=${signal})`);
  process.exit(code ?? (stopping ? 0 : 1));
});
