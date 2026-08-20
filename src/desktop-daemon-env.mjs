import { spawnSync } from "node:child_process";

export const DESKTOP_DAEMON_ENV = "CODEX_APP_SERVER_USE_LOCAL_DAEMON";

export function enableDesktopDaemonEnvironment({ platform = process.platform, run = spawnSync } = {}) {
  if (platform !== "darwin") return { enabled: false, changed: false };

  const current = run("/bin/launchctl", ["getenv", DESKTOP_DAEMON_ENV], {
    encoding: "utf8"
  });
  if (!current.error && current.status === 0 && current.stdout.trim() === "1") {
    return { enabled: true, changed: false };
  }

  const result = run("/bin/launchctl", ["setenv", DESKTOP_DAEMON_ENV, "1"], {
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`failed to enable Codex Desktop shared app-server mode: ${result.stderr?.trim() || result.status}`);
  }
  return { enabled: true, changed: true };
}
