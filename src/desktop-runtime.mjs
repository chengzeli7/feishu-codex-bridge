import { existsSync } from "node:fs";
import path from "node:path";

export const DESKTOP_CODEX_PATHS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex"
];

export function resolveDesktopCodexBin({ exists = existsSync } = {}) {
  return DESKTOP_CODEX_PATHS.find((candidate) => exists(candidate)) ?? DESKTOP_CODEX_PATHS[0];
}

export function isDesktopCodexBin(bin) {
  return typeof bin === "string" && DESKTOP_CODEX_PATHS.includes(path.resolve(bin));
}

export const DESKTOP_CODEX_BIN = resolveDesktopCodexBin();
