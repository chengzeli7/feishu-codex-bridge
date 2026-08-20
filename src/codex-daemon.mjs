import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

function parseLastJsonLine(output) {
  const lines = String(output ?? "").trim().split("\n").filter(Boolean);
  for (const line of lines.reverse()) {
    try { return JSON.parse(line); } catch { /* keep looking for a JSON status line */ }
  }
  return null;
}
export class CodexDaemonManager {
  constructor({
    bin,
    enabled = true,
    run = executeFile,
    now = () => Date.now(),
    cooldownMs = 5_000,
    timeoutMs = 20_000
  }) {
    this.bin = bin;
    this.enabled = enabled;
    this.run = run;
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.timeoutMs = timeoutMs;
    this.inFlight = null;
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.lastResult = null;
  }

  async ensureRunning() {
    if (!this.enabled) return { attempted: false, status: "disabled" };
    if (this.inFlight) return this.inFlight;
    const currentTime = this.now();
    if (this.lastAttemptAt !== null && currentTime - this.lastAttemptAt < this.cooldownMs) {
      return { attempted: false, status: "cooldown", result: this.lastResult };
    }

    this.lastAttemptAt = currentTime;
    this.inFlight = this.#start().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      recovering: Boolean(this.inFlight),
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      status: this.lastResult?.status ?? null
    };
  }

  async #start() {
    try {
      const result = await this.run(this.bin, ["app-server", "daemon", "start"], { timeout: this.timeoutMs });
      const parsed = parseLastJsonLine(result?.stdout);
      this.lastResult = parsed ?? { status: "started" };
      this.lastSuccessAt = this.now();
      this.lastError = null;
      return { attempted: true, status: this.lastResult.status ?? "started", result: this.lastResult };
    } catch (error) {
      this.lastError = error?.stderr?.trim() || error?.message || String(error);
      throw error;
    }
  }
}
