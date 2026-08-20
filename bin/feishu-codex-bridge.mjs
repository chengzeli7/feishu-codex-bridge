#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "help";
const rest = process.argv.slice(3);
const commands = {
  init: ["scripts/onboard.mjs"],
  setup: ["scripts/setup.mjs"],
  doctor: ["scripts/doctor.mjs"],
  start: ["src/bridge.mjs"],
  service: ["scripts/service.mjs", ...rest],
  status: ["scripts/service.mjs", "status"],
  restart: ["scripts/service.mjs", "restart"],
  logs: ["scripts/service.mjs", "logs"],
  uninstall: ["scripts/service.mjs", "uninstall"]
};

if (command === "help" || command === "--help" || command === "-h") {
  console.log(`Feishu Codex Bridge v0.1.0

Usage:
  feishu-codex-bridge init              Run guided end-to-end setup
  feishu-codex-bridge status            Show service health
  feishu-codex-bridge restart           Restart the bridge
  feishu-codex-bridge logs              Show recent logs
  feishu-codex-bridge uninstall         Stop the service and preserve data
  feishu-codex-bridge service <action>  Run a service action
  feishu-codex-bridge doctor            Validate local configuration
  feishu-codex-bridge start             Run in the foreground`);
  process.exit(0);
}

const target = commands[command];
if (!target) {
  console.error(`Unknown command: ${command}\nRun feishu-codex-bridge --help for usage.`);
  process.exit(2);
}

const args = command === "service" ? target : [...target, ...rest];
const result = spawnSync(process.execPath, args, {
  cwd: projectRoot,
  stdio: "inherit",
  env: process.env
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
