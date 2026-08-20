import { spawn as nodeSpawn } from "node:child_process";

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DesktopSync {
  constructor({ enabled = false, spawn = nodeSpawn, openBin = "/usr/bin/open" } = {}) {
    this.enabled = enabled;
    this.spawn = spawn;
    this.openBin = openBin;
  }

  async refreshThread(threadId) {
    if (!this.enabled) return false;
    if (!THREAD_ID_PATTERN.test(threadId ?? "")) throw new Error("invalid Codex thread ID for Desktop sync");
    await new Promise((resolve, reject) => {
      const child = this.spawn(this.openBin, ["-g", `codex://threads/${threadId}`], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Codex Desktop refresh failed (code=${code}, signal=${signal})`));
      });
    });
    return true;
  }
}
